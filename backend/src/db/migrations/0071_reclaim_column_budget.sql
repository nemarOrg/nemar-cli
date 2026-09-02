-- Reclaim the datasets column budget (#1182): rebuild `datasets` as an
-- 87-column table so the running total (92 after 0072_signal_defaults, which
-- is applied AFTER this file) stays under D1's 100-column cap. The cap was
-- hit when 0071_signal_defaults (now renumbered 0072) could not apply, which
-- blocked every deploy.
--
-- A rebuild, not ALTER: SQLite refuses DROP COLUMN on a CHECK-bound column,
-- and four of the six attestation columns carry CHECKs, so the 6 -> 1
-- collapse cannot be done incrementally.
--
-- What changes (see ADR 0034 for each derivation):
--   DROPPED (6): zenodo_latest_version_id, uploader, ezid_identifier,
--     doi_provider, num_citations, file_size_formatted. All are derivable or
--     constant; reads were rebound in the same PR.
--   COLLAPSED (6 -> 1): attestation_deposit_type / _key_status /
--     _deidentified / _no_duplicate / _upstream_source / _accepted_at become
--     one `attestation` JSON column with keys deposit_type, key_status,
--     deidentified, no_duplicate, upstream_source, accepted_at (0/1 integers
--     for the two booleans). NULL column = "no attestation on record",
--     preserving ADR 0024's tri-state reading.
--   KEPT deliberately: zenodo_concept_id (doomsday backup + its index),
--     metadata_columns_error (failure-only write channel in
--     services/enrich-dataset.ts and services/dataset-reindex.ts -- 0 rows
--     means no recent failures, NOT dead), and all sweep bookkeeping stamps
--     (a follow-up PR owns those).
--
-- ORDERING IS LOAD-BEARING. Correctness must not depend on whole-file
-- atomicity. In particular: DROP TABLE performs an implicit DELETE first,
-- which fires ON DELETE CASCADE on FK children even under
-- `PRAGMA defer_foreign_keys` (deferral postpones violation REPORTING, not
-- the ACTION). `datasets` has THREE FK children -- access_requests
-- (CASCADE) and dataset_collaborators (CASCADE), both keyed on
-- datasets(id), plus dataset_versions (NO ACTION), which is keyed on
-- datasets(dataset_id), the TEXT natural key, NOT on id. Two of the three
-- are also spelled `REFERENCES "datasets"` with quotes, so a grep for
-- `REFERENCES datasets(id)` finds only one of them -- exactly the trap
-- migration 0026 already documented. So the children are rescued into plain
-- tables and EMPTIED before the drop; the implicit DELETE then has nothing
-- to cascade onto and nothing to violate. They are restored after the
-- rename, which is safe for either FK target because both id and dataset_id
-- are copied verbatim and unchanged.
--
-- The `_rebuild_guard` table aborts the migration BEFORE anything
-- destructive if a copy went wrong: inserting a false comparison (0) or a
-- NULL violates CHECK (ok = 1) / NOT NULL and fails that statement.
--
-- `datasets.id` values are SPARSE (production MIN 48, MAX 61277) and are the
-- FTS5 external-content rowid: they are copied explicitly and must never be
-- reassigned by AUTOINCREMENT. Copying the max id into the AUTOINCREMENT
-- table re-seeds sqlite_sequence at MAX(id), which equals the pre-rebuild
-- seq (verified in production), and ALTER TABLE RENAME carries the
-- sqlite_sequence entry to the new name.
--
-- NO `IF NOT EXISTS` anywhere on purpose: a blind re-run after a partial
-- failure must fail loudly, not silently skip steps.

PRAGMA defer_foreign_keys = on;

CREATE TABLE _rebuild_guard (ok INTEGER NOT NULL CHECK (ok = 1));

CREATE TABLE datasets_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  owner_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'deleted')),
  github_repo TEXT,
  concept_doi TEXT,
  latest_version_doi TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  zenodo_concept_id TEXT,
  is_sandbox INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'public')),
  ezid_status TEXT,
  enrichment_json TEXT,
  enrichment_updated_at TEXT,
  last_activity_at TEXT,
  source TEXT,
  source_id TEXT,
  subject_count INTEGER,
  modalities TEXT,
  age_min REAL,
  age_max REAL,
  file_size INTEGER,
  total_files INTEGER,
  tasks TEXT,
  metadata_updated_at TEXT,
  metadata_columns_error TEXT,
  staleness_warn_stage INTEGER,
  staleness_admin_notified_at TEXT,
  authors TEXT,
  license TEXT,
  readme TEXT,
  bids_version TEXT,
  sessions_count INTEGER,
  publish_date TEXT,
  embedding_dirty INTEGER NOT NULL DEFAULT 0,
  license_tier TEXT NOT NULL DEFAULT 'unknown',
  zarr_status TEXT
    CHECK (zarr_status IN ('pending', 'ready', 'failed')),
  zarr_converted_at TEXT,
  zarr_store_count INTEGER,
  zarr_index_etag TEXT,
  zarr_source_commit TEXT,
  archive_status TEXT
    CHECK (archive_status IN ('pending', 'ready', 'failed')),
  archive_size INTEGER,
  archive_checked_at TEXT,
  zarr_checked_at TEXT,
  archive_retry_count INTEGER NOT NULL DEFAULT 0,
  records_status TEXT
    CHECK (records_status IN ('pending', 'ready', 'failed')),
  records_checked_at TEXT,
  archive_skip_reason TEXT,
  zarr_errors INTEGER,
  zarr_failure_count INTEGER,
  zarr_deterministic INTEGER,
  zarr_data_failures TEXT,
  zarr_failed_at TEXT,
  num_dataset_citations INTEGER NOT NULL DEFAULT 0,
  num_datapaper_citations INTEGER NOT NULL DEFAULT 0,
  citations_updated_at TEXT,
  n_channels INTEGER,
  electrode_system TEXT,
  channel_montage_checked_at TEXT,
  has_hed INTEGER CHECK (has_hed IN (0, 1)),
  hed_version TEXT,
  hed_checked_at TEXT,
  is_exemplar INTEGER NOT NULL DEFAULT 0 CHECK (is_exemplar IN (0, 1)),
  bytes_present INTEGER,
  data_complete INTEGER CHECK (data_complete IN (0, 1)),
  data_checked_at TEXT,
  withdrawn_at TEXT,
  withdrawn_reason TEXT,
  availability_report_at TEXT,
  archive_complete INTEGER CHECK (archive_complete IN (0, 1)),
  archive_absent_files INTEGER,
  archive_declared_files INTEGER,
  attestation TEXT CHECK (attestation IS NULL OR json_valid(attestation)),
  zarr_pool_breaks INTEGER,
  total_recording_duration REAL,
  recording_duration_min REAL,
  recording_duration_max REAL,
  recording_count INTEGER,
  recordings_unavailable INTEGER,
  recordings_measured INTEGER,
  channel_count_min INTEGER,
  channel_count_max INTEGER,
  recording_stats_at TEXT,
  FOREIGN KEY (owner_user_id) REFERENCES "users"(id)
);

INSERT INTO datasets_new (
  id, dataset_id, name, description, owner_user_id, status, github_repo,
  concept_doi, latest_version_doi, created_at, updated_at, zenodo_concept_id,
  is_sandbox, visibility, ezid_status, enrichment_json, enrichment_updated_at,
  last_activity_at, source, source_id, subject_count, modalities, age_min,
  age_max, file_size, total_files, tasks, metadata_updated_at,
  metadata_columns_error, staleness_warn_stage, staleness_admin_notified_at,
  authors, license, readme, bids_version, sessions_count, publish_date,
  embedding_dirty, license_tier, zarr_status, zarr_converted_at,
  zarr_store_count, zarr_index_etag, zarr_source_commit, archive_status,
  archive_size, archive_checked_at, zarr_checked_at, archive_retry_count,
  records_status, records_checked_at, archive_skip_reason, zarr_errors,
  zarr_failure_count, zarr_deterministic, zarr_data_failures, zarr_failed_at,
  num_dataset_citations, num_datapaper_citations, citations_updated_at,
  n_channels, electrode_system, channel_montage_checked_at, has_hed,
  hed_version, hed_checked_at, is_exemplar, bytes_present, data_complete,
  data_checked_at, withdrawn_at, withdrawn_reason, availability_report_at,
  archive_complete, archive_absent_files, archive_declared_files,
  attestation, zarr_pool_breaks, total_recording_duration,
  recording_duration_min, recording_duration_max, recording_count,
  recordings_unavailable, recordings_measured, channel_count_min,
  channel_count_max, recording_stats_at
)
SELECT
  id, dataset_id, name, description, owner_user_id, status, github_repo,
  concept_doi, latest_version_doi, created_at, updated_at, zenodo_concept_id,
  is_sandbox, visibility, ezid_status, enrichment_json, enrichment_updated_at,
  last_activity_at, source, source_id, subject_count, modalities, age_min,
  age_max, file_size, total_files, tasks, metadata_updated_at,
  metadata_columns_error, staleness_warn_stage, staleness_admin_notified_at,
  authors, license, readme, bids_version, sessions_count, publish_date,
  embedding_dirty, license_tier, zarr_status, zarr_converted_at,
  zarr_store_count, zarr_index_etag, zarr_source_commit, archive_status,
  archive_size, archive_checked_at, zarr_checked_at, archive_retry_count,
  records_status, records_checked_at, archive_skip_reason, zarr_errors,
  zarr_failure_count, zarr_deterministic, zarr_data_failures, zarr_failed_at,
  num_dataset_citations, num_datapaper_citations, citations_updated_at,
  n_channels, electrode_system, channel_montage_checked_at, has_hed,
  hed_version, hed_checked_at, is_exemplar, bytes_present, data_complete,
  data_checked_at, withdrawn_at, withdrawn_reason, availability_report_at,
  archive_complete, archive_absent_files, archive_declared_files,
  CASE
    WHEN attestation_deposit_type IS NULL
     AND attestation_key_status IS NULL
     AND attestation_deidentified IS NULL
     AND attestation_no_duplicate IS NULL
     AND attestation_upstream_source IS NULL
     AND attestation_accepted_at IS NULL
    THEN NULL
    ELSE json_object(
      'deposit_type', attestation_deposit_type,
      'key_status', attestation_key_status,
      'deidentified', attestation_deidentified,
      'no_duplicate', attestation_no_duplicate,
      'upstream_source', attestation_upstream_source,
      'accepted_at', attestation_accepted_at
    )
  END,
  zarr_pool_breaks, total_recording_duration,
  recording_duration_min, recording_duration_max, recording_count,
  recordings_unavailable, recordings_measured, channel_count_min,
  channel_count_max, recording_stats_at
FROM datasets;

-- Guards: a false comparison inserts 0 (violates CHECK ok = 1) and a NULL
-- violates NOT NULL; either aborts here, BEFORE anything destructive.
INSERT INTO _rebuild_guard
SELECT (SELECT COUNT(*) FROM datasets_new) = (SELECT COUNT(*) FROM datasets);
INSERT INTO _rebuild_guard
SELECT (SELECT COALESCE(SUM(id), 0) || '/' || COALESCE(MIN(id), 0) || '/' || COALESCE(MAX(id), 0) FROM datasets_new)
     = (SELECT COALESCE(SUM(id), 0) || '/' || COALESCE(MIN(id), 0) || '/' || COALESCE(MAX(id), 0) FROM datasets);

-- Rescue the three FK children into plain (constraint-free) tables, verify
-- the copies, then empty the originals so DROP TABLE's implicit DELETE has
-- nothing to cascade onto and nothing to violate.
CREATE TABLE _rescue_access_requests AS SELECT * FROM access_requests;
CREATE TABLE _rescue_dataset_collaborators AS SELECT * FROM dataset_collaborators;
CREATE TABLE _rescue_dataset_versions AS SELECT * FROM dataset_versions;
INSERT INTO _rebuild_guard
SELECT (SELECT COUNT(*) FROM _rescue_access_requests) = (SELECT COUNT(*) FROM access_requests);
INSERT INTO _rebuild_guard
SELECT (SELECT COUNT(*) FROM _rescue_dataset_collaborators) = (SELECT COUNT(*) FROM dataset_collaborators);
INSERT INTO _rebuild_guard
SELECT (SELECT COUNT(*) FROM _rescue_dataset_versions) = (SELECT COUNT(*) FROM dataset_versions);

DELETE FROM access_requests;
DELETE FROM dataset_collaborators;
DELETE FROM dataset_versions;

-- Drops the four datasets triggers with the table. The FTS index itself is
-- untouched: DROP TABLE's implicit DELETE fires no triggers, and the
-- external-content index holds no copied rows -- the integrity check at the
-- bottom proves it still matches the rebuilt table.
DROP TABLE datasets;

-- Nothing references datasets_new (children were emptied above and their
-- FK clauses name "datasets"), so no FK rewriting hazard here.
ALTER TABLE datasets_new RENAME TO datasets;

INSERT INTO dataset_versions SELECT * FROM _rescue_dataset_versions;
INSERT INTO access_requests SELECT * FROM _rescue_access_requests;
INSERT INTO dataset_collaborators SELECT * FROM _rescue_dataset_collaborators;
INSERT INTO _rebuild_guard
SELECT (SELECT COUNT(*) FROM dataset_versions) = (SELECT COUNT(*) FROM _rescue_dataset_versions);
INSERT INTO _rebuild_guard
SELECT (SELECT COUNT(*) FROM access_requests) = (SELECT COUNT(*) FROM _rescue_access_requests);
INSERT INTO _rebuild_guard
SELECT (SELECT COUNT(*) FROM dataset_collaborators) = (SELECT COUNT(*) FROM _rescue_dataset_collaborators);

DROP TABLE _rescue_dataset_versions;
DROP TABLE _rescue_access_requests;
DROP TABLE _rescue_dataset_collaborators;

-- Recreate 23 of the 25 pre-rebuild indexes, DDL verbatim from production
-- sqlite_master. Dropped with their columns: idx_datasets_ezid
-- (ezid_identifier), idx_datasets_num_citations (num_citations).
CREATE INDEX idx_datasets_id ON datasets(dataset_id);
CREATE INDEX idx_datasets_modalities ON datasets(modalities);
CREATE INDEX idx_datasets_owner ON datasets(owner_user_id);
CREATE INDEX idx_datasets_sandbox ON datasets(is_sandbox);
CREATE INDEX idx_datasets_status ON datasets(status);
CREATE INDEX idx_datasets_subject_count ON datasets(subject_count);
CREATE INDEX idx_datasets_visibility ON datasets(visibility);
CREATE INDEX idx_datasets_zenodo_concept ON datasets(zenodo_concept_id);
CREATE INDEX idx_datasets_publish_date ON datasets(publish_date);
CREATE INDEX idx_datasets_embedding_dirty ON datasets(embedding_dirty);
CREATE INDEX idx_datasets_license_tier ON datasets(license_tier);
CREATE INDEX idx_datasets_zarr_status ON datasets(zarr_status);
CREATE INDEX idx_datasets_archive_status ON datasets(archive_status);
CREATE INDEX idx_datasets_zarr_checked_at ON datasets(zarr_checked_at);
CREATE INDEX idx_datasets_records_status ON datasets(records_status);
CREATE INDEX idx_datasets_zarr_failed_at ON datasets(zarr_failed_at);
CREATE INDEX idx_datasets_source_id ON datasets(source_id);
CREATE INDEX idx_datasets_n_channels ON datasets(n_channels);
CREATE INDEX idx_datasets_electrode_system ON datasets(electrode_system);
CREATE INDEX idx_datasets_has_hed ON datasets(has_hed);
CREATE INDEX idx_datasets_is_exemplar ON datasets(is_exemplar);
CREATE INDEX idx_datasets_data_complete ON datasets(data_complete);
CREATE INDEX idx_datasets_archive_complete ON datasets(archive_complete);

-- Recreate the four triggers, DDL verbatim from production sqlite_master
-- (matching 0031_datasets_fts.sql; they reference only surviving columns).
-- UPPERCASE BEGIN...END dodges workers-sdk#10998 on remote apply -- see the
-- gate note in 0031.
CREATE TRIGGER datasets_fts_ai AFTER INSERT ON datasets BEGIN
  INSERT INTO datasets_fts(rowid, name, description, authors, tasks, modalities, readme)
  VALUES (new.id, new.name, new.description, new.authors, new.tasks, new.modalities, new.readme);
END;

CREATE TRIGGER datasets_fts_ad AFTER DELETE ON datasets BEGIN
  INSERT INTO datasets_fts(datasets_fts, rowid, name, description, authors, tasks, modalities, readme)
  VALUES ('delete', old.id, old.name, old.description, old.authors, old.tasks, old.modalities, old.readme);
END;

CREATE TRIGGER datasets_fts_au AFTER UPDATE OF name, description, authors, tasks, modalities, readme ON datasets BEGIN
  INSERT INTO datasets_fts(datasets_fts, rowid, name, description, authors, tasks, modalities, readme)
  VALUES ('delete', old.id, old.name, old.description, old.authors, old.tasks, old.modalities, old.readme);
  INSERT INTO datasets_fts(rowid, name, description, authors, tasks, modalities, readme)
  VALUES (new.id, new.name, new.description, new.authors, new.tasks, new.modalities, new.readme);
END;

CREATE TRIGGER datasets_embed_dirty_au
AFTER UPDATE OF name, description, modalities, tasks, authors, readme ON datasets BEGIN
  UPDATE datasets SET embedding_dirty = 1 WHERE id = new.id;
END;

-- External-content FTS integrity check (rank=1 verifies against the content
-- table): fails the migration if the index desynced from the rebuilt rows.
INSERT INTO datasets_fts(datasets_fts, rank) VALUES('integrity-check', 1);

DROP TABLE _rebuild_guard;
