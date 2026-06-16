/**
 * Tests for migration 0043_dataset_archive_skip_reason.sql and the SQL the
 * archive skip path runs (epic #749, Phase 3 / #752):
 *   - /webhooks/archive-ready status='skipped' UPDATE
 *   - the admin archive-sweep skipped-vs-absent branch
 *   - the "skipped = archive_skip_reason IS NOT NULL" read
 *
 * Real in-memory SQLite via bun:sqlite (no mocks); applies every migration so
 * the `datasets` table matches production.
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

describe("migration 0043: archive_skip_reason", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("column present, NULL by default", () => {
    insertDataset(db, "on005752");
    const row = db
      .prepare("SELECT archive_skip_reason, archive_status FROM datasets WHERE dataset_id = ?")
      .get("on005752") as { archive_skip_reason: string | null; archive_status: string | null };
    expect(row.archive_skip_reason).toBeNull();
    expect(row.archive_status).toBeNull();
  });

  test("archive-ready 'skipped' UPDATE sets reason + leaves archive_status NULL", () => {
    insertDataset(db, "on005752");
    const r = db
      .prepare(
        `UPDATE datasets
         SET archive_skip_reason = ?, archive_status = NULL, archive_checked_at = datetime('now')
         WHERE dataset_id = ?`,
      )
      .run("dataset 680.0 GB exceeds 100.0 GB archive limit; use direct download", "on005752");
    expect(r.changes).toBe(1);
    const row = db
      .prepare(
        "SELECT archive_skip_reason, archive_status, archive_checked_at FROM datasets WHERE dataset_id = ?",
      )
      .get("on005752") as {
      archive_skip_reason: string;
      archive_status: string | null;
      archive_checked_at: string;
    };
    expect(row.archive_skip_reason).toContain("exceeds");
    expect(row.archive_status).toBeNull();
    expect(row.archive_checked_at).not.toBeNull();
  });

  test("skipped state is distinguishable: reason IS NOT NULL, status NULL (vs absent)", () => {
    insertDataset(db, "on005752"); // skipped (oversized)
    insertDataset(db, "nm000001"); // absent (no archive, under threshold)
    db.prepare(
      "UPDATE datasets SET archive_skip_reason = ?, archive_checked_at = datetime('now') WHERE dataset_id = ?",
    ).run("oversized", "on005752");
    db.prepare("UPDATE datasets SET archive_checked_at = datetime('now') WHERE dataset_id = ?").run(
      "nm000001",
    );

    const skipped = db
      .prepare(
        "SELECT dataset_id FROM datasets WHERE archive_skip_reason IS NOT NULL ORDER BY dataset_id",
      )
      .all() as { dataset_id: string }[];
    expect(skipped.map((r) => r.dataset_id)).toEqual(["on005752"]);

    // 'absent' = checked, no archive, no skip reason, status NULL
    const absent = db
      .prepare(
        "SELECT dataset_id FROM datasets WHERE archive_checked_at IS NOT NULL AND archive_skip_reason IS NULL AND archive_status IS NULL",
      )
      .all() as { dataset_id: string }[];
    expect(absent.map((r) => r.dataset_id)).toEqual(["nm000001"]);
  });

  test("the sweep candidate query exposes file_size/total_files for the skip decision", () => {
    insertDataset(db, "on005752");
    db.prepare("UPDATE datasets SET file_size = ?, total_files = ? WHERE dataset_id = ?").run(
      730_000_000_000,
      11000,
      "on005752",
    );
    const row = db
      .prepare(
        `SELECT dataset_id, file_size, total_files FROM datasets
         WHERE visibility = 'public' AND archive_checked_at IS NULL
         ORDER BY dataset_id LIMIT 1`,
      )
      .get() as { dataset_id: string; file_size: number; total_files: number };
    expect(row.dataset_id).toBe("on005752");
    expect(row.file_size).toBe(730_000_000_000);
    expect(row.total_files).toBe(11000);
  });

  test("archive-ready 'ready' clears a stale skip_reason (size-reduced re-publish)", () => {
    insertDataset(db, "on005752");
    // previously skipped (oversized)
    db.prepare(
      "UPDATE datasets SET archive_skip_reason = 'oversized', archive_checked_at = datetime('now') WHERE dataset_id = ?",
    ).run("on005752");
    // a real zip now lands -> the 'ready' UPDATE must null the stale reason
    db.prepare(
      `UPDATE datasets
       SET archive_status = 'ready', archive_checked_at = datetime('now'),
           archive_size = ?, archive_retry_count = 0, archive_skip_reason = NULL
       WHERE dataset_id = ?`,
    ).run(500, "on005752");
    const row = db
      .prepare(
        "SELECT archive_status, archive_skip_reason, archive_size FROM datasets WHERE dataset_id = ?",
      )
      .get("on005752") as {
      archive_status: string;
      archive_skip_reason: string | null;
      archive_size: number;
    };
    expect(row.archive_status).toBe("ready");
    expect(row.archive_skip_reason).toBeNull();
    expect(row.archive_size).toBe(500);
  });
});
