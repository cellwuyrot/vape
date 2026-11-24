/**
 * Транслятор диалекта SQL.
 *
 * Прикладной код пишет один вариант запроса — с плейсхолдерами `?` и в синтаксисе SQLite.
 * Здесь он приводится к тому, что понимает конкретная СУБД. Всё, что расходится между
 * SQLite и PostgreSQL, живёт в этом файле и нигде больше.
 */

/** Подстановки в файлах миграций: одна схема — две СУБД. */
const DDL_TOKENS = {
  sqlite: {
    "{{PK}}": "INTEGER PRIMARY KEY AUTOINCREMENT",
    "{{NOW}}": "(datetime('now'))",
    "{{REAL}}": "REAL",
  },
  postgres: {
    "{{PK}}": "BIGSERIAL PRIMARY KEY",
    // Формат хранения дат единый для обеих СУБД: ISO-строка в TEXT.
    "{{NOW}}": "(to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'))",
    "{{REAL}}": "DOUBLE PRECISION",
  },
};

export function renderDdl(sql, kind) {
  const tokens = DDL_TOKENS[kind];
  if (!tokens) throw new Error(`Неизвестный диалект: ${kind}`);
  return Object.entries(tokens).reduce(
    (acc, [token, value]) => acc.split(token).join(value),
    sql
  );
}

/** Разбивает файл миграции на отдельные инструкции, не спотыкаясь о ';' внутри строк. */
export function splitStatements(sql) {
  const statements = [];
  let current = "";
  let inString = false;
  let inLineComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (!inString && ch === "-" && next === "-") {
      inLineComment = true;
      current += ch;
      continue;
    }
    if (ch === "'") {
      // '' внутри строки — экранированная кавычка, а не её конец
      if (inString && next === "'") {
        current += "''";
        i += 1;
        continue;
      }
      inString = !inString;
      current += ch;
      continue;
    }
    if (ch === ";" && !inString) {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());
  return statements.filter((s) => !/^(--[^\n]*\n?)*$/.test(s));
}

/**
 * Приводит рабочий запрос к диалекту PostgreSQL:
 *   ? → $1, $2, …   (вопросительные знаки внутри строковых литералов не трогаем)
 *   LIKE → ILIKE     (в SQLite LIKE регистронезависим, в PostgreSQL — нет)
 */
export function toPostgres(sql) {
  let out = "";
  let index = 0;
  let inString = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'") {
      if (inString && sql[i + 1] === "'") {
        out += "''";
        i += 1;
        continue;
      }
      inString = !inString;
      out += ch;
      continue;
    }
    if (ch === "?" && !inString) {
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += ch;
  }

  return out.replace(/\bLIKE\b/gi, "ILIKE");
}

/**
 * Значения на входе в драйвер. SQLite не знает boolean и Date,
 * PostgreSQL ждёт текстовое представление — приводим одинаково для обеих.
 */
export function normalizeParam(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}
