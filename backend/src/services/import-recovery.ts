/**
 * Import recovery service (#754, epic #749 Phase 5).
 *
 * On a terminal import failure, decide whether the leftover is an unambiguous
 * orphan (safe to delete) or something that must be kept for a human to look at,
 * and act on it: QUARANTINE (mark + alert admins) by default, or ROLL BACK
 * (deleteDatasetCascade) only when the orphan is unambiguous AND the
 * IMPORT_AUTO_ROLLBACK flag is on. The pure decision functions are unit-tested
 * without DB/network.
 */

import { auditLogStatement } from "../db/audit-log.js";
import { SYSTEM_USER_ID } from "../lib/constants.js";
import type { Bindings } from "../types/bindings.js";
import { deleteDatasetCascade } from "./deletion.js";
import {
  getAdminEmailsForCategory,
  resolveEmailConfig,
  sendImportQuarantineEmail,
} from "./email.js";

export type ImportStatus =
  | "preparing"
  | "copying"
  | "finalizing"
  | "complete"
  | "incomplete"
  | "failed"
  | "quarantined"
  | "rolled_back";
export type ImportStage = "prepare" | "copy" | "finalize";

export const IMPORT_STATUSES: ImportStatus[] = [
  "preparing",
  "copying",
  "finalizing",
  "complete",
  "incomplete",
  "failed",
  "quarantined",
  "rolled_back",
];
/** Terminal statuses a monotonic state update must never regress past.
 *  `incomplete` (#969) is deliberately NOT terminal -- it means the import
 *  reached `complete` once but S3 is missing keys, and the retry engine
 *  (services/import-retry.ts) actively retries it back to `complete`. */
export const TERMINAL_IMPORT_STATUSES: ImportStatus[] = ["complete", "rolled_back", "quarantined"];

export interface ImportGuardState {
  /** false when the datasets row is already gone (nothing to roll back). */
  exists: boolean;
  visibility: string;
  conceptDoi: string | null;
  latestVersionDoi: string | null;
  versionCount: number;
  ownerUserId: number | null;
  /** Did the import ever reach `complete`? Belt-and-suspenders; see runner. */
  importReachedComplete: boolean;
}

export type ImportRecoveryDecision =
  | { action: "rollback"; reason: "unambiguous_orphan" }
  | {
      action: "quarantine";
      reason:
        | "not_found_dataset"
        | "system_owned"
        | "reached_complete"
        | "has_doi"
        | "made_public"
        | "has_version"
        | "upstream_inaccessible";
    };

/**
 * Marker the import CLI emits (and the onboard prepare step forwards into the
 * import-state callback's error_message) when OpenNeuro's own data can't be
 * fetched -- objects not anonymously readable and NEMAR has no signed OpenNeuro
 * login. Mirrors OPENNEURO_UPSTREAM_MARKER in src/lib/import-openneuro.ts (kept
 * in sync deliberately; the CLI and Worker don't share a module). When present
 * in last_error, recovery records a distinct `upstream_inaccessible` quarantine
 * so these OpenNeuro-side failures are listable, not mistaken for NEMAR bugs.
 */
export const OPENNEURO_UPSTREAM_MARKER = "[openneuro-upstream-inaccessible]";

/**
 * Decide rollback vs quarantine. Auto-rollback fires ONLY for the unambiguous
 * orphan (the on004395 signature): the datasets row exists, is private, has no
 * concept/version DOI, has zero dataset_versions, never reached complete, and
 * is not a system-owned catalog row. Anything that looks even slightly real is
 * quarantined for a human. Pure — no I/O.
 */
export function decideImportRecovery(s: ImportGuardState): ImportRecoveryDecision {
  if (!s.exists) return { action: "quarantine", reason: "not_found_dataset" };
  if (s.ownerUserId === SYSTEM_USER_ID) return { action: "quarantine", reason: "system_owned" };
  if (s.importReachedComplete) return { action: "quarantine", reason: "reached_complete" };
  if (s.conceptDoi !== null || s.latestVersionDoi !== null) {
    return { action: "quarantine", reason: "has_doi" };
  }
  if (s.visibility !== "private") return { action: "quarantine", reason: "made_public" };
  if (s.versionCount > 0) return { action: "quarantine", reason: "has_version" };
  return { action: "rollback", reason: "unambiguous_orphan" };
}

/**
 * Final recovery decision: an OpenNeuro upstream-inaccessibility (the CLI's
 * marker forwarded into last_error by the onboard prepare callback) overrides
 * the leftover-state classification -- always quarantine with a distinct,
 * listable `upstream_inaccessible` reason rather than roll back or mislabel it
 * as a generic prepare miss, since it is an OpenNeuro-side problem, not a NEMAR
 * bug. Otherwise defer to decideImportRecovery. Pure -- no I/O.
 */
export function classifyRecovery(
  lastError: string | null,
  state: ImportGuardState,
): ImportRecoveryDecision {
  if ((lastError ?? "").includes(OPENNEURO_UPSTREAM_MARKER)) {
    return { action: "quarantine", reason: "upstream_inaccessible" };
  }
  return decideImportRecovery(state);
}

function isAutoRollbackEnabled(env: Bindings): boolean {
  return (env.IMPORT_AUTO_ROLLBACK ?? "").trim().toLowerCase() === "true";
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function writeAudit(
  db: D1Database,
  action: string,
  datasetId: string,
  details: unknown,
): Promise<void> {
  try {
    // Through auditLogStatement so these writes inherit the shared details
    // size bound (#1189). userId null = system-initiated.
    await auditLogStatement(db, {
      userId: null,
      action,
      resourceId: datasetId,
      details: JSON.stringify(details),
    }).run();
  } catch (err) {
    console.error(`[import-recovery] audit_log write failed for ${datasetId}:`, err);
  }
}

async function alertAdmins(
  db: D1Database,
  env: Bindings,
  datasetId: string,
  reason: string,
  job: { source_id: string | null; stage: string | null; workflow_run_url: string | null } | null,
): Promise<void> {
  if (!env.RESEND_API_KEY) return; // best-effort; audit_log is the durable record
  try {
    const adminEmails = await getAdminEmailsForCategory(db, "publication_request");
    if (adminEmails.length === 0) return;
    const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
    await sendImportQuarantineEmail(
      adminEmails,
      {
        datasetId,
        sourceId: job?.source_id ?? "unknown",
        stage: job?.stage ?? "unknown",
        reason,
        workflowRunUrl: job?.workflow_run_url ?? null,
      },
      env.RESEND_API_KEY,
      fromEmail,
      replyTo,
      isDev,
      env,
    );
  } catch (err) {
    console.error(`[import-recovery] admin alert failed for ${datasetId}:`, err);
  }
}

async function markImportStatus(
  db: D1Database,
  datasetId: string,
  status: ImportStatus,
  lastError: string,
): Promise<void> {
  // Never throw out of recovery: on a D1 hiccup the row stays visible as
  // `failed` in the admin view (not a silent orphan), and the audit/alert
  // writes below still run.
  try {
    await db
      .prepare(
        `UPDATE import_jobs
           SET status = ?, last_error = ?, completed_at = datetime('now'), updated_at = datetime('now')
         WHERE dataset_id = ?`,
      )
      .bind(status, lastError, datasetId)
      .run();
  } catch (err) {
    console.error(`[import-recovery] markImportStatus(${status}) failed for ${datasetId}:`, err);
  }
}

/**
 * Run the rollback-or-quarantine decision for a dataset whose import_jobs row is
 * already `failed`. Returns the terminal status it landed on. Shared by the
 * import-state webhook and the scheduled stuck-import sweep.
 */
export async function runImportRecovery(
  db: D1Database,
  env: Bindings,
  datasetId: string,
): Promise<"rolled_back" | "quarantined"> {
  const job = await db
    .prepare(
      "SELECT source_id, stage, workflow_run_url, last_error FROM import_jobs WHERE dataset_id = ?",
    )
    .bind(datasetId)
    .first<{
      source_id: string | null;
      stage: string | null;
      workflow_run_url: string | null;
      last_error: string | null;
    }>();

  const row = await db
    .prepare(
      `SELECT d.visibility, d.concept_doi, d.latest_version_doi, d.owner_user_id,
              (SELECT COUNT(*) FROM dataset_versions v WHERE v.dataset_id = d.dataset_id) AS version_count,
              EXISTS(SELECT 1 FROM publication_requests pr
                     WHERE pr.dataset_id = d.dataset_id AND pr.status = 'published') AS published
         FROM datasets d WHERE d.dataset_id = ?`,
    )
    .bind(datasetId)
    .first<{
      visibility: string;
      concept_doi: string | null;
      latest_version_doi: string | null;
      owner_user_id: number | null;
      version_count: number;
      published: number;
    }>();

  const state: ImportGuardState = row
    ? {
        exists: true,
        visibility: row.visibility,
        conceptDoi: row.concept_doi,
        latestVersionDoi: row.latest_version_doi,
        versionCount: row.version_count,
        ownerUserId: row.owner_user_id,
        // A finalized import published the dataset (publication_requests row),
        // a durable signal that survives even if DOI/version aren't minted yet.
        importReachedComplete: row.published === 1,
      }
    : {
        exists: false,
        visibility: "",
        conceptDoi: null,
        latestVersionDoi: null,
        versionCount: 0,
        ownerUserId: null,
        importReachedComplete: false,
      };

  const decision = classifyRecovery(job?.last_error ?? null, state);

  if (decision.action === "rollback" && isAutoRollbackEnabled(env)) {
    try {
      const result = await deleteDatasetCascade(db, env, datasetId, {});
      if (!result.deleted) {
        // Partial cascade (a D1/GitHub/S3 step failed): the orphan may still
        // exist, so do NOT mark rolled_back (that would hide it). Quarantine so
        // it stays surfaced + alerted for a human to finish.
        const warn = result.warnings.join("; ");
        const msg = `auto-rollback incomplete (partial cascade): ${warn}`;
        await markImportStatus(db, datasetId, "quarantined", msg);
        await writeAudit(db, "import_rollback_failed", datasetId, { decision, result });
        await alertAdmins(db, env, datasetId, msg, job);
        console.error(`[import-recovery] partial cascade for ${datasetId}; quarantined: ${warn}`);
        return "quarantined";
      }
      await markImportStatus(db, datasetId, "rolled_back", `auto-rollback: ${decision.reason}`);
      await writeAudit(db, "import_auto_rollback", datasetId, { decision, result });
      console.log(`[import-recovery] auto-rolled-back orphan ${datasetId} (${decision.reason})`);
      return "rolled_back";
    } catch (err) {
      // Cascade threw: fall through to quarantine so the orphan is still
      // surfaced and alerted rather than left half-deleted and silent.
      const msg = `auto-rollback failed: ${errMsg(err)}`;
      await markImportStatus(db, datasetId, "quarantined", msg);
      await writeAudit(db, "import_rollback_failed", datasetId, { decision, error: errMsg(err) });
      await alertAdmins(db, env, datasetId, msg, job);
      console.error(`[import-recovery] auto-rollback of ${datasetId} threw; quarantined:`, err);
      return "quarantined";
    }
  }

  await markImportStatus(db, datasetId, "quarantined", `quarantined: ${decision.reason}`);
  await writeAudit(db, "import_quarantined", datasetId, {
    decision,
    autoRollbackEnabled: isAutoRollbackEnabled(env),
  });
  await alertAdmins(db, env, datasetId, decision.reason, job);
  console.warn(`[import-recovery] quarantined ${datasetId} (${decision.reason})`);
  return "quarantined";
}
