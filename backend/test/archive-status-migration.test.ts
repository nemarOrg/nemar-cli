/**
 * Tests for migration 0036_dataset_archive_columns.sql and the SQL the
 * observability archive instrumentation runs (epic #695): the
 * /webhooks/archive-ready UPDATEs and the admin archive-sweep candidate query.
 *
 * Runs against a real in-memory SQLite database via bun:sqlite (no mocks),
 * applying every migration in order so the `datasets` table matches production.
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

/** SYSTEM_USER_ID sentinel (see src/lib/constants.ts) for folded catalog rows. */
const SYSTEM_USER_ID = -1;

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

function insertDataset(
  db: Database,
  d: {
    dataset_id: string;
    owner_user_id: number;
    visibility: "public" | "private";
    is_sandbox?: number;
    archive_checked_at?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, is_sandbox, archive_checked_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    d.dataset_id,
    d.owner_user_id,
    d.dataset_id,
    d.visibility,
    d.is_sandbox ?? 0,
    d.archive_checked_at ?? null,
  );
}

// The exact candidate query from POST /admin/datasets/archive-sweep.
const SWEEP_CANDIDATES = `SELECT dataset_id FROM datasets
   WHERE owner_user_id != ${SYSTEM_USER_ID}
     AND (is_sandbox = 0 OR is_sandbox IS NULL)
     AND visibility = 'public'
     AND archive_checked_at IS NULL
   ORDER BY dataset_id`;

describe("migration 0036: archive columns", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("adds archive_status / archive_size / archive_checked_at, NULL by default", () => {
    insertDataset(db, { dataset_id: "nm000001", owner_user_id: 1, visibility: "public" });
    const row = db
      .prepare(
        "SELECT archive_status, archive_size, archive_checked_at FROM datasets WHERE dataset_id = ?",
      )
      .get("nm000001") as Record<string, unknown>;
    expect(row.archive_status).toBeNull();
    expect(row.archive_size).toBeNull();
    expect(row.archive_checked_at).toBeNull();
  });

  test("idx_datasets_archive_status exists", () => {
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_datasets_archive_status");
    expect(idx).not.toBeNull();
  });

  test("archive_status CHECK accepts the enum + NULL, rejects others", () => {
    insertDataset(db, { dataset_id: "nm000001", owner_user_id: 1, visibility: "public" });
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

describe("archive-ready webhook UPDATE semantics", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
    insertDataset(db, { dataset_id: "nm000001", owner_user_id: 1, visibility: "public" });
  });

  test("'ready' sets status, size, and checked_at", () => {
    const res = db
      .prepare(
        `UPDATE datasets
         SET archive_status = 'ready', archive_checked_at = datetime('now'), archive_size = ?
         WHERE dataset_id = ?`,
      )
      .run(123456, "nm000001");
    expect(res.changes).toBe(1);
    const row = db
      .prepare(
        "SELECT archive_status, archive_size, archive_checked_at FROM datasets WHERE dataset_id = ?",
      )
      .get("nm000001") as Record<string, unknown>;
    expect(row.archive_status).toBe("ready");
    expect(row.archive_size).toBe(123456);
    expect(row.archive_checked_at).not.toBeNull();
  });

  test("'failed' flips status + stamps checked_at but preserves prior size", () => {
    db.prepare(
      "UPDATE datasets SET archive_status = 'ready', archive_size = ?, archive_checked_at = '2026-01-01 00:00:00' WHERE dataset_id = ?",
    ).run(999, "nm000001");
    const res = db
      .prepare(
        "UPDATE datasets SET archive_status = 'failed', archive_checked_at = datetime('now') WHERE dataset_id = ?",
      )
      .run("nm000001");
    expect(res.changes).toBe(1);
    const row = db
      .prepare("SELECT archive_status, archive_size FROM datasets WHERE dataset_id = ?")
      .get("nm000001") as Record<string, unknown>;
    expect(row.archive_status).toBe("failed");
    expect(row.archive_size).toBe(999); // not erased by the failed rebuild
  });

  test("a callback for an unknown dataset matches 0 rows (the 404 guard)", () => {
    const res = db
      .prepare("UPDATE datasets SET archive_status = 'ready' WHERE dataset_id = ?")
      .run("nm999999");
    expect(res.changes).toBe(0);
  });
});

describe("archive-sweep candidate selection", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
    // Only this one qualifies: managed, public, not sandbox, never checked.
    insertDataset(db, { dataset_id: "nm000001", owner_user_id: 1, visibility: "public" });
    // Excluded for each distinct reason:
    insertDataset(db, { dataset_id: "nm000002", owner_user_id: 1, visibility: "private" });
    insertDataset(db, {
      dataset_id: "xx000001",
      owner_user_id: 1,
      visibility: "public",
      is_sandbox: 1,
    });
    insertDataset(db, {
      dataset_id: "nm000003",
      owner_user_id: SYSTEM_USER_ID,
      visibility: "public",
    });
    insertDataset(db, {
      dataset_id: "nm000004",
      owner_user_id: 1,
      visibility: "public",
      archive_checked_at: "2026-01-01 00:00:00",
    });
  });

  test("selects only managed, public, non-sandbox, unchecked datasets", () => {
    const rows = db.prepare(SWEEP_CANDIDATES).all() as { dataset_id: string }[];
    expect(rows.map((r) => r.dataset_id)).toEqual(["nm000001"]);
  });

  test("a swept dataset drops out of the candidate set on re-run", () => {
    db.prepare(
      "UPDATE datasets SET archive_status = 'ready', archive_size = 10, archive_checked_at = datetime('now') WHERE dataset_id = ?",
    ).run("nm000001");
    const rows = db.prepare(SWEEP_CANDIDATES).all() as { dataset_id: string }[];
    expect(rows).toHaveLength(0);
  });
});
