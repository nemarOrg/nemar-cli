/**
 * Migration 0073_collapse_sweep_stamps (#1183): the 12 sweep bookkeeping
 * stamp columns collapse into one `sweep_stamps` JSON column, taking
 * `datasets` from 92 columns to 81.
 *
 * Real engine, no mocks: every migration file strictly before 0073 is
 * applied to a real bun:sqlite database, rows are seeded covering the fate
 * classes (all 12 stamps set with distinct values; some set; none set),
 * then 0073 is applied STATEMENT AT A TIME (bun's whole-file exec()
 * swallows mid-script statement errors except the last -- see
 * reclaim-column-budget-migration.test.ts, whose splitStatements this
 * mirrors) and the outcome is asserted.
 *
 * This file also pins the two SQLite JSON semantics the entire rewrite
 * stands on, re-derived on the real engine rather than trusted from a plan:
 *
 *  1. json_extract returns SQL NULL for a missing key, an explicit JSON
 *     null, AND a NULL column -- all three shapes mean "never swept", which
 *     is what makes `json_extract(sweep_stamps, '$.x') IS NULL` equivalent
 *     to the old `x IS NULL` candidate predicate.
 *  2. json_set on a NULL column returns NULL, silently discarding the
 *     write -- which is why every production stamp write MUST wrap the
 *     column in COALESCE(sweep_stamps, '{}'). (Per-write persistence is
 *     additionally exercised at each sweep's entry point in
 *     sweep-stamps-candidates.test.ts.)
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");

const COLLAPSE_FILE = "0073_collapse_sweep_stamps.sql";

/** The 12 stamps, in 0073's json_object order. */
const STAMPS = [
  "enrichment_updated_at",
  "metadata_updated_at",
  "archive_checked_at",
  "zarr_checked_at",
  "records_checked_at",
  "citations_updated_at",
  "channel_montage_checked_at",
  "hed_checked_at",
  "data_checked_at",
  "availability_report_at",
  "recording_stats_at",
  "signal_defaults_at",
] as const;

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** Apply every migration strictly before the 0073 collapse. */
function dbBefore0073(): Database {
  const db = new Database(":memory:");
  for (const f of migrationFiles().filter((f) => f < COLLAPSE_FILE)) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
  }
  return db;
}

/**
 * Split a migration file into individual statements. Statement-at-a-time
 * application is load-bearing: bun:sqlite's exec() on a multi-statement
 * string swallows any statement error except the last one's, so exec()ing
 * the whole file would let a failing UPDATE or DROP pass silently. D1
 * applies statements individually and fails loudly; this models that.
 * (0073 has no triggers, so no BEGIN...END handling is needed.)
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current: string[] = [];
  for (const line of sql.split("\n")) {
    const stripped = line.trim();
    if (stripped === "" || stripped.startsWith("--")) continue;
    current.push(line);
    if (stripped.endsWith(";")) {
      statements.push(current.join("\n"));
      current = [];
    }
  }
  if (current.length > 0) statements.push(current.join("\n"));
  return statements;
}

function apply0073(db: Database): void {
  for (const stmt of splitStatements(readFileSync(join(MIGRATIONS_DIR, COLLAPSE_FILE), "utf-8"))) {
    db.exec(stmt);
  }
}

function columnNames(db: Database): string[] {
  return (db.query("PRAGMA table_info(datasets)").all() as { name: string }[]).map((c) => c.name);
}

/** Distinct, recognizable value per stamp so a transposed json_object key
 *  (e.g. hed's value landing under data's key) is observable. Uniform
 *  19-char datetime('now') format, matching all 789 production rows. */
function stampValue(i: number): string {
  return `2026-08-${String(i + 10).padStart(2, "0")} 0${i % 10}:00:00`;
}

function seed(db: Database): void {
  db.exec(`
    INSERT INTO users (id, username, email, github_username, status)
    VALUES (1, 'owner', 'owner@nemar.test', 'owner-gh', 'approved');
  `);
  // Fate class 1: all 12 stamps set, each to a distinct value.
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility,
       ${STAMPS.join(", ")})
     VALUES ('nm000100', 'All Stamps', 1, 'active', 'public',
       ${STAMPS.map(() => "?").join(", ")})`,
  ).run(...STAMPS.map((_, i) => stampValue(i)));
  // Fate class 2: some set (an archive-swept, hed-swept row).
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility,
       archive_checked_at, hed_checked_at)
     VALUES ('nm000101', 'Some Stamps', 1, 'active', 'private',
       '2026-01-02 03:04:05', '2026-02-03 04:05:06')`,
  ).run();
  // Fate class 3: never swept at all.
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility)
     VALUES ('nm000102', 'No Stamps', 1, 'active', 'private')`,
  ).run();
}

function collapsed(): Database {
  const db = dbBefore0073();
  seed(db);
  apply0073(db);
  return db;
}

const extractStamp = (db: Database, id: string, stamp: string): string | null =>
  (
    db
      .query(
        `SELECT json_extract(sweep_stamps, '$.${stamp}') AS v FROM datasets WHERE dataset_id = ?`,
      )
      .get(id) as { v: string | null }
  ).v;

describe("migration 0073: collapse sweep stamps", () => {
  let db: Database;

  beforeEach(() => {
    db = collapsed();
  });

  test("column budget: 92 before, 81 after; the 12 stamp columns are gone", () => {
    const before = dbBefore0073();
    expect(columnNames(before).length).toBe(92);

    const cols = columnNames(db);
    expect(cols.length).toBe(81);
    expect(cols).toContain("sweep_stamps");
    for (const stamp of STAMPS) {
      expect(cols).not.toContain(stamp);
    }
  });

  test("idx_datasets_zarr_checked_at is dropped; the other 22 datasets indexes survive", () => {
    const names = (
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'datasets' AND sql IS NOT NULL",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).not.toContain("idx_datasets_zarr_checked_at");
    expect(names.length).toBe(22);
  });

  test("backfill round-trips every stamp value into its own key, exactly", () => {
    for (const [i, stamp] of STAMPS.entries()) {
      expect(extractStamp(db, "nm000100", stamp)).toBe(stampValue(i));
    }
  });

  test("partially-stamped row: set keys keep their values, unset keys extract NULL", () => {
    expect(extractStamp(db, "nm000101", "archive_checked_at")).toBe("2026-01-02 03:04:05");
    expect(extractStamp(db, "nm000101", "hed_checked_at")).toBe("2026-02-03 04:05:06");
    for (const stamp of STAMPS) {
      if (stamp === "archive_checked_at" || stamp === "hed_checked_at") continue;
      expect(extractStamp(db, "nm000101", stamp)).toBeNull();
    }
  });

  test("never-swept row: backfilled with all 12 keys as JSON null, all extracting NULL", () => {
    const row = db
      .query("SELECT sweep_stamps FROM datasets WHERE dataset_id = 'nm000102'")
      .get() as { sweep_stamps: string | null };
    // The backfill writes EVERY row (JSON null where the stamp was NULL) --
    // simpler to verify than per-row key omission, and semantically
    // identical under json_extract.
    expect(row.sweep_stamps).not.toBeNull();
    for (const stamp of STAMPS) {
      expect(extractStamp(db, "nm000102", stamp)).toBeNull();
    }
  });

  test("null-semantics pin: NULL column, '{}', and explicit JSON null all mean never-swept", () => {
    // Shape 1: a row inserted AFTER the migration -- sweep_stamps NULL.
    db.query(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility)
       VALUES ('nm000103', 'Fresh Row', 1, 'active', 'private')`,
    ).run();
    // Shape 2: an empty stamps object (e.g. after json_remove took the
    // last stamp away).
    db.query("UPDATE datasets SET sweep_stamps = '{}' WHERE dataset_id = 'nm000101'").run();
    // Shape 3: explicit JSON null for the key -- the backfill's own shape
    // for a never-set stamp (nm000102, asserted above, reused here).
    const candidates = (
      db
        .query(
          `SELECT dataset_id FROM datasets
           WHERE json_extract(sweep_stamps, '$.data_checked_at') IS NULL
           ORDER BY dataset_id`,
        )
        .all() as { dataset_id: string }[]
    ).map((r) => r.dataset_id);
    expect(candidates).toEqual(["nm000101", "nm000102", "nm000103"]);
  });

  test("COALESCE pin: json_set on a NULL column discards the write; COALESCE persists it", () => {
    db.query(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility)
       VALUES ('nm000104', 'Coalesce Pin', 1, 'active', 'private')`,
    ).run();
    // The trap: without COALESCE the whole expression is NULL and the stamp
    // silently vanishes -- the row would be a permanent re-sweep candidate.
    db.query(
      "UPDATE datasets SET sweep_stamps = json_set(sweep_stamps, '$.hed_checked_at', datetime('now')) WHERE dataset_id = 'nm000104'",
    ).run();
    expect(
      (
        db.query("SELECT sweep_stamps FROM datasets WHERE dataset_id = 'nm000104'").get() as {
          sweep_stamps: string | null;
        }
      ).sweep_stamps,
    ).toBeNull();
    // The convention every production write follows:
    db.query(
      "UPDATE datasets SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.hed_checked_at', datetime('now')) WHERE dataset_id = 'nm000104'",
    ).run();
    expect(extractStamp(db, "nm000104", "hed_checked_at")).not.toBeNull();
  });

  test("time-comparison pin: extracted stamps keep the 19-char datetime format, so `<` stays chronological", () => {
    // The seeded values are datetime('now')-shaped (19 chars,
    // 'YYYY-MM-DD HH:MM:SS'); json round-tripping must preserve them
    // byte-for-byte, or lexicographic `<` against datetime() output breaks.
    const v = extractStamp(db, "nm000100", "data_checked_at");
    expect(v).toHaveLength(19);
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // A stale stamp is selected by the sweeps' `< datetime('now', ?)`
    // shape; a future one is not. Run through json_extract on the real
    // column, exactly like the rewritten predicates.
    db.query(
      "UPDATE datasets SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.data_checked_at', '2020-01-01 00:00:00') WHERE dataset_id = 'nm000101'",
    ).run();
    db.query(
      "UPDATE datasets SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.data_checked_at', datetime('now')) WHERE dataset_id = 'nm000102'",
    ).run();
    const stale = (
      db
        .query(
          `SELECT dataset_id FROM datasets
           WHERE json_extract(sweep_stamps, '$.data_checked_at') < datetime('now', '-30 days')
           ORDER BY dataset_id`,
        )
        .all() as { dataset_id: string }[]
    ).map((r) => r.dataset_id);
    expect(stale).toEqual(["nm000101"]);
  });

  test("sweep_stamps CHECK rejects invalid JSON but admits NULL", () => {
    expect(() =>
      db
        .query("UPDATE datasets SET sweep_stamps = 'not json' WHERE dataset_id = 'nm000100'")
        .run(),
    ).toThrow();
    db.query("UPDATE datasets SET sweep_stamps = NULL WHERE dataset_id = 'nm000100'").run();
  });
});
