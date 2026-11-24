-- Публичные SEO-страницы категорий. Сохраняем исходные category.slug для данных,
-- а короткие витринные URL задаём отдельными landing pages.
CREATE TABLE IF NOT EXISTS store_category_pages (
  id {{PK}},
  slug TEXT UNIQUE NOT NULL,
  h1 TEXT NOT NULL,
  seo_title TEXT NOT NULL,
  seo_description TEXT NOT NULL DEFAULT '',
  intro TEXT NOT NULL DEFAULT '',
  canonical_url TEXT NOT NULL DEFAULT '',
  robots_index INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'published',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT {{NOW}},
  updated_at TEXT DEFAULT {{NOW}}
);

CREATE TABLE IF NOT EXISTS store_category_page_categories (
  page_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(page_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_store_category_pages_status ON store_category_pages(status, robots_index, sort_order);
CREATE INDEX IF NOT EXISTS idx_store_category_page_categories_category ON store_category_page_categories(category_id, page_id);

INSERT INTO store_category_pages(slug,h1,seo_title,seo_description,intro,sort_order) VALUES
('nagrevateli-tabaka','Нагреватели табака','Нагреватели табака — каталог VAPELAB','Информационный раздел каталога VAPELAB: устройства для нагревания табака и связанные позиции.','Раздел каталога с отдельными карточками устройств. Характеристики и подписи сохраняются по доступным сведениям источника.',1),
('stiki','Стики','Стики — каталог VAPELAB','Информационный раздел каталога VAPELAB: стики и связанные коллекции.','В разделе собраны категории стиков и доступные карточки каталога.',2),
('odnorazki','Одноразовые электронные устройства','Одноразовые электронные устройства — каталог VAPELAB','Информационный раздел каталога VAPELAB с карточками одноразовых электронных устройств.','Карточки представлены для ознакомления с ассортиментной структурой. Неуказанные характеристики не додумываются.',3),
('pod-sistemy','POD-системы','POD-системы — каталог VAPELAB','Информационный раздел каталога VAPELAB: POD-системы на разных типах картриджей.','Внутри раздела категории разделены по типу используемых картриджей.',4),
('kartridzhi','Картриджи для POD-систем','Картриджи для POD-систем — каталог VAPELAB','Информационный раздел каталога VAPELAB: предзаправляемые и заправляемые картриджи.','Категории разделены по типу картриджей. Совместимость показывается только при наличии исходных данных.',5),
('zhidkosti','Жидкости','Жидкости — каталог VAPELAB','Информационный раздел каталога VAPELAB с отдельными категориями жидкостей.','В каталоге сохранено разделение исходных категорий. Состав и характеристики не выводятся без подтверждения.',6),
('kalyany','Кальяны и аксессуары','Кальяны и аксессуары — каталог VAPELAB','Информационный раздел каталога VAPELAB: кальяны, аксессуары и связанные коллекции.','Внутри раздела доступны отдельные категории и карточки каталога.',7),
('tabak','Табак','Табак — каталог VAPELAB','Информационный раздел каталога VAPELAB с отдельными категориями табачной продукции.','Раздел объединяет исходные категории махорки и трубочного табака, сохраняя их раздельно внутри каталога.',8),
('napitki','Напитки','Напитки — каталог VAPELAB','Информационный раздел каталога VAPELAB: напитки и вложенные коллекции.','Категории напитков и вложенные коллекции представлены отдельно.',9),
('nikotinovaya-zhvachka','Никотиновая жвачка','Никотиновая жвачка — каталог VAPELAB','Информационная категория каталога VAPELAB с карточками соответствующего раздела.','Раздел содержит только сведения, указанные в карточках каталога.',10),
('sigarety','Сигареты','Сигареты — каталог VAPELAB','Информационная категория каталога VAPELAB с доступными сведениями об ассортименте.','Раздел каталога. Доступность и условия обращения продукции требуют отдельной проверки владельцем.',11),
('sigarilly','Сигариллы','Сигариллы — каталог VAPELAB','Информационная категория каталога VAPELAB с вложенными коллекциями.','Исходные категории и вложенные коллекции сохранены раздельно.',12),
('toplivo-dlya-zazhigalok','Топливо для зажигалок','Топливо для зажигалок — каталог VAPELAB','Информационная категория каталога VAPELAB с доступными карточками раздела.','Сведения о товарах воспроизводятся по доступным источникам.',13),
('energeticheskie-pauchi','Энергетические паучи','Энергетические паучи — каталог VAPELAB','Информационная категория каталога VAPELAB с доступными карточками раздела.','Раздел каталога с данными, которые доступны в исходном материале.',14)
ON CONFLICT(slug) DO NOTHING;

-- 18 исходных корневых категорий сведены в короткие пользовательские разделы.
INSERT INTO store_category_page_categories(page_id,category_id,sort_order)
SELECT p.id,c.id,1 FROM store_category_pages p JOIN store_categories c ON c.slug='nagrevateli-tabaka' WHERE p.slug='nagrevateli-tabaka'
ON CONFLICT(page_id,category_id) DO NOTHING;
INSERT INTO store_category_page_categories(page_id,category_id,sort_order)
SELECT p.id,c.id,1 FROM store_category_pages p JOIN store_categories c ON c.slug='stiki-dlya-nagrevateley-tabaka' WHERE p.slug='stiki'
ON CONFLICT(page_id,category_id) DO NOTHING;
INSERT INTO store_category_page_categories(page_id,category_id,sort_order)
SELECT p.id,c.id,1 FROM store_category_pages p JOIN store_categories c ON c.slug='odnorazki' WHERE p.slug='odnorazki'
ON CONFLICT(page_id,category_id) DO NOTHING;
INSERT INTO store_category_page_categories(page_id,category_id,sort_order)
SELECT p.id,c.id,1 FROM store_category_pages p JOIN store_categories c ON c.slug='pod-sistemy-na-predzapravlennyh-kartridzhah' WHERE p.slug='pod-sistemy'
ON CONFLICT(page_id,category_id) DO NOTHING;
INSERT INTO store_category_page_categories(page_id,category_id,sort_order)
SELECT p.id,c.id,2 FROM store_category_pages p JOIN store_categories c ON c.slug='pod-sistemy-na-zapravlyaemyh-kartridzhah' WHERE p.slug='pod-sistemy'
ON CONFLICT(page_id,category_id) DO NOTHING;
INSERT INTO store_category_page_categories(page_id,category_id,sort_order)
SELECT p.id,c.id,1 FROM store_category_pages p JOIN store_categories c ON c.slug='predzapravlennye-kartridzhi-dlya-pod-sistem' WHERE p.slug='kartridzhi'
ON CONFLICT(page_id,category_id) DO NOTHING;
INSERT INTO store_category_page_categories(page_id,category_id,sort_order)
SELECT p.id,c.id,2 FROM store_category_pages p JOIN store_categories c ON c.slug='zapravlyaemye-kartridzhi-dlya-pod-sistem' WHERE p.slug='kartridzhi'
ON CONFLICT(page_id,category_id) DO NOTHING;
INSERT INTO store_category_page_categories(page_id,category_id,sort_order)
SELECT p.id,c.id,1 FROM store_category_pages p JOIN store_categories c ON c.slug='zhidkosti-dlya-veypa-bez-nikotina' WHERE p.slug='zhidkosti'
ON CONFLICT(page_id,category_id) DO NOTHING;
INSERT INTO store_category_page_categories(page_id,category_id,sort_order)
SELECT p.id,c.id,2 FROM store_category_pages p JOIN store_categories c ON c.slug='zhidkosti-na-solevom-nikotine' WHERE p.slug='zhidkosti'
ON CONFLICT(page_id,category_id) DO NOTHING;
INSERT INTO store_category_page_categories(page_id,category_id,sort_order)
SELECT p.id,c.id,1 FROM store_category_pages p JOIN store_categories c ON c.slug='kalyany-i-aksessuary' WHERE p.slug='kalyany'
ON CONFLICT(page_id,category_id) DO NOTHING;
INSERT INTO store_category_page_categories(page_id,category_id,sort_order)
SELECT p.id,c.id,1 FROM store_category_pages p JOIN store_categories c ON c.slug='mahorka' WHERE p.slug='tabak'
ON CONFLICT(page_id,category_id) DO NOTHING;
INSERT INTO store_category_page_categories(page_id,category_id,sort_order)
SELECT p.id,c.id,2 FROM store_category_pages p JOIN store_categories c ON c.slug='trubochnyy-tabak' WHERE p.slug='tabak'
ON CONFLICT(page_id,category_id) DO NOTHING;
INSERT INTO store_category_page_categories(page_id,category_id,sort_order)
SELECT p.id,c.id,1 FROM store_category_pages p JOIN store_categories c ON c.slug='napitki' WHERE p.slug='napitki'
ON CONFLICT(page_id,category_id) DO NOTHING;
INSERT INTO store_category_page_categories(page_id,category_id,sort_order)
SELECT p.id,c.id,1 FROM store_category_pages p JOIN store_categories c ON c.slug='nikotinovaya-zhvachka' WHERE p.slug='nikotinovaya-zhvachka'
ON CONFLICT(page_id,category_id) DO NOTHING;
INSERT INTO store_category_page_categories(page_id,category_id,sort_order)
SELECT p.id,c.id,1 FROM store_category_pages p JOIN store_categories c ON c.slug='sigarety' WHERE p.slug='sigarety'
ON CONFLICT(page_id,category_id) DO NOTHING;
INSERT INTO store_category_page_categories(page_id,category_id,sort_order)
SELECT p.id,c.id,1 FROM store_category_pages p JOIN store_categories c ON c.slug='sigarilly' WHERE p.slug='sigarilly'
ON CONFLICT(page_id,category_id) DO NOTHING;
INSERT INTO store_category_page_categories(page_id,category_id,sort_order)
SELECT p.id,c.id,1 FROM store_category_pages p JOIN store_categories c ON c.slug='toplivo-dlya-zazhigalok' WHERE p.slug='toplivo-dlya-zazhigalok'
ON CONFLICT(page_id,category_id) DO NOTHING;
INSERT INTO store_category_page_categories(page_id,category_id,sort_order)
SELECT p.id,c.id,1 FROM store_category_pages p JOIN store_categories c ON c.slug='energeticheskie-pauchi' WHERE p.slug='energeticheskie-pauchi'
ON CONFLICT(page_id,category_id) DO NOTHING;
