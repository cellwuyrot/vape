#!/usr/bin/env node
/**
 * Снятие резервной копии вручную или по внешнему расписанию (cron, systemd-timer).
 * Запуск: npm run backup
 *
 * Полный цикл: копия → проверка восстановления → ротация → выгрузка в S3.
 * Код возврата 1 означает, что копию снять не удалось либо она не прошла проверку, —
 * на это можно повесить алерт в мониторинге.
 */
import { db, initDb } from "../server/db.js";
import { initStorage } from "../server/storage.js";
import { runBackupCycle } from "../server/backup.js";

await initDb({ runMigrations: false });
initStorage();

try {
  const result = await runBackupCycle();
  const mb = (result.size / 1024 / 1024).toFixed(2);
  process.stdout.write(`Копия: ${result.file} (${mb} МБ), проверка восстановления: ${result.verified ? "пройдена" : "ПРОВАЛЕНА"}\n`);
  if (!result.verified) {
    for (const problem of result.problems) process.stdout.write(`  — ${problem}\n`);
  }
  await db.close();
  process.exit(result.verified ? 0 : 1);
} catch (err) {
  process.stderr.write(`Резервное копирование не выполнено: ${err.message}\n`);
  await db.close().catch(() => {});
  process.exit(1);
}
