-- Dev Database Seed
-- Idempotent: safe to run multiple times (uses INSERT OR IGNORE)
-- Run with: npx wrangler@latest d1 execute nemar-db-dev --remote --env dev -c backend/wrangler.toml --file scripts/seed-dev-db.sql

-- Test users (all share the same bcrypt password hash; plaintext is in test/.env.test)
INSERT OR IGNORE INTO users (username, email, password_hash, github_username, status, role, email_verified, approved_at, revoked_at)
VALUES ('test-owner', 'testOwner@nemar.org', '$2b$10$JmaHDE03Q2pjaBgWB4jeN.mgLCp9WdSWRpicN4J5gAiJ/YZBRPWIi', 'test-owner-gh', 'approved', 'owner', 1, datetime('now'), NULL);

INSERT OR IGNORE INTO users (username, email, password_hash, github_username, status, role, email_verified, approved_at, revoked_at)
VALUES ('test-admin', 'testAdmin@nemar.org', '$2b$10$JmaHDE03Q2pjaBgWB4jeN.mgLCp9WdSWRpicN4J5gAiJ/YZBRPWIi', 'test-admin-gh', 'approved', 'admin', 1, datetime('now'), NULL);

INSERT OR IGNORE INTO users (username, email, password_hash, github_username, status, role, email_verified, approved_at, revoked_at)
VALUES ('test-user', 'test-user@nemar.test', '$2b$10$JmaHDE03Q2pjaBgWB4jeN.mgLCp9WdSWRpicN4J5gAiJ/YZBRPWIi', 'test-user-gh', 'approved', 'member', 1, datetime('now'), NULL);

INSERT OR IGNORE INTO users (username, email, password_hash, github_username, status, role, email_verified, approved_at, revoked_at)
VALUES ('test-pending', 'test-pending@nemar.test', '$2b$10$JmaHDE03Q2pjaBgWB4jeN.mgLCp9WdSWRpicN4J5gAiJ/YZBRPWIi', 'test-pending-gh', 'pending', 'member', 0, NULL, NULL);

INSERT OR IGNORE INTO users (username, email, password_hash, github_username, status, role, email_verified, approved_at, revoked_at)
VALUES ('test-verified', 'test-verified@nemar.test', '$2b$10$JmaHDE03Q2pjaBgWB4jeN.mgLCp9WdSWRpicN4J5gAiJ/YZBRPWIi', 'test-verified-gh', 'verified', 'member', 1, NULL, NULL);

INSERT OR IGNORE INTO users (username, email, password_hash, github_username, status, role, email_verified, approved_at, revoked_at)
VALUES ('test-revoked', 'test-revoked@nemar.test', '$2b$10$JmaHDE03Q2pjaBgWB4jeN.mgLCp9WdSWRpicN4J5gAiJ/YZBRPWIi', 'test-revoked-gh', 'revoked', 'member', 1, NULL, datetime('now'));

-- API tokens (SHA-256 hashes of TEST_ADMIN_API_KEY and TEST_USER_API_KEY from test/.env.test)
INSERT OR IGNORE INTO tokens (user_id, api_key_hash, api_key_prefix)
SELECT id, '95cd31011dac1cddee0bfdd6e2f01d231b6885908194b4c94c6657396e0c038e', 'nemar_test_9f57c' FROM users WHERE username = 'test-admin';

INSERT OR IGNORE INTO tokens (user_id, api_key_hash, api_key_prefix)
SELECT id, '7cd087c94ae729fafa05243282163c993306b173cfd88b83b32dd92c27ce14f9', 'nemar_test_aeef8' FROM users WHERE username = 'test-user';

-- Test dataset nm099999
INSERT OR IGNORE INTO datasets (dataset_id, name, description, owner_user_id, status, github_repo, visibility, is_sandbox, doi_provider)
SELECT 'nm099999', 'E2E Test Dataset', 'Persistent test dataset for E2E testing',
       id, 'active', 'nemarDatasets/nm099999', 'private', 0, 'ezid'
FROM users WHERE username = 'test-admin';

-- S3 permissions for test users on nm099999
INSERT OR IGNORE INTO user_s3_permissions (user_id, s3_prefix, permission, granted_by)
SELECT id, 'nm099999', 'read_write', id FROM users WHERE username = 'test-admin';

INSERT OR IGNORE INTO user_s3_permissions (user_id, s3_prefix, permission, granted_by)
SELECT id, 'nm099999', 'read_write', id FROM users WHERE username = 'test-user';

-- Verification: confirm seed data exists (check counts manually if unexpected)
SELECT 'users' AS tbl, COUNT(*) AS n FROM users WHERE username LIKE 'test-%';
SELECT 'tokens' AS tbl, COUNT(*) AS n FROM tokens WHERE api_key_prefix LIKE 'nemar_test_%';
SELECT 'datasets' AS tbl, COUNT(*) AS n FROM datasets WHERE dataset_id = 'nm099999';
SELECT 'permissions' AS tbl, COUNT(*) AS n FROM user_s3_permissions WHERE s3_prefix = 'nm099999';
