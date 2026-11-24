/**
 * Импорт базы: загрузка файла → предпросмотр с сопоставлением колонок → запись.
 *
 * Разобранный файл живёт в памяти процесса до подтверждения: гонять таблицу
 * на десять тысяч строк дважды по сети незачем, а класть её в базу до того,
 * как человек посмотрел на сопоставление колонок, — тем более.
 */
import crypto from "node:crypto";

import { audit } from "../auth.js";
import { config } from "../config.js";
import { repo } from "../db.js";
import { HttpError, clientIp, get, post, rateLimit, readRaw } from "../http.js";
import { ENTITY_FIELDS, applyImport, buildPreview } from "../importer.js";
import { parseMultipart } from "./files.js";
import { log } from "../logger.js";

const PENDING_TTL_MS = 30 * 60_000;
const pending = new Map();

function remember(payload) {
  const id = crypto.randomUUID();
  pending.set(id, { ...payload, at: Date.now() });
  for (const [key, value] of pending) if (Date.now() - value.at > PENDING_TTL_MS) pending.delete(key);
  return id;
}

get("/api/import/fields", async () => ({
  data: Object.fromEntries(
    Object.entries(ENTITY_FIELDS).map(([entity, meta]) => [entity, { label: meta.label, fields: meta.fields }])
  ),
}), { auth: true });

post("/api/import/preview", async ({ req, query, user }) => {
  if (user.role === "viewer") throw new HttpError(403, "Роль «наблюдатель» не может импортировать данные");
  rateLimit(`import:${user.id}`, 20, 60_000);

  const entity = query.get("entity") || "contacts";
  const contentType = req.headers["content-type"] || "";
  const raw = await readRaw(req, config.storage.maxFileSize);
  if (!raw.length) throw new HttpError(400, "Пустой файл");

  let filename = decodeURIComponent(String(req.headers["x-file-name"] || "import.csv"));
  let buffer = raw;
  if (contentType.startsWith("multipart/form-data")) {
    const part = parseMultipart(raw, contentType).find((p) => p.filename);
    if (!part) throw new HttpError(400, "В запросе нет файла");
    filename = part.filename;
    buffer = part.content;
  }

  const preview = buildPreview({ filename, buffer, entity });
  const id = remember({ entity, rows: preview.rows, headers: preview.headers, filename, profile: preview.profile, userId: user.id });

  log.info("import.preview", { entity, rows: preview.total, profile: preview.profile });
  return {
    data: {
      id,
      entity,
      filename,
      profile: preview.profile,
      profile_label: preview.profile_label,
      headers: preview.headers,
      mapping: preview.mapping,
      total: preview.total,
      sample: preview.sample,
      fields: preview.fields,
    },
  };
}, { auth: true, rawBody: true });

post("/api/import/apply", async ({ body, user, req }) => {
  if (user.role === "viewer") throw new HttpError(403, "Роль «наблюдатель» не может импортировать данные");
  const id = String(body.id || "");
  const job = pending.get(id);
  if (!job) throw new HttpError(410, "Предпросмотр отсутствует, истёк или уже использован. Загрузите файл заново.");
  if (job.processing) throw new HttpError(409, "Этот импорт уже выполняется. Дождитесь завершения операции.");

  job.processing = true;
  try {
    const stats = await applyImport({
      entity: job.entity,
      rows: job.rows,
      mapping: body.mapping || {},
      headers: job.headers,
      userId: user.id,
      filename: job.filename,
      profile: job.profile,
      dryRun: Boolean(body.dry_run),
    });

    if (!body.dry_run) {
      pending.delete(id);
      await audit(user.id, "import", job.entity, "", stats, clientIp(req));
      log.info("import.applied", { entity: job.entity, ...stats, errors: stats.errors.length });
    } else {
      job.processing = false;
    }
    return { data: stats };
  } catch (error) {
    job.processing = false;
    throw error;
  }
}, { auth: true });

get("/api/import/runs", async () => ({ data: await repo.list("import_runs", { limit: 50 }) }), { auth: true });
