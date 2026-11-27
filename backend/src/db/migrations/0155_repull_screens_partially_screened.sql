-- A re-pull screen may store `partially-screened` (epic #2182 phase A1, #2185; lead ruling
-- 2026-11-25).
--
-- WHY. The identifier screen's report version 2 counts recordings per format reader, and says
-- `partially-screened` where version 1 said `clean-edf-only-others-unscreened`: the recordings a
-- reader parses are clean, and other recordings are in formats none parses. The gate is the same
-- (`acknowledge`). Migration 0106 lists the statuses in two CHECKs of `upstream_repull_screens`,
-- the status itself and the states an acknowledgment may be recorded on, so a version-2 verdict
-- of that word could be neither stored nor acknowledged. Both lists gain the word; the old one
-- stays, because rows written under version 1 keep it.
--
-- HOW. SQLite cannot change a CHECK in place, so the table is rebuilt: a new table with the
-- widened CHECKs, every row copied with its id, the old table dropped, the new one renamed, and
-- the partial unique index made again. Nothing references this table, so the drop cascades
-- nowhere; its own foreign key to `upstream_repulls` is declared again unchanged. Every other
-- column, CHECK and default is 0106's, verbatim.

CREATE TABLE upstream_repull_screens_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repull_id INTEGER NOT NULL REFERENCES upstream_repulls(id) ON DELETE CASCADE,
  pr TEXT NOT NULL CHECK (pr IN ('n0', 'n1')),
  sha TEXT NOT NULL CHECK (length(sha) = 40 AND sha NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'direct-identifiers', 'dates-only', 'review',
    'clean', 'partially-screened', 'clean-edf-only-others-unscreened', 'not-screened',
    'no-recordings', 'unchecked', 'error', 'unreported')),
  nonce TEXT CHECK (nonce IS NULL OR length(nonce) > 0),
  report TEXT CHECK (report IS NULL OR json_valid(report)),
  dispatched_at TEXT NOT NULL DEFAULT (datetime('now')),
  reported_at TEXT,
  ack_by INTEGER,
  ack_reason TEXT,
  ack_at TEXT,
  UNIQUE (repull_id, pr, sha),
  CHECK ((status IN ('pending', 'unreported')) = (report IS NULL)),
  CHECK ((reported_at IS NULL) = (report IS NULL)),
  CHECK (nonce IS NULL OR status IN ('pending', 'unreported')),
  CHECK ((ack_at IS NULL) = (ack_by IS NULL)),
  CHECK ((ack_at IS NULL) = (ack_reason IS NULL)),
  CHECK (ack_at IS NULL OR status IN ('review', 'unchecked', 'not-screened',
    'partially-screened', 'clean-edf-only-others-unscreened'))
);

INSERT INTO upstream_repull_screens_new (id, repull_id, pr, sha, status, nonce, report,
  dispatched_at, reported_at, ack_by, ack_reason, ack_at)
SELECT id, repull_id, pr, sha, status, nonce, report, dispatched_at, reported_at, ack_by,
  ack_reason, ack_at
  FROM upstream_repull_screens;

DROP TABLE upstream_repull_screens;
ALTER TABLE upstream_repull_screens_new RENAME TO upstream_repull_screens;

CREATE UNIQUE INDEX upstream_repull_screens_one_waiting ON upstream_repull_screens (repull_id)
  WHERE nonce IS NOT NULL;
