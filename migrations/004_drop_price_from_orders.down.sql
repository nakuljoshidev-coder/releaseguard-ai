-- ============================================================
-- Rollback: 004_drop_price_from_orders
-- Reverses: ALTER TABLE orders DROP COLUMN price
--
-- ⚠️  DATA LOSS WARNING — READ BEFORE EXECUTING
-- ---------------------------------------------------------------
-- This rollback restores the SCHEMA only.
-- The original price data was permanently destroyed when the
-- up migration was applied. No automated recovery of price
-- values is possible from this script alone.
--
-- To recover actual price data you MUST restore from a
-- pre-migration database backup taken before 004 was applied.
--
-- After running this script the price column will exist but
-- all rows will have price = 0.00 (the placeholder default).
-- Update values from your backup before re-enabling the
-- application against this schema.
-- ============================================================

-- Step 1: Re-add the price column with a temporary safe default
-- so existing rows are not left in an invalid state.
ALTER TABLE orders ADD COLUMN price NUMERIC(10, 2) NOT NULL DEFAULT 0.00;

-- Step 2: (Manual step — not automated)
-- Restore price values from backup:
--   UPDATE orders SET price = <backup_value> WHERE id = <id>;
-- Or bulk-restore using your database backup tool.

-- Step 3: Once values are restored, remove the temporary default
-- if the application enforces price at the API layer.
-- ALTER TABLE orders ALTER COLUMN price DROP DEFAULT;
