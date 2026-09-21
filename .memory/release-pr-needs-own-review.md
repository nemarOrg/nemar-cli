---
name: release-pr-needs-own-review
description: "The dev-to-main release PR gets its own multi-lens review before merging, even when every phase and the epic PR were already reviewed; it hunts what fell between the seams of the follow-up PRs"
metadata:
  type: feedback
---

On the v0.10.0 release of nemar-cli (2026-09-08), after the epic #1272 had per-phase reviews and an epic-level review, Yahya added: "promoting dev to main needs its own PR review to find things that might have fallen from seams."

**Why:** between the epic review and the release, `dev` accumulates follow-ups (live-tier fixes, config notes, an email fence, version bumps) that were each reviewed alone but never together against `main`; the release diff is the only place their interactions, config and workflow drift, and the release-safety checklist are visible at once.

**How to apply:** in the epic-dev finalize flow, after the epic PR merges into `dev` and before merging the `dev` to `main` release PR, run a release review on the full `origin/main...dev` diff (a detached worktree at the dev tip, read-only reviewers on Sonnet): a seams-focused code review (follow-ups versus the epic, wrangler and workflow config, AGENTS.md and docs versus shipped behavior, migration catalogue) plus a check of `.context/release-safety-playbook.md` against the PR body's checklist. Address findings on `dev` first, then merge the release PR. See [[cite-adr-by-content-not-plan-numbers]] and [[dev-worker-deploys-only-from-dev]].
