/**
 * Real behavioral tests for dataset-level recording statistics (epic #1144
 * Phase 2, issue #1146): the pure `aggregateRecordingStats` aggregator and the
 * `POST /admin/datasets/recording-stats-sweep` backfill (modelled on
 * channel-montage-sweep, routes/admin/datasets-lifecycle.ts). No mocks: real
 * bun:sqlite + the ACTUAL migration SQL read off disk.
 *
 * The `/webhooks/zarr-ready` callback's `recording_stats_at` invalidation is
 * covered separately in
 * backend/test/recording-stats-callback.test.ts, which drives the real
 * handler through Hono (backend/test/helpers/d1.ts's realD1) rather than
 * hand-copying its UPDATE SQL -- a hand-copy could never catch a future edit
 * to the handler that accidentally clears (or forgets to clear)
 * recording_stats_at, which is exactly the property this invalidation needs.
 *
 * Fixtures:
 *  - test/fixtures/zarr-index-nm000111-slice.json: the first 6 stores + both
 *    failures of the LIVE nm000111 index
 *    (https://api.nemar.org/zarrproxy/nm000111/zarr/index.json, fetched
 *    2026-08-24, source_commit 510a05377459cf857e60b861ab377bc53b5b5b29),
 *    kept verbatim. Anchors the sum-across-stores half of the aggregation
 *    rule against real data; independently hand-computed oracle: 165450 s.
 *  - test/fixtures/zarr-index-multigroup.json: SYNTHETIC. As of 2026-08-24 a
 *    sample of 34 live indexes (every MEG/NIRS/motion/EMG dataset reachable)
 *    contains zero multi-group stores, so real data cannot falsify the
 *    max-within-store half of the rule -- this fixture is the only thing
 *    that can.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RECORDING_STATS_SWEEP_CANDIDATE_SQL,
  RECORDING_STATS_SWEEP_REMAINING_SQL,
} from "../backend/src/services/recording-stats-sweep";
import {
  type RecordingStats,
  type ZarrIndexJson,
  aggregateRecordingStats,
} from "../backend/src/services/s3";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "backend/src/db/migrations");
const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const M0070 = readFileSync(join(MIGRATIONS_DIR, "0070_recording_stats.sql"), "utf8");

function loadFixture(name: string): ZarrIndexJson {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8")) as ZarrIndexJson;
}

// ===========================================================================
// aggregateRecordingStats — pure function, no I/O
// ===========================================================================

describe("aggregateRecordingStats", () => {
  test("real-data anchor: nm000111 trimmed slice (6 stores + 2 failures)", () => {
    const index = loadFixture("zarr-index-nm000111-slice.json");
    const stats = aggregateRecordingStats(index);
    // Independently hand-computed from the fixture's own duration_s values:
    // 28290 + 28890 + 26250 + 26910 + 27990 + 27120 = 165450.
    expect(stats.totalRecordingDuration).toBe(165450);
    expect(stats.recordingDurationMin).toBe(26250);
    expect(stats.recordingDurationMax).toBe(28890);
    // recording_count = store_count(6) + failure_count(2), NOT stores.length
    // alone -- the two failed recordings (sub-I001/sub-I002) are real raw
    // recordings that never converted and must not vanish from the count.
    expect(stats.recordingCount).toBe(8);
    expect(stats.recordingsUnavailable).toBe(2);
    expect(stats.recordingsMeasured).toBe(6);
    // Channel counts across the 6 stores: 19 (x5), 21 (x1).
    expect(stats.channelCountMin).toBe(19);
    expect(stats.channelCountMax).toBe(21);
  });

  test("max within a store, sum across stores (synthetic multi-group fixture)", () => {
    const index = loadFixture("zarr-index-multigroup.json");
    const stats = aggregateRecordingStats(index);
    // Store 1 (sub-01) has two concurrent groups: 3000s and 1000s. Its
    // contribution must be max(3000, 1000) = 3000, never their sum (4000).
    // Store 2 (sub-02) has one group: 2000s.
    // Correct total: 3000 + 2000 = 5000. A sum-within-store bug would yield
    // (3000 + 1000) + 2000 = 6000 instead.
    expect(stats.totalRecordingDuration).toBe(5000);
    expect(stats.recordingDurationMin).toBe(2000);
    expect(stats.recordingDurationMax).toBe(3000);
    expect(stats.recordingCount).toBe(2);
    expect(stats.recordingsMeasured).toBe(2);
    // Channel range spans both groups of store 1 (4 and 32) and store 2 (32).
    expect(stats.channelCountMin).toBe(4);
    expect(stats.channelCountMax).toBe(32);
  });

  test("recording_count reads the index's own store_count field, not stores.length", () => {
    // Synthetic divergence (never happens on a real index -- the converter
    // always keeps store_count in sync with stores.length): store_count says
    // 10, but only 2 store entries are actually present. The aggregator must
    // trust store_count (the converter's authoritative field), so
    // recording_count = 10 + 1 = 11. A stores.length-based implementation
    // would silently report 2 + 1 = 3 instead.
    const index: ZarrIndexJson = {
      store_count: 10,
      stores: [{ groups: [{ n_channels: 5, duration_s: 100 }] }, { groups: [] }],
      failure_count: 1,
      failures: [{}],
    };
    const stats = aggregateRecordingStats(index);
    expect(stats.recordingCount).toBe(11);
    expect(stats.recordingsUnavailable).toBe(1);
  });

  test("a store whose only group has n_channels but no duration_s is unmeasured", () => {
    // Rate/channel count can be known before a full read measures duration
    // (verification #4): the channel range must still see this group, but it
    // must not count toward recordingsMeasured or contribute to duration.
    const index: ZarrIndexJson = {
      store_count: 1,
      stores: [{ groups: [{ n_channels: 8, duration_s: null }] }],
      failure_count: 0,
      failures: [],
    };
    const stats = aggregateRecordingStats(index);
    expect(stats.recordingsMeasured).toBe(0);
    expect(stats.totalRecordingDuration).toBeNull();
    expect(stats.recordingDurationMin).toBeNull();
    expect(stats.recordingDurationMax).toBeNull();
    expect(stats.channelCountMin).toBe(8);
    expect(stats.channelCountMax).toBe(8);
  });

  test("a store with an empty groups array is unmeasured and contributes no channel data", () => {
    const index: ZarrIndexJson = {
      store_count: 1,
      stores: [{ groups: [] }],
      failure_count: 0,
      failures: [],
    };
    const stats = aggregateRecordingStats(index);
    expect(stats.recordingsMeasured).toBe(0);
    expect(stats.totalRecordingDuration).toBeNull();
    expect(stats.channelCountMin).toBeNull();
    expect(stats.channelCountMax).toBeNull();
    expect(stats.recordingCount).toBe(1);
  });

  test("an empty stores array yields NULL duration (not 0) when nothing measured", () => {
    // ADR 0005: availability is reported, never faked. A zero-length total
    // would read as "zero-length dataset" instead of "not measured yet".
    const index: ZarrIndexJson = {
      store_count: 0,
      stores: [],
      failure_count: 3,
      failures: [{}, {}, {}],
    };
    const stats = aggregateRecordingStats(index);
    expect(stats.totalRecordingDuration).toBeNull();
    expect(stats.recordingDurationMin).toBeNull();
    expect(stats.recordingDurationMax).toBeNull();
    expect(stats.recordingsMeasured).toBe(0);
    expect(stats.recordingCount).toBe(3);
    expect(stats.recordingsUnavailable).toBe(3);
    expect(stats.channelCountMin).toBeNull();
    expect(stats.channelCountMax).toBeNull();
  });
});

// ===========================================================================
// Migration 0070
// ===========================================================================

describe("migration 0070", () => {
  test("adds the nine recording-stats columns", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE datasets (dataset_id TEXT PRIMARY KEY);");
    db.exec(M0070);
    const cols = (db.query("PRAGMA table_info(datasets)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    for (const c of [
      "total_recording_duration",
      "recording_duration_min",
      "recording_duration_max",
      "recording_count",
      "recordings_unavailable",
      "recordings_measured",
      "channel_count_min",
      "channel_count_max",
      "recording_stats_at",
    ]) {
      expect(cols).toContain(c);
    }
    // Deliberately absent -- see the aggregator's ZarrIndexGroupJson comment.
    expect(cols).not.toContain("sampling_frequency_min");
    expect(cols).not.toContain("sampling_frequency_max");
    db.close();
  });
});

// ===========================================================================
// POST /admin/datasets/recording-stats-sweep (routes/admin/datasets-lifecycle.ts)
// ===========================================================================

// The candidate/remaining queries are imported directly from
// services/recording-stats-sweep.ts (the SAME source runRecordingStatsSweep
// itself queries), so there is nothing here that can silently drift --
// unlike channel-montage-sweep.unit.test.ts / zarr-sweep.unit.test.ts, which
// predate that shared-query pattern and hand-duplicate their SQL instead.
const RESET_SQL = `UPDATE datasets
   SET recording_stats_at = NULL,
       total_recording_duration = NULL,
       recording_duration_min = NULL,
       recording_duration_max = NULL,
       recording_count = NULL,
       recordings_unavailable = NULL,
       recordings_measured = NULL,
       channel_count_min = NULL,
       channel_count_max = NULL
   WHERE recording_stats_at IS NOT NULL`;

const BASE_SCHEMA = `
CREATE TABLE datasets (
  dataset_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  zarr_status TEXT,
  updated_at TEXT
);
`;

function seedSweepFixture(db: Database) {
  const ins = db.query(
    "INSERT INTO datasets (dataset_id, status, zarr_status, updated_at) VALUES (?, ?, ?, ?)",
  );
  ins.run("nm000400", "active", "ready", "2020-01-01 00:00:00"); // candidate
  ins.run("nm000401", "active", "ready", "2020-01-01 00:00:00"); // candidate
  // Sandbox-prefixed IDs are NOT excluded by this sweep's predicate (unlike
  // channel-montage-sweep / zarr-sweep, which both filter is_sandbox) --
  // the plan specifies exactly the three ANDed conditions above and nothing
  // more, since the exemplar fleet's published xx0999NN copies are
  // legitimate catalog entries that should carry duration too.
  ins.run("xx000090", "active", "ready", "2020-01-01 00:00:00"); // candidate
  ins.run("nm000402", "active", null, "2020-01-01 00:00:00"); // excluded: not zarr-ready
  ins.run("nm000403", "withdrawn", "ready", "2020-01-01 00:00:00"); // excluded: not active
  ins.run("nm000404", "active", "ready", "2020-01-01 00:00:00"); // excluded: already stamped below
  db.run("UPDATE datasets SET recording_stats_at = datetime('now') WHERE dataset_id = 'nm000404'");
}

const candidates = (db: Database) =>
  (db.query(RECORDING_STATS_SWEEP_CANDIDATE_SQL).all(100) as { dataset_id: string }[]).map(
    (r) => r.dataset_id,
  );

/** Mirror the endpoint's per-dataset write: eight stat columns + the stamp, no updated_at. */
function applyStats(db: Database, id: string, stats: RecordingStats | null) {
  db.query(
    `UPDATE datasets
       SET total_recording_duration = ?,
           recording_duration_min = ?,
           recording_duration_max = ?,
           recording_count = ?,
           recordings_unavailable = ?,
           recordings_measured = ?,
           channel_count_min = ?,
           channel_count_max = ?,
           recording_stats_at = datetime('now')
     WHERE dataset_id = ?`,
  ).run(
    stats?.totalRecordingDuration ?? null,
    stats?.recordingDurationMin ?? null,
    stats?.recordingDurationMax ?? null,
    stats?.recordingCount ?? null,
    stats?.recordingsUnavailable ?? null,
    stats?.recordingsMeasured ?? null,
    stats?.channelCountMin ?? null,
    stats?.channelCountMax ?? null,
    id,
  );
}

describe("recording-stats-sweep", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(BASE_SCHEMA);
    db.exec(M0070);
    seedSweepFixture(db);
  });

  test("candidate query scopes to active, zarr-ready, unstamped rows (sandbox included)", () => {
    expect(candidates(db)).toEqual(["nm000400", "nm000401", "xx000090"]);
  });

  test("a computed stats bag is written verbatim, stamping recording_stats_at, leaving updated_at untouched", () => {
    const stats: RecordingStats = {
      totalRecordingDuration: 165450,
      recordingDurationMin: 26250,
      recordingDurationMax: 28890,
      recordingCount: 8,
      recordingsUnavailable: 2,
      recordingsMeasured: 6,
      channelCountMin: 19,
      channelCountMax: 21,
    };
    applyStats(db, "nm000400", stats);
    const row = db
      .query(
        `SELECT total_recording_duration, recording_duration_min, recording_duration_max,
                recording_count, recordings_unavailable, recordings_measured,
                channel_count_min, channel_count_max, recording_stats_at, updated_at
           FROM datasets WHERE dataset_id = 'nm000400'`,
      )
      .get() as Record<string, unknown>;
    expect(row.total_recording_duration).toBe(165450);
    expect(row.recording_duration_min).toBe(26250);
    expect(row.recording_duration_max).toBe(28890);
    expect(row.recording_count).toBe(8);
    expect(row.recordings_unavailable).toBe(2);
    expect(row.recordings_measured).toBe(6);
    expect(row.channel_count_min).toBe(19);
    expect(row.channel_count_max).toBe(21);
    expect(row.recording_stats_at).not.toBeNull();
    // Verification #7: a ~660-dataset backfill must not bump updated_at
    // catalog-wide (would re-sort every dataset to "newest").
    expect(row.updated_at).toBe("2020-01-01 00:00:00");
    // Idempotent convergence: no longer a candidate.
    expect(candidates(db)).not.toContain("nm000400");
  });

  test("a failed probe (null stats) still stamps recording_stats_at so it converges", () => {
    applyStats(db, "nm000401", null);
    const row = db
      .query(
        "SELECT total_recording_duration, recording_count, recording_stats_at FROM datasets WHERE dataset_id = 'nm000401'",
      )
      .get() as Record<string, unknown>;
    expect(row.total_recording_duration).toBeNull();
    expect(row.recording_count).toBeNull();
    expect(row.recording_stats_at).not.toBeNull();
    expect(candidates(db)).not.toContain("nm000401");
  });

  test("?reset=1 clears every stamped row's stats and stamp, making it a candidate again", () => {
    const stats: RecordingStats = {
      totalRecordingDuration: 100,
      recordingDurationMin: 100,
      recordingDurationMax: 100,
      recordingCount: 1,
      recordingsUnavailable: 0,
      recordingsMeasured: 1,
      channelCountMin: 19,
      channelCountMax: 19,
    };
    applyStats(db, "nm000400", stats);
    expect(candidates(db)).not.toContain("nm000400");

    const result = db.run(RESET_SQL);
    // nm000400 (just stamped) + nm000404 (pre-stamped by the fixture) = 2.
    expect(result.changes).toBe(2);
    expect(candidates(db).sort()).toEqual(["nm000400", "nm000401", "nm000404", "xx000090"]);
    const row = db
      .query(
        "SELECT total_recording_duration, recording_count FROM datasets WHERE dataset_id = 'nm000400'",
      )
      .get() as Record<string, unknown>;
    expect(row.total_recording_duration).toBeNull();
    expect(row.recording_count).toBeNull();
  });

  test("remaining count reflects only unstamped candidates", () => {
    const remaining = () =>
      (db.query(RECORDING_STATS_SWEEP_REMAINING_SQL).get() as { n: number }).n;
    expect(remaining()).toBe(3); // nm000400, nm000401, xx000090
    applyStats(db, "nm000400", null);
    expect(remaining()).toBe(2);
    applyStats(db, "nm000401", null);
    applyStats(db, "xx000090", null);
    expect(remaining()).toBe(0);
  });
});
