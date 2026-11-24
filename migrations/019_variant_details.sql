-- Описание и структурированное наличие варианта. Пустое наличие наследуется от товара.
ALTER TABLE store_product_variants ADD COLUMN description TEXT DEFAULT '';
ALTER TABLE store_product_variants ADD COLUMN availability_status TEXT DEFAULT '';
ALTER TABLE store_product_images ADD COLUMN content_sha256 TEXT DEFAULT '';
