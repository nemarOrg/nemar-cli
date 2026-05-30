/**
 * Phase 5 tests (#646 / #651): the nemar_catalog dual-write is gated on the
 * READ_FROM_DATASETS flag. Where reads moved to `datasets` (flag on), the cache
 * write is skipped; where they haven't (flag off), the cache stays fresh.
 * Real bun:sqlite, no mocks.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importCatalogRecords } from "../backend/src/services/catalog-sync";

const MIG = join(import.meta.dir, "..", "backend/src/db/migrations");

function realD1(db: Database): D1Database {
  const make = (q: string) => {
    const stmt = db.query(q);
    let bound: unknown[] = [];
    const api = {
      bind(...p: unknown[]) {
        bound = p;
        return api;
      },
      run() {
        const r = stmt.run(...(bound as never[]));
        return Promise.resolve({
          success: true,
          meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) },
        });
      },
      first<T>() {
        return Promise.resolve((stmt.get(...(bound as never[])) as T) ?? null);
      },
      all<T>() {
        return Promise.resolve({ results: stmt.all(...(bound as never[])) as T[] });
      },
    };
    return api;
  };
  return {
    prepare: make,
    batch: (stmts: Array<{ run: () => Promise<unknown> }>) =>
      Promise.all(stmts.map((s) => s.run())),
  } as unknown as D1Database;
}

const SCHEMA = `
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, email TEXT NOT NULL UNIQUE,
  password_hash TEXT, github_username TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','approved','revoked')),
  email_verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  signup_source TEXT NOT NULL DEFAULT 'cli' CHECK (signup_source IN ('cli','web')));
CREATE TABLE datasets (id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  description TEXT, owner_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleted')),
  github_repo TEXT, concept_doi TEXT, latest_version_doi TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_sandbox INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  enrichment_json TEXT, source TEXT, source_id TEXT, nemar_sync_status TEXT,
  subject_count INTEGER, modalities TEXT, age_min REAL, age_max REAL, file_size INTEGER,
  total_files INTEGER, tasks TEXT, FOREIGN KEY (owner_user_id) REFERENCES users(id));
CREATE TABLE nemar_catalog (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, modalities TEXT,
  participants INTEGER DEFAULT 0, age_min INTEGER DEFAULT 0, age_max INTEGER DEFAULT 0, tasks TEXT,
  authors TEXT, doi TEXT, license TEXT, bids_version TEXT, file_size INTEGER DEFAULT 0,
  file_size_formatted TEXT, total_files INTEGER DEFAULT 0, sessions_count INTEGER DEFAULT 0,
  latest_version TEXT, publish_date TEXT, created_date TEXT, uploader TEXT, readme TEXT,
  source TEXT NOT NULL DEFAULT 'nemar.org', source_id TEXT, is_processed INTEGER DEFAULT 0,
  search_text TEXT, synced_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE catalog_sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT, records_synced INTEGER DEFAULT 0, records_indexed INTEGER DEFAULT 0, errors TEXT,
  status TEXT NOT NULL DEFAULT 'running');
`;

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  db.exec(readFileSync(join(MIG, "0027_consolidation_columns_and_sentinel.sql"), "utf8"));
  return db;
}

// biome-ignore lint/suspicious/noExplicitAny: minimal NemarCatalogRecord for tests
function rec(id: string): any {
  return {
    id,
    name: `Catalog ${id}`,
    created: "2022-01-01",
    uploader: "OpenNeuro",
    latestSnapshot: "1.0.0",
    publishDate: "2022-02-02",
    sessionsNum: 1,
    file_size: 100,
    byte_size_format: "100 B",
    totalFiles: 5,
    participants: 9,
    age_min: 0,
    age_max: 0,
    BIDSVersion: "1.8.0",
    License: "CC0",
    Authors: "Author",
    DatasetDOI: "doi:10/x",
    tasks: "rest",
    modalities: "eeg",
    readme: "readme",
    local_dataset: 0,
    processed: 0,
  };
}

const count = (db: Database, sql: string) => (db.query(sql).get() as { n: number }).n;

describe("catalog ingest dual-write gating", () => {
  test("flag ON: folds into datasets ONLY, skips the nemar_catalog cache write", async () => {
    const db = freshDb();
    await importCatalogRecords(realD1(db), [rec("ds000111")], undefined, undefined, true);
    expect(count(db, "SELECT COUNT(*) AS n FROM nemar_catalog")).toBe(0); // cache write skipped
    const folded = db
      .query("SELECT owner_user_id FROM datasets WHERE dataset_id='ds000111'")
      .get() as { owner_user_id: number } | null;
    expect(folded?.owner_user_id).toBe(-1); // folded into datasets
  });

  test("flag OFF: writes the nemar_catalog cache AND folds into datasets", async () => {
    const db = freshDb();
    await importCatalogRecords(realD1(db), [rec("ds000222")], undefined, undefined, false);
    expect(count(db, "SELECT COUNT(*) AS n FROM nemar_catalog WHERE id='ds000222'")).toBe(1); // cache kept
    expect(count(db, "SELECT COUNT(*) AS n FROM datasets WHERE dataset_id='ds000222'")).toBe(1); // also folded
  });
});

describe("Phase 5 wiring (source pins)", () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

  test("enrich + reindex gate the nemar_catalog mirror on the flag", () => {
    for (const f of [
      "backend/src/services/enrich-dataset.ts",
      "backend/src/services/dataset-reindex.ts",
    ]) {
      const src = read(f);
      // The cache mirror is now behind the flag check...
      expect(src).toMatch(/if \(!isReadFromDatasetsEnabled\(env\)\)/);
      // ...while the datasets write + re-embed stay unconditional.
      expect(src).toContain("reembedDatasetVector(");
    }
    expect(read("backend/src/services/enrich-dataset.ts")).toContain("writeDatasetCatalogFields(");
    expect(read("backend/src/services/dataset-reindex.ts")).toContain("writeDatasetCatalogFields(");
  });

  test("admin /catalog/sync passes the flag to both catalog-sync entry points", () => {
    const admin = read("backend/src/routes/admin.ts");
    expect(
      (admin.match(/isReadFromDatasetsEnabled\(c\.env\)/g) || []).length,
    ).toBeGreaterThanOrEqual(2);
  });
});
