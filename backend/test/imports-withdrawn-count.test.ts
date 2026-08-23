/**
 * Real GET /admin/imports tests for the withdrawn count (#1048).
 *
 * A withdrawn dataset's import succeeded, so its `import_jobs` row stays
 * `complete` forever. Counting it only there made `complete N` read as "N
 * datasets you can fetch", which is how a withdrawal cohort got mistaken for a
 * data-integrity incident in the first place. `withdrawn` is reported as its
 * own number, alongside rather than inside `by_status`.
 *
 * Runs against a real D1 (bun:sqlite + the actual migrations), no mocks.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "withdrawn-admin-key-0123456789abcdef0123456789ab";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let ownerId: number;

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('wdadmin', 'wdadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='wdadmin'").get();
  if (!u) throw new Error("seed: admin insert failed");
  ownerId = u.id;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

/** An imported dataset, optionally withdrawn. `status` is the import status. */
function seedImportedDataset(
  datasetId: string,
  status: string,
  withdrawnAt: string | null = null,
): void {
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, withdrawn_at, withdrawn_reason)
     VALUES (?, ?, ?, 'active', 'public', ?, ?)`,
  ).run(
    datasetId,
    `Dataset ${datasetId}`,
    ownerId,
    withdrawnAt,
    withdrawnAt ? "source returns 403 for every client" : null,
  );
  db.query(
    `INSERT INTO import_jobs (dataset_id, source, source_id, stage, status)
     VALUES (?, 'openneuro', ?, 'finalize', ?)`,
  ).run(datasetId, datasetId.replace(/^on/, "ds"), status);
}

function get(path: string): Promise<Response> {
  return app.request(path, { headers: { Authorization: `Bearer ${ADMIN_KEY}` } }, {
    DB: realD1(db),
    ENVIRONMENT: "development",
  } as Bindings);
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

describe("GET /admin/imports withdrawn count", () => {
  test("counts only datasets with withdrawn_at set", async () => {
    seedImportedDataset("on000001", "complete");
    seedImportedDataset("on000002", "complete", "2026-07-01T00:00:00Z");
    seedImportedDataset("on000003", "complete", "2026-07-02T00:00:00Z");

    const body = await (await get("/admin/imports")).json();
    expect(body.withdrawn).toBe(2);
  });

  test("withdrawn rows stay inside by_status.complete rather than moving out of it", async () => {
    seedImportedDataset("on000001", "complete");
    seedImportedDataset("on000002", "complete", "2026-07-01T00:00:00Z");

    const body = await (await get("/admin/imports")).json();
    // The import genuinely completed; withdrawal is a separate axis. If this
    // ever drops to 1, the count moved instead of being reported alongside.
    expect(body.by_status.complete).toBe(2);
    expect(body.withdrawn).toBe(1);
  });

  test("is zero when nothing is withdrawn", async () => {
    seedImportedDataset("on000001", "complete");
    seedImportedDataset("on000002", "failed");

    const body = await (await get("/admin/imports")).json();
    expect(body.withdrawn).toBe(0);
  });

  test("stays fleet-wide when a status filter is applied", async () => {
    // by_status is deliberately unfiltered so the summary line is not
    // misleading under a filter; `withdrawn` sits on that same line.
    seedImportedDataset("on000001", "failed");
    seedImportedDataset("on000002", "complete", "2026-07-01T00:00:00Z");

    const body = await (await get("/admin/imports?status=failed")).json();
    expect(body.imports.length).toBe(1);
    expect(body.withdrawn).toBe(1);
  });

  test("a withdrawn dataset with no import job is not counted", async () => {
    // The count is about imported datasets; a natively-uploaded one that was
    // withdrawn has no import_jobs row and does not belong in this total.
    db.query(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, withdrawn_at)
       VALUES ('nm000001', 'Native', ?, 'active', 'public', '2026-07-01T00:00:00Z')`,
    ).run(ownerId);
    seedImportedDataset("on000001", "complete");

    const body = await (await get("/admin/imports")).json();
    expect(body.withdrawn).toBe(0);
  });
});
