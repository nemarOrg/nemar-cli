/**
 * The weekly import summary (epic #1306 phase 4, #1312).
 *
 * Driven against real in-memory SQLite with every migration applied: the real
 * queries, the real classifier, the real `first_incomplete_at` arithmetic and the
 * real body all run. Only the GitHub calls, the token and phase 3's coverage sweep
 * are injected.
 *
 * The assertions that matter are about what CANNOT happen:
 *
 *   - a failed read must not become a zero, at any layer;
 *   - the same week must not be posted twice, whether the audit gate or the title is
 *     the thing that catches it;
 *   - a report must never be silently truncated, because a report that stops at N
 *     under-counts and reads as good news.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { GitHubIssue } from "../src/services/github/issues";
import type { ImportCoverageSweepResult } from "../src/services/import-coverage-sweep";
import {
  IMPORT_WEEKLY_ISSUE_LABEL,
  importWeeklySummaryIssueTitle,
} from "../src/services/import-issue-identity";
import { isoWeekLabel } from "../src/services/import-weekly-summary";
import {
  WEEKLY_SUMMARY_AUDIT_ACTION,
  type WeeklySummaryDeps,
  runWeeklyImportSummary,
  runWeeklyImportSummaryCron,
  weeklySummaryCronLine,
} from "../src/services/import-weekly-summary-sweep";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

/** A Monday, so the calendar is never the thing under test here. */
const NOW = new Date("2026-09-07T03:00:00Z");
const THIS_WEEK = isoWeekLabel(NOW);

function envFor(db: Database, environment = "test"): Bindings {
  return { DB: realD1(db), ENVIRONMENT: environment } as unknown as Bindings;
}

function seedImported(db: Database, sourceId: string, opts: { daysAgo?: number } = {}): void {
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id, status, visibility, created_at)
     VALUES (?, ?, 1, 'openneuro', ?, 'active', 'public', datetime('now', ?))`,
  ).run(`on${sourceId.slice(2)}`, `Dataset ${sourceId}`, sourceId, `-${opts.daysAgo ?? 0} days`);
}

function seedImportJob(
  db: Database,
  datasetId: string,
  opts: {
    status?: string;
    lastError?: string | null;
    blocklisted?: boolean;
    reason?: string | null;
    firstIncompleteDaysAgo?: number | null;
  } = {},
): void {
  db.query(
    `INSERT INTO import_jobs
       (dataset_id, source, source_id, stage, status, last_error, blocklisted, blocklist_reason, first_incomplete_at)
     VALUES (?, 'openneuro', ?, 'prepare', ?, ?, ?, ?, ?)`,
  ).run(
    datasetId,
    `ds${datasetId.slice(2)}`,
    opts.status ?? "failed",
    opts.lastError ?? null,
    opts.blocklisted === true ? 1 : 0,
    opts.reason ?? null,
    // Anchored to the test's injected NOW, not SQLite's `now`. Using
    // `datetime('now', ...)` here mixed two clocks: the fixture would be relative to
    // the real date while the assertion was relative to NOW, so the expected
    // duration drifted by however far apart they happened to be.
    opts.firstIncompleteDaysAgo === null || opts.firstIncompleteDaysAgo === undefined
      ? null
      : sqliteUtc(new Date(NOW.getTime() - opts.firstIncompleteDaysAgo * 86_400_000)),
  );
}

/** `YYYY-MM-DD HH:MM:SS`, the format SQLite's `datetime()` writes and
 *  `parseSqliteUtc` reads. */
function sqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** An `import_issue_triage` audit row, as phase 2's cron now writes. */
function seedTriageAudit(db: Database, details: Record<string, unknown>, daysAgo = 1): void {
  db.query(
    `INSERT INTO audit_log (action, resource_type, resource_id, details, timestamp)
     VALUES ('import_issue_triage', 'issue', 'x', ?, datetime('now', ?))`,
  ).run(JSON.stringify(details), `-${daysAgo} days`);
}

function coverageResult(over: Partial<ImportCoverageSweepResult> = {}): ImportCoverageSweepResult {
  return {
    applied: false,
    status: "healthy",
    kind: null,
    reason: "nothing outstanding",
    enabled: true,
    lastDispatchAt: "2026-09-07 01:00:00",
    dispatchAgeHours: 2,
    lastDispatchSourceId: "ds000001",
    dispatchLost: false,
    discovered: 766,
    imported: 764,
    importedInScan: 760,
    importedNotInScan: 4,
    inFlight: 0,
    terminal: 0,
    backlog: { neverAttempted: [], untracked: [], tracked: [], blocklisted: [] },
    issue: null,
    errors: [],
    ...over,
  };
}

function weeklyIssue(number: number, week: string): GitHubIssue {
  return {
    number,
    html_url: `https://example/${number}`,
    state: "open",
    title: importWeeklySummaryIssueTitle(week),
    labels: [{ name: IMPORT_WEEKLY_ISSUE_LABEL }],
  };
}

function recordingDeps(
  open: GitHubIssue[] = [],
  coverage: ImportCoverageSweepResult | Error = coverageResult(),
  fail: { create?: Error; close?: Error; comment?: Error } = {},
): WeeklySummaryDeps & {
  created: { title: string; body: string; labels: string[] }[];
  closed: number[];
  comments: { n: number; body: string }[];
} {
  const created: { title: string; body: string; labels: string[] }[] = [];
  const closed: number[] = [];
  const comments: { n: number; body: string }[] = [];
  return {
    created,
    closed,
    comments,
    token: async () => "test-token",
    listOpenIssues: async () => open,
    coverage: async () => {
      if (coverage instanceof Error) throw coverage;
      return coverage;
    },
    create: async (_repo, title, body, labels) => {
      if (fail.create) throw fail.create;
      created.push({ title, body, labels });
      return weeklyIssue(900, THIS_WEEK);
    },
    close: async (_repo, n) => {
      if (fail.close) throw fail.close;
      closed.push(n);
    },
    comment: async (_repo, n, body) => {
      if (fail.comment) throw fail.comment;
      comments.push({ n, body });
    },
  };
}

function auditRows(
  db: Database,
  action = WEEKLY_SUMMARY_AUDIT_ACTION,
): { details: string | null }[] {
  return db
    .query<{ details: string | null }, [string]>(
      "SELECT details FROM audit_log WHERE action = ? ORDER BY id",
    )
    .all(action);
}

// ---------------------------------------------------------------------------
// The report arrives, and it is right
// ---------------------------------------------------------------------------

describe("the report is produced from real queries", () => {
  test("counts imports in the window and the total separately", async () => {
    const db = freshDb();
    for (const d of ["ds000001", "ds000002", "ds000003"]) seedImported(db, d, { daysAgo: 2 });
    // Older than the window: counts toward the total, not toward this week.
    seedImported(db, "ds000900", { daysAgo: 40 });
    const deps = recordingDeps();

    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, deps);

    expect(r.facts.importedThisWeek).toBe(3);
    expect(r.facts.importedTotal).toBe(4);
  });

  test("a folded legacy shadow row counts as neither", async () => {
    // owner_user_id = -1 is an un-imported browse pointer. Counting them as imported
    // is what caused the 2026-06-20 stall, and it would also overstate this report.
    const db = freshDb();
    db.query(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id, status, visibility)
       VALUES ('ds000001', 'shadow', -1, 'openneuro', 'ds000001', 'active', 'public')`,
    ).run();
    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());
    expect(r.facts.importedTotal).toBe(0);
    expect(r.facts.importedThisWeek).toBe(0);
  });

  test("open failures are grouped by classified cause, zero-filled", async () => {
    const db = freshDb();
    seedImportJob(db, "on000001", {
      status: "failed",
      lastError:
        "Failed to push: remote: Invalid username or token. Password authentication is not supported for Git operations.",
    });
    seedImportJob(db, "on000002", {
      status: "failed",
      lastError:
        "Failed to configure S3 remote: The bucket already exists, and its annex-uuid file indicates it is used by a different special remote.",
    });
    seedImportJob(db, "on000003", { status: "incomplete", lastError: null });

    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());

    expect(r.facts.openFailureTotal).toBe(3);
    expect(r.facts.failuresByCause?.["auth-invalid"]).toBe(1);
    expect(r.facts.failuresByCause?.["annex-uuid-conflict"]).toBe(1);
    expect(r.facts.failuresByCause?.["needs-triage"]).toBe(1);
    // Zero-filled: a cause absent from the map is indistinguishable from a cause at
    // zero, which is the same unknown-vs-zero confusion one level down.
    expect(r.facts.failuresByCause?.timeout).toBe(0);
  });

  test("a blocklisted row is not double-counted as an open failure", async () => {
    const db = freshDb();
    seedImportJob(db, "on000001", { status: "failed", blocklisted: true, reason: "no_source" });
    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());
    expect(r.facts.openFailureTotal).toBe(0);
    expect(r.facts.parked).toHaveLength(1);
  });

  /**
   * `first_incomplete_at` is the anchor because it is write-once. `updated_at` is
   * bumped by the slow blocklist re-check, so a row parked two months but probed
   * yesterday would read as one day old.
   */
  test("parked duration comes from the write-once anchor", async () => {
    const db = freshDb();
    seedImportJob(db, "on004148", {
      blocklisted: true,
      reason: "upstream_403_after_window",
      firstIncompleteDaysAgo: 64,
    });
    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());
    expect(r.facts.parked?.[0]?.parkedDays).toBe(64);
    expect(r.facts.parked?.[0]?.reason).toBe("upstream_403_after_window");
  });

  test("a blocklisted row with no anchor is unknown, not zero days", async () => {
    // Possible on rows predating the retry engine. "0 days" would say "parked today".
    const db = freshDb();
    seedImportJob(db, "on005279", { blocklisted: true, reason: "no_source" });
    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());
    expect(r.facts.parked?.[0]?.parkedDays).toBeNull();
    expect(r.renderedBody).toContain("| on005279 | no_source | unknown |");
  });

  test("parked datasets are ordered longest-first", async () => {
    const db = freshDb();
    seedImportJob(db, "on000001", { blocklisted: true, firstIncompleteDaysAgo: 5 });
    seedImportJob(db, "on000002", { blocklisted: true, firstIncompleteDaysAgo: 50 });
    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());
    expect(r.facts.parked?.map((p) => p.datasetId)).toEqual(["on000002", "on000001"]);
  });

  test("sweep activity is summed from the cron's audit rows", async () => {
    const db = freshDb();
    seedTriageAudit(db, { source: "cron", closed: 2, relabelled: 1 }, 1);
    seedTriageAudit(db, { source: "cron", closed: 3, relabelled: 0 }, 3);
    // Outside the window: must not count.
    seedTriageAudit(db, { source: "cron", closed: 99, relabelled: 99 }, 30);

    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());

    expect(r.facts.issuesClosed).toBe(5);
    expect(r.facts.issuesRelabelled).toBe(1);
  });

  test("no audit rows at all is unknown, not zero", async () => {
    // Genuinely ambiguous: nothing happened, or the crons have not started writing.
    const db = freshDb();
    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());
    expect(r.facts.issuesClosed).toBeNull();
    expect(r.facts.issuesRelabelled).toBeNull();
  });

  test("coverage numbers come from phase 3's sweep, run read-only", async () => {
    const db = freshDb();
    let sawApply: boolean | undefined;
    const deps = recordingDeps();
    deps.coverage = async (_env, opts) => {
      sawApply = opts?.apply;
      return coverageResult({ discovered: 766, importedNotInScan: 4 });
    };

    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, deps);

    // Read-only: the weekly report must never file or close the coverage issue as a
    // side effect of writing a report.
    expect(sawApply).toBe(false);
    expect(r.facts.discovered).toBe(766);
    expect(r.facts.importedNotInScan).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// A failed read is a reported unknown, never a zero
// ---------------------------------------------------------------------------

describe("a failure in one section does not zero it or abort the report", () => {
  test("a coverage unknown blanks the coverage numbers and is listed", async () => {
    const db = freshDb();
    seedImported(db, "ds000001", { daysAgo: 1 });
    const deps = recordingDeps(
      [],
      coverageResult({ status: "unknown", reason: "OpenNeuro discovery failed" }),
    );

    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, deps);

    expect(r.facts.outstanding).toBeNull();
    expect(r.facts.discovered).toBeNull();
    expect(r.facts.errors.some((e) => e.stage === "coverage")).toBe(true);
    // The rest of the report still arrives.
    expect(r.facts.importedThisWeek).toBe(1);
  });

  test("a coverage throw is listed and the report still arrives", async () => {
    const db = freshDb();
    seedImported(db, "ds000001", { daysAgo: 1 });
    const deps = recordingDeps([], new Error("GraphQL 502"));

    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, deps);

    expect(r.facts.coverageStatus).toBeNull();
    expect(r.facts.errors[0]?.stage).toBe("coverage");
    expect(r.facts.importedThisWeek).toBe(1);
    expect(r.renderedBody).toContain("**unknown**, not zero");
  });

  test("a dropped table makes that section unknown, not zero", async () => {
    const db = freshDb();
    seedImported(db, "ds000001", { daysAgo: 1 });
    db.run("DROP TABLE import_jobs");

    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());

    expect(r.facts.failuresByCause).toBeNull();
    expect(r.facts.openFailureTotal).toBeNull();
    expect(r.facts.parked).toBeNull();
    // ...and the sections that could be read are intact.
    expect(r.facts.importedThisWeek).toBe(1);
    expect(r.facts.errors.map((e) => e.stage).sort()).toEqual(["failures", "parked"]);
  });

  test("an unknown anywhere marks the week as needing attention", async () => {
    const db = freshDb();
    db.run("DROP TABLE import_jobs");
    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());
    // A report that cannot see is not a report that found nothing.
    expect(r.renderedBody).toContain("Needs attention");
  });
});

// ---------------------------------------------------------------------------
// Once per week, whichever mechanism catches it
// ---------------------------------------------------------------------------

describe("the same week is never posted twice", () => {
  test("a first run posts and reserves the audit row", async () => {
    const db = freshDb();
    const deps = recordingDeps();

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);

    expect(r.posted).toBe(true);
    expect(deps.created[0]?.title).toBe(importWeeklySummaryIssueTitle(THIS_WEEK));
    expect(deps.created[0]?.labels).toEqual([IMPORT_WEEKLY_ISSUE_LABEL]);
    const rows = auditRows(db);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.details ?? "{}")).toMatchObject({ week: THIS_WEEK });
  });

  test("a second run in the same week is refused by the audit gate", async () => {
    const db = freshDb();
    const first = recordingDeps();
    await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, first);

    const second = recordingDeps();
    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, second);

    expect(r.posted).toBe(false);
    expect(r.gateReason).toContain(`already posted for ${THIS_WEEK}`);
    expect(second.created).toEqual([]);
    expect(auditRows(db)).toHaveLength(1);
  });

  /**
   * The belt-and-braces half. The audit gate is a read-then-write with a race window;
   * the week-labelled title is immune to it, because GitHub is the one that would
   * hold two issues with one title.
   */
  test("an existing issue for this week stops a post even if the gate let it through", async () => {
    const db = freshDb();
    const deps = recordingDeps([weeklyIssue(700, THIS_WEEK)]);

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);

    expect(r.posted).toBe(false);
    expect(deps.created).toEqual([]);
    // No audit row either: nothing was reserved because nothing was posted.
    expect(auditRows(db)).toEqual([]);
  });

  test("the following week proceeds", async () => {
    const db = freshDb();
    await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, recordingDeps());
    const next = new Date(NOW.getTime() + 7 * 86_400_000);
    const deps = recordingDeps();

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: next }, deps);

    expect(r.posted).toBe(true);
    expect(deps.created[0]?.title).toContain(isoWeekLabel(next));
  });

  test("an unreadable gate timestamp refuses rather than posting", async () => {
    const db = freshDb();
    db.query(
      `INSERT INTO audit_log (action, details, timestamp)
       VALUES ('${WEEKLY_SUMMARY_AUDIT_ACTION}', '{}', 'not-a-timestamp')`,
    ).run();
    const deps = recordingDeps();

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);

    expect(r.posted).toBe(false);
    expect(r.gateReason).toContain("unreadable");
    expect(deps.created).toEqual([]);
  });

  test("a gate query that throws refuses rather than posting", async () => {
    const db = freshDb();
    db.run("DROP TABLE audit_log");
    const deps = recordingDeps();

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);

    expect(r.posted).toBe(false);
    expect(r.gateReason).toContain("gate query failed");
    expect(deps.created).toEqual([]);
  });

  /**
   * The reservation is written BEFORE the GitHub call, per `autoImportTick`'s rule.
   * If it cannot be written we must not post: posting anyway risks one issue per day
   * for as long as the write keeps failing.
   */
  test("a failed reservation means no post", async () => {
    const db = freshDb();
    // Gate read succeeds (table exists, no rows); the reservation INSERT then fails.
    db.run("DROP INDEX IF EXISTS idx_audit_action");
    db.run("ALTER TABLE audit_log RENAME TO audit_log_moved");
    db.run("CREATE VIEW audit_log AS SELECT * FROM audit_log_moved");
    const deps = recordingDeps();

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);

    expect(deps.created).toEqual([]);
    expect(r.facts.errors.some((e) => e.stage === "post")).toBe(true);
  });

  test("force bypasses the gate but still writes nothing on a dry run", async () => {
    const db = freshDb();
    await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, recordingDeps());
    const deps = recordingDeps();

    // What the admin route's dry run does: an operator asking to READ the report
    // should not be told to wait until next Monday.
    const r = await runWeeklyImportSummary(envFor(db), { force: true, now: NOW }, deps);

    expect(r.renderedBody).toContain(`# Import summary, ${THIS_WEEK}`);
    expect(deps.created).toEqual([]);
    expect(auditRows(db)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Rollover
// ---------------------------------------------------------------------------

describe("filing this week closes last week", () => {
  test("the previous week is closed and commented, close first", async () => {
    const db = freshDb();
    const previous = isoWeekLabel(new Date(NOW.getTime() - 7 * 86_400_000));
    const order: string[] = [];
    const deps = recordingDeps([weeklyIssue(700, previous)]);
    const wrappedClose = deps.close;
    const wrappedComment = deps.comment;
    deps.close = async (...a) => {
      order.push("close");
      return wrappedClose?.(...a);
    };
    deps.comment = async (...a) => {
      order.push("comment");
      return wrappedComment?.(...a);
    };

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);

    expect(r.closedPrevious).toBe(700);
    // ADR 0050: mutate then comment, so a failed close cannot leave a claim behind.
    expect(order).toEqual(["close", "comment"]);
    expect(deps.comments[0]?.body).toContain(THIS_WEEK);
  });

  test("the OLDEST is not closed when several are open -- only the latest previous", async () => {
    const db = freshDb();
    const w35 = isoWeekLabel(new Date(NOW.getTime() - 14 * 86_400_000));
    const w36 = isoWeekLabel(new Date(NOW.getTime() - 7 * 86_400_000));
    const deps = recordingDeps([weeklyIssue(600, w35), weeklyIssue(700, w36)]);

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);

    // Chosen by sorting week LABELS, not issue numbers: the numbers are shared with
    // every other issue on the repo, so a manual re-file would break that ordering.
    expect(r.closedPrevious).toBe(700);
    expect(deps.closed).toEqual([700]);
  });

  test("a rollover failure does not undo this week's report", async () => {
    const db = freshDb();
    const previous = isoWeekLabel(new Date(NOW.getTime() - 7 * 86_400_000));
    const deps = recordingDeps([weeklyIssue(700, previous)], coverageResult(), {
      close: new Error("HTTP 403"),
    });

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);

    // This week's report is the deliverable; tidying is not.
    expect(r.posted).toBe(true);
    expect(deps.created).toHaveLength(1);
    expect(r.closedPrevious).toBeNull();
    expect(r.facts.errors.some((e) => e.stage === "rollover")).toBe(true);
  });

  test("an unrelated issue carrying the label is not mistaken for a weekly one", async () => {
    const db = freshDb();
    const deps = recordingDeps([
      {
        number: 42,
        html_url: "https://example/42",
        state: "open",
        title: "Someone's note about the weekly summary",
        labels: [{ name: IMPORT_WEEKLY_ISSUE_LABEL }],
      },
    ]);

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);

    expect(r.posted).toBe(true);
    expect(deps.closed).toEqual([]);
  });

  test("nothing to close on the first week ever", async () => {
    const db = freshDb();
    const deps = recordingDeps();
    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);
    expect(r.closedPrevious).toBeNull();
    expect(deps.closed).toEqual([]);
  });
});

describe("a dry run writes nothing", () => {
  test("no issue, no audit row, but a full rendered body", async () => {
    const db = freshDb();
    seedImported(db, "ds000001", { daysAgo: 1 });
    const deps = recordingDeps();

    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, deps);

    expect(r.applied).toBe(false);
    expect(r.posted).toBe(false);
    expect(deps.created).toEqual([]);
    expect(deps.closed).toEqual([]);
    expect(auditRows(db)).toEqual([]);
    // The point of a dry run: review exactly what would be filed.
    expect(r.renderedBody).toContain("@nemarAdmin");
    expect(r.renderedBody).toContain("| Imported this week | 1 |");
  });
});

// ---------------------------------------------------------------------------
// The cron wrapper's guard, both directions
// ---------------------------------------------------------------------------

describe("runWeeklyImportSummaryCron refuses outside production", () => {
  for (const environment of ["development", "staging", "test"]) {
    test(`${environment} skips without touching anything`, async () => {
      const db = freshDb();
      const deps = recordingDeps();
      const r = await runWeeklyImportSummaryCron(envFor(db, environment), deps);
      expect(r).toBeNull();
      expect(deps.created).toEqual([]);
      expect(auditRows(db)).toEqual([]);
    });
  }

  // Fail-closed: anything not recognised as non-production must RUN, or a mis-set
  // variable silently stops the report -- the regression this epic exists to prevent.
  for (const environment of ["production", "", undefined, "prod", "Production"]) {
    test(`${environment === undefined ? "undefined" : `"${environment}"`} runs with apply on`, async () => {
      const db = freshDb();
      const deps = recordingDeps();
      const r = await runWeeklyImportSummaryCron(
        { ...envFor(db), ENVIRONMENT: environment } as Bindings,
        deps,
      );
      expect(r).not.toBeNull();
      expect(r?.applied).toBe(true);
    });
  }
});

describe("weeklySummaryCronLine", () => {
  test("a gate refusal says so rather than pretending to report", async () => {
    const db = freshDb();
    await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, recordingDeps());
    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, recordingDeps());
    expect(weeklySummaryCronLine(r)).toContain("not posted:");
  });

  test("a posted run names the week, the issue and the rollover", async () => {
    const db = freshDb();
    const previous = isoWeekLabel(new Date(NOW.getTime() - 7 * 86_400_000));
    const deps = recordingDeps([weeklyIssue(700, previous)]);
    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);
    const line = weeklySummaryCronLine(r);
    expect(line).toContain(`week=${THIS_WEEK}`);
    expect(line).toContain("issue=#900");
    expect(line).toContain("closed_previous=#700");
  });
});
