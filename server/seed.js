/** Демо-данные: клиенты, сделки, заказ и живая переписка из мессенджеров. */
import { initDb, repo, db } from "./db.js";
import { ensureAdmin } from "./auth.js";
import { ingest } from "./inbox.js";
import { ensureTemplates } from "./documents.js";

await initDb();
await ensureAdmin();
await ensureTemplates();

if (await repo.count("contacts") > 0) {
  console.log("Данные уже есть — сидинг пропущен. Очистить: npm run reset");
  process.exit(0);
}

const company = await repo.insert("companies", {
  name: 'ООО «Северный Ветер»', inn: "7701234567", kpp: "770101001",
  legal_address: "Москва, ул. Тверская, 12", edo_operator_id: "2BM",
});

for (const p of [
  { sku: "SRV-001", name: "Внедрение CRM, час работ", price: 4500, unit: "час" },
  { sku: "LIC-010", name: "Лицензия рабочего места, год", price: 12000 },
  { sku: "SUP-001", name: "Техподдержка, месяц", price: 25000, unit: "мес" },
]) await repo.insert("products", p);

const ivanov = await repo.insert("contacts", {
  full_name: "Иванов Иван", phone: "+79161234567", email: "ivanov@severwind.ru",
  position: "Коммерческий директор", company_id: company.id, source: "webform",
  pd_consent: 1, pd_consent_at: new Date().toISOString(),
});
const petrova = await repo.insert("contacts", {
  full_name: "Петрова Мария", phone: "+79261112233", email: "maria@retail.ru",
  source: "telegram", pd_consent: 1, pd_consent_at: new Date().toISOString(),
});

const sales = await db.get("SELECT * FROM pipelines WHERE code = ?", ["sales"]);
const admin = await db.get("SELECT * FROM users WHERE role IN (?, ?) ORDER BY id LIMIT 1", ["superadmin", "admin"]);
const dealIds = [];

for (const d of [
  { title: "Внедрение CRM для отдела продаж", stage: "proposal", amount: 450000, contact_id: ivanov.id, company_id: company.id, next_step: "Согласовать состав работ" },
  { title: "Лицензии на 20 рабочих мест", stage: "negotiation", amount: 240000, contact_id: petrova.id, source: "telegram", next_step: "Дожать по цене" },
  { title: "Годовая техподдержка", stage: "won", amount: 300000, contact_id: ivanov.id, company_id: company.id },
  { title: "Пилот на 5 менеджеров", stage: "new", amount: 60000, contact_id: petrova.id },
]) {
  const deal = await repo.insert("deals", {
    ...d, pipeline_id: sales?.id ?? null, owner_id: admin?.id ?? null,
    stage_changed_at: new Date().toISOString(),
  });
  dealIds.push(deal.id);
}

const hours = (n) => new Date(Date.now() + n * 3600_000).toISOString();
for (const t of [
  { title: "Позвонить Иванову и подтвердить КП", kind: "call", due_at: hours(2), contact_id: ivanov.id, deal_id: dealIds[0] },
  { title: "Отправить счёт на техподдержку", kind: "email", due_at: hours(-3), contact_id: ivanov.id, deal_id: dealIds[2] },
  { title: "Встреча с Петровой по лицензиям", kind: "meeting", due_at: hours(26), contact_id: petrova.id, deal_id: dealIds[1] },
]) {
  await repo.insert("tasks", {
    ...t, status: "open", priority: "normal", remind_at: t.due_at,
    assignee_id: admin?.id ?? null, author_id: admin?.id ?? null,
  });
}

const order = await repo.insert("orders", {
  number: `${new Date().getFullYear()}-00001`, status: "confirmed",
  contact_id: ivanov.id, company_id: company.id, total: 57000,
});
await repo.insert("order_items", { order_id: order.id, name: "Внедрение CRM, час работ", quantity: 8, price: 4500 });
await repo.insert("order_items", { order_id: order.id, name: "Техподдержка, месяц", quantity: 1, price: 21000 });

await ingest({
  channel_type: "telegram", external_chat_id: "555001", external_message_id: "1",
  text: "Здравствуйте! Интересует внедрение CRM на 20 человек. Что входит в стоимость?",
  contact_name: "Петрова Мария", contact_phone: "+79261112233",
});
await ingest({
  channel_type: "whatsapp", external_chat_id: "79031234455", external_message_id: "2",
  text: "Добрый день, пришлите, пожалуйста, счёт на техподдержку до конца недели.",
  contact_name: "Сидоров Пётр", contact_phone: "+79031234455",
});
await ingest({
  channel_type: "avito", external_chat_id: "u2288", external_message_id: "3",
  text: "Актуально ли предложение? Готов обсудить сегодня.",
  contact_name: "Кузнецов Артём",
});

console.log(
  `Демо-данные загружены: ${await repo.count("contacts")} клиентов, ` +
  `${await repo.count("deals")} сделок, ${await repo.count("tasks")} задачи, ` +
  `${await repo.count("conversations")} диалога.`
);
