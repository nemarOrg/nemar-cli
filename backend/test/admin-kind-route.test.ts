/**
 * POST /admin/users/:username/kind and GET /admin/users?kind= (epic #1272
 * phase 4, #1284; ADR 0048).
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, the
 * real admin router (authMiddleware + adminMiddleware + ownerMiddleware,
 * real hashed tokens). No mocks.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const OWNER_KEY = "kind-route-owner-key-0123456789abcdef012345";
const ADMIN_KEY = "kind-route-admin-key-0123456789abcdef012345";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

async function seedActor(username: string, role: "owner" | "admin", apiKey: string): Promise<void> {
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

function seedTarget(
  username: string,
  opts: { accountKind?: "person" | "service" | "test"; orcidVerified?: boolean } = {},
): void {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, account_kind, orcid, orcid_verified)
     VALUES (?, ?, 'x', 'verified', 'member', 1, ?, ?, ?)`,
  ).run(
    username,
    `${username}@example.org`,
    opts.accountKind ?? "person",
    opts.orcidVerified ? "0000-0002-1825-0097" : null,
    opts.orcidVerified ? 1 : 0,
  );
}

function kindOf(username: string): string | undefined {
  return db
    .query<{ account_kind: string }, [string]>("SELECT account_kind FROM users WHERE username = ?")
    .get(username)?.account_kind;
}

function auditRows(action: string) {
  return db
    .query<{ user_id: number | null; resource_id: string | null; details: string | null }, [string]>(
      "SELECT user_id, resource_id, details FROM audit_log WHERE action = ? ORDER BY id",
    )
    .all(action);
}

function postKind(username: string, kind: string, apiKey: string): Promise<Response> {
  return app.request(
    `/admin/users/${username}/kind`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ kind }),
    },
    { DB: realD1(db), ENVIRONMENT: "test" } as Bindings,
  );
}

function getUsers(query: string, apiKey: string): Promise<Response> {
  return app.request(
    `/admin/users${query}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    { DB: realD1(db), ENVIRONMENT: "test" } as Bindings,
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedActor("kindowner", "owner", OWNER_KEY);
  await seedActor("kindadmin", "admin", ADMIN_KEY);
});

describe("POST /admin/users/:username/kind", () => {
  test("an owner changes a person to service and back", async () => {
    seedTarget("persona1", { accountKind: "person" });

    const toService = await postKind("persona1", "service", OWNER_KEY);
    expect(toService.status).toBe(200);
    const body = (await toService.json()) as { message: string; user: { account_kind: string } };
    expect(body.user.account_kind).toBe("service");
    expect(body.message).toContain("'person' to 'service'");
    expect(kindOf("persona1")).toBe("service");

    const toTest = await postKind("persona1", "test", OWNER_KEY);
    expect(toTest.status).toBe(200);
    expect(kindOf("persona1")).toBe("test");
  });

  test("an admin (non-owner) gets 403", async () => {
    seedTarget("persona2");
    const res = await postKind("persona2", "service", ADMIN_KEY);
    expect(res.status).toBe(403);
    expect(kindOf("persona2")).toBe("person");
  });

  test("targeting your own account answers 400", async () => {
    const res = await postKind("kindowner", "service", OWNER_KEY);
    expect(res.status).toBe(400);
    expect(kindOf("kindowner")).toBe("person");
  });

  test("an unchanged kind answers 409 same_kind", async () => {
    seedTarget("persona3", { accountKind: "test" });
    const res = await postKind("persona3", "test", OWNER_KEY);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("same_kind");
  });

  test("an invalid kind value answers 400 at the validation boundary", async () => {
    seedTarget("persona4");
    const res = await postKind("persona4", "bogus", OWNER_KEY);
    expect(res.status).toBe(400);
    expect(kindOf("persona4")).toBe("person");
  });

  test("an unknown username answers 404", async () => {
    const res = await postKind("nonexistent-user", "service", OWNER_KEY);
    expect(res.status).toBe(404);
  });

  test("a verified ORCID iD refuses the move to a non-person kind with 409 orcid_linked", async () => {
    seedTarget("persona5", { accountKind: "person", orcidVerified: true });
    const res = await postKind("persona5", "service", OWNER_KEY);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("orcid_linked");
    expect(body.message).toContain("unlink it before making this a service or test account");
    expect(kindOf("persona5")).toBe("person");
  });

  test("a verified ORCID iD does NOT block a move TO person (already person, so this is same_kind)", async () => {
    // The orcid_linked refusal only fires for a move AWAY from person; moving
    // INTO person with a verified iD is the ordinary, unblocked case.
    seedTarget("persona6", { accountKind: "test", orcidVerified: true });
    const res = await postKind("persona6", "person", OWNER_KEY);
    expect(res.status).toBe(200);
    expect(kindOf("persona6")).toBe("person");
  });

  test("writes an account_kind_changed audit row with from/to", async () => {
    seedTarget("persona7", { accountKind: "person" });
    await postKind("persona7", "service", OWNER_KEY);
    const rows = auditRows("account_kind_changed");
    expect(rows).toHaveLength(1);
    expect(rows[0].resource_id).toBe("persona7");
    expect(JSON.parse(rows[0].details ?? "{}")).toMatchObject({ from: "person", to: "service" });
  });

  test("keys are not revoked on a kind change", async () => {
    seedTarget("persona8", { accountKind: "person" });
    const target = db
      .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
      .get("persona8");
    if (!target) throw new Error("seed failed");
    db.query(
      "INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)",
    ).run(target.id, "persona8-existing-hash", "nm_persona");

    await postKind("persona8", "service", OWNER_KEY);

    const row = db
      .query<{ revoked_at: string | null }, [string]>(
        "SELECT revoked_at FROM tokens WHERE api_key_hash = ?",
      )
      .get("persona8-existing-hash");
    expect(row?.revoked_at).toBeNull();
  });
});

describe("GET /admin/users?kind=", () => {
  beforeEach(() => {
    seedTarget("filterperson", { accountKind: "person" });
    seedTarget("filterservice", { accountKind: "service" });
    seedTarget("filtertest", { accountKind: "test" });
  });

  test("narrows to the requested kind", async () => {
    const body = (await (await getUsers("?kind=test", OWNER_KEY)).json()) as {
      users: { username: string }[];
    };
    expect(body.users.map((u) => u.username)).toEqual(["filtertest"]);
  });

  test("an invalid kind value answers 400", async () => {
    const res = await getUsers("?kind=bogus", OWNER_KEY);
    expect(res.status).toBe(400);
  });

  test("account_kind is carried on every listed row", async () => {
    const body = (await (await getUsers("?kind=service", OWNER_KEY)).json()) as {
      users: { username: string; account_kind: string }[];
    };
    expect(body.users[0]?.account_kind).toBe("service");
  });
});
