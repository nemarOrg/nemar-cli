-- The upstream snapshot a dataset version mirrors (epic #1046 phase 2, #1908; ADR 0111, decision 4).
--
-- WHAT THIS IS FOR. An imported OpenNeuro mirror must be able to say which upstream tag its
-- tree came from, because a re-pull replays the delta between that tag and a newer one. Nothing
-- recorded it: the importer cloned the default HEAD and neither table had a column for it. The
-- dataset's mirrored tag is DERIVED at read time from its highest version row, so `datasets`
-- gains nothing and stays under ADR 0034's column budget (this file does not touch it).
--
--   * `source_version`: the upstream tag (`2.0.2`, or a legacy one such as `00001`), or NULL.
--     A value here always means a KNOWN tag. It is the string upstream wrote, never normalized.
--   * `source_version_basis`: how the tag is known.
--       NULL (with source_version NULL)     never examined. Every row that exists today is this.
--       'unknown' (with source_version NULL) examined, and no single tag could be established:
--                                            a description that names no matching entry or whose
--                                            entry disagrees with itself; a description that is
--                                            not valid JSON (recorded by the sites that read the
--                                            raw file, not by the inline paths, which leave
--                                            NULL/NULL); or a 404 for the tagged file older than
--                                            an hour that a control read of the same repository
--                                            (same credential) shows is about the tag. Not a
--                                            fetch error: an error writes nothing. Final: nothing
--                                            examines the row again.
--       'doi'                                the tag is DECLARED by the version's own tagged
--                                            dataset_description.json, in the entry of
--                                            `SourceDatasets` that names this dataset's upstream
--                                            `ds` (its `Version`, its DOI or its URL). The word
--                                            says the claim comes from the description; it does
--                                            not say the tree was compared with upstream's.
--       'lineage'                            the tree was compared with upstream's outside the
--                                            paths NEMAR owns. Written only by a re-pull plan
--                                            (a later phase); nothing in this phase writes it.
--
-- The three states are different facts and must stay different (ADR 0053, ADR 0054): "never
-- examined" is not "examined and unknown", and neither is a tag. Hence the CHECK, which makes
-- the two NULL-tag states and the known-tag state the only three rows the table can hold.
--
-- Each term of the CHECK is TRUE or FALSE, never NULL: a CHECK passes on NULL, and
-- `NULL IN ('doi', 'lineage')` is NULL, which would let a tag with no basis in. When basis is NULL
-- only the first term can be TRUE, and only if source_version is NULL too.
--
-- This is a cross-column CHECK inside ADD COLUMN. It is exercised on SQLite by
-- backend/test/source-version-migration.test.ts; it is UNVERIFIED on D1 until the dev deploy.
-- Existing rows hold NULL/NULL, which the CHECK accepts, so adding it re-validates every row
-- and rejects none.

ALTER TABLE dataset_versions ADD COLUMN source_version TEXT;
ALTER TABLE dataset_versions ADD COLUMN source_version_basis TEXT
  CHECK (
    (source_version_basis IS NULL AND source_version IS NULL)
    OR (source_version_basis IS NOT NULL AND source_version_basis = 'unknown' AND source_version IS NULL)
    OR (source_version_basis IS NOT NULL AND source_version_basis IN ('doi', 'lineage') AND source_version IS NOT NULL)
  );
