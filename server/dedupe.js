/**
 * Дубли клиентов и компаний.
 *
 * Один и тот же человек приходит с сайта, из Telegram и по телефону — и в базе
 * появляются три карточки. Ищем совпадения по нормализованному телефону, почте
 * и ИНН, показываем подсказку при создании и умеем склеивать карточки без потери
 * истории: сделки, заказы, диалоги, задачи и лента переезжают в основную карточку.
 */
import { db, nowIso, repo } from "./db.js";
import { HttpError } from "./http.js";
import { logActivity } from "./activity.js";

/** +7 (916) 123-45-67, 8 916 1234567 и 79161234567 — один и тот же номер. */
export function normalizePhone(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  if (!digits) return "";
  if (digits.length === 11 && (digits[0] === "8" || digits[0] === "7")) return `7${digits.slice(1)}`;
  if (digits.length === 10) return `7${digits}`;
  return digits;
}

export const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
export const normalizeInn = (value) => String(value || "").replace(/\D+/g, "");

/** Ключи, по которым карточка считается той же самой. */
export function contactKeys(row) {
  const keys = [];
  const phone = normalizePhone(row.phone);
  const email = normalizeEmail(row.email);
  if (phone.length >= 10) keys.push(`phone:${phone}`);
  if (email.includes("@")) keys.push(`email:${email}`);
  return keys;
}

export function companyKeys(row) {
  const keys = [];
  const inn = normalizeInn(row.inn);
  if (inn.length >= 10) keys.push(`inn:${inn}`);
  const name = String(row.name || "").toLowerCase().replace(/[«»"'.,\s]|ооо|ао|зао|пао|ип/g, "");
  if (name.length >= 4) keys.push(`name:${name}`);
  return keys;
}

/** Подсказка при создании: «такой клиент уже есть». */
export async function findContactMatches({ phone, email, excludeId = null }) {
  const wanted = contactKeys({ phone, email });
  if (!wanted.length) return [];
  const rows = await db.all(
    "SELECT * FROM contacts WHERE merged_into_id IS NULL ORDER BY id DESC LIMIT 5000"
  );
  return rows.filter(
    (row) => row.id !== Number(excludeId) && contactKeys(row).some((key) => wanted.includes(key))
  );
}

export async function findCompanyMatches({ inn, name, excludeId = null }) {
  const wanted = companyKeys({ inn, name });
  if (!wanted.length) return [];
  const rows = await db.all(
    "SELECT * FROM companies WHERE merged_into_id IS NULL ORDER BY id DESC LIMIT 5000"
  );
  return rows.filter(
    (row) => row.id !== Number(excludeId) && companyKeys(row).some((key) => wanted.includes(key))
  );
}

/** Пакетная проверка базы: группы карточек, которые стоит склеить. */
export async function scanDuplicates(entity = "contacts", { limit = 100 } = {}) {
  const isContacts = entity === "contacts";
  const table = isContacts ? "contacts" : "companies";
  const rows = await db.all(`SELECT * FROM ${table} WHERE merged_into_id IS NULL ORDER BY id LIMIT 10000`);
  const keyFn = isContacts ? contactKeys : companyKeys;

  const buckets = new Map();
  for (const row of rows) {
    for (const key of keyFn(row)) {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    }
  }

  const groups = [];
  const seen = new Set();
  for (const [key, list] of buckets) {
    if (list.length < 2) continue;
    const signature = list.map((r) => r.id).sort((a, b) => a - b).join("-");
    if (seen.has(signature)) continue;
    seen.add(signature);
    const [reason, value] = key.split(":");
    groups.push({
      reason,
      value,
      items: list.map((r) => ({
        id: r.id,
        title: isContacts ? r.full_name : r.name,
        phone: r.phone || "",
        email: r.email || "",
        inn: r.inn || "",
        created_at: r.created_at,
      })),
    });
    if (groups.length >= limit) break;
  }
  return groups;
}

const REASON_LABELS = { phone: "телефон", email: "почта", inn: "ИНН", name: "название" };
export const duplicateReason = (reason) => REASON_LABELS[reason] || reason;

/**
 * Склеивает две карточки клиента. Победитель — target, донор помечается
 * merged_into_id и остаётся в базе: удалять карточку с историей ПДн нельзя,
 * её нужно уметь показать по запросу субъекта.
 */
export async function mergeContacts(sourceId, targetId, userId) {
  if (Number(sourceId) === Number(targetId)) throw new HttpError(400, "Нельзя склеить карточку саму с собой");
  const source = await repo.byId("contacts", sourceId);
  const target = await repo.byId("contacts", targetId);
  if (!source || !target) throw new HttpError(404, "Карточка не найдена");
  if (source.merged_into_id) throw new HttpError(400, "Эта карточка уже склеена");

  // Пустые поля основной карточки заполняем данными донора — информация не теряется
  const filled = {};
  for (const field of ["phone", "email", "position", "comment", "tags", "company_id", "source"]) {
    if (!target[field] && source[field]) filled[field] = source[field];
  }
  if (!target.pd_consent && source.pd_consent) {
    filled.pd_consent = 1;
    filled.pd_consent_at = source.pd_consent_at || nowIso();
  }
  filled.updated_at = nowIso();

  await db.transaction(async (tx) => {
    for (const [table, column] of [
      ["deals", "contact_id"],
      ["orders", "contact_id"],
      ["conversations", "contact_id"],
      ["tasks", "contact_id"],
      ["activities", "contact_id"],
    ]) {
      await tx.run(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`, [target.id, source.id]);
    }
    const keys = Object.keys(filled);
    if (keys.length) {
      await tx.run(
        `UPDATE contacts SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
        [...keys.map((k) => filled[k]), target.id]
      );
    }
    await tx.run("UPDATE contacts SET merged_into_id = ?, updated_at = ? WHERE id = ?", [
      target.id,
      nowIso(),
      source.id,
    ]);
  });

  await logActivity({
    type: "merge",
    title: "Карточки объединены",
    body: `Карточка «${source.full_name}» (#${source.id}) присоединена к этой`,
    contact_id: target.id,
    user_id: userId,
  });

  return repo.byId("contacts", target.id);
}
