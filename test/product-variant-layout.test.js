import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const read = (path) => fs.readFile(new URL(path, import.meta.url), "utf8");
const publicPages = await read("../server/public-pages.js");
const client = await read("../public/product-variants.js");
const admin = await read("../public/js/views/store.js");
const styles = await read("../public/seo-pages.css");

test("витрина выводит одно главное изображение без нижней полосы миниатюр", () => {
  assert.match(publicPages, /data-product-main-image/);
  assert.doesNotMatch(publicPages, /seo-product-gallery-thumbs|data-product-gallery-thumb|seo-product-thumb/);
  assert.doesNotMatch(styles, /seo-product-gallery-thumbs|seo-product-thumb/);
});

test("заглушка галереи скрывается с атрибутом hidden", () => {
  assert.match(styles, /\.seo-product-gallery-stage>\[data-product-gallery-placeholder\]\[hidden\]\s*\{\s*display:none;\s*\}/);
  assert.match(client, /if \(placeholder\) placeholder\.hidden = true;/);
});

test("выбор варианта меняет главное изображение из привязки варианта", () => {
  assert.match(publicPages, /data-image-url=\"\$\{esc\(item\.image\?\.public_url \|\| fallbackImage\)\}\"/);
  assert.match(client, /const variantImage = button\.dataset\.imageUrl \|\| gallery\.dataset\.defaultImage \|\| \"\"/);
  assert.match(client, /setMainImage\(gallery, variantImage, variantAlt\)/);
});

test("варианты остаются в правой информационной колонке карточки товара", () => {
  assert.ok(publicPages.includes('${imageGallery}<article class="seo-product-information"'));
  assert.ok(publicPages.indexOf('${variantRows}') > publicPages.indexOf('${imageGallery}<article class="seo-product-information"'));
  assert.match(styles, /\.seo-product-page \.seo-product-detail \{ grid-template-columns:minmax\(0,1\.08fr\) minmax\(380px,\.92fr\)/);
});

test("основная карточка товара в админке показывает список вариантов и фото", () => {
  assert.match(admin, /store-product-variants-summary/);
  assert.match(admin, /store-product-variant-summary-row/);
  assert.match(admin, /Настроить варианты и фото/);
});

test("непривязанные фото можно назначить конкретному варианту из его карточки", () => {
  assert.match(admin, /store-variant-shared-photo/);
  assert.match(admin, /variant_id: variant\.id/);
  assert.match(admin, /Общие фотографии товара/);
  assert.match(admin, /const sharedImages = images\.filter\(\(image\) => !Number\(image\.variant_id\)\)/);
});
