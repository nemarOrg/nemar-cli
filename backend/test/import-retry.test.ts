/**
 * Tests for the consistent retry engine + blocklist (epic #967 Phase 2, #969):
 *   - migration 0058 columns/defaults
 *   - the exact candidate queries, run against real in-memory SQLite (no
 *     mocks) with every migration applied, mirroring archive-retry.test.ts
 *   - the pure decision functions: decideRetryAction (window boundary,
 *     backoff, no-source, recover-on-complete), retryBackoffMs,
 *     planRetryTick (per-tick dispatch cap), decideMaintainerNotification
 *   - the prod-only guard on sweepImportRetries / reclassifyCompleteRows
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { OPENNEURO_UPSTREAM_MARKER } from "../src/services/import-recovery";
import {
  BLOCKLIST_RECHECK_QUERY,
  IMPORT_RETRY_CANDIDATES_QUERY,
  MAX_RECOVERY_DISPATCHES_PER_TICK,
  RECLASSIFY_CANDIDATES_QUERY,
  RETRY_WINDOW_MS,
  type RetryCandidateInput,
  decideMaintainerNotification,
  decideRetryAction,
  planRetryTick,
  reclassifyCompleteRows,
  recoverRow,
  retryBackoffMs,
  sendMaintainerReportIfDue,
  stampMaintainerNotified,
  sweepImportRetries,
} from "../src/services/import-retry";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

// ---------------------------------------------------------------------------
// decideRetryAction
// ---------------------------------------------------------------------------

describe("decideRetryAction", () => {
  const base = {
    now: Date.parse("2026-07-20T00:00:00Z"),
    verified: { complete: false },
    firstIncompleteAtMs: Date.parse("2026-07-19T00:00:00Z"),
    lastError: null as string | null,
    recoveryAttempts: 0,
    hasSourceId: true,
  };

  test("verified complete always recovers, regardless of window/source", () => {
    expect(decideRetryAction({ ...base, verified: { complete: true } })).toEqual({
      action: "recover",
    });
    expect(
      decideRetryAction({ ...base, verified: { complete: true }, hasSourceId: false }),
    ).toEqual({ action: "recover" });
  });

  test("no source_id blocklists immediately, independent of the window", () => {
    expect(decideRetryAction({ ...base, hasSourceId: false })).toEqual({
      action: "blocklist",
      reason: "no_source",
    });
  });

  test("inside the window always dispatches, even with an upstream-inaccessible error", () => {
    const decision = decideRetryAction({
      ...base,
      lastError: `some prepare failure ${OPENNEURO_UPSTREAM_MARKER}`,
      firstIncompleteAtMs: base.now - (RETRY_WINDOW_MS - 1),
    });
    expect(decision.action).toBe("dispatch");
  });

  test("past the window but NOT upstream-inaccessible still dispatches (not parked forever)", () => {
    const decision = decideRetryAction({
      ...base,
      lastError: "some generic copy failure",
      firstIncompleteAtMs: base.now - (RETRY_WINDOW_MS + 1),
    });
    expect(decision.action).toBe("dispatch");
  });

  test("window boundary: 1h under 14 days still dispatches, 1h over blocklists (upstream-inaccessible)", () => {
    const hour = 60 * 60 * 1000;
    const justUnder = decideRetryAction({
      ...base,
      lastError: OPENNEURO_UPSTREAM_MARKER,
      firstIncompleteAtMs: base.now - (RETRY_WINDOW_MS - hour),
    });
    const justOver = decideRetryAction({
      ...base,
      lastError: OPENNEURO_UPSTREAM_MARKER,
      firstIncompleteAtMs: base.now - (RETRY_WINDOW_MS + hour),
    });
    expect(justUnder.action).toBe("dispatch");
    expect(justOver).toEqual({ action: "blocklist", reason: "upstream_403_after_window" });
  });

  test("exactly at the window boundary (>=) blocklists", () => {
    const atBoundary = decideRetryAction({
      ...base,
      lastError: OPENNEURO_UPSTREAM_MARKER,
      firstIncompleteAtMs: base.now - RETRY_WINDOW_MS,
    });
    expect(atBoundary).toEqual({ action: "blocklist", reason: "upstream_403_after_window" });
  });

  test("dispatch bumps recoveryAttempts and computes next_retry_at via retryBackoffMs", () => {
    const decision = decideRetryAction({ ...base, recoveryAttempts: 2 });
    expect(decision).toEqual({
      action: "dispatch",
      nextRecoveryAttempt: 3,
      nextRetryAt: base.now + retryBackoffMs(3),
    });
  });
});

describe("retryBackoffMs", () => {
  test("doubles per attempt starting from the base", () => {
    expect(retryBackoffMs(1)).toBe(6 * 60 * 60 * 1000);
    expect(retryBackoffMs(2)).toBe(12 * 60 * 60 * 1000);
    expect(retryBackoffMs(3)).toBe(24 * 60 * 60 * 1000);
  });

  test("caps at 48h and never exceeds it for large attempt counts", () => {
    expect(retryBackoffMs(4)).toBe(48 * 60 * 60 * 1000);
    expect(retryBackoffMs(10)).toBe(48 * 60 * 60 * 1000);
    expect(retryBackoffMs(100)).toBe(48 * 60 * 60 * 1000);
  });

  test("attempt 0 or negative does not underflow below the base", () => {
    expect(retryBackoffMs(0)).toBe(6 * 60 * 60 * 1000);
    expect(retryBackoffMs(-5)).toBe(6 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// planRetryTick
// ---------------------------------------------------------------------------

describe("planRetryTick", () => {
  const now = Date.parse("2026-07-20T00:00:00Z");

  function dispatchCandidate(id: string): RetryCandidateInput {
    return {
      datasetId: id,
      sourceId: `ds${id}`,
      verified: { complete: false },
      firstIncompleteAtMs: now - 60_000,
      lastError: null,
      recoveryAttempts: 0,
    };
  }

  test("respects the per-tick dispatch cap; excess dispatch candidates are omitted", () => {
    const candidates = [
      dispatchCandidate("on000001"),
      dispatchCandidate("on000002"),
      dispatchCandidate("on000003"),
      dispatchCandidate("on000004"),
      dispatchCandidate("on000005"),
    ];
    const plan = planRetryTick(candidates, {
      now,
      maxDispatches: MAX_RECOVERY_DISPATCHES_PER_TICK,
    });
    const dispatches = plan.filter((p) => p.decision.action === "dispatch");
    expect(dispatches.length).toBe(MAX_RECOVERY_DISPATCHES_PER_TICK);
    expect(plan.length).toBe(MAX_RECOVERY_DISPATCHES_PER_TICK); // over-cap candidates simply absent
    expect(dispatches.map((d) => d.datasetId)).toEqual(["on000001", "on000002", "on000003"]);
  });

  test("recover and blocklist decisions never count against the dispatch cap", () => {
    const candidates: RetryCandidateInput[] = [
      { ...dispatchCandidate("on000001"), verified: { complete: true } }, // recover
      { ...dispatchCandidate("on000002"), sourceId: null }, // blocklist (no_source)
      dispatchCandidate("on000003"),
      dispatchCandidate("on000004"),
      dispatchCandidate("on000005"),
      dispatchCandidate("on000006"), // would be the 4th dispatch -> deferred
    ];
    const plan = planRetryTick(candidates, { now, maxDispatches: 3 });
    expect(plan.length).toBe(5); // recover + blocklist + 3 dispatches; on000006 deferred
    expect(plan.find((p) => p.datasetId === "on000001")?.decision.action).toBe("recover");
    expect(plan.find((p) => p.datasetId === "on000002")?.decision.action).toBe("blocklist");
    expect(plan.find((p) => p.datasetId === "on000006")).toBeUndefined();
  });

  test("empty input produces an empty plan", () => {
    expect(planRetryTick([], { now, maxDispatches: 3 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// decideMaintainerNotification
// ---------------------------------------------------------------------------

describe("decideMaintainerNotification", () => {
  test("already-notified always skips, regardless of flag/recipient", () => {
    expect(
      decideMaintainerNotification({ enabled: true, hasRecipient: true, alreadyNotified: true }),
    ).toBe("skip_already_notified");
  });

  test("flag on + recipient configured -> send", () => {
    expect(
      decideMaintainerNotification({ enabled: true, hasRecipient: true, alreadyNotified: false }),
    ).toBe("send");
  });

  test("flag off -> dry_run even with a recipient configured", () => {
    expect(
      decideMaintainerNotification({ enabled: false, hasRecipient: true, alreadyNotified: false }),
    ).toBe("dry_run");
  });

  test("flag on but no recipient configured -> dry_run, never sends into the void", () => {
    expect(
      decideMaintainerNotification({ enabled: true, hasRecipient: false, alreadyNotified: false }),
    ).toBe("dry_run");
  });
});

// ---------------------------------------------------------------------------
// Migration 0058
// ---------------------------------------------------------------------------

function insertJob(
  db: Database,
  j: {
    dataset_id: string;
    source_id?: string | null;
    status?: string;
    blocklisted?: number;
    blocklist_reason?: string | null;
    first_incomplete_at?: string | null;
    next_retry_at?: string | null;
    last_error?: string | null;
    maintainer_notified_at?: string | null;
    updated_at?: string;
    integrity_checked_at?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO import_jobs
       (dataset_id, source, source_id, status, blocklisted, blocklist_reason,
        first_incomplete_at, next_retry_at, last_error, maintainer_notified_at,
        integrity_checked_at, updated_at)
     VALUES (?, 'openneuro', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    j.dataset_id,
    j.source_id ?? `ds${j.dataset_id}`,
    j.status ?? "preparing",
    j.blocklisted ?? 0,
    j.blocklist_reason ?? null,
    j.first_incomplete_at ?? null,
    j.next_retry_at ?? null,
    j.last_error ?? null,
    j.maintainer_notified_at ?? null,
    j.integrity_checked_at ?? null,
    j.updated_at ??
      new Date()
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d+Z$/, ""),
  );
}

describe("migration 0058: retry-engine + blocklist columns", () => {
  test("adds the new columns with the documented defaults", () => {
    const db = freshDb();
    insertJob(db, { dataset_id: "on000001" });
    const row = db
      .prepare(
        `SELECT recovery_attempts, first_incomplete_at, next_retry_at, blocklisted,
                blocklist_reason, maintainer_notified_at, integrity_checked_at
           FROM import_jobs WHERE dataset_id = ?`,
      )
      .get("on000001") as {
      recovery_attempts: number;
      first_incomplete_at: string | null;
      next_retry_at: string | null;
      blocklisted: number;
      blocklist_reason: string | null;
      maintainer_notified_at: string | null;
      integrity_checked_at: string | null;
    };
    expect(row.recovery_attempts).toBe(0);
    expect(row.first_incomplete_at).toBeNull();
    expect(row.next_retry_at).toBeNull();
    expect(row.blocklisted).toBe(0);
    expect(row.blocklist_reason).toBeNull();
    expect(row.maintainer_notified_at).toBeNull();
    expect(row.integrity_checked_at).toBeNull();
  });

  test("'incomplete' is a legal status value (no CHECK constraint)", () => {
    const db = freshDb();
    expect(() => insertJob(db, { dataset_id: "on000002", status: "incomplete" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Candidate queries (real SQLite, production SQL)
// ---------------------------------------------------------------------------

const NOW_SQL = "2026-07-20 00:00:00";

describe("IMPORT_RETRY_CANDIDATES_QUERY", () => {
  function candidateIds(db: Database): string[] {
    return (
      db.prepare(IMPORT_RETRY_CANDIDATES_QUERY).all(NOW_SQL, 25) as { dataset_id: string }[]
    ).map((r) => r.dataset_id);
  }

  test("selects incomplete and failed rows unconditionally", () => {
    const db = freshDb();
    insertJob(db, { dataset_id: "on000001", status: "incomplete" });
    insertJob(db, { dataset_id: "on000002", status: "failed" });
    expect(candidateIds(db).sort()).toEqual(["on000001", "on000002"]);
  });

  test("excludes complete and rolled_back rows", () => {
    const db = freshDb();
    insertJob(db, { dataset_id: "on000001", status: "complete" });
    insertJob(db, { dataset_id: "on000002", status: "rolled_back" });
    expect(candidateIds(db)).toEqual([]);
  });

  test("excludes blocklisted rows even if status otherwise qualifies", () => {
    const db = freshDb();
    insertJob(db, { dataset_id: "on000001", status: "incomplete", blocklisted: 1 });
    expect(candidateIds(db)).toEqual([]);
  });

  test("respects next_retry_at gating: future is excluded, past/NULL is included", () => {
    const db = freshDb();
    insertJob(db, {
      dataset_id: "on000001",
      status: "failed",
      next_retry_at: "2026-07-21 00:00:00",
    });
    insertJob(db, {
      dataset_id: "on000002",
      status: "failed",
      next_retry_at: "2026-07-19 00:00:00",
    });
    insertJob(db, { dataset_id: "on000003", status: "failed", next_retry_at: null });
    expect(candidateIds(db).sort()).toEqual(["on000002", "on000003"]);
  });

  test("quarantined rows qualify ONLY with the upstream-inaccessible marker in last_error", () => {
    const db = freshDb();
    insertJob(db, {
      dataset_id: "on000001",
      status: "quarantined",
      last_error: `quarantined: ${OPENNEURO_UPSTREAM_MARKER}`,
    });
    insertJob(db, {
      dataset_id: "on000002",
      status: "quarantined",
      last_error: "quarantined: has_doi",
    });
    insertJob(db, {
      dataset_id: "on000003",
      status: "quarantined",
      last_error: "quarantined: made_public",
    });
    insertJob(db, {
      dataset_id: "on000004",
      status: "quarantined",
      last_error: "quarantined: system_owned",
    });
    insertJob(db, { dataset_id: "on000005", status: "quarantined", last_error: null });
    expect(candidateIds(db)).toEqual(["on000001"]);
  });
});

describe("BLOCKLIST_RECHECK_QUERY", () => {
  function candidateIds(db: Database): string[] {
    return (db.prepare(BLOCKLIST_RECHECK_QUERY).all(NOW_SQL, 25) as { dataset_id: string }[]).map(
      (r) => r.dataset_id,
    );
  }

  test("only selects blocklisted rows due for recheck", () => {
    const db = freshDb();
    insertJob(db, {
      dataset_id: "on000001",
      status: "quarantined",
      blocklisted: 1,
      next_retry_at: null,
    });
    insertJob(db, {
      dataset_id: "on000002",
      status: "quarantined",
      blocklisted: 1,
      next_retry_at: "2026-07-19 00:00:00",
    });
    insertJob(db, {
      dataset_id: "on000003",
      status: "quarantined",
      blocklisted: 1,
      next_retry_at: "2026-07-21 00:00:00",
    });
    insertJob(db, { dataset_id: "on000004", status: "quarantined", blocklisted: 0 });
    expect(candidateIds(db).sort()).toEqual(["on000001", "on000002"]);
  });
});

describe("RECLASSIFY_CANDIDATES_QUERY", () => {
  test("only complete rows never integrity-checked, batch-bounded", () => {
    const db = freshDb();
    insertJob(db, { dataset_id: "on000001", status: "complete", integrity_checked_at: null });
    insertJob(db, { dataset_id: "on000002", status: "complete", integrity_checked_at: null });
    insertJob(db, {
      dataset_id: "on000003",
      status: "complete",
      integrity_checked_at: "2026-07-01 00:00:00",
    });
    insertJob(db, { dataset_id: "on000004", status: "failed", integrity_checked_at: null });

    const all = (db.prepare(RECLASSIFY_CANDIDATES_QUERY).all(25) as { dataset_id: string }[]).map(
      (r) => r.dataset_id,
    );
    expect(all.sort()).toEqual(["on000001", "on000002"]);

    const bounded = (
      db.prepare(RECLASSIFY_CANDIDATES_QUERY).all(1) as { dataset_id: string }[]
    ).map((r) => r.dataset_id);
    expect(bounded.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Prod-only guard (mirrors cron-dev-safety.test.ts's probe pattern)
// ---------------------------------------------------------------------------

describe("prod-only guard", () => {
  function probe(): { db: D1Database; touched: () => boolean } {
    let reached = false;
    const db = {
      prepare() {
        reached = true;
        throw new Error("probe: candidate query reached");
      },
    } as unknown as D1Database;
    return { db, touched: () => reached };
  }

  for (const environment of ["development", "staging", "test"]) {
    test(`sweepImportRetries never queries D1 when ENVIRONMENT=${environment}`, async () => {
      const p = probe();
      await sweepImportRetries({ ENVIRONMENT: environment, DB: p.db } as unknown as Bindings);
      expect(p.touched()).toBe(false);
    });

    test(`reclassifyCompleteRows never queries D1 when ENVIRONMENT=${environment}`, async () => {
      const p = probe();
      await reclassifyCompleteRows({ ENVIRONMENT: environment, DB: p.db } as unknown as Bindings);
      expect(p.touched()).toBe(false);
    });
  }

  for (const environment of ["production", "", undefined, "prod", "Production"]) {
    test(`sweepImportRetries still runs when ENVIRONMENT=${JSON.stringify(environment)}`, async () => {
      const p = probe();
      await sweepImportRetries({ ENVIRONMENT: environment, DB: p.db } as unknown as Bindings);
      expect(p.touched()).toBe(true);
    });
  }

  test("reclassifyCompleteRows returns a zero result off-prod", async () => {
    const p = probe();
    const result = await reclassifyCompleteRows({
      ENVIRONMENT: "development",
      DB: p.db,
    } as unknown as Bindings);
    expect(result).toEqual({ checked: 0, reclassified: 0 });
  });
});

// NOTE: sweepImportRetries/reclassifyCompleteRows' on-prod bodies call
// verifyDatasetVersionS3, which does real S3 network I/O (listObjectSizes)
// even on the "no manifest" fallback path -- there is no way to exercise them
// end-to-end without live AWS credentials. Consistent with
// archiveRetrySweep/reconcileReservedVersionDois (also untested at that
// level), coverage here stops at the prod-only guard above plus the pure
// decision functions and query text tested elsewhere in this file.
//
// recoverRow, stampMaintainerNotified, and sendMaintainerReportIfDue's
// dry-run path are D1-only (no S3, no email network) -- real end-to-end
// coverage below, no excuse to skip it.

describe("recoverRow (real D1)", () => {
  test("un-parks a blocklisted quarantined row unconditionally", async () => {
    const db = freshDb();
    insertJob(db, {
      dataset_id: "on000001",
      status: "quarantined",
      blocklisted: 1,
      blocklist_reason: "upstream_403_after_window",
      first_incomplete_at: "2026-07-01 00:00:00",
      next_retry_at: "2026-07-25 00:00:00",
    });

    await recoverRow(realD1(db), "on000001");

    const row = db
      .prepare(
        `SELECT status, blocklisted, blocklist_reason, first_incomplete_at, next_retry_at,
                integrity_checked_at
           FROM import_jobs WHERE dataset_id = ?`,
      )
      .get("on000001") as {
      status: string;
      blocklisted: number;
      blocklist_reason: string | null;
      first_incomplete_at: string | null;
      next_retry_at: string | null;
      integrity_checked_at: string | null;
    };
    expect(row.status).toBe("complete");
    expect(row.blocklisted).toBe(0);
    expect(row.blocklist_reason).toBeNull();
    expect(row.first_incomplete_at).toBeNull();
    expect(row.next_retry_at).toBeNull();
    expect(row.integrity_checked_at).not.toBeNull();
  });

  test("un-parks a blocklisted failed row too (blocklisting never changes status)", async () => {
    const db = freshDb();
    insertJob(db, {
      dataset_id: "on000002",
      status: "failed",
      blocklisted: 1,
      blocklist_reason: "upstream_403_after_window",
    });

    await recoverRow(realD1(db), "on000002");

    const row = db
      .prepare("SELECT status, blocklisted FROM import_jobs WHERE dataset_id = ?")
      .get("on000002") as { status: string; blocklisted: number };
    expect(row.status).toBe("complete");
    expect(row.blocklisted).toBe(0);
  });

  test("writes an import_recovered audit row", async () => {
    const db = freshDb();
    insertJob(db, { dataset_id: "on000003", status: "incomplete" });

    await recoverRow(realD1(db), "on000003");

    const audit = db
      .prepare("SELECT action, resource_id FROM audit_log WHERE action = 'import_recovered'")
      .get() as { action: string; resource_id: string } | undefined;
    expect(audit?.resource_id).toBe("on000003");
  });
});

describe("stampMaintainerNotified (real D1) -- the #969 placeholder/bind fix", () => {
  test("stamps exactly the given ids when they are a strict SUBSET of a larger candidate set", async () => {
    // Reproduces the exact shape of the bug: sendMaintainerReportIfDue is
    // called with a candidates array, but only a subset (`due`) is still
    // eligible after the maintainer_notified_at IS NULL filter. Passing a
    // shorter `datasetIds` than some OTHER, larger array's placeholder count
    // is exactly what threw "wrong number of parameter bindings" before the
    // fix; here the function's own placeholder count always matches its own
    // argument, so this must not throw.
    const db = freshDb();
    insertJob(db, { dataset_id: "on000001" });
    insertJob(db, { dataset_id: "on000002" });
    insertJob(db, { dataset_id: "on000003" });

    await expect(stampMaintainerNotified(realD1(db), ["on000002"])).resolves.toBeUndefined();

    const rows = db
      .prepare("SELECT dataset_id, maintainer_notified_at FROM import_jobs ORDER BY dataset_id")
      .all() as { dataset_id: string; maintainer_notified_at: string | null }[];
    expect(rows.find((r) => r.dataset_id === "on000001")?.maintainer_notified_at).toBeNull();
    expect(rows.find((r) => r.dataset_id === "on000002")?.maintainer_notified_at).not.toBeNull();
    expect(rows.find((r) => r.dataset_id === "on000003")?.maintainer_notified_at).toBeNull();
  });

  test("empty array is a no-op (does not run a malformed IN () query)", async () => {
    const db = freshDb();
    insertJob(db, { dataset_id: "on000001" });
    await expect(stampMaintainerNotified(realD1(db), [])).resolves.toBeUndefined();
    const row = db
      .prepare("SELECT maintainer_notified_at FROM import_jobs WHERE dataset_id = ?")
      .get("on000001") as { maintainer_notified_at: string | null };
    expect(row.maintainer_notified_at).toBeNull();
  });
});

describe("sendMaintainerReportIfDue dry-run (real D1, no email network)", () => {
  test("mixed batch (one already-notified, one new): filters correctly, no throw, nothing stamped when the flag is unset", async () => {
    const db = freshDb();
    insertJob(db, {
      dataset_id: "on000001",
      source_id: "ds000001",
      status: "quarantined",
      blocklisted: 1,
      maintainer_notified_at: null, // due
    });
    insertJob(db, {
      dataset_id: "on000002",
      source_id: "ds000002",
      status: "quarantined",
      blocklisted: 1,
      maintainer_notified_at: "2026-07-01 00:00:00", // already notified -- must be excluded
    });

    const env = {
      DB: realD1(db),
      // OPENNEURO_MAINTAINER_EMAIL_ENABLED left unset: dry run, never reaches
      // the network send.
    } as unknown as Bindings;

    await expect(
      sendMaintainerReportIfDue(env, [
        { datasetId: "on000001", sourceId: "ds000001" },
        { datasetId: "on000002", sourceId: "ds000002" },
      ]),
    ).resolves.toBeUndefined();

    const rows = db
      .prepare("SELECT dataset_id, maintainer_notified_at FROM import_jobs ORDER BY dataset_id")
      .all() as { dataset_id: string; maintainer_notified_at: string | null }[];
    // Dry run: neither row is stamped -- on000002 was already stamped from an
    // earlier cycle and must stay untouched (still non-null, unchanged), and
    // on000001 must stay NULL (not silently marked "notified" without a send).
    expect(rows.find((r) => r.dataset_id === "on000001")?.maintainer_notified_at).toBeNull();
    expect(rows.find((r) => r.dataset_id === "on000002")?.maintainer_notified_at).toBe(
      "2026-07-01 00:00:00",
    );

    const audit = db
      .prepare("SELECT details FROM audit_log WHERE action = 'import_maintainer_report_computed'")
      .get() as { details: string } | undefined;
    expect(audit).toBeDefined();
    const details = JSON.parse(audit?.details ?? "{}");
    expect(details.decision).toBe("dry_run");
    // Only the still-due dataset (on000001) is in the computed report --
    // on000002 was already filtered out by maintainer_notified_at IS NULL.
    expect(details.datasets).toEqual(["on000001"]);
  });

  test("all candidates already notified: no-op, no audit row", async () => {
    const db = freshDb();
    insertJob(db, {
      dataset_id: "on000001",
      maintainer_notified_at: "2026-07-01 00:00:00",
    });

    const env = { DB: realD1(db) } as unknown as Bindings;
    await sendMaintainerReportIfDue(env, [{ datasetId: "on000001", sourceId: "ds000001" }]);

    const audit = db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'import_maintainer_report_computed'",
      )
      .get() as { n: number };
    expect(audit.n).toBe(0);
  });
});
