/**
 * The 403 body a user actually receives when they lack upload access
 * (ADR 0040, #1251), read off the real route rather than the constant.
 *
 * The message used to say "Request upload access from your account settings",
 * pointing at a settings feature that has never existed (ADR 0010's phase 2 was
 * never built, #1249) -- so the one place the product ever explains the gate
 * sent people to a page with nothing on it. This pins the replacement text at
 * the boundary, and pins that `error` did NOT change: the CLI matches on it.
 *
 * Entry point is POST /datasets/:id/upload-urls, whose service gate is the one
 * a collaborator or owner hits when pushing bytes. Real engine: bun:sqlite
 * behind realD1 with every migration applied, real Hono dispatch through
 * authMiddleware, real hashed tokens. The 403 returns before generateDatasetUploadUrls,
 * so no S3 call is made (no-mocks policy).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { datasetRoutes } from "../src/routes/datasets";
import { hashApiKey } from "../src/services/token";
import { SERVICE_ACCESS_ERROR } from "../src/services/upload-gate";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const OWNER_KEY = "gatemsg-owner-key-0123456789abcdef0123456789abcdef";
const DATASET_ID = "nm000281";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

/** A member (not admin -- admins skip the gate) with S3 permission on the
 *  dataset but no upload grant: exactly the person the message is written for. */
async function seedOwnerWithoutUploadAccess(serviceAccess: 0 | 1): Promise<void> {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        service_access, sandbox_completed)
     VALUES ('gateuser', 'gateuser@example.org', 'x', 'approved', 'member', 1, ?, 1)`,
  ).run(serviceAccess);
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='gateuser'").get();
  if (!u) throw new Error("seed: user insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(OWNER_KEY),
    OWNER_KEY.slice(0, 8),
  );
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, is_sandbox, visibility, status)
     VALUES (?, 'Gate Message Fixture', ?, ?, 0, 'private', 'active')`,
  ).run(DATASET_ID, u.id, `nemarDatasets/${DATASET_ID}`);
  db.query("INSERT INTO user_s3_permissions (user_id, s3_prefix) VALUES (?, ?)").run(
    u.id,
    DATASET_ID,
  );
}

function requestUploadUrls(): Promise<Response> {
  return app.request(
    `/datasets/${DATASET_ID}/upload-urls`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${OWNER_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ files: ["dataset_description.json"] }),
    },
    { DB: realD1(db), ENVIRONMENT: "test" } as Bindings,
  );
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/datasets", datasetRoutes);
});

describe("the upload gate's 403 body", () => {
  test("names admin approval and the support page, not a settings feature", async () => {
    await seedOwnerWithoutUploadAccess(0);

    const res = await requestUploadUrls();
    expect(res.status).toBe(403);
    const body = await res.json();

    expect(body.message).toBe(
      "Uploading requires upload access, a one-time admin approval. Ask an admin via https://nemar.org/support; the request flow is coming to Settings and the CLI.",
    );
    // The dead pointer this replaced. Asserted negatively so a well-meaning
    // reinstatement has to argue with a test rather than slip through.
    expect(body.message).not.toContain("account settings");
  });

  test("the machine-readable `error` is unchanged (the CLI matches on it)", async () => {
    await seedOwnerWithoutUploadAccess(0);

    const body = await (await requestUploadUrls()).json();
    expect(body.error).toBe("Service access required");
    // The route must send the shared constant verbatim, not its own copy.
    expect(body).toEqual({ ...SERVICE_ACCESS_ERROR });
  });

  test("a user who holds upload access is not stopped by this gate", async () => {
    await seedOwnerWithoutUploadAccess(1);

    // No S3 credentials in the test env, so the request cannot reach a 200 and
    // the route logs the presigning failure it hits next -- that noise in the
    // run is expected. What matters is that the gate is behind us: neither the
    // 403 nor the service-access body comes back.
    const res = await requestUploadUrls();
    expect(res.status).not.toBe(403);
    // Read as text: past the gate the route dies on the missing S3 credentials
    // and Hono answers with a plain-text 500, which .json() cannot parse.
    expect(await res.text()).not.toContain(SERVICE_ACCESS_ERROR.error);
  });
});
