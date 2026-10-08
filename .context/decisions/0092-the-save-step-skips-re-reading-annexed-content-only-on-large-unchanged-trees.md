# ADR 0092: The save step skips re-reading annexed content only on large trees, only for files that have not changed, and only while it can take the skip back

**Status:** accepted
**Date:** 2026-10-07
**Owner:** Seyed Yahya Shirazi

Issue #1642, part of #1455, tracked under epic #1671.
Relates to [ADR 0031](0031-the-annex-policy-has-one-source-and-data-may-wear-a-metadata-extension.md) (the annex policy and what the save annexes) and ADR 0060 (what `git annex add` considers).

## Context

`git annex add` stages an unlocked file through `git update-index --index-info`, which leaves its index entry with zero stat data.
The save's `git add -A` then treats every annexed file as possibly modified and streams its full content through `git-annex filter-process` to find out that it is not.
On nm000358 (165 files, 1.6 TB, Ceph) that was the hours-long "Saving dataset changes" step, after the S3 copy had already finished.

Marking the annexed paths `assume-unchanged` for the duration of the save avoids that read.
It also hides those paths from git: a flag that is wrong, or that outlives the save, silently omits every later edit and deletion of the file, and the user sees "Upload complete".
On a small tree the skip costs more than it saves: on a Ceph filesystem, 600 annexed 120 KB files plus 600 JSON files saved in 33.5 s with the skip and 6.6 s without it.

## Decision

**The save skips re-reading annexed content only when the recorded annexed bytes reach `SAVE_SKIP_MIN_BYTES`, only for a file whose size and mtime still match the upload plan's record, and with every way the flag could outlive the save closed.**

- The threshold is 1 GiB (`SAVE_SKIP_MIN_BYTES`). It is a conservative starting point, not a measured crossover: nm000358 is three orders of magnitude above it and the Ceph benchmark (72 MB of annexed data) more than one order below. Below it the save is the plain `git add -A`, with no listing, no stat pass and no index rewrite.
- A path is skipped only if its size and mtime still match what the upload plan recorded. The record predates a possibly multi-hour `git annex add`, and it is the right thing to compare with because `git annex add` leaves the size, mtime and inode of an unlocked file unchanged (verified against git-annex 10.20260901 on APFS; a test checks the filesystem the suite runs on, others are unverified).
- A changed file fails the save, naming the first few paths and saying to re-run the upload, which re-tracks them (and `--restart` if the file is no longer a data file). A file that has stopped being data since it was tracked is dropped from the skip and saved normally. The comparison runs again after the commit, and a marked file that vanished or became unreadable counts as changed.
- Stale flags are cleared at the entry of every save, at the repository's top level, for annexed paths only. A failure to check or to clear them fails the save with git's message, because the alternative is a "saved" result that is not. The next save clears them first, so the way out is to run it again.
- The flags are cleared in a `finally`, retried once; a failure after the commit fails the save and names the way out (`nemar dataset commit`, or the upload again, either of which clears them first). On SIGINT, SIGTERM and SIGHUP they are cleared before the process dies.
- A failure to mark degrades to the plain save, with a warning: the skip is an optimization, never a reason to refuse a save.

The deferred cost is accepted. The skip defers the re-read, it does not remove it: the entries stay zero-stat, so the first `git status` afterwards re-reads the annexed content once (0.34 s against 0.01 s at 600 files of 120 KB; 4.5 s against 0.05 s at 10,000 annexed files of 3 KB plus 5,000 JSON files; local disk).

## Consequences

- A large upload no longer spends hours in "Saving dataset changes". The first `git status` or `nemar dataset update` on that directory afterwards pays for the read once.
- The save can now fail where it used to succeed: on a changed file, and on a git that cannot report its flags. Both say what to do.
- Index stat data is still not primed, so the cost above is paid on a later command rather than avoided.

## Alternatives considered

- **Always skip.** Rejected by the small-tree measurement: 33.5 s against 6.6 s on Ceph.
- **Never skip.** Rejected by the 1.6 TB re-read.
- **Prime the index's stat data so the read never happens.** No git command writes stat data for a zero-stat entry without reading its content, and writing the index by hand is not something to maintain.
- **Skip by a per-file size threshold.** It would still pay the per-tree costs of the skip (a listing, a stat pass, two index rewrites) on every tree.

## Receipts

- `src/lib/git-annex/clone-push.ts` - `saveDataset`, `compareRecordedStat`, `clearStaleAssumeUnchanged`
- `src/lib/upload/finalize.ts` - `SAVE_SKIP_MIN_BYTES`, `planSaveSkip`, `dropFilesNoLongerData`, `saveDatasetStep`
- `test/upload-save-skip.unit.test.ts` - the gate, the stat guard, the stale flags, against real git-annex
- `test/upload-save-failures.unit.test.ts` - git failing, a subdirectory, an interrupt
