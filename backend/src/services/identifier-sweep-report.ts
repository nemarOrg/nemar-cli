/**
 * The identifier sweep's weekly report (epic #1610, phase 5, ADR 0088). Pure:
 * facts in, words out, no I/O.
 *
 * **Derived, not stored** (ADR 0034). Whether a dataset was screened this
 * cycle, and if not why, is read off its stamps and the report's own clock
 * every time; nothing records "covered" or "overdue".
 *
 * **Unknown is not zero** (ADR 0054). Every count is `number | null` and goes
 * through the one renderer, {@link count}; a fact that could not be read is
 * `unknown`, and an unknown counts as needing attention.
 *
 * **A finding stays listed** until a complete screen, or a newer finding,
 * replaces it: not when its screen ages out of the cycle, not when a later
 * screen was incomplete, and not when its stored report stops reading back.
 *
 * **The words are the screen's.** A verdict is named with `screenStateLabel`,
 * a cause with `screenErrorText`, kinds with `kindsPhrase`, all from
 * `shared/identifier-screen-report.ts`, so the publication email, the status
 * views and this report cannot call one thing by two names. A line carries
 * dataset ids, kinds, counts, dates and those words, never a value.
 */

import {
  DATASET_STATUSES,
  type DatasetStatus,
  SCREEN_ERRORS,
  SCREEN_NOT_READ,
  type ScreenError,
  type ScreenReport,
  kindsPhrase,
  parseScreenReport,
  screenErrorText,
  screenStateLabel,
} from "../../../shared/identifier-screen-report.js";
import { parseSqliteUtc } from "./auto-import.js";
import { count, isoWeekLabel } from "./import-weekly-summary.js";

/** One in-scope dataset as the rows query returns it. Every stamp is untrusted. */
export interface IdentifierSweepRow {
  dataset_id: string;
  latest_version: string | null;
  /** `json_type(sweep_stamps)`: `object`, null for no stamps, anything else for a row that cannot hold them. */
  stamps_type?: unknown;
  status: unknown;
  checked_at: unknown;
  version: unknown;
  report: unknown;
  /** The finding an incomplete screen kept (`{ status, checked_at, report }` as JSON text). */
  finding?: unknown;
  attempt: unknown;
  attempt_error: unknown;
  attempted_at: unknown;
  requested_at: unknown;
}

/** Verdicts that found something: the ones listed by id. */
export const FINDING_STATUSES = ["direct-identifiers", "review"] as const;
const FINDING_SET: ReadonlySet<string> = new Set(FINDING_STATUSES);

/** Verdicts of a screen that ran but cannot parse some of the recordings' formats. */
const PARTIAL_COVERAGE: ReadonlySet<string> = new Set([
  "not-screened",
  "clean-edf-only-others-unscreened",
]);

/**
 * Why a dataset is not screened this cycle.
 *
 * - `never-screened`: no verdict was ever stored.
 * - `unreadable`: a verdict is recorded but its report, status or time does not
 *   read back (a row edited by hand, a time in the future, or a report written
 *   under an older contract). Not clean, and not "never" either.
 * - `expired`: the last verdict is older than the cycle.
 * - `new-version`: the last verdict is of an older version than the latest.
 * - `incomplete`: the last screen ran and could not read everything it can
 *   parse (`scan.incomplete`, whatever it found).
 */
export const UNCHECKED_REASONS = [
  "never-screened",
  "unreadable",
  "expired",
  "new-version",
  "incomplete",
] as const;
export type UncheckedReason = (typeof UNCHECKED_REASONS)[number];

const UNCHECKED_WORDS: Record<UncheckedReason, string> = {
  "never-screened": "never screened",
  unreadable: "the stored result does not read back",
  expired: "the last screen is older than the cycle",
  "new-version": "a newer version has not been screened",
  incomplete: "the last screen was INCOMPLETE",
};

/**
 * What the last attempt of an unchecked dataset came to: `in-flight` (a screen
 * is running), `queued` (not attempted since it came due), a `ScreenError`
 * word, or `unknown` when the attempt does not read back.
 */
export type AttemptNote = "in-flight" | "queued" | "unknown" | ScreenError;

/** A dataset whose last finding is listed, with its kinds and counts. */
export interface FlaggedDataset {
  dataset_id: string;
  /** When that finding's screen was stored, `YYYY-MM-DD`, or null when its time does not read back. */
  screened_on: string | null;
  /**
   * Where the finding stands: `current` (the dataset's verdict, in the cycle),
   * an unchecked reason (the verdict, lapsed or incomplete; `unreadable` when
   * only its status reads back), or `earlier` (an earlier screen's finding,
   * kept because every screen since was incomplete).
   */
  standing: "current" | UncheckedReason | "earlier";
  /** Null when the finding's report does not read back. */
  findings_by_kind: Partial<Record<string, number>> | null;
  edf_bdf_files_flagged: number | null;
}

/** Everything the report says. Every count is nullable, and null means it could not be read. */
export interface IdentifierWeekFacts {
  /** The ISO week the report covers (the week before it was made). */
  week: string;
  windowStart: string;
  windowEnd: string;
  /** The instant the cycle figures are as of. */
  asOf: string;
  cycleDays: number;
  /** Public datasets the sweep screens. */
  scope: number | null;
  /** Datasets screened this cycle (a verdict at most `cycleDays` old, of the latest version, complete). */
  screened: number | null;
  /** Of those, verdicts whose screen could not parse some recordings' formats. */
  partialCoverage: number | null;
  /** Screened datasets by verdict. */
  byStatus: Partial<Record<DatasetStatus, number>> | null;
  unchecked: number | null;
  uncheckedByReason: Record<UncheckedReason, number> | null;
  /** Over every unchecked dataset that is not `incomplete`: what its last attempt came to. */
  lastAttempt: Partial<Record<AttemptNote, number>> | null;
  /** Over every `incomplete` dataset: how many datasets carry each reason. */
  incompleteReasons: Record<string, number> | null;
  /**
   * Datasets whose most recent screen was dispatched in the window: GitHub took
   * it, or may have. A claim that never reached GitHub (no credential, no
   * repository, a refusal) is not counted. Only the latest attempt per dataset
   * is kept, so this counts datasets, not runs.
   */
  dispatchedInWindow: number | null;
  /** Datasets whose verdict was stored in the window. */
  storedInWindow: number | null;
  /**
   * Datasets whose most recent attempt was in the window and ended without a
   * verdict (`error` or `unreported`), whatever their verdict's age: a refused
   * or silent workflow shows here before any verdict lapses.
   */
  failedInWindow: number | null;
  /** The earliest most-recent attempt of any dataset, ISO; null when no attempt was ever made. */
  firstAttemptAt: string | null;
  /** Datasets the queue would take now. */
  due: number | null;
  /** Datasets owed a screen at all: due, or due and waiting out a retry backoff. */
  owed: number | null;
  /** Datasets whose last finding found direct identifiers. */
  flagged: FlaggedDataset[] | null;
  /** Datasets whose last finding needs review. */
  review: FlaggedDataset[] | null;
  /** What could not be read, in fixed words. */
  errors: string[];
}

/** The week the report covers: the ISO week before `now`'s, Monday 00:00 to Monday 00:00 UTC. */
export function reportWindow(now: Date): { week: string; start: Date; end: Date } {
  const day = now.getUTCDay() === 0 ? 7 : now.getUTCDay();
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (day - 1)),
  );
  const start = new Date(end.getTime() - 7 * 86_400_000);
  return { week: isoWeekLabel(start), start, end };
}

const STATUS_SET: ReadonlySet<string> = new Set(DATASET_STATUSES);
const ERROR_SET: ReadonlySet<string> = new Set(SCREEN_ERRORS);
/** A stored time this far past the report's own clock is not a time the sweep wrote. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

const asText = (x: unknown): string | null => (typeof x === "string" && x !== "" ? x : null);

/**
 * A stored report, parsed again on the way out (the Worker only ever writes a
 * parsed one, so a failure means a row edited by hand, or written under an
 * older contract, and reads as no report).
 */
function readReport(raw: unknown): ScreenReport | null {
  if (typeof raw !== "string") return null;
  try {
    return parseScreenReport(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** One dataset's standing, as of `nowMs`. */
export type Standing =
  | { kind: "screened"; status: DatasetStatus; report: ScreenReport; checkedMs: number }
  | {
      kind: "unchecked";
      reason: UncheckedReason;
      attempt: AttemptNote;
      /** The last verdict, when one reads back (for `expired`, `new-version`, `incomplete`). */
      status: DatasetStatus | null;
      report: ScreenReport | null;
      checkedMs: number | null;
      /** For `unreadable`: the stored status, when it is a finding, so the finding is still listed. */
      claimedFinding?: DatasetStatus;
    };

/** What the last attempt came to, read without trusting it. */
export function attemptNote(
  row: Pick<IdentifierSweepRow, "attempt" | "attempt_error">,
): AttemptNote {
  switch (row.attempt) {
    case undefined:
    case null:
    case "reported":
      return "queued";
    case "pending":
      return "in-flight";
    case "unreported":
      return "no-report-in-time";
    case "error":
      return typeof row.attempt_error === "string" && ERROR_SET.has(row.attempt_error)
        ? (row.attempt_error as ScreenError)
        : "unknown";
    default:
      return "unknown";
  }
}

/**
 * A dataset counts as screened this cycle only when ALL of these hold: its
 * stamps, verdict, report and time read back and agree, and the time is not in
 * the future; the verdict is at most `cycleDays` old; it was of the dataset's
 * latest version; and the screen read everything it can parse. Anything else
 * is unchecked, with the first reason that applies.
 */
export function standingOf(row: IdentifierSweepRow, nowMs: number, cycleDays: number): Standing {
  const attempt = attemptNote(row);
  const stampsType = row.stamps_type ?? null;
  const rawStatus = asText(row.status);
  if (stampsType !== null && stampsType !== "object") {
    return {
      kind: "unchecked",
      reason: "unreadable",
      attempt,
      status: null,
      report: null,
      checkedMs: null,
    };
  }
  if (rawStatus === null) {
    return {
      kind: "unchecked",
      reason: "never-screened",
      attempt,
      status: null,
      report: null,
      checkedMs: null,
    };
  }
  const report = readReport(row.report);
  const parsedMs = parseSqliteUtc(asText(row.checked_at));
  const checkedMs = parsedMs !== null && parsedMs <= nowMs + FUTURE_TOLERANCE_MS ? parsedMs : null;
  const status = STATUS_SET.has(rawStatus) ? (rawStatus as DatasetStatus) : null;
  if (status === null || report?.scan?.status !== status || checkedMs === null) {
    return {
      kind: "unchecked",
      reason: "unreadable",
      attempt,
      status: null,
      report: null,
      checkedMs,
      ...(FINDING_SET.has(rawStatus) ? { claimedFinding: rawStatus as DatasetStatus } : {}),
    };
  }
  const lapsed = (reason: UncheckedReason): Standing => ({
    kind: "unchecked",
    reason,
    attempt,
    status,
    report,
    checkedMs,
  });
  if (nowMs - checkedMs > cycleDays * 86_400_000) return lapsed("expired");
  if ((asText(row.version) ?? "") !== (row.latest_version ?? "")) return lapsed("new-version");
  if (report.scan?.incomplete) return lapsed("incomplete");
  return { kind: "screened", status, report, checkedMs };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const RANK = (status: unknown) =>
  status === "direct-identifiers" ? 2 : status === "review" ? 1 : 0;

/**
 * The finding an incomplete screen carried forward. `garbage` when a stamp is
 * there but does not read back at all (it is still listed, as unreadable);
 * null when there is none.
 */
function retainedFinding(
  raw: unknown,
):
  | { status: DatasetStatus; checkedMs: number | null; report: ScreenReport | null }
  | "garbage"
  | null {
  if (typeof raw !== "string") return null;
  try {
    const f = JSON.parse(raw) as { status?: unknown; checked_at?: unknown; report?: unknown };
    if (typeof f.status !== "string" || !FINDING_SET.has(f.status)) return "garbage";
    let report: ScreenReport | null = null;
    try {
      report = f.report == null ? null : parseScreenReport(f.report);
      if (report?.scan?.status !== f.status) report = null;
    } catch {
      report = null;
    }
    return {
      status: f.status as DatasetStatus,
      checkedMs: parseSqliteUtc(asText(f.checked_at)),
      report,
    };
  } catch {
    return "garbage";
  }
}

/**
 * The listed finding of a row, if it has one, and which list it goes in.
 *
 * Two sources: the verdict itself (when it found something, or when only its
 * status still reads back), and the finding an incomplete screen carried
 * forward. The stronger one is listed (a direct identifier above a review
 * item); between equals, the verdict, which is the newer screen. A carried
 * finding is ignored beside a complete verdict, which is the whole answer.
 */
function findingOf(
  row: IdentifierSweepRow,
  s: Standing,
): { list: "flagged" | "review"; entry: FlaggedDataset } | null {
  const listOf = (status: DatasetStatus) => (status === "review" ? "review" : "flagged");
  let current: { status: DatasetStatus; entry: FlaggedDataset } | null = null;
  if (s.status && FINDING_SET.has(s.status) && s.report?.scan && s.checkedMs !== null) {
    current = {
      status: s.status,
      entry: {
        dataset_id: row.dataset_id,
        screened_on: day(s.checkedMs),
        standing: s.kind === "screened" ? "current" : s.reason,
        findings_by_kind: { ...(s.report.scan.findings_by_kind ?? {}) },
        edf_bdf_files_flagged: s.report.scan.edf_bdf_files_flagged ?? null,
      },
    };
  } else if (s.kind === "unchecked" && s.claimedFinding) {
    current = {
      status: s.claimedFinding,
      entry: {
        dataset_id: row.dataset_id,
        screened_on: s.checkedMs === null ? null : day(s.checkedMs),
        standing: "unreadable",
        findings_by_kind: null,
        edf_bdf_files_flagged: null,
      },
    };
  }

  // Beside a complete, readable verdict a carried stamp is stale and ignored.
  const verdictComplete = s.report !== null && s.report.scan?.incomplete === false;
  const kept = verdictComplete ? null : retainedFinding(row.finding);
  let carried: { status: DatasetStatus; entry: FlaggedDataset } | null = null;
  if (kept === "garbage") {
    // A carried stamp that does not read back: named, conservatively, with the
    // direct identifiers, because what it held cannot be told.
    carried = {
      status: "direct-identifiers",
      entry: {
        dataset_id: row.dataset_id,
        screened_on: null,
        standing: "unreadable",
        findings_by_kind: null,
        edf_bdf_files_flagged: null,
      },
    };
  } else if (kept) {
    carried = {
      status: kept.status,
      entry: {
        dataset_id: row.dataset_id,
        screened_on: kept.checkedMs === null ? null : day(kept.checkedMs),
        standing: "earlier",
        findings_by_kind: kept.report ? { ...(kept.report.scan?.findings_by_kind ?? {}) } : null,
        edf_bdf_files_flagged: kept.report?.scan?.edf_bdf_files_flagged ?? null,
      },
    };
  }

  const chosen =
    carried && (!current || RANK(carried.status) > RANK(current.status)) ? carried : current;
  return chosen ? { list: listOf(chosen.status), entry: chosen.entry } : null;
}

const inWindow = (ms: number | null, start: number, end: number) =>
  ms !== null && ms >= start && ms < end;

/** An attempt that never reached GitHub: claimed, then refused or impossible. */
const neverDispatched = (row: IdentifierSweepRow) =>
  row.attempt === "error" &&
  (row.attempt_error === "dispatch-unconfigured" || row.attempt_error === "dispatch-failed");

/** The week's facts from the in-scope rows. */
export function buildIdentifierWeek(
  rows: readonly IdentifierSweepRow[],
  opts: {
    now: Date;
    due: number | null;
    /** Defaults to `due` when not given. */
    owed?: number | null;
    errors?: string[];
    cycleDays: number;
  },
): IdentifierWeekFacts {
  const nowMs = opts.now.getTime();
  const win = reportWindow(opts.now);
  const start = win.start.getTime();
  const end = win.end.getTime();

  const byStatus: Partial<Record<DatasetStatus, number>> = {};
  const uncheckedByReason = Object.fromEntries(UNCHECKED_REASONS.map((r) => [r, 0])) as Record<
    UncheckedReason,
    number
  >;
  const lastAttempt: Partial<Record<AttemptNote, number>> = {};
  const incompleteReasons: Record<string, number> = {};
  const flagged: FlaggedDataset[] = [];
  const review: FlaggedDataset[] = [];
  let screened = 0;
  let partial = 0;
  let unchecked = 0;
  let dispatched = 0;
  let stored = 0;
  let failedRecent = 0;
  let firstAttemptMs: number | null = null;

  for (const row of rows) {
    const s = standingOf(row, nowMs, opts.cycleDays);
    const attemptedMs = parseSqliteUtc(asText(row.attempted_at));
    if (attemptedMs !== null && (firstAttemptMs === null || attemptedMs < firstAttemptMs)) {
      firstAttemptMs = attemptedMs;
    }
    if (inWindow(attemptedMs, start, end) && !neverDispatched(row)) dispatched++;
    if (
      inWindow(attemptedMs, start, end) &&
      (row.attempt === "error" || row.attempt === "unreported")
    ) {
      failedRecent++;
    }
    if (inWindow(s.checkedMs, start, end)) stored++;
    if (s.kind === "screened") {
      screened++;
      if (PARTIAL_COVERAGE.has(s.status)) partial++;
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    } else {
      unchecked++;
      uncheckedByReason[s.reason]++;
      if (s.reason === "incomplete") {
        for (const r of new Set(s.report?.scan?.incomplete_reasons ?? [])) {
          incompleteReasons[r] = (incompleteReasons[r] ?? 0) + 1;
        }
      } else {
        lastAttempt[s.attempt] = (lastAttempt[s.attempt] ?? 0) + 1;
      }
    }
    const f = findingOf(row, s);
    if (f) (f.list === "review" ? review : flagged).push(f.entry);
  }

  return {
    week: win.week,
    windowStart: win.start.toISOString(),
    windowEnd: win.end.toISOString(),
    asOf: opts.now.toISOString(),
    cycleDays: opts.cycleDays,
    scope: rows.length,
    screened,
    partialCoverage: partial,
    byStatus,
    unchecked,
    uncheckedByReason,
    lastAttempt,
    incompleteReasons,
    dispatchedInWindow: dispatched,
    storedInWindow: stored,
    failedInWindow: failedRecent,
    firstAttemptAt: firstAttemptMs === null ? null : new Date(firstAttemptMs).toISOString(),
    due: opts.due,
    owed: opts.owed === undefined ? opts.due : opts.owed,
    flagged,
    review,
    errors: [...(opts.errors ?? [])],
  };
}

/** The facts when the sweep's records could not be read: every figure from them is unknown. */
export function unknownIdentifierWeek(
  now: Date,
  due: number | null,
  owed: number | null,
  errors: string[],
  cycleDays: number,
): IdentifierWeekFacts {
  const win = reportWindow(now);
  return {
    week: win.week,
    windowStart: win.start.toISOString(),
    windowEnd: win.end.toISOString(),
    asOf: now.toISOString(),
    cycleDays,
    scope: null,
    screened: null,
    partialCoverage: null,
    byStatus: null,
    unchecked: null,
    uncheckedByReason: null,
    lastAttempt: null,
    incompleteReasons: null,
    dispatchedInWindow: null,
    storedInWindow: null,
    failedInWindow: null,
    firstAttemptAt: null,
    due,
    owed,
    flagged: null,
    review: null,
    errors: [...errors],
  };
}

/** Datasets needing review named before falling back to a count (ADR 0036). */
export const SWEEP_REPORT_MAX_REVIEW_LISTED = 50;

export interface IdentifierWeekReport {
  subject: string;
  headline: string;
  attention: boolean;
  lines: string[];
}

const ATTEMPT_WORDS = (note: AttemptNote): string => {
  switch (note) {
    case "in-flight":
      return "a screen is running";
    case "queued":
      return "waiting in the queue";
    case "unknown":
      return "the last attempt does not read back";
    default:
      return screenErrorText(note);
  }
};

function flaggedLine(f: FlaggedDataset): string {
  const date = f.screened_on ?? "on a date that does not read back";
  const when =
    f.standing === "current"
      ? `screened ${date}`
      : f.standing === "earlier"
        ? `screened ${date}; every screen since was INCOMPLETE`
        : `screened ${date}, ${UNCHECKED_WORDS[f.standing]}`;
  const kinds =
    f.findings_by_kind === null
      ? "kinds do not read back"
      : kindsPhrase(f.findings_by_kind) || "no kinds recorded";
  const files =
    f.edf_bdf_files_flagged === null
      ? ""
      : `; EDF/BDF files with an identifier finding: ${count(f.edf_bdf_files_flagged)}`;
  return `  ${f.dataset_id} (${when}): ${kinds}${files}`;
}

/**
 * The sweep's liveness this week, from its own records (ADR 0053: silence is
 * evidence only when there was work).
 *
 * Work is what is OWED (due, including datasets waiting out a retry backoff),
 * not only what the queue would take this minute, so a sweep whose every
 * dispatch is refused does not read as one with nothing to do.
 *
 * - `idle`: work was owed, the sweep had been running before the week ended,
 *   and it dispatched nothing in the week (it may be refused, or not running).
 * - `never`: work is owed and no dataset has ever been attempted.
 * - `not-yet`: the sweep's first attempt came after the week ended, so the
 *   week says nothing about it (the first report after a deploy).
 * - `ok`: none of those.
 * - `unknown`: a figure it needs could not be read.
 */
export function identifierWeekLiveness(
  f: IdentifierWeekFacts,
): "ok" | "idle" | "never" | "not-yet" | "unknown" {
  if (f.owed === null || f.dispatchedInWindow === null || f.scope === null) return "unknown";
  if (f.owed === 0 || f.dispatchedInWindow > 0) return "ok";
  if (f.firstAttemptAt === null) return "never";
  return f.firstAttemptAt >= f.windowEnd ? "not-yet" : "idle";
}

/**
 * What in this week needs a person, as short phrases; empty when nothing does.
 *
 * A dataset that is unchecked only because it is waiting in the queue, or its
 * screen is running, is ordinary work in progress and needs nobody (a newly
 * published dataset, a new version, the first pass). Everything else does: a
 * figure that could not be read, a direct identifier in any dataset's last
 * finding, a sweep that dispatched nothing while work was due or never has, a
 * screen that did not run or did not report, one that was incomplete, a result
 * that does not read back, and a dataset that fell out of the cycle (the
 * refresh comes a week earlier, so lapsing means the sweep is not keeping up).
 */
export function attentionReasons(f: IdentifierWeekFacts): string[] {
  if (f.scope === null) return ["some figures could not be read"];
  const out: string[] = [];
  if (f.errors.length > 0 || f.due === null || f.owed === null) {
    out.push("some figures could not be read");
  }
  if (f.flagged === null || f.flagged.length > 0) {
    out.push(`${count(f.flagged?.length ?? null)} datasets with direct identifiers`);
  }
  const liveness = identifierWeekLiveness(f);
  if (liveness === "idle") out.push("the sweep dispatched no screen while work was owed");
  if (liveness === "never") out.push("the sweep has never dispatched a screen");
  const failed =
    f.lastAttempt === null
      ? null
      : Object.entries(f.lastAttempt)
          .filter(([note]) => note !== "in-flight" && note !== "queued")
          .reduce((a, [, n]) => a + (n ?? 0), 0);
  if (failed === null || failed > 0) {
    out.push(`${count(failed)} unchecked datasets whose last screen did not run or did not report`);
  }
  if (f.failedInWindow === null || f.failedInWindow > 0) {
    out.push(
      `${count(f.failedInWindow)} datasets whose latest screen this week did not run or did not report`,
    );
  }
  const reason = (r: UncheckedReason) =>
    f.uncheckedByReason === null ? null : f.uncheckedByReason[r];
  for (const [r, phrase] of [
    ["incomplete", "screens were incomplete"],
    ["expired", "datasets fell out of the cycle"],
    ["unreadable", "stored results do not read back"],
  ] as const) {
    const n = reason(r);
    if (n === null || n > 0) out.push(`${count(n)} ${phrase}`);
  }
  return out;
}

/** The report, in the screen's words. */
export function renderIdentifierWeek(f: IdentifierWeekFacts): IdentifierWeekReport {
  const reasons = attentionReasons(f);
  const attention = reasons.length > 0;
  const withIds = f.flagged === null ? null : f.flagged.length;
  const subject = `[NEMAR] Identifier sweep ${f.week}: ${count(withIds)} with identifiers, ${count(f.unchecked)} unchecked`;
  const headline = attention
    ? `Needs attention: ${reasons.join("; ")}.`
    : "Nothing needs attention this week.";
  const lines: string[] = [];

  lines.push(
    `Week ${f.week}, ${f.windowStart.slice(0, 10)} to ${f.windowEnd.slice(0, 10)} (UTC). Cycle figures as of ${f.asOf.slice(0, 16).replace("T", " ")} UTC.`,
  );
  lines.push(
    `A dataset counts as screened when its last screen is at most ${f.cycleDays} days old, was of its latest version, and read everything it could parse.`,
  );
  lines.push("");
  lines.push(`Public datasets in scope: ${count(f.scope)}`);
  lines.push(`Screened this cycle: ${count(f.screened)}`);
  lines.push(
    `  of which some recordings are in formats the scanner does not parse: ${count(f.partialCoverage)}`,
  );
  if (f.byStatus === null) {
    lines.push("  by result: unknown");
  } else {
    for (const s of DATASET_STATUSES) {
      const n = f.byStatus[s];
      if (n) lines.push(`  ${screenStateLabel(s)}: ${count(n)}`);
    }
  }
  lines.push(`Unchecked: ${count(f.unchecked)}`);
  if (f.uncheckedByReason === null) {
    lines.push("  by reason: unknown");
  } else {
    for (const r of UNCHECKED_REASONS) {
      const n = f.uncheckedByReason[r];
      if (n) lines.push(`  ${UNCHECKED_WORDS[r]}: ${count(n)}`);
    }
  }
  if (f.lastAttempt === null) {
    lines.push("  last attempt: unknown");
  } else {
    const entries = Object.entries(f.lastAttempt) as [AttemptNote, number][];
    if (entries.length > 0) {
      lines.push("  last attempt of those not incomplete:");
      for (const [note, n] of entries.sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`    ${ATTEMPT_WORDS(note)}: ${count(n)}`);
      }
    }
  }
  if (f.incompleteReasons === null) {
    lines.push("  incomplete, by reason: unknown");
  } else {
    const entries = Object.entries(f.incompleteReasons).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length > 0) {
      lines.push(
        `  incomplete, by reason: ${entries.map(([r, n]) => `${r} x${count(n)}`).join(", ")}`,
      );
    }
  }
  lines.push("");
  lines.push(
    `This week: screens dispatched for ${count(f.dispatchedInWindow)} datasets; results stored for ${count(f.storedInWindow)}.`,
  );
  lines.push(
    `Owed a screen: ${count(f.owed)} (due now: ${count(f.due)}; the rest wait out a retry backoff)`,
  );
  lines.push(
    `Latest screen this week did not run or did not report: ${count(f.failedInWindow)} datasets`,
  );
  switch (identifierWeekLiveness(f)) {
    case "idle":
      lines.push(
        `The sweep dispatched no screen this week while ${count(f.owed)} datasets were owed one: it is not running, or every dispatch is refused.`,
      );
      break;
    case "never":
      lines.push(
        `The sweep has never dispatched a screen, and ${count(f.owed)} datasets are owed one.`,
      );
      break;
    case "not-yet":
      lines.push("The sweep began after this week ended, so the week says nothing about it.");
      break;
    case "unknown":
      lines.push("Whether the sweep ran this week: unknown");
      break;
    case "ok":
      break;
  }
  lines.push("");
  lines.push(
    `Datasets with direct identifiers (last finding, kinds and counts): ${count(withIds)}`,
  );
  for (const d of f.flagged ?? []) lines.push(flaggedLine(d));
  const reviewCount = f.review === null ? null : f.review.length;
  lines.push(`Datasets that need review (last finding, kinds and counts): ${count(reviewCount)}`);
  const shown = (f.review ?? []).slice(0, SWEEP_REPORT_MAX_REVIEW_LISTED);
  for (const d of shown) lines.push(flaggedLine(d));
  if (reviewCount !== null && reviewCount > shown.length) {
    lines.push(
      `  and ${count(reviewCount - shown.length)} more (GET /admin/identifier-sweep lists them all)`,
    );
  }
  if (f.errors.length > 0) {
    lines.push("");
    for (const e of f.errors) lines.push(`Could not read: ${e}.`);
  }
  lines.push("");
  lines.push(SCREEN_NOT_READ);
  lines.push(
    "Formats other than EDF and BDF are counted, not parsed. A clean screen is not a certification.",
  );
  return { subject, headline, attention, lines };
}
