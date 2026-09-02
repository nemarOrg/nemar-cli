-- Collapse the 12 sweep bookkeeping stamps into one JSON column (#1183).
-- Follow-up to the 0071 rebuild (#1182, ADR 0034), which deferred this
-- group. Takes `datasets` from 92 columns to 81 (+1 sweep_stamps, -12
-- stamp columns), buying real headroom under D1's 100-column cap.
--
-- Plain ALTERs, not a rebuild: none of the 12 carries a CHECK constraint,
-- none appears in any trigger, and only zarr_checked_at is indexed
-- (idx_datasets_zarr_checked_at, dropped below), so SQLite's DROP COLUMN
-- restrictions that forced 0071's rebuild do not apply here.
--
-- Keys are the OLD COLUMN NAMES verbatim ('$.archive_checked_at', never a
-- shortened form), so the codebase stays greppable by stamp name.
--
-- The backfill writes ALL 12 keys on every row, JSON null where the stamp
-- was NULL (json_object maps SQL NULL to JSON null). That is deliberate:
-- json_extract returns SQL NULL for a missing key, an explicit JSON null,
-- AND a NULL column, so "never swept" keeps one candidate predicate
-- (json_extract(...) IS NULL) across all three shapes, and writing every
-- key uniformly is simpler to verify than per-row key omission. Rows
-- inserted AFTER this migration start at sweep_stamps NULL, which is why
-- every stamp write must wrap the column in COALESCE(sweep_stamps, '{}'):
-- json_set(NULL, ...) returns NULL and would silently discard the write.
--
-- All 12 stamps hold datetime('now') output, uniformly 19 characters
-- 'YYYY-MM-DD HH:MM:SS' (verified across all 789 production rows), so the
-- sweeps' `<` comparisons remain chronological as string comparisons on
-- the extracted values.

ALTER TABLE datasets ADD COLUMN sweep_stamps TEXT
  CHECK (sweep_stamps IS NULL OR json_valid(sweep_stamps));

UPDATE datasets SET sweep_stamps = json_object(
  'enrichment_updated_at', enrichment_updated_at,
  'metadata_updated_at', metadata_updated_at,
  'archive_checked_at', archive_checked_at,
  'zarr_checked_at', zarr_checked_at,
  'records_checked_at', records_checked_at,
  'citations_updated_at', citations_updated_at,
  'channel_montage_checked_at', channel_montage_checked_at,
  'hed_checked_at', hed_checked_at,
  'data_checked_at', data_checked_at,
  'availability_report_at', availability_report_at,
  'recording_stats_at', recording_stats_at,
  'signal_defaults_at', signal_defaults_at
);

DROP INDEX idx_datasets_zarr_checked_at;

ALTER TABLE datasets DROP COLUMN enrichment_updated_at;
ALTER TABLE datasets DROP COLUMN metadata_updated_at;
ALTER TABLE datasets DROP COLUMN archive_checked_at;
ALTER TABLE datasets DROP COLUMN zarr_checked_at;
ALTER TABLE datasets DROP COLUMN records_checked_at;
ALTER TABLE datasets DROP COLUMN citations_updated_at;
ALTER TABLE datasets DROP COLUMN channel_montage_checked_at;
ALTER TABLE datasets DROP COLUMN hed_checked_at;
ALTER TABLE datasets DROP COLUMN data_checked_at;
ALTER TABLE datasets DROP COLUMN availability_report_at;
ALTER TABLE datasets DROP COLUMN recording_stats_at;
ALTER TABLE datasets DROP COLUMN signal_defaults_at;
