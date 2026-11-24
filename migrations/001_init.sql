-- 001 — базовая схема RuCRM.
-- Совместима с обеими СУБД: подстановки {{PK}}, {{NOW}}, {{REAL}} раскрывает server/dialect.js.
-- Миграция идемпотентна: её безопасно накатывать на существующую базу версии 2.0.0.

CREATE TABLE IF NOT EXISTS users (
  id {{PK}},
  email TEXT UNIQUE NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  full_name TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'agent',
  email_verified INTEGER DEFAULT 0,
  phone_verified INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  pd_consent_at TEXT,
  created_at TEXT DEFAULT {{NOW}}
);

CREATE TABLE IF NOT EXISTS verification_codes (
  id {{PK}},
  user_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER DEFAULT 0,
  used INTEGER DEFAULT 0,
  created_at TEXT DEFAULT {{NOW}}
);

CREATE TABLE IF NOT EXISTS companies (
  id {{PK}},
  name TEXT NOT NULL,
  inn TEXT DEFAULT '',
  kpp TEXT DEFAULT '',
  ogrn TEXT DEFAULT '',
  legal_address TEXT DEFAULT '',
  edo_operator_id TEXT DEFAULT '',
  website TEXT DEFAULT '',
  created_at TEXT DEFAULT {{NOW}}
);

CREATE TABLE IF NOT EXISTS contacts (
  id {{PK}},
  full_name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  position TEXT DEFAULT '',
  source TEXT DEFAULT 'manual',
  tags TEXT DEFAULT '',
  comment TEXT DEFAULT '',
  company_id INTEGER,
  owner_id INTEGER,
  pd_consent INTEGER DEFAULT 0,
  pd_consent_at TEXT,
  pd_retention_until TEXT,
  created_at TEXT DEFAULT {{NOW}},
  updated_at TEXT DEFAULT {{NOW}}
);

CREATE TABLE IF NOT EXISTS deals (
  id {{PK}},
  title TEXT NOT NULL,
  stage TEXT DEFAULT 'new',
  amount {{REAL}} DEFAULT 0,
  currency TEXT DEFAULT 'RUB',
  contact_id INTEGER,
  company_id INTEGER,
  owner_id INTEGER,
  source TEXT DEFAULT 'manual',
  lost_reason TEXT DEFAULT '',
  created_at TEXT DEFAULT {{NOW}},
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id {{PK}},
  sku TEXT DEFAULT '',
  name TEXT NOT NULL,
  price {{REAL}} DEFAULT 0,
  vat_rate INTEGER DEFAULT 20,
  unit TEXT DEFAULT 'шт',
  stock {{REAL}} DEFAULT 0,
  marking_required INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id {{PK}},
  number TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'draft',
  contact_id INTEGER,
  company_id INTEGER,
  deal_id INTEGER,
  owner_id INTEGER,
  total {{REAL}} DEFAULT 0,
  comment TEXT DEFAULT '',
  external_1c_id TEXT DEFAULT '',
  edo_document_id TEXT DEFAULT '',
  receipt_fiscal_id TEXT DEFAULT '',
  created_at TEXT DEFAULT {{NOW}}
);

CREATE TABLE IF NOT EXISTS order_items (
  id {{PK}},
  order_id INTEGER NOT NULL,
  product_id INTEGER,
  name TEXT NOT NULL,
  quantity {{REAL}} DEFAULT 1,
  price {{REAL}} DEFAULT 0,
  vat_rate INTEGER DEFAULT 20
);

CREATE TABLE IF NOT EXISTS conversations (
  id {{PK}},
  channel_type TEXT NOT NULL,
  external_chat_id TEXT NOT NULL,
  contact_id INTEGER,
  assignee_id INTEGER,
  status TEXT DEFAULT 'open',
  subject TEXT DEFAULT '',
  unread_count INTEGER DEFAULT 0,
  last_message_at TEXT DEFAULT {{NOW}},
  created_at TEXT DEFAULT {{NOW}},
  UNIQUE (channel_type, external_chat_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id {{PK}},
  conversation_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  body TEXT DEFAULT '',
  attachment_url TEXT DEFAULT '',
  author_user_id INTEGER,
  external_message_id TEXT DEFAULT '',
  delivered INTEGER DEFAULT 1,
  error TEXT DEFAULT '',
  created_at TEXT DEFAULT {{NOW}}
);

CREATE TABLE IF NOT EXISTS audit_log (
  id {{PK}},
  user_id INTEGER,
  action TEXT,
  entity TEXT,
  entity_id TEXT,
  payload TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  created_at TEXT DEFAULT {{NOW}}
);

CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(full_name);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conv_last ON conversations(last_message_at DESC);
