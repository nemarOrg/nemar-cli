/**
 * Integration test for migration 0056_hed_columns.sql (epic #869 phase 1, #870).
 *
 * Runs against a real in-memory SQLite database via bun:sqlite (no mocks),
 * applying every migration in order so the schema matches production, then
 * asserting the HED additions:
 *
 *   1. datasets gains has_hed, hed_version, hed_checked_at.
 *   2. dataset_versions gains has_hed, hed_version.
 *   3. idx_datasets_has_hed exists.
 *   4. The columns round-trip a populated row (has_hed=1, hed_version='8.3.0').
 *   5. A row inserted WITHOUT the columns reads back NULL ("not classified yet"),
 *      so downstream queries can distinguish unclassified from really-false.
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
    "INSERT INTO users (id, username, email, github_username, status) VALUES (1, 'alice', 'alice@nemar.org', 'alice', 'approved')",
  ).run();
  db.prepare(
    "INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, is_sandbox) VALUES (?, 1, ?, 'public', 0)",
  ).run(datasetId, datasetId);
}

describe("migration 0056_hed_columns", () => {
  test("datasets gains has_hed, hed_version, hed_checked_at", () => {
    const db = freshDb();
    expect(tableColumns(db, "datasets")).toEqual(
      expect.arrayContaining(["has_hed", "hed_version", "hed_checked_at"]),
    );
    db.close();
  });

  test("dataset_versions gains has_hed, hed_version", () => {
    const db = freshDb();
    expect(tableColumns(db, "dataset_versions")).toEqual(
      expect.arrayContaining(["has_hed", "hed_version"]),
    );
    db.close();
  });

  test("idx_datasets_has_hed index exists", () => {
    const db = freshDb();
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_datasets_has_hed") as { name: string } | null;
    expect(idx?.name).toBe("idx_datasets_has_hed");
    db.close();
  });

  test("datasets HED columns round-trip a populated row", () => {
    const db = freshDb();
    seedDataset(db, "nm000132");
    db.prepare(
      "UPDATE datasets SET has_hed = 1, hed_version = '8.3.0', hed_checked_at = '2026-06-29T00:00:00Z' WHERE dataset_id = ?",
    ).run("nm000132");
    const row = db
      .prepare("SELECT has_hed, hed_version, hed_checked_at FROM datasets WHERE dataset_id = ?")
      .get("nm000132") as {
      has_hed: number;
      hed_version: string;
      hed_checked_at: string;
    };
    expect(row.has_hed).toBe(1);
    expect(row.hed_version).toBe("8.3.0");
    expect(row.hed_checked_at).toBe("2026-06-29T00:00:00Z");
    db.close();
  });

  test("unpopulated datasets row reads back NULL (not classified yet)", () => {
    const db = freshDb();
    seedDataset(db, "nm000999");
    const row = db
      .prepare("SELECT has_hed, hed_version, hed_checked_at FROM datasets WHERE dataset_id = ?")
      .get("nm000999") as {
      has_hed: number | null;
      hed_version: string | null;
      hed_checked_at: string | null;
    };
    expect(row.has_hed).toBeNull();
    expect(row.hed_version).toBeNull();
    expect(row.hed_checked_at).toBeNull();
    db.close();
  });

  test("dataset_versions HED columns are per-version (v1 null, v2 set)", () => {
    const db = freshDb();
    seedDataset(db, "nm000132");
    // v1.0.0 has no HED; v1.1.1 does -- the exact case this epic must support.
    db.prepare(
      "INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, 'v1.0.0', 'doi:10.82901/NEMAR.nm000132.v1.0.0')",
    ).run("nm000132");
    db.prepare(
      "INSERT INTO dataset_versions (dataset_id, version, doi, has_hed, hed_version) VALUES (?, 'v1.1.1', 'doi:10.82901/NEMAR.nm000132.v1.1.1', 1, '8.3.0')",
    ).run("nm000132");

    const v1 = db
      .prepare(
        "SELECT has_hed, hed_version FROM dataset_versions WHERE dataset_id = ? AND version = 'v1.0.0'",
      )
      .get("nm000132") as { has_hed: number | null; hed_version: string | null };
    const v2 = db
      .prepare(
        "SELECT has_hed, hed_version FROM dataset_versions WHERE dataset_id = ? AND version = 'v1.1.1'",
      )
      .get("nm000132") as { has_hed: number | null; hed_version: string | null };

    expect(v1.has_hed).toBeNull();
    expect(v1.hed_version).toBeNull();
    expect(v2.has_hed).toBe(1);
    expect(v2.hed_version).toBe("8.3.0");
    db.close();
  });
});
