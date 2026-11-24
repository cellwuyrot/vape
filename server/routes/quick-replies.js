/** Шаблоны быстрых ответов инбокса: список, создание, правка, счётчик применений. */
import { db, repo } from "../db.js";
import { HttpError, del, get, patch, post } from "../http.js";

const canEdit = (user, row) =>
  ["superadmin", "admin", "manager"].includes(user.role) || (row && row.owner_id === user.id);

get("/api/quick-replies", async ({ user }) => ({
  data: await db.all(
    "SELECT * FROM quick_replies WHERE is_shared = 1 OR owner_id = ? ORDER BY sort, id",
    [user.id]
  ),
}), { auth: true });

post("/api/quick-replies", async ({ body, user }) => {
  if (user.role === "viewer") throw new HttpError(403, "Недостаточно прав");
  if (!body.title || !body.body) throw new HttpError(400, "Укажите название и текст ответа");
  return {
    status: 201,
    data: await repo.insert("quick_replies", {
      shortcut: String(body.shortcut || "").trim().slice(0, 40),
      title: String(body.title).slice(0, 200),
      body: String(body.body).slice(0, 4000),
      channel: String(body.channel || ""),
      owner_id: user.id,
      is_shared: body.is_shared === false ? 0 : 1,
      sort: Number(body.sort) || 100,
    }),
  };
}, { auth: true });

patch("/api/quick-replies/:id", async ({ params, body, user }) => {
  const row = await repo.byId("quick_replies", params.id);
  if (!row) throw new HttpError(404, "Шаблон не найден");

  // Счётчик применений может увеличить любой сотрудник — это статистика, а не правка
  if (body.used) return { data: await repo.update("quick_replies", row.id, { used_count: (row.used_count || 0) + 1 }) };

  if (!canEdit(user, row)) throw new HttpError(403, "Чужой шаблон можно только применять");
  const data = {};
  for (const field of ["title", "body", "shortcut", "channel"]) {
    if (body[field] !== undefined) data[field] = String(body[field]).slice(0, 4000);
  }
  if (body.sort !== undefined) data.sort = Number(body.sort) || 0;
  if (body.is_shared !== undefined) data.is_shared = body.is_shared ? 1 : 0;
  return { data: await repo.update("quick_replies", row.id, data) };
}, { auth: true });

del("/api/quick-replies/:id", async ({ params, user }) => {
  const row = await repo.byId("quick_replies", params.id);
  if (!row) throw new HttpError(404, "Шаблон не найден");
  if (!canEdit(user, row)) throw new HttpError(403, "Недостаточно прав");
  await repo.remove("quick_replies", row.id);
  return { status: 204, data: null };
}, { auth: true });
