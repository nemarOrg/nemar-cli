# ADR 0027: The Zarr dispatch gate is raw-only; derivatives/sourcedata/code never trigger

**Status:** accepted
**Date:** 2026-08-20
**Owner:** Seyed Yahya Shirazi

## Context

`generate_zarr.py` (the Zarr serving-copy converter, in `nemarDatasets/.github`) walks the entire
repo tree at HEAD and treats any path matching `PRIMARY_EXTS`, or a directory-based format like
`.ds`, as a recording, wherever in the tree it sits.
`backend/src/routes/webhooks/github.ts`'s `isZarrTriggerPath` mirrors that same whole-tree view when
deciding whether a push fans out to the conversion workflow.

Measurement across all 200 datasets shows this is the dominant source of two separate problems.
3,270 of 3,771 reported conversion failures (86.7%) come from `derivatives/`, `sourcedata/`, or
`code/` paths: phantom failures for files that were never meant to be viewable recordings (ICA
solutions, epoched/averaged `-epo.fif`/`-ave.fif` derivatives, raw `sourcedata`).
Separately, 4,721 live Zarr stores (12% of 39,433) were built from `derivatives/` and `sourcedata/`
and are being served to the viewer, even though neither is a BIDS raw recording.

There is already a precedent for excluding these trees: `emit_records.py` (also in
`nemarDatasets/.github`) excludes `derivatives/` and `sourcedata/` via
`path.startswith("derivatives/") or "/derivatives/" in path` (and the `sourcedata/` equivalent) when
building its Tier-1 record set, so only raw recordings become records there.

## Decision

The Zarr serving copy covers BIDS raw recordings only.
`isZarrTriggerPath` excludes any path under `derivatives/`, `sourcedata/`, or `code/`, matched at
both a top-level and a nested position (mirroring `emit_records.py`'s shape, extended here to also
cover `code/`, which cannot hold a BIDS raw recording either).
The exclusion is checked first and unconditionally, ahead of every other rule in the function —
including the `_events.tsv` early return, which previously short-circuited before any other check
and would otherwise still fire on a `derivatives/.../*_events.tsv` path.

This PR changes only the dispatch gate in `nemar-cli`.
It does not change `generate_zarr.py` itself, which lives in a separate repo
(`nemarDatasets/.github`) and is out of scope for this track (issue #1098).

## Consequences

Eliminates the dominant source of phantom failures at the dispatch layer: a push confined to
`derivatives/`, `sourcedata/`, or `code/` no longer fans out to the Zarr workflow at all, which
removes 86.7% of the false-failure volume at the point where it is cheapest to stop, before a job is
even queued.

It does **not**, by itself, retroactively remove the 4,721 already-live `derivatives/`/`sourcedata/`
stores, and it does not stop a *manually* triggered `--full` or `--clean` run from reconverting them.
`generate_zarr.py`'s `is_primary()` and `compute_worklist()` were read at `nemarDatasets/.github` HEAD
on 2026-08-20 to check this, and they still walk the entire tree with no directory filter: `is_primary`
matches by extension alone, and a `--clean`/`--full` run's `all_primaries` is every such match anywhere
in the tree, not restricted to raw BIDS paths.
So the converter itself does not yet know about this exclusion; closing the loop end-to-end needs a
matching change there, tracked separately.

That gap matters for one claim this ADR was asked to verify before making it: ADR 0023 (`--clean`
rebuilds reconcile instead of wiping) computes orphans on a `--clean` run as the prior index's store
set minus the stores the run produces, then removes exactly those after conversion.
If the converter excluded `derivatives/`/`sourcedata/`/`code/` from its own primaries computation, that
mechanism would clean up the existing 4,721 stores automatically on the next `--clean` run, with no
manual purge needed.
As verified against the script above, the converter does **not** yet apply that exclusion, so **this
claim does not hold today**: a `--clean` run right now would still treat every `derivatives/`/
`sourcedata/` primary as present, reconvert it, and keep its store, because nothing removed it from
`all_primaries`.
The claim becomes true once the companion converter change lands.
Until then, the existing stores are merely inert — nothing will trigger a fresh conversion job
targeting them, since the dispatch path that would have done so is now excluded — but they are not
removed, and a manual `--wipe` or a one-off bulk cleanup remains the only way to drop them in the
interim.
That is an operational follow-up, not something this ADR settles.

## Alternatives considered

- **Filter only in the converter (`generate_zarr.py`), leave the gate as-is.** Rejected as the sole
  fix: the gate would still dispatch a full conversion job for a derivatives-only push, wasting
  compute on a run whose worklist would end up empty of raw recordings, and the immediate ask for
  this track is the gate (issue #1098); the converter-side change is separate follow-up work.
- **Path allowlist instead of a denylist** (match only known BIDS raw subdirectories, e.g. `sub-*/`).
  Rejected: BIDS raw layout varies with session/task/acquisition entity nesting, and enumerating
  every legal raw shape is more brittle than excluding the three well-known non-raw trees — which is
  also the shape `emit_records.py` already uses successfully.
- **Match `emit_records.py` exactly** (exclude only `derivatives/`/`sourcedata/`, leave `code/`
  unexcluded). Rejected: `code/` cannot contain a BIDS raw recording any more than `derivatives/` or
  `sourcedata/` can, and issue #1098 explicitly asks for it. `emit_records.py` not yet covering
  `code/` reads as a gap there, not a reason to repeat it here.

## Receipts

- nemarOrg/nemar-cli#1098 (this track), part of epic nemarOrg/nemar-cli#1095
- ADR 0023 — `--clean` reconciliation semantics; the claim above was checked against it and found to
  only partially hold today, as described in Consequences
- `scripts/emit_records.py` in `nemarDatasets/.github` — the `derivatives`/`sourcedata` exclusion
  precedent this PR's shape follows
- `scripts/zarr/generate_zarr.py` in `nemarDatasets/.github` — `PRIMARY_EXTS`, `is_primary`,
  `compute_worklist`, and the `--clean` orphan-removal logic (read at HEAD on 2026-08-20; confirmed
  not yet raw-only filtered)
- Measured 2026-08-20 across all 200 datasets: 3,270/3,771 (86.7%) conversion failures and
  4,721/39,433 (12%) live stores attributable to `derivatives/`/`sourcedata/`
