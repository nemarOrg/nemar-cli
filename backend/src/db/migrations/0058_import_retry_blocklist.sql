-- Migration 0058: retry-engine + blocklist columns on import_jobs (epic #967
-- Phase 2, issue #969).
--
-- The retry engine (services/import-retry.ts) discovers every incomplete
-- import -- `quarantined`, `failed`, AND a `complete` row whose S3 objects
-- turn out to be missing/0-byte (services/import-integrity.ts reclassifies
-- those to the new `incomplete` status; see import-recovery.ts) -- and
-- retries the copy on a paced, capped, ~2-week window by re-dispatching
-- onboard-openneuro.yml. A dataset whose OpenNeuro source is genuinely
-- inaccessible (public-but-403) is parked on the blocklist below with a slow
-- re-check, so access restoration auto-resumes the import instead of needing
-- a human to notice.
--
-- recovery_attempts: retry-engine dispatch counter, distinct from
--   auto_attempts (0047), which counts the UNRELATED discovery-tick loop.
-- first_incomplete_at: set once when a row first enters an incomplete/failed
--   state under the engine (never overwritten while still incomplete;
--   cleared on return to healthy `complete`) -- the anchor for the 2-week
--   retry window.
-- next_retry_at: earliest time the engine may re-dispatch (backoff), and also
--   the earliest time a blocklisted row may be re-verified (slow re-check).
-- blocklisted / blocklist_reason: 1 = parked as upstream-inaccessible (or, in
--   principle, undispatchable for lack of a source_id -- defensive; source_id
--   is TEXT NOT NULL and validated non-empty at every write path today, so
--   that reason is not currently reachable); the engine stops dispatching and
--   only re-verifies on the slow cadence.
-- maintainer_notified_at: set when the OpenNeuro maintainer report email was
--   actually sent (once); stays NULL while the flag-gated send is dry-run.
-- integrity_checked_at: last time verifyImportS3 re-checked this row's S3
--   per-key state; NULL = never. Drives the bounded, resumable
--   reclassification sweep over `complete` rows.
--
-- Plain ADD COLUMN; import_jobs is not FTS-backed and not in any trigger OF
-- list (same note as 0047).
ALTER TABLE import_jobs ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE import_jobs ADD COLUMN first_incomplete_at TEXT;
ALTER TABLE import_jobs ADD COLUMN next_retry_at TEXT;
ALTER TABLE import_jobs ADD COLUMN blocklisted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE import_jobs ADD COLUMN blocklist_reason TEXT;
ALTER TABLE import_jobs ADD COLUMN maintainer_notified_at TEXT;
ALTER TABLE import_jobs ADD COLUMN integrity_checked_at TEXT;
