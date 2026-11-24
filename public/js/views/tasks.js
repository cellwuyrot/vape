/**
 * Задачи и календарь недели.
 *
 * Экран отвечает на три вопроса менеджера: что горит, что сегодня, что на неделе.
 * Просроченное подсвечено, выполнить задачу можно одним нажатием — без карточек,
 * подтверждений и лишних переходов.
 */
import {
  TASK_KINDS, TASK_PRIORITIES, api, dueLabel, empty, field, forInput, h, isOverdue, mount, sheet, toast,
} from "../core.js";

const SCOPES = [
  { key: "today", label: "Сегодня" },
  { key: "overdue", label: "Просроченные" },
  { key: "week", label: "Неделя" },
  { key: "upcoming", label: "Впереди" },
  { key: "all", label: "Все" },
];

const WEEKDAYS = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];

export async function renderTasks(page) {
  const view = { scope: "today", mine: true, mode: "list" };
  const host = h("div");
  const counters = h("div", { class: "line", style: { gap: "8px" } });

  const tabs = h("div", { class: "tabs" },
    ...SCOPES.map((scope) =>
      h("button", {
        class: "tab" + (scope.key === view.scope ? " on" : ""),
        onclick: (e) => {
          view.scope = scope.key;
          view.mode = "list";
          [...e.target.parentNode.children].forEach((n) => n.classList.remove("on"));
          e.target.classList.add("on");
          load();
        },
      }, scope.label)
    ),
    h("button", {
      class: "tab",
      onclick: (e) => {
        view.mode = "calendar";
        [...e.target.parentNode.children].forEach((n) => n.classList.remove("on"));
        e.target.classList.add("on");
        load();
      },
    }, "Календарь")
  );

  const onlyMine = h("label", { class: "check", style: { marginBottom: 0 } },
    h("input", {
      type: "checkbox",
      checked: true,
      onchange: (e) => { view.mine = e.target.checked; load(); },
    }),
    h("span", {}, "Только мои")
  );

  const load = async () => {
    if (view.mode === "calendar") return loadCalendar();
    const { tasks, counters: stats } = await api(`/tasks?scope=${view.scope}&mine=${view.mine ? 1 : 0}&status=open`);

    mount(counters,
      h("span", { class: "chip" }, `сегодня ${stats.today}`),
      stats.overdue ? h("span", { class: "chip warn" }, `просрочено ${stats.overdue}`) : null
    );

    mount(host,
      tasks.length
        ? h("div", { class: "stack" }, ...tasks.map((task) => taskRow(task, load)))
        : empty("Задач нет. Свободный день — редкость, поставьте себе следующую.")
    );
  };

  const loadCalendar = async () => {
    const { days } = await api(`/tasks/calendar?mine=${view.mine ? 1 : 0}`);
    mount(counters);
    mount(host,
      h("div", { class: "week" },
        ...days.map((day, index) => {
          const date = new Date(day.date);
          const today = date.toDateString() === new Date().toDateString();
          return h("div", { class: "week-day" + (today ? " today" : "") },
            h("div", { class: "week-head" },
              h("b", {}, WEEKDAYS[index]),
              h("span", {}, date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }))
            ),
            ...(day.tasks.length
              ? day.tasks.map((task) =>
                  h("div", {
                    class: "week-task" + (isOverdue(task.due_at) ? " late" : ""),
                    onclick: () => openTask(task, load),
                  },
                    h("span", { class: "mono" }, new Date(task.due_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })),
                    h("span", {}, task.title)
                  )
                )
              : [h("div", { class: "week-empty" }, "—")])
          );
        })
      )
    );
  };

  mount(page,
    h("div", { class: "line", style: { marginBottom: "18px" } },
      h("div", {},
        h("h1", { class: "page-title display" }, "Задачи"),
        h("p", { class: "page-sub", style: { margin: 0 } }, "Звонки, встречи и обещания клиенту — с напоминанием и сроком.")
      ),
      h("div", { class: "spacer" }),
      counters,
      h("button", { class: "btn solid", onclick: () => openCreate({}, load) }, "Новая задача")
    ),
    h("div", { class: "line", style: { marginBottom: "18px" } }, tabs, h("div", { class: "spacer" }), onlyMine),
    host
  );

  await load();
}

/* ---------- Строка задачи ---------- */

export function taskRow(task, onDone) {
  const late = task.status === "open" && isOverdue(task.due_at);
  return h("div", { class: "task" + (late ? " late" : "") },
    h("button", {
      class: "tick",
      title: "Выполнена",
      onclick: async (e) => {
        e.stopPropagation();
        try {
          await api(`/tasks/${task.id}`, { method: "PATCH", body: { status: "done" } });
          toast("Задача выполнена");
          onDone?.();
        } catch (err) { toast(err.message); }
      },
    }, "✓"),
    h("div", { style: { minWidth: 0, flex: 1, cursor: "pointer" }, onclick: () => openTask(task, onDone) },
      h("div", { class: "line" },
        h("span", { class: "chip plain" }, TASK_KINDS[task.kind] || task.kind),
        h("span", { style: { fontWeight: 500 } }, task.title)
      ),
      h("div", { class: "task-meta" },
        h("span", { class: late ? "late-text" : "" }, dueLabel(task.due_at)),
        task.contact_name ? h("span", {}, ` · ${task.contact_name}`) : null,
        task.deal_title ? h("span", {}, ` · ${task.deal_title}`) : null,
        task.assignee_name ? h("span", {}, ` · ${task.assignee_name}`) : null
      )
    )
  );
}

/* ---------- Карточка задачи ---------- */

function openTask(task, onDone) {
  const result = h("textarea", { placeholder: "Что сделано, о чём договорились" });
  const due = h("input", { type: "datetime-local", value: forInput(task.due_at || Date.now()) });

  const close = sheet(task.title,
    h("div", {},
      h("div", { class: "line", style: { marginBottom: "14px" } },
        h("span", { class: "chip" }, TASK_KINDS[task.kind] || task.kind),
        h("span", { class: "chip plain" }, TASK_PRIORITIES[task.priority] || task.priority),
        isOverdue(task.due_at) && task.status === "open" ? h("span", { class: "chip warn" }, "просрочена") : null
      ),
      task.description ? h("p", { style: { fontSize: "13.5px", color: "var(--ink-2)" } }, task.description) : null,
      field("Перенести срок", due),
      h("button", {
        class: "btn", style: { marginBottom: "18px" },
        onclick: async () => {
          try {
            await api(`/tasks/${task.id}`, { method: "PATCH", body: { due_at: new Date(due.value).toISOString() } });
            toast("Срок перенесён");
            close(); onDone?.();
          } catch (err) { toast(err.message); }
        },
      }, "Перенести"),
      field("Результат", result),
      h("div", { class: "line", style: { gap: "8px" } },
        h("button", {
          class: "btn solid",
          onclick: async () => {
            try {
              await api(`/tasks/${task.id}`, { method: "PATCH", body: { status: "done", result: result.value } });
              toast("Задача выполнена");
              close(); onDone?.();
            } catch (err) { toast(err.message); }
          },
        }, "Выполнена"),
        h("button", {
          class: "btn quiet",
          onclick: async () => {
            try {
              await api(`/tasks/${task.id}`, { method: "PATCH", body: { status: "canceled", result: result.value } });
              close(); onDone?.();
            } catch (err) { toast(err.message); }
          },
        }, "Отменить задачу")
      )
    )
  );
}

/**
 * Создание задачи. Вызывается и с экрана задач, и из карточки клиента,
 * сделки или диалога — привязка приходит в defaults.
 */
export function openCreate(defaults = {}, onDone) {
  const title = h("input", { type: "text", required: true, placeholder: "Перезвонить и уточнить бюджет" });
  const kind = h("select", {}, ...Object.entries(TASK_KINDS).map(([k, v]) => h("option", { value: k }, v)));
  const priority = h("select", {},
    ...Object.entries(TASK_PRIORITIES).map(([k, v]) => h("option", { value: k, ...(k === "normal" ? { selected: true } : {}) }, v))
  );
  const due = h("input", { type: "datetime-local", value: forInput(Date.now() + 3600_000) });
  const description = h("textarea", { placeholder: "Детали, о чём договорились" });
  const save = h("button", { class: "btn solid wide", type: "submit" }, "Поставить задачу");

  const quick = (label, ms) =>
    h("button", {
      class: "btn quiet", type: "button",
      onclick: () => { due.value = forInput(Date.now() + ms); },
    }, label);

  const close = sheet("Новая задача",
    h("form", {
      onsubmit: async (e) => {
        e.preventDefault();
        save.disabled = true;
        try {
          await api("/tasks", {
            method: "POST",
            body: {
              title: title.value,
              kind: kind.value,
              priority: priority.value,
              description: description.value,
              due_at: new Date(due.value).toISOString(),
              ...defaults,
            },
          });
          toast("Задача поставлена");
          close();
          onDone?.();
        } catch (err) { toast(err.message); save.disabled = false; }
      },
    },
      field("Что сделать", title),
      h("div", { class: "grid2" }, field("Тип", kind), field("Приоритет", priority)),
      field("Срок", due),
      h("div", { class: "line", style: { gap: "6px", marginBottom: "16px" } },
        quick("Через час", 3600_000),
        quick("Завтра", 86400_000),
        quick("Через неделю", 7 * 86400_000)
      ),
      field("Описание", description),
      save
    )
  );
}
