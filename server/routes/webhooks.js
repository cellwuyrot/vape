/**
 * Вебхуки мессенджеров: клиент пишет боту — сообщение попадает в инбокс CRM.
 *
 * Telegram: https://<домен>/api/webhooks/telegram/<TELEGRAM_WEBHOOK_SECRET>
 * Wazzup24 (WhatsApp / MAX / Avito): https://<домен>/api/webhooks/wazzup/<WAZZUP_WEBHOOK_SECRET>
 * Форма сайта: POST https://<домен>/api/webhooks/webform
 */
import crypto from "node:crypto";
import { config } from "../config.js";
import { db, nowIso } from "../db.js";
import { HttpError, clientIp, post, rateLimit } from "../http.js";
import { getChannel } from "../channels.js";
import { ingest } from "../inbox.js";

const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

post("/api/webhooks/telegram/:secret", async ({ params, body, req }) => {
  rateLimit(`wh:${clientIp(req)}`, 240, 60_000);
  if (!safeEqual(params.secret, config.telegram.secret)) throw new HttpError(403, "Неверный секрет вебхука");
  const incoming = body?.message || body?.edited_message;
  const startText = String(incoming?.text || "").trim();
  const accountLinkMatch = /^\/start\s+link_([a-zA-Z0-9_-]{24,80})$/.exec(startText);
  if (accountLinkMatch && incoming?.chat?.id) {
    const tokenHash = crypto.createHash("sha256").update(accountLinkMatch[1]).digest("hex");
    const target = await db.get("SELECT id,email FROM users WHERE telegram_link_token_hash=? AND telegram_link_expires>? AND is_active=1", [tokenHash, nowIso()]);
    if (!target) {
      await getChannel("telegram").send(String(incoming.chat.id), "Ссылка привязки устарела. Создайте новую в личном кабинете VAPELAB.");
      return { data: { ok: false, account_linked: false } };
    }
    const chatId = String(incoming.chat.id);
    const username = String(incoming.from?.username || "").replace(/^@/, "").slice(0, 64);
    await db.run("UPDATE users SET telegram_chat_id=?,telegram_username=?,telegram_link_token_hash='',telegram_link_expires='' WHERE id=? AND telegram_link_token_hash=?", [chatId, username, target.id, tokenHash]);
    let contact = await db.get("SELECT * FROM contacts WHERE linked_user_id=? ORDER BY id LIMIT 1", [target.id]);
    if (!contact) contact = await db.get("SELECT * FROM contacts WHERE lower(email)=? ORDER BY id LIMIT 1", [String(target.email).toLowerCase()]);
    if (contact) await db.run("UPDATE contacts SET linked_user_id=?,telegram_username=?,updated_at=? WHERE id=?", [target.id, username, nowIso(), contact.id]);
    await getChannel("telegram").send(chatId, "Telegram подключён к вашему личному кабинету VAPELAB. Теперь вы можете писать нам здесь, а ответы менеджера будут приходить в этот чат.");
    return { data: { ok: true, account_linked: true } };
  }
  const restockLinkMatch = /^\/start\s+restock_([a-zA-Z0-9_-]{24,80})$/.exec(startText);
  if (restockLinkMatch && incoming?.chat?.id) {
    const tokenHash = crypto.createHash("sha256").update(restockLinkMatch[1]).digest("hex");
    const target = await db.get("SELECT id,product_id,product_name,email,email_notified FROM store_restock_subscriptions WHERE telegram_link_token_hash=? AND telegram_link_expires>? AND status='active' LIMIT 1", [tokenHash, nowIso()]);
    if (!target) {
      await getChannel("telegram").send(String(incoming.chat.id), "Ссылка подписки устарела. Оформите уведомление о поступлении заново на сайте VAPELAB.");
      return { data: { ok: false, restock_linked: false } };
    }
    const chatId = String(incoming.chat.id);
    const username = String(incoming.from?.username || "").replace(/^@/, "").slice(0, 64);
    const linked = await db.run("UPDATE store_restock_subscriptions SET telegram_chat_id=?,telegram_username=COALESCE(NULLIF(?,''),telegram_username),telegram_link_token_hash='',telegram_link_expires='',updated_at=? WHERE id=? AND telegram_link_token_hash=?", [chatId, username, nowIso(), target.id, tokenHash]);
    if (!linked.changes) {
      await getChannel("telegram").send(chatId, "Не удалось подключить подписку. Создайте новую заявку на сайте VAPELAB.");
      return { data: { ok: false, restock_linked: false } };
    }
    const currentProduct = await db.get("SELECT name,slug,availability_status FROM store_products WHERE id=?", [target.product_id]);
    let telegramNotified = false;
    if (currentProduct?.availability_status === "in_stock") {
      const publicBase = String(config.publicUrl || "http://localhost:3000").replace(/\/$/, "");
      const sent = await getChannel("telegram").send(chatId, `Товар снова в наличии: ${currentProduct.name || target.product_name}\n${publicBase}/product/${encodeURIComponent(currentProduct.slug || "")}`);
      telegramNotified = Boolean(sent.ok && !sent.dev);
    } else {
      await getChannel("telegram").send(chatId, `Готово! Уведомим вас в Telegram, когда товар «${target.product_name}» снова появится в наличии.`);
    }
    const completed = (!target.email || Number(target.email_notified) === 1) && telegramNotified;
    await db.run("UPDATE store_restock_subscriptions SET telegram_notified=?,status=?,notified_at=?,updated_at=? WHERE id=?", [telegramNotified ? 1 : 0, completed ? "notified" : "active", completed ? nowIso() : "", nowIso(), target.id]);
    return { data: { ok: true, restock_linked: true, notified_immediately: telegramNotified } };
  }
  const linkMatch = /^\/start\s+(vpl_[a-zA-Z0-9_-]{24,80})$/.exec(startText);
  if (linkMatch) {
    const tokenHash = crypto.createHash("sha256").update(linkMatch[1]).digest("hex");
    const storedHash = (await db.get("SELECT setting_value FROM store_settings WHERE setting_key='telegram_reservation_link_hash'"))?.setting_value || "";
    const expires = (await db.get("SELECT setting_value FROM store_settings WHERE setting_key='telegram_reservation_link_expires'"))?.setting_value || "";
    const valid = storedHash && storedHash === tokenHash && Number.isFinite(Date.parse(expires)) && Date.parse(expires) > Date.now();
    if (valid && incoming?.chat?.id) {
      const consumed = await db.run("UPDATE store_settings SET setting_value='',updated_at=? WHERE setting_key='telegram_reservation_link_hash' AND setting_value=?", [nowIso(), tokenHash]);
      if (consumed.changes) {
        const chatId = String(incoming.chat.id);
        await db.run("INSERT INTO store_settings(setting_key,setting_value,updated_at) VALUES('telegram_reservation_chat_id',?,?) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=excluded.updated_at", [chatId, nowIso()]);
        await db.run("INSERT INTO store_settings(setting_key,setting_value,updated_at) VALUES('telegram_reservation_link_expires','',?) ON CONFLICT(setting_key) DO UPDATE SET setting_value='',updated_at=excluded.updated_at", [nowIso()]);
        await getChannel("telegram").send(chatId, "Уведомления о бронированиях VAPELAB подключены. Этот чат будет получать новые заявки.");
        return { data: { ok: true, reservation_notifications_linked: true } };
      }
    }
    return { data: { ok: false, reservation_notifications_linked: false } };
  }
  const messages = getChannel("telegram").normalizeWebhook(body);
  for (const message of messages) await ingest(message);
  return { data: { ok: true, ingested: messages.length } };
});

post("/api/webhooks/wazzup/:secret", async ({ params, body, req }) => {
  rateLimit(`wh:${clientIp(req)}`, 240, 60_000);
  if (!safeEqual(params.secret, config.wazzup.secret)) throw new HttpError(403, "Неверный секрет вебхука");
  const messages = getChannel("whatsapp").normalizeWebhook(body);
  for (const message of messages) await ingest(message);
  return { data: { ok: true, ingested: messages.length } };
});

/**
 * Заявка с сайта. Первичная запись персональных данных происходит здесь,
 * в вашей российской базе, — это и есть требование ч. 5 ст. 18 152-ФЗ.
 */
post("/api/webhooks/webform", async ({ body, req }) => {
  rateLimit(`form:${clientIp(req)}`, 30, 60_000);
  if (!body.name && !body.phone && !body.email) throw new HttpError(400, "Пустая заявка");
  const messages = getChannel("webform").normalizeWebhook(body);
  for (const message of messages) await ingest(message);
  return { data: { ok: true } };
});

/** Демо-эндпоинт: имитация входящего сообщения без подключения реальных каналов. */
post("/api/webhooks/simulate", async ({ body, user }) => {
  if (!user) throw new HttpError(401, "Требуется авторизация");
  const message = await ingest({
    channel_type: body.channel_type || "telegram",
    external_chat_id: String(body.external_chat_id || Math.floor(Math.random() * 900000 + 100000)),
    external_message_id: "",
    text: body.text || "Здравствуйте! Расскажите про условия.",
    contact_name: body.contact_name || "Новый клиент",
    contact_phone: body.contact_phone || "",
    attachment_url: "",
  });
  return { data: message };
}, { auth: true });
