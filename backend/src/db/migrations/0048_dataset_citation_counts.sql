-- Per-dataset citation counts on the source of truth (#804).
--
-- The counts are produced by the dataset_citations pipeline and published as a
-- manifest at dashboard.nemar.org/citations/api/index.json. A scheduled worker
-- (services/citation-counts-sync.ts) upserts them here by dataset_id so the
-- catalog can order datasets by citation count without loading per-paper detail
-- (the detail stays in the dashboard API, fetched lazily by the nemar.org
-- citation modal). Additive ADD COLUMN only; existing rows default to 0.
-- See dataset_citations#170.
ALTER TABLE datasets ADD COLUMN num_citations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE datasets ADD COLUMN num_dataset_citations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE datasets ADD COLUMN num_datapaper_citations INTEGER NOT NULL DEFAULT 0;
-- When the counts were last synced from the manifest (NULL = never).
ALTER TABLE datasets ADD COLUMN citations_updated_at TEXT;

-- Supports `GET /datasets?sort=citations` (ORDER BY num_citations DESC).
CREATE INDEX IF NOT EXISTS idx_datasets_num_citations ON datasets(num_citations);
