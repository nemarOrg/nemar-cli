/**
 * Weekly import summary (epic #1306 phase 4, #1312).
 *
 * Files one issue per week on `nemarDatasets/.github`, mentioning `@nemarAdmin`,
 * whether or not anything is wrong. The decisions and the body are pure and live in
 * `import-weekly-summary.ts`; this module is the I/O around them.
 *
 * ## Why unconditional
 *
 * An alarm fires only when a threshold trips, and the seven-week outage produced no
 * alarm because no threshold existed. A report that appears only on breakage cannot
 * distinguish a healthy week from a broken reporter -- both are silence. Arriving
 * every week is what makes "no news" mean something.
 *
 * ## Every failure is a reported unknown, never a zero
 *
 * Each fact is gathered in its own try, and a failure sets that fact to `null` and
 * appends to `errors` rather than aborting the report. This is the opposite trade
 * from phase 3's sweep, and deliberately: there, a failed read must not produce a
 * verdict, because the verdict CLOSES an issue. Here nothing is closed on the
 * strength of a number, so a partial report is worth more than none -- as long as
 * the gaps say so. `null` renders as `unknown` (see `count`), and a report with an
 * unknown in it is flagged as needing attention.
 *
 * ## No new cron trigger
 *
 * `scheduled()` compares `event.cron === AUTO_IMPORT_CRON` by exact string, so a
 * new trigger would risk that branch. This rides the existing daily tick behind
 * `shouldRunWeeklySummary(now)`, and every decision lives in a pure exported
 * function because no test in this repo invokes `scheduled()` -- logic inline in a
 * `.then()` is untestable by construction.
 */

import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { parseSqliteUtc } from "./auto-import.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsToken } from "./github-auth.js";
import {
  type GitHubIssue,
  addIssueComment,
  closeIssue,
  createIssue,
  listOpenIssuesByLabel,
} from "./github.js";
import { runImportCoverageSweep } from "./import-coverage-sweep.js";
import { dispatchPhrase, outstandingCount } from "./import-coverage.js";
import { IMPORT_FAILURE_CAUSE_LABELS, classifyImportFailure } from "./import-failure-cause.js";
import {
  IMPORT_FAILURE_ISSUES_REPO,
  IMPORT_WEEKLY_ISSUE_LABEL,
  importWeeklySummaryIssueTitle,
  parseWeeklySummaryIssueTitle,
} from "./import-issue-identity.js";
import {
  type ParkedDataset,
  type WeeklySummaryFacts,
  buildWeeklyRolloverComment,
  buildWeeklySummaryBody,
  daysSince,
  decideWeeklySummaryGate,
  isoWeekLabel,
  weeklySummaryLogLine,
} from "./import-weekly-summary.js";

/** The audit action this job writes, and reads to gate itself. */
export const WEEKLY_SUMMARY_AUDIT_ACTION = "import_weekly_summary";

/** The last posted summary, for the once-per-week gate. `ORDER BY id DESC` rather
 *  than by timestamp, matching `AUTO_IMPORT_GATE_QUERY`: `id` is insertion order and
 *  is immune to a clock skew that `timestamp` is not. */
export const WEEKLY_SUMMARY_GATE_QUERY = `SELECT timestamp FROM audit_log WHERE action = '${WEEKLY_SUMMARY_AUDIT_ACTION}' ORDER BY id DESC LIMIT 1`;

/**
 * OpenNeuro mirrors created inside the window.
 *
 * Predicate matches `IMPORTED_SOURCE_IDS_QUERY`'s, including the
 * `owner_user_id != -1` clause that excludes the folded legacy shadow rows --
 * un-imported browse pointers whose inclusion caused the 2026-06-20 stall.
 *
 * Plain `created_at`, deliberately NOT `COALESCE(publish_date, created_at)` as
 * `dataset-filters.ts` uses: `publish_date` is NULL for imported mirrors, so the
 * coalesce would be a no-op today and would silently start dating mirrors by
 * OpenNeuro's publish date the moment that column gets populated. This report is
 * about when NEMAR imported something.
 */
export const IMPORTED_THIS_WEEK_QUERY = `SELECT COUNT(*) AS n FROM datasets
   WHERE source = 'openneuro' AND source_id IS NOT NULL AND owner_user_id != -1
     AND created_at >= datetime('now', ?)`;

/** Same predicate, no window: the `on*` total. */
export const IMPORTED_TOTAL_QUERY = `SELECT COUNT(*) AS n FROM datasets
   WHERE source = 'openneuro' AND source_id IS NOT NULL AND owner_user_id != -1`;

/**
 * Open failures, with the `last_error` needed to classify each one.
 *
 * Unbounded on purpose. Every existing classifier call site is single-row keyed by
 * `dataset_id`, and the one fleet-wide read (`BACKLOG_JOBS_QUERY`) omits
 * `last_error` so it cannot classify. `IMPORT_RETRY_CANDIDATES_QUERY` has the
 * column but is `LIMIT`-ed and excludes blocklisted rows, which is the wrong
 * population for a report: a report that silently stops at N is a report that
 * under-counts.
 *
 * Blocklisted rows are excluded here because they get their own section -- counting
 * them as open failures would double-report them.
 */
export const OPEN_FAILURES_QUERY = `SELECT dataset_id, stage, last_error FROM import_jobs
   WHERE status IN ('failed', 'incomplete', 'quarantined') AND blocklisted = 0`;

/**
 * Blocklisted datasets and their parked anchor.
 *
 * `first_incomplete_at` is the only write-once anchor: it is set with
 * `COALESCE(first_incomplete_at, datetime('now'))` and cleared only on recovery, so
 * it survives the slow blocklist re-check. `updated_at` would be wrong -- the
 * re-check bumps it, so a row parked two months but probed yesterday looks one day
 * old -- and `next_retry_at` would be wrong because it is in the future.
 *
 * Unbounded, and unlike `BLOCKLIST_RECHECK_QUERY` it does NOT filter on
 * `next_retry_at`, which would exclude every row currently in backoff, i.e. most of
 * them.
 */
export const PARKED_QUERY = `SELECT dataset_id, blocklist_reason, first_incomplete_at FROM import_jobs
   WHERE blocklisted = 1
   ORDER BY first_incomplete_at ASC`;

/**
 * What the daily sweeps did in the window, from the audit rows their cron wrappers
 * write. Phase 4 added those writes; before it, only the admin routes wrote them
 * and a cron run has no user, so this is `unknown` until the first full week.
 */
export const SWEEP_ACTIVITY_QUERY = `SELECT details FROM audit_log
   WHERE action = 'import_issue_triage' AND timestamp >= datetime('now', ?)`;

export interface WeeklySummaryResult {
  /** False on a dry run: nothing was written to GitHub. */
  applied: boolean;
  /** False when the gate refused -- already posted, or a timestamp it would not
   *  guess at. `facts` is still populated so a dry run can show the report. */
  posted: boolean;
  gateReason: string;
  facts: WeeklySummaryFacts;
  issue: { number: number | null; action: "created" | "would-create" } | null;
  /** The previous week's issue, closed as this one is filed. */
  closedPrevious: number | null;
  /**
   * The body exactly as it would be, or was, posted.
   *
   * Returned so a dry run can show an operator what they are about to file rather
   * than a summary of it -- the difference matters for a report whose whole contract
   * is about how unknowns are rendered, and which is otherwise unreviewable until it
   * is already on the tracker.
   */
  renderedBody: string | null;
  auditFailed?: string;
}

/**
 * Injection seams for tests. Every real caller omits them.
 *
 * TRANSPORT only -- the GitHub client calls, the token fetch, and phase 3's sweep
 * (itself already a transport-seamed unit). Every query, every classification and
 * the whole body run for real.
 */
export interface WeeklySummaryDeps {
  listOpenIssues?: typeof listOpenIssuesByLabel;
  create?: typeof createIssue;
  comment?: typeof addIssueComment;
  close?: typeof closeIssue;
  token?: (env: Bindings) => Promise<string>;
  coverage?: typeof runImportCoverageSweep;
}

/** Seven days, as a SQLite modifier. One place, so the window in the body and the
 *  window in the queries cannot drift apart. */
const WINDOW_MODIFIER = "-7 days";
const WINDOW_MS = 7 * 86_400_000;

export async function runWeeklyImportSummary(
  env: Bindings,
  opts: { apply?: boolean; now?: Date; force?: boolean } = {},
  deps: WeeklySummaryDeps = {},
): Promise<WeeklySummaryResult> {
  const apply = opts.apply === true;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const week = isoWeekLabel(now);

  const facts: WeeklySummaryFacts = {
    week,
    windowStart: new Date(now.getTime() - WINDOW_MS).toISOString(),
    windowEnd: nowIso,
    importedThisWeek: null,
    importedTotal: null,
    coverageStatus: null,
    coverageReason: null,
    outstanding: null,
    discovered: null,
    importedNotInScan: null,
    autoImportEnabled: null,
    dispatchPhrase: null,
    dispatchLost: null,
    failuresByCause: null,
    openFailureTotal: null,
    parked: null,
    issuesClosed: null,
    issuesRelabelled: null,
    errors: [],
  };

  const result: WeeklySummaryResult = {
    applied: apply,
    posted: false,
    gateReason: "",
    facts,
    issue: null,
    closedPrevious: null,
    renderedBody: null,
  };

  // ---- The gate. Read before any work: if this week is already posted there is
  // nothing to compute. `force` is for the admin route's dry run, which an operator
  // runs precisely to see the report they would otherwise have to wait for.
  let gate = { proceed: true, reason: "forced" };
  if (!opts.force) {
    try {
      const last = await env.DB.prepare(WEEKLY_SUMMARY_GATE_QUERY).first<{ timestamp: string }>();
      const lastRunAt = last?.timestamp ?? null;
      gate = decideWeeklySummaryGate({
        lastRunAt,
        lastRunMs: lastRunAt === null ? null : parseSqliteUtc(lastRunAt),
        now,
      });
    } catch (err) {
      // Fails CLOSED, like the gate decision itself: a gate that cannot be read
      // must not authorise a post, or a broken read becomes one issue per day.
      gate = { proceed: false, reason: `gate query failed: ${errText(err)}` };
    }
  }
  result.gateReason = gate.reason;
  if (!gate.proceed) return result;

  // ---- Gather. Each fact independently; a failure is a reported unknown. ----
  await gatherImports(env, facts);
  await gatherCoverage(env, facts, deps);
  await gatherFailures(env, facts);
  await gatherParked(env, facts, now);
  await gatherSweepActivity(env, facts);

  // Rendered before posting, and returned whether or not the post happens: a dry
  // run's whole value is seeing this.
  result.renderedBody = buildWeeklySummaryBody(facts, nowIso);

  // ---- Post. ----
  try {
    const outcome = await postWeeklySummary(
      env,
      facts,
      { apply, now, body: result.renderedBody },
      deps,
    );
    result.issue = outcome.issue;
    result.closedPrevious = outcome.closedPrevious;
    result.posted = outcome.posted;
    if (outcome.auditFailed) result.auditFailed = outcome.auditFailed;
  } catch (err) {
    facts.errors.push({ stage: "post", error: errText(err) });
  }

  return result;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function gatherImports(env: Bindings, facts: WeeklySummaryFacts): Promise<void> {
  try {
    const week = await env.DB.prepare(IMPORTED_THIS_WEEK_QUERY)
      .bind(WINDOW_MODIFIER)
      .first<{ n: number }>();
    facts.importedThisWeek = week?.n ?? null;
    const total = await env.DB.prepare(IMPORTED_TOTAL_QUERY).first<{ n: number }>();
    facts.importedTotal = total?.n ?? null;
  } catch (err) {
    facts.errors.push({ stage: "imports", error: errText(err) });
  }
}

/**
 * Coverage, from phase 3's sweep run READ-ONLY.
 *
 * `apply: false` deliberately, and never `runImportCoverageSweepCron`, which forces
 * `apply: true` -- calling that here would make the weekly job file and close the
 * coverage issue as a side effect of writing a report.
 *
 * This is a second OpenNeuro scan on the weekly day (the daily tick already ran
 * one), which is ~52 extra scans a year. Taken over threading the daily result
 * through so the two jobs stay independent: a coverage failure must not stop the
 * weekly report, and vice versa.
 *
 * An `unknown` coverage verdict leaves every coverage field null, so the report says
 * unknown rather than zero -- the whole point of the phase.
 */
async function gatherCoverage(
  env: Bindings,
  facts: WeeklySummaryFacts,
  deps: WeeklySummaryDeps,
): Promise<void> {
  const coverage = deps.coverage ?? runImportCoverageSweep;
  try {
    const c = await coverage(env, { apply: false });
    facts.coverageStatus = c.status;
    facts.coverageReason = c.reason;
    facts.autoImportEnabled = c.enabled;
    facts.dispatchPhrase = dispatchPhrase(c.dispatchAgeHours);
    facts.dispatchLost = c.dispatchLost;
    if (c.status === "unknown") {
      // The sweep could not see. Its numbers are initialisers, not measurements, so
      // publishing them would be exactly the zero-for-unknown mistake.
      facts.errors.push({ stage: "coverage", error: c.reason });
      return;
    }
    facts.outstanding = outstandingCount(c.backlog);
    facts.discovered = c.discovered;
    facts.importedNotInScan = c.importedNotInScan;
  } catch (err) {
    facts.errors.push({ stage: "coverage", error: errText(err) });
  }
}

async function gatherFailures(env: Bindings, facts: WeeklySummaryFacts): Promise<void> {
  try {
    const rows = await env.DB.prepare(OPEN_FAILURES_QUERY).all<{
      dataset_id: string;
      stage: string;
      last_error: string | null;
    }>();
    if (!rows.results) throw new Error("D1 returned null results");
    // Zero-filled from the label list so every cause appears, the same discipline
    // `GET /admin/imports` uses for `by_status`. A cause missing from the table is
    // indistinguishable from a cause at zero otherwise.
    const byCause: Record<string, number> = {};
    for (const label of IMPORT_FAILURE_CAUSE_LABELS) byCause[label] = 0;
    for (const r of rows.results) {
      const { label } = classifyImportFailure({ stage: r.stage, lastError: r.last_error });
      byCause[label] = (byCause[label] ?? 0) + 1;
    }
    facts.failuresByCause = byCause;
    facts.openFailureTotal = rows.results.length;
  } catch (err) {
    facts.errors.push({ stage: "failures", error: errText(err) });
  }
}

async function gatherParked(env: Bindings, facts: WeeklySummaryFacts, now: Date): Promise<void> {
  try {
    const rows = await env.DB.prepare(PARKED_QUERY).all<{
      dataset_id: string;
      blocklist_reason: string | null;
      first_incomplete_at: string | null;
    }>();
    if (!rows.results) throw new Error("D1 returned null results");
    const parked: ParkedDataset[] = rows.results.map((r) => ({
      datasetId: r.dataset_id,
      reason: r.blocklist_reason,
      // NULL is possible on rows predating the retry engine, and then the duration
      // is genuinely unknown. Reporting 0 would say "parked today".
      parkedDays: daysSince(
        r.first_incomplete_at === null ? null : parseSqliteUtc(r.first_incomplete_at),
        now.getTime(),
      ),
    }));
    facts.parked = parked;
  } catch (err) {
    facts.errors.push({ stage: "parked", error: errText(err) });
  }
}

/**
 * What the daily triage sweep did in the window.
 *
 * Reads the audit rows the cron wrappers write as of phase 4. Before that only the
 * admin routes wrote them, so this is `unknown` for the first week -- which is the
 * honest answer, not a bug.
 */
async function gatherSweepActivity(env: Bindings, facts: WeeklySummaryFacts): Promise<void> {
  try {
    const rows = await env.DB.prepare(SWEEP_ACTIVITY_QUERY)
      .bind(WINDOW_MODIFIER)
      .all<{ details: string | null }>();
    if (!rows.results) throw new Error("D1 returned null results");
    if (rows.results.length === 0) {
      // No rows is genuinely ambiguous: either nothing happened, or the crons have
      // not started writing yet. Left as null (unknown) rather than 0, and the body
      // explains the ambiguity.
      return;
    }
    let closed = 0;
    let relabelled = 0;
    for (const r of rows.results) {
      if (!r.details) continue;
      try {
        const d = JSON.parse(r.details) as { closed?: number; relabelled?: number };
        closed += typeof d.closed === "number" ? d.closed : 0;
        relabelled += typeof d.relabelled === "number" ? d.relabelled : 0;
      } catch {
        // A malformed payload is one row's problem, not the report's.
        facts.errors.push({
          stage: "sweep-activity",
          error: "an audit row's details was not JSON",
        });
      }
    }
    facts.issuesClosed = closed;
    facts.issuesRelabelled = relabelled;
  } catch (err) {
    facts.errors.push({ stage: "sweep-activity", error: errText(err) });
  }
}

/**
 * File this week's issue and close last week's.
 *
 * The body is written ONCE and never rewritten: this is a historical record of a
 * closed window (phase 2's rollup shape), not a current-state document (phase 3's
 * shape). A rewrite would restate the window's numbers from a different instant
 * than the window it claims to describe.
 *
 * Dedup is by the week-labelled title, which is immune to the D1 race the audit gate
 * has. Both are used: the title is the mechanism, the audit row is the record and
 * the input to next week's "what did the sweeps do" section.
 *
 * The audit row is reserved BEFORE the GitHub write, per `autoImportTick`'s rule: if
 * the reservation fails we never post, and if the post fails after it we simply miss
 * a week -- far better than a duplicate every day.
 */
async function postWeeklySummary(
  env: Bindings,
  facts: WeeklySummaryFacts,
  ctx: { apply: boolean; now: Date; body: string },
  deps: WeeklySummaryDeps,
): Promise<{
  issue: WeeklySummaryResult["issue"];
  closedPrevious: number | null;
  posted: boolean;
  auditFailed?: string;
}> {
  const listOpenIssues = deps.listOpenIssues ?? listOpenIssuesByLabel;
  const create = deps.create ?? createIssue;
  const comment = deps.comment ?? addIssueComment;
  const close = deps.close ?? closeIssue;
  const token = deps.token ?? getDatasetsToken;

  const title = importWeeklySummaryIssueTitle(facts.week);
  const nowIso = ctx.now.toISOString();
  const pat = await token(env);
  const open = await listOpenIssues(IMPORT_FAILURE_ISSUES_REPO, IMPORT_WEEKLY_ISSUE_LABEL, pat);

  if (open.some((i) => i.title === title)) {
    // The title dedup caught what the audit gate did not -- a D1 gate row lost, or
    // two invocations racing. Not an error: the week is already reported.
    return { issue: { number: null, action: "would-create" }, closedPrevious: null, posted: false };
  }

  if (!ctx.apply) {
    return { issue: { number: null, action: "would-create" }, closedPrevious: null, posted: false };
  }

  const body = ctx.body;

  // Reserve first. A failure here means no post, which is the safe direction.
  let auditFailed: string | undefined;
  try {
    await auditLogStatement(env.DB, {
      userId: null,
      action: WEEKLY_SUMMARY_AUDIT_ACTION,
      resourceType: "issue",
      resourceId: facts.week,
      details: JSON.stringify({
        week: facts.week,
        imported_this_week: facts.importedThisWeek,
        imported_total: facts.importedTotal,
        outstanding: facts.outstanding,
        open_failures: facts.openFailureTotal,
        parked: facts.parked?.length ?? null,
        errors: facts.errors.length,
      }),
    }).run();
  } catch (err) {
    // Refuse to post without the reservation: posting anyway risks one issue per
    // day for as long as the write keeps failing.
    throw new Error(`weekly summary gate reservation failed, not posting: ${errText(err)}`);
  }

  const created = await create(
    IMPORT_FAILURE_ISSUES_REPO,
    title,
    body,
    [IMPORT_WEEKLY_ISSUE_LABEL],
    pat,
  );
  console.log(
    `[import-weekly] filed ${IMPORT_FAILURE_ISSUES_REPO}#${created.number} for ${facts.week}`,
  );

  // Close last week's. Best-effort: this week's report is the deliverable, and a
  // failure to tidy must not undo it.
  let closedPrevious: number | null = null;
  const previous = findPreviousWeekly(open, facts.week);
  if (previous) {
    try {
      await close(IMPORT_FAILURE_ISSUES_REPO, previous.number, pat);
      closedPrevious = previous.number;
      // Mutate first, then comment (ADR 0050): a comment ahead of a failed close is
      // a claim that repeats.
      await comment(
        IMPORT_FAILURE_ISSUES_REPO,
        previous.number,
        buildWeeklyRolloverComment(facts.week, nowIso),
        pat,
      );
    } catch (err) {
      facts.errors.push({ stage: "rollover", error: errText(err) });
    }
  }

  return {
    issue: { number: created.number, action: "created" },
    closedPrevious,
    posted: true,
    auditFailed,
  };
}

/**
 * The most recent OTHER weekly issue, to close as this week's is filed.
 *
 * Chosen by sorting parsed week labels rather than by issue number, because the
 * numbers are shared with every other issue on the repo and a manual re-file would
 * break the ordering. `2026-W37` sorts lexicographically in chronological order
 * within a year, which is why the label is zero-padded.
 */
function findPreviousWeekly(open: readonly GitHubIssue[], thisWeek: string): GitHubIssue | null {
  const candidates = open
    .map((i) => ({ issue: i, week: parseWeeklySummaryIssueTitle(i.title) }))
    .filter(
      (c): c is { issue: GitHubIssue; week: string } => c.week !== null && c.week !== thisWeek,
    )
    .sort((a, b) => (a.week < b.week ? 1 : -1));
  return candidates[0]?.issue ?? null;
}

/**
 * The cron's entry point: post for real, and refuse outside production.
 *
 * Same split as `runImportIssueSweepCron` and `runImportCoverageSweepCron`. The raw
 * function stays unguarded so the admin route can dry-run it anywhere; this wrapper
 * carries the `apply` and the environment guard, because
 * `IMPORT_FAILURE_ISSUES_REPO` is hardcoded and `nemarDatasets` is shared with
 * production. `deps` is threaded so a test can assert the guard in both directions.
 *
 * The day-of-week check is the CALLER's, in `scheduled()`, so this stays callable
 * on demand -- but it is a pure exported function, because nothing in this repo can
 * test a decision made inline in a `.then()`.
 */
export async function runWeeklyImportSummaryCron(
  env: Bindings,
  deps: WeeklySummaryDeps = {},
): Promise<WeeklySummaryResult | null> {
  if (isNonProductionEnv(env)) {
    console.log("[import-weekly] skipped (non-production)");
    return null;
  }
  return runWeeklyImportSummary(env, { apply: true }, deps);
}

/** One-line cron summary. */
export function weeklySummaryCronLine(result: WeeklySummaryResult): string {
  if (!result.posted) return `[import-weekly] not posted: ${result.gateReason}`;
  return `[import-weekly] ${weeklySummaryLogLine(result.facts, result.issue?.number ?? null)}${
    result.closedPrevious === null ? "" : ` closed_previous=#${result.closedPrevious}`
  }`;
}
