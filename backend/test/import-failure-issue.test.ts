/**
 * Tests for the import-failure auto-filer (epic #967 follow-up,
 * automation half of nemarDatasets/.github#83):
 *   - shouldFileImportFailureIssue: the per-dataset-accuracy gate (genuine
 *     failure vs no-op-on-complete, prod-only, sandbox/exemplar/xx-band skip)
 *   - importFailureIssueTitle: format + dedup-title stability
 *   - buildImportFailureIssueBody / buildImportFailureIssueComment: content
 *   - fileImportFailureIssueIfNeeded: real-D1 (no network) short-circuit
 *     coverage -- asserts the gate stops the flow BEFORE any GitHub call by
 *     relying on getDatasetsToken throwing when no GitHub auth is configured
 *     (a genuine failure that reaches that point rejects; a gated-out case
 *     resolves cleanly without ever getting there).
 *   - accrual control (epic #1306 phase 2): which of create / comment+relabel /
 *     roll-up the orchestration chooses once past the gate, with the GitHub
 *     transport injected. That branch used to be unreachable in a test, because
 *     the only way to get past the gate was to let getDatasetsToken throw.
 *
 * The HTTP calls themselves (services/github/issues.ts) are I/O and stay
 * untested here, same constraint as every other github.ts consumer.
 */

import { describe, expect, test } from "bun:test";
import type { GitHubIssue } from "../src/services/github/issues";
import {
  type FileImportFailureIssueArgs,
  type ImportFailureIssueContext,
  type ImportFailureIssueDeps,
  type ImportFailureIssueDetails,
  buildImportFailureIssueBody,
  buildImportFailureIssueComment,
  fileImportFailureIssueIfNeeded,
  importFailureIssueTitle,
  shouldFileImportFailureIssue,
} from "../src/services/import-failure-issue";
import {
  IMPORT_ISSUE_CAP,
  IMPORT_ISSUE_RESUME,
  IMPORT_ROLLUP_ISSUE_LABEL,
  rollupIssueTitle,
} from "../src/services/import-issue-accrual";
import { IMPORT_FAILURE_ISSUE_LABEL } from "../src/services/import-issue-identity";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

// ---------------------------------------------------------------------------
// shouldFileImportFailureIssue
// ---------------------------------------------------------------------------

function genuineFailure(): ImportFailureIssueContext {
  return {
    datasetId: "on000123",
    resultingStatus: "failed",
    isSandbox: false,
    isExemplar: false,
    isProduction: true,
  };
}

describe("shouldFileImportFailureIssue", () => {
  test("genuine production failure on a real dataset -> file", () => {
    expect(shouldFileImportFailureIssue(genuineFailure())).toBe(true);
  });

  test("non-production -> never file, regardless of status", () => {
    expect(shouldFileImportFailureIssue({ ...genuineFailure(), isProduction: false })).toBe(false);
  });

  test("no-op-on-complete: resulting status isn't 'failed' -> skip", () => {
    for (const resultingStatus of [
      "complete",
      "rolled_back",
      "quarantined",
      "copying",
      "preparing",
    ]) {
      expect(shouldFileImportFailureIssue({ ...genuineFailure(), resultingStatus })).toBe(false);
    }
  });

  test("sandbox dataset row (is_sandbox=1) -> skip", () => {
    expect(shouldFileImportFailureIssue({ ...genuineFailure(), isSandbox: true })).toBe(false);
  });

  test("exemplar dataset row (is_exemplar=1) -> skip", () => {
    expect(shouldFileImportFailureIssue({ ...genuineFailure(), isExemplar: true })).toBe(false);
  });

  test("xx###### id band -> skip even without the is_sandbox flag set", () => {
    expect(shouldFileImportFailureIssue({ ...genuineFailure(), datasetId: "xx090001" })).toBe(
      false,
    );
  });

  test("every skip branch returns false, not just falsy", () => {
    const contexts: ImportFailureIssueContext[] = [
      { ...genuineFailure(), isProduction: false },
      { ...genuineFailure(), resultingStatus: "complete" },
      { ...genuineFailure(), isSandbox: true },
      { ...genuineFailure(), isExemplar: true },
      { ...genuineFailure(), datasetId: "xx000001" },
    ];
    for (const ctx of contexts) expect(shouldFileImportFailureIssue(ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// importFailureIssueTitle
// ---------------------------------------------------------------------------

describe("importFailureIssueTitle", () => {
  test("format: 'Import failure: on###### (ds######)'", () => {
    expect(importFailureIssueTitle("on000123", "ds000123")).toBe(
      "Import failure: on000123 (ds000123)",
    );
  });

  test("dedup-title stability: identical inputs always produce the identical title", () => {
    const a = importFailureIssueTitle("on000456", "ds000456");
    const b = importFailureIssueTitle("on000456", "ds000456");
    expect(a).toBe(b);
  });

  test("title depends only on datasetId + sourceId (stable dedup key across re-failures)", () => {
    // Two "failures" of the same dataset at different stages/times must
    // resolve to the same title so the dedup lookup finds the same issue.
    expect(importFailureIssueTitle("on000789", "ds000789")).toBe(
      importFailureIssueTitle("on000789", "ds000789"),
    );
  });
});

// ---------------------------------------------------------------------------
// buildImportFailureIssueBody
// ---------------------------------------------------------------------------

function details(overrides: Partial<ImportFailureIssueDetails> = {}): ImportFailureIssueDetails {
  return {
    datasetId: "on000123",
    sourceId: "ds000123",
    stage: "copy",
    errorMessage: "terminal: prepare=success copy=failure finalize=skipped",
    workflowRunUrl: "https://github.com/nemarDatasets/.github/actions/runs/1",
    ...overrides,
  };
}

describe("buildImportFailureIssueBody", () => {
  test("includes dataset id, source id, stage, error, and run url", () => {
    const body = buildImportFailureIssueBody(details());
    expect(body).toContain("on000123");
    expect(body).toContain("ds000123");
    expect(body).toContain("copy");
    expect(body).toContain("terminal: prepare=success copy=failure finalize=skipped");
    expect(body).toContain("https://github.com/nemarDatasets/.github/actions/runs/1");
  });

  test("links the epic and the triage doc", () => {
    const body = buildImportFailureIssueBody(details());
    expect(body).toContain("nemarOrg/nemar-cli#967");
    expect(body).toContain("docs/import-failure-procedure.md");
  });

  // These three replace the STAGE_HINTS assertions (#1309). The old map guessed
  // "possible git-divergence" from stage=prepare and "possible
  // upstream-403/shard-gap" from stage=copy. Every automated failure between
  // 2026-07-22 and 2026-09-08 was stage=prepare and none was git divergence, so
  // the hint was wrong for every case it described. The cause now comes from the
  // error message, and stage alone never implies one.
  test("names the cause from the error message", () => {
    const body = buildImportFailureIssueBody(
      details({
        stage: "prepare",
        errorMessage:
          "Failed to push: remote: Invalid username or token. Password authentication is not supported for Git operations.",
      }),
    );
    expect(body).toContain("Cause: auth_invalid");
    expect(body).toContain("NEMAR_GITHUB_PAT");
  });

  test("the generic roll-up yields an explicit unknown, not a guess", () => {
    // details() carries the generic `terminal: ...` string the report job posts.
    const body = buildImportFailureIssueBody(details({ stage: "prepare" }));
    expect(body).toContain("Cause: unknown");
    expect(body).not.toContain("git-divergence");
  });

  test("stage alone never implies a cause", () => {
    for (const stage of ["prepare", "copy", "finalize", "something-unrecognized"]) {
      expect(buildImportFailureIssueBody(details({ stage, errorMessage: null }))).toContain(
        "Cause: unknown",
      );
    }
  });

  test("null error_message / workflow_run_url render as explicit placeholders, not 'null'", () => {
    const body = buildImportFailureIssueBody(details({ errorMessage: null, workflowRunUrl: null }));
    expect(body).not.toContain("null");
    expect(body).toContain("(none reported)");
  });
});

// ---------------------------------------------------------------------------
// buildImportFailureIssueComment
// ---------------------------------------------------------------------------

describe("buildImportFailureIssueComment", () => {
  const nowIso = "2026-07-21T12:00:00.000Z";

  test("includes the re-failed stage, timestamp, error, and run url", () => {
    const comment = buildImportFailureIssueComment(details(), nowIso);
    expect(comment).toContain("Re-failed");
    expect(comment).toContain("copy");
    expect(comment).toContain(nowIso);
    expect(comment).toContain("terminal: prepare=success copy=failure finalize=skipped");
    expect(comment).toContain("https://github.com/nemarDatasets/.github/actions/runs/1");
  });

  test("is deterministic given the same details and timestamp", () => {
    expect(buildImportFailureIssueComment(details(), nowIso)).toBe(
      buildImportFailureIssueComment(details(), nowIso),
    );
  });

  test("names the cause the same way the create body does", () => {
    const errorMessage =
      "Failed to configure S3 remote: The bucket already exists, and its annex-uuid file indicates it is used by a different special remote.";
    const comment = buildImportFailureIssueComment(
      details({ stage: "prepare", errorMessage }),
      nowIso,
    );
    expect(comment).toContain("Cause: annex_uuid_conflict");
    // A re-failure whose cause is undiagnosable still says so explicitly.
    expect(buildImportFailureIssueComment(details({ stage: "finalize" }), nowIso)).toContain(
      "Cause: unknown",
    );
  });
});

// ---------------------------------------------------------------------------
// fileImportFailureIssueIfNeeded (real D1, no network)
//
// No GITHUB_ADMIN_PAT / App config is set on the test Bindings, so
// getDatasetsToken() throws "No GitHub auth configured" the instant the
// orchestration tries to reach GitHub. That throw is the observable proxy
// for "the gate let this through" -- a gated-out case must resolve cleanly
// without ever getting there; a genuine failure must reject via that throw.
// ---------------------------------------------------------------------------

function baseArgs(overrides: Partial<FileImportFailureIssueArgs> = {}): FileImportFailureIssueArgs {
  return {
    datasetId: "on000123",
    sourceId: "ds000123",
    stage: "copy",
    errorMessage: "boom",
    workflowRunUrl: null,
    resultingStatus: "failed",
    ...overrides,
  };
}

function prodEnv(db: D1Database): Bindings {
  return { ENVIRONMENT: "production", DB: db } as unknown as Bindings;
}

describe("fileImportFailureIssueIfNeeded (real D1, no network)", () => {
  test("genuine failure with no datasets row -> gate passes, attempts GitHub (rejects, no auth configured)", async () => {
    const db = freshDb();
    const d1 = realD1(db);
    await expect(fileImportFailureIssueIfNeeded(d1, prodEnv(d1), baseArgs())).rejects.toThrow(
      /No GitHub auth configured/,
    );
  });

  test("genuine failure with an explicit non-sandbox/non-exemplar row -> gate passes, attempts GitHub", async () => {
    const db = freshDb();
    db.exec(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, is_sandbox, is_exemplar)
       VALUES ('on000123', 'test dataset', 100, 0, 0)`,
    );
    const d1 = realD1(db);
    await expect(fileImportFailureIssueIfNeeded(d1, prodEnv(d1), baseArgs())).rejects.toThrow(
      /No GitHub auth configured/,
    );
  });

  test("sandbox dataset row -> short-circuits before any GitHub call", async () => {
    const db = freshDb();
    db.exec(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, is_sandbox)
       VALUES ('xx090001', 'sandbox dataset', 100, 1)`,
    );
    const d1 = realD1(db);
    await expect(
      fileImportFailureIssueIfNeeded(d1, prodEnv(d1), baseArgs({ datasetId: "xx090001" })),
    ).resolves.toBeUndefined();
  });

  test("exemplar dataset row -> short-circuits before any GitHub call", async () => {
    const db = freshDb();
    db.exec(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, is_exemplar)
       VALUES ('xx099901', 'exemplar dataset', 100, 1)`,
    );
    const d1 = realD1(db);
    await expect(
      fileImportFailureIssueIfNeeded(d1, prodEnv(d1), baseArgs({ datasetId: "xx099901" })),
    ).resolves.toBeUndefined();
  });

  test("xx###### id with no datasets row -> short-circuits on the id band alone", async () => {
    const db = freshDb();
    const d1 = realD1(db);
    await expect(
      fileImportFailureIssueIfNeeded(d1, prodEnv(d1), baseArgs({ datasetId: "xx000001" })),
    ).resolves.toBeUndefined();
  });

  test("no-op-on-complete: resultingStatus reflects the sticky upsert refusing to regress -> short-circuits", async () => {
    const db = freshDb();
    const d1 = realD1(db);
    await expect(
      fileImportFailureIssueIfNeeded(d1, prodEnv(d1), baseArgs({ resultingStatus: "complete" })),
    ).resolves.toBeUndefined();
  });

  test("non-production environment -> short-circuits even for an otherwise-genuine failure", async () => {
    const db = freshDb();
    const d1 = realD1(db);
    const env = { ENVIRONMENT: "development", DB: d1 } as unknown as Bindings;
    await expect(fileImportFailureIssueIfNeeded(d1, env, baseArgs())).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Accrual control (epic #1306 phase 2, issue #1310)
//
// Everything above proves the gate. These prove what happens once past it:
// which of create / comment+relabel / roll-up is chosen, and with what content.
// Only the GitHub transport and the token fetch are injected, so the gate, the
// D1 read, the classification, the mode decision and every body still run for
// real.
// ---------------------------------------------------------------------------

/** A real failing message from the incident window: the expired PAT. */
const AUTH_ERROR =
  "Failed to push: remote: Invalid username or token. Password authentication is not supported for Git operations.";
/** ...and the annex-uuid collision, a DIFFERENT cause on the same pipeline. */
const ANNEX_ERROR =
  "Failed to configure S3 remote: The bucket already exists, and its annex-uuid file indicates it is used by a different special remote.";

function openIssue(number: number, title: string, labels: string[]): GitHubIssue {
  return {
    number,
    html_url: `https://github.com/nemarDatasets/.github/issues/${number}`,
    state: "open",
    title,
    labels: labels.map((name) => ({ name })),
  };
}

/** `count` per-dataset tracking issues for unrelated datasets, to set the mode. */
function backlog(count: number): GitHubIssue[] {
  return Array.from({ length: count }, (_, i) =>
    openIssue(500 + i, importFailureIssueTitle(`on00900${i}`, `ds00900${i}`), [
      IMPORT_FAILURE_ISSUE_LABEL,
      "auth-invalid",
    ]),
  );
}

/** Records every write attempted, so the choice of branch is observable. */
function recordingDeps(open: GitHubIssue[]): ImportFailureIssueDeps & {
  created: { title: string; body: string; labels: string[] }[];
  comments: { n: number; body: string }[];
  labelled: { n: number; labels: string[] }[];
} {
  const created: { title: string; body: string; labels: string[] }[] = [];
  const comments: { n: number; body: string }[] = [];
  const labelled: { n: number; labels: string[] }[] = [];
  return {
    created,
    comments,
    labelled,
    token: async () => "test-token",
    listOpenIssues: async () => open,
    create: async (_repo, title, body, labels) => {
      created.push({ title, body, labels });
      return openIssue(1000 + created.length, title, labels);
    },
    comment: async (_repo, n, body) => {
      comments.push({ n, body });
    },
    setLabels: async (_repo, n, labels) => {
      labelled.push({ n, labels });
    },
  };
}

const TITLE = importFailureIssueTitle("on000123", "ds000123");

describe("a re-failure comments, and relabels when the cause changed", () => {
  test("the stale cause label is retired for the real one", async () => {
    const db = freshDb();
    const d1 = realD1(db);
    // Filed as upstream-403 back when that was the theory; it was the PAT.
    const deps = recordingDeps([
      openIssue(75, TITLE, [IMPORT_FAILURE_ISSUE_LABEL, "upstream-403"]),
    ]);

    await fileImportFailureIssueIfNeeded(
      d1,
      prodEnv(d1),
      baseArgs({ stage: "prepare", errorMessage: AUTH_ERROR }),
      deps,
    );

    expect(deps.created).toEqual([]);
    expect(deps.comments[0]?.n).toBe(75);
    expect(deps.labelled).toHaveLength(1);
    expect(deps.labelled[0]?.labels).toContain("auth-invalid");
    expect(deps.labelled[0]?.labels).not.toContain("upstream-403");
    // The tracking label is what every lookup keys off; losing it would orphan
    // the issue from the whole mechanism.
    expect(deps.labelled[0]?.labels).toContain(IMPORT_FAILURE_ISSUE_LABEL);
  });

  test("a human triage label survives the relabel", async () => {
    const db = freshDb();
    const d1 = realD1(db);
    const deps = recordingDeps([
      openIssue(75, TITLE, [IMPORT_FAILURE_ISSUE_LABEL, "git-divergence", "no-import-row"]),
    ]);

    await fileImportFailureIssueIfNeeded(
      d1,
      prodEnv(d1),
      baseArgs({ stage: "prepare", errorMessage: AUTH_ERROR }),
      deps,
    );

    expect(deps.labelled[0]?.labels).toContain("no-import-row");
  });

  test("an unchanged cause comments without a pointless label write", async () => {
    const db = freshDb();
    const d1 = realD1(db);
    const deps = recordingDeps([
      openIssue(75, TITLE, [IMPORT_FAILURE_ISSUE_LABEL, "auth-invalid"]),
    ]);

    await fileImportFailureIssueIfNeeded(
      d1,
      prodEnv(d1),
      baseArgs({ stage: "prepare", errorMessage: AUTH_ERROR }),
      deps,
    );

    expect(deps.comments).toHaveLength(1);
    expect(deps.labelled).toEqual([]);
  });
});

describe("a burst rolls up instead of opening dozens of issues", () => {
  test("below the cap, a per-dataset issue is what gets opened", async () => {
    const db = freshDb();
    const d1 = realD1(db);
    const deps = recordingDeps(backlog(IMPORT_ISSUE_CAP - 1));

    await fileImportFailureIssueIfNeeded(
      d1,
      prodEnv(d1),
      baseArgs({ stage: "prepare", errorMessage: AUTH_ERROR }),
      deps,
    );

    expect(deps.created).toHaveLength(1);
    expect(deps.created[0]?.title).toBe(TITLE);
    expect(deps.created[0]?.labels).toEqual([IMPORT_FAILURE_ISSUE_LABEL, "auth-invalid"]);
  });

  test("at the cap, the first of a cause opens that cause's rollup", async () => {
    const db = freshDb();
    const d1 = realD1(db);
    const deps = recordingDeps(backlog(IMPORT_ISSUE_CAP));

    await fileImportFailureIssueIfNeeded(
      d1,
      prodEnv(d1),
      baseArgs({ stage: "prepare", errorMessage: AUTH_ERROR }),
      deps,
    );

    expect(deps.created).toHaveLength(1);
    expect(deps.created[0]?.title).toBe(rollupIssueTitle("auth_invalid"));
    expect(deps.created[0]?.labels).toContain(IMPORT_ROLLUP_ISSUE_LABEL);
    // The affected dataset has to be findable from the rollup, or the rollup
    // trades noise for lost information.
    expect(deps.created[0]?.body).toContain("on000123");
  });

  test("a second dataset joins the existing rollup rather than opening another", async () => {
    const db = freshDb();
    const d1 = realD1(db);
    const deps = recordingDeps([
      ...backlog(IMPORT_ISSUE_CAP),
      openIssue(900, rollupIssueTitle("auth_invalid"), [
        IMPORT_FAILURE_ISSUE_LABEL,
        IMPORT_ROLLUP_ISSUE_LABEL,
        "auth-invalid",
      ]),
    ]);

    await fileImportFailureIssueIfNeeded(
      d1,
      prodEnv(d1),
      baseArgs({ stage: "prepare", errorMessage: AUTH_ERROR }),
      deps,
    );

    expect(deps.created).toEqual([]);
    expect(deps.comments).toHaveLength(1);
    expect(deps.comments[0]?.n).toBe(900);
    expect(deps.comments[0]?.body).toContain("on000123");
  });

  test("another cause's open rollup does not absorb this one", async () => {
    const db = freshDb();
    const d1 = realD1(db);
    const deps = recordingDeps([
      ...backlog(IMPORT_ISSUE_CAP),
      openIssue(900, rollupIssueTitle("auth_invalid"), [
        IMPORT_FAILURE_ISSUE_LABEL,
        IMPORT_ROLLUP_ISSUE_LABEL,
        "auth-invalid",
      ]),
    ]);

    await fileImportFailureIssueIfNeeded(
      d1,
      prodEnv(d1),
      baseArgs({ stage: "prepare", errorMessage: ANNEX_ERROR }),
      deps,
    );

    // One rollup per cause: rolling annex_uuid_conflict into the auth rollup
    // would put two unrelated problems under one title.
    expect(deps.comments).toEqual([]);
    expect(deps.created[0]?.title).toBe(rollupIssueTitle("annex_uuid_conflict"));
  });

  test("rollups do not count themselves toward the cap", async () => {
    const db = freshDb();
    const d1 = realD1(db);
    // Nine per-dataset issues plus two rollups is eleven open issues, but only
    // nine of them are what the cap is about. A rollup that counted itself
    // would latch rollup mode on and never release it.
    const deps = recordingDeps([
      ...backlog(IMPORT_ISSUE_CAP - 1),
      openIssue(900, rollupIssueTitle("timeout"), [
        IMPORT_FAILURE_ISSUE_LABEL,
        IMPORT_ROLLUP_ISSUE_LABEL,
        "timeout",
      ]),
      openIssue(901, rollupIssueTitle("rate_limit"), [
        IMPORT_FAILURE_ISSUE_LABEL,
        IMPORT_ROLLUP_ISSUE_LABEL,
        "rate-limit",
      ]),
    ]);

    await fileImportFailureIssueIfNeeded(
      d1,
      prodEnv(d1),
      baseArgs({ stage: "prepare", errorMessage: AUTH_ERROR }),
      deps,
    );

    expect(deps.created[0]?.title).toBe(TITLE);
  });

  test("per-dataset filing resumes once the backlog drains to the resume mark", async () => {
    const db = freshDb();
    const d1 = realD1(db);
    // The rollup is still open -- nobody closed it -- but the tracker has
    // drained, so the pressure valve releases on its own.
    const deps = recordingDeps([
      ...backlog(IMPORT_ISSUE_RESUME),
      openIssue(900, rollupIssueTitle("auth_invalid"), [
        IMPORT_FAILURE_ISSUE_LABEL,
        IMPORT_ROLLUP_ISSUE_LABEL,
        "auth-invalid",
      ]),
    ]);

    await fileImportFailureIssueIfNeeded(
      d1,
      prodEnv(d1),
      baseArgs({ stage: "prepare", errorMessage: AUTH_ERROR }),
      deps,
    );

    expect(deps.created[0]?.title).toBe(TITLE);
    expect(deps.comments).toEqual([]);
  });
});
