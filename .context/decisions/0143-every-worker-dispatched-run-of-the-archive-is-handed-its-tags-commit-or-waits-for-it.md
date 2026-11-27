# ADR 0143: Every Worker-dispatched run of the archive is handed its tag's commit, or waits for it

**Status:** proposed
**Date:** 2026-11-27
**Owner:** Seyed Yahya Shirazi

Supersedes the last clause of [ADR 0121](0121-a-job-names-its-executor-and-its-accounting-class-and-a-workstation-runner-pulls-its-work.md) decision 10 ("a Worker-dispatched BIDS record carries none, so a BIDS stamp has no digest").
Refines [ADR 0141](0141-the-dispatcher-stages-the-serving-index-and-the-launch-specification-is-version-2.md) decisions 3 and 4: the tag's commit is read before the serving index, a fault reading it defers without end, and an absent tag refuses.
Ruled on 2026-11-27, with nemarOrg/nemar-cli#2460 and the data mismatch of nemarOrg/nemar-cli#2461.

Refined by [ADR 0144](0144-a-serving-index-ahead-of-its-tag-by-nemars-own-metadata-is-staged-with-its-commit.md) (2026-11-27): a run handed a serving index admitted ahead of its tag is handed that index's commit instead of the tag's.

## Context

[ADR 0123](0123-derivatives-live-in-a-keyed-store-named-by-what-they-read.md) decision 3 keys a derivative of the archive (`bids`) by `git:` and the commit its files were read at, and the recipe states that commit only when it is handed one (`--source-commit`, recorded as `extensions.nemar.dataset.source_commit`).
The dispatcher handed a commit only with a staged serving index, so every other Worker-dispatched run of the archive, every `nemar-floor` run included, stated none: its stamp had no digest and the derivative store skipped it for good (`no_input_digest`).
ADR 0121 decision 10 wrote that state down as a fact.
A local end-to-end run found it on on007823, whose serving index was built from a later commit than its tag, and the coverage rule that reads a decided `stored` checkpoint would have counted every `nemar-floor` run of the archive incomplete for ever.
nemar-process accepts `--source-commit` for every recipe and records it (`cli.py` `add_identity`, `common/records.py`), so the change is the dispatcher's alone.

## Decision

1. **Every Worker-dispatched run of the archive reads the commit of its version's tag and is handed it.**
   At dispatch, after the dataset, its version, the runtime image and the service account are decided and before the claim, the Worker looks the tag up on GitHub (`versionTagCommit`: one tag lookup, the second request only without the tag's leading `v`), for every recipe.
   The arguments end with `--source-commit` and that commit: after the staged index's file when one was staged (ADR 0141 decision 4, whose commit is the tag's), and alone otherwise.
   A specification of a run of the archive without a commit is a programming error, never a job.
2. **A fault reading it defers the run for as long as the fault lasts.**
   When GitHub cannot answer, or the Worker has no credentials or cannot mint a token (`github_unreadable`, `no_github_credentials`, `token_mint_failed`), the run is not dispatched: a `refused` stamp with the word `source_commit_deferred` records the deferral, the dispatch answers `source_commit_deferred` (503) with the fault's word, and the next dispatch pass tries again.
   Unlike the serving index's deferral it never runs out, because a run without its commit could never be keyed.
   A credential fault (`no_github_credentials`, `token_mint_failed`) is the Worker's and the same for every dataset, so it stops a run over the queue at the first and ends the daily tick.
   `github_unreadable` can be one repository's (a renamed or empty repository, an answer only it gives), so the queue defers that dataset and moves on to the next.
3. **An absent tag refuses the run.**
   When the repository answers that it has no tag for the version, the dispatch is refused `version_tag_absent` (409) with nothing written, and the Worker logs `version_tag_absent` with the dataset and version.
   A version the data plane serves whose tag is gone is an integrity fault that an administrator mends, by restoring the tag; a retry cannot mend it and a run cannot be keyed without it, so neither a deferral nor an unkeyable run is spent on it.
   The dataset stays a candidate of the queue, which moves on to the next: a run over the queue tries up to ten datasets more than its room (`PIPELINE_RUN_EXTRA_TRIES`), so datasets refused or deferred at the head of the order never fill it.
   More such datasets than that at once would still hold a run, and each is logged by name.
4. **The derivative store checks the stated commit against the handed one.**
   When a run's recorded specification hands `--source-commit`, its stamp's digest must be exactly `git:` and that commit; a record that states another, or a specification that hands two, is `digest_mismatch` and is never keyed.
   A specification that hands none (a job from before this decision) is not checked.
5. **ADR 0141 decision 3 is narrowed accordingly.**
   The serving index's deferral now covers the index's own faults (`index_unreadable`, `index_not_stored`); the GitHub words are decision 2's and never run out, and `tag_absent` refuses instead of running at once.
   A run past the serving index's 24 hours still has its commit, and a deferral of its commit in between does not restart those 24 hours.

## Consequences

- A derivative of every Worker-dispatched run of the archive can be keyed and stored, `nemar-floor`'s included, under ADR 0123's key with the `git:` digest of the commit the dispatcher read, which is also what the record states.
- Every dispatch of a run of the archive costs one GitHub request before the claim; production has the GitHub App, and a staging or local Worker reads the public repositories without credentials.
  The daily tick tries at most ten datasets more than it dispatches, so it makes at most 40 GitHub requests.
  A GitHub outage pauses those dispatches, and each deferred pass writes one `refused` stamp, which holds no slot and is left out of the grid.
- The dry run still reads only D1 and the configuration, so it can answer `would_dispatch` for a version whose tag is absent; the live run refuses it.
- Runs dispatched before this decision carry no commit and stay unkeyable (`no_input_digest`); nothing is rerun automatically.
- Test suites that dispatch a run of the archive stand in for the tag lookup (`backend/test/helpers/github-tags.ts`).

## Alternatives considered

- **Dispatch without the commit and log it:** spends an allocation on a run whose derivative can never be stored.
- **Defer an absent tag too:** it would be retried on every pass, writing a stamp each time, for a fault no retry mends.
- **Keep the tag's commit in D1 at publication and never ask GitHub at dispatch:** no column holds it today, and a backfill of every version would be a change of its own; it can replace the lookup later without changing this decision.
- **Trust the commit the record states:** a recipe could state a commit it was not handed; the store checks it against the specification instead.

## Receipts

- nemarOrg/nemar-cli#2460 (the fix and its tests), nemarOrg/nemar-cli#2461 (serving indexes built after the tag).
- `versionTagCommit` in `backend/src/services/zarr-source-check.ts`; `sourceCommitForRun`, `SOURCE_COMMIT_DEFERRED_WORD` and `recipeJobSpec` in `backend/src/services/compute-pipeline.ts`; `recipeSourceCommitArguments` in `shared/compute-recipes.ts`; the digest check in `keyStamp`, `backend/src/services/compute-derivatives.ts`.
- nemar-process `dev`: `recipes/nemar_process/cli.py` (`--source-commit` for every recipe) and `recipes/nemar_process/common/records.py` (`extensions.nemar.dataset.source_commit`).
