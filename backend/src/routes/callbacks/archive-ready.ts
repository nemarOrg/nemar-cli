/**
 * Archive build callback: POST /archive-ready, called by the archive-zip
 * workflow to record build state, with bounded auto-retry dispatch on
 * failure (epic #736). Bearer-token authed.
 *
 * Moved verbatim from routes/webhooks.ts (#905, epic #902); the only
 * intentional changes are import paths and the register-function wrapper.
 */

import { MAX_ARCHIVE_RETRIES, decideArchiveRetry } from "../../services/archive-retry.js";
import { writeAvailabilityReport } from "../../services/availability-report.js";
import { isValidDatasetId } from "../../services/datasetId.js";
import { getDatasetsToken } from "../../services/github-auth.js";
import { triggerArchiveGeneration } from "../../services/github.js";
import { type WebhookRouter, timingSafeEqual } from "../webhooks/shared.js";

/**
 * POST /webhooks/archive-ready — callback from nemarDatasets/.github
 * `run-generate-archive.yml` once a dataset's downloadable zip archive has been
 * (re)built and uploaded to `s3://nemar/<id>/archives/v<version>.zip`
 * (epic #695, dashboard.nemar.org/observability).
 *
 * Mirror of /zarr-ready: same shared `X-Webhook-Token` (NEMAR_WEBHOOK_TOKEN)
 * auth, records the latest-only archive state on the `datasets` row. No cache
 * purge: archives are served via a presigned S3 302 with `no-store` (data.ts),
 * so there is no shared edge object to invalidate.
 *
 * Responses: 200 once state is recorded; 400 for a bad body or a missing/unknown
 * `status` (deliberately STRICTER than /zarr-ready -- a missing status must NOT
 * silently mark an archive 'ready', which would poison the dashboard's
 * "% with archive"); 404 when the dataset isn't in D1 (surfaces a stale callback
 * to operators rather than swallowing it).
 *
 * Idempotent: replaying re-writes the same row state.
 */
interface ArchiveReadyBody {
  dataset_id: string;
  status?: "ready" | "failed" | "skipped";
  /** Bytes of the generated zip; persisted to datasets.archive_size on 'ready'. */
  size?: number;
  /** The published version the archive was built for (logged, not stored). */
  version?: string;
  error?: string;
  /** Why archive generation was skipped (status='skipped', #752). Persisted to
   *  datasets.archive_skip_reason; its presence is what marks a dataset
   *  "archive skipped" (archive_status stays NULL). */
  reason?: string;
  /** Completeness tally from the build (#1041). Sent by
   *  nemarDatasets/.github run-generate-archive.yml on 'ready'. All optional:
   *  archives built before that shipped, and the idempotent skip path where the
   *  stream script never ran, send none of them and leave the columns NULL
   *  ("not assessed"), which must NOT be read as "incomplete". */
  /** True when every declared file made it into the zip. */
  complete?: boolean;
  /** Annexed objects S3 reported missing, or that failed the size check. */
  absent?: number;
  /** Objects that could not be read for any other reason (403/5xx/throttle).
   *  A 'ready' callback should always carry 0 here -- the build fails and the
   *  zip is deleted otherwise -- so a non-zero value is logged as an anomaly. */
  unreadable?: number;
  /** Total files the version manifest declared. */
  declared?: number;
  /** Annexed objects successfully streamed into the zip. */
  annexed?: number;
}

/** Non-negative integer or null; anything else (string, NaN, negative, float)
 *  is rejected so a malformed payload leaves the column NULL rather than
 *  poisoning it with a value the dashboard would render as fact. */
function countOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** What the 'ready' branch writes to the completeness columns (#1041). */
export interface ArchiveCompleteness {
  /** 1 complete, 0 partial, null not assessed. */
  complete: number | null;
  absent: number | null;
  declared: number | null;
  /** Surfaced so the caller can flag the should-be-impossible ready+unreadable
   *  combination; not persisted (a 'ready' build has none by construction). */
  unreadable: number | null;
}

/**
 * Derive the completeness columns from an archive-ready payload.
 *
 * `complete` is computed from the counts rather than taken from the payload's
 * own `complete` flag whenever both counts are present: the counts are the
 * primitive facts and the flag is a convenience the workflow computes from
 * them, so deriving keeps the column consistent with the numbers stored beside
 * it. The flag is the fallback for a payload that carries only it.
 *
 * Everything null means "not assessed": an archive built before #1041 shipped,
 * or the idempotent skip path where the stream script never ran. Callers must
 * persist that as leave-alone, not as overwrite-with-null.
 */
export function deriveArchiveCompleteness(body: ArchiveReadyBody): ArchiveCompleteness {
  const absent = countOrNull(body.absent);
  const unreadable = countOrNull(body.unreadable);
  const declared = countOrNull(body.declared);
  const complete =
    absent !== null && unreadable !== null
      ? absent + unreadable === 0
        ? 1
        : 0
      : typeof body.complete === "boolean"
        ? body.complete
          ? 1
          : 0
        : null;
  return { complete, absent, declared, unreadable };
}

export function registerArchiveReadyRoutes(webhooks: WebhookRouter): void {
  webhooks.post("/archive-ready", async (c) => {
    const token = c.req.header("X-Webhook-Token");
    const expectedToken = c.env.NEMAR_WEBHOOK_TOKEN ?? c.env.GITHUB_WEBHOOK_SECRET;
    if (!expectedToken) {
      console.error(
        "[archive-ready] no webhook secret configured (NEMAR_WEBHOOK_TOKEN/GITHUB_WEBHOOK_SECRET both unset or empty)",
      );
      return c.json({ error: "Invalid webhook token" }, 401);
    }
    if (!token || !timingSafeEqual(token, expectedToken)) {
      return c.json({ error: "Invalid webhook token" }, 401);
    }

    let body: ArchiveReadyBody;
    try {
      body = (await c.req.json()) as ArchiveReadyBody;
    } catch {
      return c.json({ error: "Invalid JSON in request body" }, 400);
    }

    if (typeof body.dataset_id !== "string" || !isValidDatasetId(body.dataset_id)) {
      return c.json({ error: "dataset_id must be a valid dataset id" }, 400);
    }
    // Require an explicit status: a missing/unknown value must not default to
    // 'ready' (that would mark a failed generation as having an archive).
    if (body.status !== "ready" && body.status !== "failed" && body.status !== "skipped") {
      return c.json({ error: "status must be 'ready', 'failed', or 'skipped'" }, 400);
    }
    const status = body.status;
    if (status === "failed" && body.error) {
      console.error(`[archive-ready] workflow failure dataset=${body.dataset_id}: ${body.error}`);
    }

    // Persist latest-only archive state. On failure keep the prior archive_size
    // (a failed rebuild shouldn't erase the last good zip's size) and only flip
    // the status + stamp checked_at. A 'failed' callback also drives the bounded
    // auto-retry (epic #736, Phase 3): re-dispatch generation while under the cap,
    // counting dispatches in archive_retry_count (reset to 0 on 'ready'). The
    // daily archiveRetrySweep is the backstop. See services/archive-retry.ts.
    let changed = 0;
    let retry: ReturnType<typeof decideArchiveRetry> | null = null;
    try {
      if (status === "ready") {
        const { complete, absent, declared, unreadable } = deriveArchiveCompleteness(body);
        // A 'ready' callback carrying unreadable>0 should be impossible: the
        // build exits non-zero and the wrapper deletes the zip in that case. If
        // it happens the classification logic has drifted, so say so loudly
        // rather than silently recording the archive as merely partial.
        if (unreadable !== null && unreadable > 0) {
          console.error(
            `[archive-ready] ANOMALY dataset=${body.dataset_id}: status=ready with unreadable=${unreadable}; the build should have failed and deleted the zip`,
          );
        }
        const result = await c.env.DB.prepare(
          // Clear archive_skip_reason: a real zip now exists, so a stale skip from
          // an earlier (larger) version must not keep the UI on the direct-download
          // recipe (#752).
          //
          // COALESCE on the completeness columns so a callback that carries no
          // tally leaves prior values intact instead of blanking them. That is
          // the idempotent skip path (archive already existed, stream script
          // never ran): the existing archive's completeness is still true of it,
          // and overwriting with NULL would downgrade a known state to "not
          // assessed".
          `UPDATE datasets
           SET archive_status = 'ready',
               archive_checked_at = datetime('now'),
               archive_size = ?,
               archive_retry_count = 0,
               archive_skip_reason = NULL,
               archive_complete = COALESCE(?, archive_complete),
               archive_absent_files = COALESCE(?, archive_absent_files),
               archive_declared_files = COALESCE(?, archive_declared_files)
           WHERE dataset_id = ?`,
        )
          .bind(
            typeof body.size === "number" ? body.size : null,
            complete,
            absent,
            declared,
            body.dataset_id,
          )
          .run();
        changed = result.meta.changes ?? 0;
      } else if (status === "skipped") {
        // Over the size/file-count policy (#752): the workflow built no zip and
        // steers users to direct download. Record the reason; leave archive_status
        // NULL (skipped is intentional, NOT a failed generation -> no auto-retry).
        // Reset archive_retry_count too (cross-epic with #736): a skip is a clean
        // state transition, so a prior failed-retry history must not block a future
        // auto-retry if the dataset later shrinks and a `failed` arrives.
        const result = await c.env.DB.prepare(
          `UPDATE datasets
           SET archive_skip_reason = ?,
               archive_status = NULL,
               archive_retry_count = 0,
               archive_checked_at = datetime('now')
           WHERE dataset_id = ?`,
        )
          .bind(body.reason ?? "archive skipped (size policy)", body.dataset_id)
          .run();
        changed = result.meta.changes ?? 0;
      } else {
        // Read the current dispatch count to decide whether to re-dispatch. The
        // count is NOT advanced here -- it is incremented only after a successful
        // dispatch (in the waitUntil below), so a failed dispatch can't consume a
        // retry slot. Matches archiveRetrySweep's dispatch-then-increment order.
        const row = await c.env.DB.prepare(
          "SELECT archive_retry_count FROM datasets WHERE dataset_id = ?",
        )
          .bind(body.dataset_id)
          .first<{ archive_retry_count: number }>();
        retry = decideArchiveRetry("failed", row?.archive_retry_count ?? 0, body.version);
        const result = await c.env.DB.prepare(
          `UPDATE datasets
           SET archive_status = 'failed',
               archive_checked_at = datetime('now')
           WHERE dataset_id = ?`,
        )
          .bind(body.dataset_id)
          .run();
        changed = result.meta.changes ?? 0;
      }
    } catch (err) {
      console.error(
        `[archive-ready] D1 update failed dataset=${body.dataset_id}:`,
        err instanceof Error ? err.message : String(err),
      );
      return c.json({ error: "Failed to record archive state" }, 500);
    }

    // A callback for a dataset that isn't in D1 (deleted, or never registered)
    // matches zero rows and persists nothing. Surface it as a 404 instead of a
    // silent 200 -- mirrors the zarr-ready / prescreen-result guards.
    if (changed === 0) {
      console.error(
        `[archive-ready] UPDATE matched 0 rows dataset=${body.dataset_id} status=${status} -- not in D1`,
      );
      return c.json({ error: "Dataset not found" }, 404);
    }

    // Bounded auto-retry: re-dispatch a fresh archive build, fire-and-forget via
    // waitUntil (the same pattern as the other callbacks' post-write side
    // effects) so a slow
    // GitHub /dispatches call can't delay or time out the workflow's callback. The
    // retry-count increment happens HERE, only after a successful dispatch
    // (mirrors archiveRetrySweep) -- a failed dispatch (GitHub 422 / rate-limit)
    // must not consume a retry slot, which would otherwise exhaust the cap without
    // ever running an archive. Phase 2 deletes the partial on failure, so no force.
    if (retry?.retry && body.version) {
      const retryDatasetId = body.dataset_id;
      const retryVersion = body.version;
      const retryAttempt = retry.nextCount;
      c.executionCtx.waitUntil(
        (async () => {
          try {
            const pat = await getDatasetsToken(c.env);
            await triggerArchiveGeneration(retryDatasetId, retryDatasetId, retryVersion, pat, {
              s3Bucket: c.env.S3_BUCKET,
              callbackBaseUrl: c.env.API_BASE_URL,
            });
            await c.env.DB.prepare(
              "UPDATE datasets SET archive_retry_count = ? WHERE dataset_id = ?",
            )
              .bind(retryAttempt, retryDatasetId)
              .run();
            console.log(
              `[archive-ready] auto-retry dispatched dataset=${retryDatasetId} version=${retryVersion} attempt=${retryAttempt}/${MAX_ARCHIVE_RETRIES}`,
            );
          } catch (err) {
            console.error(
              `[archive-ready] auto-retry dispatch failed dataset=${retryDatasetId} (retry slot not consumed):`,
              err instanceof Error ? err.message : String(err),
            );
          }
        })(),
      );
    }

    // Refresh the per-dataset availability report whenever an archive lands
    // (#1041). Before this, writeAvailabilityReport ran only from the admin
    // sweep and the single-dataset admin route, so the report could be stale --
    // or absent entirely -- for the very version whose archive just flipped to
    // 'ready'. That report is the per-file breakdown behind the counts stored
    // above, and the only place a user can see WHICH files are missing, so the
    // two must not drift.
    //
    // Fire-and-forget via waitUntil, matching the auto-retry dispatch: it walks
    // the manifest and writes to GitHub, which must not delay or time out the
    // workflow's callback. A failure is logged and left for the next sweep;
    // the archive state itself is already committed above.
    if (status === "ready") {
      const reportDatasetId = body.dataset_id;
      c.executionCtx.waitUntil(
        (async () => {
          try {
            const report = await writeAvailabilityReport(c.env, reportDatasetId);
            console.log(
              `[archive-ready] availability report refreshed dataset=${reportDatasetId} missing=${report.missing.length}`,
            );
          } catch (err) {
            console.error(
              `[archive-ready] availability report refresh failed dataset=${reportDatasetId} (left for the next sweep):`,
              err instanceof Error ? err.message : String(err),
            );
          }
        })(),
      );
    }

    console.log(
      `[archive-ready] dataset=${body.dataset_id} status=${status} size=${body.size ?? "?"} version=${body.version ?? "?"} complete=${body.complete ?? "?"} absent=${body.absent ?? "?"}${retry ? ` retry=${retry.reason} count=${retry.nextCount}` : ""}`,
    );

    return c.json({ ok: true, dataset_id: body.dataset_id, status });
  });
}
