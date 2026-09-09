/**
 * The import-failure issue triage sweep (epic #1306, issue #1310).
 *
 * Driven against real in-memory SQLite with every migration applied. Only the
 * TRANSPORT is injected -- the GitHub client calls and the S3 verify -- so the
 * decisions, the SQL and the comment bodies all run for real.
 *
 * The assertions that matter are the refusals. Closing an issue for a dataset
 * that is still broken discards a live problem silently, and there are five
 * distinct ways to reach that mistake: a transient error, an unresolvable
 * manifest, a manifest that declares no annex-keyed objects at all (so
 * "complete" compared nothing), a hand-written issue, and a dataset with no
 * import row.
 *
 * The second group is the APPLY half, which review found untested: every
 * fail-open test used to throw from `verify`, i.e. from the plan phase only, so
 * nothing covered a run whose GitHub writes fail. That is the realistic outage --
 * a PAT that lost `issues: write` still reads fine -- and it is what made the
 * counters, the log verbs and the route's status code disagree with reality.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { GitHubIssue } from "../src/services/github/issues";
import type { DatasetVersionIntegrityResult } from "../src/services/import-integrity";
import { IMPORT_ROLLUP_ISSUE_LABEL } from "../src/services/import-issue-accrual";
import {
  IMPORT_FAILURE_ISSUE_LABEL,
  importFailureIssueTitle,
} from "../src/services/import-issue-identity";
import {
  IMPORT_ISSUE_SWEEP_MAX_LIMIT,
  type ImportIssueSweepDeps,
  importIssueSweepLogLines,
  runImportIssueSweep,
  runImportIssueSweepCron,
  windowStart,
} from "../src/services/import-issue-sweep";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A real failing message from the incident window (expired PAT). */
const AUTH_ERROR =
  "Failed to push: remote: Invalid username or token. Password authentication is not supported for Git operations.";

function seedImportJob(
  db: Database,
  datasetId: string,
  opts: { lastError?: string | null; stage?: string } = {},
): void {
  db.query(
    `INSERT INTO import_jobs (dataset_id, source, source_id, stage, status, last_error)
     VALUES (?, 'openneuro', ?, ?, 'failed', ?)`,
  ).run(
    datasetId,
    `ds${datasetId.slice(2)}`,
    opts.stage ?? "prepare",
    opts.lastError === undefined ? AUTH_ERROR : opts.lastError,
  );
}

function issue(
  number: number,
  datasetId: string,
  labels: string[] = [IMPORT_FAILURE_ISSUE_LABEL],
): GitHubIssue {
  return {
    number,
    html_url: `https://github.com/nemarDatasets/.github/issues/${number}`,
    state: "open",
    title: importFailureIssueTitle(datasetId, `ds${datasetId.slice(2)}`),
    labels: labels.map((name) => ({ name })),
  };
}

function integrity(over: Partial<DatasetVersionIntegrityResult>): DatasetVersionIntegrityResult {
  return {
    complete: false,
    missingKeys: [],
    zeroByteKeys: [],
    expectedCount: 0,
    presentCount: 0,
    bytesPresent: 0,
    declaredBytes: 0,
    declaredFiles: 0,
    version: "1.0.0",
    ...over,
  };
}

const COMPLETE = integrity({ complete: true, expectedCount: 4812, presentCount: 4812 });
const INCOMPLETE = integrity({ complete: false, expectedCount: 3310, presentCount: 0 });
/** Verified, but no manifest -- completeness is UNKNOWN. */
const NO_MANIFEST = integrity({ complete: false, version: null });

/**
 * Records every write the sweep attempts, so a dry run can be proved silent.
 *
 * `fail` makes one of the three GitHub writes throw, which is how the apply-phase
 * tests reach the branches a `verify` throw cannot: a write that fails after the
 * decision is already made.
 */
function recordingDeps(
  issues: GitHubIssue[],
  verdicts: Record<string, DatasetVersionIntegrityResult | Error>,
  fail: { close?: Error; setLabels?: Error; comment?: Error } = {},
): ImportIssueSweepDeps & {
  closed: number[];
  labelled: { n: number; labels: string[] }[];
  comments: { n: number; body: string }[];
} {
  const closed: number[] = [];
  const labelled: { n: number; labels: string[] }[] = [];
  const comments: { n: number; body: string }[] = [];
  return {
    closed,
    labelled,
    comments,
    token: async () => "test-token",
    listOpenIssues: async () => issues,
    verify: async (_env, datasetId) => {
      const v = verdicts[datasetId];
      if (v === undefined) throw new Error(`no verdict configured for ${datasetId}`);
      if (v instanceof Error) throw v;
      return v;
    },
    close: async (_repo, n) => {
      if (fail.close) throw fail.close;
      closed.push(n);
    },
    setLabels: async (_repo, n, labels) => {
      if (fail.setLabels) throw fail.setLabels;
      labelled.push({ n, labels });
    },
    comment: async (_repo, n, body) => {
      if (fail.comment) throw fail.comment;
      comments.push({ n, body });
    },
  };
}

function envFor(db: Database): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as unknown as Bindings;
}

/** An open per-cause rollup, carrying the tracking label as the real ones do. */
function rollupIssue(number = 999): GitHubIssue {
  return {
    number,
    html_url: `https://example/${number}`,
    state: "open",
    title: "Import failures (rollup): auth_invalid",
    labels: [{ name: IMPORT_FAILURE_ISSUE_LABEL }, { name: IMPORT_ROLLUP_ISSUE_LABEL }],
  };
}

/** `n` seeded per-dataset issues, all still incomplete and already carrying the
 *  right cause label, so nothing in them decides anything but "keep". */
function backlog(
  db: Database,
  n: number,
): { issues: GitHubIssue[]; verdicts: Record<string, DatasetVersionIntegrityResult> } {
  const issues: GitHubIssue[] = [];
  const verdicts: Record<string, DatasetVersionIntegrityResult> = {};
  for (let i = 1; i <= n; i++) {
    const id = `on${String(i).padStart(6, "0")}`;
    seedImportJob(db, id);
    issues.push(issue(i, id, [IMPORT_FAILURE_ISSUE_LABEL, "auth-invalid"]));
    verdicts[id] = INCOMPLETE;
  }
  return { issues, verdicts };
}

// ---------------------------------------------------------------------------
// Closing on verified recovery
// ---------------------------------------------------------------------------

describe("a recovered import closes its issue", () => {
  test("verified complete -> closed, with the real numbers in the comment", async () => {
    const db = freshDb();
    seedImportJob(db, "on006136");
    const deps = recordingDeps([issue(105, "on006136")], { on006136: COMPLETE });

    const result = await runImportIssueSweep(envFor(db), { apply: true }, deps);

    expect(result.closed).toBe(1);
    expect(deps.closed).toEqual([105]);
    // The comment must quote what was actually verified, not a placeholder.
    expect(deps.comments[0]?.body).toContain("4812");
    expect(deps.comments[0]?.body).toContain("1.0.0");
    // ...and must not overstate the guarantee.
    expect(deps.comments[0]?.body).toContain("Size-level verification, not checksum-level");
  });

  /**
   * The ordering is load-bearing, and it is the REVERSE of what this test
   * originally asserted.
   *
   * Commenting first reads better -- no issue is ever closed without the record
   * of why -- but the two writes are not a transaction. A comment that lands
   * ahead of a close that 403s leaves an OPEN issue carrying "Recovered: closing
   * automatically", and since the verdict is recomputed from world state that did
   * not change, it re-comments every single daily run. Closing first cannot
   * produce that: `closeIssue` is idempotent, and a closed issue leaves the
   * candidate set entirely, so the worst case is one missing explanation instead
   * of an unbounded stream of false ones.
   */
  test("the close is written BEFORE its comment, so a failed write cannot leave a false record", async () => {
    const db = freshDb();
    seedImportJob(db, "on006136");
    const order: string[] = [];
    const deps = recordingDeps([issue(105, "on006136")], { on006136: COMPLETE });
    const wrappedComment = deps.comment;
    const wrappedClose = deps.close;
    deps.comment = async (...args) => {
      order.push("comment");
      return wrappedComment?.(...args);
    };
    deps.close = async (...args) => {
      order.push("close");
      return wrappedClose?.(...args);
    };

    await runImportIssueSweep(envFor(db), { apply: true }, deps);
    expect(order).toEqual(["close", "comment"]);
  });

  test("the relabel is written BEFORE its comment, for the same reason", async () => {
    const db = freshDb();
    seedImportJob(db, "on003574");
    const order: string[] = [];
    const deps = recordingDeps(
      [issue(75, "on003574", [IMPORT_FAILURE_ISSUE_LABEL, "upstream-403"])],
      {
        on003574: INCOMPLETE,
      },
    );
    const wrappedComment = deps.comment;
    const wrappedSetLabels = deps.setLabels;
    deps.comment = async (...args) => {
      order.push("comment");
      return wrappedComment?.(...args);
    };
    deps.setLabels = async (...args) => {
      order.push("setLabels");
      return wrappedSetLabels?.(...args);
    };

    await runImportIssueSweep(envFor(db), { apply: true }, deps);
    expect(order).toEqual(["setLabels", "comment"]);
  });
});

// ---------------------------------------------------------------------------
// The APPLY half: a decision that was made correctly and then failed to land
// ---------------------------------------------------------------------------

describe("a write that fails is never counted as having happened", () => {
  test("a close that 403s reports closed=0, not closed=1", async () => {
    const db = freshDb();
    seedImportJob(db, "on006136");
    const deps = recordingDeps(
      [issue(105, "on006136")],
      { on006136: COMPLETE },
      {
        close: new Error("HTTP 403 - secondary rate limit"),
      },
    );

    const result = await runImportIssueSweep(envFor(db), { apply: true }, deps);

    // The count describes reality, not the plan.
    expect(result.closed).toBe(0);
    expect(result.attempted).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.stage).toBe("apply");
    expect(result.errors[0]?.issue).toBe(105);
    // The plan still records what SHOULD have happened, marked as not landed, so
    // the log line reads FAILED CLOSE rather than CLOSE.
    expect(result.plan[0]?.kind).toBe("close");
    expect(result.plan[0]?.failed).toBe(true);
    expect(importIssueSweepLogLines(result)[0]).toContain("FAILED CLOSE");
    // And, per the ordering above, no comment was left claiming otherwise.
    expect(deps.comments).toEqual([]);
  });

  test("a relabel that fails reports relabelled=0 and leaves no comment", async () => {
    const db = freshDb();
    seedImportJob(db, "on003574");
    const deps = recordingDeps(
      [issue(75, "on003574", [IMPORT_FAILURE_ISSUE_LABEL, "upstream-403"])],
      { on003574: INCOMPLETE },
      { setLabels: new Error("HTTP 403 - resource not accessible by integration") },
    );

    const result = await runImportIssueSweep(envFor(db), { apply: true }, deps);

    expect(result.relabelled).toBe(0);
    expect(result.errors[0]?.stage).toBe("apply");
    expect(deps.comments).toEqual([]);
    expect(importIssueSweepLogLines(result)[0]).toContain("FAILED RELABEL");
  });

  test("a comment that fails AFTER the close still counts the close, and says which half broke", async () => {
    const db = freshDb();
    seedImportJob(db, "on006136");
    const deps = recordingDeps(
      [issue(105, "on006136")],
      { on006136: COMPLETE },
      {
        comment: new Error("HTTP 502 - bad gateway"),
      },
    );

    const result = await runImportIssueSweep(envFor(db), { apply: true }, deps);

    // The close really happened, so un-counting it would be the lie.
    expect(deps.closed).toEqual([105]);
    expect(result.closed).toBe(1);
    expect(result.plan[0]?.failed).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.stage).toBe("comment");
    expect(result.errors[0]?.error).toContain("close landed");
  });

  /**
   * A DECISION failure is not an attempt. Folding plan failures into `attempted`
   * made the ratio degenerate on a dry run, where nothing is ever attempted: every
   * error was a plan error and every plan error also incremented `attempted`, so
   * "all attempts failed" held identically and one transient S3 error turned a
   * read-only run into a 502 (see the route test).
   */
  test("a plan failure is not counted as an attempted write", async () => {
    const db = freshDb();
    seedImportJob(db, "on005279");
    seedImportJob(db, "on006136");
    const deps = recordingDeps(
      [
        issue(97, "on005279", [IMPORT_FAILURE_ISSUE_LABEL, "auth-invalid"]),
        issue(105, "on006136", [IMPORT_FAILURE_ISSUE_LABEL, "auth-invalid"]),
      ],
      { on005279: INCOMPLETE, on006136: new Error("S3 5xx") },
    );

    const dry = await runImportIssueSweep(envFor(db), {}, deps);
    expect(dry.attempted).toBe(0);
    expect(dry.errors[0]?.stage).toBe("plan");
    expect(dry.kept).toBe(1);

    // Same on an applied run: the failing row never reached a write.
    const applied = await runImportIssueSweep(envFor(db), { apply: true }, deps);
    expect(applied.attempted).toBe(0);
  });

  test("a keep is never an attempt, so a run of keeps cannot look like a failed run", async () => {
    const db = freshDb();
    seedImportJob(db, "on005279");
    // Cause label already correct, so there is nothing to relabel either.
    const deps = recordingDeps(
      [issue(97, "on005279", [IMPORT_FAILURE_ISSUE_LABEL, "auth-invalid"])],
      { on005279: INCOMPLETE },
    );
    const result = await runImportIssueSweep(envFor(db), { apply: true }, deps);

    expect(result.kept).toBe(1);
    expect(result.attempted).toBe(0);
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The four ways to wrongly close -- all must refuse
// ---------------------------------------------------------------------------

describe("never closes an issue whose dataset is not provably recovered", () => {
  /**
   * `complete` upstream is `missingKeys.length === 0` over the manifest's
   * annex-keyed entries, so a manifest with none of them -- `files: {}`, or every
   * entry `git:`-keyed -- is `complete: true` having compared nothing. Closing on
   * that wrote "0 of 0 annex-keyed objects are present" onto a live problem.
   */
  test("complete over an EMPTY set is not a recovery", async () => {
    const db = freshDb();
    seedImportJob(db, "on006136");
    const deps = recordingDeps([issue(105, "on006136")], {
      on006136: integrity({ complete: true, expectedCount: 0, presentCount: 0 }),
    });

    const result = await runImportIssueSweep(envFor(db), { apply: true }, deps);

    expect(result.closed).toBe(0);
    expect(deps.closed).toEqual([]);
    expect(result.plan[0]?.reason).toContain("no annex-keyed objects");
  });

  /**
   * The machine-filed signature rebuilds the title from the D1 row's `source_id`
   * and compares. Every other fixture has `source_id === "ds" + id.slice(2)`, so
   * that read was indistinguishable from a string transform: review confirmed
   * that deriving it from the title left the whole suite green. A mismatching
   * source_id is what tells the two apart.
   */
  test("a title whose source_id does not match the import row is treated as hand-written", async () => {
    const db = freshDb();
    db.query(
      `INSERT INTO import_jobs (dataset_id, source, source_id, stage, status, last_error)
       VALUES ('on006136', 'openneuro', 'ds999999', 'prepare', 'failed', ?)`,
    ).run(AUTH_ERROR);
    // Title says ds006136; the row says ds999999.
    const deps = recordingDeps([issue(105, "on006136")], { on006136: COMPLETE });

    const result = await runImportIssueSweep(envFor(db), { apply: true }, deps);

    expect(result.closed).toBe(0);
    expect(deps.closed).toEqual([]);
    expect(result.plan[0]?.reason).toContain("human-authored");
  });

  test("still incomplete", async () => {
    const db = freshDb();
    seedImportJob(db, "on005279");
    const deps = recordingDeps([issue(97, "on005279")], { on005279: INCOMPLETE });

    const result = await runImportIssueSweep(envFor(db), { apply: true }, deps);

    expect(result.closed).toBe(0);
    expect(deps.closed).toEqual([]);
  });

  test("no resolvable manifest is unknown, not clean", async () => {
    const db = freshDb();
    seedImportJob(db, "on005279");
    const deps = recordingDeps([issue(97, "on005279")], { on005279: NO_MANIFEST });

    const result = await runImportIssueSweep(envFor(db), { apply: true }, deps);

    expect(result.closed).toBe(0);
    expect(deps.closed).toEqual([]);
    expect(result.plan[0]?.reason).toContain("completeness unknown");
  });

  test("a transient verify error fails open: nothing written, still a candidate", async () => {
    const db = freshDb();
    seedImportJob(db, "on005279");
    const deps = recordingDeps([issue(97, "on005279")], {
      on005279: new Error("S3 listing timed out"),
    });

    const result = await runImportIssueSweep(envFor(db), { apply: true }, deps);

    expect(result.closed).toBe(0);
    expect(deps.closed).toEqual([]);
    expect(deps.comments).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain("S3 listing timed out");
  });

  test("one row's error does not abort the rest of the run", async () => {
    const db = freshDb();
    seedImportJob(db, "on005279");
    seedImportJob(db, "on006136");
    const deps = recordingDeps([issue(97, "on005279"), issue(105, "on006136")], {
      on005279: new Error("S3 listing timed out"),
      on006136: COMPLETE,
    });

    const result = await runImportIssueSweep(envFor(db), { apply: true }, deps);

    expect(result.errors).toHaveLength(1);
    expect(result.closed).toBe(1);
    expect(deps.closed).toEqual([105]);
  });

  test("a hand-written issue is never touched, even when verified complete", async () => {
    const db = freshDb();
    seedImportJob(db, "on006136");
    const hand: GitHubIssue = {
      ...issue(200, "on006136"),
      title: "on006136 import looks wrong, please check",
    };
    const deps = recordingDeps([hand], { on006136: COMPLETE });

    const result = await runImportIssueSweep(envFor(db), { apply: true }, deps);

    expect(result.closed).toBe(0);
    expect(deps.closed).toEqual([]);
    expect(result.plan[0]?.reason).toContain("not machine-generated");
  });

  test("a dataset with no import_jobs row is kept, and costs no S3 walk", async () => {
    const db = freshDb();
    // No seedImportJob: the `no-import-row` triage class.
    let verifyCalls = 0;
    const deps = recordingDeps([issue(68, "on003190")], {});
    deps.verify = async () => {
      verifyCalls++;
      return COMPLETE;
    };

    const result = await runImportIssueSweep(envFor(db), { apply: true }, deps);

    expect(result.closed).toBe(0);
    expect(verifyCalls).toBe(0);
    expect(result.plan[0]?.reason).toContain("no import_jobs row");
  });
});

// ---------------------------------------------------------------------------
// Relabelling
// ---------------------------------------------------------------------------

describe("a changed cause relabels instead of appending under a stale label", () => {
  test("the legacy upstream-403 label is retired for the real cause", async () => {
    const db = freshDb();
    // The real cause was an expired PAT, but the issue carries upstream-403.
    seedImportJob(db, "on003574");
    const deps = recordingDeps(
      [issue(75, "on003574", [IMPORT_FAILURE_ISSUE_LABEL, "upstream-403"])],
      { on003574: INCOMPLETE },
    );

    const result = await runImportIssueSweep(envFor(db), { apply: true }, deps);

    expect(result.relabelled).toBe(1);
    expect(deps.labelled[0]?.labels).toContain("auth-invalid");
    expect(deps.labelled[0]?.labels).not.toContain("upstream-403");
  });

  test("a human triage label survives the relabel", async () => {
    const db = freshDb();
    seedImportJob(db, "on003190");
    const deps = recordingDeps(
      [issue(68, "on003190", [IMPORT_FAILURE_ISSUE_LABEL, "git-divergence", "no-import-row"])],
      { on003190: INCOMPLETE },
    );

    await runImportIssueSweep(envFor(db), { apply: true }, deps);

    expect(deps.labelled[0]?.labels).toContain("no-import-row");
  });

  test("an already-correct label writes nothing", async () => {
    const db = freshDb();
    seedImportJob(db, "on005691");
    const deps = recordingDeps(
      [issue(104, "on005691", [IMPORT_FAILURE_ISSUE_LABEL, "auth-invalid"])],
      { on005691: INCOMPLETE },
    );

    const result = await runImportIssueSweep(envFor(db), { apply: true }, deps);

    expect(result.relabelled).toBe(0);
    expect(result.kept).toBe(1);
    expect(deps.labelled).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dry run, mode and bounds
// ---------------------------------------------------------------------------

describe("dry run", () => {
  test("plans everything and writes nothing", async () => {
    const db = freshDb();
    seedImportJob(db, "on006136");
    seedImportJob(db, "on003574");
    const deps = recordingDeps(
      [issue(105, "on006136"), issue(75, "on003574", [IMPORT_FAILURE_ISSUE_LABEL, "upstream-403"])],
      { on006136: COMPLETE, on003574: INCOMPLETE },
    );

    const result = await runImportIssueSweep(envFor(db), {}, deps);

    expect(result.applied).toBe(false);
    expect(result.closed).toBe(1);
    expect(result.relabelled).toBe(1);
    // ...but nothing actually happened.
    expect(deps.closed).toEqual([]);
    expect(deps.labelled).toEqual([]);
    expect(deps.comments).toEqual([]);
  });
});

describe("mode and bounds", () => {
  test("a rollup issue does not count itself toward the cap", async () => {
    const db = freshDb();
    seedImportJob(db, "on006136");
    const rollup: GitHubIssue = {
      number: 999,
      html_url: "https://example/999",
      state: "open",
      title: "Import failures (rollup): auth_invalid",
      labels: [{ name: IMPORT_FAILURE_ISSUE_LABEL }, { name: IMPORT_ROLLUP_ISSUE_LABEL }],
    };
    const deps = recordingDeps([issue(105, "on006136"), rollup], { on006136: INCOMPLETE });

    const result = await runImportIssueSweep(envFor(db), {}, deps);

    // Two open issues listed, but only one is a per-dataset issue.
    expect(result.openIssues).toBe(1);
    expect(result.examined).toBe(1);
  });

  test("the backlog this phase was written for reports rollup mode", async () => {
    const db = freshDb();
    const { issues, verdicts } = backlog(db, 28);
    const deps = recordingDeps(issues, verdicts);

    const result = await runImportIssueSweep(envFor(db), {}, deps);

    expect(result.openIssues).toBe(28);
    expect(result.mode).toBe("rollup");
    expect(result.examined).toBe(15);
    // Deferred to a later run, not excluded: the window rotates.
    expect(result.remaining).toBe(13);
  });

  /**
   * The fixture has to be bigger than the boundary it probes. With one issue,
   * `examined` was 1 for every limit >= 1, so deleting the `Math.min(...,
   * IMPORT_ISSUE_SWEEP_MAX_LIMIT)` clamp left the suite green
   * (`.rules/testing.md`: "the fixture is too small to reach the boundary it
   * claims to probe").
   */
  test("the per-run limit is clamped at both ends", async () => {
    const db = freshDb();
    const { issues, verdicts } = backlog(db, 40);
    const deps = recordingDeps(issues, verdicts);

    const huge = await runImportIssueSweep(envFor(db), { limit: 5000 }, deps);
    expect(huge.examined).toBe(IMPORT_ISSUE_SWEEP_MAX_LIMIT);
    expect(huge.remaining).toBe(40 - IMPORT_ISSUE_SWEEP_MAX_LIMIT);

    const zero = await runImportIssueSweep(envFor(db), { limit: 0 }, deps);
    expect(zero.examined).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The window has to move, or a broken head starves the tail forever
// ---------------------------------------------------------------------------

describe("windowStart rotates a bounded window over an unbounded backlog", () => {
  test("a backlog that fits in one run never rotates", () => {
    expect(windowStart(10, 15, new Date("2026-09-09T00:00:00Z"))).toBe(0);
    expect(windowStart(15, 15, new Date("2026-09-09T00:00:00Z"))).toBe(0);
  });

  test("two runs on the same day examine the same window", () => {
    const morning = windowStart(29, 15, new Date("2026-09-09T01:00:00Z"));
    const evening = windowStart(29, 15, new Date("2026-09-09T23:00:00Z"));
    expect(morning).toBe(evening);
  });

  test("consecutive days advance by the limit, and every candidate is reached", () => {
    const count = 29;
    const limit = 15;
    const day0 = new Date("2026-09-09T00:00:00Z").getTime();
    const seen = new Set<number>();
    // ceil(29/15) = 2 days is the claim; give it those two and no more.
    for (let d = 0; d < 2; d++) {
      const start = windowStart(count, limit, new Date(day0 + d * 86_400_000));
      for (let i = 0; i < limit; i++) seen.add((start + i) % count);
    }
    expect(seen.size).toBe(count);
  });

  test("the sweep examines a rotated window, not always the head", async () => {
    // 29 candidates, limit 15, so the window is a rotated slice rather than the head.
    const db = freshDb();
    const { issues, verdicts } = backlog(db, 29);
    const deps = recordingDeps(issues, verdicts);
    const result = await runImportIssueSweep(envFor(db), { limit: 15 }, deps);

    const examined = result.plan.map((e) => e.issueNumber);
    expect(examined).toHaveLength(15);
    // Ordered oldest-first from the rotation point, so the set is contiguous
    // modulo the candidate count rather than GitHub's newest-first head.
    const start = windowStart(29, 15, new Date());
    const expected = Array.from({ length: 15 }, (_, i) => ((start + i) % 29) + 1);
    expect(examined).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// The rollup's other half: something has to close it
// ---------------------------------------------------------------------------

describe("a rollup is released once the backlog drains", () => {
  test("closed when the mode has released, with a comment saying it is not a verdict", async () => {
    const db = freshDb();
    seedImportJob(db, "on000001");
    const deps = recordingDeps(
      [issue(1, "on000001", [IMPORT_FAILURE_ISSUE_LABEL, "auth-invalid"]), rollupIssue()],
      { on000001: INCOMPLETE },
    );

    const result = await runImportIssueSweep(envFor(db), { apply: true }, deps);

    // One per-dataset issue open, so the mode is released.
    expect(result.mode).toBe("per-dataset");
    expect(result.rollupsReleased).toBe(1);
    expect(deps.closed).toContain(999);
    const release = deps.comments.find((c) => c.n === 999);
    expect(release?.body).toContain("NOT a verdict on the datasets");
  });

  test("kept open while the backlog is still above the resume threshold", async () => {
    const db = freshDb();
    const { issues, verdicts } = backlog(db, 12);
    const deps = recordingDeps([...issues, rollupIssue()], verdicts);

    const result = await runImportIssueSweep(envFor(db), { apply: true }, deps);

    expect(result.mode).toBe("rollup");
    expect(result.rollupsReleased).toBe(0);
    expect(deps.closed).not.toContain(999);
  });

  test("a dry run reports the release without performing it", async () => {
    const db = freshDb();
    seedImportJob(db, "on000001");
    const deps = recordingDeps(
      [issue(1, "on000001", [IMPORT_FAILURE_ISSUE_LABEL, "auth-invalid"]), rollupIssue()],
      { on000001: INCOMPLETE },
    );

    const result = await runImportIssueSweep(envFor(db), {}, deps);

    expect(result.rollupsReleased).toBe(1);
    expect(deps.closed).toEqual([]);
    expect(importIssueSweepLogLines(result).some((l) => l.startsWith("WOULD RELEASE"))).toBe(true);
  });

  test("a release whose close fails prints FAILED RELEASE and is not counted", async () => {
    const db = freshDb();
    seedImportJob(db, "on000001");
    const deps = recordingDeps(
      [issue(1, "on000001", [IMPORT_FAILURE_ISSUE_LABEL, "auth-invalid"]), rollupIssue()],
      { on000001: INCOMPLETE },
      { close: new Error("HTTP 403 - forbidden") },
    );

    const result = await runImportIssueSweep(envFor(db), { apply: true }, deps);

    // Decremented back: the count describes what landed, exactly as for a close.
    expect(result.rollupsReleased).toBe(0);
    expect(result.rollups[0]?.outcome).toBe("failed");
    expect(result.errors.some((e) => e.issue === 999 && e.stage === "apply")).toBe(true);
    // The verb comes from the rollup's own outcome, not from mode/applied.
    expect(importIssueSweepLogLines(result).some((l) => l.startsWith("FAILED RELEASE"))).toBe(true);
  });

  test("the release comment quotes the count AFTER this run's closes", async () => {
    const db = freshDb();
    // Two issues, both recovered, so both close and the true post-run count is 0.
    seedImportJob(db, "on000001");
    seedImportJob(db, "on000002");
    const deps = recordingDeps(
      [
        issue(1, "on000001", [IMPORT_FAILURE_ISSUE_LABEL, "auth-invalid"]),
        issue(2, "on000002", [IMPORT_FAILURE_ISSUE_LABEL, "auth-invalid"]),
        rollupIssue(),
      ],
      { on000001: COMPLETE, on000002: COMPLETE },
    );

    const result = await runImportIssueSweep(envFor(db), { apply: true }, deps);

    expect(result.closed).toBe(2);
    const release = deps.comments.find((c) => c.n === 999);
    // 2 open minus 2 closed, not the stale pre-loop 2.
    expect(release?.body).toContain("down to 0");
  });

  test("a rollup is never verified as though it were a dataset issue", async () => {
    const db = freshDb();
    const deps = recordingDeps([rollupIssue()], {});

    const result = await runImportIssueSweep(envFor(db), {}, deps);

    // No verdict is configured for it, so a verify attempt would throw.
    expect(result.examined).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.openIssues).toBe(0);
    expect(result.rollups).toEqual([
      { number: 999, title: "Import failures (rollup): auth_invalid" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The cron wrapper's guard, in BOTH directions
// ---------------------------------------------------------------------------

describe("runImportIssueSweepCron refuses outside production", () => {
  for (const environment of ["development", "staging", "test"]) {
    test(`${environment} skips without touching the sweep`, async () => {
      const db = freshDb();
      let touched = false;
      const result = await runImportIssueSweepCron(
        { ...envFor(db), ENVIRONMENT: environment } as Bindings,
        {
          token: async () => {
            touched = true;
            return "t";
          },
        },
      );
      expect(result).toBeNull();
      expect(touched).toBe(false);
    });
  }

  // The fail-closed half: anything not recognised as non-production must RUN,
  // or a mis-set variable silently returns the tracker to accumulate-only.
  for (const environment of ["production", "", undefined, "prod", "Production"]) {
    test(`${environment === undefined ? "undefined" : `"${environment}"`} delegates with apply on`, async () => {
      const db = freshDb();
      const result = await runImportIssueSweepCron(
        { ...envFor(db), ENVIRONMENT: environment } as Bindings,
        { token: async () => "t", listOpenIssues: async () => [] },
      );
      // Not null: the guard let it through. And the wrapper is what supplies
      // `apply`, so a run reaching here writes for real in production.
      expect(result).not.toBeNull();
      expect(result?.applied).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// The cron leaves a durable record (#1312 needed this; the gap predates it)
// ---------------------------------------------------------------------------

describe("the cron wrapper records what it did", () => {
  /**
   * Before phase 4 only the ADMIN ROUTE wrote an `import_issue_triage` audit row, and
   * a cron run has no acting user -- so the daily path's only trace of an automated
   * close was a Worker log line with finite retention. That made "how many issues
   * recovered this week" unanswerable from D1, which the weekly summary needs, and
   * was a gap in the durable record of a job that closes real issues.
   */
  test("an applied cron run that closed something writes a system audit row", async () => {
    const db = freshDb();
    seedImportJob(db, "on006136");
    const deps = recordingDeps([issue(105, "on006136")], { on006136: COMPLETE });

    await runImportIssueSweepCron({ ...envFor(db), ENVIRONMENT: "production" } as Bindings, deps);

    const rows = db
      .query<{ user_id: number | null; details: string | null }, []>(
        "SELECT user_id, details FROM audit_log WHERE action = 'import_issue_triage'",
      )
      .all();
    expect(rows).toHaveLength(1);
    // userId null marks it system-initiated, the convention import-retry.ts uses.
    expect(rows[0]?.user_id).toBeNull();
    expect(JSON.parse(rows[0]?.details ?? "{}")).toMatchObject({ source: "cron", closed: 1 });
  });

  test("a cron run that changed nothing writes no row", async () => {
    const db = freshDb();
    seedImportJob(db, "on005279");
    const deps = recordingDeps(
      [issue(97, "on005279", [IMPORT_FAILURE_ISSUE_LABEL, "auth-invalid"])],
      { on005279: INCOMPLETE },
    );

    await runImportIssueSweepCron({ ...envFor(db), ENVIRONMENT: "production" } as Bindings, deps);

    const rows = db
      .query<{ id: number }, []>("SELECT id FROM audit_log WHERE action = 'import_issue_triage'")
      .all();
    expect(rows).toEqual([]);
  });

  test("a failed audit write does not fail the sweep", async () => {
    // Bookkeeping about work that already happened must not turn a successful sweep
    // into an error.
    const db = freshDb();
    seedImportJob(db, "on006136");
    db.run("DROP TABLE audit_log");
    const deps = recordingDeps([issue(105, "on006136")], { on006136: COMPLETE });

    const r = await runImportIssueSweepCron(
      { ...envFor(db), ENVIRONMENT: "production" } as Bindings,
      deps,
    );

    expect(r?.closed).toBe(1);
    expect(deps.closed).toEqual([105]);
  });
});
