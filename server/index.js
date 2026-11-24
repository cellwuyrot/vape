/**
 * RuCRM — единая точка входа: сайт и API на одном порту, без внешних зависимостей.
 * Запуск: npm start
 *
 * Что делает старт по порядку:
 *   1. проверяет конфигурацию и падает сразу, если в продакшене остались умолчания;
 *   2. подключает хранилище данных (SQLite или PostgreSQL) и накатывает миграции;
 *   3. поднимает файловое хранилище вложений;
 *   4. регистрирует расписание резервного копирования;
 *   5. открывает порт и включает корректную остановку по сигналу.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config, validateConfig } from "./config.js";
import { db, initDb } from "./db.js";
import { ensureAdmin } from "./auth.js";
import { HttpError, currentUser, readJson, routes, sendJson } from "./http.js";
import { registerTelegramWebhook } from "./channels.js";
import { log, newRequestId, setContextUser, withRequestContext } from "./logger.js";
import { observeHttp, renderMetrics, routeLabel } from "./metrics.js";
import { initStorage, storage } from "./storage.js";
import { schedule, stopAll } from "./scheduler.js";
import { lastBackupInfo, runBackupCycle } from "./backup.js";
import { currentVersion, loadMigrations } from "./migrate.js";
import { ensureTemplates } from "./documents.js";
import { runReminders } from "./tasks.js";
import { servePublicRoute, buildSitemapXml } from "./public-pages.js";

import "./routes/auth.js";
import "./routes/users.js";
import "./routes/crm.js";
import "./routes/supplies.js";
import "./routes/tasks.js";
import "./routes/pipelines.js";
import "./routes/inbox.js";
import "./routes/quick-replies.js";
import "./routes/import.js";
import "./routes/documents.js";
import "./routes/webhooks.js";
import "./routes/files.js";
import "./routes/store.js";
import "./routes/reservations.js";
import "./routes/mail.js";
import "./routes/analytics.js";
import "./routes/webchat.js";

export const VERSION = "2.2.0";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

/** Состояние готовности: балансировщик не должен слать трафик в неготовый процесс. */
const state = { ready: false, shuttingDown: false, schemaVersion: 0 };

function sendHtmlNotFound(req, res) {
  const accept = String(req.headers.accept || "");
  if (!accept.includes("text/html")) return sendJson(res, 404, { detail: "Не найдено" });
  const file = path.join(PUBLIC_DIR, "404.html");
  const body = fs.readFileSync(file);
  res.writeHead(404, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "same-origin",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

const notFound = (res) => sendJson(res, 404, { detail: "Не найдено" });

function publicBaseUrl(req) {
  if (config.publicUrl) {
    try {
      const parsed = new URL(config.publicUrl);
      if (["https:", "http:"].includes(parsed.protocol)) return parsed.origin;
    } catch { /* некорректный PUBLIC_URL будет отражён в конфигурационной проверке */ }
    return null;
  }
  if (!config.isProd) {
    const host = String(req.headers.host || `localhost:${config.port}`);
    try {
      const parsed = new URL(`${req.socket.encrypted ? "https" : "http"}://${host}`);
      if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) return parsed.origin;
    } catch { /* не используем непроверенный Host в абсолютных URL */ }
  }
  return null;
}

function serveRobots(req, res) {
  const base = publicBaseUrl(req);
  const lines = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /crm",
    "Disallow: /data/",
  ];
  if (base) lines.push(`Sitemap: ${base}/sitemap.xml`);
  const body = `${lines.join("\n")}\n`;
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

async function serveSitemap(req, res) {
  const base = publicBaseUrl(req);
  if (!base) {
    const body = "PUBLIC_URL должен быть задан для генерации публичной карты сайта.\n";
    res.writeHead(config.isProd ? 503 : 503, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
    });
    return res.end(req.method === "HEAD" ? undefined : body);
  }
  const body = await buildSitemapXml(base);
  if (!body) {
    const unavailable = "Не удалось сформировать sitemap.xml.\n";
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(unavailable), "Cache-Control": "no-store" });
    return res.end(req.method === "HEAD" ? undefined : unavailable);
  }
  res.writeHead(200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "public, max-age=900",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function serveStatic(req, res, pathname) {
  if (pathname === "/") {
    // Prefer the locally built React storefront. Keep the classic HTML entry as a safe
    // fallback until dependencies have been installed and the first Vite build exists.
    const reactEntry = path.join(PUBLIC_DIR, "react-app", "index.html");
    const fallbackEntry = path.join(PUBLIC_DIR, "storefront.html");
    const body = fs.readFileSync(fs.existsSync(reactEntry) ? reactEntry : fallbackEntry);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    });
    return res.end(req.method === "HEAD" ? undefined : body);
  }

  if (pathname === "/crm/") {
    res.writeHead(308, { Location: "/crm", "Cache-Control": "no-store" });
    return res.end();
  }
  if (pathname === "/crm") {
    const body = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "same-origin",
    });
    return res.end(req.method === "HEAD" ? undefined : body);
  }

  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return sendHtmlNotFound(req, res); }
  if (decoded.includes("\\") || decoded.includes("\0") || decoded.split("/").some((part) => part === ".." || part.startsWith("."))) {
    return sendHtmlNotFound(req, res);
  }
  // Catalog files created after migration are persistent and included in local backups.
  // Keep old public/uploads files readable until the operator copies them.
  const catalogMatch = /^\/uploads\/catalog\/([a-z0-9_-]+\.(?:jpe?g|png|webp))$/i.exec(decoded);
  const persistentRoot = path.resolve(config.storage.localDir, "catalog");
  const persistentFile = catalogMatch ? path.join(persistentRoot, catalogMatch[1]) : "";
  const usePersistent = Boolean(persistentFile && fs.existsSync(persistentFile));
  const baseDir = usePersistent ? persistentRoot : PUBLIC_DIR;
  const file = usePersistent ? persistentFile : path.resolve(PUBLIC_DIR, `.${decoded}`);
  const relative = path.relative(baseDir, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return sendHtmlNotFound(req, res);

  let target;
  try {
    target = fs.realpathSync(file);
    const realRelative = path.relative(fs.realpathSync(baseDir), target);
    if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) return sendHtmlNotFound(req, res);
    if (!fs.statSync(target).isFile()) return sendHtmlNotFound(req, res);
  } catch { return sendHtmlNotFound(req, res); }

  const ext = path.extname(target).toLowerCase();
  // HTML-документы доступны только по явным маршрутам / и /crm.
  if (ext === ".html" || !MIME[ext]) return sendHtmlNotFound(req, res);
  const body = fs.readFileSync(target);
  res.writeHead(200, {
    "Content-Type": MIME[ext],
    "Content-Length": body.length,
    "Cache-Control": ext === ".css" || ext === ".js" ? "no-cache, must-revalidate" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

/* ------------------------------------------------------------------ */
/*  Служебные эндпоинты                                                */
/* ------------------------------------------------------------------ */

/** Живость: процесс отвечает. Отдельно от готовности — этого требует Kubernetes и любой балансировщик. */
function handleHealth(res) {
  sendJson(res, 200, { status: "ok", version: VERSION, uptime_seconds: Math.round(process.uptime()) });
}

/**
 * Готовность: можно ли слать боевой трафик.
 * Проверяем базу, схему и файловое хранилище. При остановке сразу отвечаем 503,
 * чтобы балансировщик увёл трафик до закрытия сокета.
 */
async function handleReady(res) {
  if (state.shuttingDown) {
    return sendJson(res, 503, { status: "shutting_down", checks: {} });
  }

  const checks = {};
  let ok = true;

  const started = Date.now();
  try {
    await db.get("SELECT 1 AS ok");
    checks.database = { ok: true, kind: db.kind, latency_ms: Date.now() - started };
  } catch (err) {
    ok = false;
    checks.database = { ok: false, kind: db.kind, error: err.message };
  }

  const expected = loadMigrations().at(-1)?.version ?? 0;
  checks.schema = { ok: state.schemaVersion >= expected, applied: state.schemaVersion, expected };
  if (!checks.schema.ok) ok = false;

  const storageCheck = await storage.healthy();
  checks.storage = { ...storageCheck, backend: storage.backend };
  // Недоступность S3 не выводит узел из ротации: запись падает на локальный диск
  if (!storageCheck.ok) log.warn("ready.storage-degraded", { error: storageCheck.error });

  if (config.backup.enabled) {
    const last = await lastBackupInfo();
    checks.backup = last
      ? { ok: true, ...last }
      : { ok: true, detail: "копий пока нет, первая будет по расписанию" };
  }

  sendJson(res, ok ? 200 : 503, { status: ok ? "ready" : "not_ready", version: VERSION, checks });
}

/* ------------------------------------------------------------------ */
/*  Основной обработчик                                                */
/* ------------------------------------------------------------------ */

async function dispatch(req, res, url) {
  const { pathname } = url;

  if (!pathname.startsWith("/api/")) {
    if (!["GET", "HEAD"].includes(req.method)) return notFound(res);
    if (pathname === "/robots.txt") return serveRobots(req, res);
    if (pathname === "/sitemap.xml") return serveSitemap(req, res);
    if (await servePublicRoute(req, res, pathname, publicBaseUrl(req))) return;
    return serveStatic(req, res, pathname);
  }

  if (pathname === "/api/health") return handleHealth(res);
  if (pathname === "/api/ready") return handleReady(res);
  if (pathname === "/api/metrics") {
    const body = renderMetrics({ app_ready: state.ready ? 1 : 0, schema_version: state.schemaVersion });
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
    return res.end(body);
  }

  const match = routes
    .map((r) => ({ r, m: r.method === req.method ? pathname.match(r.regex) : null }))
    .find((x) => x.m);

  if (!match) return notFound(res);

  const { r, m } = match;
  const user = await currentUser(req);
  if (user) setContextUser(user.id);

  if (r.auth) {
    if (!user) throw new HttpError(401, "Требуется авторизация");
    if (!user.email_verified) throw new HttpError(403, "Подтвердите e-mail");
    if (user.role === "visitor" && !r.allowVisitor) throw new HttpError(403, "Этот раздел доступен сотрудникам VAPELAB");
  }

  const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  // Загрузка файлов читает тело сама: разбирать его как JSON нельзя
  const body = !r.rawBody && ["POST", "PUT", "PATCH"].includes(req.method) ? await readJson(req) : {};

  const result = (await r.handler({ req, res, params, body, query: url.searchParams, user })) || {};
  if (result.handled) return; // обработчик уже записал ответ сам (выдача файла)
  if (result.status === 204) {
    res.writeHead(204);
    return res.end();
  }
  sendJson(res, result.status || 200, result.data ?? {});
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const started = process.hrtime.bigint();
  const requestId = String(req.headers["x-request-id"] || newRequestId());

  await withRequestContext({ requestId }, async () => {
    res.setHeader("X-Request-Id", requestId);
    try {
      await dispatch(req, res, url);
    } catch (err) {
      if (err instanceof HttpError) {
        log.warn("http.rejected", { path: url.pathname, status: err.status, reason: err.message });
        sendJson(res, err.status, { detail: err.message });
      } else {
        log.exception("http.error", err, { path: url.pathname, method: req.method });
        if (!res.headersSent) sendJson(res, 500, { detail: "Внутренняя ошибка сервера" });
      }
    } finally {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = routeLabel(url.pathname);
      observeHttp({ method: req.method, route, status: res.statusCode, seconds });
      // Служебные опросы не засоряют лог: балансировщик стучится каждые несколько секунд
      const noisy = ["/api/health", "/api/ready", "/api/metrics"].includes(url.pathname);
      if (!noisy && url.pathname.startsWith("/api/")) {
        log.info("http.request", {
          method: req.method,
          route,
          status: res.statusCode,
          duration_ms: Number((seconds * 1000).toFixed(1)),
        });
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Сборка сервера                                                     */
/* ------------------------------------------------------------------ */

export async function createServer({ withScheduler = false } = {}) {
  const problems = validateConfig();
  if (problems.length) {
    if (config.isProd) throw new Error(`Конфигурация непригодна для продакшена:\n  — ${problems.join("\n  — ")}`);
    for (const problem of problems) log.warn("config.warning", { problem });
  }

  await initDb();
  state.schemaVersion = await currentVersion(db.driver);
  await ensureAdmin();
  await ensureTemplates();
  initStorage();

  if (withScheduler) {
    // Напоминания о задачах — единственная фоновая работа, которая нужна всегда:
    // без неё «перезвонить в четверг» так и останется строкой в базе.
    // Ноль в переменной выключает рассылку: так гасят фоновые задачи на лишних узлах
    if (config.tasks.reminderIntervalMinutes > 0) {
      schedule("task-reminders", config.tasks.reminderIntervalMinutes * 60_000, () => runReminders());
    }
    if (config.backup.enabled) {
      schedule("backup", config.backup.intervalHours * 3600_000, () => runBackupCycle(), { runOnStart: true });
    }
  }

  state.ready = true;
  return http.createServer(handler);
}

/** Корректная остановка: даём балансировщику увести трафик и дописать текущие ответы. */
export async function shutdown(server, signal) {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  state.ready = false;
  log.info("server.stopping", { signal });

  stopAll();
  const forced = setTimeout(() => {
    log.warn("server.force-exit");
    process.exit(1);
  }, 15_000);
  forced.unref?.();

  await new Promise((resolve) => server.close(resolve));
  await db.close().catch((err) => log.exception("db.close", err));
  clearTimeout(forced);
  log.info("server.stopped", {});
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const server = await createServer({ withScheduler: true });
  server.listen(config.port, () => {
    log.info("server.started", {
      url: `http://localhost:${config.port}`,
      storage: db.kind,
      files: storage.backend,
      schema_version: state.schemaVersion,
      admin: config.admin.email,
    });
    if (!config.isProd) log.info("server.hint", { detail: "коды подтверждения печатаются в этот же лог" });
  });

  registerTelegramWebhook();

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      shutdown(server, signal).then(() => process.exit(0));
    });
  }
  process.on("unhandledRejection", (err) => log.exception("unhandled.rejection", err));
  process.on("uncaughtException", (err) => log.exception("unhandled.exception", err));
}
