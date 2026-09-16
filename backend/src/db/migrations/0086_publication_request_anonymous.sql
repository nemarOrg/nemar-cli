-- A publication request remembers whether it asked for an ANONYMOUS release
-- (#1408, epic #1406).
--
-- Phase 2 (#1407, migration 0085) made anonymity a state on `datasets`. This
-- records the INTENT on the request, which is a different fact and cannot be
-- derived from the dataset row:
--
--   * At request time the dataset is not yet anonymous -- asking is what makes
--     it so, later, when an admin approves. Reading `datasets.anonymous` at
--     approval would therefore always say "no".
--   * The two publications are different runs. An anonymous release skips the
--     steps that expose identity (publish_doi, upload_to_zenodo, version_doi)
--     and keeps the repository private; a normal one does neither. The
--     orchestrator picks the step set from this column.
--   * A request is a durable record of what a person asked for. After the
--     deposit is de-anonymized and published, `datasets.anonymous` is 0, and
--     without this column the history would read as though the anonymous
--     release never happened.
--
-- Not a CHECK-constrained enum: it is a plain boolean intent, and `datasets`'
-- own triggers are what enforce the invariant that matters (anonymous implies
-- never published). A request that asks for anonymity on an already-published
-- dataset is refused by the route, and by those triggers if the route ever
-- forgets.

ALTER TABLE publication_requests ADD COLUMN anonymous INTEGER NOT NULL DEFAULT 0;

-- No backfill of the new column. Every existing request predates the feature,
-- so 0 is not a guess -- it is the truth, and the DEFAULT already states it.

-- One row cleanup, though. Phase 2 blocked every publication request from an
-- anonymous dataset with `block_reason = 'anonymous_deposit'`, and this phase
-- replaces that flat refusal with a conditional gate: the normal request IS
-- how a blinded deposit gets published for real. The reason no longer exists
-- in the code or in `shared/contract/publication.ts`, so a surviving row would
-- serve a value the CLI's enum does not know, on the one route a depositor
-- checks to find out why they are stuck. Production has none (nothing set
-- `anonymous = 1` before this epic); a staging walk-through can.
--
-- Re-opened rather than deleted: the request itself was legitimate, and what
-- was wrong was the refusal.
UPDATE publication_requests
   SET status = 'requested',
       block_reason = NULL,
       updated_at = datetime('now')
 WHERE block_reason = 'anonymous_deposit';
