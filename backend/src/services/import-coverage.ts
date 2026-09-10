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
 * when a dataset was actually picked. OpenNeuro publishes a few in-scope datasets
 * a week and the tick runs every 30 minutes, so in a healthy steady state the
 * vast majority of ticks write nothing and the last dispatch ages without limit.
 *
 * So silence is only evidence of a problem WHEN THERE WAS WORK TO DO. Every alarm
 * here is gated on real outstanding work. That is also what makes the alarm
 * trustworthy enough to act on: it cannot fire on a quiet week.
 *
 * ## Why a fresh dispatch row is not proof of life either
 *
 * The row is written to reserve the slot, so it lands BEFORE the hand-off it
 * stands for -- `getDatasetsToken` and `triggerOpenNeuroOnboard` are eighteen
 * lines later in `autoImportTick`. A fresh row therefore proves the tick ran and
 * chose something, not that GitHub accepted the work. If the datasets PAT expires
 * or the onboard workflow is renamed, rows keep appearing every ~30 minutes while
 * nothing is ever imported, and a rule that trusted the timestamp would report
 * that as healthy for weeks. `dispatchLost` is the cross-check: the dataset the
 * last row NAMES should have acquired an `import_jobs` row shortly afterwards, and
 * if it has not, the hand-off is evaporating.
 *
 * ## Why a disabled importer can still alarm
 *
 * `AUTO_IMPORT_ENABLED` was not `"true"` for the whole outage -- that is what
 * #1308 flipped back. A rule that never alarms on a disabled importer would
 * therefore miss the exact incident this phase was written for. The distinction
 * that actually matters is not enabled-versus-disabled, it is whether anything is
 * accruing: off with no outstanding work is a maintenance window, off with work
 * outstanding is "deliberately off and forgotten". Both are reported; only the
 * second alarms, and its reason names the flag so the reader knows the fix is a
 * config change rather than a bug hunt.
 *
 * Thresholds are exported so tests and the report body reference them instead of
 * repeating literals.
 */

/**
 * Hours without a dispatch, WITH work outstanding, before that reads as stalled.
 *
 * The tick runs every 30 minutes and its own gate lets it through every ~25 (so the
 * gate never blocks a tick), meaning a healthy importer with anything to do
 * dispatches within roughly 30 minutes, or ~60 on bad alignment. 24 hours is ~48
 * missed ticks: far outside normal jitter.
 *
 * Note this is not the detection latency. The sweep runs once daily, and the
 * alarm also needs {@link COVERAGE_BACKLOG_ALARM} datasets outstanding, so the
 * real latency from a stall is days -- see ADR 0053's consequences.
 */
export const COVERAGE_DISPATCH_STALE_HOURS = 24;

/**
 * Hours after a dispatch row before the dataset it names must have an
 * `import_jobs` row, or the hand-off is presumed lost.
 *
 * The onboard workflow upserts `preparing` early, well inside an hour. Six hours
 * is generous enough that a slow queue or a re-run cannot trip it, and still far
 * short of the weeks the backlog thresholds would take to notice the same fault.
 */
export const COVERAGE_DISPATCH_LOST_HOURS = 6;

/**
 * Outstanding in-scope datasets before a stale dispatch counts as an alarm.
 *
 * In-scope datasets accrued at roughly 2.7/week during the measured outage (19
 * over seven weeks), so 5 is about two weeks of accrual. Deliberately not 1: a
 * single dataset can sit un-dispatched for legitimate reasons (it was published
 * minutes ago, or it is mid-backoff after a failure) and an alarm that fires on
 * one row would be ignored within a month.
 */
export const COVERAGE_BACKLOG_ALARM = 5;

/**
 * Outstanding count that alarms on its own, whatever the dispatch clock says.
 *
 * Covers the case the dispatch signal cannot see: the importer is dispatching --
 * so it looks alive -- but is falling behind faster than it drains.
 */
export const COVERAGE_BACKLOG_ALARM_ALONE = 20;

/** Which coverage problem is live. `null` when the verdict is not an alarm. */
export type ImportCoverageKind = "backlog" | "silence" | "disabled" | "dispatch-lost";

export type ImportCoverageStatus = "healthy" | "alarm" | "unknown";

export interface ImportCoverageVerdict {
  status: ImportCoverageStatus;
  kind: ImportCoverageKind | null;
  /** One line, written for a human reading a GitHub issue. */
  reason: string;
}

/**
 * The backlog, split by whether anything is already tracking each dataset.
 *
 * `neverAttempted` and `untracked` are OUTSTANDING WORK and drive the verdict.
 * `tracked` and `blocklisted` do not: a per-dataset failure issue exists for the
 * first (ADR 0052) and the retry engine owns the second, so counting them would
 * make the alarm permanent on a set nobody intends to import -- the fastest way
 * to train an operator to ignore it.
 *
 * **There is deliberately no `withdrawn` bucket**, though #1311's text mentions
 * withdrawals. Withdrawal STAMPS `datasets.withdrawn_at` (`services/withdraw.ts`)
 * rather than deleting the row, so a withdrawn dataset still satisfies
 * `IMPORTED_SOURCE_IDS_QUERY` and `diffNewDatasets` removes it before this
 * function ever sees it. Withdrawal is invisible to a coverage sweep by
 * construction, because a withdrawn dataset genuinely was imported.
 *
 * Every array holds upstream `ds######` ids, matching `datasets.source_id` and
 * `import_jobs.source_id`.
 */
export interface ImportCoverageBacklog {
  /** No `import_jobs` row at all: nothing has ever tried. */
  neverAttempted: string[];
  /**
   * Has a row, but one no tracker owns -- `complete` with no `datasets` row (an
   * admin deleted the dataset and `deleteDatasetCascade` leaves `import_jobs`
   * behind), or an unrecognised status. The importer WILL re-dispatch these
   * (`loadFailedJobInfo` only loads `failed`), so they are outstanding work, and
   * filing them under "already tracked" would have quietly under-counted.
   */
  untracked: string[];
  /** `failed` or `incomplete`: a failure issue or the retry engine owns it. */
  tracked: string[];
  /** `import_jobs.blocklisted`, which the retry engine sets WITHOUT changing
   *  `status` -- so a partition keyed on status alone misses every blocked row. */
  blocklisted: string[];
}

/** The `import_jobs` state one backlog id can be in. */
export interface BacklogJobState {
  status: string;
  blocklisted: boolean;
}

/** Statuses for which something else is already tracking the dataset. Anything
 *  else with a row is `untracked` -- see {@link ImportCoverageBacklog}. */
const TRACKED_STATUSES: ReadonlySet<string> = new Set(["failed", "incomplete"]);

/**
 * Split the upstream-minus-D1 diff by whether anything is already tracking it.
 *
 * `diffNewDatasets` has already removed everything with a managed `datasets` row
 * and everything in-flight or terminal (`quarantined`/`rolled_back`), so what can
 * still be here is: no row at all, a `failed`/`incomplete` row, a blocklisted
 * row, or a `complete` row whose dataset was deleted.
 *
 * Blocklisted is checked before the status buckets because it is the more specific
 * statement about why nobody is retrying it -- a blocked row is commonly `failed`
 * too, since `import-retry.ts` does not change `status` when it blocklists.
 */
export function partitionBacklog(
  diff: readonly string[],
  jobs: ReadonlyMap<string, BacklogJobState>,
): ImportCoverageBacklog {
  const out: ImportCoverageBacklog = {
    neverAttempted: [],
    untracked: [],
    tracked: [],
    blocklisted: [],
  };
  for (const sourceId of diff) {
    const job = jobs.get(sourceId);
    if (!job) out.neverAttempted.push(sourceId);
    else if (job.blocklisted) out.blocklisted.push(sourceId);
    else if (TRACKED_STATUSES.has(job.status)) out.tracked.push(sourceId);
    else out.untracked.push(sourceId);
  }
  return out;
}

/** Datasets nothing is working on: the number every alarm is gated against. */
export function outstandingCount(backlog: ImportCoverageBacklog): number {
  return backlog.neverAttempted.length + backlog.untracked.length;
}

/**
 * Whole hours between `then` and `now`, or null when `then` is unknown.
 *
 * SIGNED on purpose. An earlier version clamped at 0, which turned any
 * future-dated dispatch row -- a skewed clock, a replayed fixture -- into
 * "dispatched 0 hours ago" and so made `stale` false forever, silently confining
 * the sweep to its standalone-backlog backstop. A negative value is an anomaly
 * the caller reports rather than a freshness the caller believes.
 */
export function hoursSince(thenMs: number | null, nowMs: number): number | null {
  if (thenMs === null) return null;
  return Math.floor((nowMs - thenMs) / 3_600_000);
}

/**
 * The dispatch clock as a phrase, complete on its own.
 *
 * Not a bare number with " ago" appended by the caller: `null` rendered that way
 * produced "Last dispatch: never ago" in four operator-facing reason strings.
 */
export function dispatchPhrase(hours: number | null): string {
  if (hours === null) return "never recorded";
  if (hours < 0) return "dated in the future (clock anomaly)";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/**
 * The coverage verdict.
 *
 * `dispatchAgeHours === null` means no dispatch has ever been recorded, or the
 * stored timestamp could not be read. It DOES read as stale -- the conservative
 * direction -- but stale alone is not an alarm: a freshly deployed worker with
 * nothing to import is healthy, and treating "never" as an alarm on its own would
 * fire on a correct cold start. Note this fails the opposite way from
 * `decideAutoImportGate`, which fails open toward ACTING on the same value; here
 * the safe direction is toward alarming.
 *
 * Ordering is load-bearing:
 *
 *   1. **disabled** first, because when the importer is off the dispatch clock
 *      says nothing useful -- of course nothing dispatched. Reporting that as
 *      `silence` would name the symptom and hide the cause.
 *   2. **dispatch-lost** next, because it is the most specific diagnosis: rows
 *      are being written and the work is not landing, which no other branch can
 *      see (the clock looks fresh, so `silence` cannot fire).
 *   3. **backlog** before **silence**, because a backlog this large is a problem
 *      whether or not the importer looks alive.
 */
export function decideCoverageVerdict(args: {
  enabled: boolean;
  /** Named in the dispatch-lost reason: one wedged dataset is the likeliest cause,
   *  and the reader cannot act without knowing which. */
  lastDispatchSourceId?: string | null;
  /** False when the binding is absent entirely, which is a config fault rather
   *  than a decision, and is worth saying differently. */
  enabledBindingPresent?: boolean;
  dispatchAgeHours: number | null;
  /** The dataset the last dispatch row names still has no `import_jobs` row, well
   *  after it should have. Computed by the sweep; see the module note. */
  dispatchLost?: boolean;
  backlog: ImportCoverageBacklog;
}): ImportCoverageVerdict {
  const pending = outstandingCount(args.backlog);
  const clock = dispatchPhrase(args.dispatchAgeHours);

  if (!args.enabled) {
    const how =
      args.enabledBindingPresent === false
        ? "AUTO_IMPORT_ENABLED is not set at all, so the importer is off by omission rather than by decision"
        : 'AUTO_IMPORT_ENABLED is not "true", so the importer is switched off';
    if (pending >= COVERAGE_BACKLOG_ALARM) {
      return {
        status: "alarm",
        kind: "disabled",
        reason: `${how}, and ${pending} in-scope dataset(s) are outstanding. Last dispatch: ${clock}. The importer is off, not broken: re-enable it rather than debugging the pipeline.`,
      };
    }
    return {
      status: "healthy",
      kind: null,
      reason: `${how}, but nothing is accruing (${pending} outstanding). Last dispatch: ${clock}.`,
    };
  }

  if (args.dispatchLost === true) {
    const which = args.lastDispatchSourceId ? ` (${args.lastDispatchSourceId})` : "";
    return {
      status: "alarm",
      kind: "dispatch-lost",
      reason: `The importer is picking datasets but the work is not landing: the dataset named by the last dispatch${which}, ${clock}, still has no import_jobs row after ${COVERAGE_DISPATCH_LOST_HOURS} hours. The audit row is written to reserve the slot BEFORE the GitHub hand-off, so a fresh row does not prove the hand-off succeeded. Three causes, most likely first: that one dataset is wedging the picker (a never-attempted id is always "fresh" to pickNextDataset, so a run that dies before its first callback is re-picked every tick forever); the datasets PAT can no longer dispatch; or onboard-openneuro.yml was renamed or removed.`,
    };
  }

  if (pending >= COVERAGE_BACKLOG_ALARM_ALONE) {
    return {
      status: "alarm",
      kind: "backlog",
      reason: `${pending} in-scope dataset(s) are outstanding, at or above the standalone threshold of ${COVERAGE_BACKLOG_ALARM_ALONE}. Last dispatch: ${clock}. The importer is not keeping up.`,
    };
  }

  const stale =
    args.dispatchAgeHours === null ||
    args.dispatchAgeHours < 0 ||
    args.dispatchAgeHours >= COVERAGE_DISPATCH_STALE_HOURS;
  if (pending >= COVERAGE_BACKLOG_ALARM && stale) {
    return {
      status: "alarm",
      kind: "silence",
      reason: `${pending} in-scope dataset(s) are outstanding and the last auto-import dispatch was ${clock}, at or beyond the ${COVERAGE_DISPATCH_STALE_HOURS}-hour threshold. The importer is enabled but has stopped moving.`,
    };
  }

  if (pending >= COVERAGE_BACKLOG_ALARM) {
    return {
      status: "healthy",
      kind: null,
      reason: `${pending} in-scope dataset(s) are outstanding, and the importer dispatched ${clock}, so it appears to be working through them.`,
    };
  }

  return {
    status: "healthy",
    kind: null,
    reason: `${pending} in-scope dataset(s) outstanding, below the alarm threshold of ${COVERAGE_BACKLOG_ALARM}. Last dispatch: ${clock}.`,
  };
}

// ============================================================================
// Report content. `nowIso` is caller-supplied so these stay deterministic,
// matching the convention in import-issue-accrual.ts.
// ============================================================================

/** How many ids to name before falling back to a count. ADR 0036: an
 *  operational record carries counts and pointers, not an unbounded dump. */
export const MAX_LISTED_IDS = 20;

function idList(ids: readonly string[]): string {
  if (ids.length === 0) return "_none_";
  if (ids.length <= MAX_LISTED_IDS) return ids.join(", ");
  return `${ids.slice(0, MAX_LISTED_IDS).join(", ")} ... and ${ids.length - MAX_LISTED_IDS} more`;
}

/** Everything the report needs beyond the verdict itself. */
export interface CoverageReportFacts {
  enabled: boolean;
  dispatchAgeHours: number | null;
  lastDispatchAt: string | null;
  lastDispatchSourceId: string | null;
  /** In-scope datasets the scan reported. */
  discovered: number;
  /** Managed mirrors in D1, however many the scan still returns. */
  imported: number;
  /** Of `discovered`: already imported. The first term of the balance. */
  importedInScan: number;
  /** Mirrors D1 holds that the scan no longer returns. Reported on its own line
   *  because it is drift, not a gap and not an error. */
  importedNotInScan: number;
  /** Of `discovered`, excluding the above: mid-import. */
  inFlight: number;
  /** Of `discovered`, excluding the above: quarantined or rolled back. */
  terminal: number;
  backlog: ImportCoverageBacklog;
}

/**
 * The coverage issue's body, rewritten in place on every alarming run.
 *
 * Authoritative-as-of its own timestamp, and it says so: unlike a per-dataset
 * failure issue, this body is the current state rather than a historical record,
 * and a reader has to know which.
 *
 * **The counts balance by construction**, and that is not decoration. The same
 * discipline the Zarr index uses (`discovered == stores + failures + pending`) is
 * what makes a degraded read visible: an upstream scan that returns an empty
 * in-scope set would otherwise render as an ordinary drained backlog.
 *
 * Every term is counted OVER THE SCAN, and they are mutually exclusive in the same
 * precedence `diffNewDatasets` filters by, so the sum is exactly `discovered`. An
 * earlier version summed D1's set SIZES, which double-counted -- a dataset is
 * `imported` and `inFlight` for the whole duration of every import, and quarantine
 * keeps the `datasets` row -- so the report declared itself unreliable on every
 * healthy run. A balance line that cries wolf is worse than none: it teaches the
 * reader to discount the report, which is the muting failure ADR 0053 is written
 * against.
 *
 * Mirrors the scan no longer returns get their OWN row. They are drift, not a gap:
 * upstream deleted them, their snapshot resolver failed, or their modalities were
 * retagged out of scope.
 */
export function buildCoverageIssueBody(args: {
  verdict: ImportCoverageVerdict;
  facts: CoverageReportFacts;
  nowIso: string;
}): string {
  const f = args.facts;
  const b = f.backlog;
  const accounted =
    f.importedInScan +
    f.inFlight +
    f.terminal +
    b.neverAttempted.length +
    b.untracked.length +
    b.tracked.length +
    b.blocklisted.length;
  const balances = accounted === f.discovered;

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
    `| \`AUTO_IMPORT_ENABLED\` | ${f.enabled ? "`true`" : "not `true`"} |`,
    `| Last auto-import dispatch | ${f.lastDispatchAt ?? "never recorded"} (${dispatchPhrase(f.dispatchAgeHours)}) |`,
    `| ...which picked | ${f.lastDispatchSourceId ?? "n/a"} |`,
    "",
    "### Where every in-scope OpenNeuro dataset is",
    "",
    "| bucket | count | outstanding? |",
    "|---|---|---|",
    `| imported | ${f.importedInScan} | no |`,
    `| mid-import | ${f.inFlight} | no |`,
    `| quarantined or rolled back | ${f.terminal} | no |`,
    `| failed, tracked by its own issue | ${b.tracked.length} | no |`,
    `| blocklisted by the retry engine | ${b.blocklisted.length} | no |`,
    `| **never attempted** | **${b.neverAttempted.length}** | **yes** |`,
    `| **has a stale row nothing owns** | **${b.untracked.length}** | **yes** |`,
    `| total accounted for | ${accounted} | |`,
    `| in-scope on OpenNeuro | ${f.discovered} | |`,
    "",
    balances
      ? "Those two totals agree, so this is a complete view of what OpenNeuro currently offers."
      : `**They do not agree (${accounted} vs ${f.discovered}).** These are counted as a partition of the scan, so they can only disagree if the sweep's own bookkeeping is wrong -- treat the verdict above as unreliable and re-run before acting on it.`,
    "",
    `Separately, D1 holds ${f.imported} managed mirror(s), of which ${f.importedNotInScan} are no longer in the scan at all: upstream removed them, their snapshot could not be read, or their modalities were retagged out of scope. That is drift rather than a coverage gap, and it is expected to be non-zero.`,
    "",
    "Only the two bold rows drive this issue. Withdrawn datasets do not appear at all: a withdrawal keeps the imported row, so it is not a coverage gap.",
    "",
    "### Never attempted",
    "",
    idList(b.neverAttempted),
    ...(b.untracked.length > 0
      ? ["", "### Has a stale row nothing owns", "", idList(b.untracked)]
      : []),
    "",
    "## What to check",
    "",
    '1. Is `AUTO_IMPORT_ENABLED` `"true"` on the deployed worker? Only the exact string counts.',
    "2. Are the `*/30 * * * *` cron triggers still registered?",
    "3. Does the last dispatch name a dataset that never acquired an import row? Then the hand-off is failing after the audit row is written: check the datasets PAT and the onboard workflow.",
    "4. `nemar admin import-coverage` runs this same sweep on demand.",
    "",
    `Closed automatically once fewer than ${COVERAGE_BACKLOG_ALARM} datasets are outstanding and the importer is enabled. Filed by the import coverage sweep (nemarOrg/nemar-cli#1311).`,
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

/**
 * Comment left when the alarm stands down but the issue stays open, because the
 * importer is still switched off.
 *
 * A material change -- the body flips from ALARM to HEALTHY -- and the close path's
 * comment does not cover it, so without this a watcher would see the state change
 * with no notification. Fires once, not per run: the kind labels are cleared at the
 * same time, so the next run sees no kind and takes the silent refresh path.
 */
export function buildCoverageStandDownComment(
  verdict: ImportCoverageVerdict,
  nowIso: string,
): string {
  return [
    `Alarm stood down, issue kept open (${nowIso}).`,
    "",
    verdict.reason,
    "",
    "Nothing is accruing any more, so this is no longer an alarm -- but the importer is still off, and closing this would delete the only durable record of that. It closes automatically once the importer is enabled and coverage is healthy. Close it by hand if the importer is meant to stay off.",
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
