-- Active notices displayed to CLI users
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info'
    CHECK (level IN ('info', 'warning', 'critical')),
  scope TEXT NOT NULL DEFAULT 'all'
    CHECK (scope IN ('all', 'admins', 'members')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER NOT NULL,
  expires_at TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_notices_scope ON notices(scope);
CREATE INDEX IF NOT EXISTS idx_notices_expires ON notices(expires_at);
