/** Единое окно VAPELAB: посетитель и сотрудник входят по коду e-mail. */
import { api, field, h, token, toast } from "../core.js";
import { state, render, go } from "../app.js";

const art = () => h("div", { class:"gate-art vapelab-gate-art" },
  h("a", { class:"gate-brand", href:"/" },
    h("span", { class:"gate-brand-mark" }, h("img", { src:"/assets/brand/vapelab-logo.webp", alt:"" })),
    h("strong", {}, "VAPELAB")
  ),
  h("div", { class:"lede display" }, "Личный кабинет")
);

export function renderLogin() {
  const host = h("div", { class:"gate-form" });
  const wrap = h("div", { class:"gate vapelab-gate" }, art(), host);
  showEmailStep(host);
  return wrap;
}

export function renderRegister() { return renderLogin(); }

function showEmailStep(host) {
  const name = h("input", { type:"text", maxlength:"200", placeholder:"Как к вам обращаться (необязательно)" });
  const email = h("input", { type:"email", required:true, autocomplete:"email", placeholder:"name@example.ru" });
  const consent = h("input", { type:"checkbox" });
  const alert = h("div", { class:"alert", hidden:true });
  const submit = h("button", { class:"btn solid wide", type:"submit" }, "Получить код");
  const form = h("form", { onsubmit:async (event)=>{
    event.preventDefault();
    submit.disabled=true; submit.textContent="Отправляем письмо…"; alert.hidden=true;
    try {
      await api("/auth/request-code", { method:"POST", body:{ email:email.value, full_name:name.value, pd_consent:consent.checked } });
      showCodeStep(host, email.value.trim().toLowerCase());
    } catch (error) {
      alert.textContent=error.message; alert.hidden=false; submit.disabled=false; submit.textContent="Получить код";
    }
  } },
    h("div", { class:"gate-kicker" }, "Личный кабинет / CRM"),
    h("h2", {}, "Войти в VAPELAB"),
    alert,
    field("Имя", name),
    field("Электронная почта", email),
    h("label", { class:"check gate-consent" }, consent, h("span", {}, "Согласен на обработку персональных данных для создания личного профиля, если аккаунта ещё нет.")),
    submit,
    h("div", { class:"switcher" }, h("a", { href:"/" }, "Вернуться на сайт"))
  );
  host.replaceChildren(form);
}

function showCodeStep(host, emailValue) {
  const code = h("input", { type:"text", inputmode:"numeric", pattern:"[0-9]{6}", maxlength:"6", autocomplete:"one-time-code", placeholder:"000000", required:true });
  const alert = h("div", { class:"alert", hidden:true });
  const submit = h("button", { class:"btn solid wide", type:"submit" }, "Подтвердить и войти");
  const resend = h("button", { class:"btn quiet wide", type:"button" }, "Отправить код повторно");
  const form = h("form", { onsubmit:async (event)=>{
    event.preventDefault();
    if (!/^\d{6}$/.test(code.value.trim())) { alert.textContent="Введите шестизначный код"; alert.hidden=false; return; }
    submit.disabled=true; submit.textContent="Проверяем…"; alert.hidden=true;
    try {
      const data = await api("/auth/verify-code", { method:"POST", body:{ email:emailValue, code:code.value.trim() } });
      token.set(data.access_token); state.user=data.user; toast("Вход выполнен"); go("/"); render();
    } catch (error) {
      alert.textContent=error.message; alert.hidden=false; submit.disabled=false; submit.textContent="Подтвердить и войти";
    }
  } },
    h("div", { class:"gate-kicker" }, "Проверка почты"),
    h("h2", {}, "Введите код"),
    h("p", { class:"sub" }, `Мы отправили письмо на ${emailValue}. Код действует 15 минут.`),
    alert,
    field("Шестизначный код", code),
    submit,
    resend,
    h("div", { class:"switcher" }, h("a", { onclick:()=>showEmailStep(host) }, "Изменить e-mail"))
  );
  resend.addEventListener("click", async ()=>{
    resend.disabled=true;
    try { await api("/auth/request-code", { method:"POST", body:{ email:emailValue } }); toast("Если адрес активен, новый код отправлен"); }
    catch (error) { alert.textContent=error.message; alert.hidden=false; }
    finally { resend.disabled=false; }
  });
  host.replaceChildren(form);
  setTimeout(()=>code.focus(),30);
}

export async function renderVisitorAccount(root) {
  const logout = h("button", { class:"btn quiet", onclick:()=>{ token.set(null); state.user=null; go("/login"); render(); } }, "Выйти");
  const host = h("main", { class:"visitor-card visitor-account-card" }, h("p", { class:"muted" }, "Загружаем личный кабинет…"));
  const shell = h("div", { class:"visitor-shell" },
    h("header", { class:"visitor-header" },
      h("a", { href:"/", class:"gate-brand" }, h("span", { class:"gate-brand-mark" }, h("img", { src:"/assets/brand/vapelab-logo.webp", alt:"" })), h("strong",{},"VAPELAB")),
      h("div", { class:"visitor-header-actions" }, h("a", { href:"/", class:"btn quiet" }, "Вернуться в магазин"), logout)
    ), host
  );
  root.replaceChildren(shell);

  const fmtDate = (value) => {
    if (!value) return "—";
    const date = new Date(String(value).includes("T") ? value : `${String(value).replace(" ", "T")}Z`);
    return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString("ru-RU", { dateStyle:"medium", timeStyle:"short" });
  };
  const fmtMoney = (value, currency = "RUB") => {
    const amount = Number(value || 0);
    return new Intl.NumberFormat("ru-RU", { style:"currency", currency, maximumFractionDigits:2 }).format(Number.isFinite(amount) ? amount : 0);
  };
  const escText = (value) => String(value ?? "");

  try {
    const response = await api("/auth/customer-profile");
    const profileData = response.data || response;
    const profile = profileData.profile || {};
    const user = profileData.user || state.user || {};
    const name = h("input", { type:"text", maxlength:"200", value:profile.full_name || user.full_name || "", placeholder:"Ваше имя" });
    const phone = h("input", { type:"tel", maxlength:"80", value:profile.phone || "", placeholder:"Номер телефона", autocomplete:"tel" });
    const email = h("input", { type:"email", value:profile.email || user.email || "", disabled:true });
    const telegram = h("input", { type:"text", maxlength:"64", value:profile.telegram_username || "", placeholder:"username без @" });
    const address = h("input", { type:"text", maxlength:"500", value:profile.delivery_address || "", placeholder:"Улица, дом, квартира" });
    const city = h("input", { type:"text", maxlength:"120", value:profile.delivery_city || "", placeholder:"Город" });
    const postcode = h("input", { type:"text", maxlength:"32", value:profile.delivery_postcode || "", placeholder:"Индекс" });
    const deliveryComment = h("textarea", { rows:"2", maxlength:"800", placeholder:"Подъезд, этаж, удобное время и другие детали" }, profile.delivery_comment || "");
    const alert = h("div", { class:"alert", hidden:true });
    const save = h("button", { class:"btn solid", onclick:async ()=>{
      save.disabled=true; alert.hidden=true;
      try {
        const updated = await api("/auth/profile", { method:"PATCH", body:{
          full_name:name.value.trim(), phone:phone.value.trim(), telegram_username:telegram.value.trim(),
          delivery_address:address.value.trim(), delivery_city:city.value.trim(), delivery_postcode:postcode.value.trim(), delivery_comment:deliveryComment.value.trim(),
        } });
        state.user = { ...state.user, ...(updated.data || updated) }; toast("Контактные данные сохранены");
      } catch(error) { alert.textContent=error.message; alert.hidden=false; }
      finally { save.disabled=false; }
    } }, "Сохранить контактные данные");
    const telegramState = h("p", { class:"muted" }, profile.telegram_linked ? `Telegram подключён${profile.telegram_username ? `: @${profile.telegram_username}` : ""}. Сообщения боту появятся в истории диалогов.` : "Telegram не подключён. После привязки можно будет переписываться с VAPELAB прямо в Telegram.");
    const linkTelegram = h("button", { class:"btn quiet", onclick:async ()=>{
      linkTelegram.disabled=true;
      try { const linked=await api("/auth/telegram-link", { method:"POST", body:{} }); const url=linked.url || linked.data?.url; if (!url) throw new Error("Ссылка Telegram не сформирована"); window.open(url, "_blank", "noopener,noreferrer"); toast("Откройте Telegram и нажмите Start"); }
      catch(error) { alert.textContent=error.message; alert.hidden=false; }
      finally { linkTelegram.disabled=false; }
    } }, profile.telegram_linked ? "Переподключить Telegram" : "Подключить Telegram");

    const orders = Array.isArray(profileData.orders) ? profileData.orders : [];
    const reservations = Array.isArray(profileData.reservations) ? profileData.reservations : [];
    const conversations = Array.isArray(profileData.conversations) ? profileData.conversations : [];
    const orderSection = h("section", { class:"visitor-account-section" }, h("h2",{},"История заказов"),
      orders.length ? h("div", { class:"visitor-history-list" }, ...orders.map((order)=>h("article",{class:"visitor-history-item"},
        h("div",{class:"line"},h("strong",{},order.number || `Заказ #${order.id}`),h("span",{class:"chip"},order.status || "—")),
        h("p",{},`${fmtMoney(order.total)} · ${fmtDate(order.created_at)}`),
        order.items?.length ? h("ul",{},...order.items.map((item)=>h("li",{},`${item.name} · ${item.quantity} × ${fmtMoney(item.price)}`))) : null
      ))) : h("p",{class:"muted"},"Заказов пока нет."));
    const reservationsSection = h("section", { class:"visitor-account-section" }, h("h2",{},"Бронирования"),
      reservations.length ? h("div", { class:"visitor-history-list" }, ...reservations.map((item)=>h("article",{class:"visitor-history-item"},
        h("div",{class:"line"},h("strong",{},item.product_name),h("span",{class:"chip"},item.status || "—")),
        h("p",{},`${item.number} · ${item.quantity} шт. · ${item.price_calculated ? fmtMoney((Number(item.total_price_minor)||0)/100,item.price_currency||"RUB") : "Стоимость уточняется"}`),
        h("small",{class:"muted"},fmtDate(item.created_at))
      ))) : h("p",{class:"muted"},"Бронирований пока нет."));
    const channelLabel = (kind) => ({webchat:"Чат сайта",telegram:"Telegram",whatsapp:"WhatsApp",email:"E-mail"})[kind] || kind || "Диалог";
    const conversationsSection = h("section", { class:"visitor-account-section" }, h("h2",{},"Переписка с VAPELAB"),
      conversations.length ? h("div", { class:"visitor-conversation-list" }, ...conversations.map((conversation)=>h("article",{class:"visitor-history-item"},
        h("div",{class:"line"},h("strong",{},conversation.subject || `Диалог #${conversation.id}`),h("span",{class:"chip"},channelLabel(conversation.channel_type))),
        h("div",{class:"visitor-message-history"},...(conversation.messages || []).slice(-12).map((message)=>h("div",{class:`visitor-message ${message.direction === "outbound" ? "from-team" : "from-customer"}`},h("p",{},message.body || "[вложение]"),h("small",{},fmtDate(message.created_at))))),
        h("small",{class:"muted"},`Обновлён: ${fmtDate(conversation.last_message_at)}`)
      ))) : h("p",{class:"muted"},"Переписки пока нет. Напишите нам через кнопку чата на сайте или подключите Telegram."));

    host.replaceChildren(
      h("div", { class:"visitor-account-heading" }, h("span", { class:"gate-kicker" }, "Личный кабинет"), h("h1",{},"Профиль покупателя"), h("p",{class:"muted"},user.email || profile.email || "")),
      alert,
      h("div", { class:"visitor-account-grid" },
        h("section", { class:"visitor-account-section" }, h("h2",{},"Контактные данные"),
          h("div",{class:"visitor-account-form"},field("Имя",name),field("Телефон",phone),field("E-mail",email),field("Telegram username",telegram),field("Адрес доставки",address),field("Город",city),field("Почтовый индекс",postcode),field("Комментарий к доставке",deliveryComment),save)),
        h("section", { class:"visitor-account-section" }, h("h2",{},"Связь с менеджером"),telegramState,linkTelegram,h("p",{class:"muted"},"После подключения Telegram откройте бота и нажмите Start. Вы сможете писать менеджеру в Telegram, а ответы из CRM будут приходить туда же."))
      ),
      orderSection, reservationsSection, conversationsSection
    );
  } catch(error) {
    host.replaceChildren(h("div",{class:"alert"},`Не удалось загрузить личный кабинет: ${error.message}`),h("a",{href:"/"},"Вернуться в магазин"));
  }
}
