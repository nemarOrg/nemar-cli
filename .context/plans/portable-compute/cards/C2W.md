# Card C2W: Declare the launcher detail `image_unverified` in the contract

Status: ready
Tier: worker
Timebox: S, 1 hour; escalate at 2 hours
Needs: none
Depends: none
Branch: feature/pc-c2w-image-unverified
Worktree: $WT/nemar-cli-pc-c2w (base origin/feature/portable-compute-epic)
Plan: .context/plans/portable-compute/plan.md, section 4 (C2); ADR 0118 decision 10 (every compute word is declared once); ADR 0122 decision 7

## Goal

nemar-cli declares one new `runtime_error` detail, `image_unverified`, attributed to the platform, so that card C2's runner can end a job whose image signature did not verify with its own word instead of reusing `image_missing`.

## Context

- `shared/compute-state.ts`: `LAUNCHER_DETAILS.runtime_error` (around line 412) and `PLATFORM_LAUNCHER_DETAILS` (around line 455); `image_missing` is the neighboring word and the model to copy, including any sentence or table that lists the words.
- The runner's completion body accepts any word (`launcher_detail: wordSchema` in `shared/contract/compute-runner.ts`), so nothing breaks before this lands; declaring it is what makes attribution and the reports right.
- nemar-process mirrors the list in `launcher/nemar_launch/codes.py` with a pinned drift test; card C2 re-pins to this card's merge commit.

## Scope

- `shared/compute-state.ts`, any generated schema or sentence table that enumerates launcher details (find them with `git grep -n image_missing -- shared backend/src src`), and the tests that pin the lists.

## Decided design

Settled:
1. `image_unverified` is added after `image_missing` in `LAUNCHER_DETAILS.runtime_error` and in `PLATFORM_LAUNCHER_DETAILS` (a submitter cannot cause it with a valid specification: it is the platform's image supply chain).
2. Its sentence, wherever details have sentences: "The runner could not verify the image's signature, so the job did not start."
3. Commit: `feat: declare the image_unverified detail`.
The implementer may choose: nothing else.

## Acceptance

- `git grep -n image_unverified -- shared` shows both lists; `bun test` of every test file that `git grep -ln image_missing -- backend/test test` names passes.
- Removing the word from `PLATFORM_LAUNCHER_DETAILS` fails a test (quoted, reverted); if no test fails, add the assertion that does.

## Gates

- `bun run typecheck`, `bun run lint`, the test files of Acceptance.
- Full `bun test`: not run, would check: the epic gate (card S2).

## Stop conditions

- The word would need a database CHECK change (a migration): stop and report; this card adds no migration.

## Report

At most 25 lines: PR into `feature/portable-compute-epic`, head, merge commit once merged (card C2 pins it), gates, the mutation.
