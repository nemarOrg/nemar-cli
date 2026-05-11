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
 * Tolerates per-step failures: each fetch/write has its own try/catch and is
 * reported in the return value (or in the D1 error fields). The function only
 * throws when the dataset row itself can't be found.
 */
export async function runDatasetSync(env: Bindings, datasetId: string): Promise<DatasetSyncResult> {
  const db = env.DB;
  const nemarUser = env.NEMAR_USERNAME;
  const nemarPass = env.NEMAR_PASSWORD;
  if (!nemarUser || !nemarPass) {
    throw new Error("NEMAR_USERNAME / NEMAR_PASSWORD not configured");
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
    throw new Error(`Dataset not found: ${datasetId}`);
  }
  if (!dataset.github_repo) {
    throw new Error(`Dataset has no GitHub repository: ${datasetId}`);
  }
  if (datasetId.startsWith("on")) {
    throw new Error("OpenNeuro datasets require alternate_id mapping before nemar.org sync");
  }

  const repoParts = dataset.github_repo.split("/");
  const repoName = repoParts[1];
  if (!repoName) {
    throw new Error(`Invalid github_repo format: ${dataset.github_repo}`);
  }
  const pat = env.GITHUB_ADMIN_PAT;
  const s3 = s3Cfg(env);

  // Read repo tree first; everything else depends on it.
  const tree = await getTreeAtRef(repoName, "main", pat);

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
    latestVersionDoi: latestVersion?.doi || null,
    latestVersion: latestVersion?.version || null,
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
 * Forward to /webhooks/llm-enrich in-process using the configured webhook
 * secret so admin-triggered reindex reuses the existing enrichment pipeline
 * end-to-end without extracting an 800-line handler.
 *
 * Defaults to ref="main" and force=true (admin paths always want a fresh
 * enrichment regardless of source_hash). The caller can override either.
 */
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

  // The webhook handler is on the same Worker; forwarding via the public
  // hostname keeps the call path identical to GitHub Actions. Cloudflare
  // routes the request back to this Worker.
  try {
    const res = await fetch("https://api.nemar.org/webhooks/llm-enrich", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Token": token,
      },
      body: JSON.stringify({
        dataset_id: datasetId,
        force: true,
        ref,
        client_commits: options?.clientCommits ?? false,
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
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // The webhook returns 200 even when sub-steps fail; surface those.
    const subErrors: string[] = [];
    for (const f of [
      "commit_error",
      "openrouter_error",
      "doi_sync_error",
      "cache_error",
      "bidsignore_error",
      "metadata_columns_error",
    ]) {
      const v = body[f];
      if (typeof v === "string" && v.length > 0) subErrors.push(`${f}: ${v}`);
    }
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
  const base =
    "SELECT dataset_id FROM datasets WHERE github_repo IS NOT NULL AND dataset_id NOT LIKE 'on%'";
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
