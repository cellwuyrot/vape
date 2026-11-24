/**
 * Интеграционный прогон против живого PostgreSQL.
 *
 * Запускается только когда задан DATABASE_URL — в CI это делает отдельная задача
 * с сервисом postgres, локально хватит `docker compose up -d postgres`:
 *
 *   DATABASE_URL=postgres://rucrm:rucrm@localhost:5432/rucrm npm test
 *
 * Смысл теста — не проверить SQL ещё раз, а убедиться, что собственный драйвер
 * ведёт себя ровно так же, как SQLite: те же типы, те же идентификаторы, тот же поиск.
 */
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

const url = process.env.DATABASE_URL || "";
const enabled = /^postgres(ql)?:\/\//.test(url);

describe("PostgreSQL", { skip: enabled ? false : "DATABASE_URL не задан — интеграционный прогон пропущен" }, () => {
  let driver;
  let schema;

  before(async () => {
    const { createPostgresDriver } = await import("../server/drivers/postgres.js");
    const { migrate } = await import("../server/migrate.js");

    // Тест владеет собственной схемой и не трогает боевые данные
    schema = `rucrm_test_${Date.now()}`;
    const bootstrap = await createPostgresDriver({ url, poolSize: 1 });
    await bootstrap.exec(`CREATE SCHEMA ${schema}`);
    await bootstrap.close();

    // search_path передаётся при подключении: в пуле у каждого соединения он свой
    const scopedUrl = new URL(url);
    scopedUrl.searchParams.set("search_path", schema);
    driver = await createPostgresDriver({ url: scopedUrl.toString(), poolSize: 4 });
    await migrate(driver, { silent: true });
  });

  after(async () => {
    if (!driver) return;
    await driver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await driver.close();
  });

  test("схема подключения передана в startup-сообщении", async () => {
    const row = await driver.get("SELECT current_schema() AS schema");
    assert.equal(row.schema, schema);
  });

  test("подключение живо и схема накачена", async () => {
    const row = await driver.get("SELECT 1 AS ok");
    assert.equal(row.ok, 1);
    const version = await driver.get("SELECT MAX(version) AS v FROM schema_migrations");
    assert.ok(Number(version.v) >= 2);
  });

  test("INSERT возвращает идентификатор без ручного RETURNING", async () => {
    const result = await driver.run("INSERT INTO contacts (full_name, phone) VALUES (?, ?)", [
      "Иванов Иван",
      "+79161234567",
    ]);
    assert.ok(result.lastId > 0, "драйвер обязан подставить RETURNING id сам");
    assert.equal(result.changes, 1);

    const row = await driver.get("SELECT * FROM contacts WHERE id = ?", [result.lastId]);
    assert.equal(row.full_name, "Иванов Иван");
  });

  test("типы совпадают с поведением SQLite", async () => {
    const { lastId } = await driver.run("INSERT INTO deals (title, amount, stage) VALUES (?, ?, ?)", [
      "Пилот",
      150000.5,
      "new",
    ]);
    const deal = await driver.get("SELECT * FROM deals WHERE id = ?", [lastId]);

    assert.equal(typeof deal.id, "number");
    assert.equal(typeof deal.amount, "number", "денежная сумма приходит числом, а не строкой");
    assert.equal(deal.amount, 150000.5);
    assert.equal(deal.closed_at, null, "пустая дата — null, а не пустая строка");
    assert.equal(typeof deal.created_at, "string");
  });

  test("логическое значение хранится как 0/1 — одинаково в обеих СУБД", async () => {
    const { lastId } = await driver.run("INSERT INTO contacts (full_name, pd_consent) VALUES (?, ?)", [
      "Петрова",
      true,
    ]);
    const row = await driver.get("SELECT pd_consent FROM contacts WHERE id = ?", [lastId]);
    assert.equal(Number(row.pd_consent), 1);
  });

  test("поиск по LIKE остаётся регистронезависимым", async () => {
    await driver.run("INSERT INTO contacts (full_name) VALUES (?)", ["Сидоров Пётр"]);
    const rows = await driver.all("SELECT * FROM contacts WHERE full_name LIKE ?", ["%сидоров%"]);
    assert.equal(rows.length, 1, "в PostgreSQL LIKE регистрозависим — драйвер обязан подставить ILIKE");
  });

  test("UPDATE сообщает число изменённых строк", async () => {
    const { lastId } = await driver.run("INSERT INTO deals (title) VALUES (?)", ["Для обновления"]);
    const updated = await driver.run("UPDATE deals SET stage = ? WHERE id = ?", ["won", lastId]);
    assert.equal(updated.changes, 1);
    const missing = await driver.run("UPDATE deals SET stage = ? WHERE id = ?", ["won", 999999]);
    assert.equal(missing.changes, 0);
  });

  test("транзакция откатывается целиком", async () => {
    const before = Number((await driver.get("SELECT COUNT(*) AS n FROM deals")).n);
    await assert.rejects(() =>
      driver.transaction(async (tx) => {
        await tx.run("INSERT INTO deals (title) VALUES (?)", ["Откатится"]);
        throw new Error("сбой посреди операции");
      })
    );
    const after = Number((await driver.get("SELECT COUNT(*) AS n FROM deals")).n);
    assert.equal(after, before, "вставка внутри упавшей транзакции не должна сохраниться");
  });

  test("нарушение уникальности приходит осмысленной ошибкой", async () => {
    await driver.run("INSERT INTO orders (number) VALUES (?)", ["2026-00001"]);
    await assert.rejects(
      () => driver.run("INSERT INTO orders (number) VALUES (?)", ["2026-00001"]),
      (err) => err.code === "23505"
    );
  });

  test("пул выдерживает параллельные запросы", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => driver.get("SELECT ? AS n", [i]))
    );
    assert.equal(results.length, 20);
    assert.deepEqual(results.map((r) => String(r.n)), Array.from({ length: 20 }, (_, i) => String(i)));
  });

  test("повторный накат миграций на PostgreSQL ничего не меняет", async () => {
    const { migrate } = await import("../server/migrate.js");
    const result = await migrate(driver, { silent: true });
    assert.deepEqual(result.applied, []);
  });
});
