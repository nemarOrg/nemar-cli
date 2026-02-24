-- Enforce unique GitHub usernames to prevent duplicate account linking
-- Drop the existing non-unique index and recreate as unique
DROP INDEX IF EXISTS idx_users_github;
CREATE UNIQUE INDEX idx_users_github ON users(github_username);
