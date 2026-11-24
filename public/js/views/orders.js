/** Клиентские заказы и отдельный процесс приёмки входящих поставок. */
import { api, empty, field, h, money, mount, ORDER_STATUSES, sheet, toast, upload, when } from "../core.js";
import { openPrintMenu } from "./print.js";

const SUPPLY_FIELDS = [
  ["sku", "Артикул / SKU"],
  ["name", "Наименование товара *"],
  ["quantity", "Количество *"],
  ["unit", "Единица измерения"],
  ["purchase_price", "Закупочная цена"],
  ["line_total", "Сумма строки"],
  ["vat_rate", "Ставка НДС"],
];

export async function renderOrders(page) {
  const tabs = h("div", { class: "orders-tabs", role: "tablist", "aria-label": "Раздел заказов" });
  const content = h("div");
  const heading = h("div", { class: "line orders-heading", style: { marginBottom: "18px" } },
    h("div", {},
      h("h1", { class: "page-title display" }, "Заказы"),
      h("p", { class: "page-sub", style: { margin: 0 } }, "Клиентские заказы и приёмка товарных поставок.")
    ),
    h("div", { class: "spacer" }),
    h("div", { class: "orders-heading-action" })
  );
  const actionHost = heading.lastElementChild;
  mount(page, heading, tabs, content);
  let activeTab = "orders";

  const setTab = async (tab) => {
    activeTab = tab;
    mount(tabs,
      h("button", { class: `btn ${tab === "orders" ? "solid" : "quiet"}`, role: "tab", "aria-selected": String(tab === "orders"), onclick: () => setTab("orders") }, "Заказы"),
      h("button", { class: `btn ${tab === "supplies" ? "solid" : "quiet"}`, role: "tab", "aria-selected": String(tab === "supplies"), onclick: () => setTab("supplies") }, "Поставки")
    );
    if (tab === "orders") {
      mount(actionHost, h("button", { class: "btn solid", onclick: () => openCreate(loadOrders) }, "Новый заказ"));
      await loadOrders();
    } else {
      mount(actionHost, h("button", { class: "btn solid", onclick: () => openSupplyImport(loadSupplies) }, "Принять поставку"));
      await loadSupplies();
    }
  };

  async function loadOrders() {
    try {
      const orders = await api("/orders");
      mount(content,
        orders.length
          ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
              h("thead", {}, h("tr", {},
                h("th", {}, "Номер"), h("th", {}, "Позиции"), h("th", {}, "Статус"),
                h("th", { class: "num" }, "Сумма"), h("th", {}, "Создан"), h("th", {}, "Документы")
              )),
              h("tbody", {}, ...orders.map((o) =>
                h("tr", {},
                  h("td", { class: "mono" }, o.number),
                  h("td", { style: { color: "var(--ink-2)" } }, o.items.map((i) => i.name).join(", ") || "—"),
                  h("td", {}, h("select", {
                    onchange: async (e) => {
                      try { await api(`/orders/${o.id}`, { method: "PATCH", body: { status: e.target.value } }); toast("Статус обновлён"); loadOrders(); }
                      catch (err) { toast(err.message); }
                    },
                    style: { width: "auto", padding: "3px 8px", fontSize: "13px" },
                  }, ...Object.entries(ORDER_STATUSES).map(([key, label]) => h("option", { value: key, ...(key === o.status ? { selected: true } : {}) }, label)))),
                  h("td", { class: "num" }, money(o.total)),
                  h("td", { style: { color: "var(--ink-4)", fontSize: "13px" } }, when(o.created_at)),
                  h("td", {}, h("button", { class: "btn quiet", onclick: () => openPrintMenu({ order_id: o.id }) }, "Печать"))
                )
              ))
            ))
          : empty("Клиентских заказов пока нет")
      );
    } catch (error) { mount(content, empty(error.message)); }
  }

  async function loadSupplies() {
    try {
      const supplies = await api("/supplies");
      mount(content,
        supplies.length
          ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
              h("thead", {}, h("tr", {},
                h("th", {}, "Номер поставки"), h("th", {}, "Поставщик"), h("th", {}, "Накладная"),
                h("th", {}, "Позиций"), h("th", { class: "num" }, "Сумма"), h("th", {}, "Дата приёмки"), h("th", {}, "Документ")
              )),
              h("tbody", {}, ...supplies.map((supply) =>
                h("tr", {},
                  h("td", { class: "mono" }, supply.number),
                  h("td", {}, supply.supplier_name),
                  h("td", {}, supply.invoice_number || "—", supply.invoice_date ? h("small", {}, supply.invoice_date) : null),
                  h("td", {}, `${supply.item_count || 0} · сопоставлено ${supply.matched_items || 0}`),
                  h("td", { class: "num" }, money(supply.total)),
                  h("td", {}, when(supply.created_at)),
                  h("td", {}, h("button", { class: "btn quiet", onclick: () => openSupplyDetails(supply.id) }, "Открыть"))
                )
              ))
            ))
          : h("div", { class: "panel supply-empty" },
              h("h2", {}, "Поставок пока нет"),
              h("p", { class: "muted" }, "Загрузите накладную или таблицу поставщика в формате XLSX или CSV. После проверки строк подтвердите приёмку — совпавшие товары увеличат складской остаток."),
              h("button", { class: "btn solid", onclick: () => openSupplyImport(loadSupplies) }, "Загрузить таблицу поставки")
            )
      );
    } catch (error) { mount(content, empty(error.message)); }
  }

  await setTab(activeTab);
}

async function openSupplyDetails(id) {
  try {
    const supply = await api(`/supplies/${id}`);
    const close = sheet(`Поставка ${supply.number}`, h("div", { class: "supply-detail" },
      h("div", { class: "supply-detail-meta" },
        h("div", {}, h("small", {}, "Поставщик"), h("strong", {}, supply.supplier_name)),
        h("div", {}, h("small", {}, "Накладная"), h("strong", {}, supply.invoice_number || "—")),
        h("div", {}, h("small", {}, "Дата накладной"), h("strong", {}, supply.invoice_date || "—")),
        h("div", {}, h("small", {}, "Исходный файл"), h("strong", {}, supply.source_file || "—")),
        h("div", {}, h("small", {}, "Сопоставлено с каталогом"), h("strong", {}, `${supply.matched_items || 0} из ${supply.item_count || supply.items.length}`)),
        h("div", {}, h("small", {}, "Итого по накладной"), h("strong", {}, money(supply.total)))
      ),
      supply.note ? h("p", { class: "muted" }, supply.note) : null,
      h("div", { class: "table-wrap" }, h("table", { class: "table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Артикул"), h("th", {}, "Товар"), h("th", {}, "Кол-во"), h("th", {}, "Закупочная цена"), h("th", { class: "num" }, "Сумма"))),
        h("tbody", {}, ...supply.items.map((item) => h("tr", {},
          h("td", { class: "mono" }, item.sku || "—"),
          h("td", {}, item.name, h("small", {}, item.product_id ? "Сопоставлен с товаром CRM" : "Не сопоставлен с товаром CRM")),
          h("td", {}, `${item.quantity} ${item.unit || "шт"}`),
          h("td", {}, money(item.purchase_price)),
          h("td", { class: "num" }, money(item.line_total))
        )))
      )),
      h("p", { class: "muted" }, "При приёмке остатки увеличиваются только у позиций, сопоставленных с товарами CRM по артикулу или точному названию. Закупочная цена не перезаписывает розничную цену товара.")
    ));
    void close;
  } catch (error) { toast(error.message); }
}

function openSupplyImport(onDone) {
  const file = h("input", { type: "file", accept: ".xlsx,.csv,.txt" });
  const supplier = h("input", { type: "text", maxlength: "300", placeholder: "Название поставщика", required: true });
  const invoice = h("input", { type: "text", maxlength: "120", placeholder: "Номер накладной" });
  const invoiceDate = h("input", { type: "date", value: new Date().toISOString().slice(0, 10) });
  const note = h("textarea", { rows: "2", maxlength: "2000", placeholder: "Комментарий к приёмке, договор или склад" });
  const status = h("p", { class: "muted supply-import-status" }, "Первая строка таблицы должна содержать названия колонок.");
  const mappingHost = h("div");
  const previewHost = h("div");
  const saveButton = h("button", { class: "btn solid wide", disabled: true }, "Подтвердить приёмку");
  let preview = null;
  let selectors = {};

  const close = sheet("Приём поставки из таблицы", h("div", { class: "supply-import-form" },
    h("div", { class: "supply-import-grid" },
      field("Поставщик *", supplier),
      field("Номер накладной", invoice),
      field("Дата накладной", invoiceDate),
      field("Файл Excel или CSV *", file)
    ),
    field("Комментарий", note),
    status,
    mappingHost,
    previewHost,
    saveButton
  ));

  file.addEventListener("change", async () => {
    const selected = file.files?.[0];
    if (!selected) return;
    status.textContent = "Читаем таблицу и определяем колонки…";
    saveButton.disabled = true;
    try {
      preview = await upload("/supplies/preview", selected);
      selectors = {};
      renderSupplyPreview();
      status.textContent = `${preview.filename} · ${preview.total_rows} строк. Проверьте сопоставление перед приёмкой.`;
    } catch (error) {
      preview = null;
      mount(mappingHost, null);
      mount(previewHost, null);
      status.textContent = error.message;
      toast(error.message);
    }
  });

  function mappingSelect(key) {
    const select = h("select", { style: { width: "100%", minWidth: "160px" } },
      h("option", { value: "-1" }, "— не использовать —"),
      ...preview.headers.map((header, index) => h("option", {
        value: String(index), ...(Number(preview.mapping[key]) === index ? { selected: true } : {})
      }, header))
    );
    select.value = String(preview.mapping[key] ?? -1);
    selectors[key] = select;
    return select;
  }

  function renderSupplyPreview() {
    mount(mappingHost,
      h("div", { class: "supply-mapping" },
        h("h3", {}, "Сопоставление колонок"),
        h("p", { class: "muted" }, "Проверьте, какие столбцы содержат наименование, количество и закупочную цену. Остальные поля можно не назначать."),
        h("div", { class: "supply-mapping-grid" }, ...SUPPLY_FIELDS.map(([key, label]) => field(label, mappingSelect(key))))
      )
    );
    mount(previewHost,
      h("div", { class: "supply-preview" },
        h("h3", {}, `Предпросмотр · ${Math.min(preview.sample.length, 8)} из ${preview.total_rows} строк`),
        h("div", { class: "table-wrap" }, h("table", { class: "table" },
          h("thead", {}, h("tr", {}, ...preview.headers.map((header) => h("th", {}, header)))),
          h("tbody", {}, ...preview.sample.map((row) => h("tr", {},
            ...preview.headers.map((_, index) => h("td", {}, String(row[index] ?? "")))
          )))
        ))
      )
    );
    saveButton.disabled = false;
  }

  saveButton.addEventListener("click", async () => {
    if (!preview) return toast("Сначала загрузите таблицу");
    if (!supplier.value.trim()) return toast("Укажите поставщика");
    const mapping = Object.fromEntries(Object.entries(selectors).map(([key, select]) => [key, Number(select.value)]));
    if (mapping.name < 0 || mapping.quantity < 0) return toast("Назначьте колонки «Наименование» и «Количество»");
    saveButton.disabled = true;
    status.textContent = "Сохраняем поставку и обновляем сопоставленные остатки…";
    try {
      const result = await api("/supplies", { method: "POST", body: {
        preview_id: preview.preview_id,
        supplier_name: supplier.value.trim(),
        invoice_number: invoice.value.trim(),
        invoice_date: invoiceDate.value,
        note: note.value.trim(),
        mapping,
      } });
      toast(`Поставка ${result.number} принята · сопоставлено ${result.matched_items} из ${result.item_count} позиций`);
      close();
      await onDone?.();
    } catch (error) {
      status.textContent = error.message;
      toast(error.message);
      saveButton.disabled = false;
    }
  });
}

function openCreate(onDone) {
  const contact = h("select", {}, h("option", { value: "" }, "— не выбран —"));
  const comment = h("textarea", { placeholder: "Условия, сроки, договорённости" });
  const itemsHost = h("div", { class: "stack", style: { gap: "8px", marginBottom: "10px" } });
  const totalLabel = h("b", { class: "display", style: { fontSize: "22px" } }, money(0));
  const save = h("button", { class: "btn solid wide", type: "submit" }, "Создать заказ");
  const rows = [];

  api("/contacts").then((list) => list.forEach((c) => contact.append(h("option", { value: String(c.id) }, c.full_name))));
  const recalc = () => { totalLabel.textContent = money(rows.reduce((sum, row) => sum + Number(row.qty.value || 0) * Number(row.price.value || 0), 0)); };
  const addRow = () => {
    const name = h("input", { type: "text", placeholder: "Наименование" });
    const qty = h("input", { type: "number", value: "1", min: "0", step: "0.01", style: { width: "72px" }, oninput: recalc });
    const price = h("input", { type: "number", value: "0", min: "0", step: "100", style: { width: "110px" }, oninput: recalc });
    const row = { name, qty, price };
    rows.push(row);
    const node = h("div", { class: "line", style: { gap: "8px" } }, name, qty, price,
      h("button", { class: "btn quiet", type: "button", onclick: () => { rows.splice(rows.indexOf(row), 1); node.remove(); recalc(); } }, "✕")
    );
    itemsHost.append(node);
  };
  addRow();

  const close = sheet("Новый заказ", h("form", {
    onsubmit: async (e) => {
      e.preventDefault(); save.disabled = true;
      try {
        await api("/orders", { method: "POST", body: {
          contact_id: contact.value ? Number(contact.value) : null,
          comment: comment.value,
          items: rows.filter((row) => row.name.value.trim()).map((row) => ({ name: row.name.value, quantity: Number(row.qty.value), price: Number(row.price.value) })),
        } });
        toast("Заказ создан"); close(); await onDone();
      } catch (err) { toast(err.message); save.disabled = false; }
    },
  },
    field("Клиент", contact),
    h("label", { style: { fontSize: "12px", color: "var(--ink-3)", display: "block", marginBottom: "6px" } }, "Позиции · наименование, количество, цена"),
    itemsHost,
    h("button", { class: "btn quiet", type: "button", onclick: addRow, style: { marginBottom: "14px" } }, "+ Добавить позицию"),
    field("Комментарий", comment),
    h("div", { class: "line", style: { marginBottom: "16px" } }, h("span", { style: { color: "var(--ink-3)", fontSize: "13px" } }, "Итого"), h("div", { class: "spacer" }), totalLabel),
    save
  ));
  void close;
}
