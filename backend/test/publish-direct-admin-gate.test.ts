/**
 * Admin gate on POST /datasets/:id/publish (direct publish).
 *
 * The direct publish endpoint predates the orchestrated publication flow and
 * flips GitHub/S3/D1 visibility without minting a DOI, generating a manifest,
 * or passing the submission-minimums gate. It is now admin-only; owners go
 * through POST /datasets/:id/publish/request.
 *
 * Real engine: bun:sqlite behind realD1, real auth middleware (seeded users +
 * tokens, real SHA-256 key hashing), real route via Hono app.request(). All
 * asserted paths return BEFORE any GitHub/S3 call (403 owner, 403 stranger,
 * 400 sandbox, 200 already-public, 400 no-repo), so no network is involved
 * (no-mocks policy).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { datasetRoutes } from "../src/routes/datasets";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const OWNER_KEY = "pubgate-owner-key-0123456789abcdef0123456789abcdef";
const OTHER_KEY = "pubgate-other-key-0123456789abcdef0123456789abcdef";
const ADMIN_KEY = "pubgate-admin-key-0123456789abcdef0123456789abcdef";
const DATASET_ID = "nm000280";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let ownerId: number;

async function seedUser(username: string, role: string, key: string): Promise<number> {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access, sandbox_completed)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1, 1)`,
  ).run(username, `${username}@example.org`, role);
  const u = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!u) throw new Error(`seed: ${username} insert failed`);
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
  return u.id;
}

function seedDataset(
  overrides: {
    visibility?: string;
    is_sandbox?: number;
    github_repo?: string | null;
  } = {},
): void {
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, is_sandbox, visibility, status)
     VALUES (?, 'Publish Gate Fixture', ?, ?, ?, ?, 'active')`,
  ).run(
    DATASET_ID,
    ownerId,
    overrides.github_repo === undefined ? `nemarDatasets/${DATASET_ID}` : overrides.github_repo,
    overrides.is_sandbox ?? 0,
    overrides.visibility ?? "private",
  );
}

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
}

function publish(key: string): Promise<Response> {
  return app.request(
    `/datasets/${DATASET_ID}/publish`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-CLI-Version": "99.0.0",
      },
    },
    env(),
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/datasets", datasetRoutes);
  ownerId = await seedUser("pubowner", "member", OWNER_KEY);
  await seedUser("pubother", "member", OTHER_KEY);
  await seedUser("pubadmin", "admin", ADMIN_KEY);
});

describe("POST /datasets/:id/publish admin gate", () => {
  test("dataset owner (member) -> 403 pointing at the request flow", async () => {
    seedDataset();
    const res = await publish(OWNER_KEY);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/publish request|Only admins/);
    const row = db
      .query<{ visibility: string }, [string]>(
        "SELECT visibility FROM datasets WHERE dataset_id = ?",
      )
      .get(DATASET_ID);
    expect(row?.visibility).toBe("private");
  });

  test("unrelated member -> 403", async () => {
    seedDataset();
    const res = await publish(OTHER_KEY);
    expect(res.status).toBe(403);
  });

  test("unknown dataset -> 404 (checked before the admin gate)", async () => {
    // No seedDataset: the dataset lookup runs before the role check, so an
    // unrelated member probing a bogus ID gets 404, not a 403 that would leak
    // whether the ID exists.
    const res = await publish(OTHER_KEY);
    expect(res.status).toBe(404);
  });

  test("admin on a sandbox dataset -> 400 (gate passed, sandbox check reached)", async () => {
    seedDataset({ is_sandbox: 1 });
    const res = await publish(ADMIN_KEY);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/sandbox/i);
  });

  test("admin on an already-public dataset -> 200 idempotent", async () => {
    seedDataset({ visibility: "public" });
    const res = await publish(ADMIN_KEY);
    expect(res.status).toBe(200);
    expect((await res.json()).message).toMatch(/already public/i);
  });

  test("admin on a repo-less dataset -> 400 before any external call", async () => {
    seedDataset({ github_repo: null });
    const res = await publish(ADMIN_KEY);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no GitHub repository/i);
  });
});
