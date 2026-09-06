/**
 * Real route tests for the duplicate-account report and the identity-conflict
 * flag it reports on (#1254, epic #1250; ADR 0043).
 *
 *   GET  /admin/users/duplicates
 *   POST /admin/users/:id/clear-identity-conflict
 *
 * Real engine, no mocks: bun:sqlite behind realD1 with every migration applied
 * (INCLUDING 0077, so the rows the report describes are flagged by the real
 * migration rather than by the test), real Hono dispatch through the real
 * admin router, and the production auth + admin middleware reached with a real
 * hashed API token.
 *
 * THE CORRESPONDENCE IS THE POINT. The report's canonical rule and the
 * migration's canonical rule have to agree, or the report tells an operator to
 * resolve the wrong row. So the fixture is seeded BEFORE 0077 runs and the
 * assertion compares the report's `canonical` marks against the flags 0077
 * actually wrote -- rather than against a second hand-written copy of the rule,
 * which would pass however both drifted.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { realD1 } from "./helpers/d1";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");
const TARGET = "0077_identity_uniqueness.sql";
const ADMIN_KEY = "nemar_test_admin_key_for_duplicates";

const SHARED_ORCID = "0000-0002-1974-1293";
const ADMIN_ORCID = "0000-0003-7777-8888";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as unknown as Bindings;
}

function migrationsBefore(target: string): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < target)
    .sort();
}

/** Every migration except 0077, so the fixture can be seeded pre-flag. */
function dbBeforeTarget(): Database {
  const fresh = new Database(":memory:");
  for (const file of migrationsBefore(TARGET)) {
    fresh.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  return fresh;
}

interface SeedOpts {
  orcid?: string | null;
  identityBacked?: boolean;
  github?: string | null;
  username?: string | null;
  deleted?: boolean;
  role?: string;
}

function seedUser(email: string, opts: SeedOpts = {}): number {
  db.run(
    `INSERT INTO users (username, email, status, signup_source, email_verified,
                        orcid, orcid_verified, github_username, role, deleted_at)
     VALUES (?, ?, 'verified', 'web', 1, ?, ?, ?, ?, ?)`,
    [
      opts.username ?? null,
      email,
      opts.orcid ?? null,
      opts.orcid ? 1 : 0,
      opts.github ?? null,
      opts.role ?? "member",
      opts.deleted ? "2026-01-01 00:00:00" : null,
    ],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error(`seed failed for ${email}`);
  if (opts.identityBacked && opts.orcid) {
    db.run(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', ?)",
      [row.id, opts.orcid],
    );
  }
  return row.id;
}

async function seedAdminToken(userId: number): Promise<void> {
  db.run(
    "INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, 'nemar_te')",
    [userId, await hashApiKey(ADMIN_KEY)],
  );
}

function get(path: string): Promise<Response> {
  return app.request(path, { headers: { Authorization: `Bearer ${ADMIN_KEY}` } }, env());
}

function post(path: string): Promise<Response> {
  return app.request(
    path,
    { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
    env(),
  );
}

function flagOf(id: number): number {
  return (
    db
      .query<{ identity_conflict: number }, [number]>(
        "SELECT identity_conflict FROM users WHERE id = ?",
      )
      .get(id)?.identity_conflict ?? -1
  );
}

interface ReportBody {
  groups: {
    kind: string;
    value: string;
    canonical_user_id: number;
    accounts: {
      id: number;
      username: string | null;
      email: string;
      created_at: string;
      has_oauth_identity: boolean;
      dataset_count: number;
      identity_conflict: number;
      canonical: boolean;
    }[];
  }[];
  group_count: number;
  flagged_count: number;
}

/** Ids the fixture assigns, in seed order. */
let orphanId: number;
let holderId: number;
let adaLowId: number;
let adaHighId: number;
let adminId: number;

beforeEach(async () => {
  db = dbBeforeTarget();
  // The production 42/43 shape: the ORPHAN gets the lower id, the
  // identity-backed row the higher one, so "lowest id" and "identity row"
  // disagree and the report has to pick the same winner 0077 does.
  orphanId = seedUser("robert.oostenveld@donders.ru.nl", { orcid: SHARED_ORCID });
  holderId = seedUser("r.oostenveld@donders.ru.nl", {
    orcid: SHARED_ORCID,
    identityBacked: true,
    username: null,
  });
  adaLowId = seedUser("Ada@Lab.org", { username: "ada" });
  adaHighId = seedUser("ada@lab.org");
  adminId = seedUser("root@nemar.org", {
    username: "root",
    role: "admin",
    orcid: ADMIN_ORCID,
    identityBacked: true,
  });
  // A dataset on the surviving ORCID row, so `dataset_count` is not uniformly
  // zero and a transposed count would be visible.
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, is_sandbox)
     VALUES ('nm099001', 'A dataset', ?, 0)`,
    [holderId],
  );
  db.exec(readFileSync(join(MIGRATIONS_DIR, TARGET), "utf-8"));
  await seedAdminToken(adminId);

  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
});

describe("GET /admin/users/duplicates", () => {
  test("groups both duplicate identifiers and leaves the clean row out", async () => {
    const res = await get("/admin/users/duplicates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReportBody;
    expect(body.group_count).toBe(2);
    const kinds = body.groups.map((g) => g.kind).sort();
    expect(kinds).toEqual(["email", "orcid"]);
    // The admin row shares nothing, so it must not appear in any group.
    const listed = new Set(body.groups.flatMap((g) => g.accounts.map((a) => a.id)));
    expect(listed.has(adminId)).toBe(false);
  });

  test("the canonical mark matches the row migration 0077 left unflagged", async () => {
    // Correspondence asserted against the migration's OWN output, not against
    // a second copy of the rule: if the two ever disagree, this fails.
    const res = await get("/admin/users/duplicates");
    const body = (await res.json()) as ReportBody;
    for (const group of body.groups) {
      for (const account of group.accounts) {
        expect(account.canonical).toBe(flagOf(account.id) === 0);
      }
      expect(group.canonical_user_id).toBe(
        group.accounts.find((a) => a.canonical)?.id as number,
      );
    }
    // Named explicitly too, so a report that marked NOTHING canonical (and so
    // trivially matched a catalog where every row was flagged) still fails.
    const orcidGroup = body.groups.find((g) => g.kind === "orcid");
    expect(orcidGroup?.canonical_user_id).toBe(holderId);
    const emailGroup = body.groups.find((g) => g.kind === "email");
    expect(emailGroup?.canonical_user_id).toBe(adaLowId);
  });

  test("each row carries the facts an operator decides on", async () => {
    const res = await get("/admin/users/duplicates");
    const body = (await res.json()) as ReportBody;
    const orcidGroup = body.groups.find((g) => g.kind === "orcid");
    const survivor = orcidGroup?.accounts.find((a) => a.id === holderId);
    const orphan = orcidGroup?.accounts.find((a) => a.id === orphanId);
    expect(survivor?.has_oauth_identity).toBe(true);
    expect(orphan?.has_oauth_identity).toBe(false);
    expect(survivor?.dataset_count).toBe(1);
    expect(orphan?.dataset_count).toBe(0);
    expect(orphan?.identity_conflict).toBe(1);
    expect(typeof survivor?.created_at).toBe("string");
  });

  test("flagged_count counts live flagged rows", async () => {
    const res = await get("/admin/users/duplicates");
    const body = (await res.json()) as ReportBody;
    // The ORCID orphan and the higher-id Ada.
    expect(body.flagged_count).toBe(2);
  });

  test("the email group is keyed case-insensitively on the normalised value", async () => {
    const res = await get("/admin/users/duplicates");
    const body = (await res.json()) as ReportBody;
    const emailGroup = body.groups.find((g) => g.kind === "email");
    expect(emailGroup?.value).toBe("ada@lab.org");
    expect(emailGroup?.accounts.map((a) => a.id).sort()).toEqual([adaLowId, adaHighId].sort());
  });

  test("a tombstoned row is not a duplicate", async () => {
    seedUser("deleted+90@deleted.invalid", { orcid: SHARED_ORCID, deleted: true });
    const res = await get("/admin/users/duplicates");
    const body = (await res.json()) as ReportBody;
    const orcidGroup = body.groups.find((g) => g.kind === "orcid");
    expect(orcidGroup?.accounts).toHaveLength(2);
  });

  test("a GitHub duplicate is reported too, case-insensitively", async () => {
    // 0012's table-wide unique NOCASE index means this should be impossible in
    // practice; the grouping exists so the report describes all three
    // identifiers rather than two. Seeded past the index to prove the grouping
    // is real code rather than a dead branch.
    db.exec("DROP INDEX idx_users_github");
    seedUser("gh-a@example.org", { github: "Octocat" });
    seedUser("gh-b@example.org", { github: "octocat" });
    const res = await get("/admin/users/duplicates");
    const body = (await res.json()) as ReportBody;
    const githubGroup = body.groups.find((g) => g.kind === "github");
    expect(githubGroup?.value).toBe("octocat");
    expect(githubGroup?.accounts).toHaveLength(2);
  });

  test("a clean catalog reports nothing", async () => {
    db.run("DELETE FROM users WHERE id IN (?, ?)", [orphanId, adaHighId]);
    const res = await get("/admin/users/duplicates");
    const body = (await res.json()) as ReportBody;
    expect(body.groups).toEqual([]);
    expect(body.group_count).toBe(0);
    expect(body.flagged_count).toBe(0);
  });

  test("a non-admin cannot read it", async () => {
    const memberId = seedUser("member@example.org", { username: "member" });
    db.run("UPDATE tokens SET user_id = ? WHERE user_id = ?", [memberId, adminId]);
    const res = await get("/admin/users/duplicates");
    expect(res.status).toBe(403);
  });
});

describe("POST /admin/users/:id/clear-identity-conflict", () => {
  test("refuses while the collision remains, naming the colliding rows", async () => {
    const res = await post(`/admin/users/${orphanId}/clear-identity-conflict`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      code: string;
      message: string;
      colliding: { kind: string; value: string; user_ids: number[] }[];
    };
    expect(body.error).toBe("identity_conflict_remains");
    expect(body.code).toBe("identity_conflict_remains");
    expect(body.message).toContain("Resolve it on the other account");
    expect(body.colliding).toHaveLength(1);
    expect(body.colliding[0].kind).toBe("orcid");
    expect(body.colliding[0].user_ids).toEqual([holderId]);
    // And nothing was written.
    expect(flagOf(orphanId)).toBe(1);
  });

  test("succeeds once the other row is soft-deleted", async () => {
    db.run("UPDATE users SET deleted_at = datetime('now'), orcid = NULL WHERE id = ?", [holderId]);
    const res = await post(`/admin/users/${orphanId}/clear-identity-conflict`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: number; cleared: boolean };
    expect(body).toEqual({ ok: true, id: orphanId, cleared: true });
    expect(flagOf(orphanId)).toBe(0);
  });

  test("the cleared row then holds the identifier for real", async () => {
    // The flag is not cosmetic: clearing it puts the row back INTO the partial
    // unique index, so a third claim on the iD is refused from then on.
    db.run("UPDATE users SET deleted_at = datetime('now'), orcid = NULL WHERE id = ?", [holderId]);
    await post(`/admin/users/${orphanId}/clear-identity-conflict`);
    expect(() =>
      db.run(
        "INSERT INTO users (email, status, signup_source, orcid) VALUES ('third@example.org', 'verified', 'web', ?)",
        [SHARED_ORCID],
      ),
    ).toThrow(/UNIQUE constraint failed: users\.orcid/);
  });

  test("writes an audit row", async () => {
    db.run("UPDATE users SET deleted_at = datetime('now'), orcid = NULL WHERE id = ?", [holderId]);
    await post(`/admin/users/${orphanId}/clear-identity-conflict`);
    const row = db
      .query<{ action: string; resource_id: string; user_id: number }, []>(
        "SELECT action, resource_id, user_id FROM audit_log WHERE action = 'identity_conflict_cleared'",
      )
      .get();
    expect(row?.resource_id).toBe(String(orphanId));
    expect(row?.user_id).toBe(adminId);
  });

  test("an already-clear row is a no-op, not an error", async () => {
    const res = await post(`/admin/users/${adminId}/clear-identity-conflict`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { cleared: boolean }).toEqual({
      ok: true,
      id: adminId,
      cleared: false,
    });
  });

  test("an unknown id is a 404", async () => {
    const res = await post("/admin/users/999999/clear-identity-conflict");
    expect(res.status).toBe(404);
  });

  test("a non-numeric id is a 400", async () => {
    const res = await post("/admin/users/not-a-number/clear-identity-conflict");
    expect(res.status).toBe(400);
  });
});
