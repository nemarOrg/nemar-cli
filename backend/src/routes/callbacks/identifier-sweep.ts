/**
 * Identifier-sweep callback: POST /identifier-sweep-result, called by the
 * `run-identifier-screen` workflow when the scheduled sweep dispatched it
 * (epic #1610, phase 5, ADR 0088).
 *
 * The same workflow and report as the publication screen
 * (`identifier-screen.ts` beside this file), a different door: a sweep screen
 * belongs to a dataset, not to a publication request, so its token is the
 * identifier-sweep kind (domain-tagged, over the dataset id and the attempt's
 * nonce) and its row is the dataset's. One-shot: the nonce is found only while
 * the attempt waits for its report (`pending`, or `unreported` so a late report
 * still lands, for a bounded time), and storing a result clears it, so a
 * replay gets 401.
 *
 * Body: `{ dataset_id, request_id, workflow_run_id?, report }`; the sweep
 * dispatches `request_id` 0. Every field is untrusted: `dataset_id` and
 * `request_id` are checked against their exact shapes before they are used or
 * logged, `workflow_run_id` is logged only when it is a run number, and
 * `report` reaches nothing except through `parseScreenReport`.
 *
 * Mails nobody, and answers without the verdict: the workflow does not need it,
 * and its logs are public.
 */

import { isValidDatasetId } from "../../services/datasetId.js";
import { verifyIdentifierSweepCallbackToken } from "../../services/github.js";
import { IDENTIFIER_SWEEP_NONCE_SQL, storeSweepResult } from "../../services/identifier-sweep.js";
import type { WebhookRouter } from "../webhooks/shared.js";
import { readBoundedJsonObject } from "./bounded-json.js";

/** One answer for every refusal of the token, so it does not say which datasets have a screen running. */
const UNAUTHORIZED = { error: "Invalid or expired callback token" } as const;

export function registerIdentifierSweepCallbackRoutes(webhooks: WebhookRouter): void {
  webhooks.post("/identifier-sweep-result", async (c) => {
    const token = c.req.header("X-Webhook-Token");
    if (!token) return c.json(UNAUTHORIZED, 401);

    const read = await readBoundedJsonObject(c);
    if (!read.ok) return c.json({ error: read.error }, read.status);
    const b = read.body;
    if (typeof b.dataset_id !== "string" || !isValidDatasetId(b.dataset_id)) {
      return c.json({ error: "dataset_id must be a dataset id" }, 400);
    }
    // The sweep dispatches no request, and the workflow echoes 0. Anything else
    // is a callback meant for the publication route.
    if (b.request_id !== 0) {
      return c.json({ error: "request_id must be 0 for a sweep screen" }, 400);
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
      console.error("[identifier-sweep-result] PRESCREEN_CALLBACK_SECRET is unset; rejecting");
      return c.json({ error: "Server misconfigured: callback secret unset" }, 500);
    }

    const row = await c.env.DB.prepare(IDENTIFIER_SWEEP_NONCE_SQL)
      .bind(datasetId)
      .first<{ nonce: unknown }>();
    const nonce = typeof row?.nonce === "string" && row.nonce !== "" ? row.nonce : null;
    if (nonce === null) {
      console.warn(`[identifier-sweep-result] no sweep screen waiting for ${datasetId}`);
      return c.json(UNAUTHORIZED, 401);
    }
    const ok = await verifyIdentifierSweepCallbackToken(token, { datasetId, nonce }, secret);
    if (!ok) {
      console.warn(`[identifier-sweep-result] callback token mismatch for ${datasetId}`);
      return c.json(UNAUTHORIZED, 401);
    }

    const stored = await storeSweepResult(c.env, { datasetId, nonce, body: b.report });
    if (!stored.stored) {
      // Verified, but a duplicate of this callback won the one conditional
      // UPDATE between the read and the write. Harmless.
      console.warn(`[identifier-sweep-result] ${datasetId}: result already recorded`);
      return c.json({ ok: true, dataset_id: datasetId, duplicate: true });
    }
    // The outcome kind and the error word are fixed vocabulary; the verdict is
    // not logged (the Worker's logs are not the place a finding is kept).
    console.log(
      `[identifier-sweep-result] ${datasetId}: ${stored.kind === "error" ? `error=${stored.error}` : "verdict stored"}${
        runId ? ` run=${runId}` : ""
      }`,
    );
    return c.json({ ok: true, dataset_id: datasetId });
  });
}
