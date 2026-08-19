# Implementation plan — nemar-cli#1023: admin endpoints for service-access grant/revoke

**Status:** scoping draft for human review, prepared 2026-08-10. No code changed; nothing posted to GitHub.
All file:line citations verified against the working trees on this date.

## 1. What exists today (evidence)

- **Access axis:** `backend/src/db/migrations/0062_service_access.sql:13-16` adds `service_access` (INTEGER, default 0),
  `service_access_granted_at`, `service_access_granted_by` ("NULL for grandfathered / system grants").
  **No revoked-at/by columns.** Lines 24-32 grandfather approved+sandbox users and owners/admins; 39-45 unstick ORCID web signups.
- **Export-control inputs:** `0052_user_profile_fields.sql:8-10` — city/country "required at the app/CLI layer for
  US export-control / sanctions screening"; requirement lives in validators, not NOT NULL.
- **Enforcement:** `backend/src/services/upload-gate.ts:34-52`; call sites `backend/src/routes/datasets/upload.ts:165-177`
  (create), `:538-551` (upload-urls), `:642-655` (upload-credentials). Nothing backend-side reads city/country
  (confirms website#236's claim).
- **Exposure:** `service_access` already on `/auth/me` (`backend/src/services/web-session.ts:175,238`) and `/users/me`
  (`backend/src/routes/users.ts:33,83`).
- **Gap:** `GET /admin/users` list projection (`backend/src/routes/admin/users.ts:77-81`) omits `service_access`,
  city, country, affiliation. `GET /admin/users/:username` selects `u.*` (`:136`) so the DETAIL route already has everything —
  the issue's claim that it lacks the fields is wrong; only the list needs widening. **No route anywhere writes `service_access`.**
- **Prod reality:** per the epic #1013 comment, Phase 1 shipped with no grant mechanism; grants today are raw
  `wrangler d1 execute` UPDATEs. Epic pins the intended shape: `POST /admin/users/:id/service-access`
  (require github_username, record granted_by/at) + a `nemar admin` CLI command.

## 2. Exemplar endpoints to copy

1. `POST /admin/users/:username/role` (`admin/users.ts:154-263`) — inline zod schema, `ownerMiddleware` opt-in,
   `deleted_at IS NULL` lookup, 409 on already-in-state, `auditLogStatement` in try/catch so a log failure can't 500 the mutation.
2. `POST /admin/approve/:username` (`:279-380`) — flip flag + best-effort email; `emailSent` audited and returned.
3. `DELETE /admin/users/by-id/:id` (`:696`, docblock :679-695) — precedent for **numeric-id addressing because web
   signups have `username = NULL`** (migration 0026).

Router: `authMiddleware` + `adminMiddleware` on `*` (`admin/index.ts:26-27`); `ownerMiddleware` (`middleware/auth.ts:251`) opt-in.
Audit via `auditLogStatement` (`backend/src/db/audit-log.ts:46`) only.

## 3. Addressing model: BY ID, NOT USERNAME (contradicts issue text — confirm first)

Issue #1023 says `:username`; epic comment says `:id`. ORCID web signups insert with NULL username
(`backend/src/routes/auth-orcid.ts:502-517`) and are exactly the population that queues for grants — a username-keyed
route is unaddressable for them on day one. Website already documents the trap
(`website/src/lib/users-admin-api.ts:139-141`; `admin/users/[username].astro:110-119`).
Proposal: `/admin/users/by-id/:id/service-access` matching the existing `by-id` convention. **Open question Q1.**

## 4. Endpoints

### 4.1 POST /admin/users/by-id/:id/service-access — grant

Schema: `{ reason?: string(1..2000), override_profile_checks: boolean = false }`.
Sequence: parse id (400 on NaN, reject id<=0 / SYSTEM_USER_ID); lookup with `deleted_at IS NULL` (404);
400 unless `status='approved'`; 400 if `github_username` empty (`missing: ["github_username"]`) — satisfiable via
`PATCH /auth/profile` (`auth-web.ts:508-620`, live GitHub check :589-620); 400 if city/country empty unless
`override_profile_checks` (aligns grant with website profile gate `website/src/lib/profile.ts:32,:59-63` — prevents minting
new website#236 cases); 409 if already granted; UPDATE set service_access=1 + granted_at/by + updated_at;
audit `service_access_granted` with details snapshot `{granted_by, target_username, target_email, github_username, city,
country, affiliation, reason, override_profile_checks}` — the at-grant-time snapshot IS the export-control paper trail.
Response: `{ message, user:{id, username, email, service_access, granted_at, granted_by}, email_sent }`.
No self-grant (mirror :167-169, :394-396).

### 4.2 DELETE /admin/users/by-id/:id/service-access — revoke

`{ reason?: string }` optional (DELETE bodies are awkward; accept query param too). 409 when not granted;
UPDATE service_access=0 + NEW `service_access_revoked_at/by`; audit `service_access_revoked` with
`{revoked_by, target_username, reason, granted_at, granted_by}`. Only owners revoke an owner's access (mirror :428-430).
**Deliberately NOT in scope:** token/IAM/S3/collaborator cleanup — that's account revocation (`POST /admin/revoke/:username`,
:389-676). Revoke leaves base access intact (ADR 0010 two-tier point); gate reads D1 fresh per request so no session
invalidation needed. Leave granted_at/by in place on revoke (history); document in migration comment.

### 4.3 Widen GET /admin/users

Add to projection (:77-81): `service_access`, `service_access_granted_at`, `city`, `country`, `affiliation`,
`sandbox_completed` (second half of create gate — shows whether granting will actually unblock).
Add `?service_access=true|false` filter alongside status/role (:82-105). NOTE: `params` is `string[]` (:83) —
widen to `(string|number)[]` and bind integers (loose string-vs-INTEGER comparison trap).
`?service_access=false&status=approved` = the grant queue.

### 4.4 GET /admin/users/:username — no change

Already `u.*`. Nice-to-have: LEFT JOIN to resolve `service_access_granted_by` → username (mirror `actor_username`
join in GET /admin/audit :978-984). Worth correcting the issue's inaccurate claim in the thread.

### 4.5 Route inventory pin

`test/admin-route-inventory.unit.test.ts:24-108`: add `"POST /users/by-id/:id/service-access": 2` and
`"DELETE /users/by-id/:id/service-access": 2`; update map in same commit per its docblock (:16-18).

## 5. Status/audit side effects

- `users.status` untouched — service access is orthogonal to lifecycle (ADR 0010).
- New audit actions `service_access_granted` / `service_access_revoked` (matches `<noun>_<verb>` convention).
- `resourceId = String(user.id)` (username can be NULL; precedent `email_preferences_updated` :1071); username in details.
- Audit write in try/catch (role route pattern :239-260), not bare await.
- GET /admin/audit needs no change but has no action filter (Q6).

## 6. Email

Convention: approve/revoke both send unconditional best-effort transactional mail (`sendKeyReadyEmail` :345-359,
`sendRevocationEmail` :583-597); `EmailPreferences` (email.ts:79-91) governs ADMIN fan-out only — do NOT add a category.
**Recommend: send on grant AND revoke** (grant = the moment they can upload; revoke otherwise discovered as a 403).
Add `sendServiceAccessGrantedEmail`/`RevokedEmail` following `sendKeyReadyEmail` signature (:255-262).
Grant email links to /upload; mention city/country if missing. Guard NULL username (`user.username ?? user.email`) —
`sendKeyReadyEmail` interpolates directly (:274) and would render "Congratulations, null".
Fallback if contested: `POST /admin/notify` per-user transactional send exists (:1091-1120); shipping without email is not a blocker.

## 7. Permission model

**Admin, not owner-only** — `ownerMiddleware` reserved for irreversible/lockout ops (role change :163, delete :696);
grants are reversible and must be routine (owner-only puts one person on the critical path). Guards: no self-grant;
owner-only to revoke an owner's access; reject id<=0; deleted users 404 via lookup clause. (Q4 if export-control argues otherwise.)

## 8. Migration

`0067_service_access_revocation.sql` (highest is 0066):
```sql
ALTER TABLE users ADD COLUMN service_access_revoked_at TEXT;
ALTER TABLE users ADD COLUMN service_access_revoked_by INTEGER;
```
Rationale: without it a revoked row is byte-identical to never-granted (queue can't distinguish "awaiting first review"
from "reviewed and declined"). No index (17 users, list already full-scans). No backfill (0062 grandfathered).

## 9. Test plan (no-mock policy, `.rules/testing.md`; harness `backend/test/helpers/d1.ts` freshDb/realD1)

- **`backend/test/service-access-route.test.ts`** (model: `withdraw-route.test.ts:26-80`): 401 no-auth; 403 member;
  404 unknown/soft-deleted; 400 non-numeric/id<=0/self-grant/missing github/missing city-country
  (+200 with override); 400 not-approved; 200 happy path asserting the D1 ROW (not response body); 409 double-grant;
  **grant against NULL-username target succeeds** (the id-keying regression case); revoke 409/200/owner-guard;
  audit row assertions incl. details snapshot; `email_sent: false` without RESEND key (pins best-effort contract).
- **List projection tests:** `?service_access=false&status=approved` filter contract the website queue depends on.
- **Migration test** modeled on `service-access-migration.test.ts:19-40`.
- **Fold in #1018** (route-level upload-gate test) — same harness, two findings that explain why it was never written:
  1. `upload.ts:157` — `const sandbox = isProduction ? !!requestedSandbox : true`, so the create gate at :167 is
     UNREACHABLE outside production; the test must set `ENVIRONMENT: "production"`.
  2. **Asymmetry:** byte-flow gates sit inside `if (!hasRole(user.role,"admin"))` (:522, :626) while the create gate is
     unconditional — an admin without service_access is blocked at create but allowed at upload-urls/credentials.
     Not live-exploitable (0062 grandfathers admins) but the route test should pin one way (Q7).
  Pure tier: 403 with SERVICE_ACCESS_ERROR on all three routes for a service_access=0 approved member;
  upload-urls allow-path is safe pure-tier (SigV4 presign, no network — s3.ts:175-185); upload-credentials (STS) 403-branch only.
  Live tier: `seed-web-user` fixture schema has NO service_access field (:1190-1216) — needs `service_access: z.boolean().optional()` if wanted.

## 10. CLI surface

`grantServiceAccess`/`revokeServiceAccess` in `src/lib/api/admin.ts` (next to approveUser :57-64);
`nemar admin service-access grant|revoke <id>` modeled on approve command (`src/commands/admin.ts:334-381`) with confirm();
widen `UserListItem` (:15-26) + `--service-access` filter on listUsers (:36-41).
**This alone retires the raw-D1 workaround — do it early.**

## 11. Website surface enabled (separate website PR; website#158 Phase 3 deferred half)

- `users-admin-api.ts`: widen `AdminUserListRow` (:68-88), delete stale docblock (:63-67), add `serviceAccess` query
  (:163-167), add grant/revoke functions following id-keyed `deleteUserById` (:298-316). Proxy already forwards
  POST/DELETE (`api/v1/[...path].ts:37,106-110`) — no proxy change.
- Dedicated queue view `/admin/users/service-access`: approved-without-access rows showing the four ADR 0010 review
  inputs (GitHub, city, country, affiliation) + sandbox status; Grant behind ConfirmDialog; rows missing required
  fields render Grant disabled with fields named (never walk the admin into a 400).
- Detail page: make the read-only line (:143) actionable; add granted-by/at once §4.4 join lands.
- Overview tile: `users.awaiting_service_access` fits `adminMetricHref` pattern (`admin-tabs.ts:63-69`).
- **Interaction with website#236:** endpoints don't change the 10 grandfathered users, but §4.1 step 5 guarantees no
  NEWLY granted user can land in the #236 state — converts #236 into a one-time cleanup of ten known people.

## 12. Sequencing

1. Migration 0067 + migration test.
2. Backend: widen list, two endpoints, inventory pin, route tests.
3. Email templates (or ship email_sent:false + follow-up).
4. CLI client + `nemar admin service-access` (retires raw-D1 immediately).
5. Fold in #1018 gate test (shares harness).
6. Website queue page + detail controls (separate PR).

## Open product questions

1. Id-keyed vs username-keyed (issue vs epic contradiction; id is the only shape that works for NULL-username signups).
2. Is GitHub a hard precondition for granting? ORCID signups have none and get no notification — same silent-wall
   shape as website#236. Nudge/email first, or is override_profile_checks enough?
3. Email on grant/revoke: yes/no (recommended yes both).
4. Admin vs owner-only (recommended admin; export-control liability may argue for a named individual).
5. Revoke vs in-flight uploads: mid-upload user starts 403ing on next upload-urls call — acceptable, or warn when
   target has recent `last_activity_at`?
6. Grant-history view needs action/resource filters on GET /admin/audit (separate small change).
7. Pin the admin asymmetry between create gate and byte-flow gates one way or the other.
8. "Request upload access" user flow (epic + website#164): queue-on-filter now vs access_requests table later —
   filter first is cheaper and doesn't foreclose the table.
