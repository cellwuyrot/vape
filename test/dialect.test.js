/** Транслятор диалекта: один SQL должен одинаково работать в SQLite и PostgreSQL. */
import assert from "node:assert/strict";
import test from "node:test";

import { normalizeParam, renderDdl, splitStatements, toPostgres } from "../server/dialect.js";

test("подстановки DDL раскрываются под каждую СУБД", () => {
  const ddl = "CREATE TABLE t (id {{PK}}, amount {{REAL}}, created_at TEXT DEFAULT {{NOW}})";

  const sqlite = renderDdl(ddl, "sqlite");
  assert.match(sqlite, /INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.match(sqlite, /REAL/);
  assert.match(sqlite, /datetime\('now'\)/);

  const postgres = renderDdl(ddl, "postgres");
  assert.match(postgres, /BIGSERIAL PRIMARY KEY/);
  assert.match(postgres, /DOUBLE PRECISION/);
  assert.match(postgres, /now\(\) AT TIME ZONE 'utc'/);

  assert.ok(!renderDdl(ddl, "postgres").includes("{{"), "не должно остаться нераскрытых подстановок");
});

test("неизвестный диалект отвергается, а не молча пропускается", () => {
  assert.throws(() => renderDdl("CREATE TABLE t (id {{PK}})", "mysql"), /Неизвестный диалект/);
});

test("плейсхолдеры нумеруются по порядку", () => {
  assert.equal(
    toPostgres("SELECT * FROM t WHERE a = ? AND b = ? LIMIT ?"),
    "SELECT * FROM t WHERE a = $1 AND b = $2 LIMIT $3"
  );
});

test("вопросительный знак внутри строкового литерала не считается параметром", () => {
  assert.equal(
    toPostgres("SELECT * FROM t WHERE note = 'как дела?' AND id = ?"),
    "SELECT * FROM t WHERE note = 'как дела?' AND id = $1"
  );
});

test("LIKE становится ILIKE: в SQLite поиск регистронезависим", () => {
  assert.match(toPostgres("SELECT * FROM contacts WHERE full_name LIKE ?"), /ILIKE \$1/);
});

test("экранированная кавычка не сбивает разбор строки", () => {
  const sql = "SELECT * FROM t WHERE name = 'ООО ''Ромашка''' AND id = ?";
  assert.match(toPostgres(sql), /\$1/);
  assert.equal((toPostgres(sql).match(/\$\d/g) || []).length, 1);
});

test("файл миграции разбивается на инструкции", () => {
  const sql = `
    -- комментарий; с точкой с запятой
    CREATE TABLE a (id INTEGER);
    INSERT INTO a VALUES (1);
    CREATE INDEX i ON a(id);
  `;
  const statements = splitStatements(sql);
  assert.equal(statements.length, 3);
  assert.match(statements[0], /CREATE TABLE a/);
  assert.match(statements[2], /CREATE INDEX/);
});

test("точка с запятой внутри литерала не разрывает инструкцию", () => {
  const statements = splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 1;");
  assert.equal(statements.length, 2);
  assert.match(statements[0], /'a;b'/);
});

test("параметры приводятся к виду, понятному обеим СУБД", () => {
  assert.equal(normalizeParam(true), 1);
  assert.equal(normalizeParam(false), 0);
  assert.equal(normalizeParam(undefined), null);
  assert.equal(normalizeParam(new Date("2026-08-04T10:00:00.000Z")), "2026-08-04T10:00:00.000Z");
  assert.equal(normalizeParam("текст"), "текст");
  assert.equal(normalizeParam(42), 42);
});
