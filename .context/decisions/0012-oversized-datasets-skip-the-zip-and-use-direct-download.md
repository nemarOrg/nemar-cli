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

## Amendment 2026-09-28 (#1491, #1518): one archive per dataset, a name that carries its own identity, and a retention mechanism that keeps it that way

An archive is a derived artifact, rebuildable from the dataset at any time, and by 2026-09-28
that had stopped being a design note and started being a storage bill: an audit of all 816
catalog datasets' `<id>/archives/` prefixes found 1,222 objects at 15.27 TiB, of which 546
objects (4.66 TiB) were reclaimable: a current zip for a version that was no longer latest, or
a noncurrent version left behind by a rebuild that overwrote the same key. The bucket is
versioned with no lifecycle rule expiring noncurrent versions, so every rebuild had been keeping
every prior build forever, and a plain `DeleteObject` on this bucket only adds a delete marker
and frees nothing.

**Decision, three parts:**

1. **Only the latest version's zip exists.** After `run-generate-archive.yml` uploads a version's
   archive and the archive-ready callback confirms it, the workflow deletes, BY VERSION ID, every
   other object version under that dataset's `<id>/archives/`: older-version zips, noncurrent
   versions of the current key, and delete markers. This runs in the **workflow**, not the
   backend webhook: the webhook already answers inside a Cloudflare Worker invocation with a
   bounded per-invocation subrequest budget (`applyObjectLockBatch` in `services/s3.ts`
   documents the same cap), and an unbounded `list-object-versions` + `delete-objects` pair for a
   dataset with an unknown rebuild history is the wrong thing to run inside that budget while
   also answering the workflow's HTTP request. The workflow already holds the AWS credentials the
   upload itself used, so nothing new is granted. An older version's `/<id>/<version>.zip` and its
   page-bundle archive field now say plainly that only the latest version has a retained archive
   and point at the version's own browsable files, instead of presenting a 404 that reads like the
   build is still in progress. This assumes the archive advertised for the LATEST version is
   actually built for it; #1514's per-version readiness derivation (`isArchiveStaleForLatestVersion`,
   comparing `sweep_stamps.archive_checked_at` against the latest version's `created_at`) covers the
   gap in between a new publish and its own archive's completion, when the previous version's zip is
   still the one sitting in S3.
2. **The S3 key carries the dataset's own identity: `<id>/archives/<id>_v<version>.zip`**,
   replacing the original `<id>/archives/v<version>.zip`. The file name in a presigned S3 URL's
   path is the browser's default Save-As name, so this is what makes a download named
   `on002718_v1.0.0.zip` instead of a bare, dataset-anonymous `v1.0.0.zip`, chosen over a
   `response-content-disposition` header (the mechanism `generatePresignedGetUrl` already
   supports for BIDS-shaped file names elsewhere) because the owner decided the S3 key itself
   should carry the name, not a request-time override of it. Readers
   (`resolveArchiveKey` in `backend/src/services/s3.ts`, the one place the fallback lives; the data
   route calls it directly and presigns the resolved key itself) try the new name first and fall
   back to the pre-amendment name during a one-time transition window; the fallback is deleted
   (a single call site) once
   `scripts/rename-archives.ts` (run by hand, dry-run by default, verifying each copy's size and
   ETag before deleting the old object BY VERSION ID) has reached every archive that predates
   this amendment. Writers never write the old name once this ships.
3. **A lifecycle rule is the backstop, not the mechanism.** Archive objects are tagged
   `nemar-kind=archive` at upload, and a bucket lifecycle rule expires noncurrent versions of
   tagged objects after a few days, merged with the bucket's existing
   `abort-incomplete-multipart-uploads` rule (7 days, prefix `""`), which a lifecycle PUT replaces
   wholesale rather than patches, so the merge has to be deliberate every time either rule
   changes. This exists for the run that never reaches its cleanup step (a cancelled job, a
   crashed runner); the per-build cleanup above is what keeps storage bounded in the common
   case, and the tag is what lets a bucket-wide rule reach a prefix (`<id>/archives/`) that is not
   itself a single S3 prefix. Manifests (`version/`) carry no such tag and are unaffected by
   construction.

**Two different notions of "latest," and why they are allowed to disagree only in one direction.**
The backend's "latest" (`resolveVersion`'s `latest` branch, `pickVersion`'s fallback in
`page-bundle.ts`) is `dataset_versions.created_at DESC`, the most recently published row. The
workflow's cleanup step has no D1 access at all (it runs standalone with only `DATASET_ID` and
`VERSION` from its dispatch payload), so it cannot ask that question; it compares the SEMANTIC
VERSION embedded in each S3 key's file name against the version it was just dispatched to build.
These agree for every dataset under normal operation, because publishing a dataset always assigns
the next version in increasing semver order through the publish pipeline; nobody hand-picks an
out-of-order version number, the same discipline ADR 0016 enforces for the CLI's own release
version. The one place they were known to disagree, `nm000180`, had its `dataset_versions` rows
backfilled out of band rather than created through the normal sequential publish flow, which is
exactly the kind of write that can leave `created_at` order and semver order pointing different
ways; it was repaired on 2026-09-28 by resetting each row's `created_at` to that version's actual
original publish time. Retention compares semantic versions rather than `created_at` on purpose,
independent of that repair: a `list-object-versions`-and-delete-by-version-id cleanup is
irreversible on a bucket with no undelete, so it has to anchor to the value that is embedded
directly, immutably, and locally in the very key it is about to act on, not a mutable database
column it has no access to and that has already once been wrong for one dataset.

**Consequences:** `getArchiveSize` (`services/s3.ts`) still finds the archive by scanning
`<id>/archives/` for any `.zip`-suffixed key regardless of which name it carries, so it needed no
change; its "largest zip" heuristic only actually has more than one candidate to choose between
during the narrow window between a rebuild's upload and its own cleanup step completing.
`src/lib/exemplar-clone.ts`'s best-effort archive copy for the exemplar fleet gained its own
file-name rewrite (`rewriteArchiveKeyPrefix`) for the same reason the S3 key changed in the first
place: a generic leading-prefix rewrite would leave the SOURCE dataset's id baked into a copied
archive's file name at the destination, which is neither name any reader looks for there.
`nemarOrg/nemar-cli/scripts/hallu-sync.sh`, a direct-to-S3 consumer outside the backend, carries
the same new-name-first, old-name-fallback logic as `resolveArchiveKey`, by hand, since it does
not go through `services/s3.ts`.

## Receipts

- `backend/src/services/archive-policy.ts`; #749 Phase 3 / #752
- `.context/openneuro-import-forensics` — the 2026-06-14 batch
- #1038 (throughput fix that made the file ceiling honest)
- #1514 (nm000284: dispatcher gate, tiered preflight, per-version readiness); `nemarDatasets/.github`'s `run-generate-archive.yml` + `.github/scripts/archive-size-check.sh`
- #1491 (rename), #1518 (retention); the 2026-09-28 inventory and one-time sweep are recorded on
  #1518 itself
- `backend/src/services/s3.ts` (`archiveKey`, `legacyArchiveKey`, `resolveArchiveKey`),
  `backend/src/routes/data.ts`, `backend/src/services/page-bundle.ts`
- `nemarDatasets/.github/.github/workflows/run-generate-archive.yml` (upload naming, tagging, and
  the post-callback cleanup step)
- `scripts/rename-archives.ts` (the one-time rename sweep), `scripts/s3-lifecycle-archives.json`
  (the merged lifecycle configuration)
