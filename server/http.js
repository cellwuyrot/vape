/** Микро-роутер поверх node:http: без Express и прочих зависимостей. */
import { verifyToken } from "./auth.js";
import { repo } from "./db.js";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const routes = [];

export function route(method, pattern, handler, options = {}) {
  const keys = [];
  const regex = new RegExp(
    "^" +
      pattern.replace(/:([A-Za-z_]+)/g, (_, key) => {
        keys.push(key);
        return "([^/]+)";
      }) +
      "$"
  );
  routes.push({ method, regex, keys, handler, ...options });
}

export const get = (p, h, o) => route("GET", p, h, o);
export const post = (p, h, o) => route("POST", p, h, o);
export const patch = (p, h, o) => route("PATCH", p, h, o);
export const put = (p, h, o) => route("PUT", p, h, o);
export const del = (p, h, o) => route("DELETE", p, h, o);

/** Сырое тело запроса: нужно загрузке вложений, где JSON неприменим. */
export async function readRaw(req, maxSize = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxSize) throw new HttpError(413, "Слишком большой запрос");
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
}

export async function readJson(req) {
  const body = await readRaw(req);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "Некорректный JSON");
  }
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

export async function currentUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const user = await repo.byId("users", payload.uid);
  if (!user || !user.is_active) return null;
  return user;
}

export function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "";
}

/** Ограничитель частоты запросов в памяти: защита логина и вебхуков от перебора. */
const buckets = new Map();
export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = buckets.get(key)?.filter((t) => now - t < windowMs) || [];
  bucket.push(now);
  buckets.set(key, bucket);
  if (bucket.length > limit) throw new HttpError(429, "Слишком много запросов, попробуйте позже");
}
