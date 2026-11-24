/**
 * Воронки сделок: переключатель воронок, колонки по стадиям, перетаскивание.
 *
 * Стадии приходят с сервера — их набор у каждой воронки свой. Если стадия
 * требует заполненных полей или причины отказа, сервер отвечает ошибкой,
 * и здесь мы не прячем её в тост, а сразу показываем нужную форму.
 */
import { DOC_KINDS, api, empty, field, h, money, mount, sheet, toast, when } from "../core.js";
import { openCreate as openTaskCreate, taskRow } from "./tasks.js";
import { printDocument } from "./print.js";

let activePipeline = null;

export async function renderDeals(page) {
  const pipelines = await api("/pipelines");
  if (!pipelines.length) return mount(page, empty("Не настроено ни одной воронки"));

  const current = () => pipelines.find((p) => p.id === activePipeline) || pipelines[0];
  activePipeline = current().id;

  const board = h("div", { class: "board" });
  const switcher = h("div", { class: "tabs" },
    ...pipelines.map((pipeline) =>
      h("button", {
        class: "tab" + (pipeline.id === activePipeline ? " on" : ""),
        onclick: (e) => {
          activePipeline = pipeline.id;
          [...e.target.parentNode.children].forEach((n) => n.classList.remove("on"));
          e.target.classList.add("on");
          load();
        },
      }, pipeline.name)
    )
  );

  const load = async () => {
    const pipeline = current();
    const deals = await api(`/deals?pipeline=${pipeline.id}`);

    mount(board,
      ...pipeline.stages.map((stage) => {
        const list = deals.filter((d) => d.stage === stage.code);
        const total = list.reduce((s, d) => s + Number(d.amount || 0), 0);

        const column = h("div", { class: "column" },
          h("div", { class: "column-head" }, h("b", {}, stage.name), h("span", {}, String(list.length))),
          h("div", { class: "column-total" }, money(total)),
          stage.required_fields
            ? h("div", { class: "stage-req" }, `обязательно: ${stage.required_fields.split(",").join(", ")}`)
            : null,
          ...list.map((deal) =>
            h("div", {
              class: "tile",
              draggable: "true",
              ondragstart: (e) => e.dataTransfer.setData("text/plain", String(deal.id)),
              onclick: () => openDeal(deal.id, load),
            },
              h("b", {}, deal.title),
              h("span", { class: "sum" }, money(deal.amount)),
              deal.next_step ? h("span", { class: "next" }, deal.next_step) : null
            )
          )
        );

        column.addEventListener("dragover", (e) => { e.preventDefault(); column.classList.add("drop"); });
        column.addEventListener("dragleave", () => column.classList.remove("drop"));
        column.addEventListener("drop", async (e) => {
          e.preventDefault();
          column.classList.remove("drop");
          const id = e.dataTransfer.getData("text/plain");
          if (id) await moveDeal(Number(id), stage, load);
        });

        return column;
      })
    );
  };

  mount(page,
    h("div", { class: "line", style: { marginBottom: "18px" } },
      h("div", {},
        h("h1", { class: "page-title display" }, "Сделки")
      ),
      h("div", { class: "spacer" }),
      h("button", { class: "btn solid", onclick: () => openCreate(current(), load) }, "Новая сделка")
    ),
    h("div", { style: { marginBottom: "18px" } }, switcher),
    board
  );

  await load();
}

/**
 * Перенос на стадию. Сервер сам решает, чего не хватает: наша задача —
 * показать форму для недостающего и повторить запрос, а не спорить с ним.
 */
async function moveDeal(dealId, stage, onDone) {
  try {
    await api(`/deals/${dealId}`, { method: "PATCH", body: { stage: stage.code } });
    onDone();
  } catch (err) {
    if (stage.kind === "lost" && /причин/i.test(err.message)) return askLostReason(dealId, stage, onDone);
    if (/требует заполнить/i.test(err.message)) return askRequired(dealId, stage, onDone, err.message);
    toast(err.message);
  }
}

async function askLostReason(dealId, stage, onDone) {
  const reasons = await api("/lost-reasons");
  const select = h("select", {}, ...reasons.map((r) => h("option", { value: String(r.id) }, r.name)));
  const comment = h("textarea", { placeholder: "Что именно сказал клиент" });

  const close = sheet("Причина отказа",
    h("div", {},
      h("p", { style: { fontSize: "13.5px", color: "var(--ink-3)", marginTop: 0 } },
        "Без причины отказа отчёт по потерям бессмыслен — поэтому поле обязательное."),
      field("Причина", select),
      field("Комментарий", comment),
      h("button", {
        class: "btn solid wide",
        onclick: async () => {
          try {
            await api(`/deals/${dealId}`, {
              method: "PATCH",
              body: {
                stage: stage.code,
                lost_reason_id: Number(select.value),
                next_step: comment.value || undefined,
              },
            });
            close();
            onDone();
          } catch (err) { toast(err.message); }
        },
      }, "Закрыть сделку")
    )
  );
}

function askRequired(dealId, stage, onDone, message) {
  const amount = h("input", { type: "number", min: "0", step: "1000", placeholder: "0" });
  const nextStep = h("input", { type: "text", placeholder: "Созвон в четверг в 15:00" });
  const contact = h("select", {}, h("option", { value: "" }, "— не выбран —"));
  api("/contacts").then((list) =>
    list.forEach((c) => contact.append(h("option", { value: String(c.id) }, c.full_name)))
  );

  const needs = (name) => message.toLowerCase().includes(name);

  const close = sheet(`Стадия «${stage.name}»`,
    h("div", {},
      h("p", { style: { fontSize: "13.5px", color: "var(--ink-3)", marginTop: 0 } }, message),
      needs("сумма") ? field("Сумма, ₽", amount) : null,
      needs("следующий шаг") ? field("Следующий шаг", nextStep) : null,
      needs("клиент") ? field("Клиент", contact) : null,
      h("button", {
        class: "btn solid wide",
        onclick: async () => {
          const body = { stage: stage.code };
          if (needs("сумма")) body.amount = Number(amount.value);
          if (needs("следующий шаг")) body.next_step = nextStep.value;
          if (needs("клиент") && contact.value) body.contact_id = Number(contact.value);
          try {
            await api(`/deals/${dealId}`, { method: "PATCH", body });
            close();
            onDone();
          } catch (err) { toast(err.message); }
        },
      }, "Сохранить и перевести")
    )
  );
}

/* ---------- Карточка сделки ---------- */

async function openDeal(id, onDone) {
  const deal = await api(`/deals/${id}`);
  const tasksHost = h("div", { class: "stack" });

  const reloadTasks = async () => {
    const fresh = await api(`/deals/${id}`);
    const open = fresh.tasks.filter((t) => t.status === "open");
    mount(tasksHost,
      open.length
        ? h("div", { class: "stack" }, ...open.map((t) => taskRow(t, reloadTasks)))
        : h("div", { style: { color: "var(--ink-4)", fontSize: "13px" } }, "Открытых задач нет")
    );
    onDone?.();
  };

  sheet(deal.title,
    h("div", {},
      h("div", { class: "line", style: { marginBottom: "14px", gap: "8px" } },
        h("span", { class: "chip" }, money(deal.amount)),
        deal.contact ? h("span", { class: "chip plain" }, deal.contact.full_name) : null,
        deal.lost_reason ? h("span", { class: "chip warn" }, deal.lost_reason) : null
      ),
      deal.next_step ? h("p", { style: { fontSize: "13.5px" } }, `Следующий шаг: ${deal.next_step}`) : null,

      h("div", { class: "line", style: { gap: "8px", marginBottom: "18px" } },
        h("button", {
          class: "btn",
          onclick: () => openTaskCreate({ deal_id: deal.id, contact_id: deal.contact_id }, reloadTasks),
        }, "+ Задача"),
        h("button", { class: "btn quiet", onclick: () => printDocument("quote", { deal_id: deal.id }) }, DOC_KINDS.quote)
      ),

      h("span", { class: "eyebrow" }, "Задачи"),
      tasksHost,
      h("div", { class: "hr", style: { margin: "18px 0" } }),
      h("span", { class: "eyebrow" }, "История сделки"),
      deal.feed.length
        ? h("div", { class: "stack", style: { marginTop: "8px" } },
            ...deal.feed.map((item) =>
              h("div", { class: "line", style: { alignItems: "flex-start", gap: "10px" } },
                h("span", { class: "dot", style: { marginTop: "8px" } }),
                h("div", {},
                  h("div", { style: { fontSize: "13.5px" } }, item.title),
                  item.body ? h("div", { style: { fontSize: "12.5px", color: "var(--ink-3)" } }, item.body) : null,
                  h("div", { style: { fontSize: "11.5px", color: "var(--ink-4)" } },
                    `${when(item.created_at)}${item.user_name ? ` · ${item.user_name}` : ""}`)
                )
              )
            )
          )
        : h("div", { style: { color: "var(--ink-4)", fontSize: "13px", marginTop: "6px" } }, "—")
    )
  );

  await reloadTasks();
}

/* ---------- Создание ---------- */

function openCreate(pipeline, onDone) {
  const title = h("input", { type: "text", required: true, placeholder: "Внедрение CRM для отдела продаж" });
  const amount = h("input", { type: "number", min: "0", step: "1000", value: "0" });
  const stage = h("select", {}, ...pipeline.stages.map((s) => h("option", { value: s.code }, s.name)));
  const contact = h("select", {}, h("option", { value: "" }, "— не выбран —"));
  const nextStep = h("input", { type: "text", placeholder: "Созвон в четверг в 15:00" });
  const withTask = h("input", { type: "checkbox", checked: true });
  const save = h("button", { class: "btn solid wide", type: "submit" }, "Создать");

  api("/contacts").then((list) =>
    list.forEach((c) => contact.append(h("option", { value: String(c.id) }, c.full_name)))
  );

  const close = sheet(`Новая сделка · ${pipeline.name}`,
    h("form", {
      onsubmit: async (e) => {
        e.preventDefault();
        save.disabled = true;
        try {
          const deal = await api("/deals", {
            method: "POST",
            body: {
              title: title.value,
              amount: Number(amount.value),
              stage: stage.value,
              pipeline_id: pipeline.id,
              next_step: nextStep.value,
              contact_id: contact.value ? Number(contact.value) : null,
            },
          });
          if (withTask.checked) {
            await api("/tasks", {
              method: "POST",
              body: {
                title: nextStep.value || `Связаться по сделке «${deal.title}»`,
                kind: "call",
                deal_id: deal.id,
                contact_id: deal.contact_id,
                due_at: new Date(Date.now() + 86400_000).toISOString(),
              },
            });
          }
          toast("Сделка создана");
          close();
          onDone();
        } catch (err) { toast(err.message); save.disabled = false; }
      },
    },
      field("Название", title),
      h("div", { class: "grid2" }, field("Сумма, ₽", amount), field("Стадия", stage)),
      field("Клиент", contact),
      field("Следующий шаг", nextStep),
      h("label", { class: "check", style: { marginBottom: "18px" } },
        withTask, h("span", {}, "Сразу поставить задачу на завтра")),
      save
    )
  );
}
