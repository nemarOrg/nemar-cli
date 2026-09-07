/**
 * Owner-only key routes for non-person account kinds (epic #1272 phase 4,
 * #1284; ADR 0048): POST/GET/DELETE /admin/users/:username/keys[/:id].
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, the
 * real admin router (authMiddleware + adminMiddleware + ownerMiddleware,
 * real hashed API keys and tokens). No mocks.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { MAX_LIVE_API_KEYS } from "../../shared/contract/device-auth.js";
import { adminRoutes } from "../src/routes/admin";
import { userRoutes } from "../src/routes/users";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const OWNER_KEY = "admin-keys-owner-key-0123456789abcdef012345";
const ADMIN_KEY = "admin-keys-admin-key-0123456789abcdef012345";
const MEMBER_KEY = "admin-keys-member-key-0123456789abcdef01234";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
}

async function seedActor(
  username: string,
  role: "owner" | "admin" | "member",
  apiKey: string,
): Promise<number> {
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
  return u.id;
}

function seedTarget(
  username: string,
  opts: {
    accountKind?: "person" | "service" | "test";
    status?: "pending" | "verified" | "approved" | "revoked";
    identityConflict?: boolean;
  } = {},
): number {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, account_kind, identity_conflict)
     VALUES (?, ?, 'x', ?, 'member', 1, ?, ?)`,
  ).run(
    username,
    `${username}@example.org`,
    opts.status ?? "verified",
    opts.accountKind ?? "service",
    opts.identityConflict ? 1 : 0,
  );
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error("seed: target insert failed");
  return row.id;
}

function auditRows(action: string) {
  return db
    .query<
      { user_id: number | null; resource_id: string | null; details: string | null },
      [string]
    >("SELECT user_id, resource_id, details FROM audit_log WHERE action = ? ORDER BY id")
    .all(action);
}

function createKey(username: string, name: unknown, apiKey: string): Promise<Response> {
  return app.request(
    `/admin/users/${username}/keys`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    },
    env(),
  );
}

function listKeys(username: string, apiKey: string): Promise<Response> {
  return app.request(
    `/admin/users/${username}/keys`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    env(),
  );
}

function revokeKey(username: string, id: string | number, apiKey: string): Promise<Response> {
  return app.request(
    `/admin/users/${username}/keys/${id}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${apiKey}` } },
    env(),
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  app.route("/users", userRoutes);
  await seedActor("keysowner", "owner", OWNER_KEY);
  await seedActor("keysadmin", "admin", ADMIN_KEY);
  await seedActor("keysmember", "member", MEMBER_KEY);
});

describe("POST /admin/users/:username/keys", () => {
  test("mints for a service account, and the key authenticates GET /users/me", async () => {
    seedTarget("svc1", { accountKind: "service" });
    const res = await createKey("svc1", "svc1-machine", OWNER_KEY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      api_key: string;
      key: { name: string | null; current: boolean };
    };
    expect(body.api_key.startsWith("nm_")).toBe(true);
    expect(body.key.name).toBe("svc1-machine");
    expect(body.key.current).toBe(false);

    const me = await app.request(
      "/users/me",
      { headers: { Authorization: `Bearer ${body.api_key}` } },
      env(),
    );
    expect(me.status).toBe(200);
  });

  test("mints for a test-kind account", async () => {
    seedTarget("persona1", { accountKind: "test" });
    const res = await createKey("persona1", "personas-laptop", OWNER_KEY);
    expect(res.status).toBe(200);
  });

  test("refuses a person target with 403 person_account, and mints no row", async () => {
    seedTarget("person1", { accountKind: "person" });
    const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get()?.n ?? 0;
    const res = await createKey("person1", "should-not-mint", OWNER_KEY);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("person_account");
    const after = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get()?.n ?? 0;
    expect(after).toBe(before);
  });

  test("an admin (non-owner) gets 403", async () => {
    seedTarget("svc2", { accountKind: "service" });
    const res = await createKey("svc2", "svc2-machine", ADMIN_KEY);
    expect(res.status).toBe(403);
  });

  test("a member gets 403", async () => {
    seedTarget("svc3", { accountKind: "service" });
    const res = await createKey("svc3", "svc3-machine", MEMBER_KEY);
    expect(res.status).toBe(403);
  });

  test("an unknown username answers 404", async () => {
    const res = await createKey("no-such-user", "x", OWNER_KEY);
    expect(res.status).toBe(404);
  });

  test("a pending target answers 403 account_pending", async () => {
    seedTarget("svcpending", { accountKind: "service", status: "pending" });
    const res = await createKey("svcpending", "x", OWNER_KEY);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("account_pending");
  });

  test("a revoked target answers 403 account_revoked", async () => {
    seedTarget("svcrevoked", { accountKind: "service", status: "revoked" });
    const res = await createKey("svcrevoked", "x", OWNER_KEY);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("account_revoked");
  });

  test("an identity_conflict target answers 403 identity_conflict", async () => {
    seedTarget("svcflagged", { accountKind: "service", identityConflict: true });
    const res = await createKey("svcflagged", "x", OWNER_KEY);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("identity_conflict");
  });

  test("a target already at 25 live keys answers 409 too_many_keys", async () => {
    const targetId = seedTarget("svccap", { accountKind: "service" });
    for (let i = 0; i < MAX_LIVE_API_KEYS; i++) {
      db.query(
        "INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, name) VALUES (?, ?, ?, ?)",
      ).run(targetId, `cap-hash-${i}`, "nm_xxx...", `key-${i}`);
    }
    const res = await createKey("svccap", "one-too-many", OWNER_KEY);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("too_many_keys");
  });

  test("writes an api_key_created audit row naming the target and via=admin", async () => {
    seedTarget("svcaudit", { accountKind: "service" });
    const res = await createKey("svcaudit", "audited-machine", OWNER_KEY);
    const keyId = ((await res.json()) as { key: { id: number } }).key.id;
    const rows = auditRows("api_key_created");
    expect(rows).toHaveLength(1);
    expect(rows[0].resource_id).toBe(String(keyId));
    expect(JSON.parse(rows[0].details ?? "{}")).toMatchObject({
      name: "audited-machine",
      via: "admin",
      for_username: "svcaudit",
    });
  });
});

describe("GET /admin/users/:username/keys", () => {
  test("lists a target's live keys, owner-only, works for a person too", async () => {
    const personId = seedTarget("personlist", { accountKind: "person" });
    db.query(
      "INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, name) VALUES (?, ?, ?, ?)",
    ).run(personId, "personlist-hash", "nm_person", "persons-laptop");

    const res = await listKeys("personlist", OWNER_KEY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: { name: string | null; current: boolean }[] };
    expect(body.keys.map((k) => k.name)).toEqual(["persons-laptop"]);
    expect(body.keys.every((k) => !k.current)).toBe(true);
  });

  test("an admin (non-owner) gets 403", async () => {
    seedTarget("svclist", { accountKind: "service" });
    const res = await listKeys("svclist", ADMIN_KEY);
    expect(res.status).toBe(403);
  });

  test("an unknown username answers 404", async () => {
    const res = await listKeys("no-such-user", OWNER_KEY);
    expect(res.status).toBe(404);
  });
});

describe("DELETE /admin/users/:username/keys/:id", () => {
  test("revoking one key leaves the target's other keys untouched", async () => {
    const targetId = seedTarget("svcrevoke", { accountKind: "service" });
    db.query(
      "INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, name) VALUES (?, ?, ?, ?)",
    ).run(targetId, "svcrevoke-hash-a", "nm_a", "key-a");
    db.query(
      "INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, name) VALUES (?, ?, ?, ?)",
    ).run(targetId, "svcrevoke-hash-b", "nm_b", "key-b");
    const idA = db
      .query<{ id: number }, [string]>("SELECT id FROM tokens WHERE api_key_hash = ?")
      .get("svcrevoke-hash-a")?.id;
    if (!idA) throw new Error("seed failed");

    const res = await revokeKey("svcrevoke", idA, OWNER_KEY);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const rowA = db
      .query<{ revoked_at: string | null }, [string]>(
        "SELECT revoked_at FROM tokens WHERE api_key_hash = ?",
      )
      .get("svcrevoke-hash-a");
    const rowB = db
      .query<{ revoked_at: string | null }, [string]>(
        "SELECT revoked_at FROM tokens WHERE api_key_hash = ?",
      )
      .get("svcrevoke-hash-b");
    expect(rowA?.revoked_at).not.toBeNull();
    expect(rowB?.revoked_at).toBeNull();
  });

  test("revoking an unknown key id answers 404 key_not_found", async () => {
    seedTarget("svcrevoke2", { accountKind: "service" });
    const res = await revokeKey("svcrevoke2", 999999, OWNER_KEY);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("key_not_found");
  });

  test("an admin (non-owner) gets 403", async () => {
    const targetId = seedTarget("svcrevoke3", { accountKind: "service" });
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      targetId,
      "svcrevoke3-hash",
      "nm_c",
    );
    const id = db
      .query<{ id: number }, [string]>("SELECT id FROM tokens WHERE api_key_hash = ?")
      .get("svcrevoke3-hash")?.id;
    if (!id) throw new Error("seed failed");
    const res = await revokeKey("svcrevoke3", id, ADMIN_KEY);
    expect(res.status).toBe(403);
  });

  test("writes an api_key_revoked audit row naming via=admin", async () => {
    const targetId = seedTarget("svcrevoke4", { accountKind: "service" });
    db.query(
      "INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, name) VALUES (?, ?, ?, ?)",
    ).run(targetId, "svcrevoke4-hash", "nm_d", "key-d");
    const id = db
      .query<{ id: number }, [string]>("SELECT id FROM tokens WHERE api_key_hash = ?")
      .get("svcrevoke4-hash")?.id;
    if (!id) throw new Error("seed failed");

    await revokeKey("svcrevoke4", id, OWNER_KEY);
    const rows = auditRows("api_key_revoked");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details ?? "{}")).toMatchObject({
      via: "admin",
      for_username: "svcrevoke4",
    });
  });
});
