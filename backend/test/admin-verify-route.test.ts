/**
 * POST /admin/users/by-id/:id/verify: the owner's recovery for a stuck
 * pending account (ADR 0040). Real engine: bun:sqlite behind realD1 with every
 * migration applied and the real admin router. No mocks.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const OWNER_KEY = "verify-route-owner-key-0123456789abcdef012345";
const ADMIN_KEY = "verify-route-admin-key-0123456789abcdef012345";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

async function seedActor(username: string, role: "owner" | "admin", apiKey: string) {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1)`,
  ).run(username, `${username}@example.org`, role);
  const u = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!u) throw new Error("seed: actor insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(apiKey),
    apiKey.slice(0, 8),
  );
}

let orcidCounter = 0;

function seedWeb(email: string, status: string, emailVerified = 0): number {
  orcidCounter += 1;
  db.query(
    `INSERT INTO users (email, status, signup_source, email_verified, orcid, orcid_verified, service_access)
     VALUES (?, ?, 'web', ?, ?, 1, 0)`,
  ).run(
    email,
    status,
    emailVerified,
    `0000-0002-7777-${String(Math.floor(Math.random() * 9000) + 1000)}`,
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error("seed failed");
  return row.id;
}

function row(id: number) {
  return db
    .query<{ status: string; email_verified: number; service_access: number }, [number]>(
      "SELECT status, email_verified, service_access FROM users WHERE id = ?",
    )
    .get(id);
}

function verify(id: string | number, apiKey: string): Promise<Response> {
  return app.request(
    `/admin/users/by-id/${id}/verify`,
    { method: "POST", headers: { Authorization: `Bearer ${apiKey}` } },
    { DB: realD1(db), ENVIRONMENT: "test" } as Bindings,
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedActor("verifyowner", "owner", OWNER_KEY);
  await seedActor("verifyadmin", "admin", ADMIN_KEY);
});

describe("POST /admin/users/by-id/:id/verify", () => {
  test("an owner moves a pending account to verified, grants no upload access, and is audited", async () => {
    const id = seedWeb("stuck@nemar.test", "pending");

    const res = await verify(id, OWNER_KEY);

    expect(res.status).toBe(200);
    expect(row(id)).toEqual({ status: "verified", email_verified: 1, service_access: 0 });
    const owner = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'verifyowner'")
      .get();
    const audit = db
      .query<{ user_id: number; resource_id: string }, []>(
        "SELECT user_id, resource_id FROM audit_log WHERE action = 'email_verified_by_owner'",
      )
      .all();
    expect(audit).toEqual([{ user_id: owner?.id as number, resource_id: String(id) }]);
    // The transition row records how it happened.
    const transition = db
      .query<{ details: string }, []>(
        "SELECT details FROM audit_log WHERE action = 'email_verified'",
      )
      .all();
    expect(transition.map((r) => JSON.parse(r.details).via)).toEqual(["owner_override"]);
  });

  test("a soft-deleted account is 404 and stays pending", async () => {
    const id = seedWeb("gone@nemar.test", "pending");
    db.run("UPDATE users SET deleted_at = datetime('now') WHERE id = ?", [id]);
    expect((await verify(id, OWNER_KEY)).status).toBe(404);
    expect(row(id)?.status).toBe("pending");
  });

  test("an admin who is not an owner gets 403 and nothing changes", async () => {
    const id = seedWeb("stuck2@nemar.test", "pending");
    expect((await verify(id, ADMIN_KEY)).status).toBe(403);
    expect(row(id)?.status).toBe("pending");
  });

  test("only pending accounts: verified and approved answer 409", async () => {
    const verified = seedWeb("v@nemar.test", "verified", 1);
    const approved = seedWeb("a@nemar.test", "approved", 1);
    expect((await verify(verified, OWNER_KEY)).status).toBe(409);
    expect((await verify(approved, OWNER_KEY)).status).toBe(409);
    expect(row(approved)?.status).toBe("approved");
  });

  test("unknown id is 404, malformed or system id is 400", async () => {
    expect((await verify(99999, OWNER_KEY)).status).toBe(404);
    expect((await verify("abc", OWNER_KEY)).status).toBe(400);
    expect((await verify(-1, OWNER_KEY)).status).toBe(400);
  });
});
