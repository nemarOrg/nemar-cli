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
import { SYSTEM_USER_ID } from "../lib/constants.js";
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
/**
 * Releases a reservation whose post then failed, BY ROW ID.
 *
 * Keyed on the week label it would also delete a reservation from an EARLIER,
 * successful post of the same week -- a manual re-file, say -- destroying the durable
 * record of that post, in a table the rest of the system treats as append-only. The
 * id comes from the insert's own `meta.last_row_id`, so exactly the row this run
 * wrote is removed, or nothing is.
 */
export const WEEKLY_SUMMARY_RELEASE_SQL = "DELETE FROM audit_log WHERE id = ?";

export const WEEKLY_SUMMARY_GATE_QUERY = `SELECT timestamp FROM audit_log WHERE action = '${WEEKLY_SUMMARY_AUDIT_ACTION}' ORDER BY id DESC LIMIT 1`;

/**
 * OpenNeuro mirrors created inside the window.
 *
 * Predicate matches `IMPORTED_SOURCE_IDS_QUERY`'s, including the
 * `owner_user_id != SYSTEM_USER_ID` clause that excludes the folded legacy shadow rows --
 * un-imported browse pointers whose inclusion caused the 2026-06-20 stall.
 *
 * Plain `created_at`, deliberately NOT `COALESCE(publish_date, created_at)` as
 * `dataset-filters.ts` uses: `publish_date` is NULL for imported mirrors, so the
 * coalesce would be a no-op today and would silently start dating mirrors by
 * OpenNeuro's publish date the moment that column gets populated. This report is
 * about when NEMAR imported something.
 */
export const IMPORTED_THIS_WEEK_QUERY = `SELECT COUNT(*) AS n FROM datasets
   WHERE source = 'openneuro' AND source_id IS NOT NULL AND owner_user_id != ${SYSTEM_USER_ID}
     AND created_at >= datetime('now', ?)`;

/** Same predicate, no window: the `on*` total. */
export const IMPORTED_TOTAL_QUERY = `SELECT COUNT(*) AS n FROM datasets
   WHERE source = 'openneuro' AND source_id IS NOT NULL AND owner_user_id != ${SYSTEM_USER_ID}`;

/**
 * Open failures, with the `last_error` needed to classify each one.
 *
 * Unbounded on purpose. Every existing classifier call site is single-row keyed by
 * `dataset_id`; `BACKLOG_JOBS_QUERY` reads the fleet but omits `last_error`, so it
 * cannot classify, and `GET /admin/imports` selects `last_error` but does not group. `IMPORT_RETRY_CANDIDATES_QUERY` has the
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
 * `first_incomplete_at` is the anchor because it is WRITE-ONCE: set with
 * `COALESCE(first_incomplete_at, datetime('now'))` and cleared only on recovery, so it
 * dates from when the row first went bad and cannot creep forward.
 *
 * `updated_at` is the tempting alternative and it is the wrong shape rather than the
 * wrong value: it means "when this row was last written", which happens to coincide
 * with the blocklisting today but is not a promise about anything. (An earlier version
 * of this comment claimed the slow re-check bumps it; it does not -- the re-check
 * writes only `next_retry_at` and `integrity_checked_at`.) `next_retry_at` is
 * straightforwardly wrong: it is a future timestamp.
 *
 * Unbounded, and unlike `BLOCKLIST_RECHECK_QUERY` it does NOT filter on
 * `next_retry_at`, which would exclude every row currently in backoff, i.e. most of
 * them.
 *
 * `first_incomplete_at IS NULL` leads the ORDER BY because SQLite sorts NULL before
 * every value in ASC. Without it, rows whose duration is UNKNOWN sort ahead of the
 * genuinely oldest and can consume the whole truncation budget -- so the section
 * built to surface the longest-parked datasets would hide exactly those. Written as
 * an expression rather than `NULLS LAST`, which bun:sqlite accepts and D1 may not.
 */
export const PARKED_QUERY = `SELECT dataset_id, blocklist_reason, first_incomplete_at FROM import_jobs
   WHERE blocklisted = 1
   ORDER BY first_incomplete_at IS NULL, first_incomplete_at ASC`;

/**
 * What the daily TRIAGE cron did in the window.
 *
 * Rows are filtered to `source: "cron"` in JS, NOT with `json_extract` in the SQL.
 * The filter itself is required: the admin ROUTE has always written the same action
 * with the same `closed`/`relabelled` keys, so without it a manual
 * `nemar admin import-issue-triage --apply` is reported as something the daily sweep
 * did -- which makes the `source` key load-bearing in both writers. But doing it in
 * SQL meant one malformed `details` payload raised "malformed JSON" and aborted the
 * whole SELECT, blinding the entire section over a single bad row. In JS that row is
 * skipped AND reported, which is the behaviour this phase is about.
 *
 * Deliberately singular. `import_coverage_sweep` rows exist too, but coverage is
 * reported as CURRENT STATE by `gatherCoverage`, so summing its transitions here
 * would report the same thing twice in two tenses.
 */
/**
 * The window is bound EXPLICITLY, not `datetime('now', ?)`.
 *
 * SQL-side `now` is evaluated when the query runs, which here is minutes into the
 * tick -- after the gate, after `gatherImports`, and after `gatherCoverage`'s full
 * paginated OpenNeuro scan, whose duration varies a lot. So consecutive weekly
 * reports did not tile: when this week's query ran later than last week's, the rows
 * in between appeared in NEITHER report; when it ran earlier, they appeared in both.
 * Monday's own triage row sits exactly on that boundary, so it was the row most
 * likely to be dropped -- and dropping it under-reports recoveries, which reads as
 * good news.
 *
 * Bound from the same `now` the report already fixes for `facts.windowStart`, so the
 * window the numbers cover is the window the report claims.
 */
export const SWEEP_ACTIVITY_QUERY = `SELECT details FROM audit_log
   WHERE action = 'import_issue_triage' AND timestamp >= ? AND timestamp < ?`;

/**
 * What happened to this week's issue.
 *
 * `already-filed` is its own value rather than a reused `would-create` because the
 * two mean different things to a reader: a dry run declined to write, whereas
 * already-filed means the title dedup caught a week the audit gate had APPROVED --
 * i.e. a lost gate row or a race, which is worth noticing.
 */
export type WeeklyIssueAction = "created" | "would-create" | "already-filed";

export interface WeeklySummaryResult {
  /** False on a dry run: nothing was written to GitHub. */
  applied: boolean;
  /** False when the gate refused, when this is a dry run, or when the week's issue
   *  already exists. */
  posted: boolean;
  gateReason: string;
  /**
   * NULL when the gate refused, because nothing was gathered -- the gate is read
   * before any query so a refusal costs nothing.
   *
   * Deliberately not an all-null `facts`: that is indistinguishable from a report
   * where every section failed to read, and "we did not look" is a different answer
   * from "we looked and could not tell". An earlier version returned the
   * initialiser here, so a Tuesday `?apply=1` rendered a full page of `unknown`
   * with exit code 0.
   */
  facts: WeeklySummaryFacts | null;
  issue: { number: number | null; action: WeeklyIssueAction } | null;
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

/**
 * The window, in the two forms the two consumers need: a SQLite modifier for the
 * queries and milliseconds for the label and the reported bounds.
 *
 * They are derived from one number so they cannot disagree about the length. They can
 * still disagree about the INSTANT, because each `datetime('now', ?)` is evaluated when
 * its query runs while the reported bounds are fixed at the start -- minutes apart,
 * across an OpenNeuro scan. The body states the bounds it was given, so treat those as
 * the authority to within a few minutes rather than to the second.
 */
/**
 * A JS instant in SQLite's `datetime()` shape: "YYYY-MM-DD HH:MM:SS", UTC, no zone.
 *
 * Required because `audit_log.timestamp` is written by `datetime('now')` and string
 * comparison is what the index uses. An ISO string with the `T` and the `Z` sorts
 * differently from SQLite's own format on the same instant, which is the mistake
 * ADR 0047 records for the device flow -- the same trap, one table over.
 */
function toSqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

const WINDOW_DAYS = 7;
const WINDOW_MODIFIER = `-${WINDOW_DAYS} days`;
const WINDOW_MS = WINDOW_DAYS * 86_400_000;

export async function runWeeklyImportSummary(
  env: Bindings,
  opts: { apply?: boolean; now?: Date; force?: boolean } = {},
  deps: WeeklySummaryDeps = {},
): Promise<WeeklySummaryResult> {
  const apply = opts.apply === true;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  // The week the data COVERS, not the week the run happens in. The cron fires Monday
  // 03:00 UTC and the window is the preceding seven days, so `isoWeekLabel(now)`
  // named the week that had just started: an issue titled 2026-W37 carried W36's
  // numbers, and the headline, the heading and the rollover comment all inherited the
  // lie. Deriving it from the window start makes the title mean what it says.
  //
  // The gate is unaffected: it compares labels of RUN instants, and both this and
  // that are stable within a calendar week, so they cannot disagree about which week
  // has been posted.
  const week = isoWeekLabel(new Date(now.getTime() - WINDOW_MS));

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
    facts: null,
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
  // `facts` stays null: nothing has been gathered, and saying "unknown" for
  // everything would claim we looked.
  if (!gate.proceed) return result;
  result.facts = facts;

  // ---- Gather. Each fact independently; a failure is a reported unknown. ----
  await gatherImports(env, facts);
  await gatherCoverage(env, facts, deps);
  await gatherFailures(env, facts);
  await gatherParked(env, facts, now);
  await gatherSweepActivity(env, facts, now);

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
 * An `unknown` coverage verdict leaves every DERIVED coverage field null, so the
 * report says unknown rather than zero -- the whole point of the phase. Only
 * `enabled` survives, because it is read from the binding rather than derived.
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
    // `enabled` is the ONE field safe to publish on any verdict: it is
    // `env.AUTO_IMPORT_ENABLED === "true"`, a synchronous binding read taken before
    // the sweep does any I/O, so it cannot be an unmeasured initialiser.
    facts.autoImportEnabled = c.enabled;
    if (c.status === "unknown") {
      // The sweep could not see, so NOTHING it derived may be published -- and that
      // includes the dispatch fields, which is where an earlier version of this
      // function got it wrong. On the discovery-failure path the sweep returns
      // before `COVERAGE_LAST_DISPATCH_QUERY` runs at all, so `dispatchAgeHours` is
      // still the initialiser `null` and `dispatchLost` still `false`. Assigning
      // them above this guard published "Last dispatch: never recorded" and
      // "Dispatches landing: yes" as measured fact on a week when the dispatch row
      // was never read -- a reassuring invention in the one artifact this phase
      // exists to keep from inventing reassurance.
      facts.errors.push({ stage: "coverage", error: c.reason });
      return;
    }
    facts.dispatchPhrase = dispatchPhrase(c.dispatchAgeHours);
    facts.dispatchLost = c.dispatchLost;
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
async function gatherSweepActivity(
  env: Bindings,
  facts: WeeklySummaryFacts,
  now: Date,
): Promise<void> {
  try {
    // The same instant `facts.windowStart` was derived from, so consecutive reports
    // tile exactly instead of drifting by however long the OpenNeuro scan took.
    const rows = await env.DB.prepare(SWEEP_ACTIVITY_QUERY)
      .bind(toSqliteUtc(new Date(now.getTime() - WINDOW_MS)), toSqliteUtc(now))
      .all<{ details: string | null }>();
    if (!rows.results) throw new Error("D1 returned null results");
    let closed = 0;
    let relabelled = 0;
    let cronRows = 0;
    let failedRuns = 0;
    for (const r of rows.results) {
      if (!r.details) {
        // Cannot be attributed to the cron or counted. Reported rather than skipped,
        // because treating it as a zero is the mistake this phase is about.
        facts.errors.push({
          stage: "sweep-activity",
          error: "an import_issue_triage audit row had no details payload",
        });
        continue;
      }
      let d: {
        source?: string;
        closed?: number | null;
        relabelled?: number | null;
        failed?: boolean;
        error?: string;
      };
      try {
        d = JSON.parse(r.details);
      } catch {
        facts.errors.push({
          stage: "sweep-activity",
          error: "an import_issue_triage audit row's details was not JSON",
        });
        continue;
      }
      // The cron's own rows only: see the note on SWEEP_ACTIVITY_QUERY.
      if (d.source !== "cron") continue;
      cronRows++;
      // A row from a run that THREW proves the cron ran -- which is why it counts
      // toward `cronRows` -- but measured nothing, so it contributes no counts and is
      // surfaced instead. Without this the week would read as quiet when in fact
      // every run failed, and "the token expired" is the likeliest cause.
      if (d.failed === true) {
        failedRuns++;
        facts.errors.push({
          stage: "sweep-activity",
          error: `a daily triage run failed: ${d.error ?? "no reason recorded"}`,
        });
        continue;
      }
      closed += typeof d.closed === "number" ? d.closed : 0;
      relabelled += typeof d.relabelled === "number" ? d.relabelled : 0;
    }
    // No CRON rows at all leaves both null. The crons write one per run, so an absence
    // means they did not run -- unknown, not zero.
    if (cronRows === 0) return;
    // Every row we found was a failure: the cron ran and never once completed, so
    // there is no measurement to report. Null, not zero, and the per-run errors above
    // say why.
    if (failedRuns === cronRows) return;
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
 * Dedup is the week-labelled title; the audit row is the record and next week's input
 * for "what the daily sweeps did". NEITHER is atomic -- the title check is itself a
 * read-then-write and GitHub permits duplicate titles -- so they are defence in depth
 * against ordinary repetition, not a lock. What actually caps repetition is the
 * Monday-only day guard in `scheduled()`. The title's real advantage over the audit row
 * is durability: it survives a lost or purged row.
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

  const existing = open.find((i) => i.title === title);
  if (existing) {
    // The title dedup caught what the audit gate did not -- a D1 gate row lost, or
    // two invocations racing. Not an error: the week is already reported.
    //
    // `already-filed`, NOT `would-create`. The type declared this value and the log
    // formatter branched on it, but nothing ever returned it, so an APPLIED run that
    // landed here logged "not posted (dry run)" -- and `index.ts` escalates that line
    // to console.error, making the loudest line of the week a false one. The issue
    // number is carried too: an operator asking why nothing was posted wants the
    // thing that already exists.
    return {
      issue: { number: existing.number, action: "already-filed" },
      closedPrevious: null,
      posted: false,
    };
  }

  if (!ctx.apply) {
    return { issue: { number: null, action: "would-create" }, closedPrevious: null, posted: false };
  }

  const body = ctx.body;

  // Reserve first. A failure here means no post, which is the safe direction.
  let reservationId: number | null = null;
  try {
    const written = await auditLogStatement(env.DB, {
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
    // D1 reports the inserted rowid here. If a future driver stops doing so this
    // stays null and the release below simply does not fire, which fails in the
    // burn-the-week direction rather than deleting the wrong row.
    const rowId = (written as { meta?: { last_row_id?: number } }).meta?.last_row_id;
    reservationId = typeof rowId === "number" ? rowId : null;
  } catch (err) {
    // Refuse to post without the reservation: posting anyway risks one issue per
    // day for as long as the write keeps failing.
    throw new Error(`weekly summary gate reservation failed, not posting: ${errText(err)}`);
  }

  let created: GitHubIssue;
  try {
    created = await create(
      IMPORT_FAILURE_ISSUES_REPO,
      title,
      body,
      [IMPORT_WEEKLY_ISSUE_LABEL],
      pat,
    );
  } catch (err) {
    // RELEASE the reservation. Reserve-before-acting is autoImportTick's rule, but
    // that rule assumes a caller retrying every 30 minutes; here the Monday-only day
    // guard already prevents repetition, so an un-released row would burn the whole
    // week -- and there is no operator override, because the route forces past the
    // gate only on a DRY run. Releasing keeps the anti-duplicate property without
    // the trap.
    try {
      if (reservationId === null) {
        throw new Error("the reservation row id was not reported, so it cannot be released");
      }
      await env.DB.prepare(WEEKLY_SUMMARY_RELEASE_SQL).bind(reservationId).run();
    } catch (releaseErr) {
      // Now the week really is burnt, so say so loudly: this is the one state an
      // operator must know about, since the next attempt is seven days away.
      console.error(
        `[import-weekly] post failed AND the reservation for ${facts.week} could not be released; this week will not be re-attempted:`,
        releaseErr,
      );
    }
    throw err;
  }
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
      // Mutate first, then comment (ADR 0052): a comment ahead of a failed close is
      // a claim that repeats.
      await comment(
        IMPORT_FAILURE_ISSUES_REPO,
        previous.number,
        buildWeeklyRolloverComment(facts.week, created.number, nowIso),
        pat,
      );
    } catch (err) {
      facts.errors.push({ stage: "rollover", error: errText(err) });
    }
  }

  return { issue: { number: created.number, action: "created" }, closedPrevious, posted: true };
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
    // Strictly EARLIER, not merely different. Filtering on `!== thisWeek` let a
    // future-labelled issue win the sort -- clock-skewed or hand-filed -- so the
    // rollover closed it, commented a false supersession, and left the real previous
    // week open forever: the accumulating tracker this epic is about.
    .filter((c): c is { issue: GitHubIssue; week: string } => c.week !== null && c.week < thisWeek)
    // Consistent comparator: returning -1 for equal weeks is not a valid ordering.
    .sort((a, b) => (a.week < b.week ? 1 : a.week > b.week ? -1 : 0));
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
  // Three different non-posts, and an earlier version reported all of them as a gate
  // refusal by printing `gateReason` unconditionally -- so a failed post logged "no
  // weekly summary has ever been posted", and a title-dedup hit logged the gate's
  // APPROVAL string as its reason for refusing. Each now says what actually happened.
  if (result.facts === null) return `[import-weekly] not posted: ${result.gateReason}`;
  const failed = result.facts.errors.find((e) => e.stage === "post");
  if (failed) return `[import-weekly] POST FAILED for ${result.facts.week}: ${failed.error}`;
  if (result.issue?.action === "already-filed") {
    return `[import-weekly] ${result.facts.week} was already filed as #${result.issue.number}; the gate had approved it, so a run was lost or raced`;
  }
  if (!result.posted) {
    return `[import-weekly] not posted (dry run) for ${result.facts.week}`;
  }
  return `[import-weekly] ${weeklySummaryLogLine(result.facts, result.issue?.number ?? null)}${
    result.closedPrevious === null ? "" : ` closed_previous=#${result.closedPrevious}`
  }`;
}
