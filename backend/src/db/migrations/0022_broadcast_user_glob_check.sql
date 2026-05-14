-- Issue #488: tighten the broadcast_emails recipient_group CHECK to be
-- case-sensitive on the `user:` prefix.
--
-- 0021 used `LIKE 'user:%'`, which SQLite/D1 evaluate case-insensitively, so
-- 'User:alex' would silently pass even though every CLI path produces
-- lowercase `user:` prefixes via getBroadcastRecipientByUsername in
-- backend/src/routes/admin.ts. A future direct-SQL insert or refactor that
-- uppercased the prefix could bypass the intended invariant.
--
-- GLOB is case-sensitive and otherwise behaves like LIKE for the `*`
-- wildcard. Swap to GLOB so any future write that doesn't lowercase the
-- prefix is rejected at the database boundary.
--
-- Note on `user:` with an empty suffix: `GLOB 'user:*'` matches zero or
-- more trailing characters, so a literal `'user:'` value technically
-- passes the CHECK. The DB does not enforce a minimum username length —
-- that invariant lives in the application layer (signupSchema in
-- backend/src/routes/auth.ts requires /^[a-zA-Z0-9_-]+$/ with length >= 3,
-- and getBroadcastRecipientByUsername validates the username against the
-- users table before constructing the prefix). Adding a
-- `length(recipient_group) > 5` clause here would duplicate that check
-- at the DB boundary at the cost of locking the migration to a specific
-- username-length policy; we keep the CHECK minimal.
--
-- Same SQLite/D1 caveats as 0021: rebuild the table to swap the CHECK; no
-- explicit BEGIN/COMMIT (D1 rejects them with error 7500 — the runtime
-- already wraps each migration in a transaction); no foreign_keys PRAGMA
-- toggle needed (no inbound FKs reference broadcast_emails).

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
  FOREIGN KEY (sent_by) REFERENCES users(id)
);

INSERT INTO broadcast_emails_new (
  id, sent_by, recipient_group, subject, body_markdown,
  recipient_count, failure_count, failed_recipients, sent_at
)
SELECT
  id, sent_by, recipient_group, subject, body_markdown,
  recipient_count, failure_count, failed_recipients, sent_at
FROM broadcast_emails;

DROP TABLE broadcast_emails;

ALTER TABLE broadcast_emails_new RENAME TO broadcast_emails;

CREATE INDEX IF NOT EXISTS idx_broadcast_sent_at ON broadcast_emails(sent_at);
CREATE INDEX IF NOT EXISTS idx_broadcast_sent_by ON broadcast_emails(sent_by);
