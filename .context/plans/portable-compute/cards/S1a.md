# Card S1a: Declare `nm099996` a dev-owned fixture, straight into `dev`

Status: ready
Tier: worker
Timebox: S, 1 hour; escalate at 2 hours
Needs: none
Depends: none (the owner merges the PR into `dev` and releases it to `main` in the next normal release)
Branch: feature/pc-s1a-declare-nm099996
Worktree: $WT/nemar-cli-pc-s1a (base origin/dev)
Plan: .context/plans/portable-compute/plan.md, section 4 (S1); ADR 0068; `.rules/datasets-and-fixtures.md`

## Goal

`nm099996` is declared in `DEV_OWNED_FIXTURE_IDS` on `dev`, so that once this reaches `main` the production Worker short-circuits (and forwards to staging) every webhook of the `nemarDatasets/nm099996` repository, and the staging Worker lets an administrator create the fixture by naming its id; nothing else changes.

## Context

- Why this card goes to `dev` and not to the epic: the GitHub organization is shared, so a fixture may be created on staging only after PRODUCTION knows it is dev-owned (`backend/src/routes/webhooks/github.ts`, the `isDevOwnedDatasetId` short-circuit and `DEV_WEBHOOK_MIRROR_URL`); riding the next normal release decouples that from the epic's own path to `main`.
- `nm099997` was declared the same way before it existed (the comment above `DEV_OWNED_FIXTURE_IDS` in `backend/src/services/datasetId.ts`); follow its pattern and its comment style.
- `nm099900` is `ABSENT_DATASET_ID` and is never declared; `nm099999` stays in `NEVER_DEV_OWNED_IDS`.
- Tests that name `nm099996` today as "the next undeclared id": `backend/test/dataset-id-partition.test.ts` (around line 432), `backend/test/upload-gate.unit.test.ts` (around line 286); `backend/test/import-weekly-summary-sweep.test.ts` uses `nm099996` as a ledger finding id and must still pass unchanged or with the same id moved to `nm099995` if dev-ownership changes its result.

## Scope

- `backend/src/services/datasetId.ts` (the set and its comment), `backend/src/services/upload-gate.ts` (comments that name the next undeclared id), `.rules/datasets-and-fixtures.md` (the "In use today" list: `nm099996` is the standing compute fixture, declared ahead of its creation; the next fixture is `nm099995`), and the three test files above.

## Decided design

Settled:
1. `DEV_OWNED_FIXTURE_IDS` becomes `new Set(["nm099998", "nm099997", "nm099996"])`, with a comment paragraph: "`nm099996` is the standing compute fixture (portable compute, plan step S1): a staging copy of a small public EEG dataset that runner jobs run on outside production only; declared before it exists, like `nm099997`."
2. Every comment or test that calls `nm099996` the next undeclared id now says `nm099995`; the "undeclared reserved id is refused" tests use `nm099995`.
3. A new assertion in `dataset-id-partition.test.ts`: `isDevOwnedDatasetId("nm099996")` is true, `isDevOwnedDatasetId("nm099995")` is false, `isReservedFixtureId("nm099995")` is true.
4. Commit: `feat: declare nm099996 a dev-owned fixture`; a `CHANGELOG.md` line under the unreleased heading if the file has one (one line, no internal references).
The implementer may choose: nothing else.

## Acceptance

- `bun test backend/test/dataset-id-partition.test.ts backend/test/upload-gate.unit.test.ts backend/test/import-weekly-summary-sweep.test.ts` passes; with the set entry removed, the new assertion fails (mutation quoted, then reverted, `git status --porcelain` clean).
- The PR into `dev` is open, titled "Declare nm099996 a dev-owned compute fixture", and its body says the owner merges it and that it must reach `main` before the fixture is created on staging (card S1F).

## Gates

- `bun run typecheck`, `bun run lint`, the three test files above.
- Full `bun test`: not run, would check: CI's full run on the PR into `dev`.

## Stop conditions

- Any other test or code reads `DEV_OWNED_FIXTURE_IDS` in a way that changes behavior for a dataset that exists (not a fixture): stop and report the file and line.

## Report

At most 25 lines: PR number and head, the gates' last lines, the mutation, and the exact owner commands: `gh pr merge <n> -R nemarOrg/nemar-cli --squash` after green CI (a single change into `dev` lands as one commit, as #2139 did), then the next normal `dev` to `main` release.
