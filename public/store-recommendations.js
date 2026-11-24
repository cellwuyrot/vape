(() => {
  const PRODUCT_KEY = "vapelab.viewed-products.v1";
  const CATEGORY_KEY = "vapelab.viewed-categories.v1";
  const readIds = (key, limit) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(value) ? [...new Set(value.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, limit) : [];
    } catch { return []; }
  };
  const writeIds = (key, ids, limit) => {
    try { localStorage.setItem(key, JSON.stringify(ids.slice(0, limit))); } catch { /* browser storage may be disabled */ }
  };
  const PAGE_CONTEXT_KEY = "vapelab.page-context.v1";
  const collectPageContext = () => {
    const meta = document.querySelector('meta[name="description"]')?.content || "";
    const heading = document.querySelector("h1")?.textContent || "";
    const current = [location.pathname, document.title, heading, meta].join(" ").replace(/\s+/g, " ").trim().slice(0, 320);
    try {
      const previous = JSON.parse(localStorage.getItem(PAGE_CONTEXT_KEY) || "[]");
      const history = Array.isArray(previous) ? previous.filter((item) => typeof item === "string" && item !== current) : [];
      const next = [current, ...history].slice(0, 8);
      localStorage.setItem(PAGE_CONTEXT_KEY, JSON.stringify(next));
      return next.join(" ").slice(0, 1600);
    } catch { return current; }
  };
  const safeImage = (value) => {
    const raw = String(value || "").trim();
    if (raw.startsWith("/uploads/") || raw.startsWith("/assets/")) return raw;
    try { const url = new URL(raw); return ["http:", "https:"].includes(url.protocol) ? url.href : ""; }
    catch { return ""; }
  };

  document.querySelectorAll("[data-recommendations]").forEach((host) => {
    const current = Number(host.dataset.productId || 0);
    const categoryIds = String(host.dataset.categoryIds || host.dataset.categoryId || "").split(",")
      .map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
    let productHistory = readIds(PRODUCT_KEY, 15);
    let categoryHistory = readIds(CATEGORY_KEY, 25);
    if (current > 0) productHistory = [current, ...productHistory.filter((id) => id !== current)].slice(0, 15);
    for (const id of categoryIds) categoryHistory = [id, ...categoryHistory.filter((value) => value !== id)].slice(0, 25);
    writeIds(PRODUCT_KEY, productHistory, 15);
    writeIds(CATEGORY_KEY, categoryHistory, 25);

    const daily = host.dataset.daily === "1" || current <= 0;
    const params = new URLSearchParams();
    if (current > 0) params.set("product_id", String(current));
    params.set("history", productHistory.join(","));
    params.set("categories", categoryHistory.join(","));
    params.set("context", collectPageContext());
    const endpoint = daily ? "/api/store/recommendations/daily" : `/api/store/recommendations?${params.toString()}`;
    fetch(endpoint, { headers: { Accept: "application/json" } })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("recommendations unavailable")))
      .then((payload) => {
        const items = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.products) ? payload.products : Array.isArray(payload?.data?.products) ? payload.data.products : [];
        const grid = host.querySelector(".seo-recommendations-grid");
        if (!grid) return;
        if (!items.length) { host.hidden = true; return; }
        const cards = items.map((item) => {
          const link = document.createElement("a");
          link.className = "seo-recommendation-card";
          link.href = `/product/${encodeURIComponent(item.slug)}`;
          const imageUrl = safeImage(item.image_url);
          if (imageUrl) {
            const image = document.createElement("img");
            image.src = imageUrl;
            image.alt = item.image_alt || item.name;
            image.loading = "lazy";
            link.append(image);
          } else {
            const placeholder = document.createElement("span");
            placeholder.className = "seo-recommendation-placeholder";
            placeholder.textContent = String(item.brand || item.name || "V").slice(0, 2).toUpperCase();
            link.append(placeholder);
          }
          const name = document.createElement("strong");
          name.textContent = item.name;
          const meta = document.createElement("small");
          meta.textContent = [item.brand, item.product_type].filter(Boolean).join(" · ") || "VAPELAB";
          link.append(name, meta);
          return link;
        });
        grid.replaceChildren(...cards);
      })
      .catch(() => { const grid = host.querySelector(".seo-recommendations-grid"); if (grid) grid.replaceChildren(); });
  });
})();
