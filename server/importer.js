/**
 * Импорт базы из Excel и CSV.
 *
 * Главный барьер перехода с amoCRM и Битрикс24 — не функции, а страх потерять
 * накопленную базу. Поэтому здесь: разбор xlsx и csv без единой зависимости,
 * автоматическое распознавание выгрузок amoCRM и Битрикс24, предпросмотр
 * с сопоставлением колонок и защита от дублей на записи.
 *
 * Формат xlsx — это zip с XML внутри. Распаковку делает встроенный zlib,
 * разбор XML — регулярные выражения по узкому подмножеству разметки,
 * которое реально встречается в выгрузках офисных пакетов.
 */
import zlib from "node:zlib";

import { db, nowIso, repo } from "./db.js";
import { HttpError } from "./http.js";
import { logActivity } from "./activity.js";
import { findContactMatches, normalizeEmail, normalizeInn } from "./dedupe.js";

/* ------------------------------------------------------------------ */
/*  ZIP                                                                */
/* ------------------------------------------------------------------ */

/** Распаковывает zip в карту «имя файла → Buffer». Поддержаны store и deflate. */
export function unzip(buffer) {
  const files = new Map();
  const eocd = findSignature(buffer, 0x06054b50);
  if (eocd === -1) throw new HttpError(400, "Файл не похож на xlsx: не найден каталог архива");

  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < entries; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);

    files.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function findSignature(buffer, signature) {
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === signature) return i;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/*  XLSX                                                               */
/* ------------------------------------------------------------------ */

const XML_ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const unescapeXml = (text) =>
  String(text)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity]);

/** Ссылка ячейки A1, BC12 → номер колонки с нуля. */
export function columnIndex(ref) {
  const letters = String(ref).replace(/\d+/g, "").toUpperCase();
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

export function parseXlsx(buffer) {
  const files = unzip(buffer);

  const sharedRaw = files.get("xl/sharedStrings.xml")?.toString("utf8") || "";
  const shared = [...sharedRaw.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
    unescapeXml([...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""))
  );

  const sheetName =
    [...files.keys()].find((name) => /^xl\/worksheets\/sheet1\.xml$/.test(name)) ||
    [...files.keys()].find((name) => /^xl\/worksheets\/.*\.xml$/.test(name));
  if (!sheetName) throw new HttpError(400, "В книге нет ни одного листа");

  const sheet = files.get(sheetName).toString("utf8");
  const rows = [];

  for (const rowMatch of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const inner = cellMatch[2];
      const index = columnIndex(/r="([A-Z]+\d+)"/.exec(attrs)?.[1] || "A1");
      const type = /t="([^"]+)"/.exec(attrs)?.[1] || "n";

      let value = "";
      if (type === "s") {
        value = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] || 0)] ?? "";
      } else if (type === "inlineStr") {
        value = unescapeXml([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
      } else {
        value = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] || "");
      }
      cells[index] = String(value).trim();
    }
    // Пустые ячейки в середине строки xlsx просто пропускает — восстанавливаем плотный массив
    for (let i = 0; i < cells.length; i += 1) if (cells[i] === undefined) cells[i] = "";
    rows.push(cells);
  }

  return rows.filter((row) => row.some((cell) => cell !== ""));
}

/* ------------------------------------------------------------------ */
/*  CSV                                                                */
/* ------------------------------------------------------------------ */

export function detectDelimiter(text) {
  const line = text.split(/\r?\n/).find((l) => l.trim()) || "";
  const counts = [";", ",", "\t", "|"].map((d) => [d, line.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ";";
}

export function parseCsv(text, delimiter) {
  const source = text.replace(/^﻿/, "");
  const sep = delimiter || detectDelimiter(source);
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') { value += '"'; i += 1; }
        else quoted = false;
      } else value += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === sep) { row.push(value.trim()); value = ""; continue; }
    if (char === "\n") { row.push(value.trim()); rows.push(row); row = []; value = ""; continue; }
    if (char === "\r") continue;
    value += char;
  }
  if (value !== "" || row.length) { row.push(value.trim()); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell !== ""));
}

/** Файл любого из двух форматов → массив строк. */
export function parseTable(filename, buffer) {
  if (/\.xlsx$/i.test(filename) || buffer.subarray(0, 2).toString() === "PK") return parseXlsx(buffer);
  if (/\.xls$/i.test(filename)) {
    throw new HttpError(415, "Старый формат .xls не поддерживается — пересохраните файл как .xlsx или .csv");
  }
  return parseCsv(decodeText(buffer));
}

/** Выгрузки 1С и старого Excel часто приходят в windows-1251. */
export function decodeText(buffer) {
  const utf8 = buffer.toString("utf8");
  if (!utf8.includes("�")) return utf8;
  return new TextDecoder("windows-1251").decode(buffer);
}

/* ------------------------------------------------------------------ */
/*  Сопоставление колонок                                              */
/* ------------------------------------------------------------------ */

export const ENTITY_FIELDS = {
  contacts: {
    label: "Клиенты",
    fields: {
      full_name: { label: "ФИО", required: true },
      phone: { label: "Телефон" },
      email: { label: "E-mail" },
      position: { label: "Должность" },
      company_name: { label: "Компания" },
      tags: { label: "Теги" },
      comment: { label: "Комментарий" },
      source: { label: "Источник" },
    },
  },
  companies: {
    label: "Компании",
    fields: {
      name: { label: "Название", required: true },
      inn: { label: "ИНН" },
      kpp: { label: "КПП" },
      ogrn: { label: "ОГРН" },
      legal_address: { label: "Юридический адрес" },
      website: { label: "Сайт" },
    },
  },
  deals: {
    label: "Сделки",
    fields: {
      title: { label: "Название", required: true },
      amount: { label: "Сумма" },
      stage: { label: "Стадия" },
      contact_name: { label: "Клиент" },
      contact_phone: { label: "Телефон клиента" },
      company_name: { label: "Компания" },
      source: { label: "Источник" },
    },
  },
  products: {
    label: "Товары витрины VAPELAB",
    fields: {
      name: { label: "Название товара", required: true },
      sku: { label: "Артикул / SKU" },
      brand: { label: "Бренд" },
      category_name: { label: "Основная категория" },
      subcategory_name: { label: "Подкатегория" },
      product_type: { label: "Тип товара" },
      format: { label: "Формат / вариант" },
      description: { label: "Описание" },
      price_raw: { label: "Цена (как в источнике)" },
      old_price_raw: { label: "Старая цена (как в источнике)" },
      currency: { label: "Валюта" },
      availability_label_raw: { label: "Подпись наличия (как в источнике)" },
      availability_status: { label: "Статус склада: in_stock / out_of_stock / preorder / unknown" },
      source_url: { label: "URL источника" },
      status: { label: "Статус: draft / published" },
      seo_h1: { label: "SEO H1" },
      seo_title: { label: "SEO Title" },
      seo_description: { label: "SEO Description" },
      seo_keywords: { label: "Ключевые фразы через запятую" },
      canonical_url: { label: "Canonical URL" },
      robots_index: { label: "Разрешить индексацию: 1 / 0" },
      search_volume: { label: "Частотность (целое число)" },
      frequency_class: { label: "Класс частотности: high / medium / low" },
      search_engine: { label: "Поисковая система" },
      search_region: { label: "Регион частотности" },
      search_intent: { label: "Намерение поискового запроса" },
      search_source: { label: "Источник частотности" },
      search_checked_at: { label: "Дата проверки частотности" },
      image_url: { label: "URL изображения" },
      image_alt: { label: "ALT изображения" },
      image_source_url: { label: "Страница-источник изображения" },
      image_search_query: { label: "Поисковый запрос изображения" },
      variant_name: { label: "Название варианта" },
      variant_sku: { label: "Артикул варианта" },
      variant_price_raw: { label: "Цена варианта (исходная строка)" },
      variant_old_price_raw: { label: "Старая цена варианта" },
      variant_availability_label_raw: { label: "Наличие варианта (как в источнике)" },
      taste: { label: "Вкус" },
      volume: { label: "Объём" },
      strength: { label: "Крепость" },
      color: { label: "Цвет" },
      package: { label: "Комплектация" },
      compatibility: { label: "Совместимость" },
      variant_attributes_json: { label: "Атрибуты варианта JSON" },
      is_18_plus: { label: "Требуется проверка 18+: 1 / 0" },
      is_reservable: { label: "Разрешить бронирование: 1 / 0" },
    },
  },
};

/** Заголовки, по которым узнаётся источник выгрузки и раскладываются колонки. */
const SYNONYMS = {
  contacts: {
    full_name: ["полное имя", "фио", "имя", "контакт", "название контакта", "клиент", "фамилия имя отчество"],
    phone: ["телефон", "рабочий телефон", "мобильный телефон", "телефон рабочий", "phone", "тел"],
    email: ["email", "e-mail", "почта", "рабочий email", "электронная почта"],
    position: ["должность", "position"],
    company_name: ["компания", "организация", "название компании", "контрагент"],
    tags: ["теги", "метки", "tags"],
    comment: ["комментарий", "примечание", "описание", "note"],
    source: ["источник", "откуда узнали", "source", "utm_source"],
  },
  companies: {
    name: ["название", "компания", "организация", "наименование", "контрагент"],
    inn: ["инн", "inn"],
    kpp: ["кпп"],
    ogrn: ["огрн", "огрнип"],
    legal_address: ["адрес", "юридический адрес", "адрес регистрации"],
    website: ["сайт", "веб-сайт", "website", "url"],
  },
  deals: {
    title: ["название", "название сделки", "сделка", "тема", "название лида"],
    amount: ["бюджет", "сумма", "сумма сделки", "стоимость", "amount", "цена"],
    stage: ["этап", "стадия", "статус", "этап сделки", "стадия сделки"],
    contact_name: ["контакт", "клиент", "полное имя", "основной контакт"],
    contact_phone: ["телефон", "рабочий телефон", "телефон контакта"],
    company_name: ["компания", "организация", "контрагент"],
    source: ["источник", "source", "utm_source"],
  },
  products: {
    name: ["название товара", "наименование", "название", "товар", "product"],
    sku: ["артикул", "sku", "код товара"],
    brand: ["бренд", "производитель", "brand"],
    category_name: ["категория", "основная категория", "раздел"],
    subcategory_name: ["подкатегория", "вложенная категория"],
    product_type: ["тип товара", "тип"],
    format: ["формат", "формат товара", "модификация"],
    description: ["описание", "description"],
    price_raw: ["цена", "цена исходная", "price"],
    old_price_raw: ["старая цена", "цена до скидки"],
    currency: ["валюта", "currency"],
    availability_label_raw: ["подпись наличия", "наличия", "наличие", "статус наличия", "доступность"],
    availability_status: ["статус склада", "статус наличия нормализованный", "availability status", "availability_status"],
    source_url: ["url источника", "ссылка на товар", "source_url"],
    status: ["статус draft published", "статус публикации", "статус товара"],
    seo_h1: ["seo h1", "h1"],
    seo_title: ["seo title", "title"],
    seo_description: ["seo description", "meta description", "description seo"],
    seo_keywords: ["ключевые фразы", "ключевые запросы", "ключевые слова", "keywords"],
    canonical_url: ["canonical", "canonical url", "канонический url"],
    robots_index: ["индексация", "разрешить индексацию", "robots index", "indexable"],
    search_volume: ["частотность", "объем поиска", "search volume"],
    frequency_class: ["частотный класс", "класс частотности", "вч сч нч", "frequency class"],
    search_engine: ["поисковая система", "search engine", "источник поисковой системы"],
    search_region: ["регион частотности", "регион поиска", "search region"],
    search_intent: ["намерение поискового запроса", "намерение запроса", "намерение поиска", "search intent"],
    search_source: ["источник частотности", "источник статистики", "frequency source"],
    search_checked_at: ["дата проверки частотности", "дата проверки запроса", "search checked at"],
    image_url: ["url изображения", "ссылка на изображение", "image url", "фото url"],
    image_alt: ["alt изображения", "alt фото", "image alt"],
    image_source_url: ["источник изображения", "страница изображения", "image source"],
    image_search_query: ["поисковый запрос изображения", "image search query"],
    variant_name: ["название варианта", "вариант", "модификация товара", "variant name", "variant"],
    variant_sku: ["артикул варианта", "sku варианта", "variant sku"],
    variant_price_raw: ["цена варианта", "variant price"],
    variant_old_price_raw: ["старая цена варианта", "variant old price"],
    variant_availability_label_raw: ["наличие варианта", "variant availability"],
    taste: ["вкус", "вкусовой вариант"],
    volume: ["объем", "объём", "объем варианта", "volume"],
    strength: ["крепость", "strength"],
    color: ["цвет", "color"],
    package: ["комплектация", "комплект", "package"],
    compatibility: ["совместимость", "compatible with"],
    variant_attributes_json: ["атрибуты варианта json", "variant attributes json"],
    is_18_plus: ["18+", "возраст 18+", "требуется 18+", "is 18 plus", "is_18_plus"],
    is_reservable: ["разрешить бронирование", "бронирование разрешено", "reservable", "is_reservable"],
  },
};

const FINGERPRINTS = [
  { profile: "amocrm", label: "выгрузка amoCRM", markers: ["полное имя", "ответственный", "бюджет", "теги"] },
  { profile: "bitrix24", label: "выгрузка Битрикс24", markers: ["название лида", "стадия сделки", "ответственный", "источник"] },
];

const norm = (value) => String(value || "")
  .normalize("NFKC")
  .replace(/^\uFEFF/, "")
  .trim()
  .toLocaleLowerCase("ru-RU")
  .replace(/ё/g, "е")
  .replace(/[\s_\-./\\()\[\]{}:]+/g, " ")
  .replace(/\s+/g, " ");

export function detectProfile(headers) {
  const lower = headers.map(norm);
  for (const item of FINGERPRINTS) {
    const hits = item.markers.filter((marker) => lower.some((h) => h.includes(marker))).length;
    if (hits >= 2) return item;
  }
  return { profile: "generic", label: "произвольная таблица" };
}

/**
 * Подбирает наиболее специфичное поле для каждого заголовка.
 * Точное совпадение с длинным/специфичным алиасом всегда сильнее частичного.
 * Например, "SEO Description" не превращается в обычное description,
 * а "Название варианта" — в format.
 */
export function guessMapping(headers, entity) {
  const dictionary = SYNONYMS[entity] || {};
  const candidates = [];
  headers.forEach((header, index) => {
    const value = norm(header);
    if (!value) return;
    for (const [field, variants] of Object.entries(dictionary)) {
      for (const alias of variants) {
        const needle = norm(alias);
        if (!needle) continue;
        let score = 0;
        if (value === needle) score = 10000 + needle.length;
        else if (value.startsWith(`${needle} `)) score = 6000 + needle.length;
        else if (value.includes(needle)) score = 3000 + needle.length;
        if (score) candidates.push({ index, field, score });
      }
    }
  });

  // Preserve source column order when two headers compete for the same CRM field;
  // inside each header choose its most specific alias.
  candidates.sort((a, b) => a.index - b.index || b.score - a.score || a.field.localeCompare(b.field));
  const mapping = {};
  const takenFields = new Set();
  const takenColumns = new Set();
  for (const candidate of candidates) {
    if (takenFields.has(candidate.field) || takenColumns.has(candidate.index)) continue;
    mapping[candidate.index] = candidate.field;
    takenFields.add(candidate.field);
    takenColumns.add(candidate.index);
  }
  return Object.fromEntries(Object.entries(mapping).sort((a, b) => Number(a[0]) - Number(b[0])));
}

/** Серверная валидация сопоставления, включая ручной выбор пользователя. */
export function validateImportMapping(entity, mapping, columnCount) {
  const meta = ENTITY_FIELDS[entity];
  if (!meta) throw new HttpError(400, "Неизвестная сущность импорта");
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    throw new HttpError(400, "Сопоставление колонок имеет неверный формат");
  }

  const pairs = [];
  const usedFields = new Map();
  for (const [rawIndex, rawField] of Object.entries(mapping)) {
    const index = Number(rawIndex);
    if (!Number.isSafeInteger(index) || index < 0 || index >= columnCount) {
      throw new HttpError(400, `Неверный номер колонки: ${rawIndex}`);
    }
    if (rawField === "" || rawField === null || rawField === undefined) continue;
    const field = String(rawField);
    if (!Object.hasOwn(meta.fields, field)) {
      throw new HttpError(400, `Поле импорта не поддерживается: ${field}`);
    }
    if (usedFields.has(field)) {
      throw new HttpError(400, `Поле «${meta.fields[field].label}» назначено нескольким колонкам (${usedFields.get(field) + 1} и ${index + 1}). Оставьте только одну колонку или выберите другое поле.`);
    }
    usedFields.set(field, index);
    pairs.push([index, field]);
  }

  const missingRequired = Object.entries(meta.fields)
    .filter(([field, info]) => info.required && !usedFields.has(field))
    .map(([, info]) => info.label);
  if (missingRequired.length) {
    throw new HttpError(400, `Не сопоставлены обязательные поля: ${missingRequired.join(", ")}`);
  }
  return pairs.sort((a, b) => a[0] - b[0]);
}

/* ------------------------------------------------------------------ */
/*  Предпросмотр и запись                                              */
/* ------------------------------------------------------------------ */

export function buildPreview({ filename, buffer, entity }) {
  if (!ENTITY_FIELDS[entity]) throw new HttpError(400, "Неизвестная сущность импорта");
  const rows = parseTable(filename, buffer);
  if (rows.length < 2) throw new HttpError(400, "В файле нет данных: ожидается строка заголовков и хотя бы одна строка");

  const headers = rows[0];
  const body = rows.slice(1);
  const detected = detectProfile(headers);

  return {
    entity,
    filename,
    profile: detected.profile,
    profile_label: detected.label,
    headers,
    mapping: guessMapping(headers, entity),
    total: body.length,
    sample: body.slice(0, 8),
    rows: body,
    fields: ENTITY_FIELDS[entity].fields,
  };
}

const toNumber = (value) => {
  const cleaned = String(value || "").replace(/[^\d,.-]/g, "").replace(/\s/g, "").replace(",", ".");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Применяет импорт: создаёт новые карточки, дополняет найденные, считает пропуски. */
export async function applyImport({ entity, rows, mapping, headers, userId, filename = "", profile = "generic", dryRun = false }) {
  const fields = ENTITY_FIELDS[entity];
  if (!fields) throw new HttpError(400, "Неизвестная сущность импорта");
  const inferredColumnCount = Array.isArray(headers) ? headers.length : Math.max(0, ...rows.map((row) => row.length));
  const pairs = validateImportMapping(entity, mapping, inferredColumnCount);

  const stats = { total: rows.length, created: 0, updated: 0, skipped: 0, errors: [] };

  for (const [rowIndex, row] of rows.entries()) {
    const record = {};
    for (const [index, field] of pairs) record[field] = String(row[index] ?? "").trim();

    try {
      const result = entity === "contacts"
        ? await upsertContact(record, dryRun)
        : entity === "companies"
          ? await upsertCompany(record, dryRun)
          : entity === "deals"
            ? await upsertDeal(record, userId, dryRun)
            : await upsertStoreProduct(record, dryRun);
      stats[result] += 1;
    } catch (err) {
      stats.skipped += 1;
      if (stats.errors.length < 20) stats.errors.push({ row: rowIndex + 2, detail: err.message });
    }
  }

  if (!dryRun) {
    await repo.insert("import_runs", {
      filename,
      entity,
      profile,
      mapping: JSON.stringify(mapping || {}),
      total: stats.total,
      created: stats.created,
      updated: stats.updated,
      skipped: stats.skipped,
      errors: JSON.stringify(stats.errors).slice(0, 4000),
      user_id: userId ?? null,
    });
  }
  return stats;
}

async function findStoreCategory(name, parentId = null, dryRun = false) {
  const label = String(name || "").trim();
  if (!label) return null;
  const where = parentId === null ? "name = ? AND parent_id IS NULL" : "name = ? AND parent_id = ?";
  const params = parentId === null ? [label] : [label, parentId];
  const found = await db.get(`SELECT id FROM store_categories WHERE ${where} LIMIT 1`, params);
  if (found) return found.id;
  if (dryRun) return null;
  const slugBase = label.toLowerCase().replace(/ё/g,"e").replace(/[^a-z0-9а-я]+/gi,"-").replace(/^-|-$/g,"") || `category-${Date.now()}`;
  let slug = slugBase;
  let suffix = 2;
  while (await db.get("SELECT id FROM store_categories WHERE slug=?", [slug])) { slug = slugBase + "-" + String(suffix); suffix += 1; }
  const created = await repo.insert("store_categories", { name:label, slug, parent_id:parentId, sort_order:999, description:"", source_url:"" });
  return created.id;
}

function parseImportBoolean(value, fallback, label) {
  if (value === undefined || value === null || String(value).trim() === "") return Number(fallback) ? 1 : 0;
  const normalized = String(value).trim().toLocaleLowerCase("ru-RU");
  if (["1", "true", "yes", "да", "есть", "18+", "разрешено"].includes(normalized)) return 1;
  if (["0", "false", "no", "нет", "не", "запрещено"].includes(normalized)) return 0;
  throw new Error(`поле «${label}» должно содержать 1/0, да/нет или true/false`);
}

async function upsertStoreProduct(record, dryRun) {
  const name = String(record.name || "").trim();
  if (!name) throw new Error("не указано название товара");
  const slugBase = name.toLowerCase().replace(/ё/g,"e").replace(/[^a-z0-9а-я]+/gi,"-").replace(/^-|-$/g,"") || `product-${Date.now()}`;
  // SKU is the strongest key. Without SKU, match only a materially identical
  // card (same source URL or same name + brand + type + format). Similar names
  // with another brand/format remain separate products.
  let existing = null;
  if (record.sku) {
    existing = await db.get("SELECT * FROM store_products WHERE sku=? LIMIT 1", [record.sku]);
  } else if (record.source_url) {
    existing = await db.get("SELECT * FROM store_products WHERE source_url=? AND lower(name)=lower(?) LIMIT 1", [record.source_url, name]);
  } else {
    const sameName = await db.all("SELECT * FROM store_products WHERE lower(name)=lower(?) ORDER BY id", [name]);
    const same = (value) => String(value || "").trim().toLocaleLowerCase("ru-RU");
    existing = sameName.find((item) =>
      same(item.brand) === same(record.brand) &&
      same(item.product_type) === same(record.product_type) &&
      same(item.format) === same(record.format)
    ) || null;
  }
  let productSlug = existing?.slug || slugBase;
  if (!existing) {
    let suffix = 2;
    while (await db.get("SELECT id FROM store_products WHERE slug=? LIMIT 1", [productSlug])) {
      productSlug = slugBase + "-" + String(suffix++);
    }
  }
  const keywordArray = String(record.seo_keywords || "").split(/[;,\n]/).map((v)=>v.trim()).filter(Boolean).slice(0,40);
  const status = ["draft","pending_review","published","archived"].includes(String(record.status || "").trim()) ? String(record.status).trim() : "draft";

  // Проверяем все поля, которые могут завершиться ошибкой, до любых изменений БД.
  // Иначе невалидный JSON варианта мог оставить товар уже созданным, хотя строка
  // импорта считалась пропущенной.
  const variantAttributes = {};
  for (const key of ["taste","volume","strength","color","package","compatibility"]) {
    const value = String(record[key] || "").trim();
    if (value) variantAttributes[key] = value;
  }
  if (record.variant_attributes_json) {
    let parsed;
    try { parsed = JSON.parse(record.variant_attributes_json); }
    catch { throw new Error("атрибуты варианта должны быть корректным JSON-объектом"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("атрибуты варианта должны быть JSON-объектом, а не массивом или примитивом");
    }
    Object.assign(variantAttributes, parsed);
  }
  const volumeRaw = String(record.search_volume ?? "").trim();
  const volume = volumeRaw === "" ? null : Number(volumeRaw.replace(/[\s\u00a0]/g, "").replace(",", "."));
  if (volume !== null && (!Number.isSafeInteger(volume) || volume < 0)) {
    throw new Error("частотность должна быть целым неотрицательным числом");
  }
  const variantName = String(record.variant_name || Object.values(variantAttributes).join(" / ") || "").trim();

  // Категории ищем/создаём только после проверки полей строки: ошибка JSON или
  // частотности не должна оставлять побочные записи от неуспешного импорта.
  const categories = [];
  if (record.category_name) {
    const parentId = await findStoreCategory(record.category_name, null, dryRun);
    if (parentId) {
      categories.push(parentId);
      if (record.subcategory_name) {
        const childId = await findStoreCategory(record.subcategory_name, parentId, dryRun);
        if (childId) categories.push(childId);
      }
    }
  }

  const rawAvailability = String(record.availability_label_raw || existing?.availability_label_raw || "").trim().toLocaleLowerCase("ru-RU");
  const requestedAvailability = String(record.availability_status || "").trim().toLowerCase();
  const inferredAvailability = requestedAvailability in { in_stock: 1, out_of_stock: 1, preorder: 1, unknown: 1 }
    ? requestedAvailability
    : /нет\s+в\s+наличии|отсутств|нет\s+остат/.test(rawAvailability) ? "out_of_stock"
      : /предзаказ|ожидается/.test(rawAvailability) ? "preorder"
        : /в\s+наличии|есть\s+в\s+наличии/.test(rawAvailability) ? "in_stock" : (existing?.availability_status || "unknown");
  const fields = {
    name,
    slug: productSlug,
    sku: record.sku || existing?.sku || "",
    brand: record.brand || existing?.brand || "",
    product_type: record.product_type || existing?.product_type || "",
    format: record.format || existing?.format || "",
    description: record.description || existing?.description || "",
    price_raw: record.price_raw || existing?.price_raw || "",
    old_price_raw: record.old_price_raw || existing?.old_price_raw || "",
    currency: record.currency || existing?.currency || "RUB",
    availability_label_raw: record.availability_label_raw || existing?.availability_label_raw || "",
    availability_status: inferredAvailability,
    source_url: record.source_url || existing?.source_url || "",
    status,
    seo_h1: record.seo_h1 || existing?.seo_h1 || "",
    seo_title: record.seo_title || existing?.seo_title || "",
    seo_description: record.seo_description || existing?.seo_description || "",
    seo_keywords_json: JSON.stringify(keywordArray.length ? keywordArray : (existing?.seo_keywords_json ? JSON.parse(existing.seo_keywords_json) : [])),
    canonical_url: record.canonical_url || existing?.canonical_url || "",
    robots_index: record.robots_index === undefined || record.robots_index === "" ? (existing?.robots_index ?? 1) : (/^(0|false|no|нет)$/i.test(String(record.robots_index).trim()) ? 0 : 1),
    image_search_query: record.image_search_query || `${name}${record.brand ? ` ${record.brand}` : ""}`,
    is_18_plus: parseImportBoolean(record.is_18_plus, existing?.is_18_plus ?? 0, "18+"),
    is_reservable: parseImportBoolean(record.is_reservable, existing?.is_reservable ?? 1, "бронирование"),
    updated_at: nowIso(),
  };
  if (dryRun) return existing ? "updated" : "created";
  let product;
  if (existing) product = await repo.update("store_products", existing.id, fields);
  else product = await repo.insert("store_products", fields);
  if (categories.length) {
    await db.run("DELETE FROM store_product_categories WHERE product_id=?", [product.id]);
    for (const categoryId of categories) await db.run("INSERT INTO store_product_categories(product_id,category_id) VALUES(?,?) ON CONFLICT(product_id,category_id) DO NOTHING", [product.id, categoryId]);
  }
  let savedVariant = null;
  if (variantName || record.variant_sku) {
    const existingVariant = record.variant_sku
      ? await db.get("SELECT * FROM store_product_variants WHERE product_id=? AND sku=? LIMIT 1", [product.id, record.variant_sku])
      : await db.get("SELECT * FROM store_product_variants WHERE product_id=? AND name=? LIMIT 1", [product.id, variantName]);
    const variantFields = {
      product_id:product.id, name:variantName || String(record.variant_sku), sku:record.variant_sku || existingVariant?.sku || "",
      attributes_json:JSON.stringify(variantAttributes), price_raw:record.variant_price_raw || existingVariant?.price_raw || "",
      old_price_raw:record.variant_old_price_raw || existingVariant?.old_price_raw || "", currency:record.currency || existingVariant?.currency || "RUB",
      availability_label_raw:record.variant_availability_label_raw || existingVariant?.availability_label_raw || "", sort_order:existingVariant?.sort_order || 0,
    };
    savedVariant = existingVariant
      ? await repo.update("store_product_variants", existingVariant.id, variantFields)
      : await repo.insert("store_product_variants", variantFields);
  }
  if (record.image_url && (/^https?:\/\//i.test(record.image_url) || /^\/uploads\/catalog\/[a-z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(record.image_url))) {
    const duplicate = savedVariant
      ? await db.get("SELECT id FROM store_product_images WHERE product_id=? AND variant_id=? AND url_original=? LIMIT 1", [product.id, savedVariant.id, record.image_url])
      : await db.get("SELECT id FROM store_product_images WHERE product_id=? AND variant_id IS NULL AND url_original=? LIMIT 1", [product.id, record.image_url]);
    if (!duplicate) await repo.insert("store_product_images", {
      product_id:product.id, variant_id:savedVariant?.id || null, url_original:record.image_url,
      alt_raw:record.image_alt || (savedVariant ? `${name} — ${savedVariant.name}` : name), position:0,
      source_url:record.image_source_url || "", download_status:"unverified",
    });
  }
  const classValue = String(record.frequency_class || "").trim().toLowerCase();
  const normalizedClass = ({ high:"high", medium:"medium", low:"low", unknown:"unknown", "вч":"high", "сч":"medium", "нч":"low" })[classValue] || "unknown";
  const searchEngine = String(record.search_engine || "").trim().slice(0, 80);
  const searchRegion = String(record.search_region || "").trim().slice(0, 120);
  const searchIntent = String(record.search_intent || "").trim().slice(0, 80);
  const searchSource = String(record.search_source || "xlsx import").trim().slice(0, 160);
  const searchCheckedAt = String(record.search_checked_at || "").trim().slice(0, 40);
  if (keywordArray.length && !dryRun) {
    for (const keyword of keywordArray) {
      const normalizeSearchText = (value) => String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
      const existingTargets = await db.all("SELECT * FROM store_keyword_targets WHERE product_id=?", [product.id]);
      const duplicate = existingTargets.find((item) =>
        normalizeSearchText(item.keyword) === normalizeSearchText(keyword) &&
        normalizeSearchText(item.search_engine) === normalizeSearchText(searchEngine) &&
        normalizeSearchText(item.region) === normalizeSearchText(searchRegion)
      );
      const keywordFields = { product_id:product.id, keyword, frequency_class:normalizedClass, search_volume:volume, search_engine:searchEngine, region:searchRegion, search_intent:searchIntent, source:searchSource, checked_at:searchCheckedAt, updated_at:nowIso() };
      if (duplicate) await repo.update("store_keyword_targets", duplicate.id, keywordFields);
      else await repo.insert("store_keyword_targets", keywordFields);
    }
  }
  await logActivity({ type:"import", title:`Товар импортирован: ${name}` }).catch(()=>{});
  return existing ? "updated" : "created";
}

/**
 * Поиск по номеру. Сравниваем нормализованные значения, а не строки из базы:
 * в выгрузках один и тот же телефон записан десятком способов —
 * +7 916 777-00-11, 89167770011, 7(916)7770011.
 */
async function findContactByPhone(rawPhone) {
  if (!rawPhone) return null;
  const matches = await findContactMatches({ phone: rawPhone });
  return matches[0] || null;
}

async function findCompanyIdByName(name) {
  if (!name) return null;
  const existing = await db.get("SELECT id FROM companies WHERE name = ? AND merged_into_id IS NULL", [name]);
  if (existing) return existing.id;
  const created = await repo.insert("companies", { name });
  return created.id;
}

async function upsertContact(record, dryRun) {
  const fullName = record.full_name || [record.last_name, record.first_name].filter(Boolean).join(" ");
  if (!fullName) throw new Error("пустое имя клиента");

  const email = normalizeEmail(record.email);
  const existing =
    (await findContactByPhone(record.phone)) ||
    (email.includes("@") ? await db.get("SELECT * FROM contacts WHERE email = ?", [email]) : null) ||
    null;

  if (dryRun) return existing ? "updated" : "created";

  if (existing) {
    const patch = { updated_at: nowIso() };
    for (const field of ["position", "comment", "tags"]) {
      if (!existing[field] && record[field]) patch[field] = record[field];
    }
    if (!existing.email && email) patch.email = email;
    if (!existing.phone && record.phone) patch.phone = record.phone;
    if (!existing.company_id && record.company_name) patch.company_id = await findCompanyIdByName(record.company_name);
    await repo.update("contacts", existing.id, patch);
    return "updated";
  }

  const contact = await repo.insert("contacts", {
    full_name: fullName,
    phone: record.phone || "",
    email,
    position: record.position || "",
    tags: record.tags || "",
    comment: record.comment || "",
    source: record.source || "import",
    company_id: record.company_name ? await findCompanyIdByName(record.company_name) : null,
  });
  await logActivity({ type: "import", title: "Карточка создана импортом", contact_id: contact.id });
  return "created";
}

async function upsertCompany(record, dryRun) {
  if (!record.name) throw new Error("пустое название компании");
  const inn = normalizeInn(record.inn);
  const existing =
    (inn.length >= 10 && (await db.get("SELECT * FROM companies WHERE inn = ?", [inn]))) ||
    (await db.get("SELECT * FROM companies WHERE name = ?", [record.name])) ||
    null;

  if (dryRun) return existing ? "updated" : "created";

  if (existing) {
    const patch = {};
    for (const field of ["kpp", "ogrn", "legal_address", "website"]) {
      if (!existing[field] && record[field]) patch[field] = record[field];
    }
    if (!existing.inn && inn) patch.inn = inn;
    await repo.update("companies", existing.id, patch);
    return "updated";
  }

  await repo.insert("companies", {
    name: record.name,
    inn,
    kpp: record.kpp || "",
    ogrn: record.ogrn || "",
    legal_address: record.legal_address || "",
    website: record.website || "",
  });
  return "created";
}

async function upsertDeal(record, userId, dryRun) {
  if (!record.title) throw new Error("пустое название сделки");
  if (dryRun) return "created";

  const pipeline = await db.get("SELECT * FROM pipelines WHERE is_default = 1 ORDER BY sort LIMIT 1");
  const stages = pipeline ? await db.all("SELECT * FROM pipeline_stages WHERE pipeline_id = ? ORDER BY sort", [pipeline.id]) : [];
  const wanted = norm(record.stage);
  const stage = stages.find((s) => norm(s.name) === wanted || s.code === record.stage) || stages[0];

  let contactId = (await findContactByPhone(record.contact_phone))?.id ?? null;
  if (!contactId && record.contact_name) {
    const found = await db.get("SELECT id FROM contacts WHERE full_name = ?", [record.contact_name]);
    contactId = found?.id ?? (await repo.insert("contacts", { full_name: record.contact_name, phone: record.contact_phone || "", source: "import" })).id;
  }

  const deal = await repo.insert("deals", {
    title: record.title,
    amount: toNumber(record.amount),
    stage: stage?.code || "new",
    pipeline_id: pipeline?.id ?? null,
    stage_changed_at: nowIso(),
    contact_id: contactId,
    company_id: record.company_name ? await findCompanyIdByName(record.company_name) : null,
    owner_id: userId ?? null,
    source: record.source || "import",
  });
  await logActivity({ type: "import", title: "Сделка создана импортом", deal_id: deal.id, contact_id: contactId });
  return "created";
}
