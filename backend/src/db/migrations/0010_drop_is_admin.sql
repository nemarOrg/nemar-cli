-- Drop legacy is_admin column, now fully replaced by role column
-- D1 uses SQLite 3.35+ which supports ALTER TABLE DROP COLUMN
ALTER TABLE users DROP COLUMN is_admin;
