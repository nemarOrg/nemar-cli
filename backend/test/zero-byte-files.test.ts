/**
 * Zero-byte files in POST /datasets (#1084).
 *
 * The create schema used to require `size` to be strictly positive, so one
 * empty placeholder file (routine in BIDS folders) failed zod validation and
 * blocked the entire create — the web upload flow sends File.size verbatim
 * and cannot filter them without silently dropping files. Now only negative
 * sizes are rejected.
 *
 * Real engine, mirroring attestation-endpoint.test.ts: bun:sqlite behind
 * realD1, real auth middleware (seeded user + token), real route via Hono
 * app.request(). Acceptance is asserted on the resume/dedup branch, which
 * passes validation and then fails closed at the S3 carve-out (no S3
 * bindings) — a 500 there proves zod let the request through, without any
 * external side effects (no-mocks policy).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { datasetRoutes } from "../src/routes/datasets";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const USER_KEY = "zerobyte-user-key-0123456789abcdef0123456789abcd";
const DATASET_NAME = "Zero Byte Fixture Dataset";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let userId: number;

async function seedUser(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access, sandbox_completed)
     VALUES ('zerobyte', 'zerobyte@example.org', 'x', 'approved', 'member', 1, 1, 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='zerobyte'").get();
  if (!u) throw new Error("seed: user insert failed");
  userId = u.id;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(USER_KEY),
    USER_KEY.slice(0, 8),
  );
}

/** Seed an incomplete sandbox dataset so POST /datasets takes the resume branch. */
function seedIncomplete(datasetId: string): void {
  db.query(
    `INSERT INTO datasets (dataset_id, name, description, owner_user_id, github_repo, is_sandbox, visibility)
     VALUES (?, ?, NULL, ?, 'nemarDatasets/fixture', 1, 'private')`,
  ).run(datasetId, DATASET_NAME, userId);
}

function env(): Bindings {
  // Non-production: the route forces sandbox=true. No S3/GitHub bindings —
  // the resume branch fails closed at the S3 carve-out AFTER validation.
  return { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
}

function post(body: unknown): Promise<Response> {
  return app.request(
    "/datasets",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${USER_KEY}`,
        "Content-Type": "application/json",
        "X-CLI-Version": "99.0.0",
      },
      body: JSON.stringify(body),
    },
    env(),
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/datasets", datasetRoutes);
  await seedUser();
});

describe("POST /datasets file size validation", () => {
  test("accepts a zero-byte file (passes zod, fails closed later at S3)", async () => {
    seedIncomplete("xx090001");
    const res = await post({
      name: DATASET_NAME,
      files: [
        { path: "sub-01/eeg/sub-01_task-rest_eeg.set", size: 4096, type: "data" },
        { path: ".bidsignore", size: 0, type: "data" },
      ],
    });
    // Past validation: the resume branch reached the S3 carve-out, which has
    // no bindings here and fails closed. A zod reject would be a 400 instead.
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Failed to secure dataset storage");
  });

  test("still rejects a negative size", async () => {
    const res = await post({
      name: DATASET_NAME,
      files: [{ path: "sub-01/eeg/x.set", size: -1, type: "data" }],
    });
    expect(res.status).toBe(400);
  });

  test("still rejects a non-integer size", async () => {
    const res = await post({
      name: DATASET_NAME,
      files: [{ path: "sub-01/eeg/x.set", size: 1.5, type: "data" }],
    });
    expect(res.status).toBe(400);
  });

  test("still rejects a file without a type (web clients must declare one)", async () => {
    const res = await post({
      name: DATASET_NAME,
      files: [{ path: "sub-01/eeg/x.set", size: 100 }],
    });
    expect(res.status).toBe(400);
  });
});
