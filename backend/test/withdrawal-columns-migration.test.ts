/**
 * Integration test for migration 0060_withdrawal_columns.sql (epic #967
 * phase 4, #971).
 *
 * Runs against a real in-memory SQLite database via bun:sqlite (no mocks),
 * applying every migration in order so the schema matches production, then
 * asserting the withdrawal additions:
 *
 *   1. datasets gains withdrawn_at, withdrawn_reason.
 *   2. dataset_versions gains ezid_status.
 *   3. The columns round-trip a populated row (withdrawn) and read back NULL
 *      on an untouched row (never withdrawn).
 *   4. ezid_status is per-version (mirrors the has_hed / data_complete
 *      per-version pattern): one version can be 'unavailable' while another
 *      stays 'public'.
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
    // concept_doi, not the dropped ezid_identifier column (#1182).
    "INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, is_sandbox, concept_doi) VALUES (?, 1, ?, 'public', 0, ?)",
  ).run(datasetId, datasetId, `10.82901/nemar.${datasetId.toLowerCase()}`);
}

describe("migration 0060_withdrawal_columns", () => {
  test("datasets gains withdrawn_at, withdrawn_reason", () => {
    const db = freshDb();
    expect(tableColumns(db, "datasets")).toEqual(
      expect.arrayContaining(["withdrawn_at", "withdrawn_reason"]),
    );
    db.close();
  });

  test("dataset_versions gains ezid_status", () => {
    const db = freshDb();
    expect(tableColumns(db, "dataset_versions")).toEqual(expect.arrayContaining(["ezid_status"]));
    db.close();
  });

  test("withdrawal columns round-trip a populated row", () => {
    const db = freshDb();
    seedDataset(db, "on008115");
    db.prepare(
      "UPDATE datasets SET withdrawn_at = '2026-07-21T00:00:00Z', withdrawn_reason = 'upstream_403', ezid_status = 'unavailable' WHERE dataset_id = ?",
    ).run("on008115");
    const row = db
      .prepare(
        "SELECT withdrawn_at, withdrawn_reason, ezid_status FROM datasets WHERE dataset_id = ?",
      )
      .get("on008115") as {
      withdrawn_at: string;
      withdrawn_reason: string;
      ezid_status: string;
    };
    expect(row.withdrawn_at).toBe("2026-07-21T00:00:00Z");
    expect(row.withdrawn_reason).toBe("upstream_403");
    expect(row.ezid_status).toBe("unavailable");
    db.close();
  });

  test("a never-withdrawn dataset reads back NULL for withdrawn_at/withdrawn_reason", () => {
    const db = freshDb();
    seedDataset(db, "on005279");
    const row = db
      .prepare("SELECT withdrawn_at, withdrawn_reason FROM datasets WHERE dataset_id = ?")
      .get("on005279") as { withdrawn_at: string | null; withdrawn_reason: string | null };
    expect(row.withdrawn_at).toBeNull();
    expect(row.withdrawn_reason).toBeNull();
    db.close();
  });

  test("dataset_versions.ezid_status is per-version (one withdrawn, one still public)", () => {
    const db = freshDb();
    seedDataset(db, "on008115");
    db.prepare(
      "INSERT INTO dataset_versions (dataset_id, version, doi, ezid_status) VALUES (?, '1.0.0', 'doi:10.82901/NEMAR.ON008115.V1.0.0', 'unavailable')",
    ).run("on008115");
    db.prepare(
      "INSERT INTO dataset_versions (dataset_id, version, doi, ezid_status) VALUES (?, '1.1.0', 'doi:10.82901/NEMAR.ON008115.V1.1.0', 'public')",
    ).run("on008115");

    const rows = db
      .prepare(
        "SELECT version, ezid_status FROM dataset_versions WHERE dataset_id = ? ORDER BY version",
      )
      .all("on008115") as { version: string; ezid_status: string }[];
    expect(rows).toEqual([
      { version: "1.0.0", ezid_status: "unavailable" },
      { version: "1.1.0", ezid_status: "public" },
    ]);
    db.close();
  });

  test("a version row inserted without ezid_status reads back NULL (not classified/never withdrawn)", () => {
    const db = freshDb();
    seedDataset(db, "on007816");
    db.prepare(
      "INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', 'doi:10.82901/NEMAR.ON007816.V1.0.0')",
    ).run("on007816");
    const row = db
      .prepare(
        "SELECT ezid_status FROM dataset_versions WHERE dataset_id = ? AND version = '1.0.0'",
      )
      .get("on007816") as { ezid_status: string | null };
    expect(row.ezid_status).toBeNull();
    db.close();
  });
});
