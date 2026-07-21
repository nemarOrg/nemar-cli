/**
 * D1-write tests for honest-size population (epic #967 Phase 3, #970).
 *
 * Runs the REAL `writeDatasetMetadataColumns` / `writeVersionSize` functions
 * against a real in-memory SQLite engine (every migration applied, so the schema
 * matches production) via a thin D1 adapter that forwards to bun:sqlite. No
 * mocks: the SQL and data are real, results come from SQLite executing the
 * statements. Mirrors hed-write.test.ts / the `realD1` shim in
 * test/catalog-dual-write.test.ts.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type DatasetMetadataColumns,
  writeDatasetMetadataColumns,
  writeVersionSize,
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
    bytes_present: null,
    data_complete: null,
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

describe("writeDatasetMetadataColumns honest-size columns", () => {
  test("writes datasets.file_size / bytes_present / data_complete", async () => {
    const db = freshDb();
    seed(db);
    await writeDatasetMetadataColumns(
      realD1(db),
      "nm000132",
      cols({ file_size: 12_000_000_000, total_files: 400, bytes_present: 36, data_complete: 0 }),
    );
    const row = db
      .prepare(
        "SELECT file_size, total_files, bytes_present, data_complete FROM datasets WHERE dataset_id = 'nm000132'",
      )
      .get() as {
      file_size: number;
      total_files: number;
      bytes_present: number;
      data_complete: number;
    };
    expect(row.file_size).toBe(12_000_000_000);
    expect(row.total_files).toBe(400);
    expect(row.bytes_present).toBe(36);
    expect(row.data_complete).toBe(0);
    db.close();
  });

  test("COALESCE preserves prior honest-size values when a later write passes null", async () => {
    const db = freshDb();
    seed(db);
    const d1 = realD1(db);
    await writeDatasetMetadataColumns(
      d1,
      "nm000132",
      cols({ file_size: 12_000_000_000, total_files: 400, bytes_present: 36, data_complete: 0 }),
    );
    // A later enrich/reindex run without a fresh S3 verify -> null inputs must
    // NOT clobber the values (e.g. S3 lookup failed, or dataComplete unset).
    await writeDatasetMetadataColumns(d1, "nm000132", cols({ subject_count: 5 }));
    const row = db
      .prepare(
        "SELECT file_size, bytes_present, data_complete, subject_count FROM datasets WHERE dataset_id = 'nm000132'",
      )
      .get() as {
      file_size: number;
      bytes_present: number;
      data_complete: number;
      subject_count: number;
    };
    expect(row.file_size).toBe(12_000_000_000);
    expect(row.bytes_present).toBe(36);
    expect(row.data_complete).toBe(0);
    expect(row.subject_count).toBe(5);
    db.close();
  });

  test("data_complete=1 overwrites a prior 0 (COALESCE(1, ...) is 1, not preserve)", async () => {
    const db = freshDb();
    seed(db);
    const d1 = realD1(db);
    await writeDatasetMetadataColumns(
      d1,
      "nm000132",
      cols({ data_complete: 0, bytes_present: 36 }),
    );
    // A re-verify after the missing data is restored -> 1 must win over the
    // stored 0 (0/1 are both non-NULL, so COALESCE does not preserve either way).
    await writeDatasetMetadataColumns(
      d1,
      "nm000132",
      cols({ data_complete: 1, bytes_present: 12_000_000_000 }),
    );
    const row = db
      .prepare("SELECT data_complete, bytes_present FROM datasets WHERE dataset_id = 'nm000132'")
      .get() as { data_complete: number; bytes_present: number };
    expect(row.data_complete).toBe(1);
    expect(row.bytes_present).toBe(12_000_000_000);
    db.close();
  });
});

describe("writeVersionSize", () => {
  test("writes the exact named version, leaving siblings untouched", async () => {
    const db = freshDb();
    seed(db);
    await writeVersionSize(realD1(db), "nm000132", "v1.1.1", {
      file_size: 12_000_000_000,
      total_files: 400,
      bytes_present: 12_000_000_000,
      data_complete: 1,
    });
    const v2 = db
      .prepare(
        "SELECT file_size, bytes_present, data_complete FROM dataset_versions WHERE dataset_id='nm000132' AND version='v1.1.1'",
      )
      .get() as {
      file_size: number | null;
      bytes_present: number | null;
      data_complete: number | null;
    };
    const v1 = db
      .prepare(
        "SELECT file_size, bytes_present, data_complete FROM dataset_versions WHERE dataset_id='nm000132' AND version='v1.0.0'",
      )
      .get() as {
      file_size: number | null;
      bytes_present: number | null;
      data_complete: number | null;
    };
    expect(v2.file_size).toBe(12_000_000_000);
    expect(v2.data_complete).toBe(1);
    expect(v1.file_size).toBeNull(); // older version untouched
    expect(v1.data_complete).toBeNull();
    db.close();
  });

  test("null version targets the latest-by-created_at row", async () => {
    const db = freshDb();
    seed(db);
    await writeVersionSize(realD1(db), "nm000132", null, {
      file_size: 36,
      total_files: 5,
      bytes_present: 36,
      data_complete: 0,
    });
    const v2 = db
      .prepare(
        "SELECT data_complete FROM dataset_versions WHERE dataset_id='nm000132' AND version='v1.1.1'",
      )
      .get() as { data_complete: number | null };
    const v1 = db
      .prepare(
        "SELECT data_complete FROM dataset_versions WHERE dataset_id='nm000132' AND version='v1.0.0'",
      )
      .get() as { data_complete: number | null };
    expect(v2.data_complete).toBe(0); // latest got the write
    expect(v1.data_complete).toBeNull(); // v1.0.0 left alone
    db.close();
  });

  test("direct assignment overwrites (per-version truth, not COALESCE)", async () => {
    const db = freshDb();
    seed(db);
    const d1 = realD1(db);
    await writeVersionSize(d1, "nm000132", "v1.1.1", {
      file_size: 36,
      total_files: 5,
      bytes_present: 36,
      data_complete: 0,
    });
    // A correcting re-verify must be able to overwrite, including toward complete.
    await writeVersionSize(d1, "nm000132", "v1.1.1", {
      file_size: 12_000_000_000,
      total_files: 400,
      bytes_present: 12_000_000_000,
      data_complete: 1,
    });
    const v2 = db
      .prepare(
        "SELECT file_size, bytes_present, data_complete FROM dataset_versions WHERE dataset_id='nm000132' AND version='v1.1.1'",
      )
      .get() as {
      file_size: number | null;
      bytes_present: number | null;
      data_complete: number | null;
    };
    expect(v2.file_size).toBe(12_000_000_000);
    expect(v2.bytes_present).toBe(12_000_000_000);
    expect(v2.data_complete).toBe(1);
    db.close();
  });

  test("returns changes=0 when no matching version row exists", async () => {
    const db = freshDb();
    seed(db);
    const res = await writeVersionSize(realD1(db), "nm999999", "v1.0.0", {
      file_size: 1,
      total_files: 1,
      bytes_present: 1,
      data_complete: 1,
    });
    expect(res.changes).toBe(0);
    db.close();
  });
});
