-- Epic #967 phase 3 (#970): honest file_size/total_files + a data_complete
-- tri-state so the catalog can say "incomplete" instead of a fake number.
--
-- The incident this fixes: file_size/total_files were sourced from
-- getDatasetS3Stats, which sums the actual bytes under `<id>/objects/` --
-- when the annex blobs are 0-byte (the #967 bug), a real 12 GB dataset sums
-- to "36 B" and nobody notices. The version manifest (VersionManifest.files,
-- manifest.ts) carries the DECLARED size per file (annex-key-declared for
-- blobs, real git size for text); summing it is the honest logical size and
-- does not depend on what actually landed in S3.
--
-- Like HED (0056), this is per VERSION: a dataset's v1.0.0 may be complete
-- while v1.1.1 is not (a broken re-publish). So the source of truth lives on
-- dataset_versions, and the LATEST version's values are denormalized onto
-- datasets so the list filter stays a single-table query.
--
-- Population happens via verifyDatasetVersionS3 (import-integrity.ts) ->
-- computeDatasetMetadataColumns -> writeDatasetMetadataColumns /
-- writeVersionSize (dataset-metadata-columns.ts), called from the reindex
-- walk and the `admin data-integrity-sweep` backfill. Until a row is
-- checked, these stay NULL, which the projection exposes and the website
-- treats as "not classified yet" -- NOT "incomplete".
--
-- file_size / total_files: honest logical size/count (manifest-first, S3-sum
--   fallback for pre-manifest datasets -- see computeDatasetMetadataColumns).
--   Already exist on datasets from 0020; dataset_versions gains its own copy
--   here since 0020 never added them there.
-- bytes_present: actual bytes counted in the same S3 LIST used to verify
--   completeness -- distinct from file_size when data_complete=0.
-- data_complete: 0/1, NULL = not audited yet. 1 = every annex-keyed manifest
--   entry is present at its declared size; 0 = at least one is missing or
--   truncated (the #967 signature). CHECK enforces the documented domain;
--   NULL still passes (NULL IN (0,1) is NULL, not false).
-- data_checked_at: sweep resumability marker (mirrors hed_checked_at, 0056),
--   set once per dataset after the audit runs (success or not) so a re-run
--   skips already-checked rows; `admin data-integrity-sweep --older-than`
--   widens candidacy past it for periodic re-audit.

ALTER TABLE datasets ADD COLUMN bytes_present INTEGER;
ALTER TABLE datasets ADD COLUMN data_complete INTEGER CHECK (data_complete IN (0, 1));
ALTER TABLE datasets ADD COLUMN data_checked_at TEXT;

ALTER TABLE dataset_versions ADD COLUMN file_size INTEGER;
ALTER TABLE dataset_versions ADD COLUMN total_files INTEGER;
ALTER TABLE dataset_versions ADD COLUMN bytes_present INTEGER;
ALTER TABLE dataset_versions ADD COLUMN data_complete INTEGER CHECK (data_complete IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_datasets_data_complete ON datasets(data_complete);
