/** Почта VAPELAB: отдельный IMAP/SMTP ящик, доступный администраторам и менеджерам. */
import { get, post, HttpError, rateLimit } from "../http.js";
import { mailboxFolders, mailboxMessage, mailboxMessages, mailboxStatus, sendMailboxMessage } from "../mailbox.js";
import { sendEmail } from "../notify.js";
import { config } from "../config.js";

function adminOnly(user) {
  if (!user || !["superadmin", "admin", "manager"].includes(user.role)) throw new HttpError(403, "Раздел почты доступен администраторам и менеджерам");
}

function mailFailure(error) {
  const message = String(error?.message || "Ошибка почтового сервера");
  if (/не задан|должен быть|некорректный|обязателен|превышать|корректный адрес|не найдена/i.test(message)) {
    throw new HttpError(400, message);
  }
  throw new HttpError(502, `Почтовый сервер недоступен: ${message.slice(0, 180)}`);
}

get("/api/mail/status", async ({ user }) => {
  adminOnly(user);
  try { return { data: await mailboxStatus() }; }
  catch (error) { return mailFailure(error); }
}, { auth: true });

get("/api/mail/folders", async ({ user }) => {
  adminOnly(user);
  try { return { data: await mailboxFolders() }; }
  catch (error) { return mailFailure(error); }
}, { auth: true });

get("/api/mail/messages", async ({ user, query }) => {
  adminOnly(user);
  const folder = String(query.get("folder") || "INBOX").slice(0, 160);
  const limit = Math.max(1, Math.min(100, Number(query.get("limit") || 40) || 40));
  try { return { data: await mailboxMessages(folder, limit) }; }
  catch (error) { return mailFailure(error); }
}, { auth: true });

get("/api/mail/messages/:uid", async ({ user, params, query }) => {
  adminOnly(user);
  const folder = String(query.get("folder") || "INBOX").slice(0, 160);
  try { return { data: await mailboxMessage(folder, params.uid) }; }
  catch (error) { return mailFailure(error); }
}, { auth: true });

post("/api/mail/send", async ({ user, body, req }) => {
  adminOnly(user);
  rateLimit(`mail-send:${user.id}`, 20, 60 * 60_000);
  try {
    const result = await sendMailboxMessage({ to: body.to, subject: body.subject, text: body.text });
    return { data: result };
  } catch (error) { return mailFailure(error); }
}, { auth: true });

post("/api/mail/test", async ({ user, req }) => {
  adminOnly(user);
  rateLimit(`mail-test:${user.id}`, 3, 60 * 60_000);
  if (!config.smtpUrl) throw new HttpError(409, "SMTP_URL не настроен");
  const subject = "Проверка почты VAPELAB";
  const text = [
    "Это тестовое письмо почтовой системы VAPELAB.",
    `Ящик отправителя: ${config.mailbox.address}`,
    `Время отправки: ${new Date().toISOString()}`,
    "Если письмо получено, SMTP-аутентификация и передача сообщения сработали.",
  ].join("\n");
  const result = await sendEmail(user.email, subject, text);
  if (!result.ok || result.dev) throw new HttpError(502, "Тестовое письмо не отправлено: проверьте SMTP_URL и доступность сервера");
  return { data: { ok: true, to: user.email, acceptedBySmtp: true } };
}, { auth: true });
