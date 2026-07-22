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
 *
 * The live GitHub API calls (createIssue/findOpenIssueByTitle/addIssueComment
 * in services/github/issues.ts) are I/O and stay untested here, same
 * constraint as every other github.ts consumer in this codebase.
 */

import { describe, expect, test } from "bun:test";
import {
  type FileImportFailureIssueArgs,
  type ImportFailureIssueContext,
  type ImportFailureIssueDetails,
  buildImportFailureIssueBody,
  buildImportFailureIssueComment,
  fileImportFailureIssueIfNeeded,
  importFailureIssueTitle,
  shouldFileImportFailureIssue,
} from "../src/services/import-failure-issue";
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

  test("prepare stage carries the git-divergence hint, clearly labeled", () => {
    const body = buildImportFailureIssueBody(details({ stage: "prepare" }));
    expect(body).toContain("Hint");
    expect(body).toContain("git-divergence");
  });

  test("copy stage carries the upstream-403/shard-gap hint", () => {
    const body = buildImportFailureIssueBody(details({ stage: "copy" }));
    expect(body).toContain("Hint");
    expect(body).toContain("upstream-403/shard-gap");
  });

  test("finalize (and unrecognized) stages get no hint line", () => {
    expect(buildImportFailureIssueBody(details({ stage: "finalize" }))).not.toContain("Hint");
    expect(buildImportFailureIssueBody(details({ stage: "something-unrecognized" }))).not.toContain(
      "Hint",
    );
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

  test("carries the same stage hint convention as the create body", () => {
    expect(buildImportFailureIssueComment(details({ stage: "prepare" }), nowIso)).toContain(
      "git-divergence",
    );
    expect(buildImportFailureIssueComment(details({ stage: "finalize" }), nowIso)).not.toContain(
      "Hint",
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
