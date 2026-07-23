/**
 * Integration test for migration 0061_availability_report_at.sql (epic #999
 * phase 2, #1001).
 *
 * Runs against a real in-memory SQLite database via bun:sqlite (no mocks),
 * applying every migration in order so the schema matches production, then
 * asserting the additive backfill-sweep marker:
 *
 *   1. datasets gains availability_report_at.
 *   2. A row inserted without setting it reads back NULL.
 *   3. The column round-trips a stamped row.
 *   4. availability_report_at IS NULL selects unswept datasets (sweep predicate).
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

describe("migration 0061_availability_report_at", () => {
  test("datasets gains availability_report_at", () => {
    const db = freshDb();
    expect(tableColumns(db, "datasets")).toContain("availability_report_at");
    db.close();
  });

  test("unpopulated datasets row reads back NULL (no sweep write yet)", () => {
    const db = freshDb();
    seedDataset(db, "nm000999");
    const row = db
      .prepare("SELECT availability_report_at FROM datasets WHERE dataset_id = ?")
      .get("nm000999") as { availability_report_at: string | null };
    expect(row.availability_report_at).toBeNull();
    db.close();
  });

  test("availability_report_at round-trips a stamped row", () => {
    const db = freshDb();
    seedDataset(db, "nm000132");
    db.prepare(
      "UPDATE datasets SET availability_report_at = '2026-07-22T00:00:00Z' WHERE dataset_id = ?",
    ).run("nm000132");
    const row = db
      .prepare("SELECT availability_report_at FROM datasets WHERE dataset_id = ?")
      .get("nm000132") as { availability_report_at: string };
    expect(row.availability_report_at).toBe("2026-07-22T00:00:00Z");
    db.close();
  });

  test("availability_report_at IS NULL selects unswept datasets, stamped drops out", () => {
    const db = freshDb();
    seedDataset(db, "nm000001"); // never swept
    seedDataset(db, "nm000002"); // will be stamped
    db.prepare(
      "UPDATE datasets SET availability_report_at = datetime('now') WHERE dataset_id = ?",
    ).run("nm000002");
    const candidates = db
      .prepare(
        "SELECT dataset_id FROM datasets WHERE availability_report_at IS NULL ORDER BY dataset_id",
      )
      .all() as { dataset_id: string }[];
    expect(candidates.map((r) => r.dataset_id)).toEqual(["nm000001"]);
    db.close();
  });
});
