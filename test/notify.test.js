import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

const { config } = await import("../server/config.js");
const { sendEmail } = await import("../server/notify.js");
const { sendSmtpMail } = await import("../server/smtp.js");

test("email webhook получает корректный VAPELAB payload", async () => {
  let received;
  const server = http.createServer(async (req,res) => {
    const chunks=[];
    for await (const chunk of req) chunks.push(chunk);
    received=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(202,{"Content-Type":"application/json"});
    res.end("{}");
  });
  await new Promise((resolve)=>server.listen(0,"127.0.0.1",resolve));
  const previousUrl=config.smtpUrl;
  const previousFrom=config.mailFrom;
  try {
    config.smtpUrl=`http://127.0.0.1:${server.address().port}/mail`;
    config.mailFrom="info@vaplab.ru";
    const result=await sendEmail("user@example.ru","Код подтверждения VAPELAB","123456");
    assert.equal(result.ok,true);
    assert.deepEqual(received,{from:"info@vaplab.ru",to:"user@example.ru",subject:"Код подтверждения VAPELAB",text:"123456"});
  } finally {
    config.smtpUrl=previousUrl; config.mailFrom=previousFrom;
    await new Promise((resolve)=>server.close(resolve));
  }
});

test("SMTP transport rejects non-SMTP URL before network access", async () => {
  await assert.rejects(() => sendSmtpMail({ smtpUrl:"https://example.invalid/send", from:"info@vaplab.ru", to:"user@example.ru", subject:"Test", text:"Code" }), /SMTP_URL должен начинаться/);
});
