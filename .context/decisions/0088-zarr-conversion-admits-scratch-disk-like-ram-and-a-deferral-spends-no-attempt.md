# ADR 0088: Zarr conversion admits scratch disk like RAM, and a deferral spends no attempt

**Status:** accepted
**Date:** 2026-10-06
**Owner:** Seyed Yahya Shirazi

## Context

ADR 0030 recorded one risk as open: the streaming path's scratch disk is not admission-controlled.
A streaming recording lands whole on scratch, becomes a channel-major float32 memmap, then an int16 memmap plus the view pyramid, and at the end of pass 2 all of them coexist.
Measured on nm000276 sub-03 (float32 BrainVision, 114,458,234,880 bytes) that peak is 2.83 times the recording's bytes.

nm000276 is 40 recordings of 8.6 to 177 GiB (3031 GiB, matching the catalog's `file_size`); the 28 still pending are 22 to 177 GiB.
The Hallu scratch volume offers about 535 GiB.
With 24 workers admitted by RAM alone, two recordings were enough to fill the volume.
Then a worker was killed (the log labels it "out of memory, or a native crash"; node memory never fell below 45 GiB available, so the inference is SIGBUS on a memmap write to a full volume), and a killed worker never runs `convert_one`'s `finally`.
Its raw download and memmaps (535 GiB for two workers) stayed until the whole dataset run ended, so every recording behind them failed with `[Errno 28] No space left on device`.
Four runs of 7 to 15 hours each ended the same way, and the retry accounting counted each as an attempt: after round five the recordings would have become permanent `retry_exhausted` failures on account of a full disk.

## Decision

**Scratch is admitted like RAM.**
Each recording is charged `SCRATCH_STREAM_FACTOR` (3.0) times its bytes when streamed and `SCRATCH_INMEM_FACTOR` (2.0) otherwise, against `free + what its in-flight recordings hold - headroom` (10 GiB), read again at every admission round.
What the in-flight recordings hold is counted from their own directories, never from the whole run tree, so debris a killed worker left is not added to the budget as if it were about to be freed.
A size that cannot be read (no pointer, or an annex key without `-s`) is charged at least 16 GiB, with a warning, because a charge of zero is admitted at any budget.
The three settings are validated at import: a factor below 1, a negative headroom, `nan` and `inf` stop the run naming the variable.

**The gate fails closed.**
A volume that cannot be read keeps the last good budget, or admits nothing when there has been none, and says so once.

**There is no run-alone exception for disk, unlike RAM.**
A recording that does not fit while nothing is in flight cannot be admitted this run.
Admission first looks at the volume again `SCRATCH_DEFER_RESAMPLES` (3) times, `ADMISSION_RECHECK_SECONDS` apart, because one sample can land in another tenant's spike.
Then it defers the rest, one log line per recording naming it, its charge, the budget and the volume's free and total space, and an `::error::` for one whose charge exceeds the whole volume minus headroom, which can never fit.

**A deferral is not an attempt, and not a conversion.**
The deferred recording reaches the index through `merge_index` as follows.
A store the index may keep (the published index has the same commit, engine, biosigIO and dataset provenance, so the store on S3 is what this run would have written) stays served, so a `--clean` run, which merges against no prior, no longer republishes the dataset without it (ADR 0005).
A stale store leaves the index as a failure's does, and the recording is pending as `not_attempted`, its objects left on S3.
A recording already pending keeps its `attempts` and `last_attempt_utc`, is re-reasoned as `not_attempted`, and its `last_error` says why it was deferred ahead of what it last failed with.
The incremental path holds the commit back, as it does for an infra failure.
The callback counts deferred recordings as not attempted, so `zarr_queue.mark_done` leaves `retry_round` where it was and re-queues at the shortest delay; a test feeds real callbacks through the real `mark_done`.
A memory-failed recording held for the serial retry that cannot fit there is reported as the memory failure it was.

**A run that defers everything the index already says is deferred publishes nothing.**
The index, manifest and `events.parquet` are left alone and the callback restates the index's own numbers.
This is the smallest safe answer to the hourly churn of a recording that can never fit: the metadata clone and the two callbacks remain, the downloads and uploads do not.

**A pool break pays the disk back.**
The in-flight recordings' scratch is reclaimed before anything re-runs, each recording's memmaps live in their own `.scratch` sibling so that is safe, and `aws s3 cp` children orphaned by the dead workers are killed first (matched on whole arguments naming a path under the run's own temp directory).
Failed deletes are measured and reported, not counted as freed.
The warning prints the scratch free space before and after, because a full volume kills workers with SIGBUS, which the "killed its worker process" verdict reads as out of memory; the verdict now names a full scratch disk too.

## Consequences

- A dataset whose largest recording needs more scratch than the node has (nm000276's 177 GiB recording is charged about 532 GiB) stays `pending` and says so, instead of failing after hours of download. The remedy is operational: free scratch or move it.
- This narrows the open risk in ADR 0030; it does not close it. The factor is the float32 measurement plus margin, not a bound: a recording stored in fewer bytes per sample (int16 BrainVision, EDF) expands more and can still hit ENOSPC. The reclaim keeps that to one retryable failure instead of a cascade.
- `ZARR_SCRATCH_STREAM_FACTOR`, `ZARR_SCRATCH_INMEM_FACTOR`, `ZARR_SCRATCH_HEADROOM_BYTES`, `ZARR_SCRATCH_UNKNOWN_SIZE_BYTES` and `ZARR_SCRATCH_DEFER_RESAMPLES` are env-overridable like the RAM tunables and appear in the run's "active env overrides" line.
- The deferral note in a pending entry is written by the first run that defers the recording and is not refreshed while the situation is unchanged, so its "available" figure can be stale.
- `allocated_bytes` is not cached. It runs once per admission round (at least `ADMISSION_RECHECK_SECONDS` apart) over the in-flight recordings' own directories only, a few files each until pass 3 writes the store, and a cached figure would be stalest exactly when the disk is filling.
- The orphan kill matches on `ps` output, so it cannot see a process that rewrote its own command line. Where it misses one, the free-space line after the reclaim shows the shortfall.
- Follow-up, out of scope here because it crosses components: the `zarr-ready` webhook and D1 have no field for "deferred for scratch", so a dashboard sees these as ordinary pending recordings. A `scratch_deferred` count in the callback, the webhook schema and the `datasets` summary would let it say why. A longer re-queue delay for capacity deferrals (today the shortest, one hour) is the other option for the churn, and would need `zarr_queue` to learn the difference.
- Ordering: the numbers 0085 to 0087 are claimed by the identifier-screening work in flight (`feature/issue-1610-epic-identifier-screening` and its phase PRs). `test/adr-index.unit.test.ts` requires gapless numbers, so this record merges after them.

## Alternatives considered

- **Lower `--jobs` in the crontab.** Fewer workers hide the cascade without removing it, and cost throughput on every dataset to protect the one with giant recordings.
- **Run a lone oversized recording anyway.** Matches the RAM rule, but RAM's preflight skips a recording that cannot fit before loading it; the disk has no such check, and the failure arrives after the download.
- **Count a disk-full failure as an attempt.** That is what happened, and it turns a node condition into a permanent verdict on the data.
- **Republish the index on every deferral.** Simpler, and wrong twice: it re-uploads `events.parquet` hourly, and under `--clean` it publishes only what the run converted.
- **A longer queue backoff for capacity deferrals, instead of skipping the republish.** Needs a new callback field and queue column to tell a capacity deferral from any other not-attempted recording; the skip needs neither.

## Receipts

- nm000276 run logs on Hallu, 2026-09-29 to 2026-10-06: 27 of 28 pending recordings with `[Errno 28]`, `sar -r` minimum `MemAvailable` 45 GiB across all four runs.
- Recording sizes read from the public dataset repository's annex pointers: 40 recordings, 8.6 to 177.3 GiB, 3031.3 GiB in total, equal to the catalog's `file_size`.
- ADR 0030 (the open risk), ADR 0005 (partial data still serves).
