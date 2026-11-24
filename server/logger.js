/**
 * Структурированные логи.
 *
 * В продакшене — по строке JSON на событие: такие логи читают Loki, ELK и Yandex Cloud
 * Logging без парсеров-эвристик. В разработке — человекочитаемая строка.
 * Идентификатор запроса протягивается через AsyncLocalStorage, поэтому его
 * не нужно передавать параметром в каждую функцию.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const storage = new AsyncLocalStorage();

const envLevel = (process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug")).toLowerCase();
const threshold = LEVELS[envLevel] ?? LEVELS.info;
const asJson = process.env.LOG_FORMAT
  ? process.env.LOG_FORMAT === "json"
  : process.env.NODE_ENV === "production";

/** Поля, которые нельзя писать в лог даже случайно. */
const SECRET_KEYS = /^(password|password_hash|token|access_token|secret|code|code_hash|authorization)$/i;

function sanitize(value, depth = 0) {
  if (value === null || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEYS.test(key) ? "***" : sanitize(item, depth + 1);
  }
  return out;
}

function emit(level, event, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const context = storage.getStore();
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(context?.requestId ? { request_id: context.requestId } : {}),
    ...(context?.userId ? { user_id: context.userId } : {}),
    ...sanitize(fields),
  };

  const line = asJson
    ? JSON.stringify(record)
    : `${record.ts} ${level.toUpperCase().padEnd(5)} ${event} ${
        Object.keys(fields).length ? JSON.stringify(sanitize(fields)) : ""
      }`;

  if (level === "error") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  debug: (event, fields) => emit("debug", event, fields),
  info: (event, fields) => emit("info", event, fields),
  warn: (event, fields) => emit("warn", event, fields),
  error: (event, fields) => emit("error", event, fields),
  /** Ошибка целиком: сообщение и стек в отдельных полях, а не в тексте события. */
  exception: (event, err, fields = {}) =>
    emit("error", event, { ...fields, error: err?.message || String(err), stack: err?.stack }),
};

export const newRequestId = () => crypto.randomBytes(8).toString("hex");

/** Выполняет обработчик в контексте запроса: все логи внутри получат request_id. */
export function withRequestContext(context, fn) {
  return storage.run({ ...context }, fn);
}

export function setContextUser(userId) {
  const context = storage.getStore();
  if (context) context.userId = userId;
}

export const currentRequestId = () => storage.getStore()?.requestId || "";
