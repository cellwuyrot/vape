/** Пароли (scrypt), сессионные токены (HMAC), коды подтверждения. */
import crypto from "node:crypto";
import { config } from "./config.js";
import { db, nowIso, repo } from "./db.js";
import { log } from "./logger.js";

/* ---------- Пароли ---------- */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [, salt, hash] = String(stored).split("$");
    const candidate = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, "hex");
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

/* ---------- Токены сессии (compact JWS, HS256) ---------- */
const b64 = (buf) => Buffer.from(buf).toString("base64url");

export function signToken(payload, ttlHours = config.sessionTtlHours) {
  const body = { ...payload, exp: Date.now() + ttlHours * 3600_000 };
  const data = b64(JSON.stringify(body));
  const sig = crypto.createHmac("sha256", config.secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", config.secret).update(data).digest("base64url");
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

/* ---------- Коды подтверждения ---------- */
export const generateCode = () => String(crypto.randomInt(100000, 999999));

export const hashCode = (code) =>
  crypto.createHmac("sha256", config.secret).update(String(code)).digest("hex");

export async function issueCode(userId, channel) {
  const code = generateCode();
  await repo.insert("verification_codes", {
    user_id: userId,
    channel,
    code_hash: hashCode(code),
    expires_at: new Date(Date.now() + config.codeTtlMinutes * 60_000).toISOString(),
  });
  return code;
}

export const MAX_CODE_ATTEMPTS = 5;

export async function consumeCode(userId, channel, code) {
  const row = await db.get(
    `SELECT * FROM verification_codes
     WHERE user_id = ? AND channel = ? AND used = 0
     ORDER BY id DESC LIMIT 1`,
    [userId, channel]
  );
  if (!row) return { ok: false, error: "Код не запрашивался или уже использован" };
  if (row.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, error: "Превышено число попыток, запросите новый код" };

  const now = nowIso();
  if (new Date(row.expires_at).getTime() <= Date.parse(now)) return { ok: false, error: "Срок действия кода истёк" };

  const stored = Buffer.from(String(row.code_hash || ""), "hex");
  const candidate = Buffer.from(hashCode(code), "hex");
  const matches = stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);

  if (!matches) {
    // Инкремент выполняется в SQL, а не read-modify-write: параллельные
    // неверные попытки не перетирают счётчик друг друга.
    const attempt = await db.run(
      `UPDATE verification_codes SET attempts = attempts + 1
       WHERE id = ? AND used = 0 AND attempts < ? AND expires_at > ?`,
      [row.id, MAX_CODE_ATTEMPTS, now]
    );
    if (!attempt.changes) {
      const latest = await db.get("SELECT attempts,expires_at,used FROM verification_codes WHERE id=?", [row.id]);
      if (!latest || latest.used) return { ok: false, error: "Код уже использован, запросите новый" };
      if (latest.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, error: "Превышено число попыток, запросите новый код" };
      return { ok: false, error: "Срок действия кода истёк" };
    }
    return { ok: false, error: "Неверный код" };
  }

  // Только один параллельный запрос может поменять used с 0 на 1.
  const consumed = await db.run(
    `UPDATE verification_codes SET used = 1
     WHERE id = ? AND used = 0 AND attempts < ? AND expires_at > ? AND code_hash = ?`,
    [row.id, MAX_CODE_ATTEMPTS, now, hashCode(code)]
  );
  if (!consumed.changes) {
    const latest = await db.get("SELECT attempts,expires_at,used FROM verification_codes WHERE id=?", [row.id]);
    if (!latest || latest.used) return { ok: false, error: "Код уже использован, запросите новый" };
    if (latest.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, error: "Превышено число попыток, запросите новый код" };
    return { ok: false, error: "Срок действия кода истёк" };
  }
  return { ok: true };
}

/* ---------- Пользователи ---------- */
export const findUserByEmail = (email) =>
  db.get("SELECT * FROM users WHERE email = ?", [String(email).toLowerCase()]);


export const isVerified = (user) => Boolean(user.email_verified);

export async function ensureAdmin() {
  const email = config.admin.email;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("ADMIN_EMAIL должен содержать корректный адрес главного администратора");
  }

  // В системе один главный администратор. При смене ADMIN_EMAIL прежняя запись
  // сохраняется как обычный администратор, но не остаётся вторым superadmin.
  const previous = await db.all("SELECT id,email FROM users WHERE role='superadmin'");
  for (const item of previous) {
    if (String(item.email).trim().toLowerCase() !== email) {
      await repo.update("users", item.id, { role: "admin" });
      log.warn("auth.superadmin-demoted", { email: item.email, reason: "ADMIN_EMAIL changed" });
    }
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    const updates = {};
    if (existing.role !== "superadmin") updates.role = "superadmin";
    if (!existing.email_verified) updates.email_verified = 1;
    if (!existing.phone_verified) updates.phone_verified = 1;
    if (!existing.is_active) updates.is_active = 1;
    if (Object.keys(updates).length) await repo.update("users", existing.id, updates);
    return;
  }
  await repo.insert("users", {
    email,
    phone: `internal:${email}`,
    full_name: "Главный администратор VAPELAB",
    password_hash: "",
    role: "superadmin",
    email_verified: 1,
    phone_verified: 1,
    is_active: 1,
    pd_consent_at: null,
  });
  log.info("auth.superadmin-created", { email });
}

export async function audit(userId, action, entity, entityId = "", payload = null, ip = "") {
  await repo.insert("audit_log", {
    user_id: userId ?? null,
    action,
    entity,
    entity_id: String(entityId),
    payload: payload ? JSON.stringify(payload).slice(0, 4000) : "",
    ip,
  });
}
