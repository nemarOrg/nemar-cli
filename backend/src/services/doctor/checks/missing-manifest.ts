/**
 * Check: missing-manifest
 *
 * Symptom: data.nemar.org/<id>/<version>/manifest.json returns 404 even though
 * the D1 catalog says the version is published. Surface: discover/dataset
 * pages render an empty "Manifest unavailable" state.
 *
 * Cause: the publish webhook completed steps 1-2 (DB writes including a
 * dataset_versions row) but failed step 3 (manifest tarball generation +
 * S3 upload). The webhook caught and logged the manifest error but returned
 * 200, so nothing ever retries the upload.
 *
 * Fix: regenerate the manifest from the GH tag and re-upload to S3. The
 * existing `generateManifest` + `uploadManifest` helpers are reused unchanged,
 * so this check carries no new manifest-generation logic.
 */

import { type VersionManifest, generateManifest } from "../../manifest";
import { extractRepoName } from "../../repo-metadata";
import { getManifest, uploadManifest } from "../../s3";
import type { CheckContext, DoctorCheck, Finding, FixResult } from "../types";

interface CandidateRow {
  dataset_id: string;
  version: string;
  doi: string;
  github_repo: string;
  concept_doi: string | null;
}

interface MissingManifestDetails {
  doi: string;
  github_repo: string;
  concept_doi: string | null;
}

/** S3 head-check concurrency. Higher = faster scan, more parallel S3 ops. */
const SCAN_CONCURRENCY = 5;

async function listCandidates(ctx: CheckContext, datasetId?: string): Promise<CandidateRow[]> {
  const where = datasetId ? "AND d.dataset_id = ?" : "";
  const sql = `
    SELECT d.dataset_id, dv.version, dv.doi, d.github_repo, d.concept_doi
    FROM datasets d
    JOIN dataset_versions dv ON dv.dataset_id = d.dataset_id
    WHERE d.status = 'active'
      AND d.visibility = 'public'
      AND d.github_repo IS NOT NULL
      ${where}
    ORDER BY d.dataset_id, dv.version
  `;
  const stmt = datasetId ? ctx.db.prepare(sql).bind(datasetId) : ctx.db.prepare(sql);
  const { results } = await stmt.all<CandidateRow>();
  return results;
}

async function partitionMissing(ctx: CheckContext, candidates: CandidateRow[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (let i = 0; i < candidates.length; i += SCAN_CONCURRENCY) {
    const batch = candidates.slice(i, i + SCAN_CONCURRENCY);
    const checked = await Promise.all(
      batch.map(async (row): Promise<Finding | null> => {
        const manifest = await getManifest(ctx.s3, row.dataset_id, row.version);
        if (manifest !== null) return null;
        const details: MissingManifestDetails = {
          doi: row.doi,
          github_repo: row.github_repo,
          concept_doi: row.concept_doi,
        };
        return {
          dataset_id: row.dataset_id,
          version: row.version,
          details: details as unknown as Record<string, unknown>,
        };
      }),
    );
    for (const f of checked) {
      if (f !== null) findings.push(f);
    }
  }
  return findings;
}

function readDetails(finding: Finding): MissingManifestDetails | null {
  const d = finding.details as Partial<MissingManifestDetails>;
  if (typeof d.doi !== "string" || typeof d.github_repo !== "string") return null;
  return {
    doi: d.doi,
    github_repo: d.github_repo,
    concept_doi: d.concept_doi ?? null,
  };
}

export const missingManifestCheck: DoctorCheck = {
  name: "missing-manifest",
  description: "dataset_versions row exists but S3 manifest.json is missing",

  async scan(ctx, datasetId) {
    const candidates = await listCandidates(ctx, datasetId);
    return partitionMissing(ctx, candidates);
  },

  async fix(ctx, finding): Promise<FixResult> {
    if (!finding.version) {
      return { status: "failed", message: "version required for missing-manifest fix" };
    }
    const details = readDetails(finding);
    if (!details) {
      return { status: "failed", message: "finding details missing doi or github_repo" };
    }
    const repoName = extractRepoName(details.github_repo);
    if (!repoName) {
      return { status: "failed", message: `invalid github_repo: ${details.github_repo}` };
    }

    // Re-check S3 immediately before write. Another caller (or a successful
    // earlier fix attempt) may have already uploaded; treat that as skipped,
    // not failed.
    const existing = await getManifest(ctx.s3, finding.dataset_id, finding.version);
    if (existing !== null) {
      return { status: "skipped", message: "manifest already exists" };
    }

    let manifest: VersionManifest;
    try {
      manifest = await generateManifest(
        repoName,
        finding.version,
        ctx.githubPat,
        finding.dataset_id,
        details.doi,
        details.concept_doi,
      );
    } catch (err) {
      return {
        status: "failed",
        message: `generateManifest failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    try {
      await uploadManifest(
        ctx.s3,
        finding.dataset_id,
        finding.version,
        JSON.stringify(manifest, null, 2),
      );
    } catch (err) {
      return {
        status: "failed",
        message: `uploadManifest failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return {
      status: "fixed",
      message: "generated and uploaded manifest",
      details: { files_count: Object.keys(manifest.files).length },
    };
  },
};
