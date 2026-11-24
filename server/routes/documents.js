/** Печатные формы: список шаблонов, правка бланка, готовый документ для печати. */
import { audit } from "../auth.js";
import { db, nowIso, repo } from "../db.js";
import { HttpError, clientIp, get, post, put } from "../http.js";
import { DOC_KINDS, renderDocument } from "../documents.js";
import { logActivity } from "../activity.js";

get("/api/documents/templates", async () => ({
  data: {
    kinds: DOC_KINDS,
    templates: await db.all("SELECT * FROM doc_templates ORDER BY id"),
  },
}), { auth: true });

put("/api/documents/templates/:id", async ({ params, body, user }) => {
  if (!["superadmin", "admin", "manager"].includes(user.role)) throw new HttpError(403, "Правка бланков доступна руководителю");
  const template = await repo.byId("doc_templates", params.id);
  if (!template) throw new HttpError(404, "Шаблон не найден");

  return {
    data: await repo.update("doc_templates", template.id, {
      name: body.name ?? template.name,
      body: body.body ?? template.body,
      is_active: body.is_active === undefined ? template.is_active : Number(Boolean(body.is_active)),
      updated_at: nowIso(),
    }),
  };
}, { auth: true });

/**
 * Готовый документ. Возвращаем HTML в JSON, а не отдаём файлом:
 * так печать открывается из интерфейса под тем же токеном, без ссылок
 * с ключом доступа в адресной строке — их слишком легко переслать наружу.
 */
post("/api/documents/render", async ({ body, user, req }) => {
  const code = String(body.code || "");
  if (!code) throw new HttpError(400, "Укажите шаблон");

  const document = await renderDocument({
    code,
    orderId: body.order_id ?? null,
    dealId: body.deal_id ?? null,
    userId: user.id,
  });

  await audit(user.id, "print", "document", code, { order_id: body.order_id, deal_id: body.deal_id }, clientIp(req));
  if (body.order_id || body.deal_id) {
    const order = body.order_id ? await repo.byId("orders", body.order_id) : null;
    await logActivity({
      type: "document",
      title: `Сформирован документ: ${document.title}`,
      contact_id: order?.contact_id ?? body.contact_id ?? null,
      deal_id: body.deal_id ?? order?.deal_id ?? null,
      order_id: body.order_id ?? null,
      user_id: user.id,
    });
  }

  return { data: document };
}, { auth: true });
