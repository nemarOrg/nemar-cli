# ADR 0144: A serving index ahead of its tag by NEMAR's own metadata is staged, with its commit

**Status:** proposed
**Date:** 2026-11-27
**Owner:** Seyed Yahya Shirazi

Supersedes [ADR 0141](0141-the-dispatcher-stages-the-serving-index-and-the-launch-specification-is-version-2.md) decision 2 where it refuses an index of any commit but the tag's, and the alternative it rejected ("Accept an index of a metadata-only commit").
Refines [ADR 0143](0143-every-worker-dispatched-run-of-the-archive-is-handed-its-tags-commit-or-waits-for-it.md) decision 1 and [ADR 0123](0123-derivatives-live-in-a-keyed-store-named-by-what-they-read.md) decision 3 for a run handed such an index: its `--source-commit`, and so its `git:` digest, is the index's commit.
Ruled on 2026-11-27, on nemarOrg/nemar-cli#2461.

## Context

The serving copy's index names the commit it was built from (`source_commit`), and ADR 0141 staged it for a run of the archive only when that commit was the version tag's.
nemarOrg/nemar-cli#2461 counted 807 of 812 ready copies built from a later commit than their newest tag; in a sample of 40 every one was ahead of its tag, and the rule below admits 33 of them: 6 change a path that is not NEMAR's own (dataset content in 4: `participants.tsv`, `README.md`, `dataset_description.json`; `.bidsignore` alone in 2) and 1 changes 300 files or more.
NEMAR changes its own metadata without a new tag, and a tag changes when the dataset's data or metadata changes, so a copy whose commit is ahead by NEMAR's own metadata only describes the tagged data.
nemar-process uses a row of the index only when the index's `source_commit` is exactly the run's `--source-commit` (`common/serving_index.py`, `ServingIndex.resolve`), and accepts no other attestation.

## Decision

1. **An index ahead of its tag by NEMAR-owned metadata only is staged.**
   When the index's commit S is not the tag's commit T, the Worker asks GitHub for one compare of `T...S` (the Zarr check's request, timeout and bound) and stages the index only when it answers `ahead`, `behind_by` 0, fewer than 300 files, and every changed path, and a renamed file's previous path, is NEMAR-owned metadata (`isNemarOwnedMetadataPath`):
   anything under `.nemar/` or `.github/`, or a `.gitattributes` file at any depth.
   `.gitattributes` is admitted because NEMAR's own annex policy rewrites those files across the fleet without a tag (`src/lib/fleet-annex-policy.ts`, `src/lib/import-normalize.ts`, ADR 0060), DataLad's `.datalad/.gitattributes` among them, and they govern how git stores a file, never its bytes.
   `.bidsignore` is not admitted (the dataset's authors own it, and it is BIDS configuration), nor is any other `.datalad/` file, a data file, a BIDS file or a path that is not a plain path.
2. **Anything else is refused with the word that says why, and the run goes ahead without the index at once.**
   `index_behind_tag` (the compare answers `behind`), `index_diverged` (`diverged`, ahead and behind at once, or no comparison: the repository lacks S or shares no history with it), `index_content_changed` (a path that is not NEMAR-owned metadata) and `index_delta_unlisted` (300 or more files, more than GitHub lists).
   `source_commit_differs`, ADR 0141's word for every other commit, is no longer produced and stays a valid recorded word.
3. **A compare GitHub cannot answer is a fault, never a guess.**
   It is `github_unreadable`, one of ADR 0141 decision 3's faults: the run is deferred (`serving_index_deferred`) and, 24 hours after its first deferral, runs without the index.
   Nothing is staged that was not shown to be the tag's data.
4. **What was admitted is recorded.**
   The job's specification records the staged index as `{sha256, size, ahead_of_tag: {tag_commit, index_commit, changed_paths}}`; an index of the tag's own commit is recorded as before, with no `ahead_of_tag`.
   The launch specification carries only `{sha256, size}`, so its closed schema and its bytes are unchanged.
5. **The run is handed the index's commit, S.**
   With an admitted index the arguments end `--serving-index /data/serving-index/index.json --source-commit S`.
   The tag's commit would make every row of the index `serving_index_stale`, so admitting the index would give the run nothing.
   The record then states S, which is honest: S is the commit the index was built from, and the admission proves that every file the recipe reads is the same at T and S, byte for byte; the version still names T, recorded beside S in `ahead_of_tag`.
   The derivative's `git:` digest is therefore S, and its key's `serving_index` is the staged copy's digest (ADR 0141 decision 6), so it is a different derivative from a run of the same version handed no index, as it already was.
   The derivative store keys such a run only when its specification hands exactly the recorded `index_commit` (`serving_index_unattested` otherwise), and, as ADR 0143 decision 4 requires, only when the record states that commit.

## Consequences

- Most datasets (33 of the 40 sampled) can now give nemar-ica the views of the serving copy; a copy built after a content change still cannot, which is the rest of #2461 (rebuild the copy at the tag, or tag the change).
- A nemar-ica dispatch whose index is of another commit makes one more GitHub request.
- A version's derivatives may carry two `git:` digests (T without an index, S with an admitted one); both name a commit whose read files are the version's.
- A later reconversion that only moves NEMAR's metadata gives a new S, a new index digest and so a new key, as any new index did under ADR 0141.

## Alternatives considered

- **Hand the tag's commit and teach the recipe to accept an index the platform attests:** every `git:` digest would stay the tag's, which keeps a version's digests stable across reconversions. It needs a nemar-process change (an attestation flag), and until then admission would give the run nothing. It is the shape to move to if version-stable digests matter more than views today.
- **Stage a copy of the index with its `source_commit` rewritten to the tag's:** the staged bytes would not be the serving copy's, against ADR 0141 decision 2's exact copy, and the index would state a commit it was not built from.
- **Admit `.bidsignore` too:** NEMAR writes to it, but so do the dataset's authors, and it changes what the BIDS validator reads.
- **Key by the tag's commit while the record states the index's:** the key and the record would name different commits.

## Receipts

- nemarOrg/nemar-cli#2461 (the count and the sample), nemarOrg/nemar-cli#2460 (ADR 0143, the base of this change).
- `isNemarOwnedMetadataPath` and `servingIndexAheadOfTag` in `backend/src/services/zarr-source-check.ts`; `stageServingIndex` in `backend/src/services/serving-index-staging.ts`; `recipeJobSpec` in `backend/src/services/compute-pipeline.ts`; `keyStamp` in `backend/src/services/compute-derivatives.ts`; `SERVING_INDEX_ABSENT_REASONS` and the job specification's `serving_index` in `shared/contract/compute.ts`.
- nemar-process `dev`: `recipes/nemar_process/common/serving_index.py` (`ServingIndex.resolve`: a row only when the index's commit is the run's `--source-commit`).
