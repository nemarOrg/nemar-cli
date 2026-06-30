/**
 * D1-write tests for HED population (epic #869 phase 2, #871).
 *
 * Runs the REAL `writeDatasetMetadataColumns` / `writeVersionHed` functions
 * against a real in-memory SQLite engine (every migration applied, so the schema
 * matches production) via a thin D1 adapter that forwards to bun:sqlite. No
 * mocks: the SQL and data are real, results come from SQLite executing the
 * statements. Mirrors the `realD1` shim in test/catalog-dual-write.test.ts.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type DatasetMetadataColumns,
  writeDatasetMetadataColumns,
  writeVersionHed,
} from "../src/services/dataset-metadata-columns";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");

function freshDb(): Database {
  const db = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  return db;
}

// Real-engine D1 shim: forwards every call to the underlying bun:sqlite DB.
// Not a mock -- no canned responses; every result comes from SQLite.
function realD1(db: Database): D1Database {
  return {
    prepare(sql: string) {
      const stmt = db.query(sql);
      let bound: unknown[] = [];
      const api = {
        bind(...p: unknown[]) {
          bound = p;
          return api;
        },
        run() {
          const r = stmt.run(...(bound as never[]));
          return Promise.resolve({ success: true, meta: { changes: r.changes } });
        },
        first<T>() {
          return Promise.resolve((stmt.get(...(bound as never[])) as T) ?? null);
        },
        all<T>() {
          return Promise.resolve({ results: stmt.all(...(bound as never[])) as T[] });
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

/** A full DatasetMetadataColumns with everything null except the overrides. */
function cols(partial: Partial<DatasetMetadataColumns>): DatasetMetadataColumns {
  return {
    subject_count: null,
    modalities: null,
    age_min: null,
    age_max: null,
    file_size: null,
    total_files: null,
    tasks: null,
    n_channels: null,
    electrode_system: null,
    has_hed: null,
    hed_version: null,
    ...partial,
  };
}

function seed(db: Database): void {
  db.prepare(
    "INSERT INTO users (id, username, email, github_username, status) VALUES (1, 'alice', 'alice@nemar.org', 'alice', 'approved')",
  ).run();
  db.prepare(
    "INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, is_sandbox) VALUES ('nm000132', 1, 'nm000132', 'public', 0)",
  ).run();
  // Two versions, explicit created_at so "latest" (ORDER BY created_at DESC) is
  // deterministic: v1.1.1 is newer than v1.0.0.
  db.prepare(
    "INSERT INTO dataset_versions (dataset_id, version, doi, created_at) VALUES ('nm000132', 'v1.0.0', 'doi:a', '2026-01-01 00:00:00')",
  ).run();
  db.prepare(
    "INSERT INTO dataset_versions (dataset_id, version, doi, created_at) VALUES ('nm000132', 'v1.1.1', 'doi:b', '2026-02-01 00:00:00')",
  ).run();
}

describe("writeDatasetMetadataColumns HED columns", () => {
  test("writes datasets.has_hed / hed_version", async () => {
    const db = freshDb();
    seed(db);
    await writeDatasetMetadataColumns(
      realD1(db),
      "nm000132",
      cols({ has_hed: 1, hed_version: "8.4.0" }),
    );
    const row = db
      .prepare("SELECT has_hed, hed_version FROM datasets WHERE dataset_id = 'nm000132'")
      .get() as { has_hed: number; hed_version: string };
    expect(row.has_hed).toBe(1);
    expect(row.hed_version).toBe("8.4.0");
    db.close();
  });

  test("COALESCE preserves prior HED when a later write passes null", async () => {
    const db = freshDb();
    seed(db);
    const d1 = realD1(db);
    await writeDatasetMetadataColumns(d1, "nm000132", cols({ has_hed: 1, hed_version: "8.4.0" }));
    // The enrich caller passes no HED -> null inputs must NOT clobber the values.
    await writeDatasetMetadataColumns(d1, "nm000132", cols({ subject_count: 5 }));
    const row = db
      .prepare(
        "SELECT has_hed, hed_version, subject_count FROM datasets WHERE dataset_id = 'nm000132'",
      )
      .get() as { has_hed: number; hed_version: string; subject_count: number };
    expect(row.has_hed).toBe(1);
    expect(row.hed_version).toBe("8.4.0");
    expect(row.subject_count).toBe(5);
    db.close();
  });
});

describe("writeVersionHed", () => {
  test("writes the exact named version, leaving siblings untouched", async () => {
    const db = freshDb();
    seed(db);
    await writeVersionHed(realD1(db), "nm000132", "v1.1.1", 1, "8.4.0");
    const v2 = db
      .prepare(
        "SELECT has_hed, hed_version FROM dataset_versions WHERE dataset_id='nm000132' AND version='v1.1.1'",
      )
      .get() as { has_hed: number | null; hed_version: string | null };
    const v1 = db
      .prepare(
        "SELECT has_hed, hed_version FROM dataset_versions WHERE dataset_id='nm000132' AND version='v1.0.0'",
      )
      .get() as { has_hed: number | null; hed_version: string | null };
    expect(v2.has_hed).toBe(1);
    expect(v2.hed_version).toBe("8.4.0");
    expect(v1.has_hed).toBeNull(); // older version untouched
    expect(v1.hed_version).toBeNull();
    db.close();
  });

  test("null version targets the latest-by-created_at row", async () => {
    const db = freshDb();
    seed(db);
    await writeVersionHed(realD1(db), "nm000132", null, 0, null);
    const v2 = db
      .prepare(
        "SELECT has_hed FROM dataset_versions WHERE dataset_id='nm000132' AND version='v1.1.1'",
      )
      .get() as { has_hed: number | null };
    const v1 = db
      .prepare(
        "SELECT has_hed FROM dataset_versions WHERE dataset_id='nm000132' AND version='v1.0.0'",
      )
      .get() as { has_hed: number | null };
    expect(v2.has_hed).toBe(0); // latest got the write
    expect(v1.has_hed).toBeNull(); // v1.0.0 left alone
    db.close();
  });

  test("direct assignment overwrites (per-version truth, not COALESCE)", async () => {
    const db = freshDb();
    seed(db);
    const d1 = realD1(db);
    await writeVersionHed(d1, "nm000132", "v1.1.1", 1, "8.4.0");
    // A correcting re-probe must be able to overwrite, including back toward 0.
    await writeVersionHed(d1, "nm000132", "v1.1.1", 0, null);
    const v2 = db
      .prepare(
        "SELECT has_hed, hed_version FROM dataset_versions WHERE dataset_id='nm000132' AND version='v1.1.1'",
      )
      .get() as { has_hed: number | null; hed_version: string | null };
    expect(v2.has_hed).toBe(0);
    expect(v2.hed_version).toBeNull();
    db.close();
  });
});
