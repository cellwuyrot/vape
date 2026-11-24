const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));
const safeUrl = (value = "") => {
  const raw = String(value || "").trim();
  if (/^https?:\/\//i.test(raw) || raw.startsWith("/")) return raw;
  return "";
};

let store = { categories: [], products: [], news: [], pages: [], settings: {} };

function rootCategories() {
  return store.categories.filter((category) => !category.parent_id);
}

function applySettings() {
  const settings = store.settings || {};
  const logoUrl = safeUrl(settings.logo_url);
  for (const id of ["brand-logo", "hero-logo"]) {
    const logo = $(`#${id}`);
    if (!logo) continue;
    if (logoUrl) {
      logo.src = logoUrl;
      logo.hidden = false;
      logo.addEventListener("error", () => { logo.hidden = true; }, { once: true });
    }
  }
  if (settings.brand_name) document.title = `${settings.brand_name} — каталог и информация о компании`;
  const faviconUrl = safeUrl(settings.favicon_url);
  if (faviconUrl) {
    const icon = $("link[rel='icon']");
    if (icon) icon.href = faviconUrl;
  }
  if (settings.contact_phone) {
    const phone = $("#phone");
    phone.textContent = settings.contact_phone;
    phone.href = `tel:${settings.contact_phone.replace(/[^+\d]/g, "")}`;
  }
  if (settings.telegram_url) {
    const telegram = $("#telegram");
    telegram.href = settings.telegram_url;
    const username = settings.telegram_url.match(/t\.me\/([^/?#]+)/i)?.[1];
    if (username) telegram.textContent = `@${username} ↗`;
  }
}

function newsCard(item) {
  const date = item.published_at ? new Date(item.published_at) : null;
  const dateLabel = date && !Number.isNaN(date.valueOf())
    ? new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(date)
    : "Дата не указана";
  const localUrl = item.slug ? `/news/${encodeURIComponent(item.slug)}` : "";
  const sourceUrl = safeUrl(item.source_url);
  const imageUrl = safeUrl(item.image_url);
  const visual = imageUrl
    ? `<div class="news-card-visual news-card-visual-image"><img src="${esc(imageUrl)}" alt="" loading="lazy" decoding="async" /></div>`
    : `<div class="news-card-visual" aria-hidden="true"><span class="news-card-logo">V</span><i></i><b>VAPELAB</b></div>`;
  return `<article class="news-card reveal-on-scroll">
    ${visual}
    <div class="news-card-content">
      <time>${esc(dateLabel)}</time>
      <h3>${esc(item.title || "Публикация VAPELAB")}</h3>
      <p>${esc(item.excerpt || "Материал из публичной новостной ленты компании.")}</p>
      <div class="news-card-links">${localUrl ? `<a href="${esc(localUrl)}">Открыть публикацию <span>↗</span></a>` : ""}${sourceUrl ? `<a class="news-source-link" href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">Источник</a>` : ""}</div>
    </div>
  </article>`;
}

function renderNews() {
  const host = $("#news-list");
  if (!host) return;
  const items = (store.news || []).slice(0, 3);
  host.innerHTML = items.length
    ? items.map(newsCard).join("")
    : `<p class="news-empty">В публичной выборке новости не найдены.</p>`;
  observeReveal(host);
}

function observeReveal(host = document) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  if (!("IntersectionObserver" in window)) return;
  const nodes = host.querySelectorAll(".reveal-on-scroll:not([data-reveal-bound])");
  if (!nodes.length) return;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.12, rootMargin: "0px 0px -30px 0px" });
  nodes.forEach((node) => {
    node.dataset.revealBound = "1";
    node.classList.add("reveal-pending");
    observer.observe(node);
  });
}

function initMobileMenu() {
  const button = $("#menu-toggle");
  const menu = $("#mobile-nav");
  if (!button || !menu) return;
  button.addEventListener("click", () => {
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    button.setAttribute("aria-expanded", String(willOpen));
    button.setAttribute("aria-label", willOpen ? "Закрыть меню" : "Открыть меню");
  });
  menu.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", "Открыть меню");
  }));
}

async function boot() {
  const year = $("#year");
  if (year) year.textContent = new Date().getFullYear();
  initMobileMenu();
  try {
    const response = await fetch("/api/store/public", { headers: { Accept: "application/json" } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || "Не удалось загрузить данные витрины");
    store = payload.data || payload;
    applySettings();
    const categoryCount = rootCategories().length;
    const productCount = Array.isArray(store.products) ? store.products.length : 0;
    ["hero-category-count", "catalog-category-count"].forEach((id) => {
      const node = $(`#${id}`);
      if (node) node.textContent = String(categoryCount || 18);
    });
    const productNode = $("#hero-product-count");
    if (productNode) productNode.textContent = String(productCount);
    renderNews();
  } catch (error) {
    console.error("VAPELAB storefront:", error);
    const host = $("#news-list");
    if (host) host.innerHTML = `<p class="news-empty">Не удалось загрузить публикации. Основные разделы каталога доступны по ссылкам выше.</p>`;
  }
  observeReveal(document);
}

boot();
