/**
 * OpenNeuro import state callback: POST /import-state, called by the
 * onboard-openneuro.yml workflow (issue #754). Bearer-token authed.
 *
 * Moved verbatim from routes/webhooks.ts (#905, epic #902); the only
 * intentional changes are import paths and the register-function wrapper.
 */

import { timingSafeEqual } from "../../lib/constant-time.js";
import { isValidDatasetId } from "../../services/datasetId.js";
import { fileImportFailureIssueIfNeeded } from "../../services/import-failure-issue.js";
import {
  IMPORT_STATUSES,
  type ImportStatus,
  OPENNEURO_UPSTREAM_MARKER,
  runImportRecovery,
} from "../../services/import-recovery.js";
import type { WebhookRouter } from "../webhooks/shared.js";

// ============================================================================
// Import state callback (issue #754)
// ============================================================================

export interface ImportStateBody {
  dataset_id: string;
  source: string;
  source_id: string;
  stage: string; // prepare | copy | finalize
  status: string; // one of IMPORT_STATUSES
  error_message?: string;
  workflow_run_url?: string;
  shards_total?: number;
}

/** Validate the onboard-openneuro.yml import-state callback body. */
export function validateImportStateBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.dataset_id !== "string" || !b.dataset_id) {
    return "dataset_id must be a non-empty string";
  }
  if (typeof b.source !== "string" || !b.source) return "source must be a non-empty string";
  if (typeof b.source_id !== "string" || !b.source_id)
    return "source_id must be a non-empty string";
  if (typeof b.stage !== "string" || !b.stage) return "stage must be a non-empty string";
  if (typeof b.status !== "string" || !IMPORT_STATUSES.includes(b.status as ImportStatus)) {
    return `status must be one of: ${IMPORT_STATUSES.join(", ")}`;
  }
  if (b.error_message !== undefined && typeof b.error_message !== "string") {
    return "error_message must be a string";
  }
  if (b.workflow_run_url !== undefined && typeof b.workflow_run_url !== "string") {
    return "workflow_run_url must be a string";
  }
  if (
    b.shards_total !== undefined &&
    (typeof b.shards_total !== "number" || !Number.isInteger(b.shards_total))
  ) {
    return "shards_total must be an integer";
  }
  return null;
}

export function registerImportStateRoutes(webhooks: WebhookRouter): void {
  /**
   * Import-state callback from onboard-openneuro.yml (#754). Bearer-authed with
   * NEMAR_WEBHOOK_TOKEN. Upserts the single import_jobs row per dataset_id. A
   * `preparing` POST unconditionally (re)seeds the row so a re-import after
   * rollback self-heals; every other transition is monotonic and never regresses
   * past a terminal state. On a landed terminal `failed`, the rollback-or-
   * quarantine decision runs in the background (waitUntil) so the callback
   * returns promptly.
   */
  webhooks.post("/import-state", async (c) => {
    const token = c.req.header("X-Webhook-Token");
    // Same secret-untangle as /llm-enrich: prefer NEMAR_WEBHOOK_TOKEN, fall back
    // to the historically-shared GITHUB_WEBHOOK_SECRET.
    const expectedToken = c.env.NEMAR_WEBHOOK_TOKEN ?? c.env.GITHUB_WEBHOOK_SECRET;
    if (!expectedToken) {
      console.error(
        "[import-state] no webhook secret configured (NEMAR_WEBHOOK_TOKEN/GITHUB_WEBHOOK_SECRET both unset)",
      );
      return c.json({ error: "Invalid webhook token" }, 401);
    }
    if (!token || !timingSafeEqual(token, expectedToken)) {
      return c.json({ error: "Invalid webhook token" }, 401);
    }

    let body: ImportStateBody;
    try {
      body = (await c.req.json()) as ImportStateBody;
    } catch {
      return c.json({ error: "Invalid JSON in request body" }, 400);
    }

    const validationError = validateImportStateBody(body);
    if (validationError) return c.json({ error: validationError }, 400);
    if (!isValidDatasetId(body.dataset_id)) {
      return c.json({ error: `Invalid dataset_id: ${body.dataset_id}` }, 400);
    }

    const status = body.status as ImportStatus;
    const stage = body.stage;
    const runUrl = body.workflow_run_url ?? null;
    const shardsTotal = body.shards_total ?? null;
    const errorMsg = body.error_message ?? null;

    try {
      if (status === "preparing") {
        // A fresh import attempt: unconditionally (re)seed the row, clearing any
        // prior terminal state so a re-import after rollback/quarantine heals.
        await c.env.DB.prepare(
          `INSERT INTO import_jobs
             (dataset_id, source, source_id, stage, status, shards_total, workflow_run_url,
              last_error, completed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'preparing', ?, ?, NULL, NULL, datetime('now'), datetime('now'))
           ON CONFLICT(dataset_id) DO UPDATE SET
             source = excluded.source, source_id = excluded.source_id,
             stage = excluded.stage, status = 'preparing',
             shards_total = COALESCE(excluded.shards_total, import_jobs.shards_total),
             workflow_run_url = COALESCE(excluded.workflow_run_url, import_jobs.workflow_run_url),
             last_error = NULL, completed_at = NULL, updated_at = datetime('now')`,
        )
          .bind(body.dataset_id, body.source, body.source_id, stage, shardsTotal, runUrl)
          .run();
      } else {
        // Monotonic: `failed` may upgrade an in-flight row; complete/rolled_back/
        // quarantined are sticky (the WHERE refuses a regressing update). The
        // 9th bind feeds the completed_at CASE on a fresh insert.
        await c.env.DB.prepare(
          `INSERT INTO import_jobs
             (dataset_id, source, source_id, stage, status, shards_total, workflow_run_url,
              last_error, completed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?,
                   CASE WHEN ? IN ('complete','failed','quarantined','rolled_back')
                        THEN datetime('now') ELSE NULL END,
                   datetime('now'), datetime('now'))
           ON CONFLICT(dataset_id) DO UPDATE SET
             stage = excluded.stage, status = excluded.status,
             shards_total = COALESCE(excluded.shards_total, import_jobs.shards_total),
             workflow_run_url = COALESCE(excluded.workflow_run_url, import_jobs.workflow_run_url),
             -- Sticky upstream marker (#808): once a prepare leg records the
             -- OpenNeuro-inaccessible marker, the doomed copy/finalize legs that
             -- still run under \`if: !cancelled()\` MUST NOT clobber it with their
             -- generic terminal error (or the finalizing POST's NULL). classifyRecovery
             -- reads last_error, so keeping the marker guarantees the quarantine is
             -- classified \`upstream_inaccessible\` regardless of POST ordering vs the
             -- async waitUntil recovery. A fresh attempt clears it via the 'preparing'
             -- branch above ([ ] are literal in SQLite LIKE, not wildcards).
             last_error = CASE
               WHEN import_jobs.last_error LIKE '%${OPENNEURO_UPSTREAM_MARKER}%'
                    AND COALESCE(excluded.last_error, '') NOT LIKE '%${OPENNEURO_UPSTREAM_MARKER}%'
               THEN import_jobs.last_error
               ELSE excluded.last_error END,
             completed_at = CASE WHEN excluded.status IN ('complete','failed','quarantined','rolled_back')
                                 THEN datetime('now') ELSE import_jobs.completed_at END,
             updated_at = datetime('now')
           WHERE import_jobs.status NOT IN ('complete','rolled_back','quarantined')`,
        )
          .bind(
            body.dataset_id,
            body.source,
            body.source_id,
            stage,
            status,
            shardsTotal,
            runUrl,
            errorMsg,
            status,
          )
          .run();
      }
    } catch (err) {
      console.error(`[import-state] upsert failed for ${body.dataset_id}:`, err);
      return c.json({ error: "Failed to record import state" }, 500);
    }

    // On a landed terminal failure, run the rollback-or-quarantine decision. Only
    // when the row is actually `failed` now (the monotonic guard may have refused
    // to regress a row that already reached complete).
    if (status === "failed") {
      const cur = await c.env.DB.prepare("SELECT status FROM import_jobs WHERE dataset_id = ?")
        .bind(body.dataset_id)
        .first<{ status: string }>();
      if (cur?.status === "failed") {
        c.executionCtx.waitUntil(
          runImportRecovery(c.env.DB, c.env, body.dataset_id).catch((err) =>
            console.error(`[import-state] recovery failed for ${body.dataset_id}:`, err),
          ),
        );
        // Auto-file a triage issue on nemarDatasets/.github (epic #967
        // follow-up). fileImportFailureIssueIfNeeded re-checks its own gate
        // (genuine failure / prod / non-sandbox / non-exemplar) against
        // cur.status, so this call is safe even though the outer `if` above
        // already narrows to the same condition. Best-effort: never fails
        // the webhook, which onboard-openneuro.yml needs to succeed.
        c.executionCtx.waitUntil(
          fileImportFailureIssueIfNeeded(c.env.DB, c.env, {
            datasetId: body.dataset_id,
            sourceId: body.source_id,
            stage,
            errorMessage: errorMsg,
            workflowRunUrl: runUrl,
            resultingStatus: cur.status,
          }).catch((err) =>
            console.error(`[import-state] issue-filing failed for ${body.dataset_id}:`, err),
          ),
        );
      }
    }

    console.log(
      `[import-state] dataset=${body.dataset_id} stage=${stage} status=${status}${errorMsg ? ` error=${errorMsg}` : ""}`,
    );
    return c.json({ ok: true, dataset_id: body.dataset_id, status });
  });
}
