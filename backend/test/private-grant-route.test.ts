/**
 * Real route tests for `POST /auth/private/grant` (ADR 0079).
 *
 * Real engine throughout: bun:sqlite behind `realD1` with every migration
 * applied, real Hono dispatch via `app.request()`, real session issuance via
 * `issueSession()`, real SHA-256 hashing of the one-time code. No mocks.
 *
 * Two layers refuse a non-app session here, and they are tested separately
 * on purpose. `webSessionMiddleware` reads the app scope only, so on the
 * route a docs or private value is simply no session (401). The statement
 * itself also names `ws.scope = 'app'`, and that predicate is invisible
 * through the route, because the middleware absorbs every case it covers. So
 * the statement is also run directly, against real rows, the way
 * `docs-auth-routes.test.ts` proves `DOCS_CLI_MINT_INSERT_SQL`'s own gates.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { PRIVATE_GRANT_TTL_SECONDS } from "../../shared/contract/private-site.js";
import worker from "../src/index";
import { __limits, __selectBucket } from "../src/middleware/rateLimit";
import { authDocsRoutes } from "../src/routes/auth-docs";
import { authPrivateRoutes } from "../src/routes/auth-private";
import { inactiveAccountBody } from "../src/services/account-tier";
import { hashGrantCode } from "../src/services/docs-auth";
import { PRIVATE_GRANT_INSERT_SQL } from "../src/services/private-auth";
import { type AuthMethod, hashCookieId, issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { InMemoryCache } from "./helpers/cache";
import { freshDb, realD1 } from "./helpers/d1";

const APP = "https://app.nemar.org";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    APP_BASE_URL: APP,
    WEB_SESSION_COOKIE_DOMAIN: "",
  } as unknown as Bindings;
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authDocsRoutes);
  app.route("/auth", authPrivateRoutes);
});

function seedUser(
  email: string,
  role: "member" | "admin" | "owner" = "member",
  status = "verified",
): number {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified, account_kind)
     VALUES (?, ?, 'x', ?, ?, 'web', 1, 'person')`,
    [email.split("@")[0], email, status, role],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error("seed failed");
  return row.id;
}

async function appSession(userId: number, authMethod: AuthMethod = "orcid"): Promise<string> {
  const { cookieIdRaw } = await issueSession(
    env(),
    userId,
    false,
    "test-agent",
    "127.0.0.1",
    authMethod,
  );
  return cookieIdRaw;
}

/** A valid `state`: 43 base64url characters, the length 256 random bits make. */
const STATE = "StateForTests_0123456789-abcdefghijklmnopqr";

/** Send the request with no body at all. */
const NO_BODY = Symbol("no body");

function grant(
  cookie?: string,
  origin: string | null = APP,
  body: unknown = { state: STATE },
): Promise<Response> {
  // One address for every request, as the website's egress looks.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "CF-Connecting-IP": "203.0.113.9",
  };
  if (cookie) headers.Cookie = `nemar_session=${cookie}`;
  if (origin) headers.Origin = origin;
  return app.request(
    "/auth/private/grant",
    {
      method: "POST",
      headers,
      ...(body === NO_BODY ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    },
    env(),
  );
}

function grantRow(codeHash: string) {
  return db
    .query<
      {
        user_id: number;
        auth_method: string | null;
        state_hash: string;
        ttl: number;
        live: number;
      },
      [string]
    >(
      `SELECT user_id, auth_method, state_hash,
              CAST(ROUND((julianday(expires_at) - julianday('now')) * 86400) AS INTEGER) AS ttl,
              expires_at > datetime('now') AS live
         FROM private_grants WHERE code_hash = ?`,
    )
    .get(codeHash);
}

function grantCount(): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM private_grants").get()?.n ?? 0;
}

/** A docs session through the real docs routes, for an admin. */
async function docsSession(userId: number): Promise<string> {
  const cookie = await appSession(userId);
  const granted = await app.request(
    "/auth/docs/grant",
    { method: "POST", headers: { Cookie: `nemar_session=${cookie}`, Origin: APP } },
    env(),
  );
  expect(granted.status).toBe(200);
  const { code } = (await granted.json()) as { code: string };
  const exchanged = await app.request(
    "/auth/docs/exchange",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    },
    env(),
  );
  expect(exchanged.status).toBe(200);
  return ((await exchanged.json()) as { session: string }).session;
}

describe("POST /auth/private/grant: refusals", () => {
  test("no session is 401 unauthenticated", async () => {
    // Origin present, so this isolates the missing session: the Origin check
    // runs first and would otherwise answer 403.
    const res = await grant();
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthenticated");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("a missing Origin is 403, even with a live session", async () => {
    const userId = seedUser("noorigin@nemar.test");
    const res = await grant(await appSession(userId), null);
    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(grantCount()).toBe(0);
  });

  test("a foreign Origin is 403, even with a live session", async () => {
    const userId = seedUser("badorigin@nemar.test");
    const res = await grant(await appSession(userId), "https://evil.example");
    expect(res.status).toBe(403);
    expect(grantCount()).toBe(0);
  });

  test("a pending account is 403 with the API's inactive-account body", async () => {
    const userId = seedUser("pending@nemar.test", "member", "pending");
    const res = await grant(await appSession(userId));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(inactiveAccountBody("pending"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(grantCount()).toBe(0);
  });

  test("a revoked app session is 401", async () => {
    const userId = seedUser("revokedsession@nemar.test");
    const cookie = await appSession(userId);
    db.run("UPDATE web_sessions SET revoked_at = datetime('now') WHERE user_id = ?", [userId]);
    expect((await grant(cookie)).status).toBe(401);
    expect(grantCount()).toBe(0);
  });

  test("an expired app session is 401", async () => {
    const userId = seedUser("expiredsession@nemar.test");
    const cookie = await appSession(userId);
    db.run("UPDATE web_sessions SET expires_at = datetime('now', '-1 second') WHERE user_id = ?", [
      userId,
    ]);
    expect((await grant(cookie)).status).toBe(401);
    expect(grantCount()).toBe(0);
  });

  for (const [what, body] of [
    ["no body", NO_BODY],
    ["a body that is not JSON", "state=abc"],
    ["no state field", {}],
    ["a state that is not a string", { state: 1234567890 }],
    ["a 31-character state", { state: "a".repeat(31) }],
    ["a 257-character state", { state: "a".repeat(257) }],
    ["a state with a padding character", { state: `${"a".repeat(42)}=` }],
    ["a state with a standard-base64 character", { state: `${"a".repeat(42)}+` }],
    ["a state with a space", { state: `${"a".repeat(21)} ${"a".repeat(21)}` }],
  ] as const) {
    test(`${what} is 400 invalid_request, and mints nothing`, async () => {
      const userId = seedUser(`state-${what.replace(/\W+/g, "-")}@nemar.test`);
      const res = await grant(await appSession(userId), APP, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(grantCount()).toBe(0);
    });
  }

  test("the shortest and longest accepted states mint", async () => {
    for (const state of ["a".repeat(32), "Z-_9".repeat(64)]) {
      const userId = seedUser(`state-edge-${state.length}@nemar.test`);
      expect((await grant(await appSession(userId), APP, { state })).status).toBe(200);
    }
  });

  test("a docs session presented as the app cookie is no session", async () => {
    const userId = seedUser("docsholder@nemar.test", "admin");
    const docs = await docsSession(userId);
    const before = grantCount();
    expect((await grant(docs)).status).toBe(401);
    expect(grantCount()).toBe(before);
  });
});

describe("POST /auth/private/grant: success", () => {
  test("mints a code for a member: there is no role gate", async () => {
    const userId = seedUser("member@nemar.test", "member");
    const res = await grant(await appSession(userId));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { code: string; expires_in: number };
    expect(body.expires_in).toBe(PRIVATE_GRANT_TTL_SECONDS);
    expect(body.code.length).toBeGreaterThan(20);
  });

  test("a verified account qualifies, not only an approved one", async () => {
    // ADR 0040's base tier is `verified`; the private site serves every
    // account that can use the API.
    const userId = seedUser("verified@nemar.test", "member", "verified");
    expect((await grant(await appSession(userId))).status).toBe(200);
  });

  test("stores the code hashed, for this account, with the app session's auth_method", async () => {
    const userId = seedUser("stored@nemar.test");
    const res = await grant(await appSession(userId, "email_code"));
    const { code } = (await res.json()) as { code: string };

    const row = grantRow(await hashGrantCode(code));
    expect(row?.user_id).toBe(userId);
    expect(row?.auth_method).toBe("email_code");
    // The browser's state is kept only as its hash.
    expect(row?.state_hash).toBe(await hashGrantCode(STATE));
    const stateInClear = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM private_grants WHERE state_hash = ?",
      )
      .get(STATE);
    expect(stateInClear?.n).toBe(0);
    expect(row?.live).toBe(1);
    // SQL-side TTL, measured by the database's own clock.
    expect(row?.ttl).toBeGreaterThan(PRIVATE_GRANT_TTL_SECONDS - 5);
    expect(row?.ttl).toBeLessThanOrEqual(PRIVATE_GRANT_TTL_SECONDS);

    const plaintext = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM private_grants WHERE code_hash = ?",
      )
      .get(code);
    expect(plaintext?.n).toBe(0);
  });

  test("writes nothing to the docs grants table", async () => {
    const userId = seedUser("separate@nemar.test", "admin");
    await grant(await appSession(userId));
    const docs = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM docs_grants").get();
    expect(docs?.n).toBe(0);
  });

  test("prunes grants more than an hour past expiry, and only those", async () => {
    const userId = seedUser("prune@nemar.test");
    db.run(
      `INSERT INTO private_grants (code_hash, state_hash, user_id, expires_at) VALUES
         ('stale', 's', ?, datetime('now', '-2 hours')),
         ('recent', 's', ?, datetime('now', '-10 minutes'))`,
      [userId, userId],
    );
    expect((await grant(await appSession(userId))).status).toBe(200);
    const left = db
      .query<{ code_hash: string }, []>(
        "SELECT code_hash FROM private_grants WHERE code_hash IN ('stale', 'recent')",
      )
      .all();
    expect(left).toEqual([{ code_hash: "recent" }]);
  });
});

describe("PRIVATE_GRANT_INSERT_SQL on its own", () => {
  /** Run the real statement against a session id, and report rows written. */
  async function mintFrom(sessionId: number): Promise<number> {
    const result = await realD1(db)
      .prepare(PRIVATE_GRANT_INSERT_SQL)
      .bind("statement-code", "statement-state", PRIVATE_GRANT_TTL_SECONDS, sessionId)
      .run();
    return result.meta.changes;
  }

  function sessionId(cookieHash: string): number {
    const row = db
      .query<{ id: number }, [string]>("SELECT id FROM web_sessions WHERE cookie_id_hash = ?")
      .get(cookieHash);
    if (!row) throw new Error("no such session");
    return row.id;
  }

  test("mints from a live app session", async () => {
    const userId = seedUser("stmt-app@nemar.test");
    const cookie = await appSession(userId);
    expect(await mintFrom(sessionId(await hashCookieId(cookie)))).toBe(1);
  });

  test("refuses a docs session's id", async () => {
    const userId = seedUser("stmt-docs@nemar.test", "admin");
    const docs = await docsSession(userId);
    expect(await mintFrom(sessionId(await hashCookieId(docs)))).toBe(0);
  });

  test("refuses a private session's id, so a private session cannot renew itself", async () => {
    const userId = seedUser("stmt-private@nemar.test");
    db.run(
      `INSERT INTO web_sessions (user_id, cookie_id_hash, expires_at, scope)
       VALUES (?, 'stmt-private-hash', datetime('now', '+1 hour'), 'private')`,
      [userId],
    );
    expect(await mintFrom(sessionId("stmt-private-hash"))).toBe(0);
  });

  test("refuses an app session revoked or expired since the middleware read it", async () => {
    const userId = seedUser("stmt-dead@nemar.test");
    const revoked = await appSession(userId);
    const expired = await appSession(userId);
    const revokedId = sessionId(await hashCookieId(revoked));
    const expiredId = sessionId(await hashCookieId(expired));
    db.run("UPDATE web_sessions SET revoked_at = datetime('now') WHERE id = ?", [revokedId]);
    db.run("UPDATE web_sessions SET expires_at = datetime('now', '-1 second') WHERE id = ?", [
      expiredId,
    ]);
    expect(await mintFrom(revokedId)).toBe(0);
    expect(await mintFrom(expiredId)).toBe(0);
  });
});

describe("POST /auth/private/grant: wiring", () => {
  test("the real worker routes it: an anonymous POST is 401, not 404", async () => {
    // The same probe the post-deploy check makes. `ENVIRONMENT: "development"`
    // is the documented rate-limit bypass (see docs-auth-routes.test.ts).
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        p.catch(() => {});
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    for (const path of ["/auth/private/grant", "/nemar/auth/private/grant"]) {
      const res = await worker.fetch(
        new Request(`https://api.nemar.org${path}`, { method: "POST", headers: { Origin: APP } }),
        { ...env(), ENVIRONMENT: "development" } as Bindings,
        ctx,
      );
      expect(res.status).toBe(401);
    }
  });

  test("it is NOT in the strict per-IP bucket, under either mount spelling", () => {
    // Every caller shares the website's egress addresses (issue #1354), so the
    // strict bucket would make strangers share ten sign-ins a minute. It rides
    // the generic bucket; the per-account limit below is its real floor.
    for (const path of ["/auth/private/grant", "/nemar/auth/private/grant"]) {
      const sel = __selectBucket(path, undefined, "203.0.113.7");
      expect(sel.keyKind).toBe("ip");
    }
  });
});

describe("POST /auth/private/grant: the per-account limit", () => {
  // The real Cache API is absent under bun; the shared in-memory double
  // (`helpers/cache.ts`) stores and expires entries the way it does.
  let saved: unknown;
  beforeAll(() => {
    saved = (globalThis as { caches?: unknown }).caches;
  });
  beforeEach(() => {
    (globalThis as { caches?: unknown }).caches = { default: new InMemoryCache() };
  });
  afterAll(() => {
    (globalThis as { caches?: unknown }).caches = saved;
  });

  async function grantsUntil429(userId: number): Promise<number[]> {
    const cookie = await appSession(userId);
    const statuses: number[] = [];
    for (let i = 0; i <= __limits.PRIVATE_GRANT_MAX_REQUESTS; i++) {
      statuses.push((await grant(cookie)).status);
    }
    return statuses;
  }

  test("the eleventh grant in a minute from one account is 429", async () => {
    expect(__limits.PRIVATE_GRANT_MAX_REQUESTS).toBe(10);
    const userId = seedUser("limit-one@nemar.test");
    const statuses = await grantsUntil429(userId);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
    const refused = await grant(await appSession(userId));
    expect(refused.headers.get("X-RateLimit-Bucket")).toBe("private-grant-account");
    expect(refused.headers.get("Cache-Control")).toBe("no-store");
  });

  test("two accounts from one address are limited independently", async () => {
    const first = seedUser("limit-a@nemar.test");
    const second = seedUser("limit-b@nemar.test");
    expect((await grantsUntil429(first))[10]).toBe(429);
    // Same address, a different account: its own budget is untouched.
    expect((await grant(await appSession(second))).status).toBe(200);
  });

  test("an anonymous caller spends no account's budget", async () => {
    const userId = seedUser("limit-anon@nemar.test");
    for (let i = 0; i < 20; i++) expect((await grant()).status).toBe(401);
    expect((await grant(await appSession(userId))).status).toBe(200);
  });
});
