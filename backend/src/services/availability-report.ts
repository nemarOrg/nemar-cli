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

/** One entry the version manifest declares that S3 does not have at its
 *  declared size. `path` is null when the annex key could not be matched
 *  back to a manifest path (shouldn't happen when `manifest` is non-null,
 *  since every missing key comes from that same manifest -- defensive). */
export interface AvailabilityReportMissingEntry {
  path: string | null;
  key: string;
  declared_size: number | null;
  reason: "zero_byte" | "absent";
}

export interface AvailabilityReportCompleteness {
  files_present: number;
  files_declared: number;
  bytes_present: number;
  bytes_declared: number;
  /** bytes_present / bytes_declared, or null when bytes_declared is 0 (no
   *  usable manifest -- a 0-byte-declared dataset is not represented here
   *  since that case still has a real manifest and a real, non-zero-safe
   *  ratio; 0 declared bytes with a manifest present divides to 0, not
   *  null -- only the no-manifest path leaves this null). */
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

  // Invert the manifest (path -> {key, size}) to a key -> {path, size} map so
  // each missing annex key can be traced back to the file path it belongs to.
  const byKey = new Map<string, { path: string; size: number }>();
  for (const [path, file] of Object.entries(manifest)) {
    byKey.set(file.key, { path, size: file.size });
  }

  const zeroByteKeys = new Set(integrity.zeroByteKeys);
  const missing: AvailabilityReportMissingEntry[] = integrity.missingKeys.map((key) => {
    const entry = byKey.get(key);
    return {
      path: entry?.path ?? null,
      key,
      declared_size: entry?.size ?? null,
      reason: zeroByteKeys.has(key) ? "zero_byte" : "absent",
    };
  });
  // Sort by path; entries with no resolvable path (shouldn't occur -- see the
  // field doc above) sort last rather than interleaving with real paths.
  missing.sort((a, b) => {
    if (a.path === b.path) return 0;
    if (a.path === null) return 1;
    if (b.path === null) return -1;
    return a.path < b.path ? -1 : 1;
  });

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
