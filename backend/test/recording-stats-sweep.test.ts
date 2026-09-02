/**
 * Real behavioral tests for `runRecordingStatsSweep` -- the entry point BOTH
 * real callers (`POST /admin/datasets/recording-stats-sweep` and the daily
 * cron) use (epic #1144 Phase 2, issue #1146; PR #1157 review findings
 * C1/C2).
 *
 * Drives the REAL function against a real D1 (bun:sqlite behind realD1),
 * substituting only the true network boundary (`getZarrIndex`) via the
 * function's `fetchIndex` injection point. This is not a mock standing in
 * for business logic -- it is the one thing in this loop with no real,
 * network-free equivalent in a sandboxed test, exactly the same shape as
 * `realD1` itself ("not a mock in the sense .rules/testing.md forbids: no
 * business logic is replaced or bypassed") and as the `timingSafeEqual`
 * polyfill in recording-stats-callback.test.ts. Everything else -- the
 * candidate query, the three-way throw/absent/success branch, the writes,
 * the counters, the remaining count -- runs for real against SQLite
 * executing the production SQL.
 *
 * C1: before this PR, a transient S3 error (throw) AND a briefly-absent
 * index on a reconverted dataset both fell through to one unconditional
 * write of all-NULL stats, destroying prior good numbers and permanently
 * removing the row from candidacy (recovery: only `?reset=1`, which clears
 * the ENTIRE catalog to fix one dataset). The first describe block below
 * proves each of the three outcomes independently; the ABSENT case is the
 * data-loss case and is the one that fails against the pre-fix code.
 *
 * C2: `runRecordingStatsSweep` itself was never driven by any test before
 * this file -- earlier tests exercised the exported SQL constants directly
 * against a raw sqlite handle, so removing `RECORDING_STATS_SWEEP_MAX` or
 * transposing the measured/unmeasured counters both passed every test. The
 * second describe block proves both against the real function.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  RECORDING_STATS_SWEEP_MAX,
  runRecordingStatsSweep,
  runRecordingStatsSweepCron,
} from "../src/services/recording-stats-sweep";
import type { RecordingStats, ZarrIndexInfo, getZarrIndex } from "../src/services/s3";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

let db: Database;

function env(): Bindings {
  return {
    DB: realD1(db),
    S3_BUCKET: "test-bucket",
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    ENVIRONMENT: "test",
  } as Bindings;
}

function seedDataset(id: string): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility)
     VALUES (?, ?, 1, 'active', 'public')`,
  ).run(id, id);
  // zarr_status='ready' + unstamped, matching the candidate predicate --
  // set via UPDATE since not every column above is on the base INSERT list
  // used elsewhere in this test suite.
  db.prepare("UPDATE datasets SET zarr_status = 'ready' WHERE dataset_id = ?").run(id);
}

const row = (id: string) =>
  db
    .query(
      "SELECT *, json_extract(sweep_stamps, '$.recording_stats_at') AS recording_stats_at FROM datasets WHERE dataset_id = ?",
    )
    .get(id) as Record<string, unknown>;

function stats(overrides: Partial<RecordingStats> = {}): RecordingStats {
  return {
    totalRecordingDuration: 5000,
    recordingDurationMin: 5000,
    recordingDurationMax: 5000,
    recordingCount: 1,
    recordingsUnavailable: 0,
    recordingsMeasured: 1,
    channelCountMin: 19,
    channelCountMax: 19,
    ...overrides,
  };
}

function fakeIndex(recordingStats: RecordingStats): ZarrIndexInfo {
  return { storeCount: 1, sourceCommit: "abc123", etag: "etag1", recordingStats };
}

beforeEach(() => {
  db = freshDb();
  db.prepare(
    `INSERT INTO users (id, username, email, password_hash, github_username, status)
     VALUES (1, 'sweepowner', 'sweepowner@example.org', 'x', 'sweepowner', 'approved')`,
  ).run();
});

describe("runRecordingStatsSweep: three-way outcome handling (C1)", () => {
  test("THROW: the row is left unstamped and its prior stats are untouched", async () => {
    seedDataset("on007800");
    // Prior good stats, as if a previous sweep had already succeeded, then
    // re-nulled by a reconversion (the zarr-ready callback's 'ready'
    // branch) -- exactly the scenario a transient S3 blip must not corrupt.
    db.prepare(
      // sweep_stamps = '{}' is the post-reconversion shape: the zarr-ready
      // 'ready' branch json_remove()s the recording_stats_at key from the
      // stamps object, leaving the object without the key (#1183).
      `UPDATE datasets
         SET total_recording_duration = 9999, recording_count = 3, recordings_measured = 3,
             sweep_stamps = '{}'
       WHERE dataset_id = 'on007800'`,
    ).run();

    const throwingFetch: typeof getZarrIndex = async () => {
      throw new Error("simulated S3 timeout");
    };
    const result = await runRecordingStatsSweep(env(), { fetchIndex: throwingFetch });

    expect(result.errors).toEqual([{ dataset_id: "on007800", error: "s3: simulated S3 timeout" }]);
    const r = row("on007800");
    // Not stamped -- stays a candidate for the next run.
    expect(r.recording_stats_at).toBeNull();
    // Prior good stats intact.
    expect(r.total_recording_duration).toBe(9999);
    expect(r.recording_count).toBe(3);
  });

  test("ABSENT: the timestamp is stamped but prior stats are NOT nulled (the data-loss case)", async () => {
    seedDataset("on007801");
    db.prepare(
      `UPDATE datasets
         SET total_recording_duration = 9999, recording_count = 3, recordings_measured = 3
       WHERE dataset_id = 'on007801'`,
    ).run();

    const absentFetch: typeof getZarrIndex = async () => null;
    const result = await runRecordingStatsSweep(env(), { fetchIndex: absentFetch });

    expect(result.errors).toEqual([
      { dataset_id: "on007801", error: "zarr_status=ready but index.json is absent" },
    ]);
    const r = row("on007801");
    // Stamped, so the sweep converges and does not re-select this row
    // forever.
    expect(r.recording_stats_at).not.toBeNull();
    // THE WHOLE POINT of this fix: prior good stats survive an absent read.
    expect(r.total_recording_duration).toBe(9999);
    expect(r.recording_count).toBe(3);
    expect(r.recordings_measured).toBe(3);
  });

  test("SUCCESS: all 8 stat columns are written and the timestamp is stamped", async () => {
    seedDataset("on007802");
    const successFetch: typeof getZarrIndex = async () => fakeIndex(stats());
    const result = await runRecordingStatsSweep(env(), { fetchIndex: successFetch });

    expect(result.measured).toBe(1);
    expect(result.unmeasured).toBe(0);
    expect(result.errors).toEqual([]);
    const r = row("on007802");
    expect(r.total_recording_duration).toBe(5000);
    expect(r.recording_count).toBe(1);
    expect(r.channel_count_min).toBe(19);
    expect(r.recording_stats_at).not.toBeNull();
  });
});

describe("runRecordingStatsSweep: entry-point invariants (C2)", () => {
  test("a requested limit far above RECORDING_STATS_SWEEP_MAX is clamped down to it", async () => {
    // Seed a few more candidates than the cap so a violated clamp is
    // observable in `processed` without needing hundreds of rows.
    const seeded = RECORDING_STATS_SWEEP_MAX + 5;
    for (let i = 0; i < seeded; i++) seedDataset(`on0079${String(i).padStart(3, "0")}`);
    let callCount = 0;
    const countingFetch: typeof getZarrIndex = async () => {
      callCount++;
      return fakeIndex(stats());
    };
    const result = await runRecordingStatsSweep(env(), {
      limit: 999_999,
      fetchIndex: countingFetch,
    });
    expect(result.processed).toBe(RECORDING_STATS_SWEEP_MAX);
    expect(callCount).toBe(RECORDING_STATS_SWEEP_MAX);
  });

  test("measured/unmeasured are counted correctly, not transposed", async () => {
    seedDataset("on007910");
    seedDataset("on007911");
    seedDataset("on007912");
    let call = 0;
    const mixedFetch: typeof getZarrIndex = async () => {
      call++;
      // First two calls: measured. Third: unmeasured.
      return call <= 2
        ? fakeIndex(stats())
        : fakeIndex(
            stats({
              totalRecordingDuration: null,
              recordingDurationMin: null,
              recordingDurationMax: null,
              recordingsMeasured: 0,
            }),
          );
    };
    const result = await runRecordingStatsSweep(env(), { fetchIndex: mixedFetch });
    expect(result.measured).toBe(2);
    expect(result.unmeasured).toBe(1);
  });

  test("remaining reflects the real candidate count after this pass", async () => {
    seedDataset("on007920");
    seedDataset("on007921");
    const successFetch: typeof getZarrIndex = async () => fakeIndex(stats());
    // Sweep only 1 of the 2 candidates.
    const result = await runRecordingStatsSweep(env(), { limit: 1, fetchIndex: successFetch });
    expect(result.processed).toBe(1);
    expect(result.remaining).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cron-only wrapper guard (issue #1166, Option 2) -- mirrors
// cron-dev-safety.test.ts's probe pattern. `runRecordingStatsSweep` itself is
// intentionally left unguarded above (the admin route needs it on staging);
// `runRecordingStatsSweepCron` is the thing `scheduled()` actually calls, and
// only IT carries the isNonProductionEnv fence.
// ---------------------------------------------------------------------------

describe("runRecordingStatsSweepCron", () => {
  // Mirrors cron-dev-safety.test.ts's probe(): a D1 whose prepare() throws the
  // instant it is reached, so "resolved/rejected without D1 being touched" (a
  // caught error, a truthy `null` return) cannot be mistaken for "the guard
  // fired" -- only `touched()` proves that.
  function probe(): { db: D1Database; touched: () => boolean } {
    let reached = false;
    const db = {
      prepare() {
        reached = true;
        throw new Error("probe: candidate query reached");
      },
    } as unknown as D1Database;
    return { db, touched: () => reached };
  }

  for (const environment of ["development", "staging", "test"]) {
    test(`never reaches D1 when ENVIRONMENT=${environment}`, async () => {
      const p = probe();
      const result = await runRecordingStatsSweepCron({
        ENVIRONMENT: environment,
        DB: p.db,
      } as unknown as Bindings);
      expect(p.touched()).toBe(false);
      expect(result).toBeNull();
    });
  }

  // isNonProductionEnv is an allow-list and fails CLOSED: production, and any
  // unset/unrecognized value, are treated as production so the wrapper still
  // delegates rather than silently disabling the daily job on a config typo.
  for (const environment of ["production", "", undefined, "prod", "Production"]) {
    test(`reaches D1 when ENVIRONMENT=${JSON.stringify(environment)}`, async () => {
      const p = probe();
      // runRecordingStatsSweep does not catch a candidate-query failure (by
      // design -- see its doc comment), so the wrapper's delegated call
      // rejects here too; the probe firing is what matters, not the outcome.
      await expect(
        runRecordingStatsSweepCron({
          ENVIRONMENT: environment,
          DB: p.db,
        } as unknown as Bindings),
      ).rejects.toThrow(/probe: candidate query reached/);
      expect(p.touched()).toBe(true);
    });
  }

  test("the raw sweep still reaches D1 under development -- the admin backfill route is unaffected", async () => {
    // This is the asymmetry Option 2 exists for. If a future change added an
    // internal guard to runRecordingStatsSweep itself, this is the test that
    // would catch it: staging's POST /admin/datasets/recording-stats-sweep
    // calls the exported sweep directly, not the cron wrapper, so a guard
    // here would silently break that backfill with nothing else failing.
    const p = probe();
    await expect(
      runRecordingStatsSweep({ ENVIRONMENT: "development", DB: p.db } as unknown as Bindings),
    ).rejects.toThrow(/probe: candidate query reached/);
    expect(p.touched()).toBe(true);
  });
});
