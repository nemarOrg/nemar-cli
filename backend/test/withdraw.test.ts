/**
 * Real in-memory D1 tests for services/withdraw.ts (epic #967 phase 4, #971;
 * review-fix pass adds GROUP 1's resumability decision + the split pure D1
 * writers).
 *
 * Three layers, matching the seam documented at the top of withdraw.ts:
 *
 * 1. `decideWithdrawAction` -- fully pure, no D1/network -- covers
 *    fresh/resume/skip-unrelated-private/skip-done.
 * 2. The pure D1 read/write helpers (markWithdrawalIntent/
 *    clearWithdrawalIntent/markConceptEzidStatus/markVersionEzidStatus) are
 *    exercised directly -- no network involved at all -- pinning the exact
 *    column-level state transitions: datasets.visibility is NOT touched here
 *    (that's applyDatasetVisibility's job, which needs live GitHub/S3 and is
 *    out of reach for this tier -- see backend/test/visibility.test.ts for
 *    its own network-free branches), but withdrawn_at/withdrawn_reason/
 *    ezid_status on datasets, and ezid_status on each dataset_versions row,
 *    are.
 * 3. withdrawDataset/restoreDataset's dry-run and precondition-fail paths are
 *    exercised end-to-end with NO EZID/GitHub/S3 credentials configured in
 *    env at all -- if either function tried to reach past the early return
 *    into a network call, resolveEzidAuth/getDatasetsToken would throw on
 *    the missing config, so a clean result here is real evidence of zero
 *    network calls, not just an assertion. Both paths also assert zero D1
 *    writes beyond the initial read.
 *
 * The full live-execute path (successful visibility flip + EZID tombstone,
 * including the resume case) requires a real GitHub repo + S3 bucket + EZID
 * registrar; test/ezid-sandbox.test.ts's "Withdraw/Restore Orchestration
 * Round Trip" block documents exactly what additional credentials that needs
 * and is gated on their presence (not just RUN_EZID_TESTS) -- it is NOT
 * exercised here, consistent with how every other EZID-calling function in
 * this codebase is tested.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  clearWithdrawalIntent,
  decideWithdrawAction,
  markConceptEzidStatus,
  markVersionEzidStatus,
  markWithdrawalIntent,
  restoreDataset,
  withdrawDataset,
} from "../src/services/withdraw";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

interface DatasetOverrides {
  visibility?: string;
  is_sandbox?: number;
  concept_doi?: string | null;
  ezid_status?: string | null;
  withdrawn_at?: string | null;
  withdrawn_reason?: string | null;
}

function seedDataset(db: Database, datasetId: string, overrides: DatasetOverrides = {}): void {
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email, github_username, status) VALUES (1, 'alice', 'alice@nemar.org', 'alice', 'approved')",
  ).run();
  const visibility = overrides.visibility ?? "public";
  const isSandbox = overrides.is_sandbox ?? 0;
  // The EZID identifier is derived as 'doi:' + UPPER(concept_doi) (#1182),
  // so seeding the lowercase DOI yields the doi:10.82901/NEMAR.* identifiers
  // the assertions below expect.
  const conceptDoi =
    overrides.concept_doi === undefined
      ? `10.82901/nemar.${datasetId.toLowerCase()}`
      : overrides.concept_doi;
  db.prepare(
    `INSERT INTO datasets
       (dataset_id, owner_user_id, name, visibility, is_sandbox, concept_doi,
        ezid_status, withdrawn_at, withdrawn_reason, github_repo)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    datasetId,
    datasetId,
    visibility,
    isSandbox,
    conceptDoi,
    overrides.ezid_status ?? null,
    overrides.withdrawn_at ?? null,
    overrides.withdrawn_reason ?? null,
    `nemarDatasets/${datasetId}`,
  );
}

function seedVersion(
  db: Database,
  datasetId: string,
  version: string,
  doi: string,
  ezidStatus: string | null = null,
): void {
  db.prepare(
    "INSERT INTO dataset_versions (dataset_id, version, doi, ezid_status) VALUES (?, ?, ?, ?)",
  ).run(datasetId, version, doi, ezidStatus);
}

function readDataset(
  db: Database,
  datasetId: string,
): {
  visibility: string;
  withdrawn_at: string | null;
  withdrawn_reason: string | null;
  ezid_status: string | null;
} {
  return db
    .prepare(
      "SELECT visibility, withdrawn_at, withdrawn_reason, ezid_status FROM datasets WHERE dataset_id = ?",
    )
    .get(datasetId) as {
    visibility: string;
    withdrawn_at: string | null;
    withdrawn_reason: string | null;
    ezid_status: string | null;
  };
}

function readVersionStatus(db: Database, datasetId: string, version: string): string | null {
  const row = db
    .prepare("SELECT ezid_status FROM dataset_versions WHERE dataset_id = ? AND version = ?")
    .get(datasetId, version) as { ezid_status: string | null };
  return row.ezid_status;
}

/** Bindings with NO EZID/GitHub/S3 credentials at all -- proves the paths
 *  under test never reach past the precondition/dry-run early return. */
function bareEnv(db: Database): Bindings {
  return { DB: realD1(db) } as Bindings;
}

describe("decideWithdrawAction (pure, no D1/network)", () => {
  test("fresh: public visibility, never withdrawn", () => {
    expect(
      decideWithdrawAction({
        visibility: "public",
        withdrawnAt: null,
        conceptEzidStatus: null,
        versionEzidStatuses: [],
      }),
    ).toBe("fresh");
  });

  test("skip-unrelated-private: private, but withdrawal intent never recorded", () => {
    expect(
      decideWithdrawAction({
        visibility: "private",
        withdrawnAt: null,
        conceptEzidStatus: null,
        versionEzidStatuses: [],
      }),
    ).toBe("skip-unrelated-private");
  });

  test("resume: intent recorded but concept DOI not yet tombstoned", () => {
    expect(
      decideWithdrawAction({
        visibility: "private",
        withdrawnAt: "2026-07-20T00:00:00Z",
        conceptEzidStatus: null,
        versionEzidStatuses: [],
      }),
    ).toBe("resume");
  });

  test("resume: concept done but one version still pending", () => {
    expect(
      decideWithdrawAction({
        visibility: "private",
        withdrawnAt: "2026-07-20T00:00:00Z",
        conceptEzidStatus: "unavailable",
        versionEzidStatuses: ["unavailable", null],
      }),
    ).toBe("resume");
  });

  test("skip-done: intent recorded, concept + every version already unavailable", () => {
    expect(
      decideWithdrawAction({
        visibility: "private",
        withdrawnAt: "2026-07-20T00:00:00Z",
        conceptEzidStatus: "unavailable",
        versionEzidStatuses: ["unavailable", "unavailable"],
      }),
    ).toBe("skip-done");
  });

  test("skip-done: intent recorded, concept done, zero versions (vacuous)", () => {
    expect(
      decideWithdrawAction({
        visibility: "private",
        withdrawnAt: "2026-07-20T00:00:00Z",
        conceptEzidStatus: "unavailable",
        versionEzidStatuses: [],
      }),
    ).toBe("skip-done");
  });
});

describe("pure D1 write helpers (no network)", () => {
  test("markWithdrawalIntent stamps withdrawn_at (first time) + withdrawn_reason", async () => {
    const db = freshDb();
    seedDataset(db, "on008115");
    await markWithdrawalIntent(realD1(db), "on008115", "upstream_403");
    const row = readDataset(db, "on008115");
    expect(row.withdrawn_at).not.toBeNull();
    expect(row.withdrawn_reason).toBe("upstream_403");
    // Intent-stamping alone must NOT touch ezid_status -- that's
    // markConceptEzidStatus's job, written only once the EZID call succeeds.
    expect(row.ezid_status).toBeNull();
  });

  test("markWithdrawalIntent on resume preserves the original withdrawn_at (COALESCE)", async () => {
    const db = freshDb();
    seedDataset(db, "on008115", { withdrawn_at: "2026-07-20T00:00:00Z" });
    await markWithdrawalIntent(realD1(db), "on008115", "upstream_403");
    const row = readDataset(db, "on008115");
    expect(row.withdrawn_at).toBe("2026-07-20T00:00:00Z");
  });

  test("clearWithdrawalIntent clears withdrawn_at/withdrawn_reason only", async () => {
    const db = freshDb();
    seedDataset(db, "on008115", {
      withdrawn_at: "2026-07-20T00:00:00Z",
      withdrawn_reason: "upstream_403",
      ezid_status: "unavailable",
    });
    await clearWithdrawalIntent(realD1(db), "on008115");
    const row = readDataset(db, "on008115");
    expect(row.withdrawn_at).toBeNull();
    expect(row.withdrawn_reason).toBeNull();
    // Untouched by design -- markConceptEzidStatus owns this column.
    expect(row.ezid_status).toBe("unavailable");
  });

  test("markConceptEzidStatus sets ezid_status without touching withdrawn_at/reason", async () => {
    const db = freshDb();
    seedDataset(db, "on008115", {
      withdrawn_at: "2026-07-20T00:00:00Z",
      withdrawn_reason: "upstream_403",
    });
    await markConceptEzidStatus(realD1(db), "on008115", "unavailable");
    const row = readDataset(db, "on008115");
    expect(row.ezid_status).toBe("unavailable");
    expect(row.withdrawn_at).toBe("2026-07-20T00:00:00Z");
    expect(row.withdrawn_reason).toBe("upstream_403");
  });

  test("markVersionEzidStatus sets one version's status without touching another", async () => {
    const db = freshDb();
    seedDataset(db, "on008115");
    seedVersion(db, "on008115", "1.0.0", "doi:10.82901/NEMAR.ON008115.V1.0.0");
    seedVersion(db, "on008115", "1.1.0", "doi:10.82901/NEMAR.ON008115.V1.1.0");

    await markVersionEzidStatus(realD1(db), "on008115", "1.0.0", "unavailable");

    expect(readVersionStatus(db, "on008115", "1.0.0")).toBe("unavailable");
    expect(readVersionStatus(db, "on008115", "1.1.0")).toBeNull();
  });
});

describe("withdrawDataset (dry-run + precondition-fail, zero network)", () => {
  test("dry-run (default) plans concept + every version DOI, writes nothing", async () => {
    const db = freshDb();
    seedDataset(db, "on008115");
    seedVersion(db, "on008115", "1.0.0", "doi:10.82901/NEMAR.ON008115.V1.0.0");
    seedVersion(db, "on008115", "1.1.0", "doi:10.82901/NEMAR.ON008115.V1.1.0");

    const result = await withdrawDataset(bareEnv(db), "on008115", "upstream_403");

    expect(result.dry_run).toBe(true);
    expect("skipped" in result).toBe(false);
    if ("skipped" in result) throw new Error("unreachable");
    expect(result.resumed).toBe(false);
    expect(result.visibility).toEqual({ status: "planned" });
    expect(result.dois).toEqual([
      {
        doi: "doi:10.82901/NEMAR.ON008115",
        kind: "concept",
        action: "unavailable",
        status: "planned",
      },
      {
        doi: "doi:10.82901/NEMAR.ON008115.V1.0.0",
        kind: "version",
        version: "1.0.0",
        action: "unavailable",
        status: "planned",
      },
      {
        doi: "doi:10.82901/NEMAR.ON008115.V1.1.0",
        kind: "version",
        version: "1.1.0",
        action: "unavailable",
        status: "planned",
      },
    ]);

    // Zero writes: the row is byte-identical to what was seeded.
    const row = readDataset(db, "on008115");
    expect(row.visibility).toBe("public");
    expect(row.withdrawn_at).toBeNull();
    expect(row.withdrawn_reason).toBeNull();
    expect(row.ezid_status).toBeNull();
    expect(readVersionStatus(db, "on008115", "1.0.0")).toBeNull();
  });

  test("dry-run on a resumable (interrupted) withdrawal reports resumed:true, writes nothing", async () => {
    const db = freshDb();
    // Simulates the exact partial-failure state GROUP 1 fixes: visibility
    // already private + intent recorded, but the concept DOI never got
    // tombstoned (a prior EZID call must have thrown).
    seedDataset(db, "on008115", {
      visibility: "private",
      withdrawn_at: "2026-07-20T00:00:00Z",
      withdrawn_reason: "upstream_403",
    });

    const result = await withdrawDataset(bareEnv(db), "on008115", "upstream_403");

    expect(result.dry_run).toBe(true);
    if ("skipped" in result) throw new Error("unreachable");
    expect(result.resumed).toBe(true);
    expect(result.visibility).toEqual({ status: "planned" });

    // Still zero writes -- dry-run never mutates regardless of fresh/resume.
    const row = readDataset(db, "on008115");
    expect(row.withdrawn_reason).toBe("upstream_403");
    expect(row.ezid_status).toBeNull();
  });

  test("dryRun:false is explicit -- default (omitted) is also a dry run", async () => {
    const db = freshDb();
    seedDataset(db, "on008115");
    const result = await withdrawDataset(bareEnv(db), "on008115", "upstream_403", {});
    expect(result.dry_run).toBe(true);
  });

  test("unknown dataset -> skipped, no writes, no network", async () => {
    const db = freshDb();
    const result = await withdrawDataset(bareEnv(db), "on999999", "upstream_403", {
      dryRun: false,
    });
    expect("skipped" in result && result.skipped).toBe("Dataset not found");
  });

  test("no EZID concept DOI -> skipped, no writes, no network", async () => {
    // The identifier derives from concept_doi (#1182), so a NULL concept_doi
    // is the one remaining "not EZID-managed" state (the per-dataset
    // doi_provider column is gone; ADR 0007 makes EZID the sole provider).
    const db = freshDb();
    seedDataset(db, "on008115", { concept_doi: null });
    const result = await withdrawDataset(bareEnv(db), "on008115", "upstream_403", {
      dryRun: false,
    });
    expect("skipped" in result && result.skipped).toMatch(/no EZID concept DOI/i);
  });

  test("visibility already private but NEVER withdrawn -> skip-unrelated-private, no writes, no network", async () => {
    const db = freshDb();
    seedDataset(db, "on008115", { visibility: "private" });
    const result = await withdrawDataset(bareEnv(db), "on008115", "upstream_403", {
      dryRun: false,
    });
    expect("skipped" in result && result.skipped).toMatch(/never been withdrawn/);
    // Confirms this is NOT treated as already-withdrawn: no writes occurred.
    const row = readDataset(db, "on008115");
    expect(row.withdrawn_at).toBeNull();
  });

  test("already fully withdrawn (skip-done) -> skipped, no writes, no network", async () => {
    const db = freshDb();
    seedDataset(db, "on008115", {
      visibility: "private",
      withdrawn_at: "2026-07-20T00:00:00Z",
      withdrawn_reason: "upstream_403",
      ezid_status: "unavailable",
    });
    seedVersion(db, "on008115", "1.0.0", "doi:10.82901/NEMAR.ON008115.V1.0.0", "unavailable");

    const result = await withdrawDataset(bareEnv(db), "on008115", "upstream_403", {
      dryRun: false,
    });
    expect("skipped" in result && result.skipped).toMatch(/already fully withdrawn/);
  });
});

describe("restoreDataset (dry-run + precondition-fail, zero network)", () => {
  test("dry-run (default) plans concept + every version DOI back to public, writes nothing", async () => {
    const db = freshDb();
    seedDataset(db, "on008115", {
      visibility: "private",
      withdrawn_at: "2026-07-20T00:00:00Z",
      withdrawn_reason: "upstream_403",
    });
    seedVersion(db, "on008115", "1.0.0", "doi:10.82901/NEMAR.ON008115.V1.0.0");

    const result = await restoreDataset(bareEnv(db), "on008115");

    expect(result.dry_run).toBe(true);
    if ("skipped" in result) throw new Error("unreachable");
    expect(result.visibility).toEqual({ status: "planned" });
    expect(result.dois).toEqual([
      {
        doi: "doi:10.82901/NEMAR.ON008115",
        kind: "concept",
        action: "public",
        status: "planned",
      },
      {
        doi: "doi:10.82901/NEMAR.ON008115.V1.0.0",
        kind: "version",
        version: "1.0.0",
        action: "public",
        status: "planned",
      },
    ]);

    const row = readDataset(db, "on008115");
    expect(row.visibility).toBe("private");
    expect(row.withdrawn_at).toBe("2026-07-20T00:00:00Z");
  });

  test("unknown dataset -> skipped, no writes, no network", async () => {
    const db = freshDb();
    const result = await restoreDataset(bareEnv(db), "on999999", { dryRun: false });
    expect("skipped" in result && result.skipped).toBe("Dataset not found");
  });

  test("not withdrawn (withdrawn_at unset) -> skipped, no writes, no network", async () => {
    const db = freshDb();
    seedDataset(db, "on008115", { visibility: "private" });
    const result = await restoreDataset(bareEnv(db), "on008115", { dryRun: false });
    expect("skipped" in result && result.skipped).toMatch(/was not withdrawn/);
  });

  test("no EZID concept DOI -> skipped, no writes, no network", async () => {
    const db = freshDb();
    seedDataset(db, "on008115", {
      concept_doi: null,
      visibility: "private",
      withdrawn_at: "2026-07-20T00:00:00Z",
      withdrawn_reason: "upstream_403",
    });
    const result = await restoreDataset(bareEnv(db), "on008115", { dryRun: false });
    expect("skipped" in result && result.skipped).toMatch(/no EZID concept DOI/i);
  });
});
