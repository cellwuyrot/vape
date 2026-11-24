import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test, { after, before } from "node:test";

process.env.DATA_DIR = "./data-test-webchat";
process.env.SECRET_KEY = "webchat-test-secret-with-sufficient-entropy";
process.env.ADMIN_EMAIL = "andycoulbot@gmail.com";
process.env.STORAGE_BACKEND = "local";

const { createServer } = await import("../server/index.js");
const { db, repo } = await import("../server/db.js");
const { signToken } = await import("../server/auth.js");

const server = await createServer();
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://localhost:${server.address().port}`;
let adminToken = "";
let chatToken = "";
let conversationId = 0;

const request = async (url, { method = "GET", token = adminToken, chat = "", body } = {}) => {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (chat) headers["X-Webchat-Token"] = chat;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${base}${url}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

before(async () => {
  const admin = await db.get("SELECT * FROM users WHERE email=?", ["andycoulbot@gmail.com"]);
  adminToken = signToken({ uid: admin.id, role: admin.role });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
  await fs.rm("./data-test-webchat", { recursive: true, force: true });
});

test("публичный чат требует согласие при первом обращении и создаёт диалог в общем CRM-инбоксе", async () => {
  const denied = await request("/api/webchat/messages", {
    method: "POST", token: "", body: { message: "Здравствуйте, есть вопрос?" },
  });
  assert.equal(denied.status, 400);
  assert.match(denied.data.detail, /согласие/i);

  const created = await request("/api/webchat/messages", {
    method: "POST", token: "",
    body: {
      customer_name: "Тестовый посетитель",
      email: "webchat-visitor@example.test",
      pd_consent: true,
      message: "Здравствуйте, подскажите по товару.",
    },
  });
  assert.equal(created.status, 201);
  assert.ok(created.data.chat_token);
  assert.ok(created.data.conversation_id);
  chatToken = created.data.chat_token;
  conversationId = created.data.conversation_id;

  const conversation = await db.get("SELECT * FROM conversations WHERE id=?", [conversationId]);
  assert.equal(conversation.channel_type, "webchat");
  assert.equal(conversation.unread_count, 1);
  const contact = await db.get("SELECT * FROM contacts WHERE id=?", [conversation.contact_id]);
  assert.equal(contact.source, "webchat");
  assert.equal(contact.pd_consent, 1);

  const inbox = await request("/api/inbox/conversations?channel=webchat");
  assert.equal(inbox.status, 200);
  assert.ok(inbox.data.some((item) => item.id === conversationId));
  assert.equal(inbox.data.find((item) => item.id === conversationId).contact_name, "Тестовый посетитель");
});

test("посетитель получает ответ CRM-сотрудника в той же webchat-сессии", async () => {
  assert.ok(chatToken && conversationId);
  const reply = await request(`/api/inbox/conversations/${conversationId}/reply`, {
    method: "POST", body: { body: "Здравствуйте! Менеджер VAPELAB на связи." },
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.data.direction, "outbound");
  assert.equal(reply.data.delivered, 1);

  const messages = await request("/api/webchat/messages?since=0", { token: "", chat: chatToken });
  assert.equal(messages.status, 200);
  assert.ok(messages.data.messages.some((item) => item.direction === "outbound" && item.body.includes("Менеджер VAPELAB")));
});

test("публичный чат сохраняет авторизацию сессии и ограничивает доступ без подписанного токена", async () => {
  const unauthorized = await request("/api/webchat/messages", { token: "" });
  assert.equal(unauthorized.status, 401);

  const followup = await request("/api/webchat/messages", {
    method: "POST", token: "", chat: chatToken,
    body: { message: "Спасибо, ожидаю ответ." },
  });
  assert.equal(followup.status, 201);
  assert.equal(followup.data.conversation_id, conversationId);

  const invalid = await request("/api/webchat/messages", { token: "", chat: "invalid-token" });
  assert.equal(invalid.status, 401);
});


test("личный кабинет покупателя сохраняет контактные данные и показывает CRM-диалоги", async () => {
  const visitor = await repo.insert("users", {
    email: "profile-customer@example.test", phone: "no-phone:profile-customer", full_name: "Покупатель профиля",
    password_hash: "", role: "visitor", email_verified: 1, phone_verified: 1, is_active: 1,
    pd_consent_at: new Date().toISOString(),
  });
  const { signToken } = await import("../server/auth.js");
  const visitorToken = signToken({ uid: visitor.id, role: visitor.role });
  const emptyProfile = await request("/api/auth/customer-profile", { token: visitorToken });
  assert.equal(emptyProfile.status, 200);
  assert.equal(emptyProfile.data.profile.email, visitor.email);
  const saved = await request("/api/auth/profile", { method: "PATCH", token: visitorToken, body: {
    full_name: "Покупатель VAPELAB", phone: "+79990001122", telegram_username: "buyer_profile",
    delivery_address: "Ленина, 10", delivery_city: "Москва", delivery_postcode: "101000", delivery_comment: "Позвонить заранее",
  } });
  assert.equal(saved.status, 200);
  const profileContact = await db.get("SELECT * FROM contacts WHERE linked_user_id=?", [visitor.id]);
  assert.equal(profileContact.full_name, "Покупатель VAPELAB");
  assert.equal(profileContact.delivery_address, "Ленина, 10");
  assert.equal(profileContact.telegram_username, "buyer_profile");
  const conversation = await repo.insert("conversations", {
    channel_type: "webchat", external_chat_id: `profile-${visitor.id}`, subject: "Вопрос по заказу", status: "open",
    contact_id: profileContact.id, unread_count: 0, last_message_at: new Date().toISOString(),
  });
  await repo.insert("messages", { conversation_id: conversation.id, direction: "outbound", body: "Менеджер ответил покупателю", created_at: new Date().toISOString() });
  const withHistory = await request("/api/auth/customer-profile", { token: visitorToken });
  assert.equal(withHistory.status, 200);
  assert.ok(withHistory.data.conversations.some((item) => item.id === conversation.id && item.messages.some((message) => message.body.includes("Менеджер ответил"))));
});
