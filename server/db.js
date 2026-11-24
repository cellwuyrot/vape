/**
 * Слой доступа к данным.
 *
 * Два драйвера за одним интерфейсом:
 *   • SQLite (node:sqlite) — умолчание, демо и небольшие команды;
 *   • PostgreSQL — включается переменной DATABASE_URL, для боевой эксплуатации.
 *
 * Интерфейс асинхронный: сеть синхронной не бывает, поэтому все вызовы
 * возвращают промисы независимо от выбранного хранилища. Схема создаётся
 * не здесь, а версионными миграциями из каталога migrations/.
 */
import path from "node:path";

import { config } from "./config.js";
import { createSqliteDriver } from "./drivers/sqlite.js";
import { createPostgresDriver } from "./drivers/postgres.js";
import { normalizeParam } from "./dialect.js";
import { migrate } from "./migrate.js";
import { log } from "./logger.js";
import { observeDb } from "./metrics.js";

let driver = null;

/** Оборачивает вызов драйвера в измерение времени: метрика db_query_duration_seconds. */
async function measured(op, fn) {
  const started = process.hrtime.bigint();
  try {
    const result = await fn();
    observeDb(op, Number(process.hrtime.bigint() - started) / 1e9, true);
    return result;
  } catch (err) {
    observeDb(op, Number(process.hrtime.bigint() - started) / 1e9, false);
    throw err;
  }
}

export async function initDb({ runMigrations = true } = {}) {
  if (config.databaseUrl) {
    driver = await createPostgresDriver({ url: config.databaseUrl, poolSize: config.dbPoolSize });
    log.info("db.connected", { kind: "postgres", host: driver.host, database: driver.database });
  } else {
    driver = await createSqliteDriver({ file: path.join(config.dataDir, "rucrm.db") });
    log.info("db.connected", { kind: "sqlite", file: driver.file });
  }

  if (runMigrations) {
    const { applied, version } = await migrate(driver);
    log.info("db.schema", { version, applied: applied.length });
  }
  return driver;
}

export const db = {
  get kind() {
    return driver?.kind;
  },
  get driver() {
    return driver;
  },
  all: (sql, params = []) => measured("all", () => driver.all(sql, params.map(normalizeParam))),
  get: (sql, params = []) => measured("get", () => driver.get(sql, params.map(normalizeParam))),
  run: (sql, params = []) => measured("run", () => driver.run(sql, params.map(normalizeParam))),
  exec: (sql) => measured("exec", () => driver.exec(sql)),
  transaction: (fn) => driver.transaction(fn),
  close: async () => {
    if (driver) await driver.close();
    driver = null;
  },
};

/** Мини-ORM поверх SQL: избавляет роуты от ручной сборки запросов. */
export const repo = {
  async insert(table, data) {
    const keys = Object.keys(data);
    const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
    const { lastId } = await db.run(sql, keys.map((k) => data[k]));
    return this.byId(table, lastId);
  },

  async update(table, id, data) {
    const keys = Object.keys(data);
    if (!keys.length) return this.byId(table, id);
    await db.run(
      `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
      [...keys.map((k) => data[k]), id]
    );
    return this.byId(table, id);
  },

  byId(table, id) {
    return db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  },

  async remove(table, id) {
    await db.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
  },

  list(table, { where = "", params = [], order = "id DESC", limit = 200, offset = 0 } = {}) {
    return db.all(
      `SELECT * FROM ${table} ${where ? `WHERE ${where}` : ""} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
  },

  async count(table, where = "", params = []) {
    const row = await db.get(`SELECT COUNT(*) AS n FROM ${table} ${where ? `WHERE ${where}` : ""}`, params);
    return Number(row?.n || 0);
  },

  async sum(table, column, where = "", params = []) {
    const row = await db.get(
      `SELECT COALESCE(SUM(${column}), 0) AS s FROM ${table} ${where ? `WHERE ${where}` : ""}`,
      params
    );
    return Number(row?.s || 0);
  },
};

export const nowIso = () => new Date().toISOString();
