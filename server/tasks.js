/**
 * Задачи менеджера.
 *
 * Без задач менеджер возвращается в блокнот, и обещание «перезвоню в четверг»
 * живёт только в его памяти. Здесь: сроки, напоминания, выборки «мои на сегодня»
 * и «просроченные», недельный календарь и отправка напоминаний по расписанию.
 */
import { config } from "./config.js";
import { db, nowIso, repo } from "./db.js";
import { HttpError } from "./http.js";
import { log } from "./logger.js";
import { logActivity } from "./activity.js";
import { sendEmail } from "./notify.js";

export const TASK_KINDS = {
  call: "Звонок",
  meeting: "Встреча",
  email: "Письмо",
  message: "Сообщение",
  todo: "Задача",
};

export const TASK_STATUSES = { open: "В работе", done: "Выполнена", canceled: "Отменена" };
export const TASK_PRIORITIES = { low: "Низкий", normal: "Обычный", high: "Высокий" };

const iso = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, "Некорректная дата задачи");
  return date.toISOString();
};

/** Начало и конец суток по времени сервера — в тех же ISO-строках, что и в базе. */
export function dayBounds(base = new Date()) {
  const start = new Date(base);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function weekBounds(base = new Date()) {
  const start = new Date(base);
  const weekday = (start.getDay() + 6) % 7; // понедельник — начало недели
  start.setDate(start.getDate() - weekday);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { from: start.toISOString(), to: end.toISOString() };
}

export async function createTask(payload, user) {
  if (!payload.title || !String(payload.title).trim()) throw new HttpError(400, "Укажите, что нужно сделать");
  const kind = TASK_KINDS[payload.kind] ? payload.kind : "todo";
  const dueAt = payload.due_at
    ? iso(payload.due_at)
    : new Date(Date.now() + config.tasks.defaultDueHours * 3600_000).toISOString();

  const task = await repo.insert("tasks", {
    title: String(payload.title).trim().slice(0, 300),
    description: String(payload.description || "").slice(0, 4000),
    kind,
    status: "open",
    priority: TASK_PRIORITIES[payload.priority] ? payload.priority : "normal",
    due_at: dueAt,
    remind_at: payload.remind_at ? iso(payload.remind_at) : dueAt,
    assignee_id: payload.assignee_id ?? user.id,
    author_id: user.id,
    contact_id: payload.contact_id ?? null,
    company_id: payload.company_id ?? null,
    deal_id: payload.deal_id ?? null,
    conversation_id: payload.conversation_id ?? null,
  });

  await logActivity({
    type: "task",
    title: `${TASK_KINDS[kind]}: ${task.title}`,
    body: task.description,
    contact_id: task.contact_id,
    company_id: task.company_id,
    deal_id: task.deal_id,
    conversation_id: task.conversation_id,
    task_id: task.id,
    user_id: user.id,
  });

  return task;
}

export async function closeTask(task, { status, result }, user) {
  if (!TASK_STATUSES[status]) throw new HttpError(400, "Неизвестный статус задачи");
  const updated = await repo.update("tasks", task.id, {
    status,
    result: String(result || "").slice(0, 2000),
    completed_at: status === "open" ? null : nowIso(),
    updated_at: nowIso(),
  });

  if (status !== "open") {
    await logActivity({
      type: "task_done",
      title: `${status === "done" ? "Выполнена" : "Отменена"} задача: ${task.title}`,
      body: result || "",
      contact_id: task.contact_id,
      deal_id: task.deal_id,
      task_id: task.id,
      user_id: user.id,
    });
  }
  return updated;
}

/**
 * Выборка задач под конкретный вопрос менеджера.
 * scope: today | overdue | week | upcoming | all
 */
export async function listTasks({ scope = "all", assigneeId = null, status = "open", dealId = null, contactId = null, limit = 300 }) {
  const conditions = [];
  const params = [];

  if (status && status !== "all") { conditions.push("t.status = ?"); params.push(status); }
  if (assigneeId) { conditions.push("t.assignee_id = ?"); params.push(assigneeId); }
  if (dealId) { conditions.push("t.deal_id = ?"); params.push(dealId); }
  if (contactId) { conditions.push("t.contact_id = ?"); params.push(contactId); }

  const now = nowIso();
  if (scope === "today") {
    const { to } = dayBounds();
    conditions.push("t.due_at < ?");
    params.push(to);
  } else if (scope === "overdue") {
    conditions.push("t.due_at < ?");
    params.push(now);
  } else if (scope === "week") {
    const { from, to } = weekBounds();
    conditions.push("t.due_at >= ? AND t.due_at < ?");
    params.push(from, to);
  } else if (scope === "upcoming") {
    conditions.push("t.due_at >= ?");
    params.push(now);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db.all(
    `SELECT t.*, CASE WHEN u.role='superadmin' THEN 'Администратор' ELSE u.full_name END AS assignee_name, c.full_name AS contact_name, d.title AS deal_title
     FROM tasks t
     LEFT JOIN users u ON u.id = t.assignee_id
     LEFT JOIN contacts c ON c.id = t.contact_id
     LEFT JOIN deals d ON d.id = t.deal_id
     ${where}
     ORDER BY t.due_at IS NULL, t.due_at LIMIT ?`,
    [...params, limit]
  );
}

/** Счётчики для шапки: сколько сегодня и сколько уже просрочено. */
export async function taskCounters(userId) {
  const now = nowIso();
  const { to } = dayBounds();
  const today = await db.get(
    "SELECT COUNT(*) AS n FROM tasks WHERE status = 'open' AND assignee_id = ? AND due_at < ?",
    [userId, to]
  );
  const overdue = await db.get(
    "SELECT COUNT(*) AS n FROM tasks WHERE status = 'open' AND assignee_id = ? AND due_at < ?",
    [userId, now]
  );
  return { today: Number(today?.n || 0), overdue: Number(overdue?.n || 0) };
}

/**
 * Рассылка напоминаний. Запускается планировщиком: письмо уходит один раз,
 * флаг reminded защищает от повторов при рестарте процесса.
 */
export async function runReminders() {
  const due = await db.all(
    `SELECT t.*, u.email AS assignee_email, u.full_name AS assignee_name
     FROM tasks t JOIN users u ON u.id = t.assignee_id
     WHERE t.status = 'open' AND t.reminded = 0 AND t.remind_at IS NOT NULL AND t.remind_at <= ?
     LIMIT 100`,
    [nowIso()]
  );

  for (const task of due) {
    const when = new Date(task.due_at).toLocaleString("ru-RU");
    await sendEmail(
      task.assignee_email,
      `Напоминание: ${task.title}`,
      `${TASK_KINDS[task.kind] || "Задача"} «${task.title}» — срок ${when}.\n${task.description || ""}`
    );
    await repo.update("tasks", task.id, { reminded: 1 });
  }

  if (due.length) log.info("tasks.reminded", { count: due.length });
  return due.length;
}
