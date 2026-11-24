/**
 * Мастер импорта: файл → сопоставление колонок → предпросмотр → запись.
 *
 * Выгрузки amoCRM и Битрикс24 распознаются по заголовкам, колонки
 * раскладываются сами — человеку остаётся проверить и подтвердить.
 * Перед записью можно прогнать «вхолостую» и увидеть, сколько карточек
 * создастся, а сколько дополнит существующие.
 */
import { api, empty, field, h, mount, sheet, toast, upload } from "../core.js";

const ENTITIES = { contacts: "Клиенты", companies: "Компании", products: "Товары витрины" };

export function openImport(onDone) {
  const body = h("div");
  const close = sheet("Импорт из Excel или CSV", body);
  step1(body, onDone, close);
}

/* ---------- Шаг 1: файл ---------- */

function step1(host, onDone, close) {
  const entity = h("select", {}, ...Object.entries(ENTITIES).map(([k, v]) => h("option", { value: k }, v)));
  const file = h("input", { type: "file", accept: ".csv,.xlsx,.txt" });
  const status = h("div", { style: { fontSize: "12.5px", color: "var(--ink-4)" } });

  mount(host,
    h("div", {},
      h("p", { style: { fontSize: "13.5px", color: "var(--ink-3)", marginTop: 0 } },
        "Поддерживаются .xlsx и .csv. Первая строка файла — заголовки. Для товаров доступны ручное сопоставление любых исходных колонок, категории, характеристики, изображения, цена, наличие, SEO, 18+ и бронирование. После загрузки обязательно проверьте сопоставление и выполните пробный прогон."),
      field("Что импортируем", entity),
      field("Файл", file),
      status,
      h("button", {
        class: "btn solid wide",
        style: { marginTop: "16px" },
        onclick: async () => {
          if (!file.files?.length) return toast("Выберите файл");
          status.textContent = "Читаем файл…";
          try {
            const preview = await upload(`/import/preview?entity=${entity.value}`, file.files[0]);
            step2(host, preview, onDone, close);
          } catch (err) {
            status.textContent = "";
            toast(err.message);
          }
        },
      }, "Загрузить и посмотреть")
    )
  );
}

/* ---------- Шаг 2: сопоставление ---------- */

function step2(host, preview, onDone, close) {
  const autoMapping = { ...preview.mapping };
  const mapping = { ...autoMapping };
  const fieldOptions = Object.entries(preview.fields);
  const selects = new Map();
  const mappingStatus = h("div", { class: "panel", style: { marginBottom: "12px", fontSize: "12.5px" } });

  const refreshMappingUI = () => {
    const owners = new Map();
    for (const [index, key] of Object.entries(mapping)) {
      if (key) owners.set(key, Number(index));
    }
    for (const [index, select] of selects) {
      for (const option of select.options) {
        if (!option.value) continue;
        const owner = owners.get(option.value);
        option.disabled = owner !== undefined && owner !== index;
        option.selected = mapping[index] === option.value;
      }
    }
    const required = fieldOptions.filter(([, meta]) => meta.required);
    const missing = required.filter(([key]) => !Object.values(mapping).includes(key)).map(([, meta]) => meta.label);
    const mappedCount = Object.keys(mapping).filter((key) => mapping[key]).length;
    mappingStatus.textContent = missing.length
      ? `Назначено колонок: ${mappedCount}. Не выбрано обязательное поле: ${missing.join(", ")}. Выберите его вручную.`
      : `Назначено колонок: ${mappedCount}. Обязательные поля сопоставлены. Проверьте образцы и запустите пробный прогон.`;
    mappingStatus.style.borderColor = missing.length ? "var(--warning, #b7791f)" : "var(--line, #2a7b62)";
  };

  const selectFor = (index) => {
    const select = h("select", { style: { width: "100%", minWidth: "190px", padding: "6px 8px", fontSize: "13px" } },
      h("option", { value: "" }, "— не импортировать —"),
      ...fieldOptions.map(([key, meta]) =>
        h("option", { value: key, ...(mapping[index] === key ? { selected: true } : {}) },
          meta.label + (meta.required ? " *" : ""))
      )
    );
    selects.set(index, select);
    select.addEventListener("change", () => {
      const next = select.value;
      const conflict = next && Object.entries(mapping).find(([otherIndex, field]) => Number(otherIndex) !== index && field === next);
      if (conflict) {
        toast(`Поле уже назначено колонке «${preview.headers[Number(conflict[0])] || `№${Number(conflict[0]) + 1}`}»`);
        select.value = mapping[index] || "";
        return;
      }
      if (next) mapping[index] = next;
      else delete mapping[index];
      refreshMappingUI();
    });
    return select;
  };

  const result = h("div");
  let requestInFlight = false;
  let importCompleted = false;
  const dryRunButton = h("button", {
    class: "btn",
    onclick: async () => {
      if (requestInFlight || importCompleted) return;
      requestInFlight = true;
      dryRunButton.disabled = true;
      applyButton.disabled = true;
      dryRunButton.textContent = "Проверяем…";
      try {
        const stats = await api("/import/apply", { method: "POST", body: { id: preview.id, mapping, dry_run: true } });
        mount(result, summary(stats, true, preview.entity));
      } catch (err) {
        toast(err.message);
      } finally {
        requestInFlight = false;
        dryRunButton.textContent = "Проверить вхолостую";
        if (!importCompleted) {
          dryRunButton.disabled = false;
          applyButton.disabled = false;
        }
      }
    },
  }, "Проверить вхолостую");
  const applyButton = h("button", {
    class: "btn solid",
    onclick: async () => {
      if (requestInFlight || importCompleted) return;
      requestInFlight = true;
      dryRunButton.disabled = true;
      applyButton.disabled = true;
      applyButton.textContent = "Импортируем…";
      try {
        const stats = await api("/import/apply", { method: "POST", body: { id: preview.id, mapping } });
        importCompleted = true;
        applyButton.textContent = "Импорт завершён";
        mount(result, summary(stats, false, preview.entity));
        toast(`Импорт завершён: ${stats.created} новых карточек, ${stats.updated} обновлено`);
        onDone?.();
      } catch (err) {
        toast(err.message);
        if (/предпросмотр/i.test(err.message)) {
          importCompleted = true;
          applyButton.disabled = true;
          dryRunButton.disabled = true;
          applyButton.textContent = "Загрузите файл заново";
        } else {
          applyButton.disabled = false;
          dryRunButton.disabled = false;
          applyButton.textContent = "Импортировать";
        }
      } finally {
        requestInFlight = false;
      }
    },
  }, "Импортировать");

  mount(host,
    h("div", {},
      h("div", { class: "line", style: { marginBottom: "12px", gap: "8px", flexWrap: "wrap" } },
        h("span", { class: "chip" }, preview.profile_label),
        h("span", { class: "chip plain" }, `${preview.total} строк`),
        h("span", { class: "chip plain" }, preview.filename)
      ),
      h("p", { style: { fontSize: "13px", color: "var(--ink-3)", marginTop: 0 } },
        "Каждую колонку исходного файла можно назначить вручную. Автосопоставление — только подсказка. Дубли полей блокируются; обязательные поля отмечены звёздочкой. Предпросмотр можно применить один раз; для повторной загрузки создайте новый предпросмотр."),
      mappingStatus,
      h("div", { style: { maxHeight: "380px", overflow: "auto", marginBottom: "16px" } },
        h("table", { class: "table" },
          h("thead", {}, h("tr", {}, h("th", {}, "Колонка исходного файла"), h("th", {}, "Поле VAPELAB"), h("th", {}, "Примеры значений"))),
          h("tbody", {}, ...preview.headers.map((header, index) =>
            h("tr", {},
              h("td", { style: { fontWeight: 500, minWidth: "160px" } }, header || `Колонка ${index + 1}`),
              h("td", {}, selectFor(index)),
              h("td", { style: { color: "var(--ink-4)", fontSize: "12.5px", minWidth: "180px", maxWidth: "320px" } },
                preview.sample.map((row) => row[index]).filter(Boolean).slice(0, 2).map((v) => String(v).slice(0, 110)).join(" · ") || "—")
            )
          ))
        )
      ),
      h("div", { class: "line", style: { gap: "8px", flexWrap: "wrap", marginBottom: "12px" } },
        h("button", { class: "btn quiet", onclick: () => { if (requestInFlight || importCompleted) return; Object.keys(mapping).forEach((key) => delete mapping[key]); Object.assign(mapping, autoMapping); refreshMappingUI(); } }, "Вернуть автосопоставление"),
        h("button", { class: "btn quiet", onclick: () => { if (requestInFlight || importCompleted) return; Object.keys(mapping).forEach((key) => delete mapping[key]); refreshMappingUI(); } }, "Очистить все назначения")
      ),
      result,
      h("div", { class: "line", style: { gap: "8px", flexWrap: "wrap" } },
        dryRunButton,
        applyButton,
        h("div", { class: "spacer" }),
        h("button", { class: "btn quiet", onclick: () => close() }, "Закрыть")
      )
    )
  );

  refreshMappingUI();
}

function summary(stats, dry, entity) {
  const isProducts = entity === "products";
  return h("div", { class: "panel", style: { marginBottom: "16px" } },
    h("div", { class: "line", style: { gap: "8px", marginBottom: "8px", flexWrap: "wrap" } },
      h("span", { class: "chip" }, dry ? "пробный прогон" : "импорт выполнен"),
      h("span", { class: "chip plain" }, `строк ${stats.total}`),
      h("span", { class: "chip plain" }, `${isProducts ? "карточек создано" : "создано"} ${stats.created}`),
      h("span", { class: "chip plain" }, `${isProducts ? "карточек обновлено" : "дополнено"} ${stats.updated}`),
      isProducts && stats.variants_created ? h("span", { class: "chip plain" }, `вариантов добавлено ${stats.variants_created}`) : null,
      isProducts && stats.variants_updated ? h("span", { class: "chip plain" }, `вариантов обновлено ${stats.variants_updated}`) : null,
      stats.skipped ? h("span", { class: "chip warn" }, `пропущено ${stats.skipped}`) : null
    ),
    !dry ? h("p", { style: { fontSize: "12.5px", color: "var(--ink-3)", margin: "8px 0 0" } },
      "Предпросмотр использован. Для следующего импорта загрузите файл заново.") : null,
    stats.errors.length
      ? h("div", { style: { fontSize: "12.5px", color: "var(--ink-3)" } },
          ...stats.errors.slice(0, 8).map((e) => h("div", {}, `строка ${e.row}: ${e.detail}`)))
      : null
  );
}

/* ---------- История импортов ---------- */

export async function importHistory(host) {
  const runs = await api("/import/runs");
  mount(host,
    runs.length
      ? h("table", { class: "table" },
          h("thead", {}, h("tr", {},
            h("th", {}, "Файл"), h("th", {}, "Что"), h("th", {}, "Источник"),
            h("th", { class: "num" }, "Создано"), h("th", { class: "num" }, "Дополнено"), h("th", { class: "num" }, "Пропущено")
          )),
          h("tbody", {}, ...runs.map((run) =>
            h("tr", {},
              h("td", { class: "mono" }, run.filename || "—"),
              h("td", {}, ENTITIES[run.entity] || run.entity),
              h("td", { style: { color: "var(--ink-4)" } }, run.profile),
              h("td", { class: "num" }, String(run.created)),
              h("td", { class: "num" }, String(run.updated)),
              h("td", { class: "num" }, String(run.skipped))
            )
          ))
        )
      : empty("Импортов пока не было")
  );
}
