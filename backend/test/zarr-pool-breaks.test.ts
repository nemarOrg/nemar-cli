/**
 * `zarr_pool_breaks` must survive BOTH callback outcomes (#1108 / migration 0069).
 *
 * The driver sends `pool_breaks` with `status: "ready"` and with `status:
 * "failed"` alike. The failed path used to drop it, which is the worst possible
 * place to lose it: migration 0069 exists because "recovering silently is how a
 * node under sustained memory pressure looks healthy until it isn't", and a run
 * that failed outright is the strongest pressure signal there is. Dropping it
 * left the column stale at the last successful run's value.
 *
 * These tests drive the REAL handler through Hono against a real D1 (bun:sqlite
 * plus the actual migrations). Deliberately NOT a copy of the UPDATE string:
 * test/zarr-failure-tracking.test.ts hand-copies `FAILED_SQL`, so its copy would
 * have had to be edited in lockstep with the handler and could never have caught
 * this divergence. Exercising the handler is what makes the test load-bearing.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerZarrReadyRoutes } from "../src/routes/callbacks/zarr-ready";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

/**
 * `crypto.subtle.timingSafeEqual` is a Cloudflare Workers extension to Web
 * Crypto; bun's runtime does not have it, so the handler's token check throws
 * before reaching any of the behavior under test.
 *
 * This supplies a REAL constant-time comparison for that missing platform
 * primitive. It is not a mock in the sense .rules/testing.md forbids: no
 * business logic is replaced or bypassed, the handler's own auth check still
 * executes against it, and `rejects a wrong token` below proves the check is
 * live rather than short-circuited.
 */
const subtle = crypto.subtle as SubtleCrypto & {
  timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
};
if (typeof subtle.timingSafeEqual !== "function") {
  subtle.timingSafeEqual = (a: ArrayBufferView, b: ArrayBufferView): boolean => {
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= (x[i] as number) ^ (y[i] as number);
    return diff === 0;
  };
}

const TOKEN = "zarr-pool-breaks-webhook-token";
const DATASET = "on007523";

let db: Database;
let app: Hono<{ Bindings: Bindings }>;

function post(body: Record<string, unknown>): Promise<Response> {
  return app.request(
    "/zarr-ready",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Token": TOKEN },
      body: JSON.stringify(body),
    },
    { DB: realD1(db), NEMAR_WEBHOOK_TOKEN: TOKEN, ENVIRONMENT: "test" } as Bindings,
  );
}

const row = () =>
  db.query("SELECT * FROM datasets WHERE dataset_id = ?").get(DATASET) as Record<string, unknown>;

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings }>();
  registerZarrReadyRoutes(app);
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('zpbowner', 'zpbowner@example.org', 'x', 'approved', 'user', 1)`,
  ).run();
  const owner = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='zpbowner'")
    .get();
  if (!owner) throw new Error("seed: owner insert failed");
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility)
     VALUES (?, 'Pool breaks fixture', ?, 'active', 'public')`,
  ).run(DATASET, owner.id);
});

describe("zarr_pool_breaks persistence (#1108, migration 0069)", () => {
  test("a failed run records pool_breaks instead of discarding it", async () => {
    const res = await post({
      dataset_id: DATASET,
      status: "failed",
      pool_breaks: 3,
      errors: 4,
      deterministic: false,
      data_failures: [{ path: "a.fif", code: "recording_memory_exceeded" }],
    });
    expect(res.status).toBe(200);
    const r = row();
    expect(r.zarr_status).toBe("failed");
    // The whole point: the pressure count survives the failure path.
    expect(r.zarr_pool_breaks).toBe(3);
  });

  test("a ready run records pool_breaks", async () => {
    const res = await post({
      dataset_id: DATASET,
      status: "ready",
      pool_breaks: 2,
      store_count: 7,
    });
    expect(res.status).toBe(200);
    expect(row().zarr_pool_breaks).toBe(2);
  });

  test("a failure after a clean run overwrites the stale healthy value", async () => {
    // The regression this guards: without pool_breaks on the failed branch, a
    // dataset that converted cleanly (0 breaks) and then failed under memory
    // pressure kept reporting 0 -- the node looked healthy precisely when it was
    // not, which is the failure mode migration 0069 was added to end.
    await post({ dataset_id: DATASET, status: "ready", pool_breaks: 0, store_count: 7 });
    expect(row().zarr_pool_breaks).toBe(0);

    await post({ dataset_id: DATASET, status: "failed", pool_breaks: 5, errors: 9 });
    expect(row().zarr_pool_breaks).toBe(5);
  });

  test("rejects a wrong token", async () => {
    // Guards the polyfill above: if the token check were short-circuited rather
    // than genuinely running, this would 200 and every other test here would be
    // asserting against an unauthenticated path.
    const res = await app.request(
      "/zarr-ready",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Token": "wrong-token" },
        body: JSON.stringify({ dataset_id: DATASET, status: "failed", pool_breaks: 3 }),
      },
      { DB: realD1(db), NEMAR_WEBHOOK_TOKEN: TOKEN, ENVIRONMENT: "test" } as Bindings,
    );
    expect(res.status).toBe(401);
    expect(row().zarr_pool_breaks).toBeNull();
  });

  test("an omitted pool_breaks is stored as NULL, not coerced to 0", async () => {
    // NULL means "this run predates the field / did not report it"; 0 means
    // "measured, and healthy". Conflating them would make the trend query read
    // unreported runs as evidence of a healthy node.
    const res = await post({ dataset_id: DATASET, status: "failed", errors: 1 });
    expect(res.status).toBe(200);
    expect(row().zarr_pool_breaks).toBeNull();
  });
});
