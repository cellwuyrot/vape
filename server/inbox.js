/** Приём входящих сообщений и отправка ответов из CRM. */
import { db, nowIso, repo } from "./db.js";
import { getChannel } from "./channels.js";
import { messagesIngested } from "./metrics.js";
import { log } from "./logger.js";

async function findOrCreateContact({ name, phone, source }) {
  if (phone) {
    const existing = await db.get("SELECT * FROM contacts WHERE phone = ?", [phone]);
    if (existing) return existing;
  }
  return repo.insert("contacts", {
    full_name: name || "Клиент",
    phone: phone || "",
    source,
  });
}

/** Входящее сообщение: создаёт контакт и диалог, если их ещё нет. */
export async function ingest(normalized) {
  const channelType = normalized.channel_type;
  const chatId = String(normalized.external_chat_id);

  let conv = await db.get(
    "SELECT * FROM conversations WHERE channel_type = ? AND external_chat_id = ?",
    [channelType, chatId]
  );

  if (!conv) {
    let linkedUser = null;
    if (channelType === "telegram") linkedUser = await db.get("SELECT id,email,full_name FROM users WHERE telegram_chat_id=? AND is_active=1 LIMIT 1", [chatId]);
    let contact = linkedUser ? await db.get("SELECT * FROM contacts WHERE linked_user_id=? ORDER BY id LIMIT 1", [linkedUser.id]) : null;
    if (!contact && linkedUser?.email) contact = await db.get("SELECT * FROM contacts WHERE lower(email)=? ORDER BY id LIMIT 1", [String(linkedUser.email).toLowerCase()]);
    if (!contact) {
      contact = await repo.insert("contacts", {
        full_name: linkedUser?.full_name || normalized.contact_name || "Клиент",
        phone: normalized.contact_phone || "",
        email: linkedUser?.email || "",
        source: channelType,
        tags: linkedUser ? "telegram,customer-account" : channelType,
        comment: linkedUser ? "Связанный Telegram-аккаунт покупателя VAPELAB." : "",
        pd_consent: linkedUser?.email ? 1 : 0,
        pd_consent_at: linkedUser?.email ? nowIso() : null,
        linked_user_id: linkedUser?.id || null,
        telegram_username: normalized.telegram_username || "",
        updated_at: nowIso(),
      });
    } else {
      const patch = {};
      if (linkedUser?.id) patch.linked_user_id = linkedUser.id;
      if (normalized.telegram_username) patch.telegram_username = normalized.telegram_username;
      if (Object.keys(patch).length) await repo.update("contacts", contact.id, { ...patch, updated_at: nowIso() });
    }
    conv = await repo.insert("conversations", {
      channel_type: channelType,
      external_chat_id: chatId,
      contact_id: contact.id,
      subject: (normalized.contact_name || "").slice(0, 200),
    });
  }

  const message = await repo.insert("messages", {
    conversation_id: conv.id,
    direction: "inbound",
    body: normalized.text || "",
    attachment_url: normalized.attachment_url || "",
    external_message_id: normalized.external_message_id || "",
  });

  await repo.update("conversations", conv.id, {
    unread_count: (conv.unread_count || 0) + 1,
    last_message_at: nowIso(),
    status: conv.status === "closed" ? "open" : conv.status,
  });

  messagesIngested.inc({ channel: channelType, direction: "inbound" });
  log.info("inbox.ingest", { channel: channelType, conversation_id: conv.id, message_id: message.id });
  return message;
}

/** Ответ сотрудника уходит клиенту в тот же канал, откуда он написал. */
export async function reply(conv, body, userId, attachmentUrl = "", attachmentId = null) {
  const channel = getChannel(conv.channel_type);
  const result = channel
    ? await channel.send(conv.external_chat_id, body, attachmentUrl)
    : { ok: false, error: "Канал не поддерживается" };

  const message = await repo.insert("messages", {
    conversation_id: conv.id,
    direction: "outbound",
    body,
    attachment_url: attachmentUrl,
    attachment_id: attachmentId,
    author_user_id: userId,
    external_message_id: result.messageId || "",
    delivered: result.ok ? 1 : 0,
    error: String(result.error || "").slice(0, 500),
  });

  await repo.update("conversations", conv.id, {
    last_message_at: nowIso(),
    unread_count: 0,
    assignee_id: conv.assignee_id ?? userId,
  });

  messagesIngested.inc({ channel: conv.channel_type, direction: "outbound" });
  if (!result.ok) log.warn("inbox.delivery-failed", { channel: conv.channel_type, error: result.error });
  return message;
}
