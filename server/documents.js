/**
 * Печатные формы: коммерческое предложение, счёт, договор, акт.
 *
 * Шаблон — обычный HTML с подстановками {{путь.к.полю}} и повторяющимися
 * блоками {{#items}}…{{/items}}. Готовый документ отдаётся браузеру и печатается
 * штатным «Печать → Сохранить в PDF»: так кириллица остаётся кириллицей,
 * а обещание нулевых зависимостей — обещанием. Шаблоны правятся в настройках,
 * не в коде: у каждой компании свой бланк.
 */
import { config } from "./config.js";
import { db, repo } from "./db.js";
import { HttpError } from "./http.js";

export const DOC_KINDS = {
  quote: "Коммерческое предложение",
  invoice: "Счёт на оплату",
  contract: "Договор",
  act: "Акт выполненных работ",
};

/* ------------------------------------------------------------------ */
/*  Форматирование                                                     */
/* ------------------------------------------------------------------ */

export const money = (value) =>
  new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value) || 0);

const ONES = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const ONES_F = ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const TEENS = ["десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"];
const TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
const HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];

const plural = (n, forms) => {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
};

function tripletToWords(value, feminine) {
  const words = [];
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  if (hundreds) words.push(HUNDREDS[hundreds]);
  if (rest >= 10 && rest < 20) words.push(TEENS[rest - 10]);
  else {
    const tens = Math.floor(rest / 10);
    const ones = rest % 10;
    if (tens) words.push(TENS[tens]);
    if (ones) words.push((feminine ? ONES_F : ONES)[ones]);
  }
  return words.filter(Boolean).join(" ");
}

/** Сумма прописью — обязательный реквизит счёта и акта. */
export function amountInWords(amount) {
  const total = Math.round((Number(amount) || 0) * 100);
  const rubles = Math.floor(total / 100);
  const kopecks = total % 100;

  if (rubles === 0) return `Ноль рублей ${String(kopecks).padStart(2, "0")} копеек`;

  const groups = [
    { value: Math.floor(rubles / 1_000_000_000) % 1000, feminine: false, forms: ["миллиард", "миллиарда", "миллиардов"] },
    { value: Math.floor(rubles / 1_000_000) % 1000, feminine: false, forms: ["миллион", "миллиона", "миллионов"] },
    { value: Math.floor(rubles / 1000) % 1000, feminine: true, forms: ["тысяча", "тысячи", "тысяч"] },
    { value: rubles % 1000, feminine: false, forms: null },
  ];

  const parts = [];
  for (const group of groups) {
    if (!group.value) continue;
    parts.push(tripletToWords(group.value, group.feminine));
    if (group.forms) parts.push(plural(group.value, group.forms));
  }

  const text = parts.join(" ");
  const capitalized = text.charAt(0).toUpperCase() + text.slice(1);
  return `${capitalized} ${plural(rubles, ["рубль", "рубля", "рублей"])} ${String(kopecks).padStart(2, "0")} ${plural(kopecks, ["копейка", "копейки", "копеек"])}`;
}

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/* ------------------------------------------------------------------ */
/*  Мини-шаблонизатор                                                  */
/* ------------------------------------------------------------------ */

const dig = (context, path) =>
  String(path).split(".").reduce((acc, key) => (acc === null || acc === undefined ? "" : acc[key]), context);

/** Подстановки {{a.b}} и повторяющиеся блоки {{#list}}…{{/list}}. */
export function renderTemplate(template, context) {
  const withBlocks = String(template).replace(
    /\{\{#([a-z_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_, name, inner) => {
      const list = dig(context, name);
      if (!Array.isArray(list)) return "";
      return list.map((item, index) => renderTemplate(inner, { ...context, ...item, "@index": index + 1, item })).join("");
    }
  );

  return withBlocks.replace(/\{\{([@a-z_0-9.]+)\}\}/gi, (_, path) => escapeHtml(dig(context, path)));
}

/* ------------------------------------------------------------------ */
/*  Данные для документа                                               */
/* ------------------------------------------------------------------ */

/** Собирает контекст: наши реквизиты, контрагент, позиции, суммы и НДС. */
export async function buildContext({ orderId = null, dealId = null, userId = null }) {
  let order = null;
  let items = [];
  let deal = null;

  if (orderId) {
    order = await repo.byId("orders", orderId);
    if (!order) throw new HttpError(404, "Заказ не найден");
    items = await db.all("SELECT * FROM order_items WHERE order_id = ? ORDER BY id", [order.id]);
    deal = order.deal_id ? await repo.byId("deals", order.deal_id) : null;
  } else if (dealId) {
    deal = await repo.byId("deals", dealId);
    if (!deal) throw new HttpError(404, "Сделка не найдена");
    items = [{ name: deal.title, quantity: 1, price: deal.amount, vat_rate: 20 }];
  } else {
    throw new HttpError(400, "Укажите заказ или сделку");
  }

  const contactId = order?.contact_id ?? deal?.contact_id ?? null;
  const companyId = order?.company_id ?? deal?.company_id ?? null;
  const contact = contactId ? await repo.byId("contacts", contactId) : null;
  const company = companyId ? await repo.byId("companies", companyId) : null;
  const manager = userId ? await repo.byId("users", userId) : null;

  let total = 0;
  let vatTotal = 0;
  const rows = items.map((item, index) => {
    const quantity = Number(item.quantity) || 0;
    const price = Number(item.price) || 0;
    const sum = Math.round(quantity * price * 100) / 100;
    const rate = Number(item.vat_rate ?? 20);
    const vat = Math.round((sum - sum / (1 + rate / 100)) * 100) / 100;
    total += sum;
    vatTotal += vat;
    return {
      index: index + 1,
      name: item.name,
      unit: item.unit || "шт",
      quantity: String(quantity).replace(".", ","),
      price: money(price),
      vat_rate: rate ? `${rate}%` : "без НДС",
      vat: money(vat),
      sum: money(sum),
    };
  });

  const today = new Date();
  return {
    org: config.org,
    doc: {
      number: order?.number || `Д-${deal?.id ?? ""}`,
      date: today.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }),
      short_date: today.toLocaleDateString("ru-RU"),
      valid_until: new Date(today.getTime() + 14 * 86400_000).toLocaleDateString("ru-RU"),
    },
    contact: contact
      ? { ...contact, full_name: contact.full_name, phone: contact.phone || "", email: contact.email || "" }
      : { full_name: "Покупатель", phone: "", email: "", position: "" },
    company: company || { name: contact?.full_name || "Покупатель", inn: "", kpp: "", legal_address: "" },
    order: order || {},
    deal: deal || {},
    manager: manager ? { name: manager.full_name || manager.email, phone: manager.phone, email: manager.email } : { name: "", phone: "", email: "" },
    items: rows,
    totals: {
      count: rows.length,
      amount: money(total),
      vat: money(vatTotal),
      without_vat: money(total - vatTotal),
      in_words: amountInWords(total),
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Шаблоны по умолчанию                                               */
/* ------------------------------------------------------------------ */

const PRINT_CSS = `
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font: 12px/1.5 "Helvetica Neue", Arial, sans-serif; color: #111; margin: 0; }
  h1 { font: 600 20px/1.25 Georgia, "Times New Roman", serif; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: #555; margin-bottom: 20px; }
  .req { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
  .req td { border: 1px solid #111; padding: 6px 8px; vertical-align: top; }
  table.items { width: 100%; border-collapse: collapse; margin: 12px 0; }
  table.items th, table.items td { border: 1px solid #111; padding: 6px 8px; text-align: left; }
  table.items th { background: #f2f2f2; font-weight: 600; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  .totals { margin: 10px 0 18px; text-align: right; }
  .totals b { font-size: 14px; }
  .words { border-top: 1px solid #111; padding-top: 8px; margin-bottom: 24px; }
  .signs { display: flex; gap: 40px; margin-top: 36px; }
  .signs div { flex: 1; border-top: 1px solid #111; padding-top: 6px; color: #555; }
  .note { color: #555; font-size: 11px; margin-top: 24px; }
  @media print { .noprint { display: none !important; } }
`;

const ITEMS_TABLE = `
  <table class="items">
    <thead>
      <tr>
        <th style="width:28px">№</th><th>Наименование</th><th class="num">Кол-во</th>
        <th class="num">Цена</th><th class="num">НДС</th><th class="num">Сумма</th>
      </tr>
    </thead>
    <tbody>
      {{#items}}
      <tr>
        <td>{{index}}</td><td>{{name}}</td><td class="num">{{quantity}} {{unit}}</td>
        <td class="num">{{price}}</td><td class="num">{{vat_rate}}</td><td class="num">{{sum}}</td>
      </tr>
      {{/items}}
    </tbody>
  </table>
  <div class="totals">
    Без НДС: {{totals.without_vat}} ₽ &nbsp;·&nbsp; НДС: {{totals.vat}} ₽<br />
    <b>Итого к оплате: {{totals.amount}} ₽</b>
  </div>
  <div class="words">Сумма прописью: {{totals.in_words}}</div>
`;

export const DEFAULT_TEMPLATES = [
  {
    code: "quote",
    kind: "quote",
    name: "Коммерческое предложение",
    body: `<h1>Коммерческое предложение № {{doc.number}}</h1>
<div class="sub">от {{doc.date}} · действительно до {{doc.valid_until}}</div>
<table class="req">
  <tr><td style="width:50%"><b>Исполнитель</b><br />{{org.name}}<br />ИНН {{org.inn}}, КПП {{org.kpp}}<br />{{org.address}}</td>
      <td><b>Заказчик</b><br />{{company.name}}<br />{{contact.full_name}}<br />{{contact.phone}} {{contact.email}}</td></tr>
</table>
<p>Благодарим за интерес к нашим услугам. Предлагаем следующие условия:</p>
${ITEMS_TABLE}
<p class="note">Цены указаны в рублях. Срок поставки согласовывается после подтверждения заказа.</p>
<div class="signs"><div>{{manager.name}}, менеджер<br />{{manager.phone}} · {{manager.email}}</div><div>Подпись заказчика</div></div>`,
  },
  {
    code: "invoice",
    kind: "invoice",
    name: "Счёт на оплату",
    body: `<h1>Счёт на оплату № {{doc.number}} от {{doc.date}}</h1>
<table class="req">
  <tr><td style="width:50%"><b>Поставщик</b><br />{{org.name}}<br />ИНН {{org.inn}}, КПП {{org.kpp}}<br />{{org.address}}<br />р/с {{org.account}}<br />{{org.bank}}, БИК {{org.bik}}<br />к/с {{org.corr_account}}</td>
      <td><b>Покупатель</b><br />{{company.name}}<br />ИНН {{company.inn}}, КПП {{company.kpp}}<br />{{company.legal_address}}</td></tr>
</table>
${ITEMS_TABLE}
<p class="note">Оплата этого счёта означает согласие с условиями поставки. Счёт действителен в течение 5 банковских дней.</p>
<div class="signs"><div>Руководитель &nbsp; {{org.director}}</div><div>Главный бухгалтер &nbsp; {{org.accountant}}</div></div>`,
  },
  {
    code: "contract",
    kind: "contract",
    name: "Договор оказания услуг",
    body: `<h1>Договор № {{doc.number}}</h1>
<div class="sub">г. {{org.city}} · {{doc.date}}</div>
<p>{{org.name}}, именуемое в дальнейшем «Исполнитель», в лице {{org.director}}, действующего на основании Устава,
с одной стороны, и {{company.name}}, именуемое в дальнейшем «Заказчик», в лице {{contact.full_name}},
с другой стороны, заключили настоящий договор о нижеследующем.</p>
<p><b>1. Предмет договора.</b> Исполнитель обязуется оказать услуги согласно спецификации, а Заказчик — принять и оплатить их.</p>
<p><b>2. Стоимость и порядок расчётов.</b> Стоимость услуг составляет {{totals.amount}} ₽, в том числе НДС {{totals.vat}} ₽
({{totals.in_words}}). Оплата производится в течение 5 рабочих дней с момента выставления счёта.</p>
<p><b>3. Спецификация.</b></p>
${ITEMS_TABLE}
<p><b>4. Ответственность сторон.</b> Стороны несут ответственность в соответствии с законодательством Российской Федерации.</p>
<p><b>5. Персональные данные.</b> Стороны обрабатывают персональные данные в соответствии с Федеральным законом № 152-ФЗ.</p>
<div class="signs"><div>Исполнитель &nbsp; {{org.director}}</div><div>Заказчик &nbsp; {{contact.full_name}}</div></div>`,
  },
  {
    code: "act",
    kind: "act",
    name: "Акт выполненных работ",
    body: `<h1>Акт № {{doc.number}} от {{doc.date}}</h1>
<table class="req">
  <tr><td style="width:50%"><b>Исполнитель</b><br />{{org.name}}<br />ИНН {{org.inn}}</td>
      <td><b>Заказчик</b><br />{{company.name}}<br />ИНН {{company.inn}}</td></tr>
</table>
<p>Исполнитель сдал, а Заказчик принял следующие работы (услуги):</p>
${ITEMS_TABLE}
<p>Всего оказано услуг на сумму {{totals.amount}} ₽ ({{totals.in_words}}), в том числе НДС {{totals.vat}} ₽.</p>
<p class="note">Вышеперечисленные услуги выполнены полностью и в срок. Заказчик претензий по объёму, качеству и срокам оказания услуг не имеет.</p>
<div class="signs"><div>Исполнитель &nbsp; {{org.director}}</div><div>Заказчик &nbsp; {{contact.full_name}}</div></div>`,
  },
];

/** Создаёт шаблоны по умолчанию при первом старте: пустой список форм бесполезен. */
export async function ensureTemplates() {
  for (const template of DEFAULT_TEMPLATES) {
    const existing = await db.get("SELECT id FROM doc_templates WHERE code = ?", [template.code]);
    if (!existing) await repo.insert("doc_templates", template);
  }
}

/** Готовый к печати документ: шаблон + данные + печатный CSS. */
export async function renderDocument({ code, orderId, dealId, userId }) {
  const template = await db.get("SELECT * FROM doc_templates WHERE code = ? AND is_active = 1", [code]);
  if (!template) throw new HttpError(404, "Шаблон не найден");

  const context = await buildContext({ orderId, dealId, userId });
  const body = renderTemplate(template.body, context);
  const title = `${template.name} № ${context.doc.number}`;

  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8" /><title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head>
<body>
<div class="noprint" style="margin-bottom:16px">
  <button onclick="window.print()" style="padding:8px 14px;font:500 13px sans-serif;cursor:pointer">Печать · Сохранить в PDF</button>
</div>
${body}
</body></html>`;

  return { html, title, filename: `${code}-${context.doc.number}.html` };
}
