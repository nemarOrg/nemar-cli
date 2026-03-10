-- Add block_reason column and 'blocked' status to publication_requests
-- SQLite cannot ALTER CHECK constraints, so we recreate the table.

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
  FOREIGN KEY (requested_by) REFERENCES users(id)
);

INSERT INTO publication_requests_new
  SELECT id, dataset_id, status, requested_at, requested_by,
         approved_at, approved_by, denied_at, denied_by, denied_reason,
         NULL as block_reason,
         steps_completed, current_step, last_error, updated_at
  FROM publication_requests;

DROP TABLE publication_requests;
ALTER TABLE publication_requests_new RENAME TO publication_requests;

CREATE INDEX IF NOT EXISTS idx_pub_req_status ON publication_requests(status);
CREATE INDEX IF NOT EXISTS idx_pub_req_dataset ON publication_requests(dataset_id);
