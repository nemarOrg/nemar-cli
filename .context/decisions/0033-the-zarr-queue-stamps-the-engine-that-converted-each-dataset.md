# ADR 0033: The Zarr queue stamps the engine that converted each dataset, and pre-existing rows are declared current

**Status:** accepted
**Date:** 2026-09-01
**Owner:** Seyed Yahya Shirazi

## Context

`zarr_queue.py`'s `reconcile` re-queues a `done` dataset on exactly one trigger: its
`latest_version` no longer matches the `converted_version` the queue recorded.
That is the right trigger for a dataset that changed, and it is blind to the other reason a
serving copy can become wrong — the *converter* changed.

Epic #1095 (merged 2026-08-22) taught discovery to see MEF3 `.mefd`, CTF `.ds`, and 4D/BTi
recording **directories** as recordings.
An engine upgrade bumps no dataset version, so not one already-converted dataset benefited.
`on004696` is the reference case: `store_count: 0`, `failure_count: 0`,
`updated_utc: 2026-08-13`.
The engine of the day did not see its `.mefd` directories as recordings at all,
so they landed in neither `stores` nor `failures`;
the run found nothing, exited successfully, and the queue marked the dataset `done`.
It has been invisible in the viewer ever since, and nothing in the system was capable of
noticing.
By contrast `nm000281` (a `.bdf` dataset) reconverted correctly on 2026-08-31,
because a version bump happened to push it back through the queue after the merge.

This is structural, not a one-time miss: every future widening of format discovery strands
the back catalog the same way, silently, with a green cron log.

## Decision

The queue records **which generation of discovery rules converted each dataset**.
`jobs.engine_version` is stamped by `done`, and `reconcile` re-queues any `done` row whose
stamp is not the current `ZARR_ENGINE_VERSION` — the same treatment a version change gets.
Bumping that one constant is therefore the entire deployment procedure for a widening:
the back catalog re-converts itself, precisely, on the next cron tick.

**Rows that predate the column are seeded to the CURRENT version, not treated as old.**
A NULL stamp never means "re-queue me".

The genuinely stranded cohort is recovered separately by a targeted, evidence-driven sweep
(`zarr_queue.py backfill-dir-formats`), which identifies datasets by what their published
`index.json` and file list actually show rather than by the absence of a stamp.

## Consequences

A widening of discovery now costs one constant bump and reaches every dataset automatically.
A *narrowing* must not bump it — raw-only discovery (ADR 0027) removes stores rather than
adding them, so a mass re-queue would buy nothing and cost a full archive reconversion.
The constant's comment says so; nothing enforces it.

The seeding decision is the load-bearing one, and it is deliberately a lie about the stranded
cohort. On the first run against the production queue, all ~667 `done` rows carry NULL.
Reading NULL as "unknown, therefore old" would hand `reconcile` the entire archive on the
next cron tick: days of Hallu compute, an S3 rewrite of every store, and a `--clean` pass
over hundreds of datasets that are perfectly fine — to fix a few dozen.
Seeding declares them current instead, so the stamp starts clean and every future bump
re-queues exactly the rows that predate it.
What that costs is that the stamp cannot find the pre-stamp cohort;
that is the sweep's job, and if the sweep misses a dataset the stamp will not catch it later.

`_engine_is_stale` also refuses a NULL explicitly, which is redundant with the seeding by
design: if a NULL ever reappears (a driver older than this file writing into a migrated DB,
a hand-edited row), the failure mode must be "leave it alone", not "re-convert the archive".

**A bump is armed by merging it, so it needs a second step, not merely a loud one.**
The Hallu cron's `setup()` resets the driver clone to `origin/$DRIVER_REF` on every run, so
merging a change to `ZARR_ENGINE_VERSION` *deploys* it: the next hourly tick would reconcile
under the new constant and re-queue the back catalog with nobody watching.
`--no-engine-requeue` and the reported `engine_stale` count make that legible, but only to
somebody already looking, and only after the fact.
So `reconcile` also refuses: above `--engine-requeue-limit` stamp-stale rows (25 by default)
it requeues **none** of them, reports `engine_requeue_blocked`, and leaves the queue as it
found it until one run is explicitly acknowledged — `--engine-requeue-ack`, spelled on the
node as `touch $STATE_DIR/.zarr-engine-bump-ack`, which the script consumes so it arms exactly
one run. `hallu-zarr.sh --preview-engine-bump` answers "what would this cost" beforehand,
read-only, without touching the network or the lock.

Blocking is all-or-nothing and scoped to the stamp. A partial requeue would split the archive
across two engines with no record of where the line fell, and a guard that also stopped
genuinely new datasets converting would be a worse failure than the one it prevents.
What it costs is one extra step in a procedure that should be rare; what it does not prevent
is an operator who acknowledges without previewing. A mass requeue becomes deliberate, not
impossible.

The stamp governs `done` rows only. `failed` and `data_failed` stay terminal for this
version (#774): widening discovery does not make an unreadable recording readable.

## Alternatives considered

- **Stamp the engine into `index.json` instead of the queue row.** Rejected as the primary
  mechanism: the queue is what decides whether to convert, so it would have to fetch and
  parse ~755 published index documents on every hourly reconcile to make that decision.
  The index remains the right place to record what a store was built with, and the sweep
  reads it for exactly that reason — but the *decision* belongs where the decision is made.
- **Treat NULL as old and let the archive re-convert once.** Rejected: several days of
  compute and a full S3 rewrite, unattended, triggered by a deploy rather than by a
  decision. It also destroys the signal — after such a run every row is current, so nothing
  distinguishes the datasets that actually needed it from those that did not.
- **Compare converter file hashes or the biosigIO version instead of a hand-maintained
  number.** Rejected: every unrelated edit to a 3,700-line file, and every library patch
  release, would read as a widening and re-queue the archive. The trigger has to be a
  deliberate human statement that discovery got wider.
- **Leave it to a one-off script each time discovery widens.** Rejected: that is the status
  quo, and the status quo is that #1095 shipped and nobody noticed for ten days. The one-off
  is still needed for the pre-stamp cohort, but making it the permanent mechanism guarantees
  the same bug on the next widening.

## Receipts

- nemarOrg/nemar-cli#1172 (this change), under epic nemarOrg/nemar-cli#1181
- Epic #1095 / #1096 / #1097 / #1098 — directory-format support, merged 2026-08-22
- ADR 0023 (`--clean` reconciles), ADR 0027 (discovery is raw-only), ADR 0029 (the engine
  lives here), ADR 0030 (bounded streaming)
- nemarOrg/nemar-cli#774 — why terminal rows stay terminal for the same version
- `https://zarr.nemar.org/on004696/zarr/index.json` — `store_count: 0`, `failure_count: 0`,
  `updated_utc: 2026-08-13T23:33:53Z` (read 2026-09-01)
- nemarOrg/website#256 — the frontend half (viewer rows for directory recordings)
