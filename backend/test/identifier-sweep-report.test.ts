/**
 * The identifier sweep's weekly report (epic #1610, phase 5, ADR 0088).
 *
 * Two halves. The pure half (`identifier-sweep-report.ts`) decides what each
 * dataset's standing is and what the week says, from stored rows and a clock;
 * those rules are pinned with rows whose reports come from the production
 * parser. The other half is the send, driven through
 * `sendIdentifierSweepWeeklyReport` and `GET /admin/identifier-sweep` against
 * real migrations, with the state built by the real tick and callback and the
 * mail caught by the shared Resend capture.
 *
 * The rules that matter most: the report arrives whether or not anything is
 * wrong; unknown is never rendered as zero; a dataset counts as screened only
 * when every condition holds; a finding stays listed when its screen ages out;
 * the week is sent once, fails closed, and never from a dev worker.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { parseScreenReport } from "../../shared/identifier-screen-report";
import { adminRoutes } from "../src/routes/admin";
import webhooks from "../src/routes/webhooks";
import {
  IDENTIFIER_SWEEP_CYCLE_DAYS,
  IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION,
  IDENTIFIER_SWEEP_REPORT_MAX_CLAIMS,
  IDENTIFIER_SWEEP_REPORT_SENT_ACTION,
  IDENTIFIER_SWEEP_ROWS_SQL,
  runIdentifierSweepTick,
  sendIdentifierSweepWeeklyReport,
  weeklyRecordState,
} from "../src/services/identifier-sweep";
import {
  type IdentifierSweepRow,
  attentionReasons,
  buildIdentifierWeek,
  identifierWeekLiveness,
  renderIdentifierWeek,
  reportWindow,
  standingOf,
  unknownIdentifierWeek,
} from "../src/services/identifier-sweep-report";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";
import { type CapturedEmail, asSend, withFakeResend } from "./helpers/resend";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const LEAK = "SMITH";
const DAY = 86_400_000;

function scanBody(datasetId: string, status: string, extra: Record<string, unknown> = {}) {
  // `unchecked` is always incomplete; any status may be, when the caller says so.
  const incomplete = status === "unchecked" || extra.incomplete === true;
  return {
    version: 1,
    scanner: "identifier-scan@abcdef1",
    head: HEAD,
    scan: {
      id: datasetId,
      version: null,
      scanned_at: "2026-10-05T12:00:00.000Z",
      manifest_source: "clone",
      status,
      incomplete,
      incomplete_reasons: incomplete ? ["deadline", "edf-headers-unread"] : [],
      files: { total: 10, edf_bdf: 4, header_read: incomplete ? 3 : 4, header_read_failed: 0 },
      ...extra,
    },
  };
}

/** A stored report exactly as the Worker stores one: the parser's output, re-serialized. */
const stored = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify(parseScreenReport(scanBody(id, status, extra)));

/** SQLite's `datetime('now')` shape for an instant. */
const sqlite = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

const NOW = new Date("2026-10-07T10:00:00.000Z"); // a Wednesday in 2026-W41
const NOW_MS = NOW.getTime();

function row(id: string, over: Partial<IdentifierSweepRow> = {}): IdentifierSweepRow {
  return {
    dataset_id: id,
    latest_version: "1.0.0",
    status: null,
    checked_at: null,
    version: null,
    report: null,
    attempt: null,
    attempt_error: null,
    attempted_at: null,
    requested_at: null,
    ...over,
  };
}

/** A dataset screened `daysAgo` with `status`, of its current version. */
function screenedRow(id: string, status: string, daysAgo = 1, extra = {}): IdentifierSweepRow {
  return row(id, {
    status,
    report: stored(id, status, extra),
    checked_at: sqlite(NOW_MS - daysAgo * DAY),
    version: "1.0.0",
    attempt: "reported",
    attempted_at: sqlite(NOW_MS - daysAgo * DAY - 600_000),
  });
}

const facts = (rows: IdentifierSweepRow[], due: number | null = 0) =>
  buildIdentifierWeek(rows, { now: NOW, due, cycleDays: IDENTIFIER_SWEEP_CYCLE_DAYS });

describe("the week a report covers", () => {
  test("is the ISO week before the one it is made in, Monday to Monday UTC", () => {
    const w = reportWindow(NOW);
    expect(w.week).toBe("2026-W40");
    expect(w.start.toISOString()).toBe("2026-09-28T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    // The first minute of a Monday already reports the week that just closed, and
    // the last minute of a Sunday still reports the one before it.
    expect(reportWindow(new Date("2026-10-05T00:00:00.000Z")).week).toBe("2026-W40");
    expect(reportWindow(new Date("2026-10-04T23:59:59.000Z")).week).toBe("2026-W39");
  });

  test("labels the ISO year, not the calendar year, at the boundary", () => {
    // 2027-01-04 is a Monday; the week before it began on 2026-12-28, which is 2026-W53.
    expect(reportWindow(new Date("2027-01-04T08:00:00.000Z")).week).toBe("2026-W53");
    expect(reportWindow(new Date("2027-01-11T08:00:00.000Z")).week).toBe("2027-W01");
  });
});

describe("a dataset's standing", () => {
  test("screened only when the verdict reads back, is in the cycle, is of the latest version, and is complete", () => {
    expect(standingOf(screenedRow("nm000700", "clean"), NOW_MS, 28).kind).toBe("screened");
    const reasonOf = (r: IdentifierSweepRow) => {
      const s = standingOf(r, NOW_MS, 28);
      return s.kind === "unchecked" ? s.reason : "screened";
    };
    expect(reasonOf(row("nm000701"))).toBe("never-screened");
    expect(reasonOf(screenedRow("nm000702", "clean", 29))).toBe("expired");
    expect(reasonOf(screenedRow("nm000703", "clean", 27))).toBe("screened");
    expect(reasonOf({ ...screenedRow("nm000704", "clean"), latest_version: "1.1.0" })).toBe(
      "new-version",
    );
    expect(reasonOf(screenedRow("nm000705", "unchecked"))).toBe("incomplete");
  });

  test("a verdict whose report, status or time does not read back is unreadable, never screened", () => {
    const base = screenedRow("nm000706", "clean");
    const reasonOf = (r: IdentifierSweepRow) => {
      const s = standingOf(r, NOW_MS, 28);
      return s.kind === "unchecked" ? s.reason : "screened";
    };
    expect(reasonOf({ ...base, status: "fine" })).toBe("unreadable");
    expect(reasonOf({ ...base, status: "direct-identifiers" })).toBe("unreadable");
    expect(reasonOf({ ...base, report: "{" })).toBe("unreadable");
    expect(reasonOf({ ...base, checked_at: "yesterday" })).toBe("unreadable");
    // A report edited by hand to carry a value is refused by the parser on the way out.
    const hostile = JSON.parse(base.report as string);
    hostile.scan.patient = LEAK;
    expect(reasonOf({ ...base, report: JSON.stringify(hostile) })).toBe("unreadable");
  });

  test("the version check is NULL-safe: no version on either side is the same version", () => {
    const r = { ...screenedRow("nm000707", "clean"), version: null, latest_version: null };
    expect(standingOf(r, NOW_MS, 28).kind).toBe("screened");
  });
});

describe("findings stay listed", () => {
  test("a finding from an incomplete screen is listed, and its incompleteness counts", () => {
    const f = facts([
      screenedRow("nm000770", "direct-identifiers", 1, {
        incomplete: true,
        findings_by_kind: { "edf-patient-name": 1 },
      }),
      screenedRow("nm000771", "review", 1, { incomplete: true }),
    ]);
    expect(f.screened).toBe(0);
    expect(f.uncheckedByReason?.incomplete).toBe(2);
    expect(f.flagged?.map((d) => [d.dataset_id, d.standing])).toEqual([["nm000770", "incomplete"]]);
    expect(f.review?.map((d) => [d.dataset_id, d.standing])).toEqual([["nm000771", "incomplete"]]);
  });

  test("a screen that cannot parse every format counts as screened, and is counted as such", () => {
    const f = facts([
      screenedRow("nm000772", "not-screened"),
      screenedRow("nm000773", "clean-edf-only-others-unscreened"),
      screenedRow("nm000774", "clean"),
    ]);
    expect(f.screened).toBe(3);
    expect(f.partialCoverage).toBe(2);
    expect(renderIdentifierWeek(f).lines).toContain(
      "  of which some recordings are in formats the scanner does not parse: 2",
    );
  });

  test("a flagged dataset whose report no longer reads back is still named", () => {
    // A later tightening of the contract makes every stored report unreadable at
    // once; the ids must not drop out of the list with them.
    const base = screenedRow("nm000775", "direct-identifiers", 2);
    const f = facts([{ ...base, report: "{}" }]);
    expect(f.uncheckedByReason?.unreadable).toBe(1);
    expect(f.flagged).toEqual([
      {
        dataset_id: "nm000775",
        screened_on: "2026-10-05",
        standing: "unreadable",
        findings_by_kind: null,
        edf_bdf_files_flagged: null,
      },
    ]);
    expect(renderIdentifierWeek(f).lines).toContain(
      "  nm000775 (screened 2026-10-05, the stored result does not read back): kinds do not read back",
    );
  });

  test("a finding an incomplete screen carried forward is listed as earlier; a complete verdict drops it", () => {
    const earlier = screenedRow("nm000776", "direct-identifiers", 9, {
      findings_by_kind: { "edf-patient-code": 4 },
    });
    const kept = JSON.stringify({
      status: "direct-identifiers",
      checked_at: earlier.checked_at,
      report: JSON.parse(earlier.report as string),
    });
    const f = facts([{ ...screenedRow("nm000776", "unchecked", 1), finding: kept }]);
    expect(f.flagged).toEqual([
      {
        dataset_id: "nm000776",
        screened_on: "2026-09-28",
        standing: "earlier",
        findings_by_kind: { "edf-patient-code": 4 },
        edf_bdf_files_flagged: null,
      },
    ]);
    expect(renderIdentifierWeek(f).lines).toContain(
      "  nm000776 (screened 2026-09-28; every screen since was INCOMPLETE): edf-patient-code x4",
    );
    // Beside a complete verdict, a stale finding stamp is not listed.
    expect(facts([{ ...screenedRow("nm000776", "clean", 1), finding: kept }]).flagged).toEqual([]);
  });

  test("a time in the future and stamps that are not an object are unreadable, never screened", () => {
    const reasonOf = (r: IdentifierSweepRow) => {
      const st = standingOf(r, NOW_MS, 28);
      return st.kind === "unchecked" ? st.reason : "screened";
    };
    const base = screenedRow("nm000777", "clean");
    expect(reasonOf({ ...base, checked_at: sqlite(NOW_MS + 2 * DAY) })).toBe("unreadable");
    expect(reasonOf({ ...base, checked_at: sqlite(NOW_MS + 60_000) })).toBe("screened");
    expect(reasonOf({ ...base, stamps_type: "array" })).toBe("unreadable");
    expect(reasonOf({ ...base, stamps_type: "object" })).toBe("screened");
  });
});

describe("round two: findings and failures that must still show", () => {
  test("a carried finding beside an unreadable verdict is listed; a stamp that does not read back is named", () => {
    const earlier = screenedRow("nm000780", "direct-identifiers", 9);
    const kept = JSON.stringify({
      status: "direct-identifiers",
      checked_at: earlier.checked_at,
      report: JSON.parse(earlier.report as string),
    });
    const unreadable = {
      ...screenedRow("nm000780", "clean", 1),
      checked_at: "yesterday",
      finding: kept,
    };
    expect(facts([unreadable]).flagged?.map((d) => [d.dataset_id, d.standing])).toEqual([
      ["nm000780", "earlier"],
    ]);
    const garbage = { ...screenedRow("nm000781", "unchecked", 1), finding: "not json" };
    expect(facts([garbage]).flagged).toEqual([
      {
        dataset_id: "nm000781",
        screened_on: null,
        standing: "unreadable",
        findings_by_kind: null,
        edf_bdf_files_flagged: null,
      },
    ]);
  });

  test("the stronger finding is listed: an earlier direct finding above a current incomplete review", () => {
    const earlier = screenedRow("nm000782", "direct-identifiers", 9);
    const kept = JSON.stringify({
      status: "direct-identifiers",
      checked_at: earlier.checked_at,
      report: JSON.parse(earlier.report as string),
    });
    const f = facts([
      { ...screenedRow("nm000782", "review", 1, { incomplete: true }), finding: kept },
    ]);
    expect(f.flagged?.map((d) => [d.dataset_id, d.standing])).toEqual([["nm000782", "earlier"]]);
    expect(f.review).toEqual([]);
  });

  test("a refused or silent workflow shows this week even while every verdict is still fresh", () => {
    // Screened 22 days before NOW (still inside the cycle), and every attempt in
    // the week reported ended without a verdict: nothing is unchecked yet.
    const inWeek = sqlite(Date.parse("2026-10-02T09:00:00Z"));
    const rows = ["nm000783", "nm000784", "nm000785"].map((id) => ({
      ...screenedRow(id, "clean", 22),
      attempt: "error",
      attempt_error: "workflow-failed",
      attempted_at: inWeek,
    }));
    const f = facts(rows, 0);
    f.owed = 3;
    expect(f.unchecked).toBe(0);
    expect(f.failedInWindow).toBe(3);
    expect(attentionReasons(f)).toContain(
      "3 datasets whose latest screen this week did not run or did not report",
    );
  });

  test("liveness counts work owed, not only what the queue takes this minute", () => {
    // Every dataset is waiting out a backoff after refused dispatches: nothing is
    // due right now, three are owed, and nothing was dispatched in the week.
    const before = sqlite(Date.parse("2026-09-20T00:00:00Z"));
    const rows = ["nm000786", "nm000787", "nm000788"].map((id) =>
      row(id, { attempt: "error", attempt_error: "dispatch-failed", attempted_at: before }),
    );
    const f = buildIdentifierWeek(rows, { now: NOW, due: 0, owed: 3, cycleDays: 28 });
    expect(identifierWeekLiveness(f)).toBe("idle");
    expect(attentionReasons(f)).toContain("the sweep dispatched no screen while work was owed");
  });
});

describe("the week's facts and words", () => {
  test("counts screened by verdict and unchecked by reason and by last attempt", () => {
    const f = facts([
      screenedRow("nm000710", "clean"),
      screenedRow("nm000711", "dates-only"),
      screenedRow("nm000712", "direct-identifiers", 2, {
        findings_by_kind: { "edf-patient-name": 12, "edf-patient-birthdate": 12 },
        edf_bdf_files_flagged: 12,
      }),
      screenedRow("nm000713", "unchecked"),
      row("nm000714"),
      row("nm000715", { attempt: "pending", attempted_at: sqlite(NOW_MS - 600_000) }),
      row("nm000716", { attempt: "error", attempt_error: "dispatch-failed" }),
      row("nm000717", { attempt: "unreported", attempt_error: "no-report-in-time" }),
      { ...screenedRow("nm000718", "clean", 40), attempt: "error", attempt_error: "clone-failed" },
    ]);
    expect(f.scope).toBe(9);
    expect(f.screened).toBe(3);
    expect(f.byStatus).toEqual({ clean: 1, "dates-only": 1, "direct-identifiers": 1 });
    expect(f.unchecked).toBe(6);
    expect(f.uncheckedByReason).toEqual({
      "never-screened": 4,
      unreadable: 0,
      expired: 1,
      "new-version": 0,
      incomplete: 1,
    });
    expect(f.lastAttempt).toEqual({
      queued: 1,
      "in-flight": 1,
      "dispatch-failed": 1,
      "no-report-in-time": 1,
      "clone-failed": 1,
    });
    expect(f.incompleteReasons).toEqual({ deadline: 1, "edf-headers-unread": 1 });
    expect(f.flagged?.map((d) => d.dataset_id)).toEqual(["nm000712"]);
    const r = renderIdentifierWeek(f);
    const text = r.lines.join("\n");
    // The screen's own words for each state and cause.
    expect(text).toContain("  clean (acquisition dates only): 1");
    expect(text).toContain("  FOUND IDENTIFIERS: 1");
    expect(text).toContain("GitHub refused to start the screen workflow: 1");
    expect(text).toContain(
      "no report arrived from the screen workflow in time (it may never have started): 1",
    );
    expect(text).toContain("the screen workflow could not read the dataset repository: 1");
    expect(text).toContain(
      "  nm000712 (screened 2026-10-05): edf-patient-name x12, edf-patient-birthdate x12; EDF/BDF files with an identifier finding: 12",
    );
    expect(r.subject).toBe("[NEMAR] Identifier sweep 2026-W40: 1 with identifiers, 6 unchecked");
    expect(r.attention).toBe(true);
  });

  test("date findings are named by their fixed kind words and counts, never warned about (ADR 0090)", () => {
    // What an administrator can already see: a review dataset is listed by id with every kind it
    // has, date kinds included; a dataset with dates only is counted under the screen's own words.
    const f = facts([
      screenedRow("nm000740", "review", 2, {
        findings_by_kind: { "tooling-debris": 1, "edf-startdate": 3, "acq-time-dated": 2 },
      }),
      screenedRow("nm000741", "dates-only", 2, { findings_by_kind: { "edf-startdate": 5 } }),
      screenedRow("nm000742", "dates-only", 2, { findings_by_kind: { "acq-time-dated": 1 } }),
    ]);
    expect(f.review?.map((d) => d.dataset_id)).toEqual(["nm000740"]);
    expect(f.flagged).toEqual([]);
    const text = renderIdentifierWeek(f).lines.join("\n");
    expect(text).toContain(
      "  nm000740 (screened 2026-10-05): tooling-debris x1, edf-startdate x3, acq-time-dated x2",
    );
    expect(text).toContain("  clean (acquisition dates only): 2");
    // The warning is for the people who deposit; the weekly report keeps its counts.
    expect(text).not.toContain("Warning: acquisition dates");
    expect(text).not.toContain("NEMAR does not change them");
  });

  test("a finding stays listed after its screen ages out of the cycle, and says so", () => {
    const f = facts([
      screenedRow("nm000720", "direct-identifiers", 40, {
        findings_by_kind: { "edf-patient-code": 3 },
      }),
    ]);
    expect(f.screened).toBe(0);
    expect(f.flagged).toEqual([
      {
        dataset_id: "nm000720",
        screened_on: "2026-08-28",
        standing: "expired",
        findings_by_kind: { "edf-patient-code": 3 },
        edf_bdf_files_flagged: null,
      },
    ]);
    expect(renderIdentifierWeek(f).lines.join("\n")).toContain(
      "  nm000720 (screened 2026-08-28, the last screen is older than the cycle): edf-patient-code x3",
    );
  });

  test("a quiet week says nothing needs attention, and work in progress is not a problem", () => {
    const quiet = facts([
      screenedRow("nm000730", "clean", 3),
      row("nm000731"), // a new dataset, queued
      row("nm000732", { attempt: "pending", attempted_at: sqlite(NOW_MS - 600_000) }),
    ]);
    // A screen was dispatched in the window, so the sweep is alive.
    quiet.dispatchedInWindow = 1;
    expect(attentionReasons(quiet)).toEqual([]);
    expect(renderIdentifierWeek(quiet).headline).toBe("Nothing needs attention this week.");
  });

  test("each kind of trouble is named in the headline", () => {
    const cases: [IdentifierSweepRow, string][] = [
      [screenedRow("nm000740", "direct-identifiers", 2), "1 datasets with direct identifiers"],
      [
        row("nm000741", { attempt: "error", attempt_error: "dispatch-unconfigured" }),
        "1 unchecked datasets whose last screen did not run or did not report",
      ],
      [screenedRow("nm000742", "unchecked"), "1 screens were incomplete"],
      [screenedRow("nm000743", "clean", 30), "1 datasets fell out of the cycle"],
      [
        { ...screenedRow("nm000744", "clean"), status: "fine" },
        "1 stored results do not read back",
      ],
    ];
    for (const [r, phrase] of cases) {
      const f = facts([r]);
      f.dispatchedInWindow = 1;
      expect(attentionReasons(f)).toEqual([phrase]);
      expect(renderIdentifierWeek(f).headline).toBe(`Needs attention: ${phrase}.`);
    }
  });

  test("liveness: idle only when the sweep had been running and dispatched nothing while work was due", () => {
    // Attempted before the week reported (2026-09-28 to 2026-10-05) and not since.
    const before = row("nm000750", {
      attempt: "reported",
      attempted_at: sqlite(Date.parse("2026-09-20T00:00:00Z")),
    });
    const idle = facts([before], 1);
    expect(idle.dispatchedInWindow).toBe(0);
    expect(identifierWeekLiveness(idle)).toBe("idle");
    expect(attentionReasons(idle)).toContain("the sweep dispatched no screen while work was owed");
    expect(renderIdentifierWeek(idle).lines).toContain(
      "The sweep dispatched no screen this week while 1 datasets were owed one: it is not running, or every dispatch is refused.",
    );
    // Work due and nothing ever attempted: never, and that needs a person.
    const never = facts([row("nm000751")], 1);
    expect(identifierWeekLiveness(never)).toBe("never");
    expect(attentionReasons(never)).toContain("the sweep has never dispatched a screen");
    // The first report after a deploy: the sweep's first attempt is after the week.
    const first = facts(
      [row("nm000752", { attempt: "pending", attempted_at: sqlite(NOW_MS - 600_000) })],
      5,
    );
    expect(identifierWeekLiveness(first)).toBe("not-yet");
    expect(attentionReasons(first)).toEqual([]);
    expect(renderIdentifierWeek(first).lines).toContain(
      "The sweep began after this week ended, so the week says nothing about it.",
    );
    // Nothing due and nothing dispatched all week: silence is not evidence (ADR 0053).
    // Screened ten days before NOW, so its attempt is outside the week reported.
    const quiet = facts([screenedRow("nm000753", "clean", 10)], 0);
    expect(quiet.dispatchedInWindow).toBe(0);
    expect(identifierWeekLiveness(quiet)).toBe("ok");
    expect(attentionReasons(quiet)).toEqual([]);
  });

  test("dispatched and stored this week are counted from the rows, and a refused dispatch is not a dispatch", () => {
    const inWeek = sqlite(Date.parse("2026-10-01T12:00:00Z"));
    const f = facts([
      // Dispatched in the week and reported in the week.
      { ...screenedRow("nm000754", "clean"), attempted_at: inWeek, checked_at: inWeek },
      // Dispatched in the week, still running.
      row("nm000755", { attempt: "pending", attempted_at: inWeek }),
      // Dispatched in the week, never reported: GitHub may have taken it.
      row("nm000756", {
        attempt: "unreported",
        attempt_error: "no-report-in-time",
        attempted_at: inWeek,
      }),
      // Claimed in the week and refused before GitHub: not a dispatch.
      row("nm000757", { attempt: "error", attempt_error: "dispatch-failed", attempted_at: inWeek }),
      row("nm000758", {
        attempt: "error",
        attempt_error: "dispatch-unconfigured",
        attempted_at: inWeek,
      }),
      // Dispatched after the week.
      row("nm000759", { attempt: "pending", attempted_at: sqlite(NOW_MS - 600_000) }),
    ]);
    expect(f.dispatchedInWindow).toBe(3);
    expect(f.storedInWindow).toBe(1);
    expect(f.firstAttemptAt).toBe("2026-10-01T12:00:00.000Z");
  });

  test("unknown is never zero: unreadable records make every figure unknown, and the week needs attention", () => {
    const f = unknownIdentifierWeek(NOW, null, null, ["the sweep's records could not be read"], 28);
    const r = renderIdentifierWeek(f);
    expect(r.attention).toBe(true);
    expect(r.subject).toBe(
      "[NEMAR] Identifier sweep 2026-W40: unknown with identifiers, unknown unchecked",
    );
    const text = r.lines.join("\n");
    for (const line of [
      "Public datasets in scope: unknown",
      "Screened this cycle: unknown",
      "Unchecked: unknown",
      "Owed a screen: unknown (due now: unknown; the rest wait out a retry backoff)",
      "Latest screen this week did not run or did not report: unknown datasets",
      "Datasets with direct identifiers (last finding, kinds and counts): unknown",
      "Whether the sweep ran this week: unknown",
      "Could not read: the sweep's records could not be read.",
    ]) {
      expect(text).toContain(line);
    }
    // No figure rendered as 0 anywhere.
    expect(text).not.toMatch(/: 0\b/);
    expect(text).not.toMatch(/for 0 datasets/);
  });

  test("review is listed after the identifiers, bounded, with a count and a pointer", () => {
    const rows = Array.from({ length: 53 }, (_, i) =>
      screenedRow(`nm0008${String(i).padStart(2, "0")}`, "review", 1, {
        findings_by_kind: { "tooling-debris": 1 },
      }),
    );
    const r = renderIdentifierWeek(facts(rows));
    expect(r.lines).toContain("Datasets that need review (last finding, kinds and counts): 53");
    expect(r.lines.filter((l) => l.startsWith("  nm0008"))).toHaveLength(50);
    expect(r.lines).toContain("  and 3 more (GET /admin/identifier-sweep lists them all)");
  });
});

// ============================================================================
// The send, against real migrations and the real tick and callback
// ============================================================================

const SECRET = "sweep-report-secret";
const ADMIN_KEY = "sweep-report-admin-0123456789abcdef0123456789abcdef";
let server: Server;
let dispatches: { client_payload: { dataset_id: string; callback_token: string } }[] = [];
let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let ownerId: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/repos/nemarDatasets/.github/dispatches") {
        dispatches.push(await req.json());
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

afterEach(() => {
  dispatches = [];
});

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_sweep_report",
    PRESCREEN_CALLBACK_SECRET: SECRET,
    API_BASE_URL: "https://api.test.nemar.org",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    ...over,
  } as Bindings;
}

async function seedUser(username: string, role: string, prefs?: Record<string, boolean>) {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, email_preferences)
     VALUES (?, ?, 'x', 'approved', ?, 1, ?)`,
    [username, `${username}@example.org`, role, prefs ? JSON.stringify(prefs) : null],
  );
  return db.query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?").get(username)
    ?.id as number;
}

function seedDataset(id: string, visibility = "public") {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, github_repo)
     VALUES (?, ?, ?, 'active', ?, ?)`,
    [id, `Dataset ${id}`, ownerId, visibility, `nemarDatasets/${id}`],
  );
}

async function answer(id: string, report: unknown) {
  const d = dispatches.find((x) => x.client_payload.dataset_id === id);
  if (!d) throw new Error(`no dispatch for ${id}`);
  const res = await app.request(
    "/webhooks/identifier-sweep-result",
    {
      method: "POST",
      headers: { "X-Webhook-Token": d.client_payload.callback_token },
      body: JSON.stringify({ dataset_id: id, request_id: 0, report }),
    },
    env(),
  );
  expect(res.status).toBe(200);
}

/** The week that holds real `datetime('now')` stamps is the one a report made a week later covers. */
const nextWeek = () => new Date(Date.now() + 7 * DAY);

function auditRows(action: string) {
  return db
    .query<{ resource_id: string; details: string | null }, [string]>(
      "SELECT resource_id, details FROM audit_log WHERE action = ? ORDER BY id",
    )
    .all(action);
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/webhooks", webhooks);
  app.route("/admin", adminRoutes);
  ownerId = await seedUser("reportowner", "member");
  const adminId = await seedUser("reportadmin", "admin");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    adminId,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
});

describe("the weekly send", () => {
  test("arrives once a week, says what the sweep found in the screen's words, and records the week", async () => {
    seedDataset("nm000760");
    seedDataset("nm000761");
    seedDataset("nm000762");
    seedDataset("nm000763", "private");
    await runIdentifierSweepTick(env());
    await answer("nm000760", scanBody("nm000760", "clean"));
    await answer(
      "nm000761",
      scanBody("nm000761", "direct-identifiers", {
        findings_by_kind: { "edf-patient-name": 2 },
        edf_bdf_files_flagged: 2,
      }),
    );
    // nm000762 never reports; its attempt is still in flight.
    const when = nextWeek();
    await withFakeResend(async (calls: CapturedEmail[]) => {
      const first = await sendIdentifierSweepWeeklyReport(env(), when);
      expect(first).toMatchObject({ claimed: true, attempted: 1, delivered: 1, attention: true });
      const sends = calls.filter((c) => c.path === "/emails").map(asSend);
      expect(sends).toHaveLength(1);
      const mail = sends[0] as { to: string[]; subject: string; html: string };
      expect(mail.to).toEqual(["reportadmin@example.org"]);
      expect(mail.subject).toBe(
        `[NEMAR] Identifier sweep ${reportWindow(when).week}: 1 with identifiers, 1 unchecked`,
      );
      expect(mail.html).toContain("Public datasets in scope: 3");
      expect(mail.html).toContain("Screened this cycle: 2");
      expect(mail.html).toContain("nm000761 (screened ");
      expect(mail.html).toContain("edf-patient-name x2");
      expect(mail.html).toContain("a screen is running: 1");
      expect(mail.html).not.toContain("nm000763");

      // The second tick of the week finds it sent: no claim, no mail.
      const second = await sendIdentifierSweepWeeklyReport(env(), when);
      expect(second?.claimed).toBe(false);
      expect(calls.filter((c) => c.path === "/emails")).toHaveLength(1);
    });
    const sent = auditRows(IDENTIFIER_SWEEP_REPORT_SENT_ACTION);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.resource_id).toBe(reportWindow(when).week);
    expect(JSON.parse(sent[0]?.details as string)).toMatchObject({
      delivered: 1,
      scope: 3,
      screened: 2,
      unchecked: 1,
      with_identifiers: 1,
    });
  });

  test("arrives when nothing is wrong, too", async () => {
    seedDataset("nm000765");
    await runIdentifierSweepTick(env());
    await answer("nm000765", scanBody("nm000765", "clean"));
    await withFakeResend(async (calls: CapturedEmail[]) => {
      const out = await sendIdentifierSweepWeeklyReport(env(), nextWeek());
      expect(out).toMatchObject({ claimed: true, delivered: 1, attention: false });
      const mail = asSend(calls.find((c) => c.path === "/emails") as CapturedEmail);
      expect(mail.html).toContain("Nothing needs attention this week.");
    });
  });

  test("records it could not read are stated as unknown, and the report still goes", async () => {
    seedDataset("nm000766");
    const failing = interceptingD1(realD1(db), (sql) => {
      if (sql === IDENTIFIER_SWEEP_ROWS_SQL) throw new Error("D1 unavailable");
    });
    await withFakeResend(async (calls: CapturedEmail[]) => {
      const out = await sendIdentifierSweepWeeklyReport({ ...env(), DB: failing }, nextWeek());
      expect(out).toMatchObject({ claimed: true, delivered: 1, attention: true });
      const mail = asSend(calls.find((c) => c.path === "/emails") as CapturedEmail);
      expect(mail.subject).toContain("unknown with identifiers, unknown unchecked");
      expect(mail.html).toContain("Public datasets in scope: unknown");
      expect(mail.html).toContain("Could not read: the sweep&#39;s records could not be read.");
    });
  });

  test("a claim that cannot be written sends nothing (fails closed)", async () => {
    seedDataset("nm000767");
    const failing = interceptingD1(realD1(db), (sql) => {
      if (sql.includes(IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION) && sql.startsWith("INSERT")) {
        throw new Error("D1 unavailable");
      }
    });
    await withFakeResend(async (calls: CapturedEmail[]) => {
      const out = await sendIdentifierSweepWeeklyReport({ ...env(), DB: failing }, nextWeek());
      expect(out?.claimed).toBe(false);
      expect(calls).toHaveLength(0);
    });
  });

  test("a send that reached nobody is not recorded; it is retried after the lease, up to the cap", async () => {
    seedDataset("nm000768");
    const when = nextWeek();
    const week = reportWindow(when).week;
    await withFakeResend(
      async (calls: CapturedEmail[]) => {
        const out = await sendIdentifierSweepWeeklyReport(env(), when);
        expect(out).toMatchObject({ claimed: true, attempted: 1, delivered: 0 });
        expect(calls.filter((c) => c.path === "/emails")).toHaveLength(1);
      },
      { status: 500 },
    );
    expect(auditRows(IDENTIFIER_SWEEP_REPORT_SENT_ACTION)).toHaveLength(0);
    // Inside the lease, the next tick does not claim.
    await withFakeResend(async (calls: CapturedEmail[]) => {
      expect((await sendIdentifierSweepWeeklyReport(env(), when))?.claimed).toBe(false);
      expect(calls).toHaveLength(0);
    });
    // After it, the week is tried again and sent.
    db.run("UPDATE audit_log SET timestamp = datetime('now', '-121 minutes') WHERE action = ?", [
      IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION,
    ]);
    await withFakeResend(async (calls: CapturedEmail[]) => {
      expect(await sendIdentifierSweepWeeklyReport(env(), when)).toMatchObject({
        claimed: true,
        delivered: 1,
      });
      expect(calls.filter((c) => c.path === "/emails")).toHaveLength(1);
    });
    expect(auditRows(IDENTIFIER_SWEEP_REPORT_SENT_ACTION).map((r) => r.resource_id)).toEqual([
      week,
    ]);
    // Once sent, the week stays sent: a lapsed lease does not reopen it.
    db.run("UPDATE audit_log SET timestamp = datetime('now', '-1 days') WHERE action = ?", [
      IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION,
    ]);
    await withFakeResend(async (calls: CapturedEmail[]) => {
      expect((await sendIdentifierSweepWeeklyReport(env(), when))?.claimed).toBe(false);
      expect(calls).toHaveLength(0);
    });
  });

  test(`no more than ${IDENTIFIER_SWEEP_REPORT_MAX_CLAIMS} claims in a week, however the record fails`, async () => {
    seedDataset("nm000769");
    const when = nextWeek();
    const week = reportWindow(when).week;
    for (let i = 0; i < IDENTIFIER_SWEEP_REPORT_MAX_CLAIMS; i++) {
      db.run(
        `INSERT INTO audit_log (user_id, action, resource_type, resource_id, timestamp)
         VALUES (NULL, ?, 'identifier_sweep', ?, datetime('now', '-1 days'))`,
        [IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION, week],
      );
    }
    await withFakeResend(async (calls: CapturedEmail[]) => {
      const out = await sendIdentifierSweepWeeklyReport(env(), when);
      expect(out?.claimed).toBe(false);
      // Out of claims with nothing sent: the week will not arrive, and it says so.
      expect(out?.exhausted).toBe(true);
      expect(calls).toHaveLength(0);
    });
    // One fewer, and the week is claimed again.
    db.run("DELETE FROM audit_log WHERE id = (SELECT MAX(id) FROM audit_log WHERE action = ?)", [
      IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION,
    ]);
    await withFakeResend(async () => {
      expect((await sendIdentifierSweepWeeklyReport(env(), when))?.claimed).toBe(true);
    });
  });

  test("an admin who opted out of identifier_sweep is not mailed while another is", async () => {
    await seedUser("optedout", "admin", { identifier_sweep: false });
    await withFakeResend(async (calls: CapturedEmail[]) => {
      await sendIdentifierSweepWeeklyReport(env(), nextWeek());
      const to = calls.filter((c) => c.path === "/emails").flatMap((c) => asSend(c).to);
      expect(to).toEqual(["reportadmin@example.org"]);
    });
  });

  test("a send refused outright does not count toward the cap, so a broken key does not burn the week", async () => {
    seedDataset("nm000790");
    const when = nextWeek();
    for (let i = 0; i < IDENTIFIER_SWEEP_REPORT_MAX_CLAIMS + 2; i++) {
      await withFakeResend(
        async () => {
          const out = await sendIdentifierSweepWeeklyReport(env(), when);
          expect(out).toMatchObject({ claimed: true, delivered: 0 });
        },
        { status: 401 },
      );
      db.run("UPDATE audit_log SET timestamp = datetime('now', '-121 minutes') WHERE action = ?", [
        IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION,
      ]);
    }
    await withFakeResend(async () => {
      expect(await sendIdentifierSweepWeeklyReport(env(), when)).toMatchObject({
        claimed: true,
        delivered: 1,
      });
    });
  });

  test("a send that ended without an answer counts toward the cap: it may have been delivered", async () => {
    seedDataset("nm000795");
    const when = nextWeek();
    await withFakeResend(
      async () => {
        const out = await sendIdentifierSweepWeeklyReport(env(), when);
        expect(out).toMatchObject({ claimed: true, delivered: 0, ambiguous: 1 });
      },
      { status: 503 },
    );
    const claims = auditRows(IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.details).toBeNull();
  });

  test("a delivered report whose record cannot be written counts toward the cap, and may be sent again", async () => {
    seedDataset("nm000791");
    const when = nextWeek();
    const failing = interceptingD1(realD1(db), (sql) => {
      if (sql.startsWith("INSERT") && sql.includes("VALUES") && !sql.includes("SELECT NULL")) {
        throw new Error("D1 unavailable");
      }
    });
    await withFakeResend(async (calls: CapturedEmail[]) => {
      const out = await sendIdentifierSweepWeeklyReport({ ...env(), DB: failing }, when);
      expect(out).toMatchObject({ claimed: true, delivered: 1 });
      expect(calls.filter((c) => c.path === "/emails")).toHaveLength(1);
    });
    expect(auditRows(IDENTIFIER_SWEEP_REPORT_SENT_ACTION)).toHaveLength(0);
    const claims = auditRows(IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION);
    expect(claims).toHaveLength(1);
    // Unmarked: it may have mailed someone, so it counts toward the cap.
    expect(claims[0]?.details).toBeNull();
  });

  test("a failed send is logged without the admin's address", async () => {
    seedDataset("nm000794");
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      await withFakeResend(
        async () => {
          await sendIdentifierSweepWeeklyReport(env(), nextWeek());
        },
        { status: 500 },
      );
    } finally {
      console.error = realError;
    }
    const line = logged.find((l) => l.startsWith("Failed to send the identifier sweep report"));
    expect(line).toBeDefined();
    expect(line).not.toContain("reportadmin@example.org");
    expect(line).toContain("r***@example.org");
  });

  test("a report delivered to some admins and not others is recorded, with both counts", async () => {
    await seedUser("secondadmin", "admin");
    seedDataset("nm000792");
    let n = 0;
    const realFetch = globalThis.fetch;
    await withFakeResend(async () => {
      const resendFetch = globalThis.fetch;
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname === "api.resend.com" && ++n === 2) {
          return Promise.resolve(Response.json({ message: "refused" }, { status: 422 }));
        }
        return resendFetch(input as RequestInfo, init);
      }) as typeof fetch;
      try {
        const out = await sendIdentifierSweepWeeklyReport(env(), nextWeek());
        expect(out).toMatchObject({ claimed: true, attempted: 2, delivered: 1 });
      } finally {
        globalThis.fetch = resendFetch;
      }
    });
    expect(globalThis.fetch).toBe(realFetch);
    const sent = auditRows(IDENTIFIER_SWEEP_REPORT_SENT_ACTION);
    expect(JSON.parse(sent[0]?.details as string)).toMatchObject({ delivered: 1, attempted: 2 });
  });

  test("a queue that cannot be counted is unknown, and the week says it cannot tell whether the sweep ran", async () => {
    seedDataset("nm000793");
    const failing = interceptingD1(realD1(db), (sql) => {
      if (sql.startsWith("SELECT COUNT(*) AS n") && sql.includes("GLOB")) throw new Error("boom");
    });
    await withFakeResend(async (calls: CapturedEmail[]) => {
      const out = await sendIdentifierSweepWeeklyReport({ ...env(), DB: failing }, nextWeek());
      expect(out).toMatchObject({ claimed: true, delivered: 1, attention: true });
      const mail = asSend(calls.find((c) => c.path === "/emails") as CapturedEmail);
      expect(mail.html).toContain("Owed a screen: unknown (due now: unknown;");
      expect(mail.html).toContain("Whether the sweep ran this week: unknown");
      expect(mail.html).toContain("Could not read: the queue could not be counted.");
    });
  });

  for (const environment of ["development", "staging", "test"]) {
    test(`ENVIRONMENT=${environment}: nothing is claimed and nothing is mailed`, async () => {
      seedDataset("nm000770");
      await withFakeResend(async (calls: CapturedEmail[]) => {
        expect(await sendIdentifierSweepWeeklyReport(env({ ENVIRONMENT: environment }))).toBeNull();
        // The opt-in that lets staging test admin mail does not open this one either.
        expect(
          await sendIdentifierSweepWeeklyReport(
            env({ ENVIRONMENT: environment, DEV_ADMIN_NOTIFICATIONS: "1" }),
          ),
        ).toBeNull();
        expect(calls).toHaveLength(0);
      });
      expect(auditRows(IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION)).toHaveLength(0);
    });
  }
});

describe("one bad row", () => {
  test("a report stamp that is not an object is that dataset's unreadable, not the week's unknown", async () => {
    seedDataset("nm000785");
    seedDataset("nm000786");
    await runIdentifierSweepTick(env());
    await answer("nm000785", scanBody("nm000785", "clean"));
    await answer("nm000786", scanBody("nm000786", "clean"));
    db.run(
      `UPDATE datasets SET sweep_stamps = json_set(sweep_stamps, '$.identifier_sweep_report', 'not json {')
        WHERE dataset_id = 'nm000786'`,
    );
    const res = await app.request(
      "/admin/identifier-sweep",
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    const body = (await res.json()) as {
      facts: {
        scope: number;
        screened: number;
        errors: string[];
        uncheckedByReason: Record<string, number>;
      };
    };
    expect(body.facts.errors).toEqual([]);
    expect(body.facts.scope).toBe(2);
    expect(body.facts.screened).toBe(1);
    expect(body.facts.uncheckedByReason.unreadable).toBe(1);
  });
});

describe("round two: the weekly record", () => {
  test("a week is not called exhausted while its last claim may still be sending", async () => {
    const when = nextWeek();
    const week = reportWindow(when).week;
    for (let i = 0; i < IDENTIFIER_SWEEP_REPORT_MAX_CLAIMS; i++) {
      db.run(
        `INSERT INTO audit_log (user_id, action, resource_type, resource_id, timestamp)
         VALUES (NULL, ?, 'identifier_sweep', ?, datetime('now', ?))`,
        [IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION, week, i === 0 ? "-10 minutes" : "-1 days"],
      );
    }
    expect(await weeklyRecordState(realD1(db), when)).toMatchObject({
      sent: false,
      counted: IDENTIFIER_SWEEP_REPORT_MAX_CLAIMS,
      exhausted: false,
    });
    db.run("UPDATE audit_log SET timestamp = datetime('now', '-1 days') WHERE action = ?", [
      IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION,
    ]);
    expect((await weeklyRecordState(realD1(db), when))?.exhausted).toBe(true);
  });

  test("a dataset waiting out its backoff is owed but not due", async () => {
    seedDataset("nm000796");
    const failing = env();
    // A refused dispatch (422) leaves the dataset in its 6-hour backoff.
    const github = (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL;
    const refuse = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 422 }) });
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
      `http://127.0.0.1:${refuse.port}`;
    try {
      await runIdentifierSweepTick(failing);
    } finally {
      (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = github;
      refuse.stop(true);
    }
    const res = await app.request(
      "/admin/identifier-sweep",
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    const body = (await res.json()) as { facts: { due: number; owed: number } };
    expect(body.facts.due).toBe(0);
    expect(body.facts.owed).toBe(1);
  });
});

describe("GET /admin/identifier-sweep", () => {
  test("renders the report on demand, on staging too, and sends nothing", async () => {
    seedDataset("nm000780");
    await withFakeResend(async (calls: CapturedEmail[]) => {
      const res = await app.request(
        "/admin/identifier-sweep",
        { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
        env({ ENVIRONMENT: "staging" }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        facts: { scope: number; unchecked: number };
        report: { lines: string[]; attention: boolean };
      };
      expect(body.facts.scope).toBe(1);
      expect(body.facts.unchecked).toBe(1);
      expect(body.report.lines).toContain("  never screened: 1");
      expect(calls).toHaveLength(0);
      expect((body as unknown as { weekly: unknown }).weekly).toMatchObject({
        sent: false,
        counted: 0,
        exhausted: false,
      });
    });
    expect(auditRows(IDENTIFIER_SWEEP_REPORT_CLAIM_ACTION)).toHaveLength(0);
  });
});
