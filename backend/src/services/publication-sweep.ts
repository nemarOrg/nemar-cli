/**
 * Re-evaluate publication requests that were blocked on BIDS validation (#428).
 *
 * When a user runs `nemar dataset publish request` while BIDS validation CI is
 * still pending/running, the request is blocked with
 * `block_reason='bids_validation_pending' | 'bids_validation_in_progress'`. That
 * block was one-shot: nothing re-checked the request when CI later went green,
 * so requests sat in `blocked` indefinitely (13 of bruaristimunha's requests
 * stuck for weeks, cleared by hand). This sweep — run from the daily cron — is
 * the defense-in-depth re-evaluation the issue asks for: it re-reads the latest
 * BIDS validation run for each blocked request and transitions it.
 *
 * It reuses the exact readiness evaluation from the publish-request path
 * (`getWorkflowRuns(..., "bids-validation.yml")` -> latest run conclusion), so
 * the cron and the interactive path can never disagree.
 */

import type { Bindings } from "../types/bindings.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsToken } from "./github-auth.js";
import { getWorkflowRuns } from "./github.js";

/** The block_reason values produced by the BIDS-validation readiness check. */
export const BIDS_VALIDATION_BLOCK_REASONS = [
  "bids_validation_pending",
  "bids_validation_in_progress",
  "bids_validation_failed",
] as const;

export type BlockedBidsAction =
  | { kind: "unblock" }
  | { kind: "reblock"; blockReason: "bids_validation_failed" }
  | { kind: "keep" };

/**
 * Pure decision: given the latest BIDS validation run, what should happen to a
 * request currently blocked on validation? Mirrors the publish-request logic in
 * `routes/datasets/publication.ts`:
 *   - no runs yet                 -> still pending, keep blocked
 *   - latest conclusion 'success' -> unblock (back to 'requested')
 *   - latest conclusion 'failure' -> re-block as 'bids_validation_failed'
 *   - latest conclusion null      -> in progress, keep blocked
 *   - cancelled/skipped/timed_out -> keep blocked; a later run decides
 */
export function evaluateBlockedBidsValidation(args: {
  hasRuns: boolean;
  latestConclusion: string | null;
}): BlockedBidsAction {
  if (!args.hasRuns) return { kind: "keep" };
  if (args.latestConclusion === "success") return { kind: "unblock" };
  if (args.latestConclusion === "failure")
    return { kind: "reblock", blockReason: "bids_validation_failed" };
  return { kind: "keep" };
}

export interface BlockedSweepResult {
  scanned: number;
  unblocked: number;
  reblocked: number;
  errors: number;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Re-evaluate every publication request blocked on BIDS validation and
 * transition the ones whose CI has since resolved. Returns a tally for the cron
 * log. Never throws — per-row failures are counted and skipped so one bad repo
 * can't abort the sweep.
 *
 * Unblocked requests move to 'requested' (they re-enter the admin publish
 * queue, visible via `nemar admin publish list`). No email is sent from the
 * sweep on purpose: a daily batch could otherwise fire a burst of notifications
 * for a backlog of stuck requests.
 */
export async function sweepBlockedBidsValidationRequests(
  env: Bindings,
  limit = 50,
): Promise<BlockedSweepResult> {
  const db = env.DB;
  const result: BlockedSweepResult = { scanned: 0, unblocked: 0, reblocked: 0, errors: 0 };

  // Production only (epic #923 Phase 7). The candidate query filters on request
  // status alone, with no dataset-id prefix restriction, so on the dev/staging
  // worker (whose D1 is a partial production mirror) it would select REAL
  // datasets' publication requests, read their real repos via the shared
  // nemarDatasets installation token, and rewrite their status.
  //
  // Narrowed rather than disabled: staging genuinely needs this sweep, because
  // an exemplar published while its BIDS validation is still running lands in
  // exactly this 'blocked' state and would otherwise stay stuck forever. So
  // outside production the candidate set is scoped to the dev range (xx09NNNN),
  // which is the same fence the sandbox cleanup uses.
  const devRangeOnly = isNonProductionEnv(env);
  const scopeClause = devRangeOnly ? "AND pr.dataset_id LIKE 'xx09%'" : "";

  const placeholders = BIDS_VALIDATION_BLOCK_REASONS.map(() => "?").join(", ");
  // Guard the initial query so a D1 outage / schema drift surfaces as errors>0
  // in the cron tally rather than an all-zero result indistinguishable from
  // "nothing to do". This keeps the "never throws" contract honest.
  let rows: {
    results: Array<{
      id: number;
      dataset_id: string;
      block_reason: string;
      github_repo: string | null;
    }>;
  };
  try {
    rows = await db
      .prepare(
        `SELECT pr.id, pr.dataset_id, pr.block_reason, d.github_repo
           FROM publication_requests pr
           JOIN datasets d ON d.dataset_id = pr.dataset_id
          WHERE pr.status = 'blocked'
            AND pr.block_reason IN (${placeholders})
            ${scopeClause}
          ORDER BY pr.updated_at ASC
          LIMIT ?`,
      )
      .bind(...BIDS_VALIDATION_BLOCK_REASONS, limit)
      .all<{ id: number; dataset_id: string; block_reason: string; github_repo: string | null }>();
  } catch (err) {
    result.errors++;
    console.error(`[publish-sweep] initial query failed; sweep aborted: ${errMsg(err)}`);
    return result;
  }

  if (rows.results.length === 0) return result;

  let pat: string;
  try {
    pat = await getDatasetsToken(env);
  } catch (err) {
    // Auth failure with rows pending is a real error, not a no-op: count it so
    // a broken token surfaces in the audit log instead of reading as "clean".
    result.errors++;
    console.error(
      `[publish-sweep] could not resolve datasets token; skipping sweep: ${errMsg(err)}`,
    );
    return result;
  }

  for (const row of rows.results) {
    result.scanned++;
    const repoName = row.github_repo?.split("/")[1];
    if (!repoName) {
      console.warn(`[publish-sweep] ${row.dataset_id}: no github_repo on dataset; skipping`);
      continue;
    }

    let action: BlockedBidsAction;
    try {
      const runs = await getWorkflowRuns(repoName, "bids-validation.yml", pat);
      action = evaluateBlockedBidsValidation({
        hasRuns: runs.length > 0,
        latestConclusion: runs[0]?.conclusion ?? null,
      });
    } catch (err) {
      result.errors++;
      console.error(`[publish-sweep] CI lookup failed for ${row.dataset_id}: ${errMsg(err)}`);
      continue;
    }

    try {
      if (action.kind === "unblock") {
        // Mirror the interactive re-request unblock (routes/datasets/publication.ts): also
        // clear stale prescreen state so a previously-screened request doesn't
        // surface a phantom advisory after the sweep moves it back to
        // 'requested'. Guard on status='blocked' so a concurrent re-request
        // can't be clobbered.
        const upd = await db
          .prepare(
            `UPDATE publication_requests
                SET status = 'requested', block_reason = NULL,
                    prescreen_status = NULL, prescreen_nonce = NULL,
                    prescreen_issue_url = NULL, prescreen_reasons = NULL,
                    updated_at = datetime('now')
              WHERE id = ? AND status = 'blocked'`,
          )
          .bind(row.id)
          .run();
        if ((upd.meta.changes ?? 0) > 0) {
          result.unblocked++;
          console.log(
            `[publish-sweep] ${row.dataset_id}: BIDS validation now green; request ${row.id} unblocked -> requested`,
          );
        }
      } else if (action.kind === "reblock" && row.block_reason !== action.blockReason) {
        const upd = await db
          .prepare(
            `UPDATE publication_requests
                SET block_reason = ?, updated_at = datetime('now')
              WHERE id = ? AND status = 'blocked'`,
          )
          .bind(action.blockReason, row.id)
          .run();
        if ((upd.meta.changes ?? 0) > 0) {
          result.reblocked++;
          console.log(
            `[publish-sweep] ${row.dataset_id}: BIDS validation failing; request ${row.id} block_reason -> ${action.blockReason}`,
          );
        }
      }
    } catch (err) {
      // A transient D1 error on one row must not abort the whole sweep: count
      // it and move on so the remaining rows are still processed.
      result.errors++;
      console.error(`[publish-sweep] DB update failed for ${row.dataset_id}: ${errMsg(err)}`);
    }
  }

  return result;
}
