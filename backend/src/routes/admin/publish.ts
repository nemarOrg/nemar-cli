/**
 * Admin routes: publication workflow (list/deny/approve publication requests,
 * S3 Object Lock). The approve handler is the multi-step publication
 * orchestrator (#904 extracts it to a service in the next phase).
 *
 * Moved verbatim from routes/admin.ts in #903 (epic #902); the only
 * intentional changes are import paths, `adminRoutes` -> `admin`, and
 * audit-log INSERTs routed through auditLogStatement().
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { datasetLandingUrl } from "../../../../shared/datacite-constants.js";
import { auditLogStatement } from "../../db/audit-log";
import {
  type DataCiteEnrichment,
  nemarMetadataToEnrichment,
  parseNemarMetadata,
} from "../../services/datacite";
import {
  createEzidVersionDoi,
  parseDoiProvider,
  planReadmeBadgeCommit,
  resolveEzidAuth,
} from "../../services/doi";
import {
  resolveEmailConfig,
  sendPublicationApprovedEmail,
  sendPublicationDeniedEmail,
} from "../../services/email";
import { TEST_SHOULDER, makePublic as ezidMakePublic } from "../../services/ezid";
import {
  checkWorkflowExists,
  createOrUpdateFile,
  createRelease,
  createTag,
  deleteRepoFile,
  deployWorkflows,
  ensureRepoToSpec,
  getBlobContent,
  getMainBranchSha,
  getTreeAtRef,
  getWorkflowRuns,
  setRepoVisibility,
} from "../../services/github";
import { getDatasetsToken } from "../../services/github-auth";
import { generateManifest } from "../../services/manifest";
import { errorMessage, readRepoMetadata } from "../../services/repo-metadata";
import { mirrorReconcileRemovals, resolveRepoCollaborators } from "../../services/repo-spec";
import { withRetry } from "../../services/retry";
import {
  applyObjectLockBatch,
  getDatasetS3Stats,
  markDatasetPublic,
  uploadManifest,
  waitForPublicPropagation,
} from "../../services/s3";
import { publishDeposition } from "../../services/zenodo";
import { isCentralManifestWorkflowEnabled, publishEzidVersionDoiViaCentral } from "../webhooks";
import { getS3Config } from "./shared";
import type { AdminRouter } from "./shared";

/**
 * Valid publication workflow step names.
 * Steps execute in this order; completed steps are skipped on resume.
 */
type PublicationStep =
  | "ci_check"
  | "enrichment_check"
  | "repo_public"
  | "s3_public_read"
  | "tag_protect"
  | "doi_create"
  | "update_metadata"
  | "update_readme"
  | "create_tag"
  | "create_release"
  | "upload_to_zenodo"
  | "publish_doi"
  | "version_doi"
  | "s3_lock"
  | "sync_nemar"
  | "notify_user";

/**
 * Result of a single publication step, included in the API response.
 */
interface StepResult {
  step: PublicationStep;
  status: "completed" | "failed" | "skipped";
  attempts: number;
  duration_ms: number;
  error?: string;
}

export function registerPublishRoutes(admin: AdminRouter): void {
  // ============================================================================
  // Publication Workflow (Admin)
  // ============================================================================

  /**
   * GET /admin/publish/requests - List publication requests
   */
  admin.get("/publish/requests", async (c) => {
    const db = c.env.DB;
    const status = c.req.query("status");

    let query = `
    SELECT pr.*, u.username as requested_by_username, u.email as requested_by_email
    FROM publication_requests pr
    JOIN users u ON pr.requested_by = u.id
  `;
    const params: string[] = [];

    if (status) {
      query += " WHERE pr.status = ?";
      params.push(status);
    }

    query += " ORDER BY pr.requested_at DESC";

    const requests = await db
      .prepare(query)
      .bind(...params)
      .all<{
        id: number;
        dataset_id: string;
        status: string;
        requested_at: string;
        requested_by_username: string;
        requested_by_email: string;
        steps_completed: string;
        current_step: string | null;
        last_error: string | null;
        prescreen_status: string | null;
        prescreen_reasons: string | null;
        prescreen_issue_url: string | null;
      }>();

    return c.json({
      requests: requests.results.map((r) => ({
        ...r,
        steps_completed: JSON.parse(r.steps_completed || "[]"),
      })),
      count: requests.results.length,
    });
  });

  /**
   * POST /admin/publish/:id/deny - Deny a publication request
   */
  const denySchema = z.object({
    reason: z.string().min(1, "Reason is required").max(2000, "Reason too long"),
  });

  admin.post("/publish/:id/deny", zValidator("json", denySchema), async (c) => {
    const datasetId = c.req.param("id");
    const { reason } = c.req.valid("json");
    const adminUser = c.get("user");
    const db = c.env.DB;

    const request = await db
      .prepare(
        "SELECT id, status, requested_by FROM publication_requests WHERE dataset_id = ? AND status IN ('requested', 'approving', 'blocked') ORDER BY requested_at DESC LIMIT 1",
      )
      .bind(datasetId)
      .first<{ id: number; status: string; requested_by: number }>();

    if (!request) {
      return c.json({ error: "No active publication request found" }, 404);
    }

    await db
      .prepare(
        `UPDATE publication_requests
       SET status = 'denied', denied_at = datetime('now'), denied_by = ?, denied_reason = ?, updated_at = datetime('now')
       WHERE id = ?`,
      )
      .bind(adminUser.id, reason, request.id)
      .run();

    // Notify the requesting user
    try {
      const user = await db
        .prepare("SELECT username, email FROM users WHERE id = ?")
        .bind(request.requested_by)
        .first<{ username: string; email: string }>();

      if (user) {
        const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
        await sendPublicationDeniedEmail(
          user.email,
          user.username,
          datasetId,
          reason,
          c.env.RESEND_API_KEY,
          fromEmail,
          replyTo,
          isDev,
        );
      }
    } catch (emailError) {
      console.error("Failed to send denial email:", emailError);
    }

    return c.json({
      message: "Publication request denied",
      dataset_id: datasetId,
      reason,
    });
  });

  /**
   * POST /admin/publish/:id/approve - Approve and run publication orchestrator
   *
   * Steps:
   *  1. ci_check - Verify CI exists and is passing (deploy if missing)
   *  2. s3_public_read - Grant public read by removing the dataset's private
   *      carve-out from the bucket policy (see services/bucket-policy.ts). Runs
   *      first among the mutations (epic #736, Phase 4) for propagation lead time.
   *  3. repo_public - Make repository public
   *  4. tag_protect - Apply tag protection rules (prevent version tag deletion)
   *  5. doi_create - Create concept DOI if not exists
   *  6. update_metadata - Update dataset_description.json with DOI
   *  7. update_readme - Generate/update README with dataset info
   *  8. create_tag - Create git tag for the version
   *  9. create_release - Create GitHub release from tag
   * 10. upload_to_zenodo - Upload release archive to Zenodo
   * 11. publish_doi - Publish the Zenodo DOI (permanent and irreversible!)
   * 12. s3_lock - Apply S3 Object Lock (Governance mode)
   * 13. sync_nemar - Disabled no-op (legacy nemar.org sync retired, #837)
   * 14. notify_user - Send publication confirmation email
   *
   * (Archive zip generation is NOT an orchestrator step -- the central
   * run-version-doi.yml workflow dispatches generate-archive after the version
   * DOI mint; see #670.)
   *
   * Body: { resume?: boolean } - if true, skip already-completed steps
   */
  const approveSchema = z.object({
    resume: z.boolean().optional().default(false),
    sandbox: z.boolean().optional().default(false),
    s3_lock_continuation_token: z.string().optional(),
    // Total S3 object count for the dataset's `objects/` prefix. The server
    // computes this once on the first s3_lock call (when no continuation
    // token is sent) and returns it via `s3_lock_total` in every response;
    // the CLI threads it back on subsequent calls so progress reporting
    // ("Locking S3 objects: 1240/4963 (25.0%)") survives across the many
    // sequential Worker invocations a large dataset requires. See #284.
    s3_lock_total: z.number().int().nonnegative().optional(),
    // Pre-#385 CLIs (v0.8.4 and earlier) sent `s3_lock_offset` for
    // offset-paginated batching. The server no longer reads it AND no
    // longer returns it on the response, which means an old CLI's inner
    // pagination loop breaks out on the very first `hasMore: true`,
    // silently reporting "lock complete" after only the first batch — a
    // dataset published this way ends up with most objects unlocked. We
    // detect this case explicitly and reject with 426 so the admin sees a
    // clear "upgrade required" message instead of corrupt-by-omission
    // success.
    s3_lock_offset: z.number().optional(),
    skip_ci_check: z.boolean().optional().default(false),
  });

  admin.post("/publish/:id/approve", zValidator("json", approveSchema), async (c) => {
    const datasetId = c.req.param("id");
    const { resume, sandbox } = c.req.valid("json");
    const body = c.req.valid("json");
    const adminUser = c.get("user");
    const db = c.env.DB;

    // Refuse pre-#385 CLIs that still drive s3_lock by offset. See the
    // approveSchema comment for the silent-partial-lock failure mode this
    // prevents.
    if (body.s3_lock_offset !== undefined && body.s3_lock_continuation_token === undefined) {
      console.warn(
        `[publish] rejecting pre-0.8.5 CLI for ${datasetId}: s3_lock_offset is no longer supported`,
      );
      return c.json(
        {
          error: "Outdated nemar-cli; please upgrade to >=0.8.5 for S3 lock streaming",
          message:
            "This server uses S3 ListObjectsV2 continuation tokens for s3_lock. Upgrade with `bun add -g @nemarOrg/nemar-cli@latest` and re-run.",
        },
        // 426 Upgrade Required signals a strictly-non-retryable client problem
        // so the CLI's transient-error retry classifier won't mask it.
        426,
      );
    }

    // Find the publication request
    const request = await db
      .prepare(
        "SELECT id, status, steps_completed FROM publication_requests WHERE dataset_id = ? AND status IN ('requested', 'approving', 'blocked') ORDER BY requested_at DESC LIMIT 1",
      )
      .bind(datasetId)
      .first<{ id: number; status: string; steps_completed: string }>();

    if (!request) {
      return c.json({ error: "No active publication request found" }, 404);
    }

    const stepsCompleted: PublicationStep[] = resume
      ? JSON.parse(request.steps_completed || "[]")
      : [];
    const allSteps: readonly PublicationStep[] = [
      "ci_check",
      "enrichment_check",
      // Flip S3 public as early as possible (epic #736, Phase 4 / #741): it is the
      // first mutation after the validation gates, so the bucket-policy change has
      // the most time to propagate before create_tag fires generate-archive.
      "s3_public_read",
      "repo_public",
      "tag_protect",
      "doi_create",
      "update_metadata",
      "update_readme",
      "create_tag",
      "create_release",
      "upload_to_zenodo",
      "publish_doi", // Permanent and irreversible!
      "version_doi",
      "s3_lock",
      "sync_nemar",
      "notify_user",
    ] as const;
    const stepsToRun = allSteps.filter((s) => !stepsCompleted.includes(s));

    if (stepsToRun.length === 0) {
      return c.json({
        message: "All steps already completed",
        dataset_id: datasetId,
        status: "published",
      });
    }

    // Mark as approving
    await db
      .prepare(
        "UPDATE publication_requests SET status = 'approving', approved_by = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(adminUser.id, request.id)
      .run();

    // Get dataset info
    const dataset = await db
      .prepare(
        `SELECT d.*, u.username as owner_username, u.email as owner_email, u.orcid as owner_orcid
       FROM datasets d
       JOIN users u ON d.owner_user_id = u.id
       WHERE d.dataset_id = ?`,
      )
      .bind(datasetId)
      .first<{
        id: number;
        dataset_id: string;
        name: string;
        description: string | null;
        github_repo: string | null;
        concept_doi: string | null;
        zenodo_concept_id: string | null;
        ezid_identifier: string | null;
        ezid_status: string | null;
        doi_provider: string | null;
        is_sandbox: number | null;
        owner_username: string;
        owner_email: string;
        owner_orcid: string | null;
      }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    // Block publication of sandbox datasets
    if (dataset.dataset_id.startsWith("xx")) {
      return c.json(
        {
          error: "Cannot publish sandbox datasets",
          message: "Sandbox datasets (xx-prefix) are for testing only and cannot be published.",
          dataset_id: datasetId,
        },
        400,
      );
    }

    if (!dataset.github_repo) {
      return c.json({ error: "Dataset has no GitHub repository" }, 400);
    }

    const repoName = dataset.github_repo.split("/")[1];
    if (!repoName) {
      return c.json({ error: "Invalid repository format" }, 500);
    }

    const pat = await getDatasetsToken(c.env);
    const completed: PublicationStep[] = [...stepsCompleted];
    const requestId = request.id;
    const stepResults: StepResult[] = [];

    // Track step start time for duration measurement
    let currentStepStartMs = 0;

    // Captured at the end of the s3_lock step so the final success response
    // can include the last-batch count. The CLI accumulates `s3_lock_batch_count`
    // from every response (including the non-hasMore final one) to render the
    // completed percentage; omitting it from the final response means the CLI's
    // counter reads short by exactly the last batch. (#284)
    let s3LockFinalTotal: number | undefined;
    let s3LockFinalBatchCount: number | undefined;

    // Helper to set current step before execution. Non-fatal on failure.
    async function startStep(step: PublicationStep) {
      currentStepStartMs = Date.now();
      try {
        await db
          .prepare(
            "UPDATE publication_requests SET current_step = ?, updated_at = datetime('now') WHERE id = ?",
          )
          .bind(step, requestId)
          .run();
      } catch (dbErr) {
        console.error(`[publish] Failed to set current_step to ${step}:`, dbErr);
      }
    }

    // Helper to update progress in D1. Catches its own errors to avoid
    // masking the original failure when called inside catch blocks.
    async function updateProgress(step: PublicationStep, error?: string, attempts = 1) {
      const duration_ms = currentStepStartMs > 0 ? Date.now() - currentStepStartMs : 0;
      if (!error) {
        completed.push(step);
        stepResults.push({ step, status: "completed", attempts, duration_ms });
      } else {
        stepResults.push({ step, status: "failed", attempts, duration_ms, error });
      }
      try {
        await db
          .prepare(
            `UPDATE publication_requests
           SET steps_completed = ?, current_step = ?, last_error = ?, updated_at = datetime('now')
           WHERE id = ?`,
          )
          .bind(JSON.stringify(completed), error ? step : null, error || null, requestId)
          .run();
      } catch (dbErr) {
        console.error(
          `[publish] CRITICAL: Failed to update progress for step ${step}, dataset ${datasetId}:`,
          dbErr,
        );
      }
    }

    // Step 1: CI Check
    if (stepsToRun.includes("ci_check")) {
      if (body.skip_ci_check) {
        console.warn(`[publish] CI check skipped by admin ${adminUser.username} for ${datasetId}`);
        await updateProgress("ci_check");
      } else {
        try {
          await startStep("ci_check");

          const bidsExists = await checkWorkflowExists(
            repoName,
            ".github/workflows/bids-validation.yml",
            pat,
          );
          if (!bidsExists) {
            const deployResult = await deployWorkflows(repoName, pat);
            if (!deployResult.success) {
              throw new Error(
                `Failed to deploy CI workflows to ${repoName}: ${deployResult.errors.join("; ")}`,
              );
            }
          }

          // Check latest run status (if workflow existed, verify it passes)
          // Freshly deployed workflows have no runs yet, which is acceptable
          const runs = await getWorkflowRuns(repoName, "bids-validation.yml", pat);
          if (runs.length > 0) {
            const latest = runs[0];
            if (latest.conclusion === "failure") {
              await updateProgress("ci_check", "BIDS validation CI is failing");
              return c.json(
                {
                  error: "CI check failed: BIDS validation is failing",
                  dataset_id: datasetId,
                  step: "ci_check",
                  steps_completed: completed,
                  step_results: stepResults,
                },
                422,
              );
            }
          }

          await updateProgress("ci_check");
        } catch (err) {
          const msg = errorMessage(err);
          await updateProgress("ci_check", msg);
          return c.json(
            {
              error: `CI check failed: ${msg}`,
              step: "ci_check",
              steps_completed: completed,
              step_results: stepResults,
            },
            500,
          );
        }
      }
    }

    // Step 2: Enrichment check (warn-only, does not block publication)
    if (stepsToRun.includes("enrichment_check")) {
      try {
        await startStep("enrichment_check");

        const enrichRow = await db
          .prepare("SELECT enrichment_json FROM datasets WHERE dataset_id = ?")
          .bind(datasetId)
          .first<{ enrichment_json: string | null }>();

        if (!enrichRow?.enrichment_json) {
          console.warn(
            `[publish] Dataset ${datasetId} has no LLM enrichment metadata. DOI will have minimal metadata.`,
          );
        }

        await updateProgress("enrichment_check");
      } catch (err) {
        // Non-fatal: log error and continue (enrichment check should not block publication)
        console.warn(
          `[publish] Enrichment check failed for ${datasetId} (non-fatal): ${errorMessage(err)}`,
        );
        await updateProgress("enrichment_check");
      }
    }

    // Add the S3 public-read bucket policy (deny-list removal). Runs as the FIRST
    // mutation after the validation gates (epic #736, Phase 4 / #741) so the
    // bucket-policy change has the most time to propagate before create_tag fires
    // generate-archive.
    if (stepsToRun.includes("s3_public_read")) {
      try {
        await startStep("s3_public_read");

        const { attempts: s3PublicAttempts } = await withRetry(
          () => markDatasetPublic(getS3Config(c.env), datasetId),
          "s3_public_read",
        );

        // Non-fatal propagation gate: confirm a real blob is actually anonymously
        // readable, so a stuck/slow propagation is surfaced rather than silently
        // assumed (the nm000111 failure mode). Run it via waitUntil
        // (fire-and-forget) so its bounded poll (~10s) overlaps the subsequent
        // publish steps instead of adding serial latency toward the Worker
        // wall-clock limit -- the gate is observability-only and the cascade
        // proceeds regardless (Phase 1's signed reads removed the hard dependency).
        c.executionCtx.waitUntil(
          (async () => {
            try {
              const propagation = await waitForPublicPropagation(getS3Config(c.env), datasetId);
              if (propagation.checked && !propagation.propagated) {
                console.warn(
                  `[publish] s3_public_read: public access not yet propagated for ${datasetId} after ${propagation.attempts} probes (key=${propagation.key})`,
                );
              } else {
                console.log(
                  `[publish] s3_public_read: propagation ${
                    propagation.checked
                      ? `confirmed in ${propagation.attempts} probe(s)`
                      : "skipped (no annexed objects)"
                  } for ${datasetId}`,
                );
              }
            } catch (gateErr) {
              console.warn(
                `[publish] s3_public_read: propagation probe errored for ${datasetId} (non-fatal):`,
                gateErr instanceof Error ? gateErr.message : String(gateErr),
              );
            }
          })(),
        );

        await updateProgress("s3_public_read", undefined, s3PublicAttempts);
      } catch (err) {
        const msg = errorMessage(err);
        console.error(`[publish] S3 public read policy failed for ${datasetId}:`, err);
        await updateProgress("s3_public_read", msg);
        return c.json(
          {
            error: `S3 public read policy failed: ${msg}`,
            step: "s3_public_read",
            steps_completed: completed,
            step_results: stepResults,
          },
          500,
        );
      }
    }

    // Make the repository public (runs after the S3 public flip; the two are
    // independent, S3 goes first for propagation lead time).
    if (stepsToRun.includes("repo_public")) {
      try {
        await startStep("repo_public");

        const result = await setRepoVisibility(repoName, false, pat);
        if (!result.ok) {
          await updateProgress("repo_public", `Failed to make repo public: ${result.error}`);
          return c.json(
            {
              error: `Failed to make repo public: ${result.error}`,
              step: "repo_public",
              steps_completed: completed,
              step_results: stepResults,
            },
            500,
          );
        }

        // Update dataset visibility in database to match GitHub repo visibility
        let dbUpdateResult: D1Result;
        try {
          dbUpdateResult = await db
            .prepare(
              "UPDATE datasets SET visibility = 'public', updated_at = datetime('now') WHERE dataset_id = ?",
            )
            .bind(datasetId)
            .run();

          if (!dbUpdateResult.success) {
            throw new Error("Database update did not succeed");
          }

          if (dbUpdateResult.meta.changes === 0) {
            throw new Error("Dataset not found in database");
          }

          // Verify the write persisted (read-after-write check)
          const verify = await db
            .prepare("SELECT visibility FROM datasets WHERE dataset_id = ?")
            .bind(datasetId)
            .first<{ visibility: string }>();

          if (!verify || verify.visibility !== "public") {
            console.error(
              `[publish] CRITICAL: Visibility read-after-write mismatch for ${datasetId}: expected 'public', got '${verify?.visibility}'`,
            );
            throw new Error(
              `Read-after-write verification failed: visibility is '${verify?.visibility}' instead of 'public'`,
            );
          }
        } catch (dbError) {
          const msg = dbError instanceof Error ? dbError.message : String(dbError);
          console.error(
            `CRITICAL: Failed to update database visibility for ${datasetId} after making repo public:`,
            msg,
          );
          await updateProgress("repo_public", `Database visibility update failed: ${msg}`);
          return c.json(
            {
              error: "Critical: Database update failed after making repository public",
              details: msg,
              dataset_id: datasetId,
              github_visibility: "public",
              database_visibility: "private (update failed)",
              action_required: `Manually update database: UPDATE datasets SET visibility = 'public' WHERE dataset_id = '${datasetId}'`,
              step_results: stepResults,
            },
            500,
          );
        }

        // Enforce the published-repo spec (epic #713): lock main (ruleset,
        // green-gated) + reconcile collaborators. Non-fatal; visibility is
        // already public + verified above.
        let publishSpec: Awaited<ReturnType<typeof ensureRepoToSpec>> | undefined;
        try {
          const { ownerLogin, approvedWriters } = await resolveRepoCollaborators(db, datasetId);
          publishSpec = await ensureRepoToSpec(repoName, pat, {
            visibility: "public",
            collaborators: { ownerLogin, approvedWriters },
          });
          // Surface a non-green/failed protection step in the bulk-approval log,
          // since the orchestrator response does not carry the per-step detail.
          const offSteps = Object.entries(publishSpec.steps)
            .filter(([, s]) => s.status !== "ok")
            .map(([k, s]) => `${k}=${s.status}${s.detail ? `(${s.detail})` : ""}`);
          if (offSteps.length > 0) {
            console.warn(
              `[repo-spec] ${datasetId} enforcement non-ok steps: ${offSteps.join(", ")}`,
            );
          }
        } catch (specError) {
          console.error(`Repo-spec enforcement failed for ${datasetId} (non-fatal):`, specError);
        }
        // Mirror reconcile removals into D1 (own try/catch; flags a divergence).
        await mirrorReconcileRemovals(db, datasetId, publishSpec?.reconcile?.removed);

        await updateProgress("repo_public");
      } catch (err) {
        const msg = errorMessage(err);
        await updateProgress("repo_public", msg);
        return c.json(
          {
            error: `repo_public failed: ${msg}`,
            step: "repo_public",
            steps_completed: completed,
            step_results: stepResults,
          },
          500,
        );
      }
    }

    // Tag protection (before DOI to prevent tag manipulation)
    // Idempotent: applyTagProtection treats 422 (rule already exists) as
    // success and throws HttpError with status + body on terminal failure.
    // No inline withRetry: githubFetchWithRetry inside applyTagProtection
    // already absorbs short propagation 5xx/404 windows. Persistent failures
    // (e.g., GitHub "Repository has been locked" right after a visibility
    // flip) are surfaced as 500 so the CLI's retry-with-delay loop can
    // re-invoke from a fresh Worker (and a fresh propagation window).
    if (stepsToRun.includes("tag_protect")) {
      try {
        await startStep("tag_protect");

        const { applyTagProtection } = await import("../../services/github");
        await applyTagProtection(repoName, pat);

        await updateProgress("tag_protect");
      } catch (err) {
        const msg = errorMessage(err);
        await updateProgress("tag_protect", msg);
        return c.json(
          {
            error: `Tag protection failed: ${msg}`,
            step: "tag_protect",
            steps_completed: completed,
            step_results: stepResults,
          },
          500,
        );
      }
    }

    // Step 5: Create concept DOI (if not exists)
    if (stepsToRun.includes("doi_create")) {
      try {
        await startStep("doi_create");

        if (!dataset.concept_doi) {
          // SAFETY: Block production DOI creation in non-production environments
          if (!sandbox) {
            const environment = c.env.ENVIRONMENT;
            if (!environment) {
              await updateProgress("doi_create", "ENVIRONMENT variable not configured");
              return c.json(
                {
                  error: "Server misconfiguration: ENVIRONMENT variable not set",
                  message:
                    "Cannot create production DOIs without explicit environment configuration. Use --sandbox for testing.",
                  step: "doi_create",
                  steps_completed: completed,
                  step_results: stepResults,
                },
                500,
              );
            }
            const normalizedEnv = environment.toLowerCase().trim();
            if (normalizedEnv !== "production") {
              await updateProgress("doi_create", "Production DOI blocked in non-production");
              return c.json(
                {
                  error: "Production DOI creation blocked in non-production environment",
                  message: "Use --sandbox flag for testing, or deploy to production.",
                  environment: normalizedEnv,
                  step: "doi_create",
                  steps_completed: completed,
                  step_results: stepResults,
                },
                400,
              );
            }
          }

          // Determine provider: use dataset's setting or default to ezid
          const provider = parseDoiProvider(dataset.doi_provider);

          // Read BIDS metadata and enrichment for richer DOI records
          let bidsDesc: Record<string, unknown> | undefined;
          let enrichment: DataCiteEnrichment | undefined;
          if (repoName) {
            const descResult = await readDatasetDescription("doi_create");
            if (descResult instanceof Response) return descResult;
            bidsDesc = descResult;

            // Read .nemar/metadata.json enrichment (same pattern as doi update)
            const tree = await getTreeAtRef(repoName, "main", pat);
            const nemarMetaFile =
              tree.find((f) => f.path === ".nemar/metadata.json") ||
              tree.find((f) => f.path === "nemar_metadata.json");
            if (nemarMetaFile) {
              try {
                const nemarContent = await getBlobContent(repoName, nemarMetaFile.sha, pat);
                const nemarParsed = parseNemarMetadata(JSON.parse(nemarContent));
                if (nemarParsed) {
                  enrichment = nemarMetadataToEnrichment(nemarParsed);
                }
              } catch (nemarErr) {
                console.warn(
                  "[publish] doi_create: .nemar/metadata.json enrichment skipped:",
                  nemarErr,
                );
              }
            }
          }

          // EZID DOIs are deterministic (buildConceptIdentifier is a pure function
          // of datasetId), and createEzidConceptDoi already handles the
          // "already exists" case by fetching the existing record. That makes
          // EZID minting idempotent under retry, which is what we want here:
          // EZID/DataCite propagation can briefly fail with transient 5xx or
          // network errors during approval. Zenodo's createDeposition is NOT
          // idempotent (each call mints a fresh deposition), so we only retry
          // when the provider is EZID.
          const { createConceptDoi: doiDispatch } = await import("../../services/doi");
          const doiCall = () =>
            doiDispatch(
              {
                provider,
                datasetId,
                datasetName: dataset.name,
                datasetDescription: dataset.description,
                githubRepo: dataset.github_repo,
                bidsDescription: bidsDesc,
                enrichment,
                uploaderOrcid: dataset.owner_orcid || undefined,
                uploaderName: dataset.owner_username,
                sandbox,
              },
              {
                EZID_USERNAME: c.env.EZID_USERNAME,
                EZID_PASSWORD: c.env.EZID_PASSWORD,
                EZID_SANDBOX_USERNAME: c.env.EZID_SANDBOX_USERNAME,
                EZID_SANDBOX_PASSWORD: c.env.EZID_SANDBOX_PASSWORD,
                ZENODO_API_KEY: c.env.ZENODO_API_KEY,
                ZENODO_SANDBOX_API_KEY: c.env.ZENODO_SANDBOX_API_KEY,
              },
            );
          const { result: doiResult, attempts: doiAttempts } =
            provider === "ezid"
              ? await withRetry(doiCall, "doi_create")
              : { result: await doiCall(), attempts: 1 };
          if (provider === "ezid") {
            await db
              .prepare(
                "UPDATE datasets SET concept_doi = ?, ezid_identifier = ?, ezid_status = ?, doi_provider = 'ezid', is_sandbox = ?, updated_at = datetime('now') WHERE dataset_id = ?",
              )
              .bind(
                doiResult.doi,
                doiResult.providerRecordId,
                doiResult.status,
                sandbox ? 1 : 0,
                datasetId,
              )
              .run();
          } else {
            await db
              .prepare(
                "UPDATE datasets SET concept_doi = ?, zenodo_concept_id = ?, doi_provider = 'zenodo', is_sandbox = ?, updated_at = datetime('now') WHERE dataset_id = ?",
              )
              .bind(doiResult.doi, doiResult.providerRecordId, sandbox ? 1 : 0, datasetId)
              .run();
          }

          // Keep the in-memory `dataset` snapshot in sync with the DB write so
          // later steps in this same invocation (publish_doi, etc.) don't read
          // a stale null and fail with "No EZID identifier found".
          dataset.concept_doi = doiResult.doi;
          dataset.doi_provider = provider;
          dataset.is_sandbox = sandbox ? 1 : 0;
          if (provider === "ezid") {
            dataset.ezid_identifier = doiResult.providerRecordId;
            dataset.ezid_status = doiResult.status;
          } else {
            dataset.zenodo_concept_id = doiResult.providerRecordId;
          }

          await updateProgress("doi_create", undefined, doiAttempts);
        } else {
          await updateProgress("doi_create");
        }
      } catch (err) {
        const msg = errorMessage(err);
        await updateProgress("doi_create", msg);
        return c.json(
          {
            error: `DOI creation failed: ${msg}`,
            step: "doi_create",
            steps_completed: completed,
            step_results: stepResults,
          },
          500,
        );
      }
    }

    // --- Helper: read dataset_description.json from repo ---
    async function readDatasetDescription(
      stepName: PublicationStep,
    ): Promise<Record<string, unknown> | Response> {
      const tree = await getTreeAtRef(repoName, "main", pat);
      const descFile = tree.find((f) => f.path === "dataset_description.json");
      if (!descFile) {
        await updateProgress(stepName, "dataset_description.json not found in repo");
        return c.json(
          {
            error: "dataset_description.json not found in repository",
            step: stepName,
            steps_completed: completed,
            step_results: stepResults,
          },
          500,
        );
      }
      const content = await getBlobContent(repoName, descFile.sha, pat);
      try {
        return JSON.parse(content) as Record<string, unknown>;
      } catch (parseErr) {
        const parseMsg = `dataset_description.json contains invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`;
        console.error(
          `[publish] ${parseMsg} for ${repoName}. Content starts with: ${content.substring(0, 200)}`,
        );
        await updateProgress(stepName, parseMsg);
        return c.json(
          {
            error: parseMsg,
            step: stepName,
            steps_completed: completed,
            step_results: stepResults,
          },
          500,
        );
      }
    }

    // --- Helper: get concept DOI from database ---
    async function getConceptDoi(stepName: PublicationStep): Promise<string | Response> {
      const row = await db
        .prepare("SELECT concept_doi FROM datasets WHERE dataset_id = ?")
        .bind(datasetId)
        .first<{ concept_doi: string | null }>();
      if (!row?.concept_doi) {
        await updateProgress(stepName, "No concept DOI found");
        return c.json(
          {
            error: `Cannot run ${stepName}: no concept DOI found`,
            step: stepName,
            steps_completed: completed,
            step_results: stepResults,
          },
          500,
        );
      }
      return row.concept_doi;
    }

    // --- Helper: get Zenodo config from database ---
    async function getZenodoConfig(
      stepName: PublicationStep,
    ): Promise<{ depositionId: number; token: string; isSandbox: boolean } | Response> {
      const row = await db
        .prepare("SELECT zenodo_concept_id, is_sandbox FROM datasets WHERE dataset_id = ?")
        .bind(datasetId)
        .first<{ zenodo_concept_id: string | null; is_sandbox: number | null }>();
      if (!row?.zenodo_concept_id) {
        await updateProgress(stepName, "No Zenodo deposition found");
        return c.json(
          {
            error: "No Zenodo deposition ID found",
            step: stepName,
            steps_completed: completed,
            step_results: stepResults,
          },
          500,
        );
      }
      const depositionId = Number.parseInt(row.zenodo_concept_id, 10);
      if (Number.isNaN(depositionId)) {
        const msg = `Invalid Zenodo deposition ID: ${row.zenodo_concept_id}`;
        console.error(`[publish] ${msg} for dataset ${datasetId}`);
        await updateProgress(stepName, msg);
        return c.json(
          { error: msg, step: stepName, steps_completed: completed, step_results: stepResults },
          500,
        );
      }
      const isSandbox = row.is_sandbox === 1;
      const token = isSandbox ? c.env.ZENODO_SANDBOX_API_KEY : c.env.ZENODO_API_KEY;
      if (!token) {
        const msg = isSandbox
          ? "Zenodo sandbox API key not configured"
          : "Zenodo API key not configured";
        await updateProgress(stepName, msg);
        return c.json(
          { error: msg, step: stepName, steps_completed: completed, step_results: stepResults },
          500,
        );
      }
      return { depositionId, token, isSandbox };
    }

    // --- Helper: get version and tag from dataset_description.json ---
    // NOTE: This helper only reads; version defaulting is handled in update_metadata
    // to avoid creating [skip ci] commits that the create_tag step would tag.
    async function getVersionTag(
      stepName: PublicationStep,
    ): Promise<{ version: string; tag: string; datasetDesc: Record<string, unknown> } | Response> {
      const result = await readDatasetDescription(stepName);
      if (result instanceof Response) return result;
      const datasetDesc = result;
      const version = String(datasetDesc.Version || "1.0.0");
      return { version, tag: `v${version}`, datasetDesc };
    }

    // Step: update_metadata - Update dataset_description.json with DOI
    if (stepsToRun.includes("update_metadata")) {
      try {
        await startStep("update_metadata");

        // Get concept DOI (set by the doi_create step above)
        const doiResult = await getConceptDoi("update_metadata");
        if (doiResult instanceof Response) return doiResult;
        const conceptDoi = doiResult;

        const descResult = await readDatasetDescription("update_metadata");
        if (descResult instanceof Response) return descResult;
        const datasetDesc = descResult;

        // Preserve existing DatasetDOI in SourceDatasets before overwriting
        const existingDoi = datasetDesc.DatasetDOI;
        if (typeof existingDoi === "string" && existingDoi && existingDoi !== conceptDoi) {
          const sources: Array<Record<string, unknown>> = Array.isArray(datasetDesc.SourceDatasets)
            ? [...(datasetDesc.SourceDatasets as Array<Record<string, unknown>>)]
            : [];
          const alreadyPresent = sources.some(
            (s) => typeof s.DOI === "string" && s.DOI === existingDoi,
          );
          if (!alreadyPresent) {
            sources.push({ DOI: existingDoi });
            datasetDesc.SourceDatasets = sources;
            console.log(
              `[publish] Preserved existing DatasetDOI "${existingDoi}" in SourceDatasets for ${datasetId}`,
            );
          }
        }

        datasetDesc.DatasetDOI = conceptDoi;

        // Set default Version if missing so create_tag doesn't need to write a
        // separate [skip ci] commit (which would prevent the version-doi CI from
        // triggering on the tag push).
        if (!datasetDesc.Version) {
          console.info(
            `[publish] No Version in dataset_description.json for ${repoName}; defaulting to 1.0.0`,
          );
          datasetDesc.Version = "1.0.0";
        }

        await createOrUpdateFile(
          repoName,
          "dataset_description.json",
          JSON.stringify(datasetDesc, null, 2),
          `Update DatasetDOI with concept DOI: ${conceptDoi} [skip ci]`,
          pat,
        );

        await updateProgress("update_metadata");
      } catch (err) {
        const msg = errorMessage(err);
        console.error(`[publish] update_metadata failed for dataset ${datasetId}:`, err);
        await updateProgress("update_metadata", msg);
        return c.json(
          {
            error: `Metadata update failed: ${msg}`,
            step: "update_metadata",
            steps_completed: completed,
            step_results: stepResults,
          },
          500,
        );
      }
    }

    // Step: update_readme - Update README.md with DOI badge
    if (stepsToRun.includes("update_readme")) {
      try {
        await startStep("update_readme");

        const doiResult = await getConceptDoi("update_readme");
        if (doiResult instanceof Response) return doiResult;
        const conceptDoi = doiResult;
        const doiUrl = `https://doi.org/${conceptDoi}`;
        const doiProvider = parseDoiProvider(dataset.doi_provider);
        const badgeImg =
          doiProvider === "zenodo"
            ? `https://zenodo.org/badge/DOI/${conceptDoi}.svg`
            : `https://img.shields.io/badge/DOI-${encodeURIComponent(conceptDoi)}-blue`;
        const doiBadge = `[![DOI](${badgeImg})](${doiUrl})`;

        const tree = await getTreeAtRef(repoName, "main", pat);
        // Find all README variants in the repo
        const readmeCandidates = ["README.md", "README.rst", "README.txt", "README"];
        const foundReadmes: { path: string; sha: string }[] = [];
        for (const candidate of readmeCandidates) {
          const found = tree.find((f) => f.path === candidate);
          if (found) foundReadmes.push(found);
        }

        // Use the best available README for content (prefer README.md, then others in order)
        const contentSource = foundReadmes[0];
        let readmeContent = "";
        if (contentSource) {
          readmeContent = await getBlobContent(repoName, contentSource.sha, pat);
        } else {
          console.warn(
            `[publish] No README found in ${repoName}; creating README.md with DOI badge`,
          );
        }

        // Decide whether the README needs a commit. Skips the no-op case
        // (current badge already present in README.md) so --resume runs do
        // not stack empty "Add DOI badge" commits that re-trigger CI.
        const plan = planReadmeBadgeCommit({
          readmeContent,
          doiBadge,
          conceptDoi,
          contentSourcePath: contentSource?.path,
        });

        if (!plan.commit) {
          console.log(`[publish] update_readme skipping commit for ${repoName}: ${plan.reason}`);
        } else {
          await createOrUpdateFile(repoName, "README.md", plan.content, plan.message, pat);
        }

        // Delete any non-.md README files (handles both fresh rename and resume after partial run)
        for (const readme of foundReadmes) {
          if (readme.path === "README.md") continue;
          await deleteRepoFile(
            repoName,
            readme.path,
            readme.sha,
            `Remove old ${readme.path} (renamed to README.md)`,
            pat,
          );
          console.log(`[publish] Removed ${readme.path} from ${repoName} (using README.md)`);
          if (readme.path.endsWith(".rst")) {
            console.warn(
              `[publish] Warning: ${readme.path} was RST; content may not render correctly as Markdown`,
            );
          }
        }

        // Update GitHub repo description (name only) and homepage (DOI URL)
        const { setRepoDescription } = await import("../../services/github.js");
        const descResult = await setRepoDescription(
          repoName,
          dataset.name,
          pat,
          conceptDoi ? `https://doi.org/${conceptDoi}` : undefined,
        );
        let descWarning: string | undefined;
        if (!descResult.ok) {
          descWarning = `Repo description not set: ${descResult.error}`;
          console.warn(`[publish] ${descWarning}`);
        }

        await updateProgress("update_readme", descWarning);
      } catch (err) {
        const msg = errorMessage(err);
        console.error(`[publish] update_readme failed for dataset ${datasetId}:`, err);
        await updateProgress("update_readme", msg);
        return c.json(
          {
            error: `README update failed: ${msg}`,
            step: "update_readme",
            steps_completed: completed,
            step_results: stepResults,
          },
          500,
        );
      }
    }

    // Step: create_tag - Create git tag for version
    if (stepsToRun.includes("create_tag")) {
      try {
        await startStep("create_tag");

        const vtResult = await getVersionTag("create_tag");
        if (vtResult instanceof Response) return vtResult;
        const { tag, datasetDesc } = vtResult;

        const commitSha = await getMainBranchSha(repoName, "main", pat);

        const { attempts: createTagAttempts } = await withRetry(
          () =>
            createTag(
              repoName,
              tag,
              commitSha,
              `Release ${tag} - DOI: ${datasetDesc.DatasetDOI || "pending"}`,
              pat,
            ),
          "create_tag",
        );

        await updateProgress("create_tag", undefined, createTagAttempts);
      } catch (err) {
        const msg = errorMessage(err);
        console.error(`[publish] create_tag failed for dataset ${datasetId}:`, err);
        await updateProgress("create_tag", msg);
        return c.json(
          {
            error: `Tag creation failed: ${msg}`,
            step: "create_tag",
            steps_completed: completed,
            step_results: stepResults,
          },
          500,
        );
      }
    }

    // Step: create_release - Create GitHub release
    if (stepsToRun.includes("create_release")) {
      try {
        await startStep("create_release");

        const vtResult = await getVersionTag("create_release");
        if (vtResult instanceof Response) return vtResult;
        const { version, tag, datasetDesc } = vtResult;

        const nemarUrl = datasetLandingUrl(datasetId);
        const archiveLine = `**Download:** [${tag}.zip](https://github.com/nemarDatasets/${repoName}/archive/refs/tags/${tag}.zip)`;
        const sections = [
          `# ${dataset.name} - Version ${version}`,
          `BIDS-formatted dataset published via [NEMAR](${nemarUrl}).`,
          archiveLine,
        ];
        if (datasetDesc.DatasetDOI) {
          sections.push(`**DOI:** https://doi.org/${datasetDesc.DatasetDOI}`);
        }
        const releaseBody = sections.join("\n\n");

        const { attempts: createReleaseAttempts } = await withRetry(
          () => createRelease(repoName, tag, tag, releaseBody, pat),
          "create_release",
        );

        await updateProgress("create_release", undefined, createReleaseAttempts);
      } catch (err) {
        const msg = errorMessage(err);
        console.error(`[publish] create_release failed for dataset ${datasetId}:`, err);
        await updateProgress("create_release", msg);
        return c.json(
          {
            error: `Release creation failed: ${msg}`,
            step: "create_release",
            steps_completed: completed,
            step_results: stepResults,
          },
          500,
        );
      }
    }

    // Step: upload_to_zenodo - Disabled (EZID is now the DOI provider)
    // The step is kept in allSteps so existing DB records with upload_to_zenodo
    // in steps_completed remain valid.
    if (stepsToRun.includes("upload_to_zenodo")) {
      console.log("[publish] Zenodo upload skipped (disabled)");
      await updateProgress("upload_to_zenodo");
    }

    // Step: publish_doi - Publish DOI (permanent and irreversible!)
    if (stepsToRun.includes("publish_doi")) {
      try {
        await startStep("publish_doi");

        const provider = parseDoiProvider(dataset.doi_provider);

        if (provider === "ezid") {
          // EZID: transition the reserved DOI to public status
          if (!dataset.ezid_identifier) {
            await updateProgress("publish_doi", "No EZID identifier found");
            return c.json(
              {
                error: "No EZID identifier found for dataset",
                step: "publish_doi",
                steps_completed: completed,
                step_results: stepResults,
              },
              500,
            );
          }

          const auth = resolveEzidAuth(c.env, sandbox || !!dataset.is_sandbox);
          const target = datasetLandingUrl(datasetId);
          await ezidMakePublic(auth, dataset.ezid_identifier, target);

          // Update EZID status in D1
          try {
            await db
              .prepare(
                "UPDATE datasets SET ezid_status = 'public', updated_at = datetime('now') WHERE dataset_id = ?",
              )
              .bind(datasetId)
              .run();
          } catch (dbErr) {
            console.error(
              `[publish] CRITICAL: EZID DOI published but database update failed for ${datasetId}:`,
              dbErr,
            );
          }
        } else {
          // Zenodo: publish the deposition (irreversible)
          const zenodoResult = await getZenodoConfig("publish_doi");
          if (zenodoResult instanceof Response) return zenodoResult;
          const { depositionId, token: zenodoToken, isSandbox } = zenodoResult;

          const published = await publishDeposition(depositionId, zenodoToken, isSandbox);

          // After publish, Zenodo confirms the concept DOI; update the database record.
          // The DB update is in its own try/catch because the DOI is already published at
          // this point; a DB failure must not be reported as "DOI publication failed."
          if (published.doi) {
            try {
              await db
                .prepare(
                  "UPDATE datasets SET concept_doi = ?, updated_at = datetime('now') WHERE dataset_id = ?",
                )
                .bind(published.doi, datasetId)
                .run();
            } catch (dbErr) {
              console.error(
                `[publish] CRITICAL: DOI published on Zenodo (${published.doi}) but database update failed for ${datasetId}:`,
                dbErr,
              );
              await updateProgress(
                "publish_doi",
                `DOI published (${published.doi}) but DB update failed; manual correction required`,
              );
              return c.json(
                {
                  error: `DOI was published successfully (${published.doi}) but database update failed. Manual database correction required.`,
                  published_doi: published.doi,
                  step: "publish_doi",
                  steps_completed: completed,
                  step_results: stepResults,
                },
                500,
              );
            }
          } else {
            console.error(
              `[publish] Zenodo publish returned no DOI for dataset ${datasetId}; response:`,
              published,
            );
          }
        }

        await updateProgress("publish_doi");
      } catch (err) {
        const msg = errorMessage(err);
        console.error(`[publish] publish_doi failed for dataset ${datasetId}:`, err);
        await updateProgress("publish_doi", msg);
        return c.json(
          {
            error: `DOI publication failed: ${msg}`,
            step: "publish_doi",
            steps_completed: completed,
            step_results: stepResults,
          },
          500,
        );
      }
    }

    // Step: version_doi - Create version DOI record and manifest via webhook
    // This creates the version DOI record and manifest directly (same logic as
    // the publish-version-doi webhook). We can't self-fetch in Cloudflare Workers,
    // so we call the service functions directly. The central run-version-doi.yml
    // (Phase 2 of #601, on nemarDatasets/.github) serves as the
    // tag-push-triggered counterpart for PR/patch scenarios.
    if (stepsToRun.includes("version_doi")) {
      try {
        await startStep("version_doi");

        const vtResult = await getVersionTag("version_doi");
        if (vtResult instanceof Response) {
          // updateProgress was already called by readDatasetDescription inside getVersionTag
          // so we just mark completed to avoid double-recording and unnecessary retries
          await updateProgress("version_doi");
        } else {
          const { version } = vtResult;

          // Only stable semver versions get permanent DOIs (matches webhook guard)
          if (!/^\d+\.\d+\.\d+$/.test(version)) {
            console.info(
              `[publish] version_doi skipped for ${datasetId}: non-stable version "${version}"`,
            );
          }

          // Re-read dataset to get latest state (concept DOI may have been set in earlier steps)
          const freshDataset = !/^\d+\.\d+\.\d+$/.test(version)
            ? null
            : await db
                .prepare("SELECT * FROM datasets WHERE dataset_id = ?")
                .bind(datasetId)
                .first<{
                  id: number;
                  dataset_id: string;
                  name: string;
                  github_repo: string | null;
                  concept_doi: string | null;
                  ezid_identifier: string | null;
                  doi_provider: string | null;
                }>();

          if (!freshDataset) {
            // Non-stable version, or dataset disappeared during publish
            if (/^\d+\.\d+\.\d+$/.test(version)) {
              console.error(
                `[publish] version_doi: dataset ${datasetId} not found in D1 (deleted during publish?)`,
              );
            }
            await updateProgress("version_doi");
          } else if (!freshDataset.ezid_identifier) {
            console.info(`[publish] version_doi skipped for ${datasetId}: no EZID identifier`);
            await updateProgress("version_doi");
          } else if (!freshDataset.concept_doi) {
            console.info(`[publish] version_doi skipped for ${datasetId}: no concept DOI`);
            await updateProgress("version_doi");
          } else {
            // Auto-detect sandbox from EZID test shoulder prefix (both paths).
            const sandboxPrefix = TEST_SHOULDER.replace(/^doi:/, "").split("/")[0];
            const isSandboxDoi = freshDataset.ezid_identifier.includes(sandboxPrefix);

            if (isCentralManifestWorkflowEnabled(c.env)) {
              // Central flow (#751): cheap O(1) mint + dispatch. No inline
              // generateManifest (the file-count wall) and no inline
              // dataset_versions insert — /webhooks/manifest-ready owns the row
              // once the dispatched manifest job uploads to S3, the same single
              // owner as the tag-triggered webhook path.
              const minted = await publishEzidVersionDoiViaCentral(c.env, {
                dataset: freshDataset,
                repoName,
                version,
                sandbox: isSandboxDoi,
                pat,
                requestSource: "admin",
              });
              if (minted.warnings?.length) {
                for (const w of minted.warnings) {
                  console.warn(`[publish:version_doi] ${w}`);
                }
              }
              console.log(`[publish] Version DOI dispatched for ${datasetId}: ${minted.doi}`);
              await updateProgress(
                "version_doi",
                minted.warnings?.length
                  ? `DOI created (${minted.doi}) but: ${minted.warnings.join("; ")}`
                  : undefined,
              );
            } else {
              // LEGACY inline path (centralFlow disabled, e.g. prod before the
              // #751 cutover). Reads the full repo tree and generates the manifest
              // inline; retained unchanged for the pre-cutover env.
              const repoMeta = await readRepoMetadata(
                repoName,
                pat,
                undefined,
                freshDataset.name,
                `v${version}`,
              );
              for (const w of repoMeta.warnings) {
                console.warn("[publish:version_doi]", w);
              }

              // Query existing version DOIs for concept DOI HasVersion relations
              const versionRows = await db
                .prepare("SELECT doi FROM dataset_versions WHERE dataset_id = ?")
                .bind(datasetId)
                .all<{ doi: string }>();
              const existingVersionDois = versionRows.results.map((r) => r.doi);

              const result = await createEzidVersionDoi(
                {
                  EZID_USERNAME: c.env.EZID_USERNAME,
                  EZID_PASSWORD: c.env.EZID_PASSWORD,
                  EZID_SANDBOX_USERNAME: c.env.EZID_SANDBOX_USERNAME,
                  EZID_SANDBOX_PASSWORD: c.env.EZID_SANDBOX_PASSWORD,
                },
                {
                  datasetId,
                  conceptIdentifier: freshDataset.ezid_identifier,
                  version,
                  bidsDescription: repoMeta.bidsDescription,
                  githubRepo: freshDataset.github_repo || `nemarDatasets/${repoName}`,
                  sandbox: isSandboxDoi,
                  existingVersionDois,
                  enrichment: repoMeta.enrichment,
                },
              );

              // Surface warnings from DOI creation (e.g., concept DOI HasVersion update failed)
              if (result.warnings?.length) {
                for (const w of result.warnings) {
                  console.warn(`[publish:version_doi] ${w}`);
                }
              }

              // DOI is now public and permanent. DB and manifest failures below are
              // non-fatal but must be surfaced for operator awareness.
              let dbError: string | undefined;
              try {
                await db
                  .prepare(
                    "UPDATE datasets SET latest_version_doi = ?, updated_at = datetime('now') WHERE id = ?",
                  )
                  .bind(result.doi, freshDataset.id)
                  .run();

                await db
                  .prepare(
                    "INSERT OR IGNORE INTO dataset_versions (dataset_id, version, doi, provider) VALUES (?, ?, ?, 'ezid')",
                  )
                  .bind(datasetId, version, result.doi)
                  .run();
              } catch (err) {
                dbError = errorMessage(err);
                console.error(
                  `[publish] DOI ${result.doi} is PUBLIC but DB update failed for ${datasetId}:`,
                  err,
                );
              }

              // Generate and upload version manifest (proceeds regardless of DB failure)
              const manifest = await generateManifest(
                repoName,
                version,
                pat,
                datasetId,
                result.doi,
                freshDataset.concept_doi,
              );

              await uploadManifest(
                {
                  bucket: c.env.S3_BUCKET,
                  region: c.env.AWS_REGION,
                  accessKeyId: c.env.AWS_ACCESS_KEY_ID,
                  secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
                },
                datasetId,
                version,
                JSON.stringify(manifest, null, 2),
              );

              console.log(`[publish] Version DOI created for ${datasetId}: ${result.doi}`);
              const issues = [
                ...(dbError ? [`DB update failed: ${dbError}`] : []),
                ...(result.warnings || []),
              ];
              await updateProgress(
                "version_doi",
                issues.length ? `DOI created (${result.doi}) but: ${issues.join("; ")}` : undefined,
              );
            }
          }
        }
      } catch (err) {
        // Non-fatal: the CI workflow may still handle this as a fallback
        const msg = errorMessage(err);
        console.error(`[publish] version_doi failed for ${datasetId}: ${msg}`);
        await updateProgress("version_doi", msg);
      }
    }

    // Step 12: S3 Object Lock — streamed via S3 ListObjectsV2 continuation
    // tokens. Each invocation issues exactly one LIST page (capped to
    // batchSize keys via max-keys) plus up to batchSize PutObjectRetention
    // calls — bounded subrequest cost regardless of dataset size. The CLI
    // re-invokes with the returned `s3_lock_continuation_token` until
    // `hasMore` is false. Idempotent: 403 = already-locked = counted as
    // success, so retries on the same token are safe.
    //
    // The previous offset-based approach paginated the entire dataset on
    // every call (full LIST + 40-PUT slice), which compounded across
    // batches and tripped Cloudflare's per-invocation subrequest cap on
    // the SCCN deployment for datasets with even a few hundred objects
    // (#385).
    if (stepsToRun.includes("s3_lock")) {
      try {
        await startStep("s3_lock");

        // Count total objects once at the start of the s3_lock stream so the
        // CLI can render a real progress bar instead of just a running count
        // (#284). The CLI threads `s3_lock_total` back via the request body
        // on every subsequent call so we don't re-count per page.
        //
        // Subrequest budget note: the counting sweep uses ceil(N/1000) LIST
        // subrequests; for a 6500-object dataset that is ~7 LISTs on top of
        // the 1 LIST + 100 PUTs from applyObjectLockBatch. The Workers Paid
        // cap is 1000 subrequests, so we cap the sweep at 20 LISTs (20 000
        // objects). If the dataset is larger the count is skipped and the CLI
        // falls back to a running count without a denominator — better than
        // risking a "Too many subrequests" failure on the first invocation.
        const MAX_COUNT_LISTS = 20;
        let s3LockTotal = body.s3_lock_total;
        if (s3LockTotal === undefined && body.s3_lock_continuation_token === undefined) {
          const stats = await getDatasetS3Stats(getS3Config(c.env), datasetId, MAX_COUNT_LISTS);
          // stats.objectCount is undefined when the cap was hit; leave
          // s3LockTotal as undefined so the CLI shows "N locked" without a
          // denominator rather than an incorrect percentage.
          if (stats.objectCount !== undefined) {
            s3LockTotal = stats.objectCount;
          }
        }

        const lockResult = await applyObjectLockBatch(
          getS3Config(c.env),
          datasetId,
          body.s3_lock_continuation_token,
        );

        if (lockResult.failed.length > 0) {
          const msg = `${lockResult.locked} locked, ${lockResult.failed.length} failed`;
          await updateProgress("s3_lock", msg);
          return c.json(
            {
              error: `S3 lock partially failed: ${msg}`,
              step: "s3_lock",
              steps_completed: completed,
              step_results: stepResults,
              details: lockResult,
              // Echo the same token the caller sent so the CLI's retry
              // replays this exact batch (idempotent: 403=already-locked).
              // Without this echo, the CLI would lose its place and
              // re-stream from page 1 on retry.
              s3_lock_continuation_token: body.s3_lock_continuation_token,
              s3_lock_total: s3LockTotal,
              s3_lock_batch_count: lockResult.locked,
            },
            500,
          );
        }

        if (lockResult.hasMore) {
          // More pages to lock — return next continuation token for the
          // CLI to thread into its next invocation.
          return c.json({
            message: `S3 lock in progress: ${lockResult.locked} locked in this batch`,
            step: "s3_lock",
            steps_completed: completed,
            step_results: stepResults,
            s3_lock_continuation_token: lockResult.nextContinuationToken,
            s3_lock_total: s3LockTotal,
            s3_lock_batch_count: lockResult.locked,
            hasMore: true,
          });
        }

        // Capture values for the final success response so the CLI's running
        // counter reaches the true total (not short by the last batch).
        s3LockFinalTotal = s3LockTotal;
        s3LockFinalBatchCount = lockResult.locked;
        await updateProgress("s3_lock");
      } catch (err) {
        const msg = errorMessage(err);
        await updateProgress("s3_lock", msg);
        return c.json(
          {
            error: `S3 lock failed: ${msg}`,
            step: "s3_lock",
            steps_completed: completed,
            step_results: stepResults,
          },
          500,
        );
      }
    }

    // NOTE (#670): the archive is generated by the central run-version-doi.yml
    // workflow, which always dispatches `generate-archive` after minting the
    // version DOI. The `create_tag` step above pushes the `v*` tag, which fires
    // the GitHub App push webhook -> triggerVersionDoiRun -> run-version-doi.yml
    // -> generate-archive. A separate orchestrator-side `generate_archive` step
    // used to ALSO dispatch here, producing two redundant Generate Archive runs
    // per publish; it was removed (run-generate-archive.yml also gained an
    // S3 skip-if-exists guard as defense-in-depth).

    // Step 14: nemar.org datapipeline sync — disabled (epic #837 retired the legacy
    // dataexplorer coupling). Kept in allSteps + stepsToRun so existing
    // publication_requests step records stay valid; the step is now a logged no-op
    // (mirrors the disabled upload_to_zenodo step above).
    if (stepsToRun.includes("sync_nemar")) {
      console.log("[publish] nemar.org sync skipped (legacy datapipeline sync disabled)");
      await updateProgress("sync_nemar");
    }

    // Step 15: Notify user (non-fatal — mirrors sync_nemar pattern)
    let notifyUserWarning: string | undefined;
    if (stepsToRun.includes("notify_user")) {
      try {
        await startStep("notify_user");

        // Re-read DOI in case it was just created
        const updatedDataset = await db
          .prepare("SELECT concept_doi FROM datasets WHERE dataset_id = ?")
          .bind(datasetId)
          .first<{ concept_doi: string | null }>();

        const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
        await sendPublicationApprovedEmail(
          dataset.owner_email,
          dataset.owner_username,
          datasetId,
          updatedDataset?.concept_doi || null,
          c.env.RESEND_API_KEY,
          fromEmail,
          replyTo,
          isDev,
        );

        await updateProgress("notify_user");
      } catch (err) {
        const msg = errorMessage(err);
        // Non-fatal: email failure must not block publication after DOI is minted
        console.error(`[publish] notify_user failed for ${datasetId} (non-fatal): ${msg}`);
        notifyUserWarning = `Notification email failed: ${msg}`;
        try {
          await auditLogStatement(db, {
            userId: adminUser.id,
            action: "notify_user_failed",
            resourceType: "dataset",
            resourceId: datasetId,
            details: JSON.stringify({ error: msg, owner_email: dataset.owner_email }),
          }).run();
        } catch (auditErr) {
          console.warn(`[publish] Failed to write notify_user failure to audit log: ${auditErr}`);
        }
        await updateProgress("notify_user", msg);
      }
    }

    // Final consistency check: ensure dataset visibility matches GitHub state
    const finalCheck = await db
      .prepare("SELECT visibility FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ visibility: string }>();

    if (finalCheck && finalCheck.visibility !== "public") {
      console.warn(
        `[publish] Consistency fix: dataset ${datasetId} visibility was '${finalCheck.visibility}' at end of publish, correcting to 'public'`,
      );
      await db
        .prepare(
          "UPDATE datasets SET visibility = 'public', updated_at = datetime('now') WHERE dataset_id = ?",
        )
        .bind(datasetId)
        .run();
    }

    // Mark as published
    await db
      .prepare(
        `UPDATE publication_requests
       SET status = 'published', approved_at = datetime('now'), current_step = NULL, last_error = NULL, updated_at = datetime('now')
       WHERE id = ?`,
      )
      .bind(request.id)
      .run();

    // Audit log (non-fatal but warn user if fails)
    let auditLogFailed = false;
    let auditLogError: string | undefined;

    try {
      await auditLogStatement(db, {
        userId: adminUser.id,
        action: "dataset_published",
        resourceType: "dataset",
        resourceId: datasetId,
        details: JSON.stringify({ approved_by: adminUser.username, steps: allSteps }),
      }).run();
    } catch (auditError) {
      auditLogFailed = true;
      auditLogError = auditError instanceof Error ? auditError.message : String(auditError);
      console.error(
        "AUDIT LOG FAILURE: Dataset publication for",
        datasetId,
        "was not logged:",
        auditLogError,
      );
    }

    // Combine all non-fatal warnings into the response so operators can act
    // without tailing logs. Both warnings are optional and independent.
    const auditWarning = auditLogFailed
      ? `Audit log write failed: ${auditLogError}. Publication succeeded but was not logged for compliance.`
      : undefined;
    const responseWarnings = [auditWarning, notifyUserWarning].filter(Boolean);

    return c.json({
      message: "Dataset published successfully",
      dataset_id: datasetId,
      status: "published",
      steps_completed: allSteps,
      step_results: stepResults,
      // Always return the final s3_lock totals so the CLI's running counter
      // reaches the true total. Without these the last batch is never counted
      // and the progress display reads short by a full page (e.g. 3963/4963
      // instead of 4963/4963) even when locking succeeded. (#284)
      s3_lock_total: s3LockFinalTotal,
      s3_lock_batch_count: s3LockFinalBatchCount,
      warning: responseWarnings.length > 0 ? responseWarnings.join(" | ") : undefined,
    });
  });

  /**
   * POST /admin/datasets/:id/s3-lock - Apply S3 Object Lock to dataset
   *
   * Streamed via S3 ListObjectsV2 continuation tokens — see
   * `applyObjectLockBatch` for the per-invocation subrequest contract.
   */
  admin.post("/datasets/:id/s3-lock", async (c) => {
    const datasetId = c.req.param("id");
    const db = c.env.DB;
    const body = (await c.req.json().catch(() => ({}))) as { continuation_token?: string };

    const dataset = await db
      .prepare("SELECT dataset_id FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ dataset_id: string }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    try {
      const result = await applyObjectLockBatch(
        getS3Config(c.env),
        datasetId,
        body.continuation_token,
      );

      return c.json({
        message: result.failed.length === 0 ? "Batch locked" : "Some objects failed",
        dataset_id: datasetId,
        locked: result.locked,
        failed: result.failed.map((f) => ({ key: f.key, error: f.error })),
        hasMore: result.hasMore,
        continuation_token: result.nextContinuationToken,
      });
    } catch (err) {
      const msg = errorMessage(err);
      return c.json({ error: `S3 lock failed: ${msg}` }, 500);
    }
  });
}
