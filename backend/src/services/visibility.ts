/**
 * Dataset visibility transition (extracted from routes/admin/fleet.ts's
 * PATCH /datasets/:id/visibility handler, epic #967 phase 4 / #971).
 *
 * Orchestrates the multi-surface, reversible visibility flip that both the
 * admin visibility route and the new withdraw/restore services need: GitHub
 * repo visibility -> S3 deny-list carve-out -> D1 `visibility` column ->
 * repo-spec enforcement (public locks main, private opens it) -> collaborator
 * reconcile mirror. GitHub and S3 are reverted on a later-stage failure so the
 * three surfaces never end up disagreeing; D1 is the last write, so a D1
 * failure triggers reverting BOTH GitHub and S3.
 *
 * Named `applyDatasetVisibility` (not `transitionDatasetVisibility`) because
 * s3.ts already has a private, differently-scoped function of that name (the
 * bucket-policy read-modify-write retry loop this function calls into via
 * markDatasetPrivate/markDatasetPublic).
 *
 * Deliberately transport-agnostic: returns a structured result rather than a
 * Response, so routes/admin/fleet.ts can reconstruct its exact pre-existing
 * JSON error shapes, and services/withdraw.ts can just check `.ok`. Audit
 * logging is left to the caller (the action name/details differ per caller:
 * "repo_visibility_changed" for the direct route vs "dataset_withdrawn" for
 * the withdraw service).
 */

import type { Bindings } from "../types/bindings.js";
import { getDatasetsToken } from "./github-auth.js";
import { ensureRepoToSpec, setRepoVisibility } from "./github.js";
import { mirrorReconcileRemovals, resolveRepoCollaborators } from "./repo-spec.js";
import { type PresignedUrlOptions, markDatasetPrivate, markDatasetPublic } from "./s3.js";

export type VisibilityTransitionResult =
  | {
      ok: true;
      repoName: string;
      specEnforcement?: Awaited<ReturnType<typeof ensureRepoToSpec>>;
    }
  | { ok: false; stage: "not_found" | "no_repo" | "invalid_repo" | "github"; error: string }
  | { ok: false; stage: "s3"; error: string; githubReverted: boolean; revertError?: string }
  | {
      ok: false;
      stage: "db";
      error: string;
      githubReverted: boolean;
      s3Reverted: boolean;
      revertError?: string;
    };

function s3Options(env: Bindings): PresignedUrlOptions {
  return {
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  };
}

async function setDatasetPublicity(
  env: Bindings,
  datasetId: string,
  visibility: "public" | "private",
): Promise<void> {
  if (visibility === "public") {
    await markDatasetPublic(s3Options(env), datasetId);
  } else {
    await markDatasetPrivate(s3Options(env), datasetId);
  }
}

/**
 * Apply a visibility transition to a dataset: GitHub repo + S3 bucket policy +
 * D1 `visibility` column + repo-spec enforcement, with revert-on-failure at
 * every later stage. Mirrors the pre-extraction inline handler in fleet.ts
 * exactly; see that file for the resulting HTTP response shapes.
 */
export async function applyDatasetVisibility(
  env: Bindings,
  datasetId: string,
  visibility: "public" | "private",
): Promise<VisibilityTransitionResult> {
  const db = env.DB;

  const dataset = await db
    .prepare("SELECT dataset_id, github_repo FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ dataset_id: string; github_repo: string | null }>();

  if (!dataset) {
    return { ok: false, stage: "not_found", error: "Dataset not found" };
  }
  if (!dataset.github_repo) {
    return { ok: false, stage: "no_repo", error: "Dataset has no GitHub repository" };
  }
  const repoName = dataset.github_repo.split("/")[1];
  if (!repoName) {
    return { ok: false, stage: "invalid_repo", error: "Invalid repository format" };
  }

  const isPrivate = visibility === "private";
  const pat = await getDatasetsToken(env);
  const ghResult = await setRepoVisibility(repoName, isPrivate, pat);
  if (!ghResult.ok) {
    return {
      ok: false,
      stage: "github",
      error: `Failed to set repository to ${visibility}: ${ghResult.error}`,
    };
  }

  try {
    await setDatasetPublicity(env, datasetId, visibility);
  } catch (s3Error) {
    const s3Msg = s3Error instanceof Error ? s3Error.message : String(s3Error);
    console.error(`WARNING: Failed to update S3 policy for ${datasetId}:`, s3Msg);
    // GitHub visibility changed but S3 policy failed - revert GitHub.
    const revertResult = await setRepoVisibility(repoName, !isPrivate, pat);
    return {
      ok: false,
      stage: "s3",
      error: s3Msg,
      githubReverted: revertResult.ok,
      revertError: revertResult.ok ? undefined : revertResult.error,
    };
  }

  // Helper to revert GitHub + S3 visibility changes on a D1 failure.
  async function revertAfterDbFailure(errorDetails: string): Promise<VisibilityTransitionResult> {
    const ghRevertResult = await setRepoVisibility(repoName, !isPrivate, pat);

    let s3Reverted = false;
    try {
      // We had applied `visibility`; revert to the opposite.
      await setDatasetPublicity(env, datasetId, isPrivate ? "public" : "private");
      s3Reverted = true;
    } catch (s3RevertError) {
      console.error(`S3 policy revert failed for ${datasetId}:`, s3RevertError);
    }

    return {
      ok: false,
      stage: "db",
      error: errorDetails,
      githubReverted: ghRevertResult.ok,
      s3Reverted,
      revertError: ghRevertResult.ok ? undefined : ghRevertResult.error,
    };
  }

  let dbUpdateResult: D1Result;
  try {
    dbUpdateResult = await db
      .prepare("UPDATE datasets SET visibility = ? WHERE dataset_id = ?")
      .bind(visibility, datasetId)
      .run();

    if (!dbUpdateResult.success || dbUpdateResult.meta.changes === 0) {
      const errorDetails =
        dbUpdateResult.meta.changes === 0
          ? "Dataset not found in database"
          : "Database update did not succeed";
      console.error(
        `CRITICAL: Failed to update database visibility for ${datasetId}. GitHub is now ${visibility} but database is out of sync.`,
      );
      return await revertAfterDbFailure(errorDetails);
    }
  } catch (dbError) {
    const msg = dbError instanceof Error ? dbError.message : String(dbError);
    console.error(`CRITICAL: Exception updating database visibility for ${datasetId}:`, msg);
    return await revertAfterDbFailure(msg);
  }

  // Enforce the target repo spec for the new visibility (epic #713): public ->
  // lock main (branch + tag ruleset, green-gated) + reconcile collaborators;
  // private -> remove the branch ruleset + reconcile. Non-fatal: visibility is
  // already changed at GitHub/S3/D1.
  let specEnforcement: Awaited<ReturnType<typeof ensureRepoToSpec>> | undefined;
  try {
    const { ownerLogin, approvedWriters } = await resolveRepoCollaborators(db, datasetId);
    specEnforcement = await ensureRepoToSpec(repoName, pat, {
      visibility,
      collaborators: { ownerLogin, approvedWriters },
    });
  } catch (specError) {
    console.error(`Repo-spec enforcement failed for ${datasetId} (non-fatal):`, specError);
  }
  // Mirror reconcile removals into D1 (own try/catch; flags a divergence).
  await mirrorReconcileRemovals(db, datasetId, specEnforcement?.reconcile?.removed);

  return { ok: true, repoName, specEnforcement };
}
