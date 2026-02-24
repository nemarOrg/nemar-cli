-- Enforce unique GitHub usernames to prevent duplicate account linking
-- Case-insensitive: GitHub usernames are case-insensitive (Foo == foo)
DROP INDEX IF EXISTS idx_users_github;
CREATE UNIQUE INDEX idx_users_github ON users(github_username COLLATE NOCASE);
