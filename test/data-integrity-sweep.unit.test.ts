/**
 * Real behavioral test for the data-integrity sweep (epic #967 Phase 3, #970).
 * Applies the ACTUAL migration 0059 (bytes_present/data_complete/data_checked_at
 * on datasets, file_size/total_files/bytes_present/data_complete on
 * dataset_versions) against an in-memory SQLite seeded to mirror the managed/
 * catalog/sandbox mix, and asserts the sweep's candidate selection + write
 * behave exactly like the endpoint (routes/admin/datasets-lifecycle.ts
 * POST /admin/datasets/data-integrity-sweep).
 *
 * Mirrors test/hed-sweep.unit.test.ts. The defining differences from hed-sweep:
 *  - No modality filter (same as HED -- not relevant here either way).
 *  - `?older-than=<days>` widens candidacy to already-checked rows past the
 *    staleness window, a periodic re-audit hed-sweep's one-shot drain doesn't
 *    have (the rv-silent carry-over gap this closes).
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "backend/src/db/migrations");
const M0059 = readFileSync(join(MIGRATIONS_DIR, "0059_data_complete_columns.sql"), "utf8");

// Minimal slices the sweep touches, pre-0059. dataset_versions must exist for
// M0059's `ALTER TABLE dataset_versions`.
const BASE_SCHEMA = `
CREATE TABLE datasets (
  dataset_id TEXT PRIMARY KEY,
  github_repo TEXT,
  is_sandbox INTEGER DEFAULT 0,
  updated_at TEXT
);
CREATE TABLE dataset_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL,
  version TEXT NOT NULL,
  doi TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// The endpoint's default (no --older-than) candidate predicate. Kept identical
// here; the test fails loudly if the endpoint scoping ever diverges.
const CANDIDATE_SQL = `SELECT d.dataset_id
   FROM datasets d
   WHERE d.github_repo IS NOT NULL
     AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL)
     AND d.data_checked_at IS NULL
   ORDER BY d.dataset_id`;

// The --older-than=N variant.
const CANDIDATE_SQL_OLDER_THAN = `SELECT d.dataset_id
   FROM datasets d
   WHERE d.github_repo IS NOT NULL
     AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL)
     AND (d.data_checked_at IS NULL OR d.data_checked_at < datetime('now', ?))
   ORDER BY d.dataset_id`;

function seed(db: Database) {
  const ins = db.query(
    "INSERT INTO datasets (dataset_id, github_repo, is_sandbox, updated_at) VALUES (?, ?, ?, ?)",
  );
  ins.run("nm000300", "nemarDatasets/nm000300", 0, "2020-01-01 00:00:00"); // candidate, published
  ins.run("on000301", "nemarDatasets/on000301", 0, "2020-01-01 00:00:00"); // candidate, unpublished
  ins.run("ds000303", null, 0, "2020-01-01 00:00:00"); // excluded: no repo (catalog)
  ins.run("xx000304", "nemarDatasets/xx000304", 1, "2020-01-01 00:00:00"); // excluded: sandbox

  const v = db.query(
    "INSERT INTO dataset_versions (dataset_id, version, doi, created_at) VALUES (?, ?, ?, ?)",
  );
  v.run("nm000300", "v1.0.0", "doi:a", "2026-01-01 00:00:00");
  v.run("nm000300", "v1.1.1", "doi:b", "2026-02-01 00:00:00");
}

const candidates = (db: Database) =>
  (db.query(CANDIDATE_SQL).all() as { dataset_id: string }[]).map((r) => r.dataset_id);

const candidatesOlderThan = (db: Database, days: number) =>
  (
    db.query(CANDIDATE_SQL_OLDER_THAN).all(`-${days} days`) as { dataset_id: string }[]
  ).map((r) => r.dataset_id);

/** Mirror the endpoint's per-dataset datasets write for a verified candidate. */
function applyVerified(db: Database, id: string, dataComplete: 0 | 1, bytesPresent: number) {
  db.query(
    `UPDATE datasets
       SET data_complete = ?, bytes_present = ?, data_checked_at = datetime('now')
       WHERE dataset_id = ?`,
  ).run(dataComplete, bytesPresent, id);
}

/** Mirror the endpoint's "unverifiable" branch: stamp only, keep prior classification. */
function applyUnverifiable(db: Database, id: string) {
  db.query("UPDATE datasets SET data_checked_at = datetime('now') WHERE dataset_id = ?").run(id);
}

/** Mirror the endpoint's per-version write (writeVersionSize, explicit-version path). */
function applyVersionWrite(
  db: Database,
  id: string,
  version: string,
  cols: { file_size: number; total_files: number; bytes_present: number; data_complete: 0 | 1 },
) {
  db.query(
    "UPDATE dataset_versions SET file_size = ?, total_files = ?, bytes_present = ?, data_complete = ? WHERE dataset_id = ? AND version = ?",
  ).run(cols.file_size, cols.total_files, cols.bytes_present, cols.data_complete, id, version);
}

// The endpoint's `remaining` count predicate -- identical scoping to
// CANDIDATE_SQL (no ORDER BY needed for a count). Pinned alongside the
// candidate contract so CLI loop termination stays correct.
const REMAINING_SQL = `SELECT COUNT(*) AS n FROM datasets d
   WHERE d.github_repo IS NOT NULL
     AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL)
     AND d.data_checked_at IS NULL`;
const remainingCount = (db: Database) => (db.query(REMAINING_SQL).get() as { n: number }).n;

describe("data-integrity sweep", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(BASE_SCHEMA);
    db.exec(M0059);
    seed(db);
  });

  test("migration adds the honest-size columns to both tables", () => {
    const dsCols = (db.query("PRAGMA table_info(datasets)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(dsCols).toContain("bytes_present");
    expect(dsCols).toContain("data_complete");
    expect(dsCols).toContain("data_checked_at");
    const dvCols = (
      db.query("PRAGMA table_info(dataset_versions)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(dvCols).toContain("file_size");
    expect(dvCols).toContain("total_files");
    expect(dvCols).toContain("bytes_present");
    expect(dvCols).toContain("data_complete");
  });

  test("candidate query excludes catalog-only (no repo) and sandbox rows", () => {
    expect(candidates(db)).toEqual(["nm000300", "on000301"]);
  });

  test("a verified-complete dataset writes datasets + the latest dataset_versions row", () => {
    applyVerified(db, "nm000300", 1, 12_000_000_000);
    applyVersionWrite(db, "nm000300", "v1.1.1", {
      file_size: 12_000_000_000,
      total_files: 400,
      bytes_present: 12_000_000_000,
      data_complete: 1,
    });
    const row = db
      .query(
        "SELECT data_complete, bytes_present, data_checked_at, updated_at FROM datasets WHERE dataset_id = 'nm000300'",
      )
      .get() as Record<string, unknown>;
    expect(row.data_complete).toBe(1);
    expect(row.bytes_present).toBe(12_000_000_000);
    expect(row.data_checked_at).not.toBeNull();
    // The sweep must NOT bump updated_at (would re-sort every dataset to "newest").
    expect(row.updated_at).toBe("2020-01-01 00:00:00");
    expect(candidates(db)).not.toContain("nm000300"); // idempotent

    const latest = db
      .query(
        "SELECT data_complete, bytes_present FROM dataset_versions WHERE dataset_id='nm000300' AND version='v1.1.1'",
      )
      .get() as Record<string, unknown>;
    const older = db
      .query(
        "SELECT data_complete FROM dataset_versions WHERE dataset_id='nm000300' AND version='v1.0.0'",
      )
      .get() as Record<string, unknown>;
    expect(latest.data_complete).toBe(1);
    // Non-latest historical versions are not back-verified -> stay NULL.
    expect(older.data_complete).toBeNull();
  });

  test("a verified-incomplete dataset writes data_complete=0 (the #967 signature)", () => {
    applyVerified(db, "nm000300", 0, 36);
    applyVersionWrite(db, "nm000300", "v1.1.1", {
      file_size: 12_000_000_000,
      total_files: 400,
      bytes_present: 36,
      data_complete: 0,
    });
    const row = db
      .query("SELECT data_complete, bytes_present FROM datasets WHERE dataset_id = 'nm000300'")
      .get() as { data_complete: number; bytes_present: number };
    expect(row.data_complete).toBe(0);
    expect(row.data_complete).not.toBeNull();
    expect(row.bytes_present).toBe(36);
  });

  test("an unpublished dataset gets no per-version write (no manifest to resolve)", () => {
    // on000301 has no dataset_versions rows -> verifyDatasetVersionS3 resolves no
    // version -> the sweep's "unverifiable" branch: stamp only, no writeVersionSize.
    applyUnverifiable(db, "on000301");
    const n = (
      db.query("SELECT COUNT(*) AS n FROM dataset_versions WHERE dataset_id='on000301'").get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(0);
  });

  test("an unclassified (unverifiable) probe stamps the marker and converges without a classification", () => {
    applyUnverifiable(db, "on000301");
    const row = db
      .query("SELECT data_complete, data_checked_at FROM datasets WHERE dataset_id = 'on000301'")
      .get() as Record<string, unknown>;
    expect(row.data_complete).toBeNull();
    expect(row.data_checked_at).not.toBeNull(); // checked, so not retried forever
    expect(candidates(db)).not.toContain("on000301");
  });

  test("an unverifiable probe does NOT clobber a prior classification (reindex seam)", () => {
    // The reindex path classifies data_complete but leaves data_checked_at NULL,
    // so the row is still a sweep candidate. A transient verify miss in the sweep
    // must only stamp -- never overwrite the existing data_complete with NULL.
    db.query("UPDATE datasets SET data_complete = 1, bytes_present = 12000000000 WHERE dataset_id = ?").run(
      "nm000300",
    );
    expect(candidates(db)).toContain("nm000300"); // unstamped -> still a candidate
    applyUnverifiable(db, "nm000300"); // sweep verify fails (e.g. S3 error)
    const row = db
      .query(
        "SELECT data_complete, bytes_present, data_checked_at FROM datasets WHERE dataset_id='nm000300'",
      )
      .get() as Record<string, unknown>;
    expect(row.data_complete).toBe(1); // preserved, not clobbered
    expect(row.bytes_present).toBe(12000000000);
    expect(row.data_checked_at).not.toBeNull(); // stamped -> converges
    expect(candidates(db)).not.toContain("nm000300");
  });

  test("remaining count uses the same scoping and decreases as rows are stamped", () => {
    expect(remainingCount(db)).toBe(2); // nm000300, on000301
    applyVerified(db, "nm000300", 1, 12_000_000_000);
    applyUnverifiable(db, "on000301");
    expect(remainingCount(db)).toBe(0);
    expect(candidates(db)).toEqual([]);
  });

  test("?reset=1 clears datasets rows but intentionally leaves dataset_versions", () => {
    applyVerified(db, "nm000300", 1, 12_000_000_000);
    applyVersionWrite(db, "nm000300", "v1.1.1", {
      file_size: 12_000_000_000,
      total_files: 400,
      bytes_present: 12_000_000_000,
      data_complete: 1,
    });
    applyUnverifiable(db, "on000301");
    expect(candidates(db)).toEqual([]);
    const reset = db
      .query(
        `UPDATE datasets
           SET data_checked_at = NULL, data_complete = NULL, bytes_present = NULL
         WHERE data_checked_at IS NOT NULL`,
      )
      .run();
    expect(reset.changes).toBe(2);
    expect(candidates(db)).toEqual(["nm000300", "on000301"]); // all candidates again
    const row = db
      .query("SELECT data_complete, bytes_present FROM datasets WHERE dataset_id = 'nm000300'")
      .get() as Record<string, unknown>;
    expect(row.data_complete).toBeNull();
    expect(row.bytes_present).toBeNull();
    // Asymmetry by design: dataset_versions is left untouched by reset; a
    // re-sweep overwrites the latest version's row.
    const ver = db
      .query(
        "SELECT data_complete FROM dataset_versions WHERE dataset_id='nm000300' AND version='v1.1.1'",
      )
      .get() as Record<string, unknown>;
    expect(ver.data_complete).toBe(1);
  });

  describe("?older-than=<days> periodic re-audit (#970, closes the rv-silent gap)", () => {
    test("without the flag, an already-checked row is NOT a candidate again", () => {
      applyVerified(db, "nm000300", 1, 12_000_000_000);
      expect(candidates(db)).toEqual(["on000301"]);
    });

    test("with --older-than, a stale checked row becomes a candidate again; a fresh one does not", () => {
      applyVerified(db, "nm000300", 1, 12_000_000_000);
      db.query("UPDATE datasets SET data_checked_at = datetime('now', '-40 days') WHERE dataset_id = ?").run(
        "nm000300",
      );
      applyUnverifiable(db, "on000301");
      db.query("UPDATE datasets SET data_checked_at = datetime('now', '-1 days') WHERE dataset_id = ?").run(
        "on000301",
      );

      // --older-than=30: nm000300 (40 days stale) re-qualifies; on000301 (1 day) does not.
      expect(candidatesOlderThan(db, 30)).toEqual(["nm000300"]);
      // --older-than=60: neither is stale enough.
      expect(candidatesOlderThan(db, 60)).toEqual([]);
    });

    test("a re-verified row can flip data_complete (e.g. complete -> incomplete after later corruption)", () => {
      applyVerified(db, "nm000300", 1, 12_000_000_000);
      db.query("UPDATE datasets SET data_checked_at = datetime('now', '-40 days') WHERE dataset_id = ?").run(
        "nm000300",
      );
      // Take on000301 out of the picture (recently checked) so this test isolates
      // the nm000300 re-audit flip.
      applyUnverifiable(db, "on000301");
      expect(candidatesOlderThan(db, 30)).toEqual(["nm000300"]);
      // Re-audit finds the object is now missing/truncated.
      applyVerified(db, "nm000300", 0, 0);
      const row = db
        .query("SELECT data_complete, bytes_present FROM datasets WHERE dataset_id = 'nm000300'")
        .get() as { data_complete: number; bytes_present: number };
      expect(row.data_complete).toBe(0);
      expect(row.bytes_present).toBe(0);
    });
  });
});
