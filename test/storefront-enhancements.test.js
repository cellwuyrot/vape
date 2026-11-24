import assert from "node:assert/strict";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import test, { after, before } from "node:test";

process.env.DATA_DIR = "./data-test-storefront-enhancements";
process.env.SECRET_KEY = "storefront-enhancements-test-secret";
process.env.ADMIN_EMAIL = "andycoulbot@gmail.com";
process.env.STORAGE_BACKEND = "local";
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.TELEGRAM_BOT_TOKEN = "test-telegram-token";
process.env.TELEGRAM_BOT_USERNAME = "vapelab_test_bot";

const { createServer } = await import("../server/index.js");
const { db, repo } = await import("../server/db.js");
const { signToken } = await import("../server/auth.js");

const server = await createServer();
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://localhost:${server.address().port}`;
const publicUploads = path.resolve("public/uploads/catalog");
const uploadedFiles = [];
let adminToken = "";
let paginationCategoryId = 0;
let currentProductId = 0;

const request = async (url, { method = "GET", token = adminToken, body, raw, headers = {} } = {}) => {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(body === undefined && raw === undefined ? {} : body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();
  return { status: response.status, headers: response.headers, data };
};

before(async () => {
  const admin = await db.get("SELECT * FROM users WHERE email=?", ["andycoulbot@gmail.com"]);
  adminToken = signToken({ uid: admin.id, role: admin.role });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
  for (const file of uploadedFiles) await fs.rm(file, { force: true }).catch(() => {});
  await fs.rm("./data-test-storefront-enhancements", { recursive: true, force: true });
});

test("политика и доставка не раскрывают черновой текст до публикации и проверки", async () => {
  const page = await db.get("SELECT * FROM store_pages WHERE slug='privacy'");
  assert.ok(page, "миграция должна создать черновик политики конфиденциальности");
  const privateMarker = "UNAPPROVED-PRIVACY-CONTENT-MUST-STAY-HIDDEN";
  await repo.update("store_pages", page.id, { body: privateMarker, status: "draft", legal_review_status: "pending" });

  const draft = await request("/page/privacy", { token: "" });
  assert.equal(draft.status, 200);
  assert.equal(draft.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.doesNotMatch(draft.data, new RegExp(privateMarker));
  assert.match(draft.data, /Документ подготавливается администратором VAPELAB/);

  await repo.update("store_pages", page.id, { status: "published", legal_review_status: "approved" });
  const approved = await request("/page/privacy", { token: "" });
  assert.equal(approved.status, 200);
  assert.equal(approved.headers.get("x-robots-tag"), "index, follow");
  assert.match(approved.data, new RegExp(privateMarker));
});

test("менеджер не может редактировать тексты сайта и юридические страницы", async () => {
  const manager = await repo.insert("users", {
    email: "storefront-manager@example.test",
    phone: "internal:storefront-manager",
    full_name: "Storefront Manager",
    password_hash: "",
    role: "manager",
    email_verified: 1,
    phone_verified: 1,
    is_active: 1,
    pd_consent_at: null,
  });
  const managerToken = signToken({ uid: manager.id, role: manager.role });

  const settings = await request("/api/store/settings", {
    method: "PUT", token: managerToken, body: { hero_eyebrow: "Не должно сохраниться" },
  });
  assert.equal(settings.status, 403);
  assert.match(settings.data.detail, /только администратор/i);

  const page = await db.get("SELECT * FROM store_pages WHERE slug='privacy'");
  const pageUpdate = await request(`/api/store/pages/${page.id}`, {
    method: "PUT", token: managerToken, body: { body: "Менеджер не должен менять юридический текст" },
  });
  assert.equal(pageUpdate.status, 403);
});

test("категория открывает карточки с пагинацией, а карточка товара имеет отдельный URL", async () => {
  const category = await repo.insert("store_categories", {
    name: "Тестовая категория с пагинацией",
    slug: "test-pagination-category",
    description: "Проверка отдельной страницы категории",
    sort_order: 999,
    is_active: 1,
  });
  paginationCategoryId = category.id;
  const products = [];
  for (let index = 1; index <= 25; index += 1) {
    const slug = `test-pagination-product-${String(index).padStart(2, "0")}`;
    const product = await repo.insert("store_products", {
      name: `Тестовая позиция ${index}`,
      slug,
      sku: `TEST-PAG-${String(index).padStart(2, "0")}`,
      brand: "VAPELAB Test",
      product_type: "Тест",
      description: "Проверка пагинации категории",
      status: "published",
    });
    products.push(product);
    await db.run("INSERT INTO store_product_categories(product_id,category_id) VALUES(?,?)", [product.id, category.id]);
  }
  currentProductId = products[0].id;

  const adminPageOne = await request(`/api/store/admin?page=1&page_size=10&category_id=${category.id}`);
  const adminPageTwo = await request(`/api/store/admin?page=2&page_size=10&category_id=${category.id}`);
  assert.equal(adminPageOne.status, 200);
  assert.equal(adminPageTwo.status, 200);
  assert.equal(adminPageOne.data.product_pagination.total, 25);
  assert.equal(adminPageOne.data.product_pagination.total_pages, 3);
  assert.equal(adminPageOne.data.products.length, 10);
  assert.equal(adminPageTwo.data.products.length, 10);
  assert.notEqual(adminPageOne.data.products[0].id, adminPageTwo.data.products[0].id);

  const firstPage = await request("/test-pagination-category?page=1", { token: "" });
  const secondPage = await request("/test-pagination-category?page=2", { token: "" });
  assert.equal(firstPage.status, 200);
  assert.equal(secondPage.status, 200);
  assert.match(secondPage.data, /seo-pagination/);
  const firstPageSlugs = [...firstPage.data.matchAll(/href="\/product\/([^"]+)"/g)].map((match) => match[1]);
  const secondPageSlugs = [...secondPage.data.matchAll(/href="\/product\/([^"]+)"/g)].map((match) => match[1]);
  assert.equal(firstPageSlugs.length, 24);
  assert.equal(secondPageSlugs.length, 1);
  assert.ok(!firstPageSlugs.includes(secondPageSlugs[0]), "страницы должны содержать разные товары");
  assert.match(firstPage.data, /\/product\/test-pagination-product-01/);

  const detail = await request("/product/test-pagination-product-01", { token: "" });
  assert.equal(detail.status, 200);
  assert.match(detail.data, /Тестовая позиция 1/);

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=", "base64");
  const uploaded = await request(`/api/store/products/${currentProductId}/images/upload`, {
    method: "POST", raw: png, headers: { "Content-Type": "image/png", "X-File-Name": "featured.png" },
  });
  assert.equal(uploaded.status, 201);
  assert.match(uploaded.data.url_original, /^\/uploads\/catalog\//);
  uploadedFiles.push(path.join(publicUploads, path.basename(uploaded.data.url_original)));

  const categoryUpdate = await request(`/api/store/categories/${paginationCategoryId}`, {
    method: "PUT", body: { featured_product_id: currentProductId },
  });
  assert.equal(categoryUpdate.status, 200);
  assert.equal(Number(categoryUpdate.data.featured_product_id), currentProductId);
  const publicCatalog = await request("/api/store/public", { token: "" });
  const featuredCategory = publicCatalog.data.categories.find((item) => Number(item.id) === paginationCategoryId);
  assert.equal(featuredCategory.featured_product.id, currentProductId);
  assert.equal(featuredCategory.featured_product.name, "Тестовая позиция 1");
  assert.match(featuredCategory.featured_product.image_url, /^\/uploads\/catalog\//);
});


test("админский каталог выдаёт товары постранично и умный поиск ищет по SKU", async () => {
  assert.ok(paginationCategoryId > 0 && currentProductId > 0);
  const first = await request(`/api/store/admin?page=1&page_size=10&category_id=${paginationCategoryId}`);
  const second = await request(`/api/store/admin?page=2&page_size=10&category_id=${paginationCategoryId}`);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.data.product_pagination.total, 25);
  assert.equal(first.data.product_pagination.total_pages, 3);
  assert.equal(first.data.products.length, 10);
  assert.equal(second.data.products.length, 10);
  assert.notEqual(first.data.products[0].id, second.data.products[0].id);

  const search = await request("/api/store/smart-search?q=TEST-PAG-01");
  assert.equal(search.status, 200);
  assert.ok(search.data.results.some((item) => item.id === currentProductId));

  const publicSearch = await request("/api/store/search?q=TEST-PAG-01", { token: "" });
  assert.equal(publicSearch.status, 200);
  assert.ok(publicSearch.data.results.some((item) => item.id === currentProductId));
  assert.equal(publicSearch.data.results[0].slug, "test-pagination-product-01");

  const publicPageOne = await request("/api/store/search?q=TEST-PAG&page=1&page_size=12", { token: "" });
  const publicPageTwo = await request("/api/store/search?q=TEST-PAG&page=2&page_size=12", { token: "" });
  assert.equal(publicPageOne.data.total, 25);
  assert.equal(publicPageOne.data.total_pages, 3);
  assert.equal(publicPageOne.data.results.length, 12);
  assert.equal(publicPageTwo.data.results.length, 12);
  assert.notEqual(publicPageOne.data.results[0].id, publicPageTwo.data.results[0].id);

  const searchPage = await request("/search?q=TEST-PAG", { token: "" });
  assert.equal(searchPage.status, 200);
  assert.match(searchPage.data, /id="vapelab-search-page"/);
  assert.match(searchPage.data, /customer-tools\.js/);
});

test("варианты товара сохраняют отдельные фотографии и переключают главное изображение на витрине", async () => {
  assert.ok(currentProductId > 0);
  await repo.update("store_products", currentProductId, {
    name: "Glo Air 2 — тест вариантов",
    description: "**G&#x20;**Изображение не предоставлено",
    price_raw: "1 000 ₽",
    status: "published",
  });
  const created = await request(`/api/store/products/${currentProductId}/variants`, {
    method: "POST", body: { name: "Graphite Black", color: "Graphite Black", sku: "TEST-GLO-AIR2-BLACK", price_raw: "1 000 ₽", attributes: { "Совместимость": "Glo Air 2" }, sort_order: 1 },
  });
  assert.equal(created.status, 201);
  const variantId = created.data.id;
  assert.equal(JSON.parse(created.data.attributes_json).color, "Graphite Black");
  assert.equal(JSON.parse(created.data.attributes_json)["Совместимость"], "Glo Air 2");

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=", "base64");
  const uploaded = await request(`/api/store/products/${currentProductId}/images/upload`, {
    method: "POST", raw: png, headers: { "Content-Type": "image/png", "X-File-Name": "glo-air2-graphite.png", "X-Variant-Id": String(variantId) },
  });
  assert.equal(uploaded.status, 201);
  assert.equal(Number(uploaded.data.variant_id), Number(variantId));
  uploadedFiles.push(path.join(publicUploads, path.basename(uploaded.data.url_original)));

  const admin = await request(`/api/store/admin?q=${encodeURIComponent("TEST-PAG-01")}&page=1&page_size=10`);
  assert.equal(admin.status, 200);
  const product = admin.data.products.find((item) => Number(item.id) === Number(currentProductId));
  assert.ok(product);
  const variant = product.variants.find((item) => Number(item.id) === Number(variantId));
  assert.ok(variant);
  assert.equal(variant.images.length, 1);
  assert.equal(Number(variant.images[0].id), Number(uploaded.data.id));
  assert.equal(Number(product.images.find((item) => Number(item.id) === Number(uploaded.data.id)).variant_id), Number(variantId));

  const detail = await request("/product/test-pagination-product-01", { token: "" });
  assert.equal(detail.status, 200);
  assert.match(detail.data, /product-variants\.js/);
  assert.match(detail.data, new RegExp(`data-product-variant[^>]*data-variant-id="${variantId}"`));
  assert.match(detail.data, new RegExp(`data-image-url="${uploaded.data.url_original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.doesNotMatch(detail.data, /G&amp;#x20;|G&#x20;|\*\*Изображение не предоставлено\*\*/);
  assert.match(detail.data, /data-product-gallery-placeholder/);

  const folderImage = await request("/api/store/images/import", {
    method: "POST", raw: png, headers: {
      "Content-Type": "image/png", "X-File-Name": "01-main.png",
      "X-File-Path": encodeURIComponent("images/test-pagination-product-01/Graphite Black/01-main.png"),
    },
  });
  assert.equal(folderImage.status, 201);
  assert.equal(folderImage.data.status, "matched");
  assert.equal(Number(folderImage.data.variant_id), Number(variantId));
  uploadedFiles.push(path.join(publicUploads, path.basename(folderImage.data.url)));

  const reassigned = await request(`/api/store/products/${currentProductId}/images/${uploaded.data.id}`, {
    method: "PUT", body: { variant_id: null, alt: "Общее фото Glo Air 2", position: 0 },
  });
  assert.equal(reassigned.status, 200);
  assert.equal(reassigned.data.variant_id, null);

  const deleted = await request(`/api/store/products/${currentProductId}/variants/${variantId}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  const retained = await db.get("SELECT variant_id FROM store_product_images WHERE id=?", [uploaded.data.id]);
  assert.equal(retained.variant_id, null);
});

test("карточка товара показывает цену за штуку и содержит область пересчёта суммы", async () => {
  assert.ok(currentProductId > 0);
  await repo.update("store_products", currentProductId, { price_raw: "2 000 ₽", currency: "RUB", description: "Проверенная информация о товаре" });
  const detail = await request("/product/test-pagination-product-01", { token: "" });
  assert.equal(detail.status, 200);
  assert.match(detail.data, /data-unit-price-minor="200000"/);
  assert.match(detail.data, /data-reservation-total/);
  assert.match(detail.data, /2(?:\s|&nbsp;| )000(?:\s|&nbsp;| )₽/);
});

test("карточка товара скрывает текстовые заглушки цены/описания и некорректные изображения", async () => {
  assert.ok(currentProductId > 0);
  await repo.update("store_products", currentProductId, {
    description: "Отдельное описание в доступном источнике не обнаружено",
    price_raw: "Не указана",
  });
  await repo.insert("store_product_images", {
    product_id: currentProductId,
    url_original: "javascript:alert(1)",
    alt_raw: "Некорректная тестовая ссылка",
    position: 0,
  });
  const detail = await request("/product/test-pagination-product-01", { token: "" });
  assert.equal(detail.status, 200);
  assert.doesNotMatch(detail.data, /Отдельное описание в доступном источнике не обнаружено/i);
  assert.doesNotMatch(detail.data, /seo-price-panel/);
  assert.match(detail.data, /\/uploads\/catalog\/[a-f0-9]+\.png/);
  assert.doesNotMatch(detail.data, /javascript:alert\(1\)/i);
});

test("бронирование товара создаёт запись, применяет возрастную проверку и доступно в CRM", async () => {
  await repo.update("store_products", currentProductId, { is_18_plus: 1, is_reservable: 1, status: "published", price_raw: "2 000 ₽", currency: "RUB" });
  const body = { product_id: currentProductId, customer_name: "Тестовый покупатель", phone: "+79990000000", email: "buyer@example.test", quantity: 5, pd_consent: true, source_path: "/product/test-pagination-product-01" };
  const underageMissing = await request("/api/store/reservations", { method: "POST", token: "", body });
  assert.equal(underageMissing.status, 400);
  assert.match(underageMissing.data.detail, /18 лет/);

  const created = await request("/api/store/reservations", { method: "POST", token: "", body: { ...body, age_confirmed: true } });
  assert.equal(created.status, 201);
  assert.match(created.data.number, /^VPL-/);
  const stored = await db.get("SELECT * FROM store_reservations WHERE number=?", [created.data.number]);
  assert.equal(stored.product_id, currentProductId);
  assert.equal(stored.quantity, 5);
  assert.equal(stored.is_18_plus, 1);
  assert.equal(stored.age_confirmed, 1);
  assert.equal(stored.unit_price_minor, 200000);
  assert.equal(stored.total_price_minor, 1000000);
  assert.equal(stored.price_currency, "RUB");
  assert.equal(stored.price_calculated, 1);
  assert.equal(created.data.price.total_price_minor, 1000000);
  assert.equal(stored.email_notified, 0, "локальная запись notify.dev не считается фактической отправкой письма");
  const retry = await request(`/api/store/reservations/${stored.id}/notify`, { method: "POST", body: {} });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.email_notified, false);

  const adminList = await request("/api/store/reservations?page=1&page_size=10");
  assert.equal(adminList.status, 200);
  assert.ok(adminList.data.reservations.some((item) => item.number === created.data.number));
  const changed = await request(`/api/store/reservations/${stored.id}`, { method: "PATCH", body: { status: "confirmed", manager_note: "Связаться с покупателем" } });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.status, "confirmed");

  await repo.update("store_products", currentProductId, { price_raw: "24 000 ₽ / 17 700 ₽" });
  const ambiguous = await request("/api/store/reservations", { method: "POST", token: "", body: { ...body, age_confirmed: true, quantity: 3 } });
  assert.equal(ambiguous.status, 201);
  const ambiguousStored = await db.get("SELECT * FROM store_reservations WHERE number=?", [ambiguous.data.number]);
  assert.equal(ambiguousStored.price_calculated, 0);
  assert.equal(ambiguousStored.total_price_minor, 0);
  assert.equal(ambiguousStored.price_raw_snapshot, "24 000 ₽ / 17 700 ₽");
  assert.equal(ambiguous.data.price.total_price_minor, null);
});

test("аналитика принимает анонимные события и показывает уникальных посетителей администратору", async () => {
  const visitorId = "visitor_test_000001";
  const sessionId = "session_test_000001";
  const pageView = await request("/api/analytics/event", { method: "POST", token: "", body: { visitor_id: visitorId, session_id: sessionId, event_type: "page_view", path: "/product/test-pagination-product-01", page_title: "Тестовый товар" } });
  const click = await request("/api/analytics/event", { method: "POST", token: "", body: { visitor_id: visitorId, session_id: sessionId, event_type: "click", path: "/product/test-pagination-product-01", target_tag: "A", target_text: "Каталог", target_path: "/#categories" } });
  assert.equal(pageView.status, 200);
  assert.equal(click.status, 200);
  const summary = await request("/api/analytics/summary?days=30");
  assert.equal(summary.status, 200);
  assert.ok(summary.data.totals.unique_visitors >= 1);
  assert.ok(summary.data.totals.page_views >= 1);
  assert.ok(summary.data.totals.clicks >= 1);
  const events = await request("/api/analytics/events?page=1&page_size=10");
  assert.equal(events.status, 200);
  assert.ok(events.data.events.some((item) => item.visitor_id === undefined && item.path === "/product/test-pagination-product-01"));
});


test("новости через Google используют Interactions API, принимают steps и возвращают источники", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("https://generativelanguage.googleapis.com/v1beta/interactions")) {
      assert.equal(init.headers["x-goog-api-key"], "test-gemini-key");
      const body = JSON.parse(init.body);
      assert.equal(body.model, "gemini-3.8-flash");
      assert.ok(body.tools.some((tool) => tool.type === "google_search"));
      return new Response(JSON.stringify({
        steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({ title: "Проверенная новость", excerpt: "Краткое описание", body_html: "<p>Фактический черновик</p>" }), annotations: [{ type: "url_citation", title: "Источник", url: "https://example.test/source" }] }] }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return originalFetch(input, init);
  };
  try {
    const generated = await request("/api/store/news/generate", { method: "POST", body: { prompt: "Подготовь обзор проверенного отраслевого события" } });
    assert.equal(generated.status, 200);
    assert.equal(generated.data.title, "Проверенная новость");
    assert.equal(generated.data.status, "draft");
    assert.equal(generated.data.requires_review, true);
    assert.deepEqual(generated.data.sources, ["https://example.test/source"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("рекомендации отбирают опубликованные товары из просмотренной категории", async () => {
  assert.ok(paginationCategoryId > 0 && currentProductId > 0);
  const response = await request(`/api/store/recommendations?product_id=${currentProductId}`, { token: "" });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.data));
  assert.ok(response.data.length > 0);
  assert.ok(response.data.every((item) => item.id !== currentProductId));
  assert.ok(response.data.every((item) => item.slug.startsWith("test-pagination-product-")));

  const fromPageContext = await request("/api/store/recommendations?context=VAPELAB%20Test%20%D0%A2%D0%B5%D1%81%D1%82", { token: "" });
  assert.equal(fromPageContext.status, 200);
  assert.ok(Array.isArray(fromPageContext.data));
  assert.ok(fromPageContext.data.length > 0, "текст посещённой страницы должен влиять на подборку даже без product_id");
});

test("папочный импорт сопоставляет фотографию по точному slug и проверяет формат файла", async () => {
  const filename = "test-pagination-product-01.png";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=", "base64");
  const response = await request("/api/store/images/import", {
    method: "POST",
    raw: png,
    headers: { "Content-Type": "image/png", "X-File-Name": encodeURIComponent(filename) },
  });
  assert.equal(response.status, 201);
  assert.equal(response.data.status, "matched");
  assert.equal(response.data.product_id, currentProductId);
  const stored = await db.get("SELECT * FROM store_product_images WHERE id=?", [response.data.image_id]);
  assert.equal(stored.url_original, response.data.url);
  uploadedFiles.push(path.join(publicUploads, path.basename(stored.url_original)));
});


test("папочный импорт сопоставляет изображение по имени каталога товара", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=", "base64");
  const response = await request("/api/store/images/import", {
    method: "POST", raw: png, headers: {
      "Content-Type": "image/png",
      "X-File-Name": encodeURIComponent("01-main.png"),
      "X-File-Path": encodeURIComponent("images/test-pagination-product-01/01-main.png"),
    },
  });
  assert.equal(response.status, 201);
  assert.equal(response.data.status, "matched");
  assert.equal(response.data.matched_by, "folder");
  assert.equal(response.data.product_id, currentProductId);
  const stored = await db.get("SELECT * FROM store_product_images WHERE id=?", [response.data.image_id]);
  uploadedFiles.push(path.join(publicUploads, path.basename(stored.url_original)));
});


test("массовое управление меняет публикацию и отклоняет выбор более 100 товаров", async () => {
  const first = await repo.insert("store_products", { name: "Массовый тест 1", slug: "bulk-test-1", status: "draft", availability_status: "unknown" });
  const second = await repo.insert("store_products", { name: "Массовый тест 2", slug: "bulk-test-2", status: "draft", availability_status: "unknown" });
  const updated = await request("/api/store/products/bulk", { method: "POST", body: { ids: [first.id, second.id], action: "publish" } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.affected, 2);
  assert.equal((await db.get("SELECT status FROM store_products WHERE id=?", [first.id])).status, "published");
  assert.equal((await db.get("SELECT status FROM store_products WHERE id=?", [second.id])).status, "published");
  const tooMany = await request("/api/store/products/bulk", { method: "POST", body: { ids: Array.from({ length: 101 }, (_, index) => index + 100000), action: "draft" } });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.detail, /не более 100/);
});

test("ежедневная общая подборка не включает товары 18+", async () => {
  const safe = await repo.insert("store_products", { name: "Подборка без возрастного ограничения", slug: "daily-safe-test", status: "published", is_18_plus: 0 });
  const adult = await repo.insert("store_products", { name: "Возрастная тестовая позиция", slug: "daily-adult-test", status: "published", is_18_plus: 1 });
  const response = await request("/api/store/recommendations/daily", { token: "" });
  assert.equal(response.status, 200);
  assert.ok(!response.data.products.some((item) => item.id === adult.id));
  assert.ok(response.data.products.length <= 8);
});

test("повторное Telegram-уведомление отправляется для связанной подписки при наличии товара", async () => {
  const subscription = await repo.insert("store_restock_subscriptions", {
    product_id: currentProductId, product_name: "Тестовая позиция 1", product_slug: "test-pagination-product-01",
    customer_name: "Покупатель Telegram", email: "", telegram_username: "buyer_test", telegram_chat_id: "998877",
    telegram_link_token_hash: "", telegram_link_expires: "", pd_consent_at: new Date().toISOString(),
    status: "active", email_notified: 0, telegram_notified: 0,
  });
  await repo.update("store_products", currentProductId, { availability_status: "in_stock" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => String(input).includes("api.telegram.org")
    ? new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }), { status: 200, headers: { "Content-Type": "application/json" } })
    : originalFetch(input, init);
  try {
    const response = await request(`/api/store/restock-subscriptions/${subscription.id}/notify`, { method: "POST", body: {} });
    assert.equal(response.status, 200);
    assert.equal(response.data.telegram_notified, true);
    assert.equal(response.data.status, "notified");
    const stored = await db.get("SELECT * FROM store_restock_subscriptions WHERE id=?", [subscription.id]);
    assert.equal(stored.telegram_chat_id, "998877");
    assert.equal(stored.telegram_notified, 1);
    assert.equal(stored.status, "notified");
  } finally { globalThis.fetch = originalFetch; }
});

test("оптовая страница доступна после публикации администратором", async () => {
  const page = await db.get("SELECT * FROM store_pages WHERE slug='optovy'");
  assert.ok(page);
  await repo.update("store_pages", page.id, { title: "Оптовое направление VAPELAB", body: "Условия оптового сотрудничества и заявка для партнёров.", status: "published", legal_review_status: "approved" });
  const response = await request("/optovy", { token: "" });
  assert.equal(response.status, 200);
  assert.match(response.data, /Условия оптового сотрудничества/);
});
