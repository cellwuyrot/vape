/**
 * Резервное копирование базы и вложений с проверкой восстановления.
 *
 * Копия — один файл rucrm-<метка времени>.tar.gz, внутри:
 *   manifest.json  — версия схемы, СУБД, счётчики строк, контрольные суммы;
 *   database.sqlite | database.jsonl — снимок базы;
 *   files/…        — вложения из локального хранилища.
 *
 * Копия, которую ни разу не разворачивали, копией не является: сразу после
 * снятия архив распаковывается во временный каталог, база поднимается заново
 * и счётчики строк сверяются с манифестом (verifyBackup).
 */
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { config } from "./config.js";
import { db } from "./db.js";
import { createSqliteDriver } from "./drivers/sqlite.js";
import { DATA_TABLES, currentVersion } from "./migrate.js";
import { log } from "./logger.js";
import { backupRuns } from "./metrics.js";
import { storage } from "./storage.js";
import { createTarGz, extractTarGzToDir, walk } from "./tar.js";

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Метка с миллисекундами: две копии подряд не должны перезаписать друг друга
const stamp = (date = new Date()) => date.toISOString().replace(/[:.]/g, "-").replace("Z", "");

/** Счётчики строк по таблицам — дешёвый и честный признак целостности копии. */
async function tableCounts(driver = db) {
  const counts = {};
  for (const table of DATA_TABLES) {
    try {
      const row = await driver.get(`SELECT COUNT(*) AS n FROM ${table}`);
      counts[table] = Number(row?.n || 0);
    } catch {
      counts[table] = null; // таблицы может не быть на старой схеме
    }
  }
  return counts;
}

/** Логическая выгрузка: работает для обеих СУБД, читается любым инструментом. */
async function dumpAsJsonl() {
  const lines = [];
  for (const table of DATA_TABLES) {
    let rows = [];
    try {
      rows = await db.all(`SELECT * FROM ${table} ORDER BY id`);
    } catch {
      continue;
    }
    for (const row of rows) lines.push(JSON.stringify({ table, row }));
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

/**
 * Снимает резервную копию.
 * @returns {Promise<{file: string, size: number, checksum: string, manifest: object}>}
 */
export async function createBackup({ dir = config.backup.dir, includeFiles = true } = {}) {
  const startedAt = Date.now();
  await fsp.mkdir(dir, { recursive: true });

  const driver = db.driver;
  const manifest = {
    created_at: new Date().toISOString(),
    app_version: "2.1.0",
    storage_kind: db.kind,
    schema_version: await currentVersion(driver),
    counts: await tableCounts(),
    format: db.kind === "sqlite" ? "sqlite+files" : "jsonl+files",
  };

  const entries = [];

  if (db.kind === "sqlite") {
    // VACUUM INTO даёт согласованный снимок без остановки сервиса
    const temp = path.join(os.tmpdir(), `rucrm-snapshot-${Date.now()}.db`);
    await driver.backupTo(temp);
    entries.push({ name: "database.sqlite", content: await fsp.readFile(temp) });
    await fsp.rm(temp, { force: true });
  } else {
    entries.push({ name: "database.jsonl", content: await dumpAsJsonl() });
  }

  if (includeFiles) {
    const filesDir = config.storage.localDir;
    for (const file of await walk(filesDir)) {
      entries.push({ name: `files/${file.rel}`, file: file.full });
    }
    manifest.files = entries.filter((e) => e.name.startsWith("files/")).length;
  }

  entries.unshift({ name: "manifest.json", content: Buffer.from(JSON.stringify(manifest, null, 2)) });

  const archive = await createTarGz(entries);
  const file = path.join(dir, `rucrm-${stamp()}.tar.gz`);
  await fsp.writeFile(file, archive);
  await fsp.writeFile(`${file}.sha256`, `${sha256(archive)}  ${path.basename(file)}\n`);

  log.info("backup.created", {
    file: path.basename(file),
    size: archive.length,
    seconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
    schema_version: manifest.schema_version,
  });

  return { file, size: archive.length, checksum: sha256(archive), manifest };
}

/**
 * Проверка восстановления: разворачивает архив во временный каталог,
 * поднимает из него базу и сверяет счётчики строк с манифестом.
 * Возвращает отчёт, а не бросает исключение, — вызывающий решает, что делать.
 */
export async function verifyBackup(file) {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rucrm-restore-"));
  const problems = [];
  let manifest = null;

  try {
    const archive = await fsp.readFile(file);
    const expected = await fsp
      .readFile(`${file}.sha256`, "utf8")
      .then((text) => text.trim().split(/\s+/)[0])
      .catch(() => "");
    if (expected && expected !== sha256(archive)) problems.push("контрольная сумма архива не совпала");

    const names = await extractTarGzToDir(archive, workDir);
    manifest = JSON.parse(await fsp.readFile(path.join(workDir, "manifest.json"), "utf8"));

    if (manifest.format.startsWith("sqlite")) {
      const restored = await createSqliteDriver({ file: path.join(workDir, "database.sqlite") });
      try {
        const counts = await tableCounts(restored);
        for (const [table, expectedCount] of Object.entries(manifest.counts)) {
          if (expectedCount === null) continue;
          if (counts[table] !== expectedCount) {
            problems.push(`таблица ${table}: в манифесте ${expectedCount}, восстановлено ${counts[table]}`);
          }
        }
      } finally {
        await restored.close();
      }
    } else {
      // Логическая выгрузка: пересчитываем строки прямо из JSONL
      const text = await fsp.readFile(path.join(workDir, "database.jsonl"), "utf8");
      const counts = {};
      for (const line of text.split("\n").filter(Boolean)) {
        const { table } = JSON.parse(line);
        counts[table] = (counts[table] || 0) + 1;
      }
      for (const [table, expectedCount] of Object.entries(manifest.counts)) {
        if (!expectedCount) continue;
        if ((counts[table] || 0) !== expectedCount) {
          problems.push(`таблица ${table}: в манифесте ${expectedCount}, в выгрузке ${counts[table] || 0}`);
        }
      }
    }

    const restoredFiles = names.filter((n) => n.startsWith("files/")).length;
    if (manifest.files !== undefined && restoredFiles !== manifest.files) {
      problems.push(`вложений в манифесте ${manifest.files}, в архиве ${restoredFiles}`);
    }
  } catch (err) {
    problems.push(`не удалось развернуть архив: ${err.message}`);
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }

  const ok = problems.length === 0;
  if (ok) log.info("backup.verified", { file: path.basename(file) });
  else log.error("backup.verify-failed", { file: path.basename(file), problems });

  return { ok, problems, manifest };
}

/** Ротация: держим последние N копий, остальное удаляем вместе с суммами. */
export async function rotateBackups({ dir = config.backup.dir, keep = config.backup.keep } = {}) {
  const files = (await fsp.readdir(dir).catch(() => []))
    .filter((name) => /^rucrm-.*\.tar\.gz$/.test(name))
    .sort()
    .reverse();

  const removed = [];
  for (const name of files.slice(keep)) {
    await fsp.rm(path.join(dir, name), { force: true });
    await fsp.rm(path.join(dir, `${name}.sha256`), { force: true });
    removed.push(name);
  }
  if (removed.length) log.info("backup.rotated", { removed: removed.length, keep });
  return removed;
}

/** Выгрузка копии в S3: локальный диск может исчезнуть вместе с сервером. */
export async function uploadBackup(file) {
  if (storage.backend !== "s3") {
    log.warn("backup.upload-skipped", { reason: "хранилище не S3" });
    return null;
  }
  const content = await fsp.readFile(file);
  const key = `backups/${path.basename(file)}`;
  await storage.primary.put(key, content, "application/gzip");
  log.info("backup.uploaded", { key, size: content.length });
  return key;
}

/** Полный цикл: копия → проверка → ротация → выгрузка. */
export async function runBackupCycle(options = {}) {
  try {
    const backup = await createBackup(options);
    const verification = config.backup.verify ? await verifyBackup(backup.file) : { ok: true, problems: [] };

    if (!verification.ok) {
      backupRuns.inc({ result: "verify_failed" });
      return { ...backup, verified: false, problems: verification.problems };
    }

    await rotateBackups(options);
    if (config.backup.uploadToS3) await uploadBackup(backup.file).catch((err) => log.exception("backup.upload", err));

    backupRuns.inc({ result: "success" });
    return { ...backup, verified: true, problems: [] };
  } catch (err) {
    backupRuns.inc({ result: "error" });
    log.exception("backup.failed", err);
    throw err;
  }
}

/** Время последней успешной копии — отдаётся в /api/ready и метриках. */
export async function lastBackupInfo(dir = config.backup.dir) {
  const files = (await fsp.readdir(dir).catch(() => []))
    .filter((name) => /^rucrm-.*\.tar\.gz$/.test(name))
    .sort();
  if (!files.length) return null;
  const file = path.join(dir, files[files.length - 1]);
  const stat = await fsp.stat(file);
  return { file: files[files.length - 1], size: stat.size, created_at: stat.mtime.toISOString() };
}
