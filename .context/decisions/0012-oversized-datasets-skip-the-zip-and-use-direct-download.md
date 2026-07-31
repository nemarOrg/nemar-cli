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

## Receipts

- `backend/src/services/archive-policy.ts`; #749 Phase 3 / #752
- `.context/openneuro-import-forensics` — the 2026-06-14 batch
- #1038 (throughput fix that made the file ceiling honest)
