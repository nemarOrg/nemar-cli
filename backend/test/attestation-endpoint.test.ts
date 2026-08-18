/**
 * Deposit attestation on POST /datasets (#1077, migration 0067).
 *
 * Real engine: bun:sqlite behind realD1, real auth middleware (seeded user +
 * token, real SHA-256 key hashing), real route via Hono app.request(). Covers
 * the paths that return BEFORE external side effects (zod rejects) plus the
 * resume/dedup branch, whose attestation UPDATE runs before the S3 carve-out
 * call — so persistence is asserted from the real handler even though the
 * request itself then fails closed on S3 (no-mocks policy; the fresh-create
 * INSERT binds the same columns and its happy path is validated end-to-end by
 * the CLI e2e flow).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { datasetRoutes } from "../src/routes/datasets";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const USER_KEY = "attest-user-key-0123456789abcdef0123456789abcdef";
const DATASET_NAME = "Attestation Fixture Dataset";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let userId: number;

async function seedUser(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access, sandbox_completed)
     VALUES ('attestor', 'attestor@example.org', 'x', 'approved', 'member', 1, 1, 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='attestor'").get();
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
  // Non-production: the route forces sandbox=true, keeping the test inside the
  // gate-free sandbox path. No S3/GitHub bindings — the resume branch fails
  // closed at the S3 carve-out AFTER the attestation UPDATE we assert on.
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

function attestationRow(datasetId: string) {
  return db
    .query<
      {
        attestation_deposit_type: string | null;
        attestation_key_status: string | null;
        attestation_no_duplicate: number | null;
        attestation_upstream_source: string | null;
        attestation_accepted_at: string | null;
      },
      [string]
    >(
      `SELECT attestation_deposit_type, attestation_key_status, attestation_no_duplicate,
              attestation_upstream_source, attestation_accepted_at
       FROM datasets WHERE dataset_id = ?`,
    )
    .get(datasetId);
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/datasets", datasetRoutes);
  await seedUser();
});

describe("migration 0067", () => {
  test("attestation columns exist on datasets with their CHECK constraints", () => {
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(datasets)")
      .all()
      .map((c) => c.name);
    for (const col of [
      "attestation_deposit_type",
      "attestation_key_status",
      "attestation_no_duplicate",
      "attestation_upstream_source",
      "attestation_accepted_at",
    ]) {
      expect(cols).toContain(col);
    }
    // CHECK constraints reject out-of-vocabulary values.
    seedIncomplete("xx090001");
    expect(() =>
      db
        .query("UPDATE datasets SET attestation_deposit_type = 'borrowed' WHERE dataset_id = ?")
        .run("xx090001"),
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .query("UPDATE datasets SET attestation_no_duplicate = 2 WHERE dataset_id = ?")
        .run("xx090001"),
    ).toThrow(/CHECK/);
  });
});

describe("POST /datasets attestation validation", () => {
  test("rejects a redistribution attestation without the no-duplicate affirmation", async () => {
    const res = await post({
      name: DATASET_NAME,
      attestation: { deposit_type: "redistribution", key_status: "retained" },
    });
    expect(res.status).toBe(400);
  });

  test("rejects out-of-vocabulary deposit_type and key_status", async () => {
    const bad1 = await post({
      name: DATASET_NAME,
      attestation: { deposit_type: "friend", key_status: "destroyed" },
    });
    expect(bad1.status).toBe(400);
    const bad2 = await post({
      name: DATASET_NAME,
      attestation: { deposit_type: "owner", key_status: "lost" },
    });
    expect(bad2.status).toBe(400);
  });
});

describe("POST /datasets resume branch persistence", () => {
  test("records an owner attestation on the resumed row before the S3 carve-out", async () => {
    seedIncomplete("xx090002");
    const res = await post({
      name: DATASET_NAME,
      sandbox: true,
      attestation: { deposit_type: "owner", key_status: "destroyed" },
    });
    // No S3 bindings: the resume branch fails closed AFTER the attestation
    // UPDATE (fail-closed carve-out, unchanged behavior).
    expect(res.status).toBe(500);
    const row = attestationRow("xx090002");
    expect(row?.attestation_deposit_type).toBe("owner");
    expect(row?.attestation_key_status).toBe("destroyed");
    expect(row?.attestation_no_duplicate).toBeNull();
    expect(row?.attestation_upstream_source).toBeNull();
    expect(row?.attestation_accepted_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("records a redistribution attestation with upstream source", async () => {
    seedIncomplete("xx090003");
    await post({
      name: DATASET_NAME,
      sandbox: true,
      attestation: {
        deposit_type: "redistribution",
        key_status: "retained",
        no_duplicate: true,
        upstream_source: "https://openneuro.org/datasets/ds000000",
      },
    });
    const row = attestationRow("xx090003");
    expect(row?.attestation_deposit_type).toBe("redistribution");
    expect(row?.attestation_key_status).toBe("retained");
    expect(row?.attestation_no_duplicate).toBe(1);
    expect(row?.attestation_upstream_source).toBe("https://openneuro.org/datasets/ds000000");
  });

  test("leaves attestation columns NULL when the request carries none", async () => {
    seedIncomplete("xx090004");
    await post({ name: DATASET_NAME, sandbox: true });
    const row = attestationRow("xx090004");
    expect(row?.attestation_deposit_type).toBeNull();
    expect(row?.attestation_key_status).toBeNull();
    expect(row?.attestation_accepted_at).toBeNull();
  });
});
