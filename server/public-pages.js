/** Server-rendered public category, product, news and content pages. */
import { db } from "./db.js";
import { parseMoneyMinor, formatMoneyMinor } from "./money.js";


const esc = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

// Imported descriptions can contain literal HTML entities and Markdown fragments.
// Decode the text once and HTML-escape it again at the output boundary.
const decodeHtmlEntities = (value = "") => String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ensp|emsp|thinsp|ndash|mdash|hellip|laquo|raquo);/gi, (match, entity) => {
  const key = entity.toLowerCase();
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»" };
  if (Object.hasOwn(named, key)) return named[key];
  const code = key.startsWith("#x") ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
});
const cleanDisplayText = (value = "") => decodeHtmlEntities(value)
  .replace(/^\s*G\s+(?=\*\*)/i, " ")
  .replace(/\*\*(.*?)\*\*/gs, "$1")
  .replace(/__(.*?)__/gs, "$1")
  .replace(/^\s*G\s+(?=изображение\s+не\s+предоставлено)/i, " ")
  .replace(/\s+/g, " ")
  .trim();
const escText = (value = "") => esc(cleanDisplayText(value));

const parseJson = (value, fallback = {}) => {
  if (typeof value !== "string") return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

function safeNewsHtml(value = "") {
  const html = String(value || "").slice(0, 40000).replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|iframe|object|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  return html.replace(/<(\/?)([a-z0-9]+)([^>]*)>/gi, (match, closing, rawTag, attrs) => {
    const tag = rawTag.toLowerCase();
    if (!["p", "h2", "h3", "strong", "b", "em", "i", "u", "ul", "ol", "li", "blockquote", "br", "a", "span"].includes(tag)) return "";
    if (closing) return tag === "br" ? "" : `</${tag}>`;
    if (tag !== "a") return `<${tag}>`;
    const href = /href\s*=\s*(["'])(.*?)\1/i.exec(attrs)?.[2] || "";
    return /^(https?:\/\/|\/product\/)[^\s"'<>]*$/i.test(href) ? `<a href="${esc(href)}" rel="nofollow noopener">` : "<a>";
  });
}

const plainText = (value = "") => cleanDisplayText(String(value).replace(/<[^>]*>/g, " "));
const usefulDescription = (value = "") => {
  const text = plainText(value);
  if (!text) return "";
  if (/^(?:отдельное описание в доступном источнике не обнаружено|описание товара не обнаружено|описание отсутствует|нет описания|описание не предоставлено|изображение не предоставлено)[.!]?$/i.test(text)) return "";
  return text;
};
const publicImageUrl = (value = "") => {
  let raw = cleanDisplayText(value).trim();
  if (!raw) return "";
  if (/^(?:assets|uploads|images|media|storage|files)\//i.test(raw)) raw = `/${raw}`;
  // HTTP catalog links are upgraded to HTTPS to avoid mixed-content blocking.
  if (/^http:\/\//i.test(raw)) raw = raw.replace(/^http:\/\//i, "https://");
  if (/^https:\/\//i.test(raw)) {
    try { const url = new URL(raw); return url.username || url.password ? "" : url.href; }
    catch { return ""; }
  }
  if (/^\/(?:assets|uploads|images|media|storage|files)\/[a-z0-9_./%?&=+#-]+$/i.test(raw) && !raw.includes("..") && !raw.startsWith("//")) return raw;
  return "";
};
const safeHttpUrl = (value = "") => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
  } catch { return ""; }
};
const excerpt = (value = "", limit = 158) => {
  const text = plainText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
};
const initials = (value = "VAPELAB") => String(value).trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "V";

function canonicalFor(base, path, override = "") {
  const value = String(override || "").trim();
  if (value) {
    try {
      const url = new URL(value, base);
      if (["http:", "https:"].includes(url.protocol)) return url.href;
    } catch { /* fall through to the route canonical */ }
  }
  return `${base}${path}`;
}

function htmlDocument({ title, description, canonical, robots = "index, follow", body, type = "website" }) {
  const escapedTitle = esc(title);
  const escapedDescription = esc(description);
  const escapedCanonical = esc(canonical);
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#090909">
<meta name="description" content="${escapedDescription}">
<meta name="robots" content="${esc(robots)}">
<meta property="og:type" content="${esc(type)}">
<meta property="og:site_name" content="VAPELAB">
<meta property="og:title" content="${escapedTitle}">
<meta property="og:description" content="${escapedDescription}">
<meta property="og:url" content="${escapedCanonical}">
<link rel="canonical" href="${escapedCanonical}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/brand/favicon-32.png">
<link rel="apple-touch-icon" href="/assets/brand/favicon-128.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Unbounded:wght@500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/fonts.css">
<link rel="stylesheet" href="/storefront.css">
<link rel="stylesheet" href="/seo-pages.css">
<link rel="stylesheet" href="/customer-tools.css">
<script defer src="/reactbits/spotlight-fallback.js"></script>
<script defer src="/site-navigation.js"></script>
<script defer src="/store-recommendations.js"></script>
<script defer src="/visitor-analytics.js"></script>
<script defer src="/product-variants.js"></script>
<script defer src="/store-reservations.js"></script>
<script defer src="/store-restock.js"></script>
<script defer src="/customer-tools.js"></script>
<title>${escapedTitle}</title>
</head>
<body class="seo-page">
${body}
</body>
</html>`;
}

function siteHeader() {
  return `<div class="topline"><div class="wrap topline-inner"><span>VAPELAB</span><span>Информационный каталог компании</span><span>Информация и бронирование</span></div></div>
<header class="site-header"><div class="wrap header-inner">
<a class="brand" href="/" aria-label="VAPELAB — главная"><span class="brand-mark"><img src="/assets/brand/vapelab-logo.webp" alt="Логотип VAPELAB"></span><span class="brand-copy"><strong>VAPELAB</strong><small>Каталог и история компании</small></span></a>
<nav class="main-nav" aria-label="Основная навигация"><a href="/">Главная</a><a href="/tabak">Каталог</a><a href="/#news">Новости</a><a href="/#contacts">Контакты</a></nav>
<a class="login-link" href="/crm">Личный кабинет <span aria-hidden="true">↗</span></a>
<button class="menu-toggle" id="menu-toggle" type="button" aria-label="Открыть меню" aria-expanded="false" aria-controls="mobile-nav"><span></span><span></span></button>
</div><nav class="mobile-nav" id="mobile-nav" aria-label="Мобильная навигация" hidden><a href="/">Главная</a><a href="/tabak">Каталог</a><a href="/#news">Новости</a><a href="/#contacts">Контакты</a><a href="/crm">Личный кабинет</a></nav></header>`;
}

function siteFooter(description = "Информация о компании, категориях и карточках каталога.") {
  return `<footer class="site-footer"><div class="wrap footer-main"><a class="footer-brand" href="/" aria-label="VAPELAB — на главную"><span class="footer-mark"><img src="/assets/brand/vapelab-logo.webp" alt=""></span><span>VAPELAB</span></a><p>${esc(description)}</p><nav aria-label="Навигация в подвале"><a href="/tabak">Каталог</a><a href="/#about">О компании</a><a href="/#news">Новости</a><a href="/#contacts">Контакты</a><a href="/page/privacy">Политика конфиденциальности</a><a href="/page/delivery">Доставка</a><a href="/crm">Личный кабинет ↗</a><button type="button" class="cookie-settings-button" data-cookie-settings data-analytics-ignore>Настройки cookie</button></nav></div><div class="wrap footer-bottom"><span>© ${new Date().getFullYear()} VAPELAB</span><a href="/">На главную ↑</a></div></footer>`;
}

function breadcrumb(items) {
  return `<nav class="seo-breadcrumb" aria-label="Хлебные крошки"><a href="/">Главная</a>${items.map((item) => item.href ? `<span aria-hidden="true">/</span><a href="${esc(item.href)}">${esc(item.label)}</a>` : `<span aria-hidden="true">/</span><span aria-current="page">${esc(item.label)}</span>`).join("")}</nav>`;
}

function productCard(product, image) {
  const safeImage = publicImageUrl(image?.url_original || "");
  const visual = safeImage
    ? `<div class="seo-product-image"><img src="${esc(safeImage)}" alt="${escText(image?.alt_raw || product.name)}" loading="lazy" decoding="async"></div>`
    : `<div class="seo-product-image seo-product-placeholder" aria-label="Изображение пока не добавлено"><span>${esc(initials(product.brand || product.name))}</span></div>`;
  const detail = usefulDescription(product.description);
  const rawPrice = String(product.price_raw || "").trim();
  const hasPrice = rawPrice && !/^(?:не\s+указан[ао]?|цена\s+не\s+указан[ао]?|нет\s+данных|n\/?a|[-—–])$/i.test(rawPrice);
  const price = hasPrice ? `<span class="seo-product-price">${esc(rawPrice)}</span>` : "";
  return `<div class="rb-spotlight-mount" data-reactbits-spotlight><article class="seo-product-card"><a class="seo-product-card-link" href="/product/${encodeURIComponent(product.slug)}" aria-label="Открыть: ${esc(product.name)}">${visual}<div class="seo-product-copy"><p class="seo-product-brand">${escText(product.brand || product.product_type || "VAPELAB")}</p><h2>${escText(product.name)}</h2>${detail ? `<p class="seo-product-description">${esc(excerpt(detail, 132))}</p>` : ""}<div class="seo-product-foot">${price}<span>Подробнее ↗</span></div></div></a></article></div>`;
}

async function loadProductsForCategoryIds(categoryIds, { page = 1, pageSize = 24 } = {}) {
  const ids = [...new Set(categoryIds.map(Number).filter(Number.isFinite))];
  if (!ids.length) return { items: [], total: 0, page: 1, pageSize, totalPages: 1 };
  const where = `p.status='published' AND EXISTS (
    SELECT 1 FROM store_product_categories pc WHERE pc.product_id=p.id AND pc.category_id IN (${ids.map(() => "?").join(",")})
  )`;
  const countRow = await db.get(`SELECT COUNT(*) AS total FROM store_products p WHERE ${where}`, ids);
  const total = Number(countRow?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const products = await db.all(
    `SELECT p.* FROM store_products p WHERE ${where} ORDER BY p.name COLLATE NOCASE,p.id LIMIT ? OFFSET ?`,
    [...ids, pageSize, (safePage - 1) * pageSize],
  );
  if (!products.length) return { items: [], total, page: safePage, pageSize, totalPages };
  const productIds = new Set(products.map((product) => Number(product.id)));
  const images = await db.all(`SELECT product_id,url_original,alt_raw,position FROM store_product_images WHERE product_id IN (${products.map(() => "?").join(",")}) ORDER BY position,id`, products.map((product) => product.id));
  const imageByProduct = new Map();
  for (const image of images) if (productIds.has(Number(image.product_id)) && !imageByProduct.has(Number(image.product_id))) imageByProduct.set(Number(image.product_id), image);
  return { items: products.map((product) => ({ ...product, image: imageByProduct.get(Number(product.id)) || null })), total, page: safePage, pageSize, totalPages };
}

function pageNumber(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 100000) : 1;
}

function pagination(req, key, current, totalPages) {
  if (totalPages <= 1) return "";
  const url = new URL(req.url, "http://localhost");
  const makeLink = (page, label, extra = "") => {
    const params = new URLSearchParams(url.searchParams);
    if (page <= 1) params.delete(key); else params.set(key, String(page));
    const query = params.toString();
    return `<a class="${extra}${page === current ? " is-current" : ""}" href="${esc(`${url.pathname}${query ? `?${query}` : ""}`)}"${page === current ? ' aria-current="page"' : ""}>${label}</a>`;
  };
  const pages = new Set([1, totalPages]);
  for (let value = Math.max(1, current - 2); value <= Math.min(totalPages, current + 2); value += 1) pages.add(value);
  const ordered = [...pages].sort((a, b) => a - b);
  const links = [];
  if (current > 1) links.push(makeLink(current - 1, "← Назад", "pagination-prev"));
  let previous = 0;
  for (const value of ordered) {
    if (previous && value - previous > 1) links.push('<span class="pagination-gap" aria-hidden="true">…</span>');
    links.push(makeLink(value, String(value), "pagination-page"));
    previous = value;
  }
  if (current < totalPages) links.push(makeLink(current + 1, "Далее →", "pagination-next"));
  return `<nav class="seo-pagination" aria-label="Страницы каталога">${links.join("")}</nav>`;
}

function sendHtml(req, res, body, { status = 200, noindex = false, cache = "public, max-age=60" } = {}) {
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": cache,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Robots-Tag": noindex ? "noindex, nofollow" : "index, follow",
  };
  res.writeHead(status, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

async function pageCategories(pageId) {
  const members = await db.all(
    `SELECT c.* FROM store_category_page_categories m JOIN store_categories c ON c.id=m.category_id WHERE m.page_id=? AND c.is_active=1 ORDER BY m.sort_order,c.sort_order,c.name`,
    [pageId],
  );
  const childRows = members.length
    ? await db.all(`SELECT * FROM store_categories WHERE is_active=1 AND parent_id IN (${members.map(() => "?").join(",")}) ORDER BY sort_order,name`, members.map((item) => item.id))
    : [];
  return { members, childRows };
}

async function renderCategoryLanding(req, res, page, base) {
  const { members, childRows } = await pageCategories(page.id);
  const sections = [];
  for (const category of members) {
    const children = childRows.filter((child) => Number(child.parent_id) === Number(category.id));
    const ids = [category.id, ...children.map((child) => child.id)];
    const query = new URL(req.url, "http://localhost").searchParams;
    const pageKey = `p_${category.id}`;
    const products = await loadProductsForCategoryIds(ids, { page: pageNumber(query.get(pageKey)), pageSize: 12 });
    sections.push({ category, children, products, pageKey });
  }
  const allCategoryIds = [...new Set(members.flatMap((category) => [category.id, ...childRows.filter((child) => Number(child.parent_id) === Number(category.id)).map((child) => child.id)]).map(Number))];
  const uniqueCount = allCategoryIds.length
    ? await db.get(`SELECT COUNT(DISTINCT p.id) AS total FROM store_products p JOIN store_product_categories pc ON pc.product_id=p.id WHERE p.status='published' AND pc.category_id IN (${allCategoryIds.map(() => "?").join(",")})`, allCategoryIds)
    : { total: 0 };
  const uniqueProductCount = Number(uniqueCount?.total || 0);
  const categoryLinks = members.map((category) => {
    const children = childRows.filter((child) => Number(child.parent_id) === Number(category.id));
    return `<div class="seo-category-tile"><a href="#section-${esc(category.slug)}"><strong>${esc(category.name)}</strong><span>${children.length ? `${children.length} вложенных раздела` : "Перейти к позициям"} ↗</span></a>${children.length ? `<div class="seo-subcategory-links">${children.map((child) => `<a href="/${encodeURIComponent(child.slug)}">${esc(child.name)} ↗</a>`).join("")}</div>` : ""}</div>`;
  }).join("");
  const productSections = sections.map(({ category, children, products, pageKey }) => {
    const items = products.items;
    return `<section class="seo-category-section" id="section-${esc(category.slug)}"><div class="seo-section-heading"><div><p class="seo-eyebrow">КАТЕГОРИЯ</p><h2>${esc(category.name)}</h2></div><span>${products.total} ${products.total === 1 ? "позиция" : "позиций"}</span></div>${children.length ? `<nav class="seo-subcategory-pills" aria-label="Вложенные категории">${children.map((child) => `<a href="/${encodeURIComponent(child.slug)}">${esc(child.name)} ↗</a>`).join("")}</nav>` : ""}${items.length ? `<div class="seo-product-grid">${items.map((p) => productCard(p, p.image)).join("")}</div>${pagination(req, pageKey, products.page, products.totalPages)}` : `<p class="seo-empty">В опубликованной выборке нет отдельных карточек этой категории.</p>`}</section>`;
  }).join("");

  const body = `${siteHeader()}<main class="wrap seo-main">${breadcrumb([{ label: page.h1 }])}<header class="seo-page-heading"><p class="seo-eyebrow">VAPELAB · КАТАЛОГ</p><h1>${esc(page.h1)}</h1><p>${esc(page.intro || page.seo_description)}</p><div class="seo-page-stats"><span>${members.length} ${members.length === 1 ? "раздел" : "раздела"}</span><span>${uniqueProductCount} карточек в текущей выборке</span></div></header>${members.length > 1 || childRows.length ? `<section class="seo-category-navigation"><div class="seo-section-heading"><div><p class="seo-eyebrow">НАВИГАЦИЯ</p><h2>Разделы каталога</h2></div></div><div class="seo-category-tiles">${categoryLinks}</div></section>` : ""}${productSections}<section class="seo-recommendations" data-recommendations data-daily="1" data-category-ids="${allCategoryIds.join(",")}"><div class="seo-section-heading"><div><p class="seo-eyebrow">ПОДБОРКА</p><h2>Рекомендуемые позиции</h2></div></div><div class="seo-recommendations-grid" aria-live="polite"></div></section><p class="seo-catalog-note">Информационный каталог. Подписи цен и статусов воспроизводят сохранённые сведения и требуют актуальной проверки. Страница не оформляет дистанционную покупку.</p></main>${siteFooter()}`;
  const canonical = canonicalFor(base, `/${page.slug}`, page.canonical_url);
  const indexable = Number(page.robots_index) !== 0 && uniqueProductCount > 0;
  const document = htmlDocument({ title: page.seo_title || `${page.h1} — VAPELAB`, description: page.seo_description || `Информационный раздел каталога VAPELAB: ${page.h1}.`, canonical, robots: indexable ? "index, follow" : "noindex, nofollow", body });
  sendHtml(req, res, document, { noindex: !indexable });
}

async function renderCategoryRecord(req, res, category, base) {
  const children = await db.all("SELECT * FROM store_categories WHERE parent_id=? AND is_active=1 ORDER BY sort_order,name", [category.id]);
  const page = await loadProductsForCategoryIds([category.id, ...children.map((item) => item.id)], { page: pageNumber(new URL(req.url, "http://localhost").searchParams.get("page")), pageSize: 24 });
  const parent = category.parent_id ? await db.get("SELECT * FROM store_categories WHERE id=?", [category.parent_id]) : null;
  let parentPage = null;
  if (parent) {
    parentPage = await db.get("SELECT p.slug,p.h1 FROM store_category_page_categories m JOIN store_category_pages p ON p.id=m.page_id WHERE m.category_id=? AND p.status='published' LIMIT 1", [parent.id]);
  }
  const categoryRoute = `/${category.slug}`;
  const cards = page.items.map((p) => productCard(p, p.image)).join("");
  const childLinks = children.length ? `<section class="seo-category-navigation"><div class="seo-section-heading"><h2>Вложенные разделы</h2></div><div class="seo-category-tiles">${children.map((child) => `<div class="seo-category-tile"><a href="/${encodeURIComponent(child.slug)}"><strong>${esc(child.name)}</strong><span>Открыть раздел ↗</span></a></div>`).join("")}</div></section>` : "";
  const body = `${siteHeader()}<main class="wrap seo-main">${breadcrumb([...(parentPage ? [{ label: parentPage.h1, href: `/${parentPage.slug}` }] : []), { label: category.name }])}<header class="seo-page-heading"><p class="seo-eyebrow">VAPELAB · КАТЕГОРИЯ</p><h1>${esc(category.name)}</h1><p>${esc(category.description || `Информационный раздел каталога VAPELAB: ${category.name}.`)}</p><div class="seo-page-stats"><span>${page.total} ${page.total === 1 ? "позиция" : "позиций"}</span></div></header>${childLinks}<section class="seo-category-section"><div class="seo-product-grid">${cards}</div>${page.items.length ? pagination(req, "page", page.page, page.totalPages) : `<p class="seo-empty">Опубликованных карточек пока нет.</p>`}</section><section class="seo-recommendations" data-recommendations data-daily="1" data-category-id="${Number(category.id)}"><div class="seo-section-heading"><div><p class="seo-eyebrow">ПОДБОРКА</p><h2>Рекомендуемые позиции</h2></div></div><div class="seo-recommendations-grid" aria-live="polite"></div></section><p class="seo-catalog-note">Информационный каталог. Сведения и подписи требуют проверки по актуальному источнику. Страница не оформляет дистанционную покупку.</p></main>${siteFooter("Карточки и категории информационного каталога VAPELAB.")}`;
  const canonical = canonicalFor(base, categoryRoute);
  const indexable = page.total > 0;
  const document = htmlDocument({ title: `${category.name} — VAPELAB`, description: excerpt(category.description || `Информационный раздел каталога VAPELAB: ${category.name}.`, 158), canonical, robots: indexable ? "index, follow" : "noindex, nofollow", body });
  sendHtml(req, res, document, { noindex: !indexable });
}

async function renderProduct(req, res, product, base) {
  const relations = await db.all(
    `SELECT c.* FROM store_product_categories pc JOIN store_categories c ON c.id=pc.category_id WHERE pc.product_id=? ORDER BY c.parent_id,c.sort_order,c.name`,
    [product.id],
  );
  const images = await db.all("SELECT * FROM store_product_images WHERE product_id=? ORDER BY position,id", [product.id]);
  const variants = await db.all("SELECT * FROM store_product_variants WHERE product_id=? ORDER BY sort_order,id", [product.id]);
  const specs = parseJson(product.specifications_json, {});
  const h1 = product.seo_h1 || product.name;
  const productDescription = usefulDescription(product.description);
  const description = product.seo_description || excerpt(productDescription || `${product.name}. Информация о позиции в каталоге VAPELAB.`, 158);
  const publicImages = images.map((image) => ({ ...image, public_url: publicImageUrl(image.url_original) })).filter((image) => image.public_url);
  const productImages = publicImages.filter((image) => !Number(image.variant_id));
  const imagesByVariant = new Map();
  for (const image of publicImages) {
    const variantId = Number(image.variant_id || 0);
    if (!variantId) continue;
    const list = imagesByVariant.get(variantId) || [];
    list.push(image);
    imagesByVariant.set(variantId, list);
  }
  const firstVariantWithImage = variants.find((variant) => (imagesByVariant.get(Number(variant.id)) || []).length);
  const initialVariant = firstVariantWithImage || variants[0] || null;
  const initialVariantImages = initialVariant ? (imagesByVariant.get(Number(initialVariant.id)) || []) : [];
  const initialImage = initialVariantImages[0] || productImages[0] || null;
  const initialGallery = (initialVariantImages.length ? initialVariantImages : productImages).map((image) => ({ url: image.public_url, alt: image.alt_raw || product.name }));
  const imageGallery = initialImage
    ? `<section class="seo-product-media" data-product-media data-gallery-images="${esc(JSON.stringify(initialGallery))}" data-default-image="${esc(productImages[0]?.public_url || "")}" data-default-alt="${escText(productImages[0]?.alt_raw || product.name)}"><figure class="seo-product-gallery-stage"><img data-product-main-image src="${esc(initialImage.public_url)}" alt="${escText(initialImage.alt_raw || product.name)}" fetchpriority="high" decoding="async"><div class="seo-product-placeholder seo-product-placeholder-large" data-product-gallery-placeholder hidden><span>${escText(initials(product.brand || product.name))}</span><small>Изображение недоступно</small></div></figure><div class="variant-gallery-controls" data-gallery-controls><button type="button" data-gallery-prev aria-label="Предыдущее фото">←</button><span data-gallery-counter></span><button type="button" data-gallery-next aria-label="Следующее фото">→</button></div></section>`
    : `<section class="seo-product-media" data-product-media data-gallery-images="${esc(JSON.stringify(initialGallery))}" data-default-image="" data-default-alt="${escText(product.name)}"><figure class="seo-product-gallery-stage"><img data-product-main-image alt="${escText(product.name)}" hidden decoding="async"><div class="seo-product-placeholder seo-product-placeholder-large" data-product-gallery-placeholder><span>${escText(initials(product.brand || product.name))}</span><small>Изображение не предоставлено</small></div></figure><div class="variant-gallery-controls" data-gallery-controls hidden><button type="button" data-gallery-prev aria-label="Предыдущее фото">←</button><span data-gallery-counter></span><button type="button" data-gallery-next aria-label="Следующее фото">→</button></div></section>`;
  const specRows = Object.entries(specs && typeof specs === "object" ? specs : {}).map(([key, value]) => `<div><dt>${escText(key)}</dt><dd>${escText(Array.isArray(value) ? value.join(", ") : value)}</dd></div>`).join("");
  const usefulSourceValue = (value) => {
    const text = cleanDisplayText(value);
    return text && !/^(?:не\s+указан[ао]?|цена\s+не\s+указан[ао]?|нет\s+данных|n\/?a|[-—–])$/i.test(text) ? text : "";
  };
  const rawPrice = usefulSourceValue(product.price_raw);
  const oldPrice = usefulSourceValue(product.old_price_raw);
  const stockStatus = ["in_stock", "out_of_stock", "preorder", "unknown"].includes(String(product.availability_status || "")) ? product.availability_status : "unknown";
  const stockLabel = ({ in_stock: "В наличии", out_of_stock: "Отсутствует", preorder: "Предзаказ", unknown: "Наличие уточняется" })[stockStatus];
  const availability = usefulSourceValue(product.availability_label_raw) || (stockStatus !== "unknown" ? stockLabel : "");
  const variantView = variants.map((variant) => {
    const attributes = parseJson(variant.attributes_json, {});
    const attributeEntries = attributes && typeof attributes === "object" ? Object.entries(attributes) : [];
    const colorEntry = attributeEntries.find(([key]) => /цвет|color|colour|оттенок|shade/i.test(key));
    const colorLabel = cleanDisplayText(colorEntry?.[1] || variant.name);
    const attributeText = attributeEntries.filter(([key]) => !/цвет|color|colour|оттенок|shade/i.test(key))
      .map(([key, value]) => `${cleanDisplayText(key)}: ${cleanDisplayText(Array.isArray(value) ? value.join(", ") : value)}`).join(" · ");
    const variantImages = imagesByVariant.get(Number(variant.id)) || [];
    return {
      variant, colorLabel, attributeText, image: variantImages[0] || null, images: (variantImages.length ? variantImages : productImages).map((image) => ({ url: image.public_url, alt: image.alt_raw || product.name })),
      variantPrice: usefulSourceValue(variant.price_raw),
      variantOldPrice: usefulSourceValue(variant.old_price_raw),
      variantAvailability: usefulSourceValue(variant.availability_label_raw),
    };
  });
  const initialVariantView = variantView.find((item) => Number(item.variant.id) === Number(initialVariant?.id)) || variantView[0] || null;
  const displayPrice = initialVariantView?.variantPrice || rawPrice;
  const displayOldPrice = initialVariantView?.variantOldPrice || oldPrice;
  const displayAvailability = initialVariantView?.variantAvailability || ({ in_stock: "В наличии", out_of_stock: "Отсутствует", preorder: "Предзаказ", unknown: "Наличие уточняется" })[initialVariantView?.variant.availability_status] || availability;
  const priceCurrency = String(initialVariantView?.variant.currency || product.currency || "RUB").toUpperCase();
  const unitPriceMinor = parseMoneyMinor(displayPrice);
  const hasCalculatedPrice = unitPriceMinor !== null;
  const unitPriceLabel = hasCalculatedPrice ? formatMoneyMinor(unitPriceMinor, priceCurrency) : "Уточняется менеджером";
  const totalPriceLabel = hasCalculatedPrice ? formatMoneyMinor(unitPriceMinor, priceCurrency) : "Будет подтверждена менеджером";
  const variantRows = variantView.length ? `<section class="seo-product-variants" aria-label="Варианты товара"><h2>Выберите цвет или вариант</h2><div class="seo-product-variant-options" role="group" aria-label="Варианты товара">${variantView.map((item) => {
    const selected = Number(item.variant.id) === Number(initialVariant?.id);
    const fallbackImage = productImages[0]?.public_url || "";
    return `<button type="button" class="seo-product-variant-option${selected ? " is-selected" : ""}" data-product-variant data-product-id="${Number(product.id)}" data-variant-id="${Number(item.variant.id)}" data-image-url="${esc(item.image?.public_url || fallbackImage)}" data-image-alt="${escText(item.image?.alt_raw || productImages[0]?.alt_raw || item.variant.name || product.name)}" data-gallery-images="${esc(JSON.stringify(item.images))}" data-price="${esc(item.variantPrice || rawPrice)}" data-old-price="${esc(item.variantOldPrice || oldPrice)}" data-currency="${esc(item.variant.currency || product.currency || "RUB")}" data-availability="${esc(item.variantAvailability || ({ in_stock: "В наличии", out_of_stock: "Отсутствует", preorder: "Предзаказ", unknown: "Наличие уточняется" })[item.variant.availability_status] || availability || stockLabel)}" data-stock-status="${esc(item.variant.availability_status || stockStatus)}" data-description="${esc(usefulDescription(item.variant.description) || productDescription)}" aria-pressed="${selected ? "true" : "false"}"><span class="seo-product-variant-name">${escText(item.colorLabel)}</span>${item.attributeText ? `<small>${escText(item.attributeText)}</small>` : ""}${item.variantPrice ? `<strong>${esc(item.variantPrice)}</strong>` : ""}</button>`;
  }).join("")}</div></section>` : "";
  const anyReservableVariant = variants.some((variant) => (variant.availability_status || stockStatus) !== "out_of_stock");
  const restockForm = stockStatus === "out_of_stock" && !anyReservableVariant ? `<section class="seo-restock-panel" aria-labelledby="restock-heading"><div><p class="seo-eyebrow">НЕТ В НАЛИЧИИ</p><h2 id="restock-heading">Уведомить о поступлении</h2><p>Оставьте e-mail или Telegram. Мы сообщим, когда товар снова появится.</p></div><form class="seo-restock-form" data-store-restock data-product-id="${Number(product.id)}" data-is-18-plus="${Number(product.is_18_plus) ? "1" : "0"}"><label><span>Ваше имя (необязательно)</span><input name="customer_name" maxlength="160" autocomplete="name"></label><label><span>E-mail</span><input name="email" type="email" maxlength="240" autocomplete="email" placeholder="name@example.ru"></label><label><span>Telegram username</span><input name="telegram_username" maxlength="64" placeholder="username без @"></label>${Number(product.is_18_plus) ? `<label class="reservation-consent reservation-wide"><input type="checkbox" name="age_confirmed" required><span>Подтверждаю, что мне исполнилось 18 лет</span></label>` : ""}<label class="reservation-consent reservation-wide"><input type="checkbox" name="pd_consent" required><span>Согласен(на) получить одно уведомление о поступлении и на обработку данных для этой цели. <a href="/page/privacy">Политика конфиденциальности</a>.</span></label><label class="reservation-honeypot" aria-hidden="true">Не заполняйте<input name="website" tabindex="-1" autocomplete="off"></label><button class="seo-reservation-submit" type="submit">Уведомить о поступлении</button><p class="seo-restock-feedback" role="status" aria-live="polite"></p></form></section>` : "";
  const reservationForm = Number(product.is_reservable ?? 1) !== 0 && (stockStatus !== "out_of_stock" || anyReservableVariant) ? `<section class="seo-reservation-panel" aria-labelledby="reservation-heading"><div class="seo-reservation-heading"><p class="seo-eyebrow">БРОНИРОВАНИЕ</p><h2 id="reservation-heading">Забронировать товар</h2><p>Оставьте запрос на резервирование. Это не покупка: оплата и доставка на сайте не оформляются.</p></div><form class="seo-reservation-form" data-store-reservation data-product-id="${Number(product.id)}" data-unit-price-minor="${hasCalculatedPrice ? unitPriceMinor : ""}" data-price-currency="${esc(priceCurrency)}"><input type="hidden" name="variant_id" data-selected-variant-id value="${Number(initialVariant?.id || 0) || ""}"><div class="seo-reservation-price${hasCalculatedPrice ? " is-calculated" : " is-pending"}" data-reservation-price-summary aria-live="polite"><div><span>Цена за 1 шт.</span><strong data-reservation-unit-price>${esc(unitPriceLabel)}</strong></div><div><span>Количество</span><strong data-reservation-quantity>1 шт.</strong></div><div class="reservation-total"><span>Итоговая стоимость</span><strong data-reservation-total>${esc(totalPriceLabel)}</strong></div><small data-reservation-price-note>${hasCalculatedPrice ? "Предварительный расчёт по цене, указанной в карточке. Итог подтвердит менеджер." : "В карточке нет однозначной цены или указано несколько вариантов. Сумму подтвердит менеджер."}</small></div><label><span>Ваше имя</span><input name="customer_name" required minlength="2" maxlength="160" autocomplete="name"></label><label><span>Телефон</span><input name="phone" required minlength="6" maxlength="80" autocomplete="tel" inputmode="tel"></label><label><span>E-mail (необязательно)</span><input name="email" type="email" maxlength="240" autocomplete="email"></label><label><span>Количество</span><input name="quantity" type="number" min="1" max="20" value="1" required data-reservation-quantity-input></label><label class="reservation-wide"><span>Комментарий</span><textarea name="message" rows="3" maxlength="1200" placeholder="Удобное время для связи и другие детали"></textarea></label>${Number(product.is_18_plus) ? `<label class="reservation-consent reservation-wide"><input type="checkbox" name="age_confirmed" required><span>Подтверждаю, что мне исполнилось 18 лет</span></label>` : ""}<label class="reservation-consent reservation-wide"><input type="checkbox" name="pd_consent" required><span>Согласен(на) на обработку персональных данных для ответа на запрос бронирования. <a href="/page/privacy">Политика конфиденциальности</a>.</span></label><label class="reservation-honeypot" aria-hidden="true">Не заполняйте<input name="website" tabindex="-1" autocomplete="off"></label><input type="hidden" name="source_path" value="/product/${esc(product.slug)}"><button class="seo-reservation-submit" type="submit" ${(initialVariantView?.variant.availability_status || stockStatus) === "out_of_stock" ? "disabled" : ""}>Отправить запрос на бронирование</button><p class="seo-reservation-feedback" role="status" aria-live="polite"></p></form></section>` : "";
  const categoryCrumbs = [];
  for (const category of relations) {
    if (category.parent_id) {
      const parent = await db.get("SELECT id,name FROM store_categories WHERE id=?", [category.parent_id]);
      const route = parent ? await db.get("SELECT p.slug,p.h1 FROM store_category_page_categories m JOIN store_category_pages p ON p.id=m.page_id WHERE m.category_id=? AND p.status='published' LIMIT 1", [parent.id]) : null;
      categoryCrumbs.push({ label: category.name, href: route ? `/${route.slug}` : `/${category.slug}` });
    } else {
      const route = await db.get("SELECT p.slug,p.h1 FROM store_category_page_categories m JOIN store_category_pages p ON p.id=m.page_id WHERE m.category_id=? AND p.status='published' LIMIT 1", [category.id]);
      if (route) categoryCrumbs.push({ label: route.h1, href: `/${route.slug}` });
    }
  }
  const uniqueCrumbs = categoryCrumbs.filter((item, index, rows) => rows.findIndex((row) => row.href === item.href) === index);
  const pricePanel = variantView.length || displayPrice || displayOldPrice || displayAvailability
    ? `<div class="seo-price-panel" data-product-price-panel><span>Цена</span><strong data-product-current-price>${esc(displayPrice || "Уточняется")}</strong>${displayOldPrice ? `<small data-product-old-price>Прежняя цена: ${esc(displayOldPrice)}</small>` : `<small data-product-old-price hidden></small>`}${displayAvailability ? `<small data-product-availability>${esc(displayAvailability)}</small>` : `<small data-product-availability hidden></small>`}</div>`
    : "";
  const body = `${siteHeader()}<main class="wrap seo-main seo-product-page">${breadcrumb([...uniqueCrumbs, { label: cleanDisplayText(product.name) }])}<div class="seo-product-detail">${imageGallery}<article class="seo-product-information"><p class="seo-eyebrow">${escText(product.brand || product.product_type || "VAPELAB")}</p><h1>${escText(h1)}</h1><div class="seo-product-meta">${product.product_type ? `<span>${escText(product.product_type)}</span>` : ""}${product.format ? `<span>${escText(product.format)}</span>` : ""}${product.sku ? `<span>Артикул: ${escText(product.sku)}</span>` : ""}</div>${variantRows}${pricePanel}<div class="seo-stock-state seo-stock-${initialVariantView?.variant.availability_status || stockStatus}" data-product-stock-state>${escText(initialVariantView?.variantAvailability || ({ in_stock: "В наличии", out_of_stock: "Отсутствует", preorder: "Предзаказ", unknown: "Наличие уточняется" })[initialVariantView?.variant.availability_status || stockStatus] || stockLabel)}</div><div class="seo-product-long-description" data-product-description>${escText(usefulDescription(initialVariantView?.variant.description) || productDescription).replace(/\n/g, "<br>")}</div>${specRows ? `<section class="seo-specifications"><h2>Характеристики</h2><dl>${specRows}</dl></section>` : ""}</article></div>${restockForm}${reservationForm}<p class="seo-catalog-note">Информационная карточка. Актуальные цену и наличие подтвердит менеджер VAPELAB.</p><section class="seo-recommendations" data-recommendations data-product-id="${Number(product.id)}"><div class="seo-section-heading"><div><p class="seo-eyebrow">ПОДБОРКА</p><h2>Похожие позиции</h2></div></div><div class="seo-recommendations-grid" aria-live="polite"><p class="seo-muted">Подбираем позиции по категориям и характеристикам…</p></div></section></main>${siteFooter("Карточки и категории информационного каталога VAPELAB.")}`;
  const canonical = canonicalFor(base, `/product/${product.slug}`, product.canonical_url);
  const indexable = Number(product.robots_index) !== 0;
  const document = htmlDocument({ title: product.seo_title || `${product.name} — VAPELAB`, description, canonical, robots: indexable ? "index, follow" : "noindex, nofollow", body, type: "product" });
  sendHtml(req, res, document, { noindex: !indexable });
}


async function renderSearchPage(req, res, base) {
  const url = new URL(req.url, base);
  const query = String(url.searchParams.get("q") || "").trim().slice(0, 120);
  const page = Math.max(1, Math.min(100000, Number(url.searchParams.get("page") || 1) || 1));
  const title = query ? `Поиск: ${query} — VAPELAB` : "Поиск товаров — VAPELAB";
  const description = query ? `Результаты поиска товаров VAPELAB по запросу «${query}».` : "Поиск товаров в информационном каталоге VAPELAB.";
  const body = `${siteHeader()}<main class="wrap seo-main seo-search-page"><div class="seo-page-heading"><p class="seo-eyebrow">КАТАЛОГ VAPELAB</p><h1>Поиск товаров</h1><p>${query ? `Результаты по запросу: <strong>${esc(query)}</strong>` : "Введите название, бренд или артикул в строке поиска выше."}</p></div><section id="vapelab-search-page" data-query="${esc(query)}" data-page="${page}" aria-live="polite"><p class="vapelab-search-page-summary">${query ? "Ищем подходящие товары…" : "Для начала поиска введите запрос длиной от двух символов."}</p><div class="vapelab-search-page-results seo-product-grid"></div><nav class="vapelab-search-page-pagination" aria-label="Страницы результатов поиска"></nav></section></main>${siteFooter("Поиск по опубликованным товарам каталога VAPELAB.")}`;
  sendHtml(req, res, htmlDocument({ title, description, canonical: `${base}/search`, robots: "noindex, follow", body }));
}

async function renderNews(req, res, item, base) {
  const title = `${item.title} — VAPELAB`;
  const description = excerpt(item.excerpt || item.body || item.title);
  const canonical = `${base}/news/${item.slug}`;
  const bodyHtml = safeNewsHtml(item.body_html || String(item.body || item.excerpt || "").split(/\n{2,}/).map((line) => `<p>${esc(line).replace(/\n/g, "<br>")}</p>`).join(""));
  const imageUrl = String(item.image_url || "");
  const showImage = !Number(item.is_18_plus) && !Number(item.image_hidden) && /^(https:\/\/|\/uploads\/news\/)/i.test(imageUrl);
  const relatedIds = [...new Set(parseJson(item.product_ids_json, []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 30);
  const relatedProducts = relatedIds.length ? await db.all(`SELECT id,name,slug FROM store_products WHERE status='published' AND id IN (${relatedIds.map(() => "?").join(",")}) ORDER BY name`, relatedIds) : [];
  const related = relatedProducts.length ? `<section class="seo-news-products"><h2>Товары, связанные с публикацией</h2><div>${relatedProducts.map((product) => `<a href="/product/${encodeURIComponent(product.slug)}">${esc(product.name)} ↗</a>`).join("")}</div></section>` : "";
  const body = `${siteHeader()}<main class="wrap seo-main">${breadcrumb([{ label: "Новости", href: "/#news" }, { label: item.title }])}<article class="seo-article"><p class="seo-eyebrow">VAPELAB · НОВОСТИ</p><h1>${esc(item.title)}</h1>${item.published_at ? `<time>${esc(item.published_at)}</time>` : ""}${showImage ? `<figure class="seo-news-image"><img src="${esc(imageUrl)}" alt="${esc(item.title)}" loading="lazy"></figure>` : ""}<div class="seo-news-content">${bodyHtml || `<p>${esc(item.excerpt || "")}</p>`}</div>${related}</article></main>${siteFooter("Новости и информация компании VAPELAB.")}`;
  sendHtml(req, res, htmlDocument({ title, description, canonical, body, type: "article" }));
}

async function renderInfoPage(req, res, item, base) {
  const isApproved = item.status === "published" && (item.slug === "optovy" || item.legal_review_status === "approved");
  const title = `${item.title} — VAPELAB`;
  const publicBody = isApproved ? String(item.body || "").trim() : "";
  const description = excerpt(publicBody || `${item.title}. Документ подготавливается администратором VAPELAB.`);
  const canonical = `${base}${item.slug === "optovy" ? "/optovy" : `/page/${item.slug}`}`;
  const paragraphs = publicBody
    ? publicBody.split(/\n{2,}/).map((line) => line.trim()).filter(Boolean).map((line) => `<p>${esc(line).replace(/\n/g, "<br>")}</p>`).join("")
    : `<p>Документ подготавливается администратором VAPELAB. Информация появится после заполнения и проверки.</p>`;
  const body = `${siteHeader()}<main class="wrap seo-main">${breadcrumb([{ label: item.title }])}<article class="seo-article"><p class="seo-eyebrow">VAPELAB · ИНФОРМАЦИЯ</p><h1>${esc(item.title)}</h1>${paragraphs}</article><section class="seo-recommendations" data-recommendations data-daily="1"><div class="seo-section-heading"><div><p class="seo-eyebrow">ПОДБОРКА</p><h2>Возможно, вас заинтересует</h2></div></div><div class="seo-recommendations-grid" aria-live="polite"></div></section></main>${siteFooter("Новости и информация компании VAPELAB.")}`;
  sendHtml(req, res, htmlDocument({ title, description, canonical, robots: isApproved && publicBody ? "index, follow" : "noindex, nofollow", body }), { noindex: !(isApproved && publicBody) });
}

export async function servePublicRoute(req, res, pathname, base) {
  // Public content routes must work even when PUBLIC_URL is not configured.
  // In that case canonical URLs remain path-relative instead of returning 404.
  base = base || "";
  const decoded = (() => { try { return decodeURIComponent(pathname); } catch { return ""; } })();
  if (!decoded || decoded.includes("\\") || decoded.includes("\0") || decoded.split("/").some((part) => part === ".." || part.startsWith("."))) return false;

  if (decoded === "/search" || decoded === "/search/") {
    await renderSearchPage(req, res, base);
    return true;
  }
  if (decoded === "/optovy" || decoded === "/optovy/") {
    const wholesale = await db.get("SELECT * FROM store_pages WHERE slug='optovy' AND status='published'");
    if (!wholesale) return false;
    await renderInfoPage(req, res, wholesale, base);
    return true;
  }

  let match = decoded.match(/^\/product\/([a-z0-9а-я-]+)\/?$/i);
  if (match) {
    const product = await db.get("SELECT * FROM store_products WHERE slug=? AND status='published'", [match[1]]);
    if (!product) return false;
    await renderProduct(req, res, product, base);
    return true;
  }
  match = decoded.match(/^\/news\/([a-z0-9а-я-]+)\/?$/i);
  if (match) {
    const news = await db.get("SELECT * FROM store_news WHERE slug=? AND status='published'", [match[1]]);
    if (!news) return false;
    await renderNews(req, res, news, base);
    return true;
  }
  match = decoded.match(/^\/page\/([a-z0-9а-я-]+)\/?$/i);
  if (match) {
    const page = await db.get("SELECT * FROM store_pages WHERE slug=? AND ((status='published' AND legal_review_status='approved') OR slug IN ('privacy','delivery'))", [match[1]]);
    if (!page) return false;
    await renderInfoPage(req, res, page, base);
    return true;
  }

  const categoryMatch = decoded.match(/^\/([a-z0-9а-я-]+)\/?$/i);
  if (!categoryMatch) return false;
  const slug = categoryMatch[1];
  const landing = await db.get("SELECT * FROM store_category_pages WHERE slug=? AND status='published'", [slug]);
  if (landing) {
    await renderCategoryLanding(req, res, landing, base);
    return true;
  }

  const category = await db.get("SELECT * FROM store_categories WHERE slug=? AND is_active=1", [slug]);
  if (!category) return false;
  const rootCategoryId = category.parent_id || category.id;
  const mapped = await db.get(
    "SELECT p.slug FROM store_category_page_categories m JOIN store_category_pages p ON p.id=m.page_id WHERE m.category_id=? AND p.status='published' ORDER BY p.sort_order LIMIT 1",
    [rootCategoryId],
  );
  if (!category.parent_id && mapped && mapped.slug !== slug) {
    res.writeHead(301, { Location: `/${mapped.slug}`, "Cache-Control": "public, max-age=3600" });
    return res.end();
  }
  await renderCategoryRecord(req, res, category, base);
  return true;
}

export async function buildSitemapXml(base) {
  if (!base) return null;
  const categoryPages = await db.all("SELECT p.slug,p.updated_at,p.canonical_url FROM store_category_pages p WHERE p.status='published' AND p.robots_index=1 AND EXISTS (SELECT 1 FROM store_product_categories pc JOIN store_products product ON product.id=pc.product_id WHERE pc.category_id IN (SELECT m.category_id FROM store_category_page_categories m WHERE m.page_id=p.id UNION SELECT child.id FROM store_categories child JOIN store_category_page_categories m ON child.parent_id=m.category_id WHERE m.page_id=p.id) AND product.status='published' AND product.robots_index=1) ORDER BY p.sort_order,p.slug");
  const childCategories = await db.all("SELECT c.id,c.slug,c.updated_at FROM store_categories c WHERE c.is_active=1 AND c.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM store_category_page_categories m WHERE m.category_id=c.id) AND EXISTS (SELECT 1 FROM store_product_categories pc JOIN store_products p ON p.id=pc.product_id WHERE pc.category_id=c.id AND p.status='published' AND p.robots_index=1) ORDER BY c.slug");
  const products = await db.all("SELECT slug,updated_at,canonical_url FROM store_products WHERE status='published' AND robots_index=1 ORDER BY slug");
  const news = await db.all("SELECT slug,updated_at,published_at FROM store_news WHERE status='published' ORDER BY slug");
  const pages = await db.all("SELECT slug,updated_at FROM store_pages WHERE status='published' AND (legal_review_status='approved' OR slug='optovy') ORDER BY slug");
  const entries = new Map();
  const add = (path, lastmod = "", override = "") => {
    const canonical = canonicalFor(base, path, override);
    let parsed;
    try { parsed = new URL(canonical); } catch { return; }
    const baseUrl = new URL(base);
    const expected = new URL(path, baseUrl);
    // A sitemap lists only same-origin URLs that are served at this route and are canonical.
    if (parsed.origin !== baseUrl.origin || parsed.search || parsed.hash || parsed.pathname.replace(/\/$/, "") !== expected.pathname.replace(/\/$/, "")) return;
    entries.set(canonical, { canonical, lastmod, path: parsed.pathname });
  };
  add("/");
  for (const row of categoryPages) add(`/${row.slug}`, row.updated_at, row.canonical_url);
  for (const row of childCategories) add(`/${row.slug}`, row.updated_at);
  for (const row of products) add(`/product/${row.slug}`, row.updated_at, row.canonical_url);
  for (const row of news) add(`/news/${row.slug}`, row.updated_at || row.published_at);
  for (const row of pages) add(`/page/${row.slug}`, row.updated_at);
  const sitemapEntries = [...entries.values()].sort((a, b) => a.canonical.localeCompare(b.canonical));
  const xmlEntries = sitemapEntries.map(({ canonical, lastmod }) => {
    const stamp = lastmod && /^\d{4}-\d{2}-\d{2}/.test(lastmod) ? `<lastmod>${esc(String(lastmod).slice(0, 10))}</lastmod>` : "";
    return `<url><loc>${esc(canonical)}</loc>${stamp}</url>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${xmlEntries}\n</urlset>\n`;
}
