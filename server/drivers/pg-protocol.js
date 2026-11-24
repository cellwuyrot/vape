/**
 * Клиент PostgreSQL по бинарному протоколу 3.0 — без внешних зависимостей.
 *
 * Проект принципиально ставится без обращения к npm-реестру, поэтому пакет `pg`
 * здесь недоступен. Реализовано ровно то, что нужно CRM:
 *   • StartupMessage и согласование TLS (SSLRequest);
 *   • аутентификация: trust, cleartext, MD5, SCRAM-SHA-256 (умолчание современных версий);
 *   • расширенный протокол запросов Parse/Bind/Describe/Execute/Sync с параметрами;
 *   • простой протокол Query для DDL из нескольких инструкций;
 *   • декодирование значений по OID типа.
 *
 * Функции кодирования и SCRAM экспортируются отдельно — они покрыты юнит-тестами
 * без работающего сервера (test/pg-protocol.test.js).
 */
import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";

const PROTOCOL_VERSION = 196608; // 3.0
const SSL_REQUEST_CODE = 80877103;

/* ------------------------------------------------------------------ */
/*  Разбор строки подключения                                          */
/* ------------------------------------------------------------------ */

/** postgres://user:pass@host:5432/db?sslmode=require */
export function parseConnectionString(dsn) {
  const url = new URL(dsn);
  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new Error(`Ожидается postgres:// в строке подключения, получено ${url.protocol}`);
  }
  const sslmode = url.searchParams.get("sslmode") || process.env.PGSSLMODE || "prefer";
  return {
    host: decodeURIComponent(url.hostname || "127.0.0.1"),
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username || process.env.PGUSER || "postgres"),
    password: decodeURIComponent(url.password || process.env.PGPASSWORD || ""),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
    sslmode,
    applicationName: url.searchParams.get("application_name") || "rucrm",
    caFile: url.searchParams.get("sslrootcert") || process.env.PGSSLROOTCERT || "",
    // Схема задаётся при подключении: иначе в пуле у каждого соединения свой search_path
    searchPath: url.searchParams.get("search_path") || process.env.PGSEARCHPATH || "",
  };
}

/* ------------------------------------------------------------------ */
/*  Сборка сообщений                                                   */
/* ------------------------------------------------------------------ */

/** Накопитель байтов: избавляет от ручного подсчёта смещений. */
export class Writer {
  constructor() {
    this.chunks = [];
  }
  int8(value) {
    this.chunks.push(Buffer.from([value & 0xff]));
    return this;
  }
  int16(value) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(value);
    this.chunks.push(b);
    return this;
  }
  int32(value) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(value);
    this.chunks.push(b);
    return this;
  }
  bytes(buf) {
    this.chunks.push(Buffer.from(buf));
    return this;
  }
  /** Строка с завершающим нулём — базовый строковый тип протокола. */
  cstring(value) {
    this.chunks.push(Buffer.from(String(value), "utf8"), Buffer.from([0]));
    return this;
  }
  build() {
    return Buffer.concat(this.chunks);
  }
}

/** Оборачивает тело в конверт протокола: [тип][длина вместе с полем длины][тело]. */
export function frame(type, body) {
  const length = Buffer.alloc(4);
  length.writeInt32BE(body.length + 4);
  return type ? Buffer.concat([Buffer.from(type, "ascii"), length, body]) : Buffer.concat([length, body]);
}

export function startupMessage({ user, database, applicationName = "rucrm", searchPath = "" }) {
  const w = new Writer().int32(PROTOCOL_VERSION);
  w.cstring("user").cstring(user);
  w.cstring("database").cstring(database);
  w.cstring("application_name").cstring(applicationName);
  // Единый формат дат в обеих СУБД — ISO-8601 в UTC.
  w.cstring("DateStyle").cstring("ISO, YMD");
  w.cstring("client_encoding").cstring("UTF8");
  if (searchPath) w.cstring("search_path").cstring(searchPath);
  w.int8(0);
  return frame(null, w.build());
}

export function sslRequestMessage() {
  return frame(null, new Writer().int32(SSL_REQUEST_CODE).build());
}

/** Пароль в открытом виде (AuthenticationCleartextPassword). */
export const passwordMessage = (password) => frame("p", new Writer().cstring(password).build());

/** MD5-аутентификация: md5(md5(пароль + логин) + соль). */
export function md5PasswordMessage(user, password, salt) {
  const md5 = (data) => crypto.createHash("md5").update(data).digest("hex");
  const inner = md5(Buffer.concat([Buffer.from(password, "utf8"), Buffer.from(user, "utf8")]));
  const outer = md5(Buffer.concat([Buffer.from(inner, "utf8"), Buffer.from(salt)]));
  return frame("p", new Writer().cstring(`md5${outer}`).build());
}

export function parseMessage(name, sql) {
  const w = new Writer().cstring(name).cstring(sql).int16(0);
  return frame("P", w.build());
}

export function bindMessage(portal, statement, params) {
  const w = new Writer().cstring(portal).cstring(statement);
  w.int16(0); // все параметры передаём текстом
  w.int16(params.length);
  for (const param of params) {
    if (param === null || param === undefined) {
      w.int32(-1);
      continue;
    }
    const buf = Buffer.from(String(param), "utf8");
    w.int32(buf.length).bytes(buf);
  }
  w.int16(0); // результат тоже текстом
  return frame("B", w.build());
}

export const describeMessage = (portal) => frame("D", new Writer().int8(0x50).cstring(portal).build());
export const executeMessage = (portal, max = 0) => frame("E", new Writer().cstring(portal).int32(max).build());
export const syncMessage = () => frame("S", Buffer.alloc(0));
export const terminateMessage = () => frame("X", Buffer.alloc(0));
export const simpleQueryMessage = (sql) => frame("Q", new Writer().cstring(sql).build());

/* ------------------------------------------------------------------ */
/*  SCRAM-SHA-256 (RFC 5802 / RFC 7677)                                */
/* ------------------------------------------------------------------ */

const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
const sha256 = (data) => crypto.createHash("sha256").update(data).digest();

const xor = (a, b) => Buffer.from(a.map((byte, i) => byte ^ b[i]));

/** Разбирает `r=...,s=...,i=...` в объект. */
export function parseScramAttributes(text) {
  return Object.fromEntries(
    String(text)
      .split(",")
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf("=");
        return [pair.slice(0, eq), pair.slice(eq + 1)];
      })
  );
}

/**
 * Вычисляет доказательство клиента и подпись, которую обязан вернуть сервер.
 * Вынесено из сетевого кода, чтобы проверяться векторами из RFC 7677.
 *
 * PostgreSQL берёт имя пользователя из StartupMessage и требует пустое n=,
 * поэтому username по умолчанию пуст. Параметр оставлен ради проверки
 * алгоритма официальным вектором RFC, где имя присутствует.
 */
export function scramClientProof({ password, clientNonce, serverFirst, username = "" }) {
  const attrs = parseScramAttributes(serverFirst);
  const serverNonce = attrs.r;
  if (!serverNonce || !serverNonce.startsWith(clientNonce)) {
    throw new Error("SCRAM: сервер вернул чужой nonce");
  }
  const salt = Buffer.from(attrs.s, "base64");
  const iterations = Number(attrs.i);
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error("SCRAM: некорректное число итераций");

  const saltedPassword = crypto.pbkdf2Sync(Buffer.from(password, "utf8"), salt, iterations, 32, "sha256");
  const clientKey = hmac(saltedPassword, "Client Key");
  const storedKey = sha256(clientKey);

  const clientFirstBare = `n=${username},r=${clientNonce}`;
  const clientFinalWithoutProof = `c=biws,r=${serverNonce}`;
  const authMessage = `${clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;

  const clientSignature = hmac(storedKey, authMessage);
  const proof = xor(clientKey, clientSignature).toString("base64");

  const serverKey = hmac(saltedPassword, "Server Key");
  const serverSignature = hmac(serverKey, authMessage).toString("base64");

  return {
    clientFinal: `${clientFinalWithoutProof},p=${proof}`,
    serverSignature,
  };
}

export function saslInitialMessage(mechanism, clientNonce, username = "") {
  const initial = Buffer.from(`n,,n=${username},r=${clientNonce}`, "utf8");
  const w = new Writer().cstring(mechanism).int32(initial.length).bytes(initial);
  return frame("p", w.build());
}

export const saslResponseMessage = (text) => frame("p", Buffer.from(text, "utf8"));

/* ------------------------------------------------------------------ */
/*  Разбор входящего потока                                            */
/* ------------------------------------------------------------------ */

/** Вырезает из буфера все полные сообщения. Возвращает их и непрочитанный хвост. */
export function extractMessages(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 5) {
    const type = String.fromCharCode(buffer[offset]);
    const length = buffer.readInt32BE(offset + 1);
    if (buffer.length - offset < length + 1) break;
    messages.push({ type, body: buffer.subarray(offset + 5, offset + 1 + length) });
    offset += length + 1;
  }
  return { messages, rest: buffer.subarray(offset) };
}

/** OID типов, которые имеет смысл приводить к числу и логическому значению. */
const INT_OIDS = new Set([20, 21, 23, 26, 28, 29]);
const FLOAT_OIDS = new Set([700, 701, 1700]);

export function decodeValue(raw, oid) {
  if (raw === null) return null;
  const text = raw.toString("utf8");
  if (INT_OIDS.has(oid)) {
    const value = Number(text);
    return Number.isSafeInteger(value) ? value : text;
  }
  if (FLOAT_OIDS.has(oid)) return Number(text);
  if (oid === 16) return text === "t" ? 1 : 0; // логическое значение хранится как 0/1 — как в SQLite
  return text;
}

export function readRowDescription(body) {
  const count = body.readInt16BE(0);
  const fields = [];
  let offset = 2;
  for (let i = 0; i < count; i += 1) {
    const end = body.indexOf(0, offset);
    const name = body.subarray(offset, end).toString("utf8");
    offset = end + 1;
    const oid = body.readInt32BE(offset + 6);
    offset += 18;
    fields.push({ name, oid });
  }
  return fields;
}

export function readDataRow(body, fields) {
  const count = body.readInt16BE(0);
  const row = {};
  let offset = 2;
  for (let i = 0; i < count; i += 1) {
    const length = body.readInt32BE(offset);
    offset += 4;
    if (length === -1) {
      row[fields[i]?.name ?? i] = null;
      continue;
    }
    const raw = body.subarray(offset, offset + length);
    offset += length;
    row[fields[i]?.name ?? i] = decodeValue(raw, fields[i]?.oid ?? 25);
  }
  return row;
}

/** ErrorResponse и NoticeResponse: набор полей вида [код][значение\0]. */
export function readErrorFields(body) {
  const fields = {};
  let offset = 0;
  while (offset < body.length && body[offset] !== 0) {
    const code = String.fromCharCode(body[offset]);
    const end = body.indexOf(0, offset + 1);
    fields[code] = body.subarray(offset + 1, end).toString("utf8");
    offset = end + 1;
  }
  return fields;
}

export class PostgresError extends Error {
  constructor(fields) {
    super(fields.M || "Ошибка PostgreSQL");
    this.name = "PostgresError";
    this.code = fields.C || "";
    this.detail = fields.D || "";
    this.where = fields.W || "";
  }
}

/* ------------------------------------------------------------------ */
/*  Соединение                                                         */
/* ------------------------------------------------------------------ */

export class Connection {
  constructor(options) {
    this.options = options;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.queue = [];
    this.waiter = null;
    this.closed = false;
    this.error = null;
    this.statementCounter = 0;
  }

  /* --- транспорт --- */

  async connect() {
    const { host, port, sslmode } = this.options;
    let socket = await this.#openSocket(host, port);

    if (sslmode !== "disable") {
      socket = await this.#maybeUpgradeTls(socket);
    }
    this.#attach(socket);

    try {
      this.socket.write(startupMessage(this.options));
      await this.#authenticate();
      await this.#waitForReady();
    } catch (err) {
      // Отвергнутое соединение нужно закрыть, иначе сокет висит до таймаута сервера
      this.closed = true;
      socket.destroy();
      throw err;
    }
    return this;
  }

  #openSocket(host, port) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
  }

  async #maybeUpgradeTls(plainSocket) {
    const { sslmode, host, caFile } = this.options;
    plainSocket.write(sslRequestMessage());
    const answer = await new Promise((resolve, reject) => {
      plainSocket.once("data", resolve);
      plainSocket.once("error", reject);
    });

    if (answer[0] !== 0x53 /* 'S' */) {
      if (sslmode === "require" || sslmode === "verify-full") {
        plainSocket.destroy();
        throw new Error("Сервер PostgreSQL отказал в TLS, а sslmode требует шифрования");
      }
      return plainSocket; // sslmode=prefer — продолжаем без шифрования
    }

    const secure = tls.connect({
      socket: plainSocket,
      servername: host,
      // verify-full — полная проверка цепочки; иначе доверяем каналу внутри периметра
      rejectUnauthorized: sslmode === "verify-full",
      ...(caFile && fs.existsSync(caFile) ? { ca: fs.readFileSync(caFile) } : {}),
    });
    await new Promise((resolve, reject) => {
      secure.once("secureConnect", resolve);
      secure.once("error", reject);
    });
    return secure;
  }

  #attach(socket) {
    this.socket = socket;
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      const { messages, rest } = extractMessages(this.buffer);
      this.buffer = rest;
      for (const message of messages) this.#push(message);
    });
    socket.on("error", (err) => this.#fail(err));
    socket.on("close", () => this.#fail(new Error("Соединение с PostgreSQL закрыто")));
  }

  #push(message) {
    if (this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = null;
      resolve(message);
      return;
    }
    this.queue.push(message);
  }

  #fail(err) {
    this.closed = true;
    this.error = err;
    if (this.waiter) {
      const { reject } = this.waiter;
      this.waiter = null;
      reject(err);
    }
  }

  #read() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(this.error || new Error("Соединение закрыто"));
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  /* --- аутентификация --- */

  async #authenticate() {
    const { user, password } = this.options;
    let clientNonce = "";
    let serverSignature = "";

    for (;;) {
      const message = await this.#read();
      if (message.type === "E") throw new PostgresError(readErrorFields(message.body));
      if (message.type !== "R") continue; // параметры сервера и ключ отмены игнорируем

      const code = message.body.readInt32BE(0);
      if (code === 0) return; // AuthenticationOk

      if (code === 3) {
        this.socket.write(passwordMessage(password));
      } else if (code === 5) {
        this.socket.write(md5PasswordMessage(user, password, message.body.subarray(4, 8)));
      } else if (code === 10) {
        const mechanisms = message.body
          .subarray(4)
          .toString("utf8")
          .split("\0")
          .filter(Boolean);
        if (!mechanisms.includes("SCRAM-SHA-256")) {
          throw new Error(`Сервер предлагает только ${mechanisms.join(", ")} — механизм не поддерживается`);
        }
        clientNonce = crypto.randomBytes(18).toString("base64");
        this.socket.write(saslInitialMessage("SCRAM-SHA-256", clientNonce));
      } else if (code === 11) {
        const serverFirst = message.body.subarray(4).toString("utf8");
        const proof = scramClientProof({ password, clientNonce, serverFirst });
        serverSignature = proof.serverSignature;
        this.socket.write(saslResponseMessage(proof.clientFinal));
      } else if (code === 12) {
        const attrs = parseScramAttributes(message.body.subarray(4).toString("utf8"));
        if (attrs.v !== serverSignature) throw new Error("SCRAM: сервер не подтвердил свою подлинность");
      } else {
        throw new Error(`Неподдерживаемый метод аутентификации PostgreSQL: ${code}`);
      }
    }
  }

  async #waitForReady() {
    for (;;) {
      const message = await this.#read();
      if (message.type === "E") throw new PostgresError(readErrorFields(message.body));
      if (message.type === "Z") return;
    }
  }

  /* --- запросы --- */

  /** Расширенный протокол: один запрос с параметрами. */
  async query(sql, params = []) {
    if (this.closed) throw this.error || new Error("Соединение закрыто");
    const name = "";
    this.socket.write(
      Buffer.concat([
        parseMessage(name, sql),
        bindMessage("", name, params),
        describeMessage(""),
        executeMessage(""),
        syncMessage(),
      ])
    );

    let fields = [];
    const rows = [];
    let command = "";
    let rowCount = 0;
    let failure = null;

    for (;;) {
      const message = await this.#read();
      switch (message.type) {
        case "T":
          fields = readRowDescription(message.body);
          break;
        case "D":
          rows.push(readDataRow(message.body, fields));
          break;
        case "C": {
          const tag = message.body.subarray(0, -1).toString("utf8");
          command = tag.split(" ")[0];
          const parts = tag.split(" ");
          rowCount = Number(parts[parts.length - 1]) || rows.length;
          break;
        }
        case "E":
          failure = new PostgresError(readErrorFields(message.body));
          break;
        case "Z":
          if (failure) throw failure;
          return { rows, rowCount, command };
        default:
          break; // 1, 2, n, s — служебные подтверждения
      }
    }
  }

  /** Простой протокол: несколько инструкций одним пакетом (для DDL миграций). */
  async exec(sql) {
    if (this.closed) throw this.error || new Error("Соединение закрыто");
    this.socket.write(simpleQueryMessage(sql));
    let failure = null;
    for (;;) {
      const message = await this.#read();
      if (message.type === "E") failure = new PostgresError(readErrorFields(message.body));
      if (message.type === "Z") {
        if (failure) throw failure;
        return;
      }
    }
  }

  async end() {
    if (this.closed || !this.socket) return;
    try {
      this.socket.write(terminateMessage());
    } catch {
      // сокет уже мог закрыться — молча выходим
    }
    this.closed = true;
    this.socket.destroy();
  }
}
