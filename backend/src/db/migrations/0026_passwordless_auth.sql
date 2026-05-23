-- Passwordless email-code auth for the web dashboard (#569).
--
-- The CLI keeps its existing username+password+API-token flow; the
-- dashboard at nemar.org (moving to app.nemar.org per
-- nemarOrg/website#46) uses a 6-digit code emailed to the user, plus
-- an opaque HttpOnly session cookie.
--
-- Why this migration is so long (and so order-sensitive):
--
--   The "right" fix is to drop NOT NULL on users.username,
--   users.github_username, and users.password_hash so a web-only
--   signup row can exist with email alone. SQLite cannot drop NOT
--   NULL with ALTER TABLE; the table has to be recreated.
--
--   With foreign keys enabled (D1's default), you cannot DROP a
--   parent table while any child table still has a FK pointing at
--   it. So before we can drop `users`, every table referencing it
--   has to be recreated with its FK temporarily pointing at
--   `users_new`. Same story for `datasets`: `dataset_collaborators`
--   references it with ON DELETE CASCADE, so we must recreate
--   `dataset_collaborators` first to repoint at `datasets_new`
--   before we can drop `datasets`. After the final RENAME at the
--   bottom, SQLite's default rename behaviour rewrites every
--   "users_new(id)" / "datasets_new(id)" FK string in the child
--   tables back to "users(id)" / "datasets(id)" — the schema
--   converges to its expected shape with no FK violation along
--   the way.
--
--   Earlier attempts that tried `PRAGMA defer_foreign_keys=TRUE`,
--   `PRAGMA legacy_alter_table=ON`, or `PRAGMA foreign_keys=OFF`
--   all failed: D1 wraps migrations in a transaction, inside of
--   which `foreign_keys=OFF` is a no-op (SQLite docs), and the
--   defer/legacy variants both leave dangling FK strings at the
--   moment we DROP a parent.
--
-- Backups (taken before this migration is applied):
--   backups/20260522-163700/dev-full.sql
--   backups/20260522-163700/prod-full.sql
--   backups/20260522-163700/dev-users-only.sql
--   backups/20260522-163700/prod-users-only.sql
--
-- The recreated `users` column order, plus every child-table
-- schema, mirrors the live schema captured by querying
-- sqlite_master directly on the SCCN dev D1 instance before
-- writing this migration.

------------------------------------------------------------------
-- Phase 1: build the new users table.
------------------------------------------------------------------

CREATE TABLE users_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,                          -- was NOT NULL; web-only signups have NULL until onboarding
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,                            -- was NOT NULL; NULL for web-only (no password ever set)
  github_username TEXT,                          -- was NOT NULL; NULL until onboarding fills it in
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'approved', 'revoked')),
  email_verified INTEGER NOT NULL DEFAULT 0,
  verification_token TEXT,
  verification_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  revoked_at TEXT,
  aws_access_key_id_encrypted TEXT,
  aws_secret_access_key_encrypted TEXT,
  aws_iam_username TEXT,
  sandbox_completed INTEGER NOT NULL DEFAULT 0,
  sandbox_completed_at TEXT,
  sandbox_dataset_id TEXT,
  orcid TEXT,
  role TEXT DEFAULT 'member',
  email_preferences TEXT DEFAULT NULL,
  description TEXT,
  signup_source TEXT NOT NULL DEFAULT 'cli'
    CHECK (signup_source IN ('cli', 'web'))
);

INSERT INTO users_new (
  id, username, email, password_hash, github_username,
  status, email_verified, verification_token, verification_expires_at,
  created_at, updated_at, approved_at, revoked_at,
  aws_access_key_id_encrypted, aws_secret_access_key_encrypted, aws_iam_username,
  sandbox_completed, sandbox_completed_at, sandbox_dataset_id,
  orcid, role, email_preferences, description,
  signup_source
)
SELECT
  id, username, email, password_hash, github_username,
  status, email_verified, verification_token, verification_expires_at,
  created_at, updated_at, approved_at, revoked_at,
  aws_access_key_id_encrypted, aws_secret_access_key_encrypted, aws_iam_username,
  sandbox_completed, sandbox_completed_at, sandbox_dataset_id,
  orcid, role, email_preferences, description,
  'cli'
FROM users;

------------------------------------------------------------------
-- Phase 2: rebuild datasets and its sole child
-- (dataset_collaborators) so we can swap datasets without
-- tripping the FK from dataset_collaborators -> datasets.
------------------------------------------------------------------

-- 2a. datasets_new (FK to users_new). dataset_collaborators still
--     points at the original `datasets` at this point — we recreate
--     it in step 2b before dropping the original.
CREATE TABLE datasets_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  owner_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'deleted')),
  github_repo TEXT,
  concept_doi TEXT,
  latest_version_doi TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  zenodo_concept_id TEXT,
  zenodo_latest_version_id TEXT,
  is_sandbox INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'public')),
  ezid_identifier TEXT,
  ezid_status TEXT,
  doi_provider TEXT NOT NULL DEFAULT 'ezid',
  enrichment_json TEXT,
  enrichment_updated_at TEXT,
  last_activity_at TEXT,
  source TEXT,
  source_id TEXT,
  nemar_sync_status TEXT DEFAULT NULL
    CHECK (nemar_sync_status IN ('synced', 'pending', 'failed')),
  nemar_sync_at TEXT,
  nemar_sync_error TEXT,
  subject_count INTEGER,
  modalities TEXT,
  age_min REAL,
  age_max REAL,
  file_size INTEGER,
  total_files INTEGER,
  tasks TEXT,
  metadata_updated_at TEXT,
  metadata_columns_error TEXT,
  FOREIGN KEY (owner_user_id) REFERENCES users_new(id)
);
INSERT INTO datasets_new SELECT * FROM datasets;

-- 2b. Recreate dataset_collaborators to point at datasets_new and
--     users_new. After this, dataset_collaborators no longer
--     references the original `datasets` table.
CREATE TABLE dataset_collaborators_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id INTEGER NOT NULL REFERENCES datasets_new(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users_new(id) ON DELETE CASCADE,
  granted_by INTEGER REFERENCES users_new(id),
  granted_at TEXT DEFAULT (datetime('now')),
  access_type TEXT NOT NULL CHECK (access_type IN ('requested', 'invited')),
  UNIQUE(dataset_id, user_id)
);
INSERT INTO dataset_collaborators_new SELECT * FROM dataset_collaborators;
DROP TABLE dataset_collaborators;
ALTER TABLE dataset_collaborators_new RENAME TO dataset_collaborators;
CREATE INDEX idx_dataset_collaborators_dataset ON dataset_collaborators(dataset_id);
CREATE INDEX idx_dataset_collaborators_user ON dataset_collaborators(user_id);

-- 2c. Recreate dataset_versions to point at datasets_new(dataset_id).
--     Subtle: this FK targets the TEXT `dataset_id` column on
--     datasets (not the integer `id`), which is why a grep for
--     "REFERENCES datasets(id)" missed it. Same swap pattern.
CREATE TABLE dataset_versions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL REFERENCES datasets_new(dataset_id),
  version TEXT NOT NULL,
  doi TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'ezid',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(dataset_id, version)
);
INSERT INTO dataset_versions_new SELECT * FROM dataset_versions;
DROP TABLE dataset_versions;
ALTER TABLE dataset_versions_new RENAME TO dataset_versions;
CREATE INDEX idx_dataset_versions_dataset ON dataset_versions(dataset_id);

-- 2d. With dataset_collaborators and dataset_versions safely
--     pointing at datasets_new, `datasets` has no child FKs left.
--     Drop and rename.
DROP TABLE datasets;
ALTER TABLE datasets_new RENAME TO datasets;
-- ^ This rewrites every "datasets_new(id)" FK in dataset_collaborators
--   back to "datasets(id)" automatically.
CREATE INDEX idx_datasets_ezid ON datasets(ezid_identifier);
CREATE INDEX idx_datasets_id ON datasets(dataset_id);
CREATE INDEX idx_datasets_modalities ON datasets(modalities);
CREATE INDEX idx_datasets_owner ON datasets(owner_user_id);
CREATE INDEX idx_datasets_sandbox ON datasets(is_sandbox);
CREATE INDEX idx_datasets_status ON datasets(status);
CREATE INDEX idx_datasets_subject_count ON datasets(subject_count);
CREATE INDEX idx_datasets_visibility ON datasets(visibility);
CREATE INDEX idx_datasets_zenodo_concept ON datasets(zenodo_concept_id);

------------------------------------------------------------------
-- Phase 3: recreate the remaining FK-to-users tables to point at
-- users_new. None of these have child FK references TO them, so
-- DROP+RENAME is safe per-table.
------------------------------------------------------------------

-- tokens
CREATE TABLE tokens_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  api_key_prefix TEXT NOT NULL,
  name TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users_new(id) ON DELETE CASCADE
);
INSERT INTO tokens_new SELECT * FROM tokens;
DROP TABLE tokens;
ALTER TABLE tokens_new RENAME TO tokens;
CREATE INDEX idx_tokens_hash ON tokens(api_key_hash);
CREATE INDEX idx_tokens_user ON tokens(user_id);

-- audit_log
CREATE TABLE audit_log_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  details TEXT,
  ip_address TEXT,
  FOREIGN KEY (user_id) REFERENCES users_new(id)
);
INSERT INTO audit_log_new SELECT * FROM audit_log;
DROP TABLE audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;
CREATE INDEX idx_audit_action ON audit_log(action);
CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX idx_audit_user ON audit_log(user_id);

-- user_s3_permissions
CREATE TABLE user_s3_permissions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  s3_prefix TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'read_write'
    CHECK (permission IN ('read', 'write', 'read_write')),
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by INTEGER,
  FOREIGN KEY (user_id) REFERENCES users_new(id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by) REFERENCES users_new(id),
  UNIQUE(user_id, s3_prefix)
);
INSERT INTO user_s3_permissions_new SELECT * FROM user_s3_permissions;
DROP TABLE user_s3_permissions;
ALTER TABLE user_s3_permissions_new RENAME TO user_s3_permissions;
CREATE INDEX idx_user_s3_permissions_prefix ON user_s3_permissions(s3_prefix);
CREATE INDEX idx_user_s3_permissions_user ON user_s3_permissions(user_id);

-- publication_requests
CREATE TABLE publication_requests_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approving', 'published', 'denied', 'blocked')),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  requested_by INTEGER NOT NULL,
  approved_at TEXT,
  approved_by INTEGER,
  denied_at TEXT,
  denied_by INTEGER,
  denied_reason TEXT,
  block_reason TEXT,
  steps_completed TEXT DEFAULT '[]',
  current_step TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (requested_by) REFERENCES users_new(id)
);
INSERT INTO publication_requests_new SELECT * FROM publication_requests;
DROP TABLE publication_requests;
ALTER TABLE publication_requests_new RENAME TO publication_requests;
CREATE INDEX idx_pub_req_dataset ON publication_requests(dataset_id);
CREATE INDEX idx_pub_req_status ON publication_requests(status);

-- notices
CREATE TABLE notices_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info'
    CHECK (level IN ('info', 'warning', 'critical')),
  scope TEXT NOT NULL DEFAULT 'all'
    CHECK (scope IN ('all', 'admins', 'members')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER NOT NULL,
  expires_at TEXT,
  FOREIGN KEY (created_by) REFERENCES users_new(id)
);
INSERT INTO notices_new SELECT * FROM notices;
DROP TABLE notices;
ALTER TABLE notices_new RENAME TO notices;
CREATE INDEX idx_notices_expires ON notices(expires_at);
CREATE INDEX idx_notices_scope ON notices(scope);

-- broadcast_emails
CREATE TABLE broadcast_emails_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_by INTEGER NOT NULL,
  recipient_group TEXT NOT NULL
    CHECK (
      recipient_group IN ('all', 'admins', 'members')
      OR recipient_group GLOB 'user:*'
    ),
  subject TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  failed_recipients TEXT DEFAULT '[]',
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (sent_by) REFERENCES users_new(id)
);
INSERT INTO broadcast_emails_new SELECT * FROM broadcast_emails;
DROP TABLE broadcast_emails;
ALTER TABLE broadcast_emails_new RENAME TO broadcast_emails;
CREATE INDEX idx_broadcast_sent_at ON broadcast_emails(sent_at);
CREATE INDEX idx_broadcast_sent_by ON broadcast_emails(sent_by);

------------------------------------------------------------------
-- Phase 4: swap users_new into the `users` name. After this RENAME
-- SQLite rewrites every "users_new(id)" FK string in the eight
-- now-recreated child tables (tokens, datasets, audit_log,
-- dataset_collaborators, user_s3_permissions, publication_requests,
-- notices, broadcast_emails) back to "users(id)" automatically.
------------------------------------------------------------------

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_status ON users(status);
CREATE UNIQUE INDEX idx_users_github ON users(github_username COLLATE NOCASE);
CREATE INDEX idx_users_role ON users(role);

------------------------------------------------------------------
-- Phase 5: new tables for the passwordless flow.
--
-- auth_codes.code_hash is HMAC-SHA256(code, ENCRYPTION_KEY) hex —
-- keying with the existing AES-GCM secret means an exfiltrated DB
-- alone cannot brute-force the 1M-combo space. `used_at` IS NULL
-- means the code is still active. On verify success or when a new
-- request rotates the active code, we set used_at instead of
-- deleting so the per-email rate limit can keep counting created_at
-- rows within the window.
--
-- web_sessions.cookie_id_hash is SHA-256(cookieIdRaw) hex (unkeyed;
-- the cookie value is 256 bits of entropy, so a preimage attack is
-- impossible even without HMAC keying). `remember` distinguishes
-- 30-day sliding sessions from short-lived ones; the sliding-window
-- refresh in GET /auth/me only touches remember-me cookies.
------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS auth_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_auth_codes_email_active
  ON auth_codes(email, used_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_codes_created_at
  ON auth_codes(created_at);

CREATE TABLE IF NOT EXISTS web_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cookie_id_hash TEXT NOT NULL UNIQUE,
  remember INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_agent TEXT,
  ip_hash TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_web_sessions_user_active
  ON web_sessions(user_id, revoked_at, expires_at);
