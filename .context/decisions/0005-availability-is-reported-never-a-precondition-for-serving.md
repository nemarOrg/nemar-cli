# ADR 0005: Availability is reported, never a precondition for serving

**Status:** accepted
**Date:** 2026-07-29
**Owner:** Seyed Yahya Shirazi

## Context

Some NEMAR datasets are imported from upstream archives that no longer hold every file they declare, and some carry 0-byte objects left by the #967 empty-PUT bug. Delivery treated any gap as fatal: `nemar dataset get` discarded everything git-annex had already fetched and exited non-zero, and the archive workflow built the zip, uploaded it, then deleted it and never fired its callback. A dataset missing one stray upstream temp file out of 65,063 therefore served no archive at all.

Meanwhile the zip path failed in the opposite direction too: `GetObject` succeeds on a 0-byte object, so the archiver wrote an empty entry and published the archive as `ready`. `on003574` shipped 11 silently empty `anat/*_T1w.nii.gz` files inside a 17 GB zip marked complete.

## Decision

A partially available dataset must still be deliverable through **every** contract point. Missing content is **omitted**, never faked with a placeholder and never allowed to block the delivery. What is missing is recorded out of band: the per-dataset `.nemar/availability-report.json`, the completeness counts on the `datasets` row, and the build log.

## Consequences

- Users can retrieve the data that exists instead of getting nothing.
- Reporting becomes load-bearing. If the out-of-band record is missing or stale, a partial archive is indistinguishable from a complete one — which is exactly the gap #1041 had to close after this ADR shipped.
- A loud failure became a quiet one, so a magnitude floor is required: a build where essentially nothing was readable is a failed read path, not a partial dataset, and must still fail. Set at ~90% absent so a genuinely partial dataset (on006159 is ~70% absent upstream) still publishes.
- Transport failures (403/5xx/throttle) must stay fatal and keep the delete-and-retry path from #739; only authoritative absence (404, or content whose size contradicts its annex key) is treated as permanent.

## Alternatives considered

- **Keep failing the build on any gap:** honest but useless — it denies users the data that does exist, and no rebuild can recover files that are gone upstream. Rejected.
- **Ship placeholder/0-byte entries for missing files:** what the bug did accidentally. A file that opens and is empty is worse than an absent one, because nothing signals the difference. Rejected outright.
- **Inject the availability report into the zip:** considered and not taken; the report lives on `main` while archives build from the immutable version tag, so it would need a separate fetch, and the D1 columns serve the same purpose for consumers.

## Receipts

- #1038, #1039, #1040, #1041; epic #1044
- `nemarDatasets/.github#85`
- Verified live: `on004624` (1 absent of 66,426), `on003574` (11 hollow files)
