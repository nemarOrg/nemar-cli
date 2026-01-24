-- NEMAR Database Schema
-- Migration: 0005_publication_requests
-- Description: Add publication request tracking for the publish workflow

CREATE TABLE IF NOT EXISTS publication_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approving', 'published', 'denied')),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  requested_by INTEGER NOT NULL,
  approved_at TEXT,
  approved_by INTEGER,
  denied_at TEXT,
  denied_by INTEGER,
  denied_reason TEXT,
  steps_completed TEXT DEFAULT '[]',
  current_step TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (requested_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_pub_req_status ON publication_requests(status);
CREATE INDEX IF NOT EXISTS idx_pub_req_dataset ON publication_requests(dataset_id);
