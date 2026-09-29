/**
 * Archive size policy (epic #749, Phase 3 / #752).
 *
 * Datasets over a size/file-count threshold skip the downloadable-zip build
 * (run-generate-archive.yml's 60-min cap can't finish them) and steer users to
 * the range-resumable per-file direct download instead. The thresholds and the
 * decision live here so the Worker (archive-ready, admin sweep) and the CI
 * preflight (run-generate-archive.yml mirrors these numbers in bash) agree.
 */

/** Bytes ceiling for building a zip archive. Over this -> skip + direct download.
 *  100 GiB. The 2026-06-14 batch that blew the 60-min cap was 321-680 GB. */
export const ARCHIVE_MAX_BYTES = 100 * 1024 * 1024 * 1024;

/** File-count ceiling. Guards the pathological many-tiny-files case where bytes
 *  are modest but the zip's per-entry overhead still blows the cap. */
export const ARCHIVE_MAX_FILES = 200_000;

export interface ArchiveSizeInput {
  /** Total dataset bytes (from the version manifest's cached total). */
  totalBytes: number | null | undefined;
  /** Total file count (from the version manifest). */
  totalFiles?: number | null;
}

export interface ArchiveSkipDecision {
  skip: boolean;
  /** Human-readable reason when skip is true; undefined otherwise. */
  reason?: string;
}

/** Format bytes as a compact GB string for the skip reason. */
function gb(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Decide whether to skip zip-archive generation for a dataset of the given
 * size. Pure. Over the byte ceiling OR the file-count ceiling -> skip with a
 * reason. Unknown total bytes is treated as NOT skipped (build attempted; the
 * 60-min cap remains the backstop) so a missing manifest stat can't silently
 * suppress every archive.
 */
export function shouldSkipArchive(input: ArchiveSizeInput): ArchiveSkipDecision {
  const { totalBytes, totalFiles } = input;
  if (typeof totalBytes === "number" && totalBytes > ARCHIVE_MAX_BYTES) {
    return {
      skip: true,
      reason: `dataset ${gb(totalBytes)} exceeds ${gb(ARCHIVE_MAX_BYTES)} archive limit; use direct download`,
    };
  }
  if (typeof totalFiles === "number" && totalFiles > ARCHIVE_MAX_FILES) {
    return {
      skip: true,
      reason: `dataset ${totalFiles.toLocaleString()} files exceeds ${ARCHIVE_MAX_FILES.toLocaleString()} archive limit; use direct download`,
    };
  }
  return { skip: false };
}

/**
 * What every "no zip was built, and none will be" path persists: the reason
 * (#752), `archive_status` back to NULL (a skip is not a failure -- it must
 * not read as "no archive yet" nor keep a stale 'ready'/'failed' around), and
 * `archive_retry_count` reset (a skip is a clean state transition, so a prior
 * failed-retry history must not block a future auto-retry if the dataset
 * later shrinks and a real `failed` arrives).
 *
 * Lives here rather than in the webhook route (#1514) so every producer of a
 * skip -- the webhook's own 'skipped' branch, its pre-retry-dispatch policy
 * check, the daily `archiveRetrySweep`, and the admin backfill sweep -- runs
 * the SAME statement instead of a fourth hand-copy drifting from the others
 * (the admin sweep's prior copy is exactly the drift this fixes: it never
 * cleared `archive_status`).
 */
export const ARCHIVE_SKIP_UPDATE_SQL = `UPDATE datasets
           SET archive_skip_reason = ?,
               archive_status = NULL,
               archive_retry_count = 0,
               sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.archive_checked_at', datetime('now'))
           WHERE dataset_id = ?`;

/**
 * Outcome of reconciling a real S3 archive-size probe against the current
 * size policy (#1514). Used by the admin backfill sweep (`/admin/datasets/
 * archive-sweep`), which previously marked a dataset 'ready' from any zip it
 * found under `<id>/archives/`, regardless of whether the row is now over
 * policy (a dataset that grew past the ceiling after an old build, or a zip
 * left over from before the policy existed). Policy wins over "a zip happens
 * to exist": an over-policy row is always 'skip', never 'ready'.
 */
export type ArchiveSweepOutcome =
  | { action: "ready"; size: number }
  | { action: "skip"; reason: string }
  | { action: "absent" };

/**
 * Pure decision for the archive backfill sweep. `s3Size` is the largest zip
 * byte size `getArchiveSize` found under the dataset's archive prefix (0 when
 * none exists); `row` is the dataset's current declared totals. Exported so
 * the sweep's branching can be pinned by a unit test without S3 or D1.
 */
export function decideArchiveSweepOutcome(
  s3Size: number,
  row: { file_size: number | null; total_files: number | null },
): ArchiveSweepOutcome {
  const policy = shouldSkipArchive({ totalBytes: row.file_size, totalFiles: row.total_files });
  if (policy.skip) {
    return { action: "skip", reason: policy.reason ?? "archive skipped (size policy)" };
  }
  if (s3Size > 0) {
    return { action: "ready", size: s3Size };
  }
  return { action: "absent" };
}

/**
 * Whether a `'ready'` archive on record predates the dataset's current latest
 * version (#1514). Archive readiness is tracked latest-only: the ready
 * webhook and the backfill sweep both stamp `sweep_stamps.archive_checked_at`
 * at the moment they confirm a zip, with no notion of which version that zip
 * was built for beyond "whatever was newest then". When a NEWER version
 * publishes after that stamp, the zip on record still describes the OLD
 * version -- the exact nm000284 incident (v1.0.0 built and marked ready,
 * v1.0.1 published, the page kept advertising a "ready" download that 404'd).
 *
 * Deliberately a derivation, not a new stored field (ADR 0034): both
 * timestamps already exist (`sweep_stamps.archive_checked_at`,
 * `dataset_versions.created_at`), are the same `datetime('now')` text format,
 * and compare correctly with a plain string comparison.
 *
 * Either input missing means staleness can't be proven, so this returns
 * `false` (trust the status) rather than treating "unknown" as "stale" --
 * the common case (archive built after its dataset's only version, or after
 * its latest one) must not lose its ready state just because the caller
 * didn't have both timestamps on hand.
 */
export function isArchiveStaleForLatestVersion(
  archiveCheckedAt: string | null | undefined,
  latestVersionCreatedAt: string | null | undefined,
): boolean {
  if (!archiveCheckedAt || !latestVersionCreatedAt) return false;
  return archiveCheckedAt < latestVersionCreatedAt;
}
