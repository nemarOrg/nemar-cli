-- Epic #967 phase 4 (#971): withdrawal columns for the 11 datasets published
-- with 0-byte content whose source cannot currently be recovered (9 upstream
-- OpenNeuro 403s, 2 with no source found -- see scripts/withdrawn-datasets.json).
--
-- Withdrawal = make the dataset private (existing bidirectional visibility
-- mechanism: GitHub repo + S3 deny-list carve-out + D1 `visibility`, unchanged
-- by this migration) + tombstone its EZID DOI(s) (`_status=unavailable`), both
-- reversible. `status` (lifecycle, migration 0001) is untouched -- withdrawal is
-- not deletion; only `visibility` gates catalog/data-plane access (catalog.ts,
-- data.ts). withdrawn_at/withdrawn_reason record the explicit "why" and let
-- `restore` find the withdrawn set without inferring it from
-- `visibility='private' AND ezid_status='unavailable'` (which could also be an
-- unrelated private, never-published dataset).
--
-- datasets.ezid_status (0007) already carries the CONCEPT DOI's EZID status.
-- There has been no equivalent for VERSION DOIs (dataset_versions.doi, also
-- 0007) -- the withdraw service (services/withdraw.ts) needs one so a
-- withdrawal can tombstone every version DOI, not just the concept, and so a
-- restore can tell which versions it re-published. NULL for all existing rows
-- (not classified/never withdrawn); populated going forward by withdraw/restore.
--
-- withdrawn_at: timestamp of the withdrawal (NULL = not withdrawn).
-- withdrawn_reason: 'upstream_403' | 'no_source' (see scripts/withdrawn-datasets.json);
--   free TEXT rather than a CHECK domain since a future withdrawal reason
--   (e.g. a DMCA takedown) shouldn't require a migration to add.

ALTER TABLE datasets ADD COLUMN withdrawn_at TEXT;
ALTER TABLE datasets ADD COLUMN withdrawn_reason TEXT;

ALTER TABLE dataset_versions ADD COLUMN ezid_status TEXT;
