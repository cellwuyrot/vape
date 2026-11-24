import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { routes, HttpError } from "../server/http.js";
import { config } from "../server/config.js";
import "../server/routes/mail.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("почтовый раздел CRM зарегистрирован и защищён авторизацией", async () => {
  const expected = [
    ["GET", "/api/mail/status"],
    ["GET", "/api/mail/folders"],
    ["GET", "/api/mail/messages"],
    ["GET", "/api/mail/messages/:uid"],
    ["POST", "/api/mail/send"],
    ["POST", "/api/mail/test"],
  ];
  for (const [method, pattern] of expected) {
    const route = routes.find((item) => item.method === method && item.regex.test(pattern.replace(":uid", "123")));
    assert.ok(route, `${method} ${pattern} exists`);
    assert.equal(route.auth, true);
    assert.match(read("server/routes/mail.js"), /\["superadmin", "admin", "manager"\]\.includes\(user\.role\)/);
  }
});

test("единый ящик по умолчанию использует домен vapelab.bond", () => {
  assert.equal(config.mailbox.address, "info@vapelab.bond");
  assert.equal(config.mailFrom, "info@vapelab.bond");
  assert.equal(config.mailbox.host, "mail.vapelab.bond");
  assert.equal(config.mailbox.serverIp, "178.253.16.19");
});

test("CRM содержит IMAP/SMTP mailbox client, не раскрывает настройки секрета", () => {
  const routesSource = read("server/routes/mail.js");
  const mailboxSource = read("server/mailbox.js");
  const uiSource = read("public/js/views/mail.js");
  const appSource = read("public/js/app.js");
  assert.match(routesSource, /adminOnly\(user\)/);
  assert.match(mailboxSource, /import\("imapflow"\)/);
  assert.match(mailboxSource, /import\("mailparser"\)/);
  assert.match(mailboxSource, /rejectUnauthorized:\s*true/);
  assert.match(uiSource, /\/mail\/messages/);
  assert.match(appSource, /label:\s*"Почта"/);
  assert.doesNotMatch(routesSource, /smtpUrl:\s*config\.smtpUrl/);
  assert.doesNotMatch(routesSource, /imapUrl:\s*config\.mailbox\.imapUrl/);
});

test("уведомления бронирований направляются в единый ящик", () => {
  const source = read("server/routes/reservations.js");
  assert.match(source, /sendEmail\(config\.mailbox\.address/);
  assert.doesNotMatch(source, /sendEmail\(config\.admin\.email/);
});

test("SMTP EHLO использует mail domain VAPELAB", () => {
  assert.match(read("server/smtp.js"), /EHLO vapelab\.bond/);
  assert.doesNotMatch(read("server/smtp.js"), /EHLO vapelab\.ru/);
});

test("почтовый сервер идёт отдельным compose stack с IMAPS, STARTTLS и persistent storage", () => {
  const compose = read("mail-server/compose.yaml");
  const env = read("mail-server/mailserver.env");
  assert.match(compose, /docker-mailserver:17\.0\.0/);
  for (const port of ["25:25", "465:465", "587:587", "993:993"]) assert.ok(compose.includes(port));
  assert.match(compose, /\.\/docker-data\/dms\/mail-data:\/var\/mail/);
  assert.match(env, /ENABLE_IMAP=1/);
  assert.match(env, /ENABLE_RSPAMD=1/);
  assert.match(env, /SSL_TYPE=letsencrypt/);
});
