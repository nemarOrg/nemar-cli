-- One-shot backfill: project enrichment-derived data from the `datasets`
-- source-of-truth row into the `nemar_catalog` read cache.
--
-- nemar_catalog is the table the list endpoint projects from. Migration 0020
-- added first-class columns to `datasets` (subject_count, modalities, ...)
-- and the enrichment pipeline writes to them, but no path mirrored those
-- values back into nemar_catalog. Result: a dataset like nm000166 had a full
-- `datasets.enrichment_json` plus typed columns, while its `nemar_catalog`
-- row stayed empty -- the discover card showed `BY <uploader>` and zero
-- modalities/tasks/participants/size.
--
-- Going forward, syncNemarCatalogFromEnrichment() (in
-- backend/src/services/dataset-metadata-columns.ts) is called after every
-- writeDatasetMetadataColumns to keep the cache coherent. This migration
-- closes the historical gap for rows enriched before that landed.
--
-- COALESCE preserves any existing nemar_catalog value, so we only fill empty
-- columns. A catalog row that catalog-sync.ts already populated isn't
-- clobbered.

-- modalities: copy from datasets.modalities (populated by writeDatasetMetadataColumns)
UPDATE nemar_catalog
SET modalities = COALESCE(NULLIF(modalities, ''), (
      SELECT d.modalities FROM datasets d WHERE d.dataset_id = nemar_catalog.id
    )),
    synced_at = datetime('now')
WHERE (modalities IS NULL OR modalities = '')
  AND EXISTS (
    SELECT 1 FROM datasets d
    WHERE d.dataset_id = nemar_catalog.id AND d.modalities IS NOT NULL AND d.modalities <> ''
  );

-- tasks: same pattern
UPDATE nemar_catalog
SET tasks = COALESCE(NULLIF(tasks, ''), (
      SELECT d.tasks FROM datasets d WHERE d.dataset_id = nemar_catalog.id
    )),
    synced_at = datetime('now')
WHERE (tasks IS NULL OR tasks = '')
  AND EXISTS (
    SELECT 1 FROM datasets d
    WHERE d.dataset_id = nemar_catalog.id AND d.tasks IS NOT NULL AND d.tasks <> ''
  );

-- participants: copy from datasets.subject_count (different name in nemar_catalog)
UPDATE nemar_catalog
SET participants = (
      SELECT d.subject_count FROM datasets d WHERE d.dataset_id = nemar_catalog.id
    ),
    synced_at = datetime('now')
WHERE (participants IS NULL OR participants = 0)
  AND EXISTS (
    SELECT 1 FROM datasets d
    WHERE d.dataset_id = nemar_catalog.id AND d.subject_count IS NOT NULL AND d.subject_count > 0
  );

-- age_min / age_max: each is COALESCE-preserved independently, so a row
-- with one bound already set (e.g. age_min=5, age_max NULL) still gets the
-- other bound filled in from the datasets row.
UPDATE nemar_catalog
SET age_min = COALESCE(NULLIF(age_min, 0), (
      SELECT d.age_min FROM datasets d WHERE d.dataset_id = nemar_catalog.id
    )),
    age_max = COALESCE(NULLIF(age_max, 0), (
      SELECT d.age_max FROM datasets d WHERE d.dataset_id = nemar_catalog.id
    )),
    synced_at = datetime('now')
WHERE ((age_min IS NULL OR age_min = 0) OR (age_max IS NULL OR age_max = 0))
  AND EXISTS (
    SELECT 1 FROM datasets d
    WHERE d.dataset_id = nemar_catalog.id
      AND (d.age_min IS NOT NULL OR d.age_max IS NOT NULL)
  );

-- file_size / total_files
UPDATE nemar_catalog
SET file_size = COALESCE(NULLIF(file_size, 0), (
      SELECT d.file_size FROM datasets d WHERE d.dataset_id = nemar_catalog.id
    )),
    total_files = COALESCE(NULLIF(total_files, 0), (
      SELECT d.total_files FROM datasets d WHERE d.dataset_id = nemar_catalog.id
    )),
    synced_at = datetime('now')
WHERE (file_size IS NULL OR file_size = 0)
  AND EXISTS (
    SELECT 1 FROM datasets d
    WHERE d.dataset_id = nemar_catalog.id AND d.file_size IS NOT NULL AND d.file_size > 0
  );

-- authors: extract object keys from datasets.enrichment_json.$.authors
-- Enrichment writes authors as { "Gan Huang": {...}, "Zhenxing Hu": {...} }
-- (per backend/src/services/enrich-dataset.ts output schema). The keys are
-- the names; values carry ORCID / affiliation metadata. Join the keys into a
-- CSV that matches the format catalog-sync uses elsewhere.
UPDATE nemar_catalog
SET authors = (
      SELECT GROUP_CONCAT(je.key, ', ')
      FROM datasets d, json_each(d.enrichment_json, '$.authors') AS je
      WHERE d.dataset_id = nemar_catalog.id
    ),
    synced_at = datetime('now')
WHERE (authors IS NULL OR authors = '')
  AND EXISTS (
    SELECT 1 FROM datasets d
    WHERE d.dataset_id = nemar_catalog.id
      AND d.enrichment_json IS NOT NULL
      AND json_type(d.enrichment_json, '$.authors') = 'object'
  );

-- authors (legacy array shape: [{"name": "X"}, ...]). Some older enrichments
-- emitted this form; cover it with a second pass on rows that the object-form
-- update didn't fill.
UPDATE nemar_catalog
SET authors = (
      SELECT GROUP_CONCAT(json_extract(je.value, '$.name'), ', ')
      FROM datasets d, json_each(d.enrichment_json, '$.authors') AS je
      WHERE d.dataset_id = nemar_catalog.id
        AND json_extract(je.value, '$.name') IS NOT NULL
    ),
    synced_at = datetime('now')
WHERE (authors IS NULL OR authors = '')
  AND EXISTS (
    SELECT 1 FROM datasets d
    WHERE d.dataset_id = nemar_catalog.id
      AND d.enrichment_json IS NOT NULL
      AND json_type(d.enrichment_json, '$.authors') = 'array'
  );

-- license: copy from enrichment_json
UPDATE nemar_catalog
SET license = (
      SELECT json_extract(d.enrichment_json, '$.license')
      FROM datasets d
      WHERE d.dataset_id = nemar_catalog.id
    ),
    synced_at = datetime('now')
WHERE (license IS NULL OR license = '')
  AND EXISTS (
    SELECT 1 FROM datasets d
    WHERE d.dataset_id = nemar_catalog.id
      AND json_extract(d.enrichment_json, '$.license') IS NOT NULL
  );
