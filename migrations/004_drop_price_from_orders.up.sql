-- Migration: 004_drop_price_from_orders.sql
-- Direction: UP
-- ⚠ DESTRUCTIVE: drops price column — no default, no data preservation
ALTER TABLE orders DROP COLUMN price;
