-- Migration 0046: per-dataset Zarr conversion-failure detail for the
-- observability dashboard (nemarOrg/nemar-cli#774).
--
-- Before #774 the Hallu cron retried deterministic conversion failures forever
-- (a dataset of unreadable MaxShield MEG .fif), and the only failure signal in
-- D1 was zarr_status='failed' (a bare flag, set by /webhooks/zarr-ready). The
-- robustness fix makes deterministic failures terminal and has the converter
-- report WHAT failed on every outcome (incl. a total failure, which used to send
-- no callback at all). These columns persist that detail so the existing
-- dashboard.nemar.org/observability panel can render a live "Zarr conversion
-- failures" table from nemar-db without a bespoke tracking GitHub issue.
--
-- Recorded by /webhooks/zarr-ready on every callback (a 'ready' run can still be
-- PARTIAL: some recordings convert, some fail; those are tracked here too while
-- zarr_status stays 'ready'):
--   zarr_errors          # recordings that failed in the latest conversion
--                        (0 = clean run; NULL = never converted).
--   zarr_failure_count   # of those that are TYPED data failures (a subset of
--                        zarr_errors; the rest are infra failures).
--   zarr_deterministic   1 when every failure is a typed data failure (won't be
--                        retried -- needs a converter/data fix); 0 otherwise.
--   zarr_data_failures   JSON array of the typed failures [{path, code, reason}]
--                        for the dashboard detail; NULL when there are none.
--   zarr_failed_at       ISO-8601 UTC of the latest conversion that had errors;
--                        NULL on a clean run (lets the dashboard sort by recency
--                        and the panel filter recent failures).
--
-- Plain ADD COLUMN like 0035/0036/0038/0043; none of these are in the
-- datasets_fts external-content table or the embed-dirty trigger OF lists, so
-- this touches neither the lexical index nor embeddings.
ALTER TABLE datasets ADD COLUMN zarr_errors INTEGER;
ALTER TABLE datasets ADD COLUMN zarr_failure_count INTEGER;
ALTER TABLE datasets ADD COLUMN zarr_deterministic INTEGER;
ALTER TABLE datasets ADD COLUMN zarr_data_failures TEXT;
ALTER TABLE datasets ADD COLUMN zarr_failed_at TEXT;
-- The dashboard's failures panel scans `WHERE zarr_failed_at IS NOT NULL`
-- (recently-failed, incl. partial 'ready' runs), so index it like the sibling
-- idx_datasets_zarr_status (0035) / idx_datasets_zarr_checked_at (0038).
CREATE INDEX IF NOT EXISTS idx_datasets_zarr_failed_at ON datasets(zarr_failed_at);
