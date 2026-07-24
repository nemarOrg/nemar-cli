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

-- Grandfather existing uploaders so the rollout never locks anyone out. Anyone
-- who could already upload keeps the ability: the current upload gate is
-- status='approved' AND sandbox_completed=1. Admins/owners are always trusted.
UPDATE users
   SET service_access = 1,
       service_access_granted_at = datetime('now')
 WHERE service_access = 0
   AND deleted_at IS NULL
   AND (
     (status = 'approved' AND sandbox_completed = 1)
     OR role IN ('owner', 'admin')
   );
