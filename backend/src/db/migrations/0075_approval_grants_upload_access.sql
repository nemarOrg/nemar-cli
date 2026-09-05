-- Approval grants upload access (epic #1250, phase #1251; bug #1249).
--
-- Migration 0062 (website ADR 0010) added `service_access` as the upload gate
-- but never built the grant path, so `nemar admin approve` moved a user to
-- status='approved' without unlocking upload, and ORCID web signups landed at
-- 'approved' by auto-approval with no admin ever involved. Two different
-- populations therefore sit at 'approved' meaning two different things.
--
-- ADR 0040 fixes the vocabulary: 'verified' is the base tier (browse,
-- dashboard, settings, CLI key, sandbox, request upload access) and 'approved'
-- means an admin granted upload. The invariant this migration establishes, and
-- that the approve/revoke routes then maintain, is:
--
--     status = 'approved'  <=>  service_access = 1
--
-- Both statements are keyed on `service_access = 0`, so re-running is a no-op.
-- That is load-bearing rather than incidental: production already had rule (a)
-- applied by hand on 2026-09-05 (the interim step recorded on #1250), and this
-- migration must not re-stamp those rows with a later grant timestamp.
--
-- NOT ONE TRANSACTION, and it does not need to be. `wrangler d1 migrations
-- apply` reads this file, appends its own `INSERT INTO d1_migrations`, and hands
-- the whole string to executeSql (wrangler-dist/cli.js, the `unappliedMigrations`
-- loop). With --local that is split into statements and run through
-- `db.batch()`, which IS one transaction; against the remote database it is a
-- single POST to the D1 `/query` endpoint whose transactional scope wrangler
-- does not guarantee -- and wrangler's own result handling assumes it may not
-- be, walking each statement's `success` and marking the migration failed if any
-- of them did not land. So a partial application is possible on the remote path,
-- and idempotency, not atomicity, is what makes that safe here:
--   * the two statements touch disjoint populations (signup_source 'cli' vs
--     'web'), so neither can half-apply the other's work;
--   * each narrows its own predicate by succeeding -- (a) leaves rows at
--     service_access = 1, (b) leaves them out of 'approved' -- so re-running
--     after a partial application finishes the remainder and touches nothing
--     that already landed.
-- Re-run the migration on failure; do not hand-repair.
--
-- ONE SHAPE THIS DOES NOT REACH: 0062 also grandfathered `role IN ('owner',
-- 'admin')` regardless of status, so an owner or admin sitting at 'verified' or
-- 'pending' would hold service_access = 1 without being 'approved'. Every
-- owner/admin is approved in practice, so this is expected to be an empty set,
-- and neither available repair is right for it (promoting the status would
-- approve someone no admin approved; clearing the grant would lock a working
-- admin out of upload). If such a row exists, resolve it deliberately with
-- `nemar admin approve` or `nemar admin revoke`, either of which restores the
-- invariant for that row.
--
-- DEPLOY ORDER: apply this only alongside epic #1250 phase 2, which teaches the
-- auth middleware and the website that 'verified' is active and gives a
-- 'pending' web user a verify-your-email step. Applied on its own, rule (b)
-- moves every live web account out of 'approved', and
-- `userStatusForDashboard` (backend/src/routes/auth-web.ts) reports both
-- landing tiers as "pending" with nothing on the page to act on.

-- (a) CLI signups an admin actually approved. The approval WAS the upload
-- decision under the pre-0062 world, and #1249 is exactly the complaint that it
-- silently stopped being one. granted_by stays NULL, which is how 0062 already
-- spells "granted by the system, not by a named admin".
UPDATE users
   SET service_access = 1,
       service_access_granted_at = datetime('now'),
       service_access_granted_by = NULL,
       updated_at = datetime('now')
 WHERE status = 'approved'
   AND service_access = 0
   AND signup_source = 'cli'
   AND deleted_at IS NULL;

-- (b) Web signups auto-approved by ORCID finalize. No admin ever reviewed
-- these, so they are base-tier accounts wearing the approved label: move them
-- to the tier they actually hold.
--
-- Only `email_verified` decides the landing tier. 'verified' means the EMAIL is
-- verified (ADR 0040), and ORCID does not stand in for it: ORCID proves the
-- person, the email code proves the inbox, and the base tier needs both --
-- notifications, the sign-in code and the upload-request thread all go to that
-- address. This is why the split is real work rather than a relabel: of the 19
-- production rows in this population every one is orcid_verified, and exactly
-- one is email_verified, so 18 accounts land at 'pending' and have an inbox to
-- confirm.
--
-- approved_at is cleared with the status: these rows were never admin-approved,
-- and leaving the stamp behind would make an auto-approval indistinguishable
-- from a reviewed one in the admin listing. The upload grant, when it comes,
-- has its own stamp in service_access_granted_at.
--
-- `deleted_at IS NULL` is not in the issue text but is deliberate: a tombstoned
-- row is force-flipped to 'revoked' by the delete route, so it cannot match
-- anyway, and the guard keeps a future tombstone shape from being resurrected
-- into a live tier by this statement.
UPDATE users
   SET status = CASE WHEN email_verified = 1 THEN 'verified' ELSE 'pending' END,
       approved_at = NULL,
       updated_at = datetime('now')
 WHERE status = 'approved'
   AND service_access = 0
   AND signup_source = 'web'
   AND deleted_at IS NULL;
