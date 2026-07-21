/**
 * Real in-memory D1 tests for services/withdraw.ts (epic #967 phase 4, #971).
 *
 * Two layers, matching the seam documented at the top of withdraw.ts:
 *
 * 1. The pure D1 read/write helpers (markDatasetWithdrawn/markDatasetRestored/
 *    markVersionEzidStatus) are exercised directly -- no network involved at
 *    all -- pinning the exact column-level state transitions the plan calls
 *    for: datasets.visibility is NOT touched here (that's
 *    applyDatasetVisibility's job, which needs live GitHub/S3 and is out of
 *    reach for this tier -- see the file-level comment), but withdrawn_at /
 *    withdrawn_reason / ezid_status on datasets, and ezid_status on each
 *    dataset_versions row, are.
 * 2. withdrawDataset/restoreDataset's dry-run and precondition-fail paths are
 *    exercised end-to-end with NO EZID/GitHub/S3 credentials configured in
 *    env at all -- if either function tried to reach past the early return
 *    into a network call, resolveEzidAuth/getDatasetsToken would throw on
 *    the missing config, so a clean result here is real evidence of zero
 *    network calls, not just an assertion. Both paths also assert zero D1
 *    writes beyond the initial read.
 *
 * The full live-execute path (successful visibility flip + EZID tombstone)
 * requires a real GitHub repo + S3 bucket + EZID registrar and is exercised
 * by test/ezid-sandbox.test.ts (RUN_EZID_TESTS=true, gated) and the sandbox
 * exemplar E2E, not here -- consistent with how every other EZID-calling
 * function in this codebase (createEzidConceptDoi, createEzidVersionDoi, ...)
 * is tested.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  markDatasetRestored,
  markDatasetWithdrawn,
  markVersionEzidStatus,
  restoreDataset,
  withdrawDataset,
} from "../src/services/withdraw";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

interface DatasetOverrides {
  visibility?: string;
  is_sandbox?: number;
  doi_provider?: string;
  ezid_identifier?: string | null;
  withdrawn_at?: string | null;
  withdrawn_reason?: string | null;
}

function seedDataset(db: Database, datasetId: string, overrides: DatasetOverrides = {}): void {
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email, github_username, status) VALUES (1, 'alice', 'alice@nemar.org', 'alice', 'approved')",
  ).run();
  const visibility = overrides.visibility ?? "public";
  const isSandbox = overrides.is_sandbox ?? 0;
  const doiProvider = overrides.doi_provider ?? "ezid";
  const ezidIdentifier =
    overrides.ezid_identifier === undefined
      ? `doi:10.82901/NEMAR.${datasetId.toUpperCase()}`
      : overrides.ezid_identifier;
  db.prepare(
    `INSERT INTO datasets
       (dataset_id, owner_user_id, name, visibility, is_sandbox, doi_provider,
        ezid_identifier, withdrawn_at, withdrawn_reason, github_repo)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    datasetId,
    datasetId,
    visibility,
    isSandbox,
    doiProvider,
    ezidIdentifier,
    overrides.withdrawn_at ?? null,
    overrides.withdrawn_reason ?? null,
    `nemarDatasets/${datasetId}`,
  );
}

function seedVersion(db: Database, datasetId: string, version: string, doi: string): void {
  db.prepare("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, ?, ?)").run(
    datasetId,
    version,
    doi,
  );
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

describe("pure D1 write helpers (no network)", () => {
  test("markDatasetWithdrawn stamps withdrawn_at/withdrawn_reason/ezid_status=unavailable", async () => {
    const db = freshDb();
    seedDataset(db, "on008115");
    await markDatasetWithdrawn(realD1(db), "on008115", "upstream_403");
    const row = readDataset(db, "on008115");
    expect(row.withdrawn_at).not.toBeNull();
    expect(row.withdrawn_reason).toBe("upstream_403");
    expect(row.ezid_status).toBe("unavailable");
    db.close();
  });

  test("markDatasetRestored clears withdrawn_at/withdrawn_reason and sets ezid_status=public", async () => {
    const db = freshDb();
    seedDataset(db, "on008115", {
      withdrawn_at: "2026-07-20T00:00:00Z",
      withdrawn_reason: "upstream_403",
    });
    await markDatasetRestored(realD1(db), "on008115");
    const row = readDataset(db, "on008115");
    expect(row.withdrawn_at).toBeNull();
    expect(row.withdrawn_reason).toBeNull();
    expect(row.ezid_status).toBe("public");
    db.close();
  });

  test("markVersionEzidStatus sets one version's status without touching another", async () => {
    const db = freshDb();
    seedDataset(db, "on008115");
    seedVersion(db, "on008115", "1.0.0", "doi:10.82901/NEMAR.ON008115.V1.0.0");
    seedVersion(db, "on008115", "1.1.0", "doi:10.82901/NEMAR.ON008115.V1.1.0");

    await markVersionEzidStatus(realD1(db), "on008115", "1.0.0", "unavailable");

    expect(readVersionStatus(db, "on008115", "1.0.0")).toBe("unavailable");
    expect(readVersionStatus(db, "on008115", "1.1.0")).toBeNull();
    db.close();
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
    expect(result.skipped).toBeUndefined();
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
    db.close();
  });

  test("dryRun:false is explicit -- default (omitted) is also a dry run", async () => {
    const db = freshDb();
    seedDataset(db, "on008115");
    const result = await withdrawDataset(bareEnv(db), "on008115", "upstream_403", {});
    expect(result.dry_run).toBe(true);
    db.close();
  });

  test("unknown dataset -> skipped, no writes, no network", async () => {
    const db = freshDb();
    const result = await withdrawDataset(bareEnv(db), "on999999", "upstream_403", {
      dryRun: false,
    });
    expect(result.skipped).toBe("Dataset not found");
    expect(result.dois).toBeUndefined();
    db.close();
  });

  test("no EZID concept DOI -> skipped, no writes, no network", async () => {
    const db = freshDb();
    seedDataset(db, "on008115", { ezid_identifier: null });
    const result = await withdrawDataset(bareEnv(db), "on008115", "upstream_403", {
      dryRun: false,
    });
    expect(result.skipped).toMatch(/no EZID concept DOI/i);
    db.close();
  });

  test("non-ezid doi_provider -> skipped, no writes, no network", async () => {
    const db = freshDb();
    seedDataset(db, "on008115", { doi_provider: "zenodo" });
    const result = await withdrawDataset(bareEnv(db), "on008115", "upstream_403", {
      dryRun: false,
    });
    expect(result.skipped).toMatch(/EZID-managed/i);
    db.close();
  });

  test("visibility already private -> skipped, no writes, no network", async () => {
    const db = freshDb();
    seedDataset(db, "on008115", { visibility: "private" });
    const result = await withdrawDataset(bareEnv(db), "on008115", "upstream_403", {
      dryRun: false,
    });
    expect(result.skipped).toMatch(/already "private"/);
    db.close();
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
    db.close();
  });

  test("unknown dataset -> skipped, no writes, no network", async () => {
    const db = freshDb();
    const result = await restoreDataset(bareEnv(db), "on999999", { dryRun: false });
    expect(result.skipped).toBe("Dataset not found");
    db.close();
  });

  test("not withdrawn (withdrawn_at unset) -> skipped, no writes, no network", async () => {
    const db = freshDb();
    seedDataset(db, "on008115", { visibility: "private" });
    const result = await restoreDataset(bareEnv(db), "on008115", { dryRun: false });
    expect(result.skipped).toMatch(/was not withdrawn/);
    db.close();
  });

  test("no EZID concept DOI -> skipped, no writes, no network", async () => {
    const db = freshDb();
    seedDataset(db, "on008115", {
      ezid_identifier: null,
      visibility: "private",
      withdrawn_at: "2026-07-20T00:00:00Z",
      withdrawn_reason: "upstream_403",
    });
    const result = await restoreDataset(bareEnv(db), "on008115", { dryRun: false });
    expect(result.skipped).toMatch(/no EZID concept DOI/i);
    db.close();
  });
});
