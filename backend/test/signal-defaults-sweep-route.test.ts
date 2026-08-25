/**
 * Real `POST /admin/datasets/signal-defaults-sweep` route tests (epic #1144
 * Phase 2b, issue #1153). Mirrors
 * backend/test/recording-stats-sweep-route.test.ts: real engine (bun:sqlite
 * behind realD1, the real auth/admin middleware with a seeded admin token,
 * real route dispatch via Hono app.request()).
 *
 * `runSignalDefaultsSweep` reaches the real GitHub App token mint
 * (`getDatasetsToken`) for any actual candidate, so every test in the first
 * describe block is scoped to a candidate set that yields ZERO real
 * candidates reaching the per-row loop -- proving the EXCLUSION side of each
 * filter dimension, the `?limit=` parsing, the 500-on-query-failure branch,
 * and (distinct from the recording-stats sibling, since this sweep's
 * network boundary is GitHub auth, not S3) that the sweep never attempts to
 * mint a GitHub token when there is nothing to probe -- all for real, with
 * zero network calls and NO GitHub App / PAT credentials configured on
 * `env()` at all. If `runSignalDefaultsSweep` ever called `getDatasetsToken`
 * unconditionally, every test below would 500 with "No GitHub auth
 * configured" instead of returning the empty-batch 200. The INCLUSION side
 * and the full three-way outcome handling are covered by
 * backend/test/signal-defaults-sweep.test.ts, which drives
 * `runSignalDefaultsSweep` directly with both network boundaries
 * substituted.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { SIGNAL_DEFAULTS_SWEEP_MAX } from "../src/services/signal-defaults-sweep";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "sdsweep-admin-key-0123456789abcdef0123456789abcdef";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let candidateLimitCalls: unknown[][];

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('sdsweepadmin', 'sdsweepadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const u = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='sdsweepadmin'")
    .get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

/** Real-engine D1 shim (like realD1) that ADDITIONALLY records the
 *  parameters bound to the sweep's candidate SELECT (identified by its
 *  `LIMIT ?` -- the only sweep query with one). Mirrors
 *  recording-stats-sweep-route.test.ts's recordingD1. */
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

// Deliberately NO GitHub App / PAT bindings here -- see the module doc: if
// the sweep ever tries to mint a token on a zero-candidate batch, every test
// below fails loudly with a 500, not a false-pass.
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
    githubRepo?: string | null;
    stamped?: boolean;
    isSandbox?: boolean;
  } = {},
): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, github_repo)
     VALUES (?, ?, 1, ?, 'public', ?)`,
  ).run(
    id,
    id,
    opts.status ?? "active",
    opts.githubRepo === undefined ? `nemarDatasets/${id}` : opts.githubRepo,
  );
  if (opts.stamped) {
    db.prepare(
      "UPDATE datasets SET signal_defaults_at = '2026-08-01 00:00:00' WHERE dataset_id = ?",
    ).run(id);
  }
  if (opts.isSandbox) {
    db.prepare("UPDATE datasets SET is_sandbox = 1 WHERE dataset_id = ?").run(id);
  }
}

beforeEach(async () => {
  db = freshDb();
  candidateLimitCalls = [];
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

describe("POST /admin/datasets/signal-defaults-sweep (real route, zero real candidates -> zero network calls, no GitHub auth configured)", () => {
  test("empty-table batch response shape { processed:0, populated:0, noData:0, errors:[], remaining:0 }", async () => {
    const res = await post("/admin/datasets/signal-defaults-sweep");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ processed: 0, populated: 0, noData: 0, errors: [], remaining: 0 });
  });

  test("a non-active row (excluded by WHERE) still returns the empty-batch shape", async () => {
    seedDataset("nm000900", { status: "archived" });
    const res = await post("/admin/datasets/signal-defaults-sweep");
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });

  test("a row with no github_repo is excluded", async () => {
    seedDataset("nm000901", { githubRepo: null });
    const res = await post("/admin/datasets/signal-defaults-sweep");
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });

  test("an already-stamped row is excluded", async () => {
    seedDataset("nm000902", { stamped: true });
    const res = await post("/admin/datasets/signal-defaults-sweep");
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });

  // #1162 review, I3: matches channel-montage-sweep / hed-sweep (both cited
  // as this sweep's model), which exclude is_sandbox for the same reason --
  // prod sandbox (xx*) datasets churn continuously (AGENTS.md's 14-day
  // cron), and unlike recording-stats-sweep's one cheap S3 GET, a candidate
  // here costs a full GitHub tree walk against a tight 15/30 budget.
  test("a sandbox (is_sandbox=1) row is excluded", async () => {
    seedDataset("xx090903", { isSandbox: true });
    const res = await post("/admin/datasets/signal-defaults-sweep");
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });

  test("?reset=1 response shape on an empty table", async () => {
    const res = await post("/admin/datasets/signal-defaults-sweep?reset=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ reset: 0 });
    expect(candidateLimitCalls.length).toBe(0);
  });

  test("?reset=1 clears EVERY one of the 5 columns on a stamped row", async () => {
    seedDataset("nm000903", { stamped: true });
    db.prepare(
      `UPDATE datasets
         SET sampling_frequency = 500, power_line_frequency = 60,
             eeg_reference = 'average', placement_scheme = '10-20'
       WHERE dataset_id = 'nm000903'`,
    ).run();

    const res = await post("/admin/datasets/signal-defaults-sweep?reset=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reset).toBe(1);

    const r = db.query("SELECT * FROM datasets WHERE dataset_id = 'nm000903'").get() as Record<
      string,
      unknown
    >;
    expect(r.signal_defaults_at).toBeNull();
    expect(r.sampling_frequency).toBeNull();
    expect(r.power_line_frequency).toBeNull();
    expect(r.eeg_reference).toBeNull();
    expect(r.placement_scheme).toBeNull();
  });

  test("?reset=1 does not touch an unstamped row", async () => {
    seedDataset("nm000904");
    const res = await post("/admin/datasets/signal-defaults-sweep?reset=1");
    const body = await res.json();
    expect(body.reset).toBe(0);
  });

  test("default limit (no ?limit=) is bound as 15", async () => {
    await post("/admin/datasets/signal-defaults-sweep");
    expect(candidateLimitCalls.length).toBe(1);
    const bound = candidateLimitCalls[0];
    expect(bound[bound.length - 1]).toBe(15);
  });

  test("?limit=999999 is clamped to SIGNAL_DEFAULTS_SWEEP_MAX (30) at the bound SQL parameter", async () => {
    await post("/admin/datasets/signal-defaults-sweep?limit=999999");
    const bound = candidateLimitCalls[0];
    expect(bound[bound.length - 1]).toBe(SIGNAL_DEFAULTS_SWEEP_MAX);
  });

  test("?limit=0 is clamped up to 1", async () => {
    await post("/admin/datasets/signal-defaults-sweep?limit=0");
    const bound = candidateLimitCalls[0];
    expect(bound[bound.length - 1]).toBe(1);
  });

  test("?limit=not-a-number falls back to the default of 15", async () => {
    await post("/admin/datasets/signal-defaults-sweep?limit=banana");
    const bound = candidateLimitCalls[0];
    expect(bound[bound.length - 1]).toBe(15);
  });

  test("non-admin cannot run the sweep", async () => {
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified)
       VALUES ('sdsweepuser', 'sdsweepuser@example.org', 'x', 'approved', 'member', 1)`,
    );
    const u = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username='sdsweepuser'")
      .get();
    const userKey = "sdsweep-user-key-0123456789abcdef0123456789abcdef";
    await db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(u?.id ?? 0, await hashApiKey(userKey), userKey.slice(0, 8));
    const res = await app.request(
      "/admin/datasets/signal-defaults-sweep",
      { method: "POST", headers: { Authorization: `Bearer ${userKey}` } },
      env(),
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Candidate query failure -> 500 (migration 0071 not applied)
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(import.meta.dir, "..", "src/db/migrations");

/** Every migration EXCEPT 0071, so admin auth tables (earlier migrations)
 *  exist but the signal-defaults columns/predicate do not -- reproduces "is
 *  migration 0071 applied?" for real instead of asserting on a fabricated
 *  D1 error. */
function dbMissingMigration0071(): Database {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f !== "0071_signal_defaults.sql")
    .sort();
  const built = new Database(":memory:");
  for (const file of files) {
    built.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  return built;
}

describe("POST /admin/datasets/signal-defaults-sweep: candidate query failure", () => {
  test("returns 500 with a migration-0071 hint when the signal-defaults columns don't exist", async () => {
    db = dbMissingMigration0071();
    candidateLimitCalls = [];
    app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.route("/admin", adminRoutes);
    await seedAdmin();

    const res = await post("/admin/datasets/signal-defaults-sweep");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("migration 0071");
  });
});
