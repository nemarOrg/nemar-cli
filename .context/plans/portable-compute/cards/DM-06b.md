# Card DM-06b: The dispatch path proves the Zarr serving copy describes the tagged data

Status: ready
Tier: worker-hard
Timebox: M, 4 hours; escalate at 8 hours or two failed approaches
Needs: none
Depends: DM-06, DM-08
Branch: feature/pc-dm06b-zarr-source-check
Worktree: $WT/nemar-cli-pc-dm06b (base origin/feature/portable-compute-epic)
Plan: .context/plans/portable-compute/plan.md, D12, section 3 (F1 depends on this card; F2 does not)
Review: Sonnet panel plus one Opus review (data integrity of the commit verdict; no network call from a request path without a bound; production fails closed)

## Goal

For a recipe whose input is `zarr`, `resolveRun` resolves the tag commit T and the serving index's commit S, decides the verdict with the GitHub compare rule (lead ruling of 2026-11-13, card DM-02), refuses a dataset whose verdict is neither `exact` nor `metadata_only` with a fixed word, and otherwise passes S, T, the verdict and the delta paths to the recipe through the flags DM-13 defines; the local stack is wired so DM-17, DM-18 and DM-15 can dispatch.

## Context

- Read DM-02's rule and DM-13's attestation flags (`--source-commit` S, `--tag-commit` T, `--commit-equivalence`, repeatable `--commit-delta-path`, at most 32, each under `.nemar/` or `.github/`), `backend/src/services/compute-pipeline.ts` (`resolveRun`, its refusals such as `version_untagged`, how DM-06 builds the Zarr argument vector), `backend/src/services/s3.ts` (`getZarrIndex`, which returns the index's `sourceCommit`), `backend/src/services/github/shared.ts` (`GITHUB_API()`, a test seam read at call time), `backend/src/services/github-auth.ts` (the App token), `shared/contract/compute-admin.ts` (pipeline refusal words and statuses), `NON_DATASET_FAILURE_WORDS`, `backend/scripts/compute-local-stack.ts` and its test.
- The dataset repositories are public, in the `nemarDatasets` organization.

## Scope

- New `backend/src/services/zarr-source-check.ts`; `backend/src/services/compute-pipeline.ts` (the call and the argument vector only); `shared/contract/compute-admin.ts` (two words); `backend/scripts/compute-local-stack.ts` (the two seams below).
- Tests: new `backend/test/zarr-source-check.test.ts`, new `backend/test/helpers/github-compare-standin.ts`; updates to `backend/test/compute-runner-jobs.test.ts` and `backend/test/compute-local-stack.test.ts` where the argument vector or seeding changed.

## Decided design

Settled:
- Applies only when the recipe's `input` is `zarr`; BIDS recipes and every Tapis path are unchanged (a test pins nemar-floor's argument vector).
- S: `getZarrIndex`'s `sourceCommit`; when `globalThis.NEMAR_ZARR_INDEX_BASE` is set (tests and the local stack only, read at call time like `GITHUB_API()`), `GET <base>/<id>/zarr/index.json` over HTTP instead.
- T: `GET <GITHUB_API()>/repos/nemarDatasets/<id>/commits/<data-plane tag>`, and on 404 or 422 the same tag without its leading `v`; `.sha`.
- Verdict: `exact` when S equals T; `metadata_only` when `GET .../compare/<T>...<S>` answers `status` `ahead`, `behind_by` 0, fewer than 300 `files`, and every `files[].filename` starts with `.nemar/` or `.github/`, with at most 32 such files; anything else is a mismatch.
- Refusals, worded where `resolveRun` words `version_untagged` and writing what that refusal writes: `zarr_source_mismatch` (409) for a definite mismatch (`behind`, `diverged`, a data path, 300 or more files, more than 32 delta paths, a tag GitHub does not have); `zarr_source_unverifiable` (503) when the index or GitHub cannot be read (timeout, 5xx, no index). `zarr_source_unverifiable` joins `NON_DATASET_FAILURE_WORDS`; `zarr_source_mismatch` does not.
- Calls: at most three GitHub requests and one index read per dispatch, each under the GitHub client's existing timeout and no retry inside the request; the App token when configured; outside exact production with no App credentials, unauthenticated requests (public repositories only); in exact production with no credentials, `zarr_source_unverifiable`.
- Argument vector for a Zarr recipe: `--source-commit <S> --tag-commit <T> --commit-equivalence <verdict>` plus one `--commit-delta-path <path>` per delta path in the compare's order (none for `exact`). This replaces DM-06's `ZARR_SOURCE_COMMIT_SQL` in `resolveRun` (the dataset-level commit of the latest serving copy, which DM-06 passed as `--source-commit` without comparing it with any tag): S now comes from the serving index itself and T from the resolved version's tag.
- DM-06's restriction is KEPT unchanged: a Zarr recipe runs only on the newest version, with `zarr_status = 'ready' AND zarr_store_count > 0`, refused with DM-06's own words before any index read or GitHub call. Reason: one serving copy exists per dataset and it describes the newest version; an older version's data generally differs, and relaxing it would only turn a clear refusal into a compare that fails.
- Local stack: `--seed-from-catalog` sets `NEMAR_ZARR_INDEX_BASE=https://zarr.nemar.org` and leaves `GITHUB_API()` at api.github.com (unauthenticated); `--seed-fixture` starts the GitHub compare stand-in and serves the fixture's index from the stack with S equal to the fixture version's commit, so the verdict is `exact`.
The implementer may choose: helper names, how the stand-in is seeded.

## Acceptance

- `bun test backend/test/zarr-source-check.test.ts` passes, driving the real admin pipeline route over `freshDb()` with the GitHub compare stand-in (a real `Bun.serve` for the external service) and an index base: `exact` and `metadata_only` dispatch with the exact flags above; a data-path delta, `behind`, `diverged`, 300 files and 33 delta paths are refused `zarr_source_mismatch` and write no job, hold or stamp beyond what `version_untagged` writes; a 5xx and a missing index are `zarr_source_unverifiable`; the `v`-less tag retry works; a BIDS recipe makes no GitHub call (the stand-in's request log is empty); an older version, or a dataset whose `zarr_status` is not `ready` or whose `zarr_store_count` is 0, is refused with DM-06's word and the stand-in's request log stays empty; `ZARR_SOURCE_COMMIT_SQL` is no longer read by `resolveRun` for a Zarr recipe (a source search in the test says so).
- `bun test backend/test/compute-runner-jobs.test.ts backend/test/compute-local-stack.test.ts` passes with the new argument vector and the fixture's `exact` verdict.
- Each new test fails under a one-line mutation (listed).

## Gates

- `bun run typecheck`, `bun run lint`, `bunx biome check <touched files>`, the Acceptance tests, `bun test backend/test/compute-pipeline-dispatch.test.ts`.
- Full `bun test`: not run, would check: the epic gate.

## Stop conditions

- `resolveRun` has no place to refuse before a stamp or job is written: stop and report.
- The GitHub client cannot make an unauthenticated request without changing its shared code: stop and report the smallest change.

## Report

At most 25 lines: PR, head, gates with last lines, mutations, deviations.
