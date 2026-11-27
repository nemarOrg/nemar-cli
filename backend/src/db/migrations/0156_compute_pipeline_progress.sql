-- Live progress and checkpoint counts of NEMAR's own pipeline runs (ADR 0134 decisions 3, 4 and 9; epic
-- #2324 phase 2).
--
-- WHAT THIS IS FOR. A pipeline job reports a closed progress object (`nemar.progress.v1`,
-- shared/contract/compute-progress.ts) at most once a minute while it runs: a runner in its heartbeat, a
-- job on the supercomputer on the job-token route. These tables hold what it reported, per run and per
-- checkpoint, and, once the run ends, the counts reconciled from the recordings table it uploaded, which
-- are what the backend writes into neuroschema (`compute_pipeline_documents`).
--
-- `compute_pipeline_progress_runs`, one row per pipeline stamp that reported or was reconciled. Several
-- stamps can share a job (a `tuple_mismatch` hold stamp carries the job of the stamp it holds for), so
-- the job index is not unique; reconciliation skips hold stamps. It is the
-- GATE of every write: a report is one batch whose first statement upserts this row only when the job is
-- in an accepted state, the run is not reconciled and the last report is at least 50 seconds old, and sets
-- a fresh random `write_id`; every later statement of the batch is guarded on that `write_id`, so a refused
-- report writes nothing and two concurrent reports give one winner. `checkpoint` is the current checkpoint
-- the last report named; `reports` counts accepted reports. `reconciled_at` and `outcome` are set together
-- when the run is reconciled (`reconciled`) or found unreconcilable (`table_missing`, `table_unreadable`,
-- `no_checkpoint_map`, `recipe_unknown`); after that no report moves a count. `disagreement` is 1 when the
-- last live counts ran ahead of, or did not total to, the reconciled ones (a broken reporter).
-- `recipe_version` and `declared` (the declared checkpoints in order, `stored` last, as a JSON list) are
-- written when the run is reconciled, so the `stored` row resolves from what the run declared and never
-- from a registry that has moved on.
--
-- `compute_pipeline_progress`, one row per stamp and checkpoint: the four counts, the capped failure list
-- (JSON, validated in code before it is written), the time of the last report, the last live counts once
-- reconciliation replaced them (`live_*`, all four NULL or all four set), whether the row is reconciled,
-- and whether its live counts disagreed. A reconciled row sums to its total; a live one never exceeds it.
-- The `stored` row of a succeeded run waits (`reconciled` 0) until the derivative store decides its copy.
--
-- `compute_pipeline_documents`, one row per dataset, namespace and recipe: the FINAL dataset-level
-- neuroschema `processing` and `signalJourney` entries of the latest ended run, which `/<id>/metadata.json`
-- serves. Nothing live is stored here: the `in_progress` link of a running job is worked out when the
-- document is read, from its dispatched stamp and its run row, so a run that ends without a link never
-- leaves one standing and a new run never erases the last completed link. The entry is JSON built only by
-- shared/compute-checkpoints.ts from registry values and counts; no text a job wrote reaches it. The row of
-- the newest stamp wins.
--
-- `stalled` is not stored: it is worked out on read (shared/compute-checkpoints.ts `pipelineRunStatus`),
-- so no schedule writes it.
--
-- NO FOREIGN KEY. Deleting a dataset deletes these rows in the deletion's batch (services/deletion.ts),
-- with the stamps. No column names a person, holds a credential or a path outside a run's product.
--
-- Every CHECK is named, a numeric column is checked with `typeof(...) = 'integer'`, every term is TRUE or
-- FALSE and never NULL, and every GLOB is at most 50 characters (D1 refuses longer), as 0117 requires.

CREATE TABLE compute_pipeline_progress_runs (
  stamp_id INTEGER PRIMARY KEY NOT NULL CONSTRAINT compute_pipeline_progress_runs_stamp CHECK (
    typeof(stamp_id) = 'integer' AND stamp_id > 0),
  job_id TEXT NOT NULL CONSTRAINT compute_pipeline_progress_runs_job CHECK (
    length(job_id) = 28 AND substr(job_id, 1, 4) = 'job_'
    AND substr(job_id, 5) NOT GLOB '*[^0-9a-f]*'),
  checkpoint TEXT CONSTRAINT compute_pipeline_progress_runs_checkpoint CHECK (
    checkpoint IS NULL OR (length(checkpoint) BETWEEN 1 AND 32
      AND substr(checkpoint, 1, 1) GLOB '[a-z]' AND checkpoint NOT GLOB '*[^a-z0-9_]*')),
  write_id TEXT CONSTRAINT compute_pipeline_progress_runs_write CHECK (
    write_id IS NULL OR (length(write_id) = 32 AND write_id NOT GLOB '*[^0-9a-f]*')),
  reported_at TEXT CONSTRAINT compute_pipeline_progress_runs_reported CHECK (
    reported_at IS NULL OR length(reported_at) = 19),
  reports INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_pipeline_progress_runs_reports CHECK (
    typeof(reports) = 'integer' AND reports >= 0),
  reconciled_at TEXT CONSTRAINT compute_pipeline_progress_runs_reconciled CHECK (
    reconciled_at IS NULL OR length(reconciled_at) = 19),
  outcome TEXT CONSTRAINT compute_pipeline_progress_runs_outcome CHECK (
    outcome IS NULL OR outcome IN ('reconciled', 'table_missing', 'table_unreadable',
      'no_checkpoint_map', 'recipe_unknown')),
  disagreement INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_pipeline_progress_runs_disagreement
    CHECK (typeof(disagreement) = 'integer' AND disagreement IN (0, 1)),
  recipe_version TEXT CONSTRAINT compute_pipeline_progress_runs_recipe_version CHECK (
    recipe_version IS NULL OR (length(recipe_version) BETWEEN 1 AND 64
      AND recipe_version NOT GLOB '*[^0-9A-Za-z._+-]*')),
  declared TEXT CONSTRAINT compute_pipeline_progress_runs_declared CHECK (
    declared IS NULL OR (length(declared) BETWEEN 2 AND 512 AND substr(declared, 1, 1) = '[')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- A run is reconciled exactly when it has an outcome.
  CONSTRAINT compute_pipeline_progress_runs_outcome_iff CHECK (
    (reconciled_at IS NULL) = (outcome IS NULL))
);

-- A run from its job (not unique: a hold stamp shares its job).
CREATE INDEX compute_pipeline_progress_runs_job ON compute_pipeline_progress_runs (job_id);

-- The runs reconciliation has not decided.
CREATE INDEX compute_pipeline_progress_runs_open ON compute_pipeline_progress_runs (stamp_id)
  WHERE reconciled_at IS NULL;

CREATE TABLE compute_pipeline_progress (
  stamp_id INTEGER NOT NULL CONSTRAINT compute_pipeline_progress_stamp CHECK (
    typeof(stamp_id) = 'integer' AND stamp_id > 0),
  checkpoint TEXT NOT NULL CONSTRAINT compute_pipeline_progress_checkpoint CHECK (
    length(checkpoint) BETWEEN 1 AND 32 AND substr(checkpoint, 1, 1) GLOB '[a-z]'
    AND checkpoint NOT GLOB '*[^a-z0-9_]*'),
  passed INTEGER NOT NULL CONSTRAINT compute_pipeline_progress_passed CHECK (
    typeof(passed) = 'integer' AND passed BETWEEN 0 AND 1000000),
  failed INTEGER NOT NULL CONSTRAINT compute_pipeline_progress_failed CHECK (
    typeof(failed) = 'integer' AND failed BETWEEN 0 AND 1000000),
  skipped INTEGER NOT NULL CONSTRAINT compute_pipeline_progress_skipped CHECK (
    typeof(skipped) = 'integer' AND skipped BETWEEN 0 AND 1000000),
  total INTEGER NOT NULL CONSTRAINT compute_pipeline_progress_total CHECK (
    typeof(total) = 'integer' AND total BETWEEN 0 AND 1000000),
  failures TEXT NOT NULL DEFAULT '[]' CONSTRAINT compute_pipeline_progress_failures CHECK (
    length(failures) BETWEEN 2 AND 8192 AND substr(failures, 1, 1) = '['),
  reported_at TEXT NOT NULL CONSTRAINT compute_pipeline_progress_reported CHECK (
    length(reported_at) = 19),
  live_passed INTEGER CONSTRAINT compute_pipeline_progress_live_passed CHECK (
    live_passed IS NULL OR (typeof(live_passed) = 'integer' AND live_passed BETWEEN 0 AND 1000000)),
  live_failed INTEGER CONSTRAINT compute_pipeline_progress_live_failed CHECK (
    live_failed IS NULL OR (typeof(live_failed) = 'integer' AND live_failed BETWEEN 0 AND 1000000)),
  live_skipped INTEGER CONSTRAINT compute_pipeline_progress_live_skipped CHECK (
    live_skipped IS NULL
    OR (typeof(live_skipped) = 'integer' AND live_skipped BETWEEN 0 AND 1000000)),
  live_total INTEGER CONSTRAINT compute_pipeline_progress_live_total CHECK (
    live_total IS NULL OR (typeof(live_total) = 'integer' AND live_total BETWEEN 0 AND 1000000)),
  reconciled INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_pipeline_progress_reconciled CHECK (
    typeof(reconciled) = 'integer' AND reconciled IN (0, 1)),
  disagreement INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_pipeline_progress_disagreement CHECK (
    typeof(disagreement) = 'integer' AND disagreement IN (0, 1)),
  PRIMARY KEY (stamp_id, checkpoint),
  -- No column counts more than its total, and a reconciled one sums to it.
  CONSTRAINT compute_pipeline_progress_within_total CHECK (passed + failed + skipped <= total),
  CONSTRAINT compute_pipeline_progress_reconciled_sums CHECK (
    reconciled = 0 OR passed + failed + skipped = total),
  -- The last live counts are kept whole or not at all.
  CONSTRAINT compute_pipeline_progress_live_whole CHECK (
    (live_passed IS NULL AND live_failed IS NULL AND live_skipped IS NULL AND live_total IS NULL)
    OR (live_passed IS NOT NULL AND live_failed IS NOT NULL AND live_skipped IS NOT NULL
      AND live_total IS NOT NULL))
);

-- The `stored` rows waiting for the derivative store.
CREATE INDEX compute_pipeline_progress_stored_open ON compute_pipeline_progress (stamp_id)
  WHERE checkpoint = 'stored' AND reconciled = 0;

CREATE TABLE compute_pipeline_documents (
  dataset_id TEXT NOT NULL CONSTRAINT compute_pipeline_documents_dataset CHECK (
    length(dataset_id) = 8 AND substr(dataset_id, 1, 2) NOT GLOB '*[^a-z]*'
    AND substr(dataset_id, 3) NOT GLOB '*[^0-9]*'),
  namespace TEXT NOT NULL CONSTRAINT compute_pipeline_documents_namespace CHECK (
    namespace IN ('processing', 'signalJourney')),
  recipe TEXT NOT NULL CONSTRAINT compute_pipeline_documents_recipe CHECK (
    length(recipe) BETWEEN 1 AND 64 AND recipe NOT GLOB '*[^a-z0-9-]*'),
  stamp_id INTEGER NOT NULL CONSTRAINT compute_pipeline_documents_stamp CHECK (
    typeof(stamp_id) = 'integer' AND stamp_id > 0),
  entry TEXT NOT NULL CONSTRAINT compute_pipeline_documents_entry CHECK (
    length(entry) BETWEEN 2 AND 65536 AND substr(entry, 1, 1) = '{'),
  written_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (dataset_id, namespace, recipe)
);

-- A stamp's documents (reconciliation and deletion).
CREATE INDEX compute_pipeline_documents_stamp ON compute_pipeline_documents (stamp_id);
