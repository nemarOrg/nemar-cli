/**
 * Tests for migration 0036_dataset_archive_columns.sql (epic #695): the
 * archive_status / archive_size columns and their CHECK domain. The
 * archive_checked_at stamp the same migration added is collapsed into
 * sweep_stamps -> $.archive_checked_at by migration 0073 (#1183).
 *
 * Runs against a real in-memory SQLite database via bun:sqlite (no mocks),
 * applying every migration in order so the `datasets` table matches
 * production.
 *
 * The /webhooks/archive-ready UPDATE semantics and the admin archive-sweep
 * candidate selection that used to be pinned here as hand-copied SQL are
 * covered at their real entry points in
 * backend/test/sweep-stamps-candidates.test.ts (route dispatch, imported
 * SQL) -- a hand-copy kept here could silently drift from production.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
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
  // A real owner for the managed datasets (the -1 system user is seeded by 0029).
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

describe("migration 0036: archive columns", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("adds archive_status / archive_size, NULL by default; the stamp reads NULL from sweep_stamps", () => {
    insertDataset(db, "nm000001");
    const row = db
      .prepare(
        "SELECT archive_status, archive_size, json_extract(sweep_stamps, '$.archive_checked_at') AS archive_checked_at FROM datasets WHERE dataset_id = ?",
      )
      .get("nm000001") as Record<string, unknown>;
    expect(row.archive_status).toBeNull();
    expect(row.archive_size).toBeNull();
    expect(row.archive_checked_at).toBeNull();
  });

  test("the 0036 archive_checked_at column itself is gone after 0073", () => {
    const cols = (db.prepare("PRAGMA table_info(datasets)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).not.toContain("archive_checked_at");
    expect(cols).toContain("sweep_stamps");
  });

  test("idx_datasets_archive_status exists", () => {
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_datasets_archive_status");
    expect(idx).not.toBeNull();
  });

  test("archive_status CHECK accepts the enum + NULL, rejects others", () => {
    insertDataset(db, "nm000001");
    for (const v of ["pending", "ready", "failed"]) {
      db.prepare("UPDATE datasets SET archive_status = ? WHERE dataset_id = ?").run(v, "nm000001");
    }
    db.prepare("UPDATE datasets SET archive_status = NULL WHERE dataset_id = ?").run("nm000001");
    expect(() =>
      db
        .prepare("UPDATE datasets SET archive_status = ? WHERE dataset_id = ?")
        .run("bogus", "nm000001"),
    ).toThrow();
  });
});
