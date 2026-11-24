-- 014 — складской статус, подписки о поступлении, профиль покупателя и оптовая страница.
ALTER TABLE store_products ADD COLUMN availability_status TEXT DEFAULT 'unknown';
UPDATE store_products SET availability_status = CASE
  WHEN lower(availability_label_raw) LIKE '%нет в наличии%' OR lower(availability_label_raw) LIKE '%отсутств%' OR lower(availability_label_raw) LIKE '%нет остат%' THEN 'out_of_stock'
  WHEN lower(availability_label_raw) LIKE '%предзаказ%' OR lower(availability_label_raw) LIKE '%ожидается%' THEN 'preorder'
  WHEN lower(availability_label_raw) LIKE '%в наличии%' OR lower(availability_label_raw) LIKE '%есть в наличии%' THEN 'in_stock'
  ELSE 'unknown' END
WHERE availability_status IS NULL OR availability_status = 'unknown';

ALTER TABLE contacts ADD COLUMN delivery_address TEXT DEFAULT '';
ALTER TABLE contacts ADD COLUMN delivery_city TEXT DEFAULT '';
ALTER TABLE contacts ADD COLUMN delivery_postcode TEXT DEFAULT '';
ALTER TABLE contacts ADD COLUMN delivery_comment TEXT DEFAULT '';
ALTER TABLE contacts ADD COLUMN telegram_username TEXT DEFAULT '';
ALTER TABLE contacts ADD COLUMN linked_user_id INTEGER;

ALTER TABLE users ADD COLUMN telegram_chat_id TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN telegram_username TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN telegram_link_token_hash TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN telegram_link_expires TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS store_restock_subscriptions (
  id {{PK}},
  product_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  product_slug TEXT DEFAULT '',
  customer_name TEXT DEFAULT '',
  email TEXT DEFAULT '',
  telegram_username TEXT DEFAULT '',
  telegram_chat_id TEXT DEFAULT '',
  telegram_link_token_hash TEXT DEFAULT '',
  telegram_link_expires TEXT DEFAULT '',
  pd_consent_at TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  email_notified INTEGER DEFAULT 0,
  telegram_notified INTEGER DEFAULT 0,
  notified_at TEXT DEFAULT '',
  created_at TEXT DEFAULT {{NOW}},
  updated_at TEXT DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_store_restock_product_status ON store_restock_subscriptions(product_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_restock_email ON store_restock_subscriptions(email,status);
CREATE INDEX IF NOT EXISTS idx_store_restock_token ON store_restock_subscriptions(telegram_link_token_hash);

INSERT INTO store_pages(title,slug,page_type,body,status,legal_review_status,source_url,updated_at)
VALUES ('Оптовое направление','optovy','wholesale',
'Оптовое направление VAPELAB\n\nМы работаем с компаниями и партнёрами по отдельным условиям. Оставьте заявку, чтобы обсудить ассортимент, доступность, документы, логистику и формат сотрудничества.\n\nУсловия, минимальные объёмы, цены и сроки подтверждаются менеджером индивидуально.\n\nСвяжитесь с нами через форму обратной связи или чат на сайте.',
'draft','approved','',{{NOW}})
ON CONFLICT(slug) DO NOTHING;
