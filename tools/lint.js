#!/usr/bin/env node
/**
 * Линтер проекта — без ESLint и без единого пакета из npm.
 *
 * Проверяет не стиль (его держит договорённость в команде), а то,
 * что реально ломает продакшен:
 *   • синтаксис каждого файла (node --check);
 *   • забытый await на вызове слоя данных — после перехода на PostgreSQL
 *     такой вызов вернёт промис и молча сохранит «[object Promise]»;
 *   • console.log в серверном коде вместо структурированного логгера;
 *   • подстановка значения в SQL вместо параметра — прямой путь к инъекции;
 *   • незакрытые отладочные конструкции: debugger, .only в тестах;
 *   • появление внешних зависимостей в package.json.
 *
 * Запуск: npm run lint
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["server", "test", "tools", "scripts", "public/js", "storefront-react/src", "storefront-react"];
// Не анализируем сторонние пакеты и генерируемые каталоги: правила проекта
// (в частности sql-injection) предназначены только для исходного кода VAPELAB.
// node_modules может содержать строки/шаблоны, похожие на SQL, но это не SQL
// запросы приложения и их нельзя исправлять патчами внутри зависимостей.
const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", ".originkit", ".vite", ".next",
  "dist", "build", "coverage", "vendor",
]);

const problems = [];
const report = (file, line, rule, message) =>
  problems.push({ file: path.relative(ROOT, file), line, rule, message });

/* ------------------------------------------------------------------ */

function collect(dir) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  const out = [];
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) out.push(...collect(child));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(path.join(ROOT, child));
    }
  }
  return out;
}

/** Вырезает строки, шаблоны, регулярные выражения и комментарии: правила проверяют код, а не текст. */
function stripLiterals(line) {
  if (/^\s*(\*|\/\*)/.test(line)) return ""; // строка блочного комментария
  return line
    .replace(/\/\/.*$/, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/\/(?![/*])(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuyd]*/g, "/re/");
}

/* ------------------------------------------------------------------ */
/*  Правила                                                            */
/* ------------------------------------------------------------------ */

const DB_CALL = /(?<![\w.$])(?:db\.(?:all|get|run|exec)|repo\.(?:insert|update|byId|remove|list|count|sum))\s*\(/;

/** Слой данных асинхронный: вызов без await и без явной передачи промиса — ошибка. */
function ruleAwaitedDbCalls(file, lines) {
  // db.js — определения самих методов, drivers/ — сторонний синхронный API node:sqlite
  if (/server[/\\](db|migrate)\.js$/.test(file) || /server[/\\]drivers[/\\]/.test(file)) return;
  lines.forEach((raw, index) => {
    const line = stripLiterals(raw);
    const match = DB_CALL.exec(line);
    if (!match) return;

    const before = line.slice(0, match.index).trimEnd();
    const previous = stripLiterals(lines[index - 1] || "").trimEnd();
    const allowed =
      // перенос строки после стрелки или return: `const f = (x) =>\n  db.get(...)`
      (before === "" && /(=>|return|\(|,)$/.test(previous)) ||
      /\bawait$/.test(before) ||
      /\breturn$/.test(before) ||
      /=>$/.test(before) ||
      /[([,]$/.test(before) ||
      /\b(?:Promise\.(?:all|allSettled|race)|then|catch)\s*\($/.test(before);

    if (!allowed) {
      report(file, index + 1, "await-db", `вызов ${match[0].trim()} без await — вернётся промис`);
    }
  });
}

/** В сервере должен использоваться структурированный логгер, иначе логи не разобрать машинно. */
function ruleNoConsoleInServer(file, lines) {
  if (!/[/\\]server[/\\]/.test(file)) return;
  if (/server[/\\](seed|logger)\.js$/.test(file)) return; // сидер и сам логгер пишут напрямую
  lines.forEach((raw, index) => {
    if (/(?<![\w.])console\.(log|info|warn|error|debug)\s*\(/.test(stripLiterals(raw))) {
      report(file, index + 1, "no-console", "используйте log.* из server/logger.js");
    }
  });
}

/** Значение, вклеенное в SQL, — потенциальная инъекция. Разрешены только имена таблиц и колонок. */
function ruleNoSqlInterpolation(file, lines) {
  // Проверяем только подстановки ВНУТРИ SQL template literal.
  // Параметры вида [`%${q}%`] рядом со статическим SQL безопасны и передаются отдельно.
  if (/server[/\\]db\.js$/.test(file)) return;
  const SQL_KEYWORD = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WHERE|VALUES)\b/i;
  const SAFE_EXPRESSIONS = new Set(["table", "column", "order", "where", "whereSql", "conditionSql", "condition", "sql"]);
  lines.forEach((raw, index) => {
    const templates = raw.match(/`(?:[^`\\]|\\.)*`/g) || [];
    for (const template of templates) {
      if (!SQL_KEYWORD.test(template)) continue;
      const interpolations = template.match(/\$\{[^}]+\}/g) || [];
      for (const item of interpolations) {
        const expression = item.slice(2, -1).trim();
        const safe = SAFE_EXPRESSIONS.has(expression) || /^[A-Z_]+$/.test(expression) || /\b(map|join|padStart)\s*\(/.test(expression);
        if (!safe) report(file, index + 1, "sql-injection", `подстановка ${item} в SQL — используйте параметр ?`);
      }
    }
  });
}

/** Отладочные хвосты не должны попадать в основную ветку. */
function ruleNoDebugLeftovers(file, lines) {
  lines.forEach((raw, index) => {
    const line = stripLiterals(raw);
    if (/(?<![\w.])debugger\b/.test(line)) report(file, index + 1, "no-debugger", "остался debugger");
    if (/\b(?:test|it|describe)\.only\s*\(/.test(line)) {
      report(file, index + 1, "no-only", ".only скрывает остальные тесты");
    }
    if (/\bprocess\.exit\(/.test(line) && /[/\\]server[/\\]routes[/\\]/.test(file)) {
      report(file, index + 1, "no-exit", "process.exit в обработчике роняет весь сервис");
    }
  });
}

/** Обещание «ставится без доступа к npm» держится только на пустом списке зависимостей. */
function ruleNoDependencies() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const allowedRuntime = new Set(["imapflow", "mailparser"]);
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const names = Object.keys(pkg[field] || {});
    const unexpected = field === "dependencies" ? names.filter((name) => !allowedRuntime.has(name)) : names;
    if (unexpected.length) {
      report(path.join(ROOT, "package.json"), 0, "no-deps", `${field}: ${unexpected.join(", ")} — неожиданная внешняя зависимость`);
    }
  }
}

/** Каждая миграция должна называться NNN_имя.sql, версии не должны повторяться. */
function ruleMigrationNames() {
  const dir = path.join(ROOT, "migrations");
  if (!fs.existsSync(dir)) return;
  const seen = new Map();
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".sql"))) {
    const match = name.match(/^(\d{3})_[a-z0-9_]+\.sql$/);
    if (!match) {
      report(path.join(dir, name), 0, "migration-name", "ожидается имя вида 003_add_tasks.sql");
      continue;
    }
    if (seen.has(match[1])) {
      report(path.join(dir, name), 0, "migration-dup", `версия ${match[1]} уже занята файлом ${seen.get(match[1])}`);
    }
    seen.set(match[1], name);
  }
}

/* ------------------------------------------------------------------ */

const files = [...new Set(SCAN_DIRS.flatMap(collect))];

for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    const detail = String(err.stderr || err.message).split("\n").slice(0, 3).join(" ").trim();
    report(file, 0, "syntax", detail);
    continue; // разбирать по строкам файл с синтаксической ошибкой бессмысленно
  }

  const lines = fs.readFileSync(file, "utf8").split("\n");
  ruleAwaitedDbCalls(file, lines);
  ruleNoConsoleInServer(file, lines);
  ruleNoSqlInterpolation(file, lines);
  ruleNoDebugLeftovers(file, lines);
}

ruleNoDependencies();
ruleMigrationNames();

if (!problems.length) {
  process.stdout.write(`Линтер: проверено файлов — ${files.length}, замечаний нет.\n`);
  process.exit(0);
}

process.stdout.write(`Линтер нашёл ${problems.length} замечаний:\n\n`);
for (const p of problems) {
  process.stdout.write(`  ${p.file}:${p.line}  [${p.rule}]  ${p.message}\n`);
}
process.stdout.write("\n");
process.exit(1);
