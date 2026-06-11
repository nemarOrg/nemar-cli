/**
 * Tests for migration 0041_dataset_records_columns.sql and the SQL the
 * /webhooks/records-ready handler runs (epic #736, Phase 5 / #742).
 *
 * Runs against a real in-memory SQLite database via bun:sqlite (no mocks),
 * applying every migration in order so the `datasets` table matches production.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

function insertDataset(db: Database, datasetId: string): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, is_sandbox)
     VALUES (?, 1, ?, 'public', 0)`,
  ).run(datasetId, datasetId);
}

describe("migration 0041: records columns", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("adds records_status / records_checked_at, NULL by default", () => {
    insertDataset(db, "nm000001");
    const row = db
      .prepare("SELECT records_status, records_checked_at FROM datasets WHERE dataset_id = ?")
      .get("nm000001") as Record<string, unknown>;
    expect(row.records_status).toBeNull();
    expect(row.records_checked_at).toBeNull();
  });

  test("idx_datasets_records_status exists", () => {
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_datasets_records_status");
    expect(idx).not.toBeNull();
  });

  test("records_status CHECK accepts the enum + NULL, rejects others", () => {
    insertDataset(db, "nm000001");
    for (const v of ["pending", "ready", "failed"]) {
      db.prepare("UPDATE datasets SET records_status = ? WHERE dataset_id = ?").run(v, "nm000001");
    }
    db.prepare("UPDATE datasets SET records_status = NULL WHERE dataset_id = ?").run("nm000001");
    expect(() =>
      db
        .prepare("UPDATE datasets SET records_status = ? WHERE dataset_id = ?")
        .run("bogus", "nm000001"),
    ).toThrow();
  });

  test("records-ready UPDATE flips status + stamps checked_at; 0 rows for unknown dataset", () => {
    insertDataset(db, "nm000001");
    const ok = db
      .prepare(
        "UPDATE datasets SET records_status = ?, records_checked_at = datetime('now') WHERE dataset_id = ?",
      )
      .run("ready", "nm000001");
    expect(ok.changes).toBe(1);
    const row = db
      .prepare("SELECT records_status, records_checked_at FROM datasets WHERE dataset_id = ?")
      .get("nm000001") as { records_status: string; records_checked_at: string };
    expect(row.records_status).toBe("ready");
    expect(row.records_checked_at).not.toBeNull();

    const miss = db
      .prepare(
        "UPDATE datasets SET records_status = ?, records_checked_at = datetime('now') WHERE dataset_id = ?",
      )
      .run("failed", "nm999999");
    expect(miss.changes).toBe(0);
  });
});
