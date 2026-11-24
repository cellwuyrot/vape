/**
 * Лента активности.
 *
 * Менеджер не должен собирать историю клиента по четырём вкладкам: звонки,
 * письма, сообщения, задачи и смены стадий сливаются в один поток по времени.
 * Собственные записи лежат в таблице activities, переписка подтягивается
 * из messages — дублировать сообщения в две таблицы нельзя, они разойдутся.
 */
import { db, repo } from "./db.js";
import { log } from "./logger.js";

export async function logActivity(entry) {
  try {
    return await repo.insert("activities", {
      type: entry.type,
      title: String(entry.title || "").slice(0, 300),
      body: String(entry.body || "").slice(0, 2000),
      contact_id: entry.contact_id ?? null,
      company_id: entry.company_id ?? null,
      deal_id: entry.deal_id ?? null,
      order_id: entry.order_id ?? null,
      task_id: entry.task_id ?? null,
      conversation_id: entry.conversation_id ?? null,
      user_id: entry.user_id ?? null,
    });
  } catch (err) {
    // Лента — вспомогательная запись: её сбой не должен ронять основную операцию
    log.exception("activity.failed", err, { type: entry.type });
    return null;
  }
}

/** Собирает ленту клиента: события + переписка из всех его диалогов. */
export async function contactFeed(contactId, { limit = 80 } = {}) {
  const events = await db.all(
    `SELECT a.*, CASE WHEN u.role='superadmin' THEN 'Администратор' ELSE u.full_name END AS user_name
     FROM activities a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE a.contact_id = ?
     ORDER BY a.id DESC LIMIT ?`,
    [contactId, limit]
  );

  const messages = await db.all(
    `SELECT m.id, m.direction, m.body, m.created_at, m.conversation_id, c.channel_type
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.contact_id = ?
     ORDER BY m.id DESC LIMIT ?`,
    [contactId, limit]
  );

  const stream = [
    ...events.map((e) => ({
      kind: e.type,
      at: e.created_at,
      title: e.title,
      body: e.body,
      author: e.user_name || "",
      deal_id: e.deal_id,
      task_id: e.task_id,
    })),
    ...messages.map((m) => ({
      kind: m.direction === "inbound" ? "message_in" : "message_out",
      at: m.created_at,
      title: m.direction === "inbound" ? "Входящее сообщение" : "Ответ клиенту",
      body: m.body,
      channel: m.channel_type,
      conversation_id: m.conversation_id,
    })),
  ];

  stream.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return stream.slice(0, limit);
}

/** Лента сделки: только события, привязанные к ней. */
export function dealFeed(dealId, { limit = 50 } = {}) {
  return db.all(
    `SELECT a.*, CASE WHEN u.role='superadmin' THEN 'Администратор' ELSE u.full_name END AS user_name
     FROM activities a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.deal_id = ? ORDER BY a.id DESC LIMIT ?`,
    [dealId, limit]
  );
}
