/** Единый инбокс: диалоги из мессенджеров и ответы сотрудников. */
import { db, repo } from "../db.js";
import { audit } from "../auth.js";
import { HttpError, clientIp, get, patch, post } from "../http.js";
import { CHANNELS } from "../channels.js";
import { reply } from "../inbox.js";

get("/api/inbox/conversations", async ({ query, user }) => {
  const conditions = [];
  const params = [];
  const channel = query.get("channel");
  const status = query.get("status");
  if (channel && CHANNELS[channel]) { conditions.push("channel_type = ?"); params.push(channel); }
  if (status) { conditions.push("status = ?"); params.push(status); }
  if (query.get("mine") === "1") { conditions.push("assignee_id = ?"); params.push(user.id); }

  const rows = await db.all(
    `SELECT c.*, ct.full_name AS contact_name, ct.phone AS contact_phone,
            (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS preview
     FROM conversations c
     LEFT JOIN contacts ct ON ct.id = c.contact_id
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY c.last_message_at DESC LIMIT 200`,
    params
  );
  return { data: rows };
}, { auth: true });

get("/api/inbox/conversations/:id", async ({ params, user, req }) => {
  const conv = await repo.byId("conversations", params.id);
  if (!conv) throw new HttpError(404, "Диалог не найден");
  await repo.update("conversations", conv.id, { unread_count: 0 });
  await audit(user.id, "read", "conversation", conv.id, null, clientIp(req));
  return {
    data: {
      ...conv,
      unread_count: 0,
      contact: conv.contact_id ? await repo.byId("contacts", conv.contact_id) : null,
      messages: await db.all("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id", [conv.id]),
    },
  };
}, { auth: true });

post("/api/inbox/conversations/:id/reply", async ({ params, body, user, req }) => {
  if (user.role === "viewer") throw new HttpError(403, "Роль «наблюдатель» не может отвечать клиентам");
  const conv = await repo.byId("conversations", params.id);
  if (!conv) throw new HttpError(404, "Диалог не найден");
  const text = String(body.body || "").trim();

  // Вложение прикладывается по идентификатору из /api/files: ссылку клиент не выдумывает
  let attachmentUrl = String(body.attachment_url || "");
  let attachmentId = null;
  if (body.attachment_id) {
    const attachment = await repo.byId("attachments", body.attachment_id);
    if (!attachment) throw new HttpError(404, "Вложение не найдено");
    attachmentId = attachment.id;
    attachmentUrl = `/api/files/${attachment.id}`;
  }
  if (!text && !attachmentUrl) throw new HttpError(400, "Пустое сообщение");

  const message = await reply(conv, text, user.id, attachmentUrl, attachmentId);
  await audit(user.id, "reply", "conversation", conv.id, null, clientIp(req));
  return { data: message };
}, { auth: true });

patch("/api/inbox/conversations/:id", async ({ params, body, user }) => {
  if (user.role === "viewer") throw new HttpError(403, "Недостаточно прав");
  const conv = await repo.byId("conversations", params.id);
  if (!conv) throw new HttpError(404, "Диалог не найден");
  const data = {};
  if (body.status) {
    if (!["open", "pending", "closed"].includes(body.status)) throw new HttpError(400, "Неизвестный статус");
    data.status = body.status;
  }
  if (body.assignee_id !== undefined) data.assignee_id = body.assignee_id;
  if (body.contact_id !== undefined) data.contact_id = body.contact_id;
  return { data: await repo.update("conversations", conv.id, data) };
}, { auth: true });

/**长-poll: фронтенд узнаёт о новых сообщениях без постоянного опроса. */
get("/api/inbox/updates", async ({ query }) => {
  const since = Number(query.get("since") || 0);
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const row = await db.get("SELECT MAX(id) AS last FROM messages");
    const last = Number(row?.last || 0);
    if (last > since) return { data: { last_message_id: last, changed: true } };
    await new Promise((r) => setTimeout(r, 1000));
  }
  const row = await db.get("SELECT MAX(id) AS last FROM messages");
  return { data: { last_message_id: Number(row?.last || 0), changed: false } };
}, { auth: true });
