/**
 * Real POST /admin/datasets/data-integrity-sweep route tests (epic #967
 * Phase 3, #970).
 *
 * test/data-integrity-sweep.unit.test.ts exercises the endpoint's SQL by
 * hand-copying it into local helper functions -- useful for pinning the exact
 * candidate/write logic, but it never calls the real Hono route, so a
 * scoping/validation change in the actual handler could silently diverge from
 * those helpers without failing anything. This file closes that gap: real
 * engine (bun:sqlite behind realD1, the real auth/admin middleware with a
 * seeded admin token, real route dispatch via Hono app.request()), mirroring
 * backend/test/exemplar-endpoint.test.ts.
 *
 * Deliberately scoped to an EMPTY (or non-candidate) datasets table so every
 * test here exercises parsing/validation/response shape with ZERO S3 calls --
 * verifyDatasetVersionS3 does real, uncontrolled network I/O
 * (listObjectPages hardcodes a live `*.s3.*.amazonaws.com` host with no
 * local-test seam, the same structural constraint Phase 1/2 hit), so it is
 * only exercised once a real candidate reaches the batch loop. No mocks: the
 * `recordingD1` wrapper below still forwards every call to real SQLite --
 * it only additionally records the bound LIMIT parameter so the clamp test
 * can observe it without needing >30 real candidates (which would reach the
 * S3 call this file exists to avoid).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "sweep-admin-key-0123456789abcdef0123456789abcdef";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let candidateLimitCalls: unknown[][];

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('sweepadmin', 'sweepadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='sweepadmin'").get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

/**
 * Real-engine D1 shim (like realD1) that ADDITIONALLY records the parameters
 * bound to the sweep's candidate SELECT (identified by its `LIMIT ?` --
 * the only sweep query with one; `?reset=1`'s UPDATE and the `remaining`
 * COUNT query have none). Every query still executes against the real
 * SQLite `db` via realD1 -- this only adds an observation hook, not a fake
 * response, so the `?limit=999` clamp test can assert on the actual bound
 * value without needing 30+ real candidate rows (which would reach
 * verifyDatasetVersionS3's real S3 call).
 */
function recordingD1(target: Database, calls: unknown[][]): D1Database {
  const base = realD1(target);
  return {
    prepare(sql: string) {
      // Unbound statement (e.g. the ?reset=1 UPDATE, which never calls
      // .bind()) must still work directly off `stmt` -- so run/first/all
      // delegate straight through, and only bind() gets an extra hook.
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

beforeEach(async () => {
  db = freshDb();
  candidateLimitCalls = [];
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

describe("POST /admin/datasets/data-integrity-sweep (real route, empty table -> zero S3 calls)", () => {
  test("?older-than=abc -> 400 before any candidate query runs", async () => {
    const res = await post("/admin/datasets/data-integrity-sweep?older-than=abc");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("abc");
    // Validation short-circuits before the candidate SELECT is even prepared.
    expect(candidateLimitCalls.length).toBe(0);
  });

  test("?older-than=-5 (negative) -> 400", async () => {
    const res = await post("/admin/datasets/data-integrity-sweep?older-than=-5");
    expect(res.status).toBe(400);
  });

  test("?limit=999 is clamped to 30 at the bound SQL parameter", async () => {
    const res = await post("/admin/datasets/data-integrity-sweep?limit=999");
    expect(res.status).toBe(200);
    expect(candidateLimitCalls.length).toBe(1);
    // The candidate query's params are [limit] (no --older-than), so the last
    // (only) bound value is the clamped limit.
    const bound = candidateLimitCalls[0];
    expect(bound[bound.length - 1]).toBe(30);
  });

  test("?limit=0 is clamped up to 1", async () => {
    await post("/admin/datasets/data-integrity-sweep?limit=0");
    const bound = candidateLimitCalls[0];
    expect(bound[bound.length - 1]).toBe(1);
  });

  test("?reset=1 response shape on an empty table", async () => {
    const res = await post("/admin/datasets/data-integrity-sweep?reset=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ reset: 0 });
    // Reset is a direct UPDATE with no LIMIT -- must not touch the recorder.
    expect(candidateLimitCalls.length).toBe(0);
  });

  test("empty-table batch response shape { processed:0, complete:0, incomplete:0, unknown:0, errors:[], remaining:0 }", async () => {
    const res = await post("/admin/datasets/data-integrity-sweep");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      processed: 0,
      complete: 0,
      incomplete: 0,
      unknown: 0,
      errors: [],
      remaining: 0,
    });
  });

  test("a sandbox-only table (excluded by WHERE) still returns the empty-batch shape", async () => {
    db.query(
      "INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, is_sandbox) VALUES ('xx090001', 'x', 1, 'nemarDatasets/xx090001', 1)",
    ).run();
    const res = await post("/admin/datasets/data-integrity-sweep");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });

  test("non-admin cannot run the sweep", async () => {
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified)
       VALUES ('sweepuser', 'sweepuser@example.org', 'x', 'approved', 'member', 1)`,
    );
    const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='sweepuser'").get();
    const userKey = "sweep-user-key-0123456789abcdef0123456789abcdef";
    await db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(u?.id ?? 0, await hashApiKey(userKey), userKey.slice(0, 8));
    const res = await app.request(
      "/admin/datasets/data-integrity-sweep",
      { method: "POST", headers: { Authorization: `Bearer ${userKey}` } },
      env(),
    );
    expect(res.status).toBe(403);
  });
});
