# ADR 0042: Upload access is requested once, by the person who wants it

**Status:** accepted
**Date:** 2026-09-05
**Owner:** Seyed Yahya Shirazi

> Numbering note: epic #1250 runs its phases in parallel worktrees off one epic
> branch. Phase 1 (#1258) took 0040 and phase 5 (#1260) took 0041; this is phase
> 3, so it is 0042. The ADR index's gapless check goes green when the epic branch
> holds all three, which it does.

## Context

ADR 0040 fixed the account tiers and made admin approval the single writer of
`service_access`. It deliberately left one half unbuilt: an account at the base
tier had nothing to ask WITH. The upload gate's 403 pointed at
`https://nemar.org/support`, `nemar admin users --awaiting-approval` could only
mean "verified and holding no grant" -- every browse-only account in the
catalog, whether or not anyone wanted to upload -- and an admin reviewing
someone had to assemble the export-control facts by hand from the users table.

Two things had to exist before a request could be reviewed at all.

The **username**. 19 live accounts have `username IS NULL`: web/ORCID sign-ups,
where the column has been NULL by design since migration 0026 and nothing has
ever filled it. `nemar admin approve <username>` cannot address them, the admin
listing falls back to printing an email and a numeric id, and the person has no
handle anywhere in the product. Every one of those 19 is ORCID-verified; 16
carry a given and a family name, 3 carry a given name only, and exactly 1 has
verified its email.

The **name**. ADR 0041 made DOIs cite the depositor by `given_name` /
`family_name` and refuse to mint without both. It also recorded the dead end
that left: `PATCH /auth/profile` rejected name edits because ORCID is canonical
(#835), so an account whose ORCID record hides its name could never publish and
had no in-product fix. That ADR explicitly deferred the resolution to this
phase.

## Decision

**Upload access is requested once, by the account that wants it, and the
request is a fact on the users row rather than an inference.**

`POST /users/me/upload-access/request` (bearer token or web session) stamps
`users.upload_access_requested_at` and stores the why text in `users.description`
-- the column CLI signup already fills with the same question. Approval closes
the request by granting `service_access`; nothing re-opens it. So the three
states an admin cares about are readable from two columns:

| `upload_access_requested_at` | `service_access` | meaning |
|---|---|---|
| NULL | 0 | never asked |
| set | 0 | **open request** |
| set | 1 | granted; the stamp records when they asked |

`GET /admin/users?awaiting_approval=1` is exactly the middle row, and
`nemar admin users --awaiting-approval` now means it.

**The request carries the person, or it is refused before an admin sees it.**
A username, a given and a family name, a GitHub handle that resolves on GitHub,
a city, a country, and 20-500 characters about what is being deposited. Each
refusal is `{ error, message, missing: [...] }` from a closed vocabulary, so
the website highlights fields (nemarOrg/website#301) and the CLI prints each
one with where to fix it. **Idempotent while open** (200, `already_requested`,
no second email), **409 once granted**.

**The default username is first initial plus family name**, ASCII-folded and
lowercased, `-2`/`-3` on collision: `Ada Lovelace` -> `alovelace`.
`GET /auth/profile/username-suggestion` offers it and reserves nothing;
`PATCH /auth/profile` accepts one, unique case-insensitively, settable while
NULL and changeable until an admin approves the account. It is derived from the
same name pair ADR 0041 made canonical, so an account has ONE identity rather
than a handle invented at a form and a name read from ORCID.

**Nothing is ever derived from the email address.** A row with one name part is
reported as `single_name` and left alone, by the endpoint and by the
`backfill-usernames` sweep alike.

**Names stay ORCID-canonical when, and only when, a verified ORCID is linked.**
`PATCH /auth/profile` accepts `given_name`/`family_name` for an account with no
verified iD and answers 409 `name_is_orcid_canonical` for the rest. That is the
narrowest rule that keeps #835's guarantee (ORCID is re-read on every sign-in,
so an edit would be silently overwritten) while closing ADR 0041's dead end
(nothing overwrites a name for an account ORCID does not speak for).

## Consequences

- The 403 finally names a path that exists. Its `message` has now been wrong
  twice -- a settings page that never existed (#1249), then phase 1's "coming
  soon" -- and `backend/test/upload-gate-message-route.test.ts` asserts both
  dead pointers negatively so a reinstatement has to argue with a test.
- **`nemar admin users --awaiting-approval` changes meaning**, from "verified
  with no grant" to "asked and not yet granted". On the day this deploys it
  returns NOTHING, because no request predates the column. That is correct and
  it will look like a bug; the un-narrowed population is still one flag away as
  `--no-upload-access`.
- An admin's review is one email with every export-control field on it, instead
  of a prompt to go and look the person up.
- **The username is locked at approval**, not at creation. Re-submitting the
  current username is a no-op rather than a 409, because the Settings form
  sends every field on every save and an approved account must still be able to
  save its city.
- **A case-variant race can still land two usernames one shift key apart.**
  `users.username` is UNIQUE case-SENSITIVELY (migration 0001) while every check
  around it is `COLLATE NOCASE`, so `Ada` and `ada` arriving together pass both
  the pre-check and the constraint. Phase 4's case-insensitive unique index
  closes it; until then the window is two concurrent PATCHes on one name.
- **The backfill mails, so it is dry-run by default and never automatic.** For
  each row it finishes it issues ONE verify-your-email message, through phase
  2's `issueEmailVerificationCode` so the non-production fence applies. Exactly
  one per account, ever, guaranteed by the candidate predicate rather than by a
  flag: an assigned row no longer has a NULL username, so it is never scanned
  again. There is no cron, deliberately -- the same reasoning ADR 0041 gives for
  `backfill-names`.
- **The 3 single-name accounts stay unfinished** and need a human. That is the
  cost of not guessing, and it is 3 rows.
- `users.description` now means two things over an account's life: why they
  wanted an account (CLI signup) and, after a request, what they intend to
  upload. The second overwrites the first. Both answer the same question, the
  newer one is the one an admin is reviewing, and a second column would leave
  the admin email choosing between them.

## Alternatives considered

- **An `upload_access_requests` table.** Rejected under ADR 0036 and 0034's
  reasoning: request-once means there is never more than one row per user and
  no state beyond "when", so a table is a join to learn a timestamp. If
  requests ever become repeatable (a re-request after revocation), this is the
  decision to revisit first.
- **Auto-approve the request when every precondition passes.** It is the whole
  point that a human reads it: the grant is an export-control judgement about a
  person, not a form-completeness check (website ADR 0010, ADR 0040).
- **Derive a username from the email local part when the name is unusable.**
  Rejected. It produces a handle nobody chose, it is permanent once an account
  is approved, and it is wrong exactly where names are hardest -- mononyms and
  non-Latin scripts. Three rows are worth a human.
- **Let anyone edit their name, and re-apply ORCID only on relink.** Rejected:
  it silently breaks #835's guarantee for every ORCID account at the next
  sign-in, which is a worse failure than a 409 that says why.
- **Reserve a suggested username for a few minutes.** Rejected: a table of
  expiring reservations to serve a form most people submit in seconds. The
  PATCH's uniqueness check is where a collision is decided.
- **Keep `--awaiting-approval` meaning "no grant".** Rejected: it is the flag an
  admin uses to find work, and answering it with every browse-only account is
  what made it useless. `--no-upload-access` still spells the old meaning.

## Receipts

- Issue #1253, epic #1250 (phase 3). Consumed by nemarOrg/website#301.
- Migration `0076_upload_access_request.sql`.
- Services `upload-access.ts` (preconditions), `username.ts` (format, default,
  collisions), `profile.ts` (the patch vocabulary).
- Routes `routes/users.ts` (the request), `routes/auth-web.ts` (username, name,
  suggestion), `routes/admin/users.ts` (`awaiting_approval`),
  `routes/admin/user-usernames.ts` (the backfill).
- ADR 0040 (approval is the single writer; this is its missing half),
  ADR 0041 (names are citable, and its "Phase 3 adds name entry" note),
  ADR 0036 (counts and pointers, not per-event lists).
