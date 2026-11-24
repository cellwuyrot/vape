import { api, h, mount, sheet, toast } from "../core.js";

export async function renderSeo(page) {
  let currentPage = 1;
  let query = "";
  let level = "all";
  const summary = h("div", { class: "seo-summary" });
  const table = h("div", { class: "table-wrap" });
  const pager = h("div", { class: "pager-controls" });
  const search = h("input", { type: "search", placeholder: "Название, бренд, slug" });
  const levelSelect = h("select", {}, ...[["all", "Все карточки"], ["attention", "Требуют внимания"], ["critical", "Критично · ниже 50"], ["warning", "Нужно улучшить · 50–79"], ["good", "Хорошо · 80–100"]].map(([value, label]) => h("option", { value }, label)));
  const filters = h("div", { class: "store-product-filters" }, search, levelSelect);
  mount(page, h("h1", { class: "page-title display" }, "SEO-оценка"), h("p", { class: "page-sub" }, "Редакционная и техническая полнота карточек. Это не прогноз позиций в поиске и не гарантия индексации."), filters, summary, table, pager);
  let timer;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { query = search.value.trim(); currentPage = 1; load(); }, 250); });
  levelSelect.addEventListener("change", () => { level = levelSelect.value; currentPage = 1; load(); });

  function editSeo(product) {
    const h1 = h("input", { value: product.seo_h1 || product.name, maxlength: "160" });
    const title = h("input", { value: product.seo_title || product.name, maxlength: "180" });
    const description = h("textarea", { rows: "4", maxlength: "320" }, product.seo_description || product.description || "");
    const keywords = h("textarea", { rows: "3" }, (product.seo_keywords || []).join("\n"));
    const form = h("form", { class: "seo-editor-form", onsubmit: async (event) => {
      event.preventDefault();
      try {
        await api(`/store/products/${product.id}`, { method: "PUT", body: { seo_h1: h1.value.trim(), seo_title: title.value.trim(), seo_description: description.value.trim(), seo_keywords: keywords.value.split(/[;,\n]/).map((v) => v.trim()).filter(Boolean).slice(0, 40) } });
        toast("SEO-поля сохранены"); close(); await load();
      } catch (error) { toast(error.message); }
    } },
      ...[["H1", h1], ["SEO Title", title], ["Meta Description", description], ["Поисковые запросы", keywords]].map(([label, input]) => h("label", { class: "field" }, h("span", {}, label), input)),
      h("div", { class: "seo-editor-actions" }, h("button", { class: "btn solid", type: "submit" }, "Сохранить SEO"))
    );
    const close = sheet(`SEO · ${product.name}`, form);
  }

  async function load() {
    table.replaceChildren(h("p", { class: "muted" }, "Загружаем SEO-оценку…"));
    try {
      const params = new URLSearchParams({ page: String(currentPage), page_size: "50", q: query, level });
      const report = await api(`/store/seo-report?${params}`);
      summary.replaceChildren(
        h("strong", {}, `${report.needs_attention || 0} из ${report.total || 0} карточек требуют внимания`),
        h("p", { class: "muted" }, report.score_basis || "Оценка полноты полей, а не позиции сайта."),
        h("div", { class: "seo-report-stats" }, ...[[report.published || 0, "Опубликовано"], [report.indexable || 0, "Открыто к индексации"], [report.missing_h1 || 0, "Без H1"], [report.missing_title || 0, "Без Title"], [report.missing_images || 0, "Без изображений"]].map(([value, label]) => h("div", { class: "seo-report-stat" }, h("strong", {}, String(value)), h("span", {}, label))))
      );
      const rows = report.products || [];
      table.replaceChildren(rows.length ? h("table", { class: "table" },
        h("thead", {}, h("tr", {}, ...["Товар", "Оценка", "Что исправить", "Индексация", ""].map((x) => h("th", {}, x)))),
        h("tbody", {}, ...rows.map((product) => {
          const scoreClass = product.score >= 80 ? "good" : product.score >= 50 ? "warn" : "bad";
          return h("tr", {},
            h("td", {}, h("strong", {}, product.name), h("small", {}, product.slug)),
            h("td", {}, h("div", { class: `seo-score seo-score-${scoreClass}` }, h("strong", {}, `${product.score}/100`), h("span", { class: "seo-score-track" }, h("i", { style: { width: `${product.score}%` } })))),
            h("td", {}, product.issues.length ? product.issues.map((issue) => h("div", { class: `seo-issue seo-issue-${issue.severity}` }, h("strong", {}, issue.label), h("small", {}, issue.recommendation))) : "Замечаний нет"),
            h("td", {}, product.indexing_status === "indexable" ? "Открыта" : product.indexing_status === "noindex" ? "Закрыта noindex" : "Не опубликована"),
            h("td", {}, h("button", { class: "btn quiet", onclick: () => editSeo(product) }, "Исправить SEO"))
          );
        }))
      ) : h("div", { class: "empty" }, "По выбранным условиям карточек нет"));
      const pagination = report.pagination || { page: 1, total_pages: 1, total: rows.length };
      pager.replaceChildren(h("span", {}, `${pagination.total} карточек · страница ${pagination.page} из ${pagination.total_pages}`), h("button", { class: "btn quiet", disabled: pagination.page <= 1, onclick: () => { currentPage--; load(); } }, "← Назад"), h("button", { class: "btn quiet", disabled: pagination.page >= pagination.total_pages, onclick: () => { currentPage++; load(); } }, "Далее →"));
    } catch (error) { table.replaceChildren(h("p", { class: "error" }, error.message)); }
  }
  await load();
}
