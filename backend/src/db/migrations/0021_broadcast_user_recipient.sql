-- Issue #381: allow per-user transactional sends via `nemar admin notify --user`.
--
-- The original CHECK constraint on broadcast_emails.recipient_group restricted
-- it to 'all' | 'admins' | 'members'. Single-user sends record
-- `user:<username>` so the audit trail distinguishes targeted transactional
-- emails from group broadcasts.
--
-- SQLite can't ALTER an existing CHECK constraint, so we rebuild the table.
-- All existing rows are preserved verbatim (their group values already match
-- the original enum and pass the new check).
--
-- Cloudflare D1 forbids explicit `BEGIN TRANSACTION` / `COMMIT` SQL statements
-- (error code 7500) — the runtime already wraps each migration in an atomic
-- transaction. No PRAGMA foreign_keys toggle is needed either: no other table
-- references broadcast_emails, and the new table's FK to users(id) is
-- satisfied by the existing rows being INSERTed.

CREATE TABLE broadcast_emails_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_by INTEGER NOT NULL,
  recipient_group TEXT NOT NULL
    CHECK (
      recipient_group IN ('all', 'admins', 'members')
      OR recipient_group LIKE 'user:%'
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
