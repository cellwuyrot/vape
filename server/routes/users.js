/** Управление командой VAPELAB: одинаковые рабочие права менеджеров и иерархия управления аккаунтами. */
import crypto from "node:crypto";
import { db, nowIso, repo } from "../db.js";
import { audit, findUserByEmail, issueCode } from "../auth.js";
import { HttpError, clientIp, del, get, post, put } from "../http.js";
import { sendVerification } from "../notify.js";

const canOpenTeam = (user) => ["superadmin", "admin", "manager"].includes(user?.role);
const requireTeamAccess = (user) => {
  if (!canOpenTeam(user)) throw new HttpError(403, "Управление командой доступно руководителям");
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MANAGEABLE_ROLES = new Set(["manager", "agent", "viewer"]);

async function managedUserIds(user) {
  if (user.role === "superadmin") {
    const rows = await db.all("SELECT id FROM users WHERE role <> 'superadmin' AND deleted_at IS NULL");
    return new Set(rows.map((row) => Number(row.id)));
  }
  if (user.role === "admin") {
    const rows = await db.all("SELECT id FROM users WHERE role IN ('manager','agent','viewer') AND deleted_at IS NULL");
    return new Set(rows.map((row) => Number(row.id)));
  }
  if (user.role !== "manager") return new Set();
  // Менеджер управляет только собственной веткой. UNION, а не UNION ALL,
  // защищает CTE от зацикливания даже при повреждённой цепочке invited_by.
  const rows = await db.all(`
    WITH RECURSIVE team_tree(id) AS (
      SELECT id FROM users WHERE invited_by = ? AND deleted_at IS NULL
      UNION
      SELECT child.id FROM users child
      INNER JOIN team_tree parent ON child.invited_by = parent.id
      WHERE child.deleted_at IS NULL
    )
    SELECT id FROM team_tree
  `, [user.id]);
  return new Set(rows.map((row) => Number(row.id)));
}

function safeUser(u, manageableIds, actor) {
  const isPrimaryAdmin = u.role === "superadmin";
  const canManage = !isPrimaryAdmin && u.role !== "admin" && Number(u.id) !== Number(actor.id) && manageableIds.has(Number(u.id));
  return {
    id: u.id,
    email: isPrimaryAdmin ? "" : u.email,
    full_name: isPrimaryAdmin ? "Рабочий аккаунт" : u.full_name,
    role: u.role,
    is_active: Boolean(u.is_active),
    email_verified: Boolean(u.email_verified),
    created_at: u.created_at,
    invited_at: u.invited_at,
    last_login_at: u.last_login_at,
    can_manage: canManage,
  };
}

async function requireManageTarget(actor, target) {
  if (!target || target.deleted_at) throw new HttpError(404, "Сотрудник не найден");
  if (Number(target.id) === Number(actor.id)) throw new HttpError(400, "Нельзя управлять собственным аккаунтом через список команды");
  if (target.role === "superadmin") throw new HttpError(403, "Главный системный аккаунт защищён от управления командой");
  const ids = await managedUserIds(actor);
  if (!ids.has(Number(target.id))) throw new HttpError(403, "Вы можете управлять только сотрудниками из своей ветки команды");
  if (target.role === "admin" && actor.role !== "superadmin") throw new HttpError(403, "Изменять аккаунт администратора может только главный администратор");
}

get("/api/users", async ({ user }) => {
  requireTeamAccess(user);
  const rows = await db.all("SELECT id,email,full_name,role,is_active,email_verified,created_at,invited_at,last_login_at,invited_by,deleted_at FROM users WHERE role NOT IN ('visitor','superadmin') AND deleted_at IS NULL ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,full_name,email");
  const manageableIds = await managedUserIds(user);
  return { data: rows.map((row) => safeUser(row, manageableIds, user)) };
}, { auth:true });

post("/api/users", async ({ body, user, req }) => {
  requireTeamAccess(user);
  const email = String(body.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "Введите корректный e-mail сотрудника");
  // Менеджер может назначать новых менеджеров и сотрудников, но не выдавать admin/superadmin.
  const role = MANAGEABLE_ROLES.has(body.role) ? body.role : "manager";
  if (await findUserByEmail(email)) throw new HttpError(409, "Аккаунт с таким e-mail уже существует");
  const created = await repo.insert("users", {
    email, phone:`staff:${crypto.randomUUID()}`, full_name:String(body.full_name || "").trim().slice(0,200),
    password_hash:"", role, email_verified:0, phone_verified:1, is_active:1,
    invited_by:user.id, invited_at:nowIso(), pd_consent_at:null,
  });
  const code = await issueCode(created.id, "email");
  const delivery = await sendVerification("email", email, code);
  await audit(user.id, "invite", "user", created.id, { email, role, email_sent:delivery.ok, invited_by:user.id }, clientIp(req));
  const manageableIds = await managedUserIds(user);
  return { status:201, data:{ user:safeUser(created, manageableIds, user), email_sent:Boolean(delivery.ok), delivery_mode:delivery.dev ? "development" : "smtp" } };
}, { auth:true });

put("/api/users/:id", async ({ params, body, user, req }) => {
  requireTeamAccess(user);
  const target = await repo.byId("users", params.id);
  await requireManageTarget(user, target);
  if (target.role === "admin" && body.role && body.role !== "admin") throw new HttpError(400, "Роль администратора изменяется только главным администратором");
  const role = body.role && MANAGEABLE_ROLES.has(body.role) ? body.role : target.role;
  if (target.role === "admin" && role !== target.role) throw new HttpError(400, "Роль администратора меняется только отдельной процедурой");
  const updated = await repo.update("users", target.id, {
    full_name: body.full_name === undefined ? target.full_name : String(body.full_name).trim().slice(0,200),
    role,
    is_active: body.is_active === undefined ? target.is_active : (body.is_active ? 1 : 0),
  });
  await audit(user.id, "update", "user", target.id, { role:updated.role, is_active:updated.is_active }, clientIp(req));
  const manageableIds = await managedUserIds(user);
  return { data:safeUser(updated, manageableIds, user) };
}, { auth:true });

del("/api/users/:id", async ({ params, user, req }) => {
  requireTeamAccess(user);
  const target = await repo.byId("users", params.id);
  await requireManageTarget(user, target);
  if (!MANAGEABLE_ROLES.has(target.role)) throw new HttpError(403, "Этот системный аккаунт нельзя удалить из команды");
  const removedAt = nowIso();
  // Мягкое удаление сохраняет историю автора задач/сообщений и журнал действий.
  // Прямых подчинённых переносим на инициатора, чтобы не оставлять осиротевшую ветку.
  await db.transaction(async (tx) => {
    await tx.run("UPDATE users SET invited_by = ? WHERE invited_by = ? AND deleted_at IS NULL", [user.id, target.id]);
    await tx.run("UPDATE users SET is_active = 0, deleted_at = ? WHERE id = ?", [removedAt, target.id]);
  });
  await audit(user.id, "delete", "user", target.id, { role:target.role, deleted_at:removedAt, reassigned_direct_reports:true }, clientIp(req));
  return { data:{ id:target.id, deleted:true, deleted_at:removedAt } };
}, { auth:true });
