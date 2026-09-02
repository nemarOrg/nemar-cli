/**
 * records.json build callback: POST /records-ready, observability-only
 * state recording (epic #615). Bearer-token authed.
 *
 * Moved verbatim from routes/webhooks.ts (#905, epic #902); the only
 * intentional changes are import paths and the register-function wrapper.
 */

import { isValidDatasetId } from "../../services/datasetId.js";
import { type WebhookRouter, timingSafeEqual } from "../webhooks/shared.js";

/**
 * POST /webhooks/records-ready — callback from nemarDatasets/.github
 * `generate-records.yml` once a dataset version's records.json has been built and
 * uploaded to `s3://nemar/<id>/version/v<version>-records.json` (epic #736 Phase 5
 * / #742). Until now the workflow was never dispatched on publish and had no
 * callback, so records.json 404'd for every dataset.
 *
 * Mirror of /archive-ready: same `X-Webhook-Token` (NEMAR_WEBHOOK_TOKEN) auth,
 * records the latest-only records state on the `datasets` row. The records.json
 * artifact is served from S3 directly (loadRecords), so this column is
 * observability-only -- no serving dependency, and (unlike archive) no retry.
 *
 * Responses: 200 once state is recorded; 400 for a bad body or missing/unknown
 * `status`; 404 when the dataset isn't in D1. Idempotent.
 */
interface RecordsReadyBody {
  dataset_id: string;
  status?: "ready" | "failed";
  /** The published version the records were built for (logged, not stored). */
  version?: string;
  error?: string;
}

export function registerRecordsReadyRoutes(webhooks: WebhookRouter): void {
  webhooks.post("/records-ready", async (c) => {
    const token = c.req.header("X-Webhook-Token");
    const expectedToken = c.env.NEMAR_WEBHOOK_TOKEN ?? c.env.GITHUB_WEBHOOK_SECRET;
    if (!expectedToken) {
      console.error(
        "[records-ready] no webhook secret configured (NEMAR_WEBHOOK_TOKEN/GITHUB_WEBHOOK_SECRET both unset or empty)",
      );
      return c.json({ error: "Invalid webhook token" }, 401);
    }
    if (!token || !timingSafeEqual(token, expectedToken)) {
      return c.json({ error: "Invalid webhook token" }, 401);
    }

    let body: RecordsReadyBody;
    try {
      body = (await c.req.json()) as RecordsReadyBody;
    } catch {
      return c.json({ error: "Invalid JSON in request body" }, 400);
    }

    if (typeof body.dataset_id !== "string" || !isValidDatasetId(body.dataset_id)) {
      return c.json({ error: "dataset_id must be a valid dataset id" }, 400);
    }
    // Require an explicit status: a missing/unknown value must not default to
    // 'ready' (that would mark a failed generation as having records).
    if (body.status !== "ready" && body.status !== "failed") {
      return c.json({ error: "status must be 'ready' or 'failed'" }, 400);
    }
    const status = body.status;
    if (status === "failed" && body.error) {
      console.error(`[records-ready] workflow failure dataset=${body.dataset_id}: ${body.error}`);
    }

    let changed = 0;
    try {
      const result = await c.env.DB.prepare(
        "UPDATE datasets SET records_status = ?, sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.records_checked_at', datetime('now')) WHERE dataset_id = ?",
      )
        .bind(status, body.dataset_id)
        .run();
      changed = result.meta.changes ?? 0;
    } catch (err) {
      console.error(
        `[records-ready] D1 update failed dataset=${body.dataset_id}:`,
        err instanceof Error ? err.message : String(err),
      );
      return c.json({ error: "Failed to record records state" }, 500);
    }

    // A callback for a dataset that isn't in D1 (deleted, or never registered)
    // matches zero rows; surface it as a 404 rather than a silent 200.
    if (changed === 0) {
      console.error(
        `[records-ready] UPDATE matched 0 rows dataset=${body.dataset_id} -- not in D1`,
      );
      return c.json({ error: "Dataset not found" }, 404);
    }

    console.log(
      `[records-ready] dataset=${body.dataset_id} status=${status} version=${body.version ?? "?"}`,
    );

    return c.json({ ok: true, dataset_id: body.dataset_id, status });
  });
}
