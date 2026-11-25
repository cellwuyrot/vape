/** Смоук-тесты: регистрация с кодами, CRM, омниканальный инбокс.  Запуск: npm test */
import assert from "node:assert/strict";
import fs from "node:fs";
import test, { after, before } from "node:test";

process.env.DATA_DIR = "./data-test";
process.env.SECRET_KEY = "test-secret";
fs.rmSync("./data-test", { recursive: true, force: true });

const { createServer } = await import("../server/index.js");
const { db } = await import("../server/db.js");
const { consumeCode, ensureAdmin, issueCode } = await import("../server/auth.js");
const server = await createServer();
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://localhost:${server.address().port}`;

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.close();
  await fs.promises.rm("./data-test", { recursive: true, force: true });
});

const call = async (path, { method = "GET", body, token } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

let adminToken;
const loginByEmailCode = async (email) => {
  const user = await db.get("SELECT * FROM users WHERE email=?", [email.toLowerCase()]);
  assert.ok(user, `пользователь ${email} должен существовать`);
  const code = await issueCode(user.id, "email");
  const verified = await call("/api/auth/verify-code", { method:"POST", body:{ email, code } });
  assert.equal(verified.status, 200);
  return verified.data.access_token;
};

before(async () => {
  adminToken = await loginByEmailCode("andycoulbot@gmail.com");
  // Изолированные данные теста, не зависящие от демонстрационного содержимого миграций.
  await db.run("INSERT INTO store_products(name,slug,brand,status,price_raw) VALUES(?,?,?,?,?)", ["CI тестовая модель A", "ci-test-product-a", "CI Test", "published", "100 ₽"]);
  await db.run("INSERT INTO store_products(name,slug,brand,status,price_raw) VALUES(?,?,?,?,?)", ["CI тестовая модель B", "ci-test-product-b", "CI Test", "published", "200 ₽"]);
  await db.run("INSERT INTO store_products(name,slug,status) VALUES(?,?,?)", ["CI черновик", "ci-test-draft", "draft"]);
  const products = await db.all("SELECT id FROM store_products WHERE slug IN ('ci-test-product-a','ci-test-product-b')");
  const categories = await db.all("SELECT id FROM store_categories WHERE parent_id IS NULL");
  for (const product of products) for (const category of categories) {
    await db.run("INSERT INTO store_product_categories(product_id,category_id) VALUES(?,?)", [product.id, category.id]);
  }
  await db.run("INSERT INTO store_news(title,slug,body,status) VALUES(?,?,?,?)", ["CI тестовая новость", "ci-test-news", "Тестовая публикация", "published"]);
  await db.run("INSERT INTO store_news(title,slug,body,status) VALUES(?,?,?,?)", ["CI черновик новости", "ci-test-news-draft", "Черновик", "draft"]);
});

test("сервис отвечает", async () => {
  const res = await call("/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.data.status, "ok");
});

test("публичная витрина и CRM доступны по разным адресам", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.match(html, /VAPELAB/);
  if (fs.existsSync(new URL("../public/react-app/index.html", import.meta.url))) {
    assert.match(html, /id="root"/);
    assert.match(html, /vapelab-storefront\.js/);
    assert.match(html, /vapelab-storefront\.css/);
  } else {
    assert.match(html, />Войти</);
    assert.match(html, /hero-wave-field/);
    assert.match(html, /href="\/tabak"/);
    assert.match(html, /href="\/stiki"/);
  }
  assert.doesNotMatch(html, /CRM ↗/);
  const crm = await fetch(base + "/crm");
  assert.equal(crm.status, 200);
  assert.match(await crm.text(), /VAPELAB/);
});

test("маршрутизация не подменяет неизвестные адреса оболочкой CRM", async () => {
  const unknownPage = await fetch(`${base}/definitely-not-a-page`, { headers:{ Accept:"text/html" } });
  assert.equal(unknownPage.status,404);
  assert.match(unknownPage.headers.get("content-type"),/text\/html/);
  assert.match(await unknownPage.text(),/Страница не найдена/);

  for (const pathname of ["/product/not-existing", "/index.html", "/storefront.html", "/assets/brand/missing.webp"]) {
    const response = await fetch(`${base}${pathname}`, { headers:{ Accept:"text/html" } });
    assert.equal(response.status,404,`${pathname} должен возвращать настоящий 404`);
    assert.match(response.headers.get("x-robots-tag") || "",/noindex/);
  }
  for (const pathname of ["/tabak", "/stiki", "/nagrevateli-tabaka", "/pod-sistemy"]) {
    const response = await fetch(`${base}${pathname}`, { headers:{ Accept:"text/html" } });
    assert.equal(response.status,200,`${pathname} должен открывать категорию`);
    assert.match(response.headers.get("content-type"),/text\/html/);
    assert.match(await response.text(),/<h1>/);
  }

  const crmSlash = await fetch(`${base}/crm/`, { redirect:"manual" });
  assert.equal(crmSlash.status,308);
  assert.equal(crmSlash.headers.get("location"),"/crm");
  const crmAsset = await fetch(`${base}/index.html`);
  assert.equal(crmAsset.status,404,"CRM shell нельзя открыть через произвольный статический URL");

  const traversal = await fetch(`${base}/%2e%2e/.env`, { headers:{ Accept:"text/html" } });
  assert.equal(traversal.status,404,"нельзя читать файлы за пределами public");

  const head = await fetch(`${base}/fonts.css`, { method:"HEAD" });
  assert.equal(head.status,200);
  assert.ok(Number(head.headers.get("content-length")) > 0);
  assert.equal(await head.text(),"");
});

test("резервная HTML-главная содержит короткую структуру бренда и навигацию по категориям", async () => {
  const html = fs.readFileSync(new URL("../public/storefront.html", import.meta.url), "utf8");
  assert.match(html,/<h1>VAPELAB/);
  assert.match(html,/id="about"/);
  assert.match(html,/id="categories"/);
  assert.match(html,/id="news"/);
  assert.match(html,/id="contacts"/);
  assert.match(html,/href="\/tabak"/);
  assert.match(html,/href="\/stiki"/);
  assert.match(html,/class="all-category-details"/);
  assert.doesNotMatch(html,/01\s*\/\s*ASSORTMENT/i);
  assert.doesNotMatch(html,/ДЕМОНСТРАЦИОННЫЕ ПОЗИЦИИ/i);
  assert.match(html,/РОЗНИЦА \/ ОПТ/);
  assert.doesNotMatch(html,/seo-product-card/);
  assert.match(html,/hero-58-visual\.js/);
  assert.match(html,/reactbits\/spotlight-fallback\.js/);
  assert.doesNotMatch(html,/esm\.sh|importmap/);
  assert.match(html,/href="\/favicon\.svg"/);
  const favicon = await fetch(`${base}/favicon.svg`);
  assert.equal(favicon.status,200);
  assert.match(await favicon.text(),/data:image\/png;base64/);
  const cssResponse = await fetch(`${base}/seo-pages.css`);
  assert.equal(cssResponse.status,200);
  const css = await cssResponse.text();
  assert.match(css,/grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css,/min-height:530px/);
  assert.match(css,/#246bde/);
});

test("категории имеют отдельные канонические страницы, а прежние адреса перенаправляются", async () => {
  const oldStiki = await fetch(`${base}/stiki-dlya-nagrevateley-tabaka`, { redirect:"manual" });
  assert.equal(oldStiki.status,301);
  assert.equal(oldStiki.headers.get("location"),"/stiki");

  const child = await fetch(`${base}/stiki-terea-dlya-iqos-iluma`);
  assert.equal(child.status,200);
  const childHtml = await child.text();
  assert.match(childHtml,/<h1>Стики Terea для IQOS Iluma<\/h1>/);
  assert.match(childHtml,/rel="canonical" href="http:\/\/localhost:\d+\/stiki-terea-dlya-iqos-iluma"/);

  const listing = await fetch(`${base}/stiki`);
  assert.equal(listing.status,200);
  const listingHtml = await listing.text();
  assert.match(listingHtml,/data-reactbits-spotlight/);
  assert.doesNotMatch(listingHtml,/react-app\/assets\/vapelab-storefront\.(?:js|css)/);
  assert.match(listingHtml,/spotlight-fallback\.js/);
  assert.doesNotMatch(listingHtml,/esm\.sh|importmap/);
  const spotlightFallback = await fetch(`${base}/reactbits/spotlight-fallback.js`);
  assert.equal(spotlightFallback.status,200);
  assert.match(await spotlightFallback.text(),/prefers-reduced-motion/);
  const obsoleteSpotlightModule = await fetch(`${base}/reactbits/spotlight-card.js`);
  assert.equal(obsoleteSpotlightModule.status,404);
  const heroModule = await fetch(`${base}/hero-58-visual.js`);
  assert.equal(heroModule.status,200);
  assert.match(await heroModule.text(),/particle-wave adaptation/);

  const navigationModule = await fetch(`${base}/site-navigation.js`);
  assert.equal(navigationModule.status,200);
  assert.match(await navigationModule.text(),/aria-expanded/);
  assert.match(listingHtml,/id="menu-toggle"/);
  assert.match(listingHtml,/id="mobile-nav"/);
  assert.match(listingHtml,/footer-mark/);
  assert.match(listingHtml,/vapelab-logo\.webp/);
});

test("товар имеет отдельную индексируемую страницу с метаданными и хлебными крошками", async () => {
  const item = await db.get("SELECT name,slug,seo_title,seo_h1 FROM store_products WHERE status='published' ORDER BY id LIMIT 1");
  assert.ok(item?.slug,"В тестовой базе должен быть хотя бы один опубликованный товар");
  const response = await fetch(`${base}/product/${item.slug}`);
  assert.equal(response.status,200);
  const html = await response.text();
  const expectedTitle = item.seo_title || `${item.name} — VAPELAB`;
  const expectedH1 = item.seo_h1 || item.name;
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" })[char]);
  assert.ok(html.includes(`<title>${escapeHtml(expectedTitle)}</title>`));
  assert.ok(html.includes(`<h1>${escapeHtml(expectedH1)}</h1>`));
  assert.ok(html.includes(`/product/${item.slug}`));
  assert.doesNotMatch(html,/Подпись цены в исходных данных|Отдельное описание в доступном источнике не обнаружено|Цена не указана/);
  assert.match(html,/customer-tools\.js/);
  assert.match(html,/Забронировать товар/);
  if (html.includes('data-store-reservation')) assert.match(html,/seo-reservation-panel/);
  assert.match(html,/id="menu-toggle"/);
});

test("опубликованная новость открывается отдельной страницей", async () => {
  const item = await db.get("SELECT slug FROM store_news WHERE status='published' LIMIT 1");
  assert.ok(item?.slug);
  const response = await fetch(`${base}/news/${item.slug}`);
  assert.equal(response.status,200);
  assert.match(await response.text(),/<h1>/);
});

test("robots.txt и sitemap.xml доступны и не включают закрытые URL", async () => {
  const robots = await fetch(`${base}/robots.txt`);
  assert.equal(robots.status,200);
  const robotsText = await robots.text();
  assert.match(robotsText,/Disallow: \/api\//);
  assert.match(robotsText,/Disallow: \/crm/);
  assert.match(robotsText,/Sitemap: http:\/\/localhost:/);

  const sitemap = await fetch(`${base}/sitemap.xml`);
  assert.equal(sitemap.status,200);
  assert.match(sitemap.headers.get("content-type"),/application\/xml/);
  const xml = await sitemap.text();
  assert.match(xml,/<loc>http:\/\/localhost:\d+\/<\/loc>/);
  assert.match(xml,/<loc>http:\/\/localhost:\d+\/tabak<\/loc>/);
  assert.match(xml,/<loc>http:\/\/localhost:\d+\/stiki<\/loc>/);
  assert.match(xml,/<loc>http:\/\/localhost:\d+\/product\/ci-test-product-a<\/loc>/);
  assert.doesNotMatch(xml,/\/crm|\/api\//);
});

test("все опубликованные категории и товары имеют рабочие отдельные страницы", async () => {
  const catalog = await call("/api/store/public");
  assert.equal(catalog.status, 200);
  assert.ok(Array.isArray(catalog.data.categories));
  assert.ok(Array.isArray(catalog.data.products));
  const categoryPaths = [...new Set(catalog.data.categories.map((category) => category.public_slug).filter(Boolean))];
  assert.ok(categoryPaths.length >= 18, `ожидались маршруты основных и вложенных категорий, получено ${categoryPaths.length}`);
  for (const slug of categoryPaths) {
    const response = await fetch(`${base}/${encodeURIComponent(slug)}`);
    assert.equal(response.status, 200, `страница категории /${slug} должна открываться`);
    const html = await response.text();
    assert.match(html, /<h1>/, `страница /${slug} должна иметь H1`);
    assert.match(html, /rel="canonical"/, `страница /${slug} должна иметь canonical`);
  }
  for (const product of catalog.data.products) {
    const response = await fetch(`${base}/product/${encodeURIComponent(product.slug)}`);
    assert.equal(response.status, 200, `карточка ${product.slug} должна открываться`);
    const html = await response.text();
    assert.match(html, /<h1>/, `карточка ${product.slug} должна иметь H1`);
    assert.match(html, /rel="canonical"/, `карточка ${product.slug} должна иметь canonical`);
  }
});

test("sitemap содержит только канонические индексируемые страницы", async () => {
  const product = await db.get("SELECT id,slug,canonical_url,robots_index FROM store_products WHERE status='published' ORDER BY id LIMIT 1");
  assert.ok(product?.id);
  await db.run("UPDATE store_products SET robots_index=0 WHERE id=?", [product.id]);
  try {
    const sitemapResponse = await fetch(`${base}/sitemap.xml`);
    assert.equal(sitemapResponse.status, 200);
    const xml = await sitemapResponse.text();
    const page = await fetch(`${base}/product/${encodeURIComponent(product.slug)}`);
    assert.equal(page.headers.get("x-robots-tag"), "index, follow");
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    assert.ok(urls.length >= 10, "sitemap должен содержать публичные категории и другие опубликованные страницы");
    for (const value of urls) {
      const url = new URL(value);
      const response = await fetch(`${base}${url.pathname}`, { redirect: "manual" });
      assert.equal(response.status, 200, `URL из sitemap должен открываться напрямую: ${url.pathname}`);
      if (url.pathname !== "/") {
        assert.doesNotMatch(response.headers.get("x-robots-tag") || "", /noindex/i, `URL из sitemap не должен быть noindex: ${url.pathname}`);
      }
    }
  } finally {
    await db.run("UPDATE store_products SET robots_index=? WHERE id=?", [product.robots_index, product.id]);
  }
});

test("canonical-адрес с другого домена не попадает в sitemap", async () => {
  const product = await db.get("SELECT id,slug,canonical_url FROM store_products WHERE status='published' ORDER BY id LIMIT 1");
  assert.ok(product?.id);
  const externalCanonical = "https://external.example/" + product.slug;
  await db.run("UPDATE store_products SET canonical_url=? WHERE id=?", [externalCanonical, product.id]);
  try {
    const response = await fetch(`${base}/sitemap.xml`);
    assert.equal(response.status, 200);
    const xml = await response.text();
    assert.equal(xml.includes(externalCanonical), false);
  } finally {
    await db.run("UPDATE store_products SET canonical_url=? WHERE id=?", [product.canonical_url, product.id]);
  }
});

test("новый посетитель создаётся только с согласием и входит по e-mail-коду", async () => {
  const email = "visitor@example.ru";
  const denied = await call("/api/auth/request-code", { method:"POST", body:{ email, pd_consent:false } });
  assert.equal(denied.status, 400);

  const requested = await call("/api/auth/request-code", { method:"POST", body:{ email, full_name:"Гость VAPELAB", pd_consent:true } });
  assert.equal(requested.status, 200);
  const visitor = await db.get("SELECT * FROM users WHERE email=?", [email]);
  assert.equal(visitor.role, "visitor");
  assert.equal(visitor.email_verified, 0);

  const code = await issueCode(visitor.id, "email");
  const wrong = await call("/api/auth/verify-code", { method:"POST", body:{ email, code:"000000" } });
  assert.equal(wrong.status, 400);
  const verified = await call("/api/auth/verify-code", { method:"POST", body:{ email, code } });
  assert.equal(verified.status, 200);
  assert.equal(verified.data.user.role, "visitor");
  assert.ok(verified.data.access_token);
  assert.equal((await call("/api/auth/me", { token:verified.data.access_token })).data.role, "visitor");
  assert.equal((await call("/api/stats", { token:verified.data.access_token })).status, 403);
});


test("один OTP не может быть использован для двух одновременных входов", async () => {
  const admin = await db.get("SELECT id FROM users WHERE email=?", ["andycoulbot@gmail.com"]);
  const code = await issueCode(admin.id, "email");
  const results = await Promise.all([
    consumeCode(admin.id, "email", code),
    consumeCode(admin.id, "email", code),
  ]);
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.equal(results.filter((item) => !item.ok).length, 1);
});

test("старый вход по паролю отключён", async () => {
  const res = await call("/api/auth/login", { method:"POST", body:{ email:"andycoulbot@gmail.com", password:"anything" } });
  assert.equal(res.status, 410);
});

test("администратор создаёт менеджеров, но не может выдать роль главного администратора", async () => {
  const created = await call("/api/users", { method:"POST", token:adminToken, body:{ email:"manager@vaplab.ru", full_name:"Менеджер VAPELAB", role:"manager" } });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.role, "manager");
  assert.equal(created.data.email_sent, true);
  const forbiddenRole = await call("/api/users", { method:"POST", token:adminToken, body:{ email:"bad-andycoulbot@gmail.com", role:"superadmin" } });
  assert.equal(forbiddenRole.status, 201);
  assert.equal(forbiddenRole.data.user.role, "manager", "нельзя назначить superadmin через форму приглашения");
  const users = await call("/api/users", { token:adminToken });
  assert.ok(users.data.some((item)=>item.email==="manager@vaplab.ru"));
  assert.ok(users.data.every((item)=>item.role!=="superadmin" && item.email!=="andycoulbot@gmail.com"));
  const adminProfile = await call("/api/auth/me", { token:adminToken });
  assert.equal(adminProfile.data.email, "");
  assert.equal(adminProfile.data.full_name, "Рабочий аккаунт");
  assert.equal(adminProfile.data.role, "superadmin", "внутренняя роль остаётся неизменной для разграничения прав");
  const manager = await db.get("SELECT * FROM users WHERE email=?", ["manager@vaplab.ru"]);
  const managerCode = await issueCode(manager.id,"email");
  const managerLogin = await call("/api/auth/verify-code",{method:"POST",body:{email:"manager@vaplab.ru",code:managerCode}});
  assert.equal(managerLogin.status,200);
  const managerToken = managerLogin.data.access_token;
  assert.equal((await call("/api/store/admin",{token:managerToken})).status,200);
  assert.equal((await call("/api/users",{token:managerToken})).status,200);
  assert.equal((await call("/api/audit",{token:managerToken})).status,200);
  assert.equal((await call("/api/analytics/summary",{token:managerToken})).status,200);
  // Manager 1 appoints Manager 2. Both have equal workspace permissions,
  // but only the ancestor may remove a descendant from their team tree.
  const childCreated = await call("/api/users",{method:"POST",token:managerToken,body:{email:"manager2@vaplab.ru",full_name:"Менеджер 2",role:"manager"}});
  assert.equal(childCreated.status,201);
  const child = await db.get("SELECT * FROM users WHERE email=?",["manager2@vaplab.ru"]);
  assert.equal(Number(child.invited_by),Number(manager.id));
  const childLoginCode = await issueCode(child.id,"email");
  const childLogin = await call("/api/auth/verify-code",{method:"POST",body:{email:"manager2@vaplab.ru",code:childLoginCode}});
  assert.equal(childLogin.status,200);
  const childToken = childLogin.data.access_token;
  assert.equal((await call("/api/users",{token:childToken})).status,200);
  assert.equal((await call("/api/store/admin",{token:childToken})).status,200);
  const grandchildCreated = await call("/api/users",{method:"POST",token:childToken,body:{email:"manager3@vaplab.ru",full_name:"Менеджер 3",role:"manager"}});
  assert.equal(grandchildCreated.status,201);
  const grandchild = await db.get("SELECT * FROM users WHERE email=?",["manager3@vaplab.ru"]);
  assert.equal(Number(grandchild.invited_by),Number(child.id));
  const parentInChildList = (await call("/api/users",{token:childToken})).data.find((item)=>Number(item.id)===Number(manager.id));
  assert.equal(parentInChildList.can_manage,false,"подчинённый не может управлять назначившим его менеджером");
  assert.equal((await call(`/api/users/${manager.id}`,{method:"DELETE",token:childToken})).status,403);
  const parentTeam = (await call("/api/users",{token:managerToken})).data;
  const childInParentList = parentTeam.find((item)=>Number(item.id)===Number(child.id));
  const grandchildInParentList = parentTeam.find((item)=>Number(item.id)===Number(grandchild.id));
  assert.equal(childInParentList.can_manage,true,"назначивший менеджер может управлять своим подчинённым");
  assert.equal(grandchildInParentList.can_manage,true,"руководитель может управлять всей своей веткой, включая следующие уровни");
  const removed = await call(`/api/users/${child.id}`,{method:"DELETE",token:managerToken});
  assert.equal(removed.status,200);
  const removedRow = await db.get("SELECT is_active,deleted_at FROM users WHERE id=?",[child.id]);
  assert.equal(Number(removedRow.is_active),0);
  assert.ok(removedRow.deleted_at,"удаление сохраняется как мягкое удаление для сохранения истории CRM");
  const afterRemoval = (await call("/api/users",{token:managerToken})).data;
  assert.ok(!afterRemoval.some((item)=>Number(item.id)===Number(child.id)));
  assert.ok(afterRemoval.some((item)=>Number(item.id)===Number(grandchild.id)),"подчинённый менеджер сохраняется");
  const reparentedGrandchild = await db.get("SELECT invited_by FROM users WHERE id=?",[grandchild.id]);
  assert.equal(Number(reparentedGrandchild.invited_by),Number(manager.id),"команда удалённого менеджера переходит к его руководителю");
});

test("смена ADMIN_EMAIL оставляет только одного главного администратора", async () => {
  const previous = await db.get("SELECT id FROM users WHERE email=?", ["manager@vaplab.ru"]);
  assert.ok(previous);
  await db.run("UPDATE users SET role='superadmin' WHERE id=?", [previous.id]);
  await ensureAdmin();
  const roles = await db.all("SELECT email,role FROM users WHERE role='superadmin'");
  assert.deepEqual(roles.map((item) => item.email), ["andycoulbot@gmail.com"]);
  const oldAccount = await db.get("SELECT role FROM users WHERE id=?", [previous.id]);
  assert.equal(oldAccount.role, "admin");
});

test("защищённые маршруты закрыты без токена", async () => {
  assert.equal((await call("/api/contacts")).status, 401);
});

test("каталог поддерживает SEO-отчёт и редактируемые поля", async () => {
  const admin = await call("/api/store/admin", { token:adminToken });
  assert.equal(admin.status, 200);
  const product = admin.data.products[0];
  assert.ok(product);
  const changed = await call(`/api/store/products/${product.id}`, { method:"PUT", token:adminToken, body:{ seo_h1:"Тестовый H1 VAPELAB", seo_title:"Тестовый title", seo_description:"Описание тестовой страницы", seo_keywords:["тестовый запрос"] } });
  assert.equal(changed.status, 200);
  const keyword = await call(`/api/store/products/${product.id}/keywords`, { method:"POST", token:adminToken, body:{ keyword:"товар запрос", frequency_class:"medium", search_volume:350, region:"Россия", search_engine:"Yandex", source:"Wordstat", checked_at:"2026-11-22" } });
  assert.equal(keyword.status, 201);
  const duplicateKeyword = await call(`/api/store/products/${product.id}/keywords`, { method:"POST", token:adminToken, body:{ keyword:" ТОВАР ЗАПРОС ", frequency_class:"high", search_volume:410, region:"Россия", search_engine:"Yandex", source:"Повторная проверка", checked_at:"2026-11-23" } });
  assert.equal(duplicateKeyword.status, 200);
  assert.equal(duplicateKeyword.data.id, keyword.data.id);
  assert.equal(duplicateKeyword.data.search_volume, 410);
  const report = await call(`/api/store/seo-report?q=${encodeURIComponent(product.name)}&page=1&page_size=10`, { token:adminToken });
  assert.equal(report.status, 200);
  assert.equal(report.data.products.length, 1);
  assert.equal(report.data.products[0].id, product.id);
  assert.ok(report.data.products[0].keyword_targets.length >= 1);
  assert.equal(report.data.pagination.page_size, 10);
});

test("импорт XLSX/CSV включает товарную сущность с предварительным просмотром", async () => {
  const csv = [
    "Название товара;SKU;Категория;Бренд;Описание;H1;SEO Title;SEO Description;Ключевые слова;Частотность;Класс частотности;URL изображения;Поисковая система;Регион частотности;Намерение запроса;Источник частотности;Дата проверки частотности;Canonical URL;Разрешить индексацию: 1 / 0",
    "Тестовая позиция VAPELAB;TEST-001;Тестовая категория;Demo;Описание для теста;Тестовый H1;Тестовый Title;Описание SEO;тестовый ключ;140;medium;https://example.com/test.jpg;Yandex;Россия;commercial;Wordstat;2026-11-22;https://vapelab.example/product/test;0",
  ].join("\n");
  const response = await fetch(`${base}/api/import/preview?entity=products`, { method:"POST", headers:{ Authorization:`Bearer ${adminToken}`, "Content-Type":"text/csv", "X-File-Name":"products.csv" }, body:csv });
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.entity, "products");
  assert.ok(Object.values(preview.mapping).includes("name"));
  const dry = await call("/api/import/apply", { method:"POST", token:adminToken, body:{ id:preview.id, mapping:preview.mapping, dry_run:true } });
  assert.equal(dry.status, 200);
  assert.equal(dry.data.created, 1);
  const applied = await call("/api/import/apply", { method:"POST", token:adminToken, body:{ id:preview.id, mapping:preview.mapping } });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.created, 1);
  const store = await call("/api/store/admin", { token:adminToken });
  const imported = store.data.products.find((p)=>p.sku==="TEST-001");
  assert.ok(imported);
  assert.equal(imported.status, "draft");
  assert.equal(imported.seo_h1, "Тестовый H1");
  assert.equal(imported.seo_description, "Описание SEO", "SEO Description не должен попасть в обычное описание");
  assert.equal(imported.images.length, 1);
  assert.equal(imported.canonical_url, "https://vapelab.example/product/test");
  assert.equal(imported.robots_index, 0);
  assert.equal(imported.keyword_targets.length, 1);
  assert.equal(imported.keyword_targets[0].search_engine, "Yandex");
  assert.equal(imported.keyword_targets[0].region, "Россия");
  assert.equal(imported.keyword_targets[0].search_intent, "commercial");
  assert.equal(imported.keyword_targets[0].source, "Wordstat");
  assert.equal(imported.keyword_targets[0].checked_at, "2026-11-22");

  const repeatCsv = [
    "Название товара;SKU;Ключевые слова;Частотность;Класс частотности;Поисковая система;Регион частотности;Источник частотности;Дата проверки частотности",
    "Тестовая позиция VAPELAB;TEST-001;ТЕСТОВЫЙ КЛЮЧ;225;high;Yandex;Россия;Повторный Wordstat;2026-11-23",
  ].join("\n");
  const repeatResponse = await fetch(`${base}/api/import/preview?entity=products`, { method:"POST", headers:{ Authorization:`Bearer ${adminToken}`, "Content-Type":"text/csv", "X-File-Name":"products-repeat.csv" }, body:repeatCsv });
  assert.equal(repeatResponse.status, 200);
  const repeatPreview = await repeatResponse.json();
  const repeated = await call("/api/import/apply", { method:"POST", token:adminToken, body:{ id:repeatPreview.id, mapping:repeatPreview.mapping } });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.updated, 1);
  const refreshed = await call("/api/store/admin", { token:adminToken });
  const repeatedProduct = refreshed.data.products.find((item)=>item.sku==="TEST-001");
  assert.equal(repeatedProduct.keyword_targets.length, 1, "повторный импорт не должен создавать дубликат ключевой фразы");
  assert.equal(repeatedProduct.keyword_targets[0].search_volume, 225);
  assert.equal(repeatedProduct.keyword_targets[0].frequency_class, "high");
});

test("ручное сопоставление импортируемого файла не позволяет молча перезаписать колонку товара", async () => {
  const csv = "Название товара;Второе название\nТест дублей;Дубль";
  const response = await fetch(`${base}/api/import/preview?entity=products`, {
    method:"POST", headers:{ Authorization:`Bearer ${adminToken}`, "Content-Type":"text/csv", "X-File-Name":"duplicate-mapping.csv" }, body:csv,
  });
  assert.equal(response.status, 200);
  const preview = await response.json();
  const result = await call("/api/import/apply", { method:"POST", token:adminToken, body:{ id:preview.id, mapping:{ "0":"name", "1":"name" }, dry_run:true } });
  assert.equal(result.status, 400);
  assert.match(result.data.detail, /назначено нескольким колонкам/);
});

test("XLSX импортирует товары, SEO-поля и изображения из таблицы", async () => {
  const xlsx = fs.readFileSync(new URL("./fixtures/vapelab-products.xlsx", import.meta.url));
  const response = await fetch(`${base}/api/import/preview?entity=products`, {
    method:"POST",
    headers:{ Authorization:`Bearer ${adminToken}`, "Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "X-File-Name":"vapelab-products.xlsx" },
    body:xlsx,
  });
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.entity, "products");
  assert.ok(Object.values(preview.mapping).includes("name"));
  assert.equal(preview.total, 1);
  const imported = await call("/api/import/apply", { method:"POST", token:adminToken, body:{ id:preview.id, mapping:preview.mapping } });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.created, 1);
  const store = await call("/api/store/admin", { token:adminToken });
  const product = store.data.products.find((item)=>item.sku==="XLSX-TEST-001");
  assert.ok(product);
  assert.equal(product.status,"draft");
  assert.equal(product.seo_h1,"Тестовый H1");
  assert.equal(product.images.length,1);
  assert.ok(product.category_ids?.length >= 1);
  assert.equal(product.variants.length,1);
  assert.equal(product.variants[0].attributes.color,"Графитовый");
});

test("ошибка JSON варианта не создаёт ни товар, ни пустую категорию", async () => {
  const csv = [
    "Название товара;Категория;Бренд;Атрибуты варианта JSON",
    "Невалидная позиция VAPELAB;Категория не должна появиться;Demo;{broken-json",
  ].join("\n");
  const response = await fetch(`${base}/api/import/preview?entity=products`, { method:"POST", headers:{ Authorization:`Bearer ${adminToken}`, "Content-Type":"text/csv", "X-File-Name":"invalid-variant.csv" }, body:csv });
  assert.equal(response.status, 200);
  const preview = await response.json();
  const variantColumn = preview.headers.findIndex((header) => String(header).trim() === "Атрибуты варианта JSON");
  assert.ok(variantColumn >= 0);
  const mapping = { ...preview.mapping, [variantColumn]: "variant_attributes_json" };
  const applied = await call("/api/import/apply", { method:"POST", token:adminToken, body:{ id:preview.id, mapping } });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.created, 0);
  assert.equal(applied.data.skipped, 1);
  assert.equal(await db.get("SELECT id FROM store_products WHERE name=?", ["Невалидная позиция VAPELAB"]), null);
  assert.equal(await db.get("SELECT id FROM store_categories WHERE name=?", ["Категория не должна появиться"]), null);
});

test("импорт не объединяет товары с похожим названием, но разными брендами", async () => {
  const csv = [
    "Название товара;Бренд;Тип товара;Формат",
    "Одинаковое модельное имя VAPELAB;Brand A;Устройство;Graphite",
    "Одинаковое модельное имя VAPELAB;Brand B;Устройство;Silver",
  ].join("\n");
  const response = await fetch(`${base}/api/import/preview?entity=products`, { method:"POST", headers:{ Authorization:`Bearer ${adminToken}`, "Content-Type":"text/csv", "X-File-Name":"similar-products.csv" }, body:csv });
  assert.equal(response.status, 200);
  const preview = await response.json();
  const applied = await call("/api/import/apply", { method:"POST", token:adminToken, body:{ id:preview.id, mapping:preview.mapping } });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.created, 2);
  const products = await db.all("SELECT brand,format FROM store_products WHERE name=? ORDER BY brand", ["Одинаковое модельное имя VAPELAB"]);
  assert.deepEqual(products.map((item)=>[item.brand,item.format]), [["Brand A","Graphite"],["Brand B","Silver"]]);
});

test("поиск изображений без Yandex API предлагает локальный Qwen-процесс", async () => {
  const response = await call("/api/store/images/search?query=Test%20Product", { token:adminToken });
  assert.equal(response.status, 200);
  assert.equal(response.data.provider, "local-qwen");
  assert.equal(response.data.results.length, 0);
  assert.match(response.data.guidance, /Qwen Code/i);
  assert.doesNotMatch(response.data.guidance, /YANDEX_SEARCH_API_KEY/);
});

test("логотип и favicon VAPELAB раздаются как статические файлы", async () => {
  const logo = await fetch(`${base}/assets/brand/vapelab-logo.webp`);
  assert.equal(logo.status,200);
  assert.match(logo.headers.get("content-type"),/image\/webp/);
  const favicon = await fetch(`${base}/assets/brand/favicon-32.png`);
  assert.equal(favicon.status,200);
  assert.match(favicon.headers.get("content-type"),/image\/png/);
});

test("клиенты, сделки и заказы создаются", async () => {
  const contact = await call("/api/contacts", {
    method: "POST", token: adminToken,
    body: { full_name: "Иванов Иван", phone: "+79161234567", pd_consent: true },
  });
  assert.equal(contact.status, 201);
  assert.equal(contact.data.pd_consent, 1);

  const deal = await call("/api/deals", { method: "POST", token: adminToken, body: { title: "Пилот", amount: 150000, contact_id: contact.data.id } });
  const moved = await call(`/api/deals/${deal.data.id}`, { method: "PATCH", token: adminToken, body: { stage: "won" } });
  assert.equal(moved.data.stage, "won");

  const order = await call("/api/orders", {
    method: "POST", token: adminToken,
    body: { contact_id: contact.data.id, items: [{ name: "Час работ", quantity: 10, price: 4500 }] },
  });
  assert.equal(order.data.total, 45000);
  assert.equal(order.data.items.length, 1);

  const found = await call("/api/search?q=Иванов", { token: adminToken });
  assert.ok(found.data.contacts.length >= 1);
});

test("клиент пишет в Telegram — сотрудник отвечает из CRM", async () => {
  const hook = await call("/api/webhooks/telegram/telegram-secret", {
    method: "POST",
    body: { message: { message_id: 10, chat: { id: 4242 }, from: { first_name: "Мария", last_name: "Петрова" }, text: "Здравствуйте!" } },
  });
  assert.equal(hook.data.ingested, 1);

  const list = await call("/api/inbox/conversations?channel=telegram", { token: adminToken });
  const conv = list.data.find((c) => c.external_chat_id === "4242");
  assert.equal(conv.unread_count, 1);
  assert.equal(conv.contact_name, "Мария Петрова");

  const reply = await call(`/api/inbox/conversations/${conv.id}/reply`, {
    method: "POST", token: adminToken, body: { body: "Здравствуйте! Отправлю КП сегодня." },
  });
  assert.equal(reply.data.direction, "outbound");

  const detail = await call(`/api/inbox/conversations/${conv.id}`, { token: adminToken });
  assert.equal(detail.data.messages.length, 2);
  assert.equal(detail.data.unread_count, 0);
});

test("повторное сообщение попадает в тот же диалог", async () => {
  await call("/api/webhooks/telegram/telegram-secret", {
    method: "POST",
    body: { message: { message_id: 11, chat: { id: 4242 }, from: { first_name: "Мария" }, text: "Жду!" } },
  });
  const list = await call("/api/inbox/conversations?channel=telegram", { token: adminToken });
  assert.equal(list.data.filter((c) => c.external_chat_id === "4242").length, 1);
});

test("вебхук с неверным секретом отклоняется", async () => {
  assert.equal((await call("/api/webhooks/telegram/wrong-secret", { method: "POST", body: {} })).status, 403);
});

test("журнал действий фиксирует доступ к персональным данным", async () => {
  const log = await call("/api/audit", { token: adminToken });
  assert.equal(log.status, 200);
  assert.ok(log.data.some((r) => r.entity === "contact"));
});

test("оптовая страница опубликована по умолчанию и доступна без дополнительной ручной публикации", async () => {
  const page = await db.get("SELECT status,legal_review_status FROM store_pages WHERE slug='optovy'");
  assert.equal(page?.status, "published");
  const response = await fetch(`${base}/optovy`, { headers: { Accept: "text/html" } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Оптовое направление VAPELAB/);
});

test("поставка импортируется из CSV, сохраняет накладную и увеличивает найденный остаток", async () => {
  const product = await db.run(
    "INSERT INTO products (sku,name,price,vat_rate,unit,stock,marking_required,is_active) VALUES (?,?,?,?,?,?,?,?)",
    ["SUPPLY-SKU-TEST", "Тестовый товар для поставки", 250, 20, "шт", 2, 0, 1]
  );
  const csv = [
    "Артикул;Наименование товара;Количество;Ед.;Закупочная цена;Сумма;НДС",
    "SUPPLY-SKU-TEST;Тестовый товар для поставки;3;шт;100;300;20",
  ].join("\n");
  const previewResponse = await fetch(`${base}/api/supplies/preview`, {
    method: "POST",
    headers: { "Content-Type": "text/csv; charset=utf-8", "X-File-Name": "nakladnaya.csv", Authorization: `Bearer ${adminToken}` },
    body: Buffer.from(csv, "utf8"),
  });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.total_rows, 1);
  assert.equal(preview.mapping.name, 1);
  const response = await call("/api/supplies", { method: "POST", token: adminToken, body: {
    preview_id: preview.preview_id,
    supplier_name: "Тестовый поставщик",
    invoice_number: "ТЕСТ-001",
    invoice_date: "2026-11-23",
    mapping: preview.mapping,
  } });
  assert.equal(response.status, 201);
  assert.equal(response.data.item_count, 1);
  assert.equal(response.data.matched_items, 1);
  assert.equal(response.data.items[0].purchase_price, 100);
  const stock = await db.get("SELECT stock,price FROM products WHERE id=?", [product.lastId]);
  assert.equal(Number(stock.stock), 5);
  assert.equal(Number(stock.price), 250, "закупочная цена не должна менять розничную");
  const listed = await call("/api/supplies", { token: adminToken });
  assert.ok(listed.data.some((item) => item.id === response.data.id));
});

test("публичная витрина отдаёт категории, подтверждённые карточки и публикации", async () => {
  const res = await call("/api/store/public");
  assert.equal(res.status, 200);
  assert.ok(res.data.categories.filter((category) => !category.parent_id).length >= 18);
  assert.ok(res.data.categories.filter((category) => category.parent_id).length >= 5);
  assert.ok(res.data.products.some((p) => p.slug === "ci-test-product-a" && p.price_raw === "100 ₽"));
  assert.ok(res.data.products.some((p) => p.slug === "ci-test-product-b"));
  assert.ok(!res.data.products.some((p) => p.slug === "ci-test-draft"));
  assert.ok(res.data.news.some((item) => item.slug === "ci-test-news"));
  assert.ok(!res.data.news.some((item) => item.slug === "ci-test-news-draft"));
});

test("управление витриной закрыто без авторизации", async () => {
  assert.equal((await call("/api/store/admin")).status, 401);
});

test("CRM управляет карточками витрины без публикации черновиков", async () => {
  const admin = await call("/api/store/admin", { token: adminToken });
  assert.equal(admin.status, 200);
  assert.ok(admin.data.categories.filter((category) => !category.parent_id).length >= 18);
  assert.ok(admin.data.categories.filter((category) => category.parent_id).length >= 5);
  const draft = await call("/api/store/products", {
    method: "POST", token: adminToken,
    body: { name: "Тестовая карточка", slug: "test-store-product", status: "draft", price_raw: "Цена не указана" },
  });
  assert.equal(draft.status, 201);
  let publicData = await call("/api/store/public");
  assert.equal(publicData.data.products.some((p) => p.slug === "test-store-product"), false);
  const published = await call(`/api/store/products/${draft.data.id}`, {
    method: "PUT", token: adminToken, body: { status: "published" },
  });
  assert.equal(published.status, 200);
  publicData = await call("/api/store/public");
  assert.equal(publicData.data.products.some((p) => p.slug === "test-store-product"), true);
});

test("цветовые варианты показываются текстовыми кнопками и сохраняют связь с фото и заявкой", async () => {
  const suffix = Date.now().toString(36);
  const slug = `test-color-variants-${suffix}`;
  const created = await call("/api/store/products", { method: "POST", token: adminToken, body: {
    name: "Тестовая модель с цветами", slug, brand: "Test", product_type: "Тестовое устройство",
    price_raw: "2 500 ₽", status: "published", is_reservable: true, robots_index: true,
  } });
  assert.equal(created.status, 201);
  const productId = Number(created.data.id);
  const blueImage = await db.run("INSERT INTO store_product_images(product_id,url_original,alt_raw,position,source_url,download_status) VALUES(?,?,?,?,?,?)", [productId, "https://images.example.test/blue.jpg", "Тестовая модель — Синий", 0, "https://images.example.test/source", "unverified"]);
  const greenImage = await db.run("INSERT INTO store_product_images(product_id,url_original,alt_raw,position,source_url,download_status) VALUES(?,?,?,?,?,?)", [productId, "https://images.example.test/green.jpg", "Тестовая модель — Зелёный", 1, "https://images.example.test/source", "unverified"]);
  const unsupported = await call(`/api/store/products/${productId}`, { method: "PUT", token: adminToken, body: { variants: [] } });
  assert.equal(unsupported.status, 400);
  const blue = await call(`/api/store/products/${productId}/variants`, { method: "POST", token: adminToken, body: { name: "Синий", color: "Синий", sku: `TEST-BLUE-${suffix}`, price_raw: "2 500 ₽" } });
  const green = await call(`/api/store/products/${productId}/variants`, { method: "POST", token: adminToken, body: { name: "Зелёный", color: "Зелёный", sku: `TEST-GREEN-${suffix}`, price_raw: "2 700 ₽" } });
  assert.equal(blue.status, 201); assert.equal(green.status, 201);
  assert.equal((await call(`/api/store/products/${productId}/images/${blueImage.lastId}`, { method: "PUT", token: adminToken, body: { variant_id: blue.data.id } })).status, 200);
  assert.equal((await call(`/api/store/products/${productId}/images/${greenImage.lastId}`, { method: "PUT", token: adminToken, body: { variant_id: green.data.id } })).status, 200);
  const variants = await db.all("SELECT * FROM store_product_variants WHERE product_id=? ORDER BY sort_order,id", [productId]);
  assert.equal(variants.length, 2);
  const images = await db.all("SELECT id,variant_id,url_original FROM store_product_images WHERE product_id=? ORDER BY id", [productId]);
  assert.equal(Number(images[0].variant_id), Number(variants[0].id));
  assert.equal(Number(images[1].variant_id), Number(variants[1].id));
  const admin = await call("/api/store/admin?page=1&page_size=100", { token: adminToken });
  assert.equal(admin.status, 200);
  const adminProduct = admin.data.products.find((item) => Number(item.id) === productId);
  assert.equal(adminProduct.variants.length, 2);
  assert.ok(adminProduct.images.every((image) => image.id && image.variant_id));
  const page = await fetch(`${base}/product/${slug}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-variant-id=/);
  assert.match(html, />Синий<\/span>/);
  assert.match(html, />Зелёный<\/span>/);
  assert.match(html, /data-gallery-images=/);
  assert.doesNotMatch(html, /<h2>Варианты<\/h2>/);

  const reservation = await call("/api/store/reservations", { method: "POST", body: {
    product_id: productId, variant_id: variants[1].id, customer_name: "Тестовый клиент", phone: "+70000000000",
    quantity: 2, pd_consent: true, source_path: `/product/${slug}`,
  } });
  assert.equal(reservation.status, 201);
  const savedReservation = await db.get("SELECT * FROM store_reservations WHERE number=?", [reservation.data.number]);
  assert.equal(Number(savedReservation.variant_id), Number(variants[1].id));
  assert.equal(savedReservation.variant_name, "Зелёный");
  assert.equal(savedReservation.variant_image_url, "https://images.example.test/green.jpg");
  assert.equal(Number(savedReservation.unit_price_minor), 270000);
  assert.equal(Number(savedReservation.total_price_minor), 540000);
});

