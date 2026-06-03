-- License permissiveness tier on the `datasets` source of truth (#653).
--
-- The website color-codes and filters datasets by a license tier
-- (public -> attribution -> sharealike -> noncommercial -> noderiv, plus
-- unknown). It re-derives the tier client-side from the raw `license` string,
-- but that only filters the page already fetched. Storing the derived tier
-- lets `GET /datasets?license=<tier>` filter the FULL catalog server-side.
--
-- The classifier is regex + order-sensitive (most-restrictive marker wins:
-- CC-BY-NC-ND -> noderiv, CC-BY-NC-SA -> noncommercial), so the authority is
-- backend/src/lib/license.ts#licenseTier (mirrors website src/lib/tags.ts).
-- Going-forward writes (writeDatasetCatalogFields + the legacy catalog fold)
-- recompute the tier with that exact function; this migration's CASE backfill
-- is a one-shot SQL approximation that classifies every license value present
-- in the catalog identically (asserted by test/license-tier.test.ts). Any drift
-- on an unusual future value self-heals on the row's next enrich/fold write.
--
-- NOT NULL DEFAULT 'unknown': every row is always classified, so the filter is
-- a clean `license_tier IN (...)` with no NULL branch, and it matches the
-- website's null/empty-license -> "unknown" tier. Freshly created managed rows
-- (which set no license at INSERT) read as 'unknown' until enrichment writes a
-- real license + tier. This is a plain ADD COLUMN (the DEFAULT satisfies the
-- NOT NULL), so no 0026-style table rebuild is needed.
--
-- license / license_tier are NOT in the datasets_fts or embed-dirty trigger
-- `OF` lists (0031), so this backfill touches neither the lexical index nor the
-- embedding-dirty flag -- it will not churn the catalog's vectors.

ALTER TABLE datasets ADD COLUMN license_tier TEXT NOT NULL DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS idx_datasets_license_tier ON datasets(license_tier);

-- Backfill mirroring license.ts#licenseTier. `n` normalizes the raw license the
-- same way the TS does (uppercase, [space|underscore] -> '-') so the GLOB
-- token checks ((^|-)TOK(-|$)) and LIKE substring checks line up. GLOB is
-- case-sensitive (hence the UPPER); LIKE is ASCII-case-insensitive. Order of
-- the WHEN branches IS the classifier's precedence -- do not reorder.
UPDATE datasets
SET license_tier = (
  WITH norm(n) AS (
    SELECT UPPER(REPLACE(REPLACE(COALESCE(license, ''), ' ', '-'), '_', '-'))
  )
  SELECT CASE
    WHEN license IS NULL OR TRIM(license) = '' THEN 'unknown'
    -- pass an already-classified tier name straight through
    WHEN LOWER(TRIM(license)) IN
         ('public','attribution','sharealike','noncommercial','noderiv','unknown')
      THEN LOWER(TRIM(license))
    -- noderiv: (^|-)ND(-|$) | NO-?DERIV
    WHEN (n = 'ND' OR n GLOB 'ND-*' OR n GLOB '*-ND' OR n GLOB '*-ND-*')
      OR n LIKE '%NODERIV%' OR n LIKE '%NO-DERIV%' THEN 'noderiv'
    -- noncommercial: (^|-)NC(-|$) | NON-?COMMERCIAL
    WHEN (n = 'NC' OR n GLOB 'NC-*' OR n GLOB '*-NC' OR n GLOB '*-NC-*')
      OR n LIKE '%NONCOMMERCIAL%' OR n LIKE '%NON-COMMERCIAL%' THEN 'noncommercial'
    -- sharealike: (^|-)SA(-|$) | SHARE-?ALIKE | ODBL
    WHEN (n = 'SA' OR n GLOB 'SA-*' OR n GLOB '*-SA' OR n GLOB '*-SA-*')
      OR n LIKE '%SHAREALIKE%' OR n LIKE '%SHARE-ALIKE%' OR n LIKE '%ODBL%' THEN 'sharealike'
    -- public: CC-?0 | PDDL | UNLICENSE(?!D) | PUBLIC-?DOMAIN | (^|-)PD(-|$)
    WHEN n LIKE '%CC0%' OR n LIKE '%CC-0%' OR n LIKE '%PDDL%'
      OR (n LIKE '%UNLICENSE%' AND n NOT LIKE '%UNLICENSED%')
      OR n LIKE '%PUBLICDOMAIN%' OR n LIKE '%PUBLIC-DOMAIN%'
      OR (n = 'PD' OR n GLOB 'PD-*' OR n GLOB '*-PD' OR n GLOB '*-PD-*') THEN 'public'
    -- attribution: CC-BY | ODC-BY | ATTRIBUTION
    WHEN n LIKE '%CC-BY%' OR n LIKE '%ODC-BY%' OR n LIKE '%ATTRIBUTION%' THEN 'attribution'
    ELSE 'unknown'
  END
  FROM norm
);
