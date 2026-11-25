import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vapelab-catalog-test-"));
process.env.DATA_DIR = dir;
process.env.SECRET_KEY = "test-catalog-secret";
process.env.ADMIN_EMAIL = "catalog-test@example.test";
const { createServer } = await import("../server/index.js");
const { db } = await import("../server/db.js");
const { signToken } = await import("../server/auth.js");
const { buildPreview, applyImport } = await import("../server/importer.js");
const server = await createServer();
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const admin = await db.get("SELECT * FROM users WHERE email=?", ["catalog-test@example.test"]);
const token = signToken({ uid: admin.id, role: admin.role });
after(async () => { await new Promise((resolve) => server.close(resolve)); await db.close(); await fs.rm(dir, { recursive: true, force: true }); });
async function call(url, method = "GET", body = undefined, extra = {}) {
  const r = await fetch(`${base}${url}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body && !Buffer.isBuffer(body) ? { "Content-Type": "application/json" } : {}), ...extra }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}
let productId, whiteId, blueId;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=", "base64");

test("варианты и фотографии доступны по ID и в публичном API", async () => {
  const product = await call("/api/store/products", "POST", { name: "Модель", sku: "MODEL-CHECK", slug: "model-check", status: "published", price_raw: "1000", availability_status: "in_stock" });
  assert.equal(product.status, 201); productId = product.data.id;
  const white = await call(`/api/store/products/${productId}/variants`, "POST", { name: "Белый", color: "Белый", sku: "W-CHECK", description: "Белый корпус", price_raw: "1200", availability_status: "in_stock" });
  const blue = await call(`/api/store/products/${productId}/variants`, "POST", { name: "Синий", color: "Синий", sku: "B-CHECK", description: "Синий корпус", availability_status: "out_of_stock" });
  assert.equal(white.status, 201); assert.equal(blue.status, 201); whiteId = white.data.id; blueId = blue.data.id;
  const image = await call(`/api/store/products/${productId}/images/upload`, "POST", png, { "X-File-Name": "white.png", "X-Variant-Id": String(whiteId) });
  assert.equal(image.status, 201);
  const saved = await fetch(`${base}${image.data.url_original}`); assert.equal(saved.status, 200); assert.deepEqual(Buffer.from(await saved.arrayBuffer()), png);
  const productRead = await call(`/api/store/products/${productId}`); assert.equal(productRead.data.variants.length, 2); assert.equal(productRead.data.variants[0].description, "Белый корпус");
  const publicRead = await call("/api/store/public"); assert.equal(publicRead.data.products.find((p) => p.id === productId).variants.length, 2);
  const bad = await call(`/api/store/products/${productId}`, "PUT", { variants: [] }); assert.equal(bad.status, 400);
  const html = await (await fetch(`${base}/product/model-check`)).text();
  assert.match(html, /data-selected-variant-id/); assert.match(html, /data-gallery-images/); assert.match(html, /Белый корпус/);
});

test("бронь сохраняет выбранный вариант и отклоняет отсутствующий", async () => {
  const body = { product_id: productId, variant_id: blueId, customer_name: "Тест Клиент", phone: "+79990000000", quantity: 2, pd_consent: true };
  const blocked = await call("/api/store/reservations", "POST", body); assert.equal(blocked.status, 409);
  const accepted = await call("/api/store/reservations", "POST", { ...body, variant_id: whiteId }); assert.equal(accepted.status, 201);
  const row = await db.get("SELECT * FROM store_reservations WHERE number=?", [accepted.data.number]);
  assert.equal(Number(row.variant_id), Number(whiteId)); assert.equal(Number(row.unit_price_minor), 120000); assert.equal(Number(row.total_price_minor), 240000);
});

test("пробный и повторный импорт не теряют публикацию и атрибуты", async () => {
  const rows = [["Новый импорт", "IMPORT-CHECK", "Красный", "R-CHECK", "Красный", "Описание красного"], ["Новый импорт", "IMPORT-CHECK", "Синий", "B2-CHECK", "Синий", "Описание синего"]];
  const mapping = { 0: "name", 1: "sku", 2: "variant_name", 3: "variant_sku", 4: "color", 5: "variant_description" };
  const preview = await applyImport({ entity: "products", rows, mapping, headers: ["a", "b", "c", "d", "e", "f"], dryRun: true });
  assert.equal(preview.created, 1); assert.equal(preview.updated, 1); assert.equal(await db.get("SELECT id FROM store_products WHERE sku=?", ["IMPORT-CHECK"]), null);
  const done = await applyImport({ entity: "products", rows, mapping, headers: ["a", "b", "c", "d", "e", "f"] }); assert.equal(done.created, 1); assert.equal(done.updated, 1);
  const product = await db.get("SELECT * FROM store_products WHERE sku=?", ["IMPORT-CHECK"]);
  await db.run("UPDATE store_products SET status='published' WHERE id=?", [product.id]);
  const again = await applyImport({ entity: "products", rows: [["Новый импорт", "IMPORT-CHECK", "Красный", "R-CHECK", "", ""]], mapping, headers: ["a", "b", "c", "d", "e", "f"] });
  assert.equal(again.skipped, 0);
  assert.equal((await db.get("SELECT status FROM store_products WHERE id=?", [product.id])).status, "published");
  const red = await db.get("SELECT * FROM store_product_variants WHERE product_id=? AND sku=?", [product.id, "R-CHECK"]);
  assert.equal(JSON.parse(red.attributes_json).color, "Красный"); assert.equal(red.description, "Описание красного");
  const template = await fs.readFile(new URL("../public/catalog-import-template.csv", import.meta.url));
  const mapped = buildPreview({ filename: "template.csv", buffer: template, entity: "products" });
  assert.equal(mapped.mapping[4], "status"); assert.equal(mapped.mapping[10], "variant_availability_status");
});

test("папка: предпросмотр, привязка, повтор и несуществующий вариант", async () => {
  const headers = { "X-File-Name": "photo.png", "X-File-Path": encodeURIComponent("images/MODEL-CHECK/B-CHECK/photo.png") };
  const preview = await call("/api/store/images/import", "POST", png, { ...headers, "X-Import-Preview": "1" });
  assert.equal(preview.data.status, "matched"); assert.equal(Number(preview.data.variant_id), Number(blueId));
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM store_product_images WHERE variant_id=?", [blueId])).n, 0);
  const saved = await call("/api/store/images/import", "POST", png, headers); assert.equal(saved.status, 201);
  const repeated = await call("/api/store/images/import", "POST", png, headers); assert.equal(repeated.data.status, "duplicate");
  const unknown = await call("/api/store/images/import", "POST", png, { ...headers, "X-File-Path": encodeURIComponent("images/MODEL-CHECK/НЕИЗВЕСТНЫЙ/photo.png") }); assert.equal(unknown.data.status, "unmatched_variant");
});

test("папка: ключевые слова сопоставляют вариант на глубокой вложенности, неоднозначные фото не привязываются", async () => {
  const productResponse = await call("/api/store/products", "POST", {
    name: "MOK FWRD", slug: "mok-fwrd-keyword-test", sku: "MOK-FWRD-KEYWORD-TEST", brand: "MOK FWRD",
  });
  assert.equal(productResponse.status, 201);
  const keywordProductId = productResponse.data.id;
  const bronze = await call(`/api/store/products/${keywordProductId}/variants`, "POST", {
    name: "Бронза — Сияющий янтарь", color: "Бронза", sku: "MOK-BRONZE-AMBER",
  });
  const ruby = await call(`/api/store/products/${keywordProductId}/variants`, "POST", {
    name: "Бронза — Рубиновый дым", color: "Бронза", sku: "MOK-BRONZE-RUBY",
  });
  assert.equal(bronze.status, 201); assert.equal(ruby.status, 201);

  const filename = "MOK FWRD Бронза - Сияющий янтарь__01__бронза.png";
  const headers = {
    "X-File-Name": encodeURIComponent(filename),
    "X-File-Path": encodeURIComponent(`incoming/партия 2026/MOK FWRD/серия янтарь/обработка/кадр 01/${filename}`),
  };
  const preview = await call("/api/store/images/import", "POST", png, { ...headers, "X-Import-Preview": "1" });
  assert.equal(preview.data.status, "matched");
  assert.equal(Number(preview.data.product_id), Number(keywordProductId));
  assert.equal(Number(preview.data.variant_id), Number(bronze.data.id));
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM store_product_images WHERE product_id=?", [keywordProductId])).n, 0, "предпросмотр не должен сохранять файл или запись");

  const saved = await call("/api/store/images/import", "POST", Buffer.concat([png, Buffer.from("keyword-image")]), headers);
  assert.equal(saved.status, 201);
  assert.equal(saved.data.status, "matched");
  assert.equal(saved.data.matched_by, "variant-keywords");
  const savedRow = await db.get("SELECT variant_id,original_filename,original_path FROM store_product_images WHERE id=?", [saved.data.image_id]);
  assert.equal(Number(savedRow.variant_id), Number(bronze.data.id));
  assert.equal(savedRow.original_filename, filename);
  assert.match(savedRow.original_path, /партия 2026\/MOK FWRD\/серия янтарь\/обработка\/кадр 01/);

  const unclearName = "MOK FWRD Бронза__02.png";
  const unclear = await call("/api/store/images/import", "POST", Buffer.concat([png, Buffer.from("ambiguous-keyword-image")]), {
    "X-File-Name": encodeURIComponent(unclearName),
    "X-File-Path": encodeURIComponent(`incoming/MOK FWRD/серия бронза/кадр 02/${unclearName}`),
  });
  assert.equal(unclear.data.status, "ambiguous_variant", "если одно ключевое слово подходит двум вариантам, выбор должен остаться ручным");

  const beforeUnmatched = await db.get("SELECT COUNT(*) AS n FROM store_product_images WHERE product_id=?", [keywordProductId]);
  const unmatchedName = "MOK FWRD неизвестный цвет.png";
  const unmatched = await call("/api/store/images/import", "POST", Buffer.concat([png, Buffer.from("unmatched-keyword-image")]), {
    "X-File-Name": encodeURIComponent(unmatchedName),
    "X-File-Path": encodeURIComponent(`incoming/MOK FWRD/неизвестный вариант/${unmatchedName}`),
  });
  assert.equal(unmatched.data.status, "unmatched_variant");
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM store_product_images WHERE product_id=?", [keywordProductId])).n, beforeUnmatched.n, "несопоставленное изображение не должно сохраняться на сервере");
});

test("ошибка строки откатывает товар и категорию, остальные строки сохраняются", async () => {
  const mapping = { 0: "name", 1: "sku", 2: "category_name", 3: "is_18_plus" };
  const rows = [["Ошибочный импорт", "BAD-IMPORT", "Ошибочная категория", "неизвестно"], ["Хороший импорт", "GOOD-IMPORT", "", "0"]];
  const stats = await applyImport({ entity: "products", rows, mapping, headers: ["a", "b", "c", "d"] });
  assert.equal(stats.skipped, 1); assert.equal(stats.created, 1);
  assert.equal(await db.get("SELECT id FROM store_products WHERE sku=?", ["BAD-IMPORT"]), null);
  assert.equal(await db.get("SELECT id FROM store_categories WHERE name=?", ["Ошибочная категория"]), null);
  assert.ok(await db.get("SELECT id FROM store_products WHERE sku=?", ["GOOD-IMPORT"]));
});
