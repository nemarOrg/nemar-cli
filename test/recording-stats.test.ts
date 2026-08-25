/**
 * Real behavioral tests for the pure `aggregateRecordingStats` aggregator
 * and migration 0070 (epic #1144 Phase 2, issue #1146). No mocks: real
 * bun:sqlite + the ACTUAL migration SQL read off disk.
 *
 * The recording-stats SWEEP (`runRecordingStatsSweep`,
 * POST /admin/datasets/recording-stats-sweep, and the daily cron) is covered
 * separately in backend/test/, where a real D1 (bun:sqlite behind realD1)
 * and, for the route, a real Hono dispatch are available:
 *  - backend/test/recording-stats-sweep.test.ts drives the real
 *    runRecordingStatsSweep function -- the entry point both real callers
 *    use -- with only the network boundary (getZarrIndex) substituted.
 *  - backend/test/recording-stats-sweep-route.test.ts drives the real HTTP
 *    route, including the real `?reset=1` SQL.
 * Neither hand-copies the sweep's SQL or re-implements its control flow, so
 * a future edit to the real sweep cannot silently drift out of test reach --
 * see those files' header comments for the incident (PR #1157 review) that
 * made this the required standard here.
 *
 * The `/webhooks/zarr-ready` callback's `recording_stats_at` invalidation is
 * covered in backend/test/recording-stats-callback.test.ts, which drives the
 * real handler through Hono for the same reason.
 *
 * Fixtures:
 *  - test/fixtures/zarr-index-nm000111-slice.json: the first 6 stores + both
 *    failures of the LIVE nm000111 index
 *    (https://api.nemar.org/zarrproxy/nm000111/zarr/index.json, fetched
 *    2026-08-24, source_commit 510a05377459cf857e60b861ab377bc53b5b5b29),
 *    kept verbatim. Anchors the sum-across-stores half of the aggregation
 *    rule against real data; independently hand-computed oracle: 165450 s.
 *  - test/fixtures/zarr-index-multigroup.json: SYNTHETIC. As of 2026-08-24 a
 *    sample of 34 live indexes -- every MEG/NIRS/motion/EMG dataset
 *    reachable plus a broad EEG/iEEG sample -- contains zero multi-group
 *    stores, so real data cannot falsify the max-within-store half of the
 *    rule -- this fixture is the only thing that can.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RECORDING_STATS_SWEEP_CANDIDATE_SQL,
  RECORDING_STATS_SWEEP_REMAINING_SQL,
} from "../backend/src/services/recording-stats-sweep";
import { type ZarrIndexJson, aggregateRecordingStats } from "../backend/src/services/s3";

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

  test("a store with duration_s but no n_channels is measured with a NULL channel range (I3 inverse case)", () => {
    const index: ZarrIndexJson = {
      store_count: 1,
      stores: [{ groups: [{ duration_s: 1200 }] }],
      failure_count: 0,
      failures: [],
    };
    const stats = aggregateRecordingStats(index);
    expect(stats.recordingsMeasured).toBe(1);
    expect(stats.totalRecordingDuration).toBe(1200);
    expect(stats.channelCountMin).toBeNull();
    expect(stats.channelCountMax).toBeNull();
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

  test("duration_s: 0 counts as MEASURED, not unmeasured (S1)", () => {
    // A genuinely zero-length recording is a measured fact, not an absence
    // of measurement -- `if (duration)` (a truthy check) would misclassify
    // 0 as unmeasured, since `!== null` is the correct test.
    const index: ZarrIndexJson = {
      store_count: 1,
      stores: [{ groups: [{ n_channels: 4, duration_s: 0 }] }],
      failure_count: 0,
      failures: [],
    };
    const stats = aggregateRecordingStats(index);
    expect(stats.recordingsMeasured).toBe(1);
    expect(stats.totalRecordingDuration).toBe(0);
    expect(stats.recordingDurationMin).toBe(0);
    expect(stats.recordingDurationMax).toBe(0);
  });

  test("a negative duration_s is rejected, not summed (I1)", () => {
    // Malformed data (the bundle declares duration_s minimum:0), not a
    // valid-but-unusual value. Rejecting (not clamping to 0) matters: a
    // clamped negative would be indistinguishable from a real zero-length
    // recording (see the "duration_s: 0" test above).
    const index: ZarrIndexJson = {
      store_count: 1,
      stores: [{ groups: [{ n_channels: 4, duration_s: -500 }] }],
      failure_count: 0,
      failures: [],
    };
    const stats = aggregateRecordingStats(index);
    expect(stats.recordingsMeasured).toBe(0);
    expect(stats.totalRecordingDuration).toBeNull();
  });

  test("a negative n_channels is rejected, not published as a range bound (I1)", () => {
    const index: ZarrIndexJson = {
      store_count: 1,
      stores: [{ groups: [{ n_channels: -1, duration_s: 100 }] }],
      failure_count: 0,
      failures: [],
    };
    const stats = aggregateRecordingStats(index);
    expect(stats.channelCountMin).toBeNull();
    expect(stats.channelCountMax).toBeNull();
    // The duration itself is unaffected by the sibling field's rejection.
    expect(stats.totalRecordingDuration).toBe(100);
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
// Candidate/remaining SQL (pinned, read-only, no route/function dispatch)
//
// RECORDING_STATS_SWEEP_CANDIDATE_SQL / _REMAINING_SQL are the SAME strings
// runRecordingStatsSweep itself queries (services/recording-stats-sweep.ts)
// -- imported directly, not hand-copied, so there is nothing here that can
// silently drift. Exercised as plain read-only SELECTs so this stays
// network-free; the full sweep (including the write paths) is covered
// end-to-end in backend/test/recording-stats-sweep.test.ts.
// ===========================================================================

const CANDIDATE_SCHEMA = `
CREATE TABLE datasets (
  dataset_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  zarr_status TEXT,
  recording_stats_at TEXT
);
`;

function seedCandidateFixture(db: Database) {
  const ins = db.query("INSERT INTO datasets (dataset_id, status, zarr_status) VALUES (?, ?, ?)");
  ins.run("nm000400", "active", "ready"); // candidate
  ins.run("nm000401", "active", "ready"); // candidate
  // Sandbox-prefixed IDs are NOT excluded by this sweep's predicate (unlike
  // channel-montage-sweep / zarr-sweep, which both filter is_sandbox) -- the
  // plan specifies exactly the three ANDed conditions below and nothing
  // more, since the exemplar fleet's published xx0999NN copies are
  // legitimate catalog entries that should carry duration too.
  ins.run("xx000090", "active", "ready"); // candidate
  ins.run("nm000402", "active", null); // excluded: not zarr-ready
  ins.run("nm000403", "withdrawn", "ready"); // excluded: not active
  ins.run("nm000404", "active", "ready"); // excluded: already stamped below
  db.run("UPDATE datasets SET recording_stats_at = datetime('now') WHERE dataset_id = 'nm000404'");
}

const GENEROUS_LIMIT = 100;
const candidates = (db: Database) =>
  (
    db.query(RECORDING_STATS_SWEEP_CANDIDATE_SQL).all(GENEROUS_LIMIT) as { dataset_id: string }[]
  ).map((r) => r.dataset_id);
const remaining = (db: Database) =>
  (db.query(RECORDING_STATS_SWEEP_REMAINING_SQL).get() as { n: number }).n;

describe("recording-stats-sweep candidate/remaining SQL (pinned)", () => {
  test("candidate query scopes to active, zarr-ready, unstamped rows (sandbox included)", () => {
    const db = new Database(":memory:");
    db.exec(CANDIDATE_SCHEMA);
    seedCandidateFixture(db);
    expect(candidates(db)).toEqual(["nm000400", "nm000401", "xx000090"]);
    db.close();
  });

  test("remaining count matches the candidate set and decreases as rows are stamped", () => {
    const db = new Database(":memory:");
    db.exec(CANDIDATE_SCHEMA);
    seedCandidateFixture(db);
    expect(remaining(db)).toBe(3);
    db.run(
      "UPDATE datasets SET recording_stats_at = datetime('now') WHERE dataset_id = 'nm000400'",
    );
    expect(remaining(db)).toBe(2);
    expect(candidates(db)).toEqual(["nm000401", "xx000090"]);
    db.close();
  });
});
