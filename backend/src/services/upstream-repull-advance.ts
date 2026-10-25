/**
 * The automatic re-pull's advance tick (epic #1046 phase 7, #1913; ADR 0111, decisions 6 and 7):
 * every 30 minutes, in production only, look at the automatic re-pulls that are open and say, for
 * each, why it waits where it is.
 *
 * WHAT IT DOES, for each row it examines:
 *  - a row at `pr_open`: read the machine-clean facts of its head at the gates
 *    (`gatherMachineCleanFacts`) and ask the rule (`machineClean`); the first rule that does not
 *    hold is recorded as the row's hold;
 *  - a row a live dispatch is working on (its run is still out, settling its head): nothing is read
 *    from GitHub, and the row is not held, because nothing holds it but its own run.
 *
 * HOLDS. A hold is an observation, never a transition: a fixed word (`REPULL_HOLD_REASONS`) and
 * since when, on the row (`hold_reason`, `hold_since`). Writing one does not move the row, does not
 * bump its `revision` and does not touch `updated_at`, so the record's own compare-and-set and the
 * times other slices read are left as they were. It is written only when the word changes, with
 * one audit row (`repull_hold`) per change, so a row that waits for the same reason tick after tick
 * keeps the time it began and writes nothing more; and only to the row as the tick read it (its
 * `revision`), so a row that moved while the tick looked at it is not overwritten with a reason
 * about what it was. An edge into another status clears the hold (`prepareTransition`); a self-edge
 * keeps it until the next tick reads the row again.
 *
 * WHICH ROWS. Only automatic rows (`origin = 'automatic'`) are read: an administrator's row is
 * never read, held or advanced here, because the Worker never takes an administrator's re-pull on
 * (decision 7). At most {@link ADVANCE_ROWS_PER_TICK} rows a tick, in rotation by id from a place
 * the tick's half hour decides ({@link advanceWindow}), so a row that waits on an administrator for
 * days never keeps a newer row from being read: most automatic pull requests will wait for one,
 * because most mirrors' screens ask for an acknowledgment (ADR 0111, Consequences).
 *
 * PRODUCTION ONLY. Outside `ENVIRONMENT` exactly `production` the tick returns null before it reads
 * or writes anything: the `nemarDatasets` organization is shared with dev. It is called only from
 * the 30-minute tick's production block, absent from `DEV_CRON_ALLOWLIST`. In production with
 * `AUTO_REPULL_ENABLED` not exactly `"1"`, GitHub is asked nothing, and every row it examines is
 * held `switch-off`. Each production tick stamps `upstream_repull_scheduler.last_advance_at`.
 *
 * NO MAIL. Nothing here imports a mail service (`repull-no-mail-scan.test.ts`).
 */

import { type MachineCleanVerdict, machineClean } from "../../../shared/repull-machine-clean.js";
import type { HoldReason, RepullRow, RepullStatus } from "../../../shared/repull-state.js";
import { AUDIT_IF_PREVIOUS_CHANGED_SQL, auditLogParams } from "../db/audit-log.js";
import { SYSTEM_USER_ID } from "../lib/constants.js";
import type { Bindings } from "../types/bindings.js";
import { errorClassName } from "./github/dispatch.js";
import { autoRepullEnabled, isExactProduction } from "./repull-switches.js";
import { gatherMachineCleanFacts } from "./upstream-repull-facts.js";
import { getRepull } from "./upstream-repull.js";

/** Rows one tick examines at most. */
export const ADVANCE_ROWS_PER_TICK = 5;

/** The tick's cadence, which turns its time into a place in the rotation. */
export const ADVANCE_TICK_MINUTES = 30;

/** The statuses the tick examines. */
export const ADVANCE_STATUSES = ["pr_open"] as const satisfies readonly RepullStatus[];

const quoted = (words: readonly string[]) => words.map((w) => `'${w}'`).join(", ");

// ----------------------------------------------------------------------------
// SQL. Exported so a test runs the statement the tick runs, never a copy.
// ----------------------------------------------------------------------------

/**
 * The automatic rows the tick may examine, by id. An administrator's row is never among them. One
 * open row per dataset (migration 0105) and only `on` datasets are automatic, so the list is never
 * longer than the fleet of mirrors.
 */
export const ADVANCE_ROWS_SQL = `SELECT id FROM upstream_repulls
  WHERE origin = 'automatic' AND status IN (${quoted(ADVANCE_STATUSES)})
  ORDER BY id`;

/** How many dispatches of a dataset are live (`?` the dataset): a run is out for it. */
export const ROW_DISPATCHES_SQL = `SELECT
  (SELECT COUNT(*) FROM upstream_repull_dispatches WHERE dataset_id = ?1 AND nonce IS NOT NULL) AS live`;

/**
 * Record why an automatic row waits: `?1` its id, `?2` the revision the tick read, `?3` the word it
 * read (NULL for none), `?4` the word now (NULL when nothing holds it). It applies only when the
 * word changes and only to the row as it was read, so `hold_since` is kept while the word is the
 * same, the audit row that follows it is written once per change, and a row that moved meanwhile
 * (any transition bumps its revision) is not written. It touches neither `revision` nor
 * `updated_at`: a hold is an observation, not a transition. Only an automatic row is ever held, as
 * migration 0111's CHECK also says.
 */
export const REPULL_HOLD_SQL = `UPDATE upstream_repulls
  SET hold_reason = ?4,
      hold_since = CASE WHEN ?4 IS NULL THEN NULL ELSE datetime('now') END
  WHERE id = ?1 AND revision = ?2 AND origin = 'automatic'
    AND hold_reason IS ?3 AND ?4 IS NOT ?3`;

/** The tick ran: the scheduler's row says when, for the observability slice. */
export const ADVANCE_STAMP_SQL =
  "UPDATE upstream_repull_scheduler SET last_advance_at = datetime('now') WHERE id = 1";

// ----------------------------------------------------------------------------
// The tick
// ----------------------------------------------------------------------------

/** What a tick failed at, as a fixed word; never a message. */
export type AdvanceFailure = "row-failed" | "tick-failed" | "stamp-failed";

export interface AdvanceTickResult {
  /** Rows the tick looked at. */
  examined: number;
  /** Of them, rows a live dispatch is working on, which were left alone. */
  waiting: number;
  /** Rows held this tick, by word, whether the word is new or not. */
  held: Record<string, number>;
  /** Hold words written or cleared this tick: one audit row each. */
  holdsChanged: number;
  /** What failed, in fixed words. */
  errors: AdvanceFailure[];
  /** The class of the last error ({@link errorClassName}), never its message. */
  errorClass: string | null;
}

export interface AdvanceOptions {
  /** The tick's time: its place in the rotation. Now by default; a test passes a real instant. */
  now?: Date;
}

interface Tick {
  env: Bindings;
  now: Date;
  r: AdvanceTickResult;
}

/**
 * The rows of `ids` (sorted) that a tick at `now` examines: all of them when they fit, and
 * otherwise {@link ADVANCE_ROWS_PER_TICK} of them, starting at a place that moves on by that many
 * each half hour and wraps, so every row is examined at least once in every
 * ceil(n / {@link ADVANCE_ROWS_PER_TICK}) ticks of a stable set, however long any of them waits.
 */
export function advanceWindow(ids: readonly number[], now: Date): number[] {
  const n = ids.length;
  if (n <= ADVANCE_ROWS_PER_TICK) return [...ids];
  const slot = Math.floor(now.getTime() / (ADVANCE_TICK_MINUTES * 60_000));
  const start = (((slot * ADVANCE_ROWS_PER_TICK) % n) + n) % n;
  return Array.from({ length: ADVANCE_ROWS_PER_TICK }, (_, k) => ids[(start + k) % n] as number);
}

/**
 * Record `word` as why `row` waits (null: nothing holds it), when it is not the word already
 * recorded, with its audit row in the same batch. A row that moved since it was read is not
 * written.
 */
async function observe(t: Tick, row: RepullRow, word: HoldReason | null): Promise<void> {
  if (word !== null) t.r.held[word] = (t.r.held[word] ?? 0) + 1;
  const db = t.env.DB;
  const [update] = await db.batch([
    db.prepare(REPULL_HOLD_SQL).bind(row.id, row.revision, row.hold_reason, word),
    db.prepare(AUDIT_IF_PREVIOUS_CHANGED_SQL).bind(
      ...auditLogParams({
        userId: SYSTEM_USER_ID,
        action: "repull_hold",
        resourceType: "upstream_repull",
        resourceId: String(row.id),
        details: JSON.stringify({
          dataset_id: row.dataset_id,
          status: row.status,
          from: row.hold_reason,
          to: word,
        }),
      }),
    ),
  ]);
  if ((update?.meta?.changes ?? 0) > 0) t.r.holdsChanged++;
}

/** Whether a run is out for the row's dataset (a dispatch holds its nonce). */
async function dispatchLive(db: D1Database, row: RepullRow): Promise<boolean> {
  const d = await db.prepare(ROW_DISPATCHES_SQL).bind(row.dataset_id).first<{ live: number }>();
  if (typeof d?.live !== "number") throw new Error("the row's dispatches could not be read");
  return d.live > 0;
}

/** A row at `pr_open`: its machine-clean verdict at the gates. */
async function advanceOpenPullRequest(t: Tick, row: RepullRow): Promise<void> {
  const { env } = t;
  // With the open switch off nothing is read from GitHub, and the row says why it waits.
  if (!autoRepullEnabled(env)) return observe(t, row, "switch-off");
  // A run still out for the dataset is settling the head it opened: nothing is read until it ends.
  if (await dispatchLive(env.DB, row)) {
    t.r.waiting++;
    return observe(t, row, null);
  }
  const verdict: MachineCleanVerdict = machineClean(
    await gatherMachineCleanFacts(env, row, "gates"),
  );
  return observe(t, row, verdict.clean ? null : verdict.hold);
}

async function advanceRow(t: Tick, id: number): Promise<void> {
  const row = await getRepull(t.env.DB, id);
  // Read again by id: a row that ended, moved on or is an administrator's since the list is left.
  if (!row || row.origin !== "automatic") return;
  if (!(ADVANCE_STATUSES as readonly string[]).includes(row.status)) return;
  t.r.examined++;
  await advanceOpenPullRequest(t, row);
}

/**
 * The advance tick. Null outside exact production, with nothing read, written or sent. In
 * production it examines at most {@link ADVANCE_ROWS_PER_TICK} automatic rows and stamps the
 * scheduler's row; a failure is a fixed word in the result, never a throw, so the 30-minute tick's
 * other jobs run on, and one row that fails does not stop the others.
 */
export async function runRepullAdvanceCron(
  env: Bindings,
  opts: AdvanceOptions = {},
): Promise<AdvanceTickResult | null> {
  if (!isExactProduction(env)) return null;
  const r: AdvanceTickResult = {
    examined: 0,
    waiting: 0,
    held: {},
    holdsChanged: 0,
    errors: [],
    errorClass: null,
  };
  const t: Tick = { env, now: opts.now ?? new Date(), r };
  try {
    const { results } = await env.DB.prepare(ADVANCE_ROWS_SQL).all<{ id: number }>();
    for (const id of advanceWindow(
      results.map((x) => x.id),
      t.now,
    )) {
      try {
        await advanceRow(t, id);
      } catch (err) {
        r.errors.push("row-failed");
        r.errorClass = errorClassName(err);
      }
    }
  } catch (err) {
    r.errors.push("tick-failed");
    r.errorClass = errorClassName(err);
  }
  try {
    const res = await env.DB.prepare(ADVANCE_STAMP_SQL).run();
    if (res.meta?.changes !== 1) throw new Error("the scheduler's row is missing");
  } catch (err) {
    r.errors.push("stamp-failed");
    r.errorClass = errorClassName(err);
  }
  return r;
}

/**
 * The tick's one log line, or null when it changed nothing and nothing failed, so a tick that only
 * found the same rows waiting for the same reasons says nothing. Error level when anything failed.
 * Counts and fixed words only: no dataset id, no message.
 */
export function repullAdvanceLogLine(
  r: AdvanceTickResult,
): { level: "info" | "error"; line: string } | null {
  const failed = r.errors.length > 0;
  if (!failed && r.holdsChanged === 0) return null;
  const held =
    Object.entries(r.held)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([word, n]) => `${word}:${n}`)
      .join(",") || "none";
  const fields = [
    `examined=${r.examined}`,
    `waiting=${r.waiting}`,
    `holds_changed=${r.holdsChanged}`,
    `held=${held}`,
  ];
  if (failed) fields.push(`errors=${r.errors.join(",")}`);
  if (r.errorClass !== null) fields.push(`error_class=${r.errorClass}`);
  return { level: failed ? "error" : "info", line: `[repull-advance] ${fields.join(" ")}` };
}
