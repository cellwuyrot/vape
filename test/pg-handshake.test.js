/**
 * Полный сетевой прогон драйвера PostgreSQL против мок-сервера,
 * который говорит на настоящем протоколе 3.0.
 *
 * Юнит-тесты проверяют кодирование сообщений по отдельности, а здесь работает
 * тот же класс Connection, что и в бою: рукопожатие, SCRAM-SHA-256 с проверкой
 * доказательства на стороне сервера, расширенный протокол запроса, ошибка сервера
 * и пул соединений. Настоящая СУБД для этого не нужна, поэтому тест идёт в CI всегда.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import test from "node:test";

import { Connection, Writer, extractMessages, frame } from "../server/drivers/pg-protocol.js";
import { createPostgresDriver } from "../server/drivers/postgres.js";

const PASSWORD = "секретный-пароль";
const SALT = crypto.randomBytes(16);
const ITERATIONS = 4096;

const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
const sha256 = (data) => crypto.createHash("sha256").update(data).digest();

/** Ответ на запрос: одна строка (id, full_name) — этого хватает для проверки разбора. */
function rowsResponse() {
  const field = (name, oid) =>
    new Writer().cstring(name).int32(0).int16(0).int32(oid).int16(-1).int32(-1).int16(0).build();

  const description = frame(
    "T",
    Buffer.concat([new Writer().int16(2).build(), field("id", 23), field("full_name", 25)])
  );
  const name = Buffer.from("Иванов Иван", "utf8");
  const dataRow = frame(
    "D",
    Buffer.concat([
      new Writer().int16(2).build(),
      new Writer().int32(2).bytes(Buffer.from("42")).build(),
      new Writer().int32(name.length).bytes(name).build(),
    ])
  );
  const complete = frame("C", new Writer().cstring("SELECT 1").build());
  return Buffer.concat([frame("1", Buffer.alloc(0)), frame("2", Buffer.alloc(0)), description, dataRow, complete]);
}

const readyForQuery = () => frame("Z", Buffer.from("I"));

const errorResponse = (code, message) =>
  frame(
    "E",
    Buffer.concat([
      Buffer.from(`SERROR\0`, "utf8"),
      Buffer.from(`C${code}\0`, "utf8"),
      Buffer.from(`M${message}\0`, "utf8"),
      Buffer.from([0]),
    ])
  );

/**
 * Мок-сервер PostgreSQL. Проверяет доказательство SCRAM по-настоящему:
 * неверный пароль клиента здесь не пройдёт.
 */
function startMockServer({ mode = "scram", failQuery = null } = {}) {
  const state = { queries: [], authenticated: false };
  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let stage = "startup";
    let clientFirstBare = "";
    let serverFirst = "";

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Стартовое сообщение и SSLRequest идут без байта типа
      if (stage === "startup") {
        if (buffer.length < 4) return;
        const length = buffer.readInt32BE(0);
        if (buffer.length < length) return;
        const body = buffer.subarray(4, length);
        buffer = buffer.subarray(length);

        if (length === 8 && body.readInt32BE(0) === 80877103) {
          socket.write(Buffer.from("N")); // TLS не предлагаем
          return;
        }

        state.startupParams = body.subarray(4).toString("utf8").split("\0").filter(Boolean);

        if (mode === "trust") {
          state.authenticated = true;
          stage = "query";
          socket.write(Buffer.concat([frame("R", new Writer().int32(0).build()), readyForQuery()]));
          return;
        }
        socket.write(
          frame("R", Buffer.concat([new Writer().int32(10).build(), Buffer.from("SCRAM-SHA-256\0\0", "utf8")]))
        );
        stage = "sasl-initial";
        return;
      }

      const { messages, rest } = extractMessages(buffer);
      buffer = rest;

      for (const message of messages) {
        if (stage === "sasl-initial" && message.type === "p") {
          const zero = message.body.indexOf(0);
          const payload = message.body.subarray(zero + 5).toString("utf8"); // после имени механизма и длины
          clientFirstBare = payload.replace(/^n,,/, "");
          const clientNonce = /r=([^,]+)/.exec(clientFirstBare)[1];

          serverFirst = `r=${clientNonce}${crypto.randomBytes(12).toString("base64")},s=${SALT.toString(
            "base64"
          )},i=${ITERATIONS}`;
          socket.write(
            frame("R", Buffer.concat([new Writer().int32(11).build(), Buffer.from(serverFirst, "utf8")]))
          );
          stage = "sasl-final";
          continue;
        }

        if (stage === "sasl-final" && message.type === "p") {
          const clientFinal = message.body.toString("utf8");
          const withoutProof = clientFinal.replace(/,p=.*$/, "");
          const proof = Buffer.from(/p=(.+)$/.exec(clientFinal)[1], "base64");

          const saltedPassword = crypto.pbkdf2Sync(Buffer.from(PASSWORD, "utf8"), SALT, ITERATIONS, 32, "sha256");
          const storedKey = sha256(hmac(saltedPassword, "Client Key"));
          const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`;
          const clientSignature = hmac(storedKey, authMessage);
          const clientKey = Buffer.from(proof.map((byte, i) => byte ^ clientSignature[i]));

          if (!sha256(clientKey).equals(storedKey)) {
            socket.write(Buffer.concat([errorResponse("28P01", "неверный пароль"), readyForQuery()]));
            continue;
          }

          const serverSignature = hmac(hmac(saltedPassword, "Server Key"), authMessage).toString("base64");
          state.authenticated = true;
          stage = "query";
          socket.write(
            Buffer.concat([
              frame("R", Buffer.concat([new Writer().int32(12).build(), Buffer.from(`v=${serverSignature}`, "utf8")])),
              frame("R", new Writer().int32(0).build()),
              frame("S", Buffer.concat([Buffer.from("server_version\0"), Buffer.from("16.2\0")])),
              readyForQuery(),
            ])
          );
          continue;
        }

        if (message.type === "P") state.queries.push(message.body.toString("utf8").split("\0")[1]);
        if (message.type === "Q") {
          state.queries.push(message.body.subarray(0, -1).toString("utf8"));
          socket.write(Buffer.concat([frame("C", new Writer().cstring("CREATE TABLE").build()), readyForQuery()]));
          continue;
        }
        if (message.type === "S") {
          const failing = failQuery && state.queries.some((q) => q.includes(failQuery));
          socket.write(
            failing
              ? Buffer.concat([errorResponse("23505", "дубликат ключа"), readyForQuery()])
              : Buffer.concat([rowsResponse(), readyForQuery()])
          );
        }
      }
    });
    socket.on("error", () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        port: server.address().port,
        state,
        close: () =>
          new Promise((r) => {
            for (const socket of sockets) socket.destroy();
            server.close(r);
          }),
      })
    );
  });
}

/* ------------------------------------------------------------------ */

test("рукопожатие SCRAM-SHA-256 проходит против настоящего протокола", async () => {
  const mock = await startMockServer();
  try {
    const connection = await new Connection({
      host: "127.0.0.1",
      port: mock.port,
      user: "rucrm",
      password: PASSWORD,
      database: "crm",
      sslmode: "disable",
    }).connect();

    assert.equal(mock.state.authenticated, true, "сервер обязан признать доказательство клиента");
    assert.ok(mock.state.startupParams.includes("rucrm"));
    assert.ok(mock.state.startupParams.includes("crm"));
    await connection.end();
  } finally {
    await mock.close();
  }
});

test("неверный пароль отвергается сервером, а не проходит молча", async () => {
  const mock = await startMockServer();
  try {
    await assert.rejects(
      () =>
        new Connection({
          host: "127.0.0.1",
          port: mock.port,
          user: "rucrm",
          password: "не-тот-пароль",
          database: "crm",
          sslmode: "disable",
        }).connect(),
      /неверный пароль/
    );
  } finally {
    await mock.close();
  }
});

test("запрос с параметрами проходит полный цикл и возвращает типизированные строки", async () => {
  const mock = await startMockServer({ mode: "trust" });
  try {
    const connection = await new Connection({
      host: "127.0.0.1",
      port: mock.port,
      user: "rucrm",
      password: "",
      database: "crm",
      sslmode: "disable",
    }).connect();

    const result = await connection.query("SELECT id, full_name FROM contacts WHERE id = $1", [42]);
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.rows[0], { id: 42, full_name: "Иванов Иван" });
    assert.equal(typeof result.rows[0].id, "number");
    assert.ok(mock.state.queries[0].includes("SELECT id, full_name"));

    // Соединение переживает несколько запросов подряд
    const second = await connection.query("SELECT 1", []);
    assert.equal(second.rows.length, 1);
    await connection.end();
  } finally {
    await mock.close();
  }
});

test("ошибка сервера приходит исключением с кодом SQLSTATE", async () => {
  const mock = await startMockServer({ mode: "trust", failQuery: "INSERT" });
  try {
    const connection = await new Connection({
      host: "127.0.0.1",
      port: mock.port,
      user: "rucrm",
      password: "",
      database: "crm",
      sslmode: "disable",
    }).connect();

    await assert.rejects(
      () => connection.query("INSERT INTO orders (number) VALUES ($1)", ["2026-00001"]),
      (err) => err.code === "23505" && /дубликат ключа/.test(err.message)
    );
    await connection.end();
  } finally {
    await mock.close();
  }
});

test("драйвер поверх пула транслирует диалект и раздаёт соединения", async () => {
  const mock = await startMockServer({ mode: "trust" });
  try {
    const driver = await createPostgresDriver({
      url: `postgres://rucrm@127.0.0.1:${mock.port}/crm?sslmode=disable`,
      poolSize: 3,
    });

    const rows = await driver.all("SELECT * FROM contacts WHERE full_name LIKE ?", ["%иван%"]);
    assert.equal(rows.length, 1);

    const sent = mock.state.queries.at(-1);
    assert.match(sent, /ILIKE \$1/, "LIKE должен стать ILIKE, а ? — $1");

    // Параллельные запросы обслуживаются несколькими соединениями пула
    const parallel = await Promise.all([driver.get("SELECT 1"), driver.get("SELECT 1"), driver.get("SELECT 1")]);
    assert.equal(parallel.length, 3);

    const inserted = await driver.run("INSERT INTO contacts (full_name) VALUES (?)", ["Петров"]);
    assert.match(mock.state.queries.at(-1), /RETURNING id/, "INSERT должен получить RETURNING id");
    assert.equal(inserted.lastId, 42);

    await driver.close();
  } finally {
    await mock.close();
  }
});
