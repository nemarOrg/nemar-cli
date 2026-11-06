# Environments, Shared Orgs and Names That Look Like Bugs

The detail behind the "Dev D1 shares production users and the GitHub org" and "Two names that look like bugs" hard rules in `AGENTS.md`.
The decisions are ADR 0009 (non-production D1 is not a production mirror), ADR 0048 (account kinds), ADR 0110 and ADR 0112 (mail), and ADR 0007 (EZID).
Where this file and an ADR disagree, the ADR wins.

## [STRICT] Dev D1 shares production users and the GitHub org

`nemar-db-dev` no longer mirrors production's dataset catalog.
It was purged to the curated fixtures only (the seven `xx0999NN` exemplars, the private E2E dataset `nm099999`, and the dev-owned `nm`-band fixtures listed in `.rules/datasets-and-fixtures.md`) and must stay that way.
**Do not re-seed production `nm`/`ds` rows into dev D1.**

But the `users` table was **not** purged: it still holds roughly 609 real email addresses, and the dev worker holds a live `RESEND_API_KEY`.
The `nemarDatasets` GitHub org is also **shared** between prod and dev, since the org name is hardcoded rather than environment-scoped.
So a dev-side job that selects users by a generic predicate can still email real people, and a cascade delete can still destroy a real repo.
The catalog purge removed one blast-radius vector; it did not remove the reason these fences exist.

### Mail fences

- Admin-facing notification mail (new-user approval, upload-access and publication requests, import recovery, cron digests) is production-only by default, via `getAdminEmailsForCategory`'s fence in `backend/src/services/email.ts`.
  Set `DEV_ADMIN_NOTIFICATIONS=1` only for a deliberate staging test of admin mail.
- The dev worker's `DEV_EMAIL_ALLOWLIST` is a Worker secret holding exact human addresses, never a domain.
  `@nemar.org` has a catch-all that turns every message into a production support ticket (epic #1893, ADR 0112), and `@nemar.test` fixtures get their sign-in codes echoed in the response instead of delivered.
- Support-ticket notifications are production-only with no first-admin fallback (ADR 0112).

### Seeded accounts

`users.account_kind` (ADR 0048) is explicit on the seeded fixtures:

- `test-owner` and `test-admin` are `service`: operational, no human signs in to them directly.
- `test-user`, `test-pending`, `test-verified` and `test-revoked` are `test`: a persona, not a real identity.
- `test-web` stays `person`: it is the shared web-QA account and has to reach the ORCID authorize page and the Settings key form the way a real person would.

### Cron jobs

**A new daily cron job is production-only BY DEFAULT.**
The dev cron is governed by a fail-safe allowlist in `scheduled()` (`backend/src/index.ts`).
Before adding a job to the non-prod set, confirm it cannot email a real user, dispatch GitHub work against `nemarDatasets`, or mutate a real DOI or prod-bucket object.

### Authenticating against staging

Never use production keys.
Use `TEST_ADMIN_API_KEY` from `test/.env.test`: it matches the `test-admin` token seeded by `scripts/seed-dev-db.sql`.
Set an isolated `NEMAR_CONFIG_DIR` so the real `~/.config/nemar` is untouched.
`TEST_OWNER_API_KEY`, the seeded `test-owner` token, is its owner-role sibling.

### Wrangler

Wrangler runs through cfman, which holds the SCCN account token: `bunx cfman wrangler --account sccn <arguments>`.
There is no plain `wrangler login` on these machines, so a command reporting "Not logged in" was run without cfman (`.memory/wrangler-via-cfman.md`).

## Two names that look like bugs and are not

**`ORG_NAME = "nemarDatasets"`** in `backend/src/services/github.ts`, and the publishing scripts targeting `nemarDatasets`, are correct.
Two GitHub orgs is deliberate: `nemarOrg` holds tooling and infrastructure, `nemarDatasets` holds dataset repositories only.
**Do not change these to `nemarOrg`.**
In a two-org codebase this reads as a typo, which is exactly why the warning is written down rather than left to the reader.

**EZID is the DOI registrar, not Zenodo** (ADR 0007).
`.context/research.md` describes a Zenodo flow and `docs.nemar.org/develop/zenodo-testing/` documents Zenodo sandbox testing; both are prior art and test tooling, neither is the production path.
A DOI change made on the strength of either is wrong.
