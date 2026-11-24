/**
 * Эксплуатационный контур: живость, готовность, метрики, вложения и планировщик.
 * Это то, на что смотрит дежурный и балансировщик, а не пользователь.
 */
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rucrm-ops-test-"));
process.env.DATA_DIR = workDir;
process.env.STORAGE_DIR = path.join(workDir, "files");
process.env.BACKUP_DIR = path.join(workDir, "backups");
process.env.SECRET_KEY = "test-secret";

const { createServer, shutdown } = await import("../server/index.js");
const { db } = await import("../server/db.js");
const { issueCode } = await import("../server/auth.js");
const { schedule, listJobs, stopAll, trigger } = await import("../server/scheduler.js");

const server = await createServer();
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://localhost:${server.address().port}`;

let token;

before(async () => {
  const user = await db.get("SELECT * FROM users WHERE email=?", ["andycoulbot@gmail.com"]);
  const code = await issueCode(user.id, "email");
  const res = await fetch(`${base}/api/auth/verify-code`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email:"andycoulbot@gmail.com", code }),
  });
  token = (await res.json()).access_token;
});

after(async () => {
  stopAll();
  await shutdown(server, "test");
  await fsp.rm(workDir, { recursive: true, force: true });
});

/* ---------- проверки для балансировщика ---------- */

test("живость отделена от готовности", async () => {
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.status, "ok");
  assert.ok(healthBody.uptime_seconds >= 0);

  const ready = await fetch(`${base}/api/ready`);
  assert.equal(ready.status, 200);
  const readyBody = await ready.json();
  assert.equal(readyBody.status, "ready");
  assert.equal(readyBody.checks.database.ok, true);
  assert.equal(readyBody.checks.database.kind, "sqlite");
  assert.equal(readyBody.checks.storage.ok, true);
  assert.equal(readyBody.checks.schema.ok, true);
  assert.ok(readyBody.checks.schema.applied >= 2, "схема должна быть накачена до последней версии");
});

test("каждый ответ помечен идентификатором запроса", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.match(res.headers.get("x-request-id"), /^[0-9a-f]{16}$/);

  const own = await fetch(`${base}/api/health`, { headers: { "X-Request-Id": "trace-123" } });
  assert.equal(own.headers.get("x-request-id"), "trace-123", "внешний идентификатор должен сохраняться");
});

test("метрики отдаются в формате Prometheus", async () => {
  await fetch(`${base}/api/health`);
  const res = await fetch(`${base}/api/metrics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/plain/);

  const body = await res.text();
  assert.match(body, /# TYPE http_requests_total counter/);
  assert.match(body, /http_requests_total\{method="GET",route="\/api\/health",status="200"\}/);
  assert.match(body, /# TYPE http_request_duration_seconds histogram/);
  assert.match(body, /http_request_duration_seconds_bucket\{[^}]*le="0.3"\}/, "нужна корзина 300 мс из плана");
  assert.match(body, /db_query_duration_seconds_bucket/);
  assert.match(body, /app_ready 1/);
});

test("идентификаторы в пути не размножают временные ряды", async () => {
  await fetch(`${base}/api/contacts/1`, { headers: { Authorization: `Bearer ${token}` } });
  await fetch(`${base}/api/contacts/2`, { headers: { Authorization: `Bearer ${token}` } });

  const body = await (await fetch(`${base}/api/metrics`)).text();
  assert.match(body, /route="\/api\/contacts\/:id"/);
  assert.ok(!/route="\/api\/contacts\/1"/.test(body), "конкретный идентификатор не должен попадать в метку");
});

/* ---------- вложения ---------- */

test("вложение загружается, скачивается и удаляется", async () => {
  const content = Buffer.from("Коммерческое предложение для ООО «Ромашка»", "utf8");

  const upload = await fetch(`${base}/api/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/pdf",
      "X-File-Name": encodeURIComponent("КП Ромашка.pdf"),
      "X-Entity": "deal",
      "X-Entity-Id": "1",
    },
    body: content,
  });
  assert.equal(upload.status, 201);

  const attachment = await upload.json();
  assert.equal(attachment.filename, "КП Ромашка.pdf");
  assert.equal(attachment.size, content.length);
  assert.equal(attachment.backend, "local");
  assert.match(attachment.checksum, /^[0-9a-f]{64}$/);
  assert.equal(attachment.url, `/api/files/${attachment.id}`);

  const download = await fetch(`${base}${attachment.url}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /attachment; filename\*=UTF-8''/);
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.ok(Buffer.from(await download.arrayBuffer()).equals(content));

  const list = await fetch(`${base}/api/files?entity=deal&entity_id=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal((await list.json()).length, 1, "API отдаёт полезную нагрузку без обёртки");

  const removed = await fetch(`${base}${attachment.url}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(removed.status, 204);
  assert.equal((await fetch(`${base}${attachment.url}`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
});

test("вложение загружается формой multipart", async () => {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from("скан акта", "utf8")], { type: "text/plain" }), "акт.txt");

  const res = await fetch(`${base}/api/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  assert.equal(res.status, 201);
  const attachment = await res.json();
  assert.equal(attachment.filename, "акт.txt");
  assert.equal(attachment.size, Buffer.from("скан акта", "utf8").length);
});

test("исполняемый файл загрузить нельзя", async () => {
  const res = await fetch(`${base}/api/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent("вирус.exe"),
    },
    body: Buffer.from("MZ"),
  });
  assert.equal(res.status, 415);
});

test("вложения закрыты для неавторизованных", async () => {
  assert.equal((await fetch(`${base}/api/files`)).status, 401);
  assert.equal((await fetch(`${base}/api/files/1`)).status, 401);
});

/* ---------- планировщик ---------- */

test("задача выполняется и не запускается повторно поверх себя", async () => {
  let runs = 0;
  let concurrent = 0;
  let overlapped = false;

  schedule("тест", 3600_000, async () => {
    concurrent += 1;
    if (concurrent > 1) overlapped = true;
    await new Promise((r) => setTimeout(r, 20));
    concurrent -= 1;
    runs += 1;
  });

  assert.ok(listJobs().includes("тест"));
  await Promise.all([trigger("тест"), trigger("тест")]);

  assert.equal(overlapped, false, "параллельного запуска быть не должно");
  assert.ok(runs >= 1);
});

test("ошибка в задаче не роняет процесс", async () => {
  schedule("падающая", 3600_000, async () => {
    throw new Error("сбой внешнего сервиса");
  });
  await trigger("падающая"); // не должно выбросить наружу
  assert.ok(listJobs().includes("падающая"));
});

test("повторная регистрация задачи с тем же именем отвергается", () => {
  assert.throws(() => schedule("тест", 1000, async () => {}), /уже зарегистрирована/);
});
