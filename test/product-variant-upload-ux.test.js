import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const read = (path) => fs.readFile(new URL(path, import.meta.url), "utf8");

const admin = await read("../public/js/views/store.js");
const server = await read("../server/routes/store.js");
const styles = await read("../public/seo-pages.css");

test("карточка каждого варианта содержит видимый нативный выбор файлов", () => {
  assert.match(admin, /makeSummaryUploadInput\s*=\s*\(variant\)\s*=>/);
  assert.match(admin, /class: "store-product-variant-summary-file-input"/);
  assert.match(admin, /Загрузить новое фото этого варианта/);
  assert.match(admin, /store-product-variant-summary-shared-button/);
  assert.match(admin, /Назначить уже загруженное фото — нажмите миниатюру/);
  assert.match(styles, /\.store-product-variant-summary-file-input/);
  assert.match(styles, /\.store-product-variant-summary-shared-button/);
});

test("загружаемое фото сразу привязывается к выбранному варианту и проверяется ответ сервера", () => {
  assert.match(admin, /upload\(`\/store\/products\/\$\{p\.id\}\/images\/upload`, file, \{ "X-Variant-Id": String\(variant\.id\) \}\)/);
  assert.match(admin, /Number\(image\.variant_id\) !== Number\(variant\.id\)/);
  assert.match(server, /checkedVariantId\(product\.id, req\.headers\["x-variant-id"\]\)/);
});

test("модальное управление вариантами использует видимый input вместо скрытой кнопки file.click", () => {
  assert.match(admin, /class: "store-variant-file-input"/);
  assert.match(admin, /makeField\("Загрузить фотографии этого варианта", fileInput/);
  assert.doesNotMatch(admin, /onclick: \(\) => fileInput\.click\(\)/);
  const editorStart = admin.indexOf("async function editProductVariants(");
  const editorEnd = admin.indexOf("async function editSeo(", editorStart);
  const variantEditor = admin.slice(editorStart, editorEnd);
  assert.doesNotMatch(variantEditor, /type: "file"[^\n]*hidden: true/);
});

test("при открытии редактора варианты и изображения повторно синхронизируются с сервером", () => {
  assert.match(admin, /Always reload the product snapshot/);
  assert.ok(admin.includes("const response = await api(`/store/admin?page=1&page_size=100&q=${query}`)"));
  assert.match(admin, /onSaved\?\.\(\)/);
  assert.match(admin, /onSaved: syncProductSummary/);
});

test("изменения привязки фотографий обновляют карточку товара", () => {
  assert.match(admin, /const publishProductChanges = \(\) =>/);
  assert.match(admin, /p\.images = images;/);
  assert.match(admin, /p\.variants = variants;/);
  assert.match(admin, /renderProductVariantSummary\(\)/);
});
