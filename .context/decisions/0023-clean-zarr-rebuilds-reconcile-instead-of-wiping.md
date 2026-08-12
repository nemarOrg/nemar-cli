# ADR 0023: A `--clean` Zarr rebuild reconciles; it does not wipe first

**Status:** accepted
**Date:** 2026-08-12
**Owner:** Seyed Yahya Shirazi

## Context

The Hallu Zarr pipeline ran every conversion with `--clean`,
which erased `s3://nemar/<id>/zarr/` before rebuilding.
The stated reason was exactness:
the serving copy must mirror the dataset,
with no orphaned stores from removed or renamed recordings and no stale groups from a regroup,
and a wholesale remake was judged cheap enough not to be worth reasoning about diffs.

Measurement contradicted the "cheap enough" premise.
On 2026-08-12, `nm000338` (a `v1.0.1` -> `v1.0.2` bump) spent roughly 45 minutes
deleting about 620,000 objects at 13,800 objects/min
before converting a single recording,
then re-uploaded almost exactly the keys it had just deleted.
Throughout that phase the node sat at load average 3.14 of 32 cores
with all 18 conversion workers idle:
`aws s3 rm --recursive` is one process paced by its profile's request concurrency,
so the wipe is wall-clock spent almost entirely outside the CPU.

The wipe was also never the mechanism that made a store exact.
Each store is uploaded with `aws s3 sync --delete`,
which already reconciles that store's contents precisely,
including stale chunks, renamed groups, and a recording that got shorter.
The only thing the up-front wipe added was dropping stores
for recordings that no longer exist at HEAD.

## Decision

`--clean` full-rebuilds every recording and rewrites the index fresh, but no longer erases the prefix.
Stores for recordings absent from HEAD are computed
as the prior index's store set minus the stores the run will produce,
and are handed to the existing per-store `remove` path,
which deletes after a successful conversion rather than before one.
A separate `--wipe` flag retains the erase-first behaviour for recovery.

## Consequences

A same-content rebuild now deletes nothing and re-uploads only what changed,
which removes the dominant cost from the common path.

The serving copy is no longer destroyed before its replacement exists,
so a run that fails midway degrades rather than blanking the dataset's viewer.
A recording that is still at HEAD but fails to convert keeps its previous store
instead of being deleted by a wipe that ran before the outcome was known,
which is what ADR 0005 (partial data still serves) would want.

Orphan detection now depends on the prior `index.json`.
If that index is missing or does not describe what is actually on S3,
an unreferenced store can survive.
It is invisible to the viewer, which is driven by the index, so the cost is storage rather than correctness —
and `--wipe` is the escape hatch when the prefix and the index have genuinely diverged.

`--clean` no longer means what its name suggests.
The name is kept because it is wired into the cron, the workflow, and the CLI;
the help text carries the correction.

## Alternatives considered

- **Keep the wipe, raise delete concurrency.** Sharding the recursive delete across child
  prefixes multiplies throughput and was adopted for the deletes that remain, but on its own
  it only makes the wasted work faster. It does not stop a rebuild from deleting keys it is
  about to write back, and it leaves the window where the dataset has no viewer.
- **Raise `--jobs` to claim the idle cores.** The idle cores are a symptom, not the cause: the
  pipeline is not CPU-bound during a wipe, so more workers wait on the same serial delete.
  Worth doing separately for the conversion phase, but it does not touch this cost.
- **Diff against the prior commit instead of rebuilding (drop `--clean`).** The cheapest option
  of all, and already implemented as the incremental path. Rejected here because a re-conversion
  is often triggered precisely when the *converter* changed rather than the data — the biosigIO
  one-channel fidelity bug being the case in point — and a source-commit diff cannot see that.
  Rebuilding every recording while reconciling the destination keeps that property.

## Receipts

- nemarOrg/nemar-cli#1068 — the fidelity rebuild that surfaced the cost.
- ADR 0005 — partial data still serves; the argument for deleting after, not before.
- `scripts/zarr/generate_zarr.py` in `nemarDatasets/.github` — `--clean` orphan selection,
  `_rm_recursive` sharding, and the `--wipe` escape hatch.
