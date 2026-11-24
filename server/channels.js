/**
 * Адаптеры каналов связи.
 *   normalizeWebhook(payload) — входящее сообщение клиента приводится к единому виду;
 *   send(chatId, text, attachment) — ответ сотрудника уходит клиенту в его мессенджер.
 * Новый канал = ещё один объект в реестре внизу файла.
 */
import { config } from "./config.js";
import { log } from "./logger.js";

export const CHANNELS = {
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  max: "MAX",
  avito: "Avito",
  email: "E-mail",
  webform: "Форма на сайте",
  webchat: "Чат сайта",
};

const telegram = {
  type: "telegram",
  normalizeWebhook(payload) {
    const msg = payload?.message || payload?.edited_message;
    if (!msg) return [];
    const from = msg.from || {};
    const name =
      [from.first_name, from.last_name].filter(Boolean).join(" ") ||
      from.username ||
      `Telegram ${msg.chat?.id}`;
    return [
      {
        channel_type: "telegram",
        external_chat_id: String(msg.chat?.id ?? ""),
        external_message_id: String(msg.message_id ?? ""),
        text: msg.text || msg.caption || "[вложение]",
        contact_name: name,
        contact_phone: msg.contact?.phone_number || "",
        telegram_username: String(from.username || "").replace(/^@/, "").slice(0, 64),
        attachment_url: "",
      },
    ];
  },
  async send(chatId, text, attachmentUrl = "") {
    if (!config.telegram.token) {
      log.info("channel.dev-send", { channel: "telegram", chat_id: chatId, text });
      return { ok: true, dev: true, messageId: "" };
    }
    const res = await fetch(`https://api.telegram.org/bot${config.telegram.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: attachmentUrl ? `${text}\n${attachmentUrl}` : text }),
    }).catch((err) => ({ ok: false, json: async () => ({ description: err.message }) }));
    const data = await res.json().catch(() => ({}));
    return {
      ok: Boolean(data.ok),
      messageId: String(data.result?.message_id || ""),
      error: data.ok ? "" : String(data.description || "Ошибка Telegram API"),
    };
  },
};

/** WhatsApp, MAX, Avito, Instagram Direct — через агрегатор Wazzup24 (серверы в РФ). */
const wazzup = {
  type: "whatsapp",
  normalizeWebhook(payload) {
    const list = Array.isArray(payload?.messages) ? payload.messages : [];
    return list
      .filter((m) => !m.isEcho && !["sent", "delivered", "read"].includes(m.status))
      .map((m) => ({
        channel_type: ["whatsapp", "max", "avito"].includes(String(m.chatType).toLowerCase())
          ? String(m.chatType).toLowerCase()
          : "whatsapp",
        external_chat_id: String(m.chatId ?? ""),
        external_message_id: String(m.messageId ?? ""),
        text: m.text || "[вложение]",
        contact_name: m.contact?.name || String(m.chatId ?? "Клиент"),
        contact_phone: m.contact?.phone || "",
        attachment_url: m.contentUri || "",
      }));
  },
  async send(chatId, text, attachmentUrl = "") {
    if (!config.wazzup.key) {
      log.info("channel.dev-send", { channel: "wazzup", chat_id: chatId, text });
      return { ok: true, dev: true, messageId: "" };
    }
    const res = await fetch("https://api.wazzup24.com/v3/message", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.wazzup.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chatId,
        chatType: "whatsapp",
        text,
        contentUri: attachmentUrl || undefined,
      }),
    }).catch((err) => ({ ok: false, text: async () => err.message }));
    if (!res.ok) return { ok: false, messageId: "", error: await res.text?.() || "Ошибка Wazzup" };
    const data = await res.json().catch(() => ({}));
    return { ok: true, messageId: String(data.messageId || ""), error: "" };
  },
};

const webchat = {
  type: "webchat",
  async send() {
    // Сообщения сайта доставляются посетителю через polling из общей таблицы messages.
    return { ok: true, messageId: `webchat-${Date.now()}`, error: "" };
  },
};

const logOnly = (type) => ({
  type,
  normalizeWebhook(payload) {
    return [
      {
        channel_type: type,
        external_chat_id: String(payload.chat_id || payload.email || payload.phone || "unknown"),
        external_message_id: "",
        text: payload.text || payload.message || "",
        contact_name: payload.name || "Клиент",
        contact_phone: payload.phone || "",
        attachment_url: "",
      },
    ];
  },
  async send(chatId, text) {
    log.info("channel.dev-send", { channel: type, chat_id: chatId, text });
    return { ok: true, messageId: "" };
  },
});

const REGISTRY = {
  telegram,
  whatsapp: wazzup,
  max: wazzup,
  avito: wazzup,
  email: logOnly("email"),
  webform: logOnly("webform"),
  webchat,
};

export const getChannel = (type) => REGISTRY[type] || null;

/** Автонастройка вебхука Telegram при старте, если задан PUBLIC_URL. */
export async function registerTelegramWebhook() {
  if (!config.telegram.token || !config.publicUrl) return;
  const url = `${config.publicUrl.replace(/\/$/, "")}/api/webhooks/telegram/${config.telegram.secret}`;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${config.telegram.token}/setWebhook?url=${encodeURIComponent(url)}`
    );
    const data = await res.json();
    if (data.ok) log.info("telegram.webhook-registered", { url });
    else log.warn("telegram.webhook-failed", { detail: data.description });
  } catch (err) {
    log.exception("telegram.webhook-error", err);
  }
}
