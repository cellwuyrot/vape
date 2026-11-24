#!/usr/bin/env node
/**
 * Накат миграций отдельной командой: npm run migrate
 * Нужен, когда схему обновляют до запуска приложения — например,
 * отдельным шагом деплоя, пока старая версия ещё обслуживает трафик.
 */
import { db, initDb } from "../server/db.js";
import { appliedMigrations, loadMigrations, migrate } from "../server/migrate.js";

const driver = await initDb({ runMigrations: false });
const before = await appliedMigrations(driver);
const { applied, version } = await migrate(driver);

process.stdout.write(
  applied.length
    ? `Применено миграций: ${applied.length} (${applied.join(", ")}). Схема: версия ${version}.\n`
    : `Схема уже актуальна: версия ${version}, применено ранее ${before.length}.\n`
);

const known = loadMigrations().map((m) => `${String(m.version).padStart(3, "0")}_${m.name}`);
process.stdout.write(`Миграции в каталоге: ${known.join(", ") || "нет"}\n`);

await db.close();
