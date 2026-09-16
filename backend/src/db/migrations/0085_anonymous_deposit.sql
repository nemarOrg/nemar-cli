-- Anonymous deposit (#1407, epic #1406): a dataset may conceal its depositor
-- from the public, and only before it has ever been published.
--
-- TWO columns, both spending budget deliberately (ADR 0034 pins the count at
-- `backend/test/datasets-column-budget.test.ts`; 81 -> 83 against a 97
-- ceiling). Neither is derivable at read time, which is ADR 0034's own test
-- for when a column is the right answer:
--
--   first_published_at  There is no record today of whether a dataset's
--                       DEPOSITOR has ever been named in public.
--                       `publish_date` is written by no current code path
--                       (only old catalog-fold migrations populated it),
--                       `visibility` is current state with no history, and
--                       the admin visibility route leaves no row-local trace.
--                       The obvious substitute is unsound: the publish
--                       orchestrator sets visibility='public' BEFORE it mints
--                       the DOI, so a crashed run leaves a public dataset
--                       with concept_doi IS NULL. Written once at publish,
--                       never cleared -- including on withdrawal, because
--                       "was once public" is exactly what a withdrawal does
--                       not undo.
--
--                       It means "public WITH attribution", not "public": an
--                       anonymous deposit is deliberately visibility='public'
--                       while concealing its depositor, so every path to
--                       public stamps this only when the row is not anonymous
--                       (FIRST_PUBLICATION_STAMP_SQL in services/anonymity.ts
--                       is that rule). Without the distinction the triggers
--                       below would forbid the very state this feature adds.
--
--   anonymous           Gates identity disclosure and is filtered in SQL, so
--                       it does not belong in the sweep_stamps JSON (ADR
--                       0035), whose convention is that a missing key means
--                       "not yet swept" -- the wrong reading for a fact whose
--                       absence must mean "not anonymous".
--
-- The invariant is enforced HERE rather than in application code, because a
-- rule that lives only in a service is a rule a future route can forget.
-- Triggers rather than a table-level CHECK: adding a CHECK needs a full table
-- rebuild, and `datasets` has three FK children whose rescue-and-restore
-- ordering migration 0071 documents at length. Two triggers get the same
-- refusal without any of that risk.

ALTER TABLE datasets ADD COLUMN first_published_at TEXT;
ALTER TABLE datasets ADD COLUMN anonymous INTEGER NOT NULL DEFAULT 0;

-- Backfill: every dataset that is public now, or carries a DOI, or has a
-- published version, or was folded in from the legacy catalog with a
-- publish_date, has been published at least once. Anonymity did not exist
-- before this migration, so every one of them was published attributed.
--
-- The timestamp is the best evidence available rather than a guess -- the
-- earliest version row if there is one, else created_at -- and the column is
-- nullable precisely so "never published" stays distinguishable from
-- "published at an unknown time". Existing rows are never anonymous, which
-- the DEFAULT already says.
--
-- Four disjuncts because no single one is sufficient: a crashed publish has
-- no DOI, an unversioned dataset has no version row, and a dataset that was
-- public and has since been reverted to private is caught only by the DOI or
-- version arms. One bounded gap remains and is accepted rather than papered
-- over: `POST /admin/datasets/:id/reset` destroys all four signals at once
-- (deletes the version rows, nulls concept_doi, sets visibility='private'),
-- so a row that was public BEFORE this migration and is reset before it is
-- ever stamped would backfill as never-published. That path exists for the
-- disposable E2E dataset nm099999; every dataset reset AFTER this migration
-- keeps its stamp, because nothing clears the column.
UPDATE datasets
SET first_published_at = COALESCE(
      (SELECT MIN(dv.created_at) FROM dataset_versions dv WHERE dv.dataset_id = datasets.dataset_id),
      publish_date,
      created_at
    )
WHERE first_published_at IS NULL
  AND (
    visibility = 'public'
    OR (concept_doi IS NOT NULL AND concept_doi != '')
    OR publish_date IS NOT NULL
    OR EXISTS (SELECT 1 FROM dataset_versions dv WHERE dv.dataset_id = datasets.dataset_id)
  );

CREATE TRIGGER datasets_anonymous_unpublished_ai
BEFORE INSERT ON datasets
WHEN NEW.anonymous = 1 AND NEW.first_published_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'anonymous requires first_published_at IS NULL: a published dataset cannot become anonymous');
END;

CREATE TRIGGER datasets_anonymous_unpublished_au
BEFORE UPDATE ON datasets
WHEN NEW.anonymous = 1 AND NEW.first_published_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'anonymous requires first_published_at IS NULL: a published dataset cannot become anonymous');
END;

-- Partial index: the anonymous set is tiny by construction (a handful of
-- in-flight deposits against ~800 rows), and every read of THAT SET is
-- `anonymous = 1`. The `anonymous = 0` predicates elsewhere (the zarr
-- fidelity sweep's candidates) and the disjunctions in index.ts's staleness
-- crons select almost every row and are full scans by design; this index is
-- not for them.
CREATE INDEX idx_datasets_anonymous ON datasets(anonymous) WHERE anonymous = 1;
