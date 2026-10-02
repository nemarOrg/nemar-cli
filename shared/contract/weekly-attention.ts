/**
 * Does this week need a person to look? One rule, shared by the weekly report's headline
 * (backend/src/services/import-weekly-summary.ts) and by `nemar admin import-weekly`'s exit
 * code (src/commands/admin.ts), so the two cannot drift (ADR 0054; epic #1586, phase 6).
 *
 * Before this file the command restated the rule by hand, and the Neurobagel reasons were added
 * to the headline and not to the command: an issue flagged a week for Neurobagel reasons and the
 * command exited 0 for the same week. A rule written twice is a rule that disagrees with itself.
 *
 * Pure, with no imports. The Neurobagel part carries VERDICTS AND COUNTS ONLY: the weekly report is
 * filed on a public-facing repository, and a dataset behind a finding may be an anonymous deposit,
 * so nothing here names a dataset, says what kind of finding a count is, or says which dataset
 * it concerns.
 */

export type WeeklyVerdict = "healthy" | "alarm" | "unknown" | "unchecked";

/** The four checks of the Neurobagel verification sweep. */
export const WEEKLY_NEUROBAGEL_CHECKS = ["store", "node", "registration", "drift"] as const;
export type WeeklyNeurobagelCheck = (typeof WEEKLY_NEUROBAGEL_CHECKS)[number];

/** Days by verdict. */
export interface VerdictDays {
  healthy: number;
  alarm: number;
  unknown: number;
  unchecked: number;
}

/**
 * The daily runs the Neurobagel verification sweep wrote in the window. The sweep runs once a
 * day, so a window of seven days expects this many rows; a cron that died on day two leaves
 * fewer, and silence is evidence only when there was work to do (ADR 0053).
 */
export const NEUROBAGEL_EXPECTED_DAILY_RUNS = 7;

/**
 * Daily runs allowed to be absent before the week asks for attention. One, because the window
 * ends at the moment the weekly job starts, which is the moment the day's own run starts, and
 * which of the two writes first is not defined.
 */
export const NEUROBAGEL_MISSED_RUNS_TOLERATED = 1;

export interface NeurobagelWeekly {
  /** Daily runs recorded in the window, and how many of them failed outright. */
  runs: number;
  failedRuns: number;
  /** Runs by their overall verdict. */
  days: VerdictDays;
  /** Days by verdict, for each check, so "not checked" can be said with a count. */
  checkDays: Record<WeeklyNeurobagelCheck, VerdictDays>;
  /** The most recent run in the window. */
  latest: {
    at: string;
    overall: WeeklyVerdict;
    checks: Record<WeeklyNeurobagelCheck, { verdict: WeeklyVerdict; reason: string }>;
  };
}

/** The facts the verdict reads. Every field a consumer may lack is allowed to be absent or null. */
export interface WeeklyAttentionFacts {
  week: string;
  coverageStatus: "healthy" | "alarm" | "unknown" | null;
  autoImportEnabled: boolean | null;
  dispatchLost: boolean | null;
  issuesClosed: number | null;
  /** The daily Neurobagel runs; null (or absent) when none was recorded in the window. */
  neurobagel?: NeurobagelWeekly | null;
  /**
   * Findings that need a person, counted over the window and over what stands, from every place
   * the feature records one. A count only: null when it could not be counted, and absent when
   * the consumer predates it, which is also unknown.
   */
  neurobagelFindings?: number | null;
  errors: { stage: string; error: string }[];
}

export interface WeeklyAttention {
  attention: boolean;
  /** One phrase per reason, in the order the headline lists them. */
  problems: string[];
  /** The Neurobagel checks that did not run on at least one day of the week. */
  notChecked: WeeklyNeurobagelCheck[];
}

/** The checks that were `unchecked` on at least one day, which a headline must not call normal. */
export function neurobagelNotChecked(n: NeurobagelWeekly): WeeklyNeurobagelCheck[] {
  return WEEKLY_NEUROBAGEL_CHECKS.filter((c) => n.checkDays[c].unchecked > 0);
}

export function weeklyAttention(f: WeeklyAttentionFacts): WeeklyAttention {
  const problems: string[] = [];
  if (f.coverageStatus === "alarm") problems.push("coverage is alarming");
  if (f.coverageStatus === "unknown") problems.push("coverage could not be determined");
  if (f.autoImportEnabled === false) problems.push("auto-import is OFF");
  if (f.dispatchLost === true) problems.push("dispatches are not landing");
  // An absence of sweep rows is an unknown that arrives WITHOUT an error entry, so it is the one
  // null the errors check below cannot see. The crons record every run, so no rows means they
  // did not run: the silence this epic is about.
  if (f.issuesClosed === null) {
    problems.push("no daily sweep activity was recorded, so the daily jobs may not be running");
  }

  const n = f.neurobagel ?? null;
  let notChecked: WeeklyNeurobagelCheck[] = [];
  if (n === null) {
    problems.push("no Neurobagel verification run was recorded, so that job may not be running");
  } else {
    notChecked = neurobagelNotChecked(n);
    if (n.latest.overall === "alarm") problems.push("Neurobagel verification is alarming");
    if (n.latest.overall === "unknown") {
      problems.push("Neurobagel verification could not be determined");
    }
    if (n.days.alarm > 0 && n.latest.overall !== "alarm") {
      problems.push(`Neurobagel verification alarmed on ${n.days.alarm} day(s) this week`);
    }
    if (n.days.unknown > 0 && n.latest.overall !== "unknown") {
      problems.push(`Neurobagel verification could not be determined on ${n.days.unknown} day(s)`);
    }
    if (n.failedRuns > 0) {
      problems.push(`the Neurobagel sweep itself failed on ${n.failedRuns} run(s)`);
    }
    const missed = Math.max(0, NEUROBAGEL_EXPECTED_DAILY_RUNS - n.runs);
    if (missed > NEUROBAGEL_MISSED_RUNS_TOLERATED) {
      problems.push(
        `the daily Neurobagel verification is missing for ${missed} of ${NEUROBAGEL_EXPECTED_DAILY_RUNS} day(s)`,
      );
    }
  }
  // Findings are folded in with no label of their own and no kind: the headline of a public
  // report says that something needs a person, and the audit log says what.
  if (f.neurobagelFindings === null || f.neurobagelFindings === undefined) {
    problems.push("Neurobagel findings could not be counted");
  } else if (f.neurobagelFindings > 0) {
    problems.push(
      `${f.neurobagelFindings} Neurobagel finding(s) need attention (see the audit log)`,
    );
  }
  if (f.errors.length > 0) problems.push(`${f.errors.length} part(s) of this report failed`);
  return { attention: problems.length > 0, problems, notChecked };
}
