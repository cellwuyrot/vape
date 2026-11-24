/**
 * Вложения: загрузка в файловое хранилище и выдача по ссылке.
 *
 * Принимаем два формата запроса: multipart/form-data из браузерной формы
 * и «сырое» тело с заголовком X-File-Name — так проще из скриптов и интеграций.
 * Файл всегда отдаётся через приложение, а не прямой ссылкой в бакет:
 * иначе персональные данные утекают по ссылке без проверки прав.
 */
import { audit } from "../auth.js";
import { config } from "../config.js";
import { repo } from "../db.js";
import { HttpError, clientIp, del, get, post, rateLimit, readRaw } from "../http.js";
import { log } from "../logger.js";
import { guessContentType, isAllowedUpload, safeFilename, storage } from "../storage.js";

/** Разбор multipart/form-data — минимальный, ровно под одно поле file. */
export function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!boundaryMatch) throw new HttpError(400, "Не указана граница multipart-запроса");
  const boundary = Buffer.from(`--${(boundaryMatch[1] || boundaryMatch[2]).trim()}`);

  const parts = [];
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    const from = start + boundary.length;
    if (buffer.subarray(from, from + 2).toString() === "--") break; // финальная граница
    const next = buffer.indexOf(boundary, from);
    if (next === -1) break;

    const chunk = buffer.subarray(from + 2, next - 2); // отбрасываем CRLF по краям
    const headerEnd = chunk.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      start = next;
      continue;
    }
    const headers = chunk.subarray(0, headerEnd).toString("utf8");
    const content = chunk.subarray(headerEnd + 4);
    const name = /name="([^"]*)"/i.exec(headers)?.[1] || "";
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1] || "";
    const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() || "";
    parts.push({ name, filename, contentType: type, content });
    start = next;
  }
  return parts;
}

post("/api/files", async ({ req, user }) => {
  if (user.role === "viewer") throw new HttpError(403, "Роль «наблюдатель» не может загружать файлы");
  rateLimit(`upload:${user.id}`, 60, 60_000);

  const contentType = req.headers["content-type"] || "";
  const raw = await readRaw(req, config.storage.maxFileSize);
  if (!raw.length) throw new HttpError(400, "Пустой файл");

  let filename;
  let body;
  let declaredType;

  if (contentType.startsWith("multipart/form-data")) {
    const part = parseMultipart(raw, contentType).find((p) => p.filename) || null;
    if (!part) throw new HttpError(400, "В запросе нет файла");
    filename = part.filename;
    body = part.content;
    declaredType = part.contentType;
  } else {
    filename = decodeURIComponent(String(req.headers["x-file-name"] || "file"));
    body = raw;
    declaredType = contentType;
  }

  filename = safeFilename(filename);
  if (!isAllowedUpload(filename)) throw new HttpError(415, "Файлы такого типа загружать нельзя");
  if (body.length > config.storage.maxFileSize) {
    throw new HttpError(413, `Файл больше допустимых ${Math.round(config.storage.maxFileSize / 1024 / 1024)} МБ`);
  }

  const type = declaredType && declaredType !== "application/octet-stream" ? declaredType : guessContentType(filename);
  const saved = await storage.put(filename, body, type);

  const attachment = await repo.insert("attachments", {
    storage_key: saved.key,
    backend: saved.backend,
    filename,
    content_type: type,
    size: body.length,
    checksum: saved.checksum,
    entity: String(req.headers["x-entity"] || ""),
    entity_id: String(req.headers["x-entity-id"] || ""),
    uploaded_by: user.id,
  });

  await audit(user.id, "upload", "attachment", attachment.id, { filename, size: body.length }, clientIp(req));
  if (saved.degraded) log.warn("files.degraded-write", { attachment_id: attachment.id });

  return {
    status: 201,
    data: { ...attachment, url: `/api/files/${attachment.id}`, degraded: Boolean(saved.degraded) },
  };
}, { auth: true, rawBody: true });

get("/api/files/:id", async ({ params, res, user, req }) => {
  const attachment = await repo.byId("attachments", params.id);
  if (!attachment) throw new HttpError(404, "Файл не найден");

  let content;
  try {
    content = await storage.get(attachment.storage_key, attachment.backend);
  } catch (err) {
    log.exception("files.read-failed", err, { attachment_id: attachment.id });
    throw new HttpError(502, "Хранилище файлов недоступно");
  }

  await audit(user.id, "download", "attachment", attachment.id, null, clientIp(req));

  res.writeHead(200, {
    "Content-Type": attachment.content_type || "application/octet-stream",
    "Content-Length": content.length,
    // attachment, а не inline: чужой HTML не должен исполняться в домене CRM
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=300",
  });
  res.end(content);
  return { handled: true };
}, { auth: true });

get("/api/files", async ({ query }) => {
  const entity = query.get("entity");
  const entityId = query.get("entity_id");
  const rows = entity
    ? await repo.list("attachments", {
        where: "entity = ? AND entity_id = ?",
        params: [entity, String(entityId || "")],
        limit: 100,
      })
    : await repo.list("attachments", { limit: 100 });
  return { data: rows.map((row) => ({ ...row, url: `/api/files/${row.id}` })) };
}, { auth: true });

del("/api/files/:id", async ({ params, user, req }) => {
  if (!["superadmin", "admin", "manager"].includes(user.role)) throw new HttpError(403, "Недостаточно прав");
  const attachment = await repo.byId("attachments", params.id);
  if (!attachment) throw new HttpError(404, "Файл не найден");

  await storage.remove(attachment.storage_key, attachment.backend).catch((err) =>
    log.exception("files.remove-failed", err, { attachment_id: attachment.id })
  );
  await repo.remove("attachments", attachment.id);
  await audit(user.id, "delete", "attachment", attachment.id, null, clientIp(req));
  return { status: 204, data: null };
}, { auth: true });
