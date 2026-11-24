import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const read = (file) => fs.readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("primary administrator identity is hidden from API and team list", async () => {
  const auth = await read("server/routes/auth.js");
  const users = await read("server/routes/users.js");
  assert.match(auth, /email: isPrimaryAdmin \? "" : u\.email/);
  assert.match(auth, /full_name: isPrimaryAdmin \? "Рабочий аккаунт" : u\.full_name/);
  assert.match(users, /email: isPrimaryAdmin \? "" : u\.email/);
  assert.match(users, /role NOT IN \('visitor','superadmin'\)/);
});

test("primary administrator is masked across CRM display surfaces", async () => {
  const app = await read("public/js/app.js");
  const settings = await read("public/js/views/settings.js");
  const activity = await read("server/activity.js");
  const crm = await read("server/routes/crm.js");
  const tasks = await read("server/tasks.js");
  assert.match(app, /displayName = user\?\.role === "superadmin" \? "Рабочий аккаунт"/);
  assert.doesNotMatch(app, /superadmin:"Главный администратор"/);
  assert.match(settings, /user\.role === "superadmin" \? "Скрыта"/);
  assert.match(activity, /CASE WHEN u\.role='superadmin' THEN 'Администратор'/);
  assert.match(crm, /CASE WHEN u\.role='superadmin' THEN 'Администратор'/);
  assert.match(tasks, /CASE WHEN u\.role='superadmin' THEN 'Администратор'/);
});
