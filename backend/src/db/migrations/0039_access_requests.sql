-- Access-request queue for private/unpublished datasets (epic #713, phase #715).
--
-- Before this, POST /datasets/:id/request-access auto-granted GitHub `push` +
-- an S3 read_write row to ANY approved user on ANY dataset (public or private)
-- with no owner approval and without even reading the dataset's visibility. That
-- is the platform's biggest authorization gap: a regular account could self-
-- grant write to private research data.
--
-- New model (publish-gated, see #713):
--   * PUBLIC/published dataset  -> request-access grants NOTHING (the data is
--     already world-readable; contributions come via PR, write via invite).
--   * PRIVATE/unpublished       -> request-access records a PENDING row here and
--     notifies the owner; the owner/admin approves or denies. Only on approve is
--     a `dataset_collaborators` row + S3 permission created.
--
-- This table is deliberately SEPARATE from `dataset_collaborators`: a row in
-- that table always means "has access", and it carries a UNIQUE(dataset_id,
-- user_id) + a 409 "already a collaborator" guard. Folding a pending/denied
-- status into it would trip that guard and be miscounted as access. Here a row
-- is a request with its own lifecycle; access is granted elsewhere.
--
-- One row per (dataset, user): a re-request after a denial upserts the same row
-- back to 'pending' (ON CONFLICT ... DO UPDATE), so the queue never accumulates
-- duplicates and a denied user can ask again.

CREATE TABLE IF NOT EXISTS access_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT,
  decided_by INTEGER,
  UNIQUE (dataset_id, user_id),
  FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  FOREIGN KEY (decided_by) REFERENCES users (id) ON DELETE SET NULL
);

-- Owner/admin listing of the pending queue for a dataset.
CREATE INDEX IF NOT EXISTS idx_access_requests_dataset_status
  ON access_requests (dataset_id, status);

-- "my requests" lookups and FK-driven cascades.
CREATE INDEX IF NOT EXISTS idx_access_requests_user
  ON access_requests (user_id);
