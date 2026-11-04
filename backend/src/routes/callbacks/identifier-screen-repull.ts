/**
 * Re-pull identifier-screen callback: POST /identifier-screen-repull-result, called by the
 * `run-identifier-screen` workflow for a screen dispatched by a re-pull (epic #1046 phase 6,
 * #1912; ADR 0111, decision 7).
 *
 * The same workflow and report as the publication screen and the sweep, a third door: the screen
 * belongs to a re-pull's pull request, so its token is the identifier-repull kind (domain-tagged,
 * over the dataset, the re-pull row, the pull request, the screened commit and the attempt's
 * nonce) and its row is `upstream_repull_screens`. One-shot: the nonce is found only while the
 * screen waits for its report and its re-pull is open, and storing a result clears it, so a
 * replay gets 401.
 *
 * Body: `{ dataset_id, request_id, workflow_run_id?, report }`; a re-pull dispatches `request_id`
 * 0. Every field is untrusted: `dataset_id` and `request_id` are checked against their exact
 * shapes before they are used or logged, `workflow_run_id` is logged only when it is a run number,
 * and `report` reaches nothing except through `parseScreenReport`.
 *
 * Mails nobody, and answers without the verdict: the workflow does not need it, and its logs are
 * public. The administrator reads the verdict from `GET /admin/repulls/:id/screens`.
 */

import { isValidDatasetId } from "../../services/datasetId.js";
import { verifyIdentifierRepullCallbackToken } from "../../services/github/callback-tokens.js";
import {
  REPULL_SCREEN_WAITING_SQL,
  storeRepullScreenResult,
} from "../../services/upstream-repull-screen.js";
import type { WebhookRouter } from "../webhooks/shared.js";
import { readBoundedJsonObject } from "./bounded-json.js";

/** One answer for every refusal of the token, so it does not say which datasets have a screen running. */
const UNAUTHORIZED = { error: "Invalid or expired callback token" } as const;

interface WaitingScreen {
  id: number;
  repull_id: number;
  pr: string;
  sha: string;
  nonce: string | null;
}

export function registerIdentifierScreenRepullCallbackRoutes(webhooks: WebhookRouter): void {
  webhooks.post("/identifier-screen-repull-result", async (c) => {
    const token = c.req.header("X-Webhook-Token");
    if (!token) return c.json(UNAUTHORIZED, 401);

    const read = await readBoundedJsonObject(c);
    if (!read.ok) return c.json({ error: read.error }, read.status);
    const b = read.body;
    if (typeof b.dataset_id !== "string" || !isValidDatasetId(b.dataset_id)) {
      return c.json({ error: "dataset_id must be a dataset id" }, 400);
    }
    // A re-pull dispatches no request, and the workflow echoes 0. Anything else is a callback
    // meant for the publication route.
    if (b.request_id !== 0) {
      return c.json({ error: "request_id must be 0 for a re-pull screen" }, 400);
    }
    const datasetId = b.dataset_id;
    const runId =
      typeof b.workflow_run_id === "string" && /^\d{1,20}$/.test(b.workflow_run_id)
        ? b.workflow_run_id
        : typeof b.workflow_run_id === "number" && Number.isSafeInteger(b.workflow_run_id)
          ? String(b.workflow_run_id)
          : null;

    const secret = c.env.PRESCREEN_CALLBACK_SECRET;
    if (!secret) {
      console.error(
        "[identifier-screen-repull-result] PRESCREEN_CALLBACK_SECRET is unset; rejecting",
      );
      return c.json({ error: "Server misconfigured: callback secret unset" }, 500);
    }

    const waiting = await c.env.DB.prepare(REPULL_SCREEN_WAITING_SQL)
      .bind(datasetId)
      .first<WaitingScreen>();
    const nonce = typeof waiting?.nonce === "string" && waiting.nonce !== "" ? waiting.nonce : null;
    if (!waiting || nonce === null) {
      console.warn(`[identifier-screen-repull-result] no re-pull screen waiting for ${datasetId}`);
      return c.json(UNAUTHORIZED, 401);
    }
    const ok = await verifyIdentifierRepullCallbackToken(
      token,
      { datasetId, repullId: waiting.repull_id, pr: waiting.pr, sha: waiting.sha, nonce },
      secret,
    );
    if (!ok) {
      console.warn(`[identifier-screen-repull-result] callback token mismatch for ${datasetId}`);
      return c.json(UNAUTHORIZED, 401);
    }

    const stored = await storeRepullScreenResult(c.env.DB, {
      datasetId,
      screenId: waiting.id,
      sha: waiting.sha,
      nonce,
      body: b.report,
    });
    if (!stored.stored) {
      // Verified, but a duplicate of this callback won the one conditional UPDATE between the
      // read and the write. Harmless.
      console.warn(`[identifier-screen-repull-result] ${datasetId}: result already recorded`);
      return c.json({ ok: true, dataset_id: datasetId, duplicate: true });
    }
    // Fixed vocabulary only; the verdict is not logged.
    console.log(
      `[identifier-screen-repull-result] ${datasetId} re-pull ${waiting.repull_id} ${waiting.pr}: ${
        stored.error ? `stored as an error (${stored.error})` : "result stored"
      }${runId ? ` run=${runId}` : ""}`,
    );
    return c.json({ ok: true, dataset_id: datasetId });
  });
}
