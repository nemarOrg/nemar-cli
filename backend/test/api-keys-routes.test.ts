/**
 * Real route tests for the named API key routes (epic #1272 phase 1, #1281;
 * ADR 0047).
 *
 * Real engine throughout: bun:sqlite behind `realD1` with every migration
 * applied, real Hono dispatch via `app.request()`, real zod validation, real
 * API-key hashing via `hashApiKey`, real session issuance via
 * `issueSession()`. No mocks.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  MAX_LIVE_API_KEYS,
  apiKeyCreateResponseSchema,
  apiKeyListResponseSchema,
} from "../../shared/contract/device-auth.js";
import { authKeysRoutes } from "../src/routes/auth-keys";
import { userRoutes } from "../src/routes/users";
import { hashApiKey } from "../src/services/token";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ORIGIN = "https://app.nemar.org";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    WEB_SESSION_COOKIE_DOMAIN: "",
    API_BASE_URL: "http://localhost:8787",
  } as unknown as Bindings;
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authKeysRoutes);
  app.route("/users", userRoutes);
});

function seedUser(
  email: string,
  status: "pending" | "verified" | "approved" = "verified",
  opts: { identityConflict?: boolean; accountKind?: "person" | "service" | "test" } = {},
): number {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified, identity_conflict, account_kind)
     VALUES (?, ?, 'x', ?, 'member', 'web', 1, ?, ?)`,
    [
      email.split("@")[0],
      email,
      status,
      opts.identityConflict ? 1 : 0,
      opts.accountKind ?? "person",
    ],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error("seed failed");
  return row.id;
}

function auditRows(action: string) {
  return db
    .query<{ user_id: number | null; details: string | null }, [string]>(
      "SELECT user_id, details FROM audit_log WHERE action = ? ORDER BY id",
    )
    .all(action);
}

async function seedKey(userId: number, name: string, apiKey: string): Promise<number> {
  const hash = await hashApiKey(apiKey);
  db.run("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, name) VALUES (?, ?, ?, ?)", [
    userId,
    hash,
    apiKey.slice(0, 11),
    name,
  ]);
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM tokens WHERE api_key_hash = ?")
    .get(hash);
  if (!row) throw new Error("seed failed");
  return row.id;
}

async function sessionCookie(userId: number): Promise<string> {
  const { cookieIdRaw } = await issueSession(
    env(),
    userId,
    false,
    "test-agent",
    "127.0.0.1",
    "email_code",
  );
  return `nemar_session=${cookieIdRaw}`;
}

function bearerHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

function cookieHeaders(cookie: string, origin: string | null = ORIGIN): Record<string, string> {
  const headers: Record<string, string> = { Cookie: cookie };
  if (origin) headers.Origin = origin;
  return headers;
}

async function listKeys(headers: Record<string, string>): Promise<Response> {
  return app.request("/auth/keys", { headers }, env());
}

async function createKey(headers: Record<string, string>, name: unknown): Promise<Response> {
  return app.request(
    "/auth/keys",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ name }),
    },
    env(),
  );
}

async function revokeKey(headers: Record<string, string>, id: string | number): Promise<Response> {
  return app.request(`/auth/keys/${id}`, { method: "DELETE", headers }, env());
}

// --------------------------------------------------------------------------
// GET /auth/keys
// --------------------------------------------------------------------------

describe("GET /auth/keys", () => {
  test("marks current on the bearer path and never on the cookie path", async () => {
    const ada = seedUser("ada-list@nemar.test");
    const key = "nm_list0123456789abcdefghijklmnopqrstuv";
    await seedKey(ada, "adas-laptop", key);

    const bearerRes = await listKeys(bearerHeaders(key));
    expect(bearerRes.status).toBe(200);
    const bearerBody = (await bearerRes.json()) as { keys: { current: boolean }[] };
    expect(bearerBody.keys.some((k) => k.current)).toBe(true);

    const cookieRes = await listKeys(cookieHeaders(await sessionCookie(ada)));
    expect(cookieRes.status).toBe(200);
    const cookieBody = (await cookieRes.json()) as { keys: { current: boolean }[] };
    expect(cookieBody.keys.every((k) => !k.current)).toBe(true);
  });

  test("omits revoked rows and never serializes the hash", async () => {
    const ada = seedUser("ada-list-revoked@nemar.test");
    const liveKey = "nm_live0123456789abcdefghijklmnopqrstuv";
    const revokedKey = "nm_revoked0123456789abcdefghijklmnopqr";
    await seedKey(ada, "live-key", liveKey);
    const revokedId = await seedKey(ada, "revoked-key", revokedKey);
    db.run("UPDATE tokens SET revoked_at = datetime('now') WHERE id = ?", [revokedId]);

    const res = await listKeys(bearerHeaders(liveKey));
    const body = (await res.json()) as { keys: { name: string | null }[] };
    expect(body.keys.map((k) => k.name)).toEqual(["live-key"]);
    expect(JSON.stringify(body)).not.toContain("api_key_hash");
  });

  test("cookie without Origin answers 403", async () => {
    const ada = seedUser("ada-list-noorigin@nemar.test");
    const res = await listKeys(cookieHeaders(await sessionCookie(ada), null));
    expect(res.status).toBe(403);
  });

  test("a pending cookie session answers 403 Account not approved", async () => {
    const pending = seedUser("ada-list-pending@nemar.test", "pending");
    const res = await listKeys(cookieHeaders(await sessionCookie(pending)));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Account not approved");
  });

  test("Cache-Control: no-store", async () => {
    const res = await listKeys({});
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("matches the published contract schema", async () => {
    const ada = seedUser("ada-schema-list@nemar.test");
    await seedKey(ada, "schema-key", "nm_schemalist0123456789abcdefghijklmno");
    const res = await listKeys(cookieHeaders(await sessionCookie(ada)));
    const parsed = apiKeyListResponseSchema.safeParse(await res.json());
    expect(parsed.success ? [] : parsed.error.issues.map((i) => i.path.join("."))).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// POST /auth/keys
// --------------------------------------------------------------------------

describe("POST /auth/keys", () => {
  test("mints a key that then authenticates", async () => {
    const ada = seedUser("ada-mint@nemar.test");
    const res = await createKey(cookieHeaders(await sessionCookie(ada)), "new-machine");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      api_key: string;
      key: { name: string | null; current: boolean };
    };
    expect(body.api_key.startsWith("nm_")).toBe(true);
    expect(body.key.name).toBe("new-machine");
    expect(body.key.current).toBe(false);

    const me = await app.request("/users/me", { headers: bearerHeaders(body.api_key) }, env());
    expect(me.status).toBe(200);
  });

  test("a 26th key answers 409 too_many_keys", async () => {
    const ada = seedUser("ada-cap@nemar.test");
    for (let i = 0; i < MAX_LIVE_API_KEYS; i++) {
      await seedKey(ada, `key-${i}`, `nm_cap${i}0123456789abcdefghijklmnopqrst`.slice(0, 40));
    }
    const res = await createKey(cookieHeaders(await sessionCookie(ada)), "one-too-many");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("too_many_keys");
  });

  test("an empty name answers 400", async () => {
    const ada = seedUser("ada-empty-name@nemar.test");
    const res = await createKey(cookieHeaders(await sessionCookie(ada)), "");
    expect(res.status).toBe(400);
  });

  test("a whitespace-only name answers 400, never a silent default", async () => {
    const ada = seedUser("ada-whitespace-name@nemar.test");
    const res = await createKey(cookieHeaders(await sessionCookie(ada)), "   ");
    expect(res.status).toBe(400);
  });

  test("an identity_conflict account answers 403 identity_conflict and mints no row", async () => {
    const carol = seedUser("carol-conflict-mint@nemar.test", "verified", {
      identityConflict: true,
    });
    const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get()?.n ?? 0;
    const res = await createKey(cookieHeaders(await sessionCookie(carol)), "carols-machine");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("identity_conflict");
    const after = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get()?.n ?? 0;
    expect(after).toBe(before);
  });

  test("a service-kind account answers 403 service_account and mints no row", async () => {
    // Epic #1272 phase 4 (ADR 0048): self-service minting is person-only;
    // `KEY_MINT_SQL` itself also refuses via its own `account_kind = 'person'`
    // predicate, but the route's own account-refusal check is what answers
    // with the typed reason here.
    const service = seedUser("service-self-mint@nemar.test", "verified", {
      accountKind: "service",
    });
    const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get()?.n ?? 0;
    const res = await createKey(cookieHeaders(await sessionCookie(service)), "services-machine");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("service_account");
    const after = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get()?.n ?? 0;
    expect(after).toBe(before);
  });

  test("a test-kind account also answers 403 service_account and mints no row", async () => {
    const test = seedUser("test-persona-self-mint@nemar.test", "verified", { accountKind: "test" });
    const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get()?.n ?? 0;
    const res = await createKey(cookieHeaders(await sessionCookie(test)), "personas-machine");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("service_account");
    const after = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get()?.n ?? 0;
    expect(after).toBe(before);
  });

  test("writes an api_key_created audit row with name and via", async () => {
    const ada = seedUser("ada-mint-audit@nemar.test");
    await createKey(cookieHeaders(await sessionCookie(ada)), "audited-machine");
    const rows = auditRows("api_key_created");
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(ada);
    expect(JSON.parse(rows[0].details ?? "{}")).toEqual({
      name: "audited-machine",
      via: "cookie",
    });
  });

  test("matches the published contract schema", async () => {
    const ada = seedUser("ada-schema-create@nemar.test");
    const res = await createKey(cookieHeaders(await sessionCookie(ada)), "schema-machine");
    const parsed = apiKeyCreateResponseSchema.safeParse(await res.json());
    expect(parsed.success ? [] : parsed.error.issues.map((i) => i.path.join("."))).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// DELETE /auth/keys/:id
// --------------------------------------------------------------------------

describe("DELETE /auth/keys/:id", () => {
  test("revoking another user's key id leaves it untouched and answers 404", async () => {
    const ada = seedUser("ada-revoke-other@nemar.test");
    const bob = seedUser("bob-revoke-other@nemar.test");
    const bobKey = "nm_bob0123456789abcdefghijklmnopqrstuv";
    const bobKeyId = await seedKey(bob, "bobs-key", bobKey);

    const res = await revokeKey(cookieHeaders(await sessionCookie(ada)), bobKeyId);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("key_not_found");

    const row = db
      .query<{ revoked_at: string | null }, [number]>("SELECT revoked_at FROM tokens WHERE id = ?")
      .get(bobKeyId);
    expect(row?.revoked_at).toBeNull();
  });

  test("revoking your own id succeeds, then 404s on retry", async () => {
    const ada = seedUser("ada-revoke-own@nemar.test");
    const key = "nm_own0123456789abcdefghijklmnopqrstuv0";
    const id = await seedKey(ada, "adas-key", key);

    const first = await revokeKey(cookieHeaders(await sessionCookie(ada)), id);
    expect(first.status).toBe(200);
    expect((await first.json()).ok).toBe(true);

    const second = await revokeKey(cookieHeaders(await sessionCookie(ada)), id);
    expect(second.status).toBe(404);
  });

  test("DELETE current on the bearer path revokes the presenting key; a second key still works", async () => {
    const ada = seedUser("ada-revoke-current@nemar.test");
    const key1 = "nm_first0123456789abcdefghijklmnopqrst";
    const key2 = "nm_second0123456789abcdefghijklmnopqrs";
    await seedKey(ada, "first-key", key1);
    await seedKey(ada, "second-key", key2);

    const res = await revokeKey(bearerHeaders(key1), "current");
    expect(res.status).toBe(200);

    const meAfter = await app.request("/users/me", { headers: bearerHeaders(key1) }, env());
    expect(meAfter.status).toBe(401);

    const meOther = await app.request("/users/me", { headers: bearerHeaders(key2) }, env());
    expect(meOther.status).toBe(200);
  });

  test("DELETE current on the cookie path answers 404", async () => {
    const ada = seedUser("ada-revoke-current-cookie@nemar.test");
    const res = await revokeKey(cookieHeaders(await sessionCookie(ada)), "current");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("key_not_found");
  });

  test("api_key_revoked details: self=true for DELETE current", async () => {
    const ada = seedUser("ada-revoke-self-current@nemar.test");
    const key = "nm_selfcurrent0123456789abcdefghijklmn";
    await seedKey(ada, "current-key", key);
    await revokeKey(bearerHeaders(key), "current");
    const rows = auditRows("api_key_revoked");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details ?? "{}")).toMatchObject({ self: true });
  });

  test("api_key_revoked details: self=true when a bearer revokes its own id", async () => {
    const ada = seedUser("ada-revoke-self-id@nemar.test");
    const key = "nm_selfid0123456789abcdefghijklmnopqrs";
    const id = await seedKey(ada, "own-key", key);
    await revokeKey(bearerHeaders(key), id);
    const rows = auditRows("api_key_revoked");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details ?? "{}")).toMatchObject({ self: true });
  });

  test("api_key_revoked details: self=false when revoking a non-presenting key by id", async () => {
    const ada = seedUser("ada-revoke-other-self@nemar.test");
    const key1 = "nm_notself10123456789abcdefghijklmnop";
    const key2 = "nm_notself20123456789abcdefghijklmnop";
    await seedKey(ada, "presenting-key", key1);
    const id2 = await seedKey(ada, "target-key", key2);
    await revokeKey(bearerHeaders(key1), id2);
    const rows = auditRows("api_key_revoked");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details ?? "{}")).toMatchObject({ self: false });
  });
});
