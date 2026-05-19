-- Migration 0025: manifest_jobs table for centralized manifest generation (#557).
--
-- Tracks in-flight repository_dispatch jobs sent to the central
-- `nemarOrg/nemar-cli` workflow. Each row binds a (dataset_id, version)
-- to the nonce + HMAC callback token used to authenticate the eventual
-- /webhooks/manifest-ready or /webhooks/manifest-failed POST.
--
-- Lifecycle:
--   dispatched -> ready   (manifest+summary on S3, dataset_versions row inserted)
--   dispatched -> failed  (workflow errored before uploading artifacts)
--
-- The UNIQUE on (dataset_id, version, nonce) prevents a successful
-- callback from replaying against a freshly-dispatched job for the same
-- (dataset_id, version) -- the second dispatch generates a new nonce
-- and the old token is no longer valid.

CREATE TABLE IF NOT EXISTS manifest_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL,
  version TEXT NOT NULL,
  nonce TEXT NOT NULL,
  doi TEXT,
  concept_doi TEXT,
  doi_provider TEXT,
  status TEXT NOT NULL DEFAULT 'dispatched',  -- dispatched | ready | failed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  workflow_run_url TEXT,
  error_message TEXT,
  UNIQUE(dataset_id, version, nonce)
);

CREATE INDEX IF NOT EXISTS idx_manifest_jobs_status ON manifest_jobs(status);
CREATE INDEX IF NOT EXISTS idx_manifest_jobs_dataset_version
  ON manifest_jobs(dataset_id, version);
