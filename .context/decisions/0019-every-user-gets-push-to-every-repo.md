# ADR 0019: Every approved user gets push access to every dataset repo

**Status:** superseded by ADR-0002 and ADR-0001
**Date:** 2026-01 (superseded ~2026-02, recorded 2026-07-31)
**Owner:** Seyed Yahya Shirazi

## Context

The original PR workflow had a bootstrapping problem: contributors were to be "added when they create a PR", but you need push access to push a branch before a PR can exist. The design was circular.

## Decision (at the time)

Every approved NEMAR user is added as a `push` collaborator on **every** dataset repository. On user approval, add them to all existing repos; on repo creation, add all existing approved users. Branch protection was expected to prevent direct pushes to `main`, so broad push access was considered safe and in the spirit of open scientific collaboration. GitHub allows up to 25,000 collaborators per repo, so scale was not a constraint.

## Why it was superseded

- It only works if `main` is protected on **every** repo. Under the publish-gated model (ADR 0001) private, unpublished datasets have **no ruleset**, so blanket push access would have meant every approved user could push directly to any unpublished dataset — including ones under embargo.
- It conflicts with per-dataset access as the access model (ADR 0002). Requesting, granting, and auditing access per dataset is meaningless if everyone already has push everywhere.
- Collaborator lists stopped being a useful record of who actually works on a dataset.

Replaced by per-dataset collaboration: `nemar dataset request-access`, `nemar dataset invite`, and owner/admin review, with `affiliation=direct` as the source of truth.

## Consequences of the reversal

- The bootstrapping problem it solved came back and is now handled by an explicit access request rather than by pre-granting.
- `addCollaboratorToAllRepos()` still exists in `backend/src/services/github/collaborators.ts` and **is no longer called from anywhere**. It is dead code kept from this decision; anyone finding it should not assume it reflects current policy.

## Receipts

- `.context/architecture_review.md` item 2, marked RESOLVED at the time
- `backend/src/services/github/collaborators.ts` — the orphaned function
- ADR 0002, ADR 0001
