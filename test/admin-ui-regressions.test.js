import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const read = (file) => fs.readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("таблица бронирований содержит заголовки цены и итоговой суммы", async () => {
  const source = await read("public/js/views/reservations.js");
  assert.match(source, /"Количество \/ цена", "Итого"/);
  assert.match(source, /formatReservationMoney\(row\.total_price_minor, row\.price_currency\)/);
});

test("настройки показывают журнал супер-администратору, а управление доступно по согласованным ролям", async () => {
  const source = await read("public/js/views/settings.js");
  assert.match(source, /const isManager = \["superadmin", "admin", "manager"\]\.includes\(user\.role\)/);
  assert.match(source, /\["superadmin", "admin", "manager"\]\.includes\(user\.role\) \? loadAudit\(auditHost\)/);
});


test("после успешного бронирования покупателю показывается временное подтверждение", async () => {
  const source = await read("public/store-reservations.js");
  assert.match(source, /title\.textContent = "Бронирование подтверждено"/);
  assert.match(source, /Ожидайте связи менеджера VAPELAB/);
  assert.match(source, /Бронирование подтверждено\. Номер бронирования:/);
  assert.match(source, /window\.setTimeout\(\(\) => \{/);
  assert.match(source, /\}, 5500\)/);
});


test("выбор фото товара больше не требует Yandex API и поддерживает Qwen/локальную загрузку", async () => {
  const source = await read("public/js/views/store.js");
  const styles = await read("public/app.css");
  assert.match(source, /Подобрать изображение через Qwen/);
  assert.match(source, /Скопировать задание для Qwen/);
  assert.match(source, /\/enrich-catalog <slug>/);
  assert.match(source, /Страница исходного товара/);
  assert.match(source, /store\/products\/\$\{p\.id\}\/images\/upload/);
  assert.match(styles, /\.sheet:has\(\.image-picker\).*?width:min\(900px,96vw\)/s);
  assert.match(styles, /\.image-picker \{[^}]*min-width:0/s);
});

test("поиск товаров сохраняет фокус и позицию курсора после серверного обновления", async () => {
  const source = await read("public/js/views/store.js");
  assert.match(source, /store-product-search-input/);
  assert.match(source, /reload\(\{ preserveProductSearch = false \} = \{\}\)/);
  assert.match(source, /nextSearch\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /nextSearch\.setSelectionRange\(selectionStart, selectionEnd\)/);
});

test("категории показывают выбранный товар с умеренной анимацией", async () => {
  const source = await read("storefront-react/src/main.js");
  const admin = await read("public/js/views/store.js");
  const styles = await read("storefront-react/src/styles.css");
  assert.match(source, /featured_product/);
  assert.match(source, /category-card-image/);
  assert.match(admin, /Товар-представитель категории/);
  assert.match(styles, /scale\(1\.012\)/);
  assert.match(styles, /scale\(1\.035\)/);
  assert.match(styles, /prefers-reduced-motion:reduce/);
});


test("витрина поддерживает массовую публикацию и изменение наличия", async () => {
  const source = await read("public/js/views/store.js");
  const server = await read("server/routes/store.js");
  assert.match(source, /selectedProductIds/);
  for (const label of ["Показать в каталоге", "Скрыть из каталога", "Отметить: в наличии", "Отметить: отсутствует", "Отметить: предзаказ"]) assert.ok(source.includes(label));
  assert.ok(source.includes("Разрешить бронирование"));
  assert.match(source, /За одну операцию можно выбрать не более 100 товаров/);
  assert.match(server, /store\/products\/bulk/);
  assert.match(server, /UPDATE store_products SET is_reservable=1/);
  assert.match(server, /restock-subscriptions\/:id\/notify/);
});

test("админка редактирует варианты и привязывает к ним фотографии", async () => {
  const source = await read("public/js/views/store.js");
  const server = await read("server/routes/store.js");
  assert.match(source, /Настроить варианты и фото/);
  assert.match(source, /Цена варианта/);
  assert.match(source, /Описание варианта/);
  assert.match(source, /Загрузить фотографии этого варианта/);
  assert.match(source, /Выбрать уже загруженное фото для этого варианта/);
  assert.match(server, /products\/:id\/variants/);
});

test("оптовая страница остаётся отдельным маршрутом, но не занимает место в верхней навигации", async () => {
  const source = await read("storefront-react/src/main.js");
  const pages = await read("server/public-pages.js");
  assert.match(pages, /decoded === "\/optovy"/);
  assert.match(pages, /slug='optovy' AND status='published'/);
  assert.doesNotMatch(source, /\['\/optovy', 'Опт'\]/);
  assert.doesNotMatch(source, /\['#about', 'О компании'\]/);
  assert.doesNotMatch(pages.match(/function siteHeader\(\)[\s\S]*?function siteFooter/)?.[0] || "", /\/optovy|О компании/);
});

test("пункт Сделки удалён из навигации CRM, а сохранённая серверная модель остаётся доступной", async () => {
  const app = await read("public/js/app.js");
  const dashboard = await read("public/js/views/dashboard.js");
  const crm = await read("server/routes/crm.js");
  assert.doesNotMatch(app, /path: "\/deals", label: "Сделки"/);
  assert.doesNotMatch(app, /\["Сделки", data\.deals/);
  assert.doesNotMatch(dashboard, /metric\("Сделки"/);
  assert.match(crm, /get\("\/api\/deals"/);
});

test("настройки CRM сгруппированы в компактные раскрывающиеся подразделы", async () => {
  const settings = await read("public/js/views/settings.js");
  const styles = await read("public/app.css");
  assert.match(settings, /h\("details", \{ class: "settings-section"/);
  assert.match(settings, /settings-section-summary/);
  assert.match(settings, /Профиль и оформление/);
  assert.match(settings, /Рабочие процессы/);
  assert.match(settings, /Коммуникации/);
  assert.match(styles, /\.settings-section-summary/);
});

test("раздел Заказы содержит приёмку поставок из XLSX и CSV", async () => {
  const view = await read("public/js/views/orders.js");
  const route = await read("server/routes/supplies.js");
  const migrations = await read("server/migrate.js");
  assert.match(view, /Поставки/);
  assert.match(view, /Принять поставку/);
  assert.match(view, /\.xlsx,\.csv/);
  assert.match(view, /Сопоставление колонок/);
  assert.match(route, /supplies\/preview/);
  assert.match(route, /supply_items/);
  assert.match(route, /UPDATE products SET stock=COALESCE\(stock,0\)\+/);
  assert.match(migrations, /"supplies"/);
  assert.match(migrations, /"supply_items"/);
});

test("общая воронка показывает сотрудников и итоговую строку", async () => {
  const source = await read("public/js/views/dashboard.js");
  const route = await read("server/routes/crm.js");
  assert.match(route, /funnel_by_owner/);
  assert.match(source, /Общая воронка по ответственным/);
  assert.match(source, /ИТОГО ПО ВСЕМ/);
});


test("уведомление о поступлении использует Telegram/email из авторизованного профиля", async () => {
  const source = await read("public/store-restock.js");
  assert.match(source, /localStorage\.getItem\("rucrm\.token"\)/);
  assert.match(source, /headers\.Authorization = `Bearer \${accessToken}`/);
});


test("основная учётная запись не раскрывает личность в интерфейсе CRM", async () => {
  const auth = await read("server/routes/auth.js");
  const users = await read("server/routes/users.js");
  const app = await read("public/js/app.js");
  const settings = await read("public/js/views/settings.js");
  const activity = await read("server/activity.js");
  assert.match(auth, /email: isPrimaryAdmin \? "" : u\.email/);
  assert.match(auth, /full_name: isPrimaryAdmin \? "Рабочий аккаунт" : u\.full_name/);
  assert.match(users, /role NOT IN \('visitor','superadmin'\)/);
  assert.match(app, /displayName = user\?\.role === "superadmin" \? "Рабочий аккаунт"/);
  assert.doesNotMatch(app, /superadmin:"Главный администратор"/);
  assert.match(settings, /user\.role === "superadmin" \? "Скрыта"/);
  assert.match(activity, /CASE WHEN u\.role='superadmin' THEN 'Администратор'/);
});


test("менеджеры видят все разделы админки, а управление аккаунтами ограничено своей веткой", async () => {
  const app = await read("public/js/app.js");
  const users = await read("server/routes/users.js");
  const usersView = await read("public/js/views/users.js");
  const store = await read("server/routes/store.js");
  const crm = await read("server/routes/crm.js");
  const analytics = await read("server/routes/analytics.js");
  const mail = await read("server/routes/mail.js");
  const reservations = await read("server/routes/reservations.js");
  assert.match(app, /roles:\["superadmin","admin","manager"\]/);
  assert.match(users, /WITH RECURSIVE team_tree/);
  assert.match(users, /invited_by:user\.id/);
  assert.match(users, /del\("\/api\/users\/:id"/);
  assert.match(users, /target\.role === "superadmin"/);
  assert.match(usersView, /Удалить/);
  assert.match(usersView, /user\.can_manage/);
  for (const source of [store, crm, analytics, mail, reservations]) {
    assert.match(source, /\["superadmin", "admin", "manager"\]\.includes\(user\.role\)/);
  }
});
