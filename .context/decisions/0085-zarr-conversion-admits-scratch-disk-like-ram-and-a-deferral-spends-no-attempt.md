# ADR 0085: Zarr conversion admits scratch disk like RAM, and a deferral spends no attempt

**Status:** accepted
**Date:** 2026-10-06
**Owner:** Seyed Yahya Shirazi

## Context

ADR 0030 recorded one risk as open: the streaming path's scratch disk is not admission-controlled.
A streaming recording lands whole on scratch, becomes a channel-major float32 memmap, then an
int16 memmap plus the view pyramid, and at the end of pass 2 all of them coexist.
Measured on nm000276 sub-03 (float32 BrainVision, 114,458,234,880 bytes) that peak is 2.83 times
the recording's bytes.

nm000276 is 40 recordings of 8.6 to 177 GiB (2.96 TiB), and the Hallu scratch volume offers about
535 GiB.
With 24 workers admitted by RAM alone, two recordings were enough to fill the volume.
Then a worker was killed (the log labels it "out of memory, or a native crash"; node memory was
never below 45 GiB available, so the inference is SIGBUS on a memmap write to a full volume), and a
killed worker never runs `convert_one`'s `finally`.
Its raw download and memmaps (535 GiB for two workers) stayed until the whole dataset run ended,
so every recording behind them failed with `[Errno 28] No space left on device`.
Four runs of 7 to 15 hours each ended the same way, and the retry accounting counted each as an
attempt: after round five the recordings would have become permanent `retry_exhausted` failures
on account of a full disk.

## Decision

Scratch is admitted like RAM.
Each recording is charged `SCRATCH_STREAM_FACTOR` (3.0) times its bytes when streamed and
`SCRATCH_INMEM_FACTOR` (2.0) otherwise, against `free + what the run already holds - headroom`
(10 GiB), read again at every admission round.

There is no run-alone exception for disk, unlike RAM.
A recording that does not fit while nothing is in flight cannot be admitted this run; it is handed
back unreported, which the index records as `not_attempted`, so no attempt is spent and no retry
round advances.
The queue re-queues it at the shortest backoff, and it converts when scratch allows.

A pool break reclaims the scratch of every recording it was running before anything re-runs, and
each recording's memmaps live in their own `.scratch` sibling of its store so the reclaim cannot
touch a neighbor's.

## Consequences

- A dataset whose largest recording needs more scratch than the node has (nm000276's 177 GiB
  recording needs about 532 GiB) stays `pending` and says so, instead of failing after hours of
  download. The remedy is operational: free scratch or move it.
- The factor is the float32 measurement plus margin, not a bound. A recording stored in fewer
  bytes per sample (int16 BrainVision, EDF) expands more and can still hit ENOSPC; the reclaim keeps
  that to one retryable failure instead of a cascade.
- `ZARR_SCRATCH_STREAM_FACTOR`, `ZARR_SCRATCH_INMEM_FACTOR` and `ZARR_SCRATCH_HEADROOM_BYTES` are
  env-overridable like the RAM tunables, and appear in the run's "active env overrides" line.
- Supersedes nothing: it closes the open risk in ADR 0030's last paragraph of consequences.

## Alternatives considered

- **Lower `--jobs` in the crontab.** Fewer workers hide the cascade without removing it, and cost
  throughput on every dataset to protect the one with giant recordings.
- **Run a lone oversized recording anyway.** Matches the RAM rule, but RAM's preflight skips a
  recording that cannot fit before loading it; the disk has no such check, and the failure arrives
  after the download.
- **Count a disk-full failure as an attempt.** That is what happened, and it turns a node
  condition into a permanent verdict on the data.

## Receipts

- nm000276 run logs on Hallu, 2026-09-29 to 2026-10-06: 27 of 28 pending recordings with
  `[Errno 28]`, `sar -r` minimum `MemAvailable` 45 GiB across all four runs.
- ADR 0030 (the open risk), ADR 0005 (partial data still serves).
