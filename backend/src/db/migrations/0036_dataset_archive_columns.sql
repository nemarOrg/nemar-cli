-- Downloadable-archive state on the `datasets` source of truth
-- (epic #695, dashboard.nemar.org/observability).
--
-- NEMAR generates a downloadable zip snapshot per published version at
-- s3://nemar/<id>/archives/v<version>.zip (built by nemarDatasets/.github
-- run-generate-archive.yml after a version DOI is minted). Until now the only
-- signal of "does this dataset have an archive?" was an on-demand S3 HEAD
-- (data.ts headArchive), so the observability dashboard had no cheap way to
-- count "% with archive" / "which are missing or failed". These columns mirror
-- the latest-only zarr state added in migration 0035: one archive state per
-- dataset (the latest version's zip), recorded by /webhooks/archive-ready and
-- seeded by the admin archive-sweep backfill.
--
-- Columns:
--   archive_status      lifecycle of the latest archive:
--                       'pending' -> generation dispatched, not yet confirmed
--                       'ready'   -> zip present on S3 (webhook or sweep confirmed)
--                       'failed'  -> generation workflow reported a failure
--                       NULL      -> unknown (never generated / not yet checked)
--   archive_size        bytes of the latest archive zip (NULL until known).
--   archive_checked_at  ISO-8601 UTC of the last confirmation (webhook callback
--                       or backfill sweep). Also lets the sweep skip already-
--                       checked rows (`WHERE archive_checked_at IS NULL`).
--
-- All NULLable with no default, like 0035: a dataset has no archive state until
-- its first archive lands or the sweep checks it. Not in datasets_fts or the
-- embed-dirty trigger `OF` lists, so this is a plain ADD COLUMN that touches
-- neither the lexical index nor the embedding vectors.

-- CHECK pins the enum the same way 0035 does for zarr_status (NULL passes CHECK,
-- so "unknown" stays representable) and keeps the idx scan below meaningful.
ALTER TABLE datasets ADD COLUMN archive_status TEXT
  CHECK (archive_status IN ('pending', 'ready', 'failed'));
ALTER TABLE datasets ADD COLUMN archive_size INTEGER;
ALTER TABLE datasets ADD COLUMN archive_checked_at TEXT;

-- Partial index for the dashboard's "missing / failed archive" scans and for
-- the backfill sweep's candidate selection.
CREATE INDEX IF NOT EXISTS idx_datasets_archive_status ON datasets(archive_status);
