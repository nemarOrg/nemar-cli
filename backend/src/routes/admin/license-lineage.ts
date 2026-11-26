/**
 * Admin route: a dataset's upstream license lineage (epic #2182, card D1; ADR 0139 decision 7).
 *
 *   GET /admin/datasets/:id/license-lineage
 *
 * READ-ONLY and computed on demand: it reads the dataset's `dataset_description.json`, README and
 * `.nemar/metadata.json` from the default branch, and the deposit attestation's upstream source,
 * then runs the one shared resolver (`shared/license-lineage.ts`), the same one
 * `nemar dataset license-check` runs on a local copy. It writes nothing to D1, GitHub or S3. Each
 * registry answer is cached per DOI for 24 hours in the Worker cache; a failed fetch is not cached.
 *
 * 200 is the lineage result, whatever its outcome (an `unresolved` outcome is a finding, not an
 * error; a missing `dataset_description.json` is `unresolved`, never `no_upstream_declared`).
 * 422 is the same result when `dataset_description.json` or `.nemar/metadata.json` is there but is
 * not a JSON object (`result.inputs` and the source entry name the file). 400 is a malformed id;
 * 404 an unknown dataset; 409 a dataset with no repository; 502 a repository read that failed.
 */

import { type LineageResult, resolveLicenseLineage } from "../../../../shared/license-lineage.js";
import { README_CANDIDATES } from "../../../../shared/readme-candidates.js";
import { isValidDatasetId } from "../../services/datasetId";
import { getFileContent } from "../../services/github";
import { getDatasetsToken } from "../../services/github-auth";
import { workerLineageCache } from "../../services/license-lineage-cache";
import { extractRepoName } from "../../services/repo-metadata";
import type { Bindings } from "../../types/bindings";
import type { AdminRouter } from "./shared";

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function upstreamSourceOf(attestation: string | null): string | null {
  const parsed = parseJson(attestation);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const v = (parsed as Record<string, unknown>).upstream_source;
    return typeof v === "string" && v.trim() ? v : null;
  }
  return null;
}

/**
 * A dataset's lineage from its repository files at `ref` (default `main`) and its attestation, by
 * the one shared resolver. `ok: false` when a repository read failed: a lineage is never computed
 * from inputs that could not be read. Also used by the batch acknowledgment (card D3), which reads
 * at the screened commit.
 */
export async function readDatasetLineage(
  env: Bindings,
  args: { datasetId: string; repo: string; attestation: string | null; ref?: string },
): Promise<{ ok: true; result: LineageResult } | { ok: false }> {
  const ref = args.ref ?? "main";
  let description: string | null;
  let readme: string | null = null;
  let metadata: string | null;
  try {
    const token = await getDatasetsToken(env);
    description = await getFileContent(args.repo, "dataset_description.json", token, ref);
    for (const name of README_CANDIDATES) {
      readme = await getFileContent(args.repo, name, token, ref);
      if (readme !== null) break;
    }
    metadata = await getFileContent(args.repo, ".nemar/metadata.json", token, ref);
  } catch (err) {
    console.error(`[license-lineage] repository read failed for ${args.datasetId}:`, err);
    return { ok: false };
  }
  const result = await resolveLicenseLineage(
    {
      datasetDescription: description,
      nemarMetadata: metadata,
      attestationUpstreamSource: upstreamSourceOf(args.attestation),
      readme,
    },
    { cache: workerLineageCache() },
  );
  return { ok: true, result };
}

export function registerLicenseLineageRoutes(admin: AdminRouter): void {
  admin.get("/datasets/:id/license-lineage", async (c) => {
    const datasetId = c.req.param("id");
    if (!isValidDatasetId(datasetId)) {
      return c.json({ error: "Invalid dataset id" }, 400);
    }
    const row = await c.env.DB.prepare(
      "SELECT dataset_id, github_repo, attestation FROM datasets WHERE dataset_id = ?",
    )
      .bind(datasetId)
      .first<{ dataset_id: string; github_repo: string | null; attestation: string | null }>();
    if (!row) return c.json({ error: "Dataset not found" }, 404);
    const repo = row.github_repo ? extractRepoName(row.github_repo) : null;
    if (!repo) return c.json({ error: "The dataset has no repository to read" }, 409);

    const read = await readDatasetLineage(c.env, { datasetId, repo, attestation: row.attestation });
    if (!read.ok) {
      return c.json(
        { error: "The dataset's repository files could not be read; try again later" },
        502,
      );
    }
    const result = read.result;
    // A file that is there but cannot be parsed: 422 with the result, which names the file.
    // A missing description is a 200 whose outcome is `unresolved` (never no_upstream_declared).
    if (
      result.inputs.dataset_description === "unparseable" ||
      result.inputs.nemar_metadata === "unparseable"
    ) {
      return c.json({ dataset_id: row.dataset_id, ...result }, 422);
    }
    return c.json({ dataset_id: row.dataset_id, ...result });
  });
}
