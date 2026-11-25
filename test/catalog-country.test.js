import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test, { after } from "node:test";
import { countryFromName, variantCountry } from "../server/catalog-country.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vapelab-catalog-test-"));
process.env.DATA_DIR = dir;
process.env.DATABASE_URL = "";
process.env.SECRET_KEY = "test-secret";
const { guessMapping, applyImport } = await import("../server/importer.js");
const { createServer } = await import("../server/index.js");
const { db } = await import("../server/db.js");
const server = await createServer();
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise((resolve) => server.close(resolve)); await db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("страна только из явного суффикса или атрибута", () => {
  assert.deepEqual(countryFromName("Amber — Казахстан"), { country: "Казахстан", base: "Amber" });
  assert.deepEqual(countryFromName("Модель (Япония)"), { country: "Япония", base: "Модель" });
  assert.equal(countryFromName("Японский микс"), null);
  assert.equal(variantCountry({ name: "Amber — Казахстан", attributes_json: '{"country":"Япония"}' }), "Япония");
});

test("опубликованный товар индексируется, архив недоступен и отсутствует в sitemap", async () => {
  await db.run("INSERT INTO store_products(name,slug,status,robots_index) VALUES(?,?,?,?)", ["SEO тест", "ci-seo-country", "published", 0]);
  const row = await db.get("SELECT id FROM store_products WHERE slug=?", ["ci-seo-country"]);
  for (let i = 0; i < 25; i++) await db.run("INSERT INTO store_product_variants(product_id,name,sku,attributes_json,price_raw) VALUES(?,?,?,?,?)", [row.id, `Модель ${i} — Казахстан`, `v-${i}`, "{}", "100 ₽"]);
  let response = await fetch(`${base}/product/ci-seo-country`);
  assert.equal(response.status, 200); assert.equal(response.headers.get("x-robots-tag"), "index, follow");
  const html = await response.text(); assert.match(html, /data-variant-country/); assert.match(html, /data-country="Казахстан"/); assert.equal((html.match(/data-product-variant /g) || []).length, 25);
  let sitemap = await (await fetch(`${base}/sitemap.xml`)).text(); assert.match(sitemap, /ci-seo-country/);
  await db.run("UPDATE store_products SET status='archived' WHERE id=?", [row.id]);
  response = await fetch(`${base}/product/ci-seo-country`, { headers: { Accept: "text/html" } }); assert.equal(response.status, 404); assert.match(response.headers.get("x-robots-tag"), /noindex/);
  sitemap = await (await fetch(`${base}/sitemap.xml`)).text(); assert.doesNotMatch(sitemap, /ci-seo-country/);
});

test("отчёт не меняет данные, apply сохраняет ID и не затирает конфликты", async () => {
  await db.run("INSERT INTO store_products(name,slug,status) VALUES(?,?,?)", ["Тест — Япония", "ci-country-review", "published"]);
  const product = await db.get("SELECT id FROM store_products WHERE slug=?", ["ci-country-review"]);
  await db.run("INSERT INTO store_product_variants(product_id,name,sku,attributes_json) VALUES(?,?,?,?)", [product.id, "Первый — Япония", "first", '{"color":"green"}']);
  await db.run("INSERT INTO store_product_variants(product_id,name,sku,attributes_json) VALUES(?,?,?,?)", [product.id, "Второй — Япония", "second", '{"country":"Казахстан"}']);
  const before = await db.all("SELECT * FROM store_product_variants WHERE product_id=? ORDER BY id", [product.id]);
  const env = { ...process.env, DATA_DIR: dir, DATABASE_URL: "" };
  const preview = path.join(dir, "preview.json"); const applied = path.join(dir, "apply.json");
  execFileSync(process.execPath, ["scripts/catalog-country-review.js", `--report=${preview}`], { env });
  assert.deepEqual(await db.all("SELECT * FROM store_product_variants WHERE product_id=? ORDER BY id", [product.id]), before);
  const report = JSON.parse(fs.readFileSync(preview, "utf8")); assert.ok(report.product_candidates.flat().some((p) => p.id === product.id)); assert.ok(report.warnings.some((v) => v.variant_id === before[1].id));
  execFileSync(process.execPath, ["scripts/catalog-country-review.js", `--report=${applied}`, "--apply"], { env });
  const afterRows = await db.all("SELECT * FROM store_product_variants WHERE product_id=? ORDER BY id", [product.id]);
  assert.equal(afterRows[0].id, before[0].id); assert.deepEqual(JSON.parse(afterRows[0].attributes_json), { color: "green", country: "Япония" });
  assert.equal(afterRows[1].attributes_json, before[1].attributes_json);
});

test("импорт отдельной страны сохраняет атрибут варианта", async () => {
  const headers = ["Название товара", "Название варианта", "Артикул варианта", "Страна варианта"];
  const mapping = guessMapping(headers, "products");
  assert.equal(mapping[3], "country");
  const result = await applyImport({ entity: "products", headers, mapping, rows: [["Тест импорта страны", "Test", "TEST-COUNTRY-1", "Япония"]], userId: 1 });
  assert.equal(result.errors.length, 0);
  const variant = await db.get("SELECT attributes_json FROM store_product_variants WHERE sku=?", ["TEST-COUNTRY-1"]);
  assert.equal(JSON.parse(variant.attributes_json).country, "Япония");
});
