# ADR 0030: Bounded streaming is the default conversion path; in-memory is the exception

**Status:** accepted
**Date:** 2026-08-22
**Owner:** Seyed Yahya Shirazi

## Context

The Zarr converter has two ways to build a store. The **in-memory** path loads a whole recording through biosigIO (`Recording.from_file -> to_zarr`); its peak RAM scales with the recording. The **streaming** path (`biosigio.stream_to_zarr`) makes two passes — window-by-window into a channel-major float32 memmap on scratch, then one channel at a time — so its peak is a read window plus one channel, independent of file size.

Streaming was treated as the exception, reached only above a size threshold, and the thresholds had drifted into two tiers: 256 MiB for KIT and EDF (formats with no lazy reader, which blow up early), and **2 GiB** for BrainVision, FIF, CTF `.ds` and MEF3 `.mefd` (formats with genuine lazy readers, where the in-memory path was judged "fine for moderate sizes").

On 2026-08-22 that judgment failed. Dataset `on004917`'s 24 BrainVision recordings are 1.18-2.25 GB, so **all but one sat just under the 2 GiB threshold**, took the unbounded in-memory path, and were admitted seven at a time against a projection running roughly half their real cost. Every one of the seven died. `on004998` lost 41 of 115 recordings to the same mechanism. The log carries 383 worker kills and 96 whole-dataset aborts.

The two-tier split has no principled basis. The driver's own note says BrainVision goes through MNE on both paths, so parity holds either way; "this format has a lazy reader" is a reason streaming *works*, not a reason to postpone using it.

## Decision

**A recording streams unless it is small enough that streaming would cost more than it saves.** One threshold, 256 MiB, for every format that has a streaming route: BrainVision, FIF, CTF `.ds`, MEF3 `.mefd`, 4D/BTi, KIT, and EDF/BDF. The in-memory path survives only as a fast path for genuinely small recordings, where process startup and the scratch memmap would dominate.

This supersedes the `ZARR_STREAM_MIN_BYTES=268435456` crontab override applied as a mitigation on 2026-08-22. **Remove that override when this reaches the node**, so the value lives in one place under version control rather than in a crontab line nothing reviews.

**A format joins the streaming path only on demonstrated importer parity.** Streaming reads through a different code path than the in-memory importer, so "it streams" is not sufficient; it must produce the same store.

**EEGLAB `.set` does not stream, at any size.** Two independent blockers, both verified against the installed MNE and biosigIO rather than assumed:

1. A MATLAB v7.3 `.set` is an HDF5 container. MNE refuses it outright; only biosigIO's own h5py importer reads it (the `[hdf5]` extra, added in 1.2.4 for **544** such recordings across the archive). Streaming routes through MNE, so routing `.set` there would turn those 544 back into failures.
2. For a classic `.set` whose samples are embedded in the MAT struct rather than a sibling `.fdt`, `preload=False` is a fiction: MNE's `_read_segment_file` detects `is_embedded` and calls `_readmat(preload=True)`, materialising the whole recording and caching it. Streaming such a file would load everything anyway **and** add the scratch memmap on top — strictly worse than the path it replaced.

Only a classic `.set` with a sibling `.fdt` could genuinely stream. That is a subset, and importer parity for units and channel handling would still need proving, so `.set` stays in-memory until someone does that work.

## Consequences

- The band that killed `on004917` (1.18-2.25 GB BrainVision) now takes the bounded path, with a flat 4 GiB projection instead of a size-scaled one that ran half the real cost. A regression test pins those exact sizes.
- Recordings between 256 MiB and 2 GiB convert more slowly: two passes and a scratch memmap instead of one load. This is the deliberate trade — that band is precisely where the unbounded path was killing the node.
- Scratch I/O rises. The memmap is `n_channels * n_samples * 4` bytes per recording on local NVMe, now for many more recordings. The pipeline already reclaims each recording's scratch immediately after upload.
- **Large `.set` remains the one unbounded case.** It is not left unprotected: the `RLIMIT_DATA` backstop (ADR follows #1110) turns a runaway into a catchable `MemoryError` rather than a node-wide OOM, and the temporary-versus-permanent verdict split (#1111) keeps such a recording retryable instead of burying its dataset. But it is the format to fix next if EEGLAB sizes keep growing.
- One threshold constant instead of two tiers, so the next format that needs routing has one decision to make and one place to make it.
- **Admission stops charging in-memory slack to streamed recordings.** `MEM_LIMIT_SLACK` exists to cover the in-memory projection being a guessed multiple of on-disk bytes that runs about 2x low. The streaming projection is not a guess of that kind — it is the flat bound the two-pass design gives. Applying slack to it charged 12 GiB for a recording whose real peak is in the hundreds of megabytes, and against this node's measured ~19 GiB ceiling that admitted exactly **one** recording at a time under `--jobs 24`: serial conversion of a 1.5 TB dataset. Caught by working the arithmetic before merge, and pinned by a test.
- **`STREAM_PEAK_BYTES` is a floor, not a bound, and calling it "conservative" was wrong.** Pass 2 of the streaming exporter does `x = np.asarray(mm[i], dtype=np.float64)` — it materialises one whole channel at native rate as anonymous heap memory. That term is `n_samples * 8` bytes: it scales with duration and sample rate and is **independent of channel count**. A 300-channel 1 kHz recording splits its bytes across many short channels and sits far under 4 GiB; a few-channel, long, high-rate recording (EMG, single-contact iEEG — both modalities NEMAR serves) can have one channel that alone exceeds it. Such a recording would be admitted as if it cost 4 GiB, trip the `RLIMIT_DATA` set to exactly that reservation, and fail — repeatedly, since that failure is retryable. `projected_peak_bytes` therefore takes the channel count (from the `channels.tsv` the fidelity gate already reads) and raises the projection when one channel would dominate; the flat value remains the floor, and the fallback when the count is unknown.
- **Scratch disk is not admission-controlled.** Each streaming recording writes an `n_channels * n_samples * 4` byte memmap, and raising concurrency raises the *concurrent* scratch peak proportionally. The per-recording cleanup in `convert_one`'s `finally` bounds accumulation across a run, not the peak at one instant, so it is not the mitigation it might appear to be. This is an open risk, not a solved problem: the run now reports scratch headroom at startup so a shortage is visible before it becomes a mid-run write failure, but nothing gates admission on it.

## Alternatives considered

- **Keep the 2 GiB threshold and rely on better projections alone (#1111).** Honest projections would have stopped admission over-packing, but each individual recording would still cost 12x its size on the in-memory path — so a single large BrainVision recording could still exhaust a node running alone. Rejected: it fixes the arithmetic without bounding the underlying cost.
- **Stream everything, with no threshold.** Simplest rule, but it forces a scratch memmap and a second pass onto tiny recordings where the whole load fits in a fraction of the memmap's own size. Rejected as a pointless slowdown on the common case.
- **Route `.set` to streaming anyway and accept the v7.3 losses.** Would have unified the policy across every primary format. Rejected: it trades a bounded-memory improvement for 544 recordings that currently convert correctly, and for embedded classic `.set` it would not even bound memory.
- **Leave the mitigation in the crontab.** Zero deployment risk. Rejected: it puts a load-bearing constant in an unreviewed crontab line on one box, which is the same class of drift that produced three copies of `hallu-zarr.sh` (ADR 0029).

## Receipts

- `on004917`: 24 BrainVision `.eeg` blobs, 1.18-2.25 GB; 23 of 24 below the old threshold. Seven admitted concurrently, seven killed.
- `on004998`: 74 of 115 converted, then one kill took the remaining 41.
- Log history at the time of the decision: 383 `worker crashed`, 96 `BrokenProcessPool`.
- `scripts/zarr/requirements.txt` records the v7.3 `.set` situation and the 544-recording measurement.
- MNE `io/eeglab/eeglab.py` `_read_segment_file` — the `is_embedded` branch calling `_readmat(preload=True)`.
- Issues: #1112 (this phase), #1108 (epic). Related: #1110 (backstop), #1111 (projections).
