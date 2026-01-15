-- Test Users Setup
-- Run with: cd backend && wrangler d1 execute nemar-db --remote --file ../scripts/test-users.sql

-- test-user (regular approved user)
INSERT INTO users (username, email, password_hash, github_username, status, is_admin, email_verified, approved_at, revoked_at)
VALUES ('test-user', 'test-user@nemar.test', '$2b$10$JmaHDE03Q2pjaBgWB4jeN.mgLCp9WdSWRpicN4J5gAiJ/YZBRPWIi', 'test-user-gh', 'approved', 0, 1, datetime('now'), NULL);

-- test-pending (user awaiting email verification)
INSERT INTO users (username, email, password_hash, github_username, status, is_admin, email_verified, approved_at, revoked_at)
VALUES ('test-pending', 'test-pending@nemar.test', '$2b$10$JmaHDE03Q2pjaBgWB4jeN.mgLCp9WdSWRpicN4J5gAiJ/YZBRPWIi', 'test-pending-gh', 'pending', 0, 0, NULL, NULL);

-- test-verified (user awaiting admin approval)
INSERT INTO users (username, email, password_hash, github_username, status, is_admin, email_verified, approved_at, revoked_at)
VALUES ('test-verified', 'test-verified@nemar.test', '$2b$10$JmaHDE03Q2pjaBgWB4jeN.mgLCp9WdSWRpicN4J5gAiJ/YZBRPWIi', 'test-verified-gh', 'verified', 0, 1, NULL, NULL);

-- test-revoked (user with revoked access)
INSERT INTO users (username, email, password_hash, github_username, status, is_admin, email_verified, approved_at, revoked_at)
VALUES ('test-revoked', 'test-revoked@nemar.test', '$2b$10$JmaHDE03Q2pjaBgWB4jeN.mgLCp9WdSWRpicN4J5gAiJ/YZBRPWIi', 'test-revoked-gh', 'revoked', 0, 1, NULL, datetime('now'));

-- Create API tokens for approved users
INSERT INTO tokens (user_id, api_key_hash, api_key_prefix)
SELECT id, '95cd31011dac1cddee0bfdd6e2f01d231b6885908194b4c94c6657396e0c038e', 'nemar_test_9f57c' FROM users WHERE username = 'test-admin';

INSERT INTO tokens (user_id, api_key_hash, api_key_prefix)
SELECT id, '7cd087c94ae729fafa05243282163c993306b173cfd88b83b32dd92c27ce14f9', 'nemar_test_aeef8' FROM users WHERE username = 'test-user';
