/** IMAP-клиент единого почтового ящика; все секреты остаются только на сервере. */
import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import { config } from "./config.js";
import { sendEmail } from "./notify.js";

const safeError = (error) => String(error?.message || error || "ошибка соединения")
  .replace(/(password|pass|auth|token)=?[^\s,;]*/ig, "$1=[скрыто]")
  .slice(0, 220);
const asIso = (value) => {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
};

function parseImapUrl() {
  if (!config.mailbox.imapUrl) throw new Error("MAILBOX_IMAP_URL не задан");
  const url = new URL(config.mailbox.imapUrl);
  if (url.protocol !== "imaps:" || !url.hostname || !url.username || !url.password) {
    throw new Error("MAILBOX_IMAP_URL должен быть imaps://USER:PASSWORD@HOST:993");
  }
  return {
    host: url.hostname,
    port: Number(url.port || 993),
    secure: true,
    auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) },
    logger: false,
    tls: { rejectUnauthorized: true, servername: url.hostname },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  };
}

async function createClient() {
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow(parseImapUrl());
  await client.connect();
  return client;
}

async function withMailbox(folder, fn) {
  const client = await createClient();
  let lock;
  try {
    const folders = await client.list();
    const selected = folders.find((item) => item.path === folder);
    if (!selected) throw new Error("Почтовая папка не найдена");
    lock = await client.getMailboxLock(selected.path);
    return await fn(client, selected, folders);
  } finally {
    lock?.release();
    await client.logout().catch(() => {});
  }
}

export async function mailboxFolders() {
  const client = await createClient();
  try {
    const folders = await client.list();
    return folders.map((folder) => ({
      path: folder.path,
      name: folder.name || folder.path,
      specialUse: folder.specialUse || "",
      delimiter: folder.delimiter || "/",
    }));
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function mailboxMessages(folder = "INBOX", limit = 40) {
  return withMailbox(folder, async (client) => {
    const uids = await client.search({ all: true }, { uid: true });
    const selected = (uids || []).slice(-Math.max(1, Math.min(100, limit))).reverse();
    if (!selected.length) return [];
    const messages = await client.fetchAll(selected, {
      uid: true, envelope: true, flags: true, internalDate: true, size: true,
    }, { uid: true });
    return messages.map((message) => ({
      uid: message.uid,
      subject: message.envelope?.subject || "(без темы)",
      from: message.envelope?.from?.map((item) => item.name ? `${item.name} <${item.address}>` : item.address).join(", ") || "Неизвестный отправитель",
      to: message.envelope?.to?.map((item) => item.address).join(", ") || "",
      date: asIso(message.internalDate || message.envelope?.date),
      seen: Boolean(message.flags?.has?.("\\Seen") || [...(message.flags || [])].includes("\\Seen")),
      size: Number(message.size || 0),
    }));
  });
}

export async function mailboxMessage(folder, uid) {
  const parsedUid = Number(uid);
  if (!Number.isSafeInteger(parsedUid) || parsedUid < 1) throw new Error("Некорректный идентификатор письма");
  return withMailbox(folder, async (client) => {
    const message = await client.fetchOne(parsedUid, {
      uid: true, envelope: true, flags: true, internalDate: true, source: true,
    }, { uid: true });
    if (!message?.source) throw new Error("Письмо не найдено");
    const { simpleParser } = await import("mailparser");
    const parsed = await simpleParser(message.source);
    await client.messageFlagsAdd(parsedUid, ["\\Seen"], { uid: true }).catch(() => {});
    return {
      uid: parsedUid,
      subject: parsed.subject || message.envelope?.subject || "(без темы)",
      from: parsed.from?.text || "Неизвестный отправитель",
      to: parsed.to?.text || config.mailbox.address,
      date: asIso(parsed.date || message.internalDate),
      text: String(parsed.text || parsed.html?.replace(/<[^>]+>/g, " ") || "").slice(0, 100000),
    };
  });
}

const b64 = (value) => Buffer.from(String(value ?? ""), "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n").trim();
const encodedHeader = (value) => `=?UTF-8?B?${Buffer.from(String(value || ""), "utf8").toString("base64")}?=`;
const cleanHeader = (value) => String(value || "").replace(/[\r\n]+/g, " ").trim();

function buildRawMessage({ to, subject, text }) {
  return [
    `From: ${config.mailbox.address}`,
    `To: ${cleanHeader(to)}`,
    `Subject: ${encodedHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(16).slice(2)}@${config.mailbox.domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(text),
    "",
  ].join("\r\n");
}

export async function sendMailboxMessage({ to, subject, text }) {
  const recipient = String(to || "").trim().toLowerCase();
  const title = String(subject || "").trim();
  const body = String(text || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new Error("Укажите корректный адрес получателя");
  if (!title || title.length > 250) throw new Error("Тема обязательна и не должна превышать 250 символов");
  if (!body || body.length > 60000) throw new Error("Текст письма обязателен и не должен превышать 60 000 символов");
  const delivery = await sendEmail(recipient, title, body);
  if (!delivery.ok || delivery.dev) throw new Error(delivery.dev ? "SMTP не настроен: письмо не отправлено" : "SMTP-сервер не принял письмо");

  let savedInSent = false;
  try {
    const raw = buildRawMessage({ to: recipient, subject: title, text: body });
    await withMailbox("INBOX", async (client, _folder, folders) => {
      let sent = folders.find((item) => String(item.specialUse || "").toLowerCase() === "\\sent");
      if (!sent) sent = folders.find((item) => /^(sent|sent messages|отправленные)$/i.test(item.name || ""));
      if (!sent) {
        await client.mailboxCreate("Sent");
        sent = (await client.list()).find((item) => item.path === "Sent");
      }
      if (sent) {
        await client.append(sent.path, Buffer.from(raw, "utf8"), ["\\Seen"], new Date());
        savedInSent = true;
      }
    });
  } catch { /* отправка уже принята SMTP; отдельно сообщим, что копия не сохранилась */ }
  return { ok: true, savedInSent };
}

function checkTls(host, port, secure) {
  return new Promise((resolve) => {
    const socket = secure ? tls.connect({ host, port, servername: host, rejectUnauthorized: true }) : net.createConnection({ host, port });
    const timer = setTimeout(() => finish(false, "тайм-аут"), 7000);
    let finished = false;
    const finish = (ok, error = "") => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok, error: ok ? "" : safeError(error) });
    };
    socket.once(secure ? "secureConnect" : "connect", () => finish(true));
    socket.once("error", (error) => finish(false, error.message));
  });
}

async function dnsCheck() {
  const host = config.mailbox.host;
  const domain = config.mailbox.domain;
  const result = {};
  try {
    const records = await dns.resolve4(host);
    result.a = { ok: records.includes(config.mailbox.serverIp), records, expected: config.mailbox.serverIp };
  } catch (error) { result.a = { ok: false, error: safeError(error) }; }
  try {
    const records = await dns.resolveMx(domain);
    result.mx = { ok: records.some((record) => record.exchange.replace(/\.$/, "") === host), records };
  } catch (error) { result.mx = { ok: false, error: safeError(error) }; }
  try {
    const records = (await dns.resolveTxt(domain)).map((parts) => parts.join(""));
    const spf = records.find((record) => record.startsWith("v=spf1")) || "";
    result.spf = { ok: Boolean(spf), record: spf };
  } catch (error) { result.spf = { ok: false, error: safeError(error) }; }
  try {
    const records = (await dns.resolveTxt(`_dmarc.${domain}`)).map((parts) => parts.join(""));
    const dmarc = records.find((record) => record.startsWith("v=DMARC1")) || "";
    result.dmarc = { ok: Boolean(dmarc), record: dmarc };
  } catch (error) { result.dmarc = { ok: false, error: safeError(error) }; }
  try {
    const name = `${config.mailbox.dkimSelector}._domainkey.${domain}`;
    const records = (await dns.resolveTxt(name)).map((parts) => parts.join(""));
    result.dkim = { ok: records.some((record) => record.includes("v=DKIM1") && record.includes("p=")), recordsPresent: records.length > 0 };
  } catch (error) { result.dkim = { ok: false, error: safeError(error) }; }
  try {
    const ptr = await dns.reverse(config.mailbox.serverIp);
    const matches = ptr.some((name) => name.replace(/\.$/, "") === host);
    result.ptr = { ok: matches, records: ptr, expected: host };
  } catch (error) { result.ptr = { ok: false, error: safeError(error), expected: host }; }
  return result;
}

export async function mailboxStatus() {
  const dns = await dnsCheck();
  const imapTcp = config.mailbox.imapUrl
    ? await checkTls(config.mailbox.host, 993, true)
    : { ok: false, error: "MAILBOX_IMAP_URL не задан" };
  const smtpTcp = config.smtpUrl
    ? await checkTls(config.mailbox.host, 465, true)
    : { ok: false, error: "SMTP_URL не задан" };
  let imapAuth = { ok: false, error: "MAILBOX_IMAP_URL не задан" };
  if (config.mailbox.imapUrl) {
    try {
      const client = await createClient();
      await client.logout();
      imapAuth = { ok: true };
    } catch (error) { imapAuth = { ok: false, error: safeError(error) }; }
  }
  return {
    address: config.mailbox.address,
    host: config.mailbox.host,
    configured: Boolean(config.smtpUrl && config.mailbox.imapUrl),
    dns,
    smtp: { ...smtpTcp, port: 465 },
    imap: { ...imapAuth, tcp: imapTcp, port: 993 },
    note: "Проверка локального TCP/TLS и IMAP-входа не заменяет тест входящего SMTP с внешнего сервера и проверку DNSBL.",
  };
}
