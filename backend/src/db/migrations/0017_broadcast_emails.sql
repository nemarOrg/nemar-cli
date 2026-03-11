-- Audit log for admin broadcast emails
CREATE TABLE IF NOT EXISTS broadcast_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_by INTEGER NOT NULL,
  recipient_group TEXT NOT NULL
    CHECK (recipient_group IN ('all', 'admins', 'members')),
  subject TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  failed_recipients TEXT DEFAULT '[]',
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (sent_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_broadcast_sent_at ON broadcast_emails(sent_at);
CREATE INDEX IF NOT EXISTS idx_broadcast_sent_by ON broadcast_emails(sent_by);
