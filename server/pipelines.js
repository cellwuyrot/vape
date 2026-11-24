/**
 * Воронки продаж.
 *
 * Стадии больше не константа в коде: у каждой воронки свой набор, свой порядок
 * и свои обязательные поля. Без обязательных полей и справочника причин отказа
 * аналитика по потерям превращается в гадание — поэтому проверка живёт здесь,
 * в одном месте, и её нельзя обойти из интерфейса.
 */
import { db, repo } from "./db.js";
import { HttpError } from "./http.js";

/** Человеческие названия полей: текст ошибки должен читаться менеджером, а не программистом. */
const FIELD_LABELS = {
  amount: "сумма сделки",
  contact_id: "клиент",
  company_id: "компания",
  next_step: "следующий шаг",
  title: "название",
};

export const parseRequired = (value) =>
  String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export async function listPipelines({ activeOnly = true } = {}) {
  const where = activeOnly ? "WHERE is_active = 1" : "";
  const pipelines = await db.all(`SELECT * FROM pipelines ${where} ORDER BY sort, id`);
  const out = [];
  for (const pipeline of pipelines) {
    out.push({ ...pipeline, stages: await stagesOf(pipeline.id) });
  }
  return out;
}

export function stagesOf(pipelineId) {
  return db.all("SELECT * FROM pipeline_stages WHERE pipeline_id = ? ORDER BY sort, id", [pipelineId]);
}

export async function defaultPipeline() {
  const row =
    (await db.get("SELECT * FROM pipelines WHERE is_default = 1 AND is_active = 1 ORDER BY sort LIMIT 1")) ||
    (await db.get("SELECT * FROM pipelines WHERE is_active = 1 ORDER BY sort LIMIT 1"));
  if (!row) throw new HttpError(500, "Не настроено ни одной воронки");
  return row;
}

export async function resolvePipeline(pipelineId) {
  if (!pipelineId) return defaultPipeline();
  const row = await repo.byId("pipelines", pipelineId);
  if (!row) throw new HttpError(400, "Воронка не найдена");
  return row;
}

export async function stageByCode(pipelineId, code) {
  return db.get("SELECT * FROM pipeline_stages WHERE pipeline_id = ? AND code = ?", [pipelineId, code]);
}

export async function firstStage(pipelineId) {
  return db.get("SELECT * FROM pipeline_stages WHERE pipeline_id = ? ORDER BY sort, id LIMIT 1", [pipelineId]);
}

/**
 * Проверяет, можно ли перевести сделку на стадию.
 * @param {object} stage    строка pipeline_stages
 * @param {object} deal     сделка после применения правок
 * @param {object} incoming тело запроса — из него берётся причина отказа
 */
export async function assertStageAllowed(stage, deal, incoming = {}) {
  const missing = parseRequired(stage.required_fields).filter((field) => {
    const value = deal[field];
    if (field === "amount") return !(Number(value) > 0);
    return value === null || value === undefined || String(value).trim() === "";
  });

  if (missing.length) {
    throw new HttpError(
      400,
      `Стадия «${stage.name}» требует заполнить: ${missing.map((f) => FIELD_LABELS[f] || f).join(", ")}`
    );
  }

  if (stage.kind === "lost") {
    const reasonId = incoming.lost_reason_id ?? deal.lost_reason_id;
    if (!reasonId) throw new HttpError(400, "Укажите причину отказа из справочника");
    const reason = await repo.byId("lost_reasons", reasonId);
    if (!reason) throw new HttpError(400, "Причина отказа не найдена в справочнике");
    return { lost_reason_id: reason.id, lost_reason: reason.name };
  }

  return { lost_reason_id: null, lost_reason: "" };
}
