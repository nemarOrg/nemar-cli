/**
 * The identifier screen of a re-pull pull request (epic #1046 phase 6, #1912; ADR 0111,
 * decisions 7 and 9).
 *
 * A re-pull makes no publication request, so the identifier screen gates its merge instead: it is
 * dispatched with `ref=<head sha>` and a callback bound to the re-pull row, and a merge needs it
 * `clear` or carrying an administrator's recorded acknowledgment (ADR 0086). The workflow and the
 * report are the publication screen's (`run-identifier-screen`, `shared/identifier-screen-report.ts`);
 * the row is `upstream_repull_screens` (migration 0106), one per screened commit of one of the
 * re-pull's two pull requests, and the token is a kind of its own.
 *
 * This file is the screen alone: it does not load the re-pull row, apply its fences or move it.
 * `upstream-repull.ts` does that and calls in here with the row it read, so the two never import
 * each other.
 *
 * NO MAIL. The publication screen mails its result; this one never does, because the dev database
 * holds real addresses and the administrator reads a re-pull's state from the API. That is why
 * this file imports the publication screen's readers from `identifier-screen-stored.ts` and never
 * `identifier-screen.ts`, which mails; `repull-no-mail-scan.test.ts` pins it.
 *
 * Unknown is never clear (ADR 0053): no screen, a screen that errored, one that never reported and
 * one whose report names another commit all read as "run it again", and nothing here turns any of
 * them into a pass.
 */

import {
  type ScreenGate,
  type ScreenReport,
  type ScreenState,
  describeScreen,
  isScreenState,
  parseScreenReport,
  screenGate,
  stateOf,
} from "../../../shared/identifier-screen-report.js";
import {
  PULL_REQUEST_COLUMNS,
  type RepullPullRequest,
  type RepullRow,
  TERMINAL_STATUSES,
} from "../../../shared/repull-state.js";
import { AUDIT_IF_PREVIOUS_CHANGED_SQL, auditLogParams } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { getDatasetsAuth } from "./github-auth.js";
import { signIdentifierRepullCallbackToken } from "./github/callback-tokens.js";
import { triggerIdentifierScreenRun } from "./github/dispatch.js";
import {
  SCREEN_REPORT_DEADLINE_MINUTES,
  isScreenExempt,
  readStoredReport,
  workerErrorReport,
} from "./identifier-screen-stored.js";

/** Where the workflow posts a re-pull screen's report, under API_BASE_URL. */
export const REPULL_SCREEN_CALLBACK_PATH = "/webhooks/identifier-screen-repull-result";

/** How long the dispatch waits for GitHub, so an administrator's request is answered. */
export const REPULL_SCREEN_DISPATCH_TIMEOUT_MS = 10_000;

/** The screens of one re-pull a read returns, newest first. */
export const REPULL_SCREENS_LIMIT = 20;

const TERMINAL_LIST = TERMINAL_STATUSES.map((s) => `'${s}'`).join(", ");

/**
 * The state a screen is in when it is read. A `pending` screen past the report deadline reads
 * `unreported` here, at read time, so no cron has to write it; the row keeps its nonce, so the run
 * it was dispatched for can still answer until a new dispatch replaces it.
 */
const EFFECTIVE_STATE = `CASE WHEN status = 'pending'
    AND dispatched_at < datetime('now', '-${SCREEN_REPORT_DEADLINE_MINUTES} minutes')
  THEN 'unreported' ELSE status END`;

/** What a screen may be dispatched again from: no verdict, so the gate says run it again. */
const RERUN_SQL = `(status IN ('error', 'unreported') OR (status = 'pending'
    AND dispatched_at < datetime('now', '-${SCREEN_REPORT_DEADLINE_MINUTES} minutes')))`;

const SCREEN_COLUMNS = `id, repull_id, pr, sha, status, ${EFFECTIVE_STATE} AS state, report,
  dispatched_at, reported_at, ack_by, ack_reason, ack_at,
  CASE WHEN nonce IS NULL THEN 0 ELSE 1 END AS waiting`;

/** One screen of one commit of one pull request of a re-pull. */
export const REPULL_SCREEN_SQL = `SELECT ${SCREEN_COLUMNS} FROM upstream_repull_screens
  WHERE repull_id = ? AND pr = ? AND sha = ?`;

/** The screens of a re-pull, newest first. */
export const REPULL_SCREENS_SQL = `SELECT ${SCREEN_COLUMNS} FROM upstream_repull_screens
  WHERE repull_id = ? ORDER BY id DESC LIMIT ${REPULL_SCREENS_LIMIT}`;

/**
 * The screen of a dataset that waits for its report, for the callback, which knows only the
 * dataset. At most one: one open re-pull per dataset (migration 0105) and one waiting screen per
 * re-pull (migration 0106). A re-pull that has ended accepts no report.
 */
export const REPULL_SCREEN_WAITING_SQL = `SELECT s.id AS id, s.repull_id AS repull_id, s.pr AS pr,
    s.sha AS sha, s.nonce AS nonce
  FROM upstream_repull_screens s JOIN upstream_repulls r ON r.id = s.repull_id
  WHERE r.dataset_id = ? AND s.nonce IS NOT NULL AND r.status NOT IN (${TERMINAL_LIST})
  ORDER BY s.id DESC LIMIT 1`;

/**
 * Store a verified callback's result: one conditional UPDATE on the nonce that verified, which it
 * clears, so of a callback and its replay exactly one stores. `unreported` is in the list for a
 * row a later writer may mark so; today no writer does.
 */
export const REPULL_SCREEN_STORE_SQL = `UPDATE upstream_repull_screens
  SET status = ?, report = ?, reported_at = datetime('now'), nonce = NULL
  WHERE id = ? AND nonce = ? AND status IN ('pending', 'unreported')`;

/** A screen that could not be started, or whose run failed before it could report. */
const SCREEN_FAILED_SQL = `UPDATE upstream_repull_screens
  SET status = 'error', report = ?, reported_at = datetime('now'), nonce = NULL
  WHERE id = ? AND status = 'pending' AND nonce = ?`;

/** Record an acknowledgment on exactly the verdict the administrator was shown. */
const SCREEN_ACK_SQL = `UPDATE upstream_repull_screens
  SET ack_by = ?, ack_reason = ?, ack_at = datetime('now')
  WHERE id = ? AND status = ?`;

// ----------------------------------------------------------------------------
// Rows and views
// ----------------------------------------------------------------------------

export interface RepullScreenRow {
  id: number;
  repull_id: number;
  pr: RepullPullRequest;
  sha: string;
  /** The stored state. */
  status: string;
  /** The state as read: a pending screen past the deadline is `unreported`. */
  state: string;
  report: string | null;
  dispatched_at: string;
  reported_at: string | null;
  ack_by: number | null;
  ack_reason: string | null;
  ack_at: string | null;
  waiting: number;
}

/** A screen as the API shows it. Worker-fixed words and the parsed report's counts only. */
export interface RepullScreenView {
  pr: RepullPullRequest;
  sha: string;
  state: ScreenState | null;
  gate: ScreenGate;
  headline: string;
  lines: string[];
  dispatched_at: string;
  reported_at: string | null;
  /** True while a run is out and its report would still be accepted. */
  waiting: boolean;
  acknowledged_by: number | null;
  acknowledged_at: string | null;
}

/** The stored state, read without trusting it: anything that is not a state is null. */
function stateOfRow(row: Pick<RepullScreenRow, "state">): ScreenState | null {
  return isScreenState(row.state) ? row.state : null;
}

export function repullScreenView(row: RepullScreenRow): RepullScreenView {
  const state = stateOfRow(row);
  const d = describeScreen(state, state === null ? null : readStoredReport(row.report));
  return {
    pr: row.pr,
    sha: row.sha,
    state,
    gate: screenGate(state),
    headline: d.headline,
    lines: d.lines,
    dispatched_at: row.dispatched_at,
    reported_at: row.reported_at,
    waiting: row.waiting === 1,
    acknowledged_by: row.ack_by,
    acknowledged_at: row.ack_at,
  };
}

export async function readRepullScreen(
  db: D1Database,
  repullId: number,
  pr: RepullPullRequest,
  sha: string,
): Promise<RepullScreenRow | null> {
  return db.prepare(REPULL_SCREEN_SQL).bind(repullId, pr, sha).first<RepullScreenRow>();
}

export async function listRepullScreenRows(
  db: D1Database,
  repullId: number,
): Promise<RepullScreenRow[]> {
  const { results } = await db.prepare(REPULL_SCREENS_SQL).bind(repullId).all<RepullScreenRow>();
  return results;
}

// ----------------------------------------------------------------------------
// Dispatch
// ----------------------------------------------------------------------------

export type RepullScreenStart =
  /** An `xx` dataset is not screened (ADR 0086); nothing is recorded. */
  | { kind: "exempt" }
  | { kind: "dispatched"; screen: RepullScreenView }
  /** Recorded as an `error` screen, which the gate reads as "run it again". */
  | {
      kind: "failed";
      error: "dispatch-unconfigured" | "dispatch-failed";
      screen: RepullScreenView | null;
    }
  /** A run is out for this commit, or it has a verdict: nothing is dispatched. */
  | { kind: "exists"; screen: RepullScreenView }
  /** The re-pull row moved (status or head) between the read and the claim; nothing written. */
  | { kind: "moved" };

const looksUnique = (err: unknown) => /UNIQUE constraint failed/i.test(String(err));

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Dispatch the screen of `sha`, the recorded head of pull request `pr` of `row`. The caller has
 * checked the row's status, its head and the fences; the claim checks the status and the head
 * again in the same statement that writes, so a row that moved in between is not screened.
 *
 * A commit is screened once: a second dispatch is refused while a run is out (`wait`) and once it
 * has a verdict, and is allowed only when the gate says to run it again (an error, or no report by
 * the deadline). Dispatching for a new head frees the nonce of any earlier screen of the re-pull,
 * so its run can no longer answer: one run is out per re-pull.
 *
 * Deliberately not switchable off, as the publication screen: a Worker without the callback
 * secret, the API base or a GitHub credential records `dispatch-unconfigured`, which the gate
 * refuses, so a merge never goes through because the screen could not run.
 */
export async function startRepullScreen(
  env: Bindings,
  row: Pick<RepullRow, "id" | "dataset_id">,
  pr: RepullPullRequest,
  sha: string,
  actorId: number,
): Promise<RepullScreenStart> {
  if (isScreenExempt(row.dataset_id)) return { kind: "exempt" };
  const db = env.DB;
  const existing = await readRepullScreen(db, row.id, pr, sha);
  if (existing && screenGate(stateOfRow(existing)) !== "rerun") {
    return { kind: "exists", screen: repullScreenView(existing) };
  }

  const secret = env.PRESCREEN_CALLBACK_SECRET;
  const apiBase = env.API_BASE_URL;
  let pat: string | null = null;
  let failure: "dispatch-unconfigured" | "dispatch-failed" | null =
    !secret || !apiBase ? "dispatch-unconfigured" : null;
  if (failure === null) {
    let auth: ReturnType<typeof getDatasetsAuth> | null = null;
    try {
      auth = getDatasetsAuth(env);
    } catch (err) {
      console.error(
        `[repull-screen] no GitHub credential for ${row.dataset_id}: ${errorText(err)}`,
      );
      failure = "dispatch-unconfigured";
    }
    if (auth) {
      try {
        pat = auth.kind === "app" ? await auth.getToken() : auth.token;
      } catch (err) {
        console.error(
          `[repull-screen] could not mint a GitHub token for ${row.dataset_id}: ${errorText(err)}`,
        );
        failure = "dispatch-failed";
      }
    }
  }

  // The claim, bound to the re-pull row: its status is the one in which this pull request's head
  // is screened, and its head is still `sha`.
  const cols = PULL_REQUEST_COLUMNS[pr];
  const rowGuard = `EXISTS (SELECT 1 FROM upstream_repulls WHERE id = ? AND status = ? AND ${cols.head} = ?)`;
  const rowBinds = [row.id, cols.open, sha];
  const claimable = existing
    ? `EXISTS (SELECT 1 FROM upstream_repull_screens WHERE id = ? AND ${RERUN_SQL})`
    : "NOT EXISTS (SELECT 1 FROM upstream_repull_screens WHERE repull_id = ? AND pr = ? AND sha = ?)";
  const claimableBinds = existing ? [existing.id] : [row.id, pr, sha];
  const nonce = crypto.randomUUID();
  const free = db
    .prepare(
      `UPDATE upstream_repull_screens SET nonce = NULL
        WHERE repull_id = ? AND nonce IS NOT NULL AND NOT (pr = ? AND sha = ?)
          AND ${rowGuard} AND ${claimable}`,
    )
    .bind(row.id, pr, sha, ...rowBinds, ...claimableBinds);
  const claim = existing
    ? db
        .prepare(
          `UPDATE upstream_repull_screens
              SET status = 'pending', nonce = ?, report = NULL, reported_at = NULL,
                  ack_by = NULL, ack_reason = NULL, ack_at = NULL, dispatched_at = datetime('now')
            WHERE id = ? AND ${RERUN_SQL} AND ${rowGuard}`,
        )
        .bind(nonce, existing.id, ...rowBinds)
    : db
        .prepare(
          `INSERT INTO upstream_repull_screens (repull_id, pr, sha, status, nonce)
           SELECT ?, ?, ?, 'pending', ? WHERE ${rowGuard}`,
        )
        .bind(row.id, pr, sha, nonce, ...rowBinds);
  const audit = db.prepare(AUDIT_IF_PREVIOUS_CHANGED_SQL).bind(
    ...auditLogParams({
      userId: actorId,
      action: "repull_screen_dispatched",
      resourceType: "upstream_repull",
      resourceId: String(row.id),
      details: JSON.stringify({ dataset_id: row.dataset_id, pr, sha, rerun: existing !== null }),
    }),
  );

  let claimed = false;
  try {
    const results = await db.batch([free, claim, audit]);
    claimed = (results[1]?.meta?.changes ?? 0) === 1;
  } catch (err) {
    // A concurrent dispatch inserted the same commit's screen first; read what it left.
    if (!looksUnique(err)) throw err;
  }
  const mine = await readRepullScreen(db, row.id, pr, sha);
  if (!claimed) {
    return mine && screenGate(stateOfRow(mine)) !== "rerun"
      ? { kind: "exists", screen: repullScreenView(mine) }
      : { kind: "moved" };
  }
  if (!mine) throw new Error(`the screen of re-pull ${row.id} ${pr} ${sha} was not readable`);

  const fail = async (error: "dispatch-unconfigured" | "dispatch-failed") => {
    await db
      .prepare(SCREEN_FAILED_SQL)
      .bind(JSON.stringify(workerErrorReport(error)), mine.id, nonce)
      .run();
    console.warn(`[repull-screen] ${row.dataset_id} re-pull ${row.id} ${pr}: ${error}`);
    const after = await readRepullScreen(db, row.id, pr, sha);
    return { kind: "failed" as const, error, screen: after ? repullScreenView(after) : null };
  };
  if (failure !== null || !pat || !secret || !apiBase) {
    return fail(failure ?? "dispatch-unconfigured");
  }
  try {
    const token = await signIdentifierRepullCallbackToken(
      { datasetId: row.dataset_id, repullId: row.id, pr, sha, nonce },
      secret,
    );
    await triggerIdentifierScreenRun(
      row.dataset_id,
      sha,
      0,
      token,
      `${apiBase}${REPULL_SCREEN_CALLBACK_PATH}`,
      pat,
      REPULL_SCREEN_DISPATCH_TIMEOUT_MS,
    );
  } catch (err) {
    // A timeout may hide an accepted dispatch; its run's callback then finds no nonce and is
    // refused, and the gate reads this screen as one to run again. Never as clear.
    console.error(
      `[repull-screen] dispatch failed for ${row.dataset_id} re-pull ${row.id}: ${errorText(err)}`,
    );
    return fail("dispatch-failed");
  }
  console.log(`[repull-screen] ${row.dataset_id} re-pull ${row.id} ${pr}: dispatched`);
  return { kind: "dispatched", screen: repullScreenView(mine) };
}

// ----------------------------------------------------------------------------
// The result
// ----------------------------------------------------------------------------

export type RepullScreenStore =
  | { stored: true; state: ScreenState; error: string | null }
  | { stored: false };

/**
 * Store a verified callback's report on the screen it was issued for. `body` is the untrusted
 * `report` field and reaches nothing except through `parseScreenReport`: a body outside the
 * contract, a scan of another dataset, and a scan of another commit than the one dispatched are
 * each stored as the Worker's own `workflow-failed` error, and only a fixed word is logged.
 * Mails nobody, ever.
 */
export async function storeRepullScreenResult(
  db: D1Database,
  args: { datasetId: string; screenId: number; sha: string; nonce: string; body: unknown },
): Promise<RepullScreenStore> {
  let report: ScreenReport;
  let error: string | null = null;
  try {
    report = parseScreenReport(args.body);
    if (report.scan && report.scan.id !== args.datasetId) {
      error = "another-dataset";
      report = workerErrorReport("workflow-failed");
    } else if (report.head !== null && report.head !== args.sha) {
      // The workflow was dispatched with `ref` = this commit; a report about another commit is
      // not a verdict about this one, whatever it found.
      error = "head-mismatch";
      report = workerErrorReport("workflow-failed");
    }
  } catch (err) {
    // The parser's message is a fixed word that never quotes the input.
    error = err instanceof Error && err.name === "ReportError" ? err.message : "unparseable";
    report = workerErrorReport("workflow-failed");
  }
  if (error) {
    console.warn(
      `[repull-screen] report for screen ${args.screenId} stored as workflow-failed (${error})`,
    );
  }
  const state = stateOf(report);
  const res = await db
    .prepare(REPULL_SCREEN_STORE_SQL)
    .bind(state, JSON.stringify(report), args.screenId, args.nonce)
    .run();
  if ((res.meta.changes ?? 0) !== 1) return { stored: false };
  return { stored: true, state, error };
}

// ----------------------------------------------------------------------------
// The gate
// ----------------------------------------------------------------------------

/** A condition the write re-asserts in its own statement, so the verdict it read still stands. */
export interface SqlGuard {
  sql: string;
  binds: unknown[];
}

export type RepullScreenGate =
  | { ok: true; exempt: true }
  | { ok: true; exempt: false; guard: SqlGuard }
  | {
      ok: false;
      /** `screenGate`'s word, or `unverified` when the report does not name the commit. */
      gate: ScreenGate | "unverified";
      headline: string;
      message: string;
    };

/**
 * Whether the screen bound to the re-pull lets `sha` of pull request `pr` go on (to its gates and
 * to its merge), for the administrator `actorId`. No network, no writes.
 *
 * `clear` passes. `acknowledge` passes only with a reason recorded on this very screen by the same
 * administrator, the publication path's rule (ADR 0086): a reason another administrator recorded
 * does not stand in for this one's. `blocks` never passes and cannot be acknowledged. `wait` and
 * `rerun` (no screen, an error, no report by the deadline) never pass. A verdict whose report does
 * not name `sha` is `unverified`. An `xx` dataset is exempt.
 *
 * A passing answer carries a guard for the write that relies on it: the screen still holds the
 * verdict (and the acknowledgment) the gate read when the write applies.
 */
export async function repullScreenGate(
  db: D1Database,
  args: {
    datasetId: string;
    repullId: number;
    pr: RepullPullRequest;
    sha: string;
    actorId: number;
  },
): Promise<RepullScreenGate> {
  if (isScreenExempt(args.datasetId)) return { ok: true, exempt: true };
  const short = args.sha.slice(0, 12);
  const row = await readRepullScreen(db, args.repullId, args.pr, args.sha);
  if (!row) {
    return {
      ok: false,
      gate: "rerun",
      headline: "Identifier screen: not run",
      message: `No identifier screen of commit ${short} is recorded for this re-pull; dispatch one and wait for its report.`,
    };
  }
  const view = repullScreenView(row);
  const refuse = (gate: ScreenGate | "unverified", message: string): RepullScreenGate => ({
    ok: false,
    gate,
    headline: view.headline,
    message: `${view.headline}. ${message}`,
  });
  switch (view.gate) {
    case "blocks":
      return refuse(
        "blocks",
        "A direct identifier cannot be acknowledged; this commit is not merged.",
      );
    case "wait":
      return refuse("wait", "The screen is still running; wait for its report.");
    case "rerun":
      return refuse(
        "rerun",
        "The screen produced no verdict for this commit; dispatch it again and wait for its report.",
      );
    case "acknowledge":
      if (row.ack_at === null || row.ack_by !== args.actorId) {
        return refuse(
          "acknowledge",
          "An administrator must look at what the screen reported and record a reason for this commit before it goes on.",
        );
      }
      break;
    case "clear":
      break;
  }
  if (readStoredReport(row.report)?.head !== args.sha) {
    return refuse("unverified", `The stored report does not name commit ${short}.`);
  }
  const guard: SqlGuard =
    view.gate === "acknowledge"
      ? {
          sql: "EXISTS (SELECT 1 FROM upstream_repull_screens WHERE id = ? AND status = ? AND ack_at IS NOT NULL AND ack_by = ?)",
          binds: [row.id, row.status, args.actorId],
        }
      : {
          sql: "EXISTS (SELECT 1 FROM upstream_repull_screens WHERE id = ? AND status = ?)",
          binds: [row.id, row.status],
        };
  return { ok: true, exempt: false, guard };
}

/**
 * Record an administrator's acknowledgment of the verdict `row` holds, and audit it, in one batch.
 * Conditional on the stored state the administrator was shown, so it cannot attach to a verdict
 * that has since changed. The caller has checked the gate is `acknowledge`; the database refuses
 * an acknowledgment on any other state (migration 0106). False when the state moved.
 */
export async function acknowledgeRepullScreenRow(
  db: D1Database,
  args: { row: RepullScreenRow; datasetId: string; adminUserId: number; reason: string },
): Promise<boolean> {
  const { row } = args;
  const results = await db.batch([
    db.prepare(SCREEN_ACK_SQL).bind(args.adminUserId, args.reason, row.id, row.status),
    db.prepare(AUDIT_IF_PREVIOUS_CHANGED_SQL).bind(
      ...auditLogParams({
        userId: args.adminUserId,
        action: "repull_screen_acknowledged",
        resourceType: "upstream_repull",
        resourceId: String(row.repull_id),
        details: JSON.stringify({
          dataset_id: args.datasetId,
          pr: row.pr,
          sha: row.sha,
          screen_state: row.status,
          reason: args.reason,
        }),
      }),
    ),
  ]);
  return (results[0]?.meta?.changes ?? 0) === 1;
}
