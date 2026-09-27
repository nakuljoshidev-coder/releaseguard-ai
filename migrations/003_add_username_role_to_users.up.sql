-- Migration: 003_add_username_role_to_users.sql
-- Direction: UP
-- Renames 'name' column to 'username' (destructive — existing data mapping may break)
ALTER TABLE users RENAME COLUMN name TO username;
-- Adds non-nullable 'role' column WITHOUT a default (destructive on existing rows)
ALTER TABLE users ADD COLUMN role VARCHAR(50) NOT NULL;
