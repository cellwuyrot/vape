-- 016 — выбранный вариант/цвет фиксируется в заявке на бронирование.
ALTER TABLE store_reservations ADD COLUMN variant_id INTEGER;
ALTER TABLE store_reservations ADD COLUMN variant_name TEXT DEFAULT '';
ALTER TABLE store_reservations ADD COLUMN variant_sku TEXT DEFAULT '';
ALTER TABLE store_reservations ADD COLUMN variant_image_url TEXT DEFAULT '';
