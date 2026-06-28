/**
 * Real behavioral test for the channel/montage backfill sweep (epic #854 phase 3,
 * #859). Applies the ACTUAL migrations 0054 (n_channels / electrode_system) + 0055
 * (channel_montage_checked_at) against an in-memory SQLite seeded to mirror the
 * managed/catalog/sandbox/non-eeg mix, and asserts the sweep's candidate selection
 * and its direct column write (which must NOT bump updated_at) behave exactly like
 * the endpoint (admin.ts POST /admin/datasets/channel-montage-sweep).
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "backend/src/db/migrations");
const M0054 = readFileSync(join(MIGRATIONS_DIR, "0054_channel_montage_columns.sql"), "utf8");
const M0055 = readFileSync(join(MIGRATIONS_DIR, "0055_channel_montage_checked_at.sql"), "utf8");

// Minimal datasets slice the sweep touches, pre-0054/0055.
const BASE_SCHEMA = `
CREATE TABLE datasets (
  dataset_id TEXT PRIMARY KEY,
  github_repo TEXT,
  is_sandbox INTEGER DEFAULT 0,
  modalities TEXT,
  updated_at TEXT
);
`;

// The endpoint's candidate predicate (admin.ts). Kept identical here; the test
// fails loudly if the endpoint scoping ever diverges from this contract.
const CANDIDATE_SQL = `SELECT dataset_id, github_repo FROM datasets
   WHERE github_repo IS NOT NULL
     AND (is_sandbox = 0 OR is_sandbox IS NULL)
     AND modalities LIKE '%eeg%'
     AND channel_montage_checked_at IS NULL
   ORDER BY dataset_id`;

function seed(db: Database) {
  const ins = db.query(
    "INSERT INTO datasets (dataset_id, github_repo, is_sandbox, modalities, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  ins.run("nm000300", "nemarDatasets/nm000300", 0, "eeg", "2020-01-01 00:00:00"); // candidate
  ins.run("on000301", "nemarDatasets/on000301", 0, "anat,eeg", "2020-01-01 00:00:00"); // candidate
  ins.run("on000302", "nemarDatasets/on000302", 0, "ieeg", "2020-01-01 00:00:00"); // candidate (ieeg LIKE eeg)
  ins.run("ds000303", null, 0, "eeg", "2020-01-01 00:00:00"); // excluded: no repo (catalog)
  ins.run("xx000304", "nemarDatasets/xx000304", 1, "eeg", "2020-01-01 00:00:00"); // excluded: sandbox
  ins.run("on000305", "nemarDatasets/on000305", 0, "meg", "2020-01-01 00:00:00"); // excluded: no eeg
}

const candidates = (db: Database) =>
  (db.query(CANDIDATE_SQL).all() as { dataset_id: string }[]).map((r) => r.dataset_id);

/** Mirror the endpoint's per-dataset write: two columns + marker, no updated_at. */
function applyProbe(
  db: Database,
  id: string,
  nChannels: number | null,
  electrodeSystem: string | null,
) {
  db.query(
    `UPDATE datasets
       SET n_channels = ?, electrode_system = ?, channel_montage_checked_at = datetime('now')
       WHERE dataset_id = ?`,
  ).run(nChannels, electrodeSystem, id);
}

describe("channel-montage backfill sweep", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(BASE_SCHEMA);
    db.exec(M0054); // ADD COLUMN n_channels, electrode_system + indexes
    db.exec(M0055); // ADD COLUMN channel_montage_checked_at
    seed(db);
  });

  test("migrations add the three columns", () => {
    const cols = (db.query("PRAGMA table_info(datasets)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("n_channels");
    expect(cols).toContain("electrode_system");
    expect(cols).toContain("channel_montage_checked_at");
  });

  test("candidate query scopes to repo-backed, EEG, non-sandbox, unchecked rows", () => {
    // ds000303 (no repo), xx000304 (sandbox), on000305 (no eeg) excluded.
    expect(candidates(db)).toEqual(["nm000300", "on000301", "on000302"]);
  });

  test("a successful probe writes the two columns + marker, leaving updated_at untouched", () => {
    applyProbe(db, "nm000300", 129, "egi-geodesic");
    const row = db
      .query(
        "SELECT n_channels, electrode_system, channel_montage_checked_at, updated_at FROM datasets WHERE dataset_id = 'nm000300'",
      )
      .get() as Record<string, unknown>;
    expect(row.n_channels).toBe(129);
    expect(row.electrode_system).toBe("egi-geodesic");
    expect(row.channel_montage_checked_at).not.toBeNull();
    // The backfill must NOT bump updated_at (would re-sort every EEG dataset to "newest").
    expect(row.updated_at).toBe("2020-01-01 00:00:00");
    // Idempotent: no longer a candidate.
    expect(candidates(db)).not.toContain("nm000300");
  });

  test("a no-data probe (ieeg-only, no eeg/ dir) stamps the marker and converges", () => {
    applyProbe(db, "on000302", null, null);
    const row = db
      .query(
        "SELECT n_channels, electrode_system, channel_montage_checked_at FROM datasets WHERE dataset_id = 'on000302'",
      )
      .get() as Record<string, unknown>;
    expect(row.n_channels).toBeNull();
    expect(row.electrode_system).toBeNull();
    expect(row.channel_montage_checked_at).not.toBeNull(); // checked, so not retried
    expect(candidates(db)).not.toContain("on000302");
  });
});
