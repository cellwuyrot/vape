/** Клиенты: таблица, поиск, импорт, поиск дублей и карточка с лентой активности. */
import {
  ACTIVITY_GLYPHS, CHANNELS, api, debounce, empty, field, h, initials, money, mount, sheet, toast, when,
} from "../core.js";
import { openCreate as openTaskCreate, taskRow } from "./tasks.js";
import { openImport } from "./import.js";
import { openPrintMenu } from "./print.js";

export async function renderContacts(page) {
  const search = h("input", { type: "search", placeholder: "Имя, телефон, почта, тег…", style: { width: "300px" } });
  const table = h("div");

  const load = async () => {
    const q = search.value.trim();
    const list = await api(`/contacts${q ? `?q=${encodeURIComponent(q)}` : ""}`);
    mount(table,
      list.length
        ? h("table", { class: "table" },
            h("thead", {}, h("tr", {},
              h("th", {}, "Клиент"), h("th", {}, "Контакты"), h("th", {}, "Источник"),
              h("th", {}, "Согласие ПДн"), h("th", {}, "Добавлен")
            )),
            h("tbody", {}, ...list.map((c) =>
              h("tr", { onclick: () => openCard(c.id, load) },
                h("td", {},
                  h("div", { class: "line" },
                    h("div", { class: "avatar" }, initials(c.full_name)),
                    h("div", {},
                      h("div", { style: { fontWeight: 500 } }, c.full_name),
                      c.position ? h("div", { style: { fontSize: "12px", color: "var(--ink-4)" } }, c.position) : null
                    )
                  )
                ),
                h("td", {},
                  h("div", {}, c.phone || "—"),
                  c.email ? h("div", { style: { fontSize: "12px", color: "var(--ink-4)" } }, c.email) : null
                ),
                h("td", {}, h("span", { class: "chip" }, CHANNELS[c.source] || c.source)),
                h("td", {}, c.pd_consent ? h("span", { class: "chip" }, "получено") : h("span", { class: "chip plain" }, "нет")),
                h("td", { style: { color: "var(--ink-4)", fontSize: "13px" } }, when(c.created_at))
              )
            ))
          )
        : empty(search.value ? "Ничего не найдено" : "База клиентов пуста")
    );
  };

  search.addEventListener("input", debounce(load, 240));

  mount(page,
    h("div", { class: "line", style: { marginBottom: "26px" } },
      h("div", {},
        h("h1", { class: "page-title display" }, "Клиенты"),
        h("p", { class: "page-sub", style: { margin: 0 } }, "Единая база: контакты, история сделок и переписки.")
      ),
      h("div", { class: "spacer" }),
      search,
      h("button", { class: "btn quiet", onclick: () => openDuplicates(load) }, "Дубли"),
      h("button", { class: "btn quiet", onclick: () => openImport(load) }, "Импорт"),
      h("button", { class: "btn solid", onclick: () => openCreate(load) }, "Добавить клиента")
    ),
    table
  );

  await load();
}

/* ---------- Создание с проверкой дублей ---------- */

function openCreate(onDone) {
  const inputs = {
    full_name: h("input", { type: "text", required: true, placeholder: "Иванов Иван" }),
    phone: h("input", { type: "tel", placeholder: "+7 999 123-45-67" }),
    email: h("input", { type: "email", placeholder: "client@company.ru" }),
    position: h("input", { type: "text", placeholder: "Коммерческий директор" }),
    tags: h("input", { type: "text", placeholder: "vip, опт" }),
    comment: h("textarea", { placeholder: "Что важно помнить об этом клиенте" }),
  };
  const consent = h("input", { type: "checkbox" });
  const hint = h("div", { class: "dup-hint" });
  const save = h("button", { class: "btn solid wide", type: "submit" }, "Сохранить");
  let force = false;

  /** Подсказка о дубле появляется до сохранения — это дешевле, чем склейка потом. */
  const checkDuplicates = debounce(async () => {
    const phone = inputs.phone.value.trim();
    const email = inputs.email.value.trim();
    if (!phone && !email) return mount(hint);
    try {
      const { matches } = await api(`/contacts/check?phone=${encodeURIComponent(phone)}&email=${encodeURIComponent(email)}`);
      mount(hint,
        matches.length
          ? h("div", { class: "warn-box" },
              h("b", {}, "Похоже, такой клиент уже есть"),
              ...matches.slice(0, 3).map((m) =>
                h("div", { class: "line" },
                  h("span", {}, `${m.full_name} · ${m.phone || m.email}`),
                  h("div", { class: "spacer" }),
                  h("button", {
                    class: "btn quiet", type: "button",
                    onclick: () => { close(); openCard(m.id, onDone); },
                  }, "Открыть")
                )
              )
            )
          : null
      );
    } catch { /* подсказка не критична */ }
  }, 350);

  inputs.phone.addEventListener("input", checkDuplicates);
  inputs.email.addEventListener("input", checkDuplicates);

  const close = sheet("Новый клиент",
    h("form", {
      onsubmit: async (e) => {
        e.preventDefault();
        save.disabled = true;
        try {
          await api("/contacts", {
            method: "POST",
            body: {
              ...Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])),
              pd_consent: consent.checked,
              force,
            },
          });
          toast("Клиент добавлен");
          close();
          onDone();
        } catch (err) {
          save.disabled = false;
          // Первый отказ по дублю — предупреждение, второе нажатие сохраняет намеренно
          if (/уже есть/i.test(err.message) && !force) {
            force = true;
            save.textContent = "Всё равно сохранить";
            mount(hint, h("div", { class: "warn-box" }, err.message));
            return;
          }
          toast(err.message);
        }
      },
    },
      field("ФИО", inputs.full_name),
      h("div", { class: "grid2" }, field("Телефон", inputs.phone), field("E-mail", inputs.email)),
      hint,
      h("div", { class: "grid2" }, field("Должность", inputs.position), field("Теги", inputs.tags)),
      field("Комментарий", inputs.comment),
      h("label", { class: "check", style: { marginBottom: "18px" } },
        consent, h("span", {}, "Получено согласие на обработку персональных данных")),
      save
    )
  );
}

/* ---------- Карточка клиента ---------- */

async function openCard(id, onDone) {
  const c = await api(`/contacts/${id}`);
  const feedHost = h("div");
  const tasksHost = h("div", { class: "stack" });
  const note = h("textarea", { placeholder: "Заметка или итог звонка…", rows: 2 });

  const paintFeed = (feed) => {
    mount(feedHost,
      feed.length
        ? h("div", { class: "feed" },
            ...feed.map((item) =>
              h("div", { class: `feed-item ${item.kind}` },
                h("span", { class: "feed-glyph" }, ACTIVITY_GLYPHS[item.kind] || "•"),
                h("div", { style: { minWidth: 0 } },
                  h("div", { style: { fontSize: "13.5px" } }, item.title),
                  item.body ? h("div", { class: "feed-body" }, item.body) : null,
                  h("div", { class: "feed-meta" },
                    [when(item.at), item.channel ? CHANNELS[item.channel] || item.channel : null, item.author]
                      .filter(Boolean).join(" · "))
                )
              )
            )
          )
        : h("div", { style: { color: "var(--ink-4)", fontSize: "13px" } }, "Событий пока нет")
    );
  };

  const reload = async () => {
    const fresh = await api(`/contacts/${id}`);
    paintFeed(fresh.feed);
    mount(tasksHost,
      fresh.tasks.length
        ? h("div", { class: "stack" }, ...fresh.tasks.map((t) => taskRow(t, reload)))
        : h("div", { style: { color: "var(--ink-4)", fontSize: "13px" } }, "Открытых задач нет")
    );
    onDone?.();
  };

  const rows = (title, items, render) =>
    h("div", { style: { marginBottom: "18px" } },
      h("span", { class: "eyebrow" }, title),
      items.length
        ? h("div", { class: "stack", style: { marginTop: "8px" } }, ...items.map(render))
        : h("div", { style: { color: "var(--ink-4)", fontSize: "13px", marginTop: "6px" } }, "—")
    );

  const addNote = async (type) => {
    if (!note.value.trim()) return;
    try {
      await api(`/contacts/${id}/notes`, { method: "POST", body: { body: note.value, type } });
      note.value = "";
      await reload();
    } catch (err) { toast(err.message); }
  };

  sheet(c.full_name,
    h("div", {},
      h("div", { class: "line", style: { marginBottom: "18px", gap: "14px" } },
        h("div", { class: "avatar", style: { width: "42px", height: "42px", fontSize: "15px" } }, initials(c.full_name)),
        h("div", {},
          h("div", {}, c.phone || "телефон не указан"),
          h("div", { style: { fontSize: "12.5px", color: "var(--ink-4)" } }, c.email || "почта не указана")
        ),
        h("div", { class: "spacer", style: { flex: 1 } }),
        h("span", { class: "chip" }, c.pd_consent ? "согласие ПДн получено" : "согласие ПДн не получено")
      ),
      c.company ? h("div", { class: "chip plain", style: { marginBottom: "12px" } }, c.company.name) : null,
      c.comment ? h("p", { style: { fontSize: "13.5px", color: "var(--ink-2)" } }, c.comment) : null,

      h("div", { class: "line", style: { gap: "8px", marginBottom: "18px" } },
        h("button", { class: "btn", onclick: () => openTaskCreate({ contact_id: c.id }, reload) }, "+ Задача"),
        h("button", {
          class: "btn quiet",
          onclick: () => openTaskCreate({ contact_id: c.id, kind: "call" }, reload),
        }, "Запланировать звонок"),
        c.orders.length
          ? h("button", { class: "btn quiet", onclick: () => openPrintMenu({ order_id: c.orders[0].id }) }, "Документы")
          : null
      ),

      h("span", { class: "eyebrow" }, "Задачи"),
      tasksHost,
      h("div", { class: "hr", style: { margin: "18px 0" } }),

      rows("Сделки", c.deals, (d) =>
        h("div", { class: "line" },
          h("span", {}, d.title),
          h("div", { class: "spacer" }),
          h("span", { style: { color: "var(--ink-4)" } }, money(d.amount))
        )),
      rows("Заказы", c.orders, (o) =>
        h("div", { class: "line" },
          h("span", {}, o.number),
          h("div", { class: "spacer" }),
          h("button", { class: "btn quiet", onclick: () => openPrintMenu({ order_id: o.id }) }, "Печать"),
          h("span", { style: { color: "var(--ink-4)" } }, money(o.total))
        )),
      rows("Каналы связи", c.conversations, (v) =>
        h("div", { class: "line" },
          h("span", {}, CHANNELS[v.channel_type] || v.channel_type),
          h("div", { class: "spacer" }),
          h("span", { style: { color: "var(--ink-4)" } }, when(v.last_message_at))
        )),

      h("div", { class: "hr", style: { margin: "18px 0" } }),
      h("span", { class: "eyebrow" }, "Лента активности"),
      h("div", { style: { margin: "10px 0 14px" } },
        note,
        h("div", { class: "line", style: { gap: "8px", marginTop: "6px" } },
          h("button", { class: "btn", onclick: () => addNote("note") }, "Добавить заметку"),
          h("button", { class: "btn quiet", onclick: () => addNote("call") }, "Записать звонок")
        )
      ),
      feedHost
    )
  );

  paintFeed(c.feed);
  await reload();
}

/* ---------- Поиск и склейка дублей ---------- */

async function openDuplicates(onDone) {
  const host = h("div");
  const close = sheet("Дубли в базе", host);

  const load = async (entity = "contacts") => {
    mount(host, h("div", { class: "skeleton", style: { height: "40px" } }));
    const { groups } = await api(`/duplicates?entity=${entity}`);

    mount(host,
      h("div", {},
        h("div", { class: "tabs", style: { marginBottom: "14px" } },
          h("button", { class: "tab" + (entity === "contacts" ? " on" : ""), onclick: () => load("contacts") }, "Клиенты"),
          h("button", { class: "tab" + (entity === "companies" ? " on" : ""), onclick: () => load("companies") }, "Компании")
        ),
        groups.length
          ? h("div", { class: "stack" },
              ...groups.map((group) =>
                h("div", { class: "panel", style: { padding: "14px" } },
                  h("div", { class: "line", style: { marginBottom: "8px" } },
                    h("span", { class: "chip" }, `совпадает ${group.reason_label}`),
                    h("span", { class: "mono", style: { color: "var(--ink-4)", fontSize: "12px" } }, group.value)
                  ),
                  ...group.items.map((item, index) =>
                    h("div", { class: "line", style: { padding: "5px 0" } },
                      h("span", {}, `${item.title} · #${item.id}`),
                      h("span", { style: { color: "var(--ink-4)", fontSize: "12.5px" } },
                        ` ${item.phone || item.email || item.inn || ""}`),
                      h("div", { class: "spacer" }),
                      index === 0
                        ? h("span", { class: "chip plain" }, "основная")
                        : entity === "contacts"
                          ? h("button", {
                              class: "btn quiet",
                              onclick: async () => {
                                try {
                                  await api(`/contacts/${item.id}/merge`, { method: "POST", body: { into: group.items[0].id } });
                                  toast(`Объединено с карточкой #${group.items[0].id}`);
                                  await load(entity);
                                  onDone?.();
                                } catch (err) { toast(err.message); }
                              },
                            }, "Присоединить к основной")
                          : null
                    )
                  )
                )
              )
            )
          : empty("Дублей не найдено — база чистая"),
        h("div", { class: "line", style: { marginTop: "16px" } },
          h("div", { class: "spacer" }),
          h("button", { class: "btn quiet", onclick: () => close() }, "Закрыть")
        )
      )
    );
  };

  await load();
}
