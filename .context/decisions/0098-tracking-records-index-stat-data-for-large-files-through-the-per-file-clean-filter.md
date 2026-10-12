# ADR 0098: Tracking records index stat data for large files through git-annex's per-file clean filter

**Status:** proposed
**Date:** 2026-10-12
**Owner:** Seyed Yahya Shirazi

Issue #1704 (follow-up to #884 and #1455).
Relates to [ADR 0094](0094-the-save-step-skips-re-reading-annexed-content-only-on-large-unchanged-trees.md), whose rejected alternative "prime the index's stat data" this ADR finds a way to do, and whose save skip it leaves in place.

## Context

`git annex add` stages an unlocked file through `git update-index --index-info`, which leaves its index entry with zero stat data.
Every later git command that compares the tree with the index then runs the file through the clean filter.
With `filter.annex.process` set, which `git annex init` does, that is the long-running filter: git sends it the whole content over a pipe, and only then does git-annex answer from its inode cache that nothing changed.
The add itself reads nothing through either filter (measured with `git annex add --batch -J4` and `-J16`, and the older argument form).
The reads come afterwards, from whichever command next looks at the file.

Measured with git-annex 10.20260901 and git 2.54 on the Apple File System (APFS), through `runDataSteps` with a directory remote standing in for S3, counting the bytes git pipes into the filter:

- A fresh upload of 1.26 GB in six files: nothing during the steps (the save skips the read above 1 GiB, ADR 0094), then 1,258 MB at the first `git status`.
- The next upload to the same dataset, after two subjects were added: 2,517 MB during the tracking step, because a completed upload clears its progress, every data file is an add target again, and the add's check of already-indexed paths (`git diff --name-only`) reads each zero-stat file twice. Then 210 MB at the first `git status`.
- A tracking step resumed after half the files were added: the added half read twice in the same check (1,258 MB), then 629 MB at the first `git status`.

The issue reports 75 to 95 MB/s a stream for this read on CephFS, over 80 minutes for 1.9 TB.

`git update-index --refresh` reads everything too while the filter process is set (1,258 MB, 3.25 s), which is why ADR 0094 found no way to prime.
With `filter.annex.process` absent, git uses git-annex's per-file clean filter, `git-annex smudge --clean -- %f`, which answers from the same inode cache from the path alone: the same refresh piped 0.8 MB (a pipe buffer per file) in 0.38 s, recorded the stat data, and the next `git status` read nothing.
git-annex does exactly this for its own restage: it records the value under `filter.annex.process-temp-disabled`, unsets `filter.annex.process`, refreshes, sets it back and removes the record, and its next restage restores from a record a killed run left (traced with `GIT_TRACE`).

The per-file filter is one git-annex process per file, and that cost does not depend on the file's size: 0.06 to 0.18 s a file on APFS with 6 to 6,000 annexed files in the index, and 500 files of 150 KB took 129.9 s against 0.75 s through filter-process.
The issue reports 3.7 s for a 25 GB file on CephFS.

## Decision

**The upload's tracking step records index stat data for data files whose recorded size is at least 1 GiB (`PRIME_MIN_FILE_BYTES`), with `git add --refresh` and the filter process out of the repository's configuration for the duration, under git-annex's own marker, and with every way that change could outlive the step closed.**

- It runs twice in the tracking step: before the add, for large targets already in the index (left by an interrupted run or by the last upload's save), and after the add, for every large target.
  The second runs after the step is stamped: the files are tracked whatever it finds.
- `git add --refresh -- <paths>` only records stat data for an entry whose content cleans to the blob already staged, and only for the paths named.
  It never stages anything, so what is committed cannot change.
  A file edited since it was tracked cleans to a different pointer, keeps zero stat data, and is still read and still seen.
- Both filter forms answer from the same inode cache (inode, size, mtime), so they agree on which files are unchanged.
  An edit in place that puts the size and the exact mtime back is missed by `git status` through filter-process as well; the priming hides nothing that `git status` would have shown.
- Only paths in the index are named, literally: `git add --refresh` refuses a whole list over one path it does not track.
- Nothing is primed unless `filter.annex.clean` is git-annex's and the filter process, if any, is set once and only in the repository's own configuration.
  One set anywhere else cannot be taken out for one command, and the files are left to be read as before, with a warning.
  With no filter process at all (the issue's own workaround), git already uses the per-file filter and nothing is changed.
- The value is written to `filter.annex.process-temp-disabled` before `filter.annex.process` is unset, and put back in a `finally`, retried once and read back.
  On SIGINT, SIGTERM and SIGHUP it is put back synchronously before the signal is re-raised; `git config` takes `.git/config.lock`, not the `index.lock` the refresh holds.
  SIGKILL and a power loss leave the marker, which the start of the next upload's steps restores (and git-annex's next restage would).
- A configuration that cannot be read, or put back, fails the step with the two commands that restore it.
  What is left behind is not a correctness problem (git falls back to git-annex's per-file filters, which store files the same way), but it is a change to the person's configuration that nothing else would undo, and it makes every git command start one git-annex process per file.
  A refresh that fails is only a warning: it can have recorded nothing but stat data.

## Consequences

- On the three runs above the bytes piped into the filter fell to 0.8, 1.1 and 0.8 MB, and the first `git status` afterwards to nothing.
  A large file is no longer read by the next upload's add, by the save (with or without ADR 0094's skip), or by the first command after the upload.
- Each large file costs one git-annex process per run that finds its entry without stat data, and an `lstat` on runs that do not.
- Files below 1 GiB keep the old behavior, including ADR 0094's deferred read, because for them the per-file process can cost more than the read it saves.
  At 1 GiB the per-file process is at least twice as cheap as the read on both measured hosts (about 0.6 s to re-read on APFS against 0.06 to 0.26 s a file, 11 to 14 s on the issue's CephFS against 3.7 s); it is not a measured crossover on CephFS, where only the one per-file figure from the issue is known.
- Nothing here was run on CephFS, on a multi-terabyte tree, or against S3.

## Alternatives considered

- **`-c filter.annex.process=` for one command.** Rejected: git treats an empty value as no filter at all, not as unset. A refresh then hashes the raw content and records nothing, and `git add` of a new 200 MiB file staged it as a 209,715,200-byte git blob.
- **`git update-index --refresh` with the filter process set.** Reads everything (1,258 MB); this is what ADR 0094 tried.
- **`git update-index -q --refresh -z --stdin` with paths, git-annex's own restage form.** Rejected: it re-stages the paths it is given, and a file edited after tracking had its new content annexed and staged.
- **`git annex restage`.** Does nothing for entries `git annex add` staged; its log is empty.
- **Leave the filter process unset for the whole upload (the issue's workaround).** Rejected as a default: every `git add -A` and `git status` would start one git-annex process per file, and a tree of many small files pays far more than the read (129.9 s against 0.75 s for 500 files of 150 KB).
- **Hand already-indexed files to `git annex add --batch` instead of checking them with `git diff`.** Rejected: git-annex re-hashes them (2.55 s for 600 MB), one read instead of two, not none.
- **`assume-unchanged` around the add's check, as ADR 0094 does around the save.** Defers the read rather than removing it, hides edits while set, and needs the same restoration machinery as this does.
- **A lower threshold.** Rejected on the issue's figure: a 256 MiB file re-reads in about 3 s on CephFS, less than the 3.7 s it reported for one per-file process.

## Receipts

- `src/lib/git-annex/index-prime.ts` - `primeIndexStat`, `restoreSuspendedFilterProcess`, `PRIME_MIN_FILE_BYTES`
- `src/lib/upload/transfer.ts` - `primeLargeDataFiles`, the tracking branch of `uploadDataToS3`
- `src/lib/upload/data-steps.ts` - the restore at the start of the upload steps
- `test/upload-index-prime.unit.test.ts` - the reads that are gone, the threshold, edits, signals, a configuration that cannot be restored, and the configurations left alone, against real git-annex
- `test/helpers/prime-runner.ts` - the process the signal tests interrupt
