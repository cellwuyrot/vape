/**
 * Клиент PostgreSQL проверяется без работающего сервера: кодирование сообщений,
 * разбор потока и SCRAM — чистые функции. Интеграционный прогон против живой базы
 * делает отдельный тест pg-integration.test.js, когда задан DATABASE_URL.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  Writer,
  bindMessage,
  decodeValue,
  extractMessages,
  frame,
  md5PasswordMessage,
  parseConnectionString,
  parseScramAttributes,
  readDataRow,
  readErrorFields,
  readRowDescription,
  saslInitialMessage,
  scramClientProof,
  startupMessage,
} from "../server/drivers/pg-protocol.js";

/* ---------- строка подключения ---------- */

test("строка подключения разбирается полностью", () => {
  const options = parseConnectionString("postgres://rucrm:s3cret@db.example.ru:6432/crm?sslmode=require");
  assert.equal(options.user, "rucrm");
  assert.equal(options.password, "s3cret");
  assert.equal(options.host, "db.example.ru");
  assert.equal(options.port, 6432);
  assert.equal(options.database, "crm");
  assert.equal(options.sslmode, "require");
});

test("спецсимволы в пароле не ломают разбор", () => {
  const options = parseConnectionString(`postgres://user:${encodeURIComponent("p@ss:w/rd")}@localhost/crm`);
  assert.equal(options.password, "p@ss:w/rd");
  assert.equal(options.port, 5432, "порт по умолчанию");
});

test("чужая схема подключения отвергается", () => {
  assert.throws(() => parseConnectionString("mysql://user@localhost/crm"), /Ожидается postgres/);
});

/* ---------- сборка сообщений ---------- */

test("конверт сообщения содержит длину вместе с полем длины", () => {
  const body = Buffer.from("test");
  const message = frame("P", body);
  assert.equal(String.fromCharCode(message[0]), "P");
  assert.equal(message.readInt32BE(1), body.length + 4);
  assert.equal(message.length, body.length + 5);
});

test("стартовое сообщение объявляет протокол 3.0 и параметры", () => {
  const message = startupMessage({ user: "rucrm", database: "crm" });
  assert.equal(message.readInt32BE(0), message.length, "длина покрывает всё сообщение");
  assert.equal(message.readInt32BE(4), 196608);
  const text = message.toString("utf8");
  assert.ok(text.includes("user"));
  assert.ok(text.includes("rucrm"));
  assert.ok(text.includes("crm"));
  assert.equal(message[message.length - 1], 0, "список параметров завершается нулём");
});

test("MD5-ответ считается по формуле md5(md5(пароль+логин)+соль)", () => {
  const salt = Buffer.from([1, 2, 3, 4]);
  const inner = crypto.createHash("md5").update("secretrucrm").digest("hex");
  const expected = crypto.createHash("md5").update(Buffer.concat([Buffer.from(inner), salt])).digest("hex");

  const message = md5PasswordMessage("rucrm", "secret", salt);
  assert.ok(message.toString("utf8").includes(`md5${expected}`));
});

test("Bind передаёт NULL отдельным маркером длины -1", () => {
  const message = bindMessage("", "", ["значение", null]);
  // после портала и имени (по одному нулевому байту) идут форматы и число параметров
  assert.ok(message.includes(Buffer.from("значение", "utf8")));
  assert.ok(message.includes(Buffer.from([0xff, 0xff, 0xff, 0xff])), "NULL кодируется длиной -1");
});

test("Writer собирает целые числа в сетевом порядке байтов", () => {
  const buf = new Writer().int16(258).int32(65536).build();
  assert.equal(buf.readInt16BE(0), 258);
  assert.equal(buf.readInt32BE(2), 65536);
});

/* ---------- разбор потока ---------- */

test("из потока вырезаются только полные сообщения", () => {
  const complete = frame("Z", Buffer.from([73]));
  const partial = frame("T", Buffer.alloc(20)).subarray(0, 8);

  const { messages, rest } = extractMessages(Buffer.concat([complete, complete, partial]));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, "Z");
  assert.equal(rest.length, partial.length, "неполный хвост остаётся до следующего чтения");
});

test("описание строки и данные разбираются в объект", () => {
  const field = (name, oid) => {
    const w = new Writer().cstring(name).int32(0).int16(0).int32(oid).int16(4).int32(-1).int16(0);
    return w.build();
  };
  const description = Buffer.concat([new Writer().int16(2).build(), field("id", 23), field("full_name", 25)]);
  const fields = readRowDescription(description);
  assert.deepEqual(fields.map((f) => f.name), ["id", "full_name"]);
  assert.equal(fields[0].oid, 23);

  const value = Buffer.from("Иванов", "utf8");
  const row = Buffer.concat([
    new Writer().int16(2).build(),
    new Writer().int32(2).bytes(Buffer.from("42")).build(),
    new Writer().int32(value.length).bytes(value).build(),
  ]);
  assert.deepEqual(readDataRow(row, fields), { id: 42, full_name: "Иванов" });
});

test("NULL в данных превращается в null, а не в пустую строку", () => {
  const fields = [{ name: "closed_at", oid: 25 }];
  const row = Buffer.concat([new Writer().int16(1).build(), new Writer().int32(-1).build()]);
  assert.equal(readDataRow(row, fields).closed_at, null);
});

test("значения приводятся к типам, совпадающим с поведением SQLite", () => {
  assert.equal(decodeValue(Buffer.from("42"), 23), 42);
  assert.equal(decodeValue(Buffer.from("1500.5"), 701), 1500.5);
  assert.equal(decodeValue(Buffer.from("t"), 16), 1, "логическое значение — 0/1, как в SQLite");
  assert.equal(decodeValue(Buffer.from("f"), 16), 0);
  assert.equal(decodeValue(Buffer.from("текст"), 25), "текст");
  assert.equal(decodeValue(null, 23), null);
});

test("ошибка сервера разбирается по полям", () => {
  const body = Buffer.concat([
    Buffer.from("SERROR\0"),
    Buffer.from("C23505\0"),
    Buffer.from("Mдубликат ключа\0"),
    Buffer.from([0]),
  ]);
  const fields = readErrorFields(body);
  assert.equal(fields.C, "23505");
  assert.equal(fields.M, "дубликат ключа");
});

/* ---------- SCRAM-SHA-256 ---------- */

test("SCRAM считается по вектору из RFC 7677", () => {
  // Официальный пример: пользователь user, пароль pencil
  const clientNonce = "rOprNGfwEbeRWgbNEkqO";
  const serverFirst = "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";

  const { clientFinal, serverSignature } = scramClientProof({
    password: "pencil",
    username: "user",
    clientNonce,
    serverFirst,
  });

  assert.equal(
    clientFinal,
    "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0," +
      "p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ="
  );
  assert.equal(serverSignature, "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");
});

test("подменённый сервером nonce отвергается", () => {
  assert.throws(
    () =>
      scramClientProof({
        password: "pencil",
        clientNonce: "мой-nonce",
        serverFirst: "r=чужой-nonce,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096",
      }),
    /чужой nonce/
  );
});

test("некорректное число итераций отвергается", () => {
  assert.throws(
    () => scramClientProof({ password: "p", clientNonce: "abc", serverFirst: "r=abcd,s=c2FsdA==,i=0" }),
    /число итераций/
  );
});

test("атрибуты SCRAM разбираются, включая значения со знаком равенства", () => {
  const attrs = parseScramAttributes("r=abc,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096");
  assert.equal(attrs.r, "abc");
  assert.equal(attrs.s, "W22ZaJ0SNY7soEsUEjb6gQ==");
  assert.equal(attrs.i, "4096");
});

test("первое SASL-сообщение содержит механизм и длину ответа", () => {
  const message = saslInitialMessage("SCRAM-SHA-256", "nonce123");
  const text = message.toString("utf8");
  assert.ok(text.includes("SCRAM-SHA-256"));
  assert.ok(text.includes("n,,n=,r=nonce123"));
});
