# ADR 0009: Non-production D1 is a fixture set, not a production mirror

**Status:** accepted
**Date:** 2026-07-20
**Owner:** Seyed Yahya Shirazi

## Context

The staging stack (epic #923) shares two things with production that cannot be env-scoped: the `nemarDatasets` GitHub org name is hardcoded, and the dev worker holds a live `RESEND_API_KEY`. `nemar-db-dev` also carried ~190 real `nm` rows copied from production. A dev-side job selecting datasets or users by a generic predicate could therefore dispatch GitHub work against real repos, or email real people, from what looks like a safe environment.

## Decision

`nemar-db-dev` holds **curated fixtures only** — the seven `xx0999NN` exemplars plus the private E2E dataset `nm099999`. Production `nm`/`ds` rows must not be re-seeded into it. Staging presents a completely separate catalog.

New daily cron jobs are **production-only by default**. Adding one to the non-production set requires confirming it cannot email a real user, dispatch GitHub work against `nemarDatasets`, or mutate a real DOI or production-bucket object.

## Consequences

- Staging exercises the full stack without a dataset-shaped blast radius.
- Staging cannot reproduce production-scale catalog behaviour (~750 rows vs 8), so anything scale-sensitive still needs a production canary.
- **The `users` table was deliberately NOT purged** and still holds ~609 real email addresses. The prod-safety fences remain load-bearing; the catalog purge removed one blast-radius vector, not the reason the fences exist.
- Each new scheduled job carries a written justification for which side of the fence it sits on, which is friction on purpose.

## Alternatives considered

- **Mirror production into dev:** realistic test data, but it is precisely the configuration where a generic predicate reaches real repos and real inboxes. Rejected.
- **Purge the `users` table too:** would remove the email hazard, but auth and permission paths need real user shapes to be worth testing. Rejected in favour of keeping the fences.

## Receipts

- Epic #923; AGENTS.md "DANGER: dev D1 shares production users and the GitHub org"
- `scheduled()` in `backend/src/index.ts` — the fail-safe allowlist
