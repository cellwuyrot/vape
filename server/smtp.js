/** Минимальный SMTP-клиент на встроенных net/tls. Поддерживает implicit TLS и STARTTLS. */
import net from "node:net";
import tls from "node:tls";

class SmtpReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.lines = [];
    this.waiters = [];
    this.dataHandler = (chunk) => this.onData(chunk);
    this.errorHandler = (error) => this.fail(error);
    this.closeHandler = () => this.fail(new Error("SMTP server closed the connection"));
    socket.on("data", this.dataHandler);
    socket.on("error", this.errorHandler);
    socket.on("close", this.closeHandler);
  }
  dispose() {
    this.socket.off("data", this.dataHandler);
    this.socket.off("error", this.errorHandler);
    this.socket.off("close", this.closeHandler);
  }
  onData(chunk) {
    this.buffer += chunk.toString("utf8");
    let index;
    while ((index = this.buffer.indexOf("\r\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.lines.push(line);
      if (/^\d{3} /.test(line)) {
        const response = this.lines.join("\n");
        this.lines = [];
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(response);
        else this.responses.push(response);
      }
    }
  }
  responses = [];
  read() {
    if (this.responses.length) return Promise.resolve(this.responses.shift());
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  fail(error) {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

const responseCode = (response) => Number(String(response).slice(0, 3));
async function command(socket, reader, commandText, expected) {
  socket.write(`${commandText}\r\n`);
  const response = await reader.read();
  const code = responseCode(response);
  if (!expected.includes(code)) throw new Error(`SMTP ${commandText.split(" ")[0]} failed (${code}): ${response}`);
  return response;
}
const waitFor = (socket, event) => new Promise((resolve, reject) => {
  const onError = (error) => { socket.off(event, onEvent); reject(error); };
  const onEvent = () => { socket.off("error", onError); resolve(); };
  socket.once(event, onEvent); socket.once("error", onError);
});
const base64Lines = (text) => Buffer.from(text, "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") || "";
const encodeHeader = (text) => `=?UTF-8?B?${Buffer.from(String(text || ""), "utf8").toString("base64")}?=`;
const cleanHeader = (text) => String(text || "").replace(/[\r\n]+/g, " ").trim();

export async function sendSmtpMail({ smtpUrl, from, to, subject, text }) {
  const parsed = new URL(smtpUrl);
  if (!["smtp:", "smtps:"].includes(parsed.protocol)) throw new Error("SMTP_URL должен начинаться с smtp:// или smtps://");
  const host = parsed.hostname;
  const secure = parsed.protocol === "smtps:" || parsed.port === "465";
  const port = Number(parsed.port || (secure ? 465 : 587));
  const username = decodeURIComponent(parsed.username || "");
  const password = decodeURIComponent(parsed.password || "");

  let socket = secure
    ? tls.connect({ host, port, servername: host })
    : net.createConnection({ host, port });
  socket.setTimeout(20000, () => socket.destroy(new Error("SMTP connection timed out")));
  let reader = new SmtpReader(socket);
  await waitFor(socket, secure ? "secureConnect" : "connect");
  const greeting = await reader.read();
  if (responseCode(greeting) !== 220) throw new Error(`SMTP greeting failed: ${greeting}`);
  let capabilities = await command(socket, reader, "EHLO vapelab.bond", [250]);

  if (!secure && /(^|\n)250[- ]STARTTLS\b/i.test(capabilities)) {
    await command(socket, reader, "STARTTLS", [220]);
    reader.dispose();
    socket = tls.connect({ socket, servername: host });
    socket.setTimeout(20000, () => socket.destroy(new Error("SMTP TLS connection timed out")));
    reader = new SmtpReader(socket);
    await waitFor(socket, "secureConnect");
    capabilities = await command(socket, reader, "EHLO vapelab.bond", [250]);
  }
  if (!secure && !/(^|\n)250[- ]STARTTLS\b/i.test(capabilities)) {
    throw new Error("SMTP server does not offer STARTTLS; refusing to send mail over an unencrypted connection");
  }

  if (username || password) {
    const auth = Buffer.from(`\0${username}\0${password}`, "utf8").toString("base64");
    await command(socket, reader, `AUTH PLAIN ${auth}`, [235]);
  }

  const fromAddress = cleanHeader(from).replace(/^.*<([^>]+)>.*$/, "$1");
  const recipient = cleanHeader(to);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromAddress) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    throw new Error("Invalid SMTP sender or recipient address");
  }
  await command(socket, reader, `MAIL FROM:<${fromAddress}>`, [250]);
  await command(socket, reader, `RCPT TO:<${recipient}>`, [250, 251]);
  await command(socket, reader, "DATA", [354]);

  const body = base64Lines(text).replace(/(^|\r\n)\./g, "$1..");
  const message = [
    `From: ${cleanHeader(from)}`,
    `To: ${recipient}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
    ".",
    "",
  ].join("\r\n");
  socket.write(message);
  const accepted = await reader.read();
  if (responseCode(accepted) !== 250) throw new Error(`SMTP message rejected: ${accepted}`);
  await command(socket, reader, "QUIT", [221]).catch(() => {});
  socket.end();
  return { ok: true };
}
