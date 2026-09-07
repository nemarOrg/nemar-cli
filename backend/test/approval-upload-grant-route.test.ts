/**
 * Real route tests for the approval-grants-upload rule (ADR 0040, #1251).
 *
 * #1249: `nemar admin approve` flipped `status` to 'approved' and wrote
 * nothing to `service_access`, so the admin's one action approved a user who
 * then hit the upload gate. These tests pin that the two now move together on
 * both approve routes, that revoke erases the grant AND its stamps, and that
 * the admin listing reports the tier at all.
 *
 * Real engine throughout: bun:sqlite behind realD1 (every migration applied,
 * 0075 included), real Hono dispatch through authMiddleware + adminMiddleware
 * with a real hashed token, mirroring approve-by-id-route.test.ts. The target
 * users carry no aws_iam_username, no collaborations and no owned datasets, so
 * the revoke route's IAM and GitHub branches no-op; RESEND_API_KEY is unset
 * with ENVIRONMENT="test", so the email delivery fence refuses before any
 * network call.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "grant-admin-key-0123456789abcdef0123456789abcdef";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminId: number;

async function seedAdmin(): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role,
                        email_verified, service_access)
     VALUES ('grantadmin', 'grantadmin@example.org', 'x', 'grantadmin-gh', 'approved', 'admin', 1, 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='grantadmin'").get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
  return u.id;
}

interface CliSeed {
  status?: string;
  serviceAccess?: 0 | 1;
}

/** CLI-style row: username set, email verified, no upload grant by default. */
function seedCliUser(username: string, { status = "verified", serviceAccess = 0 }: CliSeed = {}) {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, signup_source,
                        email_verified, service_access)
     VALUES (?, ?, 'x', ?, ?, 'cli', 1, ?)`,
    [username, `${username}@example.org`, `${username}-gh`, status, serviceAccess],
  );
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error(`seed failed for ${username}`);
  return row;
}

/** Web/ORCID-style row: username NULL, ORCID-verified. `emailVerified`
 *  defaults to 1 because ADR 0040 phase 2 makes a verified email a
 *  precondition of approval for every signup source; the listing cases below
 *  that only need a row to exist pass 0. */
function seedWebUser(email: string, status = "pending", emailVerified: 0 | 1 = 1) {
  db.run(
    `INSERT INTO users (email, status, signup_source, email_verified, orcid, orcid_verified,
                        given_name, family_name)
     VALUES (?, ?, 'web', ?, '0000-0002-1825-0097', 1, 'Jose', 'Hernandez')`,
    [email, status, emailVerified],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error(`seed failed for ${email}`);
  return row;
}

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
}

function post(path: string, key = ADMIN_KEY): Promise<Response> {
  return app.request(path, { method: "POST", headers: { Authorization: `Bearer ${key}` } }, env());
}

function get(path: string, key = ADMIN_KEY): Promise<Response> {
  return app.request(path, { headers: { Authorization: `Bearer ${key}` } }, env());
}

interface GrantState {
  status: string;
  service_access: number;
  service_access_granted_at: string | null;
  service_access_granted_by: number | null;
}

function grantState(id: number): GrantState {
  const row = db
    .query<GrantState, [number]>(
      `SELECT status, service_access, service_access_granted_at, service_access_granted_by
         FROM users WHERE id = ?`,
    )
    .get(id);
  if (!row) throw new Error(`no user ${id}`);
  return row;
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  adminId = await seedAdmin();
});

describe("POST /admin/approve/:username grants upload access (#1249)", () => {
  test("approving a verified CLI user sets service_access and both stamps", async () => {
    const { id } = seedCliUser("grantee1");
    expect(grantState(id).service_access).toBe(0);

    const res = await post("/admin/approve/grantee1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.service_access).toBe(true);

    const row = grantState(id);
    expect(row.status).toBe("approved");
    expect(row.service_access).toBe(1);
    expect(row.service_access_granted_at).not.toBeNull();
    // The grant names the admin who made it, unlike the migration's system grant.
    expect(row.service_access_granted_by).toBe(adminId);
  });

  test("the audit row records that the grant happened", async () => {
    seedCliUser("grantee2");
    await post("/admin/approve/grantee2");

    const audit = db
      .query<{ details: string }, []>(
        "SELECT details FROM audit_log WHERE action = 'user_approved' AND resource_id = 'grantee2'",
      )
      .get();
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit?.details ?? "{}").service_access_granted).toBe(true);
  });

  test("re-approving a revoked user re-grants upload access", async () => {
    const { id } = seedCliUser("grantee3", { status: "revoked" });
    const res = await post("/admin/approve/grantee3");
    expect(res.status).toBe(200);
    expect(grantState(id).service_access).toBe(1);
  });

  test("an audit failure does not 500 an approval that already committed", async () => {
    // The opposite trade-off from the repair path, for a reason: here the
    // status flip and grant are committed BEFORE the notification email is
    // attempted (never tell a user they are approved before the row says so),
    // so the audit insert cannot be batched with them. Once they are committed
    // there is nothing to roll back, and a 500 would tell the admin their
    // completed approval failed and send them into a retry that now 409s.
    const { id } = seedCliUser("grantee4");
    db.run("DROP TABLE audit_log");

    const res = await post("/admin/approve/grantee4");

    expect(res.status).toBe(200);
    expect((await res.json()).user.service_access).toBe(true);
    expect(grantState(id).status).toBe("approved");
    expect(grantState(id).service_access).toBe(1);
  });
});

describe("POST /admin/approve/by-id/:id grants upload access", () => {
  test("approving a verified web signup by id grants it too", async () => {
    const { id } = seedWebUser("web-grant@example.org", "verified");
    const res = await post(`/admin/approve/by-id/${id}`);
    expect(res.status).toBe(200);

    const row = grantState(id);
    expect(row.status).toBe("approved");
    expect(row.service_access).toBe(1);
    expect(row.service_access_granted_by).toBe(adminId);
  });

  test("a web signup with an unverified email is refused, and granted nothing", async () => {
    // ADR 0040 phase 2 narrowed #1012's eligibility: ORCID proves the person,
    // the emailed code proves the inbox, and approval cannot stand in for the
    // second. The grant is what makes this worth asserting -- a refused
    // approval that still wrote service_access would be the #1249 bug with
    // the sign flipped.
    const { id } = seedWebUser("web-unverified@example.org", "pending", 0);
    const res = await post(`/admin/approve/by-id/${id}`);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain("verify their email");

    const row = grantState(id);
    expect(row.status).toBe("pending");
    expect(row.service_access).toBe(0);
  });
});

describe("the approved-but-ungranted repair path (ADR 0040)", () => {
  test("200 with a note, not 409, and the grant is written", async () => {
    const { id } = seedCliUser("stuck1", { status: "approved", serviceAccess: 0 });

    const res = await post("/admin/approve/stuck1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.note).toContain("already approved");
    expect(body.user.service_access).toBe(true);

    const row = grantState(id);
    expect(row.status).toBe("approved");
    expect(row.service_access).toBe(1);
    expect(row.service_access_granted_by).toBe(adminId);
    // The repair stamps WHEN as well as WHO: a grant with no timestamp is
    // indistinguishable from the migration's system grant in the listing.
    expect(row.service_access_granted_at).not.toBeNull();
  });

  test("the repair is audited under its own action, naming the cause and the admin", async () => {
    seedCliUser("stuck2", { status: "approved", serviceAccess: 0 });
    await post("/admin/approve/stuck2");

    const audit = db
      .query<{ resource_id: string; details: string }, []>(
        "SELECT resource_id, details FROM audit_log WHERE action = 'user_upload_access_granted'",
      )
      .get();
    expect(audit?.resource_id).toBe("stuck2");

    // The repair is rare and unexpected, so its row has to explain itself
    // months later: WHY it fired, and WHO fired it.
    const details = JSON.parse(audit?.details ?? "{}");
    expect(details.repair).toContain("service_access=0");
    expect(details.granted_by_id).toBe(adminId);
    expect(details.granted_by).toBe("grantadmin");
  });

  test("an audit failure leaves no orphaned grant, and says so", async () => {
    // Fault injection against the real engine, not a mock: the audit table is
    // genuinely gone, so the production code runs against a database that
    // really cannot record the repair.
    //
    // Unbatched, the UPDATE would commit and the audit insert would then throw
    // into Hono's default 500 — the admin sees "unexpected error", the grant IS
    // live, and their retry 409s "already approved". Batched, the grant never
    // lands and the error tells the truth, so the retry works.
    const { id } = seedCliUser("stuck4", { status: "approved", serviceAccess: 0 });
    db.run("DROP TABLE audit_log");

    const res = await post("/admin/approve/stuck4");

    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("NOT granted");
    expect(grantState(id).service_access).toBe(0);
    expect(grantState(id).service_access_granted_by).toBeNull();
  });

  test("by-id takes the same repair path", async () => {
    const { id } = seedCliUser("stuck3", { status: "approved", serviceAccess: 0 });
    const res = await post(`/admin/approve/by-id/${id}`);
    expect(res.status).toBe(200);
    expect(grantState(id).service_access).toBe(1);
  });

  test("a user who is approved AND granted still 409s", async () => {
    const { id } = seedCliUser("done1", { status: "approved", serviceAccess: 1 });
    const res = await post("/admin/approve/done1");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("User already approved");
    // The 409 path writes nothing, so no stamp appears from a refused call.
    expect(grantState(id).service_access_granted_by).toBeNull();
  });
});

describe("POST /admin/revoke/:username clears the grant and its stamps", () => {
  test("revoke erases service_access, granted_at and granted_by", async () => {
    const { id } = seedCliUser("revokee1");
    await post("/admin/approve/revokee1");
    expect(grantState(id).service_access_granted_by).toBe(adminId);

    const res = await post("/admin/revoke/revokee1");
    expect(res.status).toBe(200);

    const row = grantState(id);
    expect(row.status).toBe("revoked");
    expect(row.service_access).toBe(0);
    expect(row.service_access_granted_at).toBeNull();
    expect(row.service_access_granted_by).toBeNull();
  });

  test("the revoke audit row records the clearing", async () => {
    seedCliUser("revokee2", { status: "approved", serviceAccess: 1 });
    await post("/admin/revoke/revokee2");

    const audit = db
      .query<{ details: string }, []>(
        "SELECT details FROM audit_log WHERE action = 'user_revoked' AND resource_id = 'revokee2'",
      )
      .get();
    expect(JSON.parse(audit?.details ?? "{}").service_access_cleared).toBe(true);
  });

  test("an audit failure does not 500 a revocation that already happened", async () => {
    // By the time the audit row is written, tokens, IAM credentials, GitHub
    // collaborations, S3 permissions, `status` and `service_access` have all
    // been changed and cannot be undone. A 500 here would read as "the user
    // still has access" — the one wrong answer for a revocation.
    const { id } = seedCliUser("revokee3", { status: "approved", serviceAccess: 1 });
    db.run("DROP TABLE audit_log");

    const res = await post("/admin/revoke/revokee3");

    expect(res.status).toBe(200);
    expect(grantState(id).status).toBe("revoked");
    expect(grantState(id).service_access).toBe(0);
  });
});

describe("GET /admin/users reports the tier", () => {
  test("returns service_access, signup_source, identity and email_verified", async () => {
    seedCliUser("listed1", { status: "approved", serviceAccess: 1 });
    seedWebUser("listed-web@example.org", "pending", 0);

    const res = await get("/admin/users");
    expect(res.status).toBe(200);
    const body = await res.json();

    const cli = body.users.find((u: { username: string | null }) => u.username === "listed1");
    expect(cli.service_access).toBe(1);
    expect(cli.signup_source).toBe("cli");
    expect(cli.email_verified).toBe(1);

    const web = body.users.find((u: { email: string }) => u.email === "listed-web@example.org");
    // A web row is the reason the identity columns are in the listing: it has
    // no username, so the name and ORCID are all an admin has to go on.
    expect(web.username).toBeNull();
    expect(web.service_access).toBe(0);
    expect(web.signup_source).toBe("web");
    expect(web.given_name).toBe("Jose");
    expect(web.family_name).toBe("Hernandez");
    expect(web.orcid).toBe("0000-0002-1825-0097");
  });

  test("an approval flips the listed tier and publishes the grant timestamp", async () => {
    seedCliUser("listed2");
    const before = await (await get("/admin/users?status=verified")).json();
    const beforeRow = before.users.find((u: { username: string }) => u.username === "listed2");
    expect(beforeRow.service_access).toBe(0);
    expect(beforeRow.service_access_granted_at).toBeNull();

    await post("/admin/approve/listed2");

    const after = await (await get("/admin/users?status=approved")).json();
    const afterRow = after.users.find((u: { username: string }) => u.username === "listed2");
    expect(afterRow.service_access).toBe(1);
    // The column is selected AND populated: an admin reviewing the listing can
    // see when the grant was made, not just that it exists.
    expect(afterRow.service_access_granted_at).not.toBeNull();
    expect(typeof afterRow.service_access_granted_at).toBe("string");
  });
});
