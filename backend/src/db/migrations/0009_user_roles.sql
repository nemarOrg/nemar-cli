-- Add role column for hierarchical access control (owner > admin > member)
-- Replaces binary is_admin flag (dropped in 0010_drop_is_admin.sql)
ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'member';

-- Migrate existing admins
UPDATE users SET role = 'admin' WHERE is_admin = 1;

-- Set specific owner assignments
UPDATE users SET role = 'owner' WHERE username = 'yahya';
UPDATE users SET role = 'owner' WHERE username = 'nemarOwner';

-- Set specific admin assignment
UPDATE users SET role = 'admin' WHERE username = 'nemarAdmin';

-- Index for role-based queries
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
