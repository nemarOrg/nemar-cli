---
name: release-pr-reruns-exhaust-email-budget
description: nemar-cli's passwordless-auth-test runs only on PRs into main and signs in as a fixed address capped at 5 code requests/hour, so a release PR that reruns CI more than ~5 times in an hour fails with a 429 that reads like an auth regression
metadata:
  type: project
---

Hit while promoting v0.10.4 (2026-09-16). `passwordless-auth-test` failed on the release PR with `Expected: 200 / Received: 429` at `signIn` (`test/auth-passwordless.test.ts:609`). Not an auth defect: `/auth/code/request` counts `auth_codes` rows per email in a sliding hour, `PER_HOUR_LIMIT = 5` (`backend/src/services/auth-code.ts:27`), and the `PATCH /auth/profile` block signs in as the deliberately FIXED address `pl-profile-patch@nemar.test` — fixed because the block stores a real GitHub handle and `github_username` is unique `COLLATE NOCASE`, so the row must be stable.

The job runs ONLY on PRs into `main` (#1318), and a release PR reruns its whole suite on every push to `dev`. Five executions in 40 minutes exhausted the budget; cancelled runs appear to consume it too, and superseded runs are normal during a release. So the more work a release gathers, the more certain this is to fail — on the PR where a red check costs the most to interpret.

**Why:** `passwordless-auth-test` is NOT among `main`'s required checks (`lint`, `unit-pure`, `integration-dev`), so it does not block the merge — but it should not be waved off either.

**How to apply:** on a release PR, read a 429 at `signIn` as the rate-limit budget, not a regression; confirm by counting today's runs that executed the job. The window is sliding, so waiting until the oldest request is an hour old frees one slot — then `gh run rerun <id> --failed`. Tracked as nemar-cli#1427 with three fixes proposed (mint the session from the fixture route; rotate the address per UTC hour; split the handle test onto its own address). See [[ci-tier-grep-and-checks-exit-code]].
