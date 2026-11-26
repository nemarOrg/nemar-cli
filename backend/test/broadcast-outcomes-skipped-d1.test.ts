/**
 * The `skipped` outcome (epic #2260 phase 1, migration 0146).
 *
 * A recipient the consumer leaves unsent on purpose (the account went away, its address changed,
 * or it switched the category off between enqueue and send) is neither a delivery nor a failure.
 * It has its own counter, and it counts toward `done`: a broadcast whose last recipient was
 * skipped must still finish, or its status would sit at `queued` forever. Real migrated schema and
 * the production counter statements; the outcome is recorded through `recordBroadcastOutcome`.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { recordBroadcastOutcome } from "../src/services/broadcast-outcomes";
import { freshDb, realD1 } from "./helpers/d1";

let db: Database;
let broadcastId: number;

function queue(queuedCount: number): number {
  const sender = db.query("SELECT id FROM users LIMIT 1").get() as { id: number };
  const row = db
    .query(
      `INSERT INTO broadcast_emails (sent_by, recipient_group, subject, body_markdown, recipient_count, status, queued_count)
       VALUES (?, 'all', 's', 'b', ?, 'queued', ?) RETURNING id`,
    )
    .get(sender.id, queuedCount, queuedCount) as { id: number };
  return row.id;
}

function counters() {
  return db
    .query(
      `SELECT status, queued_count, delivered_count, failure_count, unknown_count, skipped_count
         FROM broadcast_emails WHERE id = ?`,
    )
    .get(broadcastId);
}

beforeEach(() => {
  db = freshDb();
  broadcastId = queue(3);
});

describe("recordBroadcastOutcome with skipped", () => {
  test("counts in skipped_count, not as a failure, and the row stays queued until all are in", async () => {
    const d1 = realD1(db);
    expect(await recordBroadcastOutcome(d1, broadcastId, "a@x.test", "skipped")).toBe(true);
    expect(counters()).toMatchObject({ status: "queued", skipped_count: 1, failure_count: 0 });
    expect(await recordBroadcastOutcome(d1, broadcastId, "b@x.test", "delivered")).toBe(true);
    expect(counters()).toMatchObject({ status: "queued", delivered_count: 1, skipped_count: 1 });
  });

  test("a mix of every outcome reaches done when the last one lands, whichever it is", async () => {
    const d1 = realD1(db);
    await recordBroadcastOutcome(d1, broadcastId, "a@x.test", "delivered");
    await recordBroadcastOutcome(d1, broadcastId, "b@x.test", "failed", "b***@x.test");
    // The LAST recipient is the skipped one: a done-check that forgot skipped would stay queued.
    await recordBroadcastOutcome(d1, broadcastId, "c@x.test", "skipped");
    expect(counters()).toEqual({
      status: "done",
      queued_count: 3,
      delivered_count: 1,
      failure_count: 1,
      unknown_count: 0,
      skipped_count: 1,
    });
  });

  test("the other outcomes still finish a row that already holds a skipped one", async () => {
    // The skipped term is in EVERY done-check sum, not only skipped's own.
    const d1 = realD1(db);
    await recordBroadcastOutcome(d1, broadcastId, "a@x.test", "skipped");
    await recordBroadcastOutcome(d1, broadcastId, "b@x.test", "unknown");
    await recordBroadcastOutcome(d1, broadcastId, "c@x.test", "delivered");
    expect(counters()).toMatchObject({ status: "done", skipped_count: 1, unknown_count: 1 });

    const other = queue(2);
    await recordBroadcastOutcome(d1, other, "d@x.test", "skipped");
    await recordBroadcastOutcome(d1, other, "e@x.test", "unqueued");
    expect(
      db
        .query("SELECT status, skipped_count, failure_count FROM broadcast_emails WHERE id = ?")
        .get(other),
    ).toEqual({ status: "done", skipped_count: 1, failure_count: 1 });
    const third = queue(2);
    await recordBroadcastOutcome(d1, third, "f@x.test", "skipped");
    await recordBroadcastOutcome(d1, third, "g@x.test", "failed", "g***@x.test");
    expect(db.query("SELECT status FROM broadcast_emails WHERE id = ?").get(third)).toEqual({
      status: "done",
    });
  });

  test("a redelivered message does not count a skipped recipient twice", async () => {
    const d1 = realD1(db);
    expect(await recordBroadcastOutcome(d1, broadcastId, "a@x.test", "skipped")).toBe(true);
    expect(await recordBroadcastOutcome(d1, broadcastId, "a@x.test", "skipped")).toBe(false);
    expect(counters()).toMatchObject({ skipped_count: 1 });
  });
});
