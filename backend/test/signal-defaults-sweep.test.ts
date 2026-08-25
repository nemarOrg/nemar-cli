/**
 * Real behavioral tests for `runSignalDefaultsSweep` -- the entry point the
 * real admin route drives (epic #1144 Phase 2b, issue #1153). Modelled
 * directly on `recording-stats-sweep.test.ts`: drives the REAL function
 * against a real D1 (bun:sqlite behind realD1), substituting only the true
 * network boundary (`getBidsTreeStats`) via the function's `fetchStats`
 * injection point -- not a mock standing in for business logic, the same
 * "not a mock in the sense .rules/testing.md forbids" shape as `realD1`
 * itself. Everything else -- the candidate query, the three-way
 * throw/no-sidecar/success branch, the writes, the counters, the remaining
 * count -- runs for real against SQLite executing the production SQL.
 *
 * `pat` is also injected (a plain string, not a network call) so these tests
 * never need real GitHub App credentials -- see signal-defaults-sweep.ts's
 * module doc for why `runSignalDefaultsSweep` resolves the token lazily.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { BidsTreeStats, getBidsTreeStats } from "../src/services/github";
import {
  SIGNAL_DEFAULTS_SWEEP_MAX,
  runSignalDefaultsSweep,
} from "../src/services/signal-defaults-sweep";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

let db: Database;

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
}

function seedDataset(id: string, githubRepo = `nemarDatasets/${id}`): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, github_repo)
     VALUES (?, ?, 1, 'active', 'public', ?)`,
  ).run(id, id, githubRepo);
}

const row = (id: string) =>
  db.query("SELECT * FROM datasets WHERE dataset_id = ?").get(id) as Record<string, unknown>;

function emptyStats(overrides: Partial<BidsTreeStats> = {}): BidsTreeStats {
  return { modalities: [], subjectCount: 0, tasks: [], ...overrides };
}

beforeEach(() => {
  db = freshDb();
  db.prepare(
    `INSERT INTO users (id, username, email, password_hash, github_username, status)
     VALUES (1, 'sdsweepowner', 'sdsweepowner@example.org', 'x', 'sdsweepowner', 'approved')`,
  ).run();
});

describe("runSignalDefaultsSweep: three-way outcome handling", () => {
  test("THROW: the row is left unstamped and its prior values are untouched", async () => {
    seedDataset("nm000800");
    // Prior good values, as if a previous sweep (or a live reindex) already
    // populated them -- exactly the scenario a transient GitHub failure must
    // not corrupt.
    db.prepare(
      `UPDATE datasets
         SET sampling_frequency = 512, power_line_frequency = 60,
             eeg_reference = 'average', signal_defaults_at = NULL
       WHERE dataset_id = 'nm000800'`,
    ).run();

    const throwingFetch: typeof getBidsTreeStats = async () => {
      throw new Error("simulated GitHub 500");
    };
    const result = await runSignalDefaultsSweep(env(), {
      pat: "fake-pat",
      fetchStats: throwingFetch,
    });

    expect(result.errors).toEqual([
      { dataset_id: "nm000800", error: "github: simulated GitHub 500" },
    ]);
    const r = row("nm000800");
    expect(r.signal_defaults_at).toBeNull();
    expect(r.sampling_frequency).toBe(512);
    expect(r.power_line_frequency).toBe(60);
    expect(r.eeg_reference).toBe("average");
  });

  test("NO SIDECAR: the timestamp is stamped but prior values are NOT nulled (the data-loss case)", async () => {
    seedDataset("nm000801");
    db.prepare(
      `UPDATE datasets
         SET sampling_frequency = 512, power_line_frequency = 60,
             eeg_reference = 'average', placement_scheme = '10-20'
       WHERE dataset_id = 'nm000801'`,
    ).run();

    // A probe that ran to completion (no throw) but found nothing usable --
    // e.g. a non-BIDS repo, or one with no EEG sidecar.
    const noSidecarFetch: typeof getBidsTreeStats = async () => emptyStats();
    const result = await runSignalDefaultsSweep(env(), {
      pat: "fake-pat",
      fetchStats: noSidecarFetch,
    });

    expect(result.populated).toBe(0);
    expect(result.noData).toBe(1);
    const r = row("nm000801");
    expect(r.signal_defaults_at).not.toBeNull();
    // THE WHOLE POINT of the three-way split: prior good values survive a
    // no-sidecar outcome.
    expect(r.sampling_frequency).toBe(512);
    expect(r.power_line_frequency).toBe(60);
    expect(r.eeg_reference).toBe("average");
    expect(r.placement_scheme).toBe("10-20");
  });

  test("SUCCESS: all 4 value columns are written and the timestamp is stamped", async () => {
    seedDataset("nm000802");
    const successFetch: typeof getBidsTreeStats = async () =>
      emptyStats({
        samplingFrequency: 500,
        powerLineFrequency: 60,
        eegReference: "average",
        placementScheme: "extended 10-10% system",
      });
    const result = await runSignalDefaultsSweep(env(), {
      pat: "fake-pat",
      fetchStats: successFetch,
    });

    expect(result.populated).toBe(1);
    expect(result.noData).toBe(0);
    expect(result.errors).toEqual([]);
    const r = row("nm000802");
    expect(r.sampling_frequency).toBe(500);
    expect(r.power_line_frequency).toBe(60);
    expect(r.eeg_reference).toBe("average");
    expect(r.placement_scheme).toBe("extended 10-10% system");
    expect(r.signal_defaults_at).not.toBeNull();
  });

  test("SUCCESS with only ONE of the four keys populated still counts as populated, not no-data", async () => {
    // A sidecar that carries SamplingFrequency but nothing else is real and
    // common -- the `found` gate is an OR across all four, not an AND.
    seedDataset("nm000803");
    const partialFetch: typeof getBidsTreeStats = async () =>
      emptyStats({ samplingFrequency: 250 });
    const result = await runSignalDefaultsSweep(env(), {
      pat: "fake-pat",
      fetchStats: partialFetch,
    });
    expect(result.populated).toBe(1);
    expect(result.noData).toBe(0);
    const r = row("nm000803");
    expect(r.sampling_frequency).toBe(250);
    expect(r.power_line_frequency).toBeNull();
    expect(r.eeg_reference).toBeNull();
    expect(r.placement_scheme).toBeNull();
  });
});

describe("runSignalDefaultsSweep: entry-point invariants", () => {
  test("a requested limit far above SIGNAL_DEFAULTS_SWEEP_MAX is clamped down to it", async () => {
    const seeded = SIGNAL_DEFAULTS_SWEEP_MAX + 5;
    for (let i = 0; i < seeded; i++) seedDataset(`nm00090${String(i).padStart(2, "0")}`);
    let callCount = 0;
    const countingFetch: typeof getBidsTreeStats = async () => {
      callCount++;
      return emptyStats({ samplingFrequency: 250 });
    };
    const result = await runSignalDefaultsSweep(env(), {
      pat: "fake-pat",
      limit: 999_999,
      fetchStats: countingFetch,
    });
    expect(result.processed).toBe(SIGNAL_DEFAULTS_SWEEP_MAX);
    expect(callCount).toBe(SIGNAL_DEFAULTS_SWEEP_MAX);
  });

  test("populated/noData are counted correctly, not transposed", async () => {
    seedDataset("nm000810");
    seedDataset("nm000811");
    seedDataset("nm000812");
    let call = 0;
    const mixedFetch: typeof getBidsTreeStats = async () => {
      call++;
      // First two: populated. Third: no sidecar.
      return call <= 2 ? emptyStats({ samplingFrequency: 250 }) : emptyStats();
    };
    const result = await runSignalDefaultsSweep(env(), {
      pat: "fake-pat",
      fetchStats: mixedFetch,
    });
    expect(result.populated).toBe(2);
    expect(result.noData).toBe(1);
  });

  test("remaining reflects the real candidate count after this pass", async () => {
    seedDataset("nm000820");
    seedDataset("nm000821");
    const successFetch: typeof getBidsTreeStats = async () =>
      emptyStats({ samplingFrequency: 250 });
    const result = await runSignalDefaultsSweep(env(), {
      pat: "fake-pat",
      limit: 1,
      fetchStats: successFetch,
    });
    expect(result.processed).toBe(1);
    expect(result.remaining).toBe(1);
  });

  test("a dataset with no github_repo is not a candidate", async () => {
    db.prepare(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, github_repo)
       VALUES ('nm000830', 'nm000830', 1, 'active', 'public', NULL)`,
    ).run();
    const result = await runSignalDefaultsSweep(env(), {
      pat: "fake-pat",
      fetchStats: async () => emptyStats({ samplingFrequency: 250 }),
    });
    expect(result.processed).toBe(0);
  });

  test("an already-stamped row is not a candidate", async () => {
    seedDataset("nm000831");
    db.prepare(
      "UPDATE datasets SET signal_defaults_at = '2026-08-01 00:00:00' WHERE dataset_id = 'nm000831'",
    ).run();
    const result = await runSignalDefaultsSweep(env(), {
      pat: "fake-pat",
      fetchStats: async () => emptyStats({ samplingFrequency: 250 }),
    });
    expect(result.processed).toBe(0);
  });
});
