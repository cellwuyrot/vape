import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { searchScore } from "../server/catalog-search.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vapelab-directory-test-"));
process.env.DATA_DIR = dir;
process.env.SECRET_KEY = "directory-test-secret";
process.env.ADMIN_EMAIL = "directory-test@example.test";
const { createServer } = await import("../server/index.js");
const { db, repo } = await import("../server/db.js");
const server = await createServer();
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise((resolve) => server.close(resolve)); await db.close(); await fs.rm(dir, { recursive:true, force:true }); });

const root = await repo.insert("store_categories", { name:"Тестовые устройства", slug:"directory-device-test", is_active:1 });
for (let i = 0; i < 66; i++) await repo.insert("store_categories", { parent_id:root.id, name:`Бренд ${String(i).padStart(2,"0")}`, slug:`dir-brand-${i}`, is_active:1 });
const atom = await repo.insert("store_categories", { parent_id:root.id, name:"ATOM", slug:"directory-atom", is_active:1 });
const other = await repo.insert("store_categories", { name:"Другое направление", slug:"directory-other", is_active:1 });
await repo.insert("store_categories", { name:"Секретная выключенная категория", slug:"directory-hidden", is_active:0 });
const product = await repo.insert("store_products", { name:"MOK FWRD", slug:"directory-mok", brand:"MOK", sku:"MK-0001", status:"published" });
await db.run("INSERT INTO store_product_categories(product_id,category_id) VALUES(?,?)", [product.id, atom.id]);
await repo.insert("store_product_variants", { product_id:product.id, name:"Синий Ocean", sku:"OCEAN-777", attributes_json:'{"color":"Синий"}' });
const draft = await repo.insert("store_products", { name:"MOK секретный черновик", slug:"directory-draft", status:"draft" });
await db.run("INSERT INTO store_product_categories(product_id,category_id) VALUES(?,?)", [draft.id, atom.id]);
async function json(url) { const r = await fetch(base + url); assert.equal(r.status,200); const data = await r.json(); return data.data || data; }
async function html(url) { const r = await fetch(base + url); assert.equal(r.status,200); return r.text(); }

test("сопоставление учитывает все слова, транслитерацию и допустимую опечатку", () => {
  assert.ok(searchScore("мок", ["MOK FWRD"]) > 0);
  assert.ok(searchScore("ocean", ["Ocean Blue"]) > searchScore("ocen", ["Ocean Blue"]));
  assert.equal(searchScore("MOK несуществующее", ["MOK FWRD"]), 0);
  assert.equal(searchScore("LOAD-10019", ["LOAD-10010"]), 0);
});

test("каталог отображает 66+ подразделов, сортировку и серверные фильтры", async () => {
  const page = await html(`/catalog/categories?group=${root.id}&letter=A`);
  assert.match(page, /Категории и бренды/);
  assert.match(page, /href="\/directory-atom"/);
  assert.match(page, /data-name="ATOM" data-letter="A"/);
  assert.match(page, /data-name="Бренд 00" data-letter="Б" hidden/);
  assert.doesNotMatch(page, /Секретная выключенная категория/);
  assert.equal((page.match(/data-catalog-item/g) || []).length >= 68, true);
  const filtered = await html(`/catalog/categories?group=${root.id}&q=Бренд%2001`);
  assert.match(filtered, /data-name="Бренд 01" data-letter="Б"><a/);
  assert.match(filtered, /data-name="Бренд 02" data-letter="Б" hidden/);
  const escaped = await html('/catalog/categories?q=%3Cscript%3E');
  assert.doesNotMatch(escaped, /<script>alert/);
  assert.match(escaped, /&lt;script&gt;/);
});

test("подсказки содержат активные категории и опубликованные товары", async () => {
  const byCategory = await json("/api/store/search?q=ATOM");
  assert.ok(byCategory.category_results.some((x) => x.id === atom.id && x.slug === "directory-atom"));
  assert.ok(byCategory.results.some((x) => x.id === product.id));
  const byVariant = await json("/api/store/search?q=OCEAN-777");
  assert.ok(byVariant.results.some((x) => x.id === product.id));
  const translit = await json("/api/store/search?q=мок");
  assert.ok(translit.results.some((x) => x.id === product.id));
  assert.ok(!translit.results.some((x) => x.id === draft.id));
  const manyCategories = await json("/api/store/search?q=Бренд");
  assert.equal(manyCategories.category_results.filter((x) => x.name.startsWith("Бренд ")).length, 66);
  const partial = await json("/api/store/search?q=MOK%20несуществующее");
  assert.equal(partial.total, 0);
});

test("фильтр родительской категории включает вложенные, чужая категория исключает", async () => {
  const inRoot = await json(`/api/store/search?q=MOK&category_id=${root.id}`);
  const outside = await json(`/api/store/search?q=MOK&category_id=${other.id}`);
  assert.ok(inRoot.results.some((x) => x.id === product.id));
  assert.ok(!outside.results.some((x) => x.id === product.id));
});

test("лёгкая навигация не возвращает полный список товаров", async () => {
  const nav = await json("/api/store/navigation");
  assert.ok(nav.categories.some((c) => c.id === atom.id));
  assert.equal(nav.products, undefined);
  const regular = await json("/api/store/public");
  assert.ok(regular.products.some((p) => p.id === product.id));
});

test("старый адрес категории и страница поиска доступны", async () => {
  assert.match(await html('/directory-atom'), /ATOM/);
  const result = await html('/search?q=MOK&category_id=' + root.id);
  assert.match(result, /vapelab-search-page-form/);
  assert.match(result, /data-category-id=/);
});
