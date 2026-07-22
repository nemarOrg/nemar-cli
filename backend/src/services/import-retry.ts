/**
 * Consistent retry engine + blocklist for OpenNeuro imports (epic #967 Phase
 * 2, issue #969).
 *
 * A prod-only daily cron sweep (see index.ts scheduled()) that:
 *   1. Reclassifies falsely-`complete` import_jobs rows (S3 objects
 *      missing/0-byte, the #967 bug) to `incomplete`, bounded and resumable
 *      via `integrity_checked_at` (reclassifyCompleteRows).
 *   2. Retries every `incomplete` / `failed` / `quarantined`-but-not-human-
 *      review row on a paced, capped, ~2-week window by re-dispatching
 *      onboard-openneuro.yml (sweepImportRetries).
 *   3. Blocklists a row whose OpenNeuro source stays inaccessible past the
 *      window, and re-checks blocklisted rows on a slow cadence so access
 *      restoration auto-resumes the import.
 *
 * Execution model: the copy itself is a server-side S3 copy running in
 * GitHub Actions (batchServerSideCopy, src/lib/s3-server-copy.ts) -- this
 * Worker cron only DISPATCHES that workflow via triggerOpenNeuroOnboard; it
 * never copies bytes itself and there is no Hallu path.
 *
 * Decision functions are pure and separated from I/O (mirrors
 * pickNextDataset/decideAutoImportGate in auto-import.ts and
 * decideArchiveRetry in archive-retry.ts) so the retry/blocklist/backoff
 * logic is exhaustively unit-tested without D1 or GitHub.
 */

import type { Bindings } from "../types/bindings.js";
import { parseSqliteUtc } from "./auto-import.js";
import { stampDatasetIntegrity } from "./dataset-metadata-columns.js";
import { resolveEmailConfig, sendOpenNeuroMaintainerReport } from "./email.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsToken } from "./github-auth.js";
import { triggerOpenNeuroOnboard } from "./github.js";
import type { DatasetVersionIntegrityResult } from "./import-integrity.js";
import { verifyDatasetVersionS3 } from "./import-integrity.js";
import { OPENNEURO_UPSTREAM_MARKER } from "./import-recovery.js";

/** ~2 weeks: the window an incomplete/failed import is retried before an
 *  upstream-inaccessible row is parked on the blocklist. */
export const RETRY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Exponential-ish backoff between re-dispatches, capped at 48h so a
 *  long-stuck dataset still gets re-tried a few times a week inside the
 *  2-week window rather than falling silent. */
const RETRY_BACKOFF_BASE_MS = 6 * 60 * 60 * 1000;
const RETRY_BACKOFF_CAP_MS = 48 * 60 * 60 * 1000;
/** Pace GitHub dispatches per tick. GitHub's secondary rate limit (403) fires
 *  on a burst of API calls in a short window regardless of the primary quota
 *  headroom; a large retry backlog dispatching all at once would trip it
 *  (and any red-CI fallout from that would show up as unrelated failures
 *  elsewhere), so this caps how many onboard-openneuro dispatches one sweep
 *  tick can fire, leaving the rest for the next tick. */
export const MAX_RECOVERY_DISPATCHES_PER_TICK = 3;
/** Slow re-verify cadence for blocklisted rows -- cheap (S3 listing only, no
 *  GitHub dispatch), so this can be gentler than the active retry backoff. */
export const BLOCKLIST_RECHECK_MS = 3 * 24 * 60 * 60 * 1000;
/** Bounded batch for both the reclassification sweep and each candidate
 *  query, so one tick stays cheap and resumable. */
export const RECLASSIFY_BATCH = 10;
export const IMPORT_RETRY_BATCH = 25;

/** Exponential backoff before the Nth re-dispatch (N = recoveryAttempts after
 *  incrementing), capped at RETRY_BACKOFF_CAP_MS. Exported for tests. */
export function retryBackoffMs(attempt: number): number {
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_BACKOFF_CAP_MS);
}

export type RetryDecision =
  | { action: "recover" }
  | { action: "blocklist"; reason: "upstream_403_after_window" | "no_source" }
  | { action: "dispatch"; nextRecoveryAttempt: number; nextRetryAt: number };

/**
 * Core per-candidate decision (retry engine step 1-3 in the phase plan):
 *   1. Verified complete now (upstream came back, a prior dispatch landed
 *      after the row was queried) -> recover, no dispatch.
 *   2. No source_id at all -> nothing can ever be dispatched -> blocklist
 *      immediately (`no_source`), independent of the window. Defensive: not
 *      currently reachable given import_jobs.source_id is TEXT NOT NULL
 *      (migration 0044) and every write path validates it non-empty; kept so
 *      the function still has a sane, terminal answer if that constraint
 *      ever weakens instead of dispatching with an empty source_id.
 *   3. Still incomplete, inside the window, or not an upstream-inaccessible
 *      failure -> dispatch (bump recovery_attempts, backoff).
 *   4. Still incomplete, past the window, AND upstream-inaccessible -> park
 *      on the blocklist (`upstream_403_after_window`) instead of dispatching
 *      forever against a dataset OpenNeuro itself can't serve.
 *
 * Pure -- `firstIncompleteAtMs` and `now` are both resolved by the caller
 * (COALESCE(first_incomplete_at, now) parsed to epoch ms) so the window
 * boundary is exact and independently testable.
 */
export function decideRetryAction(args: {
  now: number;
  verified: { complete: boolean };
  firstIncompleteAtMs: number;
  lastError: string | null;
  recoveryAttempts: number;
  hasSourceId: boolean;
}): RetryDecision {
  if (args.verified.complete) return { action: "recover" };
  if (!args.hasSourceId) return { action: "blocklist", reason: "no_source" };

  const upstreamInaccessible = (args.lastError ?? "").includes(OPENNEURO_UPSTREAM_MARKER);
  const pastWindow = args.now - args.firstIncompleteAtMs >= RETRY_WINDOW_MS;
  if (pastWindow && upstreamInaccessible) {
    return { action: "blocklist", reason: "upstream_403_after_window" };
  }

  const nextRecoveryAttempt = args.recoveryAttempts + 1;
  return {
    action: "dispatch",
    nextRecoveryAttempt,
    nextRetryAt: args.now + retryBackoffMs(nextRecoveryAttempt),
  };
}

export interface RetryCandidateInput {
  datasetId: string;
  sourceId: string | null;
  verified: { complete: boolean };
  firstIncompleteAtMs: number;
  lastError: string | null;
  recoveryAttempts: number;
}

export interface RetryPlanItem {
  datasetId: string;
  sourceId: string | null;
  decision: RetryDecision;
}

/**
 * Apply {@link decideRetryAction} across a tick's already-verified candidates
 * AND enforce the per-tick dispatch cap in one pure pass. A candidate whose
 * decision is `dispatch` but the cap is already spent is simply omitted from
 * the plan -- its D1 row is left untouched (next_retry_at unchanged), so it's
 * picked up again on the next tick. Pure -- no I/O, exhaustively testable.
 */
export function planRetryTick(
  candidates: RetryCandidateInput[],
  opts: { now: number; maxDispatches: number },
): RetryPlanItem[] {
  let dispatchCount = 0;
  const plan: RetryPlanItem[] = [];
  for (const c of candidates) {
    const decision = decideRetryAction({
      now: opts.now,
      verified: c.verified,
      firstIncompleteAtMs: c.firstIncompleteAtMs,
      lastError: c.lastError,
      recoveryAttempts: c.recoveryAttempts,
      hasSourceId: Boolean(c.sourceId),
    });
    if (decision.action === "dispatch") {
      if (dispatchCount >= opts.maxDispatches) continue; // deferred to next tick
      dispatchCount++;
    }
    plan.push({ datasetId: c.datasetId, sourceId: c.sourceId, decision });
  }
  return plan;
}

/**
 * Gate for the OpenNeuro maintainer report send. `alreadyNotified` (an
 * already-set maintainer_notified_at) always wins -- once per dataset, ever.
 * Otherwise: real send only when the flag is on AND a recipient is
 * configured; everything else is dry-run (compute + audit, no send). Pure.
 */
export function decideMaintainerNotification(args: {
  enabled: boolean;
  hasRecipient: boolean;
  alreadyNotified: boolean;
}): "send" | "dry_run" | "skip_already_notified" {
  if (args.alreadyNotified) return "skip_already_notified";
  if (args.enabled && args.hasRecipient) return "send";
  return "dry_run";
}

// ---------------------------------------------------------------------------
// Candidate queries -- exported so tests assert the exact WHERE logic against
// a real in-memory SQLite db (mirrors ARCHIVE_RETRY_SWEEP_QUERY).
// ---------------------------------------------------------------------------

/**
 * Retry candidates: `incomplete` / `failed` rows always qualify; `quarantined`
 * rows qualify ONLY when last_error carries the upstream-inaccessible marker
 * -- every other quarantine reason (has_doi, made_public, system_owned,
 * has_version, reached_complete, not_found_dataset, or a partial-cascade
 * rollback failure) means something real already exists or NEMAR-side state
 * needs a human, so those are left for manual review, never auto-retried.
 * `rolled_back` and `complete` are excluded by the status IN list; blocklisted
 * rows are excluded (they live in BLOCKLIST_RECHECK_QUERY instead).
 */
export const IMPORT_RETRY_CANDIDATES_QUERY = `
  SELECT dataset_id, source_id, recovery_attempts, first_incomplete_at, last_error
    FROM import_jobs
   WHERE blocklisted = 0
     AND status IN ('incomplete', 'failed', 'quarantined')
     AND (next_retry_at IS NULL OR next_retry_at <= ?)
     AND (status != 'quarantined' OR last_error LIKE '%${OPENNEURO_UPSTREAM_MARKER}%')
   ORDER BY updated_at ASC
   LIMIT ?`;

/** Slow re-verify cadence for already-blocklisted rows. */
export const BLOCKLIST_RECHECK_QUERY = `
  SELECT dataset_id, source_id, recovery_attempts, first_incomplete_at, last_error
    FROM import_jobs
   WHERE blocklisted = 1
     AND (next_retry_at IS NULL OR next_retry_at <= ?)
   ORDER BY updated_at ASC
   LIMIT ?`;

/** Bounded, resumable reclassification candidates: `complete` rows never
 *  re-verified. Once every complete row has been checked once,
 *  integrity_checked_at IS NULL drains to empty and the sweep is a no-op
 *  fast query until new imports finalize. */
export const RECLASSIFY_CANDIDATES_QUERY = `
  SELECT dataset_id
    FROM import_jobs
   WHERE status = 'complete'
     AND integrity_checked_at IS NULL
   ORDER BY updated_at ASC
   LIMIT ?`;

interface CandidateRow {
  dataset_id: string;
  source_id: string | null;
  recovery_attempts: number;
  first_incomplete_at: string | null;
  last_error: string | null;
}

function nowSqlite(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

async function writeAudit(
  db: D1Database,
  action: string,
  datasetId: string,
  details: unknown,
): Promise<void> {
  try {
    await db
      .prepare("INSERT INTO audit_log (action, resource_id, details) VALUES (?, ?, ?)")
      .bind(action, datasetId, JSON.stringify(details))
      .run();
  } catch (err) {
    console.error(`[import-retry] audit_log write failed for ${datasetId}:`, err);
  }
}

/**
 * Bounded, resumable sweep: re-verify up to RECLASSIFY_BATCH `complete` rows
 * that have never been integrity-checked. A row whose S3 content turns out
 * incomplete flips to `status='incomplete'`, becomes immediately eligible for
 * the retry sweep (`next_retry_at = now`), and is audited
 * (`import_reclassified_incomplete`). A healthy row just gets
 * integrity_checked_at stamped so it's never re-walked. Feeds
 * sweepImportRetries; also callable standalone (e.g. from a future backfill).
 */
export async function reclassifyCompleteRows(
  env: Bindings,
  batchSize: number = RECLASSIFY_BATCH,
): Promise<{ checked: number; reclassified: number }> {
  if (isNonProductionEnv(env)) {
    console.log("[import-retry] reclassifyCompleteRows skipped (non-production)");
    return { checked: 0, reclassified: 0 };
  }

  let rows: { dataset_id: string }[];
  try {
    const res = await env.DB.prepare(RECLASSIFY_CANDIDATES_QUERY)
      .bind(batchSize)
      .all<{ dataset_id: string }>();
    rows = res.results ?? [];
  } catch (err) {
    console.error(
      "[import-retry] reclassify candidate query failed:",
      err instanceof Error ? err.message : String(err),
    );
    return { checked: 0, reclassified: 0 };
  }
  let reclassified = 0;

  for (const row of rows) {
    let verified: DatasetVersionIntegrityResult;
    try {
      verified = await verifyDatasetVersionS3(env, row.dataset_id);
    } catch (err) {
      console.error(
        `[import-retry] reclassify verify failed for ${row.dataset_id}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue; // leave integrity_checked_at NULL -- retried next tick
    }

    // Stamp datasets/dataset_versions from this same verification (#980):
    // this is precisely where the #967 bug (a false-`complete` import_jobs
    // row hiding a 0-byte S3 object) gets caught, so the catalog should
    // reflect the honest result the moment it's known rather than waiting for
    // the separate data-integrity-sweep to independently reach the dataset.
    // A stamp failure (D1 error) must not abort the whole batch and starve
    // sibling rows -- log and move on; the row stays a reclassify candidate
    // for the next tick since integrity_checked_at below never gets reached.
    try {
      await stampDatasetIntegrity(env.DB, row.dataset_id, verified);
    } catch (err) {
      console.error(
        `[import-retry] reclassify stamp failed for ${row.dataset_id}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }

    if (verified.complete) {
      await env.DB.prepare(
        "UPDATE import_jobs SET integrity_checked_at = datetime('now') WHERE dataset_id = ?",
      )
        .bind(row.dataset_id)
        .run();
      continue;
    }

    const upd = await env.DB.prepare(
      `UPDATE import_jobs
          SET status = 'incomplete',
              first_incomplete_at = COALESCE(first_incomplete_at, datetime('now')),
              next_retry_at = datetime('now'),
              integrity_checked_at = datetime('now'),
              updated_at = datetime('now')
        WHERE dataset_id = ?`,
    )
      .bind(row.dataset_id)
      .run();
    if ((upd.meta.changes ?? 0) === 0) {
      console.error(
        `[import-retry] reclassify-to-incomplete UPDATE matched 0 rows for ${row.dataset_id}`,
      );
    }
    await writeAudit(env.DB, "import_reclassified_incomplete", row.dataset_id, verified);
    reclassified++;
  }

  return { checked: rows.length, reclassified };
}

/**
 * Un-park a row back to healthy: clears blocklist/incomplete state, marks
 * `complete`, audits `import_recovered`. UNCONDITIONAL -- it does not check
 * (or preserve) the row's prior status, so it works whether the row was
 * `incomplete`, `failed`, or a blocklisted `quarantined`/`failed` (the
 * engine blocklists WITHOUT changing status; see decideRetryAction). Shared
 * by the main sweep's verify-first step, the blocklist slow re-check, and
 * the POST /admin/imports/:id/verify route's verified-complete branch.
 */
export async function recoverRow(db: D1Database, datasetId: string): Promise<void> {
  const upd = await db
    .prepare(
      `UPDATE import_jobs
          SET status = 'complete',
              blocklisted = 0,
              blocklist_reason = NULL,
              first_incomplete_at = NULL,
              next_retry_at = NULL,
              integrity_checked_at = datetime('now'),
              updated_at = datetime('now')
        WHERE dataset_id = ?`,
    )
    .bind(datasetId)
    .run();
  if ((upd.meta.changes ?? 0) === 0) {
    console.error(`[import-retry] recoverRow UPDATE matched 0 rows for ${datasetId}`);
  }
  await writeAudit(db, "import_recovered", datasetId, {});
}

/**
 * Prod-only cron sweep: reclassify, then retry/blocklist eligible candidates,
 * then re-check blocklisted rows. Defense-in-depth guard mirrors
 * archiveRetrySweep/reconcileReservedVersionDois -- the dev/staging D1 is a
 * partial PRODUCTION MIRROR and this sweep dispatches GitHub work against the
 * shared nemarDatasets org, so it must never run off-prod even if the cron
 * allowlist in index.ts is ever miswired.
 */
export async function sweepImportRetries(env: Bindings): Promise<void> {
  if (isNonProductionEnv(env)) {
    console.log("[import-retry] sweepImportRetries skipped (non-production)");
    return;
  }

  const reclassified = await reclassifyCompleteRows(env);

  const now = Date.now();
  const nowSql = nowSqlite(now);

  let candidateRows: CandidateRow[];
  try {
    const res = await env.DB.prepare(IMPORT_RETRY_CANDIDATES_QUERY)
      .bind(nowSql, IMPORT_RETRY_BATCH)
      .all<CandidateRow>();
    candidateRows = res.results ?? [];
  } catch (err) {
    console.error(
      "[import-retry] candidate query failed:",
      err instanceof Error ? err.message : String(err),
    );
    candidateRows = [];
  }

  const inputs: RetryCandidateInput[] = [];
  for (const row of candidateRows) {
    let verified: DatasetVersionIntegrityResult;
    try {
      verified = await verifyDatasetVersionS3(env, row.dataset_id);
    } catch (err) {
      console.error(
        `[import-retry] verify failed for ${row.dataset_id}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    // Stamp datasets/dataset_versions HERE, for every candidate regardless of
    // which decision it ends up with (#980 review fix): stamping only on the
    // `recover` branch below missed `dispatch`/`blocklist` candidates -- the
    // ones just freshly confirmed INCOMPLETE, exactly the #967 signature this
    // whole sweep exists to catch. Per-row isolation, like the sweep route: a
    // stamp failure must not abort the batch and starve sibling datasets.
    try {
      await stampDatasetIntegrity(env.DB, row.dataset_id, verified);
    } catch (err) {
      console.error(
        `[import-retry] stamp failed for ${row.dataset_id}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    inputs.push({
      datasetId: row.dataset_id,
      sourceId: row.source_id,
      verified,
      firstIncompleteAtMs: parseSqliteUtc(row.first_incomplete_at) ?? now,
      lastError: row.last_error,
      recoveryAttempts: row.recovery_attempts,
    });
  }

  const plan = planRetryTick(inputs, { now, maxDispatches: MAX_RECOVERY_DISPATCHES_PER_TICK });

  const newlyBlocklisted: Array<{ datasetId: string; sourceId: string | null }> = [];
  let recovered = 0;
  let blocklisted = 0;
  let dispatched = 0;

  let pat: string | null = null;
  for (const item of plan) {
    if (item.decision.action === "recover") {
      // Already stamped above at verify time (#980) -- no re-stamp here.
      await recoverRow(env.DB, item.datasetId);
      recovered++;
      continue;
    }
    if (item.decision.action === "blocklist") {
      const upd = await env.DB.prepare(
        `UPDATE import_jobs
            SET blocklisted = 1,
                blocklist_reason = ?,
                next_retry_at = ?,
                updated_at = datetime('now')
          WHERE dataset_id = ?`,
      )
        .bind(item.decision.reason, nowSqlite(now + BLOCKLIST_RECHECK_MS), item.datasetId)
        .run();
      if ((upd.meta.changes ?? 0) === 0) {
        console.error(`[import-retry] blocklist UPDATE matched 0 rows for ${item.datasetId}`);
      }
      await writeAudit(env.DB, "import_blocklisted", item.datasetId, {
        reason: item.decision.reason,
      });
      blocklisted++;
      if (item.decision.reason === "upstream_403_after_window") {
        newlyBlocklisted.push({ datasetId: item.datasetId, sourceId: item.sourceId });
      }
      continue;
    }
    // dispatch
    if (!item.sourceId) continue; // planRetryTick never emits dispatch without a source_id
    try {
      pat ??= await getDatasetsToken(env);
      await triggerOpenNeuroOnboard(item.sourceId, pat);
      const upd = await env.DB.prepare(
        `UPDATE import_jobs
            SET recovery_attempts = ?,
                first_incomplete_at = COALESCE(first_incomplete_at, datetime('now')),
                next_retry_at = ?,
                updated_at = datetime('now')
          WHERE dataset_id = ?`,
      )
        .bind(
          item.decision.nextRecoveryAttempt,
          nowSqlite(item.decision.nextRetryAt),
          item.datasetId,
        )
        .run();
      if ((upd.meta.changes ?? 0) === 0) {
        // The dispatch already fired (triggerOpenNeuroOnboard above), so a
        // 0-row match here means recovery_attempts/next_retry_at won't
        // advance even though the workflow is running -- surface it rather
        // than silently under-counting the retry budget.
        console.error(
          `[import-retry] dispatch-tracking UPDATE matched 0 rows for ${item.datasetId}`,
        );
      }
      await writeAudit(env.DB, "import_retry_dispatched", item.datasetId, {
        attempt: item.decision.nextRecoveryAttempt,
      });
      dispatched++;
    } catch (err) {
      console.error(
        `[import-retry] dispatch failed for ${item.datasetId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Blocklist slow re-check: cheap S3-only re-verify, no GitHub dispatch.
  let recheckRows: CandidateRow[] = [];
  try {
    const res = await env.DB.prepare(BLOCKLIST_RECHECK_QUERY)
      .bind(nowSql, IMPORT_RETRY_BATCH)
      .all<CandidateRow>();
    recheckRows = res.results ?? [];
  } catch (err) {
    console.error(
      "[import-retry] blocklist recheck query failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  let blocklistRecovered = 0;
  for (const row of recheckRows) {
    let verified: DatasetVersionIntegrityResult;
    try {
      verified = await verifyDatasetVersionS3(env, row.dataset_id);
    } catch (err) {
      console.error(
        `[import-retry] blocklist recheck verify failed for ${row.dataset_id}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    // Same stamp as the reclassify/recover paths above (#980): a blocklisted
    // row un-parking here is exactly as informative as any other recover, and
    // an access-restored dataset should not have to wait for the general
    // sweep to reflect it. Isolated the same way -- a stamp failure must not
    // abort the recheck batch and starve sibling rows.
    try {
      await stampDatasetIntegrity(env.DB, row.dataset_id, verified);
    } catch (err) {
      console.error(
        `[import-retry] blocklist recheck stamp failed for ${row.dataset_id}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    if (verified.complete) {
      await recoverRow(env.DB, row.dataset_id);
      blocklistRecovered++;
      continue;
    }
    const upd = await env.DB.prepare(
      "UPDATE import_jobs SET next_retry_at = ?, integrity_checked_at = datetime('now') WHERE dataset_id = ?",
    )
      .bind(nowSqlite(now + BLOCKLIST_RECHECK_MS), row.dataset_id)
      .run();
    if ((upd.meta.changes ?? 0) === 0) {
      console.error(`[import-retry] blocklist-recheck UPDATE matched 0 rows for ${row.dataset_id}`);
    }
  }

  if (newlyBlocklisted.length > 0) {
    await sendMaintainerReportIfDue(env, newlyBlocklisted);
  }

  console.log(
    `[import-retry] reclassified=${reclassified.reclassified}/${reclassified.checked} candidates=${candidateRows.length} recovered=${recovered} blocklisted=${blocklisted} dispatched=${dispatched} blocklistRecovered=${blocklistRecovered}/${recheckRows.length}`,
  );
}

/**
 * Batch the newly-blocklisted (upstream-inaccessible) datasets from this tick
 * into one OpenNeuro maintainer report email, gated by
 * OPENNEURO_MAINTAINER_EMAIL_ENABLED (see decideMaintainerNotification). The
 * report is always computed and audit-logged; `maintainer_notified_at` is
 * only stamped -- and the once-per-dataset guard only satisfied -- on a real
 * send, so a dry-run tick never silently marks a dataset "notified".
 */
export async function sendMaintainerReportIfDue(
  env: Bindings,
  candidates: Array<{ datasetId: string; sourceId: string | null }>,
): Promise<void> {
  // Re-query maintainer_notified_at fresh rather than trusting the in-memory
  // list: defensive against this function being invoked twice for the same
  // tick (it isn't, today, but the guard should hold on its own).
  const candidatePlaceholders = candidates.map(() => "?").join(",");
  const res = await env.DB.prepare(
    `SELECT dataset_id, source_id, first_incomplete_at, recovery_attempts
       FROM import_jobs
      WHERE dataset_id IN (${candidatePlaceholders}) AND maintainer_notified_at IS NULL`,
  )
    .bind(...candidates.map((c) => c.datasetId))
    .all<{
      dataset_id: string;
      source_id: string | null;
      first_incomplete_at: string | null;
      recovery_attempts: number;
    }>();
  const due = res.results ?? [];
  if (due.length === 0) return;

  const enabled = (env.OPENNEURO_MAINTAINER_EMAIL_ENABLED ?? "").trim().toLowerCase() === "true";
  const recipient = env.OPENNEURO_SUPPORT_EMAIL?.trim();
  const decision = decideMaintainerNotification({
    enabled,
    hasRecipient: Boolean(recipient),
    alreadyNotified: false, // the query above already filters those out
  });

  await writeAudit(env.DB, "import_maintainer_report_computed", "batch", {
    decision,
    datasets: due.map((d) => d.dataset_id),
  });

  if (decision !== "send") {
    console.log(
      `[import-retry] maintainer report dry-run (${decision}): ${due.length} dataset(s) would be reported`,
    );
    return;
  }
  if (!recipient) {
    // decision === "send" implies hasRecipient was true, so this is
    // unreachable in practice; kept as a real narrowing check (not an
    // assertion) so TypeScript proves `recipient` is a string below.
    console.error("[import-retry] maintainer report send skipped: no recipient configured");
    return;
  }
  if (!env.RESEND_API_KEY) {
    console.error("[import-retry] maintainer report send skipped: RESEND_API_KEY unset");
    return;
  }

  const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
  try {
    await sendOpenNeuroMaintainerReport(
      recipient,
      due.map((d) => ({
        datasetId: d.dataset_id,
        sourceId: d.source_id ?? "unknown",
        firstIncompleteAt: d.first_incomplete_at,
        recoveryAttempts: d.recovery_attempts,
      })),
      env.RESEND_API_KEY,
      fromEmail,
      replyTo,
      isDev,
    );
    await stampMaintainerNotified(
      env.DB,
      due.map((d) => d.dataset_id),
    );
  } catch (err) {
    console.error(
      "[import-retry] maintainer report send failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Stamp `maintainer_notified_at` for exactly the dataset ids given -- called
 * after a successful send. Extracted so its placeholder/bind count is a
 * self-contained invariant of ITS OWN argument, not something a caller can
 * accidentally source from a differently-sized array: `datasetIds` here is
 * `due` (the subset of `candidates` still needing notification after the
 * maintainer_notified_at IS NULL filter), and reusing a `candidates`-sized
 * placeholder string for it was exactly the #969 review bug -- D1 throws
 * "wrong number of parameter bindings" whenever the two lengths differ,
 * which fires AFTER the email already sent, silently losing the stamp and
 * breaking the once-per-dataset guarantee on the next tick. Exported for a
 * direct, network-free test of this exact invariant.
 */
export async function stampMaintainerNotified(db: D1Database, datasetIds: string[]): Promise<void> {
  if (datasetIds.length === 0) return;
  const duePlaceholders = datasetIds.map(() => "?").join(",");
  const upd = await db
    .prepare(
      `UPDATE import_jobs SET maintainer_notified_at = datetime('now') WHERE dataset_id IN (${duePlaceholders})`,
    )
    .bind(...datasetIds)
    .run();
  if ((upd.meta.changes ?? 0) !== datasetIds.length) {
    // Best-effort even after this fix: a D1 error surfaces via the caller's
    // catch, but a SUCCESSFUL write that matches fewer rows than expected
    // (e.g. a concurrent write already touched a row) still means some
    // recipients are unstamped -- worst case a later duplicate report, not
    // a lost/incorrect one, so this only logs rather than retrying.
    console.error(
      `[import-retry] maintainer_notified_at UPDATE matched ${upd.meta.changes ?? 0} of ${datasetIds.length} expected rows`,
    );
  }
}
