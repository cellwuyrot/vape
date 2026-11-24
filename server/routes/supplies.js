/** Приём поставок из Excel/CSV: предварительный просмотр → подтверждение → учёт остатков. */
import { audit } from "../auth.js";
import { config } from "../config.js";
import { db, nowIso } from "../db.js";
import { HttpError, clientIp, get, post, rateLimit, readRaw } from "../http.js";
import { parseTable } from "../importer.js";
import { logActivity } from "../activity.js";

const pending = new Map();
const PREVIEW_TTL_MS = 30 * 60_000;
const MAX_ROWS = 5000;

const FIELD_ALIASES = {
  sku: [/sku/i, /артик/, /код\s*(товара|номенклатуры)?/i],
  name: [/наимен/, /номенклат/, /название/i, /товар/i, /product/i],
  quantity: [/колич/, /кол-?во/i, /qty/i, /штук/i],
  unit: [/ед\.\s*изм/i, /единиц/i, /unit/i],
  purchase_price: [/закуп/i, /цена\s*(за\s*)?(ед|шт)/i, /^цена$/i, /price/i],
  line_total: [/сумма/i, /итого/i, /total/i],
  vat_rate: [/ндс/i, /vat/i],
};

const clean = (value, max = 500) => String(value ?? "").trim().slice(0, max);
const number = (value, fallback = 0) => {
  const raw = String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, "").replace(",", ".");
  if (!raw) return fallback;
  const parsed = Number(raw.replace(/[^\d.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
};
const round = (value) => Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;

function detectMapping(headers) {
  const mapping = {};
  for (const [field, patterns] of Object.entries(FIELD_ALIASES)) {
    mapping[field] = headers.findIndex((header) => patterns.some((pattern) => pattern.test(String(header || "").toLowerCase())));
  }
  return mapping;
}

function cleanupPending() {
  const now = Date.now();
  for (const [id, item] of pending) if (now - item.createdAt > PREVIEW_TTL_MS) pending.delete(id);
}

function requireWritable(user) {
  if (user.role === "viewer" || user.role === "visitor") {
    throw new HttpError(403, "Роль не может принимать поставки");
  }
}

get("/api/supplies", async () => ({
  data: await db.all(
    `SELECT s.*, COUNT(i.id) AS item_count
     FROM supplies s LEFT JOIN supply_items i ON i.supply_id=s.id
     GROUP BY s.id ORDER BY s.created_at DESC, s.id DESC LIMIT 500`
  ),
}), { auth: true });

get("/api/supplies/:id", async ({ params }) => {
  const supply = await db.get("SELECT * FROM supplies WHERE id=?", [params.id]);
  if (!supply) throw new HttpError(404, "Поставка не найдена");
  const items = await db.all("SELECT * FROM supply_items WHERE supply_id=? ORDER BY id", [supply.id]);
  return { data: { ...supply, items } };
}, { auth: true });

post("/api/supplies/preview", async ({ req, user }) => {
  requireWritable(user);
  rateLimit(`supply-preview:${user.id}`, 20, 60_000);
  const raw = await readRaw(req, config.storage.maxFileSize);
  if (!raw.length) throw new HttpError(400, "Файл пустой");
  const filename = clean(decodeURIComponent(String(req.headers["x-file-name"] || "supply.csv")).replace(/[\\/]/g, "_"), 180);
  if (!/\.(xlsx|csv|txt)$/i.test(filename) && raw.subarray(0, 2).toString() !== "PK") {
    throw new HttpError(415, "Поддерживаются только .xlsx и .csv. Формат .xls сохраните как .xlsx");
  }

  const table = parseTable(filename, raw);
  if (table.length < 2) throw new HttpError(400, "В таблице должны быть заголовки и хотя бы одна строка товара");
  const headers = table[0].map((value, index) => clean(value, 160) || `Колонка ${index + 1}`);
  const rows = table.slice(1).filter((row) => row.some((value) => String(value ?? "").trim() !== ""));
  if (!rows.length) throw new HttpError(400, "В таблице нет строк с товарами");
  if (rows.length > MAX_ROWS) throw new HttpError(413, `В одной поставке поддерживается не более ${MAX_ROWS} строк`);
  if (headers.length > 100) throw new HttpError(400, "В таблице слишком много колонок (максимум 100)");

  cleanupPending();
  const id = `${user.id}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  const mapping = detectMapping(headers);
  pending.set(id, { userId: user.id, filename, headers, rows, mapping, createdAt: Date.now() });

  return {
    data: {
      preview_id: id,
      filename,
      headers,
      mapping,
      total_rows: rows.length,
      sample: rows.slice(0, 8),
      max_rows: MAX_ROWS,
    },
  };
}, { auth: true, rawBody: true });

post("/api/supplies", async ({ body, user, req }) => {
  requireWritable(user);
  rateLimit(`supply-create:${user.id}`, 30, 60_000);
  const preview = pending.get(String(body.preview_id || ""));
  if (!preview || preview.userId !== user.id || Date.now() - preview.createdAt > PREVIEW_TTL_MS) {
    throw new HttpError(410, "Предпросмотр файла истёк. Загрузите таблицу повторно");
  }

  const supplierName = clean(body.supplier_name, 300);
  if (!supplierName) throw new HttpError(400, "Укажите поставщика");
  const mapping = {};
  for (const field of Object.keys(FIELD_ALIASES)) {
    const value = Number(body.mapping?.[field] ?? preview.mapping[field] ?? -1);
    mapping[field] = Number.isInteger(value) && value >= 0 && value < preview.headers.length ? value : -1;
  }
  if (mapping.name < 0 || mapping.quantity < 0) {
    throw new HttpError(400, "Сопоставьте обязательные колонки «Наименование» и «Количество»");
  }

  const items = [];
  for (let index = 0; index < preview.rows.length; index += 1) {
    const source = preview.rows[index];
    const at = (field) => mapping[field] >= 0 ? String(source[mapping[field]] ?? "").trim() : "";
    const name = clean(at("name"), 500);
    if (!name) continue;
    const quantity = number(at("quantity"), Number.NaN);
    const purchasePrice = number(at("purchase_price"), 0);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new HttpError(400, `Проверьте количество в строке ${index + 2}: требуется число больше нуля`);
    }
    if (!Number.isFinite(purchasePrice) || purchasePrice < 0) {
      throw new HttpError(400, `Проверьте закупочную цену в строке ${index + 2}`);
    }
    const sourceTotal = mapping.line_total >= 0 ? number(at("line_total"), 0) : 0;
    const lineTotal = sourceTotal > 0 ? sourceTotal : quantity * purchasePrice;
    const vatRaw = mapping.vat_rate >= 0 ? number(at("vat_rate"), 20) : 20;
    const vatRate = Number.isFinite(vatRaw) && vatRaw >= 0 && vatRaw <= 100 ? round(vatRaw) : 20;
    const sourceData = Object.fromEntries(preview.headers.map((header, column) => [header, String(source[column] ?? "")]));
    items.push({
      sku: clean(at("sku"), 120), name, quantity: round(quantity),
      unit: clean(at("unit"), 40) || "шт", purchase_price: round(purchasePrice),
      line_total: round(lineTotal), vat_rate: vatRate, source_data: JSON.stringify(sourceData),
    });
  }
  if (!items.length) throw new HttpError(400, "Не удалось распознать товарные строки. Проверьте сопоставление колонок");

  const invoiceNumber = clean(body.invoice_number, 120);
  const invoiceDate = clean(body.invoice_date, 32);
  if (invoiceDate && !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) throw new HttpError(400, "Укажите дату накладной в формате ГГГГ-ММ-ДД");
  const total = round(items.reduce((sum, item) => sum + item.line_total, 0));
  const created = await db.transaction(async (tx) => {
    const year = new Date().getFullYear();
    const count = await tx.get("SELECT COUNT(*) AS n FROM supplies WHERE number LIKE ?", [`П-${year}-%`]);
    const numberText = `П-${year}-${String(Number(count?.n || 0) + 1).padStart(5, "0")}`;
    const result = await tx.run(
      `INSERT INTO supplies (number,supplier_name,invoice_number,invoice_date,source_file,note,total,item_count,matched_items,owner_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [numberText, supplierName, invoiceNumber, invoiceDate, preview.filename, clean(body.note, 2000), total, items.length, 0, user.id, nowIso()]
    );
    const supplyId = result.lastId;
    let matchedItems = 0;
    for (const item of items) {
      let product = null;
      if (item.sku) product = await tx.get("SELECT * FROM products WHERE trim(sku)<>'' AND lower(trim(sku))=lower(?) ORDER BY id LIMIT 1", [item.sku]);
      if (!product) product = await tx.get("SELECT * FROM products WHERE lower(trim(name))=lower(?) ORDER BY id LIMIT 1", [item.name]);
      const productId = product?.id ?? null;
      await tx.run(
        `INSERT INTO supply_items (supply_id,product_id,sku,name,quantity,unit,purchase_price,line_total,vat_rate,source_data,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [supplyId, productId, item.sku, item.name, item.quantity, item.unit, item.purchase_price, item.line_total, item.vat_rate, item.source_data, nowIso()]
      );
      if (product) {
        await tx.run("UPDATE products SET stock=COALESCE(stock,0)+? WHERE id=?", [item.quantity, product.id]);
        matchedItems += 1;
      }
    }
    await tx.run("UPDATE supplies SET matched_items=? WHERE id=?", [matchedItems, supplyId]);
    const supply = await tx.get("SELECT * FROM supplies WHERE id=?", [supplyId]);
    const savedItems = await tx.all("SELECT * FROM supply_items WHERE supply_id=? ORDER BY id", [supplyId]);
    return { ...supply, items: savedItems };
  });

  pending.delete(String(body.preview_id));
  await audit(user.id, "create", "supply", created.id, { number: created.number, item_count: created.item_count, total: created.total }, clientIp(req));
  await logActivity({ type: "note", title: `Принята поставка ${created.number}`, body: `${supplierName} · ${created.item_count} позиций · ${Math.round(created.total)} ₽`, user_id: user.id });
  return { status: 201, data: created };
}, { auth: true });
