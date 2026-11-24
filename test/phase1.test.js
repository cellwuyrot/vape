/**
 * Рутина менеджера: задачи, воронки с обязательными полями, причина отказа,
 * дубли и склейка, шаблоны быстрых ответов, лента активности, печатные формы.
 * Запуск: npm test
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test, { after, before } from "node:test";

process.env.DATA_DIR = "./data-test-phase1";
process.env.SECRET_KEY = "test-secret";
process.env.ORG_NAME = "ООО «Тест»";
fs.rmSync("./data-test-phase1", { recursive: true, force: true });

const { createServer } = await import("../server/index.js");
const { db } = await import("../server/db.js");
const { issueCode } = await import("../server/auth.js");
const server = await createServer();
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://localhost:${server.address().port}`;

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.close();
  await fs.promises.rm("./data-test-phase1", { recursive: true, force: true });
});

let token;

const call = async (path, { method = "GET", body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

before(async () => {
  const user = await db.get("SELECT * FROM users WHERE email=?", ["andycoulbot@gmail.com"]);
  const code = await issueCode(user.id, "email");
  const res = await call("/api/auth/verify-code", { method:"POST", body:{ email:"andycoulbot@gmail.com", code } });
  token = res.data.access_token;
});

/* ---------- Воронки ---------- */

test("миграция создаёт три воронки со своими стадиями", async () => {
  const res = await call("/api/pipelines");
  assert.equal(res.status, 200);
  assert.equal(res.data.length, 3);
  const sales = res.data.find((p) => p.code === "sales");
  assert.equal(sales.is_default, 1);
  assert.equal(sales.stages.length, 6);
  assert.equal(sales.stages.at(-1).kind, "lost");
});

test("новая воронка получает стадии по умолчанию", async () => {
  const created = await call("/api/pipelines", { method: "POST", body: { name: "Партнёры" } });
  assert.equal(created.status, 201);
  assert.equal(created.data.stages.length, 4);
  assert.equal(created.data.stages[0].code, "new");
});

/* ---------- Обязательные поля и причина отказа ---------- */

test("стадия с обязательной суммой не пропускает пустую сделку", async () => {
  const deal = await call("/api/deals", { method: "POST", body: { title: "Без суммы" } });
  assert.equal(deal.status, 201);
  assert.equal(deal.data.stage, "new");

  const blocked = await call(`/api/deals/${deal.data.id}`, { method: "PATCH", body: { stage: "proposal" } });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.detail, /сумма/i);

  const ok = await call(`/api/deals/${deal.data.id}`, {
    method: "PATCH",
    body: { stage: "proposal", amount: 100000 },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.stage, "proposal");
  assert.ok(ok.data.stage_changed_at);
});

test("стадия отказа требует причину из справочника", async () => {
  const deal = await call("/api/deals", { method: "POST", body: { title: "Уйдёт в отказ", amount: 5000 } });
  const blocked = await call(`/api/deals/${deal.data.id}`, { method: "PATCH", body: { stage: "lost" } });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.detail, /причин/i);

  const reasons = await call("/api/lost-reasons");
  assert.ok(reasons.data.length >= 5);

  const closed = await call(`/api/deals/${deal.data.id}`, {
    method: "PATCH",
    body: { stage: "lost", lost_reason_id: reasons.data[0].id },
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.data.lost_reason, reasons.data[0].name);
  assert.ok(closed.data.closed_at);
});

test("выдуманная причина отказа отклоняется", async () => {
  const deal = await call("/api/deals", { method: "POST", body: { title: "Чужая причина", amount: 100 } });
  const res = await call(`/api/deals/${deal.data.id}`, {
    method: "PATCH",
    body: { stage: "lost", lost_reason_id: 99999 },
  });
  assert.equal(res.status, 400);
});

/* ---------- Задачи ---------- */

test("задача ставится, попадает в «сегодня» и закрывается", async () => {
  const contact = await call("/api/contacts", {
    method: "POST",
    body: { full_name: "Задачный Клиент", phone: "+79990001122" },
  });

  const task = await call("/api/tasks", {
    method: "POST",
    body: {
      title: "Перезвонить и уточнить бюджет",
      kind: "call",
      contact_id: contact.data.id,
      due_at: new Date(new Date().setHours(12, 0, 0, 0)).toISOString(),
    },
  });
  assert.equal(task.status, 201);
  assert.equal(task.data.status, "open");

  const today = await call("/api/tasks?scope=today");
  assert.ok(today.data.tasks.some((t) => t.id === task.data.id));
  assert.ok(today.data.counters.today >= 1);

  const done = await call(`/api/tasks/${task.data.id}`, { method: "PATCH", body: { status: "done", result: "Договорились" } });
  assert.equal(done.data.status, "done");
  assert.ok(done.data.completed_at);

  const after = await call("/api/tasks?scope=today");
  assert.ok(!after.data.tasks.some((t) => t.id === task.data.id));
});

test("просроченная задача видна в отдельной выборке", async () => {
  const task = await call("/api/tasks", {
    method: "POST",
    body: { title: "Забытое обещание", due_at: new Date(Date.now() - 7200_000).toISOString() },
  });
  const overdue = await call("/api/tasks?scope=overdue");
  assert.ok(overdue.data.tasks.some((t) => t.id === task.data.id));
  assert.ok(overdue.data.counters.overdue >= 1);
});

test("календарь недели раскладывает задачи по семи дням", async () => {
  const res = await call("/api/tasks/calendar");
  assert.equal(res.status, 200);
  assert.equal(res.data.days.length, 7);
  assert.ok(res.data.days.some((day) => day.tasks.length > 0));
});

test("напоминание уходит один раз и не повторяется при следующем проходе", async () => {
  const { runReminders } = await import("../server/tasks.js");
  const { repo } = await import("../server/db.js");

  const created = await call("/api/tasks", {
    method: "POST",
    body: {
      title: "Напомнить о себе",
      due_at: new Date(Date.now() - 60_000).toISOString(),
      remind_at: new Date(Date.now() - 60_000).toISOString(),
    },
  });

  assert.ok((await runReminders()) >= 1);
  assert.equal((await repo.byId("tasks", created.data.id)).reminded, 1);

  const second = await runReminders();
  assert.equal(second, 0, "повторной рассылки быть не должно");
});

/* ---------- Дубли ---------- */

test("клиент с тем же телефоном в другом формате распознаётся как дубль", async () => {
  const first = await call("/api/contacts", {
    method: "POST",
    body: { full_name: "Сидоров Пётр", phone: "+7 (916) 555-33-11" },
  });
  assert.equal(first.status, 201);

  const blocked = await call("/api/contacts", {
    method: "POST",
    body: { full_name: "Сидоров П.", phone: "89165553311" },
  });
  assert.equal(blocked.status, 409);

  const forced = await call("/api/contacts", {
    method: "POST",
    body: { full_name: "Сидоров П.", phone: "89165553311", force: true },
  });
  assert.equal(forced.status, 201);

  const check = await call("/api/contacts/check?phone=8%20916%20555-33-11");
  assert.ok(check.data.matches.length >= 2);

  const duplicates = await call("/api/duplicates?entity=contacts");
  const group = duplicates.data.groups.find((g) => g.items.some((i) => i.id === forced.data.id));
  assert.ok(group, "группа дублей должна найтись");
  assert.equal(group.reason, "phone");
});

test("склейка переносит сделки и историю в основную карточку", async () => {
  const target = await call("/api/contacts", { method: "POST", body: { full_name: "Основная", phone: "+79161110001" } });
  const source = await call("/api/contacts", {
    method: "POST",
    body: { full_name: "Дубль", phone: "+79161110001", email: "dubl@example.ru", force: true },
  });
  await call("/api/deals", { method: "POST", body: { title: "Сделка дубля", contact_id: source.data.id } });

  const merged = await call(`/api/contacts/${source.data.id}/merge`, {
    method: "POST",
    body: { into: target.data.id },
  });
  assert.equal(merged.status, 200);
  assert.equal(merged.data.email, "dubl@example.ru", "пустое поле основной карточки заполняется из донора");

  const card = await call(`/api/contacts/${target.data.id}`);
  assert.ok(card.data.deals.some((d) => d.title === "Сделка дубля"));
  assert.ok(card.data.feed.some((item) => item.kind === "merge"));

  const list = await call("/api/contacts");
  assert.ok(!list.data.some((c) => c.id === source.data.id), "склеенная карточка не показывается в списке");
});

/* ---------- Лента активности ---------- */

test("лента клиента собирает сделки, задачи, заметки и переписку", async () => {
  const contact = await call("/api/contacts", { method: "POST", body: { full_name: "Ленточный", phone: "+79162220002" } });
  const deal = await call("/api/deals", { method: "POST", body: { title: "Сделка для ленты", contact_id: contact.data.id, amount: 1000 } });
  await call("/api/tasks", { method: "POST", body: { title: "Позвонить", contact_id: contact.data.id } });
  await call(`/api/contacts/${contact.data.id}/notes`, { method: "POST", body: { body: "Просил перезвонить после обеда", type: "call" } });
  await call(`/api/deals/${deal.data.id}`, { method: "PATCH", body: { stage: "qualified" } });

  const feed = await call(`/api/contacts/${contact.data.id}/feed`);
  const kinds = feed.data.map((item) => item.kind);
  assert.ok(kinds.includes("deal"));
  assert.ok(kinds.includes("task"));
  assert.ok(kinds.includes("call"));
  assert.ok(kinds.includes("stage"));
});

/* ---------- Быстрые ответы ---------- */

test("шаблоны быстрых ответов есть из коробки и считают применения", async () => {
  const list = await call("/api/quick-replies");
  assert.ok(list.data.length >= 5);

  const used = await call(`/api/quick-replies/${list.data[0].id}`, { method: "PATCH", body: { used: true } });
  assert.equal(used.data.used_count, 1);

  const created = await call("/api/quick-replies", {
    method: "POST",
    body: { title: "Тестовый", shortcut: "тест", body: "Текст" },
  });
  assert.equal(created.status, 201);
});

/* ---------- Печатные формы ---------- */

test("счёт формируется с позициями, НДС и суммой прописью", async () => {
  const contact = await call("/api/contacts", { method: "POST", body: { full_name: "Плательщик", phone: "+79163330003" } });
  const order = await call("/api/orders", {
    method: "POST",
    body: { contact_id: contact.data.id, items: [{ name: "Час работ", quantity: 2, price: 4500 }] },
  });
  assert.equal(order.data.total, 9000);

  const invoice = await call("/api/documents/render", { method: "POST", body: { code: "invoice", order_id: order.data.id } });
  assert.equal(invoice.status, 200);
  assert.match(invoice.data.html, /Счёт на оплату/);
  assert.match(invoice.data.html, /Час работ/);
  assert.match(invoice.data.html, /Девять тысяч рублей 00 копеек/);
  assert.match(invoice.data.html, /ООО «Тест»/);
  assert.ok(!invoice.data.html.includes("{{"), "в готовом документе не остаётся подстановок");
});

test("коммерческое предложение формируется прямо из сделки", async () => {
  const deal = await call("/api/deals", { method: "POST", body: { title: "КП из сделки", amount: 120000 } });
  const quote = await call("/api/documents/render", { method: "POST", body: { code: "quote", deal_id: deal.data.id } });
  assert.equal(quote.status, 200);
  assert.match(quote.data.html, /Коммерческое предложение/);
  assert.match(quote.data.html, /КП из сделки/);
});

/* ---------- Импорт ---------- */

test("импорт CSV распознаёт колонки и не плодит дубли", async () => {
  const csv = [
    "Полное имя;Рабочий телефон;E-mail;Компания;Должность",
    "Импортов Иван;+7 916 777-00-11;import@example.ru;ООО «Импорт»;Директор",
    "Импортова Анна;+7 916 777-00-22;anna@example.ru;ООО «Импорт»;Бухгалтер",
  ].join("\n");

  const preview = await fetch(`${base}/api/import/preview?entity=contacts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/csv",
      "X-File-Name": encodeURIComponent("base.csv"),
    },
    body: csv,
  }).then((r) => r.json());

  assert.equal(preview.total, 2);
  assert.equal(preview.mapping[0], "full_name");
  assert.equal(preview.mapping[1], "phone");
  assert.equal(preview.mapping[2], "email");

  const dry = await call("/api/import/apply", {
    method: "POST",
    body: { id: preview.id, mapping: preview.mapping, dry_run: true },
  });
  assert.equal(dry.data.created, 2);
  assert.equal(dry.data.updated, 0);

  const applied = await call("/api/import/apply", { method: "POST", body: { id: preview.id, mapping: preview.mapping } });
  assert.equal(applied.data.created, 2);

  const list = await call("/api/contacts?q=Импортов");
  assert.ok(list.data.some((c) => c.full_name === "Импортов Иван"));

  const runs = await call("/api/import/runs");
  assert.ok(runs.data.some((run) => run.filename === "base.csv"));
});

test("повторный импорт того же файла дополняет карточки, а не создаёт новые", async () => {
  const csv = [
    "Полное имя;Рабочий телефон;Комментарий",
    "Импортов Иван;8 (916) 777-00-11;Ключевой клиент",
  ].join("\n");

  const preview = await fetch(`${base}/api/import/preview?entity=contacts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/csv", "X-File-Name": "again.csv" },
    body: csv,
  }).then((r) => r.json());

  const applied = await call("/api/import/apply", { method: "POST", body: { id: preview.id, mapping: preview.mapping } });
  assert.equal(applied.data.created, 0);
  assert.equal(applied.data.updated, 1);
});

test("устаревший предпросмотр импорта не применяется", async () => {
  const res = await call("/api/import/apply", { method: "POST", body: { id: "нет-такого", mapping: {} } });
  assert.equal(res.status, 410);
});

/* ---------- Аналитика ---------- */

test("сводка отдаёт воронку выбранной воронки, счётчики задач и причины отказа", async () => {
  const stats = await call("/api/stats?pipeline=sales");
  assert.equal(stats.status, 200);
  assert.ok(stats.data.funnel.proposal.name);
  assert.ok(typeof stats.data.tasks.today === "number");
  assert.ok(stats.data.lost_reasons.length >= 1);
});
