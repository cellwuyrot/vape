-- Индексы для выборки товаров по категории и загрузки вариантов.
CREATE INDEX IF NOT EXISTS idx_store_product_categories_category_product ON store_product_categories(category_id, product_id);
CREATE INDEX IF NOT EXISTS idx_store_variants_product_order ON store_product_variants(product_id, sort_order, id);
