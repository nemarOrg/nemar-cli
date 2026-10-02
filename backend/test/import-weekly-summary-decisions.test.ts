/**
 * Weekly import summary DECISIONS (epic #1306 phase 4, #1312). Pure, no I/O.
 *
 * Two things carry this phase, and they are what this file is about:
 *
 *   1. **A zero and an unknown must never render the same way.** "0 imports" and
 *      "no data about imports" looked alike, and that is how the original incident
 *      stayed invisible. Every count is `number | null` and the tests below assert
 *      both renderings for the same field.
 *   2. **The ISO week label is the dedup key**, so getting it wrong does not produce
 *      a cosmetic bug -- it produces two weeks claiming one title, or one week filed
 *      twice under two. The ISO year is not the calendar year at boundaries, so
 *      those are tested against independently-known values rather than against the
 *      implementation's own output.
 */

import { describe, expect, test } from "bun:test";
import {
  WEEKLY_MAX_LISTED_IDS,
  type WeeklySummaryFacts,
  buildWeeklyRolloverComment,
  buildWeeklySummaryBody,
  count,
  daysSince,
  decideWeeklySummaryGate,
  isoWeekLabel,
  shouldRunWeeklySummary,
  weeklyHeadline,
  weeklySummaryLogLine,
} from "../src/services/import-weekly-summary";

/** A healthy week with everything known. Overridden per test. */
function facts(over: Partial<WeeklySummaryFacts> = {}): WeeklySummaryFacts {
  return {
    week: "2026-W37",
    windowStart: "2026-09-02T03:00:00.000Z",
    windowEnd: "2026-09-09T03:00:00.000Z",
    importedThisWeek: 9,
    importedTotal: 764,
    coverageStatus: "healthy",
    coverageReason: "2 outstanding, below the alarm threshold of 5.",
    outstanding: 2,
    discovered: 766,
    importedNotInScan: 4,
    autoImportEnabled: true,
    dispatchPhrase: "2 hours ago",
    dispatchLost: false,
    failuresByCause: { "auth-invalid": 0, "needs-triage": 0 },
    openFailureTotal: 0,
    parked: [],
    issuesClosed: 3,
    issuesRelabelled: 1,
    neurobagel: {
      runs: 7,
      failedRuns: 0,
      days: { healthy: 7, alarm: 0, unknown: 0, unchecked: 0 },
      latest: {
        at: "2026-09-09T03:00:05.000Z",
        overall: "healthy",
        checks: {
          store: {
            verdict: "healthy",
            reason: "20 eligible dataset(s), 20 written and indexed; no residue.",
          },
          node: {
            verdict: "unchecked",
            reason: "NEUROBAGEL_NODE_URL is not set, so the node is not probed.",
          },
          registration: {
            verdict: "unchecked",
            reason: "NEUROBAGEL_FEDERATION_URL is not set, so registration is not checked.",
          },
          drift: {
            verdict: "healthy",
            reason: "11 pinned release tags and vocabulary files match upstream.",
          },
        },
      },
      anonymityFindings: 0,
    },
    errors: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The ISO week label: the dedup key
// ---------------------------------------------------------------------------

describe("isoWeekLabel", () => {
  /**
   * Independently-known ISO week-dates, not values read back from this function.
   * The four boundary cases are the whole point: the ISO year is NOT the calendar
   * year when January 1st falls Fri/Sat/Sun, or when December 29-31 falls Mon-Wed.
   */
  const known: [string, string][] = [
    ["2026-09-09T12:00:00Z", "2026-W37"], // an ordinary Wednesday
    ["2026-01-01T00:00:00Z", "2026-W01"], // Thursday: W01 of its own year
    ["2025-12-29T00:00:00Z", "2026-W01"], // Monday in DECEMBER belonging to next year's W01
    ["2025-12-28T00:00:00Z", "2025-W52"], // the Sunday immediately before it
    ["2027-01-01T00:00:00Z", "2026-W53"], // Friday in JANUARY belonging to last year's W53
    ["2027-01-04T00:00:00Z", "2027-W01"],
    ["2024-12-30T00:00:00Z", "2025-W01"],
    ["2021-01-01T00:00:00Z", "2020-W53"],
    ["2026-12-31T00:00:00Z", "2026-W53"],
  ];

  for (const [iso, want] of known) {
    test(`${iso} is ${want}`, () => {
      expect(isoWeekLabel(new Date(iso))).toBe(want);
    });
  }

  test("the week is zero-padded, so the series sorts chronologically", () => {
    // Without padding, "2026-W9" sorts AFTER "2026-W10", which would make the
    // rollover close the wrong issue -- it picks the previous week by sorting labels.
    const w9 = isoWeekLabel(new Date("2026-02-26T00:00:00Z"));
    expect(w9).toMatch(/^\d{4}-W\d{2}$/);
    expect([isoWeekLabel(new Date("2026-03-05T00:00:00Z")), w9].sort()[0]).toBe(w9);
  });

  test("every day of a week maps to the same label", () => {
    const monday = Date.UTC(2026, 8, 7); // 2026-09-07 is a Monday
    const labels = new Set<string>();
    for (let i = 0; i < 7; i++) labels.add(isoWeekLabel(new Date(monday + i * 86_400_000)));
    expect([...labels]).toEqual(["2026-W37"]);
  });

  test("consecutive weeks are distinct and every day is covered", () => {
    // Across two year boundaries: no gaps (a day belonging to no week) and no
    // duplicates (a label covering more than 7 days).
    const start = Date.UTC(2025, 11, 1);
    const perLabel = new Map<string, number>();
    for (let i = 0; i < 800; i++) {
      const l = isoWeekLabel(new Date(start + i * 86_400_000));
      perLabel.set(l, (perLabel.get(l) ?? 0) + 1);
    }
    // Only the truncated final label may cover fewer than 7 days.
    const notSeven = [...perLabel.values()].filter((n) => n !== 7);
    expect(notSeven.length).toBeLessThanOrEqual(1);
  });

  test("the label is UTC, not local", () => {
    // A time late on Sunday UTC must not read as Monday because the host is ahead.
    expect(isoWeekLabel(new Date("2026-09-06T23:59:59Z"))).toBe("2026-W36");
    expect(isoWeekLabel(new Date("2026-09-07T00:00:00Z"))).toBe("2026-W37");
  });
});

describe("shouldRunWeeklySummary", () => {
  test("Monday UTC only", () => {
    // 2026-09-07 is a Monday.
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) =>
      shouldRunWeeklySummary(new Date(Date.UTC(2026, 8, 7 + i))),
    );
    expect(days).toEqual([true, false, false, false, false, false, false]);
  });

  test("the boundary is UTC midnight, matching the label", () => {
    expect(shouldRunWeeklySummary(new Date("2026-09-06T23:59:59Z"))).toBe(false);
    expect(shouldRunWeeklySummary(new Date("2026-09-07T00:00:00Z"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The gate: fails CLOSED, unlike auto-import's
// ---------------------------------------------------------------------------

describe("decideWeeklySummaryGate", () => {
  const now = new Date("2026-09-07T03:00:00Z"); // Monday, 2026-W37

  test("never posted before proceeds", () => {
    const g = decideWeeklySummaryGate({ lastRunAt: null, lastRunMs: null, now });
    expect(g.proceed).toBe(true);
  });

  test("already posted this week refuses", () => {
    const g = decideWeeklySummaryGate({
      lastRunAt: "2026-09-07 03:00:00",
      lastRunMs: Date.parse("2026-09-07T03:00:00Z"),
      now,
    });
    expect(g.proceed).toBe(false);
    expect(g.reason).toContain("already posted for 2026-W37");
  });

  test("posted last week proceeds", () => {
    const g = decideWeeklySummaryGate({
      lastRunAt: "2026-08-31 03:00:00",
      lastRunMs: Date.parse("2026-08-31T03:00:00Z"),
      now,
    });
    expect(g.proceed).toBe(true);
    expect(g.reason).toContain("2026-W36");
  });

  /**
   * The direction that matters, and it is the OPPOSITE of `decideAutoImportGate`,
   * which fails open on the same input. The daily cron evaluates this once a day, so
   * failing open on an unreadable value would post a duplicate weekly issue EVERY
   * DAY for as long as the value stayed bad -- the notification fatigue this epic
   * exists to prevent, arriving from the tool built to prevent it.
   */
  test("an unreadable timestamp refuses rather than risking one issue per day", () => {
    const g = decideWeeklySummaryGate({ lastRunAt: "not-a-timestamp", lastRunMs: null, now });
    expect(g.proceed).toBe(false);
    expect(g.reason).toContain("unreadable");
    expect(g.reason).toContain("one issue per day");
  });

  test("a week apart across a year boundary still proceeds", () => {
    // 2026-W53 -> 2027-W01: a naive year comparison would see 2026 vs 2027 and a
    // naive week-number comparison would see 53 vs 1. The label comparison is right.
    const g = decideWeeklySummaryGate({
      lastRunAt: "2026-12-28 03:00:00",
      lastRunMs: Date.parse("2026-12-28T03:00:00Z"),
      now: new Date("2027-01-04T03:00:00Z"),
    });
    expect(g.proceed).toBe(true);
  });
});

describe("daysSince", () => {
  test("null anchor is unknown, not zero days", () => {
    expect(daysSince(null, Date.now())).toBeNull();
  });

  test("whole days, floored, never negative", () => {
    const now = Date.parse("2026-09-09T12:00:00Z");
    expect(daysSince(Date.parse("2026-09-08T12:00:00Z"), now)).toBe(1);
    expect(daysSince(Date.parse("2026-09-09T11:00:00Z"), now)).toBe(0);
    expect(daysSince(Date.parse("2026-09-10T12:00:00Z"), now)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE headline property: unknown is not zero
// ---------------------------------------------------------------------------

describe("a zero and an unknown never render the same way", () => {
  test("count renders them differently", () => {
    expect(count(0)).toBe("0");
    expect(count(null)).toBe("unknown");
    expect(count(null)).not.toBe(count(0));
  });

  /**
   * The same field, both ways, in the real body. This is the regression that would
   * re-create the original incident: a dashboard of zeroes reads as a quiet week.
   */
  test("zero imports and unknown imports produce different bodies", () => {
    const zero = buildWeeklySummaryBody(facts({ importedThisWeek: 0 }), "2026-09-09T00:00:00Z");
    const unknown = buildWeeklySummaryBody(
      facts({ importedThisWeek: null }),
      "2026-09-09T00:00:00Z",
    );
    expect(zero).toContain("| Imported this week | 0 |");
    expect(unknown).toContain("| Imported this week | unknown |");
    expect(zero).not.toBe(unknown);
  });

  test("every nullable count renders as unknown when null", () => {
    const body = buildWeeklySummaryBody(
      facts({
        importedThisWeek: null,
        importedTotal: null,
        outstanding: null,
        discovered: null,
        importedNotInScan: null,
        openFailureTotal: null,
      }),
      "2026-09-09T00:00:00Z",
    );
    // Six fields, so at least six unknowns; none of them may be a zero.
    expect(body.match(/unknown/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(body).not.toContain("| Imported this week | 0 |");
    expect(body).not.toContain("| Managed OpenNeuro mirrors in total | 0 |");
  });

  test("an unreadable section says unknown rather than being omitted", () => {
    // Omitting it would be the same mistake in a different shape: a missing section
    // reads as "nothing to report".
    const body = buildWeeklySummaryBody(
      facts({ failuresByCause: null, parked: null }),
      "2026-09-09T00:00:00Z",
    );
    expect(body).toContain("Open failures by cause");
    expect(body).toContain("Blocklisted datasets");
    expect((body.match(/\*\*unknown\*\*, not zero/g) ?? []).length).toBe(2);
  });

  test("a coverage verdict of unknown blanks its numbers and says so", () => {
    const body = buildWeeklySummaryBody(
      facts({ coverageStatus: "unknown", outstanding: null, discovered: null }),
      "2026-09-09T00:00:00Z",
    );
    expect(body).toContain("Datasets outstanding (nothing is working on them): unknown");
  });

  test("no sweep activity is unknown, and explains the ambiguity", () => {
    // Genuinely ambiguous: either nothing happened, or the crons have not written
    // their first audit row. Saying 0 would pick one and be wrong half the time.
    const body = buildWeeklySummaryBody(
      facts({ issuesClosed: null, issuesRelabelled: null }),
      "2026-09-09T00:00:00Z",
    );
    expect(body).toContain("unknown rather than zero");
    expect(body).toContain("not that they ran and found nothing");
  });
});

// ---------------------------------------------------------------------------
// The headline, which is the first thing read
// ---------------------------------------------------------------------------

describe("weeklyHeadline", () => {
  test("a clean week says nothing needs attention", () => {
    const h = weeklyHeadline(facts());
    expect(h.attention).toBe(false);
    expect(h.line).toContain("Nothing needs attention");
  });

  test("an unknown counts as needing attention", () => {
    // A report that cannot see is not a report that found nothing. This is the
    // property that stops a broken reporter from reading as a healthy week.
    const h = weeklyHeadline(facts({ coverageStatus: "unknown" }));
    expect(h.attention).toBe(true);
    expect(h.line).toContain("could not be determined");
  });

  test("a failed section counts as needing attention", () => {
    const h = weeklyHeadline(facts({ errors: [{ stage: "parked", error: "boom" }] }));
    expect(h.attention).toBe(true);
    expect(h.line).toContain("1 part(s) of this report failed");
  });

  test("a disabled importer is named in the first line", () => {
    const h = weeklyHeadline(facts({ autoImportEnabled: false }));
    expect(h.attention).toBe(true);
    expect(h.line).toContain("auto-import is OFF");
  });

  test("a lost hand-off is named in the first line", () => {
    const h = weeklyHeadline(facts({ dispatchLost: true }));
    expect(h.attention).toBe(true);
    expect(h.line).toContain("not landing");
  });

  test("several problems are all named, not just the first", () => {
    const h = weeklyHeadline(
      facts({ autoImportEnabled: false, dispatchLost: true, coverageStatus: "alarm" }),
    );
    expect(h.line).toContain("coverage is alarming");
    expect(h.line).toContain("auto-import is OFF");
    expect(h.line).toContain("not landing");
  });
});

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

describe("buildWeeklySummaryBody", () => {
  const nowIso = "2026-09-09T03:00:00.000Z";

  test("leads with the week and the verdict, then the window", () => {
    const body = buildWeeklySummaryBody(facts(), nowIso);
    const lines = body.split("\n");
    expect(lines[0]).toBe("# Import summary, 2026-W37");
    expect(lines[2]).toContain("Nothing needs attention");
    // The window has to be stated: an unstated window cannot be checked.
    expect(body).toContain("2026-09-02T03:00:00.000Z to 2026-09-09T03:00:00.000Z (UTC)");
  });

  test("mentions @nemarAdmin, which is what makes a human read it", () => {
    expect(buildWeeklySummaryBody(facts(), nowIso)).toContain("@nemarAdmin");
  });

  test("only non-zero causes get a row, and the total is always stated", () => {
    const body = buildWeeklySummaryBody(
      facts({
        failuresByCause: { "auth-invalid": 3, "needs-triage": 0, timeout: 1 },
        openFailureTotal: 4,
      }),
      nowIso,
    );
    expect(body).toContain("| `auth-invalid` | 3 |");
    expect(body).toContain("| `timeout` | 1 |");
    expect(body).not.toContain("needs-triage");
    expect(body).toContain("Total: 4.");
  });

  test("no open failures says so, with the total, rather than an empty table", () => {
    const body = buildWeeklySummaryBody(facts(), nowIso);
    expect(body).toContain("No open failures. (Total: 0.)");
  });

  test("parked datasets show their reason and duration, unknown when unanchored", () => {
    const body = buildWeeklySummaryBody(
      facts({
        parked: [
          { datasetId: "on004148", reason: "upstream_403_after_window", parkedDays: 64 },
          { datasetId: "on005279", reason: "no_source", parkedDays: null },
        ],
      }),
      nowIso,
    );
    expect(body).toContain("| on004148 | upstream_403_after_window | 64 days |");
    // The anchor column is NULL on rows predating the retry engine, and then the
    // duration is genuinely unknown -- "0 days" would say "parked today".
    expect(body).toContain("| on005279 | no_source | unknown |");
  });

  test("an empty parked list is none, not an empty table", () => {
    expect(buildWeeklySummaryBody(facts(), nowIso)).toContain("_none_");
  });

  test("a long parked list is truncated with a count (ADR 0036)", () => {
    const many = Array.from({ length: WEEKLY_MAX_LISTED_IDS + 5 }, (_, i) => ({
      datasetId: `on${String(i).padStart(6, "0")}`,
      reason: "no_source",
      parkedDays: i,
    }));
    const body = buildWeeklySummaryBody(facts({ parked: many }), nowIso);
    expect(body).toContain("...and 5 more.");
  });

  test("failed sections are listed, so a gap is never mistaken for a zero", () => {
    const body = buildWeeklySummaryBody(
      facts({ errors: [{ stage: "parked", error: "D1 timeout" }] }),
      nowIso,
    );
    expect(body).toContain("Parts of this report that failed");
    expect(body).toContain("`parked`: D1 timeout");
  });

  test("a clean report has no failure section at all", () => {
    expect(buildWeeklySummaryBody(facts(), nowIso)).not.toContain(
      "Parts of this report that failed",
    );
  });

  test("says why it arrives even when nothing is wrong", () => {
    // The justification belongs in the artifact: a reader who gets a boring report
    // every week needs to know that is the design, not a bug.
    expect(buildWeeklySummaryBody(facts(), nowIso)).toContain(
      "cannot tell a healthy week from a broken reporter",
    );
  });

  test("a disabled importer is bolded in the table, not just mentioned", () => {
    const body = buildWeeklySummaryBody(facts({ autoImportEnabled: false }), nowIso);
    expect(body).toContain("**not `true`**");
  });
});

describe("buildWeeklyRolloverComment", () => {
  test("points forward and says the numbers are frozen", () => {
    const c = buildWeeklyRolloverComment("2026-W38", 901, "2026-09-14T03:00:00Z");
    expect(c).toContain("2026-W38");
    expect(c).toContain("are not updated");
  });

  /**
   * A week label alone is not navigable: a reader on the closed issue has to search
   * the repo for a title, and the whole point of the rollover comment is that the
   * series reads in both directions. The successor's NUMBER is the link.
   */
  test("carries the successor's issue number as a link", () => {
    const c = buildWeeklyRolloverComment("2026-W38", 901, "2026-09-14T03:00:00Z");
    expect(c).toContain("#901");
  });
});

describe("weeklySummaryLogLine", () => {
  test("carries the unknowns as unknown, not as zero", () => {
    const line = weeklySummaryLogLine(facts({ importedThisWeek: null }), 900);
    expect(line).toContain("imported_this_week=unknown");
    expect(line).toContain("issue=#900");
  });

  test("names the week and whether it needs attention", () => {
    const line = weeklySummaryLogLine(facts({ autoImportEnabled: false }), null);
    expect(line).toContain("week=2026-W37");
    expect(line).toContain("attention=true");
    expect(line).toContain("issue=none");
  });
});

// ---------------------------------------------------------------------------
// The fields that are NOT counts, and so bypass `count()`
// ---------------------------------------------------------------------------

describe("the non-count fields also distinguish unknown from a value", () => {
  /**
   * `count()` is well defended, but the body renders four fields through their own
   * inline ternaries -- dispatchLost, autoImportEnabled, dispatchPhrase, parkedDays.
   * Review mutated each and three survived, so the module header's "exactly ONE
   * renderer" was aspirational for exactly the fields where a wrong answer is a
   * positive health claim: `dispatchLost === null` rendering as `yes` is "the reporter
   * could not see, and said everything is fine".
   */
  test("dispatchLost null is unknown, false is yes, true is a bolded no", () => {
    const nul = buildWeeklySummaryBody(facts({ dispatchLost: null }), "t");
    const ok = buildWeeklySummaryBody(facts({ dispatchLost: false }), "t");
    const bad = buildWeeklySummaryBody(facts({ dispatchLost: true }), "t");
    expect(nul).toContain("| Dispatches landing | unknown |");
    expect(ok).toContain("| Dispatches landing | yes |");
    expect(bad).toContain("| Dispatches landing | **no** |");
    // The three must be mutually distinct: an unknown that rendered as `yes` is the
    // founding failure.
    expect(new Set([nul, ok, bad]).size).toBe(3);
  });

  test("autoImportEnabled null is unknown, not `not true`", () => {
    expect(buildWeeklySummaryBody(facts({ autoImportEnabled: null }), "t")).toContain(
      "| `AUTO_IMPORT_ENABLED` | unknown |",
    );
    expect(buildWeeklySummaryBody(facts({ autoImportEnabled: false }), "t")).toContain(
      "**not `true`**",
    );
  });

  test("a null dispatchPhrase is unknown, distinct from a real never-recorded", () => {
    // "never recorded" means we read the row and there was none; null means we never
    // read it. Two different facts.
    expect(buildWeeklySummaryBody(facts({ dispatchPhrase: null }), "t")).toContain(
      "| Last dispatch | unknown |",
    );
    expect(buildWeeklySummaryBody(facts({ dispatchPhrase: "never recorded" }), "t")).toContain(
      "| Last dispatch | never recorded |",
    );
  });

  test("a null parkedDays is unknown, not 0 days", () => {
    const body = buildWeeklySummaryBody(
      facts({ parked: [{ datasetId: "on1", reason: "no_source", parkedDays: null }] }),
      "t",
    );
    expect(body).toContain("| on1 | no_source | unknown |");
    expect(body).not.toContain("0 days");
  });
});

describe("no sweep activity escalates the headline", () => {
  /**
   * The one null that arrives WITHOUT an `errors` entry, so the errors check cannot
   * see it. The crons write a row on every run, so an absence means they did not run
   * -- which is the silence this epic is about, and an earlier version printed
   * "Nothing needs attention" directly above the section saying it could not see.
   */
  test("issuesClosed null needs attention", () => {
    const h = weeklyHeadline(facts({ issuesClosed: null, errors: [] }));
    expect(h.attention).toBe(true);
    expect(h.line).toContain("daily jobs may not be running");
  });

  test("a recorded zero does NOT need attention", () => {
    // The whole point of the heartbeat: a real zero is a quiet week, not a silence.
    const h = weeklyHeadline(facts({ issuesClosed: 0, issuesRelabelled: 0 }));
    expect(h.attention).toBe(false);
  });

  test("the body says an absence means the crons did not run", () => {
    // Both nulls, since the section is only unknown when neither was measured.
    const body = buildWeeklySummaryBody(facts({ issuesClosed: null, issuesRelabelled: null }), "t");
    expect(body).toContain("an absence of rows means they did not run");
  });
});

describe("the truncation boundary", () => {
  function parkedRows(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      datasetId: `on${String(i).padStart(6, "0")}`,
      reason: "no_source",
      parkedDays: i,
    }));
  }

  test("exactly the limit is not truncated", () => {
    const body = buildWeeklySummaryBody(facts({ parked: parkedRows(WEEKLY_MAX_LISTED_IDS) }), "t");
    expect(body).not.toContain("more.");
  });

  test("one over the limit says exactly how many are hidden", () => {
    // The off-by-one that matters: a report that stops at N without saying so
    // under-counts, and an under-count reads as good news.
    const body = buildWeeklySummaryBody(
      facts({ parked: parkedRows(WEEKLY_MAX_LISTED_IDS + 1) }),
      "t",
    );
    expect(body).toContain("...and 1 more.");
  });
});

describe("the UTC boundary holds regardless of the host timezone", () => {
  /**
   * `the label is UTC, not local` is vacuous on CI, which runs UTC -- review proved it
   * by mutating the UTC getters to local ones and seeing 0 failures under TZ=UTC. So
   * the timezone is set explicitly here, on both sides of UTC, and the assertions are
   * the same instants either way.
   */
  for (const tz of ["Asia/Tokyo", "America/Los_Angeles"]) {
    test(`still UTC under ${tz}`, () => {
      const original = process.env.TZ;
      try {
        process.env.TZ = tz;
        expect(isoWeekLabel(new Date("2026-09-06T23:59:59Z"))).toBe("2026-W36");
        expect(isoWeekLabel(new Date("2026-09-07T00:00:00Z"))).toBe("2026-W37");
        expect(shouldRunWeeklySummary(new Date("2026-09-06T23:59:59Z"))).toBe(false);
        expect(shouldRunWeeklySummary(new Date("2026-09-07T00:00:00Z"))).toBe(true);
      } finally {
        process.env.TZ = original;
      }
    });
  }
});

// ---------------------------------------------------------------------------
// The Neurobagel section (epic #1586, phase 6)
// ---------------------------------------------------------------------------

describe("the Neurobagel section", () => {
  type Neurobagel = NonNullable<WeeklySummaryFacts["neurobagel"]>;
  const nb = (
    over: Partial<Neurobagel> = {},
    overall: Neurobagel["latest"]["overall"] = "healthy",
  ): WeeklySummaryFacts["neurobagel"] => {
    const base = facts().neurobagel as Neurobagel;
    return { ...base, ...over, latest: { ...base.latest, overall } };
  };

  test("a healthy week with the unconfigured checks shown as unchecked needs no attention", () => {
    const f = facts();
    const body = buildWeeklySummaryBody(f, "2026-09-09T03:00:00Z");
    expect(weeklyHeadline(f).attention).toBe(false);
    expect(body).toContain("## Neurobagel federation");
    expect(body).toContain("| node | unchecked |");
    expect(body).toContain("| registration | unchecked |");
    expect(body).toContain("Latest daily run (2026-09-09T03:00:05.000Z): **HEALTHY**.");
  });

  test("no run at all is unknown, rendered as unknown and asking for attention, never as zero runs", () => {
    const f = facts({ neurobagel: null });
    const h = weeklyHeadline(f);
    expect(h.attention).toBe(true);
    expect(h.line).toContain("no Neurobagel verification run was recorded");
    const body = buildWeeklySummaryBody(f, "2026-09-09T03:00:00Z");
    expect(body).toContain("which is unknown rather than zero");
    expect(body).not.toContain("Daily runs in this window");
    expect(weeklySummaryLogLine(f, null)).toContain("neurobagel=unknown");
  });

  test("an alarm and an unknown each need attention, with their own words", () => {
    expect(weeklyHeadline(facts({ neurobagel: nb({}, "alarm") })).line).toContain(
      "Neurobagel verification is alarming",
    );
    expect(weeklyHeadline(facts({ neurobagel: nb({}, "unknown") })).line).toContain(
      "Neurobagel verification could not be determined",
    );
    // The overall of all-unchecked is not a problem: nothing here is configured to check.
    expect(weeklyHeadline(facts({ neurobagel: nb({}, "unchecked") })).attention).toBe(false);
  });

  test("a day that alarmed counts even when the latest run is healthy; the same alarm is not said twice", () => {
    const earlier = weeklyHeadline(
      facts({ neurobagel: nb({ days: { healthy: 5, alarm: 2, unknown: 0, unchecked: 0 } }) }),
    );
    expect(earlier.line).toContain("alarmed on 2 day(s)");
    const latest = weeklyHeadline(
      facts({
        neurobagel: nb({ days: { healthy: 5, alarm: 2, unknown: 0, unchecked: 0 } }, "alarm"),
      }),
    );
    expect(latest.line).toContain("is alarming");
    expect(latest.line).not.toContain("alarmed on");
  });

  test("the anonymity-class count is a count: zero says zero, a positive one asks for the audit log, an unknown says unknown", () => {
    const zero = buildWeeklySummaryBody(facts({ neurobagel: nb({ anonymityFindings: 0 }) }), "x");
    expect(zero).toContain("Anonymity-class findings recorded in this window: 0.");
    const some = facts({ neurobagel: nb({ anonymityFindings: 3 }) });
    expect(weeklyHeadline(some).line).toContain(
      "3 Neurobagel anonymity-class finding(s) were recorded (see the audit log)",
    );
    expect(buildWeeklySummaryBody(some, "x")).toContain("recorded in this window: 3.");
    const unknown = facts({ neurobagel: nb({ anonymityFindings: null }) });
    expect(buildWeeklySummaryBody(unknown, "x")).toContain("recorded in this window: unknown.");
    expect(weeklyHeadline(unknown).line).toContain("could not be counted");
  });

  test("the section names no dataset: it carries only the checks' own sentences and counts", () => {
    const body = buildWeeklySummaryBody(facts(), "x");
    const section = body.slice(
      body.indexOf("## Neurobagel federation"),
      body.indexOf("## Blocklisted datasets"),
    );
    expect(section).not.toMatch(/\b(nm|on)\d{6}\b/);
  });
});
