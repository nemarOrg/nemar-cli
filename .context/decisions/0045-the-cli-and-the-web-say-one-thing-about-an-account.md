# ADR 0045: The CLI and the web say one thing about an account

**Status:** accepted
**Date:** 2026-09-05
**Owner:** Seyed Yahya Shirazi

> Numbering note: epic #1250 runs its phases in parallel worktrees off one epic
> branch, so the numbers were claimed out of order — phase 1 took 0040, phase 5
> took 0041, phase 3 took 0042, phase 4 took 0043 and phase 7 took 0044. This is
> phase 8, the last of them, and it is 0045. The index's gapless check goes green
> once the epic branch holds all six, which it does.

## Context

Epic #1250 rebuilt the account model across two surfaces at once. ADR 0040 fixed
the tiers, 0042 built the upload-access request, 0043 made an identity back one
account, 0044 brought identity self-service to the CLI, and
`nemarOrg/website#301`/`#310` built the browser half. By the end of phase 7 the
same account could be described three different ways in one afternoon:

- `POST /users/me/upload-access/request` refused with
  `missing: ["github_username", "city"]`, assembled by six hand-written `blank()`
  checks in `services/upload-access.ts`;
- `nemar auth status` said nothing about either field, and
  `nemar auth request-upload-access` rendered them through `UPLOAD_ACCESS_FIX`,
  a private table in `src/commands/auth.ts` that named commands with argument
  placeholders (`nemar auth profile set-username <name>`);
- the dashboard derived its own list client-side, from the account fields
  `/auth/me` happened to carry, and rendered it through the website's own
  sentences.

Three implementations of one rule, in two repositories, none of which failed
when another changed. The concrete drift was already visible in the wording: the
website said "Set it in Settings or run `nemar auth profile set-github`" and the
CLI said "run 'nemar auth profile set-github <handle>'", for the same gap on the
same account.

There is a second, smaller version of the same problem. ADR 0042 built an admin
sweep to give the username-less web/ORCID rows a handle. It has not been run:
production still holds 18 of them (the 19 that ADR counted, minus a duplicate
account deleted since), and the first run is scheduled for after this epic
deploys. Even once it has, the sweep closes the accounts that exist and nothing
after them — a web sign-up whose owner abandons onboarding lands straight back
in `username IS NULL` and stays there until an operator remembers to run it
again. It also never revisits: its candidate predicate is
`username IS NULL OR TRIM(username) = ''`, so a row it has named is a row it
cannot see.

## Decision

**One matrix, one copy table, one gap function — declared here, transcribed
there.**

1. `shared/contract/account-copy.ts` holds every user-facing sentence about
   tiers, upload access and missing fields, as literal strings under dotted
   keys. `nemarOrg/website/src/lib/account-copy.ts` is a transcription of it.
   Each repo has a drift test that reads the other's file **as text** and fails
   on any shared key whose string differs
   (`test/account-copy-parity.test.ts` here, `test/account-copy-drift.test.ts`
   there); both skip with a note when the other checkout is absent, because CI
   clones one repo.
2. `shared/contract/profile-gaps.ts` holds the matrix as data — for each field,
   what it blocks, where it is set on each surface, and whether it is derivable
   from an account row — plus the pure `computeProfileGaps(account)`.
3. **That function is the only implementation.** `GET /users/me` and
   `GET /auth/me` both report its output as `profile_gaps`, and
   `checkUploadAccessRequest` builds its `missing` array from it. The three
   answers cannot disagree because there is one answer;
   `backend/test/profile-gaps-route.test.ts` asks all three about one row and
   compares.
4. **A username is assigned lazily as well as in batches.** At a web sign-in
   (`/auth/code/verify`, the ORCID callback sign-in, and `/auth/orcid/finalize`)
   an account with `username IS NULL` and a usable name gets the ADR 0042
   suggestion, collision-suffixed. Migration 0079 adds
   `users.username_auto_assigned`, set by both paths and cleared when the person
   changes the username.
5. **Sandbox training stays CLI-only** and is deliberately outside the shared
   matrix.

## Consequences

**A sentence now changes in one place.** Editing copy means editing this
contract and transcribing it; the drift tests make forgetting the second half
loud on a maintainer's machine, and the mirroring is asymmetric on purpose —
`cli.`-prefixed keys are the CLI's own and the website reports them as a note.

**A rule now changes in one place too, and that is the sharper claim.** Adding
a precondition to the upload-access request means adding a row to
`PROFILE_GAP_MATRIX`, and every surface picks it up: the refusal, the CLI's
Profile block, the upload preflight, the dashboard nudge. Nothing has to be
remembered.

**The wire grew two fields and lost none.** `profile_gaps` is `.optional()` on
the CLI's `userSchema` (an older backend omits it, and absent must not read as
"nothing missing") and REQUIRED on `webUserSchema`, which only ever describes
what this backend sends.

**`set_on` on the wire names surfaces, not prose.** `["web", "cli"]`, or
`["web"]` for a name owned by a verified ORCID record. "Settings" is a website
noun and `nemar auth profile set-github` a CLI one; neither is something the
backend should spell for two clients that already know their own vocabulary and
read it out of the copy table.

**The CLI still caches.** `nemar auth status` prints the gaps from the config
cache so it works offline, with the same three-state honesty the upload-access
line already has: cached, "not checked" when nobody has refreshed, and "not
checked" again when a refresh was asked for and failed. Only `nemar auth
profile` and the upload preflight always fetch.

**The upload preflight is a hard stop with one deliberate exception.** A missing
grant ends the run before validation, because the run cannot succeed; `--dry-run`
continues, because it uploads nothing and the plan is what was asked for. A
preflight that cannot READ the grant — offline, a 5xx, an older backend — warns
and continues, because the server enforces the gate regardless and refusing an
upload over a briefly unavailable status endpoint invents a refusal nobody made.

**The username finally gets the index ADR 0042 promised it.** That ADR's
Consequences say a case-variant race "can still land two usernames one shift key
apart" and that "phase 4's case-insensitive unique index closes it"; phase 4
(migration 0077) built that index for `orcid` and `email` and not for
`username`, so the sentence has been describing a file that did not exist.
Migration 0080 is it — the same partial predicate as 0077's two, and clean to
create because the username catalogue holds no case-variant duplicates.

**Two write paths now name accounts, and both mark what they did.** The sweep is
the batch path and sign-in is the lazy path; between them an account cannot keep
browsing NEMAR without a handle. The mark is a column and not just an audit row
because the copy that offers "we chose this from your name, change it if you
like" renders on every page load and cannot scan an audit log.

**The lazy assignment is a nudge, not a guarantee.** No name, a name that folds
to nothing in ASCII, or a saturated base leaves the column NULL and onboarding
asks — nothing is ever invented from the email local part (ADR 0042). At
`/auth/code/verify` the claim rides inside the sign-in's own transaction; on the
two ORCID paths it is chained behind the public-record name refresh, which
already runs after the response, so it lands a moment later.

**What is NOT shared, and should not become shared.** Sandbox training (no web
surface); anchors and hrefs (website routing); the refusal `message` strings,
which the backend builds and both clients prefer verbatim when present. Adding a
sandbox row to the shared matrix would make the table a claim about both
surfaces that is false on one of them.

## Alternatives considered

- **Publish `@nemar/contract` to npm and have the website import it.** The
  correct end state, and out of scope for a phase that had to ship alongside a
  website release. The contract directory is already written to lift verbatim
  (zero deps beyond zod); the drift tests are the interim, and they cost a
  transcription rather than a release cycle.
- **Let each surface derive its own gaps from the account fields.** What the
  website did while waiting for this, and what the CLI would have had to do.
  Two derivations that agree today and are not tested against each other are one
  bug fix away from disagreeing, and the disagreement is invisible from either
  side.
- **Have the backend send rendered sentences.** It would guarantee identical
  wording and destroy everything else: a terminal wants a backtick-quoted
  command, a browser wants an anchor to `/settings#profile-city`, and the
  backend would be spelling both. Sending `field` plus `blocks` and rendering
  locally keeps the rule central and the presentation where it belongs.
- **Assign usernames only in the sweep (ADR 0042 as shipped).** It converges on
  the rows that exist and diverges on the ones arriving. The sweep stays; it is
  now the batch half of a pair.
- **Assign at sign-up rather than at sign-in.** ORCID sign-up has no name yet:
  `POST /auth/orcid/finalize` inserts the row and the given/family names arrive
  afterwards from the public record. Assigning at the INSERT would skip exactly
  the accounts this exists for, which is why the assignment is chained behind
  the name refresh on both ORCID paths.
- **Make the upload preflight a warning only.** Kinder in the moment and wrong:
  the upload will 403 at the server, after validation and after a repository has
  been asked for. The one case where warning is right is the one where we do not
  know the answer, and that is the case that warns.

## Receipts

- Issue #1268 (this phase), epic #1250, and the website's companion
  `nemarOrg/website#309` / `#310`.
- ADR 0040 (tiers, and `service_access` as the single grant), ADR 0041 (the name
  a DOI cites), ADR 0042 (the request, the username default, the sweep),
  ADR 0043 (one person, one account), ADR 0044 (identity self-service on the
  CLI).
- `shared/contract/account-copy.ts`, `shared/contract/profile-gaps.ts`,
  `backend/src/services/profile-gaps.ts`,
  `backend/src/services/username-assignment.ts`, migrations
  `0079_username_auto_assigned.sql` and
  `0080_username_case_insensitive_unique.sql`.
- `test/profile-gaps-matrix.test.ts` (the matrix against a fixture copied from
  the website's table, and all 2^7 field combinations),
  `test/account-copy-parity.test.ts`, `backend/test/profile-gaps-route.test.ts`,
  `backend/test/username-auto-assign-route.test.ts`,
  `test/auth-gaps-cli.test.ts`.
