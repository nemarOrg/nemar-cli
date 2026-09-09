/**
 * The import-failure issue triage sweep (epic #1306, issue #1310).
 *
 * Driven against real in-memory SQLite with every migration applied. Only the
 * TRANSPORT is injected -- the GitHub client calls and the S3 verify -- so the
 * decisions, the SQL and the comment bodies all run for real.
 *
 * The assertions that matter are the refusals. Closing an issue for a dataset
 * that is still broken discards a live problem silently, and there are four
 * distinct ways to reach that mistake: a transient error, an unresolvable
 * manifest, a hand-written issue, and a dataset with no import row at all.
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
import { type ImportIssueSweepDeps, runImportIssueSweep } from "../src/services/import-issue-sweep";
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

/** Records every write the sweep attempts, so a dry run can be proved silent. */
function recordingDeps(
  issues: GitHubIssue[],
  verdicts: Record<string, DatasetVersionIntegrityResult | Error>,
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
      closed.push(n);
    },
    setLabels: async (_repo, n, labels) => {
      labelled.push({ n, labels });
    },
    comment: async (_repo, n, body) => {
      comments.push({ n, body });
    },
  };
}

function envFor(db: Database): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as unknown as Bindings;
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

  test("the comment is written BEFORE the close, so the record survives", async () => {
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
    expect(order).toEqual(["comment", "close"]);
  });
});

// ---------------------------------------------------------------------------
// The four ways to wrongly close -- all must refuse
// ---------------------------------------------------------------------------

describe("never closes an issue whose dataset is not provably recovered", () => {
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

  test("the real backlog of 28 open issues reports rollup mode", async () => {
    const db = freshDb();
    const issues: GitHubIssue[] = [];
    const verdicts: Record<string, DatasetVersionIntegrityResult> = {};
    for (let i = 1; i <= 28; i++) {
      const id = `on${String(i).padStart(6, "0")}`;
      seedImportJob(db, id);
      issues.push(issue(i, id));
      verdicts[id] = INCOMPLETE;
    }
    const deps = recordingDeps(issues, verdicts);

    const result = await runImportIssueSweep(envFor(db), {}, deps);

    expect(result.openIssues).toBe(28);
    expect(result.mode).toBe("rollup");
    // Bounded per run, so a backlog drains over several passes.
    expect(result.examined).toBe(15);
    expect(result.remaining).toBe(13);
  });

  test("the per-run limit is clamped", async () => {
    const db = freshDb();
    seedImportJob(db, "on000001");
    const deps = recordingDeps([issue(1, "on000001")], { on000001: INCOMPLETE });

    const huge = await runImportIssueSweep(envFor(db), { limit: 5000 }, deps);
    expect(huge.examined).toBe(1);

    const zero = await runImportIssueSweep(envFor(db), { limit: 0 }, deps);
    expect(zero.examined).toBe(1);
  });
});
