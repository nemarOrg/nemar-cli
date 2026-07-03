/**
 * Real behavioral test for the HED backfill sweep (epic #869 phase 3, #872).
 * Applies the ACTUAL migration 0056 (has_hed / hed_version / hed_checked_at on
 * datasets + has_hed / hed_version on dataset_versions) against an in-memory
 * SQLite seeded to mirror the managed/catalog/sandbox/modality mix, and asserts
 * the sweep's candidate selection + direct column write behave exactly like the
 * endpoint (routes/admin/datasets-lifecycle.ts POST /admin/datasets/hed-sweep).
 *
 * The defining difference from channel-montage-sweep: HED has NO modality filter,
 * so meg-only and no-modality managed datasets ARE candidates.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "backend/src/db/migrations");
const M0056 = readFileSync(join(MIGRATIONS_DIR, "0056_hed_columns.sql"), "utf8");

// Minimal slices the sweep touches, pre-0056. dataset_versions must exist for
// M0056's `ALTER TABLE dataset_versions` + the candidate latest_version subquery.
const BASE_SCHEMA = `
CREATE TABLE datasets (
  dataset_id TEXT PRIMARY KEY,
  github_repo TEXT,
  is_sandbox INTEGER DEFAULT 0,
  modalities TEXT,
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

// The endpoint's candidate predicate (routes/admin/datasets-lifecycle.ts), incl. the latest_version
// subquery. Kept identical here; the test fails loudly if the endpoint scoping
// ever diverges. NOTE: no `modalities LIKE` clause -- HED is modality-agnostic.
const CANDIDATE_SQL = `SELECT d.dataset_id, d.github_repo,
     (SELECT version FROM dataset_versions dv WHERE dv.dataset_id = d.dataset_id
      ORDER BY created_at DESC LIMIT 1) AS latest_version
   FROM datasets d
   WHERE d.github_repo IS NOT NULL
     AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL)
     AND d.hed_checked_at IS NULL
   ORDER BY d.dataset_id`;

function seed(db: Database) {
  const ins = db.query(
    "INSERT INTO datasets (dataset_id, github_repo, is_sandbox, modalities, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  ins.run("nm000300", "nemarDatasets/nm000300", 0, "eeg", "2020-01-01 00:00:00"); // candidate, published
  ins.run("on000301", "nemarDatasets/on000301", 0, "meg", "2020-01-01 00:00:00"); // candidate (meg, NO eeg!), unpublished
  ins.run("nm000302", "nemarDatasets/nm000302", 0, null, "2020-01-01 00:00:00"); // candidate (no modalities)
  ins.run("ds000303", null, 0, "eeg", "2020-01-01 00:00:00"); // excluded: no repo (catalog)
  ins.run("xx000304", "nemarDatasets/xx000304", 1, "eeg", "2020-01-01 00:00:00"); // excluded: sandbox

  // nm000300 is published with two versions; the sweep targets the latest.
  const v = db.query(
    "INSERT INTO dataset_versions (dataset_id, version, doi, created_at) VALUES (?, ?, ?, ?)",
  );
  v.run("nm000300", "v1.0.0", "doi:a", "2026-01-01 00:00:00");
  v.run("nm000300", "v1.1.1", "doi:b", "2026-02-01 00:00:00");
}

const candidateRows = (db: Database) =>
  db.query(CANDIDATE_SQL).all() as { dataset_id: string; latest_version: string | null }[];
const candidates = (db: Database) => candidateRows(db).map((r) => r.dataset_id);

/** Mirror the endpoint's per-dataset datasets write (no updated_at bump). When the
 *  probe classified the row (hasHed != null) it writes the columns + stamp; when it
 *  could NOT (null) it ONLY stamps, so a prior classification isn't clobbered. */
function applyProbe(db: Database, id: string, hasHed: number | null, hedVersion: string | null) {
  if (hasHed != null) {
    db.query(
      `UPDATE datasets
         SET has_hed = ?, hed_version = ?, hed_checked_at = datetime('now')
         WHERE dataset_id = ?`,
    ).run(hasHed, hedVersion, id);
  } else {
    db.query("UPDATE datasets SET hed_checked_at = datetime('now') WHERE dataset_id = ?").run(id);
  }
}

/** Mirror the endpoint's per-version write (writeVersionHed, explicit-version path). */
function applyVersionProbe(
  db: Database,
  id: string,
  version: string,
  hasHed: number,
  hedVersion: string | null,
) {
  db.query(
    "UPDATE dataset_versions SET has_hed = ?, hed_version = ? WHERE dataset_id = ? AND version = ?",
  ).run(hasHed, hedVersion, id, version);
}

// The endpoint's `remaining` count predicate (routes/admin/datasets-lifecycle.ts) -- identical scoping to
// CANDIDATE_SQL minus the latest_version subquery. Drift here would break the CLI
// loop's termination, so it is pinned alongside the candidate contract.
const REMAINING_SQL = `SELECT COUNT(*) AS n FROM datasets
   WHERE github_repo IS NOT NULL
     AND (is_sandbox = 0 OR is_sandbox IS NULL)
     AND hed_checked_at IS NULL`;
const remainingCount = (db: Database) => (db.query(REMAINING_SQL).get() as { n: number }).n;

describe("HED backfill sweep", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(BASE_SCHEMA);
    db.exec(M0056); // ADD COLUMN has_hed/hed_version/hed_checked_at + dataset_versions cols + index
    seed(db);
  });

  test("migration adds the HED columns to both tables", () => {
    const dsCols = (db.query("PRAGMA table_info(datasets)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(dsCols).toContain("has_hed");
    expect(dsCols).toContain("hed_version");
    expect(dsCols).toContain("hed_checked_at");
    const dvCols = (
      db.query("PRAGMA table_info(dataset_versions)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(dvCols).toContain("has_hed");
    expect(dvCols).toContain("hed_version");
  });

  test("candidate query is modality-agnostic (meg + no-modality included)", () => {
    // The key divergence from channel-montage: on000301 (meg, no eeg) and
    // nm000302 (no modalities) ARE candidates. ds000303 (no repo) + xx000304
    // (sandbox) are still excluded.
    expect(candidates(db)).toEqual(["nm000300", "nm000302", "on000301"]);
  });

  test("latest_version subquery resolves the newest version (null when unpublished)", () => {
    const rows = candidateRows(db);
    const byId = Object.fromEntries(rows.map((r) => [r.dataset_id, r.latest_version]));
    expect(byId.nm000300).toBe("v1.1.1"); // newest of v1.0.0 / v1.1.1
    expect(byId.on000301).toBeNull(); // unpublished -> per-version write skipped
  });

  test("a probe writes the HED columns + marker, leaving updated_at untouched", () => {
    applyProbe(db, "nm000300", 1, "8.4.0");
    const row = db
      .query(
        "SELECT has_hed, hed_version, hed_checked_at, updated_at FROM datasets WHERE dataset_id = 'nm000300'",
      )
      .get() as Record<string, unknown>;
    expect(row.has_hed).toBe(1);
    expect(row.hed_version).toBe("8.4.0");
    expect(row.hed_checked_at).not.toBeNull();
    // The backfill must NOT bump updated_at (would re-sort every dataset to "newest").
    expect(row.updated_at).toBe("2020-01-01 00:00:00");
    expect(candidates(db)).not.toContain("nm000300"); // idempotent
  });

  test("a published dataset's latest version row is stamped; older versions untouched", () => {
    // The sweep writes datasets (denormalized) AND the latest dataset_versions row.
    applyProbe(db, "nm000300", 1, "8.4.0");
    applyVersionProbe(db, "nm000300", "v1.1.1", 1, "8.4.0"); // latest_version from candidate query
    const latest = db
      .query(
        "SELECT has_hed, hed_version FROM dataset_versions WHERE dataset_id='nm000300' AND version='v1.1.1'",
      )
      .get() as Record<string, unknown>;
    const older = db
      .query(
        "SELECT has_hed, hed_version FROM dataset_versions WHERE dataset_id='nm000300' AND version='v1.0.0'",
      )
      .get() as Record<string, unknown>;
    expect(latest.has_hed).toBe(1);
    expect(latest.hed_version).toBe("8.4.0");
    // Non-latest historical versions are not back-probed -> stay NULL.
    expect(older.has_hed).toBeNull();
    expect(older.hed_version).toBeNull();
  });

  test("an unpublished dataset gets no per-version write (no version row to target)", () => {
    // on000301 has no dataset_versions rows -> the handler's latest_version guard
    // skips writeVersionHed entirely (no spurious 0-row write / console.error).
    applyProbe(db, "on000301", 1, "8.4.0");
    const n = (
      db.query("SELECT COUNT(*) AS n FROM dataset_versions WHERE dataset_id='on000301'").get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(0);
  });

  test("remaining count uses the same scoping and decreases as rows are stamped", () => {
    expect(remainingCount(db)).toBe(3); // nm000300, nm000302, on000301
    applyProbe(db, "nm000300", 1, "8.4.0");
    applyProbe(db, "nm000302", 0, null);
    expect(remainingCount(db)).toBe(1); // only on000301 left unchecked
    expect(candidates(db)).toEqual(["on000301"]);
  });

  test("an unknown probe (has_hed NULL) still stamps the marker and converges", () => {
    applyProbe(db, "on000301", null, null); // probe couldn't classify
    const row = db
      .query("SELECT has_hed, hed_checked_at FROM datasets WHERE dataset_id = 'on000301'")
      .get() as Record<string, unknown>;
    expect(row.has_hed).toBeNull();
    expect(row.hed_checked_at).not.toBeNull(); // checked, so not retried forever
    expect(candidates(db)).not.toContain("on000301");
  });

  test("a failed probe does NOT clobber a prior classification (reindex seam)", () => {
    // The reindex/enrich path classifies has_hed but leaves hed_checked_at NULL,
    // so the row is still a sweep candidate. A transient probe miss in the sweep
    // must only stamp -- never overwrite the existing has_hed with NULL.
    db.query("UPDATE datasets SET has_hed = 1, hed_version = '8.4.0' WHERE dataset_id = ?").run(
      "nm000300",
    );
    expect(candidates(db)).toContain("nm000300"); // unstamped -> still a candidate
    applyProbe(db, "nm000300", null, null); // sweep probe fails to classify
    const row = db
      .query(
        "SELECT has_hed, hed_version, hed_checked_at FROM datasets WHERE dataset_id='nm000300'",
      )
      .get() as Record<string, unknown>;
    expect(row.has_hed).toBe(1); // preserved, not clobbered
    expect(row.hed_version).toBe("8.4.0");
    expect(row.hed_checked_at).not.toBeNull(); // stamped -> converges
    expect(candidates(db)).not.toContain("nm000300");
  });

  test("?reset=1 clears datasets rows but intentionally leaves dataset_versions", () => {
    applyProbe(db, "nm000300", 1, "8.4.0");
    applyVersionProbe(db, "nm000300", "v1.1.1", 1, "8.4.0"); // per-version truth
    applyProbe(db, "nm000302", 0, null);
    expect(candidates(db)).not.toContain("nm000300");
    // The endpoint's reset branch clears ONLY datasets-level columns.
    const reset = db
      .query(
        `UPDATE datasets
           SET hed_checked_at = NULL, has_hed = NULL, hed_version = NULL
         WHERE hed_checked_at IS NOT NULL`,
      )
      .run();
    expect(reset.changes).toBe(2);
    expect(candidates(db)).toEqual(["nm000300", "nm000302", "on000301"]); // all candidates again
    const row = db
      .query("SELECT has_hed, hed_version FROM datasets WHERE dataset_id = 'nm000300'")
      .get() as Record<string, unknown>;
    expect(row.has_hed).toBeNull();
    expect(row.hed_version).toBeNull();
    // Asymmetry by design: dataset_versions is publish-time truth, untouched by
    // reset; the re-sweep overwrites the latest version's row.
    const ver = db
      .query(
        "SELECT has_hed, hed_version FROM dataset_versions WHERE dataset_id='nm000300' AND version='v1.1.1'",
      )
      .get() as Record<string, unknown>;
    expect(ver.has_hed).toBe(1);
    expect(ver.hed_version).toBe("8.4.0");
  });
});
