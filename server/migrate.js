/**
 * Версионные миграции схемы.
 *
 * Файлы лежат в каталоге migrations/ и называются NNN_описание.sql.
 * Применённые версии записываются в таблицу schema_migrations, при старте
 * накатываются только недостающие. Каждая миграция выполняется в транзакции:
 * либо применяется целиком, либо не применяется вовсе.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderDdl, splitStatements } from "./dialect.js";
import { log } from "./logger.js";

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations"
);

const REGISTRY_DDL = {
  sqlite: `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`,
  postgres: `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`,
};

const checksum = (text) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Читает каталог миграций и возвращает их по возрастанию версии. */
export function loadMigrations(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => {
      const match = name.match(/^(\d+)[_-](.+)\.sql$/);
      if (!match) throw new Error(`Файл миграции ${name} должен называться NNN_описание.sql`);
      const sql = fs.readFileSync(path.join(dir, name), "utf8");
      return {
        version: Number(match[1]),
        name: match[2],
        file: name,
        sql,
        checksum: checksum(sql),
      };
    })
    .sort((a, b) => a.version - b.version);
}

export async function currentVersion(driver) {
  await driver.exec(REGISTRY_DDL[driver.kind] || REGISTRY_DDL.sqlite);
  const row = await driver.get("SELECT MAX(version) AS version FROM schema_migrations");
  return Number(row?.version || 0);
}

export async function appliedMigrations(driver) {
  await driver.exec(REGISTRY_DDL[driver.kind] || REGISTRY_DDL.sqlite);
  return driver.all("SELECT * FROM schema_migrations ORDER BY version");
}

/**
 * Накатывает недостающие миграции.
 * @returns {Promise<{applied: number[], version: number}>}
 */
export async function migrate(driver, { dir = MIGRATIONS_DIR, silent = false } = {}) {
  const migrations = loadMigrations(dir);
  const known = await appliedMigrations(driver);
  const byVersion = new Map(known.map((row) => [Number(row.version), row]));

  // Изменённый задним числом файл — источник расхождения схемы между стендами.
  for (const migration of migrations) {
    const record = byVersion.get(migration.version);
    if (record && record.checksum !== migration.checksum) {
      throw new Error(
        `Миграция ${migration.file} уже применена, но её содержимое изменилось ` +
          `(было ${record.checksum}, стало ${migration.checksum}). ` +
          `Не правьте применённые миграции — добавьте новую.`
      );
    }
  }

  const pending = migrations.filter((m) => !byVersion.has(m.version));
  const applied = [];

  for (const migration of pending) {
    const statements = splitStatements(renderDdl(migration.sql, driver.kind));
    await driver.transaction(async (tx) => {
      for (const statement of statements) await tx.exec(statement);
      await tx.run(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        [migration.version, migration.name, migration.checksum, new Date().toISOString()]
      );
    });
    applied.push(migration.version);
    if (!silent) log.info("migration.applied", { version: migration.version, name: migration.name });
  }

  const version = migrations.length ? migrations[migrations.length - 1].version : 0;
  if (!silent && !applied.length) log.debug("migration.up-to-date", { version });
  return { applied, version };
}

/** Список таблиц с данными — нужен бэкапу и проверке восстановления. */
export const DATA_TABLES = [
  "users",
  "verification_codes",
  "companies",
  "contacts",
  "deals",
  "products",
  "orders",
  "order_items",
  "supplies",
  "supply_items",
  "conversations",
  "messages",
  "audit_log",
  "attachments",
  "pipelines",
  "pipeline_stages",
  "lost_reasons",
  "tasks",
  "quick_replies",
  "activities",
  "import_runs",
  "store_reservations",
  "store_analytics_events",
  "store_restock_subscriptions",
  "doc_templates",
];
