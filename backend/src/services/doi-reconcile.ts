/**
 * Reconcile version DOIs stuck in EZID `reserved` state (epic #896, #900).
 *
 * A version-DOI mint that succeeded at `createIdentifier` (status `reserved`)
 * but CRASHED before `makePublic` left a permanent, non-resolving DOI recorded
 * as the dataset's latest version. The primary fix (services/doi.ts) completes
 * the transition on the next mint retry; this bounded daily sweep is the
 * backstop for the case where no retry ever happens. Mirrors archiveRetrySweep.
 *
 * No new D1 column (avoids a migration-number clash with the paused #923 epic):
 * each run scans a bounded, day-rotated window over ALL datasets carrying an
 * EZID version DOI and asks EZID each DOI's status, completing any stuck
 * reserved. The rotation guarantees every row is visited within
 * ceil(total/batch) days regardless of churn — a stuck DOI is exactly the row
 * that stops being updated, so a recency window would starve it.
 */

import { datasetVersionLandingUrl } from "../../../shared/datacite-constants.js";
import type { Bindings } from "../types/bindings.js";
import { resolveEzidAuth } from "./doi.js";
import { isNonProductionEnv, resolveDatasetLandingBase } from "./environment.js";
import { getIdentifier, makePublic } from "./ezid.js";

/** Datasets inspected per sweep run. */
export const DOI_RECONCILE_BATCH = 25;

/** EZID DOI shoulders NEMAR mints on (production / sandbox). */
const PROD_SHOULDER_PREFIX = "10.82901";
const SANDBOX_SHOULDER_PREFIX = "10.5072";

interface DoiRow {
  dataset_id: string;
  latest_version_doi: string;
}

/** Extract the semver from a version DOI (`…NEMAR.NM000104.V1.0.0` -> `1.0.0`). */
export function versionFromVersionDoi(doi: string): string | null {
  const m = doi.match(/\.V(\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\d*)?)$/i);
  return m ? m[1] : null;
}

/** True when the DOI is on the EZID sandbox shoulder (auto-expiring test DOIs). */
export function isSandboxDoi(doi: string): boolean {
  return doi.startsWith(SANDBOX_SHOULDER_PREFIX);
}

/** True when the DOI is a NEMAR EZID DOI (prod or sandbox shoulder). */
export function isEzidNemarDoi(doi: string): boolean {
  return doi.startsWith(PROD_SHOULDER_PREFIX) || doi.startsWith(SANDBOX_SHOULDER_PREFIX);
}

const MS_PER_DAY = 86_400_000;

/**
 * Deterministic day-indexed offset that rotates a fixed-size scan window over
 * all `total` rows, so every row is visited within `ceil(total/batch)` days
 * regardless of ordering/churn. Pure + exported for unit testing.
 */
export function rotationOffset(total: number, nowMs: number, batch = DOI_RECONCILE_BATCH): number {
  if (total <= 0) return 0;
  const buckets = Math.ceil(total / batch);
  return (Math.floor(nowMs / MS_PER_DAY) % buckets) * batch;
}

export async function reconcileReservedVersionDois(
  env: Bindings,
  nowMs = Date.now(),
): Promise<void> {
  // Production only (epic #923 Phase 7). Sandbox-vs-production EZID auth is
  // chosen from the DOI's own shoulder, not from ENVIRONMENT, so a real
  // 10.82901 DOI on the prod-mirror dev D1 resolves to production credentials
  // and makePublic is documented as permanent. The daily cron already excludes
  // this outside production; the guard is repeated here so a future caller
  // inherits the same safety.
  if (isNonProductionEnv(env)) {
    console.log("[doi-reconcile] skipped (non-production)");
    return;
  }

  const WHERE = "latest_version_doi IS NOT NULL AND latest_version_doi != ''";
  let rows: DoiRow[];
  try {
    // Rotate through ALL datasets carrying a version DOI over successive days
    // rather than only the recently-updated 25. A stuck-reserved DOI is exactly
    // the row that STOPS being updated, so unrelated churn (auto-import, HED
    // sweeps, ...) would permanently starve a recency window; a deterministic
    // day-indexed offset guarantees every row is checked within
    // ceil(total / batch) days regardless of churn.
    const total =
      (
        await env.DB.prepare(`SELECT COUNT(*) AS n FROM datasets WHERE ${WHERE}`).first<{
          n: number;
        }>()
      )?.n ?? 0;
    if (total === 0) return;
    const offset = rotationOffset(total, nowMs);
    const res = await env.DB.prepare(
      `SELECT dataset_id, latest_version_doi FROM datasets
       WHERE ${WHERE}
       ORDER BY dataset_id LIMIT ? OFFSET ?`,
    )
      .bind(DOI_RECONCILE_BATCH, offset)
      .all<DoiRow>();
    rows = res.results ?? [];
  } catch (err) {
    console.error(
      "[doi-reconcile] candidate query failed:",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  if (rows.length === 0) return;

  let checked = 0;
  let reconciled = 0;
  for (const { dataset_id, latest_version_doi: doi } of rows) {
    if (!isEzidNemarDoi(doi)) continue;
    const version = versionFromVersionDoi(doi);
    if (!version) continue;
    let auth: ReturnType<typeof resolveEzidAuth>;
    try {
      auth = resolveEzidAuth(env, isSandboxDoi(doi));
    } catch {
      continue; // required EZID secrets for this shoulder absent
    }
    try {
      const id = await getIdentifier(auth, `doi:${doi}`);
      checked++;
      if (id.status === "reserved") {
        await makePublic(
          auth,
          id.identifier,
          datasetVersionLandingUrl(dataset_id, version, resolveDatasetLandingBase(env)),
        );
        reconciled++;
        console.log(
          `[doi-reconcile] completed stuck-reserved version DOI ${doi} for ${dataset_id}`,
        );
      }
    } catch (err) {
      console.error(
        `[doi-reconcile] ${doi} (${dataset_id}) check/complete failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (checked > 0) {
    console.log(`[doi-reconcile] checked ${checked} EZID version DOIs, reconciled ${reconciled}`);
  }
}
