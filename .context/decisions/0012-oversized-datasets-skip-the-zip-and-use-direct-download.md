# ADR 0012: Oversized datasets skip the zip and steer users to direct download

**Status:** accepted
**Date:** 2026-06 (backfilled 2026-07-31)
**Owner:** Seyed Yahya Shirazi

## Context

The downloadable zip is built by a GitHub Actions job with a wall-clock cap. A 2026-06-14 batch of 321-680 GB datasets blew that cap repeatedly, and the delete-on-failure guard then removed each partial, so the datasets churned runners and ended with no archive. There is a working alternative for large data: the per-file direct download is range-resumable, which a single enormous zip is not.

## Decision

Datasets over `ARCHIVE_MAX_BYTES` (100 GiB) **or** `ARCHIVE_MAX_FILES` (200,000) skip zip generation entirely and the UI steers users to direct download. The decision is a pure function shared by the Worker and the CI preflight so both agree, and preflight runs before the expensive checkout so an oversized set never spins up a doomed build.

## Consequences

- Large datasets stop burning runner time on builds that cannot finish.
- Users of large datasets get a resumable path, which is better than a 300 GB zip they cannot restart.
- `archive_status` stays NULL for skipped datasets and `archive_skip_reason` carries the explanation; "skipped" must not be confused with "failed", and it deliberately does not trigger the auto-retry sweep.
- **Two thresholds on different axes, and the file-count one was miscalibrated for years.** At the original serial fetch rate a 60-minute cap could only deliver ~19,800 files, so 200,000 was a promise the builder could not keep — `on004624` (19.3 GB, 66,426 files) passed preflight and then failed every time. Fixed by making the fetch concurrent and raising the cap rather than lowering the limit (#1038); the ceiling was never wrong, the throughput was.
- The thresholds are duplicated in bash in the CI preflight and must be kept in lockstep with `archive-policy.ts`.

## Alternatives considered

- **Raise the timeout and build everything:** a multi-hour job pinning a runner for a zip nobody can resume. Rejected.
- **Split into multi-part archives:** solves resumability but adds a reassembly step for users and a manifest format to maintain. Rejected as disproportionate while direct download exists.

## Amendment 2026-09-28 (#1514): the manifest was never the only source, and readiness has a version

nm000284 (512.4 GiB, 14,922 files, five times over `ARCHIVE_MAX_BYTES`) got a zip built for v1.0.0 and a second build dispatched for v1.0.1, both bypassing the policy this ADR describes. Two independent gaps, found together:

- **The preflight's one size source has a hole exactly where the incident needed it not to.** `run-generate-archive.yml` read the version manifest from `https://data.nemar.org/<id>/v<version>/manifest.json`, which the data plane serves only for a published, PUBLIC version (`loadPublishedDataset`). That 404s for a private dataset, an anonymous deposit before release, or -- nm000284's case -- a version whose `dataset_versions` row hasn't been written yet. The preflight's only response to a 404 was "proceed to build (size guard skipped)": a deliberate fail-open per this ADR's Decision, but one this ADR never anticipated would be the ONLY path for a dataset that is *always* in that window at dispatch time.
- **The Worker-side dispatcher never asked the policy at all.** `services/github/dispatch.ts`'s `triggerArchiveGeneration` had no call to `shouldSkipArchive`, even on the RETRY paths (`archive-ready.ts`'s auto-retry, `archiveRetrySweep`) where the row's `file_size`/`total_files` are already in hand. Retrying a known-oversized dataset cost a wasted dispatch even before the preflight got a chance to catch it.

Fix, in both repos:

- The preflight now tries, in order: the manifest (unchanged); the `repository_dispatch` payload's `total_bytes`/`total_files`, now sent by `triggerArchiveGeneration` whenever the caller has the row's declared size; a same-job derivation that clones the dataset repo (a plain `git clone` never fetches git-annex content) and runs the SAME manifest emitter the publish pipeline already uses (`scripts/emit_manifest.py`) to compute real totals from the git tree. Only after all three fail does the ORIGINAL fail-open apply. The two thresholds stay exactly as this ADR set them and stay in lockstep with `archive-policy.ts`.
- Both Worker-side retry dispatchers (`archive-ready.ts`'s auto-retry, `archiveRetrySweep`) now call `shouldSkipArchive` on the row before dispatching, using the SAME skip-recording statement the ready webhook's own skip branch runs (`ARCHIVE_SKIP_UPDATE_SQL`, moved to `archive-policy.ts` so it has one home instead of a third hand-copy).
- The admin backfill sweep's ready path (`/admin/datasets/archive-sweep`) previously marked a dataset `ready` from any zip `getArchiveSize` found, regardless of current policy; it now runs the same `shouldSkipArchive` check first (`decideArchiveSweepOutcome`), so an over-policy row is never `ready` even when an old zip is still sitting in S3. Its skip path now clears `archive_status` the way the webhook's does (the prior copy only set the reason).

**New consequence this ADR did not previously state: readiness is version-scoped, not just size-scoped.** `archive_status` is tracked latest-only with no record of which version a `ready` zip was built for. A dataset that publishes a NEWER version before its own archive completes keeps advertising the OLD version's zip as `ready` -- the second half of the nm000284 incident (v1.0.0's zip stayed `ready` while the page advertised it for v1.0.1, which 404'd on click). Fixed as a derivation, not a new stored column (ADR 0034): `buildLandingPayload` compares `sweep_stamps.archive_checked_at` against the dataset's latest `dataset_versions.created_at` (both already-existing `datetime('now')`-format timestamps) and withholds `status`/`size` when the archive predates the latest version. The real download route (`GET /<id>/<version>.zip`) was never affected -- it already HEAD-checks the specific version's S3 key before redirecting, so it always 404'd cleanly rather than serving the wrong content; only the advertising surfaces (the landing JSON/HTML, the page bundle) could show a link that led to that clean 404.

## Receipts

- `backend/src/services/archive-policy.ts`; #749 Phase 3 / #752
- `.context/openneuro-import-forensics` — the 2026-06-14 batch
- #1038 (throughput fix that made the file ceiling honest)
- #1514 (nm000284: dispatcher gate, tiered preflight, per-version readiness); `nemarDatasets/.github`'s `run-generate-archive.yml` + `.github/scripts/archive-size-check.sh`
