/**
 * A mirror lag stays retryable through recovery, sends no mail, and gets one admin issue only when
 * the retry engine parks it (epic #1046 Phase 3, ADR 0111 decision 10; lead ruling 2026-10-23).
 *
 * Driven through the real `runImportRecovery` on the production schema, the real candidate query
 * and the real issue-filing orchestration; only the GitHub transport is injected, and Resend is the
 * shared local capture (helpers/resend.ts), so nothing leaves the machine.
 *
 * Why the recovery half matters: prepare refuses a lagging tag BEFORE Step 2 creates the dataset,
 * so the row has no `datasets` row behind it. The leftover-state rule answers `not_found_dataset`
 * for that, which neither engine retries, and a transient refusal would have been parked on its
 * first occurrence.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  OPENNEURO_MIRROR_LAG_MARKER,
  OPENNEURO_UPSTREAM_MOVED_MARKER,
} from "../../shared/import-markers";
import type { GitHubIssue } from "../src/services/github";
import {
  type ImportFailureIssueDeps,
  fileImportFailureIssueIfNeeded,
  importFailureIssueTitle,
} from "../src/services/import-failure-issue";
import { IMPORT_FAILURE_ISSUE_LABEL } from "../src/services/import-issue-identity";
import { classifyRecovery, runImportRecovery } from "../src/services/import-recovery";
import {
  type CandidateRow,
  IMPORT_RETRY_CANDIDATES_QUERY,
  RETRY_WINDOW_MS,
  applyRetryPlan,
  planRetryTick,
  retryCandidateInput,
  runRetryTick,
} from "../src/services/import-retry";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { withFakeResend } from "./helpers/resend";

/** The CLI's refusal line as the prepare reporter posts it (the wording test/import-tag-pin.test.ts raises). */
const MIRROR_LAG = `${OPENNEURO_MIRROR_LAG_MARKER} ds004362: upstream tag 1.0.2 is not on github.com/OpenNeuroDatasets/ds004362 yet. Nothing was created; the retry engine retries it.`;

function seedFailedRow(db: Database, datasetId: string, lastError: string): void {
  db.query(
    `INSERT INTO import_jobs (dataset_id, source, source_id, stage, status, last_error)
     VALUES (?, 'openneuro', ?, 'prepare', 'failed', ?)`,
  ).run(datasetId, `ds${datasetId.slice(2)}`, lastError);
}

function seedAdmin(db: Database): void {
  db.query(
    `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
     VALUES (2, 'admin', 'admin@example.org', 'x', 'approved', 'admin', 1)`,
  ).run();
}

function candidateIds(db: Database): string[] {
  return (
    db.query(IMPORT_RETRY_CANDIDATES_QUERY).all("2099-01-01 00:00:00", 100) as {
      dataset_id: string;
    }[]
  ).map((r) => r.dataset_id);
}

function lastAuditDecision(db: Database, datasetId: string): unknown {
  const row = db
    .query(
      "SELECT details FROM audit_log WHERE resource_id = ? AND action = 'import_quarantined' ORDER BY id DESC LIMIT 1",
    )
    .get(datasetId) as { details: string } | null;
  return row ? (JSON.parse(row.details) as { decision: unknown }).decision : null;
}

/** Production, with mail configured, so a send that is not suppressed really reaches the capture. */
function prodEnv(db: Database): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
  } as unknown as Bindings;
}

describe("recovery keeps a mirror lag retryable", () => {
  test("a lag with no dataset row is quarantined as mirror_lag and stays a retry candidate", async () => {
    const db = freshDb();
    seedFailedRow(db, "on004362", MIRROR_LAG);

    const status = await runImportRecovery(
      realD1(db),
      { ENVIRONMENT: "test" } as unknown as Bindings,
      "on004362",
    );

    expect(status).toBe("quarantined");
    expect(lastAuditDecision(db, "on004362")).toEqual({
      action: "quarantine",
      reason: "mirror_lag",
    });
    const row = db
      .query("SELECT status, last_error FROM import_jobs WHERE dataset_id = ?")
      .get("on004362") as { status: string; last_error: string };
    expect(row.status).toBe("quarantined");
    // ADR 0051: recovery's bookkeeping never replaces the CLI's specific line.
    expect(row.last_error).toBe(MIRROR_LAG);
    expect(candidateIds(db)).toContain("on004362");
  });

  test("without the override the same row would be not_found_dataset, which nothing retries", () => {
    // The control for the test above: the leftover state alone parks it.
    const absent = {
      exists: false,
      visibility: "",
      conceptDoi: null,
      latestVersionDoi: null,
      versionCount: 0,
      ownerUserId: null,
      importReachedComplete: false,
    };
    expect(classifyRecovery("some other prepare failure", absent)).toEqual({
      action: "quarantine",
      reason: "not_found_dataset",
    });
    expect(classifyRecovery(MIRROR_LAG, absent)).toEqual({
      action: "quarantine",
      reason: "mirror_lag",
    });
  });

  test("an upstream move is not kept retryable: it is a re-pull's job", async () => {
    const db = freshDb();
    seedFailedRow(
      db,
      "on004363",
      `${OPENNEURO_UPSTREAM_MOVED_MARKER} ds004363: on004363 has released a version and its main records upstream tag 1.0.0; this import is at 1.0.1.`,
    );
    await runImportRecovery(realD1(db), { ENVIRONMENT: "test" } as unknown as Bindings, "on004363");
    expect(candidateIds(db)).not.toContain("on004363");
  });
});

describe("a mirror lag mails no one", () => {
  test("its quarantine sends nothing, while another reason's quarantine does mail", async () => {
    const db = freshDb();
    seedAdmin(db);
    seedFailedRow(db, "on004362", MIRROR_LAG);
    // The control: same path, a reason that is not exempt.
    seedFailedRow(db, "on004364", "Failed to clone: fatal: repository not found");

    await withFakeResend(async (calls) => {
      await runImportRecovery(realD1(db), prodEnv(db), "on004362");
      expect(calls.filter((c) => c.path === "/emails")).toHaveLength(0);

      await runImportRecovery(realD1(db), prodEnv(db), "on004364");
      expect(calls.filter((c) => c.path === "/emails")).toHaveLength(1);
    });
  });
});

/** Records every GitHub write attempted. Transport only: the gate, the D1 reads and the bodies run for real. */
function recordingDeps(open: GitHubIssue[]): ImportFailureIssueDeps & {
  created: { title: string; body: string; labels: string[] }[];
  comments: { n: number; body: string }[];
} {
  const created: { title: string; body: string; labels: string[] }[] = [];
  const comments: { n: number; body: string }[] = [];
  return {
    created,
    comments,
    token: async () => "test-token",
    listOpenIssues: async () => open,
    create: async (_repo, title, body, labels) => {
      created.push({ title, body, labels });
      return {
        number: 900 + created.length,
        html_url: "https://github.com/nemarDatasets/.github/issues/900",
        state: "open",
        title,
        labels: labels.map((name) => ({ name })),
      };
    },
    comment: async (_repo, n, body) => {
      comments.push({ n, body });
    },
    setLabels: async () => {},
  };
}

describe("a mirror lag gets one admin issue, when it is parked", () => {
  function quarantinedLag(db: Database): void {
    db.query(
      `INSERT INTO import_jobs (dataset_id, source, source_id, stage, status, last_error,
                                workflow_run_url, blocklisted, blocklist_reason)
       VALUES ('on004362', 'openneuro', 'ds004362', 'prepare', 'quarantined', ?,
               'https://github.com/nemarDatasets/.github/actions/runs/1', 1, 'mirror_lag')`,
    ).run(MIRROR_LAG);
  }

  test("the failure callback files nothing for it", async () => {
    const db = freshDb();
    seedFailedRow(db, "on004362", MIRROR_LAG);
    const deps = recordingDeps([]);
    await fileImportFailureIssueIfNeeded(
      realD1(db),
      prodEnv(db),
      {
        datasetId: "on004362",
        sourceId: "ds004362",
        stage: "prepare",
        errorMessage: MIRROR_LAG,
        workflowRunUrl: null,
        resultingStatus: "failed",
      },
      deps,
    );
    expect(deps.created).toEqual([]);
    expect(deps.comments).toEqual([]);
  });

  test("the park files one issue, labelled mirror-lag, quoting the stored refusal", async () => {
    const db = freshDb();
    quarantinedLag(db);
    const deps = recordingDeps([]);
    await fileImportFailureIssueIfNeeded(
      realD1(db),
      prodEnv(db),
      {
        datasetId: "on004362",
        sourceId: "ds004362",
        stage: "prepare",
        errorMessage: null,
        workflowRunUrl: null,
        resultingStatus: "blocklisted",
        parked: true,
      },
      deps,
    );
    expect(deps.created).toHaveLength(1);
    expect(deps.created[0]?.title).toBe(importFailureIssueTitle("on004362", "ds004362"));
    expect(deps.created[0]?.labels).toEqual([IMPORT_FAILURE_ISSUE_LABEL, "mirror-lag"]);
    expect(deps.created[0]?.body).toContain(MIRROR_LAG);
    expect(deps.created[0]?.body).toContain("actions/runs/1");
  });

  test("a park of any other cause files nothing: its issue was filed when it failed", async () => {
    const db = freshDb();
    db.query(
      `INSERT INTO import_jobs (dataset_id, source, source_id, stage, status, last_error)
       VALUES ('on004365', 'openneuro', 'ds004365', 'prepare', 'quarantined', ?)`,
    ).run("[openneuro-upstream-inaccessible] OpenNeuro objects not anonymously readable");
    const deps = recordingDeps([]);
    await fileImportFailureIssueIfNeeded(
      realD1(db),
      prodEnv(db),
      {
        datasetId: "on004365",
        sourceId: "ds004365",
        stage: "prepare",
        errorMessage: null,
        workflowRunUrl: null,
        resultingStatus: "blocklisted",
        parked: true,
      },
      deps,
    );
    expect(deps.created).toEqual([]);
  });

  test("outside production the park files nothing", async () => {
    const db = freshDb();
    quarantinedLag(db);
    const deps = recordingDeps([]);
    await fileImportFailureIssueIfNeeded(
      realD1(db),
      { DB: realD1(db), ENVIRONMENT: "development" } as unknown as Bindings,
      {
        datasetId: "on004362",
        sourceId: "ds004362",
        stage: "prepare",
        errorMessage: null,
        workflowRunUrl: null,
        resultingStatus: "blocklisted",
        parked: true,
      },
      deps,
    );
    expect(deps.created).toEqual([]);
  });
});

describe("the retry engine parks a lag past its window and files its one issue", () => {
  test("applyRetryPlan blocklists it as mirror_lag and files the issue; a lag inside the window is dispatched", async () => {
    const db = freshDb();
    const now = Date.parse("2026-11-10T00:00:00Z");
    // Two lags, quarantined by recovery, one past the window and one inside it.
    for (const id of ["on004362", "on004366"]) {
      db.query(
        `INSERT INTO import_jobs (dataset_id, source, source_id, stage, status, last_error)
         VALUES (?, 'openneuro', ?, 'prepare', 'quarantined', ?)`,
      ).run(id, `ds${id.slice(2)}`, MIRROR_LAG);
    }
    const plan = planRetryTick(
      [
        {
          datasetId: "on004362",
          sourceId: "ds004362",
          verified: { complete: false },
          firstIncompleteAtMs: now - RETRY_WINDOW_MS,
          lastError: MIRROR_LAG,
          recoveryAttempts: 9,
        },
        {
          datasetId: "on004366",
          sourceId: "ds004366",
          verified: { complete: false },
          firstIncompleteAtMs: now - 60_000,
          lastError: MIRROR_LAG,
          recoveryAttempts: 0,
        },
      ],
      { now, maxDispatches: 3 },
    );
    const dispatched: string[] = [];
    const issueDeps = recordingDeps([]);
    const result = await applyRetryPlan(prodEnv(db), plan, now, {
      token: async () => "test-token",
      dispatch: async (sourceId) => {
        dispatched.push(sourceId);
      },
      issueDeps,
    });

    expect(result).toMatchObject({ blocklisted: 1, dispatched: 1, recovered: 0 });
    const parked = db
      .query("SELECT blocklisted, blocklist_reason FROM import_jobs WHERE dataset_id = ?")
      .get("on004362") as { blocklisted: number; blocklist_reason: string };
    expect(parked).toEqual({ blocklisted: 1, blocklist_reason: "mirror_lag" });
    expect(issueDeps.created).toHaveLength(1);
    expect(issueDeps.created[0]?.labels).toContain("mirror-lag");
    expect(issueDeps.created[0]?.title).toBe(importFailureIssueTitle("on004362", "ds004362"));
    expect(dispatched).toEqual(["ds004366"]);
    // The parked row is no longer a candidate; the one inside its window still is.
    expect(candidateIds(db)).toEqual(["on004366"]);
  });
});

describe("a retry is dispatched with no tag", () => {
  test("so the import resolves OpenNeuro's latest when it runs, never a tag that has since moved", async () => {
    const dispatched: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (req.method === "POST" && new URL(req.url).pathname.endsWith("/dispatches")) {
          dispatched.push((await req.json()) as Record<string, unknown>);
          return new Response(null, { status: 204 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
      `http://127.0.0.1:${server.port}`;
    try {
      const db = freshDb();
      seedFailedRow(db, "on004366", MIRROR_LAG);
      const now = Date.parse("2026-11-10T00:00:00Z");
      const env = { ...prodEnv(db), GITHUB_ADMIN_PAT: "test-pat" } as unknown as Bindings;
      // The real dispatch: no transport injected.
      const result = await applyRetryPlan(
        env,
        [
          {
            datasetId: "on004366",
            sourceId: "ds004366",
            decision: { action: "dispatch", nextRecoveryAttempt: 1, nextRetryAt: now + 1 },
          },
        ],
        now,
      );
      expect(result.dispatched).toBe(1);
      expect(dispatched).toEqual([
        { event_type: "onboard-openneuro", client_payload: { openneuro_ids: "ds004366" } },
      ]);
    } finally {
      (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
      server.stop(true);
    }
  });
});

describe("the 14-day window, read from the row as D1 stores it", () => {
  test("first_incomplete_at as a SQLite datetime string: just past 14 days parks, just inside dispatches", async () => {
    // The path the sweep takes after its S3 reads: the candidate query's rows, read through
    // parseSqliteUtc, planned and acted on. A window misread as local time, or not read at all
    // (`?? now`), would dispatch the 15-day row instead of parking it.
    const db = freshDb();
    const now = Date.parse("2026-11-20T12:00:00Z");
    const sqlite = (ms: number) =>
      new Date(ms)
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d+Z$/, "");
    const day = 24 * 60 * 60 * 1000;
    // Hours either side of the boundary, so a datetime read as local time instead of UTC moves
    // one across it wherever the process runs off UTC (the stored form has no zone).
    const hour = 60 * 60 * 1000;
    for (const [id, age] of [
      ["on004362", 14 * day + 3 * hour],
      ["on004366", 14 * day - 3 * hour],
    ] as const) {
      db.query(
        `INSERT INTO import_jobs (dataset_id, source, source_id, stage, status, last_error,
                                  first_incomplete_at)
         VALUES (?, 'openneuro', ?, 'prepare', 'quarantined', ?, ?)`,
      ).run(id, `ds${id.slice(2)}`, MIRROR_LAG, sqlite(now - age));
    }
    const rows = db.query(IMPORT_RETRY_CANDIDATES_QUERY).all(sqlite(now), 100) as CandidateRow[];
    expect(rows.map((r) => r.dataset_id).sort()).toEqual(["on004362", "on004366"]);
    const dispatched: string[] = [];
    const result = await runRetryTick(
      prodEnv(db),
      rows.map((row) => retryCandidateInput(row, { complete: false }, now)),
      now,
      {
        token: async () => "test-token",
        dispatch: async (sourceId) => {
          dispatched.push(sourceId);
        },
        issueDeps: recordingDeps([]),
      },
    );
    expect(result).toMatchObject({ blocklisted: 1, dispatched: 1 });
    const parked = db
      .query("SELECT blocklist_reason FROM import_jobs WHERE dataset_id = 'on004362'")
      .get() as { blocklist_reason: string };
    expect(parked.blocklist_reason).toBe("mirror_lag");
    expect(dispatched).toEqual(["ds004366"]);
  });

  test("a row the engine has not retried yet starts its window now", () => {
    const now = Date.parse("2026-11-20T12:00:00Z");
    const input = retryCandidateInput(
      {
        dataset_id: "on004362",
        source_id: "ds004362",
        recovery_attempts: 0,
        first_incomplete_at: null,
        last_error: MIRROR_LAG,
      },
      { complete: false },
      now,
    );
    expect(input.firstIncompleteAtMs).toBe(now);
  });
});
