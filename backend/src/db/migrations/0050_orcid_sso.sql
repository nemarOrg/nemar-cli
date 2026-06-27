-- ORCID SSO: OAuth identities + verified-iD flag + session auth method (#832).
--
-- ORCID becomes a login provider alongside the passwordless email-code flow
-- (0026). Accounts are linked by ORCID iD (the OAuth `orcid`/`sub`), never by
-- email: ORCID keeps email private by default and returns no email claim, so
-- email is not a reliable join key and auto-linking on it is an account-takeover
-- vector.
--
--   oauth_identities         - one row per linked provider account. UNIQUE
--                              (provider, provider_subject) makes "one ORCID ->
--                              one NEMAR account" a DB invariant; the FK cascade
--                              drops the link when a user is hard-deleted.
--   users.orcid_verified     - distinguishes an OAuth-proven iD from the
--                              DOI-*discovered* value already in users.orcid
--                              (0026:72), which is citation-facing and must not
--                              be overwritten by a login. provider_subject in
--                              oauth_identities is always the source of truth for
--                              the verified iD; users.orcid stays the citation
--                              value, and orcid_verified=1 means the two agree.
--   web_sessions.auth_method - 'email_code' | 'orcid'; lets /auth/me and admin
--                              tooling tell how a session was established.
--
-- Additive only (CREATE TABLE + ADD COLUMN), so unlike 0026 there is no table
-- rebuild and no FK gymnastics.

CREATE TABLE IF NOT EXISTS oauth_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('orcid')),
  provider_subject TEXT NOT NULL,   -- ORCID iD, e.g. 0000-0001-2345-6789
  provider_email TEXT,              -- usually NULL (ORCID email private by default)
  display_name TEXT,
  connected_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT,
  UNIQUE (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS idx_oauth_identities_user ON oauth_identities(user_id);

ALTER TABLE users ADD COLUMN orcid_verified INTEGER NOT NULL DEFAULT 0;

ALTER TABLE web_sessions ADD COLUMN auth_method TEXT;  -- 'email_code' | 'orcid'
