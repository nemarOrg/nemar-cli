/**
 * Re-pull run callback: POST /repull-state, called by the central `run-upstream-repull` workflow
 * to report on the dispatch it was sent (epic #1046 phase 7, #1913; ADR 0111, decision 6).
 *
 * The token is the re-pull dispatch kind (domain-tagged, over the dispatch, its dataset and its
 * one-shot nonce), presented in `X-Repull-Token`. It verifies only while the dispatch is live, and
 * the edge that ends the dispatch clears the nonce, so a replay after it is refused. Every refusal
 * of the token is one answer, so the door does not say which dispatches exist.
 *
 * Body: `{ dispatch_id, dataset_id, phase, code?, repull_id?, workflow_run_url? }`, strict and
 * small. Every field is untrusted: it reaches nothing except through the schema, a code is a word
 * from the closed list, and the answer is fixed words that echo no value. The workflow's log is
 * public, and so is anything it prints of the answer.
 *
 * Production only, and mails nobody (`repull-no-mail-scan.test.ts`).
 */

import { storeDispatchReport } from "../../services/upstream-repull-dispatch.js";
import type { WebhookRouter } from "../webhooks/shared.js";
import { readBoundedJsonObject } from "./bounded-json.js";

/** A report is a few hundred bytes; anything larger is not one. */
const MAX_REPORT_BYTES = 4096;

const ANSWERS: Readonly<Record<string, string>> = {
  "invalid-body": "The report is not one this callback takes.",
  "invalid-token": "Invalid or expired dispatch token.",
  "auto-production-only": "Re-pull runs report to the production Worker only.",
  "already-started": "This dispatch has already reported that it started.",
  "kind-mismatch": "This dispatch is not of the kind the report is for.",
  "repull-mismatch": "The report names a re-pull this dispatch is not linked to.",
  "repull-not-ready": "The re-pull is not in the state this report says it reached.",
  "stale-dispatch": "The dispatch moved before the report was stored; read it again.",
  "dispatch-unconfigured": "The Worker has no callback secret.",
};

export function registerRepullStateCallbackRoutes(webhooks: WebhookRouter): void {
  webhooks.post("/repull-state", async (c) => {
    const token = c.req.header("X-Repull-Token");
    if (!token) return c.json({ error: ANSWERS["invalid-token"], code: "invalid-token" }, 401);
    const read = await readBoundedJsonObject(c, MAX_REPORT_BYTES);
    if (!read.ok) return c.json({ error: read.error, code: "invalid-body" }, read.status);

    const outcome = await storeDispatchReport(c.env, token, read.body);
    if (outcome.status === 200) {
      // Fixed words only: the dispatch id and phase come from a body the schema accepted.
      const b = read.body as { dispatch_id: number; dataset_id: string; phase: string };
      console.log(`[repull-state] ${b.dataset_id} dispatch ${b.dispatch_id}: ${b.phase} stored`);
      return c.json({ ok: true, code: outcome.code });
    }
    if (outcome.status >= 500) console.error(`[repull-state] refused: ${outcome.code}`);
    else console.warn(`[repull-state] refused: ${outcome.code}`);
    return c.json({ error: ANSWERS[outcome.code], code: outcome.code }, outcome.status);
  });
}
