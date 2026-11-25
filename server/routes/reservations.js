/** Бронирования каталога: только запрос резерва, без оплаты и дистанционной продажи. */
import crypto from "node:crypto";
import { db, nowIso, repo } from "../db.js";
import { HttpError, get, post, patch, rateLimit, clientIp } from "../http.js";
import { audit } from "../auth.js";
import { config } from "../config.js";
import { sendEmail } from "../notify.js";
import { getChannel } from "../channels.js";
import { parseMoneyMinor, formatMoneyMinor } from "../money.js";

const managerOnly = (user) => {
  if (!user || !["superadmin", "admin", "manager"].includes(user.role)) throw new HttpError(403, "Недостаточно прав");
};
const siteAdminOnly = (user) => {
  if (!user || !["superadmin", "admin", "manager"].includes(user.role)) throw new HttpError(403, "Подключать уведомления могут администраторы и менеджеры");
};
const clean = (value, max = 500) => String(value ?? "").trim().slice(0, max);
const updateSetting = async (key, value) => db.run(
  "INSERT INTO store_settings(setting_key,setting_value,updated_at) VALUES(?,?,?) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=excluded.updated_at",
  [key, String(value ?? ""), nowIso()],
);
const readSetting = async (key) => (await db.get("SELECT setting_value FROM store_settings WHERE setting_key=?", [key]))?.setting_value || "";
const safePath = (value) => {
  const path = clean(value, 400);
  return path.startsWith("/") && !path.startsWith("//") && !/[<>\\\\]/.test(path) ? path : "/";
};

post("/api/store/reservations", async ({ body, req }) => {
  rateLimit(`store-reservation:${clientIp(req)}`, 6, 15 * 60_000);
  if (clean(body.website, 100)) return { status: 201, data: { accepted: true } };
  const productId = Number(body.product_id);
  if (!Number.isSafeInteger(productId) || productId < 1) throw new HttpError(400, "Не удалось определить товар");
  const product = await db.get("SELECT id,name,slug,sku,status,robots_index,availability_status,is_18_plus,is_reservable,price_raw,currency FROM store_products WHERE id=?", [productId]);
  if (!product || product.status !== "published") throw new HttpError(404, "Товар больше недоступен в каталоге");
  if (Number(product.is_reservable) === 0) throw new HttpError(409, "Для этого товара временно недоступно бронирование");
  const variants = await db.all("SELECT id,name,sku,price_raw,currency,availability_status FROM store_product_variants WHERE product_id=? ORDER BY sort_order,id", [productId]);
  let variant = null;
  const requestedVariantId = body.variant_id === null || body.variant_id === undefined || body.variant_id === "" ? null : Number(body.variant_id);
  if (requestedVariantId !== null) {
    if (!Number.isSafeInteger(requestedVariantId) || requestedVariantId < 1) throw new HttpError(400, "Некорректный вариант товара");
    variant = variants.find((item) => Number(item.id) === requestedVariantId) || null;
    if (!variant) throw new HttpError(400, "Выбранный цвет больше недоступен. Обновите страницу и выберите его снова.");
  } else if (variants.length > 1) {
    throw new HttpError(400, "Выберите цвет товара перед отправкой заявки");
  } else if (variants.length === 1) {
    variant = variants[0];
  }
  if ((variant?.availability_status || product.availability_status) === "out_of_stock") throw new HttpError(409, "Выбранный товар сейчас отсутствует в наличии");
  const variantImage = variant ? await db.get("SELECT url_original FROM store_product_images WHERE product_id=? AND variant_id=? ORDER BY position,id LIMIT 1", [productId, variant.id]) : null;
  const activePriceRaw = variant?.price_raw || product.price_raw;
  const activeCurrency = String(variant?.currency || product.currency || "RUB").toUpperCase();
  const customerName = clean(body.customer_name, 160);
  const phone = clean(body.phone, 80);
  const email = clean(body.email, 240).toLowerCase();
  const message = clean(body.message, 1200);
  const requestedQuantity = Number(body.quantity);
  if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1 || requestedQuantity > 20) throw new HttpError(400, "Количество должно быть от 1 до 20 штук");
  const quantity = requestedQuantity;
  const unitPriceMinor = parseMoneyMinor(activePriceRaw);
  const totalPriceMinor = unitPriceMinor === null ? null : unitPriceMinor * quantity;
  const priceCurrency = activeCurrency;
  if (customerName.length < 2 || phone.length < 6) throw new HttpError(400, "Укажите имя и корректный номер телефона");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Проверьте адрес электронной почты");
  if (body.pd_consent !== true) throw new HttpError(400, "Подтвердите согласие на обработку персональных данных");
  const is18Plus = Number(product.is_18_plus) === 1;
  if (is18Plus && body.age_confirmed !== true) throw new HttpError(400, "Подтвердите, что вам исполнилось 18 лет");
  const now = nowIso();
  const stamp = now.replace(/[-:TZ.]/g, "").slice(2, 12);
  const number = `VPL-${stamp}-${crypto.randomInt(100000, 999999)}`;
  const reservation = await repo.insert("store_reservations", {
    number, product_id: product.id, product_name: product.name, product_slug: product.slug || "", product_sku: product.sku || "",
    variant_id: variant?.id ?? null, variant_name: variant?.name || "", variant_sku: variant?.sku || "", variant_image_url: variantImage?.url_original || "",
    customer_name: customerName, phone, email, quantity, message, status: "new", is_18_plus: is18Plus ? 1 : 0,
    age_confirmed: is18Plus ? 1 : 0, pd_consent_at: now, source_path: safePath(body.source_path),
    unit_price_minor: unitPriceMinor ?? 0, total_price_minor: totalPriceMinor ?? 0,
    price_currency: priceCurrency, price_raw_snapshot: String(activePriceRaw || "").slice(0, 120),
    price_calculated: unitPriceMinor === null ? 0 : 1,
    manager_id: null, manager_note: "", email_notified: 0, telegram_notified: 0, created_at: now, updated_at: now,
  });
  const text = [
    `Новое бронирование VAPELAB: ${number}`,
    `Товар: ${product.name}`,
    `Артикул: ${variant?.sku || product.sku || "не указан"}`,
    variant ? `Цвет: ${variant.name}` : "",
    variantImage?.url_original ? `Фото выбранного цвета: ${variantImage.url_original}` : "",
    `Количество: ${quantity}`,
    `Цена за единицу: ${unitPriceMinor === null ? (activePriceRaw || "не указана / неоднозначна") : formatMoneyMinor(unitPriceMinor, priceCurrency)}`,
    `Итоговая стоимость: ${totalPriceMinor === null ? "уточнит менеджер" : formatMoneyMinor(totalPriceMinor, priceCurrency)}`,
    `Клиент: ${customerName}`,
    `Телефон: ${phone}`,
    email ? `E-mail: ${email}` : "",
    message ? `Комментарий: ${message}` : "",
    `18+: ${is18Plus ? "да, подтверждено" : "нет"}`,
    `Источник: ${safePath(body.source_path)}`,
  ].filter(Boolean).join("\n");
  let emailOk = false;
  try {
    const delivery = await sendEmail(config.mailbox.address, `Бронирование ${number} · VAPELAB`, text);
    emailOk = Boolean(delivery.ok && !delivery.dev);
  } catch { emailOk = false; }
  const chatId = await readSetting("telegram_reservation_chat_id");
  let telegramOk = false;
  if (chatId) {
    try {
      const delivery = await getChannel("telegram").send(chatId, text);
      telegramOk = Boolean(delivery.ok && !delivery.dev);
    } catch { telegramOk = false; }
  }
  await repo.update("store_reservations", reservation.id, { email_notified: emailOk ? 1 : 0, telegram_notified: telegramOk ? 1 : 0, updated_at: nowIso() });
  return { status: 201, data: { accepted: true, number, price: { calculated: unitPriceMinor !== null, unit_price_minor: unitPriceMinor, total_price_minor: totalPriceMinor, currency: priceCurrency } } };
});

get("/api/store/reservations", async ({ user, query }) => {
  managerOnly(user);
  const page = Math.max(1, Number(query.get("page") || 1) || 1);
  const pageSize = Math.max(10, Math.min(100, Number(query.get("page_size") || 50) || 50));
  const status = clean(query.get("status"), 30);
  const q = clean(query.get("q"), 120);
  const clauses = [];
  const params = [];
  if (["new", "confirmed", "declined", "ready", "completed", "cancelled"].includes(status)) { clauses.push("status=?"); params.push(status); }
  if (q) { clauses.push("(number LIKE ? OR product_name LIKE ? OR customer_name LIKE ? OR phone LIKE ? OR email LIKE ?)"); const pattern = `%${q}%`; params.push(pattern, pattern, pattern, pattern, pattern); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const count = await db.get(`SELECT COUNT(*) AS total FROM store_reservations ${where}`, params);
  const total = Number(count?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const rows = await db.all(`SELECT * FROM store_reservations ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (safePage - 1) * pageSize]);
  return { data: { reservations: rows, pagination: { page: safePage, page_size: pageSize, total, total_pages: totalPages } } };
}, { auth: true });

patch("/api/store/reservations/:id", async ({ params, body, user, req }) => {
  managerOnly(user);
  const row = await repo.byId("store_reservations", params.id);
  if (!row) throw new HttpError(404, "Бронирование не найдено");
  const allowed = ["new", "confirmed", "declined", "ready", "completed", "cancelled"];
  if (body.status !== undefined && !allowed.includes(body.status)) throw new HttpError(400, "Недопустимый статус бронирования");
  const updated = await repo.update("store_reservations", row.id, {
    status: body.status ?? row.status,
    manager_note: body.manager_note === undefined ? row.manager_note : clean(body.manager_note, 2000),
    manager_id: user.id,
    updated_at: nowIso(),
  });
  await audit(user.id, "reservation_updated", "store_reservation", row.id, { status: updated.status }, clientIp(req));
  return { data: updated };
}, { auth: true });



post("/api/store/reservations/:id/notify", async ({ params, user, req }) => {
  managerOnly(user);
  const row = await repo.byId("store_reservations", params.id);
  if (!row) throw new HttpError(404, "Бронирование не найдено");
  const text = [
    `Бронирование VAPELAB: ${row.number}`,
    `Товар: ${row.product_name}`,
    `Артикул: ${row.product_sku || "не указан"}`,
    `Количество: ${row.quantity}`,
    `Цена за единицу: ${Number(row.price_calculated) ? formatMoneyMinor(Number(row.unit_price_minor), row.price_currency) : (row.price_raw_snapshot || "не указана / неоднозначна")}`,
    row.variant_name ? `Цвет: ${row.variant_name}` : "",
    row.variant_image_url ? `Фото выбранного цвета: ${row.variant_image_url}` : "",
    `Итоговая стоимость: ${Number(row.price_calculated) ? formatMoneyMinor(Number(row.total_price_minor), row.price_currency) : "уточнит менеджер"}`,
    `Клиент: ${row.customer_name}`,
    `Телефон: ${row.phone}`,
    row.email ? `E-mail: ${row.email}` : "",
    row.message ? `Комментарий: ${row.message}` : "",
    `18+: ${row.is_18_plus ? "да, подтверждено" : "нет"}`,
    `Источник: ${row.source_path || "/"}`,
    `Статус: ${row.status}`,
  ].filter(Boolean).join("\n");
  let emailOk = Boolean(row.email_notified);
  if (!emailOk) {
    try {
      const delivery = await sendEmail(config.mailbox.address, `Бронирование ${row.number} · VAPELAB`, text);
      emailOk = Boolean(delivery.ok && !delivery.dev);
    } catch { emailOk = false; }
  }
  let telegramOk = Boolean(row.telegram_notified);
  const chatId = await readSetting("telegram_reservation_chat_id");
  if (!telegramOk && chatId) {
    try {
      const delivery = await getChannel("telegram").send(chatId, text);
      telegramOk = Boolean(delivery.ok && !delivery.dev);
    } catch { telegramOk = false; }
  }
  const updated = await repo.update("store_reservations", row.id, { email_notified: emailOk ? 1 : 0, telegram_notified: telegramOk ? 1 : 0, updated_at: nowIso() });
  await audit(user.id, "reservation_notifications_retried", "store_reservation", row.id, { email: emailOk, telegram: telegramOk }, clientIp(req));
  return { data: { email_notified: emailOk, telegram_notified: telegramOk, reservation: updated } };
}, { auth: true });

get("/api/store/reservations/telegram-status", async ({ user }) => {
  siteAdminOnly(user);
  const chatId = await readSetting("telegram_reservation_chat_id");
  return { data: { linked: Boolean(chatId), bot_configured: Boolean(config.telegram.token), webhook_configured: Boolean(config.publicUrl), chat_id_suffix: chatId ? String(chatId).slice(-4) : "" } };
}, { auth: true });

post("/api/store/reservations/telegram-link", async ({ user }) => {
  siteAdminOnly(user);
  if (!config.telegram.token) throw new HttpError(503, "Сначала добавьте TELEGRAM_BOT_TOKEN в .env и перезапустите сервер");
  if (!config.publicUrl) throw new HttpError(503, "Для Telegram webhook нужен публичный HTTPS-адрес: задайте PUBLIC_URL после публикации сайта");
  const token = `vpl_${crypto.randomBytes(24).toString("base64url")}`;
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  await updateSetting("telegram_reservation_link_hash", hash);
  await updateSetting("telegram_reservation_link_expires", expires);
  await updateSetting("telegram_reservation_link_user_id", user.id);
  return { data: { token, command: `/start ${token}`, expires_at: expires, ttl_minutes: 10 } };
}, { auth: true });
