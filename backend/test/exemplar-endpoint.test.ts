/**
 * Exemplar admin-endpoint tests (epic #923, Phase 5 / #928).
 *
 * Real engine: bun:sqlite behind realD1, the real auth/admin middleware (seeded
 * users/tokens, real SHA-256 key hashing), and the real route via Hono
 * app.request(). Covers the gated/validation/rollback-decision paths that return
 * BEFORE any GitHub/EZID call (403-in-prod, 409-duplicate, zod reject, remint
 * gates) — the happy-path repo-create + INSERT is validated end-to-end by the
 * CLI clone tool (no-mocks policy, mirroring import-openneuro.test.ts).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { EXEMPLAR_ID_RE } from "../src/routes/admin/exemplar";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "exemplar-admin-key-0123456789abcdef0123456789abcdef";
const EXEMPLAR = "xx099900";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('exadmin', 'exadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='exadmin'").get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

function env(environment: string): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: environment,
    GITHUB_ADMIN_PAT: "test-pat-never-used-on-these-paths",
  } as Bindings;
}

function post(path: string, body: unknown, environment: string): Promise<Response> {
  return app.request(
    path,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env(environment),
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

describe("EXEMPLAR_ID_RE", () => {
  test("accepts the xx099900-xx099999 band only", () => {
    expect(EXEMPLAR_ID_RE.test("xx099900")).toBe(true);
    expect(EXEMPLAR_ID_RE.test("xx099999")).toBe(true);
    expect(EXEMPLAR_ID_RE.test("xx09900")).toBe(false); // 7 chars (draft regex bug)
    expect(EXEMPLAR_ID_RE.test("xx090000")).toBe(false); // dev ephemeral band, not exemplar
    expect(EXEMPLAR_ID_RE.test("nm000132")).toBe(false);
    expect(EXEMPLAR_ID_RE.test("xx099900x")).toBe(false);
  });
});

describe("POST /admin/datasets/exemplar", () => {
  const body = { dataset_id: EXEMPLAR, source_id: "nm000132" };

  test("403 in production (staging-only fleet)", async () => {
    const res = await post("/admin/datasets/exemplar", body, "production");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Exemplar creation is disabled in production");
  });

  test("fail-closed: unknown ENVIRONMENT is treated as production -> 403", async () => {
    const res = await post("/admin/datasets/exemplar", body, "");
    expect(res.status).toBe(403);
  });

  test("409 when the dataset already exists (before any GitHub call)", async () => {
    db.query(
      "INSERT INTO datasets (dataset_id, name, owner_user_id) VALUES (?, 'existing', 100)",
    ).run(EXEMPLAR);
    const res = await post("/admin/datasets/exemplar", body, "development");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(`Dataset ${EXEMPLAR} already exists`);
  });

  test("400 on an out-of-band dataset_id", async () => {
    const res = await post(
      "/admin/datasets/exemplar",
      { dataset_id: "xx090001", source_id: "nm000132" },
      "development",
    );
    expect(res.status).toBe(400);
  });

  test("400 on a malformed source_id", async () => {
    const res = await post(
      "/admin/datasets/exemplar",
      { dataset_id: EXEMPLAR, source_id: "not-a-dataset" },
      "development",
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /admin/datasets/:id/exemplar/remint-dois", () => {
  test("403 in production", async () => {
    const res = await post(`/admin/datasets/${EXEMPLAR}/exemplar/remint-dois`, {}, "production");
    expect(res.status).toBe(403);
  });

  test("400 on a non-exemplar id", async () => {
    const res = await post("/admin/datasets/nm000132/exemplar/remint-dois", {}, "development");
    expect(res.status).toBe(400);
  });

  test("404 when the dataset does not exist", async () => {
    const res = await post(`/admin/datasets/${EXEMPLAR}/exemplar/remint-dois`, {}, "development");
    expect(res.status).toBe(404);
  });

  test("400 when the row exists but is not an exemplar", async () => {
    // owner must resolve (the handler JOINs users), so use the seeded admin id.
    const adminId = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username='exadmin'")
      .get();
    db.query(
      "INSERT INTO datasets (dataset_id, name, owner_user_id, is_exemplar) VALUES (?, 'x', ?, 0)",
    ).run(EXEMPLAR, adminId?.id ?? 1);
    const res = await post(`/admin/datasets/${EXEMPLAR}/exemplar/remint-dois`, {}, "development");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Not an exemplar dataset");
  });
});
