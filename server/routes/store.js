/** Контент витрины VAPELAB. Публичная часть только читает опубликованный контент. */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, nowIso, repo } from "../db.js";
import { HttpError, get, post, put, del, readRaw, rateLimit, clientIp } from "../http.js";
import { audit } from "../auth.js";
import { config } from "../config.js";
import { safeFilename } from "../storage.js";
import { sendEmail } from "../notify.js";
import { getChannel } from "../channels.js";
import { searchScore } from "../catalog-search.js";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");

const slugify = (value) => String(value || "").toLowerCase().trim()
  .replace(/ё/g, "e").replace(/[^a-z0-9а-я]+/gi, "-").replace(/^-|-$/g, "");
const json = (value, fallback = {}) => {
  if (typeof value !== "string") return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};
const adminOnly = (user) => {
  if (!user || !["superadmin", "admin", "manager"].includes(user.role)) throw new HttpError(403, "Недостаточно прав");
};
const siteAdminOnly = (user) => {
  if (!user || !["superadmin", "admin"].includes(user.role)) throw new HttpError(403, "Изменять публичные тексты и документы может только администратор");
};

const normalizeMatch = (value) => String(value || "")
  .normalize("NFKC")
  .toLocaleLowerCase("ru-RU")
  .replace(/ё/g, "е")
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim()
  .replace(/\s+/g, " ");

const IMAGE_MATCH_STOP_WORDS = new Set([
  "а", "без", "в", "во", "для", "до", "за", "из", "или", "и", "к", "на", "над", "не", "о", "об", "от", "по", "под", "при", "с", "со", "у",
  "the", "and", "for", "from", "with",
  "image", "images", "img", "photo", "photos", "picture", "pictures", "фото", "фотография", "изображение", "изображения", "картинка", "картинки",
  "main", "front", "back", "original", "копия", "оригинал",
]);
const imageMatchTokens = (value) => normalizeMatch(value).split(" ")
  .filter((token) => token.length > 1 && !/^\d+$/.test(token) && !IMAGE_MATCH_STOP_WORDS.has(token));
const imageAliasScore = (query, alias) => {
  const normalizedQuery = normalizeMatch(query);
  const normalizedAlias = normalizeMatch(alias);
  if (!normalizedQuery || !normalizedAlias) return 0;
  if (normalizedQuery === normalizedAlias) return 1;
  const queryTokens = new Set(imageMatchTokens(normalizedQuery));
  const aliasTokens = [...new Set(imageMatchTokens(normalizedAlias))];
  if (!queryTokens.size || !aliasTokens.length) return 0;
  const shared = aliasTokens.filter((token) => queryTokens.has(token)).length;
  if (aliasTokens.length === 1) return shared ? 0.72 : 0;
  if (shared < 2) return 0;
  const coverage = shared / aliasTokens.length;
  return coverage >= 0.7 ? 0.65 + coverage * 0.35 : 0;
};
const rankImageMatches = (hints, items, aliasesFor) => items
  .map((item) => ({
    item,
    score: Math.max(0, ...hints.flatMap((hint) => aliasesFor(item).map((alias) => imageAliasScore(hint, alias)))),
  }))
  .filter((candidate) => candidate.score > 0)
  .sort((a, b) => b.score - a.score);

const IMAGE_TYPES = {
  ".jpg": { mime: "image/jpeg", valid: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  ".jpeg": { mime: "image/jpeg", valid: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  ".png": { mime: "image/png", valid: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  ".webp": { mime: "image/webp", valid: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
};

const sanitizeNewsHtml = (value) => String(value || "").slice(0, 40000)
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/<(script|style|iframe|object|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
  .replace(/<(\/?)([a-z0-9]+)([^>]*)>/gi, (match, closing, rawTag, attrs) => {
    const tag = rawTag.toLowerCase();
    const allowed = new Set(["p", "h2", "h3", "strong", "b", "em", "i", "u", "ul", "ol", "li", "blockquote", "br", "a", "span"]);
    if (!allowed.has(tag)) return "";
    if (closing) return tag === "br" ? "" : `</${tag}>`;
    if (tag !== "a") return `<${tag}>`;
    const href = /href\s*=\s*(["'])(.*?)\1/i.exec(attrs)?.[2] || "";
    const safe = /^(https?:\/\/|\/product\/)[^\s"'<>]*$/i.test(href) ? href : "";
    return safe ? `<a href="${safe.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" rel="nofollow noopener">` : `<a rel="nofollow noopener">`;
  })
  .replace(/<\/span>/gi, "</span>");

const safeNewsImageUrl = (value) => {
  const raw = String(value || "").trim().slice(0, 1000);
  if (/^https:\/\//i.test(raw) || /^\/uploads\/news\/[a-z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(raw)) return raw;
  return "";
};

const normalizeStoreVariant = (body = {}, existing = null, productId = 0) => {
  const currentAttributes = json(existing?.attributes_json, {});
  const suppliedAttributes = body.attributes && typeof body.attributes === "object" && !Array.isArray(body.attributes) ? body.attributes : currentAttributes;
  const attributes = { ...suppliedAttributes };
  if (body.color !== undefined) {
    for (const key of Object.keys(attributes)) if (/цвет|color|colour|оттенок|shade/i.test(key)) delete attributes[key];
    if (String(body.color || "").trim()) attributes.color = String(body.color).trim().slice(0, 120);
  }
  const name = String(body.name || existing?.name || body.color || "").trim().slice(0, 180);
  if (!name) throw new HttpError(400, "Укажите название варианта или цвет");
  const sku = String(body.sku ?? existing?.sku ?? "").trim().slice(0, 100);
  const sortOrder = Number(body.sort_order ?? existing?.sort_order ?? 0);
  if (!Number.isFinite(sortOrder) || Math.abs(sortOrder) > 100000) throw new HttpError(400, "Некорректный порядок варианта");
  return {
    product_id: Number(productId || existing?.product_id), name, sku,
    attributes_json: JSON.stringify(attributes),
    description: String(body.description ?? existing?.description ?? "").trim().slice(0, 5000),
    availability_status: body.availability_status === undefined ? (existing?.availability_status || "") : (["", "in_stock", "out_of_stock", "preorder", "unknown"].includes(body.availability_status) ? body.availability_status : (() => { throw new HttpError(400, "Неизвестный статус наличия варианта"); })()),
    price_raw: String(body.price_raw ?? existing?.price_raw ?? "").trim().slice(0, 80),
    old_price_raw: String(body.old_price_raw ?? existing?.old_price_raw ?? "").trim().slice(0, 80),
    currency: String(body.currency ?? existing?.currency ?? "RUB").trim().toUpperCase().slice(0, 3) || "RUB",
    availability_label_raw: String(body.availability_label_raw ?? existing?.availability_label_raw ?? "").trim().slice(0, 120),
    sort_order: Math.trunc(sortOrder),
  };
};

const checkedVariantId = async (productId, rawVariantId) => {
  const variantId = Number(rawVariantId || 0);
  if (!variantId) return null;
  if (!Number.isSafeInteger(variantId) || variantId < 1) throw new HttpError(400, "Некорректный вариант товара");
  const variant = await db.get("SELECT id FROM store_product_variants WHERE id=? AND product_id=?", [variantId, productId]);
  if (!variant) throw new HttpError(404, "Вариант не найден у этого товара");
  return variantId;
};


const AVAILABILITY_STATES = new Set(["in_stock", "out_of_stock", "preorder", "unknown"]);
const availabilityLabel = (state) => ({ in_stock: "В наличии", out_of_stock: "Отсутствует", preorder: "Предзаказ", unknown: "Наличие уточняется" })[state] || "Наличие уточняется";

async function notifyRestockSubscribers(product) {
  const subscribers = await db.all("SELECT * FROM store_restock_subscriptions WHERE product_id=? AND status='active'", [product.id]);
  let emailSent = 0;
  let telegramSent = 0;
  const productUrl = `${String(config.publicUrl || "").replace(/\/$/, "")}/product/${product.slug}`;
  for (const subscriber of subscribers) {
    let emailNotified = Number(subscriber.email_notified) === 1;
    let telegramNotified = Number(subscriber.telegram_notified) === 1;
    if (subscriber.email && !emailNotified) {
      try {
        const result = await sendEmail(subscriber.email, `Товар снова в наличии · ${product.name}`, `Здравствуйте${subscriber.customer_name ? `, ${subscriber.customer_name}` : ""}!

Товар «${product.name}» снова доступен в каталоге VAPELAB.
${productUrl}

Это уведомление отправлено по вашему запросу о поступлении товара.`);
        emailNotified = Boolean(result.ok && !result.dev);
      } catch { emailNotified = false; }
      if (emailNotified) emailSent += 1;
    }
    if (subscriber.telegram_chat_id && !telegramNotified) {
      try {
        const result = await getChannel("telegram").send(subscriber.telegram_chat_id, `Товар снова в наличии: ${product.name}
${productUrl}`);
        telegramNotified = Boolean(result.ok && !result.dev);
      } catch { telegramNotified = false; }
      if (telegramNotified) telegramSent += 1;
    }
    const needsTelegram = Boolean(subscriber.telegram_chat_id || subscriber.telegram_username);
    const completed = (!subscriber.email || emailNotified) && (!needsTelegram || telegramNotified);
    await repo.update("store_restock_subscriptions", subscriber.id, {
      email_notified: emailNotified ? 1 : 0,
      telegram_notified: telegramNotified ? 1 : 0,
      status: completed ? "notified" : "active",
      notified_at: completed ? nowIso() : "",
      updated_at: nowIso(),
    });
  }
  return { subscribers: subscribers.length, email_sent: emailSent, telegram_sent: telegramSent };
}

async function publicNavigation() {
  const categories = await db.all(`SELECT c.id,c.parent_id,c.name,c.slug,c.description,c.sort_order,c.featured_product_id,
    (SELECT p.id FROM store_products p WHERE p.id=c.featured_product_id AND p.status='published') AS public_featured_product_id,
    (SELECT p.name FROM store_products p WHERE p.id=c.featured_product_id AND p.status='published') AS public_featured_product_name,
    (SELECT p.slug FROM store_products p WHERE p.id=c.featured_product_id AND p.status='published') AS public_featured_product_slug,
    (SELECT p.brand FROM store_products p WHERE p.id=c.featured_product_id AND p.status='published') AS public_featured_product_brand,
    (SELECT p.price_raw FROM store_products p WHERE p.id=c.featured_product_id AND p.status='published') AS public_featured_product_price,
    (SELECT i.url_original FROM store_product_images i WHERE i.product_id=c.featured_product_id ORDER BY i.position,i.id LIMIT 1) AS public_featured_product_image,
    COALESCE((SELECT p.slug FROM store_category_page_categories m JOIN store_category_pages p ON p.id=m.page_id WHERE m.category_id=c.id AND p.status='published' ORDER BY p.sort_order LIMIT 1), c.slug) AS public_slug
    FROM store_categories c WHERE c.is_active=1 ORDER BY c.sort_order,c.name`);
  const news = await db.all("SELECT id,title,slug,excerpt,body,body_html,image_url,image_hidden,is_18_plus,product_ids_json,published_at,source_url FROM store_news WHERE status='published' ORDER BY published_at DESC LIMIT 12");
  const settings = await db.all("SELECT setting_key,setting_value FROM store_settings");
  return { categories: categories.map((category) => ({
    ...category,
    featured_product: category.public_featured_product_id ? {
      id: category.public_featured_product_id, name: category.public_featured_product_name,
      slug: category.public_featured_product_slug, brand: category.public_featured_product_brand,
      price_raw: category.public_featured_product_price, image_url: category.public_featured_product_image,
    } : null,
  })), news, settings: Object.fromEntries(settings.map((s) => [s.setting_key, s.setting_value])) };
}

get("/api/store/navigation", async () => ({ data: await publicNavigation() }));

get("/api/store/public", async () => {
  const navigation = await publicNavigation();
  const products = await db.all("SELECT id,name,slug,sku,brand,product_type,format,description,specifications_json,price_raw,old_price_raw,currency,availability_label_raw,availability_status,is_18_plus,is_reservable,source_url,seo_h1,seo_title,seo_description,seo_keywords_json,canonical_url,robots_index,image_search_query FROM store_products WHERE status='published' ORDER BY name");
  const pages = await db.all("SELECT title,slug,page_type,body FROM store_pages WHERE status='published' AND legal_review_status='approved' ORDER BY title");
  const productIds = products.map((p) => p.id);
  const images = productIds.length ? await db.all(`SELECT id,product_id,variant_id,url_original,alt_raw,position,source_url,download_status FROM store_product_images WHERE product_id IN (${productIds.map(() => "?").join(",")}) ORDER BY position,id`, productIds) : [];
  const relations = productIds.length ? await db.all(`SELECT product_id,category_id FROM store_product_categories WHERE product_id IN (${productIds.map(() => "?").join(",")})`, productIds) : [];
  const variants = productIds.length ? await db.all(`SELECT id,product_id,name,sku,attributes_json,price_raw,old_price_raw,currency,availability_label_raw,availability_status,description,sort_order FROM store_product_variants WHERE product_id IN (${productIds.map(() => "?").join(",")}) ORDER BY sort_order,id`, productIds) : [];
  return { data: {
    ...navigation,
    products: products.map((p) => ({ ...p, specifications: json(p.specifications_json), images: images.filter((i) => i.product_id === p.id), variants: variants.filter((v) => v.product_id === p.id).map((v) => ({ ...v, attributes: json(v.attributes_json, {}), images: images.filter((i) => Number(i.variant_id) === Number(v.id)) })), category_ids: relations.filter((r) => r.product_id === p.id).map((r) => r.category_id) })),
    pages,
  } };
});

/** Похожие позиции: категории, бренд, тип, SEO-ключи и локальная история просмотров. */
get("/api/store/recommendations", async ({ query }) => {
  const productId = Number(query.get("product_id") || 0);
  const historyIds = [...new Set(String(query.get("history") || "").split(",")
    .map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0))].slice(0, 15);
  const categoryIds = [...new Set(String(query.get("categories") || "").split(",")
    .map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0))].slice(0, 25);
  const pageContext = normalizeMatch(String(query.get("context") || "").slice(0, 1600));
  const referenceIds = [...new Set([productId, ...historyIds].filter((value) => Number.isSafeInteger(value) && value > 0))];
  if (!referenceIds.length && !categoryIds.length && !pageContext) return { data: [] };

  const refs = referenceIds.length ? await db.all(
    `SELECT id,name,brand,product_type,format,description,seo_h1,seo_title,seo_description,seo_keywords_json
     FROM store_products WHERE status='published' AND id IN (${referenceIds.map(() => "?").join(",")})`,
    referenceIds,
  ) : [];
  const refCategories = refs.length ? await db.all(
    `SELECT product_id,category_id FROM store_product_categories WHERE product_id IN (${refs.map(() => "?").join(",")})`,
    refs.map((item) => item.id),
  ) : [];
  const current = refs.find((item) => Number(item.id) === productId) || null;
  const currentCategories = new Set([
    ...refCategories.filter((item) => Number(item.product_id) === productId).map((item) => Number(item.category_id)),
    ...categoryIds,
  ]);
  const historyCategoryWeight = new Map();
  for (const [index, id] of historyIds.entries()) {
    const weight = Math.max(1, 4 - index * 0.18);
    for (const rel of refCategories.filter((item) => Number(item.product_id) === id)) {
      const categoryId = Number(rel.category_id);
      historyCategoryWeight.set(categoryId, (historyCategoryWeight.get(categoryId) || 0) + weight);
    }
  }
  for (const id of categoryIds) historyCategoryWeight.set(id, (historyCategoryWeight.get(id) || 0) + 5);

  const referenceKeywords = new Set();
  const referenceTokens = new Set();
  for (const item of refs) {
    let keywords = [];
    try { keywords = JSON.parse(item.seo_keywords_json || "[]"); } catch { keywords = []; }
    for (const word of Array.isArray(keywords) ? keywords : []) {
      const normalized = normalizeMatch(word);
      if (normalized) referenceKeywords.add(normalized);
    }
    for (const token of normalizeMatch([item.name, item.brand, item.product_type, item.format, item.description, item.seo_h1, item.seo_title, item.seo_description].join(" ")).split(" ")) {
      if (token.length > 2) referenceTokens.add(token);
    }
  }
  for (const token of pageContext.split(" ")) if (token.length > 2) referenceTokens.add(token);
  const viewedCategories = categoryIds.length ? await db.all(
    `SELECT id,name,description FROM store_categories WHERE id IN (${categoryIds.map(() => "?").join(",")})`,
    categoryIds,
  ) : [];
  for (const category of viewedCategories) {
    for (const token of normalizeMatch([category.name, category.description].join(" ")).split(" ")) {
      if (token.length > 2) referenceTokens.add(token);
    }
  }

  const excluded = referenceIds;
  const candidates = await db.all(
    `SELECT id,name,slug,brand,product_type,format,description,price_raw,seo_h1,seo_title,seo_description,seo_keywords_json,updated_at
     FROM store_products WHERE status='published' ${excluded.length ? `AND id NOT IN (${excluded.map(() => "?").join(",")})` : ""}
     ORDER BY updated_at DESC,name LIMIT 1200`,
    excluded,
  );
  if (!candidates.length) return { data: [] };
  const candidateIds = candidates.map((item) => item.id);
  const candidateRelations = await db.all(
    `SELECT product_id,category_id FROM store_product_categories WHERE product_id IN (${candidateIds.map(() => "?").join(",")})`,
    candidateIds,
  );
  const images = await db.all(
    `SELECT product_id,url_original,alt_raw FROM store_product_images WHERE product_id IN (${candidateIds.map(() => "?").join(",")}) ORDER BY position,id`,
    candidateIds,
  );
  const categoriesByProduct = new Map();
  for (const rel of candidateRelations) {
    const list = categoriesByProduct.get(Number(rel.product_id)) || [];
    list.push(Number(rel.category_id));
    categoriesByProduct.set(Number(rel.product_id), list);
  }
  const imageByProduct = new Map();
  for (const image of images) if (!imageByProduct.has(Number(image.product_id))) imageByProduct.set(Number(image.product_id), image);

  const ranked = candidates.map((candidate) => {
    let score = 0;
    const candidateCategoryIds = categoriesByProduct.get(Number(candidate.id)) || [];
    for (const id of candidateCategoryIds) {
      if (currentCategories.has(id)) score += 8;
      score += (historyCategoryWeight.get(id) || 0) * 2.2;
    }
    if (current?.brand && normalizeMatch(candidate.brand) === normalizeMatch(current.brand)) score += 3.5;
    if (current?.product_type && normalizeMatch(candidate.product_type) === normalizeMatch(current.product_type)) score += 2.5;
    if (current?.format && normalizeMatch(candidate.format) === normalizeMatch(current.format)) score += 1;
    let keywords = [];
    try { keywords = JSON.parse(candidate.seo_keywords_json || "[]"); } catch { keywords = []; }
    for (const keyword of Array.isArray(keywords) ? keywords : []) if (referenceKeywords.has(normalizeMatch(keyword))) score += 1.8;
    for (const token of normalizeMatch([candidate.name, candidate.brand, candidate.product_type, candidate.format, candidate.description, candidate.seo_h1, candidate.seo_title, candidate.seo_description].join(" ")).split(" ")) {
      if (token.length > 2 && referenceTokens.has(token)) score += 0.35;
    }
    return { ...candidate, score, image: imageByProduct.get(Number(candidate.id)) || null };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name), "ru")).slice(0, 8);

  return { data: ranked.map(({ id, name, slug, brand, product_type, price_raw, image, score }) => ({
    id, name, slug, brand, product_type, price_raw, score,
    image_url: image?.url_original || "",
    image_alt: image?.alt_raw || name,
  })) };
});

/** Одна и та же случайная подборка для всех посетителей в течение суток. */
get("/api/store/recommendations/daily", async () => {
  const rows = await db.all(`SELECT p.id,p.name,p.slug,p.brand,p.product_type,p.price_raw,p.is_18_plus,
    (SELECT i.url_original FROM store_product_images i WHERE i.product_id=p.id ORDER BY i.position,i.id LIMIT 1) AS image_url,
    (SELECT i.alt_raw FROM store_product_images i WHERE i.product_id=p.id ORDER BY i.position,i.id LIMIT 1) AS image_alt
    FROM store_products p WHERE p.status='published' AND COALESCE(p.is_18_plus,0)=0 ORDER BY p.id`);
  const day = new Date().toISOString().slice(0, 10);
  const rank = (id) => crypto.createHash("sha256").update(`${day}:${id}:vapelab-daily`).digest("hex");
  const products = rows.sort((a, b) => rank(a.id).localeCompare(rank(b.id))).slice(0, 8).map((item) => ({
    ...item,
    image_url: /^(https:\/\/|\/assets\/|\/uploads\/)/i.test(String(item.image_url || "")) ? item.image_url : "",
  }));
  return { data: { date: day, products } };
});

get("/api/store/products/options", async ({ user, query }) => {
  adminOnly(user);
  const q = String(query.get("q") || "").trim().slice(0, 100);
  const categoryId = Math.max(0, Number(query.get("category_id") || 0) || 0);
  const publishedOnly = query.get("published_only") === "1";
  const limit = Math.max(20, Math.min(1000, Number(query.get("limit") || 500) || 500));
  const conditions = [];
  const params = [];
  if (q) { conditions.push("(p.name LIKE ? OR p.sku LIKE ? OR p.brand LIKE ?)"); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (categoryId) { conditions.push("EXISTS (SELECT 1 FROM store_product_categories pc WHERE pc.product_id=p.id AND pc.category_id=?)"); params.push(categoryId); }
  if (publishedOnly) conditions.push("p.status='published'");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await db.all(`SELECT p.id,p.name,p.slug,p.sku,p.brand,p.status,p.is_18_plus,
    (SELECT i.url_original FROM store_product_images i WHERE i.product_id=p.id ORDER BY i.position,i.id LIMIT 1) AS image_url
    FROM store_products p ${where} ORDER BY p.name LIMIT ?`, [...params, limit]);
  return { data: rows };
}, { auth: true });

get("/api/store/admin", async ({ user, query }) => {
  adminOnly(user);
  const page = Math.max(1, Math.min(100000, Number(query.get("page") || 1) || 1));
  const pageSize = Math.max(10, Math.min(100, Number(query.get("page_size") || 50) || 50));
  const q = String(query.get("q") || "").trim().slice(0, 160);
  const categoryId = Number(query.get("category_id") || 0);
  const status = String(query.get("status") || "");
  const where = [];
  const params = [];
  if (q) {
    const variants = [...new Set([q, q.toLocaleLowerCase("ru-RU"), q.toLocaleUpperCase("ru-RU")])];
    const clauses = [];
    for (const value of variants) {
      const pattern = `%${value}%`;
      clauses.push("(p.name LIKE ? OR p.brand LIKE ? OR p.sku LIKE ? OR p.product_type LIKE ? OR p.format LIKE ?)");
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
    where.push(`(${clauses.join(" OR ")})`);
  }
  if (categoryId > 0) { where.push("EXISTS (SELECT 1 FROM store_product_categories pc WHERE pc.product_id=p.id AND pc.category_id=?)"); params.push(categoryId); }
  if (["draft", "pending_review", "published", "archived"].includes(status)) { where.push("p.status=?"); params.push(status); }
  const condition = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const count = await db.get(`SELECT COUNT(*) AS total FROM store_products p ${condition}`, params);
  const total = Number(count?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const products = await db.all(`SELECT p.* FROM store_products p ${condition} ORDER BY p.updated_at DESC,p.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (safePage - 1) * pageSize]);
  const categories = await repo.list("store_categories", { order: "sort_order,name", limit: 2000 });
  const news = await repo.list("store_news", { order: "updated_at DESC", limit: 500 });
  const pages = await repo.list("store_pages", { order: "title", limit: 500 });
  const settings = await db.all("SELECT setting_key,setting_value FROM store_settings ORDER BY setting_key");
  const productIds = products.map((p) => p.id);
  const images = productIds.length ? await db.all(`SELECT id,product_id,variant_id,url_original,alt_raw,position,source_url,download_status FROM store_product_images WHERE product_id IN (${productIds.map(() => "?").join(",")}) ORDER BY position,id`, productIds) : [];
  const keywords = productIds.length ? await db.all(`SELECT * FROM store_keyword_targets WHERE product_id IN (${productIds.map(() => "?").join(",")}) ORDER BY product_id,frequency_class,keyword`, productIds) : [];
  const relations = productIds.length ? await db.all(`SELECT product_id,category_id FROM store_product_categories WHERE product_id IN (${productIds.map(() => "?").join(",")})`, productIds) : [];
  const variants = productIds.length ? await db.all(`SELECT * FROM store_product_variants WHERE product_id IN (${productIds.map(() => "?").join(",")}) ORDER BY sort_order,id`, productIds) : [];
  return { data: {
    categories,
    products: products.map((p) => ({ ...p, specifications: json(p.specifications_json), seo_keywords: json(p.seo_keywords_json, []), images: images.filter((i) => i.product_id === p.id), variants: variants.filter((v) => v.product_id === p.id).map((v) => ({ ...v, attributes: json(v.attributes_json, {}), images: images.filter((image) => Number(image.variant_id) === Number(v.id)) })), keyword_targets: keywords.filter((k) => k.product_id === p.id), category_ids: relations.filter((r) => r.product_id === p.id).map((r) => r.category_id) })),
    product_pagination: { page: safePage, page_size: pageSize, total, total_pages: totalPages, query: q, category_id: categoryId || null, status },
    news, pages, settings: Object.fromEntries(settings.map((s) => [s.setting_key, s.setting_value]))
  } };
}, { auth: true });

/** Public search: all terms must match, including variant names and SKUs. */
get("/api/store/search", async ({ query, req }) => {
  rateLimit(`store-public-search:${clientIp(req)}`, 100, 60_000);
  const raw = String(query.get("q") || "").trim().slice(0, 120);
  if (normalizeMatch(raw).length < 2) return { data: { query: raw, total: 0, results: [], category_results: [] } };
  const allCategories = await db.all(`SELECT c.id,c.parent_id,c.name,c.slug,
    COALESCE((SELECT p.slug FROM store_category_page_categories m JOIN store_category_pages p ON p.id=m.page_id WHERE m.category_id=c.id AND p.status='published' ORDER BY p.sort_order LIMIT 1),c.slug) AS public_slug
    FROM store_categories c WHERE c.is_active=1 ORDER BY c.sort_order,c.name`);
  const categoryId = Math.max(0, Number(query.get("category_id")) || 0);
  const selected = new Set(categoryId ? [categoryId] : []);
  if (categoryId) {
    let size = 0;
    while (size !== selected.size) {
      size = selected.size;
      for (const c of allCategories) if (selected.has(Number(c.parent_id))) selected.add(Number(c.id));
    }
  }
  const categoryResults = allCategories.map((c) => ({ ...c, score: searchScore(raw, [c.name]) }))
    .filter((c) => c.score > 0 && (!categoryId || selected.has(Number(c.id))))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ru"))
    .map(({ id, parent_id, name, slug, public_slug }) => ({ id, parent_id, name, slug: parent_id ? slug : public_slug }));
  const rows = await db.all(`SELECT id,name,slug,sku,brand,product_type,format,description,specifications_json,
    price_raw,is_18_plus,seo_h1,seo_title,seo_description FROM store_products WHERE status='published'`);
  const relations = await db.all(`SELECT pc.product_id,pc.category_id,c.name FROM store_product_categories pc
    JOIN store_categories c ON c.id=pc.category_id JOIN store_products p ON p.id=pc.product_id
    WHERE p.status='published' AND c.is_active=1`);
  const variants = await db.all(`SELECT v.product_id,v.name,v.sku,v.attributes_json FROM store_product_variants v
    JOIN store_products p ON p.id=v.product_id WHERE p.status='published'`);
  const categories = new Map();
  for (const rel of relations) {
    const list = categories.get(Number(rel.product_id)) || [];
    list.push(rel); categories.set(Number(rel.product_id), list);
  }
  const variantFields = new Map();
  for (const variant of variants) {
    const list = variantFields.get(Number(variant.product_id)) || [];
    list.push(variant.name, variant.sku, variant.attributes_json); variantFields.set(Number(variant.product_id), list);
  }
  const ranked = [];
  for (const product of rows) {
    const rel = categories.get(Number(product.id)) || [];
    if (categoryId && !rel.some((c) => selected.has(Number(c.category_id)))) continue;
    const fields = [product.name, product.sku, product.brand, product.product_type, product.format,
      ...(variantFields.get(Number(product.id)) || []), ...rel.map((c) => c.name),
      product.description, product.specifications_json, product.seo_h1, product.seo_title, product.seo_description];
    const score = searchScore(raw, fields);
    if (score > 0) ranked.push({ ...product, score, categories: rel.map((c) => c.name) });
  }
  ranked.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name), "ru") || Number(a.id) - Number(b.id));
  const page = Math.max(1, Math.min(100000, Number(query.get("page") || 1) || 1));
  const pageSize = Math.max(12, Math.min(48, Number(query.get("page_size") || 12) || 12));
  const total = ranked.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageItems = ranked.slice((safePage - 1) * pageSize, safePage * pageSize);
  const ids = pageItems.map((p) => p.id);
  const images = ids.length ? await db.all(`SELECT product_id,url_original,position,id FROM store_product_images WHERE product_id IN (${ids.map(() => "?").join(",")}) ORDER BY position,id`, ids) : [];
  const imagesByProduct = new Map();
  for (const image of images) if (!imagesByProduct.has(Number(image.product_id))) imagesByProduct.set(Number(image.product_id), image.url_original);
  return { data: { query: raw, total, page: safePage, page_size: pageSize, total_pages: totalPages, category_results: categoryResults,
    results: pageItems.map((item) => ({ id: item.id, name: item.name, slug: item.slug, sku: item.sku, brand: item.brand,
      product_type: item.product_type, price_raw: item.price_raw, is_18_plus: Number(item.is_18_plus) === 1,
      image_url: /^(https:\/\/|\/assets\/|\/uploads\/)/i.test(String(imagesByProduct.get(Number(item.id)) || "")) ? imagesByProduct.get(Number(item.id)) : "",
      categories: item.categories })) } };
});

get("/api/store/smart-search", async ({ user, query }) => {
  adminOnly(user);
  const raw = String(query.get("q") || "").trim().slice(0, 120);
  const normalized = normalizeMatch(raw);
  if (normalized.length < 2) throw new HttpError(400, "Введите не менее двух символов");
  const tokens = normalized.split(" ").filter(Boolean).slice(0, 8);
  const rows = await db.all("SELECT id,name,slug,sku,brand,product_type,format,description,seo_h1,seo_title,seo_description,status,is_18_plus,is_reservable,updated_at FROM store_products ORDER BY updated_at DESC,id DESC LIMIT 10000");
  const editDistance = (a, b) => {
    if (Math.abs(a.length - b.length) > 1) return 2;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      edits++; if (edits > 1) return edits;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    if (i < a.length || j < b.length) edits++;
    return edits;
  };
  const rankedBase = rows.map((product) => {
    const fields = [product.name, product.sku, product.brand, product.product_type, product.format, product.description, product.seo_h1, product.seo_title, product.seo_description].map(normalizeMatch);
    const haystack = fields.join(" ");
    const productTokens = new Set(haystack.split(" ").filter(Boolean));
    let score = 0;
    if (haystack.includes(normalized)) score += 100;
    for (const token of tokens) {
      if (fields[0].includes(token)) score += 34;
      else if (fields.slice(1, 5).some((value) => value.includes(token))) score += 25;
      else if (haystack.includes(token)) score += 12;
      else if ([...productTokens].some((candidate) => candidate.length > 3 && token.length > 3 && editDistance(token, candidate) <= 1)) score += 6;
    }
    if (tokens.length && tokens.every((token) => haystack.includes(token))) score += 24;
    return { ...product, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name), "ru")).slice(0, 25);
  const hitIds = rankedBase.map((item) => item.id);
  const categoryRelations = hitIds.length ? await db.all(`SELECT product_id,category_id FROM store_product_categories WHERE product_id IN (${hitIds.map(() => "?").join(",")})`, hitIds) : [];
  const ranked = rankedBase.map((item) => ({ ...item, category_ids: categoryRelations.filter((rel) => Number(rel.product_id) === Number(item.id)).map((rel) => Number(rel.category_id)) }));
  return { data: { query: raw, total: ranked.length, results: ranked } };
}, { auth: true });

post("/api/store/categories", async ({ body, user, req }) => {
  adminOnly(user); if (!body.name) throw new HttpError(400, "Укажите название категории");
  const row = await repo.insert("store_categories", { parent_id: body.parent_id || null, name: body.name, slug: body.slug || slugify(body.name), description: body.description || "", sort_order: Number(body.sort_order) || 0, source_url: body.source_url || "", featured_product_id: null });
  await audit(user.id, "create", "store_category", row.id, null, req.socket.remoteAddress || "");
  return { status: 201, data: row };
}, { auth: true });

put("/api/store/categories/:id", async ({ params, body, user, req }) => {
  adminOnly(user); const row = await repo.byId("store_categories", params.id); if (!row) throw new HttpError(404, "Категория не найдена");
  const requestedFeatured = body.featured_product_id === undefined ? row.featured_product_id : (body.featured_product_id ? Number(body.featured_product_id) : null);
  if (requestedFeatured !== null && requestedFeatured !== undefined) {
    if (!Number.isSafeInteger(requestedFeatured) || requestedFeatured < 1) throw new HttpError(400, "Выберите корректный товар-представитель");
    const belongs = await db.get(`SELECT p.id FROM store_products p JOIN store_product_categories pc ON pc.product_id=p.id
      WHERE p.id=? AND pc.category_id=? AND p.status='published'`, [requestedFeatured, row.id]);
    if (!belongs) throw new HttpError(400, "Товар-представитель должен быть опубликован и привязан к этой категории");
  }
  const updated = await repo.update("store_categories", row.id, { name: body.name ?? row.name, slug: body.slug ?? row.slug, description: body.description ?? row.description, parent_id: body.parent_id === undefined ? row.parent_id : body.parent_id, sort_order: body.sort_order ?? row.sort_order, is_active: body.is_active === undefined ? row.is_active : (body.is_active ? 1 : 0), featured_product_id: requestedFeatured ?? null, updated_at: nowIso() });
  await audit(user.id, "update", "store_category", row.id, { featured_product_id: requestedFeatured ?? null }, req.socket.remoteAddress || "");
  return { data: updated };
}, { auth: true });

post("/api/store/products", async ({ body, user }) => {
  adminOnly(user); if (!body.name) throw new HttpError(400, "Укажите название");
  const row = await repo.insert("store_products", { name: body.name, slug: body.slug || slugify(body.name), brand: body.brand || "", sku: body.sku || "", product_type: body.product_type || "", format: body.format || "", description: body.description || "", specifications_json: JSON.stringify(body.specifications || {}), seo_h1: body.seo_h1 || "", seo_title: body.seo_title || "", seo_description: body.seo_description || "", seo_keywords_json: JSON.stringify(body.seo_keywords || []), canonical_url: body.canonical_url || "", robots_index: body.robots_index === false ? 0 : 1, image_search_query: body.image_search_query || "", price_raw: body.price_raw || "", old_price_raw: body.old_price_raw || "", currency: body.currency || "RUB", availability_label_raw: body.availability_label_raw || "", availability_status: AVAILABILITY_STATES.has(body.availability_status) ? body.availability_status : "unknown", is_18_plus: body.is_18_plus ? 1 : 0, is_reservable: body.is_reservable === false ? 0 : 1, status: ["draft","pending_review","published","archived"].includes(body.status) ? body.status : "draft", source_url: body.source_url || "", source_checked_at: body.source_checked_at || "", migration_notes: body.migration_notes || "" });
  for (const id of (Array.isArray(body.category_ids) ? body.category_ids : [])) await db.run("INSERT INTO store_product_categories(product_id,category_id) VALUES(?,?)", [row.id, Number(id)]);
  return { status: 201, data: row };
}, { auth: true });

put("/api/store/products/:id", async ({ params, body, user, req }) => {
  adminOnly(user);
  if (body.variants !== undefined) throw new HttpError(400, "Варианты сохраняются отдельно через /products/:id/variants"); const row = await repo.byId("store_products", params.id); if (!row) throw new HttpError(404, "Товар не найден");
  const data = await repo.update("store_products", row.id, {
    name: body.name ?? row.name, slug: body.slug ?? row.slug, brand: body.brand ?? row.brand, sku: body.sku ?? row.sku,
    product_type: body.product_type ?? row.product_type, format: body.format ?? row.format, description: body.description ?? row.description,
    specifications_json: body.specifications === undefined ? row.specifications_json : JSON.stringify(body.specifications),
    price_raw: body.price_raw ?? row.price_raw, old_price_raw: body.old_price_raw ?? row.old_price_raw, currency: body.currency ?? row.currency,
    availability_label_raw: body.availability_label_raw ?? row.availability_label_raw,
    availability_status: body.availability_status === undefined ? (row.availability_status || "unknown") : (AVAILABILITY_STATES.has(body.availability_status) ? body.availability_status : (() => { throw new HttpError(400, "Неизвестный статус наличия"); })()),
    is_18_plus: body.is_18_plus === undefined ? row.is_18_plus : (body.is_18_plus ? 1 : 0), is_reservable: body.is_reservable === undefined ? row.is_reservable : (body.is_reservable ? 1 : 0),
    seo_h1: body.seo_h1 ?? row.seo_h1, seo_title: body.seo_title ?? row.seo_title, seo_description: body.seo_description ?? row.seo_description,
    seo_keywords_json: body.seo_keywords === undefined ? row.seo_keywords_json : JSON.stringify(body.seo_keywords), canonical_url: body.canonical_url ?? row.canonical_url,
    robots_index: body.robots_index === undefined ? row.robots_index : (body.robots_index ? 1 : 0), image_search_query: body.image_search_query ?? row.image_search_query,
    status: ["draft","pending_review","published","archived"].includes(body.status) ? body.status : row.status,
    source_url: body.source_url ?? row.source_url, migration_notes: body.migration_notes ?? row.migration_notes, updated_at: nowIso(),
  });
  if (Array.isArray(body.category_ids)) {
    await db.run("DELETE FROM store_product_categories WHERE product_id=?", [row.id]);
    for (const id of body.category_ids) await db.run("INSERT INTO store_product_categories(product_id,category_id) VALUES(?,?)", [row.id, Number(id)]);
  }
  let restock = null;
  if (body.availability_status === "in_stock" && row.availability_status !== "in_stock") restock = await notifyRestockSubscribers(data);
  await audit(user.id, "update", "store_product", row.id, { name:data.name, status:data.status, availability_status:data.availability_status, restock, seo_updated: ["seo_h1","seo_title","seo_description","seo_keywords","canonical_url","robots_index"].some((key) => body[key] !== undefined) }, req.socket.remoteAddress || "");
  return { data: { ...data, restock_notifications: restock } };
}, { auth: true });

get("/api/store/products/:id", async ({ params, user }) => {
  adminOnly(user);
  const p = await repo.byId("store_products", params.id);
  if (!p) throw new HttpError(404, "Товар не найден");
  const images = await db.all("SELECT * FROM store_product_images WHERE product_id=? ORDER BY position,id", [p.id]);
  const variants = await db.all("SELECT * FROM store_product_variants WHERE product_id=? ORDER BY sort_order,id", [p.id]);
  const relations = await db.all("SELECT category_id FROM store_product_categories WHERE product_id=?", [p.id]);
  return { data: { ...p, specifications: json(p.specifications_json), images, category_ids: relations.map((r) => r.category_id), variants: variants.map((v) => ({ ...v, attributes: json(v.attributes_json, {}), images: images.filter((i) => Number(i.variant_id) === Number(v.id)) })) } };
}, { auth: true });

post("/api/store/products/:id/variants", async ({ params, body, user, req }) => {
  adminOnly(user);
  const product = await repo.byId("store_products", params.id);
  if (!product) throw new HttpError(404, "Товар не найден");
  const fields = normalizeStoreVariant(body, null, product.id);
  if (fields.sku) {
    const duplicate = await db.get("SELECT id FROM store_product_variants WHERE product_id=? AND sku=? LIMIT 1", [product.id, fields.sku]);
    if (duplicate) throw new HttpError(409, "Такой артикул варианта уже есть у этого товара");
  }
  const row = await repo.insert("store_product_variants", fields);
  await audit(user.id, "store_product_variant_create", "store_product", product.id, { variant_id: row.id, name: row.name, sku: row.sku }, clientIp(req));
  return { status: 201, data: { ...row, attributes: json(row.attributes_json, {}), images: [] } };
}, { auth: true });

put("/api/store/products/:id/variants/:variantId", async ({ params, body, user, req }) => {
  adminOnly(user);
  const product = await repo.byId("store_products", params.id);
  if (!product) throw new HttpError(404, "Товар не найден");
  const variant = await db.get("SELECT * FROM store_product_variants WHERE id=? AND product_id=?", [Number(params.variantId), product.id]);
  if (!variant) throw new HttpError(404, "Вариант не найден у этого товара");
  const fields = normalizeStoreVariant(body, variant, product.id);
  if (fields.sku) {
    const duplicate = await db.get("SELECT id FROM store_product_variants WHERE product_id=? AND sku=? AND id<>? LIMIT 1", [product.id, fields.sku, variant.id]);
    if (duplicate) throw new HttpError(409, "Такой артикул варианта уже есть у этого товара");
  }
  const row = await repo.update("store_product_variants", variant.id, fields);
  await audit(user.id, "store_product_variant_update", "store_product", product.id, { variant_id: row.id, name: row.name, sku: row.sku }, clientIp(req));
  return { data: { ...row, attributes: json(row.attributes_json, {}), images: await db.all("SELECT id,variant_id,url_original,alt_raw,position,source_url FROM store_product_images WHERE product_id=? AND variant_id=? ORDER BY position,id", [product.id, variant.id]) } };
}, { auth: true });

del("/api/store/products/:id/variants/:variantId", async ({ params, user, req }) => {
  adminOnly(user);
  const product = await repo.byId("store_products", params.id);
  if (!product) throw new HttpError(404, "Товар не найден");
  const variant = await db.get("SELECT * FROM store_product_variants WHERE id=? AND product_id=?", [Number(params.variantId), product.id]);
  if (!variant) throw new HttpError(404, "Вариант не найден у этого товара");
  // Keep its photographs attached to the parent product instead of deleting them.
  await db.run("UPDATE store_product_images SET variant_id=NULL WHERE product_id=? AND variant_id=?", [product.id, variant.id]);
  await db.run("DELETE FROM store_product_variants WHERE id=? AND product_id=?", [variant.id, product.id]);
  await audit(user.id, "store_product_variant_delete", "store_product", product.id, { variant_id: variant.id, name: variant.name }, clientIp(req));
  return { data: { deleted: true, id: variant.id } };
}, { auth: true });

post("/api/store/products/bulk", async ({ body, user, req }) => {
  adminOnly(user);
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) throw new HttpError(400, "Выберите хотя бы один товар");
  if (ids.length > 100) throw new HttpError(400, "За одну операцию можно обработать не более 100 товаров");
  const action = String(body.action || "");
  if (!["publish", "draft", "archive", "delete", "in_stock", "out_of_stock", "preorder", "unknown", "enable_reservations"].includes(action)) throw new HttpError(400, "Неизвестная массовая операция");
  if (action === "delete") siteAdminOnly(user);
  const found = await db.all(`SELECT * FROM store_products WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  if (found.length !== ids.length) throw new HttpError(404, "Часть выбранных товаров не найдена. Обновите список и повторите операцию");
  let restock = { subscribers: 0, email_sent: 0, telegram_sent: 0 };
  await db.transaction(async (tx) => {
    for (const product of found) {
      if (action === "delete") {
        await tx.run("UPDATE store_restock_subscriptions SET status='cancelled',updated_at=? WHERE product_id=?", [nowIso(), product.id]);
        await tx.run("UPDATE store_categories SET featured_product_id=NULL,updated_at=? WHERE featured_product_id=?", [nowIso(), product.id]);
        await tx.run("DELETE FROM store_product_categories WHERE product_id=?", [product.id]);
        await tx.run("DELETE FROM store_product_images WHERE product_id=?", [product.id]);
        await tx.run("DELETE FROM store_product_variants WHERE product_id=?", [product.id]);
        await tx.run("DELETE FROM store_keyword_targets WHERE product_id=?", [product.id]);
        await tx.run("DELETE FROM store_products WHERE id=?", [product.id]);
      } else if (["publish", "draft", "archive"].includes(action)) {
        await tx.run("UPDATE store_products SET status=?,updated_at=? WHERE id=?", [{ publish: "published", draft: "draft", archive: "archived" }[action], nowIso(), product.id]);
      } else if (action === "enable_reservations") {
        await tx.run("UPDATE store_products SET is_reservable=1,updated_at=? WHERE id=?", [nowIso(), product.id]);
      } else {
        await tx.run("UPDATE store_products SET availability_status=?,updated_at=? WHERE id=?", [action, nowIso(), product.id]);
      }
    }
  });
  if (action === "in_stock") {
    for (const product of found) {
      if (product.availability_status !== "in_stock") {
        const result = await notifyRestockSubscribers({ ...product, availability_status: "in_stock" });
        restock.subscribers += result.subscribers; restock.email_sent += result.email_sent; restock.telegram_sent += result.telegram_sent;
      }
    }
  }
  await audit(user.id, "bulk_" + action, "store_product", ids.join(","), { count: ids.length, restock }, clientIp(req));
  return { data: { affected: ids.length, action, restock } };
}, { auth: true });

get("/api/store/restock-subscriptions", async ({ user, query }) => {
  adminOnly(user);
  const page = Math.max(1, Number(query.get("page") || 1) || 1);
  const pageSize = Math.max(10, Math.min(100, Number(query.get("page_size") || 50) || 50));
  const status = String(query.get("status") || "");
  const where = status ? "WHERE s.status=?" : "";
  const params = status ? [status] : [];
  const total = Number((await db.get(`SELECT COUNT(*) AS total FROM store_restock_subscriptions s ${where}`, params))?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const rows = await db.all(`SELECT s.*,p.name AS current_product_name,p.availability_status FROM store_restock_subscriptions s LEFT JOIN store_products p ON p.id=s.product_id ${where} ORDER BY s.created_at DESC,s.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (safePage - 1) * pageSize]);
  return { data: { subscriptions: rows, pagination: { page: safePage, page_size: pageSize, total, total_pages: totalPages } } };
}, { auth: true });

post("/api/store/restock-subscriptions/:id/notify", async ({ params, user }) => {
  adminOnly(user);
  const subscriptionId = Number(params.id);
  const subscription = await db.get("SELECT * FROM store_restock_subscriptions WHERE id=?", [subscriptionId]);
  if (!subscription) throw new HttpError(404, "Подписка не найдена");
  const product = await db.get("SELECT id,name,slug,availability_status FROM store_products WHERE id=?", [subscription.product_id]);
  if (!product || product.availability_status !== "in_stock") throw new HttpError(409, "Товар ещё не отмечен как имеющийся в наличии");
  let emailNotified = Number(subscription.email_notified) === 1;
  let telegramNotified = Number(subscription.telegram_notified) === 1;
  const productUrl = `${String(config.publicUrl || "http://localhost:3000").replace(/\/$/, "")}/product/${encodeURIComponent(product.slug)}`;
  if (subscription.email && !emailNotified) {
    const result = await sendEmail(subscription.email, `Товар снова в наличии · ${product.name}`, `Товар «${product.name}» снова доступен в каталоге VAPELAB.\n${productUrl}\n\nЭто уведомление отправлено по вашему запросу.`);
    emailNotified = Boolean(result.ok && !result.dev);
  }
  if (subscription.telegram_chat_id && !telegramNotified) {
    const result = await getChannel("telegram").send(subscription.telegram_chat_id, `Товар снова в наличии: ${product.name}\n${productUrl}`);
    telegramNotified = Boolean(result.ok && !result.dev);
  }
  const needsTelegram = Boolean(subscription.telegram_chat_id || subscription.telegram_username);
  const completed = (!subscription.email || emailNotified) && (!needsTelegram || telegramNotified);
  await repo.update("store_restock_subscriptions", subscriptionId, {
    email_notified: emailNotified ? 1 : 0,
    telegram_notified: telegramNotified ? 1 : 0,
    status: completed ? "notified" : "active",
    notified_at: completed ? nowIso() : "",
    updated_at: nowIso(),
  });
  return { data: { ok: emailNotified || telegramNotified, email_notified: emailNotified, telegram_notified: telegramNotified, status: completed ? "notified" : "active" } };
}, { auth: true });

post("/api/store/restock-subscriptions", async ({ body, req, user }) => {
  rateLimit(`restock:${clientIp(req)}`, 8, 60 * 60_000);
  if (String(body.website || "").trim()) return { status: 201, data: { accepted: true } };
  const productId = Number(body.product_id);
  const product = await db.get("SELECT id,name,slug,status,availability_status,is_18_plus FROM store_products WHERE id=?", [productId]);
  if (!product || product.status !== "published") throw new HttpError(404, "Товар не найден");
  if (product.availability_status === "in_stock") throw new HttpError(409, "Товар уже отмечен как имеющийся в наличии");
  if (Number(product.is_18_plus) && body.age_confirmed !== true) throw new HttpError(400, "Подтвердите, что вам исполнилось 18 лет");
  const email = String(body.email || user?.email || "").trim().toLowerCase();
  const telegramUsername = String(body.telegram_username || user?.telegram_username || "").trim().replace(/^@/, "").slice(0, 64);
  const telegramChatId = String(user?.telegram_chat_id || "");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Проверьте адрес электронной почты");
  if (telegramUsername && !/^[a-zA-Z0-9_]{5,64}$/.test(telegramUsername)) throw new HttpError(400, "Проверьте Telegram username");
  if (!email && !telegramUsername && !telegramChatId) throw new HttpError(400, "Укажите e-mail или Telegram username");
  if (!email && !telegramChatId && telegramUsername && (!config.telegram.token || !config.telegram.username)) throw new HttpError(503, "Telegram-бот ещё не подключён. Укажите e-mail для уведомления или повторите позже");
  if (body.pd_consent !== true) throw new HttpError(400, "Подтвердите согласие на уведомление о поступлении товара");
  const exists = await db.get("SELECT id FROM store_restock_subscriptions WHERE product_id=? AND status='active' AND ((email<>'' AND email=?) OR (telegram_username<>'' AND telegram_username=?)) LIMIT 1", [product.id, email, telegramUsername]);
  if (exists) return { data: { accepted: true, duplicate: true, message: "Вы уже подписаны на уведомление об этом товаре" } };
  let tokenRaw = "";
  let tokenHash = "";
  let expires = "";
  let linkUrl = "";
  if (!telegramChatId && telegramUsername && config.telegram.token && config.telegram.username) {
    tokenRaw = crypto.randomBytes(24).toString("base64url");
    tokenHash = crypto.createHash("sha256").update(tokenRaw).digest("hex");
    expires = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    linkUrl = `https://t.me/${config.telegram.username}?start=restock_${tokenRaw}`;
  }
  await repo.insert("store_restock_subscriptions", {
    product_id: product.id, product_name: product.name, product_slug: product.slug,
    customer_name: String(body.customer_name || user?.full_name || "").trim().slice(0, 160),
    email, telegram_username, telegram_chat_id: "", telegram_link_token_hash: tokenHash,
    telegram_link_expires: expires, pd_consent_at: nowIso(), status: "active",
    email_notified: 0, telegram_notified: 0, notified_at: "", created_at: nowIso(), updated_at: nowIso(),
  });
  return { status: 201, data: { accepted: true, telegram_link_url: linkUrl, telegram_link_required: Boolean(telegramUsername && !telegramChatId && !linkUrl), message: "Подписка сохранена. Мы сообщим, когда товар снова появится." } };
}, { auth: false });

get("/api/store/seo-report", async ({ user, query }) => {
  adminOnly(user);
  const rows = await db.all("SELECT id,name,slug,brand,status,description,seo_h1,seo_title,seo_description,seo_keywords_json,canonical_url,robots_index FROM store_products ORDER BY name");
  const h1Counts = new Map();
  const titleCounts = new Map();
  const norm = (value) => String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
  for (const row of rows) {
    const h1Key = norm(row.seo_h1);
    const titleKey = norm(row.seo_title);
    if (h1Key) h1Counts.set(h1Key, (h1Counts.get(h1Key) || 0) + 1);
    if (titleKey) titleCounts.set(titleKey, (titleCounts.get(titleKey) || 0) + 1);
  }
  const productIds = rows.map((row) => row.id);
  const targets = productIds.length ? await db.all(`SELECT * FROM store_keyword_targets WHERE product_id IN (${productIds.map(() => "?").join(",")}) ORDER BY product_id,frequency_class,keyword`, productIds) : [];
  const images = productIds.length ? await db.all(`SELECT product_id,COUNT(*) AS total,SUM(CASE WHEN alt_raw IS NULL OR TRIM(alt_raw)='' THEN 1 ELSE 0 END) AS missing_alt FROM store_product_images WHERE product_id IN (${productIds.map(() => "?").join(",")}) GROUP BY product_id`, productIds) : [];
  const categories = productIds.length ? await db.all(`SELECT product_id,COUNT(*) AS total FROM store_product_categories WHERE product_id IN (${productIds.map(() => "?").join(",")}) GROUP BY product_id`, productIds) : [];

  const report = rows.map((row) => {
    const issues = [];
    const push = (code, label, severity = "warning", weight = 10, recommendation = "") => issues.push({ code, label, severity, weight, recommendation });
    const h1 = String(row.seo_h1 || "").trim();
    const title = String(row.seo_title || "").trim();
    const description = String(row.seo_description || "").trim();
    const keywordTargets = targets.filter((item) => Number(item.product_id) === Number(row.id));
    const productImages = images.find((item) => Number(item.product_id) === Number(row.id));
    const categoryCount = Number(categories.find((item) => Number(item.product_id) === Number(row.id))?.total || 0);
    const seoKeywords = json(row.seo_keywords_json, []);

    if (!h1) push("h1_missing", "Не задан H1", "critical", 20, "Добавьте один конкретный H1, соответствующий названию и содержанию карточки.");
    else if (h1Counts.get(norm(h1)) > 1) push("h1_duplicate", "Повторяющийся H1", "critical", 18, "Сделайте H1 уникальным для этой страницы.");
    if (h1.length > 120) push("h1_long", "H1 длиннее 120 символов", "warning", 6, "Сократите заголовок без потери смысла.");

    if (!title) push("title_missing", "Не задан SEO Title", "critical", 18, "Заполните Title отдельно от H1.");
    else {
      if (title.length > 70) push("title_long", "Title длиннее 70 символов", "warning", 7, "Проверьте, можно ли сделать заголовок короче.");
      if (titleCounts.get(norm(title)) > 1) push("title_duplicate", "Повторяющийся SEO Title", "critical", 18, "Сделайте Title уникальным среди страниц сайта.");
    }
    if (!description) push("description_missing", "Не задано Description", "warning", 12, "Добавьте краткое описание именно этой страницы.");
    else if (description.length > 180) push("description_long", "Description длиннее 180 символов", "notice", 4, "Проверьте длину и уберите второстепенные детали.");
    if (!seoKeywords.length && !keywordTargets.length) push("keywords_missing", "Не добавлены поисковые запросы", "warning", 8, "Добавьте реальные запросы и укажите источник и дату проверки частотности.");
    if (!categoryCount) push("category_missing", "Товар не привязан к категории", "warning", 8, "Назначьте товару существующую категорию каталога.");
    if (!Number(productImages?.total || 0)) push("image_missing", "Нет изображений", "warning", 6, "Добавьте подходящее изображение после проверки модели и источника.");
    else if (Number(productImages?.missing_alt || 0) > 0) push("image_alt_missing", "У части изображений отсутствует ALT", "warning", 6, "Заполните содержательный ALT у каждого изображения.");

    const frequency = { high: 0, medium: 0, low: 0, unknown: 0 };
    for (const target of keywordTargets) frequency[target.frequency_class] = (frequency[target.frequency_class] || 0) + 1;
    const indexingStatus = Number(row.robots_index) === 0 ? "noindex" : row.status === "published" ? "indexable" : "not_published";
    if (indexingStatus === "noindex") push("noindex", "Страница закрыта от индексации", "notice", 0, "Проверьте, что запрет индексации установлен намеренно.");

    const score = Math.max(0, 100 - issues.reduce((sum, item) => sum + item.weight, 0));
    return {
      ...row,
      seo_keywords: seoKeywords,
      image_count: Number(productImages?.total || 0),
      category_count: categoryCount,
      indexing_status: indexingStatus,
      keyword_frequency: frequency,
      issues,
      score,
      keyword_targets: keywordTargets,
    };
  });
  const attention = report.filter((item) => item.issues.some((issue) => issue.severity !== "notice"));
  const q = String(query.get("q") || "").trim().toLocaleLowerCase("ru-RU");
  const level = String(query.get("level") || "all");
  const page = Math.max(1, Number(query.get("page") || 1) || 1);
  const pageSize = Math.max(10, Math.min(100, Number(query.get("page_size") || 50) || 50));
  const filtered = report.filter((item) => {
    const matchesText = !q || [item.name, item.slug, item.brand, item.seo_h1, item.seo_title].join(" ").toLocaleLowerCase("ru-RU").includes(q);
    const matchesLevel = level === "all" || (level === "critical" ? item.score < 50 : level === "warning" ? item.score >= 50 && item.score < 80 : level === "good" ? item.score >= 80 : level === "attention" ? item.issues.some((issue) => issue.severity !== "notice") : true);
    return matchesText && matchesLevel;
  });
  const safePage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)));
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  return { data: {
    total: report.length,
    needs_attention: attention.length,
    published: report.filter((item) => item.status === "published").length,
    indexable: report.filter((item) => item.indexing_status === "indexable").length,
    missing_h1: report.filter((item) => item.issues.some((issue) => issue.code === "h1_missing")).length,
    missing_title: report.filter((item) => item.issues.some((issue) => issue.code === "title_missing")).length,
    missing_images: report.filter((item) => item.issues.some((issue) => issue.code === "image_missing")).length,
    products: pageRows,
    pagination: { page: safePage, page_size: pageSize, total: filtered.length, total_pages: Math.max(1, Math.ceil(filtered.length / pageSize)), query: q, level },
    score_basis: "Редакционная проверка заполненности и технических полей. Не прогнозирует позиции и не гарантирует индексацию поисковой системой.",
  } };
}, { auth: true });

post("/api/store/products/:id/keywords", async ({ params, body, user, req }) => {
  adminOnly(user);
  const product = await repo.byId("store_products", params.id);
  if (!product) throw new HttpError(404, "Товар не найден");
  const keyword = String(body.keyword || "").trim().slice(0, 240);
  if (!keyword) throw new HttpError(400, "Укажите поисковый запрос");
  const frequency = ["high", "medium", "low", "unknown"].includes(body.frequency_class) ? body.frequency_class : "unknown";
  const volume = body.search_volume === "" || body.search_volume === undefined || body.search_volume === null ? null : Number(body.search_volume);
  if (volume !== null && (!Number.isSafeInteger(volume) || volume < 0)) throw new HttpError(400, "Частотность должна быть неотрицательным целым числом");
  const searchEngine = String(body.search_engine || "").trim().slice(0, 80);
  const region = String(body.region || "").trim().slice(0, 120);
  const normalizeSearchText = (value) => String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
  // SQLite lower() не выполняет полноценное Unicode-преобразование кириллицы.
  // Сравниваем нормализованные значения в JS, чтобы «ЗАПРОС» и «запрос» не дублировались.
  const productTargets = await db.all("SELECT * FROM store_keyword_targets WHERE product_id=?", [product.id]);
  const existing = productTargets.find((item) =>
    normalizeSearchText(item.keyword) === normalizeSearchText(keyword) &&
    normalizeSearchText(item.search_engine) === normalizeSearchText(searchEngine) &&
    normalizeSearchText(item.region) === normalizeSearchText(region)
  ) || null;
  const fields = {
    product_id: product.id,
    keyword,
    frequency_class: frequency,
    search_volume: volume,
    search_engine: searchEngine,
    region,
    search_intent: String(body.search_intent || "").trim().slice(0, 80),
    source: String(body.source || "manual").trim().slice(0, 160),
    checked_at: body.checked_at || "",
    updated_at: nowIso(),
  };
  const row = existing ? await repo.update("store_keyword_targets", existing.id, fields) : await repo.insert("store_keyword_targets", fields);
  await audit(user.id, existing ? "update" : "create", "store_keyword_target", row.id, { product_id: product.id, keyword }, req.socket.remoteAddress || "");
  return { status: existing ? 200 : 201, data: row, duplicate_updated: Boolean(existing) };
}, { auth: true });

get("/api/store/images/search", async ({ query, user }) => {
  adminOnly(user);
  const term = String(query.get("query") || "").trim().slice(0, 240);
  if (term.length < 3) throw new HttpError(400, "Укажите название товара или модели");
  if (!config.imageSearch.yandexApiKey || !config.imageSearch.yandexFolderId) {
    return { data: { query: term, results: [], provider: "local-qwen", guidance: "Внешний API поиска не требуется. Используйте Qwen Code для поиска официального источника и скачивания файла в папку товара, затем загрузите изображение с компьютера или вставьте проверенный HTTPS URL." } };
  }
  const response = await fetch("https://searchapi.api.cloud.yandex.net/v2/image/search", {
    method:"POST", headers:{ "Authorization":`Api-Key ${config.imageSearch.yandexApiKey}`, "Content-Type":"application/json" },
    body:JSON.stringify({ query:{ searchType:"SEARCH_TYPE_RU", queryText:term, familyMode:"FAMILY_MODE_STRICT", page:"0", fixTypoMode:"FIX_TYPO_MODE_OFF" }, imageSpec:{ format:"IMAGE_FORMAT_JPEG", size:"IMAGE_SIZE_LARGE" }, docsOnPage:"8", folderId:config.imageSearch.yandexFolderId, userAgent:"Mozilla/5.0 (compatible; VAPELABCRM/1.0)" }),
    signal:AbortSignal.timeout(15000),
  }).catch((err)=>({ ok:false, status:0, text:async()=>err.message }));
  if (!response.ok) throw new HttpError(502, `Сервис поиска изображений вернул ошибку (${response.status || "сеть"})`);
  const payload = await response.json();
  const xml = payload.rawData ? Buffer.from(payload.rawData,"base64").toString("utf8") : String(payload.xml || "");
  const decode = (v) => String(v || "").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)));
  const docs = [...xml.matchAll(/<doc\b[^>]*>([\s\S]*?)<\/doc>/gi)].map((m)=>m[1]);
  const results = docs.map((doc)=>{
    const getTag=(names)=>{ for(const name of names){ const pattern=String.raw`<${name}[^>]*>([\s\S]*?)<\/${name}>`; const m=new RegExp(pattern,"i").exec(doc); if(m) return decode(m[1].replace(/<[^>]+>/g,"")); } return ""; };
    const imageUrl=getTag(["img_href","image_url","imageUrl","image_url_original","url"]);
    const pageUrl=getTag(["page_url","pageurl","doc_url","source_url","ref_url"]);
    const title=getTag(["title","name"]);
    return { title:title || "Изображение из поиска", image_url:imageUrl || pageUrl, source_url:pageUrl || imageUrl };
  }).filter((item)=>/^https?:\/\//i.test(item.image_url)).slice(0,8);
  return { data:{ query:term, results } };
}, { auth:true });

post("/api/store/products/:id/images/upload", async ({ params, req, user }) => {
  adminOnly(user);
  rateLimit(`store-product-image-upload:${user.id}`, 80, 60_000);
  const product = await repo.byId("store_products", params.id);
  if (!product) throw new HttpError(404, "Товар не найден");
  const raw = await readRaw(req, config.storage.maxFileSize);
  if (!raw.length) throw new HttpError(400, "Выберите изображение");
  let filename = String(req.headers["x-file-name"] || "product-image");
  try { filename = decodeURIComponent(filename); } catch { /* sanitise below */ }
  filename = safeFilename(filename);
  const extension = path.extname(filename).toLowerCase();
  const imageType = IMAGE_TYPES[extension];
  if (!imageType || !imageType.valid(raw)) throw new HttpError(415, "Поддерживаются корректные JPG, PNG и WebP изображения");
  const variantId = await checkedVariantId(product.id, req.headers["x-variant-id"]);
  const storedName = `${crypto.randomBytes(12).toString("hex")}${extension}`;
  const relativeDir = path.join("uploads", "catalog");
  const absoluteDir = path.join(config.storage.localDir, "catalog");
  await fs.mkdir(absoluteDir, { recursive: true });
  await fs.writeFile(path.join(absoluteDir, storedName), raw, { flag: "wx" });
  const url = `/${relativeDir.replace(/\\/g, "/")}/${storedName}`;
  const position = variantId
    ? await db.get("SELECT COALESCE(MAX(position),-1)+1 AS position FROM store_product_images WHERE product_id=? AND variant_id=?", [product.id, variantId])
    : await db.get("SELECT COALESCE(MAX(position),-1)+1 AS position FROM store_product_images WHERE product_id=? AND variant_id IS NULL", [product.id]);
  const image = await repo.insert("store_product_images", { product_id: product.id, variant_id: variantId, url_original: url, alt_raw: product.name, position: Number(position?.position || 0), source_url: String(req.headers["x-image-source"] || "").slice(0, 500), download_status: "local" });
  await audit(user.id, "store_product_image_upload", "store_product", product.id, { filename, url }, clientIp(req));
  return { status: 201, data: image };
}, { auth: true, rawBody: true });

post("/api/store/products/:id/images", async ({ params, body, user }) => {
  adminOnly(user);
  const product = await repo.byId("store_products", params.id);
  if (!product) throw new HttpError(404, "Товар не найден");
  const imageUrl = String(body.url || "").trim();
  if (!/^https?:\/\//i.test(imageUrl) && !/^\/(?:uploads\/catalog|assets)\//i.test(imageUrl)) throw new HttpError(400, "Укажите HTTPS URL или путь к загруженному изображению");
  const variantId = await checkedVariantId(product.id, body.variant_id);
  const row = await repo.insert("store_product_images", { product_id:product.id, variant_id:variantId, url_original:imageUrl, alt_raw:String(body.alt || product.name).slice(0,240), position:Number(body.position) || 0, source_url:String(body.source_url || "").slice(0,500), download_status:"unverified" });
  return { status:201, data:row };
}, { auth:true });

put("/api/store/products/:id/images/:imageId", async ({ params, body, user, req }) => {
  adminOnly(user);
  const product = await repo.byId("store_products", params.id);
  if (!product) throw new HttpError(404, "Товар не найден");
  const image = await db.get("SELECT * FROM store_product_images WHERE id=? AND product_id=?", [Number(params.imageId), product.id]);
  if (!image) throw new HttpError(404, "Изображение не найдено у этого товара");
  const variantId = await checkedVariantId(product.id, body.variant_id);
  const alt = String(body.alt ?? image.alt_raw ?? product.name).trim().slice(0, 240);
  const position = Number(body.position ?? image.position ?? 0);
  if (!Number.isFinite(position) || Math.abs(position) > 100000) throw new HttpError(400, "Некорректный порядок изображения");
  await db.run("UPDATE store_product_images SET variant_id=?,alt_raw=?,position=? WHERE id=? AND product_id=?", [variantId, alt, Math.trunc(position), image.id, product.id]);
  const updated = await db.get("SELECT id,product_id,variant_id,url_original,alt_raw,position,source_url,download_status FROM store_product_images WHERE id=?", [image.id]);
  await audit(user.id, "store_product_image_assign", "store_product", product.id, { image_id: image.id, variant_id: variantId }, clientIp(req));
  return { data: updated };
}, { auth:true });

del("/api/store/products/:id/images/:imageId", async ({ params, user, req }) => {
  adminOnly(user);
  const product = await repo.byId("store_products", params.id);
  if (!product) throw new HttpError(404, "Товар не найден");
  const image = await db.get("SELECT * FROM store_product_images WHERE id=? AND product_id=?", [Number(params.imageId), product.id]);
  if (!image) throw new HttpError(404, "Изображение не найдено у этого товара");
  await db.run("DELETE FROM store_product_images WHERE id=? AND product_id=?", [image.id, product.id]);
  // Local files are retained deliberately: the same path may have been attached elsewhere.
  await audit(user.id, "store_product_image_unlink", "store_product", product.id, { image_id: image.id, variant_id: image.variant_id || null }, clientIp(req));
  return { data: { deleted: true, id: image.id } };
}, { auth: true });

/** Пакетная загрузка изображений из выбранной папки. Имя файла должно совпадать с названием, slug или SKU. */
post("/api/store/images/import", async ({ req, user }) => {
  adminOnly(user);
  rateLimit(`store-image-import:${user.id}`, 120, 60_000);
  const raw = await readRaw(req, config.storage.maxFileSize);
  if (!raw.length) throw new HttpError(400, "Пустой файл");
  let filename = String(req.headers["x-file-name"] || "image");
  try { filename = decodeURIComponent(filename); } catch { /* filename will be sanitized below */ }
  filename = safeFilename(filename);
  const extension = path.extname(filename).toLowerCase();
  const imageType = IMAGE_TYPES[extension];
  if (!imageType) throw new HttpError(415, "Поддерживаются только JPG, PNG и WebP");
  if (!imageType.valid(raw)) throw new HttpError(415, "Формат файла не совпадает с содержимым изображения");

  const stem = normalizeMatch(path.basename(filename, extension));
  let relativePath = String(req.headers["x-file-path"] || "").slice(0, 1200);
  try { relativePath = decodeURIComponent(relativePath); } catch { /* use the sanitized raw relative path */ }
  relativePath = relativePath.replace(/\\/g, "/").replace(/[\x00-\x1f]/g, "");
  const folderHints = relativePath.split("/").filter(Boolean).slice(0, -1).reverse().map(normalizeMatch).filter(Boolean);
  const products = await db.all("SELECT id,name,slug,sku,brand FROM store_products ORDER BY id");
  const aliasesFor = (product) => [product.name, product.slug?.replace(/-/g, " "), product.sku, `${product.brand || ""} ${product.name}`]
    .map(normalizeMatch).filter(Boolean);
  // Поддерживаются точные имена и ключевые слова в названиях файлов и на любой глубине папок.
  let exactMatches = [];
  let matchedByFolder = false;
  let productFolderIndex = -1;
  for (let index = 0; index < folderHints.length; index += 1) {
    const folderMatches = products.filter((product) => aliasesFor(product).includes(folderHints[index]));
    if (folderMatches.length) {
      exactMatches = folderMatches;
      matchedByFolder = true;
      productFolderIndex = index;
      break;
    }
  }
  if (!exactMatches.length) exactMatches = products.filter((product) => aliasesFor(product).includes(stem));
  if (exactMatches.length > 1) return { data: { status: "ambiguous", filename, candidates: exactMatches.map(({ id, name, sku }) => ({ id, name, sku })) } };

  let product = exactMatches[0] || null;
  let productMatchType = matchedByFolder ? "folder" : product ? "filename" : "";
  if (!product) {
    // Фаззи-поиск включается только при совпадении минимум двух значимых слов
    // и высокой доле совпадения, чтобы похожие товары не склеивались случайно.
    const folderMatches = rankImageMatches(folderHints, products, aliasesFor).filter((candidate) => candidate.score >= 0.82);
    if (folderMatches.length) {
      const bestScore = folderMatches[0].score;
      const bestMatches = folderMatches.filter((candidate) => bestScore - candidate.score < 0.04);
      if (bestMatches.length > 1) return { data: { status: "ambiguous", filename, candidates: bestMatches.map(({ item }) => ({ id: item.id, name: item.name, sku: item.sku })) } };
      product = bestMatches[0].item;
      matchedByFolder = true;
      productMatchType = "folder-keywords";
      productFolderIndex = folderHints.findIndex((hint) => aliasesFor(product).some((alias) => imageAliasScore(hint, alias) >= bestScore - 0.01));
    } else {
      const filenameMatches = rankImageMatches([stem], products, aliasesFor).filter((candidate) => candidate.score >= 0.82);
      if (!filenameMatches.length) return { data: { status: "unmatched", filename, relative_path: relativePath, detail: "Не найден товар по названию, артикулу или совпадающим ключевым словам в имени файла/папки" } };
      const bestScore = filenameMatches[0].score;
      const bestMatches = filenameMatches.filter((candidate) => bestScore - candidate.score < 0.04);
      if (bestMatches.length > 1) return { data: { status: "ambiguous", filename, candidates: bestMatches.map(({ item }) => ({ id: item.id, name: item.name, sku: item.sku })) } };
      product = bestMatches[0].item;
      productMatchType = "filename-keywords";
    }
  }

  const variants = await db.all("SELECT id,name,sku,attributes_json FROM store_product_variants WHERE product_id=? ORDER BY sort_order,id", [product.id]);
  const variantAliases = (variant) => {
    const attributes = json(variant.attributes_json, {});
    const colors = Object.entries(attributes || {}).filter(([key]) => /цвет|color|colour|оттенок|shade/i.test(key)).map(([, value]) => value);
    return [variant.name, variant.sku, ...colors].map(normalizeMatch).filter(Boolean);
  };
  const variantHints = [
    ...(matchedByFolder ? folderHints.slice(0, productFolderIndex) : folderHints),
    stem,
  ].filter(Boolean);
  const rankedVariants = rankImageMatches(variantHints, variants, variantAliases).filter((candidate) => candidate.score >= 0.72);
  if (rankedVariants.length) {
    const bestScore = rankedVariants[0].score;
    const bestMatches = rankedVariants.filter((candidate) => bestScore - candidate.score < 0.08);
    if (bestMatches.length > 1) return { data: { status: "ambiguous_variant", filename, product_id: product.id, product_name: product.name, candidates: bestMatches.map(({ item }) => ({ id: item.id, name: item.name, sku: item.sku })) } };
  }
  const variantMatch = rankedVariants[0] || null;
  if (matchedByFolder && productFolderIndex > 0 && !variantMatch) return { data: { status: "unmatched_variant", filename, relative_path: relativePath, product_id: product.id, detail: "Товар найден, но ключевых слов варианта недостаточно; фото не загружено" } };
  const variant = variantMatch?.item || null;
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const duplicate = await db.get("SELECT id,url_original FROM store_product_images WHERE product_id=? AND COALESCE(variant_id,0)=? AND content_sha256=? LIMIT 1", [product.id, variant?.id || 0, hash]);
  if (duplicate) return { data: { status: "duplicate", filename, relative_path: relativePath, product_id: product.id, product_name: product.name, variant_id: variant?.id || null, variant_name: variant?.name || null, image_id: duplicate.id } };
  if (req.headers["x-import-preview"] === "1") return { data: { status: "matched", filename, relative_path: relativePath, product_id: product.id, product_name: product.name, variant_id: variant?.id || null, variant_name: variant?.name || null } };
  const storedName = `${crypto.randomBytes(12).toString("hex")}${extension}`;
  const relativeDir = path.join("uploads", "catalog");
  const absoluteDir = path.join(config.storage.localDir, "catalog");
  await fs.mkdir(absoluteDir, { recursive: true });
  await fs.writeFile(path.join(absoluteDir, storedName), raw, { flag: "wx" });
  const publicUrl = `/${relativeDir.replace(/\\/g, "/")}/${storedName}`;
  const positionRow = variant
    ? await db.get("SELECT COALESCE(MAX(position),-1)+1 AS position FROM store_product_images WHERE product_id=? AND variant_id=?", [product.id, variant.id])
    : await db.get("SELECT COALESCE(MAX(position),-1)+1 AS position FROM store_product_images WHERE product_id=? AND variant_id IS NULL", [product.id]);
  const image = await repo.insert("store_product_images", {
    product_id: product.id, variant_id: variant?.id || null,
    url_original: publicUrl, alt_raw: variant ? `${product.name} — ${variant.name}` : product.name,
    position: Number(positionRow?.position || 0), source_url: "", download_status: "local", original_filename: filename, original_path: relativePath, content_sha256: hash,
  });
  await audit(user.id, "store_image_import", "store_product", product.id, { filename, url: publicUrl, variant_id: variant?.id || null }, clientIp(req));
  return { status: 201, data: { status: "matched", filename, relative_path: relativePath, matched_by: variant ? "variant-keywords" : productMatchType, product_id: product.id, product_name: product.name, variant_id: variant?.id || null, variant_name: variant?.name || null, image_id: image.id, url: publicUrl } };
}, { auth: true, rawBody: true });

const normalizeNewsInput = (body, existing = {}) => {
  const title = String(body.title ?? existing.title ?? "").trim().slice(0, 240);
  if (!title) throw new HttpError(400, "Укажите заголовок новости");
  const relatedIds = body.product_ids === undefined ? json(existing.product_ids_json, []) : body.product_ids;
  const productIds = [...new Set((Array.isArray(relatedIds) ? relatedIds : []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 30);
  return {
    title,
    slug: String(body.slug ?? existing.slug ?? slugify(title)).trim().slice(0, 180),
    excerpt: String(body.excerpt ?? existing.excerpt ?? "").trim().slice(0, 800),
    body: String(body.body ?? existing.body ?? "").slice(0, 20000),
    body_html: sanitizeNewsHtml(body.body_html ?? existing.body_html ?? ""),
    image_url: safeNewsImageUrl(body.image_url ?? existing.image_url ?? ""),
    image_hidden: body.image_hidden === undefined ? Number(existing.image_hidden || 0) : (body.image_hidden ? 1 : 0),
    is_18_plus: body.is_18_plus === undefined ? Number(existing.is_18_plus || 0) : (body.is_18_plus ? 1 : 0),
    product_ids_json: JSON.stringify(productIds),
    published_at: String(body.published_at ?? existing.published_at ?? "").slice(0, 40),
    status: body.status === "published" ? "published" : (body.status === "archived" ? "archived" : "draft"),
    source_url: String(body.source_url ?? existing.source_url ?? "").trim().slice(0, 1000),
  };
};

post("/api/store/news", async ({ body, user }) => {
  adminOnly(user);
  const fields = normalizeNewsInput(body);
  if (fields.is_18_plus) fields.image_hidden = 1;
  const row = await repo.insert("store_news", fields);
  return { status: 201, data: row };
}, { auth: true });

put("/api/store/news/:id", async ({ params, body, user }) => {
  adminOnly(user);
  const row = await repo.byId("store_news", params.id);
  if (!row) throw new HttpError(404, "Новость не найдена");
  const fields = normalizeNewsInput(body, row);
  if (fields.is_18_plus) fields.image_hidden = 1;
  return { data: await repo.update("store_news", row.id, { ...fields, updated_at: nowIso() }) };
}, { auth: true });

post("/api/store/news/images", async ({ req, user }) => {
  adminOnly(user);
  const raw = await readRaw(req, config.storage.maxFileSize);
  if (!raw.length) throw new HttpError(400, "Пустой файл");
  let filename = String(req.headers["x-file-name"] || "news-image");
  try { filename = decodeURIComponent(filename); } catch { /* sanitize filename */ }
  filename = safeFilename(filename);
  const extension = path.extname(filename).toLowerCase();
  const imageType = IMAGE_TYPES[extension];
  if (!imageType || !imageType.valid(raw)) throw new HttpError(415, "Поддерживаются корректные JPG, PNG и WebP изображения");
  const storedName = `${crypto.randomBytes(12).toString("hex")}${extension}`;
  const relativeDir = path.join("uploads", "news");
  const absoluteDir = path.join(PUBLIC_DIR, relativeDir);
  await fs.mkdir(absoluteDir, { recursive: true });
  await fs.writeFile(path.join(absoluteDir, storedName), raw, { flag: "wx" });
  return { status: 201, data: { url: `/${relativeDir.replace(/\\/g, "/")}/${storedName}` } };
}, { auth: true, rawBody: true });

post("/api/store/news/generate", async ({ body, user }) => {
  adminOnly(user);
  rateLimit(`store-news-generate:${user.id}`, 6, 60 * 60_000);
  const prompt = String(body.prompt || "").trim().slice(0, 1800);
  if (prompt.length < 8) throw new HttpError(400, "Опишите тему новости минимум в восьми символах");
  if (!config.gemini.apiKey) throw new HttpError(503, "Google Gemini не настроен. Добавьте GEMINI_API_KEY в .env");
  const input = `Создай черновик информационной новости на русском языке для сайта VAPELAB по краткому заданию ниже. Используй Google Search для проверки фактов. Не выдумывай даты, цены, характеристики, цитаты или события. Не делай рекламных утверждений и не обращайся к несовершеннолетним. Если тема затрагивает табачные/никотиновые товары, пиши только нейтральный информационный текст без побуждения к покупке. Верни строго JSON без Markdown: {"title":"...","excerpt":"...","body_html":"..."}. body_html должен содержать только простые теги p,h2,h3,strong,em,ul,ol,li,blockquote,a. В body_html в конце добавь краткий список источников ссылками, если Search нашёл источники. Задание: ${prompt}`;
  let response;
  try {
    response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": config.gemini.apiKey },
      body: JSON.stringify({ model: config.gemini.model, input, tools: [{ type: "google_search" }] }),
      signal: AbortSignal.timeout(45000),
    });
  } catch (error) { throw new HttpError(502, `Google Gemini недоступен: ${error.message}`); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(502, `Google Gemini вернул ошибку (${response.status})`);
  const steps = Array.isArray(result.steps) ? result.steps : (Array.isArray(result.output) ? result.output : []);
  const output = String(result.output_text || steps.filter((step) => step.type === "model_output").flatMap((step) => step.content || []).map((part) => part.text || "").join("\n") || "").trim();
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) throw new HttpError(502, "Google Gemini вернул текст вместо ожидаемого черновика JSON. Повторите запрос или заполните редактор вручную.");
  let draft;
  try { draft = JSON.parse(output.slice(start, end + 1)); } catch { throw new HttpError(502, "Не удалось разобрать черновик Google Gemini. Повторите запрос."); }
  const sources = [...new Set(steps.flatMap((step) => (step.content || []).flatMap((part) => part.annotations || []).map((annotation) => annotation.url || annotation.source?.url || "").filter((url) => /^https?:\/\//i.test(url))))].slice(0, 12);
  return { data: { title: String(draft.title || "").slice(0, 240), excerpt: String(draft.excerpt || "").slice(0, 800), body_html: sanitizeNewsHtml(draft.body_html || ""), sources, status: "draft", requires_review: true } };
}, { auth: true });

post("/api/store/pages", async ({ body, user }) => {
  siteAdminOnly(user); if (!body.title) throw new HttpError(400, "Укажите название страницы");
  const row = await repo.insert("store_pages", { title: body.title, slug: body.slug || slugify(body.title), page_type: body.page_type || "content", body: body.body || "", status: "draft", legal_review_status: "pending", source_url: body.source_url || "" });
  return { status: 201, data: row };
}, { auth: true });

put("/api/store/pages/:id", async ({ params, body, user }) => {
  siteAdminOnly(user); const row = await repo.byId("store_pages", params.id); if (!row) throw new HttpError(404, "Страница не найдена");
  return { data: await repo.update("store_pages", row.id, { title: body.title ?? row.title, slug: body.slug ?? row.slug, page_type: body.page_type ?? row.page_type, body: body.body ?? row.body, status: body.status ?? row.status, legal_review_status: body.legal_review_status ?? row.legal_review_status, updated_at: nowIso() }) };
}, { auth: true });

put("/api/store/settings", async ({ body, user }) => {
  siteAdminOnly(user);
  const allowed = [
    "brand_name","logo_url","favicon_url","logo_background","accent_color","font_heading","font_body","contact_phone","telegram_url","catalog_notice",
    "header_tagline","hero_eyebrow","hero_title","hero_description","hero_cta_label",
    "about_eyebrow","about_heading","about_lead","about_text","categories_eyebrow","categories_heading","categories_intro",
    "directions_eyebrow","directions_heading","directions_intro","retail_heading","retail_description","wholesale_heading","wholesale_description",
    "news_eyebrow","news_heading","contacts_eyebrow","contacts_heading","contacts_description","footer_description",
  ];
  const limits = {
    header_tagline: 160, hero_eyebrow: 120, hero_title: 240, hero_description: 1200, hero_cta_label: 80,
    about_eyebrow: 80, about_heading: 240, about_lead: 1200, about_text: 3000,
    categories_eyebrow: 80, categories_heading: 180, categories_intro: 500,
    directions_eyebrow: 80, directions_heading: 180, directions_intro: 1000,
    retail_heading: 160, retail_description: 1200, wholesale_heading: 160, wholesale_description: 1200,
    news_eyebrow: 80, news_heading: 180, contacts_eyebrow: 80, contacts_heading: 180, contacts_description: 1000,
    footer_description: 1000,
  };
  for (const key of allowed) {
    if (body[key] === undefined) continue;
    const value = String(body[key] ?? "").trim();
    if (value.length > (limits[key] || 1000)) throw new HttpError(400, `Поле ${key} слишком длинное`);
    await db.run("INSERT INTO store_settings(setting_key,setting_value,updated_at) VALUES(?,?,?) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=excluded.updated_at", [key, value, nowIso()]);
  }
  return { data: Object.fromEntries((await db.all("SELECT setting_key,setting_value FROM store_settings")).map((s) => [s.setting_key,s.setting_value])) };
}, { auth: true });

del("/api/store/products/:id", async ({ params, user }) => {
  adminOnly(user); const row = await repo.byId("store_products", params.id); if (!row) throw new HttpError(404, "Товар не найден");
  await db.run("DELETE FROM store_product_categories WHERE product_id=?", [row.id]);
  await db.run("DELETE FROM store_product_images WHERE product_id=?", [row.id]);
  await db.run("DELETE FROM store_product_variants WHERE product_id=?", [row.id]);
  await db.run("DELETE FROM store_keyword_targets WHERE product_id=?", [row.id]);
  await repo.remove("store_products", row.id); return { status: 204, data: null };
}, { auth: true });
