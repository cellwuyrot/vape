/** Раннер миграций: версии, идемпотентность, защита от правки применённого файла. */
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSqliteDriver } from "../server/drivers/sqlite.js";
import { appliedMigrations, currentVersion, loadMigrations, migrate } from "../server/migrate.js";

async function sandbox() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rucrm-migrate-"));
  const driver = await createSqliteDriver({ file: path.join(dir, "test.db") });
  return {
    dir,
    driver,
    async cleanup() {
      await driver.close();
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

test("миграции проекта именуются и нумеруются без пропусков", () => {
  const migrations = loadMigrations();
  assert.ok(migrations.length >= 2, "в проекте должны быть как минимум две миграции");
  migrations.forEach((migration, index) => {
    assert.equal(migration.version, index + 1, `версия ${migration.version} нарушает порядок`);
    assert.ok(migration.checksum.length === 16);
  });
});

test("схема проекта накатывается на пустую базу", async () => {
  const box = await sandbox();
  try {
    const { applied, version } = await migrate(box.driver, { silent: true });
    assert.ok(applied.length >= 2);
    assert.equal(await currentVersion(box.driver), version);

    // Таблицы из обеих миграций на месте
    await box.driver.run("INSERT INTO contacts (full_name) VALUES (?)", ["Иванов"]);
    await box.driver.run("INSERT INTO attachments (storage_key, filename) VALUES (?, ?)", ["k1", "f.pdf"]);
    const row = await box.driver.get("SELECT COUNT(*) AS n FROM contacts");
    assert.equal(Number(row.n), 1);
  } finally {
    await box.cleanup();
  }
});

test("повторный накат ничего не делает", async () => {
  const box = await sandbox();
  try {
    const first = await migrate(box.driver, { silent: true });
    const second = await migrate(box.driver, { silent: true });
    assert.ok(first.applied.length > 0);
    assert.deepEqual(second.applied, [], "второй запуск не должен применять миграции повторно");
    assert.equal(first.version, second.version);
  } finally {
    await box.cleanup();
  }
});

test("накатываются только недостающие версии", async () => {
  const box = await sandbox();
  const dir = path.join(box.dir, "migrations");
  await fsp.mkdir(dir);
  await fsp.writeFile(path.join(dir, "001_first.sql"), "CREATE TABLE a (id {{PK}});");

  try {
    await migrate(box.driver, { dir, silent: true });
    await fsp.writeFile(path.join(dir, "002_second.sql"), "CREATE TABLE b (id {{PK}}, note TEXT);");
    const result = await migrate(box.driver, { dir, silent: true });

    assert.deepEqual(result.applied, [2]);
    assert.equal((await appliedMigrations(box.driver)).length, 2);
    await box.driver.run("INSERT INTO b (note) VALUES (?)", ["ок"]);
  } finally {
    await box.cleanup();
  }
});

test("правка уже применённой миграции останавливает запуск", async () => {
  const box = await sandbox();
  const dir = path.join(box.dir, "migrations");
  await fsp.mkdir(dir);
  await fsp.writeFile(path.join(dir, "001_first.sql"), "CREATE TABLE a (id {{PK}});");

  try {
    await migrate(box.driver, { dir, silent: true });
    await fsp.writeFile(path.join(dir, "001_first.sql"), "CREATE TABLE a (id {{PK}}, extra TEXT);");
    await assert.rejects(() => migrate(box.driver, { dir, silent: true }), /содержимое изменилось/);
  } finally {
    await box.cleanup();
  }
});

test("падение внутри миграции откатывает её целиком", async () => {
  const box = await sandbox();
  const dir = path.join(box.dir, "migrations");
  await fsp.mkdir(dir);
  await fsp.writeFile(
    path.join(dir, "001_broken.sql"),
    "CREATE TABLE good (id {{PK}}); CREATE TABLE bad (id {{PK}}, ;"
  );

  try {
    await assert.rejects(() => migrate(box.driver, { dir, silent: true }));
    const table = await box.driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='good'");
    assert.equal(table, null, "успевшая создаться таблица должна быть откачена");
    assert.equal(await currentVersion(box.driver), 0);
  } finally {
    await box.cleanup();
  }
});

test("миграция безопасна для базы, созданной прежней версией приложения", async () => {
  const box = await sandbox();
  try {
    // Имитируем схему 2.0.0: таблица уже есть, реестра версий нет
    await box.driver.exec(
      "CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, phone TEXT DEFAULT '')"
    );
    await box.driver.run("INSERT INTO contacts (full_name, phone) VALUES (?, ?)", ["Старый клиент", "+79990001122"]);

    const { applied } = await migrate(box.driver, { silent: true });
    assert.ok(applied.length >= 2);

    const row = await box.driver.get("SELECT full_name FROM contacts WHERE phone = ?", ["+79990001122"]);
    assert.equal(row.full_name, "Старый клиент", "существующие данные не должны потеряться");
  } finally {
    await box.cleanup();
  }
});
