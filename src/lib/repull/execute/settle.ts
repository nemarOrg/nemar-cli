/**
 * Settle the release head an automatic run reports (ADR 0111, decisions 2 and 7; the Phase 7d
 * amendment).
 *
 * Enrichment commits back to every push to `release/*`, so the head GitHub reports for a re-pull's
 * pull request can move minutes after the run pushed it, by commits nobody reviewed. The Worker
 * never accepts a moved head on its own: machine clean needs the recorded head, and a head it has
 * not seen recorded holds the pull request. So before an automatic run reports its pull request
 * open, it watches the branch with git (`ls-remote`, no REST quota) until it has not moved for
 * `quietMs` or `maxWaitMs` has passed. Each move is judged by the one head rule execution and
 * resume use (`acceptsHead`: the synthesized commit, or an enrichment-shaped descendant of it) and
 * recorded as the `pr_open -> pr_open` self-edge resume writes; a move enrichment does not make is
 * `head-foreign`, recorded on the row as the automatic path's error (`[auto:head-foreign]`), and the
 * row is left at `pr_open`. A read that cannot be made is counted and tried again; unknown is never
 * a move. Any later move holds the pull request for an administrator's `resume`.
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
  /** `settled`: the head the row records is the branch's, or the bound passed; `foreign`: refused. */
  outcome: "settled" | "foreign";
  row: RepullRow;
  reads: number;
  moves: number;
  unreadable: number;
}

/** Watch the release branch of a `pr_open` row until it settles; see the module comment. */
export async function settleReleaseHead(args: {
  scratch: OriginScratch;
  row: RepullRow;
  opts: SettleOptions;
  out: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
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
  let lastMove = started;
  let reads = 0;
  let moves = 0;
  let unreadable = 0;
  for (;;) {
    reads++;
    let head: string | null = null;
    try {
      head = (await originRefs(args.scratch, [ref])).get(ref) ?? null;
    } catch {
      head = null;
    }
    if (head === null) {
      unreadable++;
    } else if (head !== row.head_sha) {
      const verdict = await acceptsHead({
        work: args.scratch.dir,
        from: row.synth_sha as string,
        head,
        ref,
        env: args.scratch.env,
      });
      if (verdict === "foreign") {
        const message = `${row.branch} moved by a commit enrichment does not make while the run settled it: the pull request is left open at the recorded head, and its record has to be abandoned (no command to abandon a record is built yet).`;
        await recordStepError(row, `${AUTOMATIC_ERROR_PREFIX}head-foreign] ${message}`, args.out);
        return { outcome: "foreign", row, reads, moves, unreadable };
      }
      if (verdict === "unreadable") {
        unreadable++;
      } else {
        row = await recordMove(row, head);
        moves++;
        lastMove = now();
        args.out(`${row.branch} moved by enrichment; re-pull #${row.id} records the new head.`);
      }
    }
    const t = now();
    if (t - lastMove >= args.opts.quietMs || t - started >= args.opts.maxWaitMs) break;
    await sleep(Math.max(0, Math.min(args.opts.pollMs, args.opts.maxWaitMs - (t - started))));
  }
  return { outcome: "settled", row, reads, moves, unreadable };
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
