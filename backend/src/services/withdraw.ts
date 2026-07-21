/**
 * Dataset withdrawal service (epic #967 phase 4, #971).
 *
 * Withdraws a broken published dataset -- one of the 11 datasets published
 * with 0-byte content whose OpenNeuro source cannot currently be recovered
 * (scripts/withdrawn-datasets.json) -- by flipping its visibility to private
 * (applyDatasetVisibility, services/visibility.ts) and tombstoning every EZID
 * DOI it carries, concept AND every version (`_status=unavailable`), so a
 * resolvable DOI never points at now-private (empty) data. `restoreDataset` is
 * the exact reverse. Both directions are fully reversible: `status`
 * (lifecycle) is untouched, only `visibility` gates catalog/data-plane access.
 *
 * Testability seam (no mocks): the D1 reads/writes below
 * (loadDatasetForTransition / loadVersionDois / markDatasetWithdrawn /
 * markDatasetRestored / markVersionEzidStatus) are pure D1 -- no network --
 * and are exercised directly in backend/test/withdraw.test.ts against a real
 * in-memory SQLite D1. The orchestration functions (withdrawDataset /
 * restoreDataset) call GitHub, S3, and EZID for real once past the
 * precondition checks and the dry-run early-return, so only those two
 * network-free paths (precondition-fail, dry-run) are covered by the pure/CI
 * test tier; the full live round trip is exercised by the manual, gated
 * test/ezid-sandbox.test.ts (RUN_EZID_TESTS=true) and the sandbox exemplar
 * E2E, matching how every other EZID-calling function in this codebase is
 * tested (services/ezid.ts's makePublic/makeUnavailable are never invoked
 * from the pure tier either).
 */

import { datasetLandingUrl, datasetVersionLandingUrl } from "../../../shared/datacite-constants.js";
import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { resolveEzidAuth } from "./doi.js";
import { resolveDatasetLandingBase } from "./environment.js";
import { makePublic, makeUnavailable } from "./ezid.js";
import { applyDatasetVisibility } from "./visibility.js";

export interface DoiStepResult {
  doi: string;
  kind: "concept" | "version";
  version?: string;
  action: "unavailable" | "public";
  status: "planned" | "ok" | "failed";
  error?: string;
}

interface TransitionResultBase {
  dataset_id: string;
  dry_run: boolean;
  /** Set (and every other field omitted) when a precondition failed; the
   *  operation made no network calls and no D1 writes. */
  skipped?: string;
  visibility?: { status: "planned" | "ok" | "failed"; error?: string };
  dois?: DoiStepResult[];
}

export type WithdrawResult = TransitionResultBase;
export type RestoreResult = TransitionResultBase;

interface TransitionOptions {
  dryRun?: boolean;
  /** Acting admin user id for the audit-log row; null for system-initiated calls. */
  actorUserId?: number | null;
}

interface WithdrawCandidate {
  dataset_id: string;
  ezid_identifier: string | null;
  doi_provider: string | null;
  visibility: string;
  is_sandbox: number | null;
  withdrawn_at: string | null;
}

interface VersionDoiRow {
  version: string;
  doi: string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// D1 reads/writes -- pure, no network. Exported for direct unit testing.
// ---------------------------------------------------------------------------

async function loadDatasetForTransition(
  db: D1Database,
  datasetId: string,
): Promise<WithdrawCandidate | null> {
  return db
    .prepare(
      `SELECT dataset_id, ezid_identifier, doi_provider, visibility, is_sandbox, withdrawn_at
       FROM datasets WHERE dataset_id = ?`,
    )
    .bind(datasetId)
    .first<WithdrawCandidate>();
}

async function loadVersionDois(db: D1Database, datasetId: string): Promise<VersionDoiRow[]> {
  const rows = await db
    .prepare(
      `SELECT version, doi FROM dataset_versions
       WHERE dataset_id = ? AND doi IS NOT NULL AND doi != ''
       ORDER BY version`,
    )
    .bind(datasetId)
    .all<VersionDoiRow>();
  return rows.results ?? [];
}

/** Stamp a dataset as withdrawn. Pure D1 write; no network. */
export async function markDatasetWithdrawn(
  db: D1Database,
  datasetId: string,
  reason: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE datasets
       SET withdrawn_at = datetime('now'), withdrawn_reason = ?, ezid_status = 'unavailable',
           updated_at = datetime('now')
       WHERE dataset_id = ?`,
    )
    .bind(reason, datasetId)
    .run();
}

/** Clear a dataset's withdrawal state (restore). Pure D1 write; no network. */
export async function markDatasetRestored(db: D1Database, datasetId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE datasets
       SET withdrawn_at = NULL, withdrawn_reason = NULL, ezid_status = 'public',
           updated_at = datetime('now')
       WHERE dataset_id = ?`,
    )
    .bind(datasetId)
    .run();
}

/** Set one version's EZID status. Pure D1 write; no network. */
export async function markVersionEzidStatus(
  db: D1Database,
  datasetId: string,
  version: string,
  status: "unavailable" | "public",
): Promise<void> {
  await db
    .prepare("UPDATE dataset_versions SET ezid_status = ? WHERE dataset_id = ? AND version = ?")
    .bind(status, datasetId, version)
    .run();
}

function buildPlannedDois(
  conceptIdentifier: string,
  versions: VersionDoiRow[],
  action: "unavailable" | "public",
): DoiStepResult[] {
  return [
    { doi: conceptIdentifier, kind: "concept", action, status: "planned" },
    ...versions.map((v) => ({
      doi: v.doi,
      kind: "version" as const,
      version: v.version,
      action,
      status: "planned" as const,
    })),
  ];
}

async function logAudit(
  db: D1Database,
  actorUserId: number | null,
  action: "dataset_withdrawn" | "dataset_restored",
  datasetId: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await auditLogStatement(db, {
      userId: actorUserId,
      action,
      resourceType: "dataset",
      resourceId: datasetId,
      details: JSON.stringify(details),
    }).run();
  } catch (auditError) {
    console.error(`Audit log write failed for ${action} on ${datasetId}:`, auditError);
  }
}

// ---------------------------------------------------------------------------
// Orchestration -- GitHub + S3 (via applyDatasetVisibility) + live EZID + D1.
// ---------------------------------------------------------------------------

/**
 * Withdraw a published dataset: flip visibility to private, then tombstone
 * the concept DOI and every version DOI. `dry_run` defaults to true (must
 * pass `{ dryRun: false }` explicitly to execute), matching the fleet
 * enforce/bulk convention so a bare call never mutates.
 *
 * Preconditions that fail return `{ skipped: <reason> }` immediately -- no
 * network calls, no D1 writes -- so a batch run (`--all`) can report a
 * per-dataset reason instead of aborting the whole run.
 */
export async function withdrawDataset(
  env: Bindings,
  datasetId: string,
  reason: string,
  opts: TransitionOptions = {},
): Promise<WithdrawResult> {
  const dryRun = opts.dryRun !== false;
  const db = env.DB;

  const dataset = await loadDatasetForTransition(db, datasetId);
  if (!dataset) {
    return { dataset_id: datasetId, dry_run: dryRun, skipped: "Dataset not found" };
  }
  if (dataset.doi_provider !== "ezid" || !dataset.ezid_identifier) {
    return {
      dataset_id: datasetId,
      dry_run: dryRun,
      skipped:
        "Dataset has no EZID concept DOI; withdrawal is only supported for EZID-managed DOIs",
    };
  }
  if (dataset.visibility !== "public") {
    return {
      dataset_id: datasetId,
      dry_run: dryRun,
      skipped: `Dataset visibility is already "${dataset.visibility}" (withdrawal expects "public")`,
    };
  }

  const versions = await loadVersionDois(db, datasetId);
  const plannedDois = buildPlannedDois(dataset.ezid_identifier, versions, "unavailable");

  if (dryRun) {
    return {
      dataset_id: datasetId,
      dry_run: true,
      visibility: { status: "planned" },
      dois: plannedDois,
    };
  }

  const visibilityResult = await applyDatasetVisibility(env, datasetId, "private");
  if (!visibilityResult.ok) {
    return {
      dataset_id: datasetId,
      dry_run: false,
      visibility: { status: "failed", error: visibilityResult.error },
      dois: plannedDois.map((d) => ({
        ...d,
        status: "failed" as const,
        error: "not attempted: visibility transition failed",
      })),
    };
  }

  const auth = resolveEzidAuth(env, !!dataset.is_sandbox);
  const dois: DoiStepResult[] = [];

  let conceptOk = false;
  try {
    await makeUnavailable(auth, dataset.ezid_identifier, reason);
    conceptOk = true;
    dois.push({
      doi: dataset.ezid_identifier,
      kind: "concept",
      action: "unavailable",
      status: "ok",
    });
  } catch (err) {
    dois.push({
      doi: dataset.ezid_identifier,
      kind: "concept",
      action: "unavailable",
      status: "failed",
      error: errMsg(err),
    });
  }

  for (const v of versions) {
    try {
      await makeUnavailable(auth, v.doi, reason);
      await markVersionEzidStatus(db, datasetId, v.version, "unavailable");
      dois.push({
        doi: v.doi,
        kind: "version",
        version: v.version,
        action: "unavailable",
        status: "ok",
      });
    } catch (err) {
      dois.push({
        doi: v.doi,
        kind: "version",
        version: v.version,
        action: "unavailable",
        status: "failed",
        error: errMsg(err),
      });
    }
  }

  // Only stamp the dataset-level withdrawal columns once the concept DOI (the
  // primary tombstone) actually succeeded; per-version status was already
  // written above for whichever versions succeeded, independent of the
  // concept outcome, so a partial failure is still recorded accurately.
  if (conceptOk) {
    await markDatasetWithdrawn(db, datasetId, reason);
  }

  await logAudit(db, opts.actorUserId ?? null, "dataset_withdrawn", datasetId, {
    reason,
    dois: dois.map((d) => ({ doi: d.doi, status: d.status })),
  });

  return {
    dataset_id: datasetId,
    dry_run: false,
    visibility: { status: "ok" },
    dois,
  };
}

/**
 * Restore a withdrawn dataset: the exact reverse of `withdrawDataset` --
 * flip visibility back to public, then makePublic the concept DOI and every
 * version DOI. Requires the dataset to actually be withdrawn
 * (`withdrawn_at` set); restore is not a generic "make public" -- that's
 * `PATCH /admin/datasets/:id/visibility` + `doi/update --make-public`.
 */
export async function restoreDataset(
  env: Bindings,
  datasetId: string,
  opts: TransitionOptions = {},
): Promise<RestoreResult> {
  const dryRun = opts.dryRun !== false;
  const db = env.DB;

  const dataset = await loadDatasetForTransition(db, datasetId);
  if (!dataset) {
    return { dataset_id: datasetId, dry_run: dryRun, skipped: "Dataset not found" };
  }
  if (dataset.doi_provider !== "ezid" || !dataset.ezid_identifier) {
    return {
      dataset_id: datasetId,
      dry_run: dryRun,
      skipped: "Dataset has no EZID concept DOI; restore is only supported for EZID-managed DOIs",
    };
  }
  if (!dataset.withdrawn_at) {
    return {
      dataset_id: datasetId,
      dry_run: dryRun,
      skipped: "Dataset was not withdrawn (withdrawn_at is not set)",
    };
  }

  const versions = await loadVersionDois(db, datasetId);
  const plannedDois = buildPlannedDois(dataset.ezid_identifier, versions, "public");

  if (dryRun) {
    return {
      dataset_id: datasetId,
      dry_run: true,
      visibility: { status: "planned" },
      dois: plannedDois,
    };
  }

  const visibilityResult = await applyDatasetVisibility(env, datasetId, "public");
  if (!visibilityResult.ok) {
    return {
      dataset_id: datasetId,
      dry_run: false,
      visibility: { status: "failed", error: visibilityResult.error },
      dois: plannedDois.map((d) => ({
        ...d,
        status: "failed" as const,
        error: "not attempted: visibility transition failed",
      })),
    };
  }

  const auth = resolveEzidAuth(env, !!dataset.is_sandbox);
  const landingBase = resolveDatasetLandingBase(env);
  const dois: DoiStepResult[] = [];

  let conceptOk = false;
  try {
    await makePublic(auth, dataset.ezid_identifier, datasetLandingUrl(datasetId, landingBase));
    conceptOk = true;
    dois.push({ doi: dataset.ezid_identifier, kind: "concept", action: "public", status: "ok" });
  } catch (err) {
    dois.push({
      doi: dataset.ezid_identifier,
      kind: "concept",
      action: "public",
      status: "failed",
      error: errMsg(err),
    });
  }

  for (const v of versions) {
    try {
      await makePublic(auth, v.doi, datasetVersionLandingUrl(datasetId, v.version, landingBase));
      await markVersionEzidStatus(db, datasetId, v.version, "public");
      dois.push({
        doi: v.doi,
        kind: "version",
        version: v.version,
        action: "public",
        status: "ok",
      });
    } catch (err) {
      dois.push({
        doi: v.doi,
        kind: "version",
        version: v.version,
        action: "public",
        status: "failed",
        error: errMsg(err),
      });
    }
  }

  if (conceptOk) {
    await markDatasetRestored(db, datasetId);
  }

  await logAudit(db, opts.actorUserId ?? null, "dataset_restored", datasetId, {
    dois: dois.map((d) => ({ doi: d.doi, status: d.status })),
  });

  return {
    dataset_id: datasetId,
    dry_run: false,
    visibility: { status: "ok" },
    dois,
  };
}
