-- Dataset-store consolidation, Phase 6 contract (#646, #652).
--
-- Drop the legacy nemar_catalog read cache. Every dataset fact now lives in
-- `datasets` (the single source of truth): managed rows carry their own
-- columns, and the legacy catalog rows were folded in under the sentinel owner
-- (owner_user_id = -1) by migration 0030. Reads (list, search, page-bundle)
-- and writes (enrich, reindex, legacy ingest fold) all target `datasets` now;
-- the flag-off code that referenced this table is deleted in the same PR.
--
-- This is the single irreversible step of the consolidation. The data is not
-- lost (it is in `datasets`); re-running migrations 0029/0030 rebuilds the
-- table from the source of truth if ever needed.
--
-- catalog_sync_log is retained as the legacy-ingest logging artifact.
--
-- Backup runbook: D1 export fails when a virtual table (datasets_fts) is
-- present -- DROP TABLE datasets_fts, export, then recreate from 0031.

DROP TABLE IF EXISTS nemar_catalog;
