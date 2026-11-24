/** Минимальный слой представления: DOM-хелперы, клиент API, форматирование.
 *  Ни фреймворка, ни сборщика — браузер исполняет эти модули напрямую. */

/* ---------- DOM ---------- */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "html") el.innerHTML = value;
    else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "value") el.value = value;
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  children.flat(4).filter(Boolean).forEach((c) => f.append(c instanceof Node ? c : document.createTextNode(String(c))));
  return f;
};

export const mount = (host, ...nodes) => {
  host.replaceChildren();
  host.append(frag(...nodes));
  return host;
};

/* ---------- API ---------- */
const TOKEN_KEY = "rucrm.token";
export const token = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (v) => (v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY)),
};

/** Загрузка файла: тело сырое, имя уходит заголовком — так проще и на сервере. */
export async function upload(path, file, extraHeaders = {}) {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
      ...(token.get() ? { Authorization: `Bearer ${token.get()}` } : {}),
      ...extraHeaders,
    },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || "Не удалось загрузить файл");
  return data;
}

export async function api(path, { method = "GET", body, signal } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    signal,
    headers: {
      "Content-Type": "application/json",
      ...(token.get() ? { Authorization: `Bearer ${token.get()}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token.get()) {
      token.set(null);
      location.hash = "#/login";
    }
    throw new Error(data.detail || "Не удалось выполнить запрос");
  }
  return data;
}

/* ---------- Форматирование ---------- */
export const money = (v) =>
  new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(Number(v) || 0);

export const num = (v) => new Intl.NumberFormat("ru-RU").format(Number(v) || 0);

const asDate = (v) => new Date(String(v).includes("T") ? v : `${String(v).replace(" ", "T")}Z`);

export const when = (v) => {
  const d = asDate(v);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "только что";
  if (diff < 3600) return `${Math.floor(diff / 60)} мин`;
  if (d.toDateString() === new Date().toDateString())
    return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
};

/** Срок задачи человеческим языком: «сегодня 15:00», «просрочено на 2 дня». */
export const dueLabel = (value) => {
  if (!value) return "без срока";
  const date = asDate(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `сегодня ${time}`;
  const tomorrow = new Date(today.getTime() + 86400000);
  if (date.toDateString() === tomorrow.toDateString()) return `завтра ${time}`;
  return `${date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })} ${time}`;
};

export const isOverdue = (value) => Boolean(value) && asDate(value).getTime() < Date.now();

/** Значение для input[type=datetime-local] — он не понимает ISO с зоной. */
export const forInput = (date) => {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const clock = (v) => asDate(v).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
export const dayLabel = (v) => asDate(v).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
export const initials = (name = "") =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() || "").join("") || "?";

/* ---------- Справочники ---------- */
export const CHANNELS = {
  telegram: "Telegram", whatsapp: "WhatsApp", max: "MAX",
  avito: "Avito", email: "E-mail", webform: "Форма на сайте", webchat: "Чат сайта",
};
export const TASK_KINDS = {
  call: "Звонок", meeting: "Встреча", email: "Письмо", message: "Сообщение", todo: "Задача",
};
export const TASK_PRIORITIES = { low: "Низкий", normal: "Обычный", high: "Высокий" };
export const DOC_KINDS = {
  quote: "Коммерческое предложение", invoice: "Счёт на оплату",
  contract: "Договор", act: "Акт выполненных работ",
};
export const ACTIVITY_GLYPHS = {
  stage: "⊞", task: "✓", task_done: "✓", call: "☎", note: "✎", order: "▤",
  document: "▦", merge: "⇋", import: "↥", deal: "⊞", message_in: "←", message_out: "→",
};

export const ORDER_STATUSES = {
  draft: "Черновик", confirmed: "Подтверждён", paid: "Оплачен",
  shipped: "Отгружен", done: "Завершён", canceled: "Отменён",
};

/* ---------- Уведомления и оверлеи ---------- */
export function toast(text) {
  const node = h("div", { class: "toast" }, text);
  document.getElementById("toasts").append(node);
  setTimeout(() => {
    node.style.transition = "opacity 200ms ease";
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 220);
  }, 2600);
}

export function overlay(node, { placement = "center" } = {}) {
  const host = document.getElementById("overlay");
  const scrim = h("div", { class: `scrim ${placement}`, onclick: (e) => { if (e.target === scrim) close(); } }, node);
  const close = () => { host.replaceChildren(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  host.replaceChildren(scrim);
  return close;
}

export function sheet(title, content, { onClose } = {}) {
  let close = () => {};
  const body = typeof content === "function" ? content(() => close()) : content;
  const node = h("div", { class: "sheet" },
    h("header", {},
      h("h3", {}, title),
      h("div", { class: "spacer", style: { flex: 1 } }),
      h("button", { class: "btn quiet", onclick: () => close() }, "Esc")
    ),
    body
  );
  close = overlay(node);
  const wrapped = () => { close(); onClose?.(); };
  return wrapped;
}

/* ---------- Прочее ---------- */
export const debounce = (fn, ms = 260) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

export const field = (label, input) => h("div", { class: "field" }, h("label", {}, label), input);

export const empty = (text) => h("div", { class: "empty" }, text);
