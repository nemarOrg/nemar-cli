-- Zarr serving-copy state on the `datasets` source of truth
-- (epic #684 / Stream C #685).
--
-- NEMAR adds a derived, LATEST-ONLY Zarr v3 serving copy of every recording
-- (built by biosigIO in nemarDatasets/.github run-generate-zarr.yml, stored at
-- s3://nemar/<id>/zarr/...). Because the store is latest-only -- it tracks the
-- current HEAD of main, not each published version -- its state lives as
-- columns on `datasets` (per-dataset), NOT in a per-version table like
-- dataset_versions. There is exactly one zarr copy per dataset at a time.
--
-- Columns:
--   zarr_status        lifecycle of the latest conversion:
--                      'pending'    -> dispatched, not yet confirmed
--                      'ready'      -> /webhooks/zarr-ready confirmed stores on S3
--                      'failed'     -> workflow reported a failure
--                      NULL         -> never converted (no zarr copy yet)
--   zarr_converted_at  ISO-8601 UTC of the last successful conversion callback.
--   zarr_store_count   number of `.zarr` stores in the latest index.json.
--   zarr_index_etag    ETag of the latest s3://nemar/<id>/zarr/index.json, so a
--                      reader/cache-purge can detect a change without refetching.
--   zarr_source_commit dataset-repo commit SHA the latest zarr copy was built
--                      from; the workflow diffs HEAD against this for incremental
--                      (convert-only-the-diff) runs.
--
-- All NULLable with no default: a dataset has no zarr state until its first
-- conversion lands, and the public catalog never branches on these (they are
-- not in datasets_fts or the embed-dirty trigger `OF` lists from 0031), so this
-- is a plain ADD COLUMN that touches neither the lexical index nor the
-- embedding vectors.

ALTER TABLE datasets ADD COLUMN zarr_status TEXT;
ALTER TABLE datasets ADD COLUMN zarr_converted_at TEXT;
ALTER TABLE datasets ADD COLUMN zarr_store_count INTEGER;
ALTER TABLE datasets ADD COLUMN zarr_index_etag TEXT;
ALTER TABLE datasets ADD COLUMN zarr_source_commit TEXT;

-- Partial index for the backfill/status sweep ("which public datasets still
-- lack a zarr copy?"): the common query is `WHERE zarr_status IS NULL` or
-- `WHERE zarr_status = 'failed'`, so index the column for those scans.
CREATE INDEX IF NOT EXISTS idx_datasets_zarr_status ON datasets(zarr_status);
