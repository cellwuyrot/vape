/** Задачи: создание из любой карточки, мои на сегодня, просроченные, календарь недели. */
import { audit } from "../auth.js";
import { db, nowIso, repo } from "../db.js";
import { HttpError, clientIp, del, get, patch, post } from "../http.js";
import {
  TASK_KINDS, TASK_PRIORITIES, TASK_STATUSES,
  closeTask, createTask, dayBounds, listTasks, taskCounters, weekBounds,
} from "../tasks.js";

const canWrite = (user) => {
  if (user.role === "viewer") throw new HttpError(403, "Роль «наблюдатель» не может изменять данные");
};

get("/api/tasks/meta", async () => ({
  data: { kinds: TASK_KINDS, statuses: TASK_STATUSES, priorities: TASK_PRIORITIES },
}), { auth: true });

get("/api/tasks", async ({ query, user }) => {
  const mine = query.get("mine") !== "0";
  const tasks = await listTasks({
    scope: query.get("scope") || "all",
    status: query.get("status") || "open",
    assigneeId: mine ? user.id : null,
    dealId: query.get("deal_id") || null,
    contactId: query.get("contact_id") || null,
  });
  return { data: { tasks, counters: await taskCounters(user.id) } };
}, { auth: true });

/** Календарь на неделю: задачи, разложенные по дням. */
get("/api/tasks/calendar", async ({ query, user }) => {
  const base = query.get("week") ? new Date(query.get("week")) : new Date();
  if (Number.isNaN(base.getTime())) throw new HttpError(400, "Некорректная неделя");
  const { from, to } = weekBounds(base);

  const conditions = ["due_at >= ?", "due_at < ?"];
  const params = [from, to];
  if (query.get("mine") !== "0") { conditions.push("assignee_id = ?"); params.push(user.id); }

  const where = conditions.join(" AND ");
  const rows = await db.all(
    `SELECT t.*, c.full_name AS contact_name FROM tasks t
     LEFT JOIN contacts c ON c.id = t.contact_id
     WHERE ${where} ORDER BY t.due_at LIMIT 500`,
    params
  );

  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const day = new Date(from);
    day.setDate(day.getDate() + i);
    const bounds = dayBounds(day);
    days.push({
      date: bounds.from,
      tasks: rows.filter((t) => t.due_at >= bounds.from && t.due_at < bounds.to),
    });
  }
  return { data: { from, to, days } };
}, { auth: true });

post("/api/tasks", async ({ body, user, req }) => {
  canWrite(user);
  const task = await createTask(body, user);
  await audit(user.id, "create", "task", task.id, null, clientIp(req));
  return { status: 201, data: task };
}, { auth: true });

patch("/api/tasks/:id", async ({ params, body, user, req }) => {
  canWrite(user);
  const task = await repo.byId("tasks", params.id);
  if (!task) throw new HttpError(404, "Задача не найдена");

  if (body.status) {
    const updated = await closeTask(task, { status: body.status, result: body.result }, user);
    await audit(user.id, "update", "task", task.id, { status: body.status }, clientIp(req));
    return { data: updated };
  }

  const patchData = { updated_at: nowIso() };
  if (body.title) patchData.title = String(body.title).slice(0, 300);
  if (body.description !== undefined) patchData.description = String(body.description).slice(0, 4000);
  if (body.due_at) {
    const date = new Date(body.due_at);
    if (Number.isNaN(date.getTime())) throw new HttpError(400, "Некорректная дата");
    patchData.due_at = date.toISOString();
    patchData.remind_at = date.toISOString();
    patchData.reminded = 0;
  }
  if (body.assignee_id !== undefined) patchData.assignee_id = body.assignee_id;
  if (body.priority && TASK_PRIORITIES[body.priority]) patchData.priority = body.priority;
  if (body.kind && TASK_KINDS[body.kind]) patchData.kind = body.kind;

  return { data: await repo.update("tasks", task.id, patchData) };
}, { auth: true });

del("/api/tasks/:id", async ({ params, user, req }) => {
  if (!["superadmin", "admin", "manager"].includes(user.role)) throw new HttpError(403, "Недостаточно прав");
  await repo.remove("tasks", params.id);
  await audit(user.id, "delete", "task", params.id, null, clientIp(req));
  return { status: 204, data: null };
}, { auth: true });
