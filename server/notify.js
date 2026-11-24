/**
 * Доставка кодов подтверждения.
 * Без настроенных провайдеров код печатается в лог сервера (режим разработки).
 * Для РФ используйте российских провайдеров и заключите договор поручения на обработку ПДн.
 */
import { config } from "./config.js";
import { log } from "./logger.js";
import { sendSmtpMail } from "./smtp.js";

export async function sendEmail(to, subject, text) {
  if (!config.smtpUrl) {
    log.info("notify.dev", { channel: "email", to, subject, text });
    return { ok: true, dev: true };
  }
  try {
    if (/^smtps?:\/\//i.test(config.smtpUrl)) {
      return await sendSmtpMail({ smtpUrl:config.smtpUrl, from:config.mailFrom, to, subject, text });
    }
    const headers = { "Content-Type": "application/json" };
    if (config.smtpApiKey) headers.Authorization = `Bearer ${config.smtpApiKey}`;
    const res = await fetch(config.smtpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        from_email: config.mailFrom,
        to,
        subject,
        text,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      log.warn("notify.email-failed", {
        to, status: res.status,
        error: payload?.detail || res.statusText,
      });
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (error) {
    log.warn("notify.email-failed", { to, error:error.message });
    return { ok:false };
  }
}

export async function sendSms(phone, text) {
  if (!config.smsUrl) {
    log.info("notify.dev", { channel: "sms", to: phone, text });
    return { ok: true, dev: true };
  }
  const url = config.smsUrl
    .replace("{phone}", encodeURIComponent(phone))
    .replace("{text}", encodeURIComponent(text));
  const res = await fetch(url).catch((err) => ({ ok: false, statusText: err.message }));
  return { ok: Boolean(res.ok) };
}

export async function sendVerification(channel, destination, code) {
  const text = `Ваш код подтверждения VAPELAB: ${code}. Код действует ограниченное время. Никому его не сообщайте.`;
  return channel === "email"
    ? sendEmail(destination, "Код подтверждения VAPELAB", text)
    : sendSms(destination, text);
}
