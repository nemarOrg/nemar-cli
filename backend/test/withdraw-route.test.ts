/**
 * Real POST /admin/datasets/:id/withdraw and /restore route tests (epic #967
 * phase 4, #971).
 *
 * Real engine: bun:sqlite behind realD1, the real auth/admin middleware
 * (seeded users/tokens), and real route dispatch via Hono app.request() --
 * mirrors backend/test/exemplar-endpoint.test.ts and
 * backend/test/data-integrity-sweep-route.test.ts.
 *
 * Deliberately scoped to paths that never reach a live GitHub/S3/EZID call:
 * the dry-run default (returns a plan and stops), and every precondition-fail
 * path (not found, no EZID DOI, wrong visibility/withdrawn state). The
 * `--execute` happy path needs a real repo + bucket + registrar and is
 * exercised by the sandbox exemplar E2E and test/ezid-sandbox.test.ts, not
 * here (same boundary documented in backend/test/withdraw.test.ts).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "withdraw-admin-key-0123456789abcdef0123456789abcdef";
const DATASET_ID = "on008115";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('wdadmin', 'wdadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='wdadmin'").get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

async function seedNonAdmin(): Promise<string> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('wduser', 'wduser@example.org', 'x', 'approved', 'member', 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='wduser'").get();
  const key = "withdraw-user-key-0123456789abcdef0123456789abcdef";
  await db
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(u?.id ?? 0, await hashApiKey(key), key.slice(0, 8));
  return key;
}

function seedDataset(overrides: { visibility?: string; withdrawn_at?: string | null } = {}): void {
  db.prepare(
    `INSERT INTO datasets
       (dataset_id, owner_user_id, name, visibility, is_sandbox, doi_provider,
        ezid_identifier, withdrawn_at, withdrawn_reason, github_repo)
     VALUES (?, 1, ?, ?, 0, 'ezid', ?, ?, ?, ?)`,
  ).run(
    DATASET_ID,
    DATASET_ID,
    overrides.visibility ?? "public",
    `doi:10.82901/NEMAR.${DATASET_ID.toUpperCase()}`,
    overrides.withdrawn_at ?? null,
    overrides.withdrawn_at ? "upstream_403" : null,
    `nemarDatasets/${DATASET_ID}`,
  );
}

function env(): Bindings {
  return { DB: realD1(db) } as Bindings;
}

function post(path: string, body: unknown, key = ADMIN_KEY): Promise<Response> {
  return app.request(
    path,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

describe("POST /admin/datasets/:id/withdraw", () => {
  test("dry_run defaults true and returns a plan without mutating", async () => {
    seedDataset();
    const res = await post(`/admin/datasets/${DATASET_ID}/withdraw`, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dry_run).toBe(true);
    expect(body.visibility).toEqual({ status: "planned" });
    expect(body.dois).toEqual([
      {
        doi: `doi:10.82901/NEMAR.${DATASET_ID.toUpperCase()}`,
        kind: "concept",
        action: "unavailable",
        status: "planned",
      },
    ]);
  });

  test("explicit dry_run:true is identical to the default", async () => {
    seedDataset();
    const res = await post(`/admin/datasets/${DATASET_ID}/withdraw`, { dry_run: true });
    expect(res.status).toBe(200);
    expect((await res.json()).dry_run).toBe(true);
  });

  test("dry_run:false without a reason -> 400 before the service runs", async () => {
    seedDataset();
    const res = await post(`/admin/datasets/${DATASET_ID}/withdraw`, { dry_run: false });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/reason is required/);
  });

  test("unknown dataset -> 200 with a skipped reason (batch-friendly, not a hard error)", async () => {
    const res = await post("/admin/datasets/on999999/withdraw", {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe("Dataset not found");
  });

  test("already-private dataset -> skipped, not attempted", async () => {
    seedDataset({ visibility: "private" });
    const res = await post(`/admin/datasets/${DATASET_ID}/withdraw`, {
      dry_run: false,
      reason: "upstream_403",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toMatch(/already "private"/);
  });

  test("non-admin cannot withdraw", async () => {
    seedDataset();
    const userKey = await seedNonAdmin();
    const res = await post(`/admin/datasets/${DATASET_ID}/withdraw`, {}, userKey);
    expect(res.status).toBe(403);
  });
});

describe("POST /admin/datasets/:id/restore", () => {
  test("dry_run defaults true and returns a plan without mutating", async () => {
    seedDataset({ visibility: "private", withdrawn_at: "2026-07-20T00:00:00Z" });
    const res = await post(`/admin/datasets/${DATASET_ID}/restore`, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dry_run).toBe(true);
    expect(body.visibility).toEqual({ status: "planned" });
    expect(body.dois).toEqual([
      {
        doi: `doi:10.82901/NEMAR.${DATASET_ID.toUpperCase()}`,
        kind: "concept",
        action: "public",
        status: "planned",
      },
    ]);
  });

  test("unknown dataset -> 200 with a skipped reason", async () => {
    const res = await post("/admin/datasets/on999999/restore", {});
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe("Dataset not found");
  });

  test("dataset never withdrawn -> skipped, not attempted", async () => {
    seedDataset();
    const res = await post(`/admin/datasets/${DATASET_ID}/restore`, { dry_run: false });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toMatch(/was not withdrawn/);
  });

  test("non-admin cannot restore", async () => {
    seedDataset({ visibility: "private", withdrawn_at: "2026-07-20T00:00:00Z" });
    const userKey = await seedNonAdmin();
    const res = await post(`/admin/datasets/${DATASET_ID}/restore`, {}, userKey);
    expect(res.status).toBe(403);
  });
});
