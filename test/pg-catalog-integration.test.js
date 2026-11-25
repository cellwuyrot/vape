import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const databaseUrl = process.env.TEST_POSTGRES_URL || "";

test("PostgreSQL: каталог, поиск и статистика работают в отдельной схеме", { skip: !databaseUrl && "TEST_POSTGRES_URL не задан" }, async () => {
  const { createPostgresDriver } = await import("../server/drivers/postgres.js");
  const bootstrap = await createPostgresDriver({ url: databaseUrl, poolSize: 1 });
  const schema = `ci_catalog_${process.pid}_${Date.now()}`;
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "vapelab-pg-catalog-"));
  let db, server;
  try {
    await bootstrap.exec(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(databaseUrl);
    scoped.searchParams.set("search_path", schema);
    process.env.DATABASE_URL = scoped.toString();
    process.env.DATA_DIR = work;
    process.env.SECRET_KEY = "ci-only-catalog-secret";
    process.env.ADMIN_EMAIL = "catalog-ci@example.test";
    const database = await import("../server/db.js");
    db = database.db;
    const { createServer } = await import("../server/index.js");
    const { issueCode } = await import("../server/auth.js");
    server = await createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const category = await database.repo.insert("store_categories", { name:"CI категория", slug:"ci-pg-category", is_active:1 });
    const product = await database.repo.insert("store_products", { name:"CI товар", slug:"ci-pg-product", sku:"CI-PG-001", status:"published" });
    await db.run("INSERT INTO store_product_categories(product_id,category_id) VALUES (?,?)", [product.id, category.id]);
    const categoryPage = await fetch(`${base}/ci-pg-category`);
    assert.equal(categoryPage.status, 200);
    assert.match(await categoryPage.text(), /CI товар/);
    const directory = await fetch(`${base}/catalog/categories`);
    assert.equal(directory.status, 200);
    assert.match(await directory.text(), /CI категория/);
    const search = await fetch(`${base}/api/store/search?q=CI-PG-001`);
    assert.equal(search.status, 200);
    const result = await search.json();
    assert.ok((result.data || result).results.some((item) => item.slug === "ci-pg-product"));
    const admin = await db.get("SELECT id FROM users WHERE email=?", ["catalog-ci@example.test"]);
    const code = await issueCode(admin.id, "email");
    const auth = await fetch(`${base}/api/auth/verify-code`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ email:"catalog-ci@example.test", code }) });
    assert.equal(auth.status, 200);
    const token = (await auth.json()).access_token;
    const stats = await fetch(`${base}/api/stats`, { headers:{ Authorization:`Bearer ${token}` } });
    assert.equal(stats.status, 200);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) await db.close();
    await bootstrap.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await bootstrap.close();
    await fs.rm(work, { recursive:true, force:true });
  }
});
