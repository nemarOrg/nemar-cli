/**
 * Bounded auto-retry for failed archive generation (epic #736, Phase 3 / #740).
 *
 * `/webhooks/archive-ready` records `archive_status='failed'` when
 * `nemarDatasets/.github` `run-generate-archive.yml` fails, but nothing used to
 * re-dispatch -- a failed archive sat failed until a human noticed (the nm000111
 * incident). Two mechanisms now share one counter and cap:
 *
 *   - the archive-ready webhook re-dispatches immediately on a `failed` callback
 *     (fast self-heal during a publish), and
 *   - `archiveRetrySweep` (a daily Worker-cron backstop) re-dispatches still-failed
 *     datasets whose last attempt is stale -- catching a chain that broke because a
 *     callback was lost.
 *
 * `archive_retry_count` (migration 0040) counts retry DISPATCHES; it is
 * incremented at the moment a retry is dispatched (so the webhook and sweep never
 * double-count one attempt), capped at `MAX_ARCHIVE_RETRIES`, and reset to 0 on a
 * `ready` callback. Zarr is deliberately NOT retried here: conversion is owned by
 * the hourly Hallu cron (autodispatch is off), so a zarr `failed` callback only
 * records state for the observability dashboard.
 */
import type { Bindings } from "../types/bindings.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsToken } from "./github-auth.js";
import { triggerArchiveGeneration } from "./github.js";

/**
 * Max retry dispatches per latest archive, beyond the original generation.
 * Kept small: a retry re-downloads every available annex blob before it can
 * detect a still-missing one, so each attempt is expensive for large datasets.
 */
export const MAX_ARCHIVE_RETRIES = 3;

export interface ArchiveRetryDecision {
  /** Whether to dispatch a fresh archive build now. */
  retry: boolean;
  /** The value to persist into archive_retry_count. */
  nextCount: number;
  /** Machine reason, for logs. */
  reason: "ready_reset" | "no_version" | "cap_reached" | "retry";
}

/**
 * Pure decision for the archive-ready webhook. The increment lives here (on the
 * retry path only) so the count tracks dispatches, not failed callbacks.
 */
export function decideArchiveRetry(
  status: "ready" | "failed",
  retryCount: number,
  version: string | null | undefined,
  max: number = MAX_ARCHIVE_RETRIES,
): ArchiveRetryDecision {
  if (status === "ready") {
    return { retry: false, nextCount: 0, reason: "ready_reset" };
  }
  // status === "failed"
  if (!version) {
    // Can't re-dispatch without a version to check out; leave the count as-is.
    return { retry: false, nextCount: retryCount, reason: "no_version" };
  }
  if (retryCount >= max) {
    return { retry: false, nextCount: retryCount, reason: "cap_reached" };
  }
  return { retry: true, nextCount: retryCount + 1, reason: "retry" };
}

/**
 * Extract the bare `X.Y.Z` version from a version DOI like
 * `10.82901/nemar.nm000111.v1.0.1` -> `1.0.1`. Returns null when absent or
 * malformed (e.g. a concept DOI with no `.vX.Y.Z` suffix).
 */
export function versionFromDoi(latestVersionDoi: string | null | undefined): string | null {
  if (!latestVersionDoi) return null;
  const m = latestVersionDoi.match(/\.v(\d+\.\d+\.\d+)$/);
  return m ? m[1] : null;
}

/**
 * Candidate query for the daily sweep. Exported so the test asserts the exact
 * WHERE logic against a real SQLite db. Binds `MAX_ARCHIVE_RETRIES`.
 *
 * Picks still-failed datasets that have a published version, are under the cap,
 * and whose last attempt is stale (>6h) or unknown -- the 6h guard avoids
 * re-dispatching an archive the webhook just retried.
 */
export const ARCHIVE_RETRY_SWEEP_QUERY = `SELECT dataset_id, latest_version_doi, archive_retry_count
   FROM datasets
  WHERE archive_status = 'failed'
    AND latest_version_doi IS NOT NULL
    AND archive_retry_count < ?
    AND (json_extract(sweep_stamps, '$.archive_checked_at') IS NULL
         OR json_extract(sweep_stamps, '$.archive_checked_at') < datetime('now', '-6 hours'))
  ORDER BY json_extract(sweep_stamps, '$.archive_checked_at') ASC
  LIMIT 20`;

interface SweepRow {
  dataset_id: string;
  latest_version_doi: string;
  archive_retry_count: number;
}

/**
 * Daily backstop: re-dispatch archive generation for still-failed datasets.
 * Best-effort and bounded (LIMIT 20 keeps it under the Workers subrequest cap).
 * Increments archive_retry_count and stamps archive_checked_at at dispatch so a
 * row isn't re-picked within the day; the resulting archive-ready callback
 * carries it forward (reset on 'ready', or the webhook's own retry on 'failed').
 */
export async function archiveRetrySweep(env: Bindings): Promise<void> {
  // Production only (epic #923 Phase 7). The candidate query filters on
  // archive_status alone, with no dataset-id prefix restriction, and dispatch
  // targets the hardcoded nemarDatasets/.github central repo. On the dev/staging
  // worker, whose D1 is a partial production mirror, that means running real
  // Actions against real dataset repos. The daily cron already excludes this
  // outside production; the guard is repeated here so a future caller inherits
  // the same safety.
  if (isNonProductionEnv(env)) {
    console.log("[archive-retry-sweep] skipped (non-production)");
    return;
  }

  let candidates: SweepRow[];
  try {
    const res = await env.DB.prepare(ARCHIVE_RETRY_SWEEP_QUERY)
      .bind(MAX_ARCHIVE_RETRIES)
      .all<SweepRow>();
    candidates = res.results ?? [];
  } catch (err) {
    console.error(
      "[archive-retry-sweep] candidate query failed:",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  if (candidates.length === 0) return;

  let pat: string;
  try {
    pat = await getDatasetsToken(env);
  } catch (err) {
    console.error(
      "[archive-retry-sweep] could not mint datasets token:",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  let dispatched = 0;
  let skipped = 0;
  for (const row of candidates) {
    const version = versionFromDoi(row.latest_version_doi);
    if (!version) {
      skipped++;
      continue;
    }
    try {
      // Dispatch first, then record the attempt. If the UPDATE throws (transient
      // D1 error) after a successful dispatch, the count isn't incremented and
      // the row may be re-dispatched on a later sweep -- at-least-once, bounded:
      // the dispatched run's archive-ready callback re-stamps the row, and the
      // cap is still enforced. The inverse order (increment then dispatch) would
      // instead drop attempts when the dispatch fails, which is worse.
      await triggerArchiveGeneration(row.dataset_id, row.dataset_id, version, pat, {
        s3Bucket: env.S3_BUCKET,
        callbackBaseUrl: env.API_BASE_URL,
      });
      await env.DB.prepare(
        `UPDATE datasets
            SET archive_retry_count = archive_retry_count + 1,
                sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.archive_checked_at', datetime('now'))
          WHERE dataset_id = ?`,
      )
        .bind(row.dataset_id)
        .run();
      dispatched++;
    } catch (err) {
      console.error(
        `[archive-retry-sweep] dispatch failed dataset=${row.dataset_id}:`,
        err instanceof Error ? err.message : String(err),
      );
      skipped++;
    }
  }
  console.log(
    `[archive-retry-sweep] candidates=${candidates.length} dispatched=${dispatched} skipped=${skipped}`,
  );
}
