/**
 * Integration test for migration 0059_data_complete_columns.sql (epic #967
 * phase 3, #970).
 *
 * Runs against a real in-memory SQLite database via bun:sqlite (no mocks),
 * applying every migration in order so the schema matches production, then
 * asserting the honest-size additions:
 *
 *   1. datasets gains bytes_present, data_complete; the data_checked_at stamp
 *      lives under sweep_stamps -> $.data_checked_at since migration 0073
 *      (#1183).
 *   2. dataset_versions gains file_size, total_files, bytes_present, data_complete.
 *   3. idx_datasets_data_complete exists.
 *   4. The columns round-trip a populated row.
 *   5. data_complete=0 (checked, incomplete) is DISTINCT from NULL (not
 *      audited yet) -- the load-bearing not-checked vs checked-incomplete
 *      distinction, mirroring has_hed.
 *   6. A row inserted without setting the new columns reads back NULL.
 *
 * The data-integrity sweep's candidate predicate itself is covered at the
 * route entry point in backend/test/sweep-stamps-candidates.test.ts.
 *   8. CHECK (data_complete IN (0,1)) rejects out-of-domain values.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");

function getMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function freshDb(): Database {
  const db = new Database(":memory:");
  for (const file of getMigrationFiles()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  return db;
}

function tableColumns(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function seedDataset(db: Database, datasetId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email, github_username, status) VALUES (1, 'alice', 'alice@nemar.org', 'alice', 'approved')",
  ).run();
  db.prepare(
    "INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, is_sandbox) VALUES (?, 1, ?, 'public', 0)",
  ).run(datasetId, datasetId);
}

describe("migration 0059_data_complete_columns", () => {
  test("datasets gains bytes_present, data_complete; data_checked_at is collapsed into sweep_stamps", () => {
    const db = freshDb();
    const cols = tableColumns(db, "datasets");
    expect(cols).toEqual(
      expect.arrayContaining(["bytes_present", "data_complete", "sweep_stamps"]),
    );
    expect(cols).not.toContain("data_checked_at");
    db.close();
  });

  test("dataset_versions gains file_size, total_files, bytes_present, data_complete", () => {
    const db = freshDb();
    expect(tableColumns(db, "dataset_versions")).toEqual(
      expect.arrayContaining(["file_size", "total_files", "bytes_present", "data_complete"]),
    );
    db.close();
  });

  test("idx_datasets_data_complete index exists", () => {
    const db = freshDb();
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_datasets_data_complete") as { name: string } | null;
    expect(idx?.name).toBe("idx_datasets_data_complete");
    db.close();
  });

  test("datasets honest-size columns round-trip a populated row", () => {
    const db = freshDb();
    seedDataset(db, "nm000132");
    db.prepare(
      "UPDATE datasets SET bytes_present = 1024, data_complete = 1, sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.data_checked_at', '2026-07-21T00:00:00Z') WHERE dataset_id = ?",
    ).run("nm000132");
    const row = db
      .prepare(
        "SELECT bytes_present, data_complete, json_extract(sweep_stamps, '$.data_checked_at') AS data_checked_at FROM datasets WHERE dataset_id = ?",
      )
      .get("nm000132") as {
      bytes_present: number;
      data_complete: number;
      data_checked_at: string;
    };
    expect(row.bytes_present).toBe(1024);
    expect(row.data_complete).toBe(1);
    expect(row.data_checked_at).toBe("2026-07-21T00:00:00Z");
    db.close();
  });

  test("unpopulated datasets row reads back NULL (not audited yet)", () => {
    const db = freshDb();
    seedDataset(db, "nm000999");
    const row = db
      .prepare(
        "SELECT bytes_present, data_complete, json_extract(sweep_stamps, '$.data_checked_at') AS data_checked_at FROM datasets WHERE dataset_id = ?",
      )
      .get("nm000999") as {
      bytes_present: number | null;
      data_complete: number | null;
      data_checked_at: string | null;
    };
    expect(row.bytes_present).toBeNull();
    expect(row.data_complete).toBeNull();
    expect(row.data_checked_at).toBeNull();
    db.close();
  });

  test("data_complete=0 (checked, incomplete) is distinct from NULL on both tables", () => {
    const db = freshDb();
    seedDataset(db, "nm000999");
    // The sweep stamps data_checked_at and writes data_complete=0 when a manifest
    // key is missing/truncated -- that 0 must NOT read back as NULL, or the sweep
    // would re-check it forever.
    db.prepare(
      "UPDATE datasets SET data_complete = 0, bytes_present = 36, sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.data_checked_at', '2026-07-21T00:00:00Z') WHERE dataset_id = ?",
    ).run("nm000999");
    const row = db
      .prepare("SELECT data_complete, bytes_present FROM datasets WHERE dataset_id = ?")
      .get("nm000999") as { data_complete: number | null; bytes_present: number | null };
    expect(row.data_complete).toBe(0);
    expect(row.data_complete).not.toBeNull();
    expect(row.bytes_present).toBe(36);

    // Same per-version: a version checked as incomplete stores 0, not NULL.
    db.prepare(
      "INSERT INTO dataset_versions (dataset_id, version, doi, data_complete) VALUES (?, 'v1.0.0', 'doi:10.82901/NEMAR.nm000999.v1.0.0', 0)",
    ).run("nm000999");
    const vrow = db
      .prepare(
        "SELECT data_complete FROM dataset_versions WHERE dataset_id = ? AND version = 'v1.0.0'",
      )
      .get("nm000999") as { data_complete: number | null };
    expect(vrow.data_complete).toBe(0);
    expect(vrow.data_complete).not.toBeNull();
    db.close();
  });

  test("CHECK (data_complete IN (0,1)) rejects an out-of-domain value", () => {
    const db = freshDb();
    seedDataset(db, "nm000132");
    expect(() =>
      db.prepare("UPDATE datasets SET data_complete = 2 WHERE dataset_id = ?").run("nm000132"),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO dataset_versions (dataset_id, version, doi, data_complete) VALUES (?, 'v9.9.9', 'doi:x', 2)",
        )
        .run("nm000132"),
    ).toThrow();
    db.close();
  });

  test("dataset_versions honest-size columns are per-version (v1 incomplete, v2 complete)", () => {
    const db = freshDb();
    seedDataset(db, "nm000132");
    db.prepare(
      "INSERT INTO dataset_versions (dataset_id, version, doi, data_complete, file_size, total_files) VALUES (?, 'v1.0.0', 'doi:10.82901/NEMAR.nm000132.v1.0.0', 0, 12000000000, 400)",
    ).run("nm000132");
    db.prepare(
      "INSERT INTO dataset_versions (dataset_id, version, doi, data_complete, file_size, total_files) VALUES (?, 'v1.1.1', 'doi:10.82901/NEMAR.nm000132.v1.1.1', 1, 12000000000, 400)",
    ).run("nm000132");

    const v1 = db
      .prepare(
        "SELECT data_complete, file_size, total_files FROM dataset_versions WHERE dataset_id = ? AND version = 'v1.0.0'",
      )
      .get("nm000132") as { data_complete: number | null; file_size: number; total_files: number };
    const v2 = db
      .prepare(
        "SELECT data_complete, file_size, total_files FROM dataset_versions WHERE dataset_id = ? AND version = 'v1.1.1'",
      )
      .get("nm000132") as { data_complete: number | null; file_size: number; total_files: number };

    expect(v1.data_complete).toBe(0);
    expect(v2.data_complete).toBe(1);
    // file_size/total_files are identical (same content); only completeness differs.
    expect(v1.file_size).toBe(v2.file_size);
    db.close();
  });
});
