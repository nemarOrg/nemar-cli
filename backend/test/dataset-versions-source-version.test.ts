/**
 * `GET /datasets/:id/versions` carries the upstream snapshot each version mirrors (epic #1046
 * phase 2, #1908; ADR 0111, decision 4): `source_version` and `source_version_basis` on every row.
 *
 * Driven through the real route with the real auth middleware, seeded tokens and real SQLite
 * carrying every migration. The route reads `dataset_description.json` from GitHub for
 * `current_version`; that call goes to a local server that answers 404, which the route treats
 * as no description, exactly as in production.
 *
 * Backward compatibility is the property: the two fields are additive, the existing fields keep
 * their values, and a version nobody examined says so with nulls rather than omitting the keys.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { authMiddleware } from "../src/middleware/auth";
import { registerManifestRoutes } from "../src/routes/datasets/manifests";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "dvs-admin-key-0123456789abcdef0123456789abcdef01";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

let server: Server;
let db: Database;
let app: App;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: () => new Response("Not Found", { status: 404 }) });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

beforeEach(async () => {
  db = freshDb();
  app = new Hono();
  registerManifestRoutes(app);
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('dvsadmin', 'dvsadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const admin = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='dvsadmin'")
    .get();
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    admin?.id ?? 0,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
});

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test", GITHUB_ADMIN_PAT: "dvs-pat" } as Bindings;
}

function seedVersion(
  version: string,
  createdAt: string,
  tag: string | null,
  basis: string | null,
): void {
  db.prepare(
    `INSERT INTO dataset_versions (dataset_id, version, doi, created_at, source_version, source_version_basis)
     VALUES ('on000001', ?, ?, ?, ?, ?)`,
  ).run(version, `10.82901/nemar.on000001.v${version}`, createdAt, tag, basis);
}

async function versions() {
  const res = await new Hono<{ Bindings: Bindings; Variables: Variables }>()
    .use("*", authMiddleware)
    .route("/", app)
    .request("/on000001/versions", { headers: { Authorization: `Bearer ${ADMIN_KEY}` } }, env());
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /datasets/:id/versions: the upstream snapshot per version", () => {
  beforeEach(() => {
    db.run(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo)
       VALUES ('on000001', 'x', -1, 'nemarDatasets/on000001')`,
    );
  });

  test("each row carries its tag and basis, and the old fields keep their values", async () => {
    seedVersion("1.0.0", "2026-01-01 00:00:00", "2.0.2", "doi");
    seedVersion("2.0.0", "2026-02-01 00:00:00", "3.0.0", "lineage");
    const { status, body } = await versions();
    expect(status).toBe(200);
    expect(body.versions).toEqual([
      {
        version: "v2.0.0",
        doi: "10.82901/nemar.on000001.v2.0.0",
        provider: "ezid",
        created_at: "2026-02-01 00:00:00",
        source_version: "3.0.0",
        source_version_basis: "lineage",
      },
      {
        version: "v1.0.0",
        doi: "10.82901/nemar.on000001.v1.0.0",
        provider: "ezid",
        created_at: "2026-01-01 00:00:00",
        source_version: "2.0.2",
        source_version_basis: "doi",
      },
    ]);
  });

  test("never examined is two nulls, and examined-unknown is a null tag with the word unknown", async () => {
    seedVersion("1.0.0", "2026-01-01 00:00:00", null, null);
    seedVersion("1.0.1", "2026-01-02 00:00:00", null, "unknown");
    const { body } = await versions();
    const rows = body.versions as Record<string, unknown>[];
    expect(rows.find((r) => r.version === "v1.0.0")).toMatchObject({
      source_version: null,
      source_version_basis: null,
    });
    expect(rows.find((r) => r.version === "v1.0.1")).toMatchObject({
      source_version: null,
      source_version_basis: "unknown",
    });
    // The keys are present, not omitted: a client tells "unrecorded" from "this backend predates the field".
    for (const row of rows) {
      expect(Object.keys(row)).toContain("source_version");
      expect(Object.keys(row)).toContain("source_version_basis");
    }
  });
});
