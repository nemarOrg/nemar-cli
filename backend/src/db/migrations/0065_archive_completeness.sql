-- #1041: make a partial archive distinguishable from a complete one.
--
-- The gap this closes: the archive builder
-- (nemarDatasets/.github run-generate-archive.yml) counts exactly how many
-- annexed objects it could not fetch, then throws the number away. The
-- archive-ready callback carried only {dataset_id, status, size, version}, so
-- a zip missing 40% of its content and a perfect one both landed in D1 as
-- archive_status='ready'. The website, the API and the observability dashboard
-- had no way to tell them apart, and the only trace of a partial build was a
-- ::warning:: in a green Actions log.
--
-- That became load-bearing with nemarDatasets/.github#85 (nemarOrg/nemar-cli#1038),
-- which deliberately changed partial archives from "fail the build and delete
-- the zip" to "publish it", on the policy that availability is REPORTED and
-- never a precondition for serving. Missing files are omitted from the zip
-- rather than written as 0-byte entries, so the archive never lists content it
-- does not carry -- but something has to carry the fact that it is short, and
-- these columns are it.
--
-- Latest-only, matching the existing archive_* columns (archive_status,
-- archive_size, archive_skip_reason) which are all denormalized onto `datasets`
-- for the version whose archive was built most recently. Deliberately NOT
-- per-version like data_complete (0059): archive_status itself is latest-only,
-- so a per-version completeness column here would have no archive_status to sit
-- beside. The per-version truth stays in .nemar/availability-report.json (#999).
--
-- archive_complete: 0/1, NULL = not assessed. 1 = every declared file made it
--   into the zip; 0 = at least one was omitted. NULL covers every archive built
--   before this shipped, plus the idempotent skip path where the stream script
--   never ran and no tally exists. CHECK enforces the domain; NULL still passes
--   (NULL IN (0,1) is NULL, not false), same as data_complete in 0059.
-- archive_absent_files: annexed objects S3 authoritatively reported missing
--   (404/NoSuchKey) or that failed the ContentLength-vs-annex-key size check
--   (the #967 empty-PUT hollow-object signature). These are permanently gone
--   upstream, so a rebuild cannot recover them.
-- archive_declared_files: total files the version manifest declared, so
--   absent/declared is readable without a second lookup and the dashboard can
--   rank "how short" rather than just "short".
--
-- Populated by the archive-ready callback (routes/callbacks/archive-ready.ts).
-- Rows stay NULL until that dataset's next archive build, which the website
-- must treat as "not assessed yet", NOT as "incomplete".

ALTER TABLE datasets ADD COLUMN archive_complete INTEGER CHECK (archive_complete IN (0, 1));
ALTER TABLE datasets ADD COLUMN archive_absent_files INTEGER;
ALTER TABLE datasets ADD COLUMN archive_declared_files INTEGER;

CREATE INDEX IF NOT EXISTS idx_datasets_archive_complete ON datasets(archive_complete);
