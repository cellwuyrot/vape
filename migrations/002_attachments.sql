-- 002 — вложения в отдельной таблице и ссылка из сообщения.
-- До этой версии вложение жило строкой attachment_url без метаданных и прав доступа.

CREATE TABLE IF NOT EXISTS attachments (
  id {{PK}},
  storage_key TEXT UNIQUE NOT NULL,
  backend TEXT DEFAULT 'local',
  filename TEXT NOT NULL,
  content_type TEXT DEFAULT 'application/octet-stream',
  size INTEGER DEFAULT 0,
  checksum TEXT DEFAULT '',
  entity TEXT DEFAULT '',
  entity_id TEXT DEFAULT '',
  uploaded_by INTEGER,
  created_at TEXT DEFAULT {{NOW}}
);

CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
CREATE INDEX IF NOT EXISTS idx_orders_contact ON orders(contact_id);
