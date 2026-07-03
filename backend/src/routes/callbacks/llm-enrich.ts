/**
 * LLM enrichment dispatch callback: POST /llm-enrich, called by GitHub
 * Actions when README.md or dataset_description.json changes. Bearer-token
 * authed; delegates the pipeline to enrichDataset().
 *
 * Moved verbatim from routes/webhooks.ts (#905, epic #902); the only
 * intentional changes are import paths and the register-function wrapper.
 */

import { enrichDataset } from "../../services/enrich-dataset.js";
import { type WebhookRouter, timingSafeEqual } from "../webhooks/shared.js";

/**
 * Validate a `ref` value supplied to the /webhooks/llm-enrich endpoint.
 * The ref is interpolated into GitHub API URL fragments and into the shell
 * payload emitted by the central `run-enrichment.yml` on
 * `nemarDatasets/.github` (Phase 1 of #601), so the allowed characters
 * are intentionally narrow.
 *
 * Returns null when the ref is acceptable. Otherwise returns a human-readable
 * error string suitable for a 400 response body. Exported so unit tests can
 * pin the validation table without spinning up a webhook harness.
 *
 * Accepts `undefined` so callers can use it on optional request fields; the
 * function treats `undefined` as "field absent" and returns null.
 */
export function validateEnrichmentRef(ref: unknown): string | null {
  if (ref === undefined) return null;
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 200) {
    return "Invalid 'ref' parameter: must be a non-empty string up to 200 characters";
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..") || ref.startsWith("/")) {
    return "Invalid 'ref' parameter: contains forbidden characters";
  }
  return null;
}

export function registerLlmEnrichRoutes(webhooks: WebhookRouter): void {
  /**
   * Trigger LLM-based metadata enrichment for a dataset. Called by GitHub
   * Actions when README.md or dataset_description.json changes. Authenticates
   * via X-Webhook-Token, validates the request shape, and delegates the
   * pipeline work to enrichDataset() in services/enrich-dataset.ts.
   */
  webhooks.post("/llm-enrich", async (c) => {
    const token = c.req.header("X-Webhook-Token");
    // Same secret-untangle as /publish-version-doi: prefer NEMAR_WEBHOOK_TOKEN,
    // fall back to the historically-shared GITHUB_WEBHOOK_SECRET.
    const expectedToken = c.env.NEMAR_WEBHOOK_TOKEN ?? c.env.GITHUB_WEBHOOK_SECRET;

    if (!expectedToken) {
      // Diagnostic log to distinguish "operator misconfiguration" from "real
      // token mismatch" — same rationale as the /publish-version-doi handler
      // (routes/callbacks/version-doi.ts).
      console.error(
        "[llm-enrich] no webhook secret configured (NEMAR_WEBHOOK_TOKEN/GITHUB_WEBHOOK_SECRET both unset or empty)",
      );
      return c.json({ error: "Invalid webhook token" }, 401);
    }
    if (!token || !timingSafeEqual(token, expectedToken)) {
      return c.json({ error: "Invalid webhook token" }, 401);
    }

    let body: {
      dataset_id: string;
      force?: boolean;
      client_commits?: boolean;
      ref?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON in request body" }, 400);
    }

    if (!body.dataset_id) {
      return c.json({ error: "Missing required field: dataset_id" }, 400);
    }
    if (body.force !== undefined && typeof body.force !== "boolean") {
      return c.json({ error: "Invalid 'force' parameter: must be a boolean (true/false)" }, 400);
    }
    if (body.client_commits !== undefined && typeof body.client_commits !== "boolean") {
      return c.json(
        { error: "Invalid 'client_commits' parameter: must be a boolean (true/false)" },
        400,
      );
    }
    const refValidationError = validateEnrichmentRef(body.ref);
    if (refValidationError) {
      return c.json({ error: refValidationError }, 400);
    }

    const outcome = await enrichDataset(c.env, {
      datasetId: body.dataset_id,
      force: body.force,
      clientCommits: body.client_commits,
      ref: body.ref,
    });
    return c.json(outcome.body, outcome.status);
  });
}
