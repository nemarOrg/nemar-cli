/**
 * Real POST /admin/revoke/:username route tests (issue #1069).
 *
 * Real engine throughout: bun:sqlite behind realD1 (every migration
 * applied), real Hono dispatch through authMiddleware + adminMiddleware
 * with a real hashed token, mirroring
 * backend/test/data-integrity-sweep-route.test.ts /
 * backend/test/approve-by-id-route.test.ts.
 *
 * The target user carries no aws_iam_username (so the IAM-revocation
 * branch is skipped -- no AWS calls), no dataset_collaborators rows and no
 * owned datasets (so the GitHub-removal loop has nothing to iterate -- no
 * GitHub calls), and RESEND_API_KEY is left unset with ENVIRONMENT="test"
 * and no DEV_EMAIL_ALLOWLIST, so the new #957 delivery fence
 * (services/email.ts) refuses the revocation email before any network
 * call, landing on the existing "email failed, non-fatal" catch branch
 * (email_sent: false) rather than reaching the real internet.
 *
 * Route behavior before this fix: the UPDATE cleared status/revoked_at/
 * updated_at only, so a revoked user's service_access (migration 0062,
 * gates real, non-sandbox uploads/compute) survived the revoke -- if
 * status were ever flipped back to 'approved' without an explicit
 * re-grant, upload access would silently return with it. This suite pins
 * that the UPDATE now also clears service_access.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "revoke-admin-key-0123456789abcdef0123456789abcdef";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

async function seedAdmin(): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role, email_verified)
     VALUES ('revokeadmin', 'revokeadmin@example.org', 'x', 'revokeadmin-gh', 'approved', 'admin', 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='revokeadmin'").get();
  if (!u) throw new Error("seed: admin insert failed");
  await db
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(u.id, await hashApiKey(ADMIN_KEY), ADMIN_KEY.slice(0, 8));
  return u.id;
}

/** Seed the user that will be revoked. `serviceAccess` defaults to 1 -- the
 *  exact pre-fix scenario (a currently-granted user being revoked). No
 *  aws_iam_username / dataset_collaborators / owned datasets rows, so the
 *  route's IAM and GitHub-removal branches both no-op. */
function seedTarget(opts: { serviceAccess?: 0 | 1 } = {}): number {
  db.run(
    `INSERT INTO users
       (username, email, password_hash, github_username, status, role,
        email_verified, service_access)
     VALUES ('revoketarget', 'revoketarget@example.org', 'x', 'revoketarget-gh',
             'approved', 'member', 1, ?)`,
    [opts.serviceAccess ?? 1],
  );
  const u = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='revoketarget'")
    .get();
  if (!u) throw new Error("seed: target insert failed");
  return u.id;
}

function targetRow(): {
  status: string;
  service_access: number;
  revoked_at: string | null;
} {
  const row = db
    .query<{ status: string; service_access: number; revoked_at: string | null }, []>(
      "SELECT status, service_access, revoked_at FROM users WHERE username='revoketarget'",
    )
    .get();
  if (!row) throw new Error("target row missing after revoke");
  return row;
}

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    RESEND_API_KEY: "",
  } as Bindings;
}

function post(username: string): Promise<Response> {
  return app.request(
    `/admin/revoke/${username}`,
    { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
    env(),
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

describe("POST /admin/revoke/:username (real route)", () => {
  test("clears service_access on full revocation (#1069)", async () => {
    seedTarget({ serviceAccess: 1 });
    const res = await post("revoketarget");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.status).toBe("revoked");

    const row = targetRow();
    expect(row.status).toBe("revoked");
    expect(row.service_access).toBe(0);
    expect(row.revoked_at).not.toBeNull();
  });

  test("service_access stays 0 when the target never had it (idempotent, not just a no-op that skipped the column)", async () => {
    seedTarget({ serviceAccess: 0 });
    const res = await post("revoketarget");
    expect(res.status).toBe(200);
    expect(targetRow().service_access).toBe(0);
  });

  test("a second revoke on an already-revoked user 409s and does not touch service_access again", async () => {
    seedTarget({ serviceAccess: 1 });
    const first = await post("revoketarget");
    expect(first.status).toBe(200);
    expect(targetRow().service_access).toBe(0);

    const second = await post("revoketarget");
    expect(second.status).toBe(409);
  });

  test("404s for an unknown username, leaving no row to check", async () => {
    const res = await post("no-such-user");
    expect(res.status).toBe(404);
  });
});
