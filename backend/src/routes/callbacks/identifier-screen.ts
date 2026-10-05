/**
 * Identifier-screen callback: POST /identifier-screen-result, called by the
 * `run-identifier-screen` workflow (epic #1610, phase 4).
 *
 * Authed like the pre-screen callback: a per-request HMAC token in
 * X-Webhook-Token, signed over {dataset_id, request_id, nonce} with
 * PRESCREEN_CALLBACK_SECRET under the identifier-screen domain tag, whose nonce
 * is recovered from the row the token was issued for. One-shot: the row is
 * looked up only while its screen is `pending`, and storing a result clears the
 * nonce, so a replay or a late callback finds nothing to verify and gets 401.
 *
 * Body: `{ dataset_id, request_id, workflow_run_id?, report }`. Every field is
 * untrusted. `dataset_id` and `request_id` are validated against their exact
 * shapes BEFORE they are used or logged, `workflow_run_id` is logged only when
 * it is a run number, and `report` reaches nothing except through
 * `parseScreenReport` (services/identifier-screen.ts). A route that echoed a
 * body field into a log line would be a way for a header's text to reach the
 * Worker's logs, which is the thing this feature exists to keep out.
 */

import { isValidDatasetId } from "../../services/datasetId.js";
import { verifyIdentifierScreenCallbackToken } from "../../services/github.js";
import { notifyAdminsOfScreen, storeScreenResult } from "../../services/identifier-screen.js";
import type { WebhookRouter } from "../webhooks/shared.js";

export function registerIdentifierScreenRoutes(webhooks: WebhookRouter): void {
  webhooks.post("/identifier-screen-result", async (c) => {
    const token = c.req.header("X-Webhook-Token");
    if (!token) {
      return c.json({ error: "Missing X-Webhook-Token header" }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON in request body" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "Body must be a JSON object" }, 400);
    }
    const b = body as Record<string, unknown>;
    if (typeof b.dataset_id !== "string" || !isValidDatasetId(b.dataset_id)) {
      return c.json({ error: "dataset_id must be a dataset id" }, 400);
    }
    if (
      typeof b.request_id !== "number" ||
      !Number.isSafeInteger(b.request_id) ||
      b.request_id < 1
    ) {
      return c.json({ error: "request_id must be a positive integer" }, 400);
    }
    const datasetId = b.dataset_id;
    const requestId = b.request_id;
    const runId =
      typeof b.workflow_run_id === "string" && /^\d{1,20}$/.test(b.workflow_run_id)
        ? b.workflow_run_id
        : typeof b.workflow_run_id === "number" && Number.isSafeInteger(b.workflow_run_id)
          ? String(b.workflow_run_id)
          : null;

    const secret = c.env.PRESCREEN_CALLBACK_SECRET;
    if (!secret) {
      console.error("[identifier-screen-result] PRESCREEN_CALLBACK_SECRET is unset; rejecting");
      return c.json({ error: "Server misconfigured: callback secret unset" }, 500);
    }

    // The nonce of the in-flight screen. Only a PENDING screen is found, so a
    // replay against a stored result cannot re-store or re-mail it.
    const row = await c.env.DB.prepare(
      `SELECT identifier_screen_nonce FROM publication_requests
        WHERE id = ? AND dataset_id = ? AND identifier_screen_status = 'pending'
        LIMIT 1`,
    )
      .bind(requestId, datasetId)
      .first<{ identifier_screen_nonce: string | null }>();
    if (!row?.identifier_screen_nonce) {
      console.warn(
        `[identifier-screen-result] no pending screen for request ${requestId} (${datasetId})`,
      );
      return c.json({ error: "No in-flight identifier screen for this request" }, 401);
    }

    const ok = await verifyIdentifierScreenCallbackToken(
      token,
      { datasetId, requestId, nonce: row.identifier_screen_nonce },
      secret,
    );
    if (!ok) {
      console.warn(
        `[identifier-screen-result] callback token mismatch for request ${requestId} (${datasetId})`,
      );
      return c.json({ error: "Invalid callback token" }, 401);
    }

    const stored = await storeScreenResult(c.env, {
      requestId,
      datasetId,
      nonce: row.identifier_screen_nonce,
      body: b.report,
    });
    if (!stored.stored) {
      // Verified, but another writer (a duplicate callback, the watchdog) won
      // the one conditional UPDATE between the read and the write. Harmless.
      console.warn(
        `[identifier-screen-result] request ${requestId} (${datasetId}): result already recorded`,
      );
      return c.json({ ok: true, dataset_id: datasetId, duplicate: true });
    }

    console.log(
      `[identifier-screen-result] request ${requestId} (${datasetId}): state=${stored.state}${
        runId ? ` run=${runId}` : ""
      }`,
    );
    const mailed = await notifyAdminsOfScreen(c.env, requestId);
    return c.json({
      ok: true,
      dataset_id: datasetId,
      state: stored.state,
      blocked: stored.blocked,
      admin_email: mailed,
    });
  });
}
