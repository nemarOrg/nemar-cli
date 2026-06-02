-- Dataset-store consolidation, Phase 3 prerequisite (#646, #649).
--
-- Close the authors/license gap before flipping reads onto `datasets`.
-- Migration 0030 backfilled datasets.authors/license ONLY from enrichment_json,
-- so managed datasets whose authors/license lived only in the nemar_catalog
-- cache (never enriched) still have NULL there. Measured on prod-shaped dev:
-- 57 managed rows would lose authors and 56 would lose license once the list/
-- search endpoints read d.* under READ_FROM_DATASETS. Copy the cache values
-- onto the source of truth, COALESCE-preserving anything already populated.
--
-- Managed rows only (owner_user_id != -1). The sentinel-owned folded rows
-- already carry authors/license from the 0030 fold. This fires the
-- datasets_fts_au + embedding_dirty triggers for the touched rows (intended:
-- their lexical index + vector get refreshed).

UPDATE datasets SET
  authors = COALESCE(authors, (SELECT c.authors FROM nemar_catalog c WHERE c.id = datasets.dataset_id)),
  license = COALESCE(license, (SELECT c.license FROM nemar_catalog c WHERE c.id = datasets.dataset_id))
WHERE owner_user_id != -1
  AND dataset_id IN (SELECT id FROM nemar_catalog);
