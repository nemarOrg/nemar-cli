-- The edge-cache epoch of each dataset's quality views (ADR 0137 decision 7, epic #2324 phase B2).
--
-- WHAT THIS IS FOR. The public quality route (`routes/quality.ts`) keeps its answers in the edge cache
-- under a key that carries the dataset's epoch. Every change to a column the route's dataset gate reads
-- (visibility, status, anonymity, first publication, withdrawal, the concept DOI's tombstone) advances
-- the epoch, so an unpublish, a withdrawal or a concealment reaches the cache at the next request: no
-- entry written before the change is ever looked up again. The route also checks the dataset row in D1
-- on every request BEFORE it reads the cache, so the epoch is the second guard, not the first.
--
-- A TABLE OF ITS OWN, NOT A COLUMN. `datasets` sits near D1's 100-column cap
-- (`datasets-column-budget.test.ts`), and an epoch is bookkeeping, not a fact about a dataset. A dataset
-- with no row is at epoch 0; the first change writes 1.
--
-- NO DELETION. A deleted dataset's row stays: it holds a dataset id and a number, and dropping it would
-- start a dataset re-made under the same id at 0 again, where an old cache entry could still sit.
--
-- NO CHECK. The only writer is the trigger below, which runs inside every UPDATE of a gate column of
-- `datasets`; a CHECK this table could fail (an id of an unexpected shape, say) would abort that UPDATE,
-- and an unpublish, a withdrawal or a concealment must never be refused for the sake of a cache.

CREATE TABLE dataset_quality_epochs (
  dataset_id TEXT PRIMARY KEY NOT NULL,
  epoch INTEGER NOT NULL
);

-- Shaped like 0145: an UPDATE OF the gate's columns, guarded by a real change, so an UPDATE that rewrites
-- a value with itself does not advance it. The inner statement writes another table, so it fires nothing.
CREATE TRIGGER datasets_quality_epoch_au
AFTER UPDATE OF visibility, status, anonymous, first_published_at, withdrawn_at, ezid_status ON datasets
WHEN old.visibility IS NOT new.visibility OR old.status IS NOT new.status
  OR old.anonymous IS NOT new.anonymous OR old.first_published_at IS NOT new.first_published_at
  OR old.withdrawn_at IS NOT new.withdrawn_at OR old.ezid_status IS NOT new.ezid_status
BEGIN
  INSERT INTO dataset_quality_epochs (dataset_id, epoch) VALUES (new.dataset_id, 1)
    ON CONFLICT (dataset_id) DO UPDATE SET epoch = epoch + 1;
END;
