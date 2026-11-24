-- Поставки: отдельные входящие накладные с товарными строками и фиксацией приёмки.
CREATE TABLE IF NOT EXISTS supplies (
  id {{PK}},
  number TEXT NOT NULL UNIQUE,
  supplier_name TEXT NOT NULL,
  invoice_number TEXT DEFAULT '',
  invoice_date TEXT DEFAULT '',
  source_file TEXT DEFAULT '',
  note TEXT DEFAULT '',
  total {{REAL}} DEFAULT 0,
  item_count INTEGER DEFAULT 0,
  matched_items INTEGER DEFAULT 0,
  owner_id INTEGER,
  created_at TEXT DEFAULT {{NOW}}
);

CREATE TABLE IF NOT EXISTS supply_items (
  id {{PK}},
  supply_id INTEGER NOT NULL,
  product_id INTEGER,
  sku TEXT DEFAULT '',
  name TEXT NOT NULL,
  quantity {{REAL}} DEFAULT 0,
  unit TEXT DEFAULT 'шт',
  purchase_price {{REAL}} DEFAULT 0,
  line_total {{REAL}} DEFAULT 0,
  vat_rate INTEGER DEFAULT 20,
  source_data TEXT DEFAULT '',
  created_at TEXT DEFAULT {{NOW}}
);

CREATE INDEX IF NOT EXISTS idx_supplies_created ON supplies(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_supplies_invoice ON supplies(supplier_name, invoice_number);
CREATE INDEX IF NOT EXISTS idx_supply_items_supply ON supply_items(supply_id, id);
CREATE INDEX IF NOT EXISTS idx_supply_items_product ON supply_items(product_id);

-- Оптовая информационная страница не является юридическим документом.
-- Существующий текст и настройки страницы сохраняются, меняется только публикация.
UPDATE store_pages
SET status='published', updated_at={{NOW}}
WHERE slug='optovy';
