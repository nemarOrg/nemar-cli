-- The record of the automatic re-pull path (epic #1046 phase 7, #1913; ADR 0111, decisions 6
-- and 7).
--
-- WHAT THIS IS FOR. The automatic path runs a re-pull unattended: the Worker dispatches a central
-- workflow, the workflow runs the administrator's commands (plan, execute, resume) on a runner,
-- and reports back. Three facts need a home, and none of them belongs on `upstream_repulls`:
--   * the DISPATCH: what the Worker asked a run to do, with what one-shot secret, and what the run
--     said back (`upstream_repull_dispatches`);
--   * the SCHEDULER's cursor and its last tick (`upstream_repull_scheduler`, one row);
--   * why an automatic re-pull is HELD where it is (`hold_reason`, `hold_since` on
--     `upstream_repulls`), an observation a later tick writes without moving the row.
--
-- WHY A SEPARATE TABLE FOR DISPATCHES. A dispatch exists before any re-pull row does: the run
-- creates the row, and a run that refuses before its first write creates none. A dispatch for a
-- re-pull that already exists (a resume, the finish after the merge) is a second dispatch of the
-- same row. So one re-pull row has any number of dispatches, and some dispatches have no row.
--
-- WHAT A ROW HOLDS.
--   * `kind`: `open` runs a plan to an open pull request (or resumes a row that stalled before
--     it); `finish` walks a merged re-pull to `complete`.
--   * `status`: `dispatched` when the Worker sent it, `started` when the run said so, then the run's
--     own last word (`opened`, `finished`, `refused`, `failed`), or the Worker's: `dispatch_failed`
--     when GitHub refused the dispatch (so it never ran and frees its unit of the open cap), and
--     `unreported` when the run said nothing within its deadline.
--   * `code`: a fixed word (`shared/repull-state.ts`, DISPATCH_CODES), never a path, a key or a
--     message. Required on every failure, so a failure always says which.
--   * `repull_id`: the re-pull row the dispatch is about. NULL for a first `open` dispatch until the
--     run creates its row; set at the claim for a resume and for a `finish`.
--
-- WHAT NULL MEANS, AND WHY THE NONCE LIVES ONLY WHILE THE RUN IS LIVE. `nonce` is the one-shot
-- secret the run's token is signed over. It is set exactly while the dispatch is live
-- (`dispatched`, `started`) and cleared by the edge that ends it, so a token replayed after its
-- run ended has nothing to verify against. One live dispatch per dataset (the partial unique
-- index), which is also what keeps two runs from working on one dataset at once.
--
-- Every CHECK term is TRUE or FALSE, never NULL: a CHECK passes on NULL, so a term that could be
-- NULL would let the row in. NO FOREIGN KEY to `datasets` or `upstream_repulls`, as migration
-- 0105: `deleteDatasetCascade` deletes these rows before the re-pull rows. Only an `on` dataset
-- is ever re-pulled automatically, so the table refuses any other id. `datasets` gains nothing, so
-- ADR 0034's column budget is untouched.

CREATE TABLE upstream_repull_dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('open', 'finish')),
  dataset_id TEXT NOT NULL CHECK (dataset_id GLOB 'on[0-9][0-9][0-9][0-9][0-9][0-9]'),
  upstream_ds TEXT NOT NULL CHECK (upstream_ds GLOB 'ds[0-9][0-9][0-9][0-9][0-9][0-9]'),
  from_tag TEXT NOT NULL CHECK (length(from_tag) BETWEEN 1 AND 64
    AND from_tag NOT GLOB '*[^0-9A-Za-z._-]*'),
  to_tag TEXT NOT NULL CHECK (length(to_tag) BETWEEN 1 AND 64
    AND to_tag NOT GLOB '*[^0-9A-Za-z._-]*'),
  repull_id INTEGER CHECK (repull_id IS NULL OR repull_id >= 1),
  nonce TEXT CHECK (nonce IS NULL OR length(nonce) BETWEEN 32 AND 64),
  status TEXT NOT NULL CHECK (status IN ('dispatched', 'started', 'opened', 'finished',
    'refused', 'failed', 'unreported', 'dispatch_failed')),
  code TEXT CHECK (code IS NULL OR (length(code) BETWEEN 1 AND 64 AND code NOT GLOB '*[^a-z0-9-]*')),
  workflow_run_url TEXT CHECK (workflow_run_url IS NULL OR (
    substr(workflow_run_url, 1, 54) = 'https://github.com/nemarDatasets/.github/actions/runs/'
    AND length(workflow_run_url) BETWEEN 55 AND 74
    AND substr(workflow_run_url, 55) NOT GLOB '*[^0-9]*')),
  dispatched_at TEXT NOT NULL DEFAULT (datetime('now')),
  reported_at TEXT,
  CHECK (from_tag <> to_tag),
  CHECK ((nonce IS NOT NULL) = (status IN ('dispatched', 'started'))),
  CHECK (status NOT IN ('refused', 'failed', 'dispatch_failed') OR code IS NOT NULL),
  CHECK (kind <> 'finish' OR repull_id IS NOT NULL),
  CHECK (status <> 'opened' OR (kind = 'open' AND repull_id IS NOT NULL)),
  CHECK (status <> 'finished' OR kind = 'finish'),
  CHECK (status NOT IN ('started', 'opened', 'finished', 'refused', 'failed')
    OR reported_at IS NOT NULL),
  CHECK (status NOT IN ('dispatched', 'dispatch_failed') OR reported_at IS NULL)
);

CREATE UNIQUE INDEX upstream_repull_dispatches_one_live ON upstream_repull_dispatches (dataset_id)
  WHERE nonce IS NOT NULL;

CREATE INDEX upstream_repull_dispatches_day ON upstream_repull_dispatches (dispatched_at);

CREATE INDEX upstream_repull_dispatches_dataset
  ON upstream_repull_dispatches (dataset_id, dispatched_at);

CREATE INDEX upstream_repull_dispatches_repull ON upstream_repull_dispatches (repull_id)
  WHERE repull_id IS NOT NULL;

-- The scheduler's one row: where the next daily scan starts (`scan_after`, a dataset id, '' for
-- the start of the fleet), when it last ran, what it concluded (a fixed word), and when the
-- advance tick last ran. The scheduler and the advance tick (upstream-repull-scheduler.ts and
-- upstream-repull-advance.ts) only update it; this migration creates the row.
CREATE TABLE upstream_repull_scheduler (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  scan_after TEXT NOT NULL DEFAULT '',
  last_tick_at TEXT,
  last_outcome TEXT CHECK (last_outcome IS NULL OR (length(last_outcome) BETWEEN 1 AND 64
    AND last_outcome NOT GLOB '*[^a-z0-9-]*')),
  last_advance_at TEXT
);

INSERT INTO upstream_repull_scheduler (id) VALUES (1);

-- Why an automatic re-pull waits where it is: a fixed word (REPULL_HOLD_REASONS in
-- shared/repull-state.ts) and since when. A hold is an observation, not a transition, so it does
-- not move the row. The two are set together or not at all, and only on an automatic row: the
-- administrator's rows are never held by the Worker.
ALTER TABLE upstream_repulls ADD COLUMN hold_reason TEXT
  CHECK (hold_reason IS NULL OR (length(hold_reason) BETWEEN 1 AND 64
    AND hold_reason NOT GLOB '*[^a-z0-9-]*' AND origin = 'automatic'));
ALTER TABLE upstream_repulls ADD COLUMN hold_since TEXT
  CHECK ((hold_since IS NULL) = (hold_reason IS NULL));
