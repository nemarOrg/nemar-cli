/**
 * Import coverage DECISIONS (epic #1306 phase 3, #1311). Pure, no I/O, no D1.
 *
 * The verdict rule is the whole point of the phase, and it has two properties
 * that pull in opposite directions:
 *
 *   - it must fire on the 2026-07-20 outage (importer off, datasets accruing), and
 *   - it must NOT fire in ordinary steady state, where the last dispatch ages
 *     without limit because most 30-minute ticks legitimately have nothing to do.
 *
 * A rule that only satisfies the first is easy and useless: it would alarm every
 * quiet week and be muted within a month. So the false-alarm cases are tested as
 * carefully as the alarm cases.
 */

import { describe, expect, test } from "bun:test";
import {
  type BacklogJobState,
  COVERAGE_BACKLOG_ALARM,
  COVERAGE_BACKLOG_ALARM_ALONE,
  COVERAGE_DISPATCH_LOST_HOURS,
  COVERAGE_DISPATCH_STALE_HOURS,
  type ImportCoverageBacklog,
  MAX_LISTED_IDS,
  buildCoverageIssueBody,
  buildCoverageKindChangeComment,
  buildCoverageRecoveryComment,
  buildCoverageStandDownComment,
  decideCoverageVerdict,
  dispatchPhrase,
  hoursSince,
  outstandingCount,
  partitionBacklog,
} from "../src/services/import-coverage";

/** `n` never-attempted ids, plus whatever else the case needs. */
function backlog(over: Partial<ImportCoverageBacklog> = {}): ImportCoverageBacklog {
  return { neverAttempted: [], untracked: [], tracked: [], blocklisted: [], ...over };
}

function ids(n: number, start = 1): string[] {
  return Array.from({ length: n }, (_, i) => `ds${String(start + i).padStart(6, "0")}`);
}

// ---------------------------------------------------------------------------
// The partition
// ---------------------------------------------------------------------------

describe("partitionBacklog", () => {
  test("no import_jobs row at all is the only thing that counts as never attempted", () => {
    const out = partitionBacklog(["ds000001"], new Map());
    expect(out.neverAttempted).toEqual(["ds000001"]);
    expect(out.tracked).toEqual([]);
    expect(out.blocklisted).toEqual([]);
  });

  test("a failed row is tracked elsewhere, not a coverage gap", () => {
    const jobs = new Map<string, BacklogJobState>([
      ["ds000001", { status: "failed", blocklisted: false }],
    ]);
    const out = partitionBacklog(["ds000001"], jobs);
    expect(out.neverAttempted).toEqual([]);
    expect(out.tracked).toEqual(["ds000001"]);
  });

  /**
   * The trap. `import-retry.ts` blocklists a row WITHOUT changing its `status`
   * (routes/admin/imports.ts, import-retry.ts), so a blocked dataset is commonly
   * `status = 'failed'` too. A partition keyed on status alone would file every
   * blocked dataset under failedTracked -- less harmful than counting it as new,
   * but it would misreport why nobody is retrying it.
   */
  test("blocklisted wins over a status that still says failed", () => {
    const jobs = new Map<string, BacklogJobState>([
      ["ds000001", { status: "failed", blocklisted: true }],
    ]);
    const out = partitionBacklog(["ds000001"], jobs);
    expect(out.blocklisted).toEqual(["ds000001"]);
    expect(out.tracked).toEqual([]);
  });

  test("order within each bucket follows the diff, which is discovery order", () => {
    const jobs = new Map<string, BacklogJobState>([
      ["ds000002", { status: "failed", blocklisted: false }],
    ]);
    const out = partitionBacklog(["ds000003", "ds000002", "ds000001"], jobs);
    expect(out.neverAttempted).toEqual(["ds000003", "ds000001"]);
  });

  test("an empty diff partitions to empty buckets, not to a fabricated one", () => {
    const out = partitionBacklog([], new Map());
    expect(out).toEqual({ neverAttempted: [], untracked: [], tracked: [], blocklisted: [] });
  });
});

describe("hoursSince", () => {
  test("null in, null out -- never dispatched is not zero hours ago", () => {
    expect(hoursSince(null, Date.now())).toBeNull();
  });

  test("whole hours, floored", () => {
    const now = Date.parse("2026-09-09T12:00:00Z");
    expect(hoursSince(Date.parse("2026-09-09T11:00:00Z"), now)).toBe(1);
    expect(hoursSince(Date.parse("2026-09-09T11:59:59Z"), now)).toBe(0);
    expect(hoursSince(Date.parse("2026-09-07T12:00:00Z"), now)).toBe(48);
  });

  /**
   * SIGNED, deliberately. An earlier version clamped at 0, which turned any
   * future-dated dispatch row -- a skewed clock, a replayed fixture -- into
   * "dispatched 0 hours ago" and so made `stale` false forever, silently confining
   * the sweep to its standalone-backlog backstop.
   */
  test("a future timestamp is negative, not clamped to fresh", () => {
    const now = Date.parse("2026-09-09T12:00:00Z");
    expect(hoursSince(Date.parse("2026-09-09T13:00:00Z"), now)).toBe(-1);
  });

  test("a future-dated dispatch still reads as stale, so it cannot suppress the alarm", () => {
    const v = decideCoverageVerdict({
      enabled: true,
      dispatchAgeHours: -5,
      backlog: backlog({ neverAttempted: ids(COVERAGE_BACKLOG_ALARM) }),
    });
    expect(v.status).toBe("alarm");
    expect(v.kind).toBe("silence");
  });
});

// ---------------------------------------------------------------------------
// The verdict: the cases that must NOT alarm
// ---------------------------------------------------------------------------

describe("steady state is healthy, however old the last dispatch is", () => {
  /**
   * THE false-alarm case, and the reason the rule is backlog-gated.
   *
   * `autoImportTick` returns at `if (!picked)` BEFORE writing its audit row, so a
   * dispatch row exists only when a dataset was actually dispatched. OpenNeuro
   * publishes a few in-scope datasets a week against a 30-minute tick, so a
   * healthy pipeline with an empty backlog has an arbitrarily old last dispatch.
   * A rule keyed on dispatch age alone would alarm every quiet week.
   */
  test("empty backlog with a 30-day-old dispatch is healthy", () => {
    const v = decideCoverageVerdict({
      enabled: true,
      dispatchAgeHours: 24 * 30,
      backlog: backlog(),
    });
    expect(v.status).toBe("healthy");
    expect(v.kind).toBeNull();
  });

  test("empty backlog with no dispatch ever recorded is healthy", () => {
    // A freshly deployed worker with nothing to import. Treating "never" as
    // infinitely stale would alarm on a correct cold start.
    const v = decideCoverageVerdict({
      enabled: true,
      dispatchAgeHours: null,
      backlog: backlog(),
    });
    expect(v.status).toBe("healthy");
  });

  test("a backlog below the alarm threshold with a stale dispatch is healthy", () => {
    const v = decideCoverageVerdict({
      enabled: true,
      dispatchAgeHours: COVERAGE_DISPATCH_STALE_HOURS * 10,
      backlog: backlog({ neverAttempted: ids(COVERAGE_BACKLOG_ALARM - 1) }),
    });
    expect(v.status).toBe("healthy");
  });

  test("a real backlog with a FRESH dispatch is healthy -- it is being worked through", () => {
    const v = decideCoverageVerdict({
      enabled: true,
      dispatchAgeHours: 1,
      backlog: backlog({ neverAttempted: ids(COVERAGE_BACKLOG_ALARM) }),
    });
    expect(v.status).toBe("healthy");
    expect(v.reason).toContain("working through");
  });

  test("datasets tracked elsewhere never drive the verdict", () => {
    // 50 failed and 50 blocklisted, none of them new. This is roughly the real
    // tracker's shape, and it must not alarm: alarming on a set nobody intends to
    // import is what trains an operator to ignore the alarm.
    const v = decideCoverageVerdict({
      enabled: true,
      dispatchAgeHours: 24 * 60,
      backlog: backlog({ tracked: ids(50), blocklisted: ids(50, 100) }),
    });
    expect(v.status).toBe("healthy");
  });
});

// ---------------------------------------------------------------------------
// The verdict: the cases that must alarm
// ---------------------------------------------------------------------------

describe("the incident this phase exists for", () => {
  /**
   * The 2026-07-20 outage, reconstructed: the importer was SWITCHED OFF
   * (`AUTO_IMPORT_ENABLED` was not "true" -- that is what #1308 flipped back) and
   * 19 in-scope datasets accrued over seven weeks.
   *
   * A rule that never alarms on a disabled importer would miss exactly this, which
   * is why "disabled" is a kind of alarm and not an exemption.
   */
  test("switched off with a growing backlog alarms, and names the flag", () => {
    const v = decideCoverageVerdict({
      enabled: false,
      dispatchAgeHours: 24 * 49,
      backlog: backlog({ neverAttempted: ids(19) }),
    });
    expect(v.status).toBe("alarm");
    expect(v.kind).toBe("disabled");
    // The reason has to send the reader to the flag, not to the pipeline.
    expect(v.reason).toContain("AUTO_IMPORT_ENABLED");
    expect(v.reason).toContain("off, not broken");
  });

  test("switched off with nothing accruing is reported, not alarmed", () => {
    // A maintenance window. Reported so "off and forgotten" is still visible.
    const v = decideCoverageVerdict({
      enabled: false,
      dispatchAgeHours: 72,
      backlog: backlog({ neverAttempted: ids(COVERAGE_BACKLOG_ALARM - 1) }),
    });
    expect(v.status).toBe("healthy");
    expect(v.kind).toBeNull();
    expect(v.reason).toContain("switched off");
    expect(v.reason).toContain("nothing is accruing");
  });

  test("enabled but silent with a backlog alarms as silence", () => {
    const v = decideCoverageVerdict({
      enabled: true,
      dispatchAgeHours: COVERAGE_DISPATCH_STALE_HOURS,
      backlog: backlog({ neverAttempted: ids(COVERAGE_BACKLOG_ALARM) }),
    });
    expect(v.status).toBe("alarm");
    expect(v.kind).toBe("silence");
    expect(v.reason).toContain("enabled but has stopped moving");
  });

  test("enabled with a backlog and NO dispatch ever recorded alarms", () => {
    // The deployment that never once dispatched. "Never" is stale in the presence
    // of work, even though it is healthy without.
    const v = decideCoverageVerdict({
      enabled: true,
      dispatchAgeHours: null,
      backlog: backlog({ neverAttempted: ids(COVERAGE_BACKLOG_ALARM) }),
    });
    expect(v.status).toBe("alarm");
    expect(v.kind).toBe("silence");
  });

  test("a large backlog alarms even when the importer is dispatching", () => {
    // The case the dispatch clock cannot see: alive, but falling behind.
    const v = decideCoverageVerdict({
      enabled: true,
      dispatchAgeHours: 0,
      backlog: backlog({ neverAttempted: ids(COVERAGE_BACKLOG_ALARM_ALONE) }),
    });
    expect(v.status).toBe("alarm");
    expect(v.kind).toBe("backlog");
    expect(v.reason).toContain("not keeping up");
  });

  test("a disabled importer is never reported as silence, because that hides the cause", () => {
    const v = decideCoverageVerdict({
      enabled: false,
      dispatchAgeHours: 24 * 100,
      backlog: backlog({ neverAttempted: ids(COVERAGE_BACKLOG_ALARM_ALONE) }),
    });
    expect(v.kind).toBe("disabled");
  });
});

describe("the thresholds are boundaries, and inclusive", () => {
  test(`${COVERAGE_BACKLOG_ALARM} never-attempted with a stale dispatch alarms; one fewer does not`, () => {
    const stale = COVERAGE_DISPATCH_STALE_HOURS;
    expect(
      decideCoverageVerdict({
        enabled: true,
        dispatchAgeHours: stale,
        backlog: backlog({ neverAttempted: ids(COVERAGE_BACKLOG_ALARM) }),
      }).status,
    ).toBe("alarm");
    expect(
      decideCoverageVerdict({
        enabled: true,
        dispatchAgeHours: stale,
        backlog: backlog({ neverAttempted: ids(COVERAGE_BACKLOG_ALARM - 1) }),
      }).status,
    ).toBe("healthy");
  });

  test(`a dispatch ${COVERAGE_DISPATCH_STALE_HOURS - 1}h old is not yet stale`, () => {
    expect(
      decideCoverageVerdict({
        enabled: true,
        dispatchAgeHours: COVERAGE_DISPATCH_STALE_HOURS - 1,
        backlog: backlog({ neverAttempted: ids(COVERAGE_BACKLOG_ALARM) }),
      }).status,
    ).toBe("healthy");
  });

  test("the standalone threshold is above the gated one, or it would be unreachable", () => {
    expect(COVERAGE_BACKLOG_ALARM_ALONE).toBeGreaterThan(COVERAGE_BACKLOG_ALARM);
  });
});

// ---------------------------------------------------------------------------
// Report bodies
// ---------------------------------------------------------------------------

/**
 * The threshold VALUES, not just the boundary shape.
 *
 * Every other assertion here is written relative to the constants
 * (`ids(COVERAGE_BACKLOG_ALARM)`, `... - 1`), which pins the inclusive boundary and
 * is invariant to the value. Review proved the gap by mutation: changing
 * COVERAGE_BACKLOG_ALARM from 5 to 1 left all 2668 backend tests green. The value
 * is the alarm's credibility -- at 1 this becomes the thing that gets muted, which
 * `COVERAGE_BACKLOG_ALARM`'s own docstring says it must not -- so it is pinned
 * literally, and moving it means visiting ADR 0051's calibration argument.
 */
describe("the calibration is pinned, not just the shape", () => {
  test("the thresholds are the values ADR 0051 argues for", () => {
    expect(COVERAGE_BACKLOG_ALARM).toBe(5);
    expect(COVERAGE_BACKLOG_ALARM_ALONE).toBe(20);
    expect(COVERAGE_DISPATCH_STALE_HOURS).toBe(24);
    expect(COVERAGE_DISPATCH_LOST_HOURS).toBe(6);
  });

  test("the standalone threshold is above the gated one, or it would be unreachable", () => {
    expect(COVERAGE_BACKLOG_ALARM_ALONE).toBeGreaterThan(COVERAGE_BACKLOG_ALARM);
  });

  test("the lost-hand-off window is well inside the staleness window", () => {
    // Otherwise `silence` would always fire first and `dispatch-lost` -- the more
    // specific diagnosis -- would be unreachable.
    expect(COVERAGE_DISPATCH_LOST_HOURS).toBeLessThan(COVERAGE_DISPATCH_STALE_HOURS);
  });
});

describe("outstanding work is both untracked buckets", () => {
  test("never-attempted and untracked both count; tracked and blocklisted do not", () => {
    expect(
      outstandingCount(
        backlog({
          neverAttempted: ids(2),
          untracked: ids(3, 100),
          tracked: ids(50, 200),
          blocklisted: ids(50, 300),
        }),
      ),
    ).toBe(5);
  });

  /**
   * A `complete` row with no `datasets` row is real outstanding work:
   * `deleteDatasetCascade` leaves `import_jobs` behind, and `loadFailedJobInfo`
   * only loads `failed`, so the importer WILL re-dispatch it. An earlier draft
   * filed it under "already tracked", which under-counted the alarm and told the
   * reader a failure issue existed for it when none did.
   */
  test("a complete row whose dataset was deleted is outstanding, not tracked", () => {
    const jobs = new Map([["ds000001", { status: "complete", blocklisted: false }]]);
    const out = partitionBacklog(["ds000001"], jobs);
    expect(out.untracked).toEqual(["ds000001"]);
    expect(out.tracked).toEqual([]);
    expect(outstandingCount(out)).toBe(1);
  });

  test("an unrecognised status is untracked rather than silently trusted", () => {
    const jobs = new Map([["ds000001", { status: "something-new", blocklisted: false }]]);
    expect(partitionBacklog(["ds000001"], jobs).untracked).toEqual(["ds000001"]);
  });

  test("incomplete is tracked: the retry engine owns it", () => {
    const jobs = new Map([["ds000001", { status: "incomplete", blocklisted: false }]]);
    expect(partitionBacklog(["ds000001"], jobs).tracked).toEqual(["ds000001"]);
  });
});

describe("dispatchPhrase is complete on its own", () => {
  /** An earlier version returned a bare "never" that callers appended " ago" to,
   *  producing "Last dispatch: never ago" in four operator-facing reasons. */
  test("null reads as never recorded, not as never ago", () => {
    expect(dispatchPhrase(null)).toBe("never recorded");
    const v = decideCoverageVerdict({
      enabled: true,
      dispatchAgeHours: null,
      backlog: backlog({ neverAttempted: ids(COVERAGE_BACKLOG_ALARM) }),
    });
    expect(v.reason).toContain("never recorded");
    expect(v.reason).not.toContain("never ago");
  });

  test("a future-dated dispatch is named as an anomaly, not as freshness", () => {
    expect(dispatchPhrase(-5)).toContain("future");
  });

  test("singular and plural hours, then days past 48", () => {
    expect(dispatchPhrase(1)).toBe("1 hour ago");
    expect(dispatchPhrase(2)).toBe("2 hours ago");
    expect(dispatchPhrase(47)).toBe("47 hours ago");
    expect(dispatchPhrase(48)).toBe("2 days ago");
  });
});

describe("a fresh dispatch row is not proof the hand-off landed", () => {
  /**
   * The audit row is written to reserve the slot, eighteen lines BEFORE
   * `triggerOpenNeuroOnboard`. So if the PAT expires or the workflow is renamed,
   * rows keep appearing while nothing imports -- the clock looks fresh, so
   * `silence` can never fire, and an earlier version reported that as healthy with
   * the reason "is working through them" for weeks.
   */
  test("a lost hand-off alarms even with a fresh clock and a small backlog", () => {
    const v = decideCoverageVerdict({
      enabled: true,
      dispatchAgeHours: COVERAGE_DISPATCH_LOST_HOURS,
      dispatchLost: true,
      backlog: backlog({ neverAttempted: ids(1) }),
    });
    expect(v.status).toBe("alarm");
    expect(v.kind).toBe("dispatch-lost");
    expect(v.reason).toContain("not landing");
    // Names the two things to check, since neither is guessable from the symptom.
    expect(v.reason).toContain("PAT");
    expect(v.reason).toContain("onboard-openneuro.yml");
  });

  test("a disabled importer is reported as disabled, not as a lost hand-off", () => {
    // Of course nothing landed: the importer is off. Naming the symptom would hide
    // the cause.
    const v = decideCoverageVerdict({
      enabled: false,
      dispatchAgeHours: 100,
      dispatchLost: true,
      backlog: backlog({ neverAttempted: ids(COVERAGE_BACKLOG_ALARM) }),
    });
    expect(v.kind).toBe("disabled");
  });

  test("dispatch-lost takes precedence over a large backlog, being the specific cause", () => {
    const v = decideCoverageVerdict({
      enabled: true,
      dispatchAgeHours: 10,
      dispatchLost: true,
      backlog: backlog({ neverAttempted: ids(COVERAGE_BACKLOG_ALARM_ALONE) }),
    });
    expect(v.kind).toBe("dispatch-lost");
  });
});

describe("a missing binding is not a decision", () => {
  test('an absent AUTO_IMPORT_ENABLED says so, rather than "switched off"', () => {
    const v = decideCoverageVerdict({
      enabled: false,
      enabledBindingPresent: false,
      dispatchAgeHours: 100,
      backlog: backlog({ neverAttempted: ids(COVERAGE_BACKLOG_ALARM) }),
    });
    expect(v.reason).toContain("not set at all");
    expect(v.reason).toContain("by omission rather than by decision");
  });

  test("an explicit false says switched off", () => {
    const v = decideCoverageVerdict({
      enabled: false,
      enabledBindingPresent: true,
      dispatchAgeHours: 100,
      backlog: backlog({ neverAttempted: ids(COVERAGE_BACKLOG_ALARM) }),
    });
    expect(v.reason).toContain("switched off");
  });
});

describe("the issue body", () => {
  const verdict = decideCoverageVerdict({
    enabled: false,
    dispatchAgeHours: 24 * 49,
    backlog: backlog({ neverAttempted: ids(19) }),
  });
  const facts = {
    enabled: false,
    dispatchAgeHours: 24 * 49,
    lastDispatchAt: "2026-07-06 02:31:15",
    lastDispatchSourceId: "ds007763",
    discovered: 764,
    imported: 764,
    importedInScan: 731,
    importedNotInScan: 33,
    inFlight: 0,
    terminal: 0,
    backlog: backlog({
      neverAttempted: ids(19),
      tracked: ids(3, 100),
      blocklisted: ids(11, 200),
    }),
  };
  const args = { verdict, facts, nowIso: "2026-09-09T12:00:00Z" };

  test("states the verdict, the numbers and the never-attempted ids", () => {
    const body = buildCoverageIssueBody(args);
    expect(body).toContain("ALARM (disabled)");
    expect(body).toContain("2026-07-06 02:31:15");
    expect(body).toContain("764");
    expect(body).toContain("ds000001");
    // The dataset the last dispatch picked, which is what makes dispatch-lost
    // diagnosable from the issue alone.
    expect(body).toContain("ds007763");
  });

  /**
   * The body is REWRITTEN every run, unlike phase 2's rollup body which is written
   * once. So it must say that it is current-state-only: a reader who assumes it
   * accumulates would read a shrinking backlog as datasets disappearing.
   */
  test("says it is rewritten in place and describes now, not history", () => {
    const body = buildCoverageIssueBody(args);
    expect(body).toContain("rewritten in place");
    expect(body).toContain("right now");
  });

  /**
   * The balance line is the reader's defence against a degraded read. 731 + 19 + 3
   * + 11 = 764 here, so it agrees. Without it, an upstream scan that returned an
   * empty in-scope set would render as an ordinary drained backlog -- the exact
   * false all-clear the plausibility floor exists to stop, invisible on the face of
   * the document that explains the verdict.
   */
  test("the counts balance, and the body says so", () => {
    // 731 in-scan imported + 19 never-attempted + 3 tracked + 11 blocklisted = 764.
    const body = buildCoverageIssueBody(args);
    expect(body).toContain("| total accounted for | 764 |");
    expect(body).toContain("Those two totals agree");
  });

  /**
   * Drift gets its own row rather than being folded into a mismatch. An earlier
   * version summed D1's set SIZES, which double-counted every in-flight import
   * (`POST /admin/datasets/import` writes both rows in one handler) and every
   * quarantined dataset, so the body declared itself unreliable on every healthy
   * run -- teaching the reader to discount the report, which is the muting failure
   * ADR 0051 is written against.
   */
  test("mirrors no longer in the scan are reported as drift, not as a mismatch", () => {
    const body = buildCoverageIssueBody(args);
    expect(body).toContain("33 are no longer in the scan");
    expect(body).toContain("drift rather than a coverage gap");
    expect(body).not.toContain("They do not agree");
  });

  /** Now only reachable if the sweep's own bookkeeping is wrong, since the terms are
   *  a partition of the scan -- so the message says that rather than blaming upstream. */
  test("a total that does not balance is called out as the sweep's own fault", () => {
    const body = buildCoverageIssueBody({
      ...args,
      facts: { ...facts, discovered: 900 },
    });
    expect(body).toContain("They do not agree");
    expect(body).toContain("the sweep's own bookkeeping is wrong");
    expect(body).not.toContain("Those two totals agree");
  });

  test("explains why the other buckets do not drive the alarm", () => {
    const body = buildCoverageIssueBody(args);
    expect(body).toContain("Only the two bold rows drive this issue");
    // And why withdrawals are absent entirely, which a reader of #1311 will ask.
    expect(body).toContain("Withdrawn datasets do not appear");
  });

  test("the untracked section appears only when there is something in it", () => {
    expect(buildCoverageIssueBody(args)).not.toContain("Has a stale row nothing owns\n");
    const withUntracked = buildCoverageIssueBody({
      ...args,
      facts: { ...facts, untracked: undefined, backlog: backlog({ untracked: ids(2, 500) }) },
    });
    expect(withUntracked).toContain("ds000500");
  });

  test("a long id list is truncated with a count (ADR 0036)", () => {
    const body = buildCoverageIssueBody({
      ...args,
      facts: { ...facts, backlog: backlog({ neverAttempted: ids(200) }) },
    });
    expect(body).toContain(`and ${200 - MAX_LISTED_IDS} more`);
    expect(body).not.toContain("ds000199");
  });

  test("exactly MAX_LISTED_IDS is not truncated; one more is", () => {
    const at = buildCoverageIssueBody({
      ...args,
      facts: { ...facts, backlog: backlog({ neverAttempted: ids(MAX_LISTED_IDS) }) },
    });
    expect(at).not.toContain("more");
    const over = buildCoverageIssueBody({
      ...args,
      facts: { ...facts, backlog: backlog({ neverAttempted: ids(MAX_LISTED_IDS + 1) }) },
    });
    expect(over).toContain("and 1 more");
  });

  test("an empty never-attempted list renders as none, not as an empty line", () => {
    const body = buildCoverageIssueBody({ ...args, facts: { ...facts, backlog: backlog() } });
    expect(body).toContain("_none_");
  });

  test("points at the things worth checking, including the exact-string trap", () => {
    const body = buildCoverageIssueBody(args);
    expect(body).toContain("Only the exact string counts");
    expect(body).toContain("nemar admin import-coverage");
    // The hand-off check, which is the one a reader could not derive themselves.
    expect(body).toContain("the hand-off is failing after the audit row is written");
  });

  /**
   * An earlier draft promised "or the importer resumes dispatching", which is false
   * for the `backlog` kind -- that kind means the importer IS dispatching. A close
   * condition stated on a public issue has to hold for every kind that can carry it.
   */
  test("the close condition it promises is true for every alarm kind", () => {
    const body = buildCoverageIssueBody(args);
    expect(body).toContain(`fewer than ${COVERAGE_BACKLOG_ALARM} datasets are outstanding`);
    expect(body).not.toContain("or the importer resumes dispatching");
  });
});

describe("the transition comments", () => {
  test("a kind change names both sides", () => {
    const c = buildCoverageKindChangeComment(
      "silence",
      "disabled",
      "because",
      "2026-09-09T00:00:00Z",
    );
    expect(c).toContain("`silence`");
    expect(c).toContain("`disabled`");
    expect(c).toContain("because");
  });

  test("a first-ever kind renders the previous as none rather than undefined", () => {
    const c = buildCoverageKindChangeComment(null, "backlog", "r", "2026-09-09T00:00:00Z");
    expect(c).toContain("`none`");
    expect(c).not.toContain("undefined");
  });

  test("the recovery comment disclaims being a per-dataset verdict", () => {
    const v = decideCoverageVerdict({ enabled: true, dispatchAgeHours: 1, backlog: backlog() });
    const c = buildCoverageRecoveryComment(v, "2026-09-09T00:00:00Z");
    expect(c).toContain("not a claim that every dataset");
  });
});

describe("the dispatch-lost reason is actionable", () => {
  /** The commonest cause is one wedged dataset, which the PAT and workflow advice
   *  cannot explain -- and the reader cannot act without knowing which id. */
  test("it names the dataset and the wedged-picker cause first", () => {
    const v = decideCoverageVerdict({
      enabled: true,
      lastDispatchSourceId: "ds008123",
      dispatchAgeHours: 10,
      dispatchLost: true,
      backlog: backlog({ neverAttempted: ["ds008123"] }),
    });
    expect(v.reason).toContain("ds008123");
    expect(v.reason).toContain("wedging the picker");
    expect(v.reason).toContain("PAT");
    expect(v.reason).toContain("onboard-openneuro.yml");
  });
});

describe("the stand-down comment", () => {
  test("says why the issue is staying open, and how it closes", () => {
    const v = decideCoverageVerdict({
      enabled: false,
      dispatchAgeHours: 100,
      backlog: backlog(),
    });
    const c = buildCoverageStandDownComment(v, "2026-09-09T00:00:00Z");
    expect(c).toContain("Alarm stood down, issue kept open");
    expect(c).toContain("only durable record");
    expect(c).toContain("closes automatically once the importer is enabled");
  });
});
