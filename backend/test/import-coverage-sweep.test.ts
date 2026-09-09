/**
 * The import coverage sweep (epic #1306 phase 3, #1311).
 *
 * Driven against real in-memory SQLite with every migration applied. Only the
 * TRANSPORT is injected -- the OpenNeuro scan and the GitHub client calls -- so
 * the real `IMPORTED_SOURCE_IDS_QUERY`, the real `diffNewDatasets`, the real
 * partition, the real verdict and the real report bodies all run.
 *
 * The load-bearing test is `a stale dispatch with a real backlog is never
 * reported as healthy`. That is the regression the whole epic exists to prevent:
 * for seven weeks the pipeline was silent and every observable said fine.
 *
 * The second theme is the opposite mistake, and it is the one that would make this
 * sweep useless rather than wrong: an alarm that fires on a quiet week gets muted.
 * `IMPORTED_SOURCE_IDS_QUERY`'s `owner_user_id != -1` and the never-attempted
 * partition are what keep it quiet, and both are exercised against real rows.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { GitHubIssue } from "../src/services/github/issues";
import {
  COVERAGE_BACKLOG_ALARM,
  COVERAGE_DISPATCH_STALE_HOURS,
} from "../src/services/import-coverage";
import {
  type ImportCoverageSweepDeps,
  importCoverageSweepSummary,
  runImportCoverageSweep,
  runImportCoverageSweepCron,
} from "../src/services/import-coverage-sweep";
import {
  IMPORT_COVERAGE_ISSUE_LABEL,
  IMPORT_COVERAGE_KIND_LABELS,
  importCoverageIssueTitle,
} from "../src/services/import-issue-identity";
import type { DiscoveredDataset } from "../src/services/openneuro-discovery";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const SYSTEM_USER_ID = -1;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function discovered(n: number, start = 1): DiscoveredDataset[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ds${String(start + i).padStart(6, "0")}`,
    latestTag: "1.0.0",
    modalities: ["eeg"],
  }));
}

/** A real managed `on######` mirror, i.e. an actually-imported dataset. */
function seedImported(db: Database, sourceId: string, ownerUserId = 1): void {
  const datasetId = `on${sourceId.slice(2)}`;
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id, status, visibility)
     VALUES (?, ?, ?, 'openneuro', ?, 'active', 'public')`,
  ).run(datasetId, `Dataset ${sourceId}`, ownerUserId, sourceId);
}

function seedImportJob(
  db: Database,
  sourceId: string,
  opts: { status?: string; blocklisted?: boolean } = {},
): void {
  db.query(
    `INSERT INTO import_jobs (dataset_id, source, source_id, stage, status, blocklisted)
     VALUES (?, 'openneuro', ?, 'prepare', ?, ?)`,
  ).run(
    `on${sourceId.slice(2)}`,
    sourceId,
    opts.status ?? "failed",
    opts.blocklisted === true ? 1 : 0,
  );
}

/** An `auto_import_dispatch` audit row `hoursAgo` in the past, written through the
 *  same column the real gate reads. */
function seedDispatch(db: Database, hoursAgo: number): void {
  db.query(
    `INSERT INTO audit_log (action, resource_id, details, timestamp)
     VALUES ('auto_import_dispatch', 'ds000001', '{}', datetime('now', ?))`,
  ).run(`-${hoursAgo} hours`);
}

function envFor(db: Database, enabled = true): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    AUTO_IMPORT_ENABLED: enabled ? "true" : "false",
  } as unknown as Bindings;
}

function coverageIssue(number = 700, kind?: keyof typeof IMPORT_COVERAGE_KIND_LABELS): GitHubIssue {
  return {
    number,
    html_url: `https://example/${number}`,
    state: "open",
    title: importCoverageIssueTitle(),
    labels: [
      { name: IMPORT_COVERAGE_ISSUE_LABEL },
      ...(kind ? [{ name: IMPORT_COVERAGE_KIND_LABELS[kind] }] : []),
    ],
  };
}

/** Records every GitHub write the sweep attempts. `fail` makes one throw. */
function recordingDeps(
  scan: DiscoveredDataset[] | Error,
  open: GitHubIssue[] = [],
  fail: { create?: Error; update?: Error; comment?: Error; close?: Error; setLabels?: Error } = {},
): ImportCoverageSweepDeps & {
  created: { title: string; body: string; labels: string[] }[];
  updated: { n: number; body?: string }[];
  comments: { n: number; body: string }[];
  labelled: { n: number; labels: string[] }[];
  closed: number[];
} {
  const created: { title: string; body: string; labels: string[] }[] = [];
  const updated: { n: number; body?: string }[] = [];
  const comments: { n: number; body: string }[] = [];
  const labelled: { n: number; labels: string[] }[] = [];
  const closed: number[] = [];
  return {
    created,
    updated,
    comments,
    labelled,
    closed,
    token: async () => "test-token",
    discover: async () => {
      if (scan instanceof Error) throw scan;
      return scan;
    },
    listOpenIssues: async () => open,
    create: async (_repo, title, body, labels) => {
      if (fail.create) throw fail.create;
      created.push({ title, body, labels });
      return coverageIssue(900);
    },
    update: async (_repo, n, fields) => {
      if (fail.update) throw fail.update;
      updated.push({ n, body: fields.body });
    },
    comment: async (_repo, n, body) => {
      if (fail.comment) throw fail.comment;
      comments.push({ n, body });
    },
    setLabels: async (_repo, n, labels) => {
      if (fail.setLabels) throw fail.setLabels;
      labelled.push({ n, labels });
    },
    close: async (_repo, n) => {
      if (fail.close) throw fail.close;
      closed.push(n);
    },
  };
}

// ---------------------------------------------------------------------------
// THE regression this epic exists to prevent
// ---------------------------------------------------------------------------

describe("silence is never reported as health", () => {
  /**
   * Seven weeks of nothing, reconstructed end to end through the real queries: the
   * importer is enabled, OpenNeuro has datasets NEMAR has never attempted, and the
   * last dispatch is long past.
   *
   * If this test ever passes with `status: "healthy"`, the sweep has stopped doing
   * the one thing it was written for.
   */
  test("a stale dispatch with a real backlog does NOT report healthy", async () => {
    const db = freshDb();
    seedDispatch(db, COVERAGE_DISPATCH_STALE_HOURS * 49);
    const deps = recordingDeps(discovered(COVERAGE_BACKLOG_ALARM));

    const result = await runImportCoverageSweep(envFor(db), {}, deps);

    expect(result.status).not.toBe("healthy");
    expect(result.status).toBe("alarm");
    expect(result.kind).toBe("silence");
    expect(result.backlog.neverAttempted).toHaveLength(COVERAGE_BACKLOG_ALARM);
  });

  test("the outage's real shape -- switched off, datasets accruing -- alarms and names the flag", async () => {
    const db = freshDb();
    seedDispatch(db, 24 * 49);
    const deps = recordingDeps(discovered(19));

    const result = await runImportCoverageSweep(envFor(db, false), {}, deps);

    expect(result.status).toBe("alarm");
    expect(result.kind).toBe("disabled");
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain("AUTO_IMPORT_ENABLED");
  });

  /**
   * The subtler half. `unknown` must never render as healthy either, because the
   * healthy branch CLOSES the issue -- so a discovery outage that read as healthy
   * would close a live alarm and leave nothing behind.
   */
  test("a discovery failure is unknown, not healthy, and closes nothing", async () => {
    const db = freshDb();
    const deps = recordingDeps(new Error("OpenNeuro GraphQL 502"), [coverageIssue(700, "silence")]);

    const result = await runImportCoverageSweep(envFor(db), { apply: true }, deps);

    expect(result.status).toBe("unknown");
    expect(result.errors[0]?.stage).toBe("discovery");
    expect(result.errors[0]?.error).toContain("502");
    // The live issue is untouched: not closed, not updated, not commented.
    expect(deps.closed).toEqual([]);
    expect(deps.updated).toEqual([]);
    expect(deps.comments).toEqual([]);
    expect(result.issue).toBeNull();
  });

  test("a truncated scan is unknown, not a smaller backlog", async () => {
    // discoverOpenNeuroDatasets throws rather than truncating, precisely so a
    // partial scan cannot read as a shrinking backlog. Confirm the sweep keeps that
    // property instead of catching it into a count.
    const db = freshDb();
    const deps = recordingDeps(
      new Error("discoverOpenNeuroDatasets truncated: scanned 40 of ~760 OpenNeuro datasets"),
    );

    const result = await runImportCoverageSweep(envFor(db), {}, deps);

    expect(result.status).toBe("unknown");
    expect(result.discovered).toBe(0);
    expect(result.backlog.neverAttempted).toEqual([]);
  });

  test("a D1 failure is unknown, not healthy", async () => {
    const db = freshDb();
    db.run("DROP TABLE import_jobs");
    const deps = recordingDeps(discovered(3), [coverageIssue(700, "silence")]);

    const result = await runImportCoverageSweep(envFor(db), { apply: true }, deps);

    expect(result.status).toBe("unknown");
    expect(result.errors[0]?.stage).toBe("d1");
    expect(deps.closed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The opposite mistake: an alarm nobody trusts
// ---------------------------------------------------------------------------

describe("a quiet pipeline stays quiet", () => {
  test("everything imported and a 60-day-old dispatch is healthy", async () => {
    const db = freshDb();
    for (const d of discovered(5)) seedImported(db, d.id);
    seedDispatch(db, 24 * 60);
    const deps = recordingDeps(discovered(5));

    const result = await runImportCoverageSweep(envFor(db), {}, deps);

    expect(result.status).toBe("healthy");
    expect(result.backlog.neverAttempted).toEqual([]);
    expect(result.discovered).toBe(5);
  });

  /**
   * The 2026-06-20 stall, guarded by `IMPORTED_SOURCE_IDS_QUERY`'s
   * `owner_user_id != -1`. A folded legacy shadow row is an un-imported browse
   * pointer, so it must NOT count as imported -- if it did, the backlog would
   * dedup away to nothing and the sweep would report healthy through an outage.
   * This is the same class of bug as the one this whole phase detects, one layer
   * down, so it is worth pinning here rather than only in the discovery tests.
   */
  test("a legacy shadow row does not hide a dataset from the backlog", async () => {
    const db = freshDb();
    // Shadow row: dataset_id == source_id, owner = SYSTEM_USER_ID.
    db.query(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id, status, visibility)
       VALUES ('ds000001', 'shadow', ?, 'openneuro', 'ds000001', 'active', 'public')`,
    ).run(SYSTEM_USER_ID);
    seedDispatch(db, COVERAGE_DISPATCH_STALE_HOURS * 2);
    const deps = recordingDeps(discovered(COVERAGE_BACKLOG_ALARM));

    const result = await runImportCoverageSweep(envFor(db), {}, deps);

    // ds000001 is still a coverage gap despite the shadow row.
    expect(result.backlog.neverAttempted).toContain("ds000001");
    expect(result.status).toBe("alarm");
  });

  test("a backlog of already-tracked failures does not alarm", async () => {
    const db = freshDb();
    for (const d of discovered(30)) seedImportJob(db, d.id, { status: "failed" });
    seedDispatch(db, 24 * 30);
    const deps = recordingDeps(discovered(30));

    const result = await runImportCoverageSweep(envFor(db), {}, deps);

    expect(result.status).toBe("healthy");
    expect(result.backlog.failedTracked).toHaveLength(30);
    expect(result.backlog.neverAttempted).toEqual([]);
  });

  test("blocklisted datasets are separated from new ones even when status says failed", async () => {
    const db = freshDb();
    for (const d of discovered(11))
      seedImportJob(db, d.id, { status: "failed", blocklisted: true });
    seedDispatch(db, 24 * 30);
    const deps = recordingDeps(discovered(11));

    const result = await runImportCoverageSweep(envFor(db), {}, deps);

    expect(result.backlog.blocklisted).toHaveLength(11);
    expect(result.backlog.failedTracked).toEqual([]);
    expect(result.status).toBe("healthy");
  });

  test("an in-flight import is not a coverage gap", async () => {
    const db = freshDb();
    for (const d of discovered(COVERAGE_BACKLOG_ALARM)) {
      seedImportJob(db, d.id, { status: "copying" });
    }
    seedDispatch(db, COVERAGE_DISPATCH_STALE_HOURS * 2);
    const deps = recordingDeps(discovered(COVERAGE_BACKLOG_ALARM));

    const result = await runImportCoverageSweep(envFor(db), {}, deps);

    // diffNewDatasets already removes in-flight rows, so they never reach the
    // partition at all.
    expect(result.backlog.neverAttempted).toEqual([]);
    expect(result.status).toBe("healthy");
  });
});

// ---------------------------------------------------------------------------
// The standing issue's lifecycle
// ---------------------------------------------------------------------------

describe("one issue, updated in place", () => {
  function alarmingDb(): Database {
    const db = freshDb();
    seedDispatch(db, COVERAGE_DISPATCH_STALE_HOURS * 3);
    return db;
  }

  test("first alarming run creates it, with the kind label", async () => {
    const db = alarmingDb();
    const deps = recordingDeps(discovered(COVERAGE_BACKLOG_ALARM), []);

    const result = await runImportCoverageSweep(envFor(db), { apply: true }, deps);

    expect(result.issue?.action).toBe("created");
    expect(deps.created).toHaveLength(1);
    expect(deps.created[0]?.title).toBe(importCoverageIssueTitle());
    expect(deps.created[0]?.labels).toContain(IMPORT_COVERAGE_ISSUE_LABEL);
    expect(deps.created[0]?.labels).toContain(IMPORT_COVERAGE_KIND_LABELS.silence);
  });

  /**
   * The accrual rule, carried over from phase 2. Coverage numbers change every day,
   * so a comment per run would be a notification per day forever -- the exact
   * failure mode this epic was opened against. The body is rewritten instead.
   */
  test("a second run with the SAME kind rewrites the body and says nothing", async () => {
    const db = alarmingDb();
    const deps = recordingDeps(discovered(COVERAGE_BACKLOG_ALARM), [coverageIssue(700, "silence")]);

    const result = await runImportCoverageSweep(envFor(db), { apply: true }, deps);

    expect(result.issue).toEqual({ number: 700, action: "updated" });
    expect(deps.updated).toHaveLength(1);
    expect(deps.updated[0]?.n).toBe(700);
    expect(deps.updated[0]?.body).toContain("ALARM (silence)");
    // No comment, and no pointless label write.
    expect(deps.comments).toEqual([]);
    expect(deps.labelled).toEqual([]);
    expect(deps.created).toEqual([]);
  });

  test("a CHANGED kind relabels and comments once", async () => {
    const db = alarmingDb();
    // Was silence; the importer has since been switched off.
    const deps = recordingDeps(discovered(COVERAGE_BACKLOG_ALARM), [coverageIssue(700, "silence")]);

    const result = await runImportCoverageSweep(envFor(db, false), { apply: true }, deps);

    expect(result.issue?.action).toBe("updated");
    expect(deps.labelled[0]?.labels).toContain(IMPORT_COVERAGE_KIND_LABELS.disabled);
    expect(deps.labelled[0]?.labels).not.toContain(IMPORT_COVERAGE_KIND_LABELS.silence);
    expect(deps.comments).toHaveLength(1);
    expect(deps.comments[0]?.body).toContain("`silence`");
    expect(deps.comments[0]?.body).toContain("`disabled`");
  });

  test("a human label on the issue survives the relabel", async () => {
    const db = alarmingDb();
    const issue = coverageIssue(700, "silence");
    issue.labels = [...(issue.labels ?? []), { name: "priority" }];
    const deps = recordingDeps(discovered(COVERAGE_BACKLOG_ALARM), [issue]);

    await runImportCoverageSweep(envFor(db, false), { apply: true }, deps);

    expect(deps.labelled[0]?.labels).toContain("priority");
  });

  test("recovery closes it, with the close BEFORE the comment", async () => {
    const db = freshDb();
    for (const d of discovered(3)) seedImported(db, d.id);
    seedDispatch(db, 1);
    const order: string[] = [];
    const deps = recordingDeps(discovered(3), [coverageIssue(700, "silence")]);
    const wrappedClose = deps.close;
    const wrappedComment = deps.comment;
    deps.close = async (...args) => {
      order.push("close");
      return wrappedClose?.(...args);
    };
    deps.comment = async (...args) => {
      order.push("comment");
      return wrappedComment?.(...args);
    };

    const result = await runImportCoverageSweep(envFor(db), { apply: true }, deps);

    expect(result.status).toBe("healthy");
    expect(result.issue?.action).toBe("closed");
    // ADR 0050: a comment ahead of a failed close is a permanent lie that repeats
    // every run. closeIssue is idempotent, so this order self-heals.
    expect(order).toEqual(["close", "comment"]);
  });

  test("healthy with no open issue does nothing at all", async () => {
    const db = freshDb();
    seedDispatch(db, 1);
    const deps = recordingDeps([], []);

    const result = await runImportCoverageSweep(envFor(db), { apply: true }, deps);

    expect(result.status).toBe("healthy");
    expect(result.issue).toBeNull();
    expect(deps.closed).toEqual([]);
    expect(deps.created).toEqual([]);
  });

  test("an unrelated issue carrying the label is not mistaken for the standing one", async () => {
    const db = alarmingDb();
    const other: GitHubIssue = {
      number: 42,
      html_url: "https://example/42",
      state: "open",
      title: "Something a human wrote about coverage",
      labels: [{ name: IMPORT_COVERAGE_ISSUE_LABEL }],
    };
    const deps = recordingDeps(discovered(COVERAGE_BACKLOG_ALARM), [other]);

    await runImportCoverageSweep(envFor(db), { apply: true }, deps);

    // Dedup is by exact title, so this creates the standing issue rather than
    // hijacking somebody's.
    expect(deps.created).toHaveLength(1);
    expect(deps.updated).toEqual([]);
  });

  test("a dry run reports the action and writes nothing", async () => {
    const db = alarmingDb();
    const deps = recordingDeps(discovered(COVERAGE_BACKLOG_ALARM), []);

    const result = await runImportCoverageSweep(envFor(db), {}, deps);

    expect(result.applied).toBe(false);
    expect(result.issue?.action).toBe("created");
    expect(deps.created).toEqual([]);
    expect(deps.updated).toEqual([]);
    expect(deps.comments).toEqual([]);
  });

  test("a report failure leaves the verdict intact and is reported separately", async () => {
    const db = alarmingDb();
    const deps = recordingDeps(discovered(COVERAGE_BACKLOG_ALARM), [], {
      create: new Error("HTTP 403 - forbidden"),
    });

    const result = await runImportCoverageSweep(envFor(db), { apply: true }, deps);

    // The verdict is a read; only the write failed.
    expect(result.status).toBe("alarm");
    expect(result.kind).toBe("silence");
    expect(result.errors[0]?.stage).toBe("report");
    expect(result.issue).toBeNull();
  });

  test("a comment failure after a landed close still counts the close", async () => {
    const db = freshDb();
    seedDispatch(db, 1);
    const deps = recordingDeps([], [coverageIssue(700, "silence")], {
      comment: new Error("HTTP 502"),
    });

    const result = await runImportCoverageSweep(envFor(db), { apply: true }, deps);

    expect(deps.closed).toEqual([700]);
    expect(result.issue?.action).toBe("closed");
    expect(result.issue?.commentError).toContain("502");
  });
});

// ---------------------------------------------------------------------------
// The cron wrapper's guard, in BOTH directions
// ---------------------------------------------------------------------------

describe("runImportCoverageSweepCron refuses outside production", () => {
  for (const environment of ["development", "staging", "test"]) {
    test(`${environment} skips without scanning`, async () => {
      const db = freshDb();
      let scanned = false;
      const result = await runImportCoverageSweepCron(
        { ...envFor(db), ENVIRONMENT: environment } as Bindings,
        {
          discover: async () => {
            scanned = true;
            return [];
          },
        },
      );
      expect(result).toBeNull();
      expect(scanned).toBe(false);
    });
  }

  // The fail-closed half: anything not recognised as non-production must RUN, or a
  // mis-set variable silently returns the pipeline to reporting nothing -- the
  // exact regression this phase exists to prevent.
  for (const environment of ["production", "", undefined, "prod", "Production"]) {
    test(`${environment === undefined ? "undefined" : `"${environment}"`} runs with apply on`, async () => {
      const db = freshDb();
      seedDispatch(db, 1);
      const result = await runImportCoverageSweepCron(
        { ...envFor(db), ENVIRONMENT: environment } as Bindings,
        recordingDeps([], []),
      );
      expect(result).not.toBeNull();
      expect(result?.applied).toBe(true);
    });
  }
});

describe("the summary line", () => {
  test("names the status, the kind and the never-attempted count", async () => {
    const db = freshDb();
    seedDispatch(db, COVERAGE_DISPATCH_STALE_HOURS * 3);
    const deps = recordingDeps(discovered(COVERAGE_BACKLOG_ALARM), []);

    const result = await runImportCoverageSweep(envFor(db), {}, deps);
    const line = importCoverageSweepSummary(result);

    expect(line).toContain("status=alarm");
    expect(line).toContain("kind=silence");
    expect(line).toContain(`never_attempted=${COVERAGE_BACKLOG_ALARM}`);
    expect(line).toContain("errors=0");
  });

  test("renders a never-dispatched pipeline as never, not as 0 hours", async () => {
    const db = freshDb();
    const deps = recordingDeps([], []);
    const result = await runImportCoverageSweep(envFor(db), {}, deps);
    expect(importCoverageSweepSummary(result)).toContain("dispatch_age_h=never");
  });
});
