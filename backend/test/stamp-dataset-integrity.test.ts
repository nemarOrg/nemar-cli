/**
 * D1-write tests for stampDatasetIntegrity (epic #967 Phase 3 follow-up,
 * issue #980).
 *
 * Runs the REAL `stampDatasetIntegrity` against a real in-memory SQLite
 * engine (every migration applied, so the schema matches production) via the
 * shared `realD1` shim (test/helpers/d1.ts) -- no mocks: the SQL and data are
 * real, results come from SQLite executing the statements. Mirrors
 * hed-write.test.ts (writeVersionHed's sibling column-write path).
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { stampDatasetIntegrity } from "../src/services/dataset-metadata-columns";
import type { DatasetVersionIntegrityResult } from "../src/services/import-integrity";
import { freshDb, realD1 } from "./helpers/d1";

/** A full DatasetVersionIntegrityResult with sane defaults, overridden per test. */
function integrity(partial: Partial<DatasetVersionIntegrityResult>): DatasetVersionIntegrityResult {
  return {
    complete: true,
    missingKeys: [],
    zeroByteKeys: [],
    expectedCount: 0,
    presentCount: 0,
    bytesPresent: 0,
    declaredBytes: 0,
    declaredFiles: 0,
    version: null,
    ...partial,
  };
}

function seed(db: Database): void {
  db.prepare(
    "INSERT INTO users (id, username, email, github_username, status) VALUES (1, 'alice', 'alice@nemar.org', 'alice', 'approved')",
  ).run();
  db.prepare(
    "INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, is_sandbox) VALUES ('on002814', 1, 'on002814', 'public', 0)",
  ).run();
  db.prepare(
    "INSERT INTO dataset_versions (dataset_id, version, doi, created_at) VALUES ('on002814', 'v1.0.0', 'doi:a', '2026-01-01 00:00:00')",
  ).run();
}

describe("stampDatasetIntegrity", () => {
  test("complete result: writes dataset_versions FIRST, then datasets, both stamped", async () => {
    const db = freshDb();
    seed(db);
    const d1 = realD1(db);

    const outcome = await stampDatasetIntegrity(
      d1,
      "on002814",
      integrity({
        complete: true,
        version: "v1.0.0",
        declaredBytes: 44909000,
        declaredFiles: 44909,
        bytesPresent: 44909000,
      }),
    );

    expect(outcome).toBe("complete");

    const version = db
      .prepare(
        `SELECT file_size, total_files, bytes_present, data_complete
           FROM dataset_versions WHERE dataset_id='on002814' AND version='v1.0.0'`,
      )
      .get() as {
      file_size: number;
      total_files: number;
      bytes_present: number;
      data_complete: number;
    };
    expect(version.file_size).toBe(44909000);
    expect(version.total_files).toBe(44909);
    expect(version.bytes_present).toBe(44909000);
    expect(version.data_complete).toBe(1);

    const dataset = db
      .prepare(
        `SELECT file_size, total_files, bytes_present, data_complete, data_checked_at
           FROM datasets WHERE dataset_id='on002814'`,
      )
      .get() as {
      file_size: number;
      total_files: number;
      bytes_present: number;
      data_complete: number;
      data_checked_at: string | null;
    };
    expect(dataset.file_size).toBe(44909000);
    expect(dataset.total_files).toBe(44909);
    expect(dataset.bytes_present).toBe(44909000);
    expect(dataset.data_complete).toBe(1);
    expect(dataset.data_checked_at).not.toBeNull();
    db.close();
  });

  test("incomplete result stamps data_complete=0 on both rows", async () => {
    const db = freshDb();
    seed(db);
    const d1 = realD1(db);

    const outcome = await stampDatasetIntegrity(
      d1,
      "on002814",
      integrity({
        complete: false,
        version: "v1.0.0",
        declaredBytes: 1000,
        declaredFiles: 10,
        bytesPresent: 500,
      }),
    );

    expect(outcome).toBe("incomplete");

    const version = db
      .prepare(
        "SELECT data_complete FROM dataset_versions WHERE dataset_id='on002814' AND version='v1.0.0'",
      )
      .get() as { data_complete: number };
    expect(version.data_complete).toBe(0);

    const dataset = db
      .prepare("SELECT data_complete, bytes_present FROM datasets WHERE dataset_id='on002814'")
      .get() as { data_complete: number; bytes_present: number };
    expect(dataset.data_complete).toBe(0);
    expect(dataset.bytes_present).toBe(500);
    db.close();
  });

  test("null integrity (unverifiable) stamps data_checked_at only, preserving an existing classification", async () => {
    const db = freshDb();
    seed(db);
    const d1 = realD1(db);

    // A prior pass already classified the dataset complete.
    await stampDatasetIntegrity(
      d1,
      "on002814",
      integrity({
        complete: true,
        version: "v1.0.0",
        declaredBytes: 500,
        declaredFiles: 5,
        bytesPresent: 500,
      }),
    );

    // This pass's verify threw (or no manifest resolved) -> null, must not
    // clobber the classification just written above.
    const outcome = await stampDatasetIntegrity(d1, "on002814", null);

    expect(outcome).toBe("unknown");
    const dataset = db
      .prepare(
        "SELECT data_complete, file_size, data_checked_at FROM datasets WHERE dataset_id='on002814'",
      )
      .get() as { data_complete: number; file_size: number; data_checked_at: string | null };
    expect(dataset.data_complete).toBe(1); // preserved, not nulled
    expect(dataset.file_size).toBe(500); // preserved
    expect(dataset.data_checked_at).not.toBeNull();
    db.close();
  });

  test("integrity with no resolvable version behaves like null: unknown, checked_at only", async () => {
    const db = freshDb();
    seed(db);
    const d1 = realD1(db);

    const outcome = await stampDatasetIntegrity(
      d1,
      "on002814",
      integrity({ complete: false, version: null }),
    );

    expect(outcome).toBe("unknown");
    const dataset = db
      .prepare("SELECT data_complete, data_checked_at FROM datasets WHERE dataset_id='on002814'")
      .get() as { data_complete: number | null; data_checked_at: string | null };
    expect(dataset.data_complete).toBeNull(); // never classified, stays NULL
    expect(dataset.data_checked_at).not.toBeNull();
    db.close();
  });
});
