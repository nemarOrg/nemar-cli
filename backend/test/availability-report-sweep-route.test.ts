/**
 * Real POST /admin/datasets/availability-report-sweep route tests (epic #999
 * phase 2, #1001).
 *
 * Mirrors backend/test/data-integrity-sweep-route.test.ts: real engine
 * (bun:sqlite behind realD1, the real auth/admin middleware with a seeded
 * admin token, real route dispatch via Hono app.request()).
 *
 * writeAvailabilityReport has NO local test seam: verifyDatasetVersionS3
 * always issues a real S3 LIST regardless of candidate state (the same
 * structural constraint data-integrity-sweep-route.test.ts documents), and a
 * successful write additionally reaches GitHub's Contents API. So every test
 * in the first describe block below is scoped to a candidate set that yields
 * ZERO real candidates reaching the per-row loop -- seeded rows are either
 * excluded by the WHERE clause (no-repo / sandbox / already-stamped /
 * missing-only's data_complete filter) or the table is empty. That proves
 * the EXCLUSION side of each filter dimension for real, through the actual
 * route, with zero network calls.
 *
 * The INCLUSION side (a fully-qualifying row IS selected, and missing-only
 * selects exactly the data_complete=0 row) is pinned in the second describe
 * block against availabilityReportSweepCandidateQuery /
 * availabilityReportSweepRemainingQuery (services/availability-report.ts) --
 * the SAME query builders the route itself calls, not a hand-copied
 * duplicate, so there is nothing here that can silently drift. A plain
 * read-only SELECT never reaches writeAvailabilityReport, so it stays
 * network-free while still proving the predicate is correct.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import {
  AVAILABILITY_REPORT_SWEEP_MAX,
  availabilityReportSweepCandidateQuery,
  availabilityReportSweepRemainingQuery,
} from "../src/services/availability-report";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "avsweep-admin-key-0123456789abcdef0123456789abcdef";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let candidateLimitCalls: unknown[][];

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('avsweepadmin', 'avsweepadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const u = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='avsweepadmin'")
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
 * via realD1 -- this only adds an observation hook, not a fake response, so
 * the `?limit=999` clamp test can assert on the actual bound value without
 * needing 25+ real candidate rows (which would reach writeAvailabilityReport's
 * real S3/GitHub calls).
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

/** Seed a dataset row. `stamped` sets availability_report_at so it is excluded. */
function seedDataset(
  id: string,
  opts: {
    githubRepo?: string | null;
    isSandbox?: 0 | 1;
    stamped?: boolean;
    dataComplete?: 0 | 1 | null;
  } = {},
): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, is_sandbox, availability_report_at, data_complete)
     VALUES (?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    id,
    id,
    opts.githubRepo === undefined ? `nemarDatasets/${id}` : opts.githubRepo,
    opts.isSandbox ?? 0,
    opts.stamped ? "2026-07-01 00:00:00" : null,
    opts.dataComplete ?? null,
  );
}

beforeEach(async () => {
  db = freshDb();
  candidateLimitCalls = [];
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

describe("POST /admin/datasets/availability-report-sweep (real route, zero real candidates -> zero network calls)", () => {
  test("empty-table batch response shape { processed:0, written:0, errors:[], remaining:0 }", async () => {
    const res = await post("/admin/datasets/availability-report-sweep");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ processed: 0, written: 0, errors: [], remaining: 0 });
  });

  test("a sandbox row (excluded by WHERE) still returns the empty-batch shape", async () => {
    seedDataset("xx090001", { isSandbox: 1 });
    const res = await post("/admin/datasets/availability-report-sweep");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });

  test("a no-repo (catalog) row is excluded", async () => {
    seedDataset("ds000303", { githubRepo: null });
    const res = await post("/admin/datasets/availability-report-sweep");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });

  test("an already-stamped row is excluded", async () => {
    seedDataset("nm000300", { stamped: true });
    const res = await post("/admin/datasets/availability-report-sweep");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });

  test("?missing-only=1 excludes an otherwise-qualifying data_complete=1 row", async () => {
    // github_repo set, non-sandbox, unstamped -- a real candidate under the
    // base sweep, so this test ONLY ever calls the endpoint with
    // ?missing-only=1, which must exclude it via data_complete=1.
    seedDataset("nm000301", { dataComplete: 1 });
    const res = await post("/admin/datasets/availability-report-sweep?missing-only=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });

  test("?reset=1 response shape on an empty table", async () => {
    const res = await post("/admin/datasets/availability-report-sweep?reset=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ reset: 0 });
    // Reset is a direct UPDATE with no LIMIT -- must not touch the recorder.
    expect(candidateLimitCalls.length).toBe(0);
  });

  test("?reset=1 clears every stamped row regardless of repo/sandbox status", async () => {
    seedDataset("nm000300", { stamped: true });
    seedDataset("xx090001", { isSandbox: 1, stamped: true });
    seedDataset("nm000301"); // unstamped -- not touched by reset
    const res = await post("/admin/datasets/availability-report-sweep?reset=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reset).toBe(2);
    const row = db
      .query("SELECT availability_report_at FROM datasets WHERE dataset_id = 'nm000300'")
      .get() as { availability_report_at: string | null };
    expect(row.availability_report_at).toBeNull();
  });

  test("?limit=999 is clamped to AVAILABILITY_REPORT_SWEEP_MAX at the bound SQL parameter", async () => {
    const res = await post("/admin/datasets/availability-report-sweep?limit=999");
    expect(res.status).toBe(200);
    expect(candidateLimitCalls.length).toBe(1);
    const bound = candidateLimitCalls[0];
    // Asserted against the constant rather than a literal so the clamp and the
    // cap can never disagree; the constant carries the rationale for its value.
    expect(bound[bound.length - 1]).toBe(AVAILABILITY_REPORT_SWEEP_MAX);
  });

  test("?limit=0 is clamped up to 1", async () => {
    await post("/admin/datasets/availability-report-sweep?limit=0");
    const bound = candidateLimitCalls[0];
    expect(bound[bound.length - 1]).toBe(1);
  });

  test("non-admin cannot run the sweep", async () => {
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified)
       VALUES ('avsweepuser', 'avsweepuser@example.org', 'x', 'approved', 'member', 1)`,
    );
    const u = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username='avsweepuser'")
      .get();
    const userKey = "avsweep-user-key-0123456789abcdef0123456789abcdef";
    await db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(u?.id ?? 0, await hashApiKey(userKey), userKey.slice(0, 8));
    const res = await app.request(
      "/admin/datasets/availability-report-sweep",
      { method: "POST", headers: { Authorization: `Bearer ${userKey}` } },
      env(),
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Pinned candidate/remaining SQL (read-only, no route dispatch)
// ---------------------------------------------------------------------------

// availabilityReportSweepCandidateQuery/-RemainingQuery are the SAME builders
// the route imports (services/availability-report.ts) -- run directly here
// ONLY to prove positive selection (a fully-qualifying row IS a candidate,
// and missing-only selects exactly the data_complete=0 row) without ever
// calling writeAvailabilityReport; see the module doc comment for why the
// real route can't safely exercise that with seeded candidates. A generous
// bound limit (well above anything seeded in these tests) stands in for the
// route's own clamped `?limit=` value, which is exercised separately above.
const GENEROUS_LIMIT = 1000;

const candidates = (missingOnly: boolean) =>
  (
    db.query(availabilityReportSweepCandidateQuery(missingOnly)).all(GENEROUS_LIMIT) as {
      dataset_id: string;
    }[]
  ).map((r) => r.dataset_id);

const remainingCount = () =>
  (db.query(availabilityReportSweepRemainingQuery(false)).get() as { n: number }).n;

describe("availability-report-sweep candidate SQL (pinned, no route dispatch)", () => {
  test("candidate query excludes catalog-only (no repo), sandbox, and already-stamped rows", () => {
    seedDataset("nm000300"); // candidate
    seedDataset("on000301"); // candidate
    seedDataset("ds000303", { githubRepo: null }); // excluded: no repo
    seedDataset("xx000304", { isSandbox: 1 }); // excluded: sandbox
    seedDataset("nm000305", { stamped: true }); // excluded: already stamped

    expect(candidates(false)).toEqual(["nm000300", "on000301"]);
  });

  test("?missing-only candidate query selects only data_complete=0 among otherwise-qualifying rows", () => {
    seedDataset("nm000300", { dataComplete: 0 }); // candidate under missing-only
    seedDataset("nm000301", { dataComplete: 1 }); // excluded under missing-only
    seedDataset("nm000302", { dataComplete: null }); // excluded under missing-only (not yet audited)

    expect(candidates(false)).toEqual(["nm000300", "nm000301", "nm000302"]);
    expect(candidates(true)).toEqual(["nm000300"]);
  });

  test("remaining count uses the same scoping as the base candidate query and decreases as rows are stamped", () => {
    seedDataset("nm000300");
    seedDataset("on000301");
    expect(remainingCount()).toBe(2);

    db.prepare(
      "UPDATE datasets SET availability_report_at = datetime('now') WHERE dataset_id = ?",
    ).run("nm000300");
    expect(remainingCount()).toBe(1);
    expect(candidates(false)).toEqual(["on000301"]);
  });
});
