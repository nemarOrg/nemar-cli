/**
 * `recording_stats_at` invalidation on the zarr-ready callback (epic #1144
 * Phase 2, issue #1146).
 *
 * The 'ready' branch must null recording_stats_at so a reconverted dataset is
 * re-picked by the next recording-stats-sweep; the 'failed' branch must leave
 * it -- and every recording-stats column -- untouched, because a bad rebuild
 * must never erase good numbers already computed from the last good index.
 *
 * These tests drive the REAL handler through Hono against a real D1
 * (bun:sqlite plus every actual migration, via freshDb()). Deliberately NOT a
 * hand-copy of the UPDATE strings: test/zarr-failure-tracking.test.ts (root
 * test/ dir) hand-copies READY_SQL/FAILED_SQL for the failure-tracking
 * columns, so a copy like that could never catch a future edit to the real
 * handler accidentally clearing (or forgetting to clear) recording_stats_at.
 * Exercising the handler is what makes this load-bearing -- mirrors
 * backend/test/zarr-pool-breaks.test.ts, which makes the identical argument
 * for zarr_pool_breaks.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerZarrReadyRoutes } from "../src/routes/callbacks/zarr-ready";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

// bun's runtime lacks `crypto.subtle.timingSafeEqual` (a Workers extension);
// the handler's token check throws before reaching the behavior under test
// without it. Real constant-time comparison, not a stand-in for business
// logic -- the handler's own auth check still runs against it (see "rejects
// a wrong token" below for proof it is live).
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

const TOKEN = "recording-stats-callback-webhook-token";
const DATASET = "on007700";

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
     VALUES ('rscbowner', 'rscbowner@example.org', 'x', 'approved', 'user', 1)`,
  ).run();
  const owner = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='rscbowner'")
    .get();
  if (!owner) throw new Error("seed: owner insert failed");
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility)
     VALUES (?, 'Recording stats fixture', ?, 'active', 'public')`,
  ).run(DATASET, owner.id);
  // Seed as if a prior sweep had already computed good recording stats.
  db.query(
    `UPDATE datasets
       SET total_recording_duration = 165450, recording_duration_min = 26250,
           recording_duration_max = 28890, recording_count = 8,
           recordings_unavailable = 2, recordings_measured = 6,
           channel_count_min = 19, channel_count_max = 21,
           recording_stats_at = '2026-08-01 00:00:00'
     WHERE dataset_id = ?`,
  ).run(DATASET);
});

describe("recording_stats_at invalidation (#1146)", () => {
  test("a 'ready' callback nulls recording_stats_at but leaves the stat VALUES alone", async () => {
    const res = await post({
      dataset_id: DATASET,
      status: "ready",
      store_count: 130,
      index_etag: "etag-new",
      commit: "commit-new",
    });
    expect(res.status).toBe(200);
    const r = row();
    expect(r.zarr_status).toBe("ready");
    // The whole point: re-picked by the next sweep.
    expect(r.recording_stats_at).toBeNull();
    // The prior good numbers are not erased -- only the stamp is cleared; the
    // sweep recomputes the values themselves on its next pass.
    expect(r.total_recording_duration).toBe(165450);
    expect(r.recording_count).toBe(8);
    expect(r.recordings_measured).toBe(6);
  });

  test("a 'failed' callback leaves recording_stats_at and every stat column untouched", async () => {
    const res = await post({
      dataset_id: DATASET,
      status: "failed",
      errors: 4,
      deterministic: false,
      data_failures: [{ path: "a.edf", code: "corrupt_or_truncated" }],
    });
    expect(res.status).toBe(200);
    const r = row();
    expect(r.zarr_status).toBe("failed");
    // A bad rebuild must never erase good numbers: the stamp AND every stat
    // column from the last good sweep survive verbatim.
    expect(r.recording_stats_at).toBe("2026-08-01 00:00:00");
    expect(r.total_recording_duration).toBe(165450);
    expect(r.recording_duration_min).toBe(26250);
    expect(r.recording_duration_max).toBe(28890);
    expect(r.recording_count).toBe(8);
    expect(r.recordings_unavailable).toBe(2);
    expect(r.recordings_measured).toBe(6);
    expect(r.channel_count_min).toBe(19);
    expect(r.channel_count_max).toBe(21);
  });

  test("a 'converting' callback does not touch recording_stats_at either", async () => {
    // The in-progress signal only flips zarr_status to 'pending' and clears
    // failure detail; it is neither a rebuild completion nor a failure, so it
    // must not disturb recording stats in either direction.
    const res = await post({ dataset_id: DATASET, status: "converting" });
    expect(res.status).toBe(200);
    const r = row();
    expect(r.zarr_status).toBe("pending");
    expect(r.recording_stats_at).toBe("2026-08-01 00:00:00");
    expect(r.total_recording_duration).toBe(165450);
  });
});
