# ADR 0001: Published datasets are PR-only; private datasets stay open

**Status:** accepted
**Date:** 2026-01-14, revised 2026-02 (owner self-merge) and 2026-06 (#713, publish-gated)
**Owner:** Seyed Yahya Shirazi

## Context

OpenNeuro, the closest comparable archive, allows direct pushes. NEMAR datasets are citable, DOI-bearing artifacts, so an unreviewed push can silently change what a published DOI resolves to. But the same protection applied to a dataset still being prepared is pure friction: the depositor is usually the only person working on it, and there is nothing published to protect yet.

## Decision

Governance is **gated on publish state**, not applied uniformly:

- **Private (unpublished):** no branch ruleset at all. The depositor iterates freely.
- **Public (published):** `main` is locked by a branch ruleset — PRs required, required status checks (BIDS validation, version check) pinned per check by `integration_id`, plus `non_fast_forward` and `deletion` rules.

On the public side, **the owner may merge their own PR**: `required_approving_review_count: 0`. The gate is the automated checks, not a second human. `dismiss_stale_reviews_on_push: true`. The NEMAR App and org admins are explicit `bypass_actors` for automation and break-glass.

## Consequences

- Every change to a published dataset carries a PR, a validation run, and a revert path — without requiring a second person who often does not exist for a single-maintainer dataset.
- Quality rests on the status checks. If BIDS validation is weak or a check is not pinned, nothing else catches a bad merge.
- Admins can bypass. That is deliberate (recovery must be possible) and means the ruleset is not a security boundary against a compromised admin token.
- Protection is applied at **publish**, not at repo creation, so the lifecycle hook that flips visibility must also flip governance. Drift between the two is possible and is what `nemar admin fleet drift` exists to catch.
- `strict` is off by default: a detached cross-repo App check-run is never re-triggered by GitHub's up-to-date logic, so `strict: true` would deadlock the merge.

## Alternatives considered

- **Uniform PR-only with `enforce_admins: true` and one required approval.** This was the *original* 2026-01-14 design, validated as workable. Abandoned because self-approval is not allowed under it, so a solo depositor could not merge their own work at all, and admins could not recover a broken repo without dismantling the protection. Replaced by owner self-merge, then by the publish-gated model.
- **Direct push, validate afterwards (the OpenNeuro model):** simpler for depositors, but a published DOI can change under readers with no review record. Rejected.

## Receipts

- `.context/pr_architecture.md` (original design), `.context/plan.md` Phase 7 (owner self-merge)
- `backend/src/services/github/branch-protection.ts` — `buildBranchRulesetPayload`
- #713 publish-gated governance; `nemar admin fleet drift|enforce`
