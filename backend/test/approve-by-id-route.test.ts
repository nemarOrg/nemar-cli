/**
 * Real route tests for POST /admin/approve/by-id/:id and the widened
 * eligibility gate on POST /admin/approve/:username (#1012).
 *
 * Web/ORCID signups have username = NULL (migration 0026), so the
 * username-keyed approve route can never address them; and CLI-style
 * "pending means unverified email" does not apply to them (ORCID is the
 * identity proof, the collected email is deliberately unverified). These
 * tests pin that:
 *   - a pending ORCID-verified web row is approvable by id,
 *   - a revoked web row is re-approvable by id,
 *   - a pending web row WITHOUT ORCID verification is refused,
 *   - a pending CLI row (unverified email) is still refused, by id too,
 *   - the username route's verified/revoked behavior is unchanged,
 *   - approval writes approved_at and a user_approved audit row keyed on
 *     the stable numeric id when there is no username.
 *
 * Real engine throughout: bun:sqlite behind realD1 (every migration
 * applied), real Hono dispatch through authMiddleware + adminMiddleware
 * with a real hashed token. RESEND_API_KEY is unset, so the routes take
 * the email-unconfigured path (email_sent: false) without any network.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "approve-admin-key-0123456789abcdef0123456789abcdef";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('approveadmin', 'approveadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const u = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='approveadmin'")
    .get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

interface WebUserSeed {
  status?: string;
  orcidVerified?: 0 | 1;
}

/** Web/ORCID-style row: username NULL, signup_source 'web'. */
function seedWebUser(email: string, { status = "pending", orcidVerified = 1 }: WebUserSeed = {}) {
  db.run(
    `INSERT INTO users (email, status, signup_source, email_verified, orcid, orcid_verified)
     VALUES (?, ?, 'web', 0, ?, ?)`,
    [email, status, orcidVerified ? "0000-0002-1825-0097" : null, orcidVerified],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error(`seed failed for ${email}`);
  return row;
}

/** CLI-style row: username set, signup_source 'cli'. */
function seedCliUser(username: string, status: string, emailVerified: 0 | 1) {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, signup_source, email_verified)
     VALUES (?, ?, 'x', ?, 'cli', ?)`,
    [username, `${username}@example.org`, status, emailVerified],
  );
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error(`seed failed for ${username}`);
  return row;
}

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "development" } as Bindings;
}

function post(path: string, key = ADMIN_KEY): Promise<Response> {
  return app.request(path, { method: "POST", headers: { Authorization: `Bearer ${key}` } }, env());
}

function userRow(id: number) {
  return db
    .query<{ status: string; approved_at: string | null }, [number]>(
      "SELECT status, approved_at FROM users WHERE id = ?",
    )
    .get(id);
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

describe("POST /admin/approve/by-id/:id (#1012)", () => {
  test("approves a pending ORCID-verified web signup (username NULL)", async () => {
    const { id } = seedWebUser("orcid-pending@example.org");
    const res = await post(`/admin/approve/by-id/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toEqual({
      id,
      username: null,
      email: "orcid-pending@example.org",
      status: "approved",
    });
    expect(body.email_sent).toBe(false); // RESEND_API_KEY unset in tests

    const row = userRow(id);
    expect(row?.status).toBe("approved");
    expect(row?.approved_at).not.toBeNull();
  });

  test("audit row is keyed on the stable numeric id when username is NULL", async () => {
    const { id } = seedWebUser("orcid-audit@example.org");
    await post(`/admin/approve/by-id/${id}`);
    const audit = db
      .query<{ resource_id: string; details: string }, [string]>(
        "SELECT resource_id, details FROM audit_log WHERE action = 'user_approved' AND resource_id = ?",
      )
      .get(String(id));
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit?.details ?? "{}").approved_by).toBe("approveadmin");
  });

  test("re-approves a revoked web account", async () => {
    const { id } = seedWebUser("orcid-revoked@example.org", { status: "revoked" });
    const res = await post(`/admin/approve/by-id/${id}`);
    expect(res.status).toBe(200);
    expect(userRow(id)?.status).toBe("approved");
  });

  test("refuses a pending web signup without ORCID verification", async () => {
    const { id } = seedWebUser("web-no-orcid@example.org", { orcidVerified: 0 });
    const res = await post(`/admin/approve/by-id/${id}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain("not ORCID-verified");
    expect(userRow(id)?.status).toBe("pending");
  });

  test("refuses a pending CLI signup (email still unverified), even by id", async () => {
    const { id } = seedCliUser("cliuser1", "pending", 0);
    const res = await post(`/admin/approve/by-id/${id}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain("verify their email");
    expect(userRow(id)?.status).toBe("pending");
  });

  test("approves a verified CLI signup by id (id path is not web-only)", async () => {
    const { id } = seedCliUser("cliuser2", "verified", 1);
    const res = await post(`/admin/approve/by-id/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.username).toBe("cliuser2");
    expect(userRow(id)?.status).toBe("approved");
  });

  test("409 on an already-approved account", async () => {
    const { id } = seedWebUser("orcid-approved@example.org", { status: "approved" });
    const res = await post(`/admin/approve/by-id/${id}`);
    expect(res.status).toBe(409);
  });

  test("404 on an unknown id, 400 on a non-numeric id", async () => {
    expect((await post("/admin/approve/by-id/99999")).status).toBe(404);
    expect((await post("/admin/approve/by-id/nope")).status).toBe(400);
    expect((await post("/admin/approve/by-id/-1")).status).toBe(400);
  });

  test("non-admin token is refused", async () => {
    const { id: memberId } = seedCliUser("plainmember", "approved", 1);
    const memberKey = "approve-member-key-0123456789abcdef0123456789abcdef";
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      memberId,
      await hashApiKey(memberKey),
      memberKey.slice(0, 8),
    );
    const { id } = seedWebUser("orcid-notyours@example.org");
    const res = await post(`/admin/approve/by-id/${id}`, memberKey);
    expect(res.status).toBe(403);
    expect(userRow(id)?.status).toBe("pending");
  });
});

describe("POST /admin/approve/:username after #1012", () => {
  test("verified CLI user is still approvable by username (regression)", async () => {
    const { id } = seedCliUser("cliuser3", "verified", 1);
    const res = await post("/admin/approve/cliuser3");
    expect(res.status).toBe(200);
    expect(userRow(id)?.status).toBe("approved");
  });

  test("pending CLI user is still refused by username (regression)", async () => {
    seedCliUser("cliuser4", "pending", 0);
    const res = await post("/admin/approve/cliuser4");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain("verify their email");
  });
});
