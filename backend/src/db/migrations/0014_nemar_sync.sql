-- Migration: 0014_nemar_sync
-- Description: Track nemar.org datapipeline sync status per dataset

ALTER TABLE datasets ADD COLUMN nemar_sync_status TEXT DEFAULT NULL
  CHECK (nemar_sync_status IN ('synced', 'pending', 'failed'));
ALTER TABLE datasets ADD COLUMN nemar_sync_at TEXT;
ALTER TABLE datasets ADD COLUMN nemar_sync_error TEXT;
