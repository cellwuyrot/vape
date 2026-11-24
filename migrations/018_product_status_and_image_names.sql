-- 018 — единые статусы каталога и исходные имена изображений для привязки к цветам.
ALTER TABLE store_product_images ADD COLUMN original_filename TEXT DEFAULT '';
ALTER TABLE store_product_images ADD COLUMN original_path TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_store_product_images_variant ON store_product_images(product_id, variant_id, position);
