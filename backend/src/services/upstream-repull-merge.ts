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
 *     `cap-unreadable`, and a live head GitHub could not answer `pr-unreadable` (the record's
 *     `github-unreadable`, a 502). A record that moved while it was read (`stale-status`) is
 *     `skipped`, for the next tick to read as it is; any other refusal is `claim-refused`, which
 *     should not happen and is said.
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
 *  - 405, 409 or 422 ({@link MERGE_REFUSED_STATUSES}): GitHub refused it, so it did not merge. The
 *    claim is kept, because the record releases a claim only once it is five minutes old, and the
 *    record holds `merge-refused`;
 *  - every other answer that is not a 2xx saying `merged: true` (a 401, a 403 or a 429, any other
 *    status, a 5xx, no answer, a timeout, a 2xx that does not say it merged): what became of the
 *    merge is not known. The claim is kept, the record holds `claim-held`, and nothing is sent again
 *    blind.
 *
 * A CLAIM THE WORKER HOLDS (`reconcileWorkerClaim`), on a later tick: GitHub, read again, says what
 * became of the merge, whatever the switches say, because a merge that happened minted a DOI and
 * must not be stranded; only sending one needs them. The claim is the Worker's when its own claim
 * edge, as the system user, made it (the latest claim in the record's audit rows); an
 * administrator's claim on an automatic record is theirs, and the Worker only records a merge
 * GitHub made at its head, and otherwise waits (`claim-held`).
 *  - Merged at the claimed head: the merge is recorded through the verified route. Merged at
 *    another head: `claim-held`, for an administrator's `resume`, which records it with its counts.
 *  - Not merged, and the last merge sent under this claim was refused: the claim is released
 *    through the record's own writer (`refused`, which needs the claim five minutes old and reads
 *    GitHub again), so its unit of the day's cap is free, and the record holds `merge-refused`.
 *  - Not merged, and the merge was sent and its answer was lost or did not say what became of it,
 *    or none was sent under the claim: while the pull request is open at the claimed head, the
 *    claim is younger than {@link HELD_CLAIM_MAX_AGE_MINUTES} minutes (so no merge goes out under a
 *    claim the administrator's `resume` may be expiring at 30), both switches are on, the bound
 *    allows, and the machine-clean facts read now are clean, the merge is sent again under the SAME
 *    claim: a second claim is never made for a merge that may have happened. Otherwise a claim
 *    under which nothing was sent is released (`not_sent`, five minutes old), and one whose answer
 *    was lost or did not say what became of it is kept (`claim-held`): only an administrator's
 *    `resume`, which expires it at 30 minutes, or GitHub's own word that it merged, ends it.
 *  - Closed and not merged: the claim is released through the record's writer (`refused` or
 *    `not_sent` as above, `expired` at 30 minutes for an answer that was lost or did not say what
 *    became of it), and the record holds `pr-closed` for an administrator.
 *
 * AFTER THE MERGE (`finishAfterMerge`): an automatic record at `merged` or `released` is walked to
 * `complete` by the central workflow's finish run (`nemar admin repull resume`, the trigger mode
 * `finish`), which reads the merge commit's trailers back, records the release and the lineage,
 * locks the objects the copy wrote and completes the record. The finish is dispatched at `merged`
 * once the version row of N.0.0 has its DOI (in either spelling of the version), and at `released`
 * at once, through the dispatch record's own claim (`claimFinishDispatch`, one live dispatch per
 * dataset, outside the open cap), at most {@link FINISH_DISPATCHES_MAX} times for a record; past
 * that the record holds `finish-exhausted` for an administrator's `resume`. It runs whatever the
 * switches say, in exact production only: turning them off must not strand a minted DOI's lineage,
 * lock and `complete`.
 *
 * PRODUCTION ONLY, and no mail: nothing here imports a mail service (`repull-no-mail-scan.test.ts`).
 */

import { isOwnDatasetRepo } from "../../../shared/nemar-app.js";
import { normalizeUpstreamTag } from "../../../shared/openneuro-tag.js";
import { bidsOverrideFault } from "../../../shared/repull-bids-override.js";
import { machineClean } from "../../../shared/repull-machine-clean.js";
import { repullSquashMessage, trailerValuesProblem } from "../../../shared/repull-squash.js";
import {
  type HoldReason,
  NEMAR_VERSION_RE,
  PULL_REQUEST_COLUMNS,
  type RepullPullRequest,
  type RepullRow,
} from "../../../shared/repull-state.js";
import { AUDIT_LOG_INSERT_SQL, auditLogParams } from "../db/audit-log.js";
import { SYSTEM_USER_ID } from "../lib/constants.js";
import type { Bindings } from "../types/bindings.js";
import { getDatasetsToken } from "./github-auth.js";
import {
  UPSTREAM_REPULL_DISPATCH_TIMEOUT_MS,
  buildUpstreamRepullPayload,
  triggerUpstreamRepullRun,
} from "./github/dispatch.js";
import { GITHUB_API, ORG_NAME, ghHeaders } from "./github/shared.js";
import { autoRepullEnabled, autoRepullMergeEnabled, isExactProduction } from "./repull-switches.js";
import {
  REFUSED_FOR_THE_DISPATCH,
  claimFinishDispatch,
  markDispatchSendFailed,
} from "./upstream-repull-dispatch.js";
import {
  gatherMachineCleanFacts,
  readCheckFacts,
  readPullRequestFact,
} from "./upstream-repull-facts.js";
import { readRecordedPullRequest, unreadable } from "./upstream-repull-github.js";
import {
  HELD_CLAIM_MAX_AGE_MINUTES,
  RELEASED_VERSION_SQL,
  recordRepullMerged,
  releaseMergeClaim,
} from "./upstream-repull-verified.js";
import {
  type RepullRefusal,
  commitTransition,
  isRefusal,
  prepareTransition,
} from "./upstream-repull.js";

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

/**
 * GitHub's answers to a merge that say it refused the merge itself, so nothing merged: 405 (not
 * mergeable), 409 (the head is not the `sha` sent) and 422 (the request was not valid). Every other
 * answer that is not a 2xx saying `merged: true` is unknown, a 401, a 403 and a 429 among them: they
 * speak of the credential or the rate, not of the merge, and the claim is kept for GitHub's word.
 */
export const MERGE_REFUSED_STATUSES: ReadonlySet<number> = new Set([405, 409, 422]);

/** The audit action written before each merge the Worker sends, and the one its answer goes in. */
export const WORKER_MERGE_ACTION = "repull_auto_merge";
export const WORKER_MERGE_ANSWER_ACTION = "repull_auto_merge_answer";

// ----------------------------------------------------------------------------
// SQL. Exported so a test runs the statement the merge runs, never a copy.
// ----------------------------------------------------------------------------

/**
 * The Worker's merge audit rows of one record, `param` a parameter bound to the record's id AS TEXT
 * (`String(id)`), as `resource_id` is written: a number bound as such could arrive as REAL, whose
 * text is `5.0`, so no statement here casts a bound number to compare it with `resource_id`.
 */
const MERGES_OF = (param: string) => `FROM audit_log
     WHERE action = '${WORKER_MERGE_ACTION}' AND resource_type = 'upstream_repull'
       AND resource_id = ${param}`;

/**
 * The record of one merge the Worker is about to send: `?1` the system user, `?2` the re-pull's id
 * (an integer, for the record), `?3` the details, `?4` the revision the claim left, `?5` the
 * claimed head, `?6` the claim's Worker-stamped time, `?7` 1 when the claim must still be younger
 * than {@link HELD_CLAIM_MAX_AGE_MINUTES} minutes (a merge sent again under a claim made earlier),
 * `?8` {@link WORKER_MERGES_MAX}, `?9` the re-pull's id as text (`String(id)`), for the audit
 * rows' `resource_id`. It applies only while the record is automatic, at `gates_clear`, at that
 * revision, holding exactly that claim and no merge, and while fewer than the bound were sent for
 * it, so the count and the send are decided in one statement, and a merge is never sent under a
 * claim the administrator's `resume` may be expiring (it expires one at 30 minutes).
 */
export const WORKER_MERGE_SENT_SQL = `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
  SELECT ?1, '${WORKER_MERGE_ACTION}', 'upstream_repull', ?9, ?3
   WHERE EXISTS (SELECT 1 FROM upstream_repulls
                  WHERE id = ?2 AND revision = ?4 AND origin = 'automatic' AND status = 'gates_clear'
                    AND merge_claim_sha = ?5 AND merge_claimed_at = ?6 AND merge_sha IS NULL
                    AND (?7 = 0 OR merge_claimed_at > datetime('now', '-${HELD_CLAIM_MAX_AGE_MINUTES} minutes')))
     AND (SELECT COUNT(*) ${MERGES_OF("?9")}) < ?8`;

/**
 * The merges the Worker sent for one record (`?1`, its id as text, `String(id)`), as one row: how
 * many (`sent`), the claim the latest was sent under (`last_claimed_at`, its Worker-stamped time)
 * and what GitHub answered it (`last_outcome`, `merged`, `refused` or `unknown`, or NULL when no
 * answer was recorded, which is read as unknown). The answer is matched to the latest merge by its
 * attempt number, so an earlier merge's answer is never read as the latest one's.
 */
export const WORKER_MERGES_SQL = `SELECT
  (SELECT COUNT(*) ${MERGES_OF("?1")}) AS sent,
  (SELECT json_extract(details, '$.claimed_at') ${MERGES_OF("?1")} ORDER BY id DESC LIMIT 1) AS last_claimed_at,
  (SELECT json_extract(a.details, '$.outcome') FROM audit_log a
     WHERE a.action = '${WORKER_MERGE_ANSWER_ACTION}' AND a.resource_type = 'upstream_repull'
       AND a.resource_id = ?1
       AND json_extract(a.details, '$.attempt') = (SELECT COUNT(*) ${MERGES_OF("?1")})
     ORDER BY a.id DESC LIMIT 1) AS last_outcome`;

export interface WorkerMerges {
  sent: number;
  last_claimed_at: string | null;
  last_outcome: "merged" | "refused" | "unknown" | null;
}

/**
 * Who made the claim a record holds (`?1` the re-pull's id as text, `String(id)`): the user of the
 * latest claim edge in its audit rows (the gates-clear self-edge), which the claim's own batch
 * writes. The system user is the Worker; any other is an administrator's
 * `nemar admin repull merge`.
 */
export const CLAIM_OWNER_SQL = `SELECT user_id FROM audit_log
  WHERE action = 'repull_transition' AND resource_type = 'upstream_repull'
    AND resource_id = ?1
    AND json_extract(details, '$.from') = 'gates_clear' AND json_extract(details, '$.to') = 'gates_clear'
  ORDER BY id DESC LIMIT 1`;

/**
 * Whether a claim (`?1` the re-pull) is younger than {@link HELD_CLAIM_MAX_AGE_MINUTES} minutes by
 * its Worker-stamped time, so a merge may still be sent under it: 1 or 0, on D1's own clock.
 */
export const CLAIM_YOUNG_SQL = `SELECT CASE WHEN merge_claimed_at > datetime('now', '-${HELD_CLAIM_MAX_AGE_MINUTES} minutes')
  THEN 1 ELSE 0 END AS young FROM upstream_repulls WHERE id = ?1`;

/** The merges the Worker sent for `id`; a count that cannot be read throws (unknown is not zero). */
export async function workerMerges(db: D1Database, id: number): Promise<WorkerMerges> {
  const m = await db.prepare(WORKER_MERGES_SQL).bind(String(id)).first<WorkerMerges>();
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
   * `unknown`: a merge was sent now and GitHub's answer does not say what became of it. `released`:
   * a claim the Worker held was released, GitHub having said its merge did not happen. `skipped`:
   * not the Worker's row to merge, and nothing was read or written for it.
   */
  kind: "merged" | "held" | "refused" | "unknown" | "released" | "skipped";
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
  if (MERGE_REFUSED_STATUSES.has(res.status)) return { outcome: "refused", status: res.status };
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
      String(row.id),
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

// ----------------------------------------------------------------------------
// A claim the Worker holds
// ----------------------------------------------------------------------------

/** Release the record's claim through its own writer, as the system user. */
function releaseClaim(
  env: Bindings,
  row: RepullRow,
  outcome: "not_sent" | "refused" | "expired",
): Promise<{ row: RepullRow } | RepullRefusal> {
  return releaseMergeClaim(env, { id: SYSTEM_USER_ID }, row.id, {
    pr: "n0",
    sha: row.merge_claim_sha as string,
    outcome,
  });
}

/**
 * Send the merge again under the claim the record holds, when it may be: both switches on, fewer
 * than {@link WORKER_MERGES_MAX} merges sent, the claim younger than
 * {@link HELD_CLAIM_MAX_AGE_MINUTES} minutes, the record's trailers carried, and the machine-clean
 * facts, read now, clean. Null when it may not, with nothing sent.
 */
async function sendAgainUnderClaim(
  env: Bindings,
  row: RepullRow,
  merges: WorkerMerges,
): Promise<WorkerMergeOutcome | null> {
  if (!autoRepullMergeEnabled(env) || merges.sent >= WORKER_MERGES_MAX) return null;
  const young = await env.DB.prepare(CLAIM_YOUNG_SQL).bind(row.id).first<{ young: number }>();
  if (young?.young !== 1 || trailerValuesProblem(row) !== null) return null;
  const verdict = machineClean(await gatherMachineCleanFacts(env, row, "merge"));
  if (!verdict.clean) return null;
  let token: string;
  try {
    token = await getDatasetsToken(env);
  } catch {
    return null;
  }
  return sendUnderClaim(env, row, token, { young: true, attempt: merges.sent + 1 });
}

/**
 * Resolve the claim to merge `row` holds from GitHub's own word: see the module comment. Called
 * for an automatic record at `gates_clear` holding a claim; any other row is `skipped`. GitHub is
 * read, and a merge it made recorded, whatever the switches say; only a merge sent needs them.
 */
export async function reconcileWorkerClaim(
  env: Bindings,
  row: RepullRow,
): Promise<WorkerMergeOutcome> {
  const db = env.DB;
  const sha = row.merge_claim_sha;
  if (
    !isExactProduction(env) ||
    row.origin !== "automatic" ||
    row.status !== "gates_clear" ||
    sha === null ||
    row.merge_claimed_at === null ||
    row.merge_sha !== null
  ) {
    return { kind: "skipped", row, hold: null, sent: false };
  }

  // GitHub first: a merge that happened is recorded, whoever held the claim.
  const read = await readRecordedPullRequest(env, row, "n0");
  if (!read.ok) return held(row, "claim-held");
  const pr = read.facts;
  if (pr.merged) {
    // At another head someone else merged it after a push: an administrator's `resume` records it.
    if (pr.headSha !== sha) return held(row, "claim-held");
    const done = await recordRepullMerged(env, { id: SYSTEM_USER_ID }, row.id, { pr: "n0" });
    if (isRefusal(done)) return held(done.row ?? row, "claim-held", done.code);
    return { kind: "merged", row: done.row, hold: null, sent: false };
  }

  // Not merged. An administrator's claim is theirs to resolve: the Worker neither sends under it
  // nor releases it.
  const owner = await db
    .prepare(CLAIM_OWNER_SQL)
    .bind(String(row.id))
    .first<{ user_id: number | null }>();
  if (owner?.user_id !== SYSTEM_USER_ID) return held(row, "claim-held");

  const merges = await workerMerges(db, row.id);
  // Claims are one at a time, so a merge sent under this claim is the latest the record has.
  const answer =
    merges.sent > 0 && merges.last_claimed_at === row.merge_claimed_at
      ? (merges.last_outcome ?? "unknown")
      : "not-sent";

  if (pr.state !== "open") {
    // Closed, so nothing can merge now: the claim is freed, by the age its answer allows.
    const freed = await releaseClaim(
      env,
      row,
      answer === "refused" ? "refused" : answer === "not-sent" ? "not_sent" : "expired",
    );
    if (isRefusal(freed)) return held(row, "claim-held");
    return { kind: "released", row: freed.row, hold: "pr-closed", sent: false };
  }
  if (answer === "refused") {
    // GitHub refused it, and says it did not merge: the unit of the cap is freed once the claim is
    // five minutes old, and an administrator looks.
    const freed = await releaseClaim(env, row, "refused");
    if (isRefusal(freed)) return held(row, "merge-refused");
    return { kind: "released", row: freed.row, hold: "merge-refused", sent: false };
  }

  // A merge whose answer was lost or did not say what became of it, or none sent: again under the
  // same claim, while it may be.
  const again = await sendAgainUnderClaim(env, row, merges);
  if (again !== null) return again;
  if (answer === "not-sent") {
    // Nothing went out under it: it is freed, and the record is taken on again from its facts.
    const freed = await releaseClaim(env, row, "not_sent");
    if (!isRefusal(freed)) return { kind: "released", row: freed.row, hold: null, sent: false };
  }
  // A merge that may have happened keeps its claim: GitHub's word, or an administrator's `resume`
  // at 30 minutes, ends it.
  return held(row, "claim-held");
}

// ----------------------------------------------------------------------------
// After the merge: the finish run
// ----------------------------------------------------------------------------

/** The `finish` dispatches one record may have, at most. */
export const FINISH_DISPATCHES_MAX = 3;

/**
 * A record's finish dispatches, as one row: `?1` its dataset, `?2` its id. `live` counts the
 * dataset's live dispatches (a run is out for it); `finishes` the record's `finish` dispatches that
 * spend an attempt, every one but a send GitHub turned away for the Worker's credential, permission
 * or rate (`dispatch-deferred`), since nothing about the record was tried then.
 */
export const FINISH_DISPATCHES_SQL = `SELECT
  (SELECT COUNT(*) FROM upstream_repull_dispatches WHERE dataset_id = ?1 AND nonce IS NOT NULL) AS live,
  (SELECT COUNT(*) FROM upstream_repull_dispatches WHERE repull_id = ?2 AND kind = 'finish'
    AND NOT (status = 'dispatch_failed' AND code = 'dispatch-deferred')) AS finishes`;

/** What the finish of one merged record came to. */
export type FinishOutcome =
  /** GitHub took the dispatch. */
  | { kind: "dispatched" }
  /** Its answer was lost: the dispatch stays live, and its run may still report. */
  | { kind: "unconfirmed" }
  /** Merged, and the version is not minted yet: the finish waits for its DOI. */
  | { kind: "waiting" }
  /** A run is out for the dataset (its finish, or another): nothing is claimed. */
  | { kind: "live" }
  /** The record had its finish dispatched as often as the automatic path dispatches one. */
  | { kind: "exhausted" }
  /** GitHub refused the send (a 4xx): the claim is ended `dispatch_failed` with this code. */
  | { kind: "refused"; code: "dispatch-refused" | "dispatch-deferred" }
  /** Nothing could be sent, for a reason about the Worker: a fixed word. */
  | {
      kind: "failed";
      error: "cli-unreleased" | "no-github-token" | "dispatch-unconfigured" | "dispatch-failed";
    }
  /** Not a record the Worker finishes, or one that moved meanwhile: nothing was written. */
  | { kind: "skipped" };

/**
 * Dispatch the finish run of an automatic record that merged (see the module comment). Exact
 * production only; the switches are not read. `cliVersion` is the CLI the run installs, the
 * dispatching Worker's own, and only a release is sent.
 */
export async function finishAfterMerge(
  env: Bindings,
  row: RepullRow,
  opts: { cliVersion: string; timeoutMs?: number },
): Promise<FinishOutcome> {
  if (
    !isExactProduction(env) ||
    row.origin !== "automatic" ||
    (row.status !== "merged" && row.status !== "released")
  ) {
    return { kind: "skipped" };
  }
  const db = env.DB;
  const d = await db
    .prepare(FINISH_DISPATCHES_SQL)
    .bind(row.dataset_id, row.id)
    .first<{ live: number; finishes: number }>();
  if (typeof d?.live !== "number" || typeof d.finishes !== "number") {
    throw new Error("the record's finish dispatches could not be counted");
  }
  if (d.live > 0) return { kind: "live" };
  if (d.finishes >= FINISH_DISPATCHES_MAX) return { kind: "exhausted" };
  if (row.status === "merged") {
    // The finish waits for the tag and the version row anyway; it is dispatched once the DOI the
    // merge minted is recorded, so its run does not spend its wait on a mint still in flight.
    const minted = await db
      .prepare(RELEASED_VERSION_SQL)
      .bind(row.dataset_id, row.to_version, row.to_version)
      .first<{ minted: number }>();
    if (!minted) return { kind: "waiting" };
  }
  // A run installs the Worker's own CLI, so a development build dispatches nothing.
  if (!NEMAR_VERSION_RE.test(opts.cliVersion)) return { kind: "failed", error: "cli-unreleased" };
  // The token is had before the claim, so a claim is never made that could not then be sent.
  let pat: string;
  try {
    pat = await getDatasetsToken(env);
  } catch {
    return { kind: "failed", error: "no-github-token" };
  }
  const claim = await claimFinishDispatch(env, row);
  if ("refused" in claim) {
    if (claim.refused === "live") return { kind: "live" };
    if (claim.refused === "unconfigured") {
      return { kind: "failed", error: "dispatch-unconfigured" };
    }
    // The record moved (or is not what was read) between the read and the claim.
    return { kind: "skipped" };
  }
  let payload: ReturnType<typeof buildUpstreamRepullPayload>;
  try {
    payload = buildUpstreamRepullPayload({
      mode: "finish",
      datasetId: row.dataset_id,
      upstreamDs: row.upstream_ds,
      fromTag: normalizeUpstreamTag(row.from_tag),
      toTag: normalizeUpstreamTag(row.to_tag),
      dispatchId: claim.id,
      repullId: row.id,
      token: claim.token,
      cliVersion: opts.cliVersion,
    });
  } catch {
    // Nothing was sent: the claim must not hold the dataset's live slot until the watchdog.
    await markDispatchSendFailed(db, claim.id, "dispatch-failed");
    return { kind: "failed", error: "dispatch-failed" };
  }
  const sent = await triggerUpstreamRepullRun(payload, pat, {
    timeoutMs: opts.timeoutMs ?? UPSTREAM_REPULL_DISPATCH_TIMEOUT_MS,
  });
  if (sent === "sent") return { kind: "dispatched" };
  if (sent === "unknown") return { kind: "unconfirmed" };
  const code = REFUSED_FOR_THE_DISPATCH.has(sent.refused)
    ? "dispatch-refused"
    : "dispatch-deferred";
  await markDispatchSendFailed(db, claim.id, code);
  return { kind: "refused", code };
}

// ----------------------------------------------------------------------------
// An administrator's merge over a failed BIDS validation
// ----------------------------------------------------------------------------

/** A merge over a failed BIDS validation asked for on the automatic path's record. */
const OVERRIDE_AUTOMATIC: RepullRefusal = {
  status: 409,
  code: "bids-override-automatic",
  message:
    "A merge over a failed BIDS validation is an administrator's, for a re-pull an administrator opened; an automatic re-pull's pull request is not merged over one.",
};

/**
 * The facts an administrator's merge over a failed BIDS validation rests on (ADR 0111, the Phase
 * 7g amendment), read at the claimed head `sha` of pull request `pr`: null when they hold, else the
 * refusal, and nothing is written either way. The claim to merge calls this (the transition route
 * hands it to the claim as `verifyBidsOverride`), after its own checks of the record and before
 * its read of the live head; the screen passing for that administrator, the fences and the cap
 * are the claim's own, unchanged.
 *  - The record is an administrator's: the automatic path never merges over a failed check, and
 *    an automatic record's pull request is merged over one by no one. Asked before GitHub is read.
 *  - The pull request is from and into the dataset's own repository (`pull-request-mismatch`
 *    otherwise): a fork's branch of the same name is not the re-pull's.
 *  - Then the rule `bidsOverrideFault` (`shared/repull-bids-override.ts`), the one `resume`'s
 *    gates and the merge gate ask too: GitHub reports the pull request `unstable`, which is a check
 *    that is not required failing (`blocked` means a rule requires the check, and merging would be
 *    a bypass, which a re-pull never uses; any other state is refused as the ordinary gate refuses
 *    it), and BIDS validation, the App's own run at that head, completed with `failure` (not
 *    pending, not unread), and `version-check` completed with `success`.
 */
export async function bidsOverrideRefusal(
  env: Bindings,
  row: RepullRow,
  pr: RepullPullRequest,
  sha: string,
): Promise<RepullRefusal | null> {
  if (row.origin !== "administrator") return { ...OVERRIDE_AUTOMATIC, row };
  const number = row[PULL_REQUEST_COLUMNS[pr].number];
  if (number === null) {
    return {
      status: 409,
      code: "bids-override-not-unstable",
      message: "The record names no pull request to merge.",
      row,
    };
  }
  const [fact, checks] = await Promise.all([
    readPullRequestFact(env, row.dataset_id, number),
    readCheckFacts(env, row.dataset_id, sha),
  ]);
  if (
    fact === "unreadable" ||
    checks.bids.status === "unreadable" ||
    checks.versionCheck.status === "unreadable"
  ) {
    return { ...unreadable(`pull request #${number}`, "its state or its checks"), row };
  }
  // From and into the dataset's own repository: a fork's branch of the same name is not the
  // re-pull's, and a deleted fork names no repository.
  if (
    !isOwnDatasetRepo(fact.headRepo, row.dataset_id) ||
    !isOwnDatasetRepo(fact.baseRepo, row.dataset_id)
  ) {
    return {
      status: 409,
      code: "pull-request-mismatch",
      message: `Pull request #${number} is not from and into ${ORG_NAME}/${row.dataset_id} itself: a fork's pull request is never merged as a re-pull's. Nothing was claimed.`,
      row,
    };
  }
  const fault = bidsOverrideFault({
    origin: row.origin,
    mergeableState: fact.mergeableState,
    bids: checks.bids,
    versionCheck: checks.versionCheck,
  });
  switch (fault) {
    case null:
      return null;
    case "automatic":
      return { ...OVERRIDE_AUTOMATIC, row };
    case "unreadable":
      return { ...unreadable(`pull request #${number}`, "its state or its checks"), row };
    case "blocked":
      return {
        status: 409,
        code: "bids-override-blocked",
        message:
          "GitHub reports the pull request blocked: this dataset's rules require BIDS validation, and merging would be a bypass, which a re-pull never uses. Nothing was claimed.",
        row,
      };
    case "not-unstable":
      return {
        status: 409,
        code: "bids-override-not-unstable",
        message: `GitHub reports the pull request ${fact.mergeableState ?? "with no state yet"}, not unstable: a merge over a failed BIDS validation is made only while that check is the one that fails. Nothing was claimed.`,
        row,
      };
    case "bids":
      return {
        status: 409,
        code: "bids-override-bids",
        message: `BIDS validation of ${sha.slice(0, 12)} is ${checks.bids.status === "completed" ? `completed with ${checks.bids.conclusion ?? "no conclusion"}` : checks.bids.status}, not failed: the override is for a validation that ran and failed. Nothing was claimed.`,
        row,
      };
    case "version-check":
      return {
        status: 409,
        code: "bids-override-version-check",
        message: `version-check of ${sha.slice(0, 12)} has not passed: the override is for BIDS validation alone. Nothing was claimed.`,
        row,
      };
  }
}
