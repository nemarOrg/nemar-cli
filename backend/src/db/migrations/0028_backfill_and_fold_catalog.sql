-- Dataset-store consolidation, Phase 1 / expand step 2 (#646, #647).
--
-- (a) + (b) seed the new columns added in 0027 for MANAGED rows from data
--     that already exists (enrichment_json + the row's nemar_catalog cache),
--     COALESCE-preserving any value already present (idempotent on re-run).
--     NOTE: this is a one-time seed. Keeping datasets.authors/readme current
--     after each enrichment run is Phase 2's job (#648 adds the write path);
--     until then a row enriched AFTER this migration carries its migration-time
--     value in datasets.* while the live value lives in nemar_catalog.
-- (c) FOLDS legacy catalog-only rows from nemar_catalog INTO datasets under
--     the sentinel owner (-1), so `datasets` becomes the single source of
--     truth. The fold carries both dedup guards from the live list endpoint
--     (equivalent in intent to routes/datasets.ts:604-616; the owner_user_id
--     != ? qualifier from the live route is omitted here because the sentinel
--     rows are being inserted by THIS migration and don't exist yet when the
--     WHERE is evaluated) so mirrored rows never double-list.
--
-- Read paths still serve these folded rows from nemar_catalog this phase
-- (code-side dormancy guards keep them out of the managed branch), so this
-- migration is wire-invisible to GET /datasets.

------------------------------------------------------------------
-- (a) authors / license for MANAGED rows from enrichment_json.
--     Faithful copy of shipped 0023's extraction: enrichment emits authors
--     as an object keyed by name (current pipeline) or, for older rows, an
--     array of {name}. COALESCE(existing, derived) preserves any value
--     already set.
------------------------------------------------------------------
UPDATE datasets SET
  authors = COALESCE(authors, CASE
    WHEN json_type(enrichment_json, '$.authors') = 'object' THEN
      (SELECT GROUP_CONCAT(je.key, ', ')
       FROM json_each(enrichment_json, '$.authors') je)
    WHEN json_type(enrichment_json, '$.authors') = 'array' THEN
      (SELECT GROUP_CONCAT(json_extract(je.value, '$.name'), ', ')
       FROM json_each(enrichment_json, '$.authors') je
       WHERE json_extract(je.value, '$.name') IS NOT NULL)
    ELSE NULL END),
  license = COALESCE(license, json_extract(enrichment_json, '$.license'))
WHERE enrichment_json IS NOT NULL;

------------------------------------------------------------------
-- (b) readme / bids_version / sessions_count / publish_date /
--     file_size_formatted for MANAGED rows from their existing
--     nemar_catalog cache row. COALESCE(existing, cached) preserves any
--     value already on the datasets row. readme truncated to 8 KB to keep
--     D1 row width in check (sufficient for FTS body match + description).
------------------------------------------------------------------
UPDATE datasets SET
  readme              = COALESCE(readme,              (SELECT substr(c.readme, 1, 8192) FROM nemar_catalog c WHERE c.id = datasets.dataset_id)),
  bids_version        = COALESCE(bids_version,        (SELECT c.bids_version            FROM nemar_catalog c WHERE c.id = datasets.dataset_id)),
  sessions_count      = COALESCE(sessions_count,      (SELECT c.sessions_count          FROM nemar_catalog c WHERE c.id = datasets.dataset_id)),
  publish_date        = COALESCE(publish_date,        (SELECT c.publish_date            FROM nemar_catalog c WHERE c.id = datasets.dataset_id)),
  file_size_formatted = COALESCE(file_size_formatted, (SELECT c.file_size_formatted     FROM nemar_catalog c WHERE c.id = datasets.dataset_id))
WHERE dataset_id IN (SELECT id FROM nemar_catalog);

------------------------------------------------------------------
-- (c) FOLD legacy catalog-only rows into datasets (sentinel owner -1).
--     BOTH dedup guards (equivalent in intent to routes/datasets.ts:604-616):
--       1. skip ids that are already an active managed dataset;
--       2. skip ds* shadows of a managed on* mirror (the mirror carries the
--          canonical on* id and back-points via source_id = "ds...").
--     concept_doi is folded from c.doi so the legacy DOI is preserved on the
--     source of truth for Phase 3 (read paths still serve c.doi from
--     nemar_catalog this phase). embedding_dirty=1: these rows have no vector
--     yet (drained by the Phase-4 cron).
--     INSERT OR IGNORE additionally drops any catalog id that collides with a
--     dataset_id present only in a NON-active state (archived/deleted) -- guard
--     1 filters on status='active' so it wouldn't catch those, and the UNIQUE
--     constraint on dataset_id would otherwise error. Such a collision means a
--     deleted managed dataset left a stale nemar_catalog row; post-apply, run
--     the verification query below to surface any:
--       SELECT c.id FROM nemar_catalog c
--       JOIN datasets d ON d.dataset_id = c.id AND d.status != 'active'
--       WHERE c.id NOT IN (SELECT dataset_id FROM datasets WHERE status='active');
------------------------------------------------------------------
INSERT OR IGNORE INTO datasets (
  dataset_id, name, description, owner_user_id, status, visibility, is_sandbox,
  source, source_id, subject_count, modalities, age_min, age_max, file_size,
  total_files, tasks, authors, license, readme, bids_version, sessions_count,
  publish_date, uploader, file_size_formatted, concept_doi, created_at, updated_at, embedding_dirty
)
SELECT
  c.id, COALESCE(c.name, c.id), c.description, -1, 'active', 'public', 0,
  c.source, c.source_id, c.participants, c.modalities, c.age_min, c.age_max, c.file_size,
  c.total_files, c.tasks, c.authors, c.license, substr(c.readme, 1, 8192), c.bids_version, c.sessions_count,
  COALESCE(c.publish_date, c.created_date, datetime('now')), c.uploader, c.file_size_formatted, c.doi,
  COALESCE(c.created_date, datetime('now')), datetime('now'), 1
FROM nemar_catalog c
WHERE c.id NOT IN (SELECT dataset_id FROM datasets WHERE status = 'active')
  AND c.id NOT IN (
        SELECT source_id FROM datasets
        WHERE status = 'active' AND source = 'openneuro' AND source_id IS NOT NULL
      );
