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
  runSignalDefaultsSweepCron,
} from "../src/services/signal-defaults-sweep";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

/** Real-engine D1 shim (like realD1) that throws on `.run()` for any
 *  statement whose SQL contains `sampling_frequency = COALESCE` -- i.e.
 *  the sweep's per-candidate write -- so the `d1 write:` catch branch,
 *  otherwise never exercised, can be driven for real. Every other
 *  statement (the candidate SELECT, the remaining COUNT, the stamp-only
 *  UPDATE) still executes against the real SQLite `db`.
 *
 * realD1's own `prepare()` returns a SELF-REFERENCING `api` object: its
 * `bind()` mutates closure state and returns `api` itself, so callers
 * chain `.prepare(sql).bind(...).run()` and land back on that same `api`.
 * This wrapper's `bind` must do the same -- call `stmt.bind()` to set up
 * the closure state, then return ITS OWN self-reference (`wrapper`), not
 * `stmt`. An earlier draft returned `stmt.bind(...)` directly, which
 * resolves to `stmt` itself and silently bypasses this wrapper's
 * overridden `run` entirely -- `.run()` in the chain would call the REAL
 * `run`, and this mutation-proof test would have reported `populated: 1`
 * instead of catching the simulated failure. */
function writeFailingD1(target: Database): D1Database {
  const base = realD1(target);
  return {
    prepare(sql: string) {
      const stmt = base.prepare(sql);
      const shouldFail = sql.includes("sampling_frequency = COALESCE");
      const wrapper = {
        bind: (...args: unknown[]) => {
          stmt.bind(...args);
          return wrapper;
        },
        run: () => {
          if (shouldFail) throw new Error("simulated D1 write failure");
          return stmt.run();
        },
        first: <T>() => stmt.first<T>(),
        all: <T>() => stmt.all<T>(),
      };
      return wrapper;
    },
  } as unknown as D1Database;
}

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

  // #1162 review, C1: SIGNAL_DEFAULTS_SWEEP_WRITE_SQL must COALESCE, not
  // directly SET. Unlike the "SUCCESS with only ONE key" test above (which
  // seeds a FRESH all-NULL row and so cannot distinguish a direct SET from
  // a COALESCE -- both produce the same result there), this seeds REAL
  // prior values in the three fields the sparse probe does NOT return,
  // exactly the "reindex already populated these, sweep re-probes with a
  // sparser sidecar later" scenario the review flagged. A direct SET
  // regresses this to NULL; COALESCE preserves it.
  test("SUCCESS with only ONE key populated does NOT null the other three when they already hold real prior values", async () => {
    seedDataset("nm000804");
    db.prepare(
      `UPDATE datasets
         SET power_line_frequency = 60, eeg_reference = 'average',
             placement_scheme = '10-20'
       WHERE dataset_id = 'nm000804'`,
    ).run();
    // This probe result is what a SPARSER re-probe would return -- only
    // sampling_frequency, as if the sidecar changed or a different
    // exemplar was sampled this time.
    const sparseFetch: typeof getBidsTreeStats = async () => emptyStats({ samplingFrequency: 999 });
    const result = await runSignalDefaultsSweep(env(), {
      pat: "fake-pat",
      fetchStats: sparseFetch,
    });
    expect(result.populated).toBe(1);
    const r = row("nm000804");
    expect(r.sampling_frequency).toBe(999);
    // The C1 assertions: these three must survive untouched.
    expect(r.power_line_frequency).toBe(60);
    expect(r.eeg_reference).toBe("average");
    expect(r.placement_scheme).toBe("10-20");
  });

  // #1162 review, I1: each of the four OR terms in the `found` gate must
  // independently route to SUCCESS. Only samplingFrequency was previously
  // exercised in isolation; deleting any ONE of the other three terms from
  // the `||` chain left every existing test green.
  test("powerLineFrequency alone routes to SUCCESS, not no-data", async () => {
    seedDataset("nm000805");
    const result = await runSignalDefaultsSweep(env(), {
      pat: "fake-pat",
      fetchStats: async () => emptyStats({ powerLineFrequency: 60 }),
    });
    expect(result.populated).toBe(1);
    expect(result.noData).toBe(0);
    const r = row("nm000805");
    expect(r.power_line_frequency).toBe(60);
  });

  test("eegReference alone routes to SUCCESS, not no-data", async () => {
    seedDataset("nm000806");
    const result = await runSignalDefaultsSweep(env(), {
      pat: "fake-pat",
      fetchStats: async () => emptyStats({ eegReference: "average" }),
    });
    expect(result.populated).toBe(1);
    expect(result.noData).toBe(0);
    const r = row("nm000806");
    expect(r.eeg_reference).toBe("average");
  });

  test("placementScheme alone routes to SUCCESS, not no-data", async () => {
    seedDataset("nm000807");
    const result = await runSignalDefaultsSweep(env(), {
      pat: "fake-pat",
      fetchStats: async () => emptyStats({ placementScheme: "10-20" }),
    });
    expect(result.populated).toBe(1);
    expect(result.noData).toBe(0);
    const r = row("nm000807");
    expect(r.placement_scheme).toBe("10-20");
  });
});

// #1162 review, C2: a swallowed transport failure inside the secondary
// probe must be treated identically to THROW (no write, row stays a
// candidate), never like genuine absence (which would stamp it away
// permanently).
describe("runSignalDefaultsSweep: channelMontageProbeError is treated like THROW, not NO SIDECAR", () => {
  test("a probe error leaves the row unstamped, prior values untouched, and is recorded in errors", async () => {
    seedDataset("nm000808");
    db.prepare(
      `UPDATE datasets
         SET sampling_frequency = 512, signal_defaults_at = NULL
       WHERE dataset_id = 'nm000808'`,
    ).run();
    const probeErrorFetch: typeof getBidsTreeStats = async () =>
      emptyStats({ channelMontageProbeError: "Failed to get blob abc123: HTTP 500" });
    const result = await runSignalDefaultsSweep(env(), {
      pat: "fake-pat",
      fetchStats: probeErrorFetch,
    });

    expect(result.populated).toBe(0);
    expect(result.noData).toBe(0);
    expect(result.errors).toEqual([
      { dataset_id: "nm000808", error: "probe: Failed to get blob abc123: HTTP 500" },
    ]);
    const r = row("nm000808");
    // Stays a candidate for the next run, exactly like THROW.
    expect(r.signal_defaults_at).toBeNull();
    // Prior good value is untouched (would survive the C1 COALESCE fix
    // anyway if this fell through to a write, but this outcome must not
    // write at all).
    expect(r.sampling_frequency).toBe(512);
  });
});

// #1162 review, I5: a GitHub-auth failure (missing/invalid App
// credentials) must be absorbed into a normal 200-shaped result, not
// propagate as a throw the route would misreport as "is migration 0072
// applied?".
describe("runSignalDefaultsSweep: GitHub-auth failure handling", () => {
  test("with a real candidate and no `pat` override, a missing-auth-config throw is caught and reported gracefully", async () => {
    seedDataset("nm000809");
    // No `pat` passed -- forces the real getDatasetsToken(env) path, which
    // throws synchronously ("No GitHub auth configured...") because this
    // test's env() has no GITHUB_APP_* / GITHUB_ADMIN_PAT bindings at all.
    const result = await runSignalDefaultsSweep(env());

    expect(result.processed).toBe(0);
    expect(result.populated).toBe(0);
    expect(result.noData).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.dataset_id).toBe("*");
    expect(result.errors[0]?.error).toContain("github-auth:");
    expect(result.errors[0]?.error).toContain("No GitHub auth configured");
    // The candidate is untouched -- still a candidate for the next run.
    const r = row("nm000809");
    expect(r.signal_defaults_at).toBeNull();
  });

  test("with zero candidates, no auth attempt is made -- the function returns cleanly even with no auth config", async () => {
    const result = await runSignalDefaultsSweep(env());
    expect(result).toEqual({
      processed: 0,
      populated: 0,
      noData: 0,
      errors: [],
      remaining: 0,
    });
  });
});

describe("runSignalDefaultsSweep: d1 write failure (suggestion from #1162 review)", () => {
  test("a D1 write failure after a SUCCESSFUL probe is recorded in errors, not thrown", async () => {
    seedDataset("nm000804a");
    const result = await runSignalDefaultsSweep(
      { DB: writeFailingD1(db), ENVIRONMENT: "test" } as Bindings,
      { pat: "fake-pat", fetchStats: async () => emptyStats({ samplingFrequency: 250 }) },
    );
    expect(result.populated).toBe(0);
    expect(result.errors).toEqual([
      { dataset_id: "nm000804a", error: "d1 write: simulated D1 write failure" },
    ]);
    // The probe succeeded but the write failed -- the row is left exactly
    // as it was (still unstamped), same recoverable shape as THROW.
    const r = row("nm000804a");
    expect(r.signal_defaults_at).toBeNull();
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

// ---------------------------------------------------------------------------
// Cron-only wrapper guard (issue #1166, Option 2) -- mirrors
// cron-dev-safety.test.ts's probe pattern. `runSignalDefaultsSweep` itself is
// intentionally left unguarded above (the admin route needs it on staging);
// `runSignalDefaultsSweepCron` is the thing `scheduled()` actually calls, and
// only IT carries the isNonProductionEnv fence.
// ---------------------------------------------------------------------------

describe("runSignalDefaultsSweepCron", () => {
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
      const result = await runSignalDefaultsSweepCron({
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
      // runSignalDefaultsSweep does not catch a candidate-query failure (by
      // design -- see its doc comment), so the wrapper's delegated call
      // rejects here too; the probe firing is what matters, not the outcome.
      await expect(
        runSignalDefaultsSweepCron({
          ENVIRONMENT: environment,
          DB: p.db,
        } as unknown as Bindings),
      ).rejects.toThrow(/probe: candidate query reached/);
      expect(p.touched()).toBe(true);
    });
  }

  test("the raw sweep still reaches D1 under development -- the admin backfill route is unaffected", async () => {
    // This is the asymmetry Option 2 exists for. If a future change added an
    // internal guard to runSignalDefaultsSweep itself, this is the test that
    // would catch it: staging's POST /admin/datasets/signal-defaults-sweep
    // calls the exported sweep directly, not the cron wrapper, so a guard
    // here would silently break that backfill with nothing else failing.
    const p = probe();
    await expect(
      runSignalDefaultsSweep({ ENVIRONMENT: "development", DB: p.db } as unknown as Bindings),
    ).rejects.toThrow(/probe: candidate query reached/);
    expect(p.touched()).toBe(true);
  });
});
