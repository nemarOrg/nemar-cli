/**
 * The Worker's merge of an automatic re-pull (epic #1046 phase 7, #1913; ADR 0111, decisions 6
 * and 7, and its Phase 7g amendment). The advance tick (`upstream-repull-advance.ts`) calls it for
 * an automatic record at `gates_clear`, in production only. It is the one code path in the Worker
 * that merges a pull request, and it merges nothing but this class: a re-pull the automatic path
 * opened, machine clean at the moment of the merge.
 *
 * THE MERGE, in this order; the first step that does not hold sends nothing:
 *  1. Exact production, an automatic record, at `gates_clear`, holding no claim to merge. Any other
 *     row is not this function's (`skipped`), and nothing is read for it: an administrator's
 *     re-pull is never merged by the Worker.
 *  2. Both switches, `AUTO_REPULL_ENABLED` and `AUTO_REPULL_MERGE_ENABLED`, each exactly `"1"`
 *     (`switch-off`, `merge-switch-off`), before anything is read.
 *  3. The bound. At most {@link WORKER_MERGES_MAX} merges are ever sent for one record, counted
 *     from the audit row written before each (`repull_auto_merge`), so past it the record holds
 *     `merge-exhausted`; and a record whose last merge GitHub refused is not claimed again
 *     (`merge-refused`): another would be refused too, so an administrator looks.
 *  4. The machine-clean facts, read now at the merge stage (`gatherMachineCleanFacts`), never the
 *     gates' reading: the switches again, the record, the dataset, the pull request the App opened
 *     at the screened head, `main` exactly the record's base, both checks green, the screen clear,
 *     the review a pass and GitHub's `clean`. Any other answer, an unknown fact's included, holds
 *     with its word, and a `main` that moved at all is `main-moved`, which is stricter than the
 *     administrator's gate (`merge-main-moved` refuses only a move outside `.nemar/` and
 *     `.github/`).
 *  5. The squash message (`shared/repull-squash.ts`), whose last paragraph must carry the re-pull
 *     commit's two trailers, because the release reads them back from the merge on `main`
 *     (`merge-message` otherwise).
 *  6. The claim to merge: the record's own self-edge, as the system user. It reads the dataset
 *     fences, the screen and GitHub's live head again and counts `REPULL_DAILY_MERGE_CAP` in the
 *     statement that claims, so a full day holds `cap-exhausted`, a cap set to something unreadable
 *     `cap-unreadable`, and any other refusal `claim-refused`, which should not happen and is said.
 *  7. The audit row of the merge (`repull_auto_merge`), in one statement that applies only while
 *     the record still holds that claim at the revision the claim left, and only under the bound.
 *     Nothing is sent without it, so the count it keeps never misses a merge that was sent.
 *  8. The squash merge, `PUT .../pulls/<n>/merge`, with the screened head as `sha` (GitHub refuses a
 *     head that moved since), `merge_method` `squash`, the message of step 5, and the Worker's own
 *     GitHub credential. The Worker submits no review: the record is the merge, the row and the
 *     plan digest.
 * Then GitHub's answer, recorded in its own audit row (`repull_auto_merge_answer`):
 *  - `merged: true`: the merge is recorded through the verified route (`recordRepullMerged`), which
 *    reads GitHub again and stores GitHub's merge commit;
 *  - a 4xx: GitHub refused it, so it did not merge. The claim is kept, because the record releases
 *    a claim only once it is five minutes old, and the record holds `merge-refused`;
 *  - a 5xx, no answer, a timeout, or a 2xx that does not say `merged: true`: the merge may have
 *    happened. The claim is kept, the record holds `claim-held`, and nothing is sent again blind.
 *
 * PRODUCTION ONLY, and no mail: nothing here imports a mail service (`repull-no-mail-scan.test.ts`).
 */

import { machineClean } from "../../../shared/repull-machine-clean.js";
import { repullSquashMessage, trailerValuesProblem } from "../../../shared/repull-squash.js";
import type { HoldReason, RepullRow } from "../../../shared/repull-state.js";
import { AUDIT_LOG_INSERT_SQL, auditLogParams } from "../db/audit-log.js";
import { SYSTEM_USER_ID } from "../lib/constants.js";
import type { Bindings } from "../types/bindings.js";
import { getDatasetsToken } from "./github-auth.js";
import { GITHUB_API, ORG_NAME, ghHeaders } from "./github/shared.js";
import { autoRepullEnabled, autoRepullMergeEnabled, isExactProduction } from "./repull-switches.js";
import { gatherMachineCleanFacts } from "./upstream-repull-facts.js";
import { HELD_CLAIM_MAX_AGE_MINUTES, recordRepullMerged } from "./upstream-repull-verified.js";
import { commitTransition, isRefusal, prepareTransition } from "./upstream-repull.js";

/** The most merges the Worker ever sends for one record, a retry under a held claim included. */
export const WORKER_MERGES_MAX = 3;

/** How long the merge may take before its answer counts as lost. */
export const WORKER_MERGE_TIMEOUT_MS = 30_000;

let mergeTimeoutMs = WORKER_MERGE_TIMEOUT_MS;

/**
 * Tests only: shorten the merge's timeout, so a GitHub that never answers is proven to leave the
 * claim held in milliseconds rather than thirty seconds. `null` restores the default.
 */
export function __setWorkerMergeTimeoutForTests(ms: number | null): void {
  mergeTimeoutMs = ms ?? WORKER_MERGE_TIMEOUT_MS;
}

/** The audit action written before each merge the Worker sends, and the one its answer goes in. */
export const WORKER_MERGE_ACTION = "repull_auto_merge";
export const WORKER_MERGE_ANSWER_ACTION = "repull_auto_merge_answer";

// ----------------------------------------------------------------------------
// SQL. Exported so a test runs the statement the merge runs, never a copy.
// ----------------------------------------------------------------------------

const MERGES_OF = (param: string) => `FROM audit_log
     WHERE action = '${WORKER_MERGE_ACTION}' AND resource_type = 'upstream_repull'
       AND resource_id = CAST(${param} AS TEXT)`;

/**
 * The record of one merge the Worker is about to send: `?1` the system user, `?2` the re-pull,
 * `?3` the details, `?4` the revision the claim left, `?5` the claimed head, `?6` the claim's
 * Worker-stamped time, `?7` 1 when the claim must still be younger than
 * {@link HELD_CLAIM_MAX_AGE_MINUTES} minutes (a merge sent again under a claim made earlier), `?8`
 * {@link WORKER_MERGES_MAX}. It applies only while the record is automatic, at `gates_clear`, at that
 * revision, holding exactly that claim and no merge, and while fewer than the bound were sent for
 * it, so the count and the send are decided in one statement, and a merge is never sent under a
 * claim the administrator's `resume` may be expiring (it expires one at 30 minutes).
 */
export const WORKER_MERGE_SENT_SQL = `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
  SELECT ?1, '${WORKER_MERGE_ACTION}', 'upstream_repull', CAST(?2 AS TEXT), ?3
   WHERE EXISTS (SELECT 1 FROM upstream_repulls
                  WHERE id = ?2 AND revision = ?4 AND origin = 'automatic' AND status = 'gates_clear'
                    AND merge_claim_sha = ?5 AND merge_claimed_at = ?6 AND merge_sha IS NULL
                    AND (?7 = 0 OR merge_claimed_at > datetime('now', '-${HELD_CLAIM_MAX_AGE_MINUTES} minutes')))
     AND (SELECT COUNT(*) ${MERGES_OF("?2")}) < ?8`;

/**
 * The merges the Worker sent for one record (`?1`), as one row: how many (`sent`), the claim the
 * latest was sent under (`last_claimed_at`, its Worker-stamped time) and what GitHub answered it
 * (`last_outcome`, `merged`, `refused` or `unknown`, or NULL when no answer was recorded, which is
 * read as unknown). The answer is matched to the latest merge by its attempt number, so an earlier
 * merge's answer is never read as the latest one's.
 */
export const WORKER_MERGES_SQL = `SELECT
  (SELECT COUNT(*) ${MERGES_OF("?1")}) AS sent,
  (SELECT json_extract(details, '$.claimed_at') ${MERGES_OF("?1")} ORDER BY id DESC LIMIT 1) AS last_claimed_at,
  (SELECT json_extract(a.details, '$.outcome') FROM audit_log a
     WHERE a.action = '${WORKER_MERGE_ANSWER_ACTION}' AND a.resource_type = 'upstream_repull'
       AND a.resource_id = CAST(?1 AS TEXT)
       AND json_extract(a.details, '$.attempt') = (SELECT COUNT(*) ${MERGES_OF("?1")})
     ORDER BY a.id DESC LIMIT 1) AS last_outcome`;

export interface WorkerMerges {
  sent: number;
  last_claimed_at: string | null;
  last_outcome: "merged" | "refused" | "unknown" | null;
}

/** The merges the Worker sent for `id`; a count that cannot be read throws (unknown is not zero). */
export async function workerMerges(db: D1Database, id: number): Promise<WorkerMerges> {
  const m = await db.prepare(WORKER_MERGES_SQL).bind(id).first<WorkerMerges>();
  if (typeof m?.sent !== "number") throw new Error("the Worker's merges could not be counted");
  return m;
}

// ----------------------------------------------------------------------------
// The outcome
// ----------------------------------------------------------------------------

/** What one call came to, for the advance tick to count and to record as the row's hold. */
export interface WorkerMergeOutcome {
  /**
   * `merged`: GitHub merged it and the merge is recorded. `held`: nothing was sent now (a rule, the
   * cap, a bound, a claim that waits on GitHub). `refused`: GitHub refused the merge sent now.
   * `unknown`: a merge was sent now and GitHub's answer does not say what became of it. `skipped`:
   * not the Worker's row to merge, and nothing was read or written for it.
   */
  kind: "merged" | "held" | "refused" | "unknown" | "skipped";
  /** The record as the Worker last read or wrote it: a hold is recorded on this revision. */
  row: RepullRow;
  /** The word to record on the row, or null for none. */
  hold: HoldReason | null;
  /** Whether this call sent a merge to GitHub. */
  sent: boolean;
  /** GitHub's HTTP status for a merge it refused or left unanswered; 0 for no answer at all. */
  status?: number;
  /** The record's refusal code, when it refused the claim or the record of the merge. */
  code?: string;
}

const held = (row: RepullRow, hold: HoldReason, code?: string): WorkerMergeOutcome => ({
  kind: "held",
  row,
  hold,
  sent: false,
  ...(code ? { code } : {}),
});

// ----------------------------------------------------------------------------
// The squash merge
// ----------------------------------------------------------------------------

type MergeAnswer =
  | { outcome: "merged"; status: number }
  | { outcome: "refused"; status: number }
  | { outcome: "unknown"; status: number };

/**
 * `PUT /repos/nemarDatasets/<id>/pulls/<n>/merge`, once, with `token`: a squash at `sha` with the
 * message given. One attempt and no retry: a 5xx, a lost connection and a timeout can each come
 * after GitHub merged, so a merge is never sent twice blind. GitHub's body is read for `merged`
 * alone and never forwarded or logged.
 */
async function sendSquashMerge(
  row: RepullRow,
  token: string,
  sha: string,
  squash: { title: string; message: string },
): Promise<MergeAnswer> {
  let res: Response;
  try {
    res = await fetch(
      `${GITHUB_API()}/repos/${ORG_NAME}/${row.dataset_id}/pulls/${row.pr_number}/merge`,
      {
        method: "PUT",
        headers: { ...ghHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          sha,
          merge_method: "squash",
          commit_title: squash.title,
          commit_message: squash.message,
        }),
        signal: AbortSignal.timeout(mergeTimeoutMs),
      },
    );
  } catch (err) {
    console.error(
      `[repull-merge] re-pull ${row.id}: the merge got no answer (${err instanceof Error ? err.name : "Error"})`,
    );
    return { outcome: "unknown", status: 0 };
  }
  const body = (await res.json().catch(() => null)) as { merged?: unknown } | null;
  if (res.ok) {
    return body?.merged === true
      ? { outcome: "merged", status: res.status }
      : { outcome: "unknown", status: res.status };
  }
  if (res.status >= 400 && res.status < 500) return { outcome: "refused", status: res.status };
  return { outcome: "unknown", status: res.status };
}

/** The answer's audit row: what GitHub said to the merge the row before it recorded. */
async function recordAnswer(
  db: D1Database,
  row: RepullRow,
  sent: { sha: string; claimedAt: string; attempt: number },
  answer: MergeAnswer,
): Promise<void> {
  try {
    await db
      .prepare(AUDIT_LOG_INSERT_SQL)
      .bind(
        ...auditLogParams({
          userId: SYSTEM_USER_ID,
          action: WORKER_MERGE_ANSWER_ACTION,
          resourceType: "upstream_repull",
          resourceId: String(row.id),
          details: JSON.stringify({
            dataset_id: row.dataset_id,
            pr: "n0",
            sha: sent.sha,
            claimed_at: sent.claimedAt,
            attempt: sent.attempt,
            outcome: answer.outcome,
            status: answer.status,
          }),
        }),
      )
      .run();
  } catch (err) {
    // An answer that is not recorded reads as unknown, the safe direction: the claim stays held.
    console.error(
      `[repull-merge] re-pull ${row.id}: GitHub's answer to the merge was not recorded (${err instanceof Error ? err.name : "Error"})`,
    );
  }
}

/**
 * Record the merge the row holds a claim for, and send it: the audit row first, in the statement
 * that also decides whether it may go ({@link WORKER_MERGE_SENT_SQL}), then the squash merge, then
 * GitHub's answer, and for `merged: true` the merge itself through the verified route. `young` is
 * set for a merge sent again under a claim made earlier.
 */
export async function sendUnderClaim(
  env: Bindings,
  row: RepullRow,
  token: string,
  opts: { young: boolean; attempt: number },
): Promise<WorkerMergeOutcome> {
  const db = env.DB;
  const sha = row.merge_claim_sha;
  const claimedAt = row.merge_claimed_at;
  if (sha === null || claimedAt === null || row.pr_number === null) {
    return held(row, "claim-held");
  }
  const squash = repullSquashMessage(row, row.pr_number, "n0", "worker");
  const recorded = await db
    .prepare(WORKER_MERGE_SENT_SQL)
    .bind(
      SYSTEM_USER_ID,
      row.id,
      JSON.stringify({
        dataset_id: row.dataset_id,
        pr: "n0",
        sha,
        claimed_at: claimedAt,
        attempt: opts.attempt,
      }),
      row.revision,
      sha,
      claimedAt,
      opts.young ? 1 : 0,
      WORKER_MERGES_MAX,
    )
    .run();
  // The record moved, the claim aged past the bound for sending under it, or the bound is reached:
  // nothing is sent, and the claim waits on GitHub.
  if ((recorded.meta?.changes ?? 0) === 0) return held(row, "claim-held");

  const answer = await sendSquashMerge(row, token, sha, squash);
  await recordAnswer(db, row, { sha, claimedAt, attempt: opts.attempt }, answer);
  if (answer.outcome === "refused") {
    return { kind: "refused", row, hold: "merge-refused", sent: true, status: answer.status };
  }
  if (answer.outcome === "unknown") {
    return { kind: "unknown", row, hold: "claim-held", sent: true, status: answer.status };
  }
  // GitHub merged it: the verified route reads GitHub again and records GitHub's merge commit. One
  // it cannot record yet (GitHub's read lagging its own merge, say) leaves the claim held, and the
  // next tick reads GitHub and records it.
  const done = await recordRepullMerged(env, { id: SYSTEM_USER_ID }, row.id, { pr: "n0" });
  if (isRefusal(done)) {
    return {
      kind: "unknown",
      row: done.row ?? row,
      hold: "claim-held",
      sent: true,
      status: answer.status,
      code: done.code,
    };
  }
  return { kind: "merged", row: done.row, hold: null, sent: true };
}

// ----------------------------------------------------------------------------
// The merge of a machine-clean automatic re-pull
// ----------------------------------------------------------------------------

/** The claim's refusals that are a full day or a cap that does not read, not a disagreement. */
const CAP_REFUSALS: Readonly<Record<string, HoldReason>> = {
  "merge-cap": "cap-exhausted",
  "merge-cap-unreadable": "cap-unreadable",
};

/**
 * Merge `row` if it is machine clean now: see the module comment for the steps. Called for an
 * automatic record at `gates_clear` that holds no claim; any other row is `skipped`.
 */
export async function workerMergeRepull(
  env: Bindings,
  row: RepullRow,
): Promise<WorkerMergeOutcome> {
  // 1. Not the Worker's row: nothing is read for it.
  if (
    !isExactProduction(env) ||
    row.origin !== "automatic" ||
    row.status !== "gates_clear" ||
    row.merge_claim_sha !== null ||
    row.merge_claimed_at !== null
  ) {
    return { kind: "skipped", row, hold: null, sent: false };
  }

  // 2. The switches, before anything is read.
  if (!autoRepullEnabled(env)) return held(row, "switch-off");
  if (!autoRepullMergeEnabled(env)) return held(row, "merge-switch-off");

  // 3. The bound.
  const merges = await workerMerges(env.DB, row.id);
  if (merges.sent >= WORKER_MERGES_MAX) return held(row, "merge-exhausted");
  if (merges.last_outcome === "refused") return held(row, "merge-refused");

  // 4. The machine-clean facts, read now.
  const verdict = machineClean(await gatherMachineCleanFacts(env, row, "merge"));
  if (!verdict.clean) return held(row, verdict.hold);

  // 5. The squash message.
  if (row.pr_number === null || row.gates_sha === null || trailerValuesProblem(row) !== null) {
    return held(row, "merge-message");
  }

  // The credential before the claim, so a claim is never made that could not then be sent.
  let token: string;
  try {
    token = await getDatasetsToken(env);
  } catch (err) {
    console.error(
      `[repull-merge] re-pull ${row.id}: no GitHub credential for the merge (${err instanceof Error ? err.name : "Error"})`,
    );
    return held(row, "pr-unreadable");
  }

  // 6. The claim, through the record's own statement, as the system user.
  const prepared = await prepareTransition(
    env,
    { id: SYSTEM_USER_ID },
    row,
    { from: "gates_clear", to: "gates_clear", fields: { merge_claim_sha: row.gates_sha } },
    { auditDetails: { automatic: true, worker_merge: true } },
  );
  const claimed = isRefusal(prepared) ? prepared : await commitTransition(env.DB, prepared);
  if (isRefusal(claimed)) {
    if (claimed.code === "stale-status") {
      // The record moved while it was read: the next tick reads it as it is.
      return { kind: "skipped", row: claimed.row ?? row, hold: null, sent: false };
    }
    const cap = CAP_REFUSALS[claimed.code];
    if (cap) return held(row, cap, claimed.code);
    return held(row, claimed.status === 502 ? "pr-unreadable" : "claim-refused", claimed.code);
  }

  // 7 and 8. The merge's audit row, then the merge, under the claim just made.
  return sendUnderClaim(env, claimed.row, token, { young: false, attempt: merges.sent + 1 });
}
