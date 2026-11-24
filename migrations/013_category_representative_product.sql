-- 013 — управляемый товар-представитель категории для интерактивных карточек витрины.
ALTER TABLE store_categories ADD COLUMN featured_product_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_store_categories_featured_product ON store_categories(featured_product_id);
