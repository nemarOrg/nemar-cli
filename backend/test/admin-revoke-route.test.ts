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

function postPath(path: string): Promise<Response> {
  return app.request(
    path,
    { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
    env(),
  );
}

function post(username: string): Promise<Response> {
  return postPath(`/admin/revoke/${username}`);
}

let adminId: number;

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  adminId = await seedAdmin();
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

/**
 * POST /admin/revoke/by-id/:id (#1274).
 *
 * The gap this closes: `POST /admin/approve/by-id/:id` can grant upload access
 * to a web/ORCID account (username NULL by design, migration 0026), and until
 * this route existed nothing could take it back -- the username-keyed revoke
 * cannot address such a row at all. ADR 0040 makes approval the single writer
 * of `service_access` and revoke its only eraser, so the two must reach the
 * same set of accounts.
 *
 * The end-to-end test drives BOTH real routes in sequence rather than seeding a
 * granted row: the four columns revoke has to clear are exactly the four
 * approval writes, and asserting against approval's own output is what proves
 * they are the same four.
 */

/** A web/ORCID-shaped row: username NULL, no GitHub handle, no IAM user. */
function seedWebTarget(email = "webtarget@example.org"): number {
  db.run(
    `INSERT INTO users (email, status, signup_source, email_verified, orcid, orcid_verified)
     VALUES (?, 'verified', 'web', 1, '0000-0002-1825-0097', 1)`,
    [email],
  );
  const u = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!u) throw new Error("seed: web target insert failed");
  return u.id;
}

function grantColumns(id: number) {
  return db
    .query<
      {
        username: string | null;
        status: string;
        service_access: number;
        service_access_granted_at: string | null;
        service_access_granted_by: number | null;
        upload_access_requested_at: string | null;
      },
      [number]
    >(
      `SELECT username, status, service_access, service_access_granted_at,
              service_access_granted_by, upload_access_requested_at
       FROM users WHERE id = ?`,
    )
    .get(id);
}

describe("POST /admin/revoke/by-id/:id (real route)", () => {
  test("revokes an account with no username, clearing everything approval wrote", async () => {
    const id = seedWebTarget();
    // The account asked for upload access before an admin granted it (ADR
    // 0042); the stamp is what makes this row show up in the review queue.
    db.query("UPDATE users SET upload_access_requested_at = datetime('now') WHERE id = ?").run(id);

    const approved = await postPath(`/admin/approve/by-id/${id}`);
    expect(approved.status).toBe(200);
    const granted = grantColumns(id);
    // Approval really did write all four, so the revoke assertions below are
    // clearing something rather than checking columns that were never set.
    expect(granted?.username).toBeNull();
    expect(granted?.service_access).toBe(1);
    expect(granted?.service_access_granted_at).not.toBeNull();
    expect(granted?.service_access_granted_by).toBe(adminId);
    expect(granted?.upload_access_requested_at).not.toBeNull();

    const res = await postPath(`/admin/revoke/by-id/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toEqual({ id, username: null, status: "revoked" });

    const row = grantColumns(id);
    expect(row?.status).toBe("revoked");
    expect(row?.service_access).toBe(0);
    expect(row?.service_access_granted_at).toBeNull();
    expect(row?.service_access_granted_by).toBeNull();
    expect(row?.upload_access_requested_at).toBeNull();
  });

  test("writes a user_revoked audit row keyed on the numeric id", async () => {
    const id = seedWebTarget("webaudit@example.org");
    expect((await postPath(`/admin/revoke/by-id/${id}`)).status).toBe(200);
    const audit = db
      .query<{ resource_id: string; details: string }, [string]>(
        "SELECT resource_id, details FROM audit_log WHERE action = 'user_revoked' AND resource_id = ?",
      )
      .get(String(id));
    expect(audit).not.toBeNull();
    const details = JSON.parse(audit?.details ?? "{}");
    expect(details.revoked_by).toBe("revokeadmin");
    expect(details.service_access_cleared).toBe(true);
  });

  test("revokes a CLI account by id too (the route is not web-only)", async () => {
    const id = seedTarget({ serviceAccess: 1 });
    const res = await postPath(`/admin/revoke/by-id/${id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).user.username).toBe("revoketarget");
    expect(targetRow().service_access).toBe(0);
  });

  test("refuses self-revocation by id", async () => {
    // The username route guards on the param before the lookup; this one has
    // no username to compare, so the guard is keyed on the id instead.
    const res = await postPath(`/admin/revoke/by-id/${adminId}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("your own access");
    const admin = grantColumns(adminId);
    expect(admin?.status).toBe("approved");
  });

  test("409s on a second revoke, 404s on an unknown id, 400s on a bad one", async () => {
    const id = seedWebTarget("webtwice@example.org");
    expect((await postPath(`/admin/revoke/by-id/${id}`)).status).toBe(200);
    expect((await postPath(`/admin/revoke/by-id/${id}`)).status).toBe(409);
    expect((await postPath("/admin/revoke/by-id/99999")).status).toBe(404);
    expect((await postPath("/admin/revoke/by-id/nope")).status).toBe(400);
    expect((await postPath("/admin/revoke/by-id/-1")).status).toBe(400);
  });

  test("a non-admin token cannot revoke by id", async () => {
    const id = seedWebTarget("webnotyours@example.org");
    const memberKey = "revoke-member-key-0123456789abcdef0123456789abcdef";
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified)
       VALUES ('plainmember', 'plainmember@example.org', 'x', 'approved', 'member', 1)`,
    );
    const member = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username='plainmember'")
      .get();
    if (!member) throw new Error("seed: member insert failed");
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      member.id,
      await hashApiKey(memberKey),
      memberKey.slice(0, 8),
    );
    const res = await app.request(
      `/admin/revoke/by-id/${id}`,
      { method: "POST", headers: { Authorization: `Bearer ${memberKey}` } },
      env(),
    );
    expect(res.status).toBe(403);
    expect(grantColumns(id)?.status).toBe("verified");
  });
});
