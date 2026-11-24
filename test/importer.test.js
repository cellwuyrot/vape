/**
 * Разбор файлов импорта и шаблонизатор печатных форм — без сети и без базы.
 * Здесь проверяется то, что легко сломать незаметно: чтение xlsx, кавычки в CSV,
 * распознавание выгрузок amoCRM и Битрикс24 и сумма прописью.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  columnIndex, detectDelimiter, detectProfile, guessMapping, validateImportMapping, parseCsv, parseXlsx, unzip,
} from "../server/importer.js";
import { amountInWords, renderTemplate } from "../server/documents.js";

/* ------------------------------------------------------------------ */
/*  Сборка минимального xlsx: zip без сжатия                           */
/* ------------------------------------------------------------------ */

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // метод хранения: без сжатия
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const body = Buffer.concat(locals);
  const dir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(body.length, 16);

  return Buffer.concat([body, dir, eocd]);
}

const BOOK = zip({
  "xl/sharedStrings.xml":
    '<sst><si><t>Полное имя</t></si><si><t>Телефон</t></si>' +
    "<si><t>Иванов Иван</t></si><si><t>+7 916 123-45-67</t></si></sst>",
  "xl/worksheets/sheet1.xml":
    "<worksheet><sheetData>" +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>' +
    '<row r="3"><c r="A3" t="inlineStr"><is><t>Петров Пётр</t></is></c><c r="C3"><v>150000</v></c></row>' +
    "</sheetData></worksheet>",
});

/* ------------------------------------------------------------------ */

test("zip распаковывается по центральному каталогу", () => {
  const files = unzip(BOOK);
  assert.ok(files.has("xl/sharedStrings.xml"));
  assert.match(files.get("xl/worksheets/sheet1.xml").toString("utf8"), /sheetData/);
});

test("xlsx читается вместе с общими строками и вставками", () => {
  const rows = parseXlsx(BOOK);
  assert.deepEqual(rows[0], ["Полное имя", "Телефон"]);
  assert.deepEqual(rows[1], ["Иванов Иван", "+7 916 123-45-67"]);
  assert.equal(rows[2][0], "Петров Пётр");
  assert.equal(rows[2][2], "150000", "пропущенная колонка B не должна сдвигать значения");
});

test("xlsx читает namespace-префиксы в worksheet, row, cell, si и t", () => {
  const namespaced = zip({
    "xl/sharedStrings.xml":
      '<x:sst xmlns:x="urn:test"><x:si><x:r><x:t>Название </x:t></x:r><x:r><x:t>товара</x:t></x:r></x:si>' +
      '<x:si><x:t>Тестовая позиция</x:t></x:si></x:sst>',
    "xl/worksheets/sheet1.xml":
      '<x:worksheet xmlns:x="urn:test"><x:sheetData>' +
      '<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c></x:row>' +
      '<x:row r="2"><x:c r="A2" t="s"><x:v>1</x:v></x:c></x:row>' +
      '</x:sheetData></x:worksheet>',
  });
  assert.deepEqual(parseXlsx(namespaced), [["Название товара"], ["Тестовая позиция"]]);
});

test("xlsx сохраняет позиции колонок после пустых self-closing ячеек с namespace", () => {
  const withEmptyCells = zip({
    "xl/worksheets/sheet1.xml":
      '<x:worksheet xmlns:x="urn:test"><x:sheetData>' +
      '<x:row r="1">' +
      '<x:c r="A1" t="inlineStr"><x:is><x:t>Название товара</x:t></x:is></x:c>' +
      '<x:c r="B1" s="1" />' +
      '<x:c r="C1" t="inlineStr"><x:is><x:t>Бренд</x:t></x:is></x:c>' +
      '<x:c r="D1" t="inlineStr"><x:is><x:t>Частотность (целое число)</x:t></x:is></x:c>' +
      '<x:c r="E1" t="inlineStr"><x:is><x:t>ALT изображения</x:t></x:is></x:c>' +
      '<x:c r="F1" s="1" />' +
      '<x:c r="G1" t="inlineStr"><x:is><x:t>Название варианта</x:t></x:is></x:c>' +
      '</x:row>' +
      '<x:row r="2">' +
      '<x:c r="A2" t="inlineStr"><x:is><x:t>MOK FWRD</x:t></x:is></x:c>' +
      '<x:c r="B2" s="1" />' +
      '<x:c r="C2" t="inlineStr"><x:is><x:t>MOK</x:t></x:is></x:c>' +
      '<x:c r="D2" s="1" />' +
      '<x:c r="E2" t="inlineStr"><x:is><x:t>Фото MOK FWRD, синий</x:t></x:is></x:c>' +
      '<x:c r="F2" s="1" />' +
      '<x:c r="G2" t="inlineStr"><x:is><x:t>Синий</x:t></x:is></x:c>' +
      '</x:row>' +
      '</x:sheetData></x:worksheet>',
  });
  const rows = parseXlsx(withEmptyCells);
  assert.deepEqual(rows[1], ["MOK FWRD", "", "MOK", "", "Фото MOK FWRD, синий", "", "Синий"]);
  const mapping = guessMapping(rows[0], "products");
  assert.equal(mapping[3], "search_volume");
  assert.equal(rows[1][Number(Object.keys(mapping).find((index) => mapping[index] === "search_volume"))], "");
  assert.equal(rows[1][4], "Фото MOK FWRD, синий");
  assert.equal(rows[1][6], "Синий");
});

test("ссылка ячейки переводится в номер колонки", () => {
  assert.equal(columnIndex("A1"), 0);
  assert.equal(columnIndex("Z9"), 25);
  assert.equal(columnIndex("AA1"), 26);
  assert.equal(columnIndex("BC12"), 54);
});

test("разделитель CSV определяется по первой строке", () => {
  assert.equal(detectDelimiter("имя;телефон;почта"), ";");
  assert.equal(detectDelimiter("имя,телефон,почта"), ",");
  assert.equal(detectDelimiter("имя\tтелефон\tпочта"), "\t");
});

test("кавычки, переносы и удвоенные кавычки в CSV разбираются верно", () => {
  const rows = parseCsv('имя;комментарий\n"Иванов, Иван";"сказал ""перезвоните позже""; ждёт"');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], ["Иванов, Иван", 'сказал "перезвоните позже"; ждёт']);
});

test("выгрузка amoCRM распознаётся по заголовкам", () => {
  const headers = ["Полное имя", "Рабочий телефон", "Ответственный", "Бюджет", "Теги"];
  assert.equal(detectProfile(headers).profile, "amocrm");
});

test("выгрузка Битрикс24 распознаётся по заголовкам", () => {
  const headers = ["Название лида", "Стадия сделки", "Ответственный", "Источник"];
  assert.equal(detectProfile(headers).profile, "bitrix24");
});

test("колонки раскладываются по полям автоматически", () => {
  const mapping = guessMapping(["Полное имя", "Рабочий телефон", "E-mail", "Компания"], "contacts");
  assert.equal(mapping[0], "full_name");
  assert.equal(mapping[1], "phone");
  assert.equal(mapping[2], "email");
  assert.equal(mapping[3], "company_name");
});

test("одна колонка файла не занимает два поля", () => {
  const mapping = guessMapping(["Телефон", "Мобильный телефон"], "contacts");
  assert.equal(mapping[0], "phone");
  assert.equal(mapping[1], undefined);
});

test("специфичные заголовки SEO и вариантов не перехватываются общими синонимами", () => {
  const mapping = guessMapping(["SEO Description", "Description", "Название варианта", "Формат", "Артикул варианта"], "products");
  assert.equal(mapping[0], "seo_description");
  assert.equal(mapping[1], "description");
  assert.equal(mapping[2], "variant_name");
  assert.equal(mapping[3], "format");
  assert.equal(mapping[4], "variant_sku");
});

test("все поля обновлённого шаблона каталога автоматически сопоставляются с CRM-полями", () => {
  const headers = [
    "Название товара", "Артикул / SKU", "Бренд", "Основная категория", "Подкатегория",
    "Тип товара", "Формат / вариант", "Описание", "Цена (как в источнике)",
    "Старая цена (как в источнике)", "Валюта", "Подпись наличия (как в источнике)",
    "URL источника", "Статус товара: hidden / active / out_of_stock / draft", "SEO H1", "SEO Title", "SEO Description",
    "Ключевые фразы через запятую", "Частотность (целое число)",
    "Класс частотности: high / medium / low", "URL изображения", "ALT изображения",
    "Страница-источник изображения", "Поисковый запрос изображения", "Название варианта",
    "Артикул варианта", "Цена варианта (исходная строка)", "Старая цена варианта",
    "Наличие варианта (как в источнике)", "Вкус", "Объём", "Крепость", "Цвет",
    "Комплектация", "Совместимость", "Атрибуты варианта JSON", "Canonical URL",
    "Поисковая система", "Регион частотности",
    "Намерение поискового запроса", "Источник частотности", "Дата проверки частотности",
    "Требуется проверка 18+: 1 / 0", "Разрешить бронирование: 1 / 0",
  ];
  const mapping = guessMapping(headers, "products");
  assert.equal(Object.keys(mapping).length, headers.length);
  assert.equal(mapping[11], "availability_label_raw");
  assert.equal(mapping[13], "status");
  assert.equal(mapping[17], "seo_keywords");
  assert.equal(mapping[39], "search_intent");
  assert.equal(mapping[42], "is_18_plus");
  assert.equal(mapping[43], "is_reservable");
});

test("ручное сопоставление можно выбрать самостоятельно, но дубли целевого поля запрещены", () => {
  const valid = validateImportMapping("products", { "0": "name", "1": "seo_description", "2": "description" }, 3);
  assert.deepEqual(valid, [[0, "name"], [1, "seo_description"], [2, "description"]]);
  assert.throws(
    () => validateImportMapping("products", { "0": "name", "1": "name" }, 2),
    /назначено нескольким колонкам/
  );
  assert.throws(
    () => validateImportMapping("products", { "0": "name", "5": "description" }, 2),
    /Неверный номер колонки/
  );
  assert.throws(
    () => validateImportMapping("products", { "0": "name", "1": "unknown_field" }, 2),
    /не поддерживается/
  );
});

/* ------------------------------------------------------------------ */
/*  Печатные формы                                                     */
/* ------------------------------------------------------------------ */

test("сумма прописью склоняется по правилам русского языка", () => {
  assert.equal(amountInWords(0), "Ноль рублей 00 копеек");
  assert.equal(amountInWords(1), "Один рубль 00 копеек");
  assert.equal(amountInWords(2), "Два рубля 00 копеек");
  assert.equal(amountInWords(11), "Одиннадцать рублей 00 копеек");
  assert.equal(amountInWords(21.05), "Двадцать один рубль 05 копеек");
  assert.equal(amountInWords(1000), "Одна тысяча рублей 00 копеек");
  assert.equal(amountInWords(2500.42), "Две тысячи пятьсот рублей 42 копейки");
  assert.equal(amountInWords(1234567.89), "Один миллион двести тридцать четыре тысячи пятьсот шестьдесят семь рублей 89 копеек");
});

test("шаблон подставляет вложенные поля и повторяет блок позиций", () => {
  const html = renderTemplate(
    "<h1>{{doc.number}}</h1>{{#items}}<li>{{index}}. {{name}} — {{sum}}</li>{{/items}}",
    { doc: { number: "2026-00001" }, items: [{ index: 1, name: "Час работ", sum: "4 500,00" }] }
  );
  assert.match(html, /<h1>2026-00001<\/h1>/);
  assert.match(html, /1\. Час работ — 4 500,00/);
});

test("значения из данных экранируются: чужой HTML не попадает в бланк", () => {
  const html = renderTemplate("{{company.name}}", { company: { name: '<script>alert("x")</script>' } });
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
});

test("отсутствующее поле подставляется пустой строкой, а не текстом undefined", () => {
  assert.equal(renderTemplate("[{{contact.middle_name}}]", { contact: {} }), "[]");
});
