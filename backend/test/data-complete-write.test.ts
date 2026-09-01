/**
 * D1-write tests for honest-size population (epic #967 Phase 3, #970).
 *
 * Runs the REAL `writeDatasetMetadataColumns` / `writeVersionSize` functions
 * against a real in-memory SQLite engine (every migration applied, so the schema
 * matches production) via a thin D1 adapter that forwards to bun:sqlite. No
 * mocks: the SQL and data are real, results come from SQLite executing the
 * statements. Mirrors hed-write.test.ts; realD1/freshDb come from the shared
 * helper (backend/test/helpers/d1.ts) rather than a per-file copy.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  type DatasetMetadataColumns,
  computeDatasetMetadataColumns,
  writeDatasetMetadataColumns,
  writeVersionSize,
} from "../src/services/dataset-metadata-columns";
import { freshDb, realD1 } from "./helpers/d1";

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
    sampling_frequency: null,
    power_line_frequency: null,
    eeg_reference: null,
    placement_scheme: null,
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

// Epic #1144 Phase 2b (#1153): the four signal_defaults value columns
// (migration 0071), written by the same COALESCE UPDATE as n_channels/
// electrode_system. Real D1 write, not a hand-copied SQL string -- this
// drives the actual writeDatasetMetadataColumns bind order, so a
// transposition among the four new positional binds (e.g. eeg_reference
// landing in placement_scheme's slot) would surface here as a real
// column-value mismatch, not just a passing type check.
describe("writeDatasetMetadataColumns signal_defaults columns (#1153)", () => {
  test("writes all four columns without transposition", async () => {
    const db = freshDb();
    seed(db);
    await writeDatasetMetadataColumns(
      realD1(db),
      "nm000132",
      cols({
        sampling_frequency: 500,
        power_line_frequency: 60,
        eeg_reference: "average",
        placement_scheme: "extended 10-10% system",
      }),
    );
    const row = db
      .prepare(
        "SELECT sampling_frequency, power_line_frequency, eeg_reference, placement_scheme FROM datasets WHERE dataset_id = 'nm000132'",
      )
      .get() as {
      sampling_frequency: number;
      power_line_frequency: number;
      eeg_reference: string;
      placement_scheme: string;
    };
    // Four DISTINCT values so a positional swap between any two columns
    // (the actual failure mode a transposed bind order produces) is
    // observable -- two columns holding the same value would hide a swap
    // between just those two.
    expect(row.sampling_frequency).toBe(500);
    expect(row.power_line_frequency).toBe(60);
    expect(row.eeg_reference).toBe("average");
    expect(row.placement_scheme).toBe("extended 10-10% system");
    db.close();
  });

  test("COALESCE preserves prior signal_defaults values when a later write passes null", async () => {
    const db = freshDb();
    seed(db);
    const d1 = realD1(db);
    await writeDatasetMetadataColumns(
      d1,
      "nm000132",
      cols({ sampling_frequency: 500, power_line_frequency: 60, eeg_reference: "average" }),
    );
    // A later reindex whose probe found no sidecar this time (nulls for
    // these four fields) must not clobber the previously-probed values --
    // same COALESCE contract as every other column this function writes.
    await writeDatasetMetadataColumns(d1, "nm000132", cols({ subject_count: 5 }));
    const row = db
      .prepare(
        "SELECT sampling_frequency, power_line_frequency, eeg_reference, subject_count FROM datasets WHERE dataset_id = 'nm000132'",
      )
      .get() as {
      sampling_frequency: number;
      power_line_frequency: number;
      eeg_reference: string;
      subject_count: number;
    };
    expect(row.sampling_frequency).toBe(500);
    expect(row.power_line_frequency).toBe(60);
    expect(row.eeg_reference).toBe("average");
    expect(row.subject_count).toBe(5);
    db.close();
  });

  test("does not touch signal_defaults_at -- that stamp is owned only by the sweep", async () => {
    // Migration 0071 / 0055 precedent: writeDatasetMetadataColumns writes
    // the VALUE columns but never the sweep's resumability stamp, so a live
    // reindex populating these columns doesn't make the row look
    // already-swept.
    const db = freshDb();
    seed(db);
    await writeDatasetMetadataColumns(realD1(db), "nm000132", cols({ sampling_frequency: 500 }));
    const row = db
      .prepare("SELECT signal_defaults_at FROM datasets WHERE dataset_id = 'nm000132'")
      .get() as { signal_defaults_at: string | null };
    expect(row.signal_defaults_at).toBeNull();
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

describe("enrich-clobber regression guard (#970, epic #967 Phase 3)", () => {
  // This is the regression test for the SAME clobber class as the #967
  // incident: enrichDataset() (backend/src/services/enrich-dataset.ts) used to
  // thread its own S3-objects sum (s3Stats) into computeDatasetMetadataColumns
  // on every re-enrichment, silently overwriting an honest, manifest-derived
  // file_size/total_files/bytes_present/data_complete back to the annex-blind
  // S3 sum. The fix passes `s3Stats: null` from that call site instead. If a
  // future change "restores" s3Stats there without also threading a real
  // manifestVerification, this test trips: it reproduces the exact enrich-
  // shaped call (treePaths + participantsTsv + s3Stats: null, no
  // manifestVerification) against a row that was previously written with
  // honest values, and asserts those values survive untouched.
  test("enrich-shaped inputs (s3Stats: null, no manifestVerification) leave a prior honest row unchanged", async () => {
    const db = freshDb();
    seed(db);
    const d1 = realD1(db);

    // Seed the row as if reindex/the sweep had already verified it honestly.
    await writeDatasetMetadataColumns(
      d1,
      "nm000132",
      cols({
        file_size: 12_000_000_000,
        total_files: 400,
        bytes_present: 12_000_000_000,
        data_complete: 1,
      }),
    );

    // The exact shape enrichDataset() passes to computeDatasetMetadataColumns:
    // treePaths + participantsTsv, s3Stats explicitly null, no
    // manifestVerification at all (enrichDataset never resolves one).
    const enrichCols = computeDatasetMetadataColumns({
      treePaths: ["sub-01/eeg/sub-01_task-rest_eeg.set"],
      participantsTsv: null,
      s3Stats: null,
    });
    await writeDatasetMetadataColumns(d1, "nm000132", enrichCols);

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
    expect(row.bytes_present).toBe(12_000_000_000);
    expect(row.data_complete).toBe(1);
    db.close();
  });
});
