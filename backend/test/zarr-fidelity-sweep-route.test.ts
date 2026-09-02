/**
 * Real `POST /admin/datasets/zarr-fidelity-sweep` route tests (issue #1068,
 * epic #1181 phase 8).
 *
 * Mirrors `zarr-catalog-publish-route.test.ts`: real engine (bun:sqlite
 * behind realD1, the real auth/admin middleware with seeded tokens, real
 * route dispatch via Hono `app.request()`). The success path injects
 * `runZarrFidelitySweep` with its `s3Options.endpointUrl` /
 * `githubRawBase` test seams pointed at a real local `Bun.serve()`
 * receiver -- the same DI-seam idiom `registerZarrCatalogRoutes` uses for
 * `publishZarrCatalog` -- with the real auth/admin middleware stack still
 * attached.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { adminMiddleware, authMiddleware } from "../src/middleware/auth";
import { registerZarrFidelitySweepRoutes } from "../src/routes/admin/zarr-fidelity-sweep";
import { hashApiKey } from "../src/services/token";
import { runZarrFidelitySweep } from "../src/services/zarr-fidelity-sweep";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "zfs-admin-key-0123456789abcdef0123456789abcdef01";
const MEMBER_KEY = "zfs-member-key-0123456789abcdef0123456789abcdef0";
const COMMIT_A = "a".repeat(40);
const ORG_NAME = "nemarDatasets";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

function newApp(deps: Parameters<typeof registerZarrFidelitySweepRoutes>[1] = {}): App {
  const app: App = new Hono();
  app.use("*", authMiddleware);
  app.use("*", adminMiddleware);
  registerZarrFidelitySweepRoutes(app, deps);
  return app;
}

async function seedUsers(db: Database): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('zfsadmin', 'zfsadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const admin = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='zfsadmin'")
    .get();
  if (!admin) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    admin.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );

  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('zfsmember', 'zfsmember@example.org', 'x', 'approved', 'member', 1)`,
  );
  const member = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='zfsmember'")
    .get();
  if (!member) throw new Error("seed: member insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    member.id,
    await hashApiKey(MEMBER_KEY),
    MEMBER_KEY.slice(0, 8),
  );
}

function env(db: Database): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "development",
    S3_BUCKET: "test-bucket",
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
  } as Bindings;
}

describe("POST /admin/datasets/zarr-fidelity-sweep: auth", () => {
  let db: Database;
  let app: App;

  beforeEach(async () => {
    db = freshDb();
    app = newApp();
    await seedUsers(db);
  });

  test("unauthenticated (no Authorization header) is rejected with 401", async () => {
    const res = await app.request("/datasets/zarr-fidelity-sweep", { method: "POST" }, env(db));
    expect(res.status).toBe(401);
  });

  test("a non-admin (member) token is rejected with 403", async () => {
    const res = await app.request(
      "/datasets/zarr-fidelity-sweep",
      { method: "POST", headers: { Authorization: `Bearer ${MEMBER_KEY}` } },
      env(db),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /admin/datasets/zarr-fidelity-sweep: candidate query failure becomes a 500", () => {
  let db: Database;
  let app: App;

  beforeEach(async () => {
    db = freshDb();
    app = newApp();
    await seedUsers(db);
  });

  test("a throwing sweep dependency surfaces as a 500 carrying the message", async () => {
    const throwingApp = newApp({
      sweep: async () => {
        throw new Error("simulated candidate query failure");
      },
    });
    const res = await throwingApp.request(
      "/datasets/zarr-fidelity-sweep",
      { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(db),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("simulated candidate query failure");
  });
});

describe("POST /admin/datasets/zarr-fidelity-sweep: success against real S3/raw-content receivers", () => {
  let db: Database;
  let server: Server;
  const indexFixtures = new Map<string, unknown>();
  const sidecarFixtures = new Map<string, string>();

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const parts = url.pathname
          .split("/")
          .filter((p) => p.length > 0)
          .map((p) => decodeURIComponent(p));
        if (
          parts.length >= 3 &&
          parts[parts.length - 2] === "zarr" &&
          parts[parts.length - 1] === "index.json"
        ) {
          const body = indexFixtures.get(parts[0]);
          if (body === undefined) return new Response("not found", { status: 404 });
          return new Response(JSON.stringify(body), { status: 200 });
        }
        if (parts[0] === ORG_NAME) {
          const [, repo, commit, ...rest] = parts;
          const content = sidecarFixtures.get(`${repo}/${commit}/${rest.join("/")}`);
          if (content === undefined) return new Response("not found", { status: 404 });
          return new Response(content, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  beforeEach(async () => {
    db = freshDb();
    indexFixtures.clear();
    sidecarFixtures.clear();
    await seedUsers(db);
  });

  test("returns the real per-dataset verdict, and it is actually persisted to D1", async () => {
    const id = "on810001";
    db.query(
      `INSERT INTO datasets
         (dataset_id, owner_user_id, name, visibility, status, is_sandbox,
          zarr_status, zarr_store_count, zarr_source_commit, github_repo)
       VALUES (?, -1, ?, 'public', 'active', 0, 'ready', 1, ?, ?)`,
    ).run(id, id, COMMIT_A, `${ORG_NAME}/${id}`);
    indexFixtures.set(id, {
      source_commit: COMMIT_A,
      store_count: 1,
      stores: [
        {
          path: "sub-01/eeg/sub-01_task-rest_eeg.set",
          zarr: "z",
          groups: [{ modality: "eeg", n_channels: 19, duration_s: 120, rate: 250 }],
        },
      ],
    });
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_channels.tsv`,
      `name\ttype\n${Array.from({ length: 19 }, (_, i) => `Ch${i}\tEEG`).join("\n")}`,
    );
    sidecarFixtures.set(
      `${id}/${COMMIT_A}/sub-01/eeg/sub-01_task-rest_eeg.json`,
      JSON.stringify({ SamplingFrequency: 250, RecordingDuration: 120 }),
    );

    const app = newApp({
      sweep: (env, opts) =>
        runZarrFidelitySweep(env, {
          ...opts,
          s3Options: { endpointUrl: `http://127.0.0.1:${server.port}` },
          githubRawBase: `http://127.0.0.1:${server.port}`,
        }),
    });
    const res = await app.request(
      "/datasets/zarr-fidelity-sweep?limit=5",
      { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      processed: number;
      verified: number;
      results: { dataset_id: string; verdict: string }[];
    };
    expect(body.processed).toBe(1);
    expect(body.verified).toBe(1);
    expect(body.results).toEqual([
      { dataset_id: id, verdict: "verified", sampled: 1, checked: 1, examples: [] },
    ]);

    const row = db
      .query(
        "SELECT json_extract(sweep_stamps, '$.zarr_verify_status') AS s FROM datasets WHERE dataset_id = ?",
      )
      .get(id) as { s: string };
    expect(row.s).toBe("verified");
  });

  test("an empty candidate set still returns a well-formed 200", async () => {
    const app = newApp({
      sweep: (env, opts) =>
        runZarrFidelitySweep(env, {
          ...opts,
          s3Options: { endpointUrl: `http://127.0.0.1:${server.port}` },
          githubRawBase: `http://127.0.0.1:${server.port}`,
        }),
    });
    const res = await app.request(
      "/datasets/zarr-fidelity-sweep",
      { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; results: unknown[]; remaining: number };
    expect(body.processed).toBe(0);
    expect(body.results).toEqual([]);
    expect(body.remaining).toBe(0);
  });
});
