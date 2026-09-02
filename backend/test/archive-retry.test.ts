/**
 * Tests for the bounded archive auto-retry (epic #736, Phase 3 / #740):
 *   - the pure decision/parse helpers in src/services/archive-retry.ts, and
 *   - migration 0040 + the exact sweep candidate query, run against a real
 *     in-memory SQLite db (bun:sqlite, no mocks) with every migration applied so
 *     the `datasets` table matches production.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ARCHIVE_READY_UPDATE_SQL } from "../src/routes/callbacks/archive-ready";
import {
  ARCHIVE_RETRY_SWEEP_QUERY,
  MAX_ARCHIVE_RETRIES,
  decideArchiveRetry,
  versionFromDoi,
} from "../src/services/archive-retry";

describe("decideArchiveRetry", () => {
  test("ready always resets the count and never retries", () => {
    expect(decideArchiveRetry("ready", 2, "1.0.0")).toEqual({
      retry: false,
      nextCount: 0,
      reason: "ready_reset",
    });
    // resets even when a version is absent
    expect(decideArchiveRetry("ready", 3, undefined)).toEqual({
      retry: false,
      nextCount: 0,
      reason: "ready_reset",
    });
  });

  test("failed without a version cannot retry and leaves the count untouched", () => {
    expect(decideArchiveRetry("failed", 1, undefined)).toEqual({
      retry: false,
      nextCount: 1,
      reason: "no_version",
    });
    expect(decideArchiveRetry("failed", 0, null)).toEqual({
      retry: false,
      nextCount: 0,
      reason: "no_version",
    });
  });

  test("failed under the cap retries and increments", () => {
    expect(decideArchiveRetry("failed", 0, "1.0.0")).toEqual({
      retry: true,
      nextCount: 1,
      reason: "retry",
    });
    expect(decideArchiveRetry("failed", MAX_ARCHIVE_RETRIES - 1, "1.0.0")).toEqual({
      retry: true,
      nextCount: MAX_ARCHIVE_RETRIES,
      reason: "retry",
    });
  });

  test("failed at or above the cap gives up without incrementing", () => {
    expect(decideArchiveRetry("failed", MAX_ARCHIVE_RETRIES, "1.0.0")).toEqual({
      retry: false,
      nextCount: MAX_ARCHIVE_RETRIES,
      reason: "cap_reached",
    });
    expect(decideArchiveRetry("failed", MAX_ARCHIVE_RETRIES + 5, "1.0.0").retry).toBe(false);
  });

  test("a full failure chain converges to the cap then stops", () => {
    let count = 0;
    let dispatches = 0;
    for (let i = 0; i < 10; i++) {
      const d = decideArchiveRetry("failed", count, "1.0.0");
      count = d.nextCount;
      if (d.retry) dispatches++;
    }
    expect(dispatches).toBe(MAX_ARCHIVE_RETRIES);
    expect(count).toBe(MAX_ARCHIVE_RETRIES);
  });
});

describe("versionFromDoi", () => {
  test("extracts the bare version from a version DOI", () => {
    expect(versionFromDoi("10.82901/nemar.nm000111.v1.0.1")).toBe("1.0.1");
    expect(versionFromDoi("10.82901/nemar.nm000132.v10.2.30")).toBe("10.2.30");
  });

  test("returns null for a concept DOI, malformed, or empty input", () => {
    expect(versionFromDoi("10.82901/nemar.nm000111")).toBeNull();
    expect(versionFromDoi("10.82901/nemar.nm000111.v1.0")).toBeNull();
    expect(versionFromDoi("")).toBeNull();
    expect(versionFromDoi(null)).toBeNull();
    expect(versionFromDoi(undefined)).toBeNull();
  });
});

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");

function freshDb(): Database {
  const db = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  db.prepare(
    `INSERT INTO users (id, username, email, github_username, status)
     VALUES (1, 'alice', 'alice@nemar.org', 'alice', 'approved')`,
  ).run();
  return db;
}

function insertDataset(
  db: Database,
  d: {
    dataset_id: string;
    archive_status?: string | null;
    latest_version_doi?: string | null;
    archive_retry_count?: number;
    archive_checked_at?: string | null;
  },
): void {
  // The stamp lives in sweep_stamps -> $.archive_checked_at since migration
  // 0073 (#1183). A NULL archive_checked_at leaves sweep_stamps NULL (the
  // fresh post-0073 row shape), which the sweep must treat as never-checked.
  db.prepare(
    `INSERT INTO datasets
       (dataset_id, owner_user_id, name, visibility, is_sandbox,
        archive_status, latest_version_doi, archive_retry_count, sweep_stamps)
     VALUES (?, 1, ?, 'public', 0, ?, ?, COALESCE(?, 0),
             CASE WHEN ? IS NULL THEN NULL ELSE json_object('archive_checked_at', ?) END)`,
  ).run(
    d.dataset_id,
    d.dataset_id,
    d.archive_status ?? null,
    d.latest_version_doi ?? null,
    d.archive_retry_count ?? 0,
    d.archive_checked_at ?? null,
    d.archive_checked_at ?? null,
  );
}

describe("migration 0040: archive_retry_count", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("adds archive_retry_count NOT NULL DEFAULT 0", () => {
    insertDataset(db, { dataset_id: "nm000001" });
    const row = db
      .prepare("SELECT archive_retry_count FROM datasets WHERE dataset_id = ?")
      .get("nm000001") as { archive_retry_count: number };
    expect(row.archive_retry_count).toBe(0);
  });

  test("ready callback UPDATE resets the count to 0", () => {
    insertDataset(db, { dataset_id: "nm000001", archive_status: "failed", archive_retry_count: 2 });
    // The route's own UPDATE, imported rather than copied so this cannot
    // drift from what production runs.
    db.prepare(ARCHIVE_READY_UPDATE_SQL).run(123, null, null, null, "nm000001");
    const row = db
      .prepare("SELECT archive_status, archive_retry_count FROM datasets WHERE dataset_id = ?")
      .get("nm000001") as { archive_status: string; archive_retry_count: number };
    expect(row.archive_status).toBe("ready");
    expect(row.archive_retry_count).toBe(0);
  });
});

describe("ARCHIVE_RETRY_SWEEP_QUERY", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  function sweepIds(): string[] {
    return (
      db.prepare(ARCHIVE_RETRY_SWEEP_QUERY).all(MAX_ARCHIVE_RETRIES) as { dataset_id: string }[]
    ).map((r) => r.dataset_id);
  }

  test("selects a failed, versioned, under-cap, stale-checked dataset", () => {
    insertDataset(db, {
      dataset_id: "nm000001",
      archive_status: "failed",
      latest_version_doi: "10.82901/nemar.nm000001.v1.0.0",
      archive_retry_count: 1,
      archive_checked_at: "2020-01-01 00:00:00",
    });
    expect(sweepIds()).toEqual(["nm000001"]);
  });

  test("selects a failed dataset that was never checked (NULL checked_at)", () => {
    insertDataset(db, {
      dataset_id: "nm000002",
      archive_status: "failed",
      latest_version_doi: "10.82901/nemar.nm000002.v1.0.0",
      archive_retry_count: 0,
      archive_checked_at: null,
    });
    expect(sweepIds()).toEqual(["nm000002"]);
  });

  test("excludes ready, no-version, at-cap, and recently-checked rows", () => {
    insertDataset(db, {
      dataset_id: "nm000010",
      archive_status: "ready",
      latest_version_doi: "10.82901/nemar.nm000010.v1.0.0",
      archive_checked_at: "2020-01-01 00:00:00",
    });
    insertDataset(db, {
      dataset_id: "nm000011",
      archive_status: "failed",
      latest_version_doi: null,
      archive_checked_at: "2020-01-01 00:00:00",
    });
    insertDataset(db, {
      dataset_id: "nm000012",
      archive_status: "failed",
      latest_version_doi: "10.82901/nemar.nm000012.v1.0.0",
      archive_retry_count: MAX_ARCHIVE_RETRIES,
      archive_checked_at: "2020-01-01 00:00:00",
    });
    insertDataset(db, {
      dataset_id: "nm000013",
      archive_status: "failed",
      latest_version_doi: "10.82901/nemar.nm000013.v1.0.0",
      archive_retry_count: 0,
      archive_checked_at: "2999-01-01 00:00:00", // checked in the (far) future -> not stale
    });
    expect(sweepIds()).toEqual([]);
  });
});
