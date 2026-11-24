-- 007 — единая e-mail авторизация, команда CRM и SEO-данные каталога.
-- Блюр изображений/возрастные ограничения намеренно не включены в эту миграцию.
ALTER TABLE users ADD COLUMN invited_by INTEGER;
ALTER TABLE users ADD COLUMN invited_at TEXT;
ALTER TABLE users ADD COLUMN last_login_at TEXT;

ALTER TABLE store_products ADD COLUMN seo_h1 TEXT DEFAULT '';
ALTER TABLE store_products ADD COLUMN seo_title TEXT DEFAULT '';
ALTER TABLE store_products ADD COLUMN seo_description TEXT DEFAULT '';
ALTER TABLE store_products ADD COLUMN seo_keywords_json TEXT DEFAULT '[]';
ALTER TABLE store_products ADD COLUMN canonical_url TEXT DEFAULT '';
ALTER TABLE store_products ADD COLUMN robots_index INTEGER DEFAULT 1;
ALTER TABLE store_products ADD COLUMN image_search_query TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS store_keyword_targets (
  id {{PK}},
  product_id INTEGER NOT NULL,
  keyword TEXT NOT NULL,
  frequency_class TEXT DEFAULT '',
  search_volume INTEGER,
  search_engine TEXT DEFAULT '',
  region TEXT DEFAULT '',
  search_intent TEXT DEFAULT '',
  source TEXT DEFAULT '',
  checked_at TEXT DEFAULT '',
  created_at TEXT DEFAULT {{NOW}},
  updated_at TEXT DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_store_keyword_product ON store_keyword_targets(product_id, frequency_class);
CREATE INDEX IF NOT EXISTS idx_store_keyword_text ON store_keyword_targets(keyword);
CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role, is_active);

INSERT INTO store_settings(setting_key,setting_value,updated_at) VALUES
  ('brand_name','VAPELAB',{{NOW}}),
  ('logo_url','/assets/brand/vapelab-logo.webp',{{NOW}}),
  ('favicon_url','/assets/brand/favicon-32.png',{{NOW}}),
  ('logo_background','#ffffff',{{NOW}}),
  ('accent_color','#2f8cff',{{NOW}}),
  ('font_heading','Unbounded',{{NOW}}),
  ('font_body','Inter',{{NOW}})
ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=excluded.updated_at;
