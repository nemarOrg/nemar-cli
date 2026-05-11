-- Epic #417 phase 2: first-class metadata columns on the datasets table.
-- These let D1 answer queries like "all EEG datasets with >=20 subjects"
-- without parsing the enrichment_json blob, and keep D1 aligned with the
-- nemar.org datapipeline tables that already carry these fields.
--
-- Population happens in two places (see backend/src/routes/webhooks.ts):
--   1. /webhooks/llm-enrich  - on README/dataset_description.json/release pushes
--   2. syncToNemarAfterVersionDoi  - on version-DOI tag push
-- Both call writeDatasetMetadataColumns() in dataset-metadata-columns.ts.
--
-- REAL is used for ages because BIDS allows fractional values (e.g., infants
-- measured in months). The downstream nemar_catalog table keeps INTEGER for
-- compatibility with the nemar.org API; we don't propagate that lossy choice.

ALTER TABLE datasets ADD COLUMN subject_count INTEGER;
ALTER TABLE datasets ADD COLUMN modalities TEXT;
ALTER TABLE datasets ADD COLUMN age_min REAL;
ALTER TABLE datasets ADD COLUMN age_max REAL;
ALTER TABLE datasets ADD COLUMN file_size INTEGER;
ALTER TABLE datasets ADD COLUMN total_files INTEGER;
ALTER TABLE datasets ADD COLUMN tasks TEXT;
ALTER TABLE datasets ADD COLUMN metadata_updated_at TEXT;
-- Free-form last-error string for the metadata-columns write. Surfaces the
-- failure from the post-version-DOI sync path, which runs server-side and
-- has no response body to return errors through. Cleared on success.
ALTER TABLE datasets ADD COLUMN metadata_columns_error TEXT;

CREATE INDEX IF NOT EXISTS idx_datasets_modalities ON datasets(modalities);
CREATE INDEX IF NOT EXISTS idx_datasets_subject_count ON datasets(subject_count);

-- Best-effort static backfill for `modalities`. The LLM enrichment pipeline
-- stores modalities as a JSON array in enrichment_json (seeded.modalities is
-- the return value of detectModalitiesFromTree -- see llm-enrich.ts:357), so
-- the array path covers the typical case. The text path is a legacy fallback
-- for any rows where modalities was historically stored as a plain string.
-- Other columns (subject_count, ages, sizes, tasks) cannot be reconstructed
-- from D1 alone and stay NULL until the next enrichment trigger or
-- version-DOI publish writes them.

UPDATE datasets
SET modalities = (
      SELECT GROUP_CONCAT(je.value, ',')
      FROM json_each(enrichment_json, '$.modalities') AS je
    ),
    metadata_updated_at = datetime('now')
WHERE enrichment_json IS NOT NULL
  AND json_type(enrichment_json, '$.modalities') = 'array';

UPDATE datasets
SET modalities = json_extract(enrichment_json, '$.modalities'),
    metadata_updated_at = datetime('now')
WHERE enrichment_json IS NOT NULL
  AND json_type(enrichment_json, '$.modalities') = 'text'
  AND modalities IS NULL;
