-- Drop the legacy nemar.org datapipeline sync state (epic #837 Phase 5).
--
-- The outgoing datapipeline push (nemar-sync.ts) and the incoming catalog pull
-- (catalog-sync.ts + /admin/catalog/sync) were removed in Phase 3, so the
-- nemar_sync_* columns (migration 0014) and the catalog_sync_log table
-- (migration 0018) are now dead and have no remaining readers/writers.
--
-- DROP COLUMN is safe here: no index, trigger, FK, or the datasets_fts external
-- -content virtual table references these columns (datasets_fts indexes only
-- name/description/authors/tasks/modalities/readme). Validated on the SCCN dev
-- D1 mirror before prod.

ALTER TABLE datasets DROP COLUMN nemar_sync_status;
ALTER TABLE datasets DROP COLUMN nemar_sync_at;
ALTER TABLE datasets DROP COLUMN nemar_sync_error;

DROP TABLE IF EXISTS catalog_sync_log;
