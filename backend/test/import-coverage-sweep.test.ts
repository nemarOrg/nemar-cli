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
import { AUTO_IMPORT_GATE_QUERY } from "../src/services/auto-import";
import type { GitHubIssue } from "../src/services/github/issues";
import {
  COVERAGE_BACKLOG_ALARM,
  COVERAGE_DISPATCH_STALE_HOURS,
} from "../src/services/import-coverage";
import {
  COVERAGE_LAST_DISPATCH_QUERY,
  COVERAGE_SCAN_SANITY_MIN_IMPORTED,
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
import {
  type DiscoveredDataset,
  discoverOpenNeuroDatasets,
} from "../src/services/openneuro-discovery";
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
function seedDispatch(db: Database, hoursAgo: number, sourceId = "ds999999"): void {
  db.query(
    `INSERT INTO audit_log (action, resource_id, details, timestamp)
     VALUES ('auto_import_dispatch', ?, '{}', datetime('now', ?))`,
    // A negative `hoursAgo` seeds a FUTURE row, for the clock-anomaly case;
    // `datetime('now', '--10 hours')` is not valid SQLite, so the sign is explicit.
  ).run(sourceId, hoursAgo >= 0 ? `-${hoursAgo} hours` : `+${-hoursAgo} hours`);
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
    // The MESSAGE is what makes this case distinct from any other throw; without
    // it this test was a second copy of its neighbour. (The guard itself is pinned
    // in openneuro-discovery.test.ts, which drives the real pagination.)
    expect(result.errors[0]?.error).toContain("truncated");
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
    expect(result.backlog.tracked).toHaveLength(30);
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
    expect(result.backlog.tracked).toEqual([]);
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

    // The claim is that they never reach the partition -- so EVERY bucket is empty,
    // not just neverAttempted. Asserting only neverAttempted held whichever way the
    // rows were classified, so dropping "copying" from the in-flight set left this
    // test green while five rows silently became `tracked`.
    expect(result.backlog).toEqual({
      neverAttempted: [],
      untracked: [],
      tracked: [],
      blocklisted: [],
    });
    expect(result.status).toBe("healthy");
  });
});

// ---------------------------------------------------------------------------
// The standing issue's lifecycle
// ---------------------------------------------------------------------------

describe("a degraded read is not a drained backlog", () => {
  /**
   * The subtlest way to a false all-clear, and the one no `unknown` path could see
   * before the plausibility floor.
   *
   * `discoverOpenNeuroDatasets` refuses a TRUNCATED scan, but `MIN_COVERAGE` counts
   * raw edges: if OpenNeuro's snapshot resolver nulls `summary.modalities`
   * fleet-wide, every dataset falls out of `keepByModality` and the scan returns an
   * empty in-scope set with 100 percent coverage and NO error. Reviewed and
   * reproduced: that read as healthy and closed the live alarm, commenting
   * "Coverage recovered", with the cron logging at console.log and the CLI exiting 0.
   */
  test("an empty in-scope scan against a populated catalogue is unknown, not healthy", async () => {
    const db = freshDb();
    for (const d of discovered(30)) seedImported(db, d.id);
    seedDispatch(db, 1);
    const deps = recordingDeps([], [coverageIssue(700, "silence")]);

    const result = await runImportCoverageSweep(envFor(db), { apply: true }, deps);

    expect(result.status).toBe("unknown");
    expect(result.errors[0]?.stage).toBe("discovery");
    expect(result.errors[0]?.error).toContain("refusing to read that as a drained backlog");
    // The live alarm survives: not closed, not commented.
    expect(deps.closed).toEqual([]);
    expect(deps.comments).toEqual([]);
    expect(result.issue).toBeNull();
  });

  /**
   * The floor measures how many of OUR MIRRORS the scan still returns, not the two
   * totals. Review showed the totals comparison rested on a false invariant --
   * `discovered` is what is in scope on the latest snapshot, `imported` is whatever
   * we ever mirrored -- so ordinary drift (upstream deletion, an unreadable
   * snapshot, a modality retag) ate the margin and would have latched the floor ON
   * permanently, leaving the monitor dark with no operator escape.
   */
  test("ordinary drift does not trip the floor", async () => {
    const db = freshDb();
    for (const d of discovered(30)) seedImported(db, d.id);
    seedDispatch(db, 1);
    // 25 of our 30 mirrors still in scope, 5 gone: well within tolerance, and a
    // strictly smaller scan than the catalogue -- which the old rule refused.
    const deps = recordingDeps(discovered(25));

    const result = await runImportCoverageSweep(envFor(db), {}, deps);

    expect(result.status).toBe("healthy");
    expect(result.importedInScan).toBe(25);
    expect(result.importedNotInScan).toBe(5);
  });

  test("losing more than half the catalogue from the scan is unknown", async () => {
    const db = freshDb();
    for (const d of discovered(30)) seedImported(db, d.id);
    const deps = recordingDeps(discovered(14));

    const result = await runImportCoverageSweep(envFor(db), {}, deps);

    expect(result.status).toBe("unknown");
    expect(result.errors[0]?.error).toContain("only 14 of the 30");
  });

  test("the floor is inert below the minimum baseline, so fixtures and cold starts pass", async () => {
    const db = freshDb();
    // Fewer mirrors than COVERAGE_SCAN_SANITY_MIN_IMPORTED: no meaningful baseline.
    for (const d of discovered(COVERAGE_SCAN_SANITY_MIN_IMPORTED - 1)) seedImported(db, d.id);
    seedDispatch(db, 1);
    const result = await runImportCoverageSweep(envFor(db), {}, recordingDeps([]));
    expect(result.status).toBe("healthy");
    expect(result.errors).toEqual([]);
  });

  test("an empty catalogue is inert too", async () => {
    const db = freshDb();
    const result = await runImportCoverageSweep(envFor(db), {}, recordingDeps([]));
    expect(result.status).toBe("healthy");
    expect(result.errors).toEqual([]);
  });

  /**
   * The bug the balance line had: `POST /admin/datasets/import` writes the `datasets`
   * row AND the `preparing` `import_jobs` row in one handler, so every in-flight
   * import is in `imported` and `inFlight` at once. Summing D1's set sizes therefore
   * over-counted and the report declared itself unreliable on every healthy run.
   * Counted over the scan, the terms are a partition and the totals agree.
   */
  test("a mid-import dataset is counted once, so the totals still balance", async () => {
    const db = freshDb();
    seedImported(db, "ds000001");
    seedImportJob(db, "ds000001", { status: "copying" });
    seedDispatch(db, 1);
    const deps = recordingDeps(discovered(1));

    const result = await runImportCoverageSweep(envFor(db), {}, deps);

    // In both D1 sets, counted once against the scan.
    expect(result.importedInScan).toBe(1);
    expect(result.inFlight).toBe(0);
    const accounted =
      result.importedInScan +
      result.inFlight +
      result.terminal +
      result.backlog.neverAttempted.length +
      result.backlog.untracked.length +
      result.backlog.tracked.length +
      result.backlog.blocklisted.length;
    expect(accounted).toBe(result.discovered);
  });

  test("a quarantined dataset that kept its datasets row is also counted once", async () => {
    const db = freshDb();
    seedImported(db, "ds000001");
    seedImportJob(db, "ds000001", { status: "quarantined" });
    seedDispatch(db, 1);
    const deps = recordingDeps(discovered(1));

    const result = await runImportCoverageSweep(envFor(db), {}, deps);

    expect(result.importedInScan).toBe(1);
    expect(result.terminal).toBe(0);
    expect(result.status).toBe("healthy");
  });
});

describe("a fresh dispatch row is not proof the hand-off landed", () => {
  /**
   * The audit row is written to reserve the slot, BEFORE `triggerOpenNeuroOnboard`.
   * If the PAT expires the row still appears every ~30 minutes while nothing is
   * imported, so the clock looks fresh and `silence` can never fire. Before this
   * cross-check that reported healthy until the standalone backlog threshold, i.e.
   * weeks -- a blind spot the size of the incident the phase was written for.
   */
  test("a picked dataset that never acquired an import row alarms as dispatch-lost", async () => {
    const db = freshDb();
    seedDispatch(db, 8, "ds000001");
    const deps = recordingDeps(discovered(1));

    const result = await runImportCoverageSweep(envFor(db), {}, deps);

    expect(result.dispatchLost).toBe(true);
    expect(result.status).toBe("alarm");
    expect(result.kind).toBe("dispatch-lost");
    expect(result.lastDispatchSourceId).toBe("ds000001");
  });

  test("a dispatch whose dataset DID acquire a row is not lost", async () => {
    const db = freshDb();
    seedDispatch(db, 8, "ds000001");
    seedImportJob(db, "ds000001", { status: "failed" });
    const deps = recordingDeps(discovered(1));

    const result = await runImportCoverageSweep(envFor(db), {}, deps);

    expect(result.dispatchLost).toBe(false);
    expect(result.status).toBe("healthy");
  });

  test("a dispatch too recent to judge is not called lost", async () => {
    // The onboard workflow needs time to write its row; judging at once would alarm
    // on every normal dispatch.
    const db = freshDb();
    seedDispatch(db, 1, "ds000001");
    const result = await runImportCoverageSweep(envFor(db), {}, recordingDeps(discovered(1)));
    expect(result.dispatchLost).toBe(false);
    expect(result.status).toBe("healthy");
  });
});

describe("a switched-off importer is never a recovery", () => {
  /**
   * The failure this gate exists for: an operator manually imports the most-wanted
   * datasets, outstanding work drops below the threshold, and the monitor closes the
   * only durable record that the importer is still off -- the incident, re-enacted
   * by its own alarm.
   */
  test("healthy-because-drained does NOT close the issue while the importer is off", async () => {
    const db = freshDb();
    seedDispatch(db, 24 * 60);
    const deps = recordingDeps([], [coverageIssue(700, "disabled")]);

    const result = await runImportCoverageSweep(envFor(db, false), { apply: true }, deps);

    expect(result.status).toBe("healthy");
    expect(deps.closed).toEqual([]);
    // Kept open, so the fact that it is off survives -- and the stand-down is
    // announced ONCE, because the body flipping from ALARM to HEALTHY is a material
    // change a watcher must not have to notice for themselves.
    expect(result.issue?.action).toBe("relabelled");
    expect(deps.updated[0]?.n).toBe(700);
    expect(deps.comments[0]?.body).toContain("Alarm stood down, issue kept open");
    // The kind label is cleared, which is what makes it fire once rather than daily.
    expect(deps.labelled[0]?.labels).toEqual(["import-coverage"]);
  });

  test("a SECOND still-off run is silent: the kind label is already cleared", async () => {
    const db = freshDb();
    seedDispatch(db, 24 * 60);
    // No kind label: yesterday's run already stood the alarm down.
    const deps = recordingDeps([], [coverageIssue(700)]);

    const result = await runImportCoverageSweep(envFor(db, false), { apply: true }, deps);

    expect(result.issue).toEqual({ number: 700, action: "refreshed" });
    expect(deps.comments).toEqual([]);
    expect(deps.labelled).toEqual([]);
    expect(deps.closed).toEqual([]);
  });

  test("healthy with the importer ENABLED does close it", async () => {
    const db = freshDb();
    seedDispatch(db, 1);
    const deps = recordingDeps([], [coverageIssue(700, "silence")]);

    const result = await runImportCoverageSweep(envFor(db), { apply: true }, deps);

    expect(deps.closed).toEqual([700]);
    expect(result.issue?.action).toBe("closed");
  });
});

describe("a write that lands is always counted", () => {
  /**
   * The body PATCH lands, then the label write fails. An earlier version let that
   * throw out of `reportCoverage`, so `result.issue` stayed null: the summary said
   * `issue=none`, the route's audit gate saw no change and wrote no row, and the CLI
   * printed nothing -- for a run that had just rewritten a real issue. Same
   * "counts describe what landed" rule as phase 2, one level up.
   */
  test("a label write that fails after the body landed still reports the action", async () => {
    const db = freshDb();
    seedDispatch(db, 24 * 3);
    const deps = recordingDeps(
      discovered(COVERAGE_BACKLOG_ALARM),
      [coverageIssue(700, "silence")],
      { setLabels: new Error("HTTP 502 - bad gateway") },
    );

    // Switched off, so the kind changes from silence to disabled.
    const result = await runImportCoverageSweep(envFor(db, false), { apply: true }, deps);

    expect(deps.updated[0]?.n).toBe(700);
    expect(result.issue?.action).toBe("relabelled");
    expect(result.issue?.labelError).toContain("502");
    // No comment: the label write is the state change, and it did not land.
    expect(deps.comments).toEqual([]);
  });

  test("a close that fails is a report error, and the action is not claimed", async () => {
    const db = freshDb();
    seedDispatch(db, 1);
    const deps = recordingDeps([], [coverageIssue(700, "silence")], {
      close: new Error("HTTP 403 - forbidden"),
    });

    const result = await runImportCoverageSweep(envFor(db), { apply: true }, deps);

    expect(result.status).toBe("healthy");
    expect(result.errors[0]?.stage).toBe("report");
    expect(result.issue).toBeNull();
    expect(deps.comments).toEqual([]);
  });

  test("a body update that fails is a report error", async () => {
    const db = freshDb();
    seedDispatch(db, 24 * 3);
    const deps = recordingDeps(
      discovered(COVERAGE_BACKLOG_ALARM),
      [coverageIssue(700, "silence")],
      { update: new Error("HTTP 422") },
    );

    const result = await runImportCoverageSweep(envFor(db), { apply: true }, deps);

    expect(result.errors[0]?.stage).toBe("report");
    expect(result.issue).toBeNull();
  });
});

describe("two kind labels are corrected, not trusted", () => {
  /**
   * `kindsFromLabels` returns every match rather than the first. Taking the first
   * could equal the current kind, short-circuit to a body-only refresh, and leave
   * the contradictory label in place forever -- quietly falsifying the "read the
   * live kind off the document" property the whole design rests on.
   */
  test("an issue carrying two kind labels is relabelled even when one matches", async () => {
    const db = freshDb();
    seedDispatch(db, 24 * 3);
    const issue = coverageIssue(700, "silence");
    issue.labels = [...(issue.labels ?? []), { name: IMPORT_COVERAGE_KIND_LABELS.backlog }];
    const deps = recordingDeps(discovered(COVERAGE_BACKLOG_ALARM), [issue]);

    const result = await runImportCoverageSweep(envFor(db), { apply: true }, deps);

    expect(result.kind).toBe("silence");
    expect(result.issue?.action).toBe("relabelled");
    const applied = deps.labelled[0]?.labels ?? [];
    expect(applied).toContain(IMPORT_COVERAGE_KIND_LABELS.silence);
    expect(applied).not.toContain(IMPORT_COVERAGE_KIND_LABELS.backlog);
  });

  test("an issue carrying no kind label is relabelled rather than read as settled", async () => {
    const db = freshDb();
    seedDispatch(db, 24 * 3);
    const deps = recordingDeps(discovered(COVERAGE_BACKLOG_ALARM), [coverageIssue(700)]);

    const result = await runImportCoverageSweep(envFor(db), { apply: true }, deps);

    expect(result.issue?.action).toBe("relabelled");
    expect(deps.labelled[0]?.labels).toContain(IMPORT_COVERAGE_KIND_LABELS.silence);
  });
});

describe("anomalies are surfaced without invalidating the verdict", () => {
  test("an unparseable dispatch timestamp is reported and reads as stale", async () => {
    const db = freshDb();
    db.query(
      `INSERT INTO audit_log (action, resource_id, details, timestamp)
       VALUES ('auto_import_dispatch', 'ds000001', '{}', 'not-a-timestamp')`,
    ).run();
    const deps = recordingDeps(discovered(COVERAGE_BACKLOG_ALARM));

    const result = await runImportCoverageSweep(envFor(db), {}, deps);

    expect(result.errors.some((e) => e.stage === "anomaly")).toBe(true);
    expect(result.dispatchAgeHours).toBeNull();
    // Conservative direction: unreadable reads as stale, so with work outstanding it
    // alarms rather than passing as fresh.
    expect(result.status).toBe("alarm");
    expect(result.kind).toBe("silence");
  });

  test("a future-dated dispatch is reported and cannot suppress the alarm", async () => {
    const db = freshDb();
    seedDispatch(db, -10, "ds000001");
    const deps = recordingDeps(discovered(COVERAGE_BACKLOG_ALARM));

    const result = await runImportCoverageSweep(envFor(db), {}, deps);

    expect(result.errors.some((e) => e.error.includes("future"))).toBe(true);
    expect(result.status).toBe("alarm");
  });
});

describe("the sweep binds the real collaborators", () => {
  /**
   * Every other test injects `discover`, so nothing pinned that the sweep calls the
   * real scan at all -- review confirmed that replacing the default with
   * `async () => []` left 153 tests green. This one drives the REAL
   * `discoverOpenNeuroDatasets` with only its documented `fetchImpl` seam redirected
   * at a local server, so scan -> modality filter -> diff -> partition -> verdict
   * runs as one piece, the way `zarr-fidelity-sweep-route.test.ts` does it.
   */
  test("the real scan, filter, diff and verdict compose", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          data: {
            datasets: {
              pageInfo: { count: 3, hasNextPage: false, endCursor: null },
              edges: [
                // In scope.
                {
                  node: {
                    id: "ds000001",
                    latestSnapshot: { tag: "1.0.0", summary: { modalities: ["eeg"] } },
                  },
                },
                // Out of scope: the real modality filter must drop this.
                {
                  node: {
                    id: "ds000002",
                    latestSnapshot: { tag: "1.0.0", summary: { modalities: ["mri"] } },
                  },
                },
                // No snapshot at all: dropped too, and the reason the plausibility
                // floor exists.
                { node: { id: "ds000003", latestSnapshot: null } },
              ],
            },
          },
        });
      },
    });
    try {
      const db = freshDb();
      seedDispatch(db, 1);
      const base = recordingDeps([]);
      const url = `http://localhost:${server.port}`;
      const result = await runImportCoverageSweep(
        envFor(db),
        {},
        {
          ...base,
          discover: () =>
            discoverOpenNeuroDatasets({
              fetchImpl: ((_input: unknown, init?: RequestInit) =>
                fetch(url, init)) as unknown as typeof fetch,
            }),
        },
      );

      // One of three survived the real filter, and it is a real coverage gap.
      expect(result.discovered).toBe(1);
      expect(result.backlog.neverAttempted).toEqual(["ds000001"]);
    } finally {
      server.stop(true);
    }
  });

  test("the widened dispatch query selects the same row as the importer's gate", async () => {
    // The sweep needs `resource_id` as well as the clock, so it has its own query. A
    // drift in the predicate would make the sweep and the importer disagree about
    // when the importer last moved.
    const db = freshDb();
    seedDispatch(db, 5, "ds000001");
    seedDispatch(db, 1, "ds000002");
    const gate = db.query(AUTO_IMPORT_GATE_QUERY).get() as { timestamp: string };
    const mine = db.query(COVERAGE_LAST_DISPATCH_QUERY).get() as {
      timestamp: string;
      resource_id: string;
    };
    expect(mine.timestamp).toBe(gate.timestamp);
    expect(mine.resource_id).toBe("ds000002");
  });
});

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

    expect(result.issue).toEqual({ number: 700, action: "refreshed" });
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

    expect(result.issue?.action).toBe("relabelled");
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
    // ADR 0052: a comment ahead of a failed close is a permanent lie that repeats
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
    expect(line).toContain(`outstanding=${COVERAGE_BACKLOG_ALARM}`);
    expect(line).toContain(`never_attempted=${COVERAGE_BACKLOG_ALARM}`);
    expect(line).toContain("errors=0");
  });

  test("renders a never-dispatched pipeline as never, not as 0 hours", async () => {
    const db = freshDb();
    const deps = recordingDeps([], []);
    const result = await runImportCoverageSweep(envFor(db), {}, deps);
    expect(importCoverageSweepSummary(result)).toContain("dispatch=never recorded");
  });
});

// ---------------------------------------------------------------------------
// The cron leaves a durable record (#1312 needed this; the gap predates it)
// ---------------------------------------------------------------------------

describe("the cron wrapper records what it did", () => {
  test("an applied cron run that filed the issue writes a system audit row", async () => {
    const db = freshDb();
    seedDispatch(db, COVERAGE_DISPATCH_STALE_HOURS * 3);
    const deps = recordingDeps(discovered(COVERAGE_BACKLOG_ALARM), []);

    await runImportCoverageSweepCron(
      { ...envFor(db), ENVIRONMENT: "production" } as Bindings,
      deps,
    );

    const rows = db
      .query<{ user_id: number | null; details: string | null }, []>(
        "SELECT user_id, details FROM audit_log WHERE action = 'import_coverage_sweep'",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBeNull();
    expect(JSON.parse(rows[0]?.details ?? "{}")).toMatchObject({
      source: "cron",
      issue_action: "created",
    });
  });

  /** `refreshed` is the routine daily body rewrite. Auditing it would write a row a
   *  day saying nothing changed, which is the accrual this epic fights. */
  test("a routine refresh writes no row", async () => {
    const db = freshDb();
    seedDispatch(db, COVERAGE_DISPATCH_STALE_HOURS * 3);
    const deps = recordingDeps(discovered(COVERAGE_BACKLOG_ALARM), [coverageIssue(700, "silence")]);

    await runImportCoverageSweepCron(
      { ...envFor(db), ENVIRONMENT: "production" } as Bindings,
      deps,
    );

    const rows = db
      .query<{ id: number }, []>("SELECT id FROM audit_log WHERE action = 'import_coverage_sweep'")
      .all();
    expect(rows).toEqual([]);
  });
});
