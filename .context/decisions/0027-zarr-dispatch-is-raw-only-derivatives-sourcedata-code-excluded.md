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
`code/` paths, for files that were never meant to be viewable recordings (ICA solutions,
epoched/averaged `-epo.fif`/`-ave.fif` derivatives, raw `sourcedata`).
Sampling these showed misclassification rather than genuine defects: every `not_continuous` failure
inspected was an epoched or trial-averaged derivative, which is a correct verdict on a file that
should never have been offered to a time-series viewer in the first place.
The count is characterized as *predominantly* misclassification on that basis rather than proven
spurious file by file; a residue of these paths may well hold genuinely unreadable files, and
excluding the trees means we stop asking rather than establishing that each one was fine.
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

Makes the dispatch gate raw-only: a push confined to `derivatives/`, `sourcedata/`, or `code/` no
longer fans out to the Zarr workflow at all.

**This ADR deliberately does not claim that removes the measured 86.7% of phantom failures, because
it cannot.** The webhook dispatch path this ADR governs is **off in production**: `ZARR_AUTODISPATCH`
is set in no environment in `backend/wrangler-sccn.toml`, and the handler dispatches only when it is
exactly `"true"`, so the event-driven path is skipped with a log line. The production conversion
engine is the Hallu cron (`scripts/zarr/hallu-zarr.sh`, crontab `30 * * * *`), which is driven by
`zarr_queue.py`'s `reconcile()` off a dataset's *version* changing, invokes `generate_zarr.py` with
`--clean` **unconditionally**, and never consults `isZarrTriggerPath`. Both paths report through the
same `/webhooks/zarr-ready` callback into the same `zarr_data_failures` column, so the measured
failures almost certainly originate predominantly from the Hallu path, which this change does not
touch.

What this change is therefore worth: it fixes a real latent defect (the missing `.con`/`.sqd`/`.kdf`
extensions meant KIT MEG pushes silently never re-dispatched), it makes the gate correct for the
staging/dev path and for any future re-enabling of `ZARR_AUTODISPATCH`, and it establishes the
raw-only scope as the settled contract that the converter-side change is then held to. The actual
reduction in phantom failures lands with that converter change, not here. Claiming otherwise would
credit this ADR with an effect the production topology does not permit.

It also does **not** retroactively remove the 4,721 already-live `derivatives/`/`sourcedata/` stores,
and it does not stop the hourly `--clean` cron from reconverting them on the next version bump.
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
The claim would become true once the companion converter change lands, but that change deliberately
suppresses it, so **the automatic cleanup will not happen and must not be assumed**.

This is worth spelling out, because the naive version of the converter change is actively dangerous.
Excluding these trees from discovery also removes them from the set of stores a run produces, and
`--clean` computes orphans as exactly `prior index stores - stores this run produced`, feeding the
result straight into recursive deletion. So a raw-only converter with no further guard would read all
4,721 already-published non-raw stores as "gone from HEAD" and delete them on the very next hourly
cron tick, with no operator action and no authorization. The companion change therefore filters
excluded-tree paths out of the orphan set on purpose, leaving those stores in place: not rebuilt, not
removed, merely no longer listed in a fresh index.
Deleting them stays a separate, explicitly authorized step.

Until then the existing stores are **not** inert, and it would be wrong to describe them that way:
the Hallu cron's unconditional `--clean` reconverts every `derivatives/`/`sourcedata/` primary each
time a dataset's version changes, entirely independently of this dispatch gate. So they keep being
rebuilt and kept, they keep being served, and they keep generating failure rows. A `--wipe` or a
one-off bulk cleanup remains the only way to drop them in the interim.
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

## Implementation status (added 2026-08-21)

The decision stands unchanged. Two statements in **Consequences** were true when written
and are no longer, so read them as dated rather than current.

**The converter-side change landed.** `nemarDatasets/.github#98` made `generate_zarr.py`'s own
discovery raw-only (`is_excluded_from_discovery`, `in_excluded_tree`), so the sentence
"the converter itself does not yet know about this exclusion" no longer describes HEAD.
It shipped with exactly the guard this ADR said it must:
`compute_clean_orphans` filters excluded-tree paths out of the orphan set,
so the raw-only scope change alone cannot mass-delete the already-published non-raw stores.
The "actively dangerous naive version" warned about above was therefore never deployed.

**The purge is real and separate, as this ADR required.**
`nemarDatasets/.github#99` added `scripts/zarr/purge_non_raw_stores.py`,
dry-run by default, deriving targets from the published `index.json`
and confirming each against S3 before deleting.
It is the "explicitly authorized step" this ADR deferred to, and it is now authorized and under way.

**Both are live in production as of 2026-08-21.** That took an operator action the ADR did not
anticipate: the Hallu cron's `setup()` refreshes the driver clone only at process start,
and the drain loop holds the lock until its queue empties,
so a single run that had been going since 2026-08-12 pinned production to the pre-#98 driver
for nine days after the merge. Merging a converter change is not deploying it.
See `.context/systems-inventory.md` §3.3.

**The measurement in Receipts is an undercount.** `GET /datasets` caps `limit` at 200,
so "all 200 datasets" was 200 of 754. Re-measured across the full catalog on 2026-08-20:
**17,234** non-raw stores served (not 4,721) and **7,335** non-raw phantom failures (not 3,270),
against 151,197 raw recordings and 91.81% raw coverage.
The percentages held up better than the absolute counts, but neither figure should be quoted
from Receipts above without this correction.
