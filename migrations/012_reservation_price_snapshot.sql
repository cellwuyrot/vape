-- 012 — фиксируем цену в момент запроса бронирования; это справочная сумма, не оплата.
ALTER TABLE store_reservations ADD COLUMN unit_price_minor INTEGER DEFAULT 0;
ALTER TABLE store_reservations ADD COLUMN total_price_minor INTEGER DEFAULT 0;
ALTER TABLE store_reservations ADD COLUMN price_currency TEXT DEFAULT 'RUB';
ALTER TABLE store_reservations ADD COLUMN price_raw_snapshot TEXT DEFAULT '';
ALTER TABLE store_reservations ADD COLUMN price_calculated INTEGER DEFAULT 0;
