-- Insert nemar_catalog rows for datasets that don't yet have one.
--
-- Migration 0023 backfilled nemar_catalog columns from datasets.* +
-- enrichment_json, but only via UPDATE -- it could not fill a catalog row
-- that didn't exist in the first place. ~100 datasets created via the new
-- in-process pipeline never got an initial INSERT from catalog-sync.ts
-- (which pulls from the legacy nemar.org upstream that doesn't know about
-- them), so the discover card continued to render empty fields for them.
--
-- This migration creates the missing rows by projecting from the
-- source-of-truth `datasets` row plus `enrichment_json`. After it runs,
-- every active dataset has a matching nemar_catalog row and the list
-- endpoint reads consistent values for all of them.
--
-- New datasets going forward are inserted by the existing dataset-creation
-- flow + catalog-sync; the helper added in #541 keeps the row in sync on
-- every subsequent enrichment / reindex.

INSERT OR IGNORE INTO nemar_catalog (
  id,
  name,
  description,
  modalities,
  participants,
  age_min,
  age_max,
  tasks,
  authors,
  doi,
  license,
  file_size,
  total_files,
  source,
  source_id,
  uploader,
  created_date,
  publish_date,
  synced_at
)
SELECT
  d.dataset_id,
  COALESCE(d.name, d.dataset_id),
  d.description,
  d.modalities,
  d.subject_count,
  d.age_min,
  d.age_max,
  d.tasks,
  -- authors: enrichment emits an object keyed by name (current pipeline)
  -- with optional array fallback for legacy rows. Pick whichever shape
  -- the row carries; null if neither (the row will inherit the row's
  -- existing catalog authors once catalog-sync next runs, or stay null).
  CASE
    WHEN json_type(d.enrichment_json, '$.authors') = 'object' THEN (
      SELECT GROUP_CONCAT(je.key, ', ')
      FROM json_each(d.enrichment_json, '$.authors') AS je
    )
    WHEN json_type(d.enrichment_json, '$.authors') = 'array' THEN (
      SELECT GROUP_CONCAT(json_extract(je.value, '$.name'), ', ')
      FROM json_each(d.enrichment_json, '$.authors') AS je
      WHERE json_extract(je.value, '$.name') IS NOT NULL
    )
    ELSE NULL
  END,
  d.concept_doi,
  json_extract(d.enrichment_json, '$.license'),
  d.file_size,
  d.total_files,
  COALESCE(d.source, 'nemar.org'),
  d.source_id,
  u.username,
  d.created_at,
  d.created_at,
  datetime('now')
FROM datasets d
LEFT JOIN nemar_catalog c ON c.id = d.dataset_id
LEFT JOIN users u ON u.id = d.owner_user_id
WHERE c.id IS NULL
  AND d.status = 'active'
  AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL)
  AND d.visibility = 'public';
