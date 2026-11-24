/** Воронки, стадии и справочник причин отказа. */
import { db, repo } from "../db.js";
import { HttpError, del, get, patch, post } from "../http.js";
import { listPipelines, stagesOf } from "../pipelines.js";

const requireManager = (user) => {
  if (!["superadmin", "admin", "manager"].includes(user.role)) throw new HttpError(403, "Настройка воронок доступна руководителю");
};

const slug = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9а-я]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

get("/api/pipelines", async () => ({ data: await listPipelines() }), { auth: true });

post("/api/pipelines", async ({ body, user }) => {
  requireManager(user);
  if (!body.name) throw new HttpError(400, "Укажите название воронки");
  const code = slug(body.code || body.name) || `pipeline-${Date.now()}`;
  if (await db.get("SELECT id FROM pipelines WHERE code = ?", [code])) {
    throw new HttpError(409, "Воронка с таким кодом уже есть");
  }

  const pipeline = await repo.insert("pipelines", {
    code,
    name: body.name,
    sort: Number(body.sort) || 100,
    is_default: 0,
  });

  const stages = Array.isArray(body.stages) && body.stages.length
    ? body.stages
    : [
        { code: "new", name: "Новая", kind: "open" },
        { code: "work", name: "В работе", kind: "open" },
        { code: "won", name: "Успех", kind: "won" },
        { code: "lost", name: "Отказ", kind: "lost" },
      ];

  for (const [index, stage] of stages.entries()) {
    await repo.insert("pipeline_stages", {
      pipeline_id: pipeline.id,
      code: slug(stage.code || stage.name) || `stage-${index}`,
      name: stage.name || "Стадия",
      kind: ["open", "won", "lost"].includes(stage.kind) ? stage.kind : "open",
      sort: index + 1,
      probability: Number(stage.probability) || 0,
      required_fields: String(stage.required_fields || ""),
    });
  }

  return { status: 201, data: { ...pipeline, stages: await stagesOf(pipeline.id) } };
}, { auth: true });

patch("/api/pipelines/:id", async ({ params, body, user }) => {
  requireManager(user);
  const pipeline = await repo.byId("pipelines", params.id);
  if (!pipeline) throw new HttpError(404, "Воронка не найдена");

  if (body.is_default) await db.run("UPDATE pipelines SET is_default = 0", []);
  const data = {};
  if (body.name) data.name = body.name;
  if (body.sort !== undefined) data.sort = Number(body.sort) || 0;
  if (body.is_default !== undefined) data.is_default = body.is_default ? 1 : 0;
  if (body.is_active !== undefined) data.is_active = body.is_active ? 1 : 0;

  const updated = await repo.update("pipelines", pipeline.id, data);
  return { data: { ...updated, stages: await stagesOf(pipeline.id) } };
}, { auth: true });

/** Правка стадии: название, порядок и — главное — список обязательных полей. */
patch("/api/pipelines/:id/stages/:stageId", async ({ params, body, user }) => {
  requireManager(user);
  const stage = await repo.byId("pipeline_stages", params.stageId);
  if (!stage || String(stage.pipeline_id) !== String(params.id)) throw new HttpError(404, "Стадия не найдена");

  const data = {};
  if (body.name) data.name = body.name;
  if (body.sort !== undefined) data.sort = Number(body.sort) || 0;
  if (body.probability !== undefined) data.probability = Number(body.probability) || 0;
  if (body.required_fields !== undefined) {
    data.required_fields = Array.isArray(body.required_fields)
      ? body.required_fields.join(",")
      : String(body.required_fields || "");
  }
  return { data: await repo.update("pipeline_stages", stage.id, data) };
}, { auth: true });

post("/api/pipelines/:id/stages", async ({ params, body, user }) => {
  requireManager(user);
  const pipeline = await repo.byId("pipelines", params.id);
  if (!pipeline) throw new HttpError(404, "Воронка не найдена");
  if (!body.name) throw new HttpError(400, "Укажите название стадии");

  const existing = await stagesOf(pipeline.id);
  return {
    status: 201,
    data: await repo.insert("pipeline_stages", {
      pipeline_id: pipeline.id,
      code: slug(body.code || body.name) || `stage-${existing.length + 1}`,
      name: body.name,
      kind: ["open", "won", "lost"].includes(body.kind) ? body.kind : "open",
      sort: Number(body.sort) || existing.length + 1,
      probability: Number(body.probability) || 0,
      required_fields: String(body.required_fields || ""),
    }),
  };
}, { auth: true });

/* ---------- Причины отказа ---------- */

get("/api/lost-reasons", async () => ({
  data: await db.all("SELECT * FROM lost_reasons WHERE is_active = 1 ORDER BY sort, id"),
}), { auth: true });

post("/api/lost-reasons", async ({ body, user }) => {
  requireManager(user);
  if (!body.name) throw new HttpError(400, "Укажите причину");
  return { status: 201, data: await repo.insert("lost_reasons", { name: body.name, sort: Number(body.sort) || 100 }) };
}, { auth: true });

del("/api/lost-reasons/:id", async ({ params, user }) => {
  requireManager(user);
  // Причина остаётся в базе: на неё ссылаются закрытые сделки и отчёт по потерям
  await repo.update("lost_reasons", params.id, { is_active: 0 });
  return { status: 204, data: null };
}, { auth: true });
