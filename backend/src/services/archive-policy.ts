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
