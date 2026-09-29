/**
 * `POST /admin/datasets/archive-sweep`'s ready/skip/absent branching, driven
 * through the REAL route against a real (fake) S3 endpoint (#1514, review
 * finding #2).
 *
 * `decideArchiveSweepOutcome` itself is unit-tested in archive-policy.test.ts
 * and archive-skip-migration.test.ts, but neither exercises the route's own
 * wiring: whether the handler actually calls the function with the right
 * arguments, in the right order, and persists the right SQL for each branch.
 * `sweep-stamps-candidates.test.ts` drives this same route for its candidate
 * SELECT, but its `env()` deliberately carries no AWS credentials so every
 * candidate fails at the S3 client constructor before a LIST is ever sent --
 * useful for the candidate-selection question, useless for this one.
 *
 * `listObjectPages` (services/s3.ts) gained an `endpointUrl` override seam in
 * this same change (it was the one S3 function in that file with no such
 * seam, per the docstring `mergeObjectSizesPage` used to carry), and
 * `getS3Config` (routes/admin/shared.ts) now forwards `env.S3_ENDPOINT_URL`
 * into it -- both needed before this test could exist at all. A real
 * `Bun.serve()` stands in for the bucket's LIST endpoint; no mocks.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { installWorkersTimingSafeEqual } from "./helpers/workers-crypto";

installWorkersTimingSafeEqual();

const ADMIN_KEY = "archive-sweep-s3-admin-key-0123456789abcdef0123";

/** The LIST fake: returns a single-page ListBucketResult, with or without a zip. */
let server: Server;
let zipsByDataset: Map<string, number>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const prefix = url.searchParams.get("prefix") ?? "";
      // prefix is "<id>/archives/"
      const datasetId = prefix.split("/")[0];
      const size = zipsByDataset.get(datasetId ?? "");
      const contents =
        size === undefined
          ? ""
          : `<Contents><Key>${datasetId}/archives/v1.0.0.zip</Key><Size>${size}</Size></Contents>`;
      const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`;
      return new Response(xml, { status: 200 });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

afterEach(() => {
  zipsByDataset = new Map();
});

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "development",
    S3_BUCKET: "nemar",
    AWS_REGION: "us-east-2",
    AWS_ACCESS_KEY_ID: "test-access-key",
    AWS_SECRET_ACCESS_KEY: "test-secret-key",
    S3_ENDPOINT_URL: `http://127.0.0.1:${server.port}`,
  } as Bindings;
}

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('sweepadmin', 'sweepadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='sweepadmin'").get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

function post(): Promise<Response> {
  return app.request(
    "/admin/datasets/archive-sweep",
    { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
    env(),
  );
}

function seedDataset(
  id: string,
  opts: { fileSize?: number | null; totalFiles?: number | null },
): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, visibility, is_sandbox, file_size, total_files)
     VALUES (?, ?, 1, 'public', 0, ?, ?)`,
  ).run(id, id, opts.fileSize ?? null, opts.totalFiles ?? null);
}

function rowState(id: string): {
  archive_status: string | null;
  archive_size: number | null;
  archive_skip_reason: string | null;
  archive_checked_at: string | null;
} {
  return db
    .prepare(
      `SELECT archive_status, archive_size, archive_skip_reason,
              json_extract(sweep_stamps, '$.archive_checked_at') AS archive_checked_at
         FROM datasets WHERE dataset_id = ?`,
    )
    .get(id) as {
    archive_status: string | null;
    archive_size: number | null;
    archive_skip_reason: string | null;
    archive_checked_at: string | null;
  };
}

beforeEach(async () => {
  db = freshDb();
  zipsByDataset = new Map();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  db.run(
    `INSERT INTO users (id, username, email, github_username, status)
     VALUES (1, 'alice', 'alice@nemar.org', 'alice', 'approved')`,
  );
  await seedAdmin();
});

describe("POST /admin/datasets/archive-sweep: real S3 LIST, ready/skip/absent (#1514)", () => {
  test("over-policy row with a zip on S3 -> skip, archive_status cleared", async () => {
    // The nm000284 shape: a real, complete zip exists (an earlier, smaller
    // build), but the row is now over policy. Policy must win.
    seedDataset("nm000284", { fileSize: 550_239_019_072, totalFiles: 14_922 });
    zipsByDataset.set("nm000284", 345_096_030_514);

    const res = await post();
    const body = (await res.json()) as { ready: number; skipped: number; absent: number };
    expect(body.skipped).toBe(1);
    expect(body.ready).toBe(0);
    expect(body.absent).toBe(0);

    const row = rowState("nm000284");
    expect(row.archive_status).toBeNull();
    expect(row.archive_skip_reason).toContain("exceeds");
    expect(row.archive_checked_at).not.toBeNull();
  });

  test("in-policy row with a zip on S3 -> ready", async () => {
    seedDataset("nm000010", { fileSize: 5 * 1024 * 1024 * 1024, totalFiles: 200 });
    zipsByDataset.set("nm000010", 2048);

    const res = await post();
    const body = (await res.json()) as { ready: number; skipped: number; absent: number };
    expect(body.ready).toBe(1);
    expect(body.skipped).toBe(0);
    expect(body.absent).toBe(0);

    const row = rowState("nm000010");
    expect(row.archive_status).toBe("ready");
    expect(row.archive_size).toBe(2048);
    expect(row.archive_skip_reason).toBeNull();
  });

  test("over-policy row with NO zip on S3 -> skip (not absent)", async () => {
    seedDataset("on004624", { fileSize: 1_000_000, totalFiles: 250_000 });
    // no entry in zipsByDataset -> LIST returns empty

    const res = await post();
    const body = (await res.json()) as { ready: number; skipped: number; absent: number };
    expect(body.skipped).toBe(1);
    expect(body.ready).toBe(0);
    expect(body.absent).toBe(0);

    const row = rowState("on004624");
    expect(row.archive_status).toBeNull();
    expect(row.archive_skip_reason).toContain("files exceeds");
  });

  test("in-policy row with no zip on S3 -> stamp-only (absent)", async () => {
    seedDataset("nm000020", { fileSize: 1024, totalFiles: 5 });

    const res = await post();
    const body = (await res.json()) as { ready: number; skipped: number; absent: number };
    expect(body.absent).toBe(1);
    expect(body.ready).toBe(0);
    expect(body.skipped).toBe(0);

    const row = rowState("nm000020");
    expect(row.archive_status).toBeNull();
    expect(row.archive_skip_reason).toBeNull();
    expect(row.archive_checked_at).not.toBeNull();
  });

  test("all four shapes in one sweep run, counted correctly", async () => {
    seedDataset("nm000284", { fileSize: 550_239_019_072, totalFiles: 14_922 });
    zipsByDataset.set("nm000284", 345_096_030_514);
    seedDataset("nm000010", { fileSize: 5 * 1024 * 1024 * 1024, totalFiles: 200 });
    zipsByDataset.set("nm000010", 2048);
    seedDataset("on004624", { fileSize: 1_000_000, totalFiles: 250_000 });
    seedDataset("nm000020", { fileSize: 1024, totalFiles: 5 });

    const res = await post();
    const body = (await res.json()) as {
      checked: number;
      ready: number;
      skipped: number;
      absent: number;
      errors: unknown[];
    };
    expect(body.checked).toBe(4);
    expect(body.ready).toBe(1);
    expect(body.skipped).toBe(2);
    expect(body.absent).toBe(1);
    expect(body.errors).toEqual([]);
  });
});
