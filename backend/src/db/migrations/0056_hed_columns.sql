-- Epic #869 phase 1 (#870): first-class HED (Hierarchical Event Descriptors)
-- columns so D1 can answer "datasets with HED annotations" and back the
-- website's "Has HED annotation" filter (FilterSidebar has_hed) -- which is a
-- dead control today because no has_hed field exists anywhere in D1 or the API.
--
-- HED is per VERSION: a dataset's v1.0.0 may carry no HED while v1.1.1 does
-- (e.g. nm000132). So the source of truth lives on dataset_versions, and the
-- LATEST version's values are denormalized onto datasets so the list filter
-- stays a single-table query (mirrors modalities / license_tier / n_channels).
--
-- Population happens in phase 2 (#871) via probeHed() in getBidsTreeStats ->
-- computeDatasetMetadataColumns -> writeDatasetMetadataColumns
-- (dataset-metadata-columns.ts, both the enrich + version-DOI callers), and the
-- phase 3 (#872) backfill sweep. Until then these stay NULL, which the
-- projection exposes and the website treats as "not classified yet".
--
-- Detection rule (phase 2): has_hed = 1 only when dataset_description.json has a
-- HEDVersion key AND >=1 real HED annotation exists (an *_events.json column
-- with a "HED" key, OR an *_events.tsv with a "HED" column). hed_version is the
-- HEDVersion string (e.g. "8.3.0").
--
-- has_hed: 0/1, NULL = not classified yet. On datasets it reflects the latest
--   version; on dataset_versions it is that specific version's status.
-- hed_version: the HEDVersion string, or NULL.
-- hed_checked_at: phase 3 sweep resumability marker, set once per dataset after
--   the HED probe runs (success or not) so a re-run skips already-checked rows.
--   Mirrors channel_montage_checked_at (0055) / archive_checked_at (0036): the
--   sweep writes has_hed/hed_version WITHOUT bumping updated_at/metadata_updated_at,
--   so a one-time backfill doesn't make every dataset read "updated today".

ALTER TABLE datasets ADD COLUMN has_hed INTEGER;
ALTER TABLE datasets ADD COLUMN hed_version TEXT;
ALTER TABLE datasets ADD COLUMN hed_checked_at TEXT;

ALTER TABLE dataset_versions ADD COLUMN has_hed INTEGER;
ALTER TABLE dataset_versions ADD COLUMN hed_version TEXT;

CREATE INDEX IF NOT EXISTS idx_datasets_has_hed ON datasets(has_hed);
