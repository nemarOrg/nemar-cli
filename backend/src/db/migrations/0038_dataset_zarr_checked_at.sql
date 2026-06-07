-- Zarr backfill-sweep bookkeeping (epic #695, observability dashboard).
--
-- migration 0035 added zarr_status/zarr_store_count/etc., but only
-- /webhooks/zarr-ready ever writes them — and the webhook fires ONLY on a real
-- conversion (status -> 'ready'/'failed'), never on "checked-but-absent". The
-- Hallu backfill cron historically wrote stores to S3 without ever POSTing the
-- webhook, so ~213 already-converted public datasets sit at zarr_status NULL.
--
-- The admin zarr-sweep backfill reconciles that by GETting <id>/zarr/index.json
-- per dataset. It needs a "checked" stamp so a dataset that legitimately has NO
-- zarr copy (no convertible recordings) isn't re-GET'd on every sweep run and
-- the "run until remaining = 0" contract converges. This is the exact mirror of
-- archive_checked_at (migration 0036): an absent row stamps zarr_checked_at and
-- leaves zarr_status NULL, so it drops out of the candidate set without being
-- mislabeled 'failed'.
--
-- NULLable, no default — same as 0035/0036. Not in datasets_fts or the
-- embed-dirty trigger lists, so this is a plain ADD COLUMN.
ALTER TABLE datasets ADD COLUMN zarr_checked_at TEXT;

-- The sweep's candidate + remaining-count queries both filter on
-- `zarr_status IS NULL AND zarr_checked_at IS NULL`; index the new column so the
-- remaining-count scan (which runs outside the limit loop) doesn't full-scan.
-- Mirrors idx_datasets_zarr_status (0035) / idx_datasets_archive_status (0036).
CREATE INDEX IF NOT EXISTS idx_datasets_zarr_checked_at ON datasets(zarr_checked_at);
