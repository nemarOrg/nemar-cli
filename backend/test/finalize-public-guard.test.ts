/**
 * Lifecycle guard on POST /datasets/:id/finalize.
 *
 * finalize is a pre-publish repo-setup step (default branch, CI workflow shims,
 * auto-merge, owner=maintain, PRIVATE-repo collaborator spec). Running it on an
 * already-published dataset would push through the published-repo ruleset and
 * re-apply the private spec to a public repo, so it must refuse when the dataset
 * is public.
 *
 * Real engine: bun:sqlite behind realD1, real auth middleware (seeded users +
 * tokens), real route via Hono app.request(). All asserted paths (404, 403,
 * 409-public) return BEFORE getDatasetsToken / any GitHub call, so no network
 * or PAT is involved (no-mocks policy).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { datasetRoutes } from "../src/routes/datasets";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const OWNER_KEY = "finalize-owner-key-0123456789abcdef0123456789abcdef";
const OTHER_KEY = "finalize-other-key-0123456789abcdef0123456789abcdef";
const DATASET_ID = "nm000280";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let ownerId: number;

async function seedUser(username: string, key: string): Promise<number> {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access, sandbox_completed)
     VALUES (?, ?, 'x', 'approved', 'member', 1, 1, 1)`,
  ).run(username, `${username}@example.org`);
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

function seedDataset(visibility: string): void {
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, is_sandbox, visibility, status)
     VALUES (?, 'Finalize Fixture', ?, ?, 0, ?, 'active')`,
  ).run(DATASET_ID, ownerId, `nemarDatasets/${DATASET_ID}`, visibility);
}

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
}

function finalize(key: string): Promise<Response> {
  return app.request(
    `/datasets/${DATASET_ID}/finalize`,
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
  ownerId = await seedUser("finowner", OWNER_KEY);
  await seedUser("finother", OTHER_KEY);
});

describe("POST /datasets/:id/finalize lifecycle guard", () => {
  test("public dataset -> 409 before any GitHub call", async () => {
    seedDataset("public");
    const res = await finalize(OWNER_KEY);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Cannot finalize a published dataset/);
  });

  test("non-owner member -> 403", async () => {
    seedDataset("private");
    const res = await finalize(OTHER_KEY);
    expect(res.status).toBe(403);
  });

  test("non-owner member on a public dataset -> 403 (auth wins over lifecycle guard)", async () => {
    // The ownership check runs before the visibility check, so a stranger must
    // get a flat 403 and never learn the dataset is public (409 would disclose it).
    seedDataset("public");
    const res = await finalize(OTHER_KEY);
    expect(res.status).toBe(403);
  });

  test("unknown dataset -> 404", async () => {
    const res = await finalize(OWNER_KEY);
    expect(res.status).toBe(404);
  });
});
