/**
 * Reconcile version DOIs stuck in EZID `reserved` state (epic #896, #900).
 *
 * A version-DOI mint that succeeded at `createIdentifier` (status `reserved`)
 * but CRASHED before `makePublic` left a permanent, non-resolving DOI recorded
 * as the dataset's latest version. The primary fix (services/doi.ts) completes
 * the transition on the next mint retry; this bounded daily sweep is the
 * backstop for the case where no retry ever happens. Mirrors archiveRetrySweep.
 *
 * No new D1 column: it checks the most-recently-updated datasets carrying an
 * EZID version DOI (a fresh mint-crash bumps updated_at, so recent is the right
 * bias) and asks EZID for each DOI's status. Cheap (bounded batch of getIdentifier
 * calls) and self-correcting.
 */

import { datasetVersionLandingUrl } from "../../../shared/datacite-constants.js";
import type { Bindings } from "../types/bindings.js";
import { resolveEzidAuth } from "./doi.js";
import { getIdentifier, makePublic } from "./ezid.js";
import { getDatasetsToken } from "./github-auth.js";

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

export async function reconcileReservedVersionDois(env: Bindings): Promise<void> {
  let rows: DoiRow[];
  try {
    const res = await env.DB.prepare(
      `SELECT dataset_id, latest_version_doi FROM datasets
       WHERE latest_version_doi IS NOT NULL AND latest_version_doi != ''
       ORDER BY updated_at DESC LIMIT ?`,
    )
      .bind(DOI_RECONCILE_BATCH)
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
  // getDatasetsToken is unused by the reconcile itself, but its availability is
  // a cheap proxy for "this is a fully-provisioned environment"; skip the sweep
  // (rather than spraying EZID errors) where core secrets are absent.
  try {
    await getDatasetsToken(env);
  } catch {
    return;
  }

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
        await makePublic(auth, id.identifier, datasetVersionLandingUrl(dataset_id, version));
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
