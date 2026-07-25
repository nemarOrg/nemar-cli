-- Issue #1025: widen the notice `level` vocabulary.
--
-- The original CHECK on notices.level restricted it to 'info' | 'warning' |
-- 'critical'. Three levels collapse distinctions the site actually needs to
-- communicate: good news (a conference, a release, a milestone) had to ship
-- as 'info' and render identically to an operational note, and a planned
-- maintenance window had to borrow either 'critical' (crying wolf) or 'info'
-- (under-selling it).
--
-- New vocabulary, most urgent first:
--   critical     - live outage, data at risk
--   warning      - degraded right now
--   maintenance  - planned or in-progress work window
--   announcement - good news
--   tip          - low-key hint or standing note  (was 'info')
--
-- 'warning' and 'critical' keep their meaning and need no data change.
-- 'info' is renamed to 'tip'; the API still ACCEPTS 'info' on write and
-- normalizes it (see routes/admin/notices.ts), so existing CLI invocations
-- and scripts passing --level info keep working. Only the stored vocabulary
-- narrows.
--
-- SQLite can't ALTER an existing CHECK constraint, so we rebuild the table,
-- mirroring 0021_broadcast_user_recipient.sql.
--
-- The info -> tip rename happens INSIDE the copy's SELECT, not as an UPDATE
-- beforehand. A pre-UPDATE cannot work: it would run against the old table,
-- whose CHECK still forbids 'tip', so it fails outright — and on a runner
-- that swallows the error (bun:sqlite's multi-statement exec does) the
-- subsequent DROP would take every row with it. Mapping in the SELECT means
-- the value only ever has to satisfy the NEW table's constraint. Regression
-- test: backend/test/notice-levels.test.ts.
--
-- Also repoints the created_by foreign key at `users`. The pre-existing
-- definition still said `users_new`, a leftover from 0026's users table
-- rebuild (the FK text kept the scratch name after the RENAME). Same target
-- table either way; this just stops propagating a confusing name.
--
-- Cloudflare D1 forbids explicit BEGIN/COMMIT (error 7500) — the runtime
-- wraps each migration in an atomic transaction already. No PRAGMA
-- foreign_keys toggle is needed: no other table references notices, and the
-- new table's FK is satisfied by the rows being INSERTed.

CREATE TABLE notices_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'tip'
    CHECK (level IN ('tip', 'announcement', 'maintenance', 'warning', 'critical')),
  scope TEXT NOT NULL DEFAULT 'all'
    CHECK (scope IN ('all', 'admins', 'members')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER NOT NULL,
  expires_at TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

INSERT INTO notices_new (id, message, level, scope, created_at, created_by, expires_at)
SELECT
  id,
  message,
  CASE level WHEN 'info' THEN 'tip' ELSE level END,
  scope,
  created_at,
  created_by,
  expires_at
FROM notices;

DROP TABLE notices;

ALTER TABLE notices_new RENAME TO notices;

CREATE INDEX IF NOT EXISTS idx_notices_scope ON notices(scope);
CREATE INDEX IF NOT EXISTS idx_notices_expires ON notices(expires_at);
