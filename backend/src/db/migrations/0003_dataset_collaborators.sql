-- Migration: Add dataset_collaborators table
-- Tracks which users have collaborator access to which datasets

CREATE TABLE IF NOT EXISTS dataset_collaborators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by INTEGER REFERENCES users(id),
  granted_at TEXT DEFAULT (datetime('now')),
  -- 'requested' = user requested access (public repos)
  -- 'invited' = owner/admin invited them (any repo)
  access_type TEXT NOT NULL CHECK (access_type IN ('requested', 'invited')),
  UNIQUE(dataset_id, user_id)
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_dataset_collaborators_dataset ON dataset_collaborators(dataset_id);
CREATE INDEX IF NOT EXISTS idx_dataset_collaborators_user ON dataset_collaborators(user_id);
