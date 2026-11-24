-- 010 — редактируемые тексты витрины и заготовки юридических страниц.
-- Документы создаются черновиками и не публикуются до заполнения и проверки.
INSERT INTO store_pages (title, slug, page_type, body, status, legal_review_status, source_url)
SELECT 'Политика конфиденциальности', 'privacy', 'legal', '', 'draft', 'pending', ''
WHERE NOT EXISTS (SELECT 1 FROM store_pages WHERE slug = 'privacy');

INSERT INTO store_pages (title, slug, page_type, body, status, legal_review_status, source_url)
SELECT 'Доставка и получение', 'delivery', 'content', '', 'draft', 'pending', ''
WHERE NOT EXISTS (SELECT 1 FROM store_pages WHERE slug = 'delivery');
