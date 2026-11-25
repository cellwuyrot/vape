(() => {
  "use strict";

  const SEARCH_SELECTOR = ".vapelab-header-search";
  const CHAT_TOKEN_KEY = "vapelab.webchat.token.v1";
  const esc = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const safeImage = (value = "") => /^(https:\/\/|\/assets\/|\/uploads\/)/i.test(String(value || "")) ? String(value) : "";

  function installSearch() {
    if (document.querySelector(SEARCH_SELECTOR)) return true;
    const host = document.querySelector(".header-inner");
    if (!host) return false;
    const search = document.createElement("div");
    search.className = "vapelab-header-search";
    search.innerHTML = `
      <form class="vapelab-search-form" role="search" autocomplete="off">
        <span class="vapelab-search-icon" aria-hidden="true"></span>
        <input class="vapelab-search-input" type="search" aria-expanded="false" aria-controls="vapelab-quick-results" name="q" placeholder="Найти товар, бренд или артикул" aria-label="Поиск товаров" minlength="2" maxlength="120" autocomplete="off" />
        <button type="submit" aria-label="Искать">Найти</button>
      </form>
      <div id="vapelab-quick-results" class="vapelab-search-results" role="region" aria-label="Подсказки поиска" aria-live="polite" hidden></div>`;
    const login = host.querySelector(".login-link");
    const menu = host.querySelector(".menu-toggle");
    host.insertBefore(search, login || menu || null);

    const form = search.querySelector("form");
    const input = search.querySelector("input");
    const results = search.querySelector(".vapelab-search-results");
    let timer = 0;
    let activeRequest = null;
    let lastQuery = "";

    const hide = () => { results.hidden = true; results.innerHTML = ""; input.setAttribute("aria-expanded", "false"); };
    const showMessage = (message) => {
      results.innerHTML = `<p class="vapelab-search-message">${esc(message)}</p>`;
      results.hidden = false;
      input.setAttribute("aria-expanded", "true");
    };
    const render = (data) => {
      const items = Array.isArray(data?.results) ? data.results.slice(0, 5) : [];
      const categories = Array.isArray(data?.category_results) ? data.category_results.slice(0, 4) : [];
      if (!items.length && !categories.length) { showMessage("По вашему запросу ничего не найдено."); return; }
      const categoryLinks = categories.map((item) => `<a class="vapelab-search-category" href="/${encodeURIComponent(item.slug)}">${esc(item.name)} <span>Категория ↗</span></a>`).join("");
      const productLinks = items.map((item) => {
        const image = safeImage(item.image_url);
        const price = String(item.price_raw || "").trim();
        return `<a class="vapelab-search-result" href="/product/${encodeURIComponent(item.slug)}">
          ${image ? `<img src="${esc(image)}" alt="" loading="lazy">` : `<span class="vapelab-search-result-placeholder">${esc(String(item.brand || item.name || "V").slice(0, 2))}</span>`}
          <span class="vapelab-search-result-copy"><strong>${esc(item.name)}</strong><small>${esc([item.brand, item.product_type, item.categories?.slice(0, 2).join(" · ")].filter(Boolean).join(" · "))}</small></span>
          ${price && !/^(?:не\s+указан[ао]?|нет\s+данных|n\/?a|[-—–])$/i.test(price) ? `<span class="vapelab-search-result-price">${esc(price)}</span>` : ""}
        </a>`;
      }).join("");
      const all = `/search?q=${encodeURIComponent(input.value.trim())}`;
      results.innerHTML = `${categories.length ? `<div class="vapelab-search-summary">Категории</div>${categoryLinks}` : ""}${items.length ? `<div class="vapelab-search-summary">Товары · ${Number(data.total) || items.length}</div>${productLinks}` : ""}<a class="vapelab-search-all" href="${all}">Все результаты поиска ↗</a>`;
      results.hidden = false;
      input.setAttribute("aria-expanded", "true");
    };

    const runSearch = async () => {
      const query = input.value.trim();
      if (query.length < 2) { hide(); return; }
      if (query === lastQuery && !results.hidden) return;
      lastQuery = query;
      activeRequest?.abort();
      activeRequest = new AbortController();
      showMessage("Ищем товары…");
      try {
        const response = await fetch(`/api/store/search?q=${encodeURIComponent(query)}`, {
          headers: { Accept: "application/json" }, signal: activeRequest.signal,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.detail || "Поиск временно недоступен");
        if (query !== input.value.trim()) return;
        render(payload.data || payload);
      } catch (error) {
        if (error.name !== "AbortError") showMessage(error.message || "Не удалось выполнить поиск.");
      }
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      lastQuery = "";
      if (input.value.trim().length < 2) { hide(); return; }
      timer = setTimeout(runSearch, 400);
    });
    input.addEventListener("focus", () => { if (input.value.trim().length >= 2) runSearch(); });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const query = input.value.trim();
      if (query.length >= 2) window.location.href = `/search?q=${encodeURIComponent(query)}`;
    });
    if (window.location.pathname === "/search") {
      const params = new URLSearchParams(window.location.search);
      input.value = params.get("q") || "";
    }
    document.addEventListener("pointerdown", (event) => { if (!search.contains(event.target)) hide(); });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") hide();
      if (event.key === "ArrowDown" && !results.hidden) { const first = results.querySelector("a"); if (first) { event.preventDefault(); first.focus(); } }
    });
    results.addEventListener("keydown", (event) => { if (event.key === "Escape") { hide(); input.focus(); } });
    return true;
  }

  function installSearchResultsPage() {
    const root = document.querySelector("#vapelab-search-page");
    if (!root || root.dataset.initialized === "1") return;
    root.dataset.initialized = "1";
    const params = new URLSearchParams(window.location.search);
    const query = String(root.dataset.query || params.get("q") || "").trim().slice(0, 120);
    const summary = root.querySelector(".vapelab-search-page-summary");
    const results = root.querySelector(".vapelab-search-page-results");
    const pagination = root.querySelector(".vapelab-search-page-pagination");
    const categoryResults = root.querySelector(".vapelab-search-page-categories");
    const categoryId = String(root.dataset.categoryId || "");
    const page = Math.max(1, Number(root.dataset.page || params.get("page") || 1) || 1);
    if (query.length < 2) return;

    const load = async () => {
      try {
        const response = await fetch(`/api/store/search?q=${encodeURIComponent(query)}&page=${page}&page_size=24${categoryId ? `&category_id=${encodeURIComponent(categoryId)}` : ""}`, { headers: { Accept: "application/json" } });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.detail || "Поиск временно недоступен");
        const data = payload.data || payload;
        const items = Array.isArray(data.results) ? data.results : [];
        const foundCategories = Array.isArray(data.category_results) ? data.category_results : [];
        if (categoryResults) categoryResults.innerHTML = foundCategories.length ? `<h2>Категории</h2><div>${foundCategories.map((c) => `<a href="/${encodeURIComponent(c.slug)}">${esc(c.name)} ↗</a>`).join("")}</div>` : "";
        summary.textContent = `Найдено товаров: ${Number(data.total) || 0}. Страница ${data.page || 1} из ${data.total_pages || 1}.`;
        results.innerHTML = items.length ? items.map((item) => {
          const image = safeImage(item.image_url);
          const price = String(item.price_raw || "").trim();
          const hasPrice = price && !/^(?:не\s+указан[ао]?|нет\s+данных|n\/?a|[-—–])$/i.test(price);
          const meta = [item.brand, item.product_type, item.categories?.slice(0, 2).join(" · "), item.sku ? `Арт. ${item.sku}` : ""].filter(Boolean).join(" · ");
          return `<a class="vapelab-search-page-card" href="/product/${encodeURIComponent(item.slug)}">${image ? `<img src="${esc(image)}" alt="" loading="lazy" decoding="async">` : `<span class="vapelab-search-page-placeholder">${esc(String(item.brand || item.name || "V").slice(0, 2))}</span>`}<span class="vapelab-search-page-card-copy"><strong>${esc(item.name)}</strong><small>${esc(meta)}</small>${hasPrice ? `<b>${esc(price)}</b>` : ""}${item.is_18_plus ? `<em>18+</em>` : ""}</span></a>`;
        }).join("") : `<p class="vapelab-search-page-empty">По этому запросу опубликованные товары не найдены. Попробуйте изменить формулировку.</p>`;
        const current = Number(data.page) || 1;
        const totalPages = Number(data.total_pages) || 1;
        if (totalPages > 1) {
          const makeLink = (target, label, extra = "") => `<a class="vapelab-search-page-page ${extra}" href="/search?q=${encodeURIComponent(query)}${categoryId ? `&category_id=${encodeURIComponent(categoryId)}` : ""}&page=${target}" ${target === current ? 'aria-current="page"' : ""}>${label}</a>`;
          const pages = new Set([1, totalPages, current - 1, current, current + 1].filter((number) => number >= 1 && number <= totalPages));
          const ordered = [...pages].sort((a, b) => a - b);
          let links = "";
          let previous = 0;
          for (const number of ordered) {
            if (previous && number - previous > 1) links += `<span class="vapelab-search-page-gap">…</span>`;
            links += makeLink(number, String(number), number === current ? "is-current" : "");
            previous = number;
          }
          pagination.innerHTML = `${current > 1 ? makeLink(current - 1, "Назад", "is-prev") : ""}${links}${current < totalPages ? makeLink(current + 1, "Далее", "is-next") : ""}`;
        } else pagination.innerHTML = "";
      } catch (error) {
        summary.textContent = error.message || "Не удалось выполнить поиск.";
        results.innerHTML = "";
        pagination.innerHTML = "";
      }
    };
    load();
  }

  function installChat() {
    if (document.querySelector(".vapelab-chat-launch")) return;
    const mount = document.createElement("div");
    mount.className = "vapelab-chat-root";
    mount.innerHTML = `
      <button class="vapelab-chat-launch" type="button" aria-label="Написать администрации VAPELAB" aria-expanded="false">
        <span class="vapelab-chat-launch-icon" aria-hidden="true">✉</span><span>Связаться с нами</span>
      </button>
      <section class="vapelab-chat-panel" aria-label="Чат с администрацией VAPELAB" hidden>
        <header class="vapelab-chat-head"><div><strong>VAPELAB</strong><small>Общение с администрацией</small></div><button class="vapelab-chat-close" type="button" aria-label="Закрыть чат">×</button></header>
        <div class="vapelab-chat-messages" role="log" aria-live="polite"><p class="vapelab-chat-welcome">Здравствуйте! Напишите нам — сообщение попадёт в диалоги администрации.</p></div>
        <form class="vapelab-chat-form">
          <div class="vapelab-chat-first-contact">
            <label>Как к вам обращаться<input name="customer_name" maxlength="160" autocomplete="name" placeholder="Имя (необязательно)"></label>
            <div class="vapelab-chat-contact-grid"><label>Телефон<input name="phone" maxlength="80" autocomplete="tel" placeholder="Телефон"></label><label>E-mail<input name="email" type="email" maxlength="240" autocomplete="email" placeholder="E-mail"></label></div>
            <label class="vapelab-chat-consent"><input type="checkbox" name="pd_consent"><span>Согласен(на) на обработку персональных данных согласно <a href="/page/privacy" target="_blank" rel="noopener">политике конфиденциальности</a>.</span></label>
          </div>
          <label class="vapelab-chat-message-label"><span class="sr-only">Сообщение</span><textarea name="message" rows="2" maxlength="4000" required placeholder="Введите сообщение…"></textarea></label>
          <div class="vapelab-chat-form-bottom"><small class="vapelab-chat-status" role="status" aria-live="polite"></small><button type="submit">Отправить</button></div>
        </form>
      </section>`;
    document.body.append(mount);

    const launch = mount.querySelector(".vapelab-chat-launch");
    const panel = mount.querySelector(".vapelab-chat-panel");
    const close = mount.querySelector(".vapelab-chat-close");
    const messageList = mount.querySelector(".vapelab-chat-messages");
    const form = mount.querySelector(".vapelab-chat-form");
    const firstContact = mount.querySelector(".vapelab-chat-first-contact");
    const messageInput = form.elements.message;
    const status = mount.querySelector(".vapelab-chat-status");
    let chatToken = localStorage.getItem(CHAT_TOKEN_KEY) || "";
    let lastMessageId = 0;
    let pollTimer = 0;
    let sending = false;

    const setOpen = (open) => {
      panel.hidden = !open;
      launch.setAttribute("aria-expanded", String(open));
      launch.classList.toggle("is-open", open);
      if (open) {
        messageInput.focus();
        loadMessages();
        schedulePoll();
      } else clearTimeout(pollTimer);
    };
    const appendMessages = (items = []) => {
      if (items.length) messageList.querySelector(".vapelab-chat-welcome")?.remove();
      for (const item of items) {
        if (!item || Number(item.id) <= lastMessageId) continue;
        const row = document.createElement("div");
        row.className = `vapelab-chat-message ${item.direction === "outbound" ? "outbound" : "inbound"}`;
        const bubble = document.createElement("div");
        bubble.className = "vapelab-chat-bubble";
        bubble.textContent = String(item.body || "");
        const time = document.createElement("small");
        const date = new Date(item.created_at);
        time.textContent = Number.isNaN(date.valueOf()) ? "" : date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
        row.append(bubble, time);
        messageList.append(row);
        lastMessageId = Number(item.id);
      }
      if (items.length) messageList.scrollTop = messageList.scrollHeight;
    };
    const authHeaders = () => {
      const headers = { Accept: "application/json" };
      const accessToken = localStorage.getItem("rucrm.token");
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      return headers;
    };
    const loadMessages = async () => {
      if (!chatToken) return;
      try {
        const headers = { ...authHeaders(), "X-Webchat-Token": chatToken };
        const response = await fetch(`/api/webchat/messages?since=${lastMessageId}`, { headers });
        const payload = await response.json().catch(() => ({}));
        if (response.status === 401 || response.status === 404) {
          localStorage.removeItem(CHAT_TOKEN_KEY);
          chatToken = "";
          lastMessageId = 0;
          firstContact.hidden = false;
          return;
        }
        if (!response.ok) throw new Error(payload.detail || "Не удалось загрузить сообщения");
        appendMessages((payload.data || payload).messages || []);
        if (firstContact) firstContact.hidden = true;
        if (status) status.textContent = "";
      } catch (error) { if (status) status.textContent = error.message; }
    };
    function schedulePoll() {
      clearTimeout(pollTimer);
      if (panel.hidden) return;
      pollTimer = setTimeout(async () => { await loadMessages(); schedulePoll(); }, 5000);
    }

    launch.addEventListener("click", () => setOpen(panel.hidden));
    close.addEventListener("click", () => setOpen(false));
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !panel.hidden) setOpen(false); });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (sending) return;
      const message = String(messageInput.value || "").trim();
      if (message.length < 2) { status.textContent = "Введите сообщение."; return; }
      const consent = form.elements.pd_consent.checked;
      if (!chatToken && !consent && !localStorage.getItem("rucrm.token")) {
        status.textContent = "Подтвердите согласие на обработку персональных данных.";
        form.elements.pd_consent.focus();
        return;
      }
      sending = true;
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      status.textContent = "Отправляем…";
      try {
        const headers = { ...authHeaders(), "Content-Type": "application/json", Accept: "application/json" };
        if (chatToken) headers["X-Webchat-Token"] = chatToken;
        const response = await fetch("/api/webchat/messages", {
          method: "POST", headers,
          body: JSON.stringify({
            message,
            customer_name: form.elements.customer_name.value,
            phone: form.elements.phone.value,
            email: form.elements.email.value,
            pd_consent: consent,
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (response.status === 401 && chatToken) {
          localStorage.removeItem(CHAT_TOKEN_KEY);
          chatToken = "";
          lastMessageId = 0;
          firstContact.hidden = false;
        }
        if (!response.ok) throw new Error(payload.detail || "Не удалось отправить сообщение");
        const data = payload.data || payload;
        if (data.chat_token) { chatToken = data.chat_token; localStorage.setItem(CHAT_TOKEN_KEY, chatToken); }
        messageInput.value = "";
        form.elements.pd_consent.checked = false;
        appendMessages(data.message ? [data.message] : []);
        firstContact.hidden = true;
        status.textContent = "Сообщение отправлено. Ответ появится в этом чате.";
        await loadMessages();
      } catch (error) { status.textContent = error.message; }
      finally { sending = false; button.disabled = false; }
    });

    if (chatToken) {
      firstContact.hidden = true;
      loadMessages().finally(() => { if (!panel.hidden) schedulePoll(); });
    }
  }

  function init() {
    installSearch();
    installSearchResultsPage();
    installChat();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
  const observer = new MutationObserver(() => { if (installSearch()) observer.disconnect(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("pageshow", init);
})();
