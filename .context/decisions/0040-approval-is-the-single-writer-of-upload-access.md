# ADR 0040: Admin approval is the single writer of upload access

**Status:** accepted
**Date:** 2026-09-05
**Owner:** Seyed Yahya Shirazi

## Context

Website ADR 0010 split viewing from uploading by adding `users.service_access`,
and shipped the gate (v0.9.5, #1013 phase 1) without the grant.
Its phase 2 was never built, so for a year the only thing that ever set the flag was
migration 0062's one-time grandfather pass.
Two consequences accumulated.
`nemar admin approve` moved a user to `status='approved'` and did not unlock upload,
which is #1249: an admin approved someone who then could not upload and nothing said why.
And ORCID web sign-ups auto-approved themselves to `status='approved'` on finalize,
so 19 of 38 accounts reached the same status with no admin, no audit row, and no username.
`approved` therefore meant two unrelated things depending on how the account was created,
and the admin listing could not tell an uploader from a browse-only account at all.

## Decision

Four names, fixed meanings, and one writer.

- **`pending`** — the account exists and its email is not verified. CLI and web alike.
- **`verified`** — the email is verified. This is the base tier and needs no admin:
  browse, dashboard, settings, CLI API key, sandbox training, and requesting upload access.
  (The CLI key and sandbox paths landed in Phase 2; the request endpoint is Phase 3.
  See Phasing below.)
- **`approved`** — an admin approved the one-time upload request.
- **`revoked`** — unchanged.

**Approval is the single writer of `service_access = 1`, and revoke is its only eraser.**
The invariant is `status = 'approved'` if and only if `service_access = 1`;
migration 0075 establishes it over the existing catalog and the approve/revoke routes maintain it.

Admins act once per uploader, at the upload request, never at account creation.
Sandbox training stays CLI-only; a browser upload is gated on approval alone.

**ORCID does not substitute for email verification.**
ORCID proves the person, the email code proves the inbox, and the base tier needs both:
notifications, the sign-in code, and the upload-request thread all go to that address.
So migration 0075 lands an auto-approved web row at `verified` only when `email_verified = 1`,
and at `pending` otherwise.
That is not a formality in this catalog:
every one of the 19 affected rows is ORCID-verified and exactly one is email-verified,
so 18 real accounts drop to `pending` with an inbox left to confirm.

**Approval cannot skip the inbox check either** (decided in phase 2's review).
#1012 let an admin approve a `pending` ORCID-verified web row on the reasoning that
ORCID was that row's identity proof and its collected email was unverified by design.
That reasoning survives for identity and dies here for delivery:
approval sits *above* the base tier, so it cannot be the step that skips the tier's
other half.
`isApprovable` therefore refuses any row with `email_verified = 0`, whatever the
signup source, and says so in the 400 —
which also means `pending` is no longer approvable at all,
since both roads out of `pending` set the flag.

## Phasing

The decision above is whole; the code arrives in two phases of epic #1250,
which merges to `dev` only as a complete epic branch.
Read the split before assuming a behaviour described here is live.

- **Phase 1 (#1251, this change):** the status vocabulary and its meanings;
  migration 0075; approval as the single writer of `service_access`
  (both approve routes, revoke as the eraser, both audited);
  the upload gate's message; admin visibility of the tier in `GET /admin/users`
  and `nemar admin users`; `Upload access` in `nemar auth status`.
- **Phase 2 (#1252, landed):** everything that makes `verified` *usable* as the base tier —
  `authMiddleware` (both credential paths), `optionalAuthMiddleware`, `POST /auth/login`,
  `POST /auth/retrieve-key`, the key-regeneration pair and the sandbox routes
  accepting `verified` where they required `status='approved'`;
  the `pending` → `verified` transition for web accounts
  (`POST /auth/email/verify{,/request}`, and the email-code login writing the status,
  not just `email_verified`); `userStatusForDashboard` mapping `verified` to active
  and `/auth/me` exposing `email_verified`; the key-ready email moving to email
  verification and a new upload-access-granted email taking its place at approval;
  the create gate taking the channel (sandbox training is CLI-only);
  and ORCID finalize landing at `pending` and mailing a verification code.

So while Phase 1 stands alone, migration 0075 must not be *applied* alone —
its rule (b) moves web accounts into a tier nothing has been taught to honour yet.

## Consequences

- An admin's one action now means what it says, and the audit row records the grant
  (`service_access_granted`) rather than leaving it to be inferred from a status.
- The upload gate's 403 can finally name a real path.
  It used to point at "request upload access from your account settings",
  a settings feature that has never existed.
- **Migration 0075 must not be applied before epic #1250 phase 2.**
  It moves every auto-approved web row out of `approved`,
  and until the middleware and `userStatusForDashboard` learn that `verified` is active,
  those users see a dashboard that reports them as pending with nothing to act on.
  Phase 2 has landed on the epic branch, so the two ship together as intended;
  the constraint is on applying 0075 to a deployment that predates it.
- 18 web users must verify an email address they have never been asked to verify,
  once Phase 2 ships the verify step that lets them.
  That is the cost of making `verified` mean what it says, and it is paid once.
- An admin can no longer unblock a web sign-up that has not confirmed its email;
  the user has to redeem a code first (they can ask for one from the dashboard).
  That is the cost of the rule above and it falls on the 18 rows 0075 moved,
  who have to confirm an inbox once either way.
- Until phase 3 ships the request endpoint, there is no self-service path:
  the 403 tells people to reach an admin through the support page.
  `nemar admin users --awaiting-approval` is correspondingly approximate —
  "verified with no grant", not "asked for one" — until there is a request to read.
- ORCID finalize auto-approved new web sign-ups between phase 1 and phase 2,
  so the invariant was established by 0075 and then re-broken by every new web sign-up
  until phase 2 landed. The approve routes repair such a row instead of 409ing it,
  which is also what recovers any row created in that window.
- One legacy shape sits outside the invariant and is deliberately left alone:
  0062 grandfathered `role IN ('owner','admin')` regardless of status,
  so an owner or admin at `verified` could hold the grant without being `approved`.
  It should be an empty set, and both mechanical repairs are wrong
  (promoting approves someone no admin approved; clearing locks a working admin out),
  so such a row is resolved by an explicit approve or revoke. See 0075's header.
- Upload access is now reported as three states, not two, everywhere it is displayed:
  granted, not granted, and unknown.
  A CLI talking to a backend that predates this change gets `undefined`, not `false`,
  and saying "not granted" to someone who holds the grant is the one wrong answer here
  — it sends them to an admin to ask for something they already have.

## Alternatives considered

- **Keep `approved` as the base tier and add a third status for uploaders.**
  Rejected: `approved` is the status every existing query, email, and admin habit is built on,
  and the thing it should gate is the expensive one. Renaming the cheap tier is the smaller lie.
- **Let `nemar admin approve` keep granting nothing, and add a separate `grant-upload` command.**
  Rejected: it preserves exactly the two-step an admin already forgot to take (#1249),
  and doubles the surface where the two halves can drift apart again.
- **Treat `orcid_verified` as satisfying the base tier's email requirement.**
  It would have kept 18 people from being interrupted.
  Rejected because the address those accounts hold is unconfirmed,
  and the base tier's whole content is things that are delivered to it.
- **Filter the admin listing's tiers server-side with a new query param.**
  Rejected: the listing is unpaginated, so a client-side filter over the same rows
  costs nothing and adds no API surface to keep in step.

## Receipts

- Supersedes the "auto-approve ORCID sign-ups to `status='approved'`" half of
  [website ADR 0010](https://github.com/nemarOrg/website/blob/main/.context/decisions/0010-tiered-access-base-service.md).
  The two-tier idea and the export-control review behind the upload grant survive intact;
  only the claim that a sign-in step can write the upper tier's status does not.
- Epic #1250 (account tiers), phase #1251 (this change), bug #1249 (approval granted nothing).
- Migration `backend/src/db/migrations/0075_approval_grants_upload_access.sql`,
  gate `backend/src/services/upload-gate.ts`,
  routes `backend/src/routes/admin/users.ts`.
