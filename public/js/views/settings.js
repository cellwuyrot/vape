/**
 * Настройки: профиль, оформление, воронки и стадии, причины отказа,
 * шаблоны быстрых ответов, печатные бланки, каналы, импорт и журнал действий.
 *
 * Всё, что раньше требовало программиста, настраивается отсюда: набор стадий,
 * обязательные поля на переходе, справочник причин отказа и тексты бланков.
 */
import { api, empty, field, h, mount, sheet, toast, when } from "../core.js";
import { state, toggleTheme, render } from "../app.js";
import { importHistory, openImport } from "./import.js";

const ROLES = { superadmin: "Администратор", admin: "Администратор", manager: "Руководитель", agent: "Менеджер", viewer: "Наблюдатель" };
const STAGE_KINDS = { open: "рабочая", won: "успех", lost: "отказ" };
const REQUIRED_FIELD_LABELS = {
  amount: "сумма", contact_id: "клиент", company_id: "компания", next_step: "следующий шаг",
};

export async function renderSettings(page) {
  const { user } = state;
  const origin = location.origin;
  const isManager = ["superadmin", "admin", "manager"].includes(user.role);

  const line = (label, value) =>
    h("div", { class: "line settings-info-line" },
      h("span", { class: "muted" }, label),
      h("div", { class: "spacer" }),
      h("span", { class: "settings-info-value" }, value)
    );

  const hook = (title, url, hint) =>
    h("div", { class: "settings-hook" },
      h("b", {}, title),
      h("button", {
        class: "settings-copy-url mono",
        type: "button",
        title: "Скопировать адрес",
        onclick: async (e) => {
          try { await navigator.clipboard?.writeText(url); toast("Адрес скопирован"); }
          catch { e.currentTarget.textContent = url; toast("Не удалось скопировать адрес"); }
        },
      }, url),
      h("p", { class: "muted" }, hint)
    );

  const section = (title, description, body, open = false) =>
    h("details", { class: "settings-section", ...(open ? { open: true } : {}) },
      h("summary", { class: "settings-section-summary" },
        h("span", { class: "settings-section-copy" },
          h("b", {}, title),
          h("small", {}, description)
        ),
        h("span", { class: "settings-section-chevron", "aria-hidden": "true" }, "⌄")
      ),
      h("div", { class: "settings-section-body" }, body)
    );

  const pipelinesHost = h("div");
  const reasonsHost = h("div");
  const repliesHost = h("div");
  const templatesHost = h("div");
  const importHost = h("div");
  const auditHost = h("div");

  const profile = h("div", { class: "settings-grid" },
    h("div", { class: "panel settings-inner-panel" },
      h("h2", {}, "Учётная запись"),
      line("ФИО", user.role === "superadmin" ? "Рабочий аккаунт" : (user.full_name || "—")),
      line("Почта", user.role === "superadmin" ? "Скрыта" : `${user.email} · ${user.email_verified ? "подтверждена" : "не подтверждена"}`),
      line("Телефон", `${user.phone || "—"} · ${user.phone_verified ? "подтверждён" : "не подтверждён"}`),
      line("Роль", ROLES[user.role] || user.role)
    ),
    h("div", { class: "panel settings-inner-panel" },
      h("h2", {}, "Оформление"),
      h("p", { class: "muted" }, "Тема интерфейса применяется только к вашей учётной записи в этом браузере."),
      h("button", { class: "btn", onclick: () => { toggleTheme(); render(); } },
        document.documentElement.dataset.theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему")
    )
  );

  const workflow = h("div", { class: "settings-grid" },
    h("div", { class: "panel settings-inner-panel" }, h("h2", {}, "Воронки и стадии"), pipelinesHost),
    h("div", { class: "panel settings-inner-panel" }, h("h2", {}, "Причины отказа"), reasonsHost)
  );
  const communication = h("div", { class: "settings-stack" },
    h("div", { class: "panel settings-inner-panel" }, h("h2", {}, "Быстрые ответы"), repliesHost),
    h("div", { class: "panel settings-inner-panel" },
      h("h2", {}, "Печатные формы"),
      h("p", { class: "muted" }, "HTML-шаблоны документов. Реквизиты организации задаются переменными ORG_* в .env."),
      templatesHost
    ),
    h("div", { class: "panel settings-inner-panel" },
      h("h2", {}, "Подключение каналов"),
      hook("Telegram", `${origin}/api/webhooks/telegram/<TELEGRAM_WEBHOOK_SECRET>`, "Токен бота хранится в TELEGRAM_BOT_TOKEN."),
      hook("WhatsApp, MAX и Avito (Wazzup24)", `${origin}/api/webhooks/wazzup/<WAZZUP_WEBHOOK_SECRET>`, "Ключ агрегатора хранится в WAZZUP_API_KEY."),
      hook("Форма сайта", `${origin}/api/webhooks/webform`, "POST с полями name, phone, email и text.")
    )
  );
  const importSection = h("div", { class: "panel settings-inner-panel" },
    h("div", { class: "line settings-panel-heading" },
      h("h2", {}, "Импорт базы"),
      h("div", { class: "spacer" }),
      h("button", { class: "btn", onclick: () => openImport(() => importHistory(importHost)) }, "Загрузить файл")
    ),
    h("p", { class: "muted" }, "Excel и CSV: клиенты, компании, сделки и товары. Перед записью можно проверить сопоставление колонок."),
    importHost
  );
  const security = ["superadmin", "admin", "manager"].includes(user.role)
    ? h("div", { class: "panel settings-inner-panel" },
        h("h2", {}, "Журнал действий"),
        h("p", { class: "muted" }, "Входы, чтение и изменение карточек, поиск, импорт и печать."),
        auditHost
      )
    : null;

  mount(page,
    h("div", { class: "settings-page-head" },
      h("h1", { class: "page-title display" }, "Настройки"),
      h("p", { class: "page-sub" }, "Основные параметры CRM. Разделы можно раскрывать по мере необходимости.")
    ),
    h("div", { class: "settings-sections" },
      section("Профиль и оформление", "Учётная запись и тема интерфейса", profile, true),
      section("Рабочие процессы", "Воронки, стадии и справочник причин отказа", workflow),
      section("Коммуникации", "Шаблоны ответов, документы и внешние каналы", communication),
      section("Импорт данных", "Загрузка и проверка таблиц", importSection),
      security ? section("Контроль и безопасность", "Журнал операций с данными", security) : null
    )
  );

  await Promise.all([
    loadPipelines(pipelinesHost, isManager),
    loadReasons(reasonsHost, isManager),
    loadReplies(repliesHost, user),
    loadTemplates(templatesHost, isManager),
    importHistory(importHost),
    ["superadmin", "admin", "manager"].includes(user.role) ? loadAudit(auditHost) : Promise.resolve(),
  ]);
}

/* ---------- Воронки ---------- */

async function loadPipelines(host, isManager) {
  const pipelines = await api("/pipelines");
  mount(host,
    h("div", { class: "stack" },
      ...pipelines.map((pipeline) =>
        h("div", { style: { marginBottom: "10px" } },
          h("div", { class: "line", style: { marginBottom: "6px" } },
            h("b", {}, pipeline.name),
            pipeline.is_default ? h("span", { class: "chip" }, "по умолчанию") : null,
            h("div", { class: "spacer" }),
            isManager && !pipeline.is_default
              ? h("button", {
                  class: "btn quiet",
                  onclick: async () => {
                    await api(`/pipelines/${pipeline.id}`, { method: "PATCH", body: { is_default: true } });
                    loadPipelines(host, isManager);
                  },
                }, "Сделать основной")
              : null
          ),
          h("table", { class: "table" },
            h("thead", {}, h("tr", {},
              h("th", {}, "Стадия"), h("th", {}, "Тип"), h("th", {}, "Обязательные поля"), h("th", {}, "")
            )),
            h("tbody", {}, ...pipeline.stages.map((stage) =>
              h("tr", {},
                h("td", {}, stage.name),
                h("td", { style: { color: "var(--ink-4)" } }, STAGE_KINDS[stage.kind] || stage.kind),
                h("td", { style: { color: "var(--ink-3)" } },
                  stage.required_fields
                    ? stage.required_fields.split(",").map((f) => REQUIRED_FIELD_LABELS[f] || f).join(", ")
                    : "—"),
                h("td", {},
                  isManager
                    ? h("button", {
                        class: "btn quiet",
                        onclick: () => editStage(pipeline, stage, () => loadPipelines(host, isManager)),
                      }, "Изменить")
                    : null)
              )
            ))
          )
        )
      ),
      isManager
        ? h("button", { class: "btn", onclick: () => createPipeline(() => loadPipelines(host, isManager)) }, "+ Воронка")
        : null
    )
  );
}

function editStage(pipeline, stage, onDone) {
  const name = h("input", { type: "text", value: stage.name });
  const required = h("input", { type: "text", value: stage.required_fields || "", placeholder: "amount,next_step" });
  const probability = h("input", { type: "number", min: "0", max: "100", value: String(stage.probability || 0) });

  const close = sheet(`Стадия «${stage.name}»`,
    h("div", {},
      field("Название", name),
      field("Обязательные поля", required),
      h("div", { style: { fontSize: "12px", color: "var(--ink-4)", marginTop: "-10px", marginBottom: "14px" } },
        "Через запятую: amount, contact_id, company_id, next_step"),
      field("Вероятность, %", probability),
      h("button", {
        class: "btn solid wide",
        onclick: async () => {
          try {
            await api(`/pipelines/${pipeline.id}/stages/${stage.id}`, {
              method: "PATCH",
              body: { name: name.value, required_fields: required.value, probability: Number(probability.value) },
            });
            toast("Стадия обновлена");
            close();
            onDone();
          } catch (err) { toast(err.message); }
        },
      }, "Сохранить")
    )
  );
}

function createPipeline(onDone) {
  const name = h("input", { type: "text", required: true, placeholder: "Сервис" });
  const close = sheet("Новая воронка",
    h("div", {},
      field("Название", name),
      h("p", { style: { fontSize: "12.5px", color: "var(--ink-4)" } },
        "Будут созданы четыре стадии по умолчанию: новая, в работе, успех, отказ. Их можно переименовать."),
      h("button", {
        class: "btn solid wide",
        onclick: async () => {
          try {
            await api("/pipelines", { method: "POST", body: { name: name.value } });
            toast("Воронка создана");
            close();
            onDone();
          } catch (err) { toast(err.message); }
        },
      }, "Создать")
    )
  );
}

/* ---------- Причины отказа ---------- */

async function loadReasons(host, isManager) {
  const reasons = await api("/lost-reasons");
  const input = h("input", { type: "text", placeholder: "Новая причина" });

  mount(host,
    h("div", {},
      reasons.length
        ? h("div", { class: "stack" },
            ...reasons.map((reason) =>
              h("div", { class: "line", style: { padding: "4px 0" } },
                h("span", {}, reason.name),
                h("div", { class: "spacer" }),
                isManager
                  ? h("button", {
                      class: "btn quiet",
                      onclick: async () => {
                        await api(`/lost-reasons/${reason.id}`, { method: "DELETE" });
                        loadReasons(host, isManager);
                      },
                    }, "Скрыть")
                  : null
              )
            )
          )
        : empty("Справочник пуст"),
      isManager
        ? h("div", { class: "line", style: { gap: "8px", marginTop: "12px" } },
            input,
            h("button", {
              class: "btn",
              onclick: async () => {
                if (!input.value.trim()) return;
                await api("/lost-reasons", { method: "POST", body: { name: input.value.trim() } });
                input.value = "";
                loadReasons(host, isManager);
              },
            }, "Добавить")
          )
        : null
    )
  );
}

/* ---------- Быстрые ответы ---------- */

async function loadReplies(host, user) {
  const replies = await api("/quick-replies");
  mount(host,
    h("div", {},
      replies.length
        ? h("div", { class: "stack" },
            ...replies.map((reply) =>
              h("div", { style: { paddingBottom: "8px", borderBottom: "1px solid var(--hair)" } },
                h("div", { class: "line" },
                  h("b", { style: { fontSize: "13.5px" } }, reply.title),
                  reply.shortcut ? h("span", { class: "mono", style: { color: "var(--ink-4)" } }, `/${reply.shortcut}`) : null,
                  h("div", { class: "spacer" }),
                  h("span", { style: { fontSize: "12px", color: "var(--ink-4)" } }, `применён ${reply.used_count}`),
                  h("button", {
                    class: "btn quiet",
                    onclick: async () => {
                      try {
                        await api(`/quick-replies/${reply.id}`, { method: "DELETE" });
                        loadReplies(host, user);
                      } catch (err) { toast(err.message); }
                    },
                  }, "Удалить")
                ),
                h("div", { style: { fontSize: "12.5px", color: "var(--ink-3)" } }, reply.body)
              )
            )
          )
        : empty("Шаблонов пока нет"),
      user.role !== "viewer"
        ? h("button", {
            class: "btn", style: { marginTop: "12px" },
            onclick: () => createReply(() => loadReplies(host, user)),
          }, "+ Шаблон")
        : null
    )
  );
}

function createReply(onDone) {
  const title = h("input", { type: "text", required: true, placeholder: "Отправка КП" });
  const shortcut = h("input", { type: "text", placeholder: "кп" });
  const body = h("textarea", { placeholder: "Текст ответа клиенту" });

  const close = sheet("Шаблон быстрого ответа",
    h("div", {},
      h("div", { class: "grid2" }, field("Название", title), field("Сокращение", shortcut)),
      field("Текст", body),
      h("button", {
        class: "btn solid wide",
        onclick: async () => {
          try {
            await api("/quick-replies", {
              method: "POST",
              body: { title: title.value, shortcut: shortcut.value, body: body.value },
            });
            toast("Шаблон сохранён");
            close();
            onDone();
          } catch (err) { toast(err.message); }
        },
      }, "Сохранить")
    )
  );
}

/* ---------- Печатные бланки ---------- */

async function loadTemplates(host, isManager) {
  const { templates } = await api("/documents/templates");
  mount(host,
    h("table", { class: "table" },
      h("thead", {}, h("tr", {}, h("th", {}, "Бланк"), h("th", {}, "Код"), h("th", {}, "Изменён"), h("th", {}, ""))),
      h("tbody", {}, ...templates.map((template) =>
        h("tr", {},
          h("td", {}, template.name),
          h("td", { class: "mono", style: { color: "var(--ink-4)" } }, template.code),
          h("td", { style: { color: "var(--ink-4)", fontSize: "13px" } }, when(template.updated_at)),
          h("td", {},
            isManager
              ? h("button", {
                  class: "btn quiet",
                  onclick: () => editTemplate(template, () => loadTemplates(host, isManager)),
                }, "Изменить")
              : null)
        )
      ))
    )
  );
}

function editTemplate(template, onDone) {
  const name = h("input", { type: "text", value: template.name });
  const body = h("textarea", {
    rows: 18,
    style: { fontFamily: "ui-monospace, monospace", fontSize: "12px", minHeight: "320px" },
  });
  body.value = template.body;

  const close = sheet(`Бланк: ${template.name}`,
    h("div", {},
      field("Название", name),
      field("HTML бланка", body),
      h("button", {
        class: "btn solid wide",
        onclick: async () => {
          try {
            await api(`/documents/templates/${template.id}`, {
              method: "PUT",
              body: { name: name.value, body: body.value },
            });
            toast("Бланк сохранён");
            close();
            onDone();
          } catch (err) { toast(err.message); }
        },
      }, "Сохранить")
    )
  );
}

/* ---------- Журнал ---------- */

async function loadAudit(host) {
  try {
    const log = await api("/audit");
    mount(host,
      log.length
        ? h("table", { class: "table" },
            h("thead", {}, h("tr", {}, h("th", {}, "Действие"), h("th", {}, "Объект"), h("th", {}, "IP"), h("th", {}, "Когда"))),
            h("tbody", {}, ...log.slice(0, 30).map((row) =>
              h("tr", {},
                h("td", {}, row.action),
                h("td", { style: { color: "var(--ink-3)" } }, `${row.entity} ${row.entity_id || ""}`),
                h("td", { class: "mono", style: { color: "var(--ink-4)" } }, row.ip || "—"),
                h("td", { style: { color: "var(--ink-4)", fontSize: "13px" } }, when(row.created_at))
              )
            ))
          )
        : empty("Записей пока нет")
    );
  } catch (err) { mount(host, empty(err.message)); }
}
