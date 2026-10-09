# ADR 0095: Password sign-in is retired and its stored hashes are cleared

**Status:** accepted
**Date:** 2026-10-09
**Owner:** Seyed Yahya Shirazi

## Context

NEMAR once registered CLI accounts with a username, an email address and a
password, and handed out the first API key against that password. ADR 0047
(epic #1272) replaced both with browser sign-in: ORCID creates the account and
the device authorization grant mints a key named for the machine. It kept two
password-era commands "for this release", each printing a sentence saying
password sign-in would be removed in the next one.

The maintainer has now confirmed that no password is used any more (2026-10-09).
API keys are very much in use, so this decision is about what takes a password
and nothing else.

What was left, checked on 2026-10-09:

- `POST /auth/signup` registered an account with a password, a typed ORCID iD and
  a GitHub handle. The CLI stopped calling it in epic #1272 phase 3; the client
  function was still exported but had no caller.
- `POST /auth/retrieve-key` checked a password with bcrypt and, for an account
  that had no key yet, minted one.
- `backend/src/services/password.ts` (bcrypt, cost 10, and a strength rule) and
  the `bcryptjs` dependency in both packages, used by those two routes and by one
  script.
- `users.password_hash`: written only by signup, read only by retrieve-key, and
  the first column ADR 0094 had to stop admins reading out of `users`.
- Mail and pages that told a person to run `nemar auth retrieve-key`.

`nemarOrg/website` and `nemarOrg/nemar-py` were searched for both routes and for
the CLI command; neither calls them. The private `nemarOrg/docs` repository was
not readable from the session that made this change, so any page there that still
names `retrieve-key` is a follow-up (see Consequences).

## Decision

**Remove every route, command and helper that needed a password.**

- `POST /auth/signup` and `POST /auth/retrieve-key` are deleted. They are not
  mounted, so a request gets a 404, and a test dispatches both through the real
  app to pin that.
- `nemar auth retrieve-key` is deleted. `nemar auth regenerate-key` stays (it
  uses an emailed link, not a password) and loses its deprecation sentence.
- `services/password.ts`, the `signup` and `retrieveKey` client functions and
  `bcryptjs` are deleted.
- Every message that named `retrieve-key` now names `nemar auth login`, which is
  where a key comes from: the verification mail, the "already verified" and
  success pages, and the admin approve command's hints.

**Clear the stored hashes (migration 0093) and keep the column.** The migration
sets every non-NULL `password_hash` to NULL. A hash of a password nobody can use
is credential material with no purpose, and clearing it ends the exposure that
ADR 0094 only stopped admins reading. It cannot be undone, and that is the point.
The column stays, nullable, and stays classified `secret` in `USER_COLUMN_ROLES`:
dropping it means rebuilding `users` and every table that references it (migration
0026 shows the cost), for no extra safety once every value is NULL. The tombstone
still sets it to NULL, harmlessly. The dev seed no longer inserts a hash.

**What does not change.** API keys, their hashing, revocation and the cascade that
ends everything minted from a key. `POST /auth/login` (it validates an API key,
despite the name), email verification and resend, the emailed key regeneration
pair, the device flow, the passwordless web code flow, and the `check-username`,
`check-github` and `orcid-name` helper routes.

## Consequences

- A person with no key signs in with `nemar auth login`. A legacy `verified`
  account that never fetched a key, which `retrieve-key` used to serve, gets one
  the same way. A key minted before the device flow keeps working; the CLI still
  labels it a password-era key because it has no `keySource`.
- A person who lost a key and has no signed-in machine uses `nemar auth
  regenerate-key` (an emailed link). It revokes the key on every machine, as it
  always did.
- The `key_retrieved` audit action is no longer written. Historical rows stay.
- Rolling this back is not possible for the data: the hashes are gone. Restoring
  password sign-in would be a new decision with a new way to set a password.
- Migration 0093 and the code deploy are not atomic. In the gap, a request to the
  still-running old worker for `retrieve-key` fails, because there is no hash to
  compare. That is the same outcome as the 404 that follows, and nobody uses it.
- Follow-ups, not decided here. Pages on `docs.nemar.org` that name `retrieve-key`
  need the same edit (the repository is private; an admin can read it with
  `nemar admin docs`). The client functions `checkUsername`, `checkGitHubUsername`
  and `checkOrcidName` have no caller in the CLI (the signup form that used them
  went in phase 3) and are pinned only by the export-surface test; their routes
  may be dead too. `users.verification_token` is still stored in plaintext. None of
  these needs a password and none is changed by this decision.

## Alternatives considered

- **Keep the commands until the next release, as ADR 0047 planned.** That plan
  assumed some accounts still signed in with a password. The maintainer says none
  do, and a command that prompts for a password nobody has only produces a
  confusing failure.
- **Drop `users.password_hash`.** A table rebuild across every referencing table,
  with the failure modes migration 0026 documents, to remove a column that holds
  only NULL. It can be done later if it ever matters.
- **Leave the stored hashes in place.** They would be readable by anyone who ever
  regains a whole-row read of `users`, and they protect nothing.
- **Retire the emailed key regeneration and email verification too.** They are the
  recovery path for API keys, which are in use, and neither takes a password.

## Receipts

- `backend/src/routes/auth.ts`, `backend/src/db/migrations/0093_clear_password_hashes.sql`,
  `src/commands/auth.ts`, `src/lib/api/auth.ts`.
- `backend/test/password-hashes-cleared-migration.test.ts`,
  `backend/test/verified-tier-routes.test.ts` ("the password routes are gone"),
  `backend/test/tier-emails.test.ts`, `test/auth-device-cli.test.ts`.
- ADR 0047 (amended in place). ADR 0040's phase 2 record still lists `POST
  /auth/retrieve-key` among the routes that accepted `verified`; that is history
  and is left as written. ADR 0094.
