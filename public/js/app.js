/** Оболочка приложения: маршрутизация, боковая панель, командная строка. */
import { api, h, initials, mount, overlay, token, toast, CHANNELS, dueLabel, money } from "./core.js";

import { renderLogin, renderRegister, renderVisitorAccount } from "./views/gate.js";
import { renderUsers } from "./views/users.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderInbox } from "./views/inbox.js";
import { renderTasks } from "./views/tasks.js";
import { renderContacts } from "./views/contacts.js";
import { renderOrders } from "./views/orders.js";
import { renderSettings } from "./views/settings.js";
import { renderStore } from "./views/store.js";
import { renderReservations } from "./views/reservations.js";
import { renderSeo } from "./views/seo.js";
import { renderIndexing } from "./views/indexing.js";
import { renderMail } from "./views/mail.js";

export const state = { user: null, stats: null };

const NAV = [
  { path: "/", label: "Обзор", glyph: "◇", render: renderDashboard, crumb: "Обзор" },
  { path: "/inbox", label: "Диалоги", glyph: "❐", render: renderInbox, crumb: "Диалоги", full: true },
  { path: "/tasks", label: "Задачи", glyph: "✓", render: renderTasks, crumb: "Задачи" },
  { path: "/contacts", label: "Клиенты", glyph: "☰", render: renderContacts, crumb: "Клиенты" },
  { path: "/orders", label: "Заказы", glyph: "▤", render: renderOrders, crumb: "Заказы" },
  { path: "/settings", label: "Настройки", glyph: "⚙", render: renderSettings, crumb: "Настройки" },
  { path: "/store", label: "Витрина", glyph: "▧", render: renderStore, crumb: "Витрина", roles:["superadmin","admin","manager"] },
  { path: "/reservations", label: "Бронирования", glyph: "◷", render: renderReservations, crumb: "Бронирования", roles:["superadmin","admin","manager"] },
  { path: "/seo", label: "SEO-оценка", glyph: "⌕", render: renderSeo, crumb: "SEO-оценка", roles:["superadmin","admin","manager"] },
  { path: "/indexing", label: "Индексация", glyph: "▥", render: renderIndexing, crumb: "Индексация", roles:["superadmin","admin","manager"] },
  { path: "/mail", label: "Почта", glyph: "✉", render: renderMail, crumb: "Почта", roles:["superadmin","admin","manager"] },
  { path: "/users", label: "Команда", glyph: "♙", render: renderUsers, crumb: "Команда", roles:["superadmin","admin","manager"] },
];

const root = () => document.getElementById("root");
export const go = (path) => { location.hash = `#${path}`; };
const currentPath = () => (location.hash || "#/").slice(1).split("?")[0] || "/";

/* ---------- Тема ---------- */
export function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("rucrm.theme", next);
  return next;
}

/* ---------- Боковая панель ---------- */
function rail(active) {
  const { user, stats } = state;
  const displayName = user?.role === "superadmin" ? "Рабочий аккаунт" : (user?.full_name || user?.email || "Пользователь");
  return h("aside", { class: "rail" },
    h("div", { class: "rail-brand" }, h("div", { class: "mark logo-mark" }, h("img", { src:"/assets/brand/vapelab-logo.webp", alt:"" })), h("b", {}, "VAPELAB CRM")),
    h("a", { class: "rail-item storefront-return", href: "/", title: "Вернуться в магазин" }, h("span", { class: "glyph" }, "↗"), h("span", {}, "Вернуться в магазин")),

    h("button", { class: "rail-search", onclick: openPalette },
      h("span", {}, "⌕"), h("span", {}, "Поиск"), h("kbd", {}, "⌘K")
    ),

    h("div", { class: "rail-group" },
      h("span", { class: "eyebrow", style: { display: "block", padding: "0 8px 6px" } }, "Работа"),
      ...NAV.filter((item) => (!item.roles || item.roles.includes(state.user?.role)) && (!item.roles || item.roles.includes(state.user?.role))).map((item) =>
        h("a", {
          class: "rail-item" + (item.path === active ? " active" : ""),
          href: `#${item.path}`,
        },
          h("span", { class: "glyph" }, item.glyph),
          h("span", {}, item.label),
          item.path === "/inbox" && stats?.unread ? h("span", { class: "tally" }, String(stats.unread)) : null,
          item.path === "/tasks" && stats?.tasks?.today
            ? h("span", { class: "tally" + (stats.tasks.overdue ? " warn" : "") }, String(stats.tasks.today))
            : null
        )
      )
    ),

    h("div", { class: "rail-foot" },
      h("div", {
        class: "rail-user",
        onclick: () => {
          if (confirm("Выйти из системы?")) { token.set(null); state.user = null; go("/login"); render(); }
        },
      },
        h("div", { class: "avatar" }, initials(displayName)),
        h("div", { class: "who" },
          h("div", {}, displayName),
          h("div", {}, ROLE_LABELS[user?.role] || user?.role)
        )
      )
    )
  );
}

const ROLE_LABELS = { superadmin:"Администратор", admin: "Администратор", manager: "Менеджер", agent: "Сотрудник", viewer: "Наблюдатель", visitor:"Посетитель" };

/* ---------- Командная строка (⌘K) ---------- */
export async function openPalette() {
  const input = h("input", { type: "search", placeholder: "Клиент, компания или номер заказа…", autofocus: true });
  const results = h("div", { class: "results" });
  const box = h("div", { class: "palette" }, input, results);
  const close = overlay(box, { placement: "top" });

  const showNav = () => {
    results.replaceChildren(
      h("div", { class: "group" }, "Переходы"),
      ...NAV.filter((item) => (!item.roles || item.roles.includes(state.user?.role)) && (!item.roles || item.roles.includes(state.user?.role))).map((item) =>
        h("div", { class: "hit", onclick: () => { close(); go(item.path); } },
          h("span", {}, item.glyph), h("span", {}, item.label)
        )
      )
    );
  };
  showNav();

  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return showNav();
    timer = setTimeout(async () => {
      try {
        const data = await api(`/search?q=${encodeURIComponent(q)}`);
        const groups = [
          ["Клиенты", data.contacts, (c) => [c.full_name, c.phone || c.email, () => go("/contacts")]],
          ["Компании", data.companies, (c) => [c.name, c.inn && `ИНН ${c.inn}`, () => go("/contacts")]],
          ["Задачи", data.tasks, (t) => [t.title, dueLabel(t.due_at), () => go("/tasks")]],
          ["Заказы", data.orders, (o) => [o.number, money(o.total), () => go("/orders")]],
          ["Диалоги", data.conversations, (c) => [c.subject || c.external_chat_id, CHANNELS[c.channel_type], () => go("/inbox")]],
        ].filter(([, list]) => list?.length);

        results.replaceChildren(
          ...(groups.length
            ? groups.flatMap(([title, list, map]) => [
                h("div", { class: "group" }, title),
                ...list.map((item) => {
                  const [label, meta, action] = map(item);
                  return h("div", { class: "hit", onclick: () => { close(); action(); } },
                    h("span", {}, label),
                    meta ? h("span", { class: "meta" }, meta) : null
                  );
                }),
              ])
            : [h("div", { class: "empty" }, "Ничего не найдено")])
        );
      } catch (err) { toast(err.message); }
    }, 220);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") results.querySelector(".hit")?.click();
  });
  setTimeout(() => input.focus(), 30);
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && state.user) {
    e.preventDefault();
    openPalette();
  }
});

/* ---------- Отрисовка ---------- */
export async function render() {
  const path = currentPath();

  if (!state.user) {
    if (path === "/register") return mount(root(), renderRegister());
    return mount(root(), renderLogin());
  }
  if (path === "/login" || path === "/register") return go("/");
  if (state.user.role === "visitor") return renderVisitorAccount(root());

  const allowedNav = NAV.filter((n) => (!n.roles || n.roles.includes(state.user.role)) && (!n.roles || n.roles.includes(state.user.role)));
  const item = allowedNav.find((n) => n.path === path) || allowedNav[0];
  const page = h("div", { class: item.full ? "" : "page" });

  mount(root(),
    h("div", { class: "shell" },
      rail(item.path),
      h("div", { class: "canvas" },
        h("div", { class: "topbar" },
          h("span", { class: "crumb" }, "Рабочее пространство"),
          h("span", {}, "/"),
          h("span", { class: "crumb", style: { color: "var(--ink)" } }, item.crumb),
          h("div", { class: "spacer" }),
          h("button", { class: "btn quiet", onclick: () => { toggleTheme(); render(); } },
            document.documentElement.dataset.theme === "dark" ? "Светлая тема" : "Тёмная тема"),
          h("button", { class: "btn quiet", onclick: openPalette }, "⌘K")
        ),
        page
      )
    )
  );

  try {
    await item.render(page);
  } catch (err) {
    mount(page, h("div", { class: "empty" }, err.message));
  }

  refreshStats();
}

async function refreshStats() {
  try {
    state.stats = await api("/stats");
    const unread = document.querySelector('.rail-item[href="#/inbox"] .tally');
    if (unread) unread.textContent = String(state.stats.unread || "");
    const tasks = document.querySelector('.rail-item[href="#/tasks"] .tally');
    if (tasks) tasks.textContent = String(state.stats.tasks?.today || "");
  } catch { /* тихо: счётчик не критичен */ }
}

/* ---------- Старт ---------- */
window.addEventListener("hashchange", render);

(async function boot() {
  if (token.get()) {
    try { state.user = await api("/auth/me"); } catch { token.set(null); }
  }
  render();
})();
