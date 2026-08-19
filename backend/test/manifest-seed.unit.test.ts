/**
 * Manifest-derived catalog seeds on POST /datasets (#1091).
 *
 * Pure tests for manifestSeedStats plus the resume-branch persistence,
 * following the attestation-endpoint pattern: real bun:sqlite behind realD1,
 * real auth, real route; the resume branch runs the seed UPDATE before the
 * S3 carve-out fails closed on missing bindings, so persistence is asserted
 * from the real handler (no-mocks policy).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { datasetRoutes } from "../src/routes/datasets";
import { manifestSeedStats } from "../src/routes/datasets/upload";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const USER_KEY = "seed-user-key-0123456789abcdef0123456789abcdef";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let userId: number;

async function seedUser(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access, sandbox_completed)
     VALUES ('seeder', 'seeder@example.org', 'x', 'approved', 'member', 1, 1, 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='seeder'").get();
  if (!u) throw new Error("seed: user insert failed");
  userId = u.id;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(USER_KEY),
    USER_KEY.slice(0, 8),
  );
}

describe("manifestSeedStats", () => {
  test("sums bytes and counts distinct sub-* top-level directories", () => {
    const stats = manifestSeedStats([
      { path: "sub-001/eeg/a.set", size: 100 },
      { path: "sub-001/eeg/b.set", size: 200 },
      { path: "sub-002/eeg/c.set", size: 300 },
      { path: "dataset_description.json", size: 50 },
      { path: "stimuli/tone.wav", size: 25 },
    ]);
    expect(stats).toEqual({ bytes: 675, subjects: 2 });
  });

  test("subjects is null when no sub-* directories exist; substring lookalikes don't count", () => {
    const stats = manifestSeedStats([
      { path: "subplot/x.txt", size: 10 },
      { path: "README", size: 5 },
    ]);
    expect(stats).toEqual({ bytes: 15, subjects: null });
  });

  test("empty or missing manifest yields nulls", () => {
    expect(manifestSeedStats(undefined)).toEqual({ bytes: null, subjects: null });
    expect(manifestSeedStats([])).toEqual({ bytes: null, subjects: null });
  });

  test("zero-byte manifests still seed (bytes 0 is legal per #1084)", () => {
    expect(manifestSeedStats([{ path: "sub-001/eeg/empty.set", size: 0 }])).toEqual({
      bytes: 0,
      subjects: 1,
    });
  });
});

describe("POST /datasets resume branch seeds catalog stats", () => {
  beforeEach(async () => {
    db = freshDb();
    app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.route("/datasets", datasetRoutes);
    await seedUser();
  });

  test("persists subject_count/file_size before the S3 carve-out", async () => {
    db.query(
      `INSERT INTO datasets (dataset_id, name, description, owner_user_id, github_repo, is_sandbox, visibility)
       VALUES ('xx090010', 'Seed Fixture Dataset', NULL, ?, 'nemarDatasets/fixture', 1, 'private')`,
    ).run(userId);
    const res = await app.request(
      "/datasets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${USER_KEY}`,
          "Content-Type": "application/json",
          "X-CLI-Version": "99.0.0",
        },
        body: JSON.stringify({
          name: "Seed Fixture Dataset",
          sandbox: true,
          files: [
            { path: "sub-001/eeg/a.set", size: 700_000, type: "data" },
            { path: "sub-002/eeg/b.set", size: 150_000, type: "data" },
            { path: "dataset_description.json", size: 500, type: "metadata" },
          ],
        }),
      },
      { DB: realD1(db), ENVIRONMENT: "test" } as Bindings,
    );
    expect(res.status).toBe(500); // fails closed at S3 AFTER the seed UPDATE
    const row = db
      .query<
        {
          subject_count: number | null;
          file_size: number | null;
          file_size_formatted: string | null;
        },
        [string]
      >("SELECT subject_count, file_size, file_size_formatted FROM datasets WHERE dataset_id = ?")
      .get("xx090010");
    expect(row?.subject_count).toBe(2);
    expect(row?.file_size).toBe(850_500);
    expect(row?.file_size_formatted).toMatch(/KB|MB/);
  });
});
