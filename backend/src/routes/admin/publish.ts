/**
 * Admin routes: publication workflow (list/deny/approve publication requests,
 * S3 Object Lock). The approve route is a thin adapter over the 16-step
 * state machine in services/publication-orchestrator.ts (#904, epic #902);
 * list/deny/s3-lock handlers moved verbatim from routes/admin.ts in #903.
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { resolveEmailConfig, sendPublicationDeniedEmail } from "../../services/email";
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
