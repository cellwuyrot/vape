#!/usr/bin/env node
/**
 * Проверка восстановления существующей копии: npm run restore-check [файл]
 *
 * Без аргумента берётся последняя копия из BACKUP_DIR. Архив разворачивается
 * во временный каталог, база поднимается заново, счётчики строк сверяются
 * с манифестом. Ничего в рабочей системе при этом не меняется.
 */
import path from "node:path";
import { config } from "../server/config.js";
import { lastBackupInfo, verifyBackup } from "../server/backup.js";

const argument = process.argv[2];
let file = argument;

if (!file) {
  const last = await lastBackupInfo();
  if (!last) {
    process.stderr.write(`В каталоге ${config.backup.dir} нет ни одной копии.\n`);
    process.exit(1);
  }
  file = path.join(config.backup.dir, last.file);
}

process.stdout.write(`Проверяю восстановление: ${file}\n`);
const result = await verifyBackup(file);

if (result.manifest) {
  const { created_at: createdAt, storage_kind: kind, schema_version: schema } = result.manifest;
  process.stdout.write(`  снята ${createdAt}, СУБД ${kind}, схема версии ${schema}\n`);
}

if (result.ok) {
  process.stdout.write("Восстановление проверено: копия пригодна.\n");
  process.exit(0);
}

process.stdout.write("Копия НЕ прошла проверку:\n");
for (const problem of result.problems) process.stdout.write(`  — ${problem}\n`);
process.exit(1);
