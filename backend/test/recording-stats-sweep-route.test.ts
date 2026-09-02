/**
 * Real `POST /admin/datasets/recording-stats-sweep` route tests (epic #1144
 * Phase 2, issue #1146; PR #1157 review finding C3).
 *
 * Mirrors backend/test/availability-report-sweep-route.test.ts: real engine
 * (bun:sqlite behind realD1, the real auth/admin middleware with a seeded
 * admin token, real route dispatch via Hono app.request()).
 *
 * `runRecordingStatsSweep` reaches a real S3 GET (`getZarrIndex`) for any
 * actual candidate, so -- like the availability-report sweep -- every test
 * in the first describe block is scoped to a candidate set that yields ZERO
 * real candidates reaching the per-row loop (seeded rows are excluded by the
 * WHERE clause, or the table is empty). That proves the EXCLUSION side of
 * each filter dimension, the `?limit=` parsing, and the 500-on-query-failure
 * branch for real, through the actual route, with zero network calls. The
 * INCLUSION side and the full three-way outcome handling are covered by
 * backend/test/recording-stats-sweep.test.ts, which drives
 * `runRecordingStatsSweep` directly with the network boundary substituted.
 *
 * C3: before this PR, `?reset=1`'s SQL was hand-copied into a root test/
 * file as a local `RESET_SQL` constant, so dropping a column from the REAL
 * route's reset (e.g. `recording_count = NULL`) passed every test -- the
 * test validated its own copy, not the route. This file exercises the
 * ACTUAL route (RECORDING_STATS_SWEEP_RESET_SQL, imported by the route
 * itself, not re-typed here) and checks each reset column individually.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { RECORDING_STATS_SWEEP_MAX } from "../src/services/recording-stats-sweep";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "rssweep-admin-key-0123456789abcdef0123456789abcdef";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let candidateLimitCalls: unknown[][];

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('rssweepadmin', 'rssweepadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const u = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='rssweepadmin'")
    .get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

/**
 * Real-engine D1 shim (like realD1) that ADDITIONALLY records the parameters
 * bound to the sweep's candidate SELECT (identified by its `LIMIT ?` -- the
 * only sweep query with one; `?reset=1`'s UPDATE and the `remaining` COUNT
 * query have none). Every query still executes against the real SQLite `db`
 * via realD1 -- an observation hook, not a fake response -- so the
 * `?limit=999999` clamp test can assert on the actual bound value without
 * needing 200+ real candidate rows (which would reach the real S3 GET).
 */
function recordingD1(target: Database, calls: unknown[][]): D1Database {
  const base = realD1(target);
  return {
    prepare(sql: string) {
      const stmt = base.prepare(sql);
      return {
        bind(...args: unknown[]) {
          if (sql.includes("LIMIT ?")) calls.push(args);
          return stmt.bind(...args);
        },
        run: () => stmt.run(),
        first: <T>() => stmt.first<T>(),
        all: <T>() => stmt.all<T>(),
      };
    },
  } as unknown as D1Database;
}

function env(): Bindings {
  return {
    DB: recordingD1(db, candidateLimitCalls),
    ENVIRONMENT: "development",
  } as Bindings;
}

function post(path: string): Promise<Response> {
  return app.request(
    path,
    { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
    env(),
  );
}

/** Seed a dataset row. Defaults are a fully-qualifying candidate; override
 *  individual fields to test each exclusion. */
function seedDataset(
  id: string,
  opts: {
    status?: string;
    zarrStatus?: string | null;
    stamped?: boolean;
  } = {},
): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility)
     VALUES (?, ?, 1, ?, 'public')`,
  ).run(id, id, opts.status ?? "active");
  db.prepare("UPDATE datasets SET zarr_status = ? WHERE dataset_id = ?").run(
    opts.zarrStatus === undefined ? "ready" : opts.zarrStatus,
    id,
  );
  if (opts.stamped) {
    db.prepare(
      "UPDATE datasets SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.recording_stats_at', '2026-08-01 00:00:00') WHERE dataset_id = ?",
    ).run(id);
  }
}

beforeEach(async () => {
  db = freshDb();
  candidateLimitCalls = [];
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

describe("POST /admin/datasets/recording-stats-sweep (real route, zero real candidates -> zero network calls)", () => {
  test("empty-table batch response shape { processed:0, measured:0, unmeasured:0, errors:[], remaining:0 }", async () => {
    const res = await post("/admin/datasets/recording-stats-sweep");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ processed: 0, measured: 0, unmeasured: 0, errors: [], remaining: 0 });
  });

  test("a non-active row (excluded by WHERE) still returns the empty-batch shape", async () => {
    seedDataset("nm000500", { status: "archived" });
    const res = await post("/admin/datasets/recording-stats-sweep");
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });

  test("a non-zarr-ready row is excluded", async () => {
    seedDataset("nm000501", { zarrStatus: null });
    const res = await post("/admin/datasets/recording-stats-sweep");
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });

  test("an already-stamped row is excluded", async () => {
    seedDataset("nm000502", { stamped: true });
    const res = await post("/admin/datasets/recording-stats-sweep");
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });

  test("?reset=1 response shape on an empty table", async () => {
    const res = await post("/admin/datasets/recording-stats-sweep?reset=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ reset: 0 });
    // Reset is a direct UPDATE with no LIMIT -- must not touch the recorder.
    expect(candidateLimitCalls.length).toBe(0);
  });

  test("?reset=1 clears EVERY one of the 9 columns on a stamped row (C3)", async () => {
    seedDataset("nm000503", { stamped: true });
    db.prepare(
      `UPDATE datasets
         SET total_recording_duration = 5000, recording_duration_min = 100,
             recording_duration_max = 200, recording_count = 3,
             recordings_unavailable = 1, recordings_measured = 2,
             channel_count_min = 19, channel_count_max = 24
       WHERE dataset_id = 'nm000503'`,
    ).run();

    const res = await post("/admin/datasets/recording-stats-sweep?reset=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reset).toBe(1);

    const r = db
      .query(
        "SELECT *, json_extract(sweep_stamps, '$.recording_stats_at') AS recording_stats_at FROM datasets WHERE dataset_id = 'nm000503'",
      )
      .get() as Record<string, unknown>;
    // Every one of the 9 columns, checked individually -- a reset that
    // forgets exactly one (e.g. recording_count) would still pass a test
    // that only checks `reset: 1` or a couple of the columns.
    expect(r.recording_stats_at).toBeNull();
    expect(r.total_recording_duration).toBeNull();
    expect(r.recording_duration_min).toBeNull();
    expect(r.recording_duration_max).toBeNull();
    expect(r.recording_count).toBeNull();
    expect(r.recordings_unavailable).toBeNull();
    expect(r.recordings_measured).toBeNull();
    expect(r.channel_count_min).toBeNull();
    expect(r.channel_count_max).toBeNull();
  });

  test("?reset=1 clears a stamped row regardless of status/zarr_status (independent of candidacy)", async () => {
    seedDataset("nm000504", { status: "archived", zarrStatus: "failed", stamped: true });
    const res = await post("/admin/datasets/recording-stats-sweep?reset=1");
    const body = await res.json();
    expect(body.reset).toBe(1);
    const r = db
      .query(
        "SELECT json_extract(sweep_stamps, '$.recording_stats_at') AS recording_stats_at FROM datasets WHERE dataset_id = 'nm000504'",
      )
      .get() as { recording_stats_at: string | null };
    expect(r.recording_stats_at).toBeNull();
  });

  test("?reset=1 does not touch an unstamped row", async () => {
    seedDataset("nm000505");
    const res = await post("/admin/datasets/recording-stats-sweep?reset=1");
    const body = await res.json();
    expect(body.reset).toBe(0);
  });

  test("default limit (no ?limit=) is bound as 50", async () => {
    await post("/admin/datasets/recording-stats-sweep");
    expect(candidateLimitCalls.length).toBe(1);
    const bound = candidateLimitCalls[0];
    expect(bound[bound.length - 1]).toBe(50);
  });

  test("?limit=999999 is clamped to RECORDING_STATS_SWEEP_MAX at the bound SQL parameter", async () => {
    await post("/admin/datasets/recording-stats-sweep?limit=999999");
    const bound = candidateLimitCalls[0];
    // Asserted against the constant rather than a literal so the clamp and
    // the cap can never disagree; the constant carries the rationale.
    expect(bound[bound.length - 1]).toBe(RECORDING_STATS_SWEEP_MAX);
  });

  test("?limit=0 is clamped up to 1", async () => {
    await post("/admin/datasets/recording-stats-sweep?limit=0");
    const bound = candidateLimitCalls[0];
    expect(bound[bound.length - 1]).toBe(1);
  });

  test("?limit=not-a-number falls back to the default of 50", async () => {
    await post("/admin/datasets/recording-stats-sweep?limit=banana");
    const bound = candidateLimitCalls[0];
    expect(bound[bound.length - 1]).toBe(50);
  });

  test("non-admin cannot run the sweep", async () => {
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified)
       VALUES ('rssweepuser', 'rssweepuser@example.org', 'x', 'approved', 'member', 1)`,
    );
    const u = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username='rssweepuser'")
      .get();
    const userKey = "rssweep-user-key-0123456789abcdef0123456789abcdef";
    await db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(u?.id ?? 0, await hashApiKey(userKey), userKey.slice(0, 8));
    const res = await app.request(
      "/admin/datasets/recording-stats-sweep",
      { method: "POST", headers: { Authorization: `Bearer ${userKey}` } },
      env(),
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Candidate query failure -> 500 (migration 0070 not applied)
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(import.meta.dir, "..", "src/db/migrations");

/** Every migration BEFORE 0070, so admin auth tables (earlier migrations)
 *  exist but the recording-stats columns/predicate do not -- reproduces
 *  "is migration 0070 applied?" for real instead of asserting on a
 *  fabricated D1 error. Stops before 0070 (not merely skipping it) because
 *  the 0071 rebuild (#1182) recreates the recording-stats columns
 *  unconditionally, so "0070 skipped but later migrations applied" is no
 *  longer a constructible schema. */
function dbMissingMigration0070(): Database {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < "0070")
    .sort();
  const built = new Database(":memory:");
  for (const file of files) {
    built.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  return built;
}

describe("POST /admin/datasets/recording-stats-sweep: candidate query failure", () => {
  test("returns 500 with a migration-0070 hint when the recording-stats columns don't exist", async () => {
    db = dbMissingMigration0070();
    candidateLimitCalls = [];
    app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.route("/admin", adminRoutes);
    await seedAdmin();

    const res = await post("/admin/datasets/recording-stats-sweep");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("migration 0070");
  });
});
