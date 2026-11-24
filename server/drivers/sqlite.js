/**
 * Драйвер SQLite поверх встроенного модуля node:sqlite (Node 22+).
 * Умолчание для демо, одиночного сервера и небольших команд.
 *
 * Интерфейс намеренно асинхронный, хотя сам node:sqlite синхронный:
 * прикладной код не должен знать, какое хранилище под ним.
 */
import fs from "node:fs";
import path from "node:path";

export async function createSqliteDriver({ file }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (err) {
    throw new Error(
      `Модуль node:sqlite недоступен. Нужен Node.js 22 или новее, текущая версия ${process.version}. ` +
        `Исходная ошибка: ${err.message}`
    );
  }

  const db = new DatabaseSync(file);
  // WAL — параллельное чтение во время записи; foreign_keys — целостность связей.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");

  return {
    kind: "sqlite",
    file,

    async all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },

    async get(sql, params = []) {
      return db.prepare(sql).get(...params) ?? null;
    },

    async run(sql, params = []) {
      const info = db.prepare(sql).run(...params);
      return { lastId: Number(info.lastInsertRowid), changes: Number(info.changes) };
    },

    async exec(sql) {
      db.exec(sql);
    },

    /** Обработчик получает тот же драйвер: в SQLite соединение одно на процесс. */
    async transaction(fn) {
      db.exec("BEGIN");
      try {
        const result = await fn(this);
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    /** Согласованный снимок базы одним файлом — без остановки сервиса. */
    async backupTo(targetFile) {
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.rmSync(targetFile, { force: true });
      db.exec(`VACUUM INTO '${targetFile.replace(/'/g, "''")}'`);
      return targetFile;
    },

    async close() {
      db.close();
    },
  };
}
