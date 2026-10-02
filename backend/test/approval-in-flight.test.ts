/**
 * `approval_in_flight` on GET /admin/publish/requests (ADR 0080).
 *
 * The list route reports, per request, whether an approval run is live, from the
 * SAME predicate the dispatch route claims with (services/approval-dispatch.ts).
 * A page reads this boolean and never hard-codes the lease, so what is pinned
 * here is the rule itself: a run is live for 15 minutes after its last sign of
 * life, there are two ways to run an approval and both count, and a request that
 * can no longer run is never live.
 *
 * Real engine only: bun:sqlite behind realD1, the real auth middleware (seeded
 * admin + hashed key) and the real route via Hono app.request(). Ages are set
 * with SQLite's own `datetime('now', '-N minutes')` so the comparison the route
 * makes is the comparison production makes, with no clock to fake. The ages used
 * sit well clear of the 15-minute edge (14 and 16, never 15), so a slow run
 * cannot flip a case.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "inflight-admin-key-0123456789abcdef0123456789abcdef";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminId: number;

interface Seed {
  status: string;
  /** A recorded step failure. Null/omitted means the run has not failed. */
  lastError?: string;
  /** SQLite modifier such as "-20 minutes", or null for NULL. */
  dispatchedAt?: string | null;
  updatedAt?: string;
  requestedBy?: number | null;
}

let counter = 0;
function seedRequest(seed: Seed): string {
  const datasetId = `nm0${String(900000 + ++counter)}`;
  const modifier = (m: string | null | undefined) => (m ? `datetime('now', '${m}')` : "NULL");
  db.run(
    `INSERT INTO publication_requests
       (dataset_id, status, requested_by, requested_at, updated_at,
        approval_requested_by, approval_dispatched_at, last_error)
     VALUES ('${datasetId}', '${seed.status}', ${adminId}, datetime('now', '-3 hours'),
             ${seed.updatedAt ? modifier(seed.updatedAt) : "datetime('now', '-3 hours')"},
             ${seed.requestedBy ?? "NULL"}, ${modifier(seed.dispatchedAt)},
             ${seed.lastError ? `'${seed.lastError}'` : "NULL"})`,
  );
  return datasetId;
}

async function list(): Promise<Record<string, Record<string, unknown>>> {
  const res = await app.request(
    "/admin/publish/requests",
    { headers: { Authorization: `Bearer ${ADMIN_KEY}`, "X-CLI-Version": "99.0.0" } },
    { DB: realD1(db), ENVIRONMENT: "test" } as Bindings,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { requests: Array<{ dataset_id: string }> };
  return Object.fromEntries(body.requests.map((r) => [r.dataset_id, r]));
}

beforeEach(async () => {
  db = freshDb();
  counter = 0;
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('inflightadmin', 'inflightadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const u = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='inflightadmin'")
    .get();
  if (!u) throw new Error("seed: user insert failed");
  adminId = u.id;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    adminId,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
});

describe("approval_in_flight: a web-dispatched run", () => {
  test("is in flight when dispatched within the lease", async () => {
    const id = seedRequest({ status: "requested", dispatchedAt: "-14 minutes" });
    expect((await list())[id].approval_in_flight).toBe(true);
  });

  test("is not in flight once the dispatch is older than the lease and nothing followed it", async () => {
    // The executor never started: a queued runner that vanished. The lease
    // lapses on its own, which is the only way a dead dispatch is released.
    const id = seedRequest({ status: "requested", dispatchedAt: "-16 minutes" });
    expect((await list())[id].approval_in_flight).toBe(false);
  });

  test("a stale dispatch is still in flight while the run keeps making progress", async () => {
    // Dispatched long ago, but the orchestrator bumped updated_at a minute ago:
    // a long S3 lock loop. The second clause keeps it live.
    const id = seedRequest({
      status: "approving",
      dispatchedAt: "-2 hours",
      updatedAt: "-1 minutes",
    });
    expect((await list())[id].approval_in_flight).toBe(true);
  });

  test("a stale dispatch with stale progress is not in flight", async () => {
    const id = seedRequest({
      status: "approving",
      dispatchedAt: "-2 hours",
      updatedAt: "-16 minutes",
    });
    expect((await list())[id].approval_in_flight).toBe(false);
  });
});

describe("approval_in_flight: a terminal-driven run", () => {
  // A direct CLI approval never sets approval_dispatched_at, so only the
  // second clause can see it. Without it the web could start a second run
  // beside a person's own.
  test("approving with a fresh updated_at and no dispatch is in flight", async () => {
    const id = seedRequest({ status: "approving", dispatchedAt: null, updatedAt: "-1 minutes" });
    const row = (await list())[id];
    expect(row.approval_dispatched_at).toBeNull();
    expect(row.approval_in_flight).toBe(true);
  });

  test("the same row with updated_at 20 minutes old is not in flight", async () => {
    const id = seedRequest({ status: "approving", dispatchedAt: null, updatedAt: "-20 minutes" });
    expect((await list())[id].approval_in_flight).toBe(false);
  });

  test("a requested row that nobody touched is not in flight, however fresh its updated_at", async () => {
    // updated_at alone proves nothing for a request that never started: only
    // `approving` is evidence of a run. A fresh `requested` row is just a
    // request that was filed (or edited) a moment ago.
    const id = seedRequest({ status: "requested", dispatchedAt: null, updatedAt: "-1 minutes" });
    expect((await list())[id].approval_in_flight).toBe(false);
  });
});

describe("approval_in_flight: the edge of the lease", () => {
  // A lease runs for 15 minutes AFTER the last sign of life, and the sign of life
  // at exactly 15 minutes still counts (>=, not >). SQLite's clock moves a whole
  // second at a time, so a timestamp seeded "exactly 15 minutes ago" is exactly
  // that only if the second did not tick before the route read it. Each case
  // seeds, checks the threshold the route compares against is still the seeded
  // value, and only then asserts; if the second ticked it discards that row and
  // tries again, so the assertion is never made on a row that was not on the edge.
  async function onTheEdge(seed: Seed, column: "approval_dispatched_at" | "updated_at") {
    for (let attempt = 0; attempt < 40; attempt++) {
      const id = seedRequest({
        ...seed,
        ...(column === "approval_dispatched_at"
          ? { dispatchedAt: "-15 minutes" }
          : { updatedAt: "-15 minutes" }),
      });
      const seeded = db
        .query<{ v: string }, [string]>(
          `SELECT ${column} AS v FROM publication_requests WHERE dataset_id = ?`,
        )
        .get(id)?.v;
      const inFlight = (await list())[id].approval_in_flight;
      const threshold = db
        .query<{ t: string }, []>("SELECT datetime('now', '-15 minutes') AS t")
        .get()?.t;
      if (seeded === threshold) return inFlight;
      db.run("DELETE FROM publication_requests WHERE dataset_id = ?", [id]);
    }
    throw new Error("the clock ticked on every attempt; cannot place a row on the edge");
  }

  test("a dispatch exactly 15 minutes old is still in flight (>=, not >)", async () => {
    expect(await onTheEdge({ status: "requested" }, "approval_dispatched_at")).toBe(true);
  });

  test("an approving run whose last sign of life was exactly 15 minutes ago is still in flight", async () => {
    expect(await onTheEdge({ status: "approving" }, "updated_at")).toBe(true);
  });
});

describe("approval_in_flight: a run that failed", () => {
  // The orchestrator records a step failure in last_error (and bumps updated_at)
  // and answers 500. The CLI then retries after a fixed 10 second wait, so a
  // failure cannot read as "stopped" at once: a second executor launched in that
  // wait would run beside the retry. After the grace window it is stalled, not
  // held for the whole 15 minute lease.
  test("a failure recorded seconds ago is still in flight: its retry is about to start", async () => {
    const id = seedRequest({
      status: "approving",
      lastError: "EZID 503",
      updatedAt: "-10 seconds",
    });
    expect((await list())[id].approval_in_flight).toBe(true);
  });

  test("a failure recorded a few minutes ago is stalled, though the lease has not lapsed", async () => {
    const id = seedRequest({
      status: "approving",
      lastError: "EZID 503",
      updatedAt: "-5 minutes",
    });
    expect((await list())[id].approval_in_flight).toBe(false);
  });

  test("the same row with no error recorded is still running", async () => {
    const id = seedRequest({ status: "approving", updatedAt: "-5 minutes" });
    expect((await list())[id].approval_in_flight).toBe(true);
  });

  test("an old error left beside a fresh dispatch reads as failed, which is why the dispatch claim clears it", async () => {
    // Nothing clears the error but the claim and the orchestrator's start. If a
    // dispatch left one in place, the run it just launched would read as failed
    // and a second click would be let through. approve-dispatch-route.test.ts
    // pins that the claim clears it.
    const id = seedRequest({ status: "approving", dispatchedAt: "-1 minutes", lastError: "old" });
    expect((await list())[id].approval_in_flight).toBe(false);
  });
});

describe("approval_in_flight: a request that can no longer run", () => {
  test.each(["published", "denied", "blocked"])(
    "%s is never in flight, even with a fresh dispatch and fresh progress",
    async (status) => {
      const id = seedRequest({ status, dispatchedAt: "-1 minutes", updatedAt: "-1 minutes" });
      expect((await list())[id].approval_in_flight).toBe(false);
    },
  );
});

describe("the list route's new fields", () => {
  test("returns the claim columns alongside the computed boolean", async () => {
    const id = seedRequest({
      status: "requested",
      dispatchedAt: "-1 minutes",
      requestedBy: adminId,
    });
    const row = (await list())[id];
    expect(row.approval_requested_by).toBe(adminId);
    expect(typeof row.approval_dispatched_at).toBe("string");
    expect(row.approval_in_flight).toBe(true);
  });

  test("a request that was never dispatched reports null columns and false", async () => {
    const id = seedRequest({ status: "requested" });
    const row = (await list())[id];
    expect(row.approval_requested_by).toBeNull();
    expect(row.approval_dispatched_at).toBeNull();
    expect(row.approval_in_flight).toBe(false);
  });

  test("approval_in_flight is a boolean on every row, never 0 or 1", async () => {
    seedRequest({ status: "requested", dispatchedAt: "-1 minutes" });
    seedRequest({ status: "published" });
    for (const row of Object.values(await list())) {
      expect(typeof row.approval_in_flight).toBe("boolean");
    }
  });

  test("the status filter still works and still carries the field", async () => {
    seedRequest({ status: "requested", dispatchedAt: "-1 minutes" });
    seedRequest({ status: "published" });
    const res = await app.request(
      "/admin/publish/requests?status=requested",
      { headers: { Authorization: `Bearer ${ADMIN_KEY}`, "X-CLI-Version": "99.0.0" } },
      { DB: realD1(db), ENVIRONMENT: "test" } as Bindings,
    );
    const body = (await res.json()) as {
      requests: Array<{ status: string; approval_in_flight: boolean }>;
      count: number;
    };
    expect(body.count).toBe(1);
    expect(body.requests[0]).toMatchObject({ status: "requested", approval_in_flight: true });
  });
});
