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
- 18 web users must verify an email address they have never been asked to verify.
  That is the cost of making `verified` mean what it says, and it is paid once.
- Until phase 3 ships the request endpoint, there is no self-service path:
  the 403 tells people to reach an admin through the support page.
  `nemar admin users --awaiting-approval` is correspondingly approximate —
  "verified with no grant", not "asked for one" — until there is a request to read.
- ORCID finalize still auto-approves new web sign-ups (phase 2 changes it),
  so the invariant is established by 0075 and then re-broken by every new web sign-up
  until that lands. The approve routes repair such a row instead of 409ing it.

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
