-- 011 — бронирования, публикации с изображениями/связями и privacy-first аналитика.
ALTER TABLE store_products ADD COLUMN is_18_plus INTEGER DEFAULT 0;
ALTER TABLE store_products ADD COLUMN is_reservable INTEGER DEFAULT 1;

ALTER TABLE store_news ADD COLUMN image_url TEXT DEFAULT '';
ALTER TABLE store_news ADD COLUMN image_hidden INTEGER DEFAULT 0;
ALTER TABLE store_news ADD COLUMN is_18_plus INTEGER DEFAULT 0;
ALTER TABLE store_news ADD COLUMN product_ids_json TEXT DEFAULT '[]';
ALTER TABLE store_news ADD COLUMN body_html TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS store_reservations (
  id {{PK}},
  number TEXT UNIQUE NOT NULL,
  product_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  product_slug TEXT DEFAULT '',
  product_sku TEXT DEFAULT '',
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT DEFAULT '',
  quantity INTEGER DEFAULT 1,
  message TEXT DEFAULT '',
  status TEXT DEFAULT 'new',
  is_18_plus INTEGER DEFAULT 0,
  age_confirmed INTEGER DEFAULT 0,
  pd_consent_at TEXT NOT NULL,
  source_path TEXT DEFAULT '',
  manager_id INTEGER,
  manager_note TEXT DEFAULT '',
  email_notified INTEGER DEFAULT 0,
  telegram_notified INTEGER DEFAULT 0,
  created_at TEXT DEFAULT {{NOW}},
  updated_at TEXT DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_store_reservations_status_created ON store_reservations(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_reservations_product_created ON store_reservations(product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS store_analytics_events (
  id {{PK}},
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  path TEXT NOT NULL,
  page_title TEXT DEFAULT '',
  referrer_host TEXT DEFAULT '',
  target_tag TEXT DEFAULT '',
  target_text TEXT DEFAULT '',
  target_path TEXT DEFAULT '',
  created_at TEXT DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_store_analytics_created ON store_analytics_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_analytics_visitor_created ON store_analytics_events(visitor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_analytics_type_created ON store_analytics_events(event_type, created_at DESC);
