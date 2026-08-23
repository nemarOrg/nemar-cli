/**
 * Zarr conversion callback: POST /zarr-ready, called by the Zarr build
 * pipeline to record conversion state on the datasets row (+ best-effort
 * CDN cache purge). Bearer-token authed.
 *
 * Moved verbatim from routes/webhooks.ts (#905, epic #902); the only
 * intentional changes are import paths and the register-function wrapper.
 */

import { purgeCacheUrls, zarrPurgeTargets } from "../../services/cloudflare.js";
import { isValidDatasetId } from "../../services/datasetId.js";
import { type WebhookRouter, timingSafeEqual } from "../webhooks/shared.js";

/**
 * POST /webhooks/zarr-ready — callback from `scripts/zarr/hallu-zarr.sh`, which
 * lives in THIS repo and runs on the SDSC Hallu cron (ADR 0029 repatriated it
 * from nemarDatasets/.github), once a dataset's Zarr serving copy has been
 * (re)built and synced to `s3://nemar/<id>/zarr/...` (epic #684 / Stream C).
 *
 * Authenticated with the shared `X-Webhook-Token` (NEMAR_WEBHOOK_TOKEN), same
 * as /publish-version-doi. Records the latest-only conversion state on the
 * `datasets` row (status, store count, index ETag, source commit, timestamp)
 * and best-effort purges the small shared cache objects (index.json + each
 * changed store's zarr.json) so the viewer sees added/removed stores promptly;
 * the bulk chunk objects ride the edge TTL + ETag revalidation.
 *
 * Idempotent: replaying a callback re-writes the same row state and re-purges
 * the same URLs (both harmless). Always 200 on a valid token + body so the
 * workflow's fire-and-forget POST doesn't see a retryable error.
 */
interface ZarrDataFailure {
  path?: string;
  code?: string;
  reason?: string;
}

interface ZarrReadyBody {
  dataset_id: string;
  // 'converting' is the live in-progress signal the Hallu driver POSTs when it
  // starts a dataset, so the dashboard's "Processing" tile reflects conversions
  // actually running (the cron has no Actions dispatch to set it). 'ready' /
  // 'failed' are the terminal outcomes. See #774.
  status?: "ready" | "failed" | "converting";
  store_count?: number;
  index_etag?: string;
  commit?: string;
  converted?: string[];
  removed?: string[];
  error?: string;
  // Failure detail (#774). The converter now reports these on EVERY callback,
  // including a total failure (status='failed') which previously sent none.
  errors?: number; // recordings that failed this run (0 = clean)
  failed?: string[]; // their source paths
  failure_count?: number; // subset that are TYPED data failures
  data_failures?: ZarrDataFailure[]; // typed failures [{path, code, reason}]
  deterministic?: boolean; // all failures are typed data failures (won't retry)
  // Memory-robustness telemetry (epic #1108). Declared here because an
  // undeclared field is silently dropped by this handler's typed read -- the
  // converter was reporting these and nothing was listening.
  pool_breaks?: number; // worker-pool breaks RECOVERED this run; 0 is healthy
  measured_count?: number; // recordings whose peak RAM was actually measured
  calibration?: unknown[]; // per-format measured-vs-projected peak RAM
}

/**
 * Derive the Zarr failure-tracking columns persisted by /webhooks/zarr-ready
 * (#774). A 'ready' run can still be PARTIAL (errors>0 while the index has the
 * stores that converted); a 'failed' run is a total failure. `hadErrors` drives
 * `zarr_failed_at`, so a clean run clears the failure detail and the dashboard
 * can sort/filter recent failures. Defensive against missing/garbage fields so
 * the always-200 callback contract holds.
 */
export function zarrFailureColumns(body: {
  errors?: number;
  failure_count?: number;
  deterministic?: boolean;
  data_failures?: unknown;
}): {
  errors: number;
  failureCount: number;
  deterministic: 0 | 1;
  dataFailuresJson: string | null;
  hadErrors: boolean;
} {
  const errors =
    typeof body.errors === "number" && Number.isFinite(body.errors)
      ? Math.max(0, Math.trunc(body.errors))
      : 0;
  const dataFailures = Array.isArray(body.data_failures) ? body.data_failures : [];
  const rawFailureCount =
    typeof body.failure_count === "number" && Number.isFinite(body.failure_count)
      ? Math.max(0, Math.trunc(body.failure_count))
      : dataFailures.length;
  // Typed data failures are a SUBSET of total errors; clamp so a converter bug
  // (or a missing failure_count) can never render "3 data failures of 1 error".
  const failureCount = Math.min(rawFailureCount, errors);
  // Store only the known fields, length-capped: the values are display-only on
  // the dashboard and `datasets` is heavily queried, so a malformed/huge
  // data_failures item must not bloat the row's TEXT column.
  const sanitized = dataFailures.map((item) => {
    if (typeof item !== "object" || item === null) return {};
    const i = item as Record<string, unknown>;
    return {
      ...(typeof i.path === "string" ? { path: i.path.slice(0, 512) } : {}),
      ...(typeof i.code === "string" ? { code: i.code.slice(0, 64) } : {}),
      ...(typeof i.reason === "string" ? { reason: i.reason.slice(0, 256) } : {}),
    };
  });
  return {
    errors,
    failureCount,
    deterministic: body.deterministic === true ? 1 : 0,
    dataFailuresJson: sanitized.length > 0 ? JSON.stringify(sanitized) : null,
    hadErrors: errors > 0,
  };
}

export function registerZarrReadyRoutes(webhooks: WebhookRouter): void {
  webhooks.post("/zarr-ready", async (c) => {
    const token = c.req.header("X-Webhook-Token");
    const expectedToken = c.env.NEMAR_WEBHOOK_TOKEN ?? c.env.GITHUB_WEBHOOK_SECRET;
    if (!expectedToken) {
      console.error(
        "[zarr-ready] no webhook secret configured (NEMAR_WEBHOOK_TOKEN/GITHUB_WEBHOOK_SECRET both unset or empty)",
      );
      return c.json({ error: "Invalid webhook token" }, 401);
    }
    if (!token || !timingSafeEqual(token, expectedToken)) {
      return c.json({ error: "Invalid webhook token" }, 401);
    }

    let body: ZarrReadyBody;
    try {
      body = (await c.req.json()) as ZarrReadyBody;
    } catch {
      return c.json({ error: "Invalid JSON in request body" }, 400);
    }

    if (typeof body.dataset_id !== "string" || !isValidDatasetId(body.dataset_id)) {
      return c.json({ error: "dataset_id must be a valid dataset id" }, 400);
    }
    const status =
      body.status === "failed" ? "failed" : body.status === "converting" ? "converting" : "ready";

    // Persist latest-only conversion state. On failure keep the prior
    // store_count/etag/commit (a failed rebuild shouldn't erase the last good
    // copy's bookkeeping) and only flip the status + stamp converted_at.
    // Failure detail for the observability dashboard (#774). Recorded on BOTH
    // terminal branches: a 'ready' run can be partial (some recordings failed) and
    // a 'failed' run is a total failure. `zarr_failed_at` is stamped only when this
    // run had errors, so a clean run clears the detail.
    const f = zarrFailureColumns(body);
    let changed = 0;
    try {
      if (status === "converting") {
        // In-progress signal (#774): the Hallu driver POSTs this when it starts a
        // dataset so the dashboard "Processing" tile reflects live conversions.
        // Mark zarr_status='pending' (the dashboard's processing state) and clear
        // any prior failure detail -- this is a fresh attempt in flight. Leave the
        // last-good store_count/etag/commit untouched. A terminal ready/failed
        // callback overwrites this when the conversion finishes.
        const result = await c.env.DB.prepare(
          `UPDATE datasets
           SET zarr_status = 'pending',
               zarr_errors = NULL,
               zarr_failure_count = NULL,
               zarr_deterministic = NULL,
               zarr_data_failures = NULL,
               zarr_failed_at = NULL
           WHERE dataset_id = ?`,
        )
          .bind(body.dataset_id)
          .run();
        changed = result.meta.changes ?? 0;
      } else if (status === "ready") {
        const result = await c.env.DB.prepare(
          `UPDATE datasets
           SET zarr_status = 'ready',
               zarr_converted_at = datetime('now'),
               zarr_store_count = ?,
               zarr_index_etag = ?,
               zarr_source_commit = ?,
               zarr_errors = ?,
               zarr_failure_count = ?,
               zarr_deterministic = ?,
               zarr_data_failures = ?,
               zarr_pool_breaks = ?,
               zarr_failed_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END
           WHERE dataset_id = ?`,
        )
          .bind(
            typeof body.store_count === "number" ? body.store_count : null,
            body.index_etag ?? null,
            body.commit ?? null,
            f.errors,
            f.failureCount,
            f.deterministic,
            f.dataFailuresJson,
            typeof body.pool_breaks === "number" ? body.pool_breaks : null,
            f.hadErrors ? 1 : 0,
            body.dataset_id,
          )
          .run();
        changed = result.meta.changes ?? 0;
      } else {
        // Record failure for the observability dashboard only -- do NOT auto-retry
        // zarr here. Conversion is owned by the hourly Hallu cron (workflow
        // autodispatch is intentionally off), which re-attempts on its own
        // schedule; many zarr failures are the mixed-rate EDF/BDF reader bug
        // (#737) that a re-dispatch wouldn't fix. This is the deliberate contrast
        // with the archive-ready auto-retry (epic #736, Phase 3 decision). Keep
        // the prior store_count/etag/commit (a failed rebuild shouldn't erase the
        // last good copy's bookkeeping) and only flip status + the failure detail.
        // zarr_pool_breaks is recorded here too, not just on the ready path. The
        // driver sends it with either status, and a run that failed outright is
        // the STRONGEST node-pressure signal there is -- dropping it would leave
        // the column stale at the last successful run's value and defeat the
        // point of migration 0069 ("a node under sustained memory pressure looks
        // healthy until it isn't") in exactly the case it was added for.
        const result = await c.env.DB.prepare(
          `UPDATE datasets
           SET zarr_status = 'failed',
               zarr_errors = ?,
               zarr_failure_count = ?,
               zarr_deterministic = ?,
               zarr_data_failures = ?,
               zarr_pool_breaks = ?,
               zarr_failed_at = datetime('now')
           WHERE dataset_id = ?`,
        )
          .bind(
            f.errors,
            f.failureCount,
            f.deterministic,
            f.dataFailuresJson,
            typeof body.pool_breaks === "number" ? body.pool_breaks : null,
            body.dataset_id,
          )
          .run();
        changed = result.meta.changes ?? 0;
      }
    } catch (err) {
      console.error(
        `[zarr-ready] D1 update failed dataset=${body.dataset_id}:`,
        err instanceof Error ? err.message : String(err),
      );
      return c.json({ error: "Failed to record zarr state" }, 500);
    }

    // A callback for a dataset that isn't in D1 (deleted, or never registered)
    // matches zero rows and persists nothing. Surface it as a 404 instead of a
    // 200 that silently drops the state -- mirrors the prescreen-result
    // meta.changes guard. The workflow logs the 404 for an operator to chase.
    if (changed === 0) {
      console.error(`[zarr-ready] UPDATE matched 0 rows dataset=${body.dataset_id} -- not in D1`);
      return c.json({ error: "Dataset not found" }, 404);
    }

    // Best-effort cache purge of the freshness-sensitive shared objects. Wrapped
    // so a malformed `converted` entry (a non-string would make `.trim()` throw)
    // can't break the always-200 contract; purgeCacheUrls itself never throws.
    let purge: Awaited<ReturnType<typeof purgeCacheUrls>> | undefined;
    if (status === "ready") {
      try {
        const targets = zarrPurgeTargets(c.env, body.dataset_id, body.converted ?? []);
        if (targets.length === 0 && !c.env.ZARR_CACHE_BASE_URL) {
          console.warn(
            `[zarr-ready] ZARR_CACHE_BASE_URL unset; cache purge skipped dataset=${body.dataset_id}`,
          );
        }
        purge = await purgeCacheUrls(c.env, targets);
        if (!purge.ok) {
          console.warn(
            `[zarr-ready] cache purge incomplete dataset=${body.dataset_id}: ${purge.detail ?? "unknown"}`,
          );
        }
      } catch (err) {
        console.warn(
          `[zarr-ready] cache purge threw dataset=${body.dataset_id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    console.log(
      `[zarr-ready] dataset=${body.dataset_id} status=${status} stores=${body.store_count ?? "?"} converted=${body.converted?.length ?? 0} removed=${body.removed?.length ?? 0} purged=${purge?.submitted ?? 0} pool_breaks=${body.pool_breaks ?? "?"}`,
    );

    // Peak-RAM calibration (#1111) is diagnostic rather than dashboard material,
    // so it is logged rather than given a column -- but it is logged HERE, on the
    // Worker, instead of only in a cron log on one box nobody tails. Only when
    // there is something to say.
    if (body.pool_breaks || (body.calibration?.length ?? 0) > 0) {
      console.log(
        `[zarr-ready] dataset=${body.dataset_id} memory: pool_breaks=${body.pool_breaks ?? 0} measured=${body.measured_count ?? 0} calibration=${JSON.stringify(body.calibration ?? [])}`,
      );
    }

    return c.json({
      ok: true,
      dataset_id: body.dataset_id,
      status,
      ...(purge ? { cache_purge: { ok: purge.ok, submitted: purge.submitted } } : {}),
    });
  });
}
