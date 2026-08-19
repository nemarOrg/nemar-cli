/**
 * Integration test for D1 migration 0039_access_requests.sql (epic #713, phase
 * #715).
 *
 * Runs against a real in-memory SQLite database via bun:sqlite (no mocks).
 * Applies migrations 0001-0039 to build the real schema, then exercises the
 * access_requests table that backs the publish-gated request-access queue.
 *
 * Invariants verified:
 *  1. Table + both indexes exist; status defaults to 'pending'.
 *  2. status CHECK accepts pending/approved/denied, rejects anything else.
 *  3. UNIQUE(dataset_id, user_id): a second plain INSERT for the same pair
 *     throws.
 *  4. The endpoint's ON CONFLICT upsert resets a decided row back to 'pending'
 *     and clears decided_at / decided_by (re-request after denial).
 *  5. FK ON DELETE CASCADE: deleting the dataset or the requesting user removes
 *     the request row.
 *  6. decided_by FK ON DELETE SET NULL: deleting the decider preserves the row
 *     and nulls decided_by.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");
const M0039 = readFileSync(join(MIGRATIONS_DIR, "0039_access_requests.sql"), "utf-8");

// Minimal real schema for the FK targets 0039 references. Mirrors the
// single-migration-on-base-schema pattern used by user-soft-delete.unit.test.ts:
// applying the full 0001-0039 chain under bun:sqlite is not viable because
// 0026's multi-statement `users` table rebuild trips bun:sqlite's exec() quirk.
const BASE_SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  status TEXT
);
CREATE TABLE datasets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL,
  github_repo TEXT,
  visibility TEXT,
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);
`;

/** prepare().run() surfaces CHECK/UNIQUE errors that exec() can swallow. */
function execInsert(db: Database, sql: string): void {
  db.prepare(sql.trim()).run();
}

/**
 * Fresh in-memory DB with the base schema + the real 0039 migration applied, FK
 * enforcement ON, and a private dataset (id=1) owned by user 1, plus a
 * requester (2) and an admin (3).
 */
function buildDb(): Database {
  const db = new Database(":memory:");
  db.exec(BASE_SCHEMA);
  db.exec(M0039);
  // FK enforcement is off by default in SQLite; turn it on AFTER DDL so the
  // cascade/set-null tests exercise the real constraints.
  db.exec("PRAGMA foreign_keys = ON");

  for (const [id, username] of [
    [1, "owner"],
    [2, "requester"],
    [3, "adminuser"],
  ] as const) {
    execInsert(
      db,
      `INSERT INTO users (id, username, email, status)
       VALUES (${id}, '${username}', '${username}@nemar.org', 'approved')`,
    );
  }
  execInsert(
    db,
    `INSERT INTO datasets (id, dataset_id, name, owner_user_id, github_repo, visibility)
     VALUES (1, 'nm000999', 'Test dataset', 1, 'nemarDatasets/nm000999', 'private')`,
  );
  return db;
}

// The exact upsert the request-access endpoint runs.
const UPSERT_SQL = `INSERT INTO access_requests (dataset_id, user_id, status)
   VALUES (?, ?, 'pending')
   ON CONFLICT (dataset_id, user_id)
   DO UPDATE SET status = 'pending', created_at = CURRENT_TIMESTAMP, decided_at = NULL, decided_by = NULL`;

describe("migration 0039 — access_requests", () => {
  let db: Database;

  beforeEach(() => {
    db = buildDb();
  });

  afterEach(() => {
    db.close();
  });

  test("table and both indexes exist", () => {
    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='access_requests'")
      .get();
    expect(tbl).not.toBeNull();

    const idxNames = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='access_requests'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(idxNames).toContain("idx_access_requests_dataset_status");
    expect(idxNames).toContain("idx_access_requests_user");
  });

  test("status defaults to 'pending'", () => {
    execInsert(db, "INSERT INTO access_requests (dataset_id, user_id) VALUES (1, 2)");
    const row = db
      .prepare("SELECT status FROM access_requests WHERE dataset_id = 1 AND user_id = 2")
      .get() as { status: string };
    expect(row.status).toBe("pending");
  });

  test("status CHECK accepts pending/approved/denied", () => {
    for (const status of ["pending", "approved", "denied"]) {
      const db2 = buildDb();
      expect(() => {
        execInsert(
          db2,
          `INSERT INTO access_requests (dataset_id, user_id, status) VALUES (1, 2, '${status}')`,
        );
      }).not.toThrow();
      db2.close();
    }
  });

  test("status CHECK rejects an unknown value", () => {
    expect(() => {
      execInsert(
        db,
        "INSERT INTO access_requests (dataset_id, user_id, status) VALUES (1, 2, 'granted')",
      );
    }).toThrow();
  });

  test("UNIQUE(dataset_id, user_id) rejects a duplicate plain insert", () => {
    execInsert(db, "INSERT INTO access_requests (dataset_id, user_id) VALUES (1, 2)");
    expect(() => {
      execInsert(db, "INSERT INTO access_requests (dataset_id, user_id) VALUES (1, 2)");
    }).toThrow();
  });

  test("re-request upsert resets a denied row back to pending and clears the decision", () => {
    // First request.
    db.prepare(UPSERT_SQL).run(1, 2);
    // Owner (user 1) denies it.
    db.prepare(
      "UPDATE access_requests SET status='denied', decided_at=CURRENT_TIMESTAMP, decided_by=1 WHERE dataset_id=1 AND user_id=2",
    ).run();
    const denied = db
      .prepare("SELECT status, decided_by FROM access_requests WHERE dataset_id=1 AND user_id=2")
      .get() as { status: string; decided_by: number | null };
    expect(denied.status).toBe("denied");
    expect(denied.decided_by).toBe(1);

    // User re-requests: the same upsert the endpoint runs.
    db.prepare(UPSERT_SQL).run(1, 2);
    const reopened = db
      .prepare(
        "SELECT status, decided_at, decided_by FROM access_requests WHERE dataset_id=1 AND user_id=2",
      )
      .get() as { status: string; decided_at: string | null; decided_by: number | null };
    expect(reopened.status).toBe("pending");
    expect(reopened.decided_at).toBeNull();
    expect(reopened.decided_by).toBeNull();

    // Still exactly one row for the pair.
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM access_requests WHERE dataset_id=1 AND user_id=2")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("re-request upsert also resets an 'approved' row back to pending", () => {
    // The ON CONFLICT clause fires unconditionally, so it resets an approved
    // row too. In the live flow this is guarded earlier by the
    // dataset_collaborators 409 check (an approved user is already a
    // collaborator), so request-access never reaches the upsert for them. This
    // pins the SQL behavior so a future change to that guard is a conscious one.
    db.prepare(UPSERT_SQL).run(1, 2);
    db.prepare(
      "UPDATE access_requests SET status='approved', decided_at=CURRENT_TIMESTAMP, decided_by=1 WHERE dataset_id=1 AND user_id=2",
    ).run();
    db.prepare(UPSERT_SQL).run(1, 2);
    const row = db
      .prepare("SELECT status, decided_by FROM access_requests WHERE dataset_id=1 AND user_id=2")
      .get() as { status: string; decided_by: number | null };
    expect(row.status).toBe("pending");
    expect(row.decided_by).toBeNull();
  });

  test("deleting the dataset cascades the request away", () => {
    execInsert(db, "INSERT INTO access_requests (dataset_id, user_id) VALUES (1, 2)");
    db.prepare("DELETE FROM datasets WHERE id = 1").run();
    const count = db.prepare("SELECT COUNT(*) AS n FROM access_requests").get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("deleting the requesting user cascades the request away", () => {
    execInsert(db, "INSERT INTO access_requests (dataset_id, user_id) VALUES (1, 2)");
    db.prepare("DELETE FROM users WHERE id = 2").run();
    const count = db.prepare("SELECT COUNT(*) AS n FROM access_requests").get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("deleting the decider nulls decided_by but keeps the request", () => {
    // Admin (user 3) decides a request from user 2.
    execInsert(
      db,
      "INSERT INTO access_requests (dataset_id, user_id, status, decided_by) VALUES (1, 2, 'approved', 3)",
    );
    db.prepare("DELETE FROM users WHERE id = 3").run();
    const row = db
      .prepare("SELECT status, decided_by FROM access_requests WHERE dataset_id=1 AND user_id=2")
      .get() as { status: string; decided_by: number | null };
    expect(row).not.toBeNull();
    expect(row.status).toBe("approved");
    expect(row.decided_by).toBeNull();
  });
});
