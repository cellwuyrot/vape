import { api, h, toast, sheet, mount, upload } from "../core.js";
import { openImport } from "./import.js";

const field = (label, value = "", type = "text") => {
  const input = h("input", { type, value, placeholder: label });
  return { node: h("label", { class: "field" }, h("span", {}, label), input), input };
};
const button = (label, fn, cls = "btn") => h("button", { class: cls, onclick: fn }, label);
const section = (title, subtitle = "") => h("div", { class: "section-head" }, h("div", {}, h("h2", {}, title), subtitle ? h("p", { class: "muted" }, subtitle) : null));

export async function renderStore(root) {
  let productPage = 1;
  let productPageSize = 25;
  let productQuery = "";
  let productCategoryId = "";
  let productStatus = "";
  const selectedProductIds = new Set();
  const initialParams = new URLSearchParams({ page: String(productPage), page_size: String(productPageSize) });
  const payload = await api(`/store/admin?${initialParams}`);
  const data = payload.data || payload;
  let tab = "products";
  const content = h("div", { class: "store-admin" });
  const tabs = h("div", { class: "tabs" },
    ...[["products","Товары"],["categories","Категории"],["news","Новости"],["pages","Страницы"],["restock","Оповещения о поступлении"],["settings","Оформление"]].map(([id,label]) => button(label, () => { tab = id; draw(); }, "btn quiet"))
  );
  const toolbar = h("div", { class: "row" });
  const body = h("div", {});
  content.append(section("Витрина VAPELAB", "Каталог, новости и информационные страницы. Публикация контента — только после проверки."), tabs, toolbar, body);
  root.append(content);

  let reloadSequence = 0;
  async function reload({ preserveProductSearch = false } = {}) {
    const active = document.activeElement;
    const restoreSearch = preserveProductSearch && Boolean(active?.classList?.contains("store-product-search-input"));
    const selectionStart = restoreSearch ? active.selectionStart : null;
    const selectionEnd = restoreSearch ? active.selectionEnd : null;
    const sequence = ++reloadSequence;
    const params = new URLSearchParams({ page: String(productPage), page_size: String(productPageSize), q: productQuery, category_id: productCategoryId, status: productStatus });
    const fresh = await api(`/store/admin?${params}`);
    if (sequence !== reloadSequence) return;
    Object.assign(data, fresh.data || fresh);
    draw();
    if (restoreSearch) {
      const nextSearch = body.querySelector(".store-product-search-input");
      if (nextSearch) {
        nextSearch.focus({ preventScroll: true });
        if (Number.isInteger(selectionStart) && Number.isInteger(selectionEnd)) nextSearch.setSelectionRange(selectionStart, selectionEnd);
      }
    }
  }
  function categorySelect(selectedIds = [], { multiple = true } = {}) {
    const selected = new Set((selectedIds || []).map(Number));
    return h("select", { multiple, size: multiple ? "6" : "1", class: multiple ? "store-category-select" : "" },
      ...data.categories.map((category) => {
        const parent = data.categories.find((item) => Number(item.id) === Number(category.parent_id));
        return h("option", { value: String(category.id), selected: selected.has(Number(category.id)) }, `${parent ? "　↳ " : ""}${category.name}${category.is_active ? "" : " · скрыта"}`);
      })
    );
  }
  const selectedCategoryIds = (select) => Array.from(select.selectedOptions).map((option) => Number(option.value)).filter(Number.isSafeInteger);
  async function addProduct() {
    const makeField = (label, control, hint = "") => h("label", { class: "field seo-form-field" }, h("span", {}, label), control, hint ? h("small", { class: "muted" }, hint) : null);
    const name = h("input", { type: "text", required: true, maxlength: "240", placeholder: "Название товара по источнику" });
    const sku = h("input", { type: "text", maxlength: "100", placeholder: "Артикул, если указан" });
    const brand = h("input", { type: "text", maxlength: "120", placeholder: "Бренд, если известен" });
    const productType = h("input", { type: "text", maxlength: "120", placeholder: "Тип товара" });
    const format = h("input", { type: "text", maxlength: "160", placeholder: "Формат / вариант" });
    const description = h("textarea", { rows: "4", maxlength: "5000", placeholder: "Только подтверждённое описание" });
    const priceRaw = h("input", { type: "text", maxlength: "80", placeholder: "Цена из источника без преобразования" });
    const sourceUrl = h("input", { type: "url", maxlength: "500", placeholder: "URL страницы-источника" });
    const imageQuery = h("input", { type: "text", maxlength: "240", placeholder: "Бренд + точная модель" });
    const availabilityStatus = h("select", {}, ...[["unknown","Наличие уточняется"],["in_stock","В наличии"],["out_of_stock","Отсутствует"],["preorder","Предзаказ"]].map(([value,label]) => h("option", { value }, label)));
    const categories = categorySelect([]);
    const is18Plus = h("input", { type: "checkbox" });
    const isReservable = h("input", { type: "checkbox", checked: true });
    const form = h("form", { class: "seo-editor-form store-product-form" },
      h("div", { class: "seo-editor-grid" },
        makeField("Название товара", name), makeField("Артикул / SKU", sku),
        makeField("Бренд", brand), makeField("Тип товара", productType),
        makeField("Категории (можно выбрать несколько)", categories), makeField("Формат / вариант", format),
        makeField("Цена (исходная строка)", priceRaw), makeField("Наличие", availabilityStatus), makeField("Страница-источник", sourceUrl),
        makeField("Запрос для поиска изображения", imageQuery, "Результаты поиска будут показаны для ручного подтверждения.")
      ),
      h("div", { class: "store-product-flags" }, h("label", { class: "check-field" }, is18Plus, "Товар с ограничением 18+"), h("label", { class: "check-field" }, isReservable, "Разрешить бронирование")),
      makeField("Описание", description, "Не добавляйте свойства, совместимость или наличие, если они не подтверждены источником."),
      h("div", { class: "seo-editor-actions" }, h("span", { class: "muted" }, "Новая карточка будет сохранена черновиком."), h("button", { class: "btn solid", type: "submit" }, "Создать черновик"))
    );
    const close = sheet("Новый товар", form);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await api("/store/products", { method: "POST", body: {
          name: name.value.trim(), sku: sku.value.trim(), brand: brand.value.trim(), product_type: productType.value.trim(),
          format: format.value.trim(), description: description.value.trim(), price_raw: priceRaw.value.trim(), source_url: sourceUrl.value.trim(),
          image_search_query: imageQuery.value.trim(), status: "draft", category_ids: selectedCategoryIds(categories), availability_status: availabilityStatus.value,
          is_18_plus: is18Plus.checked, is_reservable: isReservable.checked,
          migration_notes: "Создано в CRM; проверить источник, фотографии и SEO перед публикацией",
        } });
        toast("Черновик товара создан"); close(); await reload();
      } catch (error) { toast(error.message); }
    });
  }
  async function openSmartSearch() {
    const searchInput = h("input", { type: "search", placeholder: "Название, артикул, бренд, тип, SEO-текст" });
    const results = h("div", { class: "smart-search-results" }, h("p", { class: "muted" }, "Введите запрос. Поиск учитывает название, артикул, описание и SEO-поля; допускает одну опечатку."));
    const close = sheet("Умный поиск товаров", h("div", { class: "smart-search-panel" }, searchInput, results));
    let timer;
    searchInput.addEventListener("input", () => {
      clearTimeout(timer);
      const q = searchInput.value.trim();
      if (q.length < 2) { results.replaceChildren(h("p", { class: "muted" }, "Введите не менее двух символов.")); return; }
      timer = setTimeout(async () => {
        results.replaceChildren(h("p", { class: "muted" }, "Ищем совпадения…"));
        try {
          const response = await api(`/store/smart-search?q=${encodeURIComponent(q)}`);
          const hits = response.results || [];
          results.replaceChildren(h("p", { class: "muted" }, `Найдено совпадений: ${response.total || hits.length}`), ...(hits.length ? hits.map((product) => h("div", { class: "smart-search-hit" }, h("div", {}, h("strong", {}, product.name), h("small", {}, `${product.sku || "Без SKU"} · ${product.brand || "Бренд не указан"} · ${statusLabel(product.status)}`)), h("button", { class: "btn quiet", onclick: () => { close(); editProduct(product); } }, "Открыть"))) : [h("div", { class: "empty" }, "Ничего не найдено. Попробуйте упростить запрос.")]));
        } catch (error) { results.replaceChildren(h("p", { class: "error" }, error.message)); }
      }, 220);
    });
    searchInput.focus();
  }

  async function addCategory() {
    const makeField = (label, control) => h("label", { class: "field seo-form-field" }, h("span", {}, label), control);
    const name = h("input", { type: "text", required: true, maxlength: "180", placeholder: "Название категории" });
    const slug = h("input", { type: "text", maxlength: "180", placeholder: "Автоматически из названия" });
    const parent = h("select", {}, h("option", { value: "" }, "Основная категория"), ...data.categories.filter((item) => !item.parent_id).map((item) => h("option", { value: String(item.id) }, item.name)));
    const description = h("textarea", { rows: "3", maxlength: "1200", placeholder: "Описание категории" });
    const form = h("form", { class: "seo-editor-form" }, h("div", { class: "seo-editor-grid" }, makeField("Название", name), makeField("Slug", slug), makeField("Родительская категория", parent)), makeField("Описание", description), h("div", { class: "seo-editor-actions" }, h("span", { class: "muted" }, "Категория станет доступна после активации и привязки опубликованных товаров."), h("button", { class: "btn solid", type: "submit" }, "Создать категорию")));
    const close = sheet("Новая категория", form);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try { await api("/store/categories", { method: "POST", body: { name: name.value.trim(), slug: slug.value.trim(), parent_id: parent.value ? Number(parent.value) : null, description: description.value.trim() } }); toast("Категория добавлена"); close(); await reload(); }
      catch (error) { toast(error.message); }
    });
  }
  async function addNews() { return editNews(null); }
  async function addPage() {
    const title = prompt("Название страницы"); if (!title) return;
    try { await api("/store/pages", { method: "POST", body: { title, page_type: "content" } }); toast("Страница создана как черновик; юридические страницы требуют проверки"); await reload(); } catch (e) { toast(e.message); }
  }
  function statusLabel(s) { return ({ draft: "Черновик", pending_review: "На проверке", published: "Опубликовано", archived: "Архив" })[s] || s; }
  async function editProduct(p) {
    if (!Array.isArray(p.variants) || !Array.isArray(p.images)) {
      try {
        const response = await api(`/store/products/${p.id}`);
        const fullProduct = response.data || response;
        if (fullProduct) Object.assign(p, fullProduct);
      } catch (error) {
        toast(`Не удалось загрузить варианты товара: ${error.message}`);
      }
    }
    const makeField = (label, control, hint = "") => h("label", { class: "field seo-form-field" }, h("span", {}, label), control, hint ? h("small", { class: "muted" }, hint) : null);
    const makeInput = (value, placeholder, maxlength = 240) => h("input", { type: "text", value: value || "", maxlength: String(maxlength), placeholder });
    const name = makeInput(p.name, "Название товара");
    const sku = makeInput(p.sku, "Артикул / SKU", 100);
    const brand = makeInput(p.brand, "Бренд", 120);
    const productType = makeInput(p.product_type, "Тип товара", 120);
    const format = makeInput(p.format, "Формат / вариант", 160);
    const description = h("textarea", { rows: "5", maxlength: "5000", placeholder: "Описание по подтверждённым данным" }, p.description || "");
    const priceRaw = makeInput(p.price_raw, "Исходная цена", 80);
    const oldPriceRaw = makeInput(p.old_price_raw, "Старая цена", 80);
    const availability = makeInput(p.availability_label_raw, "Подпись наличия из источника", 120);
    const availabilityStatus = h("select", {}, ...[["unknown","Наличие уточняется"],["in_stock","В наличии"],["out_of_stock","Отсутствует"],["preorder","Предзаказ"]].map(([value,label]) => h("option", { value, selected: (p.availability_status || "unknown") === value }, label)));
    const sourceUrl = h("input", { type: "url", value: p.source_url || "", maxlength: "500", placeholder: "URL страницы-источника" });
    const imageQuery = makeInput(p.image_search_query || `${p.brand || ""} ${p.name}`.trim(), "Бренд + точная модель");
    const categories = categorySelect(p.category_ids || []);
    const is18Plus = h("input", { type: "checkbox", checked: Number(p.is_18_plus) === 1 });
    const isReservable = h("input", { type: "checkbox", checked: Number(p.is_reservable ?? 1) === 1 });
    const variantRows = Array.isArray(p.variants) ? p.variants : [];
    const productImages = Array.isArray(p.images) ? p.images : [];
    const variantColorLabel = (variant) => {
      const attributes = variant.attributes && typeof variant.attributes === "object"
        ? variant.attributes
        : (() => { try { return JSON.parse(variant.attributes_json || "{}"); } catch { return {}; } })();
      const key = Object.keys(attributes || {}).find((name) => /цвет|color|colour|оттенок|shade/i.test(name));
      return String((key && attributes[key]) || variant.name || "Вариант без названия");
    };
    const variantsSummaryList = h("div", { class: "store-product-variant-summary-list" });
    const variantsSummary = h("section", { class: "store-product-variants-summary" },
      h("div", { class: "store-product-variants-summary-head" },
        h("div", {}, h("strong", {}, `Варианты товара · ${variantRows.length}`), h("small", {}, "Цвет, артикул, цена и изображения каждого исполнения")),
        h("button", { class: "btn quiet", type: "button", onclick: () => editProductVariants(p, { onSaved: syncProductSummary }) }, "Настроить варианты и фото"),
      ),
      variantsSummaryList,
    );
    const syncProductSummary = () => {
      const latestVariants = Array.isArray(p.variants) ? p.variants : [];
      const latestImages = Array.isArray(p.images) ? p.images : [];
      variantRows.splice(0, variantRows.length, ...latestVariants);
      productImages.splice(0, productImages.length, ...latestImages);
      renderProductVariantSummary();
    };
    const makeSummaryUploadInput = (variant) => {
      const input = h("input", {
        type: "file", multiple: true,
        accept: ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp",
        class: "store-product-variant-summary-file-input",
        "aria-label": `Выбрать фотографии для варианта ${variantColorLabel(variant)}`,
      });
      input.addEventListener("change", async () => {
        const files = Array.from(input.files || []).slice(0, 12);
        if (!files.length) return;
        if (!variant.id) { toast("Сначала сохраните вариант, затем загружайте фотографии"); input.value = ""; return; }
        input.disabled = true;
        let uploadedCount = 0;
        const errors = [];
        try {
          for (const file of files) {
            try {
              const response = await upload(`/store/products/${p.id}/images/upload`, file, { "X-Variant-Id": String(variant.id) });
              const image = response.data || response;
              if (Number(image.variant_id) !== Number(variant.id)) throw new Error("Сервер не подтвердил привязку фото к выбранному варианту");
              const existingIndex = productImages.findIndex((item) => Number(item.id) === Number(image.id));
              if (existingIndex >= 0) productImages[existingIndex] = image;
              else productImages.push(image);
              uploadedCount += 1;
            } catch (error) { errors.push(`${file.name}: ${error.message}`); }
          }
          if (uploadedCount) {
            p.images = productImages;
            p.variants = variantRows;
            renderProductVariantSummary();
            toast(`Загружено и привязано к «${variantColorLabel(variant)}»: ${uploadedCount}`);
          }
          if (errors.length) toast(errors.slice(0, 2).join(" · "));
        } finally { input.disabled = false; input.value = ""; }
      });
      return input;
    };
    const renderProductVariantSummary = () => {
      variantsSummaryList.replaceChildren(...(variantRows.length ? variantRows.map((variant) => {
        const assignedImages = productImages.filter((image) => Number(image.variant_id) === Number(variant.id));
        const photo = assignedImages[0];
        const uploadInput = makeSummaryUploadInput(variant);
        const sharedPhotos = productImages.filter((image) => !Number(image.variant_id));
        const sharedPhotoPicker = h("div", { class: "store-product-variant-summary-shared" },
          h("small", {}, "Назначить уже загруженное фото — нажмите миниатюру"),
          sharedPhotos.length
            ? h("div", { class: "store-product-variant-summary-shared-grid" }, ...sharedPhotos.map((image) => h("button", {
                type: "button", class: "store-product-variant-summary-shared-button",
                title: `Назначить фото #${image.id} варианту ${variantColorLabel(variant)}`,
                "aria-label": `Назначить фото #${image.id} варианту ${variantColorLabel(variant)}`,
                onclick: async () => {
                  try {
                    const response = await api(`/store/products/${p.id}/images/${image.id}`, { method: "PUT", body: { variant_id: variant.id, alt: `${p.name} — ${variantColorLabel(variant)}`, position: image.position || 0 } });
                    Object.assign(image, response.data || response);
                    p.images = productImages;
                    renderProductVariantSummary();
                    toast(`Фото #${image.id} назначено варианту «${variantColorLabel(variant)}»`);
                  } catch (error) { toast(`Не удалось назначить фото: ${error.message}`); }
                },
              }, h("img", { src: image.url_original, alt: image.alt_raw || p.name, loading: "lazy" }), h("span", {}, `#${image.id}`))))
            : h("span", { class: "muted" }, "Нет свободных фото"),
        );
        return h("article", { class: "store-product-variant-summary-row" },
          photo ? h("img", { src: photo.url_original, alt: photo.alt_raw || p.name, loading: "lazy" }) : h("span", { class: "store-product-variant-summary-noimage" }, "Фото не привязано"),
          h("div", { class: "store-product-variant-summary-main" },
            h("strong", {}, variantColorLabel(variant)),
            h("small", {}, `SKU: ${variant.sku || "не указан"} · ${assignedImages.length} фото`),
          ),
          h("div", { class: "store-product-variant-summary-price" },
            h("strong", {}, variant.price_raw || "Цена не указана"),
            variant.old_price_raw ? h("small", {}, `Старая цена: ${variant.old_price_raw}`) : null,
          ),
          h("div", { class: "store-product-variant-summary-actions" },
            sharedPhotoPicker,
            h("label", { class: "store-product-variant-summary-upload" },
              h("span", {}, "Загрузить новое фото этого варианта"), uploadInput,
            ),
          ),
        );
      }) : [h("p", { class: "muted" }, "Варианты ещё не добавлены. Нажмите «Настроить варианты и фото», чтобы создать цвета или исполнения.") ]));
    };
    renderProductVariantSummary();
    const form = h("form", { class: "seo-editor-form store-product-form" },
      h("div", { class: "seo-editor-grid" },
        makeField("Название товара", name), makeField("Артикул / SKU", sku),
        makeField("Бренд", brand), makeField("Тип товара", productType),
        makeField("Формат / вариант", format), makeField("Категории (можно выбрать несколько)", categories),
        makeField("Цена (исходная строка)", priceRaw),
        makeField("Старая цена", oldPriceRaw), makeField("Подпись наличия из источника", availability), makeField("Статус наличия", availabilityStatus),
        makeField("Страница-источник", sourceUrl), makeField("Поисковый запрос изображения", imageQuery)
      ),
      variantsSummary,
      h("div", { class: "store-product-flags" }, h("label", { class: "check-field" }, is18Plus, "Товар с ограничением 18+"), h("label", { class: "check-field" }, isReservable, "Разрешить бронирование")),
      makeField("Описание", description, "Сохраняйте формулировки исходного материала; неподтверждённые свойства не добавляйте."),
      h("div", { class: "seo-editor-actions" },
        h("span", { class: "muted" }, `Статус: ${statusLabel(p.status)}. Публикация меняется отдельно.`),
        h("button", { class: "btn solid", type: "submit" }, "Сохранить карточку")
      )
    );
    const close = sheet(`Карточка товара · ${p.name}`, form);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await api(`/store/products/${p.id}`, { method: "PUT", body: {
          name: name.value.trim(), sku: sku.value.trim(), brand: brand.value.trim(), product_type: productType.value.trim(),
          format: format.value.trim(), description: description.value.trim(), price_raw: priceRaw.value.trim(),
          old_price_raw: oldPriceRaw.value.trim(), availability_label_raw: availability.value.trim(), availability_status: availabilityStatus.value,
          source_url: sourceUrl.value.trim(), image_search_query: imageQuery.value.trim(), category_ids: selectedCategoryIds(categories),
          is_18_plus: is18Plus.checked, is_reservable: isReservable.checked,
        } });
        toast("Карточка обновлена"); close(); await reload();
      } catch (error) { toast(error.message); }
    });
  }
  async function editProductVariants(p, { onSaved } = {}) {
    // Always reload the product snapshot so the variant editor is synchronised with DB state.
    try {
      const response = await api(`/store/products/${p.id}`);
      const fullProduct = response.data || response;
      if (!fullProduct) throw new Error("Товар не найден в ответе каталога");
      Object.assign(p, fullProduct);
    } catch (error) { toast(`Не удалось обновить данные товара: ${error.message}`); return; }
    const variants = (Array.isArray(p.variants) ? p.variants : []).map((variant) => ({ ...variant, attributes: { ...(variant.attributes || {}) }, images: [...(variant.images || [])] }));
    const images = (Array.isArray(p.images) ? p.images : []).map((image) => ({ ...image }));
    const variantList = h("div", { class: "store-variant-list" });
    const variantSearch = h("input", { type: "search", placeholder: "Поиск варианта, SKU или страны", "aria-label": "Поиск вариантов" });
    const imageList = h("div", { class: "store-variant-image-list" });
    const makeField = (label, control, hint = "") => h("label", { class: "field seo-form-field" }, h("span", {}, label), control, hint ? h("small", { class: "muted" }, hint) : null);
    const parseAttributes = (value) => {
      if (!String(value || "").trim()) return {};
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Дополнительные характеристики должны быть JSON-объектом");
      return parsed;
    };
    const colorValue = (attributes = {}) => {
      const key = Object.keys(attributes).find((name) => /цвет|color|colour|оттенок|shade/i.test(name));
      return key ? String(attributes[key] ?? "") : "";
    };
    const syncVariantImages = () => {
      for (const variant of variants) variant.images = images.filter((image) => Number(image.variant_id) === Number(variant.id) && variant.id);
    };
    const publishProductChanges = () => {
      p.variants = variants;
      p.images = images;
      syncVariantImages();
      onSaved?.();
    };

    function renderImageList() {
      syncVariantImages();
      const sharedImages = images.filter((image) => !Number(image.variant_id));
      imageList.replaceChildren(
        h("h4", {}, "Общие фотографии товара"),
        h("p", { class: "muted" }, "Здесь показаны только свободные фотографии. Выберите вариант в списке или нажмите миниатюру внутри карточки нужного варианта."),
        ...(sharedImages.length ? sharedImages.map((image) => {
          const assignment = h("select", { class: "store-image-variant-select" },
            h("option", { value: "", selected: !image.variant_id }, "Общее фото товара"),
            ...variants.filter((variant) => variant.id).map((variant) => h("option", { value: String(variant.id), selected: Number(image.variant_id) === Number(variant.id) }, `${variant.name}${colorValue(variant.attributes) ? ` · ${colorValue(variant.attributes)}` : ""}`)),
          );
          const save = h("button", { type: "button", class: "btn quiet", onclick: async () => {
            try {
              const response = await api(`/store/products/${p.id}/images/${image.id}`, { method: "PUT", body: { variant_id: assignment.value || null, alt: image.alt_raw || p.name, position: image.position || 0 } });
              const updated = response.data || response;
              Object.assign(image, updated);
              publishProductChanges();
              toast("Привязка фотографии обновлена");
              renderImageList();
              renderVariantList();
            } catch (error) { toast(error.message); }
          } }, "Сохранить привязку");
          const remove = h("button", { type: "button", class: "btn danger", onclick: async () => {
            if (!confirm("Убрать это изображение из карточки? Сам файл на сервере сохранится.")) return;
            try {
              await api(`/store/products/${p.id}/images/${image.id}`, { method: "DELETE" });
              const index = images.findIndex((item) => Number(item.id) === Number(image.id));
              if (index >= 0) images.splice(index, 1);
              publishProductChanges();
              toast("Изображение отвязано");
              renderImageList();
              renderVariantList();
            } catch (error) { toast(error.message); }
          } }, "Отвязать");
          return h("article", { class: "store-variant-image-row" },
            h("img", { src: image.url_original, alt: image.alt_raw || p.name, loading: "lazy" }),
            h("div", { class: "store-variant-image-meta" }, h("strong", {}, image.alt_raw || p.name), h("small", {}, image.source_url || image.url_original), makeField("Привязать к", assignment), h("div", { class: "store-variant-image-actions" }, save, remove)),
          );
        }) : [h("p", { class: "muted" }, "Свободных общих фотографий нет. Все фотографии уже назначены вариантам или удалены из карточки.")]),
      );
    }

    function renderVariantList() {
      syncVariantImages();
      variantList.replaceChildren(...variants.map((variant, index) => {
        const attrs = { ...(variant.attributes || {}) };
        const countryKey = Object.keys(attrs).find((key) => /^(country|страна)$/i.test(key));
        const countryValue = countryKey ? String(attrs[countryKey] || "") : "";
        for (const key of Object.keys(attrs)) if (/цвет|color|colour|оттенок|shade/i.test(key) || /^(country|страна)$/i.test(key)) delete attrs[key];
        const name = h("input", { type: "text", maxlength: "180", required: true, value: variant.name || "", placeholder: "Название варианта" });
        const color = h("input", { type: "text", maxlength: "120", value: colorValue(variant.attributes) || variant.name || "", placeholder: "Например: Graphite Black" });
        const country = h("input", { type: "text", maxlength: "120", value: countryValue, placeholder: "Как указана в источнике" });
        const sku = h("input", { type: "text", maxlength: "100", value: variant.sku || "", placeholder: "Уникальный SKU варианта" });
        const price = h("input", { type: "text", maxlength: "80", value: variant.price_raw || "", placeholder: "Цена варианта из источника" });
        const oldPrice = h("input", { type: "text", maxlength: "80", value: variant.old_price_raw || "", placeholder: "Старая цена, если есть" });
        const availability = h("input", { type: "text", maxlength: "120", value: variant.availability_label_raw || "", placeholder: "Подпись наличия" });
        const variantDescription = h("textarea", { rows: "3", maxlength: "5000", placeholder: "Пусто — описание модели" }, variant.description || "");
        const variantStatus = h("select", {}, ...[["", "Как у товара"], ["unknown", "Уточняется"], ["in_stock", "В наличии"], ["out_of_stock", "Отсутствует"], ["preorder", "Предзаказ"]].map(([value, label]) => h("option", { value, selected: (variant.availability_status || "") === value }, label)));
        const sortOrder = h("input", { type: "number", min: "0", max: "100000", value: String(variant.sort_order ?? index), placeholder: "Порядок" });
        const extra = h("textarea", { rows: "3", spellcheck: "false", placeholder: '{"Вкус":"...","Объём":"..."}' }, variant._extraDraft ?? JSON.stringify(attrs, null, 2));
        for (const [control, key] of [[name, "name"], [sku, "sku"], [price, "price_raw"], [oldPrice, "old_price_raw"], [availability, "availability_label_raw"], [sortOrder, "sort_order"], [variantDescription, "description"], [variantStatus, "availability_status"], [extra, "_extraDraft"]]) control.addEventListener("input", () => { variant[key] = control.value; });
        country.addEventListener("input", () => { const updated = { ...(variant.attributes || {}) }; for (const key of Object.keys(updated)) if (/^(country|страна)$/i.test(key)) delete updated[key]; if (country.value.trim()) updated.country = country.value.trim(); variant.attributes = updated; });
        color.addEventListener("input", () => { const updated = { ...(variant.attributes || {}) }; for (const key of Object.keys(updated)) if (/цвет|color|colour|оттенок|shade/i.test(key)) delete updated[key]; updated.color = color.value; variant.attributes = updated; });
        const save = h("button", { type: "button", class: "btn solid", onclick: async () => {
          let attributes;
          try { attributes = parseAttributes(extra.value); }
          catch (error) { toast(error.message); return; }
          if (country.value.trim()) attributes.country = country.value.trim();
          const body = { name: name.value.trim(), color: color.value.trim(), sku: sku.value.trim(), price_raw: price.value.trim(), old_price_raw: oldPrice.value.trim(), availability_label_raw: availability.value.trim(), availability_status: variantStatus.value, description: variantDescription.value.trim(), sort_order: Number(sortOrder.value || 0), attributes };
          try {
            const response = await api(variant.id ? `/store/products/${p.id}/variants/${variant.id}` : `/store/products/${p.id}/variants`, { method: variant.id ? "PUT" : "POST", body });
            const saved = response.data || response;
            variants[index] = { ...saved, attributes: saved.attributes || { ...attributes, ...(body.color ? { color: body.color } : {}) }, images: variant.images || [] };
            publishProductChanges();
            toast("Вариант сохранён");
            renderVariantList();
            renderImageList();
          } catch (error) { toast(error.message); }
        } }, variant.id ? "Сохранить вариант" : "Создать вариант");
        const remove = h("button", { type: "button", class: "btn danger", onclick: async () => {
          if (!variant.id) { variants.splice(index, 1); renderVariantList(); return; }
          if (!confirm(`Удалить вариант «${variant.name}»? Его фотографии останутся общими фотографиями товара.`)) return;
          try {
            await api(`/store/products/${p.id}/variants/${variant.id}`, { method: "DELETE" });
            images.forEach((image) => { if (Number(image.variant_id) === Number(variant.id)) image.variant_id = null; });
            variants.splice(index, 1);
            publishProductChanges();
            toast("Вариант удалён, фотографии сохранены у товара");
            renderVariantList(); renderImageList();
          } catch (error) { toast(error.message); }
        } }, "Удалить");
        const fileInput = h("input", { type: "file", multiple: true, accept: ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp", class: "store-variant-file-input", "aria-label": `Загрузить фото для ${variant.name || "варианта"}` });
        fileInput.disabled = !variant.id;
        fileInput.addEventListener("change", async () => {
          const files = Array.from(fileInput.files || []).slice(0, 12);
          if (!files.length) return;
          if (!variant.id) { toast("Сначала сохраните вариант, затем загружайте фотографии"); fileInput.value = ""; return; }
          fileInput.disabled = true;
          const errors = [];
          let count = 0;
          try {
            for (const file of files) {
              try {
                const response = await upload(`/store/products/${p.id}/images/upload`, file, { "X-Variant-Id": String(variant.id) });
                const image = response.data || response;
                if (Number(image.variant_id) !== Number(variant.id)) throw new Error("Сервер не подтвердил привязку фото к выбранному варианту");
                images.push(image); count += 1;
              } catch (error) { errors.push(`${file.name}: ${error.message}`); }
            }
            if (count) { publishProductChanges(); toast(`Фото привязаны к «${variant.name}»: ${count}`); renderVariantList(); renderImageList(); }
            if (errors.length) toast(errors.slice(0, 2).join(" · "));
          } finally { fileInput.disabled = !variant.id; fileInput.value = ""; }
        });
        const imageUrl = h("input", { type: "url", maxlength: "1000", placeholder: "HTTPS URL или /uploads/catalog/..." });
        const addUrl = h("button", { type: "button", class: "btn quiet", disabled: !variant.id, onclick: async () => {
          const url = imageUrl.value.trim();
          if (!url) return toast("Укажите URL изображения");
          try {
            const response = await api(`/store/products/${p.id}/images`, { method: "POST", body: { url, variant_id: variant.id, alt: `${p.name} — ${name.value.trim() || variant.name}`, source_url: /^https:\/\//i.test(url) ? url : "" } });
            images.push(response.data || response); publishProductChanges(); imageUrl.value = "";
            toast("Фото привязано к варианту"); renderVariantList(); renderImageList();
          } catch (error) { toast(error.message); }
        } }, "Привязать URL");
        const assignedPhotoStrip = h("div", { class: "store-variant-assigned-photos" },
          variant.images.length
            ? variant.images.map((image) => h("figure", { class: "store-variant-assigned-photo" }, h("img", { src: image.url_original, alt: image.alt_raw || variant.name, loading: "lazy" }), h("figcaption", {}, `Фото #${image.id}`)))
            : [h("p", { class: "muted" }, "К этому варианту ещё не привязано фото.")],
        );
        const sharedPhotoChoices = images.filter((image) => !Number(image.variant_id));
        const assignSharedPhotos = h("div", { class: "store-variant-assign-shared" },
          h("strong", {}, "Выбрать уже загруженное фото для этого варианта"),
          h("small", { class: "muted" }, "Нажмите на миниатюру — фото сразу закрепится за этим цветом."),
          sharedPhotoChoices.length
            ? h("div", { class: "store-variant-shared-photo-grid" }, ...sharedPhotoChoices.map((image) => h("button", { type: "button", class: "store-variant-shared-photo", disabled: !variant.id, title: `Привязать фото #${image.id} к ${variant.name}`, onclick: async () => {
                try {
                  const response = await api(`/store/products/${p.id}/images/${image.id}`, { method: "PUT", body: { variant_id: variant.id, alt: `${p.name} — ${variant.name}`, position: image.position || 0 } });
                  Object.assign(image, response.data || response);
                  publishProductChanges();
                  toast(`Фото #${image.id} привязано к варианту «${variant.name}»`);
                  renderVariantList(); renderImageList();
                } catch (error) { toast(error.message); }
              } }, h("img", { src: image.url_original, alt: image.alt_raw || p.name, loading: "lazy" }), h("span", {}, `Фото #${image.id}`))))
            : h("p", { class: "muted" }, "Свободных общих фотографий нет."),
        );
        const card = h("article", { class: "store-variant-editor-card" },
          h("div", { class: "store-variant-editor-heading" }, h("strong", {}, `${variant.name || `Вариант #${variant.id || index + 1}`} · ${colorValue(variant.attributes) || "цвет не указан"}`), h("small", { class: "muted" }, `Фотографий: ${variant.images.length}`)),
          h("div", { class: "store-variant-photo-assignment" }, assignedPhotoStrip, assignSharedPhotos),
          h("div", { class: "seo-editor-grid" },
            makeField("Название варианта", name), makeField("Страна (как указана в источнике)", country), makeField("Цвет / подпись на витрине", color),
            makeField("Артикул варианта (уникальный в товаре)", sku), makeField("Цена варианта", price),
            makeField("Старая цена", oldPrice), makeField("Подпись наличия", availability), makeField("Статус наличия варианта", variantStatus), makeField("Описание варианта", variantDescription, "Пусто — используется описание товара."),
            makeField("Порядок показа", sortOrder), makeField("Дополнительные атрибуты JSON", extra, "Цвет хранится отдельно; остальные характеристики сохраняются как JSON."),
          ),
          h("div", { class: "store-variant-editor-actions" }, save, remove),
          makeField("Загрузить фотографии этого варианта", fileInput, variant.id ? "Выберите один или несколько JPG, PNG или WebP. Файлы сразу сохранятся у этого цвета." : "Сначала сохраните вариант, затем можно будет загрузить его фотографии."),
          h("div", { class: "store-variant-image-url" }, imageUrl, addUrl),
        );
        card.dataset.variantSearch = `${variant.name || ""} ${variant.sku || ""} ${countryValue}`.toLocaleLowerCase("ru-RU");
        card.hidden = Boolean(variant.id) && Boolean(variantSearch.value.trim()) && !card.dataset.variantSearch.includes(variantSearch.value.trim().toLocaleLowerCase("ru-RU"));
        return card;
      }));
    }
    variantSearch.addEventListener("input", () => {
      const term = variantSearch.value.trim().toLocaleLowerCase("ru-RU");
      for (const card of variantList.children) card.hidden = Boolean(term) && !card.dataset.variantSearch.includes(term);
    });

    const addVariant = h("button", { type: "button", class: "btn solid", onclick: () => {
      variants.push({ id: null, name: "", sku: "", attributes: {}, price_raw: "", old_price_raw: "", availability_label_raw: "", sort_order: variants.length, images: [] });
      renderVariantList();
    } }, "Добавить вариант / цвет");
    const body = h("div", { class: "store-variants-editor" },
      h("p", { class: "muted" }, "Создайте отдельный вариант для каждого цвета или исполнения. Сначала сохраните вариант, затем загрузите или привяжите его фотографии. Фото можно переназначить между общим товаром и конкретным вариантом."),
      h("div", { class: "store-variants-toolbar" }, addVariant, variantSearch, h("span", { class: "muted" }, `Товар: ${p.name} · SKU: ${p.sku || "не указан"}`)),
      variantList,
      imageList,
    );
    const close = sheet(`Варианты и фотографии · ${p.name}`, body);
    renderVariantList();
    renderImageList();
  }

  async function editSeo(p) {
    const makeField = (label, control, hint = "") => h("label", { class: "field seo-form-field" },
      h("span", {}, label), control, hint ? h("small", { class: "muted" }, hint) : null);
    const seoH1 = h("input", { type: "text", maxlength: "160", value: p.seo_h1 || p.name || "", placeholder: "Заголовок страницы H1" });
    const seoTitle = h("input", { type: "text", maxlength: "180", value: p.seo_title || p.name || "", placeholder: "Заголовок для поисковой выдачи" });
    const seoDescription = h("textarea", { rows: "4", maxlength: "320", placeholder: "Кратко и точно опишите содержание страницы" }, p.seo_description || p.description || "");
    const canonical = h("input", { type: "url", value: p.canonical_url || "", placeholder: "https://example.ru/product/slug" });
    const keywords = h("textarea", { rows: "3", placeholder: "Один запрос на строку или через запятую" }, (p.seo_keywords || []).join("\n"));

    const counters = {
      h1: h("small", { class: "seo-char-counter" }, `${seoH1.value.length}/160`),
      title: h("small", { class: "seo-char-counter" }, `${seoTitle.value.length}/180`),
      description: h("small", { class: "seo-char-counter" }, `${seoDescription.value.length}/320`),
    };
    const previewTitle = h("strong", {}, seoTitle.value || "Заголовок страницы появится здесь");
    const previewDescription = h("p", { class: "muted" }, seoDescription.value || "Описание для поисковой выдачи появится здесь.");
    const previewUrl = h("span", { class: "seo-preview-url" }, canonical.value || `/product/${p.slug}`);
    const updatePreview = () => {
      counters.h1.textContent = `${seoH1.value.length}/160`;
      counters.title.textContent = `${seoTitle.value.length}/180`;
      counters.description.textContent = `${seoDescription.value.length}/320`;
      previewTitle.textContent = seoTitle.value || "Заголовок страницы появится здесь";
      previewDescription.textContent = seoDescription.value || "Описание для поисковой выдачи появится здесь.";
      previewUrl.textContent = canonical.value || `/product/${p.slug}`;
    };
    [seoH1, seoTitle, seoDescription, canonical].forEach((input) => input.addEventListener("input", updatePreview));

    const form = h("form", { class: "seo-editor-form" },
      h("div", { class: "seo-editor-grid" },
        makeField("H1 страницы", seoH1, "Один основной заголовок, соответствующий содержанию карточки."),
        h("div", { class: "seo-counter-row" }, counters.h1),
        makeField("SEO Title", seoTitle, "Не копируйте механически H1: заголовок должен точно описывать эту страницу."),
        h("div", { class: "seo-counter-row" }, counters.title),
        makeField("Meta Description", seoDescription, "Краткое описание страницы. Счётчик длины — ориентир, а не гарантия сниппета."),
        h("div", { class: "seo-counter-row" }, counters.description),
        makeField("Canonical URL", canonical, "Оставьте пустым, чтобы использовать канонический адрес страницы по умолчанию."),
        makeField("Поисковые запросы", keywords, "Один запрос на строку. Частотность и источник добавляются отдельно ниже в SEO-анализе."),
      ),
      h("p", { class: "muted" }, "Индексация товара определяется статусом: опубликован — доступен для индексации; черновик и архив не публикуются. Наличие на складе — отдельный параметр."),
      h("div", { class: "seo-preview-card" }, h("span", { class: "eyebrow" }, "Предварительный просмотр"), previewUrl, previewTitle, previewDescription),
      h("div", { class: "seo-editor-actions" },
        h("span", { class: "muted" }, "Изменения сохраняются в карточке товара."),
        h("button", { class: "btn solid", type: "submit" }, "Сохранить SEO")
      )
    );
    const close = sheet(`SEO · ${p.name}`, form);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const seoKeywords = keywords.value.split(/[;,\n]/).map((item) => item.trim()).filter(Boolean).slice(0, 40);
      try {
        await api(`/store/products/${p.id}`, { method: "PUT", body: {
          seo_h1: seoH1.value.trim(), seo_title: seoTitle.value.trim(), seo_description: seoDescription.value.trim(),
          canonical_url: canonical.value.trim(), seo_keywords: seoKeywords,
        } });
        toast("SEO-поля сохранены"); close(); await reload();
      } catch (error) { toast(error.message); }
    });
  }
  async function addKeyword(p) {
    const makeField = (label, control, hint = "") => h("label", { class: "field seo-form-field" },
      h("span", {}, label), control, hint ? h("small", { class: "muted" }, hint) : null);
    const keyword = h("input", { type: "text", maxlength: "240", required: true, placeholder: "Например, название модели" });
    const frequency = h("select", {},
      h("option", { value: "unknown" }, "Не определена"),
      h("option", { value: "high" }, "ВЧ — высокая"),
      h("option", { value: "medium" }, "СЧ — средняя"),
      h("option", { value: "low" }, "НЧ — низкая")
    );
    const volume = h("input", { type: "number", min: "0", step: "1", placeholder: "Не указывать без источника" });
    const engine = h("select", {}, h("option", { value: "Yandex" }, "Яндекс"), h("option", { value: "Google" }, "Google"), h("option", { value: "Other" }, "Другой источник"));
    const region = h("input", { type: "text", maxlength: "120", value: "Россия", placeholder: "Регион" });
    const intent = h("select", {}, ...[["informational","Информационный"],["commercial","Коммерческий"],["navigational","Навигационный"],["transactional","Транзакционный"],["unknown","Не определён"]].map(([value,label])=>h("option",{value},label)));
    const source = h("input", { type: "text", maxlength: "160", placeholder: "Wordstat, ручная проверка и т. п." });
    const checkedAt = h("input", { type: "date", value: new Date().toISOString().slice(0, 10) });
    const form = h("form", { class: "seo-keyword-form" },
      makeField("Поисковый запрос", keyword),
      h("div", { class: "seo-editor-grid" },
        makeField("Частотный класс", frequency),
        makeField("Частотность", volume, "Оставьте пустым, если нет подтверждённого значения."),
        makeField("Поисковая система", engine),
        makeField("Регион", region),
        makeField("Намерение запроса", intent),
        makeField("Источник данных", source),
        makeField("Дата проверки", checkedAt),
      ),
      h("div", { class: "seo-editor-actions" },
        h("span", { class: "muted" }, "Не добавляйте предполагаемые значения частотности."),
        h("button", { class: "btn solid", type: "submit" }, "Сохранить запрос")
      )
    );
    const close = sheet(`Поисковый запрос · ${p.name}`, form);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (volume.value && (!Number.isSafeInteger(Number(volume.value)) || Number(volume.value) < 0)) return toast("Частотность должна быть целым неотрицательным числом");
      try {
        await api(`/store/products/${p.id}/keywords`, { method: "POST", body: {
          keyword: keyword.value.trim(), frequency_class: frequency.value,
          search_volume: volume.value, search_engine: engine.value, region: region.value.trim(),
          search_intent: intent.value, source: source.value.trim(), checked_at: checkedAt.value,
        } });
        toast("Поисковый запрос сохранён"); close(); await reload();
      } catch (error) { toast(error.message); }
    });
  }
  async function pickImages(p) {
    const query = p.image_search_query || `${p.brand || ""} ${p.name}`.trim();
    const slug = p.slug || `product-${p.id}`;
    const qwenTask = [
      `Подбери изображения для товара VAPELAB: ${p.name}.`,
      `Бренд: ${p.brand || "не указан"}. Артикул: ${p.sku || "не указан"}. Модель/вариант: ${p.format || p.product_type || "не указан"}.`,
      `Поисковый запрос: ${query}.`,
      `Страница исходного товара: ${p.source_url || "не указана"}. Slug товара в VAPELAB: ${slug}.`,
      "Открой папку qwen-workspace, прочитай QWEN.md и manifest.json. Если в manifest есть этот slug, выполни /enrich-catalog <slug>: команда должна подготовить enriched.json (описание, тип, формат, SEO H1/Title/Description/Keywords) и image-sources.json. Не меняй исходный source.json. Если slug отсутствует, не создавай произвольную запись импорта: сообщи, что сначала нужно добавить товар в manifest через каталоговый парсер.",
      "Используй доступные инструменты Qwen Code web_search и web_fetch (сначала проверь /tools; у некоторых провайдеров их может не быть). Ищи прежде всего официальный сайт производителя или пресс/медиаматериалы; не используй изображения другого цвета/модели и не выдавай похожую модель за нужную.",
      "Скачивай только изображения, которые можно правомерно использовать в каталоге. Если права или источник неясны — не скачивай, верни URL-кандидат и пометку, что нужна проверка лицензии.",
      `Если скачивание разрешено, сохрани общие фото в qwen-workspace/images/${slug}/, а фото вариантов — в подпапках с точным названием цвета/варианта: images/${slug}/Graphite Black/01-main.jpg. Сохрани URL страницы-источника и краткое основание права использования в qwen-workspace/products/${slug}/image-sources.json.`,
      "Не копируй чужие описания дословно. Подготовь нейтральное структурированное описание и SEO отдельно на основе подтверждённых характеристик. Не выдумывай цену, SKU, наличие, совместимость, крепость, состав, гарантию или сертификаты.",
      "Не обходи CAPTCHA, авторизацию, paywall, robots.txt, 401/403/429 или иные ограничения доступа. Не публикуй товар автоматически.",
    ].join("\n");

    const help = h("p", { class: "muted image-picker-help" }, "Поиск изображений через Yandex API не обязателен. Qwen может найти официальный источник в своей локальной сессии, а сюда загружаются уже проверенные файлы или URL.");
    const promptArea = h("textarea", { class: "image-qwen-prompt", rows: "7", readonly: true }, qwenTask);
    const copyPrompt = button("Скопировать задание для Qwen · фото + SEO", async () => {
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(qwenTask);
        else {
          promptArea.focus(); promptArea.select();
          if (!document.execCommand("copy")) throw new Error("Копирование не поддерживается браузером");
        }
        toast("Задание скопировано. Вставьте его в Qwen Code, открыв папку qwen-workspace.");
      } catch (error) { toast(error.message || "Не удалось скопировать задание"); }
    }, "btn quiet");

    const fileInput = h("input", { type: "file", multiple: true, accept: ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp", hidden: true });
    const uploadButton = button("Загрузить изображения с компьютера", () => fileInput.click(), "btn solid");
    fileInput.addEventListener("change", async () => {
      const files = Array.from(fileInput.files || []);
      if (!files.length) return;
      uploadButton.disabled = true;
      let uploaded = 0;
      const errors = [];
      try {
        for (const file of files.slice(0, 12)) {
          try {
            await upload(`/store/products/${p.id}/images/upload`, file);
            uploaded += 1;
          } catch (error) { errors.push(`${file.name}: ${error.message}`); }
        }
        if (files.length > 12) errors.push("За один раз можно загрузить не более 12 изображений.");
        if (uploaded) { toast(`Загружено изображений: ${uploaded}`); close(); await reload(); }
        if (errors.length) toast(errors.slice(0, 2).join(" · "));
      } finally { uploadButton.disabled = false; fileInput.value = ""; }
    });

    const imageUrl = h("input", { type: "url", maxlength: "1000", placeholder: "HTTPS URL проверенного изображения" });
    const imageAlt = h("input", { type: "text", maxlength: "240", value: p.name || "", placeholder: "ALT изображения" });
    const attachUrl = button("Добавить URL", async () => {
      const url = imageUrl.value.trim();
      if (!/^https:\/\//i.test(url) && !/^\/uploads\/catalog\/[a-z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(url)) return toast("Укажите HTTPS URL или путь к уже загруженному фото");
      try {
        await api(`/store/products/${p.id}/images`, { method: "POST", body: { url, alt: imageAlt.value.trim() || p.name, source_url: url.startsWith("https://") ? url : "" } });
        toast("Изображение добавлено. Проверьте его в карточке товара."); close(); await reload();
      } catch (error) { toast(error.message); }
    }, "btn quiet");

    const currentImages = Array.isArray(p.images) ? p.images : [];
    const gallery = h("div", { class: "image-picker-gallery" },
      h("h4", {}, "Уже привязанные изображения"),
      currentImages.length ? h("div", { class: "image-suggestion-grid" }, ...currentImages.map((item) => h("article", { class: "image-suggestion" },
        h("img", { src: item.url_original, alt: item.alt_raw || p.name, loading: "lazy" }),
        h("small", {}, item.source_url || item.url_original),
      ))) : h("p", { class: "muted" }, "Пока нет привязанных фотографий."),
    );
    const body = h("div", { class: "image-picker" },
      help,
      h("section", { class: "image-picker-method" }, h("h4", {}, "1. Подобрать изображение через Qwen"), copyPrompt, promptArea),
      h("section", { class: "image-picker-method" }, h("h4", {}, "2. Загрузить скачанные файлы"), h("p", { class: "muted" }, "Можно выбрать несколько JPG, PNG или WebP. Файлы будут привязаны непосредственно к этому товару."), uploadButton, fileInput),
      h("section", { class: "image-picker-method" }, h("h4", {}, "3. Добавить проверенный URL"), h("div", { class: "image-picker-url" }, imageUrl, imageAlt, attachUrl)),
      gallery,
    );
    const close = sheet(`Фотографии · ${p.name}`, body);
  }

  async function editCategory(c) {
    const makeField = (label, control, hint = "") => h("label", { class: "field seo-form-field" }, h("span", {}, label), control, hint ? h("small", { class: "muted" }, hint) : null);
    const name = h("input", { type: "text", maxlength: "180", required: true, value: c.name || "" });
    const slug = h("input", { type: "text", maxlength: "180", value: c.slug || "" });
    const parent = h("select", {}, h("option", { value: "" }, "Основная категория"), ...data.categories.filter((item) => !item.parent_id && Number(item.id) !== Number(c.id)).map((item) => h("option", { value: String(item.id), selected: Number(item.id) === Number(c.parent_id) }, item.name)));
    const description = h("textarea", { rows: "4", maxlength: "1200" }, c.description || "");
    const active = h("select", {}, h("option", { value: "1", selected: Boolean(c.is_active) }, "Активна"), h("option", { value: "0", selected: !c.is_active }, "Скрыта"));
    const representative = h("select", { disabled: true }, h("option", { value: "" }, c.id ? "Загружаем опубликованные товары категории…" : "Сначала сохраните категорию"));
    const featuredNote = h("p", { class: "muted" }, "Выбранный товар будет мягко проявляться на карточке категории при наведении. Можно оставить пустым.");
    const form = h("form", { class: "seo-editor-form category-editor-form" },
      h("div", { class: "seo-editor-grid" }, makeField("Название", name), makeField("Slug", slug), makeField("Родительская категория", parent), makeField("Статус", active)),
      makeField("Товар-представитель категории", representative), featuredNote,
      makeField("Описание", description),
      h("div", { class: "seo-editor-actions" }, h("span", { class: "muted" }, "Товар должен быть опубликован и привязан к этой категории."), h("button", { class: "btn solid", type: "submit" }, "Сохранить категорию"))
    );
    const close = sheet(`Категория · ${c.name}`, form);
    if (c.id) {
      try {
        const options = await api(`/store/products/options?limit=1000&category_id=${c.id}&published_only=1`);
        representative.replaceChildren(h("option", { value: "" }, "Не показывать товар на карточке"), ...(options || []).map((product) => h("option", { value: String(product.id), selected: Number(product.id) === Number(c.featured_product_id) }, `${product.name}${product.sku ? ` · ${product.sku}` : ""}`)));
        representative.disabled = false;
        if (!options.length) featuredNote.textContent = "В этой категории пока нет опубликованных товаров. Сначала опубликуйте товар и добавьте его в категорию.";
      } catch (error) {
        representative.replaceChildren(h("option", { value: "" }, "Не удалось загрузить товары категории"));
        featuredNote.textContent = error.message;
      }
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await api(`/store/categories/${c.id}`, { method: "PUT", body: { name: name.value.trim(), slug: slug.value.trim(), parent_id: parent.value ? Number(parent.value) : null, description: description.value.trim(), is_active: Number(active.value), featured_product_id: representative.value ? Number(representative.value) : null } });
        toast("Категория сохранена"); close(); await reload();
      } catch (error) { toast(error.message); }
    });
  }

  async function editNews(n = null) {
    const productOptions = await api("/store/products/options?limit=1000").catch(() => data.products || []);
    const title = h("input", { required: true, maxlength: "240", value: n?.title || "", placeholder: "Заголовок публикации" });
    const slug = h("input", { maxlength: "180", value: n?.slug || "", placeholder: "URL-адрес (создаётся из заголовка)" });
    const excerpt = h("textarea", { rows: "3", maxlength: "800", placeholder: "Краткое описание для карточки новости" }, n?.excerpt || "");
    const imageUrl = h("input", { type: "url", maxlength: "1000", value: n?.image_url || "", placeholder: "https://… или локальный адрес загруженного фото" });
    const imageFile = h("input", { type: "file", accept: ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" });
    const imageHidden = h("input", { type: "checkbox", checked: Boolean(n?.image_hidden) });
    const is18Plus = h("input", { type: "checkbox", checked: Boolean(n?.is_18_plus) });
    const status = h("select", {}, ...[["draft", "Черновик"], ["published", "Опубликовать"], ["archived", "Архив"]].map(([value, label]) => h("option", { value, selected: (n?.status || "draft") === value }, label)));
    const publishedAt = h("input", { type: "date", value: String(n?.published_at || new Date().toISOString().slice(0, 10)).slice(0, 10) });
    const productIds = new Set((n?.product_ids_json ? (() => { try { return JSON.parse(n.product_ids_json); } catch { return []; } })() : []).map(Number));
    const productsSelect = h("select", { multiple: true, size: "7", class: "store-category-select" }, ...productOptions.map((product) => h("option", { value: String(product.id), selected: productIds.has(Number(product.id)) }, `${product.name}${Number(product.is_18_plus) ? " · 18+" : ""}`)));
    const editor = h("div", { class: "news-rich-editor", contenteditable: "true", role: "textbox", "aria-label": "Содержание новости" });
    editor.innerHTML = n?.body_html || (n?.body ? `<p>${String(n.body).replace(/[&<>]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[char]))}</p>` : "<p></p>");
    const editorTools = h("div", { class: "news-editor-tools" },
      ...[["Жирный", "bold"], ["Курсив", "italic"], ["Заголовок", "formatBlock", "<h2>"], ["Список", "insertUnorderedList"], ["Цитата", "formatBlock", "<blockquote>"]].map(([label, command, value]) => h("button", { type: "button", class: "btn quiet", onclick: () => { editor.focus(); document.execCommand(command, false, value || null); } }, label)),
      h("button", { type: "button", class: "btn quiet", onclick: () => { const url = prompt("HTTPS-ссылка или адрес товара /product/…"); if (url) { editor.focus(); document.execCommand("createLink", false, url); } } }, "Ссылка")
    );
    const promptInput = h("textarea", { rows: "2", maxlength: "1800", placeholder: "Коротко опишите тему. Google Search проверит факты и подготовит черновик." });
    const generateButton = button("Подготовить черновик через Google", async () => {
      if (!promptInput.value.trim()) return toast("Введите тему новости");
      generateButton.disabled = true;
      try {
        const draft = await api("/store/news/generate", { method: "POST", body: { prompt: promptInput.value.trim() } });
        title.value = draft.title || title.value;
        excerpt.value = draft.excerpt || excerpt.value;
        editor.innerHTML = draft.body_html || "<p></p>";
        sourceList.replaceChildren(...(draft.sources || []).map((url) => h("p", {}, h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, url))));
        toast("Черновик подготовлен. Проверьте источники и содержание перед публикацией.");
      } catch (error) { toast(error.message); }
      finally { generateButton.disabled = false; }
    }, "btn quiet");
    const sourceList = h("div", { class: "news-source-list" });
    const uploadImage = button("Загрузить фото", async () => {
      const file = imageFile.files?.[0];
      if (!file) return toast("Выберите изображение");
      try { const result = await upload("/store/news/images", file); imageUrl.value = result.url || result.data?.url || ""; toast("Изображение загружено"); }
      catch (error) { toast(error.message); }
    }, "btn quiet");
    const makeField = (label, control) => h("label", { class: "field seo-form-field" }, h("span", {}, label), control);
    const form = h("form", { class: "seo-editor-form store-news-editor", onsubmit: async (event) => {
      event.preventDefault();
      const selectedProducts = Array.from(productsSelect.selectedOptions).map((option) => Number(option.value));
      const payload = { title: title.value.trim(), slug: slug.value.trim(), excerpt: excerpt.value.trim(), body_html: editor.innerHTML, body: editor.innerText, image_url: imageUrl.value.trim(), image_hidden: imageHidden.checked, is_18_plus: is18Plus.checked, product_ids: selectedProducts, published_at: publishedAt.value, status: status.value };
      try {
        if (n?.id) await api(`/store/news/${n.id}`, { method: "PUT", body: payload });
        else await api("/store/news", { method: "POST", body: payload });
        toast("Публикация сохранена"); close(); await reload();
      } catch (error) { toast(error.message); }
    } },
      h("div", { class: "seo-editor-grid" }, makeField("Заголовок", title), makeField("Адрес страницы", slug), makeField("Краткое описание", excerpt), makeField("Дата публикации", publishedAt), makeField("Статус", status), makeField("Связанные товары", productsSelect)),
      makeField("Изображение URL", imageUrl), makeField("Файл изображения", imageFile), uploadImage,
      h("div", { class: "store-product-flags" }, h("label", { class: "check-field" }, imageHidden, "Скрыть фотографию публикации"), h("label", { class: "check-field" }, is18Plus, "Материал 18+ (фото скрывается автоматически)")),
      h("section", { class: "news-ai-panel" }, h("strong", {}, "Черновик с Google Search"), makeField("Короткое задание", promptInput), generateButton, sourceList),
      h("section", { class: "news-editor-section" }, h("strong", {}, "Содержание публикации"), editorTools, editor),
      h("div", { class: "seo-editor-actions" }, h("span", { class: "muted" }, "AI-материал всегда сохраняется черновиком. Проверяйте факты и ссылки вручную."), h("button", { class: "btn solid", type: "submit" }, "Сохранить публикацию"))
    );
    const close = sheet(n ? `Новость · ${n.title}` : "Новая публикация", form);
  }
  async function editPage(p) {
    const title = h("input", { type: "text", maxlength: "220", required: true, value: p.title || "" });
    const slug = h("input", { type: "text", maxlength: "180", value: p.slug || "" });
    const pageBody = h("textarea", { rows: "16", maxlength: "30000", placeholder: "Введите содержание документа. Публикация требует заполнения и подтверждения." }, p.body || "");
    const status = h("select", {}, ...[["draft","Черновик"],["published","Опубликовано"]].map(([value,label]) => h("option", { value, selected: (p.status || "draft") === value }, label)));
    const review = h("select", {}, ...[["pending","Ожидает проверки"],["approved","Проверено и разрешено к публикации"]].map(([value,label]) => h("option", { value, selected: (p.legal_review_status || "pending") === value }, label)));
    const field = (label, control, wide = false) => h("label", { class: `field seo-form-field${wide ? " editor-wide" : ""}` }, h("span", {}, label), control);
    const form = h("form", { class: "seo-editor-form store-page-form" },
      h("div", { class: "seo-editor-grid" }, field("Название", title), field("Адрес страницы (slug)", slug), field("Статус", status), field("Юридическая проверка", review)),
      field("Содержание", pageBody, true),
      h("div", { class: "seo-editor-actions" }, h("span", { class: "muted" }, p.slug === "optovy" ? "Заполните оптовое предложение, условия сотрудничества, логистику и контактные данные. После проверки установите статус «Опубликовано»." : "Не публикуйте юридические тексты до заполнения и отдельной проверки."), h("button", { class: "btn solid", type: "submit" }, "Сохранить страницу"))
    );
    const close = sheet(`Страница · ${p.title}`, form);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await api(`/store/pages/${p.id}`, { method: "PUT", body: { title: title.value.trim(), slug: slug.value.trim(), body: pageBody.value, status: status.value, legal_review_status: review.value } });
        toast("Страница сохранена"); close(); await reload();
      } catch (error) { toast(error.message); }
    });
  }
  async function changeProduct(p) {
    const choices = ["draft", "pending_review", "published", "archived"];
    const next = prompt(`Статус товара: ${choices.join(", ")}`, p.status);
    if (!next || !choices.includes(next)) return;
    try { await api(`/store/products/${p.id}`, { method: "PUT", body: { status: next } }); await reload(); } catch (e) { toast(e.message); }
  }
  function draw() {
    toolbar.replaceChildren(); body.replaceChildren();
    const add = tab === "products" ? addProduct : tab === "categories" ? addCategory : tab === "news" ? addNews : tab === "pages" ? addPage : null;
    if (add) toolbar.append(button(tab === "products" ? "+ Добавить товар" : tab === "categories" ? "+ Добавить категорию" : tab === "news" ? "+ Добавить новость" : "+ Добавить страницу", add));
    if (tab === "products") {
      toolbar.append(button("Импорт XLSX / CSV", () => openImport(reload), "btn quiet"));
      toolbar.append(button("⌕ Умный поиск товаров", openSmartSearch, "btn quiet"));
      const folderInput = h("input", { type: "file", multiple: true, webkitdirectory: true, directory: true, hidden: true });
      folderInput.addEventListener("change", async () => {
        const selected = Array.from(folderInput.files || []);
        folderInput.value = "";
        const files = selected.filter((file) => /\.(?:jpe?g|png|webp)$/i.test(file.name));
        const tables = selected.filter((file) => /\.(?:csv|xlsx)$/i.test(file.name));
        if (!files.length && !tables.length) { toast("В папке нет таблицы CSV/XLSX или изображений"); return; }
        if (tables.length > 1) { toast("Оставьте в папке только одну таблицу CSV или XLSX"); return; }
        const progress = h("p", {}, "Подготовка…");
        const results = h("div", { style: { maxHeight: "45vh", overflow: "auto" } });
        const actions = h("div", { class: "row" });
        const close = sheet("Импорт папки товаров и фото", h("div", {}, h("p", { class: "muted" }, "Папка может содержать одну таблицу CSV/XLSX и фотографии в подпапках любой глубины. Товар и вариант ищутся по названию, артикулу и ключевым словам из имени файла и папок. Сначала каждый файл проверяется в предпросмотре; в каталоге сохраняются только подтверждённые совпадения. Непривязанные файлы в каталоге сервера не сохраняются, оригиналы на компьютере не удаляются."), progress, results, actions));
        let calls = 0;
        let windowStart = Date.now();
        const send = async (file, preview) => {
          if (calls >= 80) { const delay = Math.max(0, 61000 - (Date.now() - windowStart)); if (delay) { progress.textContent = `Пауза из-за лимита загрузки: ${Math.ceil(delay / 1000)} сек.`; await new Promise((resolve) => setTimeout(resolve, delay)); } calls = 0; windowStart = Date.now(); }
          calls += 1;
          const response = await upload("/store/images/import", file, { "X-File-Path": encodeURIComponent(file.webkitRelativePath || file.name), ...(preview ? { "X-Import-Preview": "1" } : {}) });
          return response.data || response;
        };
        const showPhotos = async () => {
          actions.replaceChildren();
          if (!files.length) { progress.textContent = "Таблица обработана. Фотографий в папке нет."; actions.append(h("button", { class: "btn quiet", onclick: close }, "Закрыть")); await reload(); return; }
          const checked = [];
          for (let index = 0; index < files.length; index += 1) {
            const file = files[index];
            try { checked.push({ file, result: await send(file, true) }); }
            catch (error) { checked.push({ file, result: { status: "error", detail: error.message } }); }
            progress.textContent = `Проверено фото: ${index + 1} из ${files.length}`;
          }
          const labels = { matched: "готово", duplicate: "уже загружено", unmatched: "товар не найден", unmatched_variant: "вариант не найден", ambiguous: "несколько товаров", ambiguous_variant: "несколько вариантов", error: "ошибка" };
          const display = () => results.replaceChildren(...checked.map(({ file, result }) => h("p", {}, `${file.webkitRelativePath || file.name} — ${labels[result.status] || result.status}${result.product_name ? `: ${result.product_name}${result.variant_name ? ` / ${result.variant_name}` : " / общее фото"}` : ""}${result.detail ? ` (${result.detail})` : ""}`)));
          display();
          const ready = checked.filter((entry) => entry.result.status === "matched");
          progress.textContent = `Готово к загрузке: ${ready.length} из ${files.length}. Остальные файлы перечислены ниже.`;
          const apply = h("button", { class: "btn solid", type: "button", disabled: !ready.length, onclick: async () => {
            apply.disabled = true;
            for (let index = 0; index < ready.length; index += 1) {
              try { ready[index].result = await send(ready[index].file, false); }
              catch (error) { ready[index].result = { status: "error", detail: error.message }; }
              progress.textContent = `Обработано фото: ${index + 1} из ${ready.length}`;
            }
            display();
            const saved = checked.filter((entry) => entry.result.status === "matched").length;
            progress.textContent = `Загружено: ${saved}. Необработанные файлы и ошибки перечислены ниже.`;
            await reload();
          } }, "Подтвердить загрузку фото");
          actions.append(apply, h("button", { class: "btn quiet", type: "button", onclick: close }, "Закрыть"));
        };
        if (!tables.length) { await showPhotos(); return; }
        try {
          const response = await upload("/import/preview?entity=products", tables[0]);
          const preview = response.data || response;
          if (!Object.values(preview.mapping || {}).includes("name")) throw new Error("Название товара не распознано. Импортируйте таблицу через мастер XLSX/CSV с ручным сопоставлением, затем загрузите папку фото.");
          const checked = await api("/import/apply", { method: "POST", body: { id: preview.id, mapping: preview.mapping, dry_run: true } });
          progress.textContent = `Таблица ${tables[0].name}: ${checked.total} строк; создать: ${checked.created}, обновить: ${checked.updated}, пропустить: ${checked.skipped}.`;
          results.replaceChildren(h("p", {}, "Автосопоставление колонок:"), ...Object.entries(preview.mapping).map(([index, field]) => h("p", {}, `${preview.headers[Number(index)]} → ${preview.fields[field]?.label || field}`)), ...(checked.errors || []).map((error) => h("p", { class: "error" }, `Строка ${error.row}: ${error.detail}`)));
          const applyTable = h("button", { class: "btn solid", type: "button", onclick: async () => {
            applyTable.disabled = true;
            try {
              const saved = await api("/import/apply", { method: "POST", body: { id: preview.id, mapping: preview.mapping } });
              toast(`Таблица: создано ${saved.created}, обновлено ${saved.updated}, пропущено ${saved.skipped}`);
              if (saved.skipped) { progress.textContent = `Таблица: пропущено ${saved.skipped} строк. Исправьте ошибки и повторите импорт.`; results.replaceChildren(...(saved.errors || []).map((error) => h("p", {}, `Строка ${error.row}: ${error.detail}`))); actions.replaceChildren(h("button", { class: "btn quiet", onclick: close }, "Закрыть")); await reload(); return; }
              await showPhotos();
            } catch (error) { progress.textContent = error.message; applyTable.disabled = false; }
          } }, "Подтвердить импорт таблицы");
          actions.append(applyTable, h("button", { class: "btn quiet", onclick: close }, "Отмена"));
        } catch (error) { progress.textContent = error.message; actions.replaceChildren(h("button", { class: "btn quiet", onclick: close }, "Закрыть")); }
      });
      toolbar.append(button("Импорт папки товаров и фото", () => folderInput.click(), "btn quiet"), folderInput);
      const filterRow = h("div", { class: "store-product-filters" });
      const search = h("input", { type: "search", class: "store-product-search-input", value: productQuery, placeholder: "Поиск по названию, бренду или артикулу", autocomplete: "off" });
      const categoryFilter = h("select", {}, h("option", { value: "" }, "Все категории"), ...data.categories.map((category) => h("option", { value: String(category.id), selected: String(category.id) === productCategoryId }, category.name)));
      const statusFilter = h("select", {}, h("option", { value: "" }, "Все статусы"), ...[["draft","Черновики"],["pending_review","На проверке"],["published","Опубликовано"],["archived","Архив"],].map(([value,label]) => h("option", { value, selected: value === productStatus }, label)));
      filterRow.append(search, categoryFilter, statusFilter);
      const tableBody = h("tbody", {});
      const selectPage = h("input", { type: "checkbox", title: "Выбрать товары на этой странице" });
      const productTable = h("table", { class: "table store-products-table" }, h("thead", {}, h("tr", {},
        h("th", {}, selectPage), ...["Товар", "Категории", "Бренд", "Цена", "Публикация", "Наличие", "Действия"].map((x) => h("th", {}, x))
      )), tableBody);
      const filterCount = h("p", { class: "muted store-filter-count" }, "");
      const bulkBar = h("div", { class: "store-bulk-bar" });
      const bulkCount = h("strong", {}, "Выбрано: 0");
      const bulkAction = h("select", {},
        h("option", { value: "" }, "Массовое действие"),
        ...[["publish","Показать в каталоге"],["draft","Скрыть из каталога"],["archive","В архив"],["in_stock","Отметить: в наличии"],["out_of_stock","Отметить: отсутствует"],["preorder","Отметить: предзаказ"],["unknown","Наличие уточняется"],["enable_reservations","Разрешить бронирование"],["delete","Удалить выбранные" ]].map(([value,label]) => h("option", { value }, label))
      );
      const bulkApply = button("Применить", async () => {
        const ids = [...selectedProductIds];
        if (!ids.length || !bulkAction.value) return toast("Выберите товары и массовое действие");
        if (ids.length > 100) return toast("За одну операцию можно выбрать не более 100 товаров. Снимите часть отметок.");
        if (bulkAction.value === "delete" && !confirm(`Удалить выбранные товары (${ids.length}) без возможности восстановления?`)) return;
        if (bulkAction.value !== "delete") {
          const confirmation = bulkAction.value === "enable_reservations"
            ? `Разрешить бронирование для ${ids.length} выбранных товаров?`
            : `Применить действие к ${ids.length} товарам?`;
          if (!confirm(confirmation)) return;
        }
        bulkApply.disabled = true;
        try {
          const result = await api("/store/products/bulk", { method: "POST", body: { ids, action: bulkAction.value } });
          selectedProductIds.clear(); bulkAction.value = "";
          const restock = result.restock?.subscribers ? ` Подписчиков: ${result.restock.subscribers}, уведомлений e-mail: ${result.restock.email_sent}, Telegram: ${result.restock.telegram_sent}.` : "";
          toast(`Обработано товаров: ${result.affected}.${restock}`); await reload();
        } catch (error) { toast(error.message); } finally { bulkApply.disabled = false; }
      }, "btn solid");
      const clearSelection = button("Снять выбор", () => { selectedProductIds.clear(); renderProductRows(); }, "btn quiet");
      bulkBar.append(bulkCount, bulkAction, bulkApply, clearSelection);
      const pagerTop = h("div", { class: "pager-controls product-pager product-pager-top" });
      const pager = h("div", { class: "pager-controls product-pager" });
      const availabilityLabel = (value) => ({ in_stock: "В наличии", out_of_stock: "Отсутствует", preorder: "Предзаказ", unknown: "Уточняется" })[value] || "Уточняется";
      const refreshBulkBar = () => {
        bulkCount.textContent = `Выбрано: ${selectedProductIds.size}`;
        bulkBar.classList.toggle("is-active", selectedProductIds.size > 0);
      };
      selectPage.addEventListener("change", () => {
        for (const product of data.products || []) {
          if (selectPage.checked) selectedProductIds.add(Number(product.id));
          else selectedProductIds.delete(Number(product.id));
        }
        renderProductRows();
      });
      const renderProductRows = () => {
        const rows = data.products || [];
        selectPage.checked = rows.length > 0 && rows.every((product) => selectedProductIds.has(Number(product.id)));
        selectPage.indeterminate = rows.some((product) => selectedProductIds.has(Number(product.id))) && !selectPage.checked;
        tableBody.replaceChildren(...rows.map((product) => {
          const names = (product.category_ids || []).map((id) => data.categories.find((item) => Number(item.id) === Number(id))?.name).filter(Boolean);
          const check = h("input", { type: "checkbox", "aria-label": `Выбрать ${product.name}` });
          check.checked = selectedProductIds.has(Number(product.id));
          check.addEventListener("change", () => { if (check.checked) selectedProductIds.add(Number(product.id)); else selectedProductIds.delete(Number(product.id)); refreshBulkBar(); selectPage.checked = rows.length > 0 && rows.every((item) => selectedProductIds.has(Number(item.id))); selectPage.indeterminate = rows.some((item) => selectedProductIds.has(Number(item.id))) && !selectPage.checked; });
          const stockSelect = h("select", { class: "store-stock-select", "aria-label": `Наличие: ${product.name}` }, ...[["unknown","Уточняется"],["in_stock","В наличии"],["out_of_stock","Отсутствует"],["preorder","Предзаказ"]].map(([value,label]) => h("option", { value, selected: (product.availability_status || "unknown") === value }, label)));
          stockSelect.addEventListener("change", async () => {
            const previous = product.availability_status || "unknown"; stockSelect.disabled = true;
            try { await api(`/store/products/${product.id}`, { method: "PUT", body: { availability_status: stockSelect.value } }); product.availability_status = stockSelect.value; toast(`Наличие: ${availabilityLabel(stockSelect.value)}`); }
            catch (error) { stockSelect.value = previous; toast(error.message); } finally { stockSelect.disabled = false; }
          });
          return h("tr", {},
            h("td", {}, check),
            h("td", {}, h("strong", {}, product.name), h("small", {}, product.sku || "Артикул не указан"), Number(product.is_18_plus) ? h("span", { class: "status-pill age-pill" }, "18+") : null),
            h("td", {}, names.length ? names.join(" · ") : "Не назначена"),
            h("td", {}, product.brand || "—"),
            h("td", {}, product.price_raw || "Не указана"),
            h("td", {}, button(statusLabel(product.status), () => changeProduct(product), "btn quiet")),
            h("td", {}, stockSelect),
            h("td", {}, button("Карточка", () => editProduct(product), "btn quiet"), button("SEO", () => editSeo(product), "btn quiet"), button("Фото", () => pickImages(product), "btn quiet"))
          );
        }));
        refreshBulkBar();
        const pagination = data.product_pagination || { page: 1, page_size: 50, total: rows.length, total_pages: 1 };
        filterCount.textContent = `Показано ${rows.length} из ${pagination.total} товаров · по ${pagination.page_size} на странице`;
        const controls = () => h("div", { class: "product-pager-inner" },
          h("button", { class: "btn quiet", disabled: pagination.page <= 1, onclick: () => { productPage = 1; reload(); } }, "« Первая"),
          h("button", { class: "btn quiet", disabled: pagination.page <= 1, onclick: () => { productPage = Math.max(1, pagination.page - 1); reload(); } }, "← Назад"),
          h("span", { class: "product-pager-current" }, `Страница ${pagination.page} из ${pagination.total_pages} · ${pagination.total} товаров`),
          h("label", { class: "product-pager-size" }, "Показывать", h("select", { onchange: (event) => { productPageSize = Number(event.target.value); productPage = 1; reload(); } }, ...[25,50,100].map((value) => h("option", { value: String(value), selected: value === productPageSize }, `${value}`)))),
          h("button", { class: "btn quiet", disabled: pagination.page >= pagination.total_pages, onclick: () => { productPage = Math.min(pagination.total_pages, pagination.page + 1); reload(); } }, "Далее →"),
          h("button", { class: "btn quiet", disabled: pagination.page >= pagination.total_pages, onclick: () => { productPage = pagination.total_pages; reload(); } }, "Последняя »")
        );
        pagerTop.replaceChildren(controls());
        pager.replaceChildren(controls());
      };
      let searchTimer;
      search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { productQuery = search.value.trim(); productPage = 1; reload({ preserveProductSearch: true }); }, 250); });
      categoryFilter.addEventListener("change", () => { productCategoryId = categoryFilter.value; productPage = 1; reload(); });
      statusFilter.addEventListener("change", () => { productStatus = statusFilter.value; productPage = 1; reload(); });
      renderProductRows();
      body.append(filterRow, bulkBar, filterCount, pagerTop, h("div", { class: "table-wrap" }, productTable), pager, h("p", { class: "muted" }, `Показано только ${productPageSize} товаров за запрос. Отметьте товары галочками и примените массовое действие. Поиск и фильтры применяются на сервере.`));
    } else if (tab === "seo") {
      api("/store/seo-report").then((report)=>{
        const products=report.products || [];
        const summary = h("div", { class:"seo-summary" },
          h("strong", {}, `${report.needs_attention || 0} из ${report.total || 0} карточек требуют внимания`),
          h("p", { class:"muted" }, report.score_basis || "Оценка отражает полноту редакционных и технических полей, а не позиции в поиске."),
          h("div", { class:"seo-report-stats" },
            ...[[report.published || 0,"Опубликовано"],[report.indexable || 0,"Открыто к индексации"],[report.missing_h1 || 0,"Без H1"],[report.missing_images || 0,"Без изображений"]].map(([value,label])=>h("div",{class:"seo-report-stat"},h("strong",{},String(value)),h("span",{},label)))
          )
        );
        const header = h("thead", {}, h("tr", {}, ...["Товар","SEO-оценка","Замечания","Запросы","Действия"].map((x)=>h("th",{},x))));
        const rows = products.map((p)=>h("tr", {},
          h("td", {}, h("strong",{},p.name), h("small",{},p.slug)),
          h("td", {}, h("div",{class:"seo-score"},h("strong",{},`${p.score}/100`),h("span",{class:"seo-score-track"},h("i",{style:{width:`${p.score}%`}})))),
          h("td", {}, p.issues.length ? p.issues.map((i)=>i.label).join(" · ") : "Критичных замечаний нет"),
          h("td", {}, (()=>{const counts={high:0,medium:0,low:0,unknown:0};for(const k of (p.keyword_targets||[]))counts[k.frequency_class] = (counts[k.frequency_class]||0)+1;return `ВЧ ${counts.high} · СЧ ${counts.medium} · НЧ ${counts.low} · без класса ${counts.unknown}`;})()),
          h("td", {}, button("Настроить SEO",()=>editSeo(p),"btn quiet"), button("+ Запрос",()=>addKeyword(p),"btn quiet"))
        ));
        const table = h("div",{class:"table-wrap"},h("table",{class:"table"},header,h("tbody",{},...rows)));
        body.replaceChildren(summary, table);
      }).catch(e=>body.replaceChildren(h("p",{class:"muted"},e.message)));
      body.append(h("p",{class:"muted"},"Классификация ВЧ / СЧ / НЧ хранится вместе с частотностью, регионом, поисковой системой и датой проверки."));
    } else if (tab === "categories") {
      body.append(h("div", { class: "list" }, ...data.categories.map(c => {
        const parent = data.categories.find((item) => Number(item.id) === Number(c.parent_id));
        return h("div", { class: "list-row" }, h("strong", {}, `${parent ? "↳ " : ""}${c.name}`), h("span", {}, parent ? `Внутри: ${parent.name}` : "Основная категория"), h("span", {}, c.featured_product_id ? `Товар-представитель #${c.featured_product_id}` : "Представитель не выбран"), h("span", {}, c.is_active ? "Активна" : "Скрыта"), button("Изменить", () => editCategory(c), "btn quiet"));
      })));
    } else if (tab === "news") {
      body.append(h("div", { class: "list" }, ...data.news.map(n => h("div", { class: "list-row" }, h("strong", {}, n.title), h("span", {}, n.published_at || "Дата не указана"), h("span", {}, statusLabel(n.status)), button("Изменить", () => editNews(n), "btn quiet")))));
    } else if (tab === "pages") {
      body.append(h("div", { class: "list" }, ...data.pages.map(p => h("div", { class: "list-row" }, h("strong", {}, p.title), h("span", {}, `/${p.slug}`), h("span", {}, `${statusLabel(p.status)} · проверка: ${p.legal_review_status}`), button("Изменить", () => editPage(p), "btn quiet")))));
      body.append(h("p", { class: "muted" }, "Юридические тексты по умолчанию не публикуются. Публикация возможна только после подтверждения владельцем и юристом."));
    } else if (tab === "restock") {
      body.replaceChildren(h("p", { class: "muted" }, "Заявки покупателей на уведомление о поступлении товаров. Telegram-ссылки привязываются к чату после перехода пользователя в бота."));
      const renderRestockPage = (result) => {
        const rows = result.subscriptions || [];
        const pagination = result.pagination || { page: 1, total: rows.length, total_pages: 1 };
        const table = h("table", { class: "table" }, h("thead", {}, h("tr", {}, ...["Товар", "Покупатель", "E-mail", "Telegram", "Доставка", "Согласие", "Статус", "Создано", "Действия"].map((x) => h("th", {}, x)))),
          h("tbody", {}, ...rows.map((item) => h("tr", {},
            h("td", {}, h("strong", {}, item.current_product_name || item.product_name), h("small", {}, `#${item.product_id}`)),
            h("td", {}, item.customer_name || "—"), h("td", {}, item.email || "—"),
            h("td", {}, item.telegram_username ? `@${item.telegram_username}${item.telegram_chat_id ? " · подключён" : " · ожидает подключения"}` : "—"),
            h("td", {}, [`E-mail ${Number(item.email_notified) ? "✓" : "—"}`, `TG ${Number(item.telegram_notified) ? "✓" : "—"}`].join(" · ")),
            h("td", {}, item.pd_consent_at ? "Да" : "Нет"), h("td", {}, item.status), h("td", {}, item.created_at || "—"),
            h("td", {}, item.status === "active" && item.availability_status === "in_stock" ? button("Повторить уведомление", async () => {
              try { await api(`/store/restock-subscriptions/${item.id}/notify`, { method: "POST", body: {} }); toast("Повторная отправка выполнена");
                const fresh = await api(`/store/restock-subscriptions?page=${pagination.page}&page_size=50`); renderRestockPage(fresh.data || fresh);
              } catch (error) { toast(error.message); }
            }, "btn quiet") : "—")
          ))));
        const nav = h("div", { class: "pager-controls" },
          h("span", {}, `Страница ${pagination.page} из ${pagination.total_pages} · ${pagination.total} подписок`),
          h("button", { class: "btn quiet", disabled: pagination.page <= 1, onclick: async () => { try { const p = await api(`/store/restock-subscriptions?page=${pagination.page - 1}&page_size=50`); renderRestockPage(p.data || p); } catch (error) { toast(error.message); } } }, "← Назад"),
          h("button", { class: "btn quiet", disabled: pagination.page >= pagination.total_pages, onclick: async () => { try { const p = await api(`/store/restock-subscriptions?page=${pagination.page + 1}&page_size=50`); renderRestockPage(p.data || p); } catch (error) { toast(error.message); } } }, "Далее →"));
        body.replaceChildren(h("p", { class: "muted" }, "Заявки покупателей на уведомление о поступлении товаров. Для повторной отправки нужен статус «В наличии» и подключённый канал доставки."), h("div", { class: "table-wrap" }, table), nav);
      };
      api("/store/restock-subscriptions?page=1&page_size=50").then((payload) => renderRestockPage(payload.data || payload)).catch((error) => body.append(h("p", { class: "error" }, error.message)));
    } else if (tab === "settings") {
      const logo = field("URL логотипа (SVG/PNG)", data.settings.logo_url || "");
      const favicon = field("URL favicon", data.settings.favicon_url || "");
      const accent = field("Акцентный цвет", data.settings.accent_color || "#111111");
      const phone = field("Телефон", data.settings.contact_phone || "");
      const telegram = field("Telegram URL", data.settings.telegram_url || "");
      const save = button("Сохранить оформление", async () => { try { await api("/store/settings", { method: "PUT", body: { logo_url: logo.input.value, favicon_url: favicon.input.value, accent_color: accent.input.value, contact_phone: phone.input.value, telegram_url: telegram.input.value, font_heading: "Unbounded", font_body: "Inter", logo_background: "#ffffff" } }); toast("Настройки сохранены"); await reload(); } catch (e) { toast(e.message); } });
      body.append(h("div", { class: "settings-grid" }, logo.node, favicon.node, accent.node, phone.node, telegram.node, h("div", {}, save)), h("p", { class: "muted" }, "Логотип отображается в круглой области на белом фоне. Укажи прямой URL файла SVG/PNG/WebP, а не страницу фотохостинга. Favicon задаётся отдельным URL. Фирменный логотип VAPELAB уже включён в сборку. Для локального файла используйте путь /assets/brand/vapelab-logo.webp."));
    }
  }
  draw();
}
