/**
 * Admin routes: publication workflow (list/deny/approve publication requests,
 * S3 Object Lock). The approve route is a thin adapter over the 16-step
 * state machine in services/publication-orchestrator.ts (#904, epic #902);
 * list/deny/s3-lock handlers moved verbatim from routes/admin.ts in #903.
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { auditLogStatement } from "../../db/audit-log";
import { ACTIVE_REQUEST_TAIL_SQL, approvalInFlightSql } from "../../services/approval-dispatch";
import { resolveEmailConfig, sendPublicationDeniedEmail } from "../../services/email";
import { getDatasetsAuth } from "../../services/github-auth";
import {
  DispatchRejectedError,
  approvalDispatchEnvironment,
  triggerApprovePublication,
} from "../../services/github/dispatch";
import { approveSchema, runPublicationApproval } from "../../services/publication-orchestrator";
import { errorMessage } from "../../services/repo-metadata";
import { applyObjectLockBatch } from "../../services/s3";
import { getS3Config } from "./shared";
import type { AdminRouter } from "./shared";

export function registerPublishRoutes(admin: AdminRouter): void {
  // ============================================================================
  // Publication Workflow (Admin)
  // ============================================================================

  /**
   * GET /admin/publish/requests - List publication requests
   *
   * `approval_in_flight` is computed per row from the same predicate the
   * dispatch route claims with (services/approval-dispatch.ts), so a client
   * never offers an action the route would refuse and never hard-codes the
   * lease. The new columns `approval_requested_by` and `approval_dispatched_at`
   * ride along in `pr.*`.
   */
  admin.get("/publish/requests", async (c) => {
    const db = c.env.DB;
    const status = c.req.query("status");

    let query = `
    SELECT pr.*, u.username as requested_by_username, u.email as requested_by_email,
           ${approvalInFlightSql("pr.")} AS approval_in_flight
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
        approval_requested_by: number | null;
        approval_dispatched_at: string | null;
        approval_in_flight: number;
      }>();

    return c.json({
      requests: requests.results.map((r) => ({
        ...r,
        steps_completed: JSON.parse(r.steps_completed || "[]"),
        approval_in_flight: r.approval_in_flight === 1,
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
          c.env,
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
   * POST /admin/publish/:id/approve - Approve and run the publication
   * orchestrator. The 16-step state machine lives in
   * services/publication-orchestrator.ts (#904); this route is a thin adapter.
   */
  admin.post("/publish/:id/approve", zValidator("json", approveSchema), async (c) => {
    const result = await runPublicationApproval({
      db: c.env.DB,
      env: c.env,
      // Lazy closure: executionCtx is only touched if a step actually
      // schedules background work (test harnesses provide no executionCtx).
      waitUntil: (p) => c.executionCtx.waitUntil(p),
      datasetId: c.req.param("id"),
      adminUser: c.get("user"),
      body: c.req.valid("json"),
    });
    return c.json(result.body as never, (result.status ?? 200) as never);
  });

  /**
   * POST /admin/publish/:id/approve-dispatch - Launch an approval from the web
   * (ADR 0080).
   *
   * Approval is not one request: after the irreversible DOI publish, S3 Object
   * Lock runs in batches the CALLER must keep requesting, so a click cannot run
   * it inside one Worker invocation and the loop is deliberately not moved into
   * the Worker. This route claims the request, records WHO clicked, and hands
   * the run to an executor (a GitHub Actions workflow that drives the CLI)
   * through `repository_dispatch`, then answers 202 straight away. Closing the
   * page cannot matter: the state lives in `publication_requests`.
   *
   * The executor calls `POST /publish/:id/approve` with its own service key; the
   * orchestrator reads `approval_requested_by` as the approver, so the record
   * names the admin who clicked rather than the bot. `/approve` itself is
   * untouched and stays the contract for every executor, a terminal included.
   *
   * Errors carry a stable code in `error` and a sentence in `message`:
   *   404 not_found         no active request for the dataset
   *   409 not_dispatchable  the newest active request is `blocked`
   *   409 already_in_flight a run is live (services/approval-dispatch.ts)
   *   502 dispatch_failed   GitHub answered non-2xx, or a token could not be
   *                         minted: nothing was sent, the claim is released
   *   502 dispatch_unconfigured  the Worker has no GitHub credential; retrying
   *                         cannot help; the claim is released
   *   502 dispatch_unconfirmed   the call to GitHub dropped or timed out: it MAY
   *                         have started, so the lease is KEPT (a retry is a
   *                         409 until it lapses)
   */
  admin.post("/publish/:id/approve-dispatch", async (c) => {
    const datasetId = c.req.param("id");
    const adminUser = c.get("user");
    const db = c.env.DB;

    const request = await db
      .prepare(`SELECT id, status ${ACTIVE_REQUEST_TAIL_SQL}`)
      .bind(datasetId)
      .first<{ id: number; status: string }>();

    if (!request) {
      return c.json({ error: "not_found", message: "No active publication request found" }, 404);
    }
    if (request.status === "blocked") {
      return c.json(
        {
          error: "not_dispatchable",
          message:
            "This request is blocked. Resolve the block before dispatching an approval, or approve it from a terminal.",
        },
        409,
      );
    }

    // One conditional UPDATE is the claim: D1 runs it atomically, so two
    // simultaneous clicks cannot both see the row idle. `updated_at` is left
    // alone on purpose. It is the orchestrator's progress heartbeat, and
    // bumping it here would make a failed dispatch read as a live run for the
    // whole lease on an `approving` row.
    const claim = await db
      .prepare(
        `UPDATE publication_requests
           SET approval_requested_by = ?, approval_dispatched_at = datetime('now')
         WHERE id = ? AND status IN ('requested', 'approving') AND NOT ${approvalInFlightSql()}`,
      )
      .bind(adminUser.id, request.id)
      .run();

    if (claim.meta.changes !== 1) {
      return c.json(
        {
          error: "already_in_flight",
          message: "An approval is already running for this dataset.",
        },
        409,
      );
    }

    // A request already `approving` has done part of the work, and some of it
    // cannot be undone: it resumes, it does not start over.
    const resume = request.status === "approving";
    const environment = approvalDispatchEnvironment(c.env);

    // Release the claim so the admin can try again at once rather than wait out
    // the lease. Only ever done for a failure that is DEFINITELY "not sent".
    // `AND approval_requested_by = ?` makes it clear only a claim this click
    // made. If even the release fails the lease lapses by itself, which errs
    // toward refusing a retry, never toward a second run.
    const releaseClaim = async (): Promise<void> => {
      try {
        await db
          .prepare(
            `UPDATE publication_requests
               SET approval_requested_by = NULL, approval_dispatched_at = NULL
             WHERE id = ? AND approval_requested_by = ?`,
          )
          .bind(request.id, adminUser.id)
          .run();
      } catch (releaseErr) {
        console.error(
          `[approve-dispatch] could not release the claim on request ${request.id}:`,
          errorMessage(releaseErr),
        );
      }
    };

    // 1. A credential. Absent entirely is a configuration fault that retrying
    // cannot fix, so it has its own code; failing to MINT one (an App token
    // request GitHub refused) is transient and is an ordinary failed dispatch.
    // Neither sent anything, so both release.
    let auth: ReturnType<typeof getDatasetsAuth>;
    try {
      auth = getDatasetsAuth(c.env);
    } catch (err) {
      console.error(`[approve-dispatch] no GitHub credential for ${datasetId}:`, errorMessage(err));
      await releaseClaim();
      return c.json(
        {
          error: "dispatch_unconfigured",
          message:
            "This server has no GitHub credential configured, so an approval cannot be dispatched from the web. Retrying will not help. Approve from a terminal, and ask an administrator to fix the configuration.",
        },
        502,
      );
    }
    let pat: string;
    try {
      pat = auth.kind === "app" ? await auth.getToken() : auth.token;
    } catch (err) {
      console.error(
        `[approve-dispatch] could not obtain a GitHub token for ${datasetId}:`,
        errorMessage(err),
      );
      await releaseClaim();
      return c.json(
        {
          error: "dispatch_failed",
          message: "The approval could not be started. Nothing was changed; try again.",
        },
        502,
      );
    }

    // 2. The dispatch itself. GitHub answering non-2xx means nothing was sent:
    // release. A dropped connection or a timeout means UNKNOWN: GitHub may have
    // accepted the event and lost only the reply, and releasing then would let
    // the next click start a second run beside it. KEEP the lease; it lapses on
    // its own if nothing started.
    try {
      await triggerApprovePublication(datasetId, request.id, resume, environment, pat);
    } catch (err) {
      console.error(`[approve-dispatch] dispatch failed for ${datasetId}:`, errorMessage(err));
      if (err instanceof DispatchRejectedError) {
        await releaseClaim();
        return c.json(
          {
            error: "dispatch_failed",
            message: "The approval could not be started. Nothing was changed; try again.",
          },
          502,
        );
      }
      return c.json(
        {
          error: "dispatch_unconfirmed",
          message:
            "GitHub did not confirm the request. It may have started; check again in a few minutes before trying again.",
        },
        502,
      );
    }

    try {
      await auditLogStatement(db, {
        userId: adminUser.id,
        action: "approval_dispatched",
        resourceType: "dataset",
        resourceId: datasetId,
        details: JSON.stringify({ request_id: request.id, resume, environment }),
      }).run();
    } catch (auditErr) {
      // The run is already launched; a missing audit row must not report the
      // launch as failed.
      console.error(
        `[approve-dispatch] audit write failed for ${datasetId}:`,
        errorMessage(auditErr),
      );
    }

    return c.json(
      { status: "dispatched", dataset_id: datasetId, request_id: request.id, resume },
      202,
    );
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
