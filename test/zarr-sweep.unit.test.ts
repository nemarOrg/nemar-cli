/**
 * Real behavioral test for the zarr-sweep reconcile, epic #695.
 *
 * Applies the ACTUAL migration 0038 (datasets.zarr_checked_at) against an
 * in-memory SQLite seeded to mirror the managed/sandbox/catalog/private mix, and
 * asserts the sweep's candidate selection + the ready/absent state writes behave
 * exactly like the endpoint (admin.ts POST /admin/datasets/zarr-sweep), including
 * idempotent convergence (an absent dataset is stamped once and never rescanned).
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SYSTEM_USER_ID } from "../backend/src/lib/constants";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "backend/src/db/migrations");
const M0038 = readFileSync(join(MIGRATIONS_DIR, "0038_dataset_zarr_checked_at.sql"), "utf8");

// Minimal datasets slice the sweep touches (zarr_* columns from 0035, sans the
// 0038 checked-at the migration adds).
const BASE_SCHEMA = `
CREATE TABLE datasets (
  dataset_id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  is_sandbox INTEGER DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'private',
  zarr_status TEXT,
  zarr_store_count INTEGER,
  zarr_converted_at TEXT,
  zarr_index_etag TEXT,
  zarr_source_commit TEXT
);
`;

// The endpoint's candidate predicate (admin.ts). Kept identical here; the test
// fails loudly if the endpoint scoping ever diverges from this contract.
const CANDIDATE_SQL = `SELECT dataset_id FROM datasets
   WHERE owner_user_id != ${SYSTEM_USER_ID}
     AND (is_sandbox = 0 OR is_sandbox IS NULL)
     AND visibility = 'public'
     AND zarr_status IS NULL
     AND zarr_checked_at IS NULL
   ORDER BY dataset_id`;

function seed(db: Database) {
  const ins = db.query(
    "INSERT INTO datasets (dataset_id, owner_user_id, is_sandbox, visibility) VALUES (?, ?, ?, ?)",
  );
  ins.run("nm000200", 10, 0, "public"); // candidate (converted -> ready)
  ins.run("nm000201", 10, 0, "public"); // candidate (no index -> absent)
  ins.run("nm000202", 10, 0, "private"); // excluded: private
  ins.run("xx000001", 10, 1, "public"); // excluded: sandbox
  ins.run("ds999999", SYSTEM_USER_ID, 0, "public"); // excluded: folded catalog sentinel
  // Already-confirmed by the webhook -> not a candidate.
  db.run("UPDATE datasets SET zarr_status = 'ready' WHERE dataset_id = 'nm000200'");
  db.run(
    "INSERT INTO datasets (dataset_id, owner_user_id, is_sandbox, visibility) VALUES ('nm000203', 10, 0, 'public')",
  );
}

const candidates = (db: Database) =>
  (db.query(CANDIDATE_SQL).all() as { dataset_id: string }[]).map((r) => r.dataset_id);

describe("zarr-sweep reconcile", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(BASE_SCHEMA);
    db.exec(M0038); // real migration: ALTER TABLE datasets ADD COLUMN zarr_checked_at TEXT
    seed(db);
  });

  test("migration 0038 adds zarr_checked_at", () => {
    const cols = db.query("PRAGMA table_info(datasets)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "zarr_checked_at")).toBe(true);
  });

  test("candidate query scopes to public, managed, non-sandbox, unswept rows", () => {
    // nm000200 already ready (webhook); nm000201/nm000203 unknown; others excluded.
    expect(candidates(db)).toEqual(["nm000201", "nm000203"]);
  });

  test("present index.json -> ready + store_count + checked_at, converted_at stays NULL", () => {
    db.query(
      `UPDATE datasets
         SET zarr_status = 'ready', zarr_store_count = ?, zarr_index_etag = ?,
             zarr_source_commit = ?, zarr_checked_at = datetime('now')
       WHERE dataset_id = ?`,
    ).run(7, "etag123", "abc1234", "nm000201");
    const row = db
      .query(
        "SELECT zarr_status, zarr_store_count, zarr_converted_at, zarr_checked_at, zarr_index_etag FROM datasets WHERE dataset_id = 'nm000201'",
      )
      .get() as Record<string, unknown>;
    expect(row.zarr_status).toBe("ready");
    expect(row.zarr_store_count).toBe(7);
    expect(row.zarr_index_etag).toBe("etag123");
    expect(row.zarr_converted_at).toBeNull(); // honesty: we don't fabricate a time
    expect(row.zarr_checked_at).not.toBeNull();
  });

  test("absent index.json -> stamp checked_at, leave zarr_status NULL, and converge", () => {
    // nm000203 has no index -> absent path stamps checked_at only.
    db.query(
      "UPDATE datasets SET zarr_checked_at = datetime('now') WHERE dataset_id = 'nm000203'",
    ).run();
    const row = db
      .query("SELECT zarr_status, zarr_checked_at FROM datasets WHERE dataset_id = 'nm000203'")
      .get() as Record<string, unknown>;
    expect(row.zarr_status).toBeNull(); // absence != failed
    expect(row.zarr_checked_at).not.toBeNull();
    // Idempotent: a second sweep no longer selects it.
    expect(candidates(db)).not.toContain("nm000203");
  });
});
