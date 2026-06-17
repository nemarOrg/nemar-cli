/**
 * #774: /webhooks/zarr-ready persists per-dataset conversion-failure detail so
 * the observability dashboard can render a live failures table.
 *
 * Two parts, no mocks:
 *  - zarrFailureColumns(): the pure derivation of the failure columns from the
 *    callback body (clean / partial / total-failure / garbage inputs).
 *  - migration 0046 + the exact UPDATE SQL the handler runs, against a real
 *    bun:sqlite datasets table: a partial 'ready' and a total 'failed' both
 *    record the detail; a clean 'ready' clears zarr_failed_at.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zarrFailureColumns } from "../backend/src/routes/webhooks";

describe("zarrFailureColumns (#774)", () => {
  test("clean run: no errors -> cleared, hadErrors false", () => {
    const f = zarrFailureColumns({ errors: 0, data_failures: [] });
    expect(f).toEqual({
      errors: 0,
      failureCount: 0,
      deterministic: 0,
      dataFailuresJson: null,
      hadErrors: false,
    });
  });

  test("partial run: typed data failures -> JSON + counts, not yet terminal", () => {
    const df = [{ path: "sub-01_meg.fif", code: "maxshield", reason: "needs MaxFilter" }];
    const f = zarrFailureColumns({
      errors: 3,
      failure_count: 1,
      deterministic: false,
      data_failures: df,
    });
    expect(f.errors).toBe(3);
    expect(f.failureCount).toBe(1);
    expect(f.deterministic).toBe(0);
    expect(JSON.parse(f.dataFailuresJson as string)).toEqual(df);
    expect(f.hadErrors).toBe(true);
  });

  test("total deterministic failure -> deterministic=1", () => {
    const df = [
      { path: "a.fif", code: "maxshield" },
      { path: "b.fif", code: "maxshield" },
    ];
    const f = zarrFailureColumns({ errors: 2, deterministic: true, data_failures: df });
    expect(f.deterministic).toBe(1);
    // failure_count defaults to data_failures length when omitted.
    expect(f.failureCount).toBe(2);
    expect(f.hadErrors).toBe(true);
  });

  test("garbage / missing fields default safely (always-200 contract)", () => {
    expect(zarrFailureColumns({})).toEqual({
      errors: 0,
      failureCount: 0,
      deterministic: 0,
      dataFailuresJson: null,
      hadErrors: false,
    });
    const f = zarrFailureColumns({
      errors: Number.NaN,
      failure_count: -5,
      // @ts-expect-error deliberately wrong shape
      data_failures: "nope",
      // @ts-expect-error deliberately wrong shape
      deterministic: "true",
    });
    expect(f.errors).toBe(0);
    expect(f.failureCount).toBe(0);
    expect(f.deterministic).toBe(0); // only boolean true counts
    expect(f.dataFailuresJson).toBeNull();
  });

  test("failure_count is clamped to total errors (data failures are a subset)", () => {
    // Converter bug / missing failure_count must not render "3 data of 1 error".
    expect(zarrFailureColumns({ errors: 1, failure_count: 3 }).failureCount).toBe(1);
    expect(
      zarrFailureColumns({ errors: 1, data_failures: [{ code: "a" }, { code: "b" }] }).failureCount,
    ).toBe(1);
  });

  test("data_failures items are sanitized to known fields + length-capped", () => {
    const f = zarrFailureColumns({
      errors: 2,
      data_failures: [
        { path: "p", code: "c", reason: "r", junk: { huge: "x".repeat(99999) } },
        "not-an-object",
        { code: "x".repeat(200) },
      ],
    });
    const parsed = JSON.parse(f.dataFailuresJson as string);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({ path: "p", code: "c", reason: "r" }); // junk dropped
    expect(parsed[1]).toEqual({}); // non-object -> empty
    expect(parsed[2].code.length).toBe(64); // capped
  });
});

describe("migration 0046 + zarr-ready handler SQL", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    // Minimal datasets slice the zarr-ready UPDATEs touch (zarr_* columns from
    // 0035/0038), then apply the ACTUAL 0046 migration on top.
    db.run(`
      CREATE TABLE datasets (
        dataset_id TEXT PRIMARY KEY,
        zarr_status TEXT,
        zarr_converted_at TEXT,
        zarr_store_count INTEGER,
        zarr_index_etag TEXT,
        zarr_source_commit TEXT,
        zarr_checked_at TEXT
      );
    `);
    const m0046 = readFileSync(
      join(import.meta.dir, "..", "backend/src/db/migrations/0046_dataset_zarr_failures.sql"),
      "utf8",
    );
    db.run(m0046);
    db.run("INSERT INTO datasets (dataset_id, zarr_status) VALUES ('on007523', NULL)");
  });

  const READY_SQL = `UPDATE datasets
     SET zarr_status='ready', zarr_converted_at=datetime('now'), zarr_store_count=?,
         zarr_index_etag=?, zarr_source_commit=?, zarr_errors=?, zarr_failure_count=?,
         zarr_deterministic=?, zarr_data_failures=?,
         zarr_failed_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END
     WHERE dataset_id=?`;
  const FAILED_SQL = `UPDATE datasets
     SET zarr_status='failed', zarr_errors=?, zarr_failure_count=?, zarr_deterministic=?,
         zarr_data_failures=?, zarr_failed_at=datetime('now')
     WHERE dataset_id=?`;
  const CONVERTING_SQL = `UPDATE datasets
     SET zarr_status='pending', zarr_errors=NULL, zarr_failure_count=NULL,
         zarr_deterministic=NULL, zarr_data_failures=NULL, zarr_failed_at=NULL
     WHERE dataset_id=?`;
  const row = () =>
    db.query("SELECT * FROM datasets WHERE dataset_id='on007523'").get() as Record<string, unknown>;

  test("migration adds the 5 failure columns + the index", () => {
    const cols = (db.query("PRAGMA table_info(datasets)").all() as { name: string }[]).map(
      (r) => r.name,
    );
    for (const c of [
      "zarr_errors",
      "zarr_failure_count",
      "zarr_deterministic",
      "zarr_data_failures",
      "zarr_failed_at",
    ]) {
      expect(cols).toContain(c);
    }
    const idx = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_datasets_zarr_failed_at'",
      )
      .get();
    expect(idx).toBeTruthy();
  });

  test("partial ready run records detail + stamps zarr_failed_at", () => {
    const f = zarrFailureColumns({
      errors: 2,
      failure_count: 2,
      deterministic: false,
      data_failures: [{ path: "a.fif", code: "maxshield" }],
    });
    db.run(READY_SQL, [
      5,
      "etag",
      "abc123",
      f.errors,
      f.failureCount,
      f.deterministic,
      f.dataFailuresJson,
      f.hadErrors ? 1 : 0,
      "on007523",
    ]);
    const r = row();
    expect(r.zarr_status).toBe("ready");
    expect(r.zarr_store_count).toBe(5);
    expect(r.zarr_errors).toBe(2);
    expect(r.zarr_deterministic).toBe(0);
    expect(JSON.parse(r.zarr_data_failures as string)).toHaveLength(1);
    expect(r.zarr_failed_at).not.toBeNull();
  });

  test("total failed run records deterministic detail", () => {
    const f = zarrFailureColumns({
      errors: 4,
      deterministic: true,
      data_failures: [{ code: "maxshield" }],
    });
    db.run(FAILED_SQL, [f.errors, f.failureCount, f.deterministic, f.dataFailuresJson, "on007523"]);
    const r = row();
    expect(r.zarr_status).toBe("failed");
    expect(r.zarr_errors).toBe(4);
    expect(r.zarr_deterministic).toBe(1);
    expect(r.zarr_failed_at).not.toBeNull();
  });

  test("converting signal sets pending (Processing) + clears prior failure detail", () => {
    // A dataset that previously failed, now being re-converted: the in-progress
    // signal flips it to 'pending' (the dashboard's Processing tile) and clears
    // the stale failure detail so it doesn't show as failed while converting.
    const fail = zarrFailureColumns({ errors: 3, deterministic: false });
    db.run(FAILED_SQL, [
      fail.errors,
      fail.failureCount,
      fail.deterministic,
      fail.dataFailuresJson,
      "on007523",
    ]);
    expect(row().zarr_status).toBe("failed");

    db.run(CONVERTING_SQL, ["on007523"]);
    const r = row();
    expect(r.zarr_status).toBe("pending");
    expect(r.zarr_errors).toBeNull();
    expect(r.zarr_data_failures).toBeNull();
    expect(r.zarr_failed_at).toBeNull();
  });

  test("clean ready run clears zarr_failed_at", () => {
    // First fail, then a clean reconvert.
    const fail = zarrFailureColumns({ errors: 4, deterministic: true });
    db.run(FAILED_SQL, [
      fail.errors,
      fail.failureCount,
      fail.deterministic,
      fail.dataFailuresJson,
      "on007523",
    ]);
    expect(row().zarr_failed_at).not.toBeNull();

    const ok = zarrFailureColumns({ errors: 0, data_failures: [] });
    db.run(READY_SQL, [
      9,
      "etag2",
      "def456",
      ok.errors,
      ok.failureCount,
      ok.deterministic,
      ok.dataFailuresJson,
      ok.hadErrors ? 1 : 0,
      "on007523",
    ]);
    const r = row();
    expect(r.zarr_status).toBe("ready");
    expect(r.zarr_errors).toBe(0);
    expect(r.zarr_failed_at).toBeNull();
    expect(r.zarr_data_failures).toBeNull();
  });
});
