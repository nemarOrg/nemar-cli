-- Migration 0044: import_jobs table for OpenNeuro->NEMAR import state (#754,
-- epic #749 Phase 5).
--
-- OpenNeuro imports are a 3-job CI fan-out (prepare -> copy[matrix shard] ->
-- finalize) in onboard-openneuro.yml with no end-to-end state and no cleanup.
-- on004395 (9TB) hit GitHub's 6h runner cap mid copy-shard and left a silent
-- orphan: a private datasets row + an empty GitHub repo + 3.86TB of partial S3
-- objects, with nothing to detect or clean it. This table is the single source
-- of truth for each import so a terminal failure is surfaced (and quarantined
-- or, behind the IMPORT_AUTO_ROLLBACK flag, rolled back) instead of silent.
--
-- Lifecycle (status):
--   preparing -> copying -> finalizing -> complete           (happy path)
--   any in-flight stage  -> failed                           (report job / sweep)
--   failed -> quarantined  (ambiguous or auto-rollback off; admin alerted)
--   failed -> rolled_back  (unambiguous orphan + IMPORT_AUTO_ROLLBACK on)
--
-- Separate table (not columns on `datasets`): `datasets` is FTS5-backed
-- (additive-only), and crucially the state row must OUTLIVE the datasets row so
-- a `rolled_back` orphan stays auditable -- deleteDatasetCascade deletes the
-- datasets row but does NOT touch import_jobs. UNIQUE(dataset_id): an import is
-- at-most-one-live per dataset (parse-ids dedups), so one sticky row per
-- dataset_id is the source of truth and makes the re-import upsert trivial.
-- status is plain TEXT (no CHECK), mirroring manifest_jobs (0025).

CREATE TABLE IF NOT EXISTS import_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL,           -- on###### NEMAR id
  source TEXT NOT NULL,               -- 'openneuro'
  source_id TEXT NOT NULL,            -- ds######
  stage TEXT NOT NULL DEFAULT 'prepare',  -- prepare | copy | finalize (last observed)
  status TEXT NOT NULL DEFAULT 'preparing',
    -- preparing | copying | finalizing | complete | failed | quarantined | rolled_back
  last_error TEXT,
  resume_cursor TEXT,                 -- JSON; coarse {"stage":"copy"} (key-level resume is S3-driven)
  shards_total INTEGER,
  workflow_run_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE(dataset_id)
);

CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status);
CREATE INDEX IF NOT EXISTS idx_import_jobs_updated_at ON import_jobs(updated_at);
