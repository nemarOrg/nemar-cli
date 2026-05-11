/**
 * Dataset reindex helpers (epic #417 phase 3).
 *
 * Two reusable building blocks plus a SQL-filter helper for bulk reindex:
 *
 * - runDatasetSync: gathers tree + participants.tsv + S3 stats + manifest
 *   for a dataset, pushes to the nemar.org datapipeline via
 *   syncDatasetToNemar, and updates both the existing nemar_sync_* fields
 *   and the Phase 2 metadata columns + metadata_columns_error in D1.
 *
 * - runEnrichmentForDataset: forwards to the /webhooks/llm-enrich endpoint
 *   in-process via fetch using GITHUB_WEBHOOK_SECRET so callers do not need
 *   to re-implement the 800-line enrichment pipeline.
 *
 * - buildReindexFilterQuery: pure SQL-builder for the bulk admin endpoint
 *   so the filter matrix is unit-testable without a D1 harness.
 *
 * Replaces the duplicated sync flow previously inlined in
 * webhooks.ts:syncToNemarAfterVersionDoi and admin.ts:/datasets/:id/sync.
 */

import type { Bindings } from "../types/bindings.js";
import { parseNemarMetadata } from "./datacite.js";
import {
  computeDatasetMetadataColumns,
  writeDatasetMetadataColumns,
} from "./dataset-metadata-columns.js";
import { getBlobContent, getTreeAtRef } from "./github.js";
import { syncDatasetToNemar } from "./nemar-sync.js";
import { errorMessage } from "./repo-metadata.js";
import { getArchiveSize, getDatasetS3Stats, getManifest } from "./s3.js";

export interface DatasetSyncResult {
  synced: boolean;
  errors: string[];
  metadata_columns_written: boolean;
  metadata_columns_error?: string;
}

/**
 * Typed error class so admin routes can map runDatasetSync failures to the
 * right HTTP status without substring-matching error messages. Status codes
 * are intentionally narrow: 400 for caller-side issues (bad dataset config),
 * 404 when the dataset row is missing, 500 for upstream / config failures.
 */
export class DatasetReindexError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 500,
  ) {
    super(message);
    this.name = "DatasetReindexError";
  }
}

export interface RunDatasetSyncOptions {
  /**
   * Fallback version DOI to use when the most-recent dataset_versions row is
   * not yet visible (D1 read-after-write race). Set by the webhook caller
   * that just minted this DOI in the same request.
   */
  versionDoiOverride?: string;
  /** Companion override for versionDoiOverride. */
  versionOverride?: string;
}

function s3Cfg(env: Bindings) {
  return {
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  };
}

/**
 * Gather upstream data and push it to nemar.org + refresh D1 metadata columns.
 *
 * Throws DatasetReindexError for caller-recoverable validation failures
 * (missing dataset row, OpenNeuro dataset, bad github_repo, missing creds)
 * so admin routes can map them to specific HTTP status codes. Re-throws the
 * underlying error (wrapped with context) when the initial GitHub tree fetch
 * fails. Once the tree is in hand, every downstream sub-step has its own
 * try/catch and is reported through the return value or D1 fields.
 */
export async function runDatasetSync(
  env: Bindings,
  datasetId: string,
  options?: RunDatasetSyncOptions,
): Promise<DatasetSyncResult> {
  const db = env.DB;
  const nemarUser = env.NEMAR_USERNAME;
  const nemarPass = env.NEMAR_PASSWORD;
  if (!nemarUser || !nemarPass) {
    throw new DatasetReindexError("NEMAR_USERNAME / NEMAR_PASSWORD not configured", 500);
  }

  const dataset = await db
    .prepare(
      `SELECT d.dataset_id, d.github_repo, d.concept_doi, d.created_at,
              u.username AS owner_username
       FROM datasets d
       LEFT JOIN users u ON d.owner_user_id = u.id
       WHERE d.dataset_id = ?`,
    )
    .bind(datasetId)
    .first<{
      dataset_id: string;
      github_repo: string | null;
      concept_doi: string | null;
      created_at: string | null;
      owner_username: string | null;
    }>();

  if (!dataset) {
    throw new DatasetReindexError(`Dataset not found: ${datasetId}`, 404);
  }
  if (!dataset.github_repo) {
    throw new DatasetReindexError(`Dataset has no GitHub repository: ${datasetId}`, 400);
  }
  if (datasetId.startsWith("on")) {
    throw new DatasetReindexError(
      "OpenNeuro datasets require alternate_id mapping before nemar.org sync",
      400,
    );
  }
  if (datasetId.startsWith("xx")) {
    throw new DatasetReindexError(
      `Sandbox dataset ${datasetId} is not eligible for nemar.org sync`,
      400,
    );
  }

  const repoParts = dataset.github_repo.split("/");
  const repoName = repoParts[1];
  if (!repoName) {
    throw new DatasetReindexError(`Invalid github_repo format: ${dataset.github_repo}`, 400);
  }
  const pat = env.GITHUB_ADMIN_PAT;
  const s3 = s3Cfg(env);

  // Read repo tree first; everything else depends on it. Wrap to give the
  // caller a clear error context (most-likely cause: GitHub auth or repo
  // visibility, not anything in our code).
  let tree: Awaited<ReturnType<typeof getTreeAtRef>>;
  try {
    tree = await getTreeAtRef(repoName, "main", pat);
  } catch (err) {
    throw new DatasetReindexError(
      `Failed to read GitHub tree for ${repoName}@main: ${errorMessage(err)}`,
      500,
    );
  }

  // dataset_description.json + README + .nemar/metadata.json for the nemar.org payload.
  let bidsDescription: Record<string, unknown> = {};
  const bidsFile = tree.find((f) => f.path === "dataset_description.json");
  if (bidsFile) {
    try {
      bidsDescription = JSON.parse(await getBlobContent(repoName, bidsFile.sha, pat));
    } catch (err) {
      console.warn(
        `[reindex] Failed to parse dataset_description.json for ${datasetId}: ${errorMessage(err)}`,
      );
    }
  }
  const readmeFile = tree.find((f) => f.path === "README" || f.path === "README.md");
  const readme = readmeFile ? await getBlobContent(repoName, readmeFile.sha, pat) : "";
  let nemarMeta = null;
  const nemarMetaFile = tree.find((f) => f.path === ".nemar/metadata.json");
  if (nemarMetaFile) {
    try {
      const raw = JSON.parse(await getBlobContent(repoName, nemarMetaFile.sha, pat));
      const parsed = parseNemarMetadata(raw);
      if (parsed?.version === "2.0") nemarMeta = parsed;
    } catch (err) {
      console.warn(
        `[reindex] Failed to parse .nemar/metadata.json for ${datasetId}: ${errorMessage(err)}`,
      );
    }
  }

  // Latest version + publication info from D1.
  const [latestVersion, pubRequest, repoInfo] = await Promise.all([
    db
      .prepare(
        "SELECT version, doi, created_at FROM dataset_versions WHERE dataset_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .bind(datasetId)
      .first<{ version: string; doi: string; created_at: string }>(),
    db
      .prepare(
        "SELECT approved_at FROM publication_requests WHERE dataset_id = ? AND status = 'published' ORDER BY approved_at DESC LIMIT 1",
      )
      .bind(datasetId)
      .first<{ approved_at: string | null }>(),
    fetch(`https://api.github.com/repos/nemarDatasets/${repoName}`, {
      headers: { Authorization: `token ${pat}`, Accept: "application/vnd.github.v3+json" },
    })
      .then(async (r) => {
        if (!r.ok) {
          console.warn(`[reindex] GitHub repo info for ${repoName}: HTTP ${r.status}`);
          return null;
        }
        return r.json() as Promise<{ created_at?: string }>;
      })
      .catch((err) => {
        console.warn(`[reindex] GitHub repo info fetch failed for ${repoName}: ${err}`);
        return null;
      }),
  ]);

  // S3 stats split: the nemar.org call accepts a fallback {0,0}, but the
  // metadata-column writer needs to know if the measurement is real (null on
  // failure) so it doesn't overwrite valid values with zeros.
  let s3StatsForColumns: { totalSize: number; objectCount: number } | null = null;
  const [s3Stats, zipFileSize] = await Promise.all([
    getDatasetS3Stats(s3, datasetId)
      .then((r) => {
        s3StatsForColumns = r;
        return r;
      })
      .catch((err) => {
        console.warn(`[reindex] S3 stats failed for ${datasetId}: ${err}`);
        return { totalSize: 0, objectCount: 0 };
      }),
    getArchiveSize(s3, datasetId).catch((err) => {
      console.warn(`[reindex] Archive size failed for ${datasetId}: ${err}`);
      return 0;
    }),
  ]);

  // participants.tsv for subject_count/age fields.
  let participantsTsv: string | null = null;
  const participantsFile = tree.find((f) => f.path === "participants.tsv");
  if (participantsFile) {
    try {
      participantsTsv = await getBlobContent(repoName, participantsFile.sha, pat);
    } catch (err) {
      console.warn(
        `[reindex] Failed to read participants.tsv for ${datasetId}: ${errorMessage(err)}`,
      );
    }
  }

  // Version manifest from S3 (accurate annex sizes).
  let manifest = null;
  if (latestVersion?.version) {
    try {
      const raw = await getManifest(s3, datasetId, latestVersion.version);
      if (raw) {
        try {
          manifest = JSON.parse(raw);
        } catch (parseErr) {
          console.warn(
            `[reindex] Manifest JSON corrupted for ${datasetId} v${latestVersion.version}: ${parseErr}`,
          );
        }
      }
    } catch (err) {
      console.warn(`[reindex] Failed to fetch manifest from S3 for ${datasetId}: ${err}`);
    }
  }

  // Push to nemar.org.
  const syncResult = await syncDatasetToNemar(nemarUser, nemarPass, {
    datasetId,
    bidsDescription,
    nemarMetadata: nemarMeta,
    readme,
    tree,
    conceptDoi: dataset.concept_doi,
    // Fall back to the caller-supplied overrides when the D1 versions row is
    // not yet visible. This covers the webhook path where the version row was
    // just inserted in the same request and the post-DOI sync runs via
    // waitUntil before D1 read-after-write replication catches up.
    latestVersionDoi: latestVersion?.doi || options?.versionDoiOverride || null,
    latestVersion: latestVersion?.version || options?.versionOverride || null,
    versionCreatedAt: latestVersion?.created_at || null,
    ownerUsername: dataset.owner_username || "unknown",
    createdAt: dataset.created_at || null,
    publishDate: pubRequest?.approved_at || null,
    repoName,
    pat,
    manifest,
    s3Stats,
    zipFileSize,
    repoCreatedAt: repoInfo?.created_at || null,
  });

  // Persist nemar.org sync status.
  await db
    .prepare(
      `UPDATE datasets SET nemar_sync_status = ?, nemar_sync_at = CASE WHEN ? = 'synced' THEN datetime('now') ELSE nemar_sync_at END, nemar_sync_error = ?, updated_at = datetime('now') WHERE dataset_id = ?`,
    )
    .bind(
      syncResult.synced ? "synced" : "failed",
      syncResult.synced ? "synced" : "failed",
      syncResult.errors.length ? syncResult.errors.join("; ") : null,
      datasetId,
    )
    .run();

  // Refresh Phase 2 metadata columns. Failure here doesn't fail the sync.
  let metadataColumnsError: string | undefined;
  let metadataColumnsWritten = false;
  try {
    const cols = computeDatasetMetadataColumns({
      treePaths: tree.map((f) => f.path),
      participantsTsv,
      s3Stats: s3StatsForColumns,
    });
    await writeDatasetMetadataColumns(db, datasetId, cols);
    metadataColumnsWritten = true;
    console.log(
      `[reindex] Metadata columns refreshed for ${datasetId}: subjects=${cols.subject_count}, modalities=${cols.modalities}, files=${cols.total_files}`,
    );
  } catch (colErr) {
    metadataColumnsError = errorMessage(colErr);
    console.error(`[reindex] Failed to write metadata columns for ${datasetId}:`, colErr);
  }
  try {
    await db
      .prepare(
        `UPDATE datasets SET metadata_columns_error = ?, updated_at = datetime('now') WHERE dataset_id = ?`,
      )
      .bind(metadataColumnsError ?? null, datasetId)
      .run();
  } catch (errFieldErr) {
    console.warn(
      `[reindex] Failed to record metadata_columns_error for ${datasetId}: ${errorMessage(errFieldErr)}`,
    );
  }

  return {
    synced: syncResult.synced,
    errors: syncResult.errors,
    metadata_columns_written: metadataColumnsWritten,
    metadata_columns_error: metadataColumnsError,
  };
}

export interface EnrichmentRunResult {
  ok: boolean;
  error?: string;
  ref: string;
}

/**
 * Field names the /webhooks/llm-enrich handler uses to surface non-fatal
 * sub-step failures inside a 200 response body. Kept in sync with the
 * spread at webhooks.ts where the response is built.
 */
const ENRICHMENT_SUBERROR_FIELDS = [
  "commit_error",
  "openrouter_error",
  "doi_sync_error",
  "cache_error",
  "bidsignore_error",
  "metadata_columns_error",
  "issue_creation_error",
] as const;

/**
 * Pull named *_error fields from a parsed enrichment response body and emit
 * "<field>: <message>" for each one populated with a non-empty string. Pure
 * function so the surfacing matrix is unit-testable.
 */
export function extractEnrichmentSubErrors(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const out: string[] = [];
  for (const field of ENRICHMENT_SUBERROR_FIELDS) {
    const v = record[field];
    if (typeof v === "string" && v.length > 0) out.push(`${field}: ${v}`);
  }
  return out;
}

/**
 * Forward to /webhooks/llm-enrich in-process using the configured webhook
 * secret so admin-triggered reindex reuses the existing enrichment pipeline
 * end-to-end without extracting an 800-line handler.
 *
 * Defaults to ref="main" and force=true (admin paths always want a fresh
 * enrichment regardless of source_hash). The caller can override either.
 */
/**
 * Heuristic: does the given ref look like a version tag (immutable)?
 * Matches `v` followed by a digit, the conventional shape for semver-style
 * release tags produced by pr-merge.yml. Tag refs must use client_commits=true
 * because the Worker's commit path resolves refs/heads/<ref> and gets 404
 * for tags; the worse failure mode is the bare-Contents-API write silently
 * landing on main. Exported for unit tests.
 */
export function looksLikeTagRef(ref: string): boolean {
  return /^v\d/.test(ref);
}

export async function runEnrichmentForDataset(
  env: Bindings,
  datasetId: string,
  options?: { ref?: string; clientCommits?: boolean },
): Promise<EnrichmentRunResult> {
  const ref = options?.ref ?? "main";
  const token = env.GITHUB_WEBHOOK_SECRET;
  if (!token) {
    return { ok: false, error: "GITHUB_WEBHOOK_SECRET not configured", ref };
  }
  if (!env.OPENROUTER_API_KEY) {
    return { ok: false, error: "OPENROUTER_API_KEY not configured", ref };
  }
  if (!env.API_BASE_URL) {
    return { ok: false, error: "API_BASE_URL not configured", ref };
  }

  // Tag refs are immutable; force client_commits=true so the Worker skips
  // its commit path. If the explicit caller already opted into client_commits
  // we honor that. Branch refs default to false unless the caller asked
  // otherwise (mirroring the existing behavior).
  const clientCommits = options?.clientCommits === true || looksLikeTagRef(ref);

  // The webhook handler is on the same Worker; forwarding via API_BASE_URL
  // (configured per environment in wrangler.toml) ensures dev hits the dev
  // Worker and prod hits api.nemar.org. Cloudflare routes the request back
  // to this Worker.
  try {
    const res = await fetch(`${env.API_BASE_URL.replace(/\/$/, "")}/webhooks/llm-enrich`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Token": token,
      },
      body: JSON.stringify({
        dataset_id: datasetId,
        force: true,
        ref,
        client_commits: clientCommits,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: `HTTP ${res.status}: ${text.slice(0, 200) || "(empty body)"}`,
        ref,
      };
    }
    // Parse the body explicitly so a malformed/gateway response is reported
    // as a failure rather than silently treated as "everything OK".
    let body: unknown;
    try {
      body = await res.json();
    } catch (parseErr) {
      return {
        ok: false,
        error: `Enrichment response body was not valid JSON: ${errorMessage(parseErr)}`,
        ref,
      };
    }
    const subErrors = extractEnrichmentSubErrors(body);
    if (subErrors.length > 0) {
      return { ok: false, error: subErrors.join("; "), ref };
    }
    return { ok: true, ref };
  } catch (err) {
    return { ok: false, error: errorMessage(err), ref };
  }
}

export type ReindexFilter = "all" | "missing-metadata" | "stale";

export interface ReindexFilterOptions {
  olderThanDays?: number;
}

/**
 * Pure SQL builder for the bulk reindex admin endpoint. Returns the SQL plus
 * the parameter bindings so the route can prepare/bind without composing
 * strings itself. Throws on unknown filter values so a typo is loud.
 */
export function buildReindexFilterQuery(
  filter: ReindexFilter,
  options?: ReindexFilterOptions,
): { sql: string; params: unknown[] } {
  // Excludes on% datasets (OpenNeuro, need alternate_id mapping) and xx%
  // datasets (sandbox/throwaway, not eligible for nemar.org sync — see
  // dataset deletion/publish handlers for the same short-circuit).
  const base =
    "SELECT dataset_id FROM datasets WHERE github_repo IS NOT NULL AND dataset_id NOT LIKE 'on%' AND dataset_id NOT LIKE 'xx%'";
  if (filter === "all") {
    return { sql: `${base} ORDER BY dataset_id`, params: [] };
  }
  if (filter === "missing-metadata") {
    return {
      sql: `${base} AND (subject_count IS NULL OR modalities IS NULL OR file_size IS NULL OR total_files IS NULL) ORDER BY dataset_id`,
      params: [],
    };
  }
  if (filter === "stale") {
    const days = options?.olderThanDays ?? 30;
    if (!Number.isFinite(days) || days < 0) {
      throw new Error(`Invalid older_than_days: ${days}`);
    }
    return {
      sql: `${base} AND (metadata_updated_at IS NULL OR metadata_updated_at < datetime('now', ?)) ORDER BY dataset_id`,
      params: [`-${days} days`],
    };
  }
  throw new Error(`Unknown reindex filter: ${filter}`);
}
