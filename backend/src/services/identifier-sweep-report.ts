/**
 * The identifier sweep's weekly report (epic #1610, phase 5, ADR 0087). Pure:
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
  status: unknown;
  checked_at: unknown;
  version: unknown;
  report: unknown;
  attempt: unknown;
  attempt_error: unknown;
  attempted_at: unknown;
  requested_at: unknown;
}

/**
 * Why a dataset is not screened this cycle.
 *
 * - `never-screened`: no verdict was ever stored.
 * - `unreadable`: a verdict is recorded but its report, status or time does not
 *   read back (a row edited by hand). Not clean, and not "never" either.
 * - `expired`: the last verdict is older than the cycle.
 * - `new-version`: the last verdict is of an older version than the latest.
 * - `incomplete`: the last screen ran and could not read everything (the
 *   scanner's own `unchecked`).
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

/** A dataset whose last verdict found something, with its kinds and counts. */
export interface FlaggedDataset {
  dataset_id: string;
  /** When that verdict was stored, `YYYY-MM-DD`. */
  screened_on: string;
  /** Whether that verdict still counts (`screened`) or has lapsed (an unchecked reason). */
  standing: "current" | UncheckedReason;
  findings_by_kind: Partial<Record<string, number>>;
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
  /** Screened datasets by verdict. */
  byStatus: Partial<Record<DatasetStatus, number>> | null;
  unchecked: number | null;
  uncheckedByReason: Record<UncheckedReason, number> | null;
  /** Over every unchecked dataset that is not `incomplete`: what its last attempt came to. */
  lastAttempt: Partial<Record<AttemptNote, number>> | null;
  /** Over every `incomplete` dataset: how many datasets carry each reason. */
  incompleteReasons: Record<string, number> | null;
  /** Datasets whose most recent screen was started in the window. */
  startedInWindow: number | null;
  /** Datasets whose verdict was stored in the window. */
  storedInWindow: number | null;
  /** Datasets the queue would take now. */
  due: number | null;
  /** Datasets whose last verdict found direct identifiers. */
  flagged: FlaggedDataset[] | null;
  /** Datasets whose last verdict needs review. */
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

const asText = (x: unknown): string | null => (typeof x === "string" && x !== "" ? x : null);

/**
 * A stored report, parsed again on the way out (the Worker only ever writes a
 * parsed one, so a failure means a row edited by hand, and reads as no report).
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
 * verdict, report and time read back and agree; the verdict is at most
 * `cycleDays` old; it was of the dataset's latest version; and the screen was
 * complete. Anything else is unchecked, with the first reason that applies.
 */
export function standingOf(row: IdentifierSweepRow, nowMs: number, cycleDays: number): Standing {
  const rawStatus = asText(row.status);
  const report = readReport(row.report);
  const checkedMs = parseSqliteUtc(asText(row.checked_at));
  const attempt = attemptNote(row);
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
  const status = STATUS_SET.has(rawStatus) ? (rawStatus as DatasetStatus) : null;
  if (status === null || report?.scan?.status !== status || checkedMs === null) {
    return {
      kind: "unchecked",
      reason: "unreadable",
      attempt,
      status: null,
      report: null,
      checkedMs,
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
  if (status === "unchecked") return lapsed("incomplete");
  return { kind: "screened", status, report, checkedMs };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function flaggedEntry(row: IdentifierSweepRow, s: Standing): FlaggedDataset | null {
  if (!s.report?.scan || s.checkedMs === null) return null;
  return {
    dataset_id: row.dataset_id,
    screened_on: day(s.checkedMs),
    standing: s.kind === "screened" ? "current" : s.reason,
    findings_by_kind: { ...(s.report.scan.findings_by_kind ?? {}) },
    edf_bdf_files_flagged: s.report.scan.edf_bdf_files_flagged ?? null,
  };
}

const inWindow = (ms: number | null, start: number, end: number) =>
  ms !== null && ms >= start && ms < end;

/** The week's facts from the in-scope rows. */
export function buildIdentifierWeek(
  rows: readonly IdentifierSweepRow[],
  opts: { now: Date; due: number | null; errors?: string[]; cycleDays: number },
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
  let unchecked = 0;
  let started = 0;
  let stored = 0;

  for (const row of rows) {
    const s = standingOf(row, nowMs, opts.cycleDays);
    if (inWindow(parseSqliteUtc(asText(row.attempted_at)), start, end)) started++;
    if (inWindow(s.checkedMs, start, end)) stored++;
    if (s.kind === "screened") {
      screened++;
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
    // Listed by the LAST verdict, whatever its standing: a finding does not stop
    // being reported because its screen aged out of the cycle.
    if (s.status === "direct-identifiers" || s.status === "review") {
      const entry = flaggedEntry(row, s);
      if (entry) (s.status === "review" ? review : flagged).push(entry);
    }
  }

  return {
    week: win.week,
    windowStart: win.start.toISOString(),
    windowEnd: win.end.toISOString(),
    asOf: opts.now.toISOString(),
    cycleDays: opts.cycleDays,
    scope: rows.length,
    screened,
    byStatus,
    unchecked,
    uncheckedByReason,
    lastAttempt,
    incompleteReasons,
    startedInWindow: started,
    storedInWindow: stored,
    due: opts.due,
    flagged,
    review,
    errors: [...(opts.errors ?? [])],
  };
}

/** The facts when the sweep's records could not be read: every figure from them is unknown. */
export function unknownIdentifierWeek(
  now: Date,
  due: number | null,
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
    byStatus: null,
    unchecked: null,
    uncheckedByReason: null,
    lastAttempt: null,
    incompleteReasons: null,
    startedInWindow: null,
    storedInWindow: null,
    due,
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
  const when =
    f.standing === "current"
      ? `screened ${f.screened_on}`
      : `screened ${f.screened_on}, ${UNCHECKED_WORDS[f.standing]}`;
  const kinds = kindsPhrase(f.findings_by_kind);
  const files =
    f.edf_bdf_files_flagged === null
      ? ""
      : `; EDF/BDF files with an identifier finding: ${f.edf_bdf_files_flagged}`;
  return `  ${f.dataset_id} (${when}): ${kinds || "no kinds recorded"}${files}`;
}

/**
 * What in this week needs a person, as short phrases; empty when nothing does.
 *
 * A dataset that is unchecked only because it is waiting in the queue, or its
 * screen is running, is ordinary work in progress and needs nobody (a newly
 * published dataset, a new version, the first pass). Everything else does: a
 * figure that could not be read, a direct identifier in any dataset's last
 * screen, a sweep that started nothing while work was due, a screen that did
 * not run or did not report, one that was incomplete, a result that does not
 * read back, and a dataset that fell out of the cycle (the refresh comes a week
 * earlier, so lapsing means the sweep is not keeping up).
 */
export function attentionReasons(f: IdentifierWeekFacts): string[] {
  const out: string[] = [];
  if (f.errors.length > 0 || f.scope === null || f.due === null) {
    out.push("some figures could not be read");
  }
  if (f.flagged === null || f.flagged.length > 0) {
    out.push(`${count(f.flagged?.length ?? null)} datasets with direct identifiers`);
  }
  if (identifierWeekIdle(f) === true) out.push("the sweep started no screen while work was due");
  const failed =
    f.lastAttempt === null
      ? null
      : Object.entries(f.lastAttempt)
          .filter(([note]) => note !== "in-flight" && note !== "queued")
          .reduce((a, [, n]) => a + (n ?? 0), 0);
  if (failed === null || failed > 0) {
    out.push(`${count(failed)} unchecked datasets whose last screen did not run or did not report`);
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
  // One "unknown" line is enough when the records could not be read at all.
  return f.scope === null ? ["some figures could not be read"] : out;
}

/** True when datasets are due and no screen started in the week; null when that cannot be told. */
export function identifierWeekIdle(f: IdentifierWeekFacts): boolean | null {
  if (f.due === null || f.startedInWindow === null) return null;
  return f.due > 0 && f.startedInWindow === 0;
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
      lines.push(`  incomplete, by reason: ${entries.map(([r, n]) => `${r} x${n}`).join(", ")}`);
    }
  }
  lines.push("");
  lines.push(
    `This week: screens started for ${count(f.startedInWindow)} datasets; results stored for ${count(f.storedInWindow)}.`,
  );
  lines.push(`Due now: ${count(f.due)}`);
  const idle = identifierWeekIdle(f);
  if (idle === true) {
    lines.push(
      `The sweep started no screen this week while ${count(f.due)} datasets were due: it is not running.`,
    );
  } else if (idle === null) {
    lines.push("Whether the sweep ran this week: unknown");
  }
  lines.push("");
  lines.push(`Datasets with direct identifiers (last screen, kinds and counts): ${count(withIds)}`);
  for (const d of f.flagged ?? []) lines.push(flaggedLine(d));
  const reviewCount = f.review === null ? null : f.review.length;
  lines.push(`Datasets that need review (last screen, kinds and counts): ${count(reviewCount)}`);
  const shown = (f.review ?? []).slice(0, SWEEP_REPORT_MAX_REVIEW_LISTED);
  for (const d of shown) lines.push(flaggedLine(d));
  if (reviewCount !== null && reviewCount > shown.length) {
    lines.push(
      `  and ${reviewCount - shown.length} more (GET /admin/identifier-sweep lists them all)`,
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
