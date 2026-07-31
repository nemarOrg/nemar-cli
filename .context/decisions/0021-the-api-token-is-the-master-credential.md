# ADR 0021: The NEMAR API token is the master credential; revocation cascades

**Status:** accepted
**Date:** 2026-02 (backfilled 2026-07-31)
**Owner:** Seyed Yahya Shirazi

## Context

An approved user ends up holding three separate credentials: a NEMAR API token, a GitHub PAT for `nemarDatasets` access, and S3 credentials scoped to their datasets. Three independently-issued secrets means three independent revocation paths, and revoking the obvious one while the others keep working is how offboarding silently fails.

## Decision

The **API token is the master credential**. The GitHub PAT and S3 credentials are issued as linked children of it at approval time, and **revoking the API token invalidates every linked credential**. There is one revocation action, not three.

## Consequences

- Offboarding and compromise response are a single operation with no "did we get all of them?" question.
- The linkage must be maintained by every path that issues or regenerates a credential. A credential created outside this hierarchy is invisible to revocation — that is the failure mode to guard.
- Losing the API token means losing access to all three, so regeneration has to reissue the whole set rather than just the top-level token.
- The token is a genuine single point of failure. Accepted deliberately: one credential that definitely revokes beats three that individually might not.

## Alternatives considered

- **Independent credentials with a documented offboarding checklist:** simpler to issue, and depends on a human remembering three steps under time pressure. Rejected — this is exactly where checklists fail.
- **Short-lived credentials with refresh:** better blast radius on leak, but requires a refresh path in the CLI and in every CI workflow that uses S3, for a population where revocation is rare and offboarding is the real risk. Rejected as disproportionate for now.

## Receipts

- `.context/plan.md` — "Token Hierarchy"
- `backend/src/services/token.ts`; `nemar admin revoke`
