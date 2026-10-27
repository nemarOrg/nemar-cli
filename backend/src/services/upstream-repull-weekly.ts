/**
 * The automatic re-pull's week, for the weekly import report (epic #1046 phase 7, #1913; ADR 0111,
 * the Phase 7h slice): what the dispatch record, the re-pull record and the audit log say about the
 * seven days the report covers, laid beside the switches and the scheduler's last tick, and the
 * reasons a person should look.
 *
 * READ-ONLY, AND NOTHING IS SENT. This module reads D1 and decides; the weekly report files an
 * issue on a repository that is public-facing, and nothing here mails anyone
 * (`repull-no-mail-scan.test.ts`). It reads no switch to decide whether to read: the report arrives
 * every week whether or not the path is on (ADR 0054), and a week of zeros from a path that is off
 * is a true zero.
 *
 * COUNTS AND FIXED WORDS, NEVER A DATASET. The statements select no dataset id, and a word is
 * printed only when it is on the closed list it belongs to and does not name anonymity: a code,
 * a hold word or an outcome that is anything else is counted under `other`. The database checks
 * only the SHAPE of a word, and a dataset id has that shape, so the list is what keeps one from
 * reaching a public report. The rule is `publicWord` in `shared/repull-observability.ts`, applied
 * here where the counts are made and again by the report's renderer where they are written.
 *
 * UNKNOWN IS NEVER ZERO (ADR 0054). Every count here is a number from a read that succeeded. A read
 * that fails throws, the caller leaves the report's re-pull facts null and lists a failed part, and
 * the section says unknown. The five counts are read in one batch, so they describe one instant
 * and cannot disagree about it; `sent` is the sum of the states, so the table balances by
 * construction.
 *
 * ATTENTION FOLLOWS ADR 0053: silence is evidence of a problem only when there was work to do.
 * {@link repullAttention} raises a reason for exactly these, and for nothing else: a switch is on
 * and the daily scheduler has not stamped its row for {@link SCHEDULER_STALE_HOURS}; a switch is on
 * and the scheduler's last tick concluded `waiting-for-manual-run` (gate G4: the two first re-pulls
 * are not both run by hand, so nothing dispatches until a person acts); a dispatch
 * nobody answered (`unreported`) or that GitHub did not accept (`dispatch_failed`); a claim to
 * merge held for over {@link HELD_CLAIM_ATTENTION_HOURS} hour; a re-pull that ended `failed`; a
 * re-pull that used all its resumes or finish runs; a cap set to something unreadable. A switch
 * that is off, a hold waiting on a gate (the screen, the review, BIDS validation, `not-clean`) and
 * a run's refusal are the expected state of a path that is working, and an alarm that never
 * clears gets muted. Every other hold (a refused merge, claim or gate, the merge bound) is counted
 * in the table of holds and does not ask.
 *
 * WHEN A DISPATCH IS COUNTED. In the week it was SENT, in the state it has when the report is made.
 * One still running then is counted as running, and is not counted again in the next week's report
 * if it later goes unreported; the row it was for is then stalled, and resuming it, and the bound on
 * its resumes, are what the report sees next. Merges are counted in the week the record of the
 * merge was written, failed re-pulls in the week they ended. Holds and held claims are the state
 * when the report is made.
 */

import type {
  RepullSchedulerRow,
  RepullSwitchesReport,
  RepullWeek,
  RepullWeekFacts,
  WordCounts,
} from "../../../shared/repull-observability.js";
import { publicWord } from "../../../shared/repull-observability.js";
import {
  DISPATCH_KINDS,
  DISPATCH_STATUSES,
  type DispatchKind,
  type DispatchStatus,
  TERMINAL_STATUSES,
} from "../../../shared/repull-state.js";
import { SYSTEM_USER_ID } from "../lib/constants.js";
import type { Bindings } from "../types/bindings.js";
import { repullSwitchesReport } from "./repull-switches.js";
import { readSchedulerRow } from "./upstream-repull-scheduler.js";

/**
 * How old the daily scheduler's last stamp may be while a switch is on. The tick runs at 03:00 UTC
 * and stamps its row whether or not it dispatches (the row says `switch-off` when the switch is
 * off), so a day plus two hours is a tick that did not run.
 */
export const SCHEDULER_STALE_HOURS = 26;

/** How long a claim to merge may stay unresolved before the week asks for attention. */
export const HELD_CLAIM_ATTENTION_HOURS = 1;

const HOUR_MS = 3_600_000;

const quoted = (words: readonly string[]) => words.map((w) => `'${w}'`).join(", ");
const TERMINAL_LIST = quoted(TERMINAL_STATUSES);

/**
 * The five reads of the week, exported so a test runs the statement the service runs, never a
 * copy. `?1` and `?2` are the window (SQLite UTC, `?1` inclusive and `?2` exclusive), bound from
 * the report's own `now` and not from SQL's, as the rest of the report is (ADR 0054); `claims` binds
 * the cutoff instead. None selects a dataset id.
 *
 *  - `dispatches`: the window's dispatches by kind, state and code. A code is NOT NULL for the
 *    three states that carry one, so the words add up to the states.
 *  - `holds`: the open automatic re-pulls by hold word now (NULL is open and not held).
 *  - `claims`: open re-pulls of any origin holding a claim to merge, for either pull request, that
 *    has no merge recorded and was made before the cutoff (`?1`), so it is older than the bound.
 *  - `merges`: the merges recorded in the window, by who held the claim to merge. A merge is the
 *    audit row of an edge INTO `merged` or `patch_merged`, from another status: the release's step
 *    errors write an edge from `merged` to `merged` (and the same for `patch_merged`) whenever a
 *    tag or a version row is not there yet, and that is not a merge, so a row whose edge ends where
 *    it began is not counted. Whether any NEMAR tool held a claim is in that row
 *    (`merged_outside_tool`), and who held it is the user of the latest claim edge before it, the
 *    claim of the pull request that merged (the `gates_clear` self-edge for N.0.0's merge, the
 *    `patch_gates_clear` one for N.0.1's, never the other's): the system user is the Worker,
 *    anyone else is an administrator's tool, and none is a claim the audit log does not hold.
 *  - `failed`: the re-pulls that ended `failed` in the window.
 */
export const REPULL_WEEK_SQL = {
  dispatches: `SELECT kind, status, code, COUNT(*) AS n
      FROM upstream_repull_dispatches
     WHERE dispatched_at >= ?1 AND dispatched_at < ?2
     GROUP BY kind, status, code`,
  holds: `SELECT hold_reason, COUNT(*) AS n
      FROM upstream_repulls
     WHERE origin = 'automatic' AND status NOT IN (${TERMINAL_LIST})
     GROUP BY hold_reason`,
  claims: `SELECT COUNT(*) AS n
      FROM upstream_repulls
     WHERE status NOT IN (${TERMINAL_LIST})
       AND ((merge_claimed_at IS NOT NULL AND merge_sha IS NULL AND merge_claimed_at < ?1)
         OR (patch_merge_claimed_at IS NOT NULL AND patch_merge_sha IS NULL
             AND patch_merge_claimed_at < ?1))`,
  merges: `SELECT
      COALESCE(SUM(CASE WHEN m.outside = 1 THEN 1 ELSE 0 END), 0) AS outside_tool,
      COALESCE(SUM(CASE WHEN m.outside = 0 AND m.claimant = ${SYSTEM_USER_ID} THEN 1 ELSE 0 END), 0) AS worker,
      COALESCE(SUM(CASE WHEN m.outside = 0 AND m.claimant IS NOT NULL
                         AND m.claimant <> ${SYSTEM_USER_ID} THEN 1 ELSE 0 END), 0) AS administrator,
      COALESCE(SUM(CASE WHEN m.outside = 0 AND m.claimant IS NULL THEN 1 ELSE 0 END), 0) AS unattributed
      FROM (
        SELECT
          CASE WHEN json_extract(a.details, '$.merged_outside_tool') = 1 THEN 1 ELSE 0 END AS outside,
          (SELECT c.user_id FROM audit_log c
            WHERE c.action = 'repull_transition' AND c.resource_type = 'upstream_repull'
              AND c.resource_id = a.resource_id
              AND json_extract(c.details, '$.to') = CASE
                    WHEN json_extract(a.details, '$.to') = 'patch_merged' THEN 'patch_gates_clear'
                    ELSE 'gates_clear' END
              AND json_extract(c.details, '$.from') = json_extract(c.details, '$.to')
              AND c.id < a.id
            ORDER BY c.id DESC LIMIT 1) AS claimant
          FROM audit_log a
         WHERE a.action = 'repull_transition' AND a.resource_type = 'upstream_repull'
           AND json_extract(a.details, '$.to') IN ('merged', 'patch_merged')
           AND json_extract(a.details, '$.from') IS NOT json_extract(a.details, '$.to')
           AND a.timestamp >= ?1 AND a.timestamp < ?2
      ) m`,
  failed: `SELECT COUNT(*) AS n
      FROM upstream_repulls
     WHERE status = 'failed' AND terminal_at >= ?1 AND terminal_at < ?2`,
} as const;

/** The window of the report: `from` inclusive, `to` exclusive, and `to` is the report's own `now`. */
export interface RepullWindow {
  from: Date;
  to: Date;
}

/** A JS instant in the shape SQLite's `datetime()` writes: `YYYY-MM-DD HH:MM:SS`, UTC. */
function toSqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** A stored time as milliseconds, or null when it is not one. */
function sqliteMs(stamp: string | null): number | null {
  if (stamp === null) return null;
  const ms = Date.parse(`${stamp.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** A count from a statement that cannot return anything else; anything else is a fault, not a zero. */
function asCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("a re-pull count read from the database was not a count");
  }
  return value;
}

function rowsOf<T>(result: D1Result | undefined): T[] {
  if (!result?.results) throw new Error("D1 returned null results");
  return result.results as T[];
}

/**
 * Send the week's statements as one batch and return their answers, or throw. A batch that comes
 * back with a different number of answers than statements, or with an answer that did not
 * succeed, is a read that did not happen, and counts taken from the answers that did arrive would
 * be a partial week: unknown, never zero (ADR 0054).
 */
async function checkedBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<D1Result[]> {
  const answers = await db.batch(statements);
  if (answers?.length !== statements.length) {
    throw new Error(
      `the re-pull week's batch answered ${answers?.length ?? 0} of ${statements.length} statements`,
    );
  }
  for (const [i, answer] of answers.entries()) {
    if (answer?.success !== true) {
      throw new Error(`statement ${i + 1} of the re-pull week's batch did not succeed`);
    }
  }
  return answers;
}

const isKind = (v: unknown): v is DispatchKind =>
  typeof v === "string" && (DISPATCH_KINDS as readonly string[]).includes(v);
const isStatus = (v: unknown): v is DispatchStatus =>
  typeof v === "string" && (DISPATCH_STATUSES as readonly string[]).includes(v);

function addWord(into: WordCounts, word: string, n: number): void {
  into[word] = (into[word] ?? 0) + n;
}

interface DispatchGroup {
  kind: unknown;
  status: unknown;
  code: string | null;
  n: unknown;
}
interface HoldGroup {
  hold_reason: string | null;
  n: unknown;
}
interface MergeSums {
  worker: unknown;
  administrator: unknown;
  outside_tool: unknown;
  unattributed: unknown;
}

/**
 * Count the week. Throws when any read fails, when the batch of reads comes back with a different
 * number of answers than statements or with one that did not succeed or has no rows array, or
 * when a read returns something that is not a count: the caller leaves the report's re-pull facts
 * null and lists a failed part, so a failed read is unknown and never a zero.
 */
export async function gatherRepullWeek(
  env: Pick<Bindings, "DB">,
  window: RepullWindow,
): Promise<RepullWeek> {
  const db = env.DB;
  const from = toSqliteUtc(window.from);
  const to = toSqliteUtc(window.to);
  const claimCutoff = toSqliteUtc(
    new Date(window.to.getTime() - HELD_CLAIM_ATTENTION_HOURS * HOUR_MS),
  );
  const [dispatches, holds, claims, merges, failed] = await checkedBatch(db, [
    db.prepare(REPULL_WEEK_SQL.dispatches).bind(from, to),
    db.prepare(REPULL_WEEK_SQL.holds),
    db.prepare(REPULL_WEEK_SQL.claims).bind(claimCutoff),
    db.prepare(REPULL_WEEK_SQL.merges).bind(from, to),
    db.prepare(REPULL_WEEK_SQL.failed).bind(from, to),
  ]);

  const by_kind = Object.fromEntries(DISPATCH_KINDS.map((k) => [k, 0])) as Record<
    DispatchKind,
    number
  >;
  const by_status = Object.fromEntries(DISPATCH_STATUSES.map((s) => [s, 0])) as Record<
    DispatchStatus,
    number
  >;
  const by_word = {
    refused: {},
    failed: {},
    dispatch_failed: {},
  } as RepullWeek["dispatches"]["by_word"];
  let sent = 0;
  for (const g of rowsOf<DispatchGroup>(dispatches)) {
    const n = asCount(g.n);
    if (!isKind(g.kind) || !isStatus(g.status)) {
      throw new Error("a dispatch row had a kind or a state this report does not know");
    }
    by_kind[g.kind] += n;
    by_status[g.status] += n;
    sent += n;
    if (g.status === "refused" || g.status === "failed" || g.status === "dispatch_failed") {
      addWord(by_word[g.status], publicWord(g.code, "code"), n);
    }
  }

  let total = 0;
  let held = 0;
  const holdWords: WordCounts = {};
  for (const g of rowsOf<HoldGroup>(holds)) {
    const n = asCount(g.n);
    total += n;
    if (g.hold_reason !== null) {
      held += n;
      addWord(holdWords, publicWord(g.hold_reason, "hold"), n);
    }
  }

  const claimRow = rowsOf<{ n: unknown }>(claims)[0];
  const mergeRow = rowsOf<MergeSums>(merges)[0];
  const failedRow = rowsOf<{ n: unknown }>(failed)[0];
  if (!claimRow || !mergeRow || !failedRow) {
    throw new Error("a re-pull aggregate returned no row");
  }

  return {
    window: { from, to },
    dispatches: { sent, by_kind, by_status, by_word },
    open_automatic: { total, held, holds: holdWords },
    held_claims: asCount(claimRow.n),
    merged: {
      worker: asCount(mergeRow.worker),
      administrator: asCount(mergeRow.administrator),
      outside_tool: asCount(mergeRow.outside_tool),
      unattributed: asCount(mergeRow.unattributed),
    },
    ended_failed: asCount(failedRow.n),
  };
}

type SchedulerSilence = "fresh" | "never" | "stale" | "unreadable";

/** How long the scheduler has been silent as of `nowMs`: never, past the bound, unreadable, or fresh. */
function schedulerSilence(
  scheduler: RepullSchedulerRow | null,
  nowMs: number | null,
): SchedulerSilence {
  if (scheduler === null || nowMs === null) return "unreadable";
  if (scheduler.last_tick_at === null) return "never";
  const tickMs = sqliteMs(scheduler.last_tick_at);
  if (tickMs === null) return "unreadable";
  return nowMs - tickMs > SCHEDULER_STALE_HOURS * HOUR_MS ? "stale" : "fresh";
}

/**
 * Why this week of re-pull activity needs a person, one fixed phrase each, in the order the
 * headline lists them; empty when nothing does. See the module header for the rule: it raises a
 * reason for exactly these and nothing else, so a quiet week with the switches off is quiet.
 * `week.window.to` is the instant the report is made, and the scheduler's age is measured against it.
 */
export function repullAttention(
  week: RepullWeek,
  switches: RepullSwitchesReport,
  scheduler: RepullSchedulerRow | null,
): string[] {
  const problems: string[] = [];

  if (switches.auto_repull_enabled || switches.auto_repull_merge_enabled) {
    const silence = schedulerSilence(scheduler, sqliteMs(week.window.to));
    if (silence === "never") {
      problems.push("the automatic re-pull is on, and its scheduler has never recorded a run");
    } else if (silence === "stale") {
      problems.push(
        `the automatic re-pull is on, and its scheduler has not run for over ${SCHEDULER_STALE_HOURS} hours`,
      );
    } else if (silence === "unreadable") {
      problems.push("the automatic re-pull is on, and its scheduler's last run could not be read");
    }
    // The tick ran and dispatched nothing because gate G4 is not met: the two first re-pulls are
    // not both run by hand to `complete`, and only a person can change that. With the switch on
    // this is a path that will not start by itself, so it asks; with the switch off it is quiet.
    if (scheduler?.last_outcome === "waiting-for-manual-run") {
      problems.push(
        "the automatic re-pull is on, and its scheduler is waiting for the two first re-pulls to be run by hand",
      );
    }
  }

  const { unreported, dispatch_failed } = week.dispatches.by_status;
  if (unreported > 0) {
    problems.push(`${unreported} re-pull dispatch(es) were not reported by their run in time`);
  }
  if (dispatch_failed > 0) {
    problems.push(`${dispatch_failed} re-pull dispatch(es) were not accepted by GitHub`);
  }
  if (week.held_claims > 0) {
    problems.push(
      `${week.held_claims} re-pull merge claim(s) have been held for over ${HELD_CLAIM_ATTENTION_HOURS} hour`,
    );
  }
  if (week.ended_failed > 0) {
    problems.push(`${week.ended_failed} re-pull(s) ended failed`);
  }
  const resumes = week.open_automatic.holds["resume-exhausted"] ?? 0;
  if (resumes > 0) {
    problems.push(`${resumes} re-pull(s) have used all their resumes (resume-exhausted)`);
  }
  const finishes = week.open_automatic.holds["finish-exhausted"] ?? 0;
  if (finishes > 0) {
    problems.push(
      `${finishes} merged re-pull(s) have used all their finish runs (finish-exhausted)`,
    );
  }
  if (switches.open_cap.source === "unreadable") {
    problems.push("the re-pull open cap is set to something unreadable, so it reads 0");
  }
  if (switches.merge_cap.source === "unreadable") {
    problems.push("the re-pull merge cap is set to something unreadable, so it reads 0");
  }
  return problems;
}

/**
 * The weekly report's re-pull facts: the week, the switches the Worker reads, the scheduler's row
 * and the reasons to look. Throws when a read fails (see {@link gatherRepullWeek}).
 */
export async function gatherRepullFacts(
  env: Bindings,
  window: RepullWindow,
): Promise<RepullWeekFacts> {
  const week = await gatherRepullWeek(env, window);
  const stored = await readSchedulerRow(env.DB);
  // The outcome is a word the report prints, so it is held to its closed list like every other.
  const scheduler =
    stored === null || stored.last_outcome === null
      ? stored
      : { ...stored, last_outcome: publicWord(stored.last_outcome, "outcome") };
  const switches = repullSwitchesReport(env);
  return { ...week, switches, scheduler, attention: repullAttention(week, switches, scheduler) };
}
