/** Клиенты, компании, сделки, товары, заказы, дубли, лента активности, поиск, аналитика. */
import { db, nowIso, repo } from "../db.js";
import { audit } from "../auth.js";
import { HttpError, clientIp, del, get, patch, post, put } from "../http.js";
import { contactFeed, dealFeed, logActivity } from "../activity.js";
import {
  duplicateReason, findCompanyMatches, findContactMatches, mergeContacts, scanDuplicates,
} from "../dedupe.js";
import { assertStageAllowed, defaultPipeline, resolvePipeline, stageByCode, stagesOf } from "../pipelines.js";
import { taskCounters } from "../tasks.js";

export const ORDER_STATUSES = ["draft", "confirmed", "paid", "shipped", "done", "canceled"];

const like = (q) => `%${String(q).trim()}%`;
const canWrite = (user) => {
  if (user.role === "viewer") throw new HttpError(403, "Роль «наблюдатель» не может изменять данные");
};

/* ---------- Компании ---------- */
get("/api/companies", async ({ query }) => {
  const q = query.get("q");
  return {
    data: q
      ? await db.all("SELECT * FROM companies WHERE name LIKE ? OR inn LIKE ? ORDER BY id DESC LIMIT 200", [like(q), like(q)])
      : await repo.list("companies"),
  };
}, { auth: true });

post("/api/companies", async ({ body, user }) => {
  canWrite(user);
  if (!body.name) throw new HttpError(400, "Укажите название компании");

  const matches = await findCompanyMatches({ inn: body.inn, name: body.name });
  if (matches.length && !body.force) {
    throw new HttpError(
      409,
      `Похожая компания уже есть: ${matches.map((m) => m.name).join(", ")}. ` +
        "Повторите сохранение, если это разные организации"
    );
  }

  const company = await repo.insert("companies", {
    name: body.name, inn: body.inn || "", kpp: body.kpp || "", ogrn: body.ogrn || "",
    legal_address: body.legal_address || "", edo_operator_id: body.edo_operator_id || "",
    website: body.website || "",
  });
  return { status: 201, data: company };
}, { auth: true });

/* ---------- Клиенты ---------- */
get("/api/contacts", async ({ query }) => {
  const q = query.get("q");
  return {
    data: q
      ? await db.all(
          `SELECT * FROM contacts
           WHERE merged_into_id IS NULL AND (full_name LIKE ? OR phone LIKE ? OR email LIKE ? OR tags LIKE ?)
           ORDER BY id DESC LIMIT 200`,
          [like(q), like(q), like(q), like(q)]
        )
      : await repo.list("contacts", { where: "merged_into_id IS NULL" }),
  };
}, { auth: true });

/** Подсказка при создании: клиент с таким телефоном или почтой уже есть. */
get("/api/contacts/check", async ({ query }) => ({
  data: {
    matches: await findContactMatches({
      phone: query.get("phone"),
      email: query.get("email"),
      excludeId: query.get("exclude"),
    }),
  },
}), { auth: true });

/** Пакетная проверка базы: группы карточек-кандидатов на склейку. */
get("/api/duplicates", async ({ query }) => {
  const entity = query.get("entity") === "companies" ? "companies" : "contacts";
  const groups = await scanDuplicates(entity);
  return { data: { entity, groups: groups.map((g) => ({ ...g, reason_label: duplicateReason(g.reason) })) } };
}, { auth: true });

post("/api/contacts", async ({ body, user, req }) => {
  canWrite(user);
  if (!body.full_name) throw new HttpError(400, "Укажите имя клиента");

  const matches = await findContactMatches({ phone: body.phone, email: body.email });
  if (matches.length && !body.force) {
    throw new HttpError(
      409,
      `Такой клиент уже есть: ${matches.map((m) => `${m.full_name} (#${m.id})`).join(", ")}. ` +
        "Откройте карточку или сохраните повторно, если это разные люди"
    );
  }

  const contact = await repo.insert("contacts", {
    full_name: body.full_name,
    phone: body.phone || "", email: body.email || "", position: body.position || "",
    source: body.source || "manual", tags: body.tags || "", comment: body.comment || "",
    company_id: body.company_id ?? null,
    owner_id: body.owner_id ?? user.id,
    pd_consent: body.pd_consent ? 1 : 0,
    pd_consent_at: body.pd_consent ? nowIso() : null,
  });
  await audit(user.id, "create", "contact", contact.id, null, clientIp(req));
  await logActivity({ type: "note", title: "Карточка клиента создана", contact_id: contact.id, user_id: user.id });
  return { status: 201, data: contact };
}, { auth: true });

get("/api/contacts/:id", async ({ params, user, req }) => {
  const contact = await repo.byId("contacts", params.id);
  if (!contact) throw new HttpError(404, "Клиент не найден");
  await audit(user.id, "read", "contact", contact.id, null, clientIp(req));
  return {
    data: {
      ...contact,
      company: contact.company_id ? await repo.byId("companies", contact.company_id) : null,
      deals: await db.all("SELECT * FROM deals WHERE contact_id = ? ORDER BY id DESC", [contact.id]),
      orders: await db.all("SELECT * FROM orders WHERE contact_id = ? ORDER BY id DESC", [contact.id]),
      conversations: await db.all("SELECT * FROM conversations WHERE contact_id = ? ORDER BY last_message_at DESC", [contact.id]),
      tasks: await db.all("SELECT * FROM tasks WHERE contact_id = ? AND status = 'open' ORDER BY due_at", [contact.id]),
      feed: await contactFeed(contact.id),
    },
  };
}, { auth: true });

put("/api/contacts/:id", async ({ params, body, user, req }) => {
  canWrite(user);
  const contact = await repo.byId("contacts", params.id);
  if (!contact) throw new HttpError(404, "Клиент не найден");
  const updated = await repo.update("contacts", contact.id, {
    full_name: body.full_name ?? contact.full_name,
    phone: body.phone ?? contact.phone,
    email: body.email ?? contact.email,
    position: body.position ?? contact.position,
    tags: body.tags ?? contact.tags,
    comment: body.comment ?? contact.comment,
    company_id: body.company_id === undefined ? contact.company_id : body.company_id,
    pd_consent: body.pd_consent ? 1 : 0,
    pd_consent_at: body.pd_consent ? contact.pd_consent_at || nowIso() : null,
    updated_at: nowIso(),
  });
  await audit(user.id, "update", "contact", contact.id, null, clientIp(req));
  return { data: updated };
}, { auth: true });

/** Склейка дублей: история донора переезжает в основную карточку. */
post("/api/contacts/:id/merge", async ({ params, body, user, req }) => {
  if (!["superadmin", "admin", "manager"].includes(user.role)) throw new HttpError(403, "Склейка карточек доступна руководителю");
  if (!body.into) throw new HttpError(400, "Укажите карточку, в которую объединяем");
  const target = await mergeContacts(params.id, body.into, user.id);
  await audit(user.id, "merge", "contact", params.id, { into: body.into }, clientIp(req));
  return { data: target };
}, { auth: true });

/** Заметка в ленту клиента: то, что менеджер раньше писал на полях блокнота. */
post("/api/contacts/:id/notes", async ({ params, body, user }) => {
  canWrite(user);
  const contact = await repo.byId("contacts", params.id);
  if (!contact) throw new HttpError(404, "Клиент не найден");
  if (!body.body) throw new HttpError(400, "Пустая заметка");
  await logActivity({
    type: body.type === "call" ? "call" : "note",
    title: body.title || (body.type === "call" ? "Звонок" : "Заметка"),
    body: body.body,
    contact_id: contact.id,
    deal_id: body.deal_id ?? null,
    user_id: user.id,
  });
  return { status: 201, data: { feed: await contactFeed(contact.id) } };
}, { auth: true });

get("/api/contacts/:id/feed", async ({ params }) => ({ data: await contactFeed(params.id) }), { auth: true });

del("/api/contacts/:id", async ({ params, user, req }) => {
  if (!["superadmin", "admin", "manager"].includes(user.role)) throw new HttpError(403, "Недостаточно прав");
  await repo.remove("contacts", params.id);
  await audit(user.id, "delete", "contact", params.id, null, clientIp(req));
  return { status: 204, data: null };
}, { auth: true });

/* ---------- Сделки ---------- */

/** Воронка из запроса: принимаем и код, и числовой идентификатор. */
async function pipelineFromQuery(query) {
  const raw = query?.get("pipeline");
  if (!raw) return null;
  const byCode = await db.get("SELECT id FROM pipelines WHERE code = ?", [raw]);
  return byCode?.id ?? (Number(raw) || null);
}

get("/api/deals", async ({ query }) => {
  const pipelineId = await pipelineFromQuery(query);
  const rows = pipelineId
    ? await repo.list("deals", { where: "pipeline_id = ?", params: [pipelineId], limit: 500 })
    : await repo.list("deals", { limit: 500 });
  return { data: rows };
}, { auth: true });

post("/api/deals", async ({ body, user }) => {
  canWrite(user);
  if (!body.title) throw new HttpError(400, "Укажите название сделки");

  const pipeline = await resolvePipeline(body.pipeline_id);
  const stages = await stagesOf(pipeline.id);
  const stage = stages.find((s) => s.code === body.stage) || stages[0];
  if (!stage) throw new HttpError(500, "В воронке нет ни одной стадии");

  const draft = {
    title: body.title,
    amount: Number(body.amount) || 0,
    contact_id: body.contact_id ?? null,
    company_id: body.company_id ?? null,
    next_step: body.next_step || "",
  };
  const closing = await assertStageAllowed(stage, draft, body);

  const deal = await repo.insert("deals", {
    ...draft,
    stage: stage.code,
    pipeline_id: pipeline.id,
    stage_changed_at: nowIso(),
    owner_id: user.id,
    source: body.source || "manual",
    lost_reason_id: closing.lost_reason_id,
    lost_reason: closing.lost_reason,
    closed_at: ["won", "lost"].includes(stage.kind) ? nowIso() : null,
  });

  await logActivity({
    type: "deal",
    title: `Создана сделка «${deal.title}»`,
    body: `Воронка «${pipeline.name}», стадия «${stage.name}»`,
    contact_id: deal.contact_id,
    company_id: deal.company_id,
    deal_id: deal.id,
    user_id: user.id,
  });
  return { status: 201, data: deal };
}, { auth: true });

get("/api/deals/:id", async ({ params }) => {
  const deal = await repo.byId("deals", params.id);
  if (!deal) throw new HttpError(404, "Сделка не найдена");
  return {
    data: {
      ...deal,
      contact: deal.contact_id ? await repo.byId("contacts", deal.contact_id) : null,
      tasks: await db.all("SELECT * FROM tasks WHERE deal_id = ? ORDER BY status, due_at", [deal.id]),
      feed: await dealFeed(deal.id),
    },
  };
}, { auth: true });

patch("/api/deals/:id", async ({ params, body, user, req }) => {
  canWrite(user);
  const deal = await repo.byId("deals", params.id);
  if (!deal) throw new HttpError(404, "Сделка не найдена");

  const patchData = {};
  if (body.title) patchData.title = body.title;
  if (body.amount !== undefined) patchData.amount = Number(body.amount) || 0;
  if (body.next_step !== undefined) patchData.next_step = String(body.next_step).slice(0, 500);
  if (body.contact_id !== undefined) patchData.contact_id = body.contact_id;
  if (body.company_id !== undefined) patchData.company_id = body.company_id;

  let stage = null;
  if (body.pipeline_id && Number(body.pipeline_id) !== Number(deal.pipeline_id)) {
    const pipeline = await resolvePipeline(body.pipeline_id);
    const stages = await stagesOf(pipeline.id);
    stage = stages.find((s) => s.code === body.stage) || stages[0];
    patchData.pipeline_id = pipeline.id;
  } else if (body.stage && body.stage !== deal.stage) {
    const pipelineId = deal.pipeline_id ?? (await defaultPipeline()).id;
    stage = await stageByCode(pipelineId, body.stage);
    if (!stage) throw new HttpError(400, "В этой воронке нет такой стадии");
  }

  if (stage) {
    // Обязательные поля проверяем по итоговому состоянию сделки, а не по телу запроса
    const closing = await assertStageAllowed(stage, { ...deal, ...patchData }, body);
    patchData.stage = stage.code;
    patchData.stage_changed_at = nowIso();
    patchData.lost_reason_id = closing.lost_reason_id;
    patchData.lost_reason = closing.lost_reason;
    patchData.closed_at = ["won", "lost"].includes(stage.kind) ? nowIso() : null;
  }

  const updated = await repo.update("deals", deal.id, patchData);
  await audit(user.id, "update", "deal", deal.id, patchData, clientIp(req));

  if (stage) {
    await logActivity({
      type: "stage",
      title: `Стадия: ${stage.name}`,
      body: stage.kind === "lost" ? `Причина отказа: ${patchData.lost_reason}` : "",
      contact_id: updated.contact_id,
      deal_id: deal.id,
      user_id: user.id,
    });
  }
  return { data: updated };
}, { auth: true });

/* ---------- Товары ---------- */
get("/api/products", async () => ({ data: await repo.list("products", { where: "is_active = 1", order: "name" }) }), { auth: true });

post("/api/products", async ({ body, user }) => {
  canWrite(user);
  if (!body.name) throw new HttpError(400, "Укажите наименование");
  return {
    status: 201,
    data: await repo.insert("products", {
      name: body.name, sku: body.sku || "", price: Number(body.price) || 0,
      vat_rate: Number(body.vat_rate ?? 20), unit: body.unit || "шт",
      stock: Number(body.stock) || 0, marking_required: body.marking_required ? 1 : 0,
    }),
  };
}, { auth: true });

/* ---------- Заказы ---------- */
const withItems = async (order) => ({
  ...order,
  items: await db.all("SELECT * FROM order_items WHERE order_id = ?", [order.id]),
});

get("/api/orders", async () => {
  const orders = await repo.list("orders", { limit: 500 });
  return { data: await Promise.all(orders.map(withItems)) };
}, { auth: true });

post("/api/orders", async ({ body, user, req }) => {
  canWrite(user);
  const items = Array.isArray(body.items) ? body.items.filter((i) => i.name) : [];
  const total = items.reduce((sum, i) => sum + Number(i.quantity || 0) * Number(i.price || 0), 0);
  const year = new Date().getFullYear();
  const number = `${year}-${String(await repo.count("orders") + 1).padStart(5, "0")}`;

  const order = await repo.insert("orders", {
    number,
    status: ORDER_STATUSES.includes(body.status) ? body.status : "draft",
    contact_id: body.contact_id ?? null, company_id: body.company_id ?? null,
    deal_id: body.deal_id ?? null, owner_id: user.id,
    total: Math.round(total * 100) / 100, comment: body.comment || "",
  });
  for (const item of items) {
    await repo.insert("order_items", {
      order_id: order.id, product_id: item.product_id ?? null, name: item.name,
      quantity: Number(item.quantity) || 1, price: Number(item.price) || 0,
      vat_rate: Number(item.vat_rate ?? 20),
    });
  }
  await audit(user.id, "create", "order", order.id, null, clientIp(req));
  await logActivity({
    type: "order",
    title: `Заказ № ${order.number}`,
    body: `Сумма ${Math.round(order.total)} ₽`,
    contact_id: order.contact_id,
    company_id: order.company_id,
    deal_id: order.deal_id,
    order_id: order.id,
    user_id: user.id,
  });
  return { status: 201, data: await withItems(order) };
}, { auth: true });

patch("/api/orders/:id", async ({ params, body, user }) => {
  canWrite(user);
  const order = await repo.byId("orders", params.id);
  if (!order) throw new HttpError(404, "Заказ не найден");
  if (body.status && !ORDER_STATUSES.includes(body.status)) throw new HttpError(400, "Неизвестный статус");
  const updated = await repo.update("orders", order.id, body.status ? { status: body.status } : {});
  if (body.status) {
    await logActivity({
      type: "order",
      title: `Заказ № ${order.number}: новый статус`,
      body: body.status,
      contact_id: order.contact_id,
      order_id: order.id,
      user_id: user.id,
    });
  }
  return { data: await withItems(updated) };
}, { auth: true });

/* ---------- Сквозной поиск ---------- */
get("/api/search", async ({ query, user, req }) => {
  const q = String(query.get("q") || "").trim();
  if (q.length < 2) return { data: { contacts: [], companies: [], deals: [], orders: [], conversations: [], tasks: [] } };
  await audit(user.id, "search", "global", "", { q }, clientIp(req));
  const p = like(q);
  return {
    data: {
      contacts: await db.all(
        `SELECT * FROM contacts
         WHERE merged_into_id IS NULL AND (full_name LIKE ? OR phone LIKE ? OR email LIKE ? OR comment LIKE ?)
         LIMIT 12`,
        [p, p, p, p]
      ),
      companies: await db.all("SELECT * FROM companies WHERE name LIKE ? OR inn LIKE ? LIMIT 12", [p, p]),
      deals: await db.all("SELECT * FROM deals WHERE title LIKE ? LIMIT 12", [p]),
      orders: await db.all("SELECT * FROM orders WHERE number LIKE ? OR comment LIKE ? LIMIT 12", [p, p]),
      tasks: await db.all("SELECT * FROM tasks WHERE title LIKE ? OR description LIKE ? LIMIT 12", [p, p]),
      conversations: await db.all(
        `SELECT c.* FROM conversations c
         LEFT JOIN messages m ON m.conversation_id = c.id
         WHERE c.subject LIKE ? OR m.body LIKE ?
         GROUP BY c.id LIMIT 12`,
        [p, p]
      ),
    },
  };
}, { auth: true });

/* ---------- Аналитика ---------- */
get("/api/stats", async ({ query, user }) => {
  const pipelineId = (await pipelineFromQuery(query)) ?? (await defaultPipeline()).id;
  const stages = await stagesOf(pipelineId);

  const funnel = {};
  let wonAmount = 0;
  for (const stage of stages) {
    const count = await repo.count("deals", "stage = ? AND pipeline_id = ?", [stage.code, pipelineId]);
    const amount = await repo.sum("deals", "amount", "stage = ? AND pipeline_id = ?", [stage.code, pipelineId]);
    funnel[stage.code] = { name: stage.name, kind: stage.kind, count, amount };
    if (stage.kind === "won") wonAmount += amount;
  }

  const lostReasons = await db.all(
    `SELECT r.name AS name, COUNT(d.id) AS n FROM lost_reasons r
     JOIN deals d ON d.lost_reason_id = r.id
     GROUP BY r.id, r.name ORDER BY n DESC LIMIT 8`
  );
  const ownerRows = await db.all(
    `SELECT d.owner_id, CASE WHEN u.role='superadmin' THEN 'Администратор' ELSE COALESCE(NULLIF(u.full_name,''),u.email,'Не назначен') END AS owner_name,
      d.stage, COUNT(d.id) AS count, COALESCE(SUM(d.amount),0) AS amount
     FROM deals d LEFT JOIN users u ON u.id=d.owner_id
     WHERE d.pipeline_id=?
     GROUP BY d.owner_id,u.role,u.full_name,u.email,d.stage
     ORDER BY owner_name,d.owner_id,d.stage`,
    [pipelineId],
  );
  const owners = new Map();
  for (const row of ownerRows) {
    const key = row.owner_id === null || row.owner_id === undefined ? "unassigned" : String(row.owner_id);
    if (!owners.has(key)) owners.set(key, { owner_id: row.owner_id ?? null, owner_name: row.owner_name || "Не назначен", stages: {}, total_count: 0, total_amount: 0 });
    const owner = owners.get(key);
    const count = Number(row.count || 0);
    const amount = Number(row.amount || 0);
    const stage = stages.find((item) => item.code === row.stage);
    owner.stages[row.stage] = { name: stage?.name || row.stage, count, amount };
    owner.total_count += count;
    owner.total_amount += amount;
  }

  return {
    data: {
      pipeline_id: pipelineId,
      contacts: await repo.count("contacts", "merged_into_id IS NULL"),
      companies: await repo.count("companies"),
      deals: await repo.count("deals"),
      deals_amount: await repo.sum("deals", "amount"),
      won_amount: wonAmount,
      orders: await repo.count("orders"),
      orders_total: await repo.sum("orders", "total"),
      open_conversations: await repo.count("conversations", "status = ?", ["open"]),
      unread: await repo.sum("conversations", "unread_count"),
      tasks: await taskCounters(user.id),
      funnel,
      funnel_by_owner: [...owners.values()].sort((a, b) => b.total_amount - a.total_amount || a.owner_name.localeCompare(b.owner_name, "ru")),
      lost_reasons: lostReasons.map((r) => ({ name: r.name, count: Number(r.n) })),
      recent_messages: await db.all(
        `SELECT m.*, c.channel_type, c.subject FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         ORDER BY m.id DESC LIMIT 6`
      ),
    },
  };
}, { auth: true });

/* ---------- Журнал действий (152-ФЗ) ---------- */
get("/api/audit", async ({ user }) => {
  if (!["superadmin", "admin", "manager"].includes(user.role)) throw new HttpError(403, "Журнал доступен руководителям");
  return { data: await repo.list("audit_log", { limit: 100 }) };
}, { auth: true });
