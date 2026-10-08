/**
 * Pull-request review callback: POST /pr-review-result, called by the `run-pr-review` workflow
 * (ADR 0092).
 *
 * Authed like the identifier-screen callback: a per-review HMAC token in X-Webhook-Token, signed
 * over {dataset_id, review_id, nonce} with PRESCREEN_CALLBACK_SECRET under the `pr-review` domain
 * tag, whose nonce is recovered from the row the token was issued for. One-shot: the row is found
 * only while it waits for its report (`dispatched`, or `unreported` after the watchdog gave up),
 * and storing a result clears the nonce, so a replay or a late duplicate finds nothing to verify
 * and gets 401.
 *
 * Body: `{ review_id, dataset_id, outcome: "reported" | "error", report?, error? }`. Every field
 * is untrusted. `dataset_id` and `review_id` are validated against their exact shapes BEFORE they
 * are used or logged, and `report` reaches nothing except through `parsePrReviewReport`, so a
 * workflow that was changed to put a pull request's text into its report is refused at the door
 * (stored as `report_invalid`) rather than shown.
 */

import { isValidDatasetId } from "../../services/datasetId.js";
import { verifyPrReviewCallbackToken } from "../../services/github/callback-tokens.js";
import { pendingNonce, storePrReviewResult } from "../../services/pr-review.js";
import type { WebhookRouter } from "../webhooks/shared.js";
import { readBoundedJsonObject } from "./bounded-json.js";

/** Every refusal says the same bytes, so the answer does not tell a caller which reviews are running. */
const UNAUTHORIZED = { error: "Invalid or expired callback token" } as const;

export function registerPrReviewRoutes(webhooks: WebhookRouter): void {
  webhooks.post("/pr-review-result", async (c) => {
    const token = c.req.header("X-Webhook-Token");
    if (!token) return c.json(UNAUTHORIZED, 401);

    const read = await readBoundedJsonObject(c);
    if (!read.ok) return c.json({ error: read.error }, read.status);
    const b = read.body;
    if (typeof b.dataset_id !== "string" || !isValidDatasetId(b.dataset_id)) {
      return c.json({ error: "dataset_id must be a dataset id" }, 400);
    }
    if (typeof b.review_id !== "number" || !Number.isSafeInteger(b.review_id) || b.review_id < 1) {
      return c.json({ error: "review_id must be a positive integer" }, 400);
    }
    const datasetId = b.dataset_id;
    const reviewId = b.review_id;

    const secret = c.env.PRESCREEN_CALLBACK_SECRET;
    if (!secret) {
      console.error("[pr-review-result] PRESCREEN_CALLBACK_SECRET is unset; rejecting");
      return c.json({ error: "Server misconfigured: callback secret unset" }, 500);
    }

    const nonce = await pendingNonce(c.env.DB, reviewId, datasetId);
    if (!nonce) {
      console.warn(`[pr-review-result] no waiting review ${reviewId} (${datasetId})`);
      return c.json(UNAUTHORIZED, 401);
    }
    const ok = await verifyPrReviewCallbackToken(token, { datasetId, reviewId, nonce }, secret);
    if (!ok) {
      console.warn(`[pr-review-result] token mismatch for review ${reviewId} (${datasetId})`);
      return c.json(UNAUTHORIZED, 401);
    }

    const { stored } = await storePrReviewResult(c.env, reviewId, datasetId, nonce, {
      outcome: b.outcome,
      report: b.report,
      error: b.error,
    });
    if (!stored) {
      // Verified, but another writer (a duplicate callback, the watchdog) won the one conditional
      // UPDATE between the read and the write. Harmless.
      return c.json({ ok: true, dataset_id: datasetId, duplicate: true });
    }
    console.log(`[pr-review-result] review ${reviewId} (${datasetId}): stored`);
    return c.json({ ok: true, dataset_id: datasetId });
  });
}
