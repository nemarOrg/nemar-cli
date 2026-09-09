/**
 * Import coverage DECISIONS (epic #1306 phase 3, #1311). Pure, no I/O.
 *
 * ## The question this answers
 *
 * Auto-import was off from 2026-07-20 for seven weeks. Every component behaved
 * correctly and no component's job was to notice that nothing was happening.
 * Phases 1 and 2 improved how a failure is DESCRIBED; this one exists because
 * absence of failure is not evidence of success.
 *
 * ## Why silence alone is not the signal
 *
 * The obvious rule -- alarm when the last `auto_import_dispatch` is older than
 * some threshold -- false-alarms permanently, and the reason is subtle enough to
 * be worth stating where the rule lives. `autoImportTick` returns at
 * `if (!picked)` BEFORE it writes its audit row, so a dispatch row exists only
 * when a dataset was actually dispatched. OpenNeuro publishes a few in-scope
 * datasets a week and the tick runs every 30 minutes, so in a healthy steady
 * state the vast majority of ticks write nothing and the last dispatch ages
 * without limit.
 *
 * So silence is only evidence of a problem WHEN THERE WAS WORK TO DO. Every
 * alarm here is gated on a real backlog. That is also what makes the alarm
 * trustworthy enough to act on: it cannot fire on a quiet week.
 *
 * ## Why a disabled importer can still alarm
 *
 * `AUTO_IMPORT_ENABLED` was `"false"` for the whole outage -- that is what #1308
 * flipped back. A rule that never alarms on a disabled importer would therefore
 * miss the exact incident this phase was written for. The distinction that
 * actually matters is not enabled-vs-disabled, it is whether anything is
 * accruing: off with an empty backlog is a maintenance window, off with a
 * backlog is "deliberately off and forgotten". Both are reported; only the second
 * alarms, and its reason names the flag so the reader knows the fix is a config
 * change rather than a bug hunt.
 *
 * Thresholds are exported so tests and the report body reference them instead of
 * repeating literals.
 */

/**
 * Hours without a dispatch, WITH a backlog, before that reads as stalled.
 *
 * The tick runs every 30 minutes and its own gate lets it through every ~25, so a
 * healthy importer with anything to do dispatches within roughly 90 minutes. 24
 * hours is ~48 missed ticks: far outside normal jitter, and still catches a
 * seven-week outage on its first full day.
 */
export const COVERAGE_DISPATCH_STALE_HOURS = 24;

/**
 * Never-attempted in-scope datasets before a stale dispatch counts as an alarm.
 *
 * In-scope datasets accrued at roughly 2.7/week during the measured outage (19
 * over seven weeks), so 5 is about two weeks of accrual. Deliberately not 1: a
 * single dataset can sit un-dispatched for legitimate reasons (it was published
 * minutes ago, or it is mid-backoff after a failure) and an alarm that fires on
 * one row would be ignored within a month.
 */
export const COVERAGE_BACKLOG_ALARM = 5;

/**
 * Never-attempted count that alarms on its own, whatever the dispatch clock says.
 *
 * Covers the case the dispatch signal cannot see: the importer is dispatching --
 * so it looks alive -- but is falling behind faster than it drains, or is
 * dispatching the same few datasets repeatedly while the rest accrue.
 */
export const COVERAGE_BACKLOG_ALARM_ALONE = 20;

/** Which coverage problem is live. `null` when the verdict is not an alarm. */
export type ImportCoverageKind = "backlog" | "silence" | "disabled";

export type ImportCoverageStatus = "healthy" | "alarm" | "unknown";

export interface ImportCoverageVerdict {
  status: ImportCoverageStatus;
  kind: ImportCoverageKind | null;
  /** One line, written for a human reading a GitHub issue. */
  reason: string;
}

/**
 * The backlog, split by what is already tracked elsewhere.
 *
 * Only `neverAttempted` is evidence of a coverage problem. The other two are
 * datasets the system already knows about: a per-dataset failure issue exists for
 * them (phases 1-2), or the retry engine has blocklisted them. Counting those as
 * backlog would make the alarm fire forever on a set nobody intends to import,
 * which is the fastest way to train an operator to ignore it.
 *
 * **There is deliberately no `withdrawn` bucket**, though #1311's own text
 * mentions withdrawals. Withdrawal STAMPS `datasets.withdrawn_at`
 * (`services/withdraw.ts`) rather than deleting the row, so a withdrawn dataset
 * still satisfies `IMPORTED_SOURCE_IDS_QUERY` and `diffNewDatasets` removes it
 * from the diff before this function ever sees it. A withdrawn bucket here would
 * be permanently empty; withdrawal is invisible to a coverage sweep by
 * construction, because a withdrawn dataset genuinely was imported.
 *
 * Every array holds upstream `ds######` ids, matching `datasets.source_id` and
 * `import_jobs.source_id`.
 */
export interface ImportCoverageBacklog {
  neverAttempted: string[];
  failedTracked: string[];
  blocklisted: string[];
}

/** The `import_jobs` state one backlog id can be in. */
export interface BacklogJobState {
  status: string;
  /** `import_jobs.blocklisted`, which the retry engine sets WITHOUT changing
   *  `status` -- so a partition keyed on status alone misses every blocked row. */
  blocklisted: boolean;
}

/**
 * Split the upstream-minus-D1 diff by what the system already knows.
 *
 * `diffNewDatasets` has already removed everything with a managed `datasets` row
 * and everything in-flight or terminal (`quarantined`/`rolled_back`). What can
 * still be in `diff` is: nothing at all in `import_jobs` (never attempted), a
 * plain `failed`/`incomplete` row (tracked by a failure issue), or a blocklisted
 * row (tracked by the retry engine, and possibly still `status = 'failed'`).
 *
 * Blocklisted is checked before "has a row at all" because it is the more
 * specific statement about why nobody is retrying it.
 */
export function partitionBacklog(
  diff: readonly string[],
  jobs: ReadonlyMap<string, BacklogJobState>,
): ImportCoverageBacklog {
  const out: ImportCoverageBacklog = {
    neverAttempted: [],
    failedTracked: [],
    blocklisted: [],
  };
  for (const sourceId of diff) {
    const job = jobs.get(sourceId);
    if (!job) {
      out.neverAttempted.push(sourceId);
    } else if (job.blocklisted) {
      out.blocklisted.push(sourceId);
    } else {
      out.failedTracked.push(sourceId);
    }
  }
  return out;
}

/** Whole hours between `then` and `now`, or null when `then` is unknown. */
export function hoursSince(thenMs: number | null, nowMs: number): number | null {
  if (thenMs === null) return null;
  return Math.max(0, Math.floor((nowMs - thenMs) / 3_600_000));
}

/** Rendered as "3 days" / "5 hours" rather than a raw number, because the report
 *  is read by a human deciding whether to act. */
function humanAge(hours: number | null): string {
  if (hours === null) return "never";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.floor(hours / 24)} days`;
}

/**
 * The coverage verdict.
 *
 * `dispatchAgeHours === null` means no dispatch has ever been recorded. That is
 * NOT automatically stale: a freshly deployed worker with nothing to import is
 * healthy, and treating "never" as infinitely old would alarm on it. It is only
 * stale in the presence of a backlog -- the same fail-open reasoning
 * `decideAutoImportGate` applies to the same value.
 *
 * Ordering matters. The disabled branch comes first because when the importer is
 * off, the dispatch clock says nothing useful: of course nothing has dispatched.
 * Reporting that as `silence` would name the symptom and hide the cause.
 */
export function decideCoverageVerdict(args: {
  enabled: boolean;
  dispatchAgeHours: number | null;
  backlog: ImportCoverageBacklog;
}): ImportCoverageVerdict {
  const pending = args.backlog.neverAttempted.length;
  const age = humanAge(args.dispatchAgeHours);

  if (!args.enabled) {
    if (pending >= COVERAGE_BACKLOG_ALARM) {
      return {
        status: "alarm",
        kind: "disabled",
        reason: `AUTO_IMPORT_ENABLED is not "true" and ${pending} in-scope dataset(s) have never been attempted. Last dispatch: ${age} ago. The importer is switched off, not broken: re-enable it rather than debugging the pipeline.`,
      };
    }
    return {
      status: "healthy",
      kind: null,
      reason: `AUTO_IMPORT_ENABLED is not "true", so the importer is deliberately off, but nothing is accruing (${pending} never-attempted). Last dispatch: ${age} ago.`,
    };
  }

  // Checked before the silence rule: a backlog this large is a problem whether or
  // not the importer looks alive, and saying "silence" about a dispatching
  // importer would be wrong.
  if (pending >= COVERAGE_BACKLOG_ALARM_ALONE) {
    return {
      status: "alarm",
      kind: "backlog",
      reason: `${pending} in-scope dataset(s) have never been attempted, at or above the standalone threshold of ${COVERAGE_BACKLOG_ALARM_ALONE}. Last dispatch: ${age} ago. The importer is dispatching but not keeping up.`,
    };
  }

  const stale =
    args.dispatchAgeHours === null || args.dispatchAgeHours >= COVERAGE_DISPATCH_STALE_HOURS;
  if (pending >= COVERAGE_BACKLOG_ALARM && stale) {
    return {
      status: "alarm",
      kind: "silence",
      reason: `${pending} in-scope dataset(s) have never been attempted and the last auto-import dispatch was ${age} ago, at or beyond the ${COVERAGE_DISPATCH_STALE_HOURS}-hour threshold. The importer is enabled but has stopped moving.`,
    };
  }

  if (pending >= COVERAGE_BACKLOG_ALARM) {
    return {
      status: "healthy",
      kind: null,
      reason: `${pending} in-scope dataset(s) are waiting, but the importer dispatched ${age} ago and is working through them.`,
    };
  }

  return {
    status: "healthy",
    kind: null,
    reason: `${pending} in-scope dataset(s) never attempted, below the alarm threshold of ${COVERAGE_BACKLOG_ALARM}. Last dispatch: ${age} ago.`,
  };
}

// ============================================================================
// Report content. `nowIso` is caller-supplied so these stay deterministic,
// matching the convention in import-issue-accrual.ts.
// ============================================================================

/** How many ids to name before falling back to a count. ADR 0036: an
 *  operational record carries counts and pointers, not an unbounded dump. */
const MAX_LISTED_IDS = 20;

function idList(ids: readonly string[]): string {
  if (ids.length === 0) return "_none_";
  if (ids.length <= MAX_LISTED_IDS) return ids.join(", ");
  return `${ids.slice(0, MAX_LISTED_IDS).join(", ")} ... and ${ids.length - MAX_LISTED_IDS} more`;
}

/**
 * The coverage issue's body, rewritten in place on every alarming run.
 *
 * Authoritative-as-of its own timestamp, and it says so: unlike a per-dataset
 * failure issue, this body is the current state rather than a historical record,
 * and a reader has to know which. It states no running total and no history --
 * phase 2 froze a body at "1 dataset(s) affected" while a dozen comments
 * accumulated below it, and the lesson is that a body written once must never
 * imply it accumulates. This one is not written once, so it can state totals, but
 * only about NOW.
 */
export function buildCoverageIssueBody(args: {
  verdict: ImportCoverageVerdict;
  enabled: boolean;
  dispatchAgeHours: number | null;
  lastDispatchAt: string | null;
  discovered: number;
  backlog: ImportCoverageBacklog;
  nowIso: string;
}): string {
  const b = args.backlog;
  return [
    `**${args.verdict.status.toUpperCase()}${args.verdict.kind ? ` (${args.verdict.kind})` : ""}** as of ${args.nowIso}.`,
    "",
    args.verdict.reason,
    "",
    "## Current state",
    "",
    "This body is rewritten in place by every run of the import coverage sweep. It describes the pipeline **right now**, not a history; the comments below record only changes of kind.",
    "",
    "| | |",
    "|---|---|",
    `| \`AUTO_IMPORT_ENABLED\` | ${args.enabled ? "`true`" : "not `true`"} |`,
    `| Last auto-import dispatch | ${args.lastDispatchAt ?? "never recorded"}${args.dispatchAgeHours === null ? "" : ` (${humanAge(args.dispatchAgeHours)} ago)`} |`,
    `| In-scope datasets on OpenNeuro | ${args.discovered} |`,
    `| **Never attempted** | **${b.neverAttempted.length}** |`,
    `| Failed, already tracked | ${b.failedTracked.length} |`,
    `| Blocklisted by the retry engine | ${b.blocklisted.length} |`,
    "",
    "Only the never-attempted count drives this issue. The other two are already tracked: a per-dataset failure issue exists for them, or the retry engine has blocklisted them. Withdrawn datasets do not appear at all -- a withdrawal keeps the imported row, so it is not a coverage gap.",
    "",
    "### Never attempted",
    "",
    idList(b.neverAttempted),
    "",
    "## What to check",
    "",
    `1. Is \`AUTO_IMPORT_ENABLED\` \`"true"\` in \`backend/wrangler-sccn.toml\`? Only the exact string counts.`,
    "2. Are the `*/30 * * * *` cron triggers still registered on the deployed worker?",
    "3. Does `nemar admin import-coverage` reproduce this? It runs the same sweep on demand.",
    "",
    `Closed automatically once the never-attempted count falls below ${COVERAGE_BACKLOG_ALARM} or the importer resumes dispatching. Filed by the import coverage sweep (nemarOrg/nemar-cli#1311).`,
  ].join("\n");
}

/** Comment left when the KIND of problem changes, which is the only transition
 *  worth a notification. A run that merely re-confirms the same kind rewrites the
 *  body and says nothing. */
export function buildCoverageKindChangeComment(
  previous: ImportCoverageKind | null,
  next: ImportCoverageKind,
  reason: string,
  nowIso: string,
): string {
  return [
    `Coverage problem changed from \`${previous ?? "none"}\` to \`${next}\` (${nowIso}).`,
    "",
    reason,
    "",
    "The body above has been updated to the current numbers.",
  ].join("\n");
}

/** Comment left as the issue is closed. Says what recovered, because "closed"
 *  alone does not distinguish a real recovery from someone silencing it. */
export function buildCoverageRecoveryComment(
  verdict: ImportCoverageVerdict,
  nowIso: string,
): string {
  return [
    `Coverage recovered: closing automatically (${nowIso}).`,
    "",
    verdict.reason,
    "",
    "A new issue opens if coverage regresses. This close is not a claim that every dataset listed above was imported -- some may be tracked by their own failure issue, blocklisted, or withdrawn.",
  ].join("\n");
}
