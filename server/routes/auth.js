/** Единая авторизация VAPELAB по одноразовому коду e-mail. */
import crypto from "node:crypto";
import { db, nowIso, repo } from "../db.js";
import { audit, consumeCode, findUserByEmail, issueCode, signToken } from "../auth.js";
import { HttpError, clientIp, get, patch, post, rateLimit } from "../http.js";
import { sendVerification } from "../notify.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cleanEmail = (value) => String(value || "").trim().toLowerCase();
const publicUser = (u) => {
  const isPrimaryAdmin = u.role === "superadmin";
  return {
    id: u.id,
    // The real address remains in the database for OTP delivery, but is never sent to the browser.
    email: isPrimaryAdmin ? "" : u.email,
    phone: isPrimaryAdmin || /^(?:visitor|staff|internal|no-phone):/.test(String(u.phone || "")) ? "" : u.phone,
    full_name: isPrimaryAdmin ? "Рабочий аккаунт" : u.full_name,
    role: u.role,
    email_verified: Boolean(u.email_verified),
    telegram_username: u.telegram_username || "",
  };
};
const genericResponse = { detail: "Если для этого адреса доступен вход, код отправлен на почту" };

post("/api/auth/request-code", async ({ body, req }) => {
  const email = cleanEmail(body.email);
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "Введите корректный адрес электронной почты");
  rateLimit(`auth-code-ip:${clientIp(req)}`, 8, 15 * 60_000);
  rateLimit(`auth-code-email:${email}`, 4, 15 * 60_000);

  let user = await findUserByEmail(email);
  if (!user) {
    if (body.pd_consent !== true) throw new HttpError(400, "Для создания личного профиля подтвердите согласие на обработку персональных данных");
    user = await repo.insert("users", {
      email,
      phone: `no-phone:${crypto.randomUUID()}`,
      full_name: String(body.full_name || "").trim().slice(0, 200),
      password_hash: "",
      role: "visitor",
      email_verified: 0,
      phone_verified: 1,
      is_active: 1,
      pd_consent_at: nowIso(),
    });
    await audit(user.id, "visitor_created", "user", user.id, null, clientIp(req));
  }

  if (!user.is_active) return { data: genericResponse };
  const code = await issueCode(user.id, "email");
  const delivery = await sendVerification("email", user.email, code);
  if (!delivery.ok) throw new HttpError(502, "Не удалось отправить письмо. Проверьте настройки почты или повторите позже");
  await audit(user.id, "auth_code_requested", "user", user.id, { role: user.role }, clientIp(req));
  return { data: genericResponse };
});

post("/api/auth/verify-code", async ({ body, req }) => {
  rateLimit(`auth-verify-ip:${clientIp(req)}`, 20, 10 * 60_000);
  const email = cleanEmail(body.email);
  const user = await findUserByEmail(email);
  if (!user || !user.is_active) throw new HttpError(400, "Неверный или просроченный код");
  const result = await consumeCode(user.id, "email", String(body.code || "").trim());
  if (!result.ok) throw new HttpError(400, result.error);

  const updated = await repo.update("users", user.id, { email_verified: 1, last_login_at: nowIso() });
  const fresh = updated || await repo.byId("users", user.id);
  await audit(user.id, "login", "user", user.id, { role: user.role }, clientIp(req));
  return { data: { access_token: signToken({ uid: user.id, role: user.role }), user: publicUser(fresh) } };
});

get("/api/auth/me", async ({ user }) => ({ data: publicUser(user) }), { auth: true, allowVisitor: true });

async function customerContact(user) {
  let contact = await db.get("SELECT * FROM contacts WHERE linked_user_id=? ORDER BY id LIMIT 1", [user.id]);
  if (!contact && user.email) contact = await db.get("SELECT * FROM contacts WHERE lower(email)=? ORDER BY id LIMIT 1", [String(user.email).toLowerCase()]);
  if (!contact) {
    contact = await repo.insert("contacts", {
      full_name: user.full_name || "Покупатель", phone: "", email: user.email || "", position: "",
      source: "account", tags: "customer-account", comment: "Профиль покупателя VAPELAB",
      company_id: null, owner_id: null, pd_consent: user.pd_consent_at ? 1 : 0,
      pd_consent_at: user.pd_consent_at || null, linked_user_id: user.id, updated_at: nowIso(),
    });
  } else if (Number(contact.linked_user_id) !== Number(user.id)) {
    contact = await repo.update("contacts", contact.id, { linked_user_id: user.id, updated_at: nowIso() }) || contact;
  }
  return contact;
}

get("/api/auth/customer-profile", async ({ user }) => {
  const contact = await customerContact(user);
  const orders = await db.all("SELECT * FROM orders WHERE contact_id=? ORDER BY created_at DESC,id DESC LIMIT 100", [contact.id]);
  const orderIds = orders.map((order) => order.id);
  const orderItems = orderIds.length ? await db.all(`SELECT * FROM order_items WHERE order_id IN (${orderIds.map(() => "?").join(",")}) ORDER BY order_id,id`, orderIds) : [];
  const conversations = await db.all("SELECT id,channel_type,subject,status,last_message_at,created_at FROM conversations WHERE contact_id=? ORDER BY last_message_at DESC,id DESC LIMIT 50", [contact.id]);
  const conversationIds = conversations.map((row) => row.id);
  const messages = conversationIds.length ? await db.all(`SELECT id,conversation_id,direction,body,created_at FROM messages WHERE conversation_id IN (${conversationIds.map(() => "?").join(",")}) ORDER BY id`, conversationIds) : [];
  const reservations = await db.all("SELECT id,number,product_name,quantity,status,total_price_minor,price_currency,price_calculated,created_at FROM store_reservations WHERE lower(email)=? ORDER BY created_at DESC,id DESC LIMIT 100", [String(user.email || "").toLowerCase()]);
  return { data: {
    user: publicUser(user),
    profile: {
      full_name: user.full_name || contact.full_name || "", phone: contact.phone || "", email: user.email || "",
      telegram_username: user.telegram_username || contact.telegram_username || "",
      delivery_address: contact.delivery_address || "", delivery_city: contact.delivery_city || "",
      delivery_postcode: contact.delivery_postcode || "", delivery_comment: contact.delivery_comment || "",
      telegram_linked: Boolean(user.telegram_chat_id),
    },
    orders: orders.map((order) => ({ ...order, items: orderItems.filter((item) => Number(item.order_id) === Number(order.id)) })),
    reservations,
    conversations: conversations.map((conversation) => ({ ...conversation, messages: messages.filter((message) => Number(message.conversation_id) === Number(conversation.id)) })),
  } };
}, { auth: true, allowVisitor: true });

patch("/api/auth/profile", async ({ body, user, req }) => {
  const full_name = String(body.full_name ?? user.full_name ?? "").trim().slice(0, 200);
  const telegramUsername = String(body.telegram_username ?? user.telegram_username ?? "").trim().replace(/^@/, "").slice(0, 64);
  if (telegramUsername && !/^[a-zA-Z0-9_]{5,64}$/.test(telegramUsername)) throw new HttpError(400, "Проверьте Telegram username");
  const updated = await repo.update("users", user.id, { full_name, telegram_username: telegramUsername });
  const contact = await customerContact(updated || user);
  await repo.update("contacts", contact.id, {
    full_name,
    phone: String(body.phone ?? contact.phone ?? "").trim().slice(0, 80),
    telegram_username: telegramUsername,
    delivery_address: String(body.delivery_address ?? contact.delivery_address ?? "").trim().slice(0, 500),
    delivery_city: String(body.delivery_city ?? contact.delivery_city ?? "").trim().slice(0, 120),
    delivery_postcode: String(body.delivery_postcode ?? contact.delivery_postcode ?? "").trim().slice(0, 32),
    delivery_comment: String(body.delivery_comment ?? contact.delivery_comment ?? "").trim().slice(0, 800),
    email: user.email || contact.email, updated_at: nowIso(),
  });
  await audit(user.id, "customer_profile_updated", "contact", contact.id, null, clientIp(req));
  return { data: publicUser(updated || await repo.byId("users", user.id)) };
}, { auth: true, allowVisitor: true });

post("/api/auth/telegram-link", async ({ user }) => {
  if (!config.telegram.token || !config.telegram.username) throw new HttpError(503, "Администратор ещё не настроил Telegram-бота для личного кабинета");
  const raw = crypto.randomBytes(24).toString("base64url");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const expires = new Date(Date.now() + 15 * 60_000).toISOString();
  await repo.update("users", user.id, { telegram_link_token_hash: hash, telegram_link_expires: expires });
  return { data: { url: `https://t.me/${config.telegram.username}?start=link_${raw}`, expires_at: expires } };
}, { auth: true, allowVisitor: true });

// Старые password-flow endpoints отключены, чтобы не оставлять параллельный способ входа.
post("/api/auth/login", async () => { throw new HttpError(410, "Вход по паролю отключён. Запросите код на e-mail"); });
post("/api/auth/register", async () => { throw new HttpError(410, "Регистрация выполняется через единое окно по e-mail"); });
