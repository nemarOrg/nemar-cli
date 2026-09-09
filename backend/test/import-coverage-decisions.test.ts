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
  COVERAGE_DISPATCH_STALE_HOURS,
  type ImportCoverageBacklog,
  buildCoverageIssueBody,
  buildCoverageKindChangeComment,
  buildCoverageRecoveryComment,
  decideCoverageVerdict,
  hoursSince,
  partitionBacklog,
} from "../src/services/import-coverage";

/** `n` never-attempted ids, plus whatever else the case needs. */
function backlog(over: Partial<ImportCoverageBacklog> = {}): ImportCoverageBacklog {
  return { neverAttempted: [], failedTracked: [], blocklisted: [], ...over };
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
    expect(out.failedTracked).toEqual([]);
    expect(out.blocklisted).toEqual([]);
  });

  test("a failed row is tracked elsewhere, not a coverage gap", () => {
    const jobs = new Map<string, BacklogJobState>([
      ["ds000001", { status: "failed", blocklisted: false }],
    ]);
    const out = partitionBacklog(["ds000001"], jobs);
    expect(out.neverAttempted).toEqual([]);
    expect(out.failedTracked).toEqual(["ds000001"]);
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
    expect(out.failedTracked).toEqual([]);
  });

  test("order within each bucket follows the diff, which is discovery order", () => {
    const jobs = new Map<string, BacklogJobState>([
      ["ds000002", { status: "failed", blocklisted: false }],
    ]);
    const out = partitionBacklog(["ds000003", "ds000002", "ds000001"], jobs);
    expect(out.neverAttempted).toEqual(["ds000003", "ds000001"]);
  });

  test("an empty diff partitions to three empty buckets, not to a fabricated one", () => {
    const out = partitionBacklog([], new Map());
    expect(out).toEqual({ neverAttempted: [], failedTracked: [], blocklisted: [] });
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

  test("a future timestamp clamps to 0 rather than going negative", () => {
    const now = Date.parse("2026-09-09T12:00:00Z");
    expect(hoursSince(Date.parse("2026-09-09T13:00:00Z"), now)).toBe(0);
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
      backlog: backlog({ failedTracked: ids(50), blocklisted: ids(50, 100) }),
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
    expect(v.reason).toContain("switched off, not broken");
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
    expect(v.reason).toContain("deliberately off");
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

describe("the issue body", () => {
  const args = {
    verdict: decideCoverageVerdict({
      enabled: false,
      dispatchAgeHours: 24 * 49,
      backlog: backlog({ neverAttempted: ids(19) }),
    }),
    enabled: false,
    dispatchAgeHours: 24 * 49,
    lastDispatchAt: "2026-07-06 02:31:15",
    discovered: 764,
    backlog: backlog({
      neverAttempted: ids(19),
      failedTracked: ids(3, 100),
      blocklisted: ids(11, 200),
    }),
    nowIso: "2026-09-09T12:00:00Z",
  };

  test("states the verdict, the numbers and the never-attempted ids", () => {
    const body = buildCoverageIssueBody(args);
    expect(body).toContain("ALARM (disabled)");
    expect(body).toContain("2026-07-06 02:31:15");
    expect(body).toContain("764");
    expect(body).toContain("ds000001");
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

  test("explains why the other buckets do not drive the alarm", () => {
    const body = buildCoverageIssueBody(args);
    expect(body).toContain("Only the never-attempted count drives this issue");
    // And why withdrawals are absent entirely, which a reader of #1311 will ask.
    expect(body).toContain("Withdrawn datasets do not appear");
  });

  test("a long id list is truncated with a count, not dumped (ADR 0036)", () => {
    const body = buildCoverageIssueBody({
      ...args,
      backlog: backlog({ neverAttempted: ids(200) }),
    });
    expect(body).toContain("and 180 more");
    expect(body).not.toContain("ds000199");
  });

  test("an empty never-attempted list renders as none, not as an empty line", () => {
    const body = buildCoverageIssueBody({ ...args, backlog: backlog() });
    expect(body).toContain("_none_");
  });

  test("points at the three things worth checking, including the exact-string trap", () => {
    const body = buildCoverageIssueBody(args);
    expect(body).toContain("Only the exact string counts");
    expect(body).toContain("nemar admin import-coverage");
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
