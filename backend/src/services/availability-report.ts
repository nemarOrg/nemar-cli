/**
 * Per-dataset availability report (`.nemar/availability-report.json`) — epic
 * #999 Phase 1, issue #1000.
 *
 * Records how much of a dataset's declared version-manifest content is
 * actually present in S3, and exactly which files are missing (+ why),
 * committed to the repo's `main` branch via the admin Contents-API path
 * (mirrors how enrichment commits `.nemar/metadata.json`). Reuses the
 * completeness math from services/import-integrity.ts
 * (verifyDatasetVersionS3) instead of recomputing it.
 */

import type { Bindings } from "../types/bindings.js";
import { getDatasetsToken } from "./github-auth.js";
import { createOrUpdateFile } from "./github/contents.js";
import {
  type DatasetVersionIntegrityResult,
  type ExpectedManifestFile,
  parseManifestFiles,
  verifyDatasetVersionS3,
} from "./import-integrity.js";
import { errorMessage } from "./repo-metadata.js";
import { type PresignedUrlOptions, getManifest } from "./s3.js";

/** One manifest PATH whose declared annex key is not present in S3 at its
 *  declared size. Entries are built by walking manifest PATHS (not annex
 *  keys): git-annex is content-addressed, so two distinct paths (repeated
 *  calibration/empty-room/identical-stimulus files are common in BIDS) can
 *  share one key -- keying off `key` alone would collapse two genuinely
 *  missing paths into a single (wrong, duplicated) entry. */
export interface AvailabilityReportMissingEntry {
  path: string;
  key: string;
  declared_size: number;
  reason: "zero_byte" | "absent";
}

export interface AvailabilityReportCompleteness {
  files_present: number;
  files_declared: number;
  bytes_present: number;
  bytes_declared: number;
  /** bytes_present / bytes_declared, or null whenever bytes_declared is not
   *  > 0 (a 0-declared-bytes dataset, with or without a manifest -- avoids a
   *  0/0 NaN either way). */
  pct_bytes: number | null;
}

export interface AvailabilityReport {
  dataset_id: string;
  version: string | null;
  generated_at: string;
  source: { type: string; id: string } | null;
  complete: boolean;
  completeness: AvailabilityReportCompleteness;
  missing: AvailabilityReportMissingEntry[];
  blocklist_reason?: string;
}

export interface BuildAvailabilityReportArgs {
  datasetId: string;
  version: string | null;
  source: { type: string; id: string } | null;
  integrity: DatasetVersionIntegrityResult;
  manifest: Record<string, ExpectedManifestFile> | null;
  generatedAt: string;
  blocklistReason?: string | null;
}

/**
 * Pure builder: turns an already-computed integrity result + the manifest it
 * was computed against into the on-disk report shape. Deterministic --
 * `generatedAt` is injected by the caller, never read from the clock here.
 *
 * When `integrity.version` is null (no manifest could be resolved/parsed --
 * see verifyDatasetVersionS3's own conservative contract) OR `manifest` is
 * null, completeness is genuinely unknown, not a bogus zero: returns a
 * minimal report with `version: null`, `complete: false`, `missing: []`, and
 * whatever raw present/declared counts `integrity` still carries (both stay
 * 0 when there was never a manifest to compare against at all).
 */
export function buildAvailabilityReport(args: BuildAvailabilityReportArgs): AvailabilityReport {
  const { datasetId, version, source, integrity, manifest, generatedAt, blocklistReason } = args;
  const blocklistFields = blocklistReason ? { blocklist_reason: blocklistReason } : {};

  if (integrity.version === null || manifest === null) {
    return {
      dataset_id: datasetId,
      version: null,
      generated_at: generatedAt,
      source,
      complete: false,
      completeness: {
        files_present: integrity.presentCount,
        files_declared: integrity.expectedCount,
        bytes_present: integrity.bytesPresent,
        bytes_declared: integrity.declaredBytes,
        pct_bytes: null,
      },
      missing: [],
      ...blocklistFields,
    };
  }

  // Walk manifest PATHS (not integrity.missingKeys) so a key shared by
  // multiple paths -- git-annex is content-addressed, so repeated
  // calibration/empty-room/identical-stimulus files commonly share one key
  // -- produces one entry per genuinely-missing path instead of collapsing
  // them all onto whichever path last won a key->path lookup.
  const missingKeySet = new Set(integrity.missingKeys);
  const zeroByteKeys = new Set(integrity.zeroByteKeys);
  const missing: AvailabilityReportMissingEntry[] = [];
  for (const [path, file] of Object.entries(manifest)) {
    if (!missingKeySet.has(file.key)) continue;
    missing.push({
      path,
      key: file.key,
      declared_size: file.size,
      reason: zeroByteKeys.has(file.key) ? "zero_byte" : "absent",
    });
  }
  missing.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    dataset_id: datasetId,
    version,
    generated_at: generatedAt,
    source,
    complete: integrity.complete,
    completeness: {
      files_present: integrity.presentCount,
      files_declared: integrity.expectedCount,
      bytes_present: integrity.bytesPresent,
      bytes_declared: integrity.declaredBytes,
      pct_bytes:
        integrity.declaredBytes > 0 ? integrity.bytesPresent / integrity.declaredBytes : null,
    },
    missing,
    ...blocklistFields,
  };
}

/**
 * Thrown by {@link writeAvailabilityReport} for caller-recoverable failures
 * (missing dataset row, no/invalid GitHub repo, auth failure) so the admin
 * route can map them to a specific HTTP status instead of a generic 500.
 * Mirrors DatasetReindexError (services/dataset-reindex.ts).
 */
export class AvailabilityReportError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 500,
  ) {
    super(message);
    this.name = "AvailabilityReportError";
  }
}

export interface WriteAvailabilityReportOptions {
  /** When true, compute and return the report without committing it. */
  dryRun?: boolean;
  /** Injected timestamp for deterministic tests; defaults to now. */
  generatedAt?: string;
}

/**
 * Resolve a dataset's current availability report and, unless `dryRun`,
 * commit it to `.nemar/availability-report.json` on the repo's `main`
 * branch via the admin Contents-API path (the same last-writer-wins
 * `createOrUpdateFile` enrichment uses for `.nemar/metadata.json`).
 *
 * Throws {@link AvailabilityReportError} for the dataset-not-found case (and,
 * on the write path only, a missing/invalid github_repo or a GitHub auth
 * failure) so callers can map them to specific HTTP statuses; a dry-run never
 * needs a repo at all, so those checks are skipped when `dryRun` is true.
 */
export async function writeAvailabilityReport(
  env: Bindings,
  datasetId: string,
  opts?: WriteAvailabilityReportOptions,
): Promise<AvailabilityReport> {
  const db = env.DB;

  const dataset = await db
    .prepare("SELECT dataset_id, github_repo FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ dataset_id: string; github_repo: string | null }>();
  if (!dataset) {
    throw new AvailabilityReportError(`Dataset not found: ${datasetId}`, 404);
  }

  // import_jobs carries OpenNeuro provenance for imported (on*) datasets
  // only; a native NEMAR submission has no row here, so `source` stays null.
  const importJob = await db
    .prepare("SELECT source, source_id, blocklist_reason FROM import_jobs WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ source: string; source_id: string; blocklist_reason: string | null }>();

  const integrity = await verifyDatasetVersionS3(env, datasetId);

  // Re-fetch + re-parse the same manifest verifyDatasetVersionS3 already
  // resolved (integrity.version) so the path <-> key mapping is available for
  // buildAvailabilityReport -- verifyDatasetVersionS3 only returns the
  // comparison result, not the parsed files map itself.
  let manifest: Record<string, ExpectedManifestFile> | null = null;
  if (integrity.version) {
    const s3Options: PresignedUrlOptions = {
      bucket: env.S3_BUCKET,
      region: env.AWS_REGION,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    };
    const manifestJson = await getManifest(s3Options, datasetId, integrity.version);
    if (manifestJson) {
      manifest = parseManifestFiles(manifestJson);
    }
  }

  const generatedAt = opts?.generatedAt ?? new Date().toISOString();
  const report = buildAvailabilityReport({
    datasetId,
    version: integrity.version,
    source: importJob ? { type: importJob.source, id: importJob.source_id } : null,
    integrity,
    manifest,
    generatedAt,
    blocklistReason: importJob?.blocklist_reason ?? null,
  });

  if (!opts?.dryRun) {
    if (!dataset.github_repo) {
      throw new AvailabilityReportError(`Dataset has no GitHub repository: ${datasetId}`, 400);
    }
    const repoName = dataset.github_repo.split("/")[1];
    if (!repoName) {
      throw new AvailabilityReportError(`Invalid github_repo format: ${dataset.github_repo}`, 400);
    }
    let pat: string;
    try {
      pat = await getDatasetsToken(env);
    } catch (err) {
      throw new AvailabilityReportError(`Failed to resolve GitHub auth: ${errorMessage(err)}`, 500);
    }
    await createOrUpdateFile(
      repoName,
      ".nemar/availability-report.json",
      JSON.stringify(report, null, 2),
      "Update NEMAR availability report",
      pat,
      "main",
    );
  }

  return report;
}

// ============================================================================
// Availability-report backfill sweep SQL (epic #999 phase 2, #1001)
// ============================================================================
//
// Exported so routes/admin/datasets-lifecycle.ts's POST
// /admin/datasets/availability-report-sweep handler and its test both build
// from the SAME query text instead of a hand-copied duplicate that can
// silently drift (the pattern ARCHIVE_RETRY_SWEEP_QUERY and
// NON_PROD_SANDBOX_CLEANUP_QUERY already use). The candidate SELECT and the
// `remaining` COUNT must stay scoped identically -- `remaining` is a promise
// that "0 means the sweep is done" -- so both are derived from the one
// `availabilityReportSweepWhere` builder rather than two copies of the WHERE
// clause that could drift apart.

/** Base candidacy predicate: every managed dataset (github_repo IS NOT NULL;
 *  catalog ds* rows have none), not sandbox, not yet stamped. */
const AVAILABILITY_REPORT_SWEEP_BASE_WHERE = `github_repo IS NOT NULL
     AND (is_sandbox = 0 OR is_sandbox IS NULL)
     AND availability_report_at IS NULL`;

/** Appended to the base predicate when `?missing-only=1` narrows candidacy to
 *  datasets already known incomplete (data_complete = 0, migration 0059). */
const AVAILABILITY_REPORT_SWEEP_MISSING_ONLY_WHERE = "AND data_complete = 0";

/** Single source of truth for the sweep's WHERE clause, with or without the
 *  missing-only narrowing -- shared by the candidate query and the remaining
 *  query below so they can never scope differently from each other. */
export function availabilityReportSweepWhere(missingOnly: boolean): string {
  return missingOnly
    ? `${AVAILABILITY_REPORT_SWEEP_BASE_WHERE}\n     ${AVAILABILITY_REPORT_SWEEP_MISSING_ONLY_WHERE}`
    : AVAILABILITY_REPORT_SWEEP_BASE_WHERE;
}

/** Candidate SELECT for the sweep. `LIMIT ?` is the only bound parameter. */
export function availabilityReportSweepCandidateQuery(missingOnly: boolean): string {
  return `SELECT dataset_id FROM datasets
     WHERE ${availabilityReportSweepWhere(missingOnly)}
     ORDER BY dataset_id
     LIMIT ?`;
}

/** `remaining` COUNT for the sweep -- identical scoping to the candidate query. */
export function availabilityReportSweepRemainingQuery(missingOnly: boolean): string {
  return `SELECT COUNT(*) AS n FROM datasets WHERE ${availabilityReportSweepWhere(missingOnly)}`;
}
