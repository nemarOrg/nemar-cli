/**
 * Real POST /admin/imports/dispatch-cooldown route tests (#981).
 *
 * `recover --execute` reclassifies a row to `incomplete` (next_retry_at =
 * now) and then dispatches onboard-openneuro.yml itself; without this route
 * the Phase-2 retry cron (sweepImportRetries, services/import-retry.ts)
 * would see the same `incomplete` + due `next_retry_at` row on its next tick
 * and re-dispatch it a second time. This route pushes next_retry_at forward
 * so the cron backs off. No S3/GitHub calls on this path, so the full route
 * (validation, the UPDATE, the audit log) is exercised against a real D1.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { parseSqliteUtc } from "../src/services/auto-import";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "cooldown-admin-key-0123456789abcdef0123456789ab";
const USER_KEY = "cooldown-user-key-0123456789abcdef0123456789abc";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('cooldownadmin', 'cooldownadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const u = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='cooldownadmin'")
    .get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

async function seedNonAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('cooldownuser', 'cooldownuser@example.org', 'x', 'approved', 'member', 1)`,
  );
  const u = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='cooldownuser'")
    .get();
  if (!u) throw new Error("seed: user insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(USER_KEY),
    USER_KEY.slice(0, 8),
  );
}

function seedImportJob(datasetId: string, status: string): void {
  db.run(
    `INSERT INTO import_jobs (dataset_id, source, source_id, stage, status, next_retry_at, created_at, updated_at)
     VALUES (?, 'openneuro', ?, 'copy', ?, datetime('now'), datetime('now'), datetime('now'))`,
    [datasetId, `ds${datasetId.slice(2)}`, status],
  );
}

function getNextRetryAt(datasetId: string): string {
  const row = db
    .query<{ next_retry_at: string }, [string]>(
      "SELECT next_retry_at FROM import_jobs WHERE dataset_id = ?",
    )
    .get(datasetId);
  if (!row) throw new Error(`no import_jobs row for ${datasetId}`);
  return row.next_retry_at;
}

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "development" } as Bindings;
}

function postCooldown(datasetIds: unknown, apiKey = ADMIN_KEY): Promise<Response> {
  return app.request(
    "/admin/imports/dispatch-cooldown",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ dataset_ids: datasetIds }),
    },
    env(),
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

describe("POST /admin/imports/dispatch-cooldown (#981)", () => {
  test("pushes next_retry_at into the future for an incomplete row, leaves a complete row untouched", async () => {
    seedImportJob("on000001", "incomplete");
    seedImportJob("on000002", "complete");
    const completeBefore = getNextRetryAt("on000002");

    const res = await postCooldown(["on000001", "on000002"]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);

    const incompleteAfter = parseSqliteUtc(getNextRetryAt("on000001"));
    expect(incompleteAfter).not.toBeNull();
    expect(incompleteAfter as number).toBeGreaterThan(Date.now());

    expect(getNextRetryAt("on000002")).toBe(completeBefore);
  });

  test("ids with no import_jobs row don't count toward updated", async () => {
    seedImportJob("on000001", "incomplete");

    const res = await postCooldown(["on000001", "on999999"]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);
  });

  test("400 on an empty dataset_ids array", async () => {
    const res = await postCooldown([]);
    expect(res.status).toBe(400);
  });

  test("400 when dataset_ids is not an array of strings", async () => {
    const res = await postCooldown(["on000001", 42]);
    expect(res.status).toBe(400);
  });

  test("non-admin cannot set a dispatch cooldown", async () => {
    await seedNonAdmin();
    seedImportJob("on000001", "incomplete");
    const res = await postCooldown(["on000001"], USER_KEY);
    expect(res.status).toBe(403);
  });
});
