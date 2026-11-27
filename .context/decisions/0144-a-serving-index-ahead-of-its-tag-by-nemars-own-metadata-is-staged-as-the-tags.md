# ADR 0144: A serving index ahead of its tag by NEMAR's own metadata is staged, as the tag's

**Status:** proposed
**Date:** 2026-11-27
**Owner:** Seyed Yahya Shirazi

Supersedes [ADR 0141](0141-the-dispatcher-stages-the-serving-index-and-the-launch-specification-is-version-2.md) decision 2 where it refuses an index of any commit but the tag's, and the alternative it rejected ("Accept an index of a metadata-only commit").
[ADR 0143](0143-every-worker-dispatched-run-of-the-archive-is-handed-its-tags-commit-or-waits-for-it.md) and [ADR 0123](0123-derivatives-live-in-a-keyed-store-named-by-what-they-read.md) decision 3 stand as they are: the run is the tag's.
Ruled on 2026-11-27, on nemarOrg/nemar-cli#2461.

## Context

The serving copy's index names the commit it was built from (`source_commit`), and ADR 0141 staged it for a run of the archive only when that commit was the version tag's.
nemarOrg/nemar-cli#2461 counted 807 of 812 ready copies built from a later commit than their newest tag, every one of a sample of 40 ahead of its tag.
The commits between are mostly NEMAR's readiness work: its records under `.nemar/`, its workflows under `.github/`, and the annex policy it rewrites in `.gitattributes` files across the fleet without a tag (`src/lib/fleet-annex-policy.ts`, `src/lib/import-normalize.ts`, ADR 0060).
The ruling's invariant: the data and events a serving copy was created from are the tag's, so the copy is kept as the tag's.
NEMAR's metadata changes without a tag; a tag changes when the dataset's data or metadata changes.
nemar-process used a row of the index only when the index's `source_commit` was exactly the run's `--source-commit` (`common/serving_index.py`, `ServingIndex.resolve`); nemarOrg/nemar-process#108 adds the arguments that attest an index built at another commit for a run of the tag's commit.

## Decision

1. **An index ahead of its tag by NEMAR-owned metadata only is staged.**
   When the index's commit S is not the tag's commit T, the Worker asks GitHub for one compare of `T...S` (the Zarr check's request, timeout and bound).
   It stages the index only when the compare answers `ahead`, `behind_by` 0 and fewer than 300 files, and every changed path, and a renamed file's previous path, is NEMAR-owned metadata (`isNemarOwnedMetadataPath`): anything under `.nemar/` or `.github/`, or a `.gitattributes` file at any depth.
   `.bidsignore` is not (the dataset's authors own it, and it is BIDS configuration), nor is any other `.datalad/` file, a data file, a BIDS file or a path that is not a plain path.
2. **A `.gitattributes` edit is admitted only when it cannot change the bytes of a checkout.**
   Git attributes can change those bytes: `eol=crlf` writes line endings as CR LF, `working-tree-encoding` re-encodes text, `ident` expands `$Id$`, and a smudge `filter` other than git-annex's rewrites the file.
   So the Worker reads each `.gitattributes` file's patch from the compare (`gitattributesPatchProblem`), and refuses (`index_content_changed`) any line, added or removed, that carries one of those, whether set, unset or given a value.
   Annex rules (`annex.*`), git-annex's own `filter=annex`, and `text`, `eol=lf`, `binary`, `diff` or `merge` lines are admitted: they say where git keeps a file, or leave an LF checkout as it was.
   A `.gitattributes` change whose patch GitHub leaves out (a large or binary diff) is `index_delta_unlisted`.
   This rule differs from the Zarr input's delta roots (`ZARR_SOURCE_DELTA_ROOTS`, `.nemar/` and `.github/` only) because the two prove different things to different readers.
   The Zarr recipe is handed every changed path and validates them against its own roots.
   Here the Worker alone decides, from the patches, that the files the archive run reads at T and the files the copy was converted from at S are the same.
3. **Anything else is refused with the word that says why, and the run goes ahead without the index at once.**
   - `index_behind_tag`: the compare answers `behind`.
   - `index_diverged`: the compare answers `diverged`, or ahead and behind at once, or there is no comparison (the repository lacks S, or shares no history with it).
   - `index_content_changed`: a path that is not NEMAR-owned metadata, or a `.gitattributes` edit that can change bytes.
   - `index_delta_unlisted`: 300 or more files, more changed paths than a job can carry (24, below), a body over the compare's bound, or a `.gitattributes` change without its patch.

   `source_commit_differs`, ADR 0141's word for every other commit, is no longer produced and stays a valid recorded word.
4. **A compare GitHub cannot answer is a fault, never a guess.**
   It is `github_unreadable`, one of ADR 0141 decision 3's faults: the run is deferred (`serving_index_deferred`) and, 24 hours after its first deferral, runs without the index.
   So a compare that can never be answered costs that dataset one 24-hour deferral and then a run without the index.
   Nothing is staged that was not shown to be the tag's data.
5. **The run is the tag's; the index's commit is provenance.**
   The run is handed the TAG's commit as `--source-commit`, staged index or not (ADR 0143).
   Its record states T, and its derivative is keyed by `git:` and T (ADR 0123 decision 3), with the staged copy's digest as the key's `serving_index` (ADR 0141 decision 6).
   The job's specification records the admission as provenance: `{sha256, size, ahead_of_tag: {tag_commit, index_commit, changed_path_count}}`, that is, the commit compared, the index's own commit and how many paths changed.
   An index of the tag's own commit is recorded as before.
   The launch specification carries only `{sha256, size}`, so its closed schema and its bytes are unchanged.
   The specification builder refuses an admission compared with another tag commit than the one handed, or one whose index commit is the tag's.
   The arguments attest the admission to the recipe (nemarOrg/nemar-process#108): after `--source-commit T` come `--serving-index-commit S` and one `--serving-index-delta-path` per changed path, a renamed file's old name included, each once and in code-unit order; the recipe uses a row only when its `--source-commit` is the attested T and the index's `source_commit` is S.
   A job's argument vector holds at most 64 strings and such a run uses 16 of them, so it carries at most 24 paths (the recipe takes 32); a larger delta is refused as `index_delta_unlisted`, never handed in part.
   The derivative store keys such a run only when its specification hands exactly the recorded `tag_commit`, attests exactly the recorded `index_commit` and as many paths as recorded, and attests nothing when no index ahead of its tag was staged (`serving_index_unattested` otherwise); and, per ADR 0143 decision 4, only when the record states the tag's commit.

## Consequences

- The identity of a run, its record and its derivative is the tag's everywhere, so a version's digests do not move when NEMAR's metadata does. A later reconversion that only moves NEMAR's metadata changes the index's digest, and so the key, as any new index did under ADR 0141.
- A nemar-ica dispatch whose index is of another commit makes one more GitHub request.
- A copy built after a content change is still not staged, which is the rest of #2461 (rebuild the copy at the tag, or tag the change).
- A run handed the attestation needs a runtime image built with nemarOrg/nemar-process#108; an older image refuses the arguments (exit 2, a usage error), so the image must move before nemar-ica runs over an admitted index.

## Alternatives considered

- **Hand the index's commit as `--source-commit`:** the recipe would use the index today, but the record and the key would name a commit the version does not name, and a version's digests would move with every metadata-only reconversion.
- **Stage a copy of the index with its `source_commit` rewritten to the tag's:** the staged bytes would not be the serving copy's, against ADR 0141 decision 2's exact copy, and the index would state a commit it was not built from.
- **Admit `.gitattributes` without reading its patch:** an `eol=crlf`, `working-tree-encoding`, `ident` or filter change does change checkout bytes.
- **Admit `.bidsignore` too:** NEMAR writes to it, but so do the dataset's authors, and it changes what the BIDS validator reads.

## Receipts

- nemarOrg/nemar-cli#2461 (the count and the sample), nemarOrg/nemar-cli#2460 (ADR 0143, the base of this change).
- `isNemarOwnedMetadataPath`, `gitattributesPatchProblem` and `servingIndexAheadOfTag` in `backend/src/services/zarr-source-check.ts`; `stageServingIndex` in `backend/src/services/serving-index-staging.ts`; `recipeJobSpec` in `backend/src/services/compute-pipeline.ts`; `keyStamp` in `backend/src/services/compute-derivatives.ts`; `SERVING_INDEX_ABSENT_REASONS` and the job specification's `serving_index` in `shared/contract/compute.ts`.
- nemar-process `dev`: `recipes/nemar_process/common/serving_index.py` (`ServingIndex.resolve`: a row only when the index's commit is the run's `--source-commit`).
