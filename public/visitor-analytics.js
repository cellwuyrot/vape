(() => {
  const CONSENT = "vpl_cookie_consent";
  const VISITOR = "vpl_visitor_id";
  const SESSION = "vpl_session_id";
  const readCookie = (name) => {
    const raw = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || "";
    try { return decodeURIComponent(raw); } catch { return ""; }
  };
  const secure = location.protocol === "https:" ? "; Secure" : "";
  const setCookie = (name, value, days = 180) => {
    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${days * 86400}; SameSite=Lax${secure}`;
  };
  const makeId = () => {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, "");
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  };
  let choice = readCookie(CONSENT);
  let visitorId = "";
  let sessionId = "";

  function identity() {
    visitorId = readCookie(VISITOR);
    if (!visitorId) { visitorId = makeId(); setCookie(VISITOR, visitorId); }
    try {
      sessionId = sessionStorage.getItem(SESSION) || makeId();
      sessionStorage.setItem(SESSION, sessionId);
    } catch { sessionId = makeId(); }
  }

  function send(eventType, details = {}) {
    if (choice !== "accepted") return;
    if (!visitorId || !sessionId) identity();
    const payload = {
      visitor_id: visitorId,
      session_id: sessionId,
      event_type: eventType,
      path: `${location.pathname}${location.hash ? location.hash.slice(0, 120) : ""}`,
      page_title: document.title.slice(0, 180),
      referrer: document.referrer,
      target_tag: String(details.target_tag || "").slice(0, 20),
      target_text: String(details.target_text || "").replace(/\s+/g, " ").trim().slice(0, 120),
      target_path: String(details.target_path || "").slice(0, 400),
    };
    fetch("/api/analytics/event", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), keepalive: true }).catch(() => {});
  }

  function setChoice(next) {
    choice = next;
    setCookie(CONSENT, next);
    if (next !== "accepted") {
      document.cookie = `${VISITOR}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
      try { sessionStorage.removeItem(SESSION); } catch {}
      visitorId = ""; sessionId = "";
    } else {
      identity();
      send("page_view");
    }
    document.querySelector("[data-cookie-banner]")?.remove();
    document.dispatchEvent(new CustomEvent("vpl:cookie-consent", { detail: { choice: next } }));
  }

  function showBanner() {
    if (document.querySelector("[data-cookie-banner]")) return;
    const banner = document.createElement("aside");
    banner.className = "cookie-consent-banner";
    banner.dataset.cookieBanner = "1";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-label", "Настройки cookie");
    banner.innerHTML = `<div class="cookie-consent-copy"><strong>Настройки cookie</strong><p>Необходимые cookie обеспечивают работу сайта. Аналитика включается только по вашему выбору.</p></div><div class="cookie-consent-actions"><button type="button" data-cookie-necessary>Только необходимые</button><button type="button" class="is-primary" data-cookie-accept>Принять аналитику</button></div>`;
    document.body.append(banner);
    banner.querySelector("[data-cookie-necessary]").addEventListener("click", () => setChoice("necessary"));
    banner.querySelector("[data-cookie-accept]").addEventListener("click", () => setChoice("accepted"));
  }

  function settings() {
    const current = choice || "не выбрано";
    const box = document.createElement("div");
    box.className = "cookie-settings-dialog";
    box.innerHTML = `<div class="cookie-settings-backdrop" data-cookie-close></div><section role="dialog" aria-modal="true" aria-labelledby="cookie-settings-title"><button type="button" class="cookie-settings-close" data-cookie-close aria-label="Закрыть">×</button><h2 id="cookie-settings-title">Настройки cookie</h2><p>Необходимые cookie сохраняют работу основных функций. Аналитические cookie помогают считать посещения и клики без записи IP-адреса или данных из полей форм.</p><p class="cookie-settings-current">Текущий выбор: ${current === "accepted" ? "аналитика разрешена" : current === "necessary" ? "только необходимые" : "не выбрано"}</p><div class="cookie-consent-actions"><button type="button" data-cookie-necessary>Только необходимые</button><button type="button" class="is-primary" data-cookie-accept>Разрешить аналитику</button></div></section>`;
    document.body.append(box);
    box.querySelectorAll("[data-cookie-close]").forEach((element) => element.addEventListener("click", () => box.remove()));
    box.querySelector("[data-cookie-necessary]").addEventListener("click", () => { setChoice("necessary"); box.remove(); });
    box.querySelector("[data-cookie-accept]").addEventListener("click", () => { setChoice("accepted"); box.remove(); });
  }

  document.addEventListener("click", (event) => {
    const settingsButton = event.target.closest("[data-cookie-settings]");
    if (settingsButton) { event.preventDefault(); settings(); return; }
    const target = event.target.closest("a,button,[data-track]");
    if (!target || target.closest("[data-analytics-ignore]") || target.closest("form") || target.matches("input,textarea,select")) return;
    const text = String(target.innerText || target.getAttribute("aria-label") || target.title || "").replace(/\s+/g, " ").trim();
    let targetPath = "";
    const href = target.getAttribute("href");
    if (href) {
      try { const url = new URL(href, location.href); if (url.origin === location.origin) targetPath = `${url.pathname}${url.hash}`.slice(0, 400); } catch {}
    }
    send("click", { target_tag: target.tagName.toLowerCase(), target_text: text, target_path: targetPath });
  }, true);

  window.VAPELABAnalytics = { track: (eventType, details) => send(eventType, details), openSettings: settings };
  if (choice === "accepted") { identity(); send("page_view"); }
  else if (choice !== "necessary") showBanner();
  window.addEventListener("hashchange", () => send("page_view"));
})();
