/** Публичный чат сайта, привязанный к существующим conversations/messages CRM. */
import crypto from "node:crypto";
import { db, nowIso, repo } from "../db.js";
import { signToken, verifyToken } from "../auth.js";
import { HttpError, get, post, rateLimit, clientIp } from "../http.js";

const clean = (value, max = 500) => String(value ?? "").trim().slice(0, max);
const CHAT_TOKEN_HEADER = "x-webchat-token";
const tokenFrom = (req) => clean(req.headers[CHAT_TOKEN_HEADER], 4096);

function decodeChatToken(token) {
  if (!token) return null;
  const payload = verifyToken(token);
  if (payload?.scope !== "vapelab-webchat" || typeof payload.chat_id !== "string" || !/^[a-f0-9-]{24,64}$/i.test(payload.chat_id)) return null;
  return payload.chat_id;
}

async function findConversation(chatId) {
  return db.get("SELECT * FROM conversations WHERE channel_type='webchat' AND external_chat_id=?", [chatId]);
}

async function createConversation({ body, user, req, chatId }) {
  const now = nowIso();
  const name = clean(body.customer_name || user?.full_name || "Посетитель сайта", 160) || "Посетитель сайта";
  const email = clean(body.email || user?.email || "", 240).toLowerCase();
  const phone = clean(body.phone || "", 80);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Проверьте адрес электронной почты");
  const consent = body.pd_consent === true || Boolean(user?.pd_consent_at);
  if (!consent) throw new HttpError(400, "Подтвердите согласие на обработку персональных данных, чтобы начать диалог");

  let contact = email ? await db.get("SELECT * FROM contacts WHERE lower(email)=? ORDER BY id LIMIT 1", [email]) : null;
  if (!contact) {
    contact = await repo.insert("contacts", {
      full_name: name,
      phone,
      email,
      source: "webchat",
      tags: "webchat",
      comment: "Обращение из публичного чата VAPELAB.",
      pd_consent: 1,
      pd_consent_at: now,
      pd_retention_until: "",
      owner_id: null,
      updated_at: now,
    });
  } else if (consent && !contact.pd_consent) {
    contact = await repo.update("contacts", contact.id, { pd_consent: 1, pd_consent_at: now, updated_at: now }) || contact;
  }

  return repo.insert("conversations", {
    channel_type: "webchat",
    external_chat_id: chatId,
    contact_id: contact.id,
    assignee_id: null,
    status: "open",
    subject: "Обращение с сайта VAPELAB",
    unread_count: 0,
    last_message_at: now,
    created_at: now,
  });
}

post("/api/webchat/messages", async ({ body, req, user }) => {
  rateLimit(`webchat-ip:${clientIp(req)}`, 18, 10 * 60_000);
  if (clean(body.website, 120)) return { status: 201, data: { accepted: true } };
  const text = clean(body.message, 4000);
  if (!text) throw new HttpError(400, "Введите сообщение");
  if (text.length < 2) throw new HttpError(400, "Сообщение слишком короткое");

  const suppliedToken = tokenFrom(req);
  let chatId = suppliedToken ? decodeChatToken(suppliedToken) : null;
  if (suppliedToken && !chatId) throw new HttpError(401, "Сессия чата истекла. Начните новый диалог");
  let conversation = chatId ? await findConversation(chatId) : null;
  if (chatId && !conversation) throw new HttpError(404, "Диалог не найден. Начните новый диалог");

  if (!conversation) {
    chatId = crypto.randomUUID();
    conversation = await createConversation({ body, user, req, chatId });
  }

  rateLimit(`webchat-session:${chatId}`, 12, 60_000);
  const now = nowIso();
  const message = await repo.insert("messages", {
    conversation_id: conversation.id,
    direction: "inbound",
    body: text,
    attachment_url: "",
    author_user_id: null,
    external_message_id: `webchat-${crypto.randomUUID()}`,
    delivered: 1,
    error: "",
    created_at: now,
  });
  await repo.update("conversations", conversation.id, {
    unread_count: Number(conversation.unread_count || 0) + 1,
    last_message_at: now,
    status: conversation.status === "closed" ? "open" : conversation.status,
  });
  const token = suppliedToken || signToken({ scope: "vapelab-webchat", chat_id: chatId }, 24 * 30);
  return { status: 201, data: { accepted: true, chat_token: token, conversation_id: conversation.id, message } };
});

get("/api/webchat/messages", async ({ query, req }) => {
  rateLimit(`webchat-poll-ip:${clientIp(req)}`, 180, 60_000);
  const chatId = decodeChatToken(tokenFrom(req));
  if (!chatId) throw new HttpError(401, "Сессия чата не найдена или истекла");
  const conversation = await findConversation(chatId);
  if (!conversation) throw new HttpError(404, "Диалог не найден");
  const rawSince = Number(query.get("since") || 0);
  const since = Number.isSafeInteger(rawSince) && rawSince > 0 ? rawSince : 0;
  let messages;
  if (since) {
    messages = await db.all("SELECT id,direction,body,created_at FROM messages WHERE conversation_id=? AND id>? ORDER BY id LIMIT 100", [conversation.id, since]);
  } else {
    messages = await db.all("SELECT id,direction,body,created_at FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 50", [conversation.id]);
    messages.reverse();
  }
  const lastMessageId = messages.reduce((max, message) => Math.max(max, Number(message.id)), 0);
  return { data: { conversation_id: conversation.id, messages, last_message_id: lastMessageId } };
});
