/**
 * Admin routes: repository visibility, fleet governance (drift report,
 * enforce, revalidate; epic #713), and CI workflow management.
 *
 * Moved verbatim from routes/admin.ts in #903 (epic #902); the only
 * intentional changes are import paths, `adminRoutes` -> `admin`, and
 * audit-log INSERTs routed through auditLogStatement().
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { LIVE_DATASETS, isLiveDataset } from "../../constants";
import { auditLogStatement } from "../../db/audit-log";
import {
  type DriftBucket,
  classifyDatasetDrift,
  gatherRepoDriftState,
} from "../../services/fleet-drift";
import {
  checkWorkflowExists,
  deployWorkflows,
  ensureRepoToSpec,
  getBranchRulesetInfo,
  getMainBranchSha,
  getWorkflowRuns,
  setRepoVisibility,
  syncWorkflowTemplates,
  triggerBidsValidation,
  validateDeployedWorkflows,
} from "../../services/github";
import { getDatasetsToken } from "../../services/github-auth";
import { mirrorReconcileRemovals, resolveRepoCollaborators } from "../../services/repo-spec";
import {
  markDatasetPrivate,
  markDatasetPublic,
} from "../../services/s3";
import { getS3Config } from "./shared";
import type { AdminRouter } from "./shared";

export function registerFleetRoutes(admin: AdminRouter): void {
  // ============================================================================
  // Repository Visibility
  // ============================================================================

  const visibilitySchema = z.object({
    visibility: z.enum(["public", "private"]),
  });

  /**
   * PATCH /admin/datasets/:id/visibility - Change repository visibility
   */
  admin.patch("/datasets/:id/visibility", zValidator("json", visibilitySchema), async (c) => {
    const datasetId = c.req.param("id");
    const { visibility } = c.req.valid("json");
    const db = c.env.DB;
    const adminUser = c.get("user");

    const dataset = await db
      .prepare("SELECT dataset_id, github_repo FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ dataset_id: string; github_repo: string | null }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    if (!dataset.github_repo) {
      return c.json({ error: "Dataset has no GitHub repository" }, 400);
    }

    const repoName = dataset.github_repo.split("/")[1];
    if (!repoName) {
      return c.json({ error: "Invalid repository format" }, 500);
    }

    const isPrivate = visibility === "private";
    const pat = await getDatasetsToken(c.env);
    const result = await setRepoVisibility(repoName, isPrivate, pat);

    if (!result.ok) {
      return c.json({ error: `Failed to set repository to ${visibility}: ${result.error}` }, 500);
    }

    // Update S3 bucket policy based on visibility
    try {
      if (visibility === "public") {
        await markDatasetPublic(getS3Config(c.env), datasetId);
      } else {
        // Carve the dataset back out of public access when reverting to private
        await markDatasetPrivate(getS3Config(c.env), datasetId);
      }
    } catch (s3Error) {
      const s3Msg = s3Error instanceof Error ? s3Error.message : String(s3Error);
      console.error(`WARNING: Failed to update S3 policy for ${datasetId}:`, s3Msg);
      // GitHub visibility changed but S3 policy failed - revert GitHub
      const revertResult = await setRepoVisibility(repoName, !isPrivate, pat);
      if (revertResult.ok) {
        return c.json(
          {
            error: `Failed to update S3 bucket policy, reverted GitHub repository to ${isPrivate ? "public" : "private"}`,
            details: s3Msg,
            dataset_id: datasetId,
          },
          500,
        );
      }
      return c.json(
        {
          error: "CRITICAL: S3 policy update failed AND GitHub revert failed",
          details: s3Msg,
          dataset_id: datasetId,
          github_visibility: visibility,
          s3_public: visibility === "private",
          revert_error: revertResult.error,
          action_required: `Manually revert GitHub repo to ${isPrivate ? "public" : "private"} OR manually ${visibility === "public" ? "add" : "remove"} S3 public read policy for ${datasetId}`,
        },
        500,
      );
    }

    // Helper to revert GitHub + S3 visibility changes on DB failure
    async function revertVisibilityChanges(errorDetails: string): Promise<Response> {
      const ghRevertResult = await setRepoVisibility(repoName, !isPrivate, pat);

      let s3Reverted = false;
      try {
        const s3Opts = getS3Config(c.env);
        if (visibility === "public") {
          // We had granted public access; revert by re-carving it out
          await markDatasetPrivate(s3Opts, datasetId);
        } else {
          await markDatasetPublic(s3Opts, datasetId);
        }
        s3Reverted = true;
      } catch (s3RevertError) {
        console.error(`S3 policy revert failed for ${datasetId}:`, s3RevertError);
      }

      if (ghRevertResult.ok && s3Reverted) {
        return c.json(
          {
            error: "Database update failed, reverted GitHub and S3 to original state",
            details: errorDetails,
            dataset_id: datasetId,
          },
          500,
        );
      }

      return c.json(
        {
          error: "CRITICAL: Database update failed AND rollback incomplete",
          details: errorDetails,
          dataset_id: datasetId,
          github_visibility: visibility,
          github_reverted: ghRevertResult.ok,
          s3_reverted: s3Reverted,
          database_visibility: visibility === "public" ? "private" : "public",
          revert_error: ghRevertResult.ok ? undefined : ghRevertResult.error,
          action_required:
            `Manually fix: ${!ghRevertResult.ok ? `revert GitHub to ${!isPrivate ? "public" : "private"}` : ""} ${!s3Reverted ? `revert S3 policy for ${datasetId}` : ""} update database SET visibility = '${visibility}' WHERE dataset_id = '${datasetId}'`.trim(),
        },
        500,
      );
    }

    // Update dataset visibility in database to match GitHub repo
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

        return revertVisibilityChanges(errorDetails);
      }
    } catch (dbError) {
      const msg = dbError instanceof Error ? dbError.message : String(dbError);
      console.error(`CRITICAL: Exception updating database visibility for ${datasetId}:`, msg);

      return revertVisibilityChanges(msg);
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

    // Audit log (non-fatal but warn user if fails)
    let auditLogFailed = false;
    let auditLogError: string | undefined;

    try {
      await auditLogStatement(db, {
        userId: adminUser.id,
        action: "repo_visibility_changed",
        resourceType: "dataset",
        resourceId: datasetId,
        details: JSON.stringify({ visibility, changed_by: adminUser.username }),
      }).run();
    } catch (auditError) {
      auditLogFailed = true;
      auditLogError = auditError instanceof Error ? auditError.message : String(auditError);
      console.error(
        "AUDIT LOG FAILURE: Visibility change for dataset",
        datasetId,
        "was not logged:",
        auditLogError,
      );
    }

    return c.json({
      message: `Repository visibility set to ${visibility}`,
      dataset_id: datasetId,
      visibility,
      spec_enforcement: specEnforcement?.steps,
      warning: auditLogFailed
        ? `Audit log write failed: ${auditLogError}. Operation succeeded but was not logged for compliance.`
        : undefined,
    });
  });

  // ============================================================================
  // Fleet governance (epic #713)
  // ============================================================================

  /**
   * GET /admin/fleet/drift - Report dataset repos that are off the governance
   * spec. Read-only; gathers live GitHub state per repo (sequential, to respect
   * the shared App rate limit) and classifies into drift buckets. Filter with
   * ?prefix=nm, ?visibility=public|private, ?limit=N (default 25, max 50).
   */
  admin.get("/fleet/drift", async (c) => {
    const db = c.env.DB;
    const prefix = c.req.query("prefix");
    const visFilter = c.req.query("visibility");
    const limit = Math.min(
      Math.max(Number.parseInt(c.req.query("limit") ?? "25", 10) || 25, 1),
      50,
    );

    const clauses: string[] = ["github_repo IS NOT NULL", "dataset_id != 'nm099999'"];
    const binds: unknown[] = [];
    if (prefix) {
      clauses.push("dataset_id LIKE ?");
      binds.push(`${prefix}%`);
    }
    if (visFilter === "public" || visFilter === "private") {
      clauses.push("visibility = ?");
      binds.push(visFilter);
    }

    const rows = await db
      .prepare(
        `SELECT dataset_id, github_repo, visibility FROM datasets
        WHERE ${clauses.join(" AND ")} ORDER BY dataset_id LIMIT ?`,
      )
      .bind(...binds, limit)
      .all<{ dataset_id: string; github_repo: string; visibility: string }>();

    const datasets = rows.results ?? [];
    const pat = await getDatasetsToken(c.env);
    const buckets: Partial<Record<DriftBucket, string[]>> = {};
    const repos: Array<{ dataset_id: string; buckets: DriftBucket[] }> = [];

    for (const d of datasets) {
      const repoName = d.github_repo.split("/")[1];
      if (!repoName) continue;
      const visibility = d.visibility === "public" ? "public" : "private";
      let result: DriftBucket[];
      try {
        result = classifyDatasetDrift(await gatherRepoDriftState(repoName, visibility, pat));
      } catch (e) {
        console.error(`[fleet/drift] gather failed for ${d.dataset_id}:`, e);
        continue;
      }
      repos.push({ dataset_id: d.dataset_id, buckets: result });
      for (const b of result) {
        const list = buckets[b] ?? [];
        list.push(d.dataset_id);
        buckets[b] = list;
      }
    }

    const counts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));
    return c.json({ scanned: datasets.length, limit, counts, buckets, repos });
  });

  const enforceSchema = z.object({ dry_run: z.boolean().optional() });

  /**
   * POST /admin/datasets/:id/enforce - Bring one dataset repo to spec via
   * ensureRepoToSpec (public locks + reconciles; private removes the ruleset +
   * reconciles). `dry_run` defaults to TRUE (must pass `dry_run:false` to apply),
   * matching the bulk endpoint so a bare `{}` body never mutates.
   */
  admin.post("/datasets/:id/enforce", zValidator("json", enforceSchema), async (c) => {
    const datasetId = c.req.param("id");
    const dryRun = c.req.valid("json").dry_run !== false;
    const db = c.env.DB;

    // Live datasets hold real data; refuse to APPLY governance changes to them
    // without an explicit override. Dry-run (read-only) is always allowed.
    if (!dryRun && isLiveDataset(datasetId) && c.req.query("force") !== "true") {
      return c.json(
        {
          error: `Refusing to enforce live dataset ${datasetId}. Pass ?force=true to override.`,
        },
        403,
      );
    }

    const dataset = await db
      .prepare("SELECT github_repo, visibility FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ github_repo: string | null; visibility: string }>();
    if (!dataset) return c.json({ error: "Dataset not found" }, 404);
    if (!dataset.github_repo) return c.json({ error: "Dataset has no GitHub repository" }, 400);
    const repoName = dataset.github_repo.split("/")[1];
    if (!repoName) return c.json({ error: "Invalid repository format" }, 500);

    const visibility = dataset.visibility === "public" ? "public" : "private";
    const pat = await getDatasetsToken(c.env);
    const { ownerLogin, approvedWriters } = await resolveRepoCollaborators(db, datasetId);

    let result: Awaited<ReturnType<typeof ensureRepoToSpec>>;
    try {
      result = await ensureRepoToSpec(repoName, pat, {
        visibility,
        collaborators: { ownerLogin, approvedWriters },
        dryRun: dryRun,
      });
    } catch (e) {
      return c.json(
        { error: "Enforcement failed", details: e instanceof Error ? e.message : String(e) },
        500,
      );
    }

    if (!dryRun) await mirrorReconcileRemovals(db, datasetId, result.reconcile?.removed);
    return c.json({ dataset_id: datasetId, dry_run: dryRun, result });
  });

  /**
   * POST /admin/datasets/:id/revalidate - Re-run central BIDS validation on the
   * dataset's `main` HEAD so a fresh `Run BIDS Validation` check-run lands there
   * (the enforce green-gate only reads HEAD; a `[skip ci]` metadata commit leaves
   * it uncovered). Unifies the two cases the manual #713 rollout handled by hand:
   *   - inline workflow still present -> `syncWorkflowTemplates` commits the shim,
   *     and that push auto-triggers validation;
   *   - shim already deployed -> `triggerBidsValidation` dispatches it directly.
   * Already-protected repos are skipped (locked => no re-validation needed).
   * Live datasets are refused without `?force=true` (mirrors ci/sync, #730).
   * The CLI polls the resulting check-run, then runs `enforce` for the greens.
   */
  admin.post("/datasets/:id/revalidate", async (c) => {
    const datasetId = c.req.param("id");
    const db = c.env.DB;
    const adminUser = c.get("user");
    const force = c.req.query("force") === "true";

    if (isLiveDataset(datasetId) && !force) {
      return c.json(
        {
          error: `Refusing to revalidate live dataset ${datasetId}. Pass ?force=true to override.`,
        },
        403,
      );
    }

    const dataset = await db
      .prepare("SELECT github_repo FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ github_repo: string | null }>();
    if (!dataset) return c.json({ error: "Dataset not found" }, 404);
    if (!dataset.github_repo) return c.json({ error: "Dataset has no GitHub repository" }, 400);
    const repoName = dataset.github_repo.split("/")[1];
    if (!repoName) return c.json({ error: "Invalid repository format" }, 500);

    const pat = await getDatasetsToken(c.env);

    // Skip-if-locked: a protected repo is already green-gated; no need to churn it.
    try {
      const ruleset = await getBranchRulesetInfo(repoName, pat);
      if (ruleset.present && !force) {
        const headSha = await getMainBranchSha(repoName, "main", pat).catch(() => null);
        return c.json({ dataset_id: datasetId, skipped: "already_protected", head_sha: headSha });
      }
    } catch (e) {
      // Non-fatal: if we can't read the ruleset, fall through and revalidate.
      console.error(`[revalidate] ruleset check failed for ${datasetId}:`, e);
    }

    let triggeredBy: "sync" | "dispatch";
    let headSha: string;
    try {
      // Ensure the central shim is deployed. If it was inline, the sync commit
      // auto-triggers validation; re-read HEAD to point the caller at the new sha.
      const sync = await syncWorkflowTemplates(repoName, "main", pat);
      if (sync.listFailed) {
        return c.json(
          { error: "Workflow listing failed (transient?)", details: sync.errors.join("; ") },
          502,
        );
      }
      if (sync.errors.length > 0) {
        return c.json({ error: "Workflow sync failed", details: sync.errors.join("; ") }, 502);
      }
      if (sync.committed) {
        triggeredBy = "sync";
        headSha = await getMainBranchSha(repoName, "main", pat);
      } else {
        triggeredBy = "dispatch";
        headSha = await getMainBranchSha(repoName, "main", pat);
        await triggerBidsValidation(datasetId, headSha, pat);
      }
    } catch (e) {
      return c.json(
        { error: "Revalidation failed", details: e instanceof Error ? e.message : String(e) },
        500,
      );
    }

    try {
      await auditLogStatement(db, {
        userId: adminUser.id,
        action: "ci_revalidate",
        resourceType: "dataset",
        resourceId: datasetId,
        details: JSON.stringify({
          by: adminUser.username,
          triggered_by: triggeredBy,
          head_sha: headSha,
        }),
      }).run();
    } catch (auditError) {
      console.error("Audit log write failed for revalidate:", auditError);
    }

    return c.json({ dataset_id: datasetId, head_sha: headSha, triggered_by: triggeredBy });
  });

  const enforceBulkSchema = z.object({
    prefix: z.string().optional(),
    visibility: z.enum(["public", "private"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    dry_run: z.boolean().optional(),
  });

  /**
   * POST /admin/datasets/enforce/bulk - Run ensureRepoToSpec across a filtered set
   * SEQUENTIALLY (shared App rate limit). `dry_run` defaults to TRUE; pass
   * `dry_run:false` to actually apply. Always excludes nm099999. Owner-only.
   */
  admin.post("/datasets/enforce/bulk", zValidator("json", enforceBulkSchema), async (c) => {
    if (c.get("user").role !== "owner") {
      return c.json({ error: "Only the NEMAR owner can bulk-enforce" }, 403);
    }
    const db = c.env.DB;
    const { prefix, visibility, limit, dry_run } = c.req.valid("json");
    const dryRun = dry_run !== false; // default to a dry run
    const cap = limit ?? 25;

    // Never bulk-mutate the test dataset or any LIVE production dataset. The
    // values are compile-time constants (no user input), so inlining them is
    // injection-safe and mirrors the existing nm099999 literal.
    const liveList = [...LIVE_DATASETS].map((id) => `'${id}'`).join(", ");
    const clauses: string[] = [
      "github_repo IS NOT NULL",
      "dataset_id != 'nm099999'",
      `dataset_id NOT IN (${liveList})`,
    ];
    const binds: unknown[] = [];
    if (prefix) {
      clauses.push("dataset_id LIKE ?");
      binds.push(`${prefix}%`);
    }
    if (visibility) {
      clauses.push("visibility = ?");
      binds.push(visibility);
    }

    const rows = await db
      .prepare(
        `SELECT dataset_id, github_repo, visibility FROM datasets
        WHERE ${clauses.join(" AND ")} ORDER BY dataset_id LIMIT ?`,
      )
      .bind(...binds, cap)
      .all<{ dataset_id: string; github_repo: string; visibility: string }>();

    const datasets = rows.results ?? [];
    const pat = await getDatasetsToken(c.env);
    const results: Array<{
      dataset_id: string;
      steps?: Record<string, { status: string; detail?: string }>;
      error?: string;
    }> = [];

    for (const d of datasets) {
      const repoName = d.github_repo.split("/")[1];
      if (!repoName) {
        results.push({ dataset_id: d.dataset_id, error: "invalid repo format" });
        continue;
      }
      const vis = d.visibility === "public" ? "public" : "private";
      try {
        const { ownerLogin, approvedWriters } = await resolveRepoCollaborators(db, d.dataset_id);
        const spec = await ensureRepoToSpec(repoName, pat, {
          visibility: vis,
          collaborators: { ownerLogin, approvedWriters },
          dryRun: dryRun,
        });
        if (!dryRun) await mirrorReconcileRemovals(db, d.dataset_id, spec.reconcile?.removed);
        results.push({ dataset_id: d.dataset_id, steps: spec.steps });
      } catch (e) {
        results.push({
          dataset_id: d.dataset_id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return c.json({ dry_run: dryRun, count: datasets.length, results });
  });

  // ============================================================================
  // CI Management
  // ============================================================================

  /**
   * GET /admin/datasets/:id/ci - Check CI workflow status
   */
  admin.get("/datasets/:id/ci", async (c) => {
    const datasetId = c.req.param("id");
    const db = c.env.DB;

    const dataset = await db
      .prepare("SELECT dataset_id, github_repo FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ dataset_id: string; github_repo: string | null }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    if (!dataset.github_repo) {
      return c.json({ error: "Dataset has no GitHub repository" }, 400);
    }

    const repoName = dataset.github_repo.split("/")[1];
    if (!repoName) {
      return c.json({ error: "Invalid repository format" }, 500);
    }

    const pat = await getDatasetsToken(c.env);

    let bidsWorkflowExists = false;
    let versionCheckExists = false;
    let latestRunStatus = "unknown";
    let latestRunUrl: string | null = null;

    try {
      bidsWorkflowExists = await checkWorkflowExists(
        repoName,
        ".github/workflows/bids-validation.yml",
        pat,
      );

      versionCheckExists = await checkWorkflowExists(
        repoName,
        ".github/workflows/version-check.yml",
        pat,
      );

      if (bidsWorkflowExists) {
        const runs = await getWorkflowRuns(repoName, "bids-validation.yml", pat);
        if (runs.length > 0) {
          const latest = runs[0];
          latestRunStatus = latest.conclusion || latest.status;
          latestRunUrl = latest.html_url;
        } else {
          latestRunStatus = "no_runs";
        }
      }
    } catch (githubError) {
      const msg = githubError instanceof Error ? githubError.message : String(githubError);
      return c.json({ error: `GitHub API error: ${msg}` }, 502);
    }

    return c.json({
      dataset_id: datasetId,
      bids_validation: {
        present: bidsWorkflowExists,
        status: bidsWorkflowExists ? latestRunStatus : "missing",
        url: latestRunUrl,
      },
      version_check: {
        present: versionCheckExists,
      },
    });
  });

  /**
   * POST /admin/datasets/:id/ci - Deploy CI workflows to repository
   */
  admin.post("/datasets/:id/ci", async (c) => {
    const datasetId = c.req.param("id");
    const db = c.env.DB;
    const adminUser = c.get("user");

    // Deploying workflows commits to the repo's main branch (same class of
    // mutation as ci/sync). Live datasets hold real data; refuse without an
    // explicit override.
    if (isLiveDataset(datasetId) && c.req.query("force") !== "true") {
      return c.json(
        {
          error: `Refusing to modify live dataset ${datasetId}. Pass ?force=true to override.`,
        },
        403,
      );
    }

    const dataset = await db
      .prepare("SELECT dataset_id, github_repo FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ dataset_id: string; github_repo: string | null }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    if (!dataset.github_repo) {
      return c.json({ error: "Dataset has no GitHub repository" }, 400);
    }

    const repoName = dataset.github_repo.split("/")[1];
    if (!repoName) {
      return c.json({ error: "Invalid repository format" }, 500);
    }

    // Post-deploy parseability check moved out of the Worker (issue #472).
    // The CLI polls POST /admin/datasets/:id/ci/validate after this returns.
    // The legacy ?validate=false query param is accepted but ignored — old
    // CLIs that sent it still get a successful, fast deploy.
    const result = await deployWorkflows(repoName, await getDatasetsToken(c.env));

    if (!result.success) {
      return c.json(
        {
          error: "Failed to deploy some workflows",
          deployed: result.deployed,
          failed: result.errors,
        },
        500,
      );
    }

    try {
      await auditLogStatement(db, {
        userId: adminUser.id,
        action: "ci_workflows_deployed",
        resourceType: "dataset",
        resourceId: datasetId,
        details: JSON.stringify({ deployed_by: adminUser.username }),
      }).run();
    } catch (auditError) {
      console.error("Audit log write failed for CI deploy:", auditError);
    }

    return c.json({
      message: "CI workflows deployed successfully",
      dataset_id: datasetId,
      workflows_deployed: result.deployed,
    });
  });

  /**
   * POST /admin/datasets/:id/ci/validate - One-shot parseability probe.
   *
   * Called by the CLI after the deploy endpoint returns. The CLI handles the
   * indexing-lag wait and retry on its own machine, keeping the Worker
   * wall-clock budget out of the loop (issue #472).
   *
   * Returns valid/missing/errors for the workflows defined by the current
   * template set. Best-effort: a 500 from GitHub or a transport error lands in
   * `errors` rather than failing the response.
   *
   * Verb choice: this is a read-only probe and a strict REST reading would
   * favor GET. We keep POST to stay consistent with the rest of the ci/*
   * family (POST /ci to deploy, POST /ci/sync to bring drift back in line —
   * both admin-only RPC-style operations). Mixing verbs across the family
   * would surprise admin tooling that scripts these endpoints.
   */
  admin.post("/datasets/:id/ci/validate", async (c) => {
    const datasetId = c.req.param("id");
    const db = c.env.DB;

    const dataset = await db
      .prepare("SELECT dataset_id, github_repo FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ dataset_id: string; github_repo: string | null }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }
    if (!dataset.github_repo) {
      return c.json({ error: "Dataset has no GitHub repository" }, 400);
    }
    const repoName = dataset.github_repo.split("/")[1];
    if (!repoName) {
      return c.json({ error: "Invalid repository format" }, 500);
    }

    const result = await validateDeployedWorkflows(repoName, await getDatasetsToken(c.env));
    return c.json({
      dataset_id: datasetId,
      valid: result.valid,
      missing: result.missing,
      errors: result.errors,
    });
  });

  /**
   * POST /admin/datasets/:id/ci/sync - Bring deployed CI workflows in sync with
   * the current templates. Only files that drift or are missing are written,
   * in a single tree commit. Idempotent and cheap when nothing has changed
   * (single Contents-API listing).
   */
  admin.post("/datasets/:id/ci/sync", async (c) => {
    const datasetId = c.req.param("id");
    const db = c.env.DB;
    const adminUser = c.get("user");

    // ci/sync commits to the repo's main branch (overwrites workflow files).
    // Live datasets hold real data; refuse without an explicit override.
    if (isLiveDataset(datasetId) && c.req.query("force") !== "true") {
      return c.json(
        {
          error: `Refusing to modify live dataset ${datasetId}. Pass ?force=true to override.`,
        },
        403,
      );
    }

    const dataset = await db
      .prepare("SELECT dataset_id, github_repo FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ dataset_id: string; github_repo: string | null }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }
    if (!dataset.github_repo) {
      return c.json({ error: "Dataset has no GitHub repository" }, 400);
    }

    const repoName = dataset.github_repo.split("/")[1];
    if (!repoName) {
      return c.json({ error: "Invalid repository format" }, 500);
    }

    const result = await syncWorkflowTemplates(repoName, "main", await getDatasetsToken(c.env));

    try {
      await auditLogStatement(db, {
        userId: adminUser.id,
        action: "ci_workflows_synced",
        resourceType: "dataset",
        resourceId: datasetId,
        details: JSON.stringify({
          synced_by: adminUser.username,
          changed: result.changed,
          added: result.added,
          errors: result.errors,
          committed: result.committed,
          list_failed: result.listFailed,
        }),
      }).run();
    } catch (auditError) {
      console.error("Audit log write failed for CI sync:", auditError);
    }

    // 207 (Multi-Status) when the call surfaced any partial failures so
    // automation and `--all` loops don't false-green on partial errors.
    const status = result.errors.length > 0 ? 207 : 200;
    return c.json(
      {
        dataset_id: datasetId,
        checked: result.checked,
        changed: result.changed,
        added: result.added,
        errors: result.errors,
        committed: result.committed,
        list_failed: result.listFailed,
      },
      status,
    );
  });
}
