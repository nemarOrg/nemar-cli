/**
 * User-facing publication workflow: publish request/status/resend, CI status,
 * and POST /:id/publish (make-public). The make-public route physically sat
 * after the Version Manifests section in the monolith; it is registered with
 * its concern group here (all cross-file same-method paths are structurally
 * disjoint, and the route-inventory pin is unordered).
 *
 * Moved verbatim from routes/datasets.ts (#906, epic #902); the only
 * intentional changes are import paths and the register-function wrapper.
 */

import { authMiddleware } from "../../middleware/auth";
import { isValidDatasetId } from "../../services/datasetId";
import {
  getAdminEmailsForCategory,
  resolveEmailConfig,
  sendPublicationRequestEmail,
} from "../../services/email";
import { isExemplarPublishAllowed } from "../../services/exemplar";
import {
  checkWorkflowExists,
  deployWorkflows,
  ensureRepoToSpec,
  getFileContent,
  getWorkflowRuns,
  setRepoVisibility,
  signPrescreenCallbackToken,
  triggerPrescreenRun,
} from "../../services/github";
import { getDatasetsToken } from "../../services/github-auth";
import { mirrorReconcileRemovals, resolveRepoCollaborators } from "../../services/repo-spec";
import { markDatasetPrivate, markDatasetPublic } from "../../services/s3";
import {
  SUBMISSION_POLICY_URL,
  evaluateSubmissionMinimums,
} from "../../services/submission-minimums";
import { hasRole } from "../../types/bindings";
import { extractRepoName } from "./shared";
import type { DatasetsRouter } from "./shared";

// User-facing messages for each publication block reason
const BLOCK_MESSAGES: Record<string, string> = {
  bids_validation_failed:
    "BIDS validation is failing on your dataset. Please check the repository CI and fix validation errors, then re-request publication.",
  bids_validation_pending:
    "BIDS validation has not run yet. Please wait for CI to complete, then re-request publication.",
  bids_validation_in_progress:
    "BIDS validation is currently running. Please wait for it to complete, then re-request publication.",
  // Legacy only: the pre-screen no longer blocks (#756), so new rows never get
  // this block_reason. Kept (without the now-removed repo-issue reference) so a
  // pre-deploy 'blocked' row still renders a sensible message until re-request.
  prescreen_failed:
    "The automated pre-screen flagged missing publication essentials (data, README, or dataset_description). Address the gaps and re-request publication; the pre-screen now runs as a non-blocking advisory.",
  // No policy URL in the message: the response carries policy_url separately
  // and the CLI renders it once, alongside the itemized reasons.
  min_requirements_failed:
    "The dataset does not meet the minimum submission requirements. Fix the stated items and re-request publication.",
};

export function registerPublicationRoutes(datasetRoutes: DatasetsRouter): void {
  // ============================================================================
  // Publication Workflow (User-facing)
  // ============================================================================

  /**
   * POST /datasets/:id/publish/request - Request publication of a dataset
   */
  datasetRoutes.post("/:id/publish/request", authMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const currentUser = c.get("user");
    const db = c.env.DB;

    const dataset = await db
      .prepare(
        "SELECT id, dataset_id, owner_user_id, is_sandbox, is_exemplar, github_repo, visibility, source FROM datasets WHERE dataset_id = ?",
      )
      .bind(datasetId)
      .first<{
        id: number;
        dataset_id: string;
        owner_user_id: number;
        is_sandbox: number | null;
        is_exemplar: number | null;
        github_repo: string | null;
        visibility: string | null;
        source: string | null;
      }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    if (dataset.owner_user_id !== currentUser.id && !hasRole(currentUser.role, "admin")) {
      return c.json({ error: "Only the dataset owner can request publication" }, 403);
    }

    // Block sandbox/xx, except staging exemplars (epic #923).
    if (
      (dataset.is_sandbox || dataset.dataset_id.startsWith("xx")) &&
      !isExemplarPublishAllowed(c.env, dataset)
    ) {
      return c.json({ error: "Cannot publish sandbox datasets" }, 400);
    }

    if (dataset.visibility === "public") {
      return c.json({ error: "Dataset is already published" }, 409);
    }

    // Check for existing active request (allow re-checking blocked requests)
    const existing = await db
      .prepare(
        "SELECT id, status, block_reason FROM publication_requests WHERE dataset_id = ? AND status IN ('requested', 'approving', 'blocked') ORDER BY requested_at DESC LIMIT 1",
      )
      .bind(datasetId)
      .first<{ id: number; status: string; block_reason: string | null }>();

    if (existing && existing.status !== "blocked") {
      return c.json(
        {
          error: "A publication request already exists",
          status: existing.status,
          message:
            existing.status === "approving"
              ? "Publication is in progress"
              : "Use 'resend' to remind admins",
        },
        409,
      );
    }

    // For blocked requests, re-run readiness checks instead of creating a new one
    const requestId = existing?.id;

    // Run readiness checks: deploy CI if missing, check BIDS validation
    const repoName = dataset.github_repo?.split("/")[1];
    let blocked = false;
    let blockReason: string | null = null;
    const ciUrl = repoName ? `https://github.com/nemarDatasets/${repoName}/actions` : undefined;

    // Resolve auth inside the try so a missing or unconfigured token blocks
    // the request the same way other CI infrastructure failures do, rather
    // than 500-ing the request before we've even recorded a row.
    let pat: string | null = null;
    if (repoName) {
      try {
        pat = await getDatasetsToken(c.env);
        // Deploy CI workflows if missing
        const hasWorkflow = await checkWorkflowExists(
          repoName,
          ".github/workflows/bids-validation.yml",
          pat,
        );
        if (!hasWorkflow) {
          const deployResult = await deployWorkflows(repoName, pat);
          if (!deployResult.success) {
            throw new Error(
              `Failed to deploy CI workflows to ${repoName}: ${deployResult.errors.join("; ")}`,
            );
          }
        }

        // Check latest BIDS validation run
        const runs = await getWorkflowRuns(repoName, "bids-validation.yml", pat);
        if (runs.length === 0) {
          blocked = true;
          blockReason = "bids_validation_pending";
        } else if (runs[0].conclusion === "failure") {
          blocked = true;
          blockReason = "bids_validation_failed";
        } else if (runs[0].conclusion === null) {
          blocked = true;
          blockReason = "bids_validation_in_progress";
        }
      } catch (err) {
        // CI infrastructure failure (GitHub API outage, PAT expired, auth
        // misconfig, etc.). Block the request so it can be retried rather
        // than bypassing validation.
        console.error(
          `[publish-request] CI readiness check failed for ${datasetId}:`,
          err instanceof Error ? err.message : err,
        );
        blocked = true;
        blockReason = "bids_validation_pending";
      }
    } else {
      console.warn(`[publish-request] Skipping CI checks for ${datasetId}: no GitHub repo`);
    }

    // Deterministic submission minimums for NATIVE submissions (#1087, ADR
    // 0026): Name >= 25 chars, non-placeholder Authors, ethics statement.
    // OpenNeuro imports and exemplars passed an upstream review and are
    // exempt. Fail-open on a fetch error: the CI check above already proved
    // GitHub reachable, so a later hiccup is logged and left to the admin
    // review rather than adding a spurious block.
    let minReasons: string[] | null = null;
    if (!blocked && repoName && pat && dataset.source !== "openneuro" && !dataset.is_exemplar) {
      try {
        const descriptionJson = await getFileContent(repoName, "dataset_description.json", pat);
        let readme: string | null = null;
        for (const candidate of ["README.md", "README", "README.txt", "README.rst"]) {
          readme = await getFileContent(repoName, candidate, pat);
          if (readme !== null) break;
        }
        const reasons = evaluateSubmissionMinimums(descriptionJson, readme);
        if (reasons.length > 0) {
          blocked = true;
          blockReason = "min_requirements_failed";
          minReasons = reasons;
        }
      } catch (err) {
        console.error(
          `[publish-request] submission-minimums check failed for ${datasetId} (non-fatal):`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    let prId: number | null = requestId ?? null;
    if (requestId) {
      // Update existing blocked request
      if (blocked) {
        // Persist the itemized minimums reasons (migration 0068) so the later
        // /publish/status view stays as specific as this rejection; NULL for
        // CI blocks, and stale reasons from a prior minimums block are
        // overwritten either way.
        await db
          .prepare(
            "UPDATE publication_requests SET status = 'blocked', block_reason = ?, min_requirements_reasons = ?, updated_at = datetime('now') WHERE id = ?",
          )
          .bind(blockReason, minReasons ? JSON.stringify(minReasons) : null, requestId)
          .run();
      } else {
        // Unblock: transition to requested. Also clear any prior pre-screen
        // state so a re-request gets a clean screen (and a disabled-feature
        // re-request doesn't leave a stale 'failed'/nonce on a 'requested' row).
        await db
          .prepare(
            "UPDATE publication_requests SET status = 'requested', block_reason = NULL, min_requirements_reasons = NULL, prescreen_status = NULL, prescreen_nonce = NULL, prescreen_issue_url = NULL, prescreen_reasons = NULL, updated_at = datetime('now') WHERE id = ?",
          )
          .bind(requestId)
          .run();
      }
    } else {
      // Create new publication request
      const inserted = await db
        .prepare(
          "INSERT INTO publication_requests (dataset_id, requested_by, status, block_reason, min_requirements_reasons) VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(
          datasetId,
          currentUser.id,
          blocked ? "blocked" : "requested",
          blockReason,
          minReasons ? JSON.stringify(minReasons) : null,
        )
        .first<{ id: number }>();
      prId = inserted?.id ?? null;
      if (prId === null) {
        console.warn(
          `[publish-request] INSERT ... RETURNING id returned no id for ${datasetId}; pre-screen will not run`,
        );
      }
    }

    if (blocked) {
      return c.json(
        {
          status: "blocked",
          block_reason: blockReason,
          message: BLOCK_MESSAGES[blockReason || ""] || "Publication request blocked.",
          dataset_id: datasetId,
          ci_url: ciUrl,
          // Specific, user-facing failures from the minimums check, mirrored
          // under `details` because the CLI's ApiError only carries that field.
          ...(minReasons
            ? {
                reasons: minReasons,
                policy_url: SUBMISSION_POLICY_URL,
                details: { reasons: minReasons, policy_url: SUBMISSION_POLICY_URL },
              }
            : {}),
        },
        422,
      );
    }

    // Dispatch the automated pre-screen (issue #666). Async + feature-flagged:
    // the request is already 'requested', so a dispatch failure must not 500
    // the call -- we log it and leave the row as a normal pending request.
    // The verdict arrives later at /webhooks/prescreen-result.
    if (
      prId !== null &&
      repoName &&
      pat &&
      c.env.PRESCREEN_ENABLED === "true" &&
      c.env.PRESCREEN_CALLBACK_SECRET
    ) {
      try {
        const nonce = crypto.randomUUID();
        const callbackToken = await signPrescreenCallbackToken(
          { datasetId, requestId: prId, nonce },
          c.env.PRESCREEN_CALLBACK_SECRET,
        );
        await db
          .prepare(
            "UPDATE publication_requests SET prescreen_status = 'pending', prescreen_nonce = ?, prescreen_issue_url = NULL, prescreen_reasons = NULL, prescreen_at = NULL, updated_at = datetime('now') WHERE id = ?",
          )
          .bind(nonce, prId)
          .run();
        await triggerPrescreenRun(
          datasetId,
          "main",
          prId,
          callbackToken,
          `${c.env.API_BASE_URL}/webhooks/prescreen-result`,
          pat,
        );
      } catch (err) {
        console.error(
          `[publish-request] prescreen dispatch failed for ${datasetId} (non-fatal):`,
          err instanceof Error ? err.message : err,
        );
        // Don't strand the row in 'pending' with no workflow behind it.
        try {
          await db
            .prepare(
              "UPDATE publication_requests SET prescreen_status = NULL, prescreen_nonce = NULL, prescreen_reasons = NULL WHERE id = ?",
            )
            .bind(prId)
            .run();
        } catch (resetErr) {
          console.error(`[publish-request] prescreen reset failed for ${datasetId}:`, resetErr);
        }
      }
    }

    // Notify admins who have publication_request notifications enabled
    try {
      const adminEmails = await getAdminEmailsForCategory(db, "publication_request");
      if (adminEmails.length > 0) {
        const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
        await sendPublicationRequestEmail(
          adminEmails,
          datasetId,
          currentUser.username,
          c.env.RESEND_API_KEY,
          fromEmail,
          replyTo,
          isDev,
          c.env,
        );
      }
    } catch (emailError) {
      console.error("Failed to send publication request notification:", emailError);
    }

    return c.json({
      message: "Publication request submitted",
      dataset_id: datasetId,
      status: "requested",
    });
  });

  /**
   * GET /datasets/:id/publish/status - Get publication status
   */
  datasetRoutes.get("/:id/publish/status", authMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const currentUser = c.get("user");
    const db = c.env.DB;

    const dataset = await db
      .prepare("SELECT id, owner_user_id FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ id: number; owner_user_id: number }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    if (dataset.owner_user_id !== currentUser.id && !hasRole(currentUser.role, "admin")) {
      return c.json({ error: "Only the dataset owner or admin can view publication status" }, 403);
    }

    const request = await db
      .prepare(
        `SELECT pr.*, u.username as requested_by_username, d.github_repo
         FROM publication_requests pr
         JOIN users u ON pr.requested_by = u.id
         JOIN datasets d ON pr.dataset_id = d.dataset_id
         WHERE pr.dataset_id = ?
         ORDER BY pr.requested_at DESC
         LIMIT 1`,
      )
      .bind(datasetId)
      .first<{
        id: number;
        dataset_id: string;
        status: string;
        requested_at: string;
        requested_by_username: string;
        approved_at: string | null;
        denied_at: string | null;
        denied_reason: string | null;
        block_reason: string | null;
        min_requirements_reasons: string | null;
        prescreen_status: string | null;
        prescreen_reasons: string | null;
        prescreen_issue_url: string | null;
        steps_completed: string;
        current_step: string | null;
        last_error: string | null;
        updated_at: string;
        github_repo: string | null;
      }>();

    if (!request) {
      return c.json({
        dataset_id: datasetId,
        status: "none",
        message: "No publication request found",
      });
    }

    const repoName = request.github_repo?.split("/")[1];

    // Pre-screen is advisory (#756): when it flagged a concern, surface it as a
    // non-blocking advisory (the request is NOT blocked by it). Real blockers keep
    // status='blocked' with a BLOCK_MESSAGE below.
    let prescreenAdvisory:
      | { source: "prescreen"; reasons: string[]; issue_url?: string }
      | undefined;
    if (request.prescreen_status === "concern") {
      let reasons: string[] = [];
      try {
        const parsed = JSON.parse(request.prescreen_reasons || "[]");
        if (Array.isArray(parsed)) reasons = parsed.filter((r) => typeof r === "string");
      } catch (err) {
        // malformed reasons JSON -> empty list (the advisory flag still shows)
        console.error(`[publish-status] malformed prescreen_reasons for ${datasetId}:`, err);
      }
      prescreenAdvisory = {
        source: "prescreen",
        reasons,
        ...(request.prescreen_issue_url ? { issue_url: request.prescreen_issue_url } : {}),
      };
    }

    // Persisted submission-minimums reasons (#1087, migration 0068): keep the
    // status view as specific as the original 422.
    let minReasons: string[] | undefined;
    if (request.block_reason === "min_requirements_failed" && request.min_requirements_reasons) {
      try {
        const parsed = JSON.parse(request.min_requirements_reasons);
        if (Array.isArray(parsed)) {
          minReasons = parsed.filter((r): r is string => typeof r === "string");
        }
      } catch (err) {
        console.error(`[publish-status] malformed min_requirements_reasons for ${datasetId}:`, err);
      }
    }

    return c.json({
      dataset_id: datasetId,
      status: request.status,
      requested_at: request.requested_at,
      requested_by: request.requested_by_username,
      approved_at: request.approved_at,
      denied_at: request.denied_at,
      denied_reason: request.denied_reason,
      block_reason: request.block_reason,
      ...(request.status === "blocked" && repoName
        ? {
            message: BLOCK_MESSAGES[request.block_reason || ""] || "Publication request blocked.",
            ci_url: `https://github.com/nemarDatasets/${repoName}/actions`,
          }
        : {}),
      ...(minReasons?.length ? { reasons: minReasons, policy_url: SUBMISSION_POLICY_URL } : {}),
      ...(prescreenAdvisory ? { advisory: prescreenAdvisory } : {}),
      steps_completed: JSON.parse(request.steps_completed || "[]"),
      current_step: request.current_step,
      last_error: request.last_error,
      updated_at: request.updated_at,
    });
  });

  /**
   * POST /datasets/:id/publish/resend - Resend publication request notification
   */
  datasetRoutes.post("/:id/publish/resend", authMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const currentUser = c.get("user");
    const db = c.env.DB;

    const dataset = await db
      .prepare("SELECT id, owner_user_id FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ id: number; owner_user_id: number }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    if (dataset.owner_user_id !== currentUser.id && !hasRole(currentUser.role, "admin")) {
      return c.json({ error: "Only the dataset owner can resend notifications" }, 403);
    }

    const request = await db
      .prepare(
        "SELECT id, status, updated_at FROM publication_requests WHERE dataset_id = ? AND status = 'requested' ORDER BY requested_at DESC LIMIT 1",
      )
      .bind(datasetId)
      .first<{ id: number; status: string; updated_at: string }>();

    if (!request) {
      return c.json({ error: "No pending publication request found" }, 404);
    }

    // Rate limit: 30 minutes between resends
    const lastUpdate = new Date(request.updated_at).getTime();
    const cooldownMs = 30 * 60 * 1000;
    if (Date.now() - lastUpdate < cooldownMs) {
      return c.json({ error: "Please wait before resending (30 min cooldown)" }, 429);
    }

    // Update timestamp for rate limiting
    await db
      .prepare("UPDATE publication_requests SET updated_at = datetime('now') WHERE id = ?")
      .bind(request.id)
      .run();

    // Resend notification to admins who have publication_request notifications enabled
    try {
      const adminEmails = await getAdminEmailsForCategory(db, "publication_request");
      if (adminEmails.length > 0) {
        const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
        await sendPublicationRequestEmail(
          adminEmails,
          datasetId,
          currentUser.username,
          c.env.RESEND_API_KEY,
          fromEmail,
          replyTo,
          isDev,
          c.env,
        );
      }
    } catch (emailError) {
      console.error("Failed to resend publication notification:", emailError);
      return c.json(
        {
          error: "Failed to resend notification email",
          message:
            "The notification could not be sent. Please try again later or contact an administrator directly.",
        },
        500,
      );
    }

    return c.json({
      message: "Notification resent to admins",
      dataset_id: datasetId,
    });
  });

  /**
   * GET /datasets/:id/ci/status - Check CI status for a dataset (user-accessible)
   *
   * Returns CI workflow presence and latest run status.
   * Authenticated users can check any dataset they own or collaborate on.
   */
  datasetRoutes.get("/:id/ci/status", authMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const db = c.env.DB;
    const currentUser = c.get("user");

    const dataset = await db
      .prepare(
        `SELECT d.dataset_id, d.github_repo, u.username as owner_username
         FROM datasets d
         JOIN users u ON d.owner_user_id = u.id
         WHERE d.dataset_id = ?`,
      )
      .bind(datasetId)
      .first<{ dataset_id: string; github_repo: string | null; owner_username: string }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    // Check ownership or admin status
    if (dataset.owner_username !== currentUser.username && !hasRole(currentUser.role, "admin")) {
      return c.json({ error: "Access denied" }, 403);
    }

    if (!dataset.github_repo) {
      return c.json({ error: "Dataset has no GitHub repository" }, 400);
    }

    const repoName = extractRepoName(dataset.github_repo);
    if (!repoName) {
      return c.json({ error: "Invalid repository format" }, 500);
    }

    const pat = await getDatasetsToken(c.env);

    let bidsWorkflowExists = false;
    let latestRunStatus = "unknown";
    let latestRunUrl: string | null = null;

    try {
      bidsWorkflowExists = await checkWorkflowExists(
        repoName,
        ".github/workflows/bids-validation.yml",
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
      console.error(`[ci/status] GitHub API error for ${datasetId} (repo: ${repoName}):`, msg);
      return c.json({ error: `GitHub API error: ${msg}` }, 502);
    }

    return c.json({
      dataset_id: datasetId,
      bids_validation: {
        present: bidsWorkflowExists,
        status: bidsWorkflowExists ? latestRunStatus : "missing",
        url: latestRunUrl,
      },
    });
  });

  /**
   * POST /datasets/:id/publish - Publish a dataset (make public)
   *
   * Authorization: Admin only. Predates the orchestrated publication flow
   * (publish/request -> admin approval -> orchestrator); as a direct flip of
   * GitHub/S3/D1 visibility it skips DOI minting, manifest generation, and the
   * submission-minimums gate, so owners must go through publish/request instead.
   * One-way operation: Cannot unpublish
   *
   * Effects:
   * 1. Changes GitHub repo from private to public
   * 2. Updates S3 bucket policy for public read
   * 3. Sets visibility='public' in database
   * 4. Logs action in audit_log
   */
  datasetRoutes.post("/:id/publish", authMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const user = c.get("user");
    const db = c.env.DB;

    // Validate dataset ID format
    if (!isValidDatasetId(datasetId)) {
      return c.json({ error: "Invalid dataset ID" }, 400);
    }

    // Fetch dataset with ownership check
    const dataset = await db
      .prepare(`
        SELECT id, dataset_id, name, owner_user_id, github_repo, visibility, is_sandbox
        FROM datasets
        WHERE dataset_id = ? AND status = 'active'
      `)
      .bind(datasetId)
      .first<{
        id: number;
        dataset_id: string;
        name: string;
        owner_user_id: number;
        github_repo: string | null;
        visibility: string;
        is_sandbox: number;
      }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    // Authorization: admin only. Owners must use the publication request flow
    // (POST /datasets/:id/publish/request), which routes through the orchestrator.
    if (!hasRole(user.role, "admin")) {
      return c.json(
        {
          error:
            "Forbidden: Only admins can publish directly. Use 'nemar dataset publish request' to request publication.",
        },
        403,
      );
    }

    // Prevent publishing sandbox datasets
    if (dataset.is_sandbox) {
      return c.json(
        {
          error: "Cannot publish sandbox datasets",
          message: "Sandbox datasets are for training only and cannot be made public",
        },
        400,
      );
    }

    // Already public (idempotent)
    if (dataset.visibility === "public") {
      return c.json(
        {
          message: "Dataset is already public",
          dataset_id: datasetId,
        },
        200,
      );
    }

    // Validate GitHub repo exists
    if (!dataset.github_repo) {
      return c.json(
        {
          error: "Dataset has no GitHub repository",
          message: "Cannot publish a dataset without a repository",
        },
        400,
      );
    }

    // Extract repo name from full name (e.g., "nemarDatasets/nm000104" -> "nm000104")
    const repoName = dataset.github_repo.split("/")[1];
    if (!repoName) {
      return c.json({ error: "Invalid GitHub repository format" }, 500);
    }

    // Step 1: Update GitHub repository visibility
    const pat = await getDatasetsToken(c.env);
    const ghResult = await setRepoVisibility(repoName, false, pat);
    if (!ghResult.ok) {
      console.error(`GitHub visibility update failed for ${datasetId}:`, ghResult.error);
      return c.json(
        {
          error: "Failed to update GitHub repository visibility",
          details: ghResult.error,
          dataset_id: datasetId,
        },
        500,
      );
    }

    // Step 2: Grant public read by removing the dataset's private carve-out
    try {
      await markDatasetPublic(
        {
          bucket: c.env.S3_BUCKET,
          region: c.env.AWS_REGION,
          accessKeyId: c.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
        },
        datasetId,
      );
    } catch (s3Error) {
      const s3Msg = s3Error instanceof Error ? s3Error.message : String(s3Error);
      console.error(`S3 policy update failed for ${datasetId}:`, s3Msg);

      // Revert GitHub to private on S3 failure
      const revertResult = await setRepoVisibility(repoName, true, pat);
      if (revertResult.ok) {
        return c.json(
          {
            error: "Failed to update S3 bucket policy, reverted GitHub repository to private",
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
          github_visibility: "public",
          s3_public: false,
          revert_error: revertResult.error,
          action_required: `Manually revert GitHub repo to private OR manually add S3 public read policy for ${datasetId}`,
        },
        500,
      );
    }

    // Step 3: Update database
    try {
      await db
        .prepare(
          "UPDATE datasets SET visibility = 'public', updated_at = datetime('now') WHERE id = ?",
        )
        .bind(dataset.id)
        .run();
    } catch (dbError) {
      const dbMsg = dbError instanceof Error ? dbError.message : String(dbError);
      console.error(`Database update failed for ${datasetId}:`, dbMsg);

      // Revert both GitHub and S3 on database failure
      const ghRevertResult = await setRepoVisibility(repoName, true, pat);

      let s3Reverted = false;
      try {
        await markDatasetPrivate(
          {
            bucket: c.env.S3_BUCKET,
            region: c.env.AWS_REGION,
            accessKeyId: c.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
          },
          datasetId,
        );
        s3Reverted = true;
      } catch (s3RevertError) {
        console.error(`S3 policy revert failed for ${datasetId}:`, s3RevertError);
      }

      return c.json(
        {
          error: "CRITICAL: Database update failed, attempted rollback",
          details: dbMsg,
          dataset_id: datasetId,
          github_reverted: ghRevertResult.ok,
          s3_reverted: s3Reverted,
          action_required:
            ghRevertResult.ok && s3Reverted
              ? "Rollback successful, but database update failed. Contact administrator."
              : `Manually revert: ${!ghRevertResult.ok ? "GitHub repo to private" : ""} ${!s3Reverted ? "Remove S3 public read policy" : ""}`.trim(),
        },
        500,
      );
    }

    // Step 3.5: Enforce the published-repo spec (epic #713): lock main (branch +
    // tag ruleset, green-gated), deploy workflows, reconcile collaborators
    // (owner=maintain, ledger writers=push, strip stray read). Non-fatal: the
    // dataset is already public at GitHub/S3/D1; a failed step just means
    // protection may need a retry (surfaced in the response for visibility).
    let specEnforcement: Awaited<ReturnType<typeof ensureRepoToSpec>> | undefined;
    try {
      const { ownerLogin, approvedWriters } = await resolveRepoCollaborators(db, datasetId);
      specEnforcement = await ensureRepoToSpec(repoName, pat, {
        visibility: "public",
        collaborators: { ownerLogin, approvedWriters },
      });
    } catch (specError) {
      console.error(`Repo-spec enforcement failed for ${datasetId} (non-fatal):`, specError);
    }
    // Mirror reconcile removals into D1 (own try/catch; flags a divergence).
    await mirrorReconcileRemovals(db, datasetId, specEnforcement?.reconcile?.removed);

    // Step 4: Audit log
    await db
      .prepare(`
        INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
        VALUES (?, ?, ?, ?, ?)
      `)
      .bind(
        user.id,
        "dataset_publish",
        "dataset",
        datasetId,
        JSON.stringify({
          dataset_name: dataset.name,
          github_repo: dataset.github_repo,
        }),
      )
      .run();

    return c.json({
      success: true,
      message: "Dataset published successfully",
      dataset_id: datasetId,
      github_url: `https://github.com/${dataset.github_repo}`,
      s3_url: `https://${c.env.S3_BUCKET}.s3.${c.env.AWS_REGION}.amazonaws.com/${datasetId}/`,
      spec_enforcement: specEnforcement?.steps,
    });
  });
}
