/**
 * Settle the release head an automatic run reports (ADR 0111, decisions 2 and 7; the Phase 7d
 * amendment).
 *
 * Enrichment commits back to every push to `release/*`, so the head GitHub reports for a re-pull's
 * pull request can move minutes after the run pushed it, by commits nobody reviewed. The Worker
 * never accepts a moved head on its own: machine clean needs the recorded head, and a head it has
 * not seen recorded holds the pull request. So before an automatic run reports its pull request
 * open, it watches the branch with git (`ls-remote`, no REST quota) until it has not moved for
 * `quietMs`, by what successful reads saw, or `maxWaitMs` has passed, and never past the end of
 * the App token's usable hour (`deadlineMs`). Each move is judged by the one head rule execution and
 * resume use (`acceptsHead`: the synthesized commit, or an enrichment-shaped descendant of it) and
 * recorded as the `pr_open -> pr_open` self-edge resume writes; a move enrichment does not make is
 * `head-foreign`, recorded on the row as the automatic path's error (`[auto:head-foreign]`), and the
 * row is left at `pr_open`. A read that cannot be made is counted and tried again; unknown is never
 * a move, and never settled: the branch is settled only when a read succeeded in the last quiet
 * period before the settle ended, and otherwise the outcome is `unreadable`, recorded on the row
 * (`[auto:head-unreadable]`, with the last read's cause in fixed words) and reported as
 * `head-unreadable`. A settle the token's hour cut short before the branch was seen quiet is
 * `unreadable` too (cause `token-hour`), never a token error. The pull request stays open and the
 * gates read its head; no automatic run takes a `pr_open` record up again, so an administrator's
 * `resume` is the only way to settle it again, and any later move holds the pull request for it.
 *
 * Settling writes nothing to GitHub; the scratch repository is the caller's.
 */

import { AUTOMATIC_ERROR_PREFIX, type RepullRow } from "../../../../shared/repull-state.js";
import { ApiError } from "../../api/errors.js";
import { repullErrorCode, transitionRepull } from "../../api/repull.js";
import { recordStepError } from "../steps.js";
import { type OriginScratch, originRefs } from "./origin.js";
import { acceptsHead, releaseRefOf } from "./pull-request.js";
import { ExecuteRefused } from "./verify-plan.js";

/** How long the branch must stay where it is before it counts as settled. */
export const SETTLE_QUIET_MS = 5 * 60_000;
/** How often the branch is read while it settles. */
export const SETTLE_POLL_MS = 15_000;
/** The default bound on the whole settle, in minutes (`--settle-minutes`). */
export const SETTLE_DEFAULT_MINUTES = 30;

export interface SettleOptions {
  /** The bound on the whole settle; 0 reads the branch once. */
  maxWaitMs: number;
  quietMs: number;
  pollMs: number;
}

export interface Settled {
  /**
   * `settled`: a read in the last quiet period found the head the row records (or recorded the one
   * enrichment moved it to), and the branch was quiet or the bound passed; `foreign`: a head
   * enrichment did not make; `unreadable`: no read succeeded in the last quiet period.
   */
  outcome: "settled" | "foreign" | "unreadable";
  row: RepullRow;
  reads: number;
  moves: number;
  unreadable: number;
  /** Why the last read that failed failed, in fixed words; null when none did. */
  cause: string | null;
}

/** Watch the release branch of a `pr_open` row until it settles; see the module comment. */
export async function settleReleaseHead(args: {
  scratch: OriginScratch;
  row: RepullRow;
  opts: SettleOptions;
  out: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * When, on the same clock as `now`, the App token's usable hour ends: the settle reads nothing
   * after it, and a settle it cuts short before the branch was seen quiet is `unreadable`.
   */
  deadlineMs?: number;
}): Promise<Settled> {
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let row = args.row;
  if (row.status !== "pr_open" || !row.synth_sha || !row.branch || !row.head_sha) {
    throw new ExecuteRefused(
      "repull-not-ready",
      `Re-pull #${row.id} is ${row.status}, not an open pull request with a recorded head.`,
    );
  }
  const ref = releaseRefOf(row.to_version);
  const started = now();
  const leftMs =
    args.deadlineMs === undefined ? Number.POSITIVE_INFINITY : args.deadlineMs - started;
  const maxWaitMs = Math.min(args.opts.maxWaitMs, leftMs);
  const cut = leftMs < args.opts.maxWaitMs;
  const unread = async (cause: string, reads: number, moves: number, unreadable: number) => {
    const message = `${row.branch} could not be read while the run settled it (${cause}); the pull request stays open, and an administrator's resume settles it.`;
    await recordStepError(row, `${AUTOMATIC_ERROR_PREFIX}head-unreadable] ${message}`, args.out);
    return { outcome: "unreadable" as const, row, reads, moves, unreadable, cause };
  };
  // The token's hour is over: nothing is read with it.
  if (leftMs <= 0) return unread("token-hour", 0, 0, 0);
  /**
   * Since when successful reads have seen the branch where the row records it: the first read
   * that found it, then each move recorded. The branch is quiet only over what was read.
   */
  let quietFrom: number | null = null;
  /** When a read last found the recorded head (or recorded a move), or null before one did. */
  let lastGood: number | null = null;
  let cause: string | null = null;
  let reads = 0;
  let moves = 0;
  let unreadable = 0;
  let quiet = false;
  for (;;) {
    reads++;
    let head: string | null = null;
    try {
      head = (await originRefs(args.scratch, [ref])).get(ref) ?? null;
      if (head === null) cause = "branch-absent";
    } catch (err) {
      cause = causeOf(err);
    }
    if (head === null) {
      unreadable++;
    } else if (head === row.head_sha) {
      lastGood = now();
      quietFrom ??= lastGood;
    } else {
      const verdict = await acceptsHead({
        work: args.scratch.dir,
        from: row.synth_sha as string,
        head,
        ref,
        env: args.scratch.env,
      });
      if (verdict === "foreign") {
        const message = `${row.branch} moved by a commit enrichment does not make while the run settled it: the pull request is left open at the recorded head, and the record is to be abandoned.`;
        await recordStepError(row, `${AUTOMATIC_ERROR_PREFIX}head-foreign] ${message}`, args.out);
        return { outcome: "foreign", row, reads, moves, unreadable, cause };
      }
      if (verdict === "unreadable") {
        unreadable++;
        cause = "branch-unreadable";
      } else {
        row = await recordMove(row, head);
        moves++;
        lastGood = now();
        quietFrom = lastGood;
        args.out(`${row.branch} moved by enrichment; re-pull #${row.id} records the new head.`);
      }
    }
    const t = now();
    quiet = quietFrom !== null && lastGood !== null && lastGood - quietFrom >= args.opts.quietMs;
    if (quiet || t - started >= maxWaitMs) break;
    await sleep(Math.max(0, Math.min(args.opts.pollMs, maxWaitMs - (t - started))));
  }
  // Settled only on what was read: a read must have succeeded in the last quiet period.
  if (lastGood === null || lastGood < now() - args.opts.quietMs) {
    return unread(cause ?? "unknown", reads, moves, unreadable);
  }
  // The token's hour ended the settle before the branch was seen quiet: not settled.
  if (cut && !quiet) return unread("token-hour", reads, moves, unreadable);
  return { outcome: "settled", row, reads, moves, unreadable, cause };
}

/** A failed read's cause in fixed words: a refusal's code, or the error's class. */
function causeOf(err: unknown): string {
  if (err instanceof ExecuteRefused) return err.code;
  const name = err instanceof Error ? err.name : "";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "error";
}

/** The head moved by enrichment: the `pr_open` self-edge resume records for it. */
async function recordMove(row: RepullRow, head: string): Promise<RepullRow> {
  try {
    return await transitionRepull(row.id, {
      from: "pr_open",
      to: "pr_open",
      fields: { branch: row.branch, pr_number: row.pr_number, head_sha: head },
    });
  } catch (err) {
    const code = repullErrorCode(err);
    const refusal = new ExecuteRefused(
      code ?? (err instanceof ApiError ? "record-refused" : "github-failed"),
      `The moved head of ${row.branch} could not be recorded on re-pull #${row.id}.`,
    );
    refusal.resumable = true;
    throw refusal;
  }
}
