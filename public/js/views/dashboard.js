/** Обзор: ключевые метрики, задачи на сегодня, воронка, причины отказа, переписка. */
import { api, CHANNELS, h, money, mount, num, when } from "../core.js";
import { go } from "../app.js";

export async function renderDashboard(page) {
  mount(page, h("div", { class: "skeleton", style: { width: "220px", height: "40px" } }));
  const s = await api("/stats");

  const metric = (label, value, note, onclick) =>
    h("div", { class: "cell" + (onclick ? " clickable" : ""), onclick },
      h("span", { class: "eyebrow" }, label),
      h("div", { class: "numeral" }, value),
      note ? h("div", { class: "note" }, note) : null
    );

  const stages = Object.entries(s.funnel);
  const totalFunnelCount = stages.reduce((sum, [, stage]) => sum + Number(stage.count || 0), 0);
  const totalFunnelAmount = stages.reduce((sum, [, stage]) => sum + Number(stage.amount || 0), 0);
  const maxStage = Math.max(1, ...stages.map(([, stage]) => stage.count));

  mount(page,
    h("h1", { class: "page-title display" }, "Обзор"),
    h("p", { class: "page-sub" }, "Состояние клиентской базы, задач, продаж и переписки на сегодня."),

    h("div", { class: "cards four" },
      metric("Задачи на сегодня", num(s.tasks.today),
        s.tasks.overdue ? `${num(s.tasks.overdue)} просрочено` : "просрочек нет",
        () => go("/tasks")),
      metric("Диалоги", num(s.open_conversations),
        s.unread ? `${num(s.unread)} непрочитанных` : "всё прочитано",
        () => go("/inbox")),
      metric("Клиенты", num(s.contacts), "в базе", () => go("/contacts")),
      metric("Заказы", num(s.orders), `на ${money(s.orders_total)}`, () => go("/orders"))
    ),

    h("div", { class: "hr" }),

    h("div", { class: "cards two", style: { background: "transparent", border: "none", gap: "16px" } },
      h("div", { class: "panel" },
        h("h2", {}, "Воронка продаж"),
        ...stages.map(([, stage]) =>
          h("div", { style: { marginBottom: "14px" } },
            h("div", { class: "line", style: { fontSize: "13px", marginBottom: "5px" } },
              h("span", {}, stage.name),
              h("div", { class: "spacer" }),
              h("span", { style: { color: "var(--ink-4)" } }, `${num(stage.count)} · ${money(stage.amount)}`)
            ),
            h("div", { class: "bar" }, h("i", { style: { width: `${(stage.count / maxStage) * 100}%` } }))
          )
        )
      ),

      h("div", { class: "panel" },
        h("h2", {}, "Причины отказа"),
        s.lost_reasons.length
          ? h("div", { class: "stack" },
              ...s.lost_reasons.map((reason) =>
                h("div", { class: "line", style: { fontSize: "13.5px" } },
                  h("span", {}, reason.name),
                  h("div", { class: "spacer" }),
                  h("span", { style: { color: "var(--ink-4)" } }, num(reason.count))
                )
              )
            )
          : h("div", { style: { color: "var(--ink-4)", fontSize: "13px" } },
              "Пока ни одна сделка не закрыта отказом — или причина не указана."),

        h("div", { class: "hr", style: { margin: "18px 0" } }),
        h("h2", {}, "Последние сообщения"),
        s.recent_messages.length
          ? h("div", { class: "stack" },
              ...s.recent_messages.map((m) =>
                h("div", { class: "line", style: { alignItems: "flex-start", gap: "10px" } },
                  h("span", { class: "dot" + (m.direction === "inbound" ? "" : " hollow"), style: { marginTop: "8px" } }),
                  h("div", { style: { minWidth: 0 } },
                    h("div", { style: { fontSize: "13.5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, m.body || "—"),
                    h("div", { style: { fontSize: "11.5px", color: "var(--ink-4)" } },
                      `${m.subject || "Клиент"} · ${CHANNELS[m.channel_type] || m.channel_type} · ${when(m.created_at)}`)
                  )
                )
              )
            )
          : h("div", { class: "empty" }, "Переписки пока нет")
      )
    ),
    h("div", { class: "panel dashboard-owner-funnel", style: { marginTop: "16px" } },
      h("div", { class: "line", style: { alignItems: "baseline", gap: "12px" } },
        h("h2", {}, "Общая воронка по ответственным"),
        h("div", { class: "spacer" }),
        h("span", { class: "muted" }, "Все сотрудники и общий результат")
      ),
      Array.isArray(s.funnel_by_owner) && s.funnel_by_owner.length
        ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
            h("thead", {}, h("tr", {}, h("th", {}, "Ответственный"), h("th", {}, "Сделок"), h("th", {}, "Сумма"), ...stages.map(([, stage]) => h("th", {}, stage.name)))),
            h("tbody", {},
              ...s.funnel_by_owner.map((owner) => h("tr", {},
                h("td", {}, h("strong", {}, owner.owner_name)),
                h("td", {}, num(owner.total_count)),
                h("td", {}, money(owner.total_amount)),
                ...stages.map(([code]) => h("td", {}, num(owner.stages?.[code]?.count || 0)))
              )),
              h("tr", { class: "table-total-row" },
                h("td", {}, h("strong", {}, "ИТОГО ПО ВСЕМ")),
                h("td", {}, num(totalFunnelCount)),
                h("td", {}, money(totalFunnelAmount)),
                ...stages.map(([code]) => h("td", {}, num(s.funnel?.[code]?.count || 0)))
              )
            )
          ))
        : h("p", { class: "muted" }, "Пока нет сделок в выбранной воронке.")
    )
  );
}
