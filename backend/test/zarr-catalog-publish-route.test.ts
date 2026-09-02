/**
 * Real `POST /admin/zarr-catalog/publish` route tests (issue #1062, epic
 * #1181 phase 2; PR #1201 review, item 7).
 *
 * Mirrors backend/test/recording-stats-sweep-route.test.ts: real engine
 * (bun:sqlite behind realD1, the real auth/admin middleware with seeded
 * tokens, real route dispatch via Hono app.request()).
 *
 * `publishZarrCatalog` ALWAYS attempts exactly one S3 PUT, even against an
 * empty `datasets` table (it still publishes a well-formed, empty
 * document) -- unlike a sweep, there is no "scope to zero candidates to
 * avoid the network call" option here. So the "success" test below builds
 * its OWN app via `registerZarrCatalogRoutes(app, { publish })`, injecting
 * `publishZarrCatalog` with its `endpointUrl` test seam pointed at a real
 * local `Bun.serve()` receiver -- the same "one true network boundary
 * substituted" idiom `runRecordingStatsSweep`'s `fetchIndex` parameter
 * uses -- with the real `authMiddleware`/`adminMiddleware` stack still
 * attached, so auth is exercised for real too. The auth-rejection and
 * thrown-error tests need no receiver at all (they never reach the S3
 * call), so they use the same locally-built app with the default
 * (un-injected) `publishZarrCatalog`.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { adminMiddleware, authMiddleware } from "../src/middleware/auth";
import { registerZarrCatalogRoutes } from "../src/routes/admin/zarr-catalog";
import { hashApiKey } from "../src/services/token";
import { publishZarrCatalog } from "../src/services/zarr-catalog";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "zcpub-admin-key-0123456789abcdef0123456789abcdef";
const MEMBER_KEY = "zcpub-member-key-0123456789abcdef0123456789abcd";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

function newApp(deps: Parameters<typeof registerZarrCatalogRoutes>[1] = {}): App {
  const app: App = new Hono();
  app.use("*", authMiddleware);
  app.use("*", adminMiddleware);
  registerZarrCatalogRoutes(app, deps);
  return app;
}

async function seedUsers(db: Database): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('zcpubadmin', 'zcpubadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const admin = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='zcpubadmin'")
    .get();
  if (!admin) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    admin.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );

  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('zcpubmember', 'zcpubmember@example.org', 'x', 'approved', 'member', 1)`,
  );
  const member = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='zcpubmember'")
    .get();
  if (!member) throw new Error("seed: member insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    member.id,
    await hashApiKey(MEMBER_KEY),
    MEMBER_KEY.slice(0, 8),
  );
}

describe("POST /admin/zarr-catalog/publish: auth", () => {
  let db: Database;
  let app: App;

  beforeEach(async () => {
    db = freshDb();
    app = newApp();
    await seedUsers(db);
  });

  function env(): Bindings {
    return { DB: realD1(db), ENVIRONMENT: "development" } as Bindings;
  }

  test("unauthenticated (no Authorization header) is rejected with 401", async () => {
    const res = await app.request("/zarr-catalog/publish", { method: "POST" }, env());
    expect(res.status).toBe(401);
  });

  test("a non-admin (member) token is rejected with 403", async () => {
    const res = await app.request(
      "/zarr-catalog/publish",
      { method: "POST", headers: { Authorization: `Bearer ${MEMBER_KEY}` } },
      env(),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /admin/zarr-catalog/publish: a thrown publish error becomes a 500", () => {
  let db: Database;
  let app: App;

  beforeEach(async () => {
    db = freshDb();
    app = newApp();
    await seedUsers(db);
  });

  test("ZARR_CACHE_BASE_URL unconfigured -> publishZarrCatalog throws for real -> 500 carrying the message", async () => {
    // No S3 call is ever attempted: publishZarrCatalog's own guard throws
    // before touching D1 or S3 (see that function's doc comment), so this
    // exercises a REAL thrown error through the actual route without
    // needing a receiver.
    const res = await app.request(
      "/zarr-catalog/publish",
      { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      { DB: realD1(db), ENVIRONMENT: "development" } as Bindings, // ZARR_CACHE_BASE_URL omitted
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("ZARR_CACHE_BASE_URL");
  });
});

describe("POST /admin/zarr-catalog/publish: success against a real local S3 receiver", () => {
  let db: Database;
  let server: Server;
  let putCount: number;

  beforeAll(() => {
    putCount = 0;
    server = Bun.serve({
      port: 0,
      fetch(req) {
        if (req.method === "PUT") putCount++;
        return new Response("", { status: 200 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  beforeEach(async () => {
    db = freshDb();
    putCount = 0;
    await seedUsers(db);
  });

  test("returns {count, bytes} with a 200, and the PUT actually reached the receiver", async () => {
    const app = newApp({
      publish: (env) => publishZarrCatalog(env, { endpointUrl: `http://127.0.0.1:${server.port}` }),
    });
    const res = await app.request(
      "/zarr-catalog/publish",
      { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      {
        DB: realD1(db),
        ENVIRONMENT: "development",
        ZARR_CACHE_BASE_URL: "https://zarr.nemar.org",
        S3_BUCKET: "test-bucket",
        AWS_REGION: "us-east-2",
        AWS_ACCESS_KEY_ID: "AKIATEST",
        AWS_SECRET_ACCESS_KEY: "secret",
      } as Bindings,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; bytes: number };
    // Empty datasets table -- a real, well-formed, empty document is still
    // published (publishZarrCatalog never skips the PUT for zero rows).
    expect(body.count).toBe(0);
    expect(body.bytes).toBeGreaterThan(0);
    expect(putCount).toBe(1);
  });

  test("with candidate rows in D1, count reflects the real query result", async () => {
    db.run(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, zarr_status, zarr_store_count)
       VALUES ('on700001', 'Real candidate', -1, 'active', 'public', 'ready', 5)`,
    );
    const app = newApp({
      publish: (env) => publishZarrCatalog(env, { endpointUrl: `http://127.0.0.1:${server.port}` }),
    });
    const res = await app.request(
      "/zarr-catalog/publish",
      { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      {
        DB: realD1(db),
        ENVIRONMENT: "development",
        ZARR_CACHE_BASE_URL: "https://zarr.nemar.org",
        S3_BUCKET: "test-bucket",
        AWS_REGION: "us-east-2",
        AWS_ACCESS_KEY_ID: "AKIATEST",
        AWS_SECRET_ACCESS_KEY: "secret",
      } as Bindings,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; bytes: number };
    expect(body.count).toBe(1);
    expect(putCount).toBe(1);
  });
});
