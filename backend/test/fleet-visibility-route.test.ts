/**
 * Real PATCH /admin/datasets/:id/visibility route tests (epic #967 phase 4,
 * #971, review-fix GROUP 2b).
 *
 * fleet.ts's PATCH /visibility handler used to build these JSON error shapes
 * inline; the phase 4 extraction turned it into a `switch (result.stage)`
 * over applyDatasetVisibility's structured result -- a REWRITE, not a
 * verbatim move, and had no dedicated test pinning the resulting HTTP status/
 * body. This covers the three branches reachable without any network call
 * (not_found/no_repo/invalid_repo, all returned by applyDatasetVisibility
 * before getDatasetsToken is called) via the real route (real adminRoutes +
 * realD1 + seeded admin token), mirroring backend/test/exemplar-endpoint.test.ts.
 * The github/s3/db branches need a real GitHub PAT + AWS credentials and are
 * out of reach here (same boundary as backend/test/visibility.test.ts).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "vis-admin-key-0123456789abcdef0123456789abcdef";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('visadmin', 'visadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='visadmin'").get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

function seedDataset(datasetId: string, githubRepo: string | null): void {
  db.prepare(
    "INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, is_sandbox, github_repo) VALUES (?, 1, ?, 'public', 0, ?)",
  ).run(datasetId, datasetId, githubRepo);
}

function env(): Bindings {
  return { DB: realD1(db) } as Bindings;
}

function patch(path: string, body: unknown): Promise<Response> {
  return app.request(
    path,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
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

describe("PATCH /admin/datasets/:id/visibility (network-free stage branches)", () => {
  test("not_found -> 404", async () => {
    const res = await patch("/admin/datasets/on999999/visibility", { visibility: "private" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Dataset not found");
  });

  test("no_repo -> 400", async () => {
    seedDataset("on008115", null);
    const res = await patch("/admin/datasets/on008115/visibility", { visibility: "private" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Dataset has no GitHub repository");
  });

  test("invalid_repo -> 500", async () => {
    seedDataset("on008115", "not-a-slash-delimited-repo");
    const res = await patch("/admin/datasets/on008115/visibility", { visibility: "private" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Invalid repository format");
  });
});
