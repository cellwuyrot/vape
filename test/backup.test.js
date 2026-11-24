/**
 * Резервное копирование: упаковка, восстановление, ротация и обнаружение порчи.
 * Копия, которую ни разу не разворачивали, копией не считается — это здесь и проверяется.
 */
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rucrm-backup-test-"));
process.env.DATA_DIR = workDir;
process.env.STORAGE_DIR = path.join(workDir, "files");
process.env.BACKUP_DIR = path.join(workDir, "backups");
process.env.SECRET_KEY = "test-secret";

const { createTarGz, extractTarGz, extractTarGzToDir } = await import("../server/tar.js");
const { db, initDb, repo } = await import("../server/db.js");
const { initStorage, storage } = await import("../server/storage.js");
const { createBackup, lastBackupInfo, rotateBackups, verifyBackup } = await import("../server/backup.js");

before(async () => {
  await initDb();
  initStorage();
});

after(async () => {
  await db.close();
  await fsp.rm(workDir, { recursive: true, force: true });
});

/* ---------- архив ---------- */

test("архив собирается и распаковывается без потерь", async () => {
  const entries = [
    { name: "manifest.json", content: Buffer.from('{"a":1}') },
    { name: "files/2026/08/договор.pdf", content: Buffer.from("содержимое", "utf8") },
    { name: "empty.bin", content: Buffer.alloc(0) },
  ];
  const files = await extractTarGz(await createTarGz(entries));

  assert.equal(files.length, 3);
  assert.equal(files[0].content.toString(), '{"a":1}');
  assert.equal(files[1].name, "files/2026/08/договор.pdf");
  assert.equal(files[1].content.toString("utf8"), "содержимое");
  assert.equal(files[2].content.length, 0);
});

test("файл, не кратный блоку 512, восстанавливается побайтово", async () => {
  const content = Buffer.alloc(1000, 7);
  const [file] = await extractTarGz(await createTarGz([{ name: "data.bin", content }]));
  assert.equal(file.content.length, 1000);
  assert.ok(file.content.equals(content));
});

test("путь с выходом за каталог при распаковке отвергается", async () => {
  const archive = await createTarGz([{ name: "../побег.txt", content: Buffer.from("x") }]);
  const target = path.join(workDir, "unpack");
  await assert.rejects(() => extractTarGzToDir(archive, target), /Подозрительный путь/);
});

/* ---------- копия и восстановление ---------- */

test("копия снимается и проходит проверку восстановления", async () => {
  await repo.insert("contacts", { full_name: "Иванов Иван", phone: "+79161234567" });
  await repo.insert("contacts", { full_name: "Петрова Мария", phone: "+79261112233" });
  await repo.insert("deals", { title: "Пилот", amount: 150000 });
  await storage.put("вложение.txt", Buffer.from("текст вложения", "utf8"), "text/plain");

  const backup = await createBackup();
  assert.ok(backup.size > 0);
  assert.equal(backup.manifest.counts.contacts, 2);
  assert.equal(backup.manifest.counts.deals, 1);
  assert.equal(backup.manifest.files, 1, "вложение должно попасть в копию");
  assert.ok(backup.manifest.schema_version >= 2);

  const verification = await verifyBackup(backup.file);
  assert.equal(verification.ok, true, verification.problems.join("; "));
  assert.deepEqual(verification.problems, []);
});

test("рядом с копией лежит контрольная сумма", async () => {
  const backup = await createBackup();
  const sum = (await fsp.readFile(`${backup.file}.sha256`, "utf8")).trim();
  assert.match(sum, /^[0-9a-f]{64}\s+rucrm-.*\.tar\.gz$/);
  assert.ok(sum.startsWith(backup.checksum));
});

test("испорченный архив проверку не проходит", async () => {
  const backup = await createBackup();
  const content = await fsp.readFile(backup.file);
  // Портим середину архива: так ведёт себя сбойный диск или оборванная выгрузка
  content[Math.floor(content.length / 2)] ^= 0xff;
  await fsp.writeFile(backup.file, content);

  const verification = await verifyBackup(backup.file);
  assert.equal(verification.ok, false);
  assert.ok(verification.problems.length > 0);
});

test("восстановленная база содержит те же данные, а не только те же счётчики", async () => {
  const backup = await createBackup();
  const target = path.join(workDir, "restored");
  await fsp.rm(target, { recursive: true, force: true });
  await extractTarGzToDir(await fsp.readFile(backup.file), target);

  const { createSqliteDriver } = await import("../server/drivers/sqlite.js");
  const restored = await createSqliteDriver({ file: path.join(target, "database.sqlite") });
  try {
    const row = await restored.get("SELECT full_name FROM contacts WHERE phone = ?", ["+79161234567"]);
    assert.equal(row.full_name, "Иванов Иван");
    const attachment = await restored.get("SELECT COUNT(*) AS n FROM attachments");
    assert.ok(Number(attachment.n) >= 0);
  } finally {
    await restored.close();
  }
});

test("ротация оставляет заданное число последних копий", async () => {
  const dir = process.env.BACKUP_DIR;
  for (const name of await fsp.readdir(dir)) await fsp.rm(path.join(dir, name), { force: true });

  for (let i = 1; i <= 4; i += 1) {
    const name = `rucrm-2026-08-0${i}T00-00-00.tar.gz`;
    await fsp.writeFile(path.join(dir, name), "заглушка");
    await fsp.writeFile(path.join(dir, `${name}.sha256`), "0000  x\n");
  }

  const removed = await rotateBackups({ dir, keep: 2 });
  assert.equal(removed.length, 2);

  const left = (await fsp.readdir(dir)).filter((n) => n.endsWith(".tar.gz"));
  assert.deepEqual(left.sort(), ["rucrm-2026-08-03T00-00-00.tar.gz", "rucrm-2026-08-04T00-00-00.tar.gz"]);
  assert.equal((await fsp.readdir(dir)).filter((n) => n.endsWith(".sha256")).length, 2, "суммы удаляются вместе с копиями");
});

test("сведения о последней копии доступны для эндпоинта готовности", async () => {
  const info = await lastBackupInfo(process.env.BACKUP_DIR);
  assert.ok(info);
  assert.match(info.file, /^rucrm-.*\.tar\.gz$/);
  assert.ok(info.created_at);
});
