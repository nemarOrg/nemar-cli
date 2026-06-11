-- records.json artifact state on the `datasets` source of truth
-- (epic #736, Phase 5 / #742).
--
-- generate-records.yml (nemarDatasets/.github) emits the neuroschema
-- per-recording records.json and uploads it to
-- s3://nemar/<id>/version/v<version>-records.json (served by the data plane's
-- loadRecords). Until Phase 5 the workflow was never dispatched on publish and
-- had no callback, so records.json 404'd for every dataset. /webhooks/records-ready
-- now records the latest-only records state here, mirroring the archive (0036)
-- and zarr (0035) columns for the observability dashboard. The records.json
-- artifact is served from S3 directly, so these columns are observability-only
-- (no serving dependency).
--
-- Columns:
--   records_status      'pending' -> dispatched, not yet confirmed
--                       'ready'   -> records.json present on S3 (webhook confirmed)
--                       'failed'  -> generation workflow reported a failure
--                       NULL      -> unknown (never generated / not yet checked)
--   records_checked_at  ISO-8601 UTC of the last records-ready callback.
--
-- Plain ADD COLUMN like 0036; not in datasets_fts or the embed-dirty trigger
-- OF lists, so this touches neither the lexical index nor the embedding vectors.
ALTER TABLE datasets ADD COLUMN records_status TEXT
  CHECK (records_status IN ('pending', 'ready', 'failed'));
ALTER TABLE datasets ADD COLUMN records_checked_at TEXT;

-- Partial index for the dashboard's "missing / failed records" scans.
CREATE INDEX IF NOT EXISTS idx_datasets_records_status ON datasets(records_status);
