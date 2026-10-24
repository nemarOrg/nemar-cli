-- The identifier screen of a re-pull pull request (epic #1046 phase 6, #1912; ADR 0111,
-- decisions 7 and 9).
--
-- WHAT THIS IS FOR. A re-pull makes no publication request, so the identifier screen gates its
-- merge instead (decision 9), and decision 7 says that screen is "dispatched with ref=<head sha>
-- and a callback bound to the re-pull row". The publication screen's columns live on
-- `publication_requests` and its sweep's on `datasets.sweep_stamps`; neither is a re-pull's, so a
-- re-pull's screens get this table. One row is one screen of one commit of one of the re-pull's
-- two pull requests: `n0` is N.0.0's, `n1` is N.0.1's. A head that moves gets a new row; the old
-- row keeps the verdict about the old commit, which no gate reads again.
--
-- WHAT A ROW HOLDS. `status` is the screen's state in the publication screen's words
-- (shared/identifier-screen-report.ts): `pending` while a run is out, the scan's status once it
-- reported, `error` when it could not run. `unreported` is in the list so the words match, but no
-- writer stores it: a `pending` row older than the report deadline is READ as `unreported`, at read
-- time, so no cron is needed. `report` is only ever the parser's output, re-serialized. `nonce` is
-- the one-shot callback secret: set while the run is out, cleared when its result is stored, so a
-- replay finds nothing to verify against; a pending row keeps it past the deadline, so a late
-- report still lands until a new dispatch replaces the row's nonce.
--
-- ACKNOWLEDGMENT. A screen that asks for a person (review, unchecked, not-screened, an EDF-only
-- clean) may carry an administrator's recorded reason; a direct identifier never can, and a CHECK
-- refuses an acknowledgment on any other state. The three columns are set together or not at all.
--
-- ONE RUN OUT PER RE-PULL. The callback finds its nonce by dataset (the workflow echoes only the
-- dataset id), so at most one screen of a re-pull may wait for a report, which the partial unique
-- index pins; with one open re-pull per dataset (migration 0105) that is one per dataset.
--
-- Every CHECK term is TRUE or FALSE, never NULL (a CHECK passes on NULL). The foreign key cascades
-- on D1, which enforces foreign keys; `deleteDatasetCascade` also deletes these rows explicitly,
-- before the re-pull rows, rather than trusting the pragma.

CREATE TABLE upstream_repull_screens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repull_id INTEGER NOT NULL REFERENCES upstream_repulls(id) ON DELETE CASCADE,
  pr TEXT NOT NULL CHECK (pr IN ('n0', 'n1')),
  sha TEXT NOT NULL CHECK (length(sha) = 40 AND sha NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'direct-identifiers', 'dates-only', 'review',
    'clean', 'clean-edf-only-others-unscreened', 'not-screened', 'no-recordings', 'unchecked',
    'error', 'unreported')),
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
    'clean-edf-only-others-unscreened'))
);

CREATE UNIQUE INDEX upstream_repull_screens_one_waiting ON upstream_repull_screens (repull_id)
  WHERE nonce IS NOT NULL;
