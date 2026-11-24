-- 004 — контентная витрина VAPELAB поверх существующей RuCRM.
-- Цены и статусы сохраняются исходными строками; складской остаток не выводится из UI-меток.
CREATE TABLE IF NOT EXISTS store_categories (
  id {{PK}}, parent_id INTEGER, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
  description TEXT DEFAULT '', sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1, source_url TEXT DEFAULT '', created_at TEXT DEFAULT {{NOW}}, updated_at TEXT DEFAULT {{NOW}}
);
CREATE TABLE IF NOT EXISTS store_products (
  id {{PK}}, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, brand TEXT DEFAULT '', sku TEXT DEFAULT '',
  product_type TEXT DEFAULT '', format TEXT DEFAULT '', description TEXT DEFAULT '', specifications_json TEXT DEFAULT '{}',
  price_raw TEXT DEFAULT '', old_price_raw TEXT DEFAULT '', currency TEXT DEFAULT 'RUB',
  availability_label_raw TEXT DEFAULT '', stock_quantity {{REAL}}, status TEXT DEFAULT 'draft',
  source_url TEXT DEFAULT '', source_checked_at TEXT DEFAULT '', migration_notes TEXT DEFAULT '',
  created_at TEXT DEFAULT {{NOW}}, updated_at TEXT DEFAULT {{NOW}}
);
CREATE TABLE IF NOT EXISTS store_product_categories (
  product_id INTEGER NOT NULL, category_id INTEGER NOT NULL, sort_order INTEGER DEFAULT 0,
  PRIMARY KEY(product_id, category_id)
);
CREATE TABLE IF NOT EXISTS store_product_variants (
  id {{PK}}, product_id INTEGER NOT NULL, name TEXT NOT NULL, sku TEXT DEFAULT '',
  attributes_json TEXT DEFAULT '{}', price_raw TEXT DEFAULT '', old_price_raw TEXT DEFAULT '',
  currency TEXT DEFAULT 'RUB', availability_label_raw TEXT DEFAULT '', sort_order INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS store_product_images (
  id {{PK}}, product_id INTEGER NOT NULL, variant_id INTEGER, url_original TEXT DEFAULT '',
  alt_raw TEXT DEFAULT '', position INTEGER DEFAULT 0, source_url TEXT DEFAULT '', download_status TEXT DEFAULT 'unverified'
);
CREATE TABLE IF NOT EXISTS store_news (
  id {{PK}}, title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, excerpt TEXT DEFAULT '', body TEXT DEFAULT '',
  published_at TEXT DEFAULT '', status TEXT DEFAULT 'draft', source_url TEXT DEFAULT '',
  created_at TEXT DEFAULT {{NOW}}, updated_at TEXT DEFAULT {{NOW}}
);
CREATE TABLE IF NOT EXISTS store_pages (
  id {{PK}}, title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, page_type TEXT DEFAULT 'content', body TEXT DEFAULT '',
  status TEXT DEFAULT 'draft', legal_review_status TEXT DEFAULT 'pending', source_url TEXT DEFAULT '',
  updated_at TEXT DEFAULT {{NOW}}
);
CREATE TABLE IF NOT EXISTS store_settings (
  setting_key TEXT PRIMARY KEY, setting_value TEXT DEFAULT '', updated_at TEXT DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_store_products_status ON store_products(status, name);
CREATE INDEX IF NOT EXISTS idx_store_categories_parent ON store_categories(parent_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_store_news_status_date ON store_news(status, published_at DESC);

-- Базовые категории перенесены из видимого дерева навигации. Остальные товары требуют экспорта.
INSERT INTO store_categories(name,slug,sort_order,source_url) VALUES
('Нагреватели табака','nagrevateli-tabaka',1,'https://vapelab.tech/collection/nagrevateli-tabaka'),
('Стики для нагревателей табака','stiki-dlya-nagrevateley-tabaka',2,'https://vapelab.tech/collection/stiki-dlya-nagrevateley-tabaka'),
('Одноразовые электронные сигареты - одноразки','odnorazki',3,'https://vapelab.tech/collection/odnorazki'),
('POD-системы на предзаправленных картриджах','pod-sistemy-na-predzapravlennyh-kartridzhah',4,''),
('POD-системы на заправляемых картриджах','pod-sistemy-na-zapravlyaemyh-kartridzhah',5,''),
('Предзаправленные картриджи для POD-систем','predzapravlennye-kartridzhi-dlya-pod-sistem',6,''),
('Заправляемые картриджи для POD-систем','zapravlyaemye-kartridzhi-dlya-pod-sistem',7,''),
('Жидкости для вейпа без никотина','zhidkosti-dlya-veypa-bez-nikotina',8,''),
('Жидкости для вейпа на солевом никотине','zhidkosti-na-solevom-nikotine',9,''),
('Кальяны и аксессуары','kalyany-i-aksessuary',10,''),
('Махорка','mahorka',11,''),
('Напитки','napitki',12,''),
('Никотиновая жвачка','nikotinovaya-zhvachka',13,''),
('Сигареты','sigarety',14,''),
('Сигариллы','sigarilly',15,''),
('Топливо для зажигалок','toplivo-dlya-zazhigalok',16,''),
('Трубочный табак','trubochnyy-tabak',17,''),
('Энергетические паучи','energeticheskie-pauchi',18,'')
ON CONFLICT(slug) DO NOTHING;

-- Начальная витрина без демонстрационных товаров и новостей.
-- Базовые настройки бренда без персональных контактов.
INSERT INTO store_settings(setting_key,setting_value) VALUES
('brand_name','VAPELAB'),
('logo_url',''),
('favicon_url',''),
('logo_background','#ffffff'),
('accent_color','#111111'),
('font_heading','Unbounded'),
('font_body','Inter'),
('catalog_notice','')
ON CONFLICT(setting_key) DO NOTHING;
