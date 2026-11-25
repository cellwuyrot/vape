#!/usr/bin/env node
// По умолчанию только отчёт. --apply заполняет country лишь при однозначном
// суффиксе названия варианта, не объединяет и не удаляет записи.
import fs from "node:fs";
import path from "node:path";
import { config } from "../server/config.js";
import { db, initDb } from "../server/db.js";
import { countryFromName, countryFromAttributes } from "../server/catalog-country.js";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--apply" && !arg.startsWith("--report="))) throw new Error("Используйте --report=/путь/report.json и при необходимости --apply");
const reportArg = args.find((arg) => arg.startsWith("--report="));
if (!reportArg || !reportArg.slice(9)) throw new Error("Укажите --report=/путь/report.json (вне проекта)");
const apply = args.includes("--apply");
if (!config.databaseUrl && !fs.existsSync(path.join(config.dataDir, "rucrm.db"))) throw new Error("База SQLite не найдена. Проверьте рабочий каталог и DATA_DIR; пустая база не создаётся.");
await initDb({ runMigrations: false });
try {
  const products = await db.all("SELECT id,name,slug,sku,brand,product_type,status FROM store_products ORDER BY id");
  const variants = await db.all("SELECT id,product_id,name,sku,attributes_json FROM store_product_variants ORDER BY id");
  const changes = []; const warnings = []; const groups = new Map();
  for (const product of products) {
    const found = countryFromName(product.name);
    if (!found) continue;
    const key = `${found.base.toLocaleLowerCase("ru-RU")}\u0000${String(product.brand || "").trim().toLocaleLowerCase("ru-RU")}\u0000${String(product.product_type || "").trim().toLocaleLowerCase("ru-RU")}`;
    const list = groups.get(key) || []; list.push({ ...product, country_label: found.country, proposed_base: found.base }); groups.set(key, list);
  }
  for (const variant of variants) {
    const found = countryFromName(variant.name);
    if (!found) continue;
    let attributes;
    try { attributes = JSON.parse(variant.attributes_json || "{}"); } catch { warnings.push({ variant_id: variant.id, reason: "Некорректный JSON" }); continue; }
    if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) { warnings.push({ variant_id: variant.id, reason: "JSON не является объектом" }); continue; }
    const current = countryFromAttributes(attributes);
    if (current) {
      if (current.toLocaleLowerCase("ru-RU") !== found.country.toLocaleLowerCase("ru-RU")) warnings.push({ variant_id: variant.id, reason: "Страна в названии и атрибутах различается", current, detected: found.country });
      continue;
    }
    changes.push({ variant_id: variant.id, product_id: variant.product_id, name: variant.name, country: found.country, before_json: variant.attributes_json, after_json: JSON.stringify({ ...attributes, country: found.country }) });
  }
  const report = { version: 1, mode: apply ? "apply-planned" : "preview", created_at: new Date().toISOString(), note: "Страна — исходная подпись, не подтверждение происхождения. Группы кандидатов требуют ручной проверки и не объединяются.", changes, warnings, product_candidates: [...groups.values()] };
  // Создаём отчёт до записи, не перезаписываем существующий.
  fs.writeFileSync(reportArg.slice(9), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  if (apply) await db.transaction(async (tx) => {
    for (const item of changes) {
      const before = await tx.get("SELECT attributes_json FROM store_product_variants WHERE id=?", [item.variant_id]);
      if (!before || before.attributes_json !== item.before_json) throw new Error(`Вариант ${item.variant_id} изменился: обновление отменено`);
      await tx.run("UPDATE store_product_variants SET attributes_json=? WHERE id=?", [item.after_json, item.variant_id]);
    }
  });
  process.stdout.write(`Стран к заполнению: ${changes.length}; конфликтов: ${warnings.length}; групп для проверки: ${groups.size}. ${apply ? "Изменения применены." : "База не изменена."}\n`);
} finally { await db.close(); }
