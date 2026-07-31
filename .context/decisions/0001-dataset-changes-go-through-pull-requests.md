# ADR 0001: Dataset changes go through pull requests; main is sacred

**Status:** accepted
**Date:** 2026-01-14 (backfilled 2026-07-31)
**Owner:** Seyed Yahya Shirazi

## Context

OpenNeuro, the closest comparable archive, allows direct pushes to a dataset. NEMAR datasets are citable, DOI-bearing research artifacts, so an unreviewed push can silently change what a published DOI resolves to. We also need BIDS validation to be a gate rather than an after-the-fact report.

## Decision

Every change to a dataset repository goes through a pull request. Direct pushes to `main` are blocked by GitHub branch protection with `enforce_admins=true`, so the rule binds org owners too. Branch protection is applied automatically at repo creation.

## Consequences

- Every change carries an audit trail, a validation run, and a revert path.
- Self-approval is not possible, so a single-maintainer dataset needs a second reviewer or an admin action. This is friction by design and has to be staffed.
- `enforce_admins=true` means recovery from a bad state cannot be done by pushing over it; the protection must be lifted deliberately and restored.
- Private repos need GitHub Team for branch protection, which is why `nemarDatasets` is on Team via GitHub Education.
- Governance later became publish-gated (#713): private datasets stay open for iteration, public ones lock to PR-only. That refines this ADR rather than replacing it.

## Alternatives considered

- **Direct push, validate after (the OpenNeuro model):** simpler for depositors, but a published DOI can change under readers with no review record. Rejected.
- **PR required only for public datasets:** less friction while private, but the transition to public then has no reviewed history to inspect. Partially adopted later as publish-gated governance (#713), on top of this rule rather than instead of it.

## Receipts

- `.context/pr_architecture.md`
- `.context/validated_workflows.md` — branch protection validated 2026-01-14
- #713 publish-gated governance
