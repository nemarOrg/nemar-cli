// Data-plane access counters (epic #695, dashboard.nemar.org/observability).
//
// Emits one Cloudflare Analytics Engine data point per served data-plane
// request (archive download on data.nemar.org, zarr read on zarr.nemar.org)
// so the observability dashboard can rank "which datasets are accessed most".
//
// Write-only here: the dashboard reads the `nemar_access_metrics` dataset via
// the account-scoped Analytics Engine SQL API, NOT a binding. Because AE
// applies adaptive sampling under bursts, the read side must aggregate with
// `SUM(_sample_interval)`, never `COUNT(*)`.
//
// The binding is optional (see Bindings.ANALYTICS): recordAccess() no-ops when
// it is absent, so dev/test and pre-provisioning deploys serve traffic without
// telemetry and callers never have to guard.

import type { Bindings } from "../types/bindings";

/** Which data-plane host served the request. */
export type AccessSource = "archive" | "zarr" | "file";

export interface AccessEvent {
  /** Public dataset id (nm/on...). Used as the AE index + first blob. */
  datasetId: string;
  source: AccessSource;
  /**
   * Source-specific discriminator stored as a blob:
   *   archive -> the version string (e.g. "1.0.0")
   *   zarr    -> object class ("index" | "metadata" | "chunk")
   */
  detail: string;
  /**
   * Bytes the Worker served for this request. 0 when unknown -- archive
   * downloads 302 to a presigned S3 URL, so the Worker never sees the bytes
   * (only the event is counted; archive byte size lives in datasets.archive_size).
   */
  bytes?: number;
}

/**
 * Build the Analytics Engine data point for one served request. Pure (no I/O)
 * so it is unit-testable without a live binding. The field ordering is a
 * contract the dashboard's read-side SQL depends on:
 *   indexes[0] = dataset_id   (group/sample key; AE allows one index, <=96B)
 *   blob1      = dataset_id
 *   blob2      = source
 *   blob3      = detail
 *   double1    = bytes
 */
export function buildAccessDataPoint(event: AccessEvent): AnalyticsEngineDataPoint {
  return {
    indexes: [event.datasetId],
    blobs: [event.datasetId, event.source, event.detail],
    doubles: [event.bytes ?? 0],
  };
}

/**
 * Classify a zarr S3 key into the coarse object class recorded as `detail`.
 * `<id>/zarr/index.json` -> index; `<id>/zarr/<store>.zarr/zarr.json` ->
 * metadata; everything else (chunks under `c/...`) -> chunk.
 */
export function zarrObjectType(key: string): string {
  // Slash-anchored to match cacheControlFor() in zarr-data.ts and to avoid
  // misclassifying a hypothetical chunk like `..._index.json` as the store index.
  if (key.endsWith("/index.json")) return "index";
  if (key.endsWith("/zarr.json")) return "metadata";
  return "chunk";
}

/**
 * Emit one access data point. No-op when the binding is absent. Never throws:
 * telemetry must not be able to break a data-plane response. Non-blocking
 * (writeDataPoint buffers and flushes out-of-band, so no waitUntil needed).
 */
export function recordAccess(env: Pick<Bindings, "ANALYTICS">, event: AccessEvent): void {
  if (!env.ANALYTICS) return;
  try {
    env.ANALYTICS.writeDataPoint(buildAccessDataPoint(event));
  } catch (err) {
    console.error("[access-metrics] writeDataPoint failed:", err);
  }
}
