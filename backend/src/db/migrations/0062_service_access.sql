-- Tiered access, Phase 1 (website ADR 0010, epic #1013).
--
-- Splits the single `status='approved'` gate into two tiers:
--   * base access   -- auto-granted on ORCID sign-in; view/dashboard only.
--   * service access -- a separate per-user grant an admin makes after reviewing
--     GitHub + location/affiliation for export-control screening. Required to
--     upload or use compute. Closed by default.
--
-- ORCID iDs are free to create, so ORCID-verified is not authorization to
-- consume finite compute/storage; and NEMAR compute carries export-control /
-- local-jurisdiction restrictions requiring a human review of who/where.

ALTER TABLE users ADD COLUMN service_access INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN service_access_granted_at TEXT;
-- users.id of the admin who granted; NULL for grandfathered / system grants.
ALTER TABLE users ADD COLUMN service_access_granted_by INTEGER;

-- Grandfather existing self-serve uploaders so the rollout never locks out
-- people who created their own datasets: the current create gate is
-- status='approved' AND sandbox_completed=1. Admins/owners are always trusted.
-- Deliberately NOT grandfathering invite-only collaborators (a user with an S3
-- permission but no sandbox training): per ADR 0010, collaborators keep download
-- but do not upload -- their upload ability is intentionally withdrawn here, and
-- the dataset owner (who has service access) remains responsible for them.
UPDATE users
   SET service_access = 1,
       service_access_granted_at = datetime('now')
 WHERE service_access = 0
   AND deleted_at IS NULL
   AND (
     (status = 'approved' AND sandbox_completed = 1)
     OR role IN ('owner', 'admin')
   );

-- Unstick existing ORCID-first web signups that landed status='pending' before
-- auto-approve (nemar-cli#1012): ORCID is the identity proof, so grant them base
-- access like a fresh sign-in would now. service_access stays 0 (no upload).
-- Scoped to verified-ORCID web rows so CLI/unverified pending users are untouched.
UPDATE users
   SET status = 'approved',
       approved_at = COALESCE(approved_at, datetime('now'))
 WHERE status = 'pending'
   AND signup_source = 'web'
   AND orcid IS NOT NULL
   AND orcid_verified = 1
   AND deleted_at IS NULL;
