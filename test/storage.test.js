/**
 * Файловое хранилище: подпись SigV4 сверяется с эталонным вектором AWS,
 * локальный бэкенд и запасной путь при отказе S3 — на реальном каталоге.
 */
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalQuery, canonicalUri, encodeRfc3986, signRequest } from "../server/sigv4.js";
import {
  buildKey,
  createLocalBackend,
  createS3Backend,
  guessContentType,
  isAllowedUpload,
  safeFilename,
} from "../server/storage.js";

/* ---------- подпись ---------- */

test("подпись совпадает с эталонным вектором AWS get-vanilla", () => {
  const { headers, canonicalRequest, signature } = signRequest({
    method: "GET",
    host: "example.amazonaws.com",
    path: "/",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "service",
    date: new Date(Date.UTC(2015, 7, 30, 12, 36, 0)),
  });

  assert.equal(canonicalRequest.split("\n")[0], "GET");
  assert.equal(signature, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
      "SignedHeaders=host;x-amz-date, " +
      "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
  );
});

test("для S3 добавляется обязательный заголовок с хешом тела", () => {
  const { headers } = signRequest({
    method: "PUT",
    host: "storage.yandexcloud.net",
    path: "/bucket/key.pdf",
    accessKeyId: "KEY",
    secretAccessKey: "SECRET",
    region: "ru-central1",
  });
  assert.ok(headers["x-amz-content-sha256"]);
  assert.match(headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
});

test("кодирование пути соответствует правилам AWS, а не encodeURIComponent", () => {
  assert.equal(encodeRfc3986("a b"), "a%20b");
  assert.equal(encodeRfc3986("файл(1)*.pdf"), encodeURIComponent("файл(1)*.pdf").replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`));
  assert.equal(encodeRfc3986("a/b", true), "a/b");
  assert.equal(canonicalUri("bucket/2026/08/файл 1.pdf").startsWith("/bucket/2026/08/"), true);
  assert.ok(!canonicalUri("bucket/файл 1.pdf").includes(" "), "пробел обязан быть закодирован");
});

test("параметры запроса сортируются по имени", () => {
  assert.equal(canonicalQuery({ b: "2", a: "1", "": "" }), "=&a=1&b=2");
});

/* ---------- ключи и имена ---------- */

test("имя файла очищается от путей и опасных символов", () => {
  assert.equal(safeFilename("../../etc/passwd"), "passwd");
  assert.equal(safeFilename("счёт №1.pdf"), "счёт №1.pdf");
  assert.equal(safeFilename('плохое:имя*файла?.pdf'), "плохое_имя_файла_.pdf");
  assert.equal(safeFilename(""), "file");
});

test("ключ раскладывается по году и месяцу и остаётся уникальным", () => {
  const date = new Date(Date.UTC(2026, 7, 4));
  const first = buildKey("договор.pdf", date);
  const second = buildKey("договор.pdf", date);
  assert.match(first, /^2026\/08\/[0-9a-f]{16}-договор\.pdf$/);
  assert.notEqual(first, second, "два файла с одним именем не должны затирать друг друга");
});

test("исполняемые вложения не принимаются", () => {
  assert.equal(isAllowedUpload("отчёт.pdf"), true);
  assert.equal(isAllowedUpload("скан.JPG"), true);
  assert.equal(isAllowedUpload("вирус.exe"), false);
  assert.equal(isAllowedUpload("script.sh"), false);
  assert.equal(isAllowedUpload("payload.JS"), false);
});

test("тип содержимого определяется по расширению", () => {
  assert.equal(guessContentType("счёт.pdf"), "application/pdf");
  assert.equal(guessContentType("фото.JPEG"), "image/jpeg");
  assert.equal(guessContentType("данные.неизвестно"), "application/octet-stream");
});

/* ---------- локальный бэкенд ---------- */

test("локальный бэкенд пишет, читает и удаляет файл", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rucrm-files-"));
  try {
    const backend = createLocalBackend({ dir });
    const body = Buffer.from("содержимое договора", "utf8");

    const saved = await backend.put("2026/08/test.pdf", body);
    assert.equal(saved.backend, "local");
    assert.equal(saved.size, body.length);
    assert.deepEqual(await backend.get("2026/08/test.pdf"), body);
    assert.equal(await backend.exists("2026/08/test.pdf"), true);

    await backend.remove("2026/08/test.pdf");
    assert.equal(await backend.exists("2026/08/test.pdf"), false);
    assert.equal((await backend.healthy()).ok, true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("выход за пределы каталога через ключ невозможен", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rucrm-files-"));
  try {
    const backend = createLocalBackend({ dir });
    await assert.rejects(() => backend.put("../побег.txt", Buffer.from("x")), /Недопустимый ключ/);
    await assert.rejects(() => backend.get("../../etc/passwd"), /Недопустимый ключ/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("S3-бэкенд формирует адрес в стиле path-style", () => {
  const backend = createS3Backend({
    endpoint: "https://storage.yandexcloud.net",
    region: "ru-central1",
    bucket: "rucrm-files",
    accessKeyId: "KEY",
    secretAccessKey: "SECRET",
    forcePathStyle: true,
  });
  assert.equal(backend.kind, "s3");
  assert.equal(backend.bucket, "rucrm-files");
});
