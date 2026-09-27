-- ============================================================
-- Rollback: 003_add_username_role_to_users
-- Reverses: RENAME COLUMN name -> username, ADD COLUMN role
--
-- WARNING: This rollback reverts the schema only.
--   Any data written to the 'role' column will be lost.
--   Any 'username' values will be moved back to 'name'.
--   Review application code for references to 'username'
--   and 'role' before executing this rollback.
-- ============================================================

-- Step 1: Drop the role column that was added in the up migration.
-- All role data will be permanently lost.
ALTER TABLE users DROP COLUMN IF EXISTS role;

-- Step 2: Rename username back to name (reverting the breaking rename).
ALTER TABLE users RENAME COLUMN username TO name;
