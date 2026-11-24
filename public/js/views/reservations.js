import { api, h, mount, sheet, toast, when } from "../core.js";

function formatReservationMoney(minor, currency = "RUB") {
  const amount = Number(minor);
  if (!Number.isSafeInteger(amount) || amount < 0) return "—";
  try {
    return new Intl.NumberFormat("ru-RU", { style: "currency", currency: /^[A-Z]{3}$/.test(String(currency)) ? currency : "RUB", minimumFractionDigits: amount % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 }).format(amount / 100);
  } catch { return `${(amount / 100).toLocaleString("ru-RU")} ${currency || "RUB"}`; }
}

export async function renderReservations(page) {
  let currentPage = 1;
  let filterStatus = "";
  let searchTerm = "";
  const tableHost = h("div", { class: "table-wrap" });
  const meta = h("p", { class: "muted" });
  const pager = h("div", { class: "pager-controls" });
  const statusFilter = h("select", {}, h("option", { value: "" }, "Все статусы"), ...[["new", "Новые"], ["confirmed", "Подтверждены"], ["declined", "Отклонены"], ["ready", "Готовы"], ["completed", "Завершены"], ["cancelled", "Отменены"]].map(([value, label]) => h("option", { value }, label)));
  const search = h("input", { type: "search", placeholder: "Номер, товар, имя или телефон" });
  const toolbar = h("div", { class: "store-product-filters" }, search, statusFilter);
  const telegramStatus = h("span", { class: "muted" }, "Проверяем Telegram…");
  const linkButton = h("button", { class: "btn quiet", onclick: linkTelegram }, "Подключить Telegram");
  mount(page,
    h("div", { class: "section-head" }, h("div", {}, h("h1", { class: "page-title display" }, "Бронирования"), h("p", { class: "page-sub" }, "Заявки на резервирование товара. Оплата и дистанционная продажа не выполняются."))),
    h("div", { class: "panel reservation-channel-panel" }, telegramStatus, linkButton), toolbar, meta, tableHost, pager
  );
  statusFilter.addEventListener("change", () => { filterStatus = statusFilter.value; currentPage = 1; load(); });
  let timer;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { searchTerm = search.value.trim(); currentPage = 1; load(); }, 260); });

  async function loadTelegram() {
    try {
      const status = await api("/store/reservations/telegram-status");
      telegramStatus.textContent = status.linked ? `Telegram подключён · чат ••••${status.chat_id_suffix}` : status.bot_configured ? "Telegram-бот настроен, чат администратора ещё не привязан" : "Добавьте TELEGRAM_BOT_TOKEN в .env после создания бота";
      linkButton.disabled = !status.bot_configured;
    } catch (error) { telegramStatus.textContent = error.message; }
  }

  async function linkTelegram() {
    try {
      const result = await api("/store/reservations/telegram-link", { method: "POST", body: {} });
      const command = h("code", { class: "telegram-link-command" }, result.command);
      const close = sheet("Подключение уведомлений Telegram", h("div", { class: "stack" },
        h("p", {}, "Откройте своего Telegram-бота и отправьте ему эту команду. Ссылка действует 10 минут и используется один раз."),
        command,
        h("button", { class: "btn solid", onclick: async () => { try { await navigator.clipboard.writeText(result.command); toast("Команда скопирована"); } catch { toast("Скопируйте команду вручную"); } } }, "Скопировать команду"),
        h("p", { class: "muted" }, `Срок действия до ${new Date(result.expires_at).toLocaleTimeString("ru-RU")}. Для входящего webhook нужен публичный HTTPS-домен.`)
      ));
      void close;
    } catch (error) { toast(error.message); }
  }

  async function retryNotifications(row) {
    try {
      const result = await api(`/store/reservations/${row.id}/notify`, { method: "POST", body: {} });
      toast(`Уведомления: e-mail ${result.email_notified ? "отправлено" : "не отправлено"}, Telegram ${result.telegram_notified ? "отправлено" : "не отправлено"}`);
      await load();
      openDetails(result.reservation || row);
    } catch (error) { toast(error.message); }
  }

  function openDetails(row) {
    const note = h("textarea", { rows: "4", maxlength: "2000", placeholder: "Внутренняя заметка менеджера" }, row.manager_note || "");
    const status = h("select", {}, ...[["new", "Новая"], ["confirmed", "Подтверждена"], ["declined", "Отклонена"], ["ready", "Готова"], ["completed", "Завершена"], ["cancelled", "Отменена"]].map(([value, label]) => h("option", { value, selected: row.status === value }, label)));
    const close = sheet(`Бронирование ${row.number}`, h("form", { class: "seo-editor-form", onsubmit: async (event) => {
      event.preventDefault();
      try { await api(`/store/reservations/${row.id}`, { method: "PATCH", body: { status: status.value, manager_note: note.value } }); toast("Бронирование обновлено"); close(); await load(); }
      catch (error) { toast(error.message); }
    } },
      h("div", { class: "reservation-detail-grid" },
        h("div", {}, h("small", {}, "Товар"), h("strong", {}, row.product_name), row.variant_name ? h("small", {}, `Цвет: ${row.variant_name}`) : null, row.variant_image_url ? h("a", { href: row.variant_image_url, target: "_blank", rel: "noopener" }, "Фото выбранного цвета") : null),
        h("div", {}, h("small", {}, "Количество"), h("strong", {}, `${row.quantity} шт.`)),
        h("div", {}, h("small", {}, "Цена за единицу"), h("strong", {}, Number(row.price_calculated) ? formatReservationMoney(row.unit_price_minor, row.price_currency) : (row.price_raw_snapshot || "Не указана; уточнить у менеджера"))),
        h("div", {}, h("small", {}, "Итоговая стоимость"), h("strong", {}, Number(row.price_calculated) ? formatReservationMoney(row.total_price_minor, row.price_currency) : "Уточняет менеджер")),
        h("div", {}, h("small", {}, "Клиент"), h("strong", {}, row.customer_name)),
        h("div", {}, h("small", {}, "Телефон"), h("strong", {}, row.phone)),
        h("div", {}, h("small", {}, "E-mail"), h("strong", {}, row.email || "Не указан")),
        h("div", {}, h("small", {}, "Создано"), h("strong", {}, when(row.created_at))),
        h("div", {}, h("small", {}, "Возраст"), h("strong", {}, Number(row.is_18_plus) ? "18+, подтверждено" : "Не ограничено")),
        h("div", {}, h("small", {}, "Уведомления"), h("strong", {}, `E-mail: ${row.email_notified ? "отправлено" : "не отправлено"}; Telegram: ${row.telegram_notified ? "отправлено" : "не отправлено"}`)),
      ),
      h("p", {}, row.message || "Комментарий отсутствует"),
      h("div", { class: "seo-editor-actions" }, h("span", { class: "muted" }, "Если канал не был настроен в момент создания заявки, уведомления можно отправить повторно после подключения."), h("button", { class: "btn quiet", type: "button", onclick: () => retryNotifications(row) }, "Повторить уведомления")),
      h("label", { class: "field" }, h("span", {}, "Статус"), status),
      h("label", { class: "field" }, h("span", {}, "Заметка"), note),
      h("div", { class: "seo-editor-actions" }, h("button", { class: "btn solid", type: "submit" }, "Сохранить"))
    ));
  }

  async function load() {
    try {
      const params = new URLSearchParams({ page: String(currentPage), page_size: "50" });
      if (filterStatus) params.set("status", filterStatus);
      if (searchTerm) params.set("q", searchTerm);
      const response = await api(`/store/reservations?${params}`);
      const rows = response.reservations || [];
      const pagination = response.pagination || { page: 1, total: rows.length, total_pages: 1 };
      meta.textContent = `Найдено бронирований: ${pagination.total}. Страница ${pagination.page} из ${pagination.total_pages}.`;
      tableHost.replaceChildren(rows.length ? h("table", { class: "table" },
        h("thead", {}, h("tr", {}, ...["Номер", "Товар", "Клиент", "Контакт", "Количество / цена", "Итого", "Статус", "Создано", "Уведомления", ""].map((x) => h("th", {}, x)))),
        h("tbody", {}, ...rows.map((row) => h("tr", {},
          h("td", {}, h("strong", {}, row.number)),
          h("td", {}, row.product_name, row.variant_name ? h("small", {}, `Цвет: ${row.variant_name}`) : null, row.product_sku ? h("small", {}, row.product_sku) : null),
          h("td", {}, row.customer_name),
          h("td", {}, row.phone, row.email ? h("small", {}, row.email) : null),
          h("td", {}, `${row.quantity} шт.`, h("small", {}, Number(row.price_calculated) ? `${formatReservationMoney(row.unit_price_minor, row.price_currency)} / шт.` : "Цена уточняется")),
          h("td", {}, Number(row.price_calculated) ? formatReservationMoney(row.total_price_minor, row.price_currency) : "Уточнить"),
          h("td", {}, h("span", { class: `status-pill status-${row.status}` }, ({ new: "Новая", confirmed: "Подтверждена", declined: "Отклонена", ready: "Готова", completed: "Завершена", cancelled: "Отменена" })[row.status] || row.status)),
          h("td", {}, when(row.created_at)),
          h("td", {}, `E-mail ${row.email_notified ? "✓" : "—"}`, h("br"), `TG ${row.telegram_notified ? "✓" : "—"}`),
          h("td", {}, h("button", { class: "btn quiet", onclick: () => openDetails(row) }, "Открыть"))
        )))
      ) : h("div", { class: "empty" }, "Бронирований пока нет"));
      pager.replaceChildren(
        h("button", { class: "btn quiet", disabled: pagination.page <= 1, onclick: () => { currentPage--; load(); } }, "← Назад"),
        h("span", {}, `Страница ${pagination.page} / ${pagination.total_pages}`),
        h("button", { class: "btn quiet", disabled: pagination.page >= pagination.total_pages, onclick: () => { currentPage++; load(); } }, "Далее →")
      );
    } catch (error) { tableHost.replaceChildren(h("p", { class: "error" }, error.message)); }
  }
  await Promise.all([load(), loadTelegram()]);
}
