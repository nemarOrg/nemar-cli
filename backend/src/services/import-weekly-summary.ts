/**
 * Weekly import summary DECISIONS and report body (epic #1306 phase 4, #1312).
 * Pure, no I/O.
 *
 * ## Why an unconditional report
 *
 * Phases 1-3 made the pipeline able to describe its own state. This phase makes
 * someone read it.
 *
 * An alarm fires only when a threshold trips, and the seven-week outage produced
 * no alarm because no threshold existed. A report that appears only when something
 * breaks cannot distinguish a healthy week from a broken reporter -- both look like
 * silence. So this arrives every week whether or not anything is wrong, which is
 * what makes "no news" mean something.
 *
 * ## Unknown is a value, and it is not zero
 *
 * The rule this phase turns on. "0 imports" and "no data about imports" looked alike,
 * and that is how the original incident stayed invisible: a dashboard full of zeroes
 * reads as a quiet week. So every count here is `number | null`, and `null` renders as
 * `unknown`.
 *
 * Every COUNT goes through one renderer ({@link count}), because a ternary per field is
 * how one of them eventually renders `0`. The handful of non-count fields -- the two
 * booleans and the dispatch phrase -- necessarily have their own three-way rendering,
 * and review found three of them unpinned, so each now has its own test: a
 * `dispatchLost === null` that rendered as `yes` is "the reporter could not see, and
 * said everything is fine", which is the founding failure exactly.
 */

import {
  NEUROBAGEL_EXPECTED_DAILY_RUNS,
  type NeurobagelWeekly,
  WEEKLY_NEUROBAGEL_CHECKS,
  weeklyAttention,
} from "../../../shared/contract/weekly-attention.js";
import {
  type RepullCapReading,
  type RepullSchedulerRow,
  type RepullWeekFacts,
  type WordCounts,
  type WordList,
  publicWord,
} from "../../../shared/repull-observability.js";
import {
  UPSTREAM_STATES,
  type UpstreamFleetSummary,
  type UpstreamState,
} from "../../../shared/upstream-staleness.js";

export type { NeurobagelWeekly };

/**
 * Rows to name before falling back to a count.
 *
 * The spirit of ADR 0036 -- an operational record carries counts and pointers, not an
 * unbounded dump -- though note 0036 is stricter than this about truncation
 * specifically. What it forbids is inlining detail that belongs elsewhere; a bounded
 * list plus an explicit "and N more" is a pointer, and the count above it is never
 * truncated.
 */
export const WEEKLY_MAX_LISTED_IDS = 20;

/**
 * The ISO-8601 week label, e.g. `2026-W37`.
 *
 * Zero-padded to two digits, which both the inverse parser and the lexical sort
 * depend on: `2026-W9` would sort after `2026-W10` and would not match a `\d{2}`
 * regex.
 *
 * ISO weeks start on Monday and week 1 is the week containing the first Thursday
 * of January -- equivalently, the week containing January 4th. The consequence
 * that makes this worth its own function and its own boundary tests: the ISO year
 * is NOT always the calendar year. 2027-01-01 is a Friday, so it belongs to
 * 2026-W53; 2024-12-30 is a Monday, so it belongs to 2025-W01. Deriving the label
 * from `getUTCFullYear()` would mislabel both, and a mislabelled week silently
 * breaks the title-as-dedup-key: two different weeks could claim one title, or one
 * week could be filed twice under two.
 *
 * The algorithm is the standard one: move to the Thursday of the current ISO week
 * (Thursday is always in the same ISO year as its week), then count weeks from
 * that year's January 4th.
 */
export function isoWeekLabel(now: Date): string {
  // Work in UTC only. A local-time reading would shift the week boundary by the
  // host's offset, and the Worker's clock is UTC while a developer's is not.
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // getUTCDay: 0 = Sunday. ISO counts Monday = 1 ... Sunday = 7.
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  // Thursday of this ISO week: the day that determines the ISO year.
  d.setUTCDate(d.getUTCDate() + 4 - isoDay);
  const isoYear = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4IsoDay = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  // Monday of week 1.
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() + 1 - jan4IsoDay);
  const week = Math.floor((d.getTime() - week1Monday.getTime()) / 604_800_000) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * Is today the day the weekly summary posts?
 *
 * Monday UTC, matching `check-summary-drift.yml`, the repo's other weekly
 * cadence (`* * 1`). `bump-validator.yml` runs monthly, so it is not a second
 * weekly rhythm.
 *
 * The daily cron fires at 03:00 UTC, so the report covers the week ending Monday
 * 03:00 UTC. That is stated in the body: an unstated window cannot be checked
 * against anything.
 */
export function shouldRunWeeklySummary(now: Date): boolean {
  return now.getUTCDay() === 1;
}

/**
 * Has this week's summary already been posted?
 *
 * Same shape as `decideAutoImportGate`, and deliberately the OPPOSITE failure
 * direction. Auto-import fails OPEN on an unreadable last-dispatch timestamp,
 * because a skipped import is worse than an early one. Here an unreadable
 * timestamp fails CLOSED: the daily cron evaluates this once a day, so a gate that
 * failed open on a bad value would post a duplicate weekly issue every day for as
 * long as the value stayed bad -- which is precisely the notification fatigue this
 * epic exists to prevent, arriving from the tool built to prevent it.
 *
 * A skipped week costs one missing report and is visible as a gap in the series,
 * because the titles are week-labelled and therefore sortable.
 */
export function decideWeeklySummaryGate(args: {
  /** `audit_log.timestamp` of the last posted summary, or null if never. */
  lastRunAt: string | null;
  /** Parsed form of the same, or null when it could not be read. Passed separately so
   *  this module needs no import from `auto-import.ts`, which is where `parseSqliteUtc`
   *  lives -- the function is pure, so purity is not the reason. */
  lastRunMs: number | null;
  now: Date;
}): { proceed: boolean; reason: string } {
  if (args.lastRunAt === null) {
    return { proceed: true, reason: "no weekly summary has ever been posted" };
  }
  if (args.lastRunMs === null) {
    return {
      proceed: false,
      reason: `last weekly summary timestamp is unreadable (${JSON.stringify(args.lastRunAt)}); refusing to post rather than risk one issue per day`,
    };
  }
  const lastWeek = isoWeekLabel(new Date(args.lastRunMs));
  const thisWeek = isoWeekLabel(args.now);
  if (lastWeek === thisWeek) {
    return { proceed: false, reason: `already posted for ${thisWeek}` };
  }
  return { proceed: true, reason: `last posted for ${lastWeek}, now ${thisWeek}` };
}

// ============================================================================
// Report content
// ============================================================================

/**
 * Render a count that may be unknown.
 *
 * The ONE renderer, used for every number in the report. A per-field ternary is
 * how one field eventually renders `unknown` as `0`, which is the single mistake
 * this phase exists to prevent -- see the module header.
 */
export function count(n: number | null): string {
  return n === null ? "unknown" : String(n);
}

/** Days between an anchor and now, or null when the anchor is unreadable. */
export function daysSince(anchorMs: number | null, nowMs: number): number | null {
  if (anchorMs === null) return null;
  return Math.max(0, Math.floor((nowMs - anchorMs) / 86_400_000));
}

/** One blocklisted dataset, with how long it has been parked. */
export interface ParkedDataset {
  datasetId: string;
  reason: string | null;
  /** From `first_incomplete_at`, the only write-once anchor. `null` when that
   *  column is NULL -- possible on rows predating #969 -- and then the duration is
   *  genuinely unknown rather than zero. */
  parkedDays: number | null;
}

/** Everything the body renders. Every count is nullable, and null means the sweep
 *  could not determine it. */
export interface WeeklySummaryFacts {
  /** The ISO week this report covers. */
  week: string;
  /** Start of the covered window, ISO 8601, so the window is checkable. */
  windowStart: string;
  windowEnd: string;

  /** OpenNeuro mirrors created in the window. */
  importedThisWeek: number | null;
  /** Managed OpenNeuro mirrors in total. */
  importedTotal: number | null;

  /** Coverage, from phase 3's sweep. `null` throughout when its verdict was
   *  `unknown`, because a coverage number the sweep could not establish must not
   *  render as zero. */
  coverageStatus: "healthy" | "alarm" | "unknown" | null;
  coverageReason: string | null;
  outstanding: number | null;
  discovered: number | null;
  importedNotInScan: number | null;

  /** Dispatch liveness. */
  autoImportEnabled: boolean | null;
  dispatchPhrase: string | null;
  dispatchLost: boolean | null;

  /** Open failures grouped by classified cause label, zero-filled so every cause
   *  appears. `null` when the query itself failed. */
  failuresByCause: Record<string, number> | null;
  openFailureTotal: number | null;

  /** Blocklisted datasets, longest-parked first. `null` when unavailable. */
  parked: ParkedDataset[] | null;

  /** What the daily sweeps did in the window, read from `audit_log`. `null` until
   *  the crons have written their first rows -- correct, not a bug. */
  issuesClosed: number | null;
  issuesRelabelled: number | null;

  /** The Neurobagel verification sweep. `null` when no daily run was recorded in the window
   *  (it writes a heartbeat on every run, so none means it did not run: unknown, not zero). */
  neurobagel: NeurobagelWeekly | null;
  /**
   * Findings in the Neurobagel feature that need a person, counted over the window and over what
   * stands, from every place the feature records one, and independent of whether the daily sweep
   * wrote a row. A COUNT only: it carries no kind and no identifier, because the report is filed
   * on a public-facing repository. `null` when it could not be counted, which is unknown.
   */
  neurobagelFindings: number | null;

  /**
   * The upstream freshness pass (epic #1046 phase 4b): counts by state over the managed mirrors,
   * no dataset named. `null` when the pass did not run or failed: unknown, not zero. Stale is
   * reported, not attention (ADR 0053); blindness is (see `gatherUpstream`).
   */
  upstream: UpstreamFleetSummary | null;

  /**
   * The upstream re-pulls' week (epic #1046 phase 7, ADR 0111): the switches in force, the
   * scheduler's last tick, the dispatches and merges counted, and the reasons a person should
   * look. Counts and fixed words, no dataset named: the report is filed on a public-facing
   * repository. `null` when the read failed: unknown, not zero, and a failed part is listed.
   */
  repulls: RepullWeekFacts | null;

  /** Anything that went wrong producing this report. Listed, never swallowed. */
  errors: { stage: string; error: string }[];
}

/**
 * Is anything in this report worth a human's attention?
 *
 * Drives the first line, so an unhealthy week is obvious without scrolling. An
 * `unknown` counts as needing attention: a report that cannot see is not a report
 * that found nothing.
 */
export function weeklyHeadline(f: WeeklySummaryFacts): { attention: boolean; line: string } {
  // ONE rule, in shared/contract: `nemar admin import-weekly` takes its exit code from the same
  // function, so the issue and the command cannot disagree about a week.
  const { attention, problems, notChecked } = weeklyAttention(f);
  if (!attention) {
    // Never "all look normal" over a check that did not run: what was not checked is said.
    const neurobagel =
      notChecked.length > 0
        ? ` Neurobagel verification did not run these checks on at least one day: ${notChecked.join(", ")}.`
        : " All four Neurobagel checks ran and look normal.";
    return {
      attention: false,
      // Names what was actually checked. It deliberately does not speak for open
      // failures or the blocklist: phases 2 and 3 own those, and a report that claimed
      // "all normal" while 40 failures sat below it would be overclaiming.
      line: `**Nothing needs attention this week.** Auto-import, coverage, dispatch and the daily sweeps look normal for ${f.week}.${neurobagel}`,
    };
  }
  return {
    attention: true,
    line: `**Needs attention:** ${problems.join("; ")}.`,
  };
}

/**
 * The weekly summary issue body.
 *
 * Written ONCE, at creation, and never rewritten -- this is a historical record of
 * a closed window, which is phase 2's rollup shape rather than phase 3's
 * current-state shape. A rewritten body would silently restate last week's numbers
 * from a different instant than the window it claims to describe.
 *
 * The first two lines carry the verdict; everything after is deliberately boring
 * and scannable, because a report that is exciting every week gets skimmed.
 */
export function buildWeeklySummaryBody(f: WeeklySummaryFacts, nowIso: string): string {
  const head = weeklyHeadline(f);
  const causeRows = f.failuresByCause
    ? Object.entries(f.failuresByCause)
        .filter(([, n]) => n > 0)
        .map(([label, n]) => `| \`${label}\` | ${n} |`)
    : [];

  return [
    `# Import summary, ${f.week}`,
    "",
    head.line,
    "",
    `Covers ${f.windowStart} to ${f.windowEnd} (UTC). Generated ${nowIso}.`,
    "",
    "cc @nemarAdmin",
    "",
    "## Imports",
    "",
    "| | |",
    "|---|---|",
    `| Imported this week | ${count(f.importedThisWeek)} |`,
    `| Managed OpenNeuro mirrors in total | ${count(f.importedTotal)} |`,
    `| In scope on OpenNeuro | ${count(f.discovered)} |`,
    `| Mirrors no longer in scope upstream | ${count(f.importedNotInScan)} |`,
    "",
    "## Coverage",
    "",
    f.coverageStatus === null
      ? "The coverage sweep did not run for this report, so none of its numbers are available. This is **unknown**, not zero."
      : `Verdict: **${f.coverageStatus.toUpperCase()}**. ${f.coverageReason ?? ""}`,
    "",
    `Datasets outstanding (nothing is working on them): ${count(f.outstanding)}`,
    "",
    "## Upstream freshness",
    "",
    ...upstreamSection(f.upstream),
    "",
    "## Upstream re-pulls",
    "",
    ...repullSection(f.repulls),
    "",
    "## Dispatch liveness",
    "",
    "| | |",
    "|---|---|",
    `| \`AUTO_IMPORT_ENABLED\` | ${f.autoImportEnabled === null ? "unknown" : f.autoImportEnabled ? "`true`" : "**not `true`**"} |`,
    `| Last dispatch | ${f.dispatchPhrase ?? "unknown"} |`,
    `| Dispatches landing | ${f.dispatchLost === null ? "unknown" : f.dispatchLost ? "**no**" : "yes"} |`,
    "",
    "## Open failures by cause",
    "",
    f.failuresByCause === null
      ? "Could not be read this week: **unknown**, not zero."
      : causeRows.length === 0
        ? `No open failures. (Total: ${count(f.openFailureTotal)}.)`
        : [
            "| cause | datasets |",
            "|---|---|",
            ...causeRows,
            "",
            `Total: ${count(f.openFailureTotal)}.`,
          ].join("\n"),
    "",
    "## What the daily sweeps did this week",
    "",
    f.issuesClosed === null && f.issuesRelabelled === null
      ? "**No sweep activity was recorded at all for this window, which is unknown rather than zero.** The daily crons write a row on every run, so an absence of rows means they did not run -- not that they ran and found nothing. (In the first week after this report shipped it also just means the rows did not exist yet.)"
      : `Tracking issues closed on recovery: ${count(f.issuesClosed)}. Relabelled after a cause change: ${count(f.issuesRelabelled)}.`,
    "",
    "## Neurobagel federation",
    "",
    ...neurobagelSection(f.neurobagel, f.neurobagelFindings),
    "",
    "## Blocklisted datasets",
    "",
    f.parked === null
      ? "Could not be read this week: **unknown**, not zero."
      : f.parked.length === 0
        ? "_none_"
        : [
            "| dataset | reason | parked |",
            "|---|---|---|",
            ...f.parked
              .slice(0, WEEKLY_MAX_LISTED_IDS)
              .map(
                (p) =>
                  `| ${p.datasetId} | ${p.reason ?? "unknown"} | ${p.parkedDays === null ? "unknown" : `${p.parkedDays} days`} |`,
              ),
            ...(f.parked.length > WEEKLY_MAX_LISTED_IDS
              ? ["", `...and ${f.parked.length - WEEKLY_MAX_LISTED_IDS} more.`]
              : []),
          ].join("\n"),
    "",
    ...(f.errors.length > 0
      ? [
          "## Parts of this report that failed",
          "",
          "Listed rather than omitted, so a gap is never mistaken for a zero.",
          "",
          ...f.errors.map((e) => `- \`${e.stage}\`: ${e.error}`),
          "",
        ]
      : []),
    "---",
    "",
    "Posted weekly by the import summary job whether or not anything is wrong (nemarOrg/nemar-cli#1312), because a report that only appears when something breaks cannot tell a healthy week from a broken reporter. Last week's summary is closed automatically when this one is filed; its content stays readable.",
  ].join("\n");
}

/** The plain label of each upstream state, in the order the section lists them. */
const UPSTREAM_LABELS: Record<UpstreamState, string> = {
  current: "At upstream's latest snapshot",
  stale_ready: "Behind upstream, new tag on the GitHub mirror",
  mirror_lag: "Behind upstream, new tag not on the GitHub mirror yet",
  stale_unverified: "Behind upstream, GitHub mirror not checked",
  anomaly: "Upstream and NEMAR disagree",
  unknown: "Tag unknown (not compared)",
  not_examined: "Tag never examined",
  unpublished: "No NEMAR version yet",
  in_progress: "Import running",
  parked: "Parked",
  unchecked: "Could not be compared (OpenNeuro unavailable)",
};

/**
 * The upstream freshness section: counts only, rendered through {@link count}, no dataset named
 * (the report is filed on a public-facing repository). `null` is unknown, never zero, and an
 * unknown-tag mirror is said to be NOT compared, so it is never read as verified clean.
 */
function upstreamSection(u: UpstreamFleetSummary | null): string[] {
  if (u === null) {
    return [
      "The upstream freshness pass did not run or failed, so none of its numbers are available. This is **unknown**, not zero.",
    ];
  }
  // Compared with upstream: a verdict from OpenNeuro's snapshot list. An anomaly counts unless it
  // is a source id mismatch, which is settled from NEMAR's own row before OpenNeuro is asked.
  const compared =
    u.counts.states.current +
    u.counts.stale +
    u.counts.states.anomaly -
    u.counts.anomalies.source_id_mismatch;
  return [
    `Examined ${count(u.examined)} of ${count(u.population)} managed OpenNeuro mirrors (${count(u.withdrawn)} withdrawn and ${count(u.excluded_unmanaged)} other rows left out); ${count(compared)} of them were compared with upstream.${u.truncated ? " **The pass did not reach every mirror.**" : ""}`,
    "",
    "| state | mirrors |",
    "|---|---|",
    ...UPSTREAM_STATES.map((s) => `| ${UPSTREAM_LABELS[s]} | ${count(u.counts.states[s])} |`),
    "",
    `Stale in total: ${count(u.counts.stale)}. Tag unknown and probably stale by date: ${count(u.counts.probably_stale)} (display only, not counted as stale).`,
    "",
    "A stale mirror is reported, not an alarm: being behind upstream is an expected state, not a fault. Mirrors with an unknown tag, never examined, with no version yet, with an import running or parked, and those whose source id does not match were not compared.",
    "",
    'How the three "Behind upstream" rows divide depends on the 25 GitHub checks one weekly pass makes; it is not a fleet-wide proportion.',
    "",
    "Names and reasons: `nemar admin upstream-status`.",
  ];
}

/** When a tick last ran, or that nothing has stamped it yet (which is not the same as unknown). */
function ranText(what: string, at: string | null): string {
  return at === null ? `${what} has no recorded run` : `${what} last ran ${at} UTC`;
}

/** A cap as the Worker reads it; an unreadable one is said to read 0, which stops the work. */
function capText(c: RepullCapReading): string {
  return c.source === "unreadable"
    ? "**unreadable**, so it reads 0"
    : `${count(c.value)} (${c.source === "set" ? "set" : "the default"})`;
}

/** The scheduler's stamps in a sentence; a row the report could not find is unknown, not "never". */
function schedulerText(s: RepullSchedulerRow | null): string {
  if (s === null) {
    return "The scheduler's row could not be found, so when it last ran is **unknown**, not never.";
  }
  // The outcome is a word like any other: printed only from its closed list (`publicWord`).
  const outcome =
    s.last_outcome === null ? "" : ` and concluded \`${publicWord(s.last_outcome, "outcome")}\``;
  return `${ranText("The scheduler's daily tick", s.last_tick_at)}${outcome}. ${ranText("The advance tick", s.last_advance_at)}.`;
}

/**
 * A table of fixed words and their counts, or nothing when there are none. Every word goes through
 * {@link publicWord} for the list it belongs to and the counts of the words that come to the same
 * one are added, because the report is filed on a public-facing repository: a fact that holds a
 * dataset id where a word should be prints as `other`, whoever made the fact.
 */
function wordTable(title: string, words: WordCounts, list: WordList): string[] {
  const printable: WordCounts = {};
  for (const [word, n] of Object.entries(words)) {
    const printed = publicWord(word, list);
    printable[printed] = (printable[printed] ?? 0) + n;
  }
  const rows = Object.entries(printable).sort(([a], [b]) => a.localeCompare(b));
  if (rows.length === 0) return [];
  return [
    "",
    `${title}:`,
    "",
    "| word | count |",
    "|---|---|",
    ...rows.map(([word, n]) => `| \`${word}\` | ${count(n)} |`),
  ];
}

/**
 * The upstream re-pulls' section (epic #1046 phase 7, ADR 0111): counts only, rendered through
 * {@link count}, no dataset named, and present every week whether or not any work was done (ADR
 * 0054: a quiet week with the switches off is a true zero, and a missing section would read as
 * "nothing to report"). `null` is unknown, never zero. What raises attention is decided by
 * `repullAttention` and reaches the headline through the shared rule, not here.
 */
function repullSection(r: RepullWeekFacts | null): string[] {
  // `== null`: an absent field is unknown too, as in the log line, never a render that throws.
  if (r == null) {
    return [
      "The upstream re-pull counts could not be read, so none of their numbers are available. This is **unknown**, not zero.",
    ];
  }
  const on = (v: boolean) => (v ? "**on**" : "off");
  const s = r.switches;
  const d = r.dispatches;
  return [
    `Open switch (\`AUTO_REPULL_ENABLED\`): ${on(s.auto_repull_enabled)}. Merge switch (\`AUTO_REPULL_MERGE_ENABLED\`): ${on(s.auto_repull_merge_enabled)}.${s.environment_is_production ? "" : " This is not the production Worker, so neither switch is honored."} Daily open cap: ${capText(s.open_cap)}. Daily merge cap: ${capText(s.merge_cap)}.`,
    "",
    schedulerText(r.scheduler),
    "",
    "| | |",
    "|---|---|",
    `| Dispatches sent this week | ${count(d.sent)} |`,
    `| Opened a pull request | ${count(d.by_status.opened)} |`,
    `| Finished after a merge | ${count(d.by_status.finished)} |`,
    `| Refused by the run | ${count(d.by_status.refused)} |`,
    `| Failed in the run | ${count(d.by_status.failed)} |`,
    `| Not reported in time | ${count(d.by_status.unreported)} |`,
    `| Not accepted by GitHub | ${count(d.by_status.dispatch_failed)} |`,
    `| Still running | ${count(d.by_status.dispatched + d.by_status.started)} |`,
    `| Open automatic re-pulls now | ${count(r.open_automatic.total)} |`,
    `| Of those, held | ${count(r.open_automatic.held)} |`,
    `| Claims to merge held over an hour | ${count(r.held_claims)} |`,
    `| Re-pulls that ended failed this week | ${count(r.ended_failed)} |`,
    `| Merged by the Worker | ${count(r.merged.worker)} |`,
    `| Merged by an administrator | ${count(r.merged.administrator)} |`,
    `| Merged outside NEMAR's tools | ${count(r.merged.outside_tool)} |`,
    `| Merged, claim not in the audit log | ${count(r.merged.unattributed)} |`,
    ...wordTable("Refused by the run, by word", d.by_word.refused, "code"),
    ...wordTable("Failed in the run, by word", d.by_word.failed, "code"),
    ...wordTable("Not accepted by GitHub, by word", d.by_word.dispatch_failed, "code"),
    ...wordTable("Held automatic re-pulls, by word", r.open_automatic.holds, "hold"),
    "",
    "A dispatch is counted in the week it was sent, in the state it has when this report is made. A switch that is off, a re-pull waiting on a gate (the identifier screen, the review, BIDS validation) and a run's refusal are expected and are not an alarm. What asks for attention is a scheduler that stopped while a switch is on, a dispatch nobody answered, a claim to merge held for an hour, a re-pull that ended failed, a re-pull that used all its resumes or all its finish runs, and a cap that cannot be read; every other hold is counted in its table and does not ask.",
    "",
    "Names and reasons: `nemar admin repull auto`.",
  ];
}

/**
 * The Neurobagel section. Counts and verdicts, and each check's own one-sentence reason (which
 * the sweep writes generically, with counts and public upstream tags only). `unchecked` is
 * printed as "unchecked": a check that is not configured here is neither good news nor zero.
 *
 * The findings line is a count with no label of its own: the report is filed on a
 * public-facing repository, and what the findings are lives in the audit log.
 */
function neurobagelSection(n: NeurobagelWeekly | null, findings: number | null): string[] {
  const findingsLine = `Findings that need a person, over the window and what stands: ${count(findings)}. A count only: the audit log holds the detail.`;
  if (n === null) {
    return [
      "**No daily verification run was recorded in this window, which is unknown rather than zero.** The sweep writes a row on every run, so an absence of rows means it did not run, not that it ran and found nothing. (In the first week after this section shipped it also just means the rows did not exist yet.)",
      "",
      findingsLine,
    ];
  }
  const verdicts = WEEKLY_NEUROBAGEL_CHECKS.map(
    (name) => `| ${name} | ${n.latest.checks[name].verdict} | ${n.latest.checks[name].reason} |`,
  );
  const notRun = WEEKLY_NEUROBAGEL_CHECKS.filter((c) => n.checkDays[c].unchecked > 0).map(
    (c) => `${c} ${n.checkDays[c].unchecked} day(s)`,
  );
  return [
    `Latest daily run (${n.latest.at}): **${n.latest.overall.toUpperCase()}**.`,
    "",
    "| check | verdict | what it found |",
    "|---|---|---|",
    ...verdicts,
    "",
    `Daily runs in this window: ${n.runs} of ${NEUROBAGEL_EXPECTED_DAILY_RUNS} expected (healthy ${n.days.healthy}, alarm ${n.days.alarm}, unknown ${n.days.unknown}, unchecked ${n.days.unchecked}; the sweep itself failed on ${n.failedRuns}).`,
    "",
    notRun.length > 0
      ? `Checks that did not run: ${notRun.join(", ")}.`
      : "Every check ran on every recorded day.",
    "",
    findingsLine,
  ];
}

/** Comment left on the previous week's issue as it is closed, so the series is
 *  navigable in both directions. */
export function buildWeeklyRolloverComment(
  nextWeek: string,
  nextIssue: number,
  nowIso: string,
): string {
  return [
    // A bare `#N`, not `owner/repo#N`: the comment is posted on the same repo the
    // successor was filed on, so GitHub renders it as a link either way, and leaving
    // the repo name out keeps this module with no imports at all.
    `Superseded by the ${nextWeek} summary, #${nextIssue} (${nowIso}).`,
    "",
    "Closed automatically. The numbers above describe the window in the title and are not updated.",
  ].join("\n");
}

/** One-line summary for the cron log. Hand-rolled rather than via `sweepLogLines`,
 *  which needs `processed`/`remaining`/per-dataset errors that a fleet-level weekly
 *  report does not have -- the same reason phases 2 and 3 hand-roll theirs. */
export function weeklySummaryLogLine(f: WeeklySummaryFacts, issue: number | null): string {
  return (
    `week=${f.week} attention=${weeklyHeadline(f).attention} ` +
    `imported_this_week=${count(f.importedThisWeek)} total=${count(f.importedTotal)} ` +
    `outstanding=${count(f.outstanding)} open_failures=${count(f.openFailureTotal)} ` +
    `parked=${f.parked === null ? "unknown" : f.parked.length} ` +
    `closed=${count(f.issuesClosed)} relabelled=${count(f.issuesRelabelled)} ` +
    `neurobagel=${f.neurobagel === null ? "unknown" : f.neurobagel.latest.overall} ` +
    `neurobagel_findings=${count(f.neurobagelFindings)} ` +
    `upstream_stale=${f.upstream === null ? "unknown" : count(f.upstream.counts.stale)} ` +
    `upstream_unchecked=${f.upstream === null ? "unknown" : count(f.upstream.counts.states.unchecked)} ` +
    `repull_dispatched=${f.repulls == null ? "unknown" : count(f.repulls.dispatches.sent)} ` +
    `repull_merged_worker=${f.repulls == null ? "unknown" : count(f.repulls.merged.worker)} ` +
    `repull_unreported=${f.repulls == null ? "unknown" : count(f.repulls.dispatches.by_status.unreported)} ` +
    `issue=${issue === null ? "none" : `#${issue}`} errors=${f.errors.length}`
  );
}
