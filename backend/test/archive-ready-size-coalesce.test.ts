/**
 * The archive-ready webhook's 'ready' UPDATE must COALESCE `archive_size`,
 * the same way it already COALESCEs the completeness columns (review finding
 * on the 0.10.8 release: `ARCHIVE_READY_UPDATE_SQL` set `archive_size = ?`
 * unconditionally, so a 'ready' callback that omits `size` -- the idempotent
 * skip path, or any producer that sends a tally without a byte count --
 * would null out a real, previously-recorded archive size).
 *
 * Real engine throughout: a real Hono app with `registerArchiveReadyRoutes`
 * and real in-memory D1 (`helpers/d1`'s `realD1`, every migration applied).
 * No mocks.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerArchiveReadyRoutes } from "../src/routes/callbacks/archive-ready";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const TOKEN = "test-webhook-token";

function seedUser(db: Database): void {
  db.prepare(
    `INSERT INTO users (id, username, email, github_username, status)
     VALUES (1, 'alice', 'alice@nemar.org', 'alice', 'approved')`,
  ).run();
}

function insertDataset(db: Database, datasetId: string): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, is_sandbox)
     VALUES (?, 1, ?, 'public', 0)`,
  ).run(datasetId, datasetId);
}

interface WebhookAnswer {
  httpStatus: number;
  ok?: boolean;
  dataset_id?: string;
  status?: string;
  applied?: boolean;
  reason?: string;
  error?: string;
}

async function postArchiveReady(
  db: Database,
  body: Record<string, unknown>,
): Promise<WebhookAnswer> {
  const app = new Hono<{ Bindings: Bindings }>();
  registerArchiveReadyRoutes(app);
  const waitUntilPromises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waitUntilPromises.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const req = new Request("http://localhost/archive-ready", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Webhook-Token": TOKEN },
    body: JSON.stringify(body),
  });
  const res = await app.fetch(
    req,
    {
      NEMAR_WEBHOOK_TOKEN: TOKEN,
      DB: realD1(db),
      GITHUB_ADMIN_PAT: "test-token",
      S3_BUCKET: "nemar",
      API_BASE_URL: "https://api.nemar.org",
    } as Bindings,
    ctx,
  );
  await Promise.all(waitUntilPromises);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ...json, httpStatus: res.status } as WebhookAnswer;
}

function readArchiveSize(db: Database, datasetId: string): number | null {
  const row = db
    .prepare("SELECT archive_size FROM datasets WHERE dataset_id = ?")
    .get(datasetId) as { archive_size: number | null };
  return row.archive_size;
}

describe("POST /archive-ready: 'ready' callback omitting size", () => {
  test("does not null out a previously recorded archive_size", async () => {
    const db = freshDb();
    seedUser(db);
    insertDataset(db, "nm000288");

    // A first, normal build records a real size.
    const first = await postArchiveReady(db, {
      dataset_id: "nm000288",
      status: "ready",
      size: 123_456,
    });
    expect(first.httpStatus).toBe(200);
    expect(readArchiveSize(db, "nm000288")).toBe(123_456);

    // A second 'ready' callback that omits `size` entirely -- the idempotent
    // skip path (archive already existed, stream script never ran) is one
    // real producer of this shape -- must leave the recorded size alone
    // rather than nulling it via an unconditional `archive_size = ?`.
    const second = await postArchiveReady(db, {
      dataset_id: "nm000288",
      status: "ready",
    });
    expect(second.httpStatus).toBe(200);
    expect(readArchiveSize(db, "nm000288")).toBe(123_456);
  });
});
