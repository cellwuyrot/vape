import { api, h, mount, when } from "../core.js";

export async function renderIndexing(page) {
  let currentPage = 1;
  let eventType = "";
  const cards = h("div", { class: "cards four" });
  const charts = h("div", { class: "cards two" });
  const events = h("div", { class: "table-wrap" });
  const pager = h("div", { class: "pager-controls" });
  const period = h("select", {}, ...[[7, "7 дней"], [30, "30 дней"], [90, "90 дней"]].map(([value, label]) => h("option", { value: String(value), selected: value === 30 }, label)));
  const filter = h("select", {}, ...[["", "Все события"], ["page_view", "Просмотры страниц"], ["click", "Клики"], ["reservation_submitted", "Бронирования"]].map(([value, label]) => h("option", { value }, label)));
  mount(page,
    h("h1", { class: "page-title display" }, "Индексация и аналитика"),
    h("p", { class: "page-sub" }, "Анонимная статистика поведения посетителей после согласия на аналитические cookie. Не записываются IP-адреса, поля форм или персональные данные."),
    h("div", { class: "store-product-filters" }, period, filter), cards, charts,
    h("h2", {}, "Последние действия посетителей"), events, pager
  );
  period.addEventListener("change", loadSummary);
  filter.addEventListener("change", () => { eventType = filter.value; currentPage = 1; loadEvents(); });

  function metric(label, value, note = "") {
    return h("div", { class: "panel indexing-metric" }, h("span", { class: "muted" }, label), h("strong", {}, new Intl.NumberFormat("ru-RU").format(Number(value || 0))), note ? h("small", {}, note) : null);
  }
  function listPanel(title, items, format) {
    return h("div", { class: "panel" }, h("h2", {}, title), items.length ? h("div", { class: "indexing-list" }, ...items.map((item) => h("div", { class: "indexing-list-row" }, h("span", {}, format(item)), h("strong", {}, String(item.views ?? item.clicks ?? 0))))) : h("p", { class: "muted" }, "Данных пока нет"));
  }
  async function loadSummary() {
    try {
      const data = await api(`/analytics/summary?days=${period.value}`);
      const t = data.totals || {};
      cards.replaceChildren(metric("Уникальные посетители", t.unique_visitors), metric("Сессии", t.sessions), metric("Просмотры страниц", t.page_views), metric("Клики", t.clicks), metric("Отправки бронирований", t.reservation_events));
      charts.replaceChildren(
        listPanel("Популярные страницы", data.pages || [], (item) => `${item.path} · ${item.visitors} посетителей`),
        listPanel("Популярные действия", data.clicks || [], (item) => `${item.target_text || "Элемент"} · ${item.target_path || ""}`),
        h("div", { class: "panel indexing-daily" }, h("h2", {}, "Динамика по дням"), ...(data.daily || []).map((item) => h("div", { class: "indexing-day" }, h("span", {}, item.day), h("span", {}, `${item.visitors} посетителей`), h("span", {}, `${item.page_views} просмотров`), h("span", {}, `${item.clicks} кликов`))))
      );
    } catch (error) { cards.replaceChildren(h("p", { class: "error" }, error.message)); }
  }
  async function loadEvents() {
    try {
      const params = new URLSearchParams({ page: String(currentPage), page_size: "50" });
      if (eventType) params.set("event_type", eventType);
      const result = await api(`/analytics/events?${params}`);
      const rows = result.events || [];
      events.replaceChildren(rows.length ? h("table", { class: "table" },
        h("thead", {}, h("tr", {}, ...["Время", "Событие", "Страница", "Элемент", "Переход"].map((x) => h("th", {}, x)))),
        h("tbody", {}, ...rows.map((row) => h("tr", {}, h("td", {}, when(row.created_at)), h("td", {}, ({ page_view: "Просмотр", click: "Клик", reservation_submitted: "Бронирование" })[row.event_type] || row.event_type), h("td", {}, row.path, row.page_title ? h("small", {}, row.page_title) : null), h("td", {}, row.target_text || "—"), h("td", {}, row.target_path || "—"))))
      ) : h("div", { class: "empty" }, "Событий пока нет. Для сбора данных посетитель должен принять аналитические cookie."));
      const p = result.pagination || { page: 1, total_pages: 1, total: rows.length };
      pager.replaceChildren(h("span", {}, `${p.total} событий · страница ${p.page} из ${p.total_pages}`), h("button", { class: "btn quiet", disabled: p.page <= 1, onclick: () => { currentPage--; loadEvents(); } }, "← Назад"), h("button", { class: "btn quiet", disabled: p.page >= p.total_pages, onclick: () => { currentPage++; loadEvents(); } }, "Далее →"));
    } catch (error) { events.replaceChildren(h("p", { class: "error" }, error.message)); }
  }
  await Promise.all([loadSummary(), loadEvents()]);
}
