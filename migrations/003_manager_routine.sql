-- 003 — рутина менеджера: задачи, воронки, причины отказа, быстрые ответы,
-- лента активности, журнал импорта и шаблоны печатных форм.
-- Совместима с обеими СУБД: подстановки {{PK}}, {{NOW}}, {{REAL}} раскрывает server/dialect.js.

/* ---------- Воронки и стадии ---------- */

CREATE TABLE IF NOT EXISTS pipelines (
  id {{PK}},
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  sort INTEGER DEFAULT 0,
  is_default INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT {{NOW}}
);

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id {{PK}},
  pipeline_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  -- open — рабочая стадия, won — успех, lost — отказ
  kind TEXT DEFAULT 'open',
  sort INTEGER DEFAULT 0,
  probability INTEGER DEFAULT 0,
  -- список обязательных полей сделки через запятую: amount,contact_id,next_step
  required_fields TEXT DEFAULT '',
  UNIQUE (pipeline_id, code)
);

CREATE TABLE IF NOT EXISTS lost_reasons (
  id {{PK}},
  name TEXT NOT NULL,
  sort INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1
);

/* ---------- Задачи ---------- */

CREATE TABLE IF NOT EXISTS tasks (
  id {{PK}},
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  -- call, meeting, email, message, todo
  kind TEXT DEFAULT 'todo',
  -- open, done, canceled
  status TEXT DEFAULT 'open',
  priority TEXT DEFAULT 'normal',
  due_at TEXT,
  remind_at TEXT,
  reminded INTEGER DEFAULT 0,
  assignee_id INTEGER,
  author_id INTEGER,
  contact_id INTEGER,
  company_id INTEGER,
  deal_id INTEGER,
  conversation_id INTEGER,
  result TEXT DEFAULT '',
  completed_at TEXT,
  created_at TEXT DEFAULT {{NOW}},
  updated_at TEXT DEFAULT {{NOW}}
);

/* ---------- Шаблоны быстрых ответов ---------- */

CREATE TABLE IF NOT EXISTS quick_replies (
  id {{PK}},
  shortcut TEXT DEFAULT '',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  channel TEXT DEFAULT '',
  owner_id INTEGER,
  is_shared INTEGER DEFAULT 1,
  used_count INTEGER DEFAULT 0,
  sort INTEGER DEFAULT 0,
  created_at TEXT DEFAULT {{NOW}}
);

/* ---------- Лента активности ---------- */

CREATE TABLE IF NOT EXISTS activities (
  id {{PK}},
  -- stage, task, task_done, call, email, note, order, import, merge
  type TEXT NOT NULL,
  title TEXT DEFAULT '',
  body TEXT DEFAULT '',
  contact_id INTEGER,
  company_id INTEGER,
  deal_id INTEGER,
  order_id INTEGER,
  task_id INTEGER,
  conversation_id INTEGER,
  user_id INTEGER,
  created_at TEXT DEFAULT {{NOW}}
);

/* ---------- Импорт ---------- */

CREATE TABLE IF NOT EXISTS import_runs (
  id {{PK}},
  filename TEXT DEFAULT '',
  entity TEXT NOT NULL,
  profile TEXT DEFAULT 'generic',
  mapping TEXT DEFAULT '',
  total INTEGER DEFAULT 0,
  created INTEGER DEFAULT 0,
  updated INTEGER DEFAULT 0,
  skipped INTEGER DEFAULT 0,
  errors TEXT DEFAULT '',
  user_id INTEGER,
  created_at TEXT DEFAULT {{NOW}}
);

/* ---------- Печатные формы ---------- */

CREATE TABLE IF NOT EXISTS doc_templates (
  id {{PK}},
  code TEXT UNIQUE NOT NULL,
  -- quote, invoice, contract, act
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  updated_at TEXT DEFAULT {{NOW}}
);

/* ---------- Расширение существующих таблиц ---------- */

ALTER TABLE deals ADD COLUMN pipeline_id INTEGER;
ALTER TABLE deals ADD COLUMN lost_reason_id INTEGER;
ALTER TABLE deals ADD COLUMN stage_changed_at TEXT;
ALTER TABLE deals ADD COLUMN next_step TEXT DEFAULT '';
ALTER TABLE contacts ADD COLUMN merged_into_id INTEGER;
ALTER TABLE companies ADD COLUMN merged_into_id INTEGER;
ALTER TABLE messages ADD COLUMN attachment_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_deal ON tasks(deal_id);
CREATE INDEX IF NOT EXISTS idx_activities_contact ON activities(contact_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_activities_deal ON activities(deal_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_stages_pipeline ON pipeline_stages(pipeline_id, sort);
CREATE INDEX IF NOT EXISTS idx_deals_pipeline ON deals(pipeline_id, stage);

/* ---------- Наполнение справочников ---------- */

INSERT INTO pipelines (code, name, sort, is_default) VALUES ('sales', 'Продажи', 1, 1);
INSERT INTO pipelines (code, name, sort, is_default) VALUES ('repeat', 'Повторные продажи', 2, 0);
INSERT INTO pipelines (code, name, sort, is_default) VALUES ('service', 'Сервис', 3, 0);

INSERT INTO pipeline_stages (pipeline_id, code, name, kind, sort, probability, required_fields)
  SELECT id, 'new', 'Новая', 'open', 1, 10, '' FROM pipelines WHERE code = 'sales';
INSERT INTO pipeline_stages (pipeline_id, code, name, kind, sort, probability, required_fields)
  SELECT id, 'qualified', 'Квалифицирована', 'open', 2, 25, 'contact_id' FROM pipelines WHERE code = 'sales';
INSERT INTO pipeline_stages (pipeline_id, code, name, kind, sort, probability, required_fields)
  SELECT id, 'proposal', 'КП отправлено', 'open', 3, 50, 'amount' FROM pipelines WHERE code = 'sales';
INSERT INTO pipeline_stages (pipeline_id, code, name, kind, sort, probability, required_fields)
  SELECT id, 'negotiation', 'Переговоры', 'open', 4, 70, 'amount,next_step' FROM pipelines WHERE code = 'sales';
INSERT INTO pipeline_stages (pipeline_id, code, name, kind, sort, probability, required_fields)
  SELECT id, 'won', 'Успех', 'won', 5, 100, 'amount' FROM pipelines WHERE code = 'sales';
INSERT INTO pipeline_stages (pipeline_id, code, name, kind, sort, probability, required_fields)
  SELECT id, 'lost', 'Отказ', 'lost', 6, 0, '' FROM pipelines WHERE code = 'sales';

INSERT INTO pipeline_stages (pipeline_id, code, name, kind, sort, probability, required_fields)
  SELECT id, 'new', 'Повод для контакта', 'open', 1, 15, '' FROM pipelines WHERE code = 'repeat';
INSERT INTO pipeline_stages (pipeline_id, code, name, kind, sort, probability, required_fields)
  SELECT id, 'offer', 'Предложение сделано', 'open', 2, 45, 'amount' FROM pipelines WHERE code = 'repeat';
INSERT INTO pipeline_stages (pipeline_id, code, name, kind, sort, probability, required_fields)
  SELECT id, 'won', 'Продлено', 'won', 3, 100, 'amount' FROM pipelines WHERE code = 'repeat';
INSERT INTO pipeline_stages (pipeline_id, code, name, kind, sort, probability, required_fields)
  SELECT id, 'lost', 'Отказ', 'lost', 4, 0, '' FROM pipelines WHERE code = 'repeat';

INSERT INTO pipeline_stages (pipeline_id, code, name, kind, sort, probability, required_fields)
  SELECT id, 'new', 'Заявка принята', 'open', 1, 20, '' FROM pipelines WHERE code = 'service';
INSERT INTO pipeline_stages (pipeline_id, code, name, kind, sort, probability, required_fields)
  SELECT id, 'work', 'В работе', 'open', 2, 60, 'next_step' FROM pipelines WHERE code = 'service';
INSERT INTO pipeline_stages (pipeline_id, code, name, kind, sort, probability, required_fields)
  SELECT id, 'won', 'Выполнено', 'won', 3, 100, '' FROM pipelines WHERE code = 'service';
INSERT INTO pipeline_stages (pipeline_id, code, name, kind, sort, probability, required_fields)
  SELECT id, 'lost', 'Отменена', 'lost', 4, 0, '' FROM pipelines WHERE code = 'service';

INSERT INTO lost_reasons (name, sort) VALUES ('Дорого', 1);
INSERT INTO lost_reasons (name, sort) VALUES ('Выбрали конкурента', 2);
INSERT INTO lost_reasons (name, sort) VALUES ('Нет бюджета', 3);
INSERT INTO lost_reasons (name, sort) VALUES ('Отложено на неопределённый срок', 4);
INSERT INTO lost_reasons (name, sort) VALUES ('Не подошёл функционал', 5);
INSERT INTO lost_reasons (name, sort) VALUES ('Не отвечает', 6);
INSERT INTO lost_reasons (name, sort) VALUES ('Нецелевое обращение', 7);

INSERT INTO quick_replies (shortcut, title, body, sort) VALUES
  ('прив', 'Приветствие', 'Здравствуйте! Спасибо за обращение. Подскажите, какая задача перед вами стоит — подберу решение.', 1);
INSERT INTO quick_replies (shortcut, title, body, sort) VALUES
  ('кп', 'Отправка КП', 'Подготовил коммерческое предложение по вашему запросу — направляю во вложении. Готов созвониться и обсудить детали.', 2);
INSERT INTO quick_replies (shortcut, title, body, sort) VALUES
  ('счёт', 'Счёт отправлен', 'Счёт выставлен и отправлен на вашу почту. После оплаты пришлём закрывающие документы через ЭДО.', 3);
INSERT INTO quick_replies (shortcut, title, body, sort) VALUES
  ('пауза', 'Взять паузу', 'Уточню информацию у коллег и вернусь с ответом в течение часа.', 4);
INSERT INTO quick_replies (shortcut, title, body, sort) VALUES
  ('нерабочее', 'Вне рабочих часов', 'Спасибо за обращение! Мы работаем с 9:00 до 18:00 по московскому времени, ответим утром первым делом.', 5);

UPDATE deals SET pipeline_id = (SELECT id FROM pipelines WHERE code = 'sales') WHERE pipeline_id IS NULL;
