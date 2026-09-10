/**
 * Real route tests for the docs admin gate (epic #1336 phase 0, issue #1338).
 *
 * Real engine throughout: bun:sqlite behind `realD1` with every migration
 * applied, real Hono dispatch via `app.request()`, real zod validation, real
 * session issuance via `issueSession()`, real SHA-256 hashing of the one-time
 * code. No mocks.
 *
 * THE TEST THAT MATTERS MOST is "an app cookie is refused by verify". Both
 * scopes live in one `web_sessions` table, so the only thing standing between a
 * dashboard cookie and the gated documentation is the `ws.scope = ?` predicate
 * added to `findSessionByCookieId` in migration 0083's change. That is a
 * privilege crossing rather than a cosmetic mix-up, so it is asserted in both
 * directions.
 *
 * WHAT THIS FILE CANNOT EXERCISE, BY CONSTRUCTION (`.rules/testing.md`: say so
 * when real data cannot falsify a rule). The actual concurrent race that
 * `DOCS_MINT_CONSUME_SQL`'s `EXISTS` gate closes -- two exchanges spending one
 * code simultaneously -- cannot be produced here: bun:sqlite is a single writer
 * with no interleaving hook, so the "second attempt is refused" assertions
 * below prove the statement's own mutual exclusion over sequential calls, not
 * that two simultaneous callers cannot both win.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  DOCS_GRANT_TTL_SECONDS,
  DOCS_SESSION_HEADER,
  DOCS_SESSION_TTL_SECONDS,
} from "../../shared/contract/docs-auth.js";
import { authDocsRoutes } from "../src/routes/auth-docs";
import { authWebRoutes } from "../src/routes/auth-web";
import { hashGrantCode } from "../src/services/docs-auth";
import { type AuthMethod, issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
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
    API_BASE_URL: "http://localhost:8787",
  } as unknown as Bindings;
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authWebRoutes);
  app.route("/auth", authDocsRoutes);
});

// --------------------------------------------------------------------------
// Seeding
// --------------------------------------------------------------------------

function seedUser(email: string, role: "member" | "admin" | "owner" = "admin"): number {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified, account_kind)
     VALUES (?, ?, 'x', 'approved', ?, 'web', 1, 'person')`,
    [email.split("@")[0], email, role],
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

function grantRow(codeHash: string) {
  return db
    .query<
      { code_hash: string; user_id: number; auth_method: string | null; expires_at: string },
      [string]
    >("SELECT code_hash, user_id, auth_method, expires_at FROM docs_grants WHERE code_hash = ?")
    .get(codeHash);
}

function docsSessionCount(userId: number): number {
  const row = db
    .query<{ n: number }, [number]>(
      "SELECT COUNT(*) AS n FROM web_sessions WHERE user_id = ? AND scope = 'docs'",
    )
    .get(userId);
  return row?.n ?? 0;
}

async function grant(cookie: string): Promise<Response> {
  return app.request(
    "/auth/docs/grant",
    { method: "POST", headers: { Cookie: `nemar_session=${cookie}`, Origin: APP } },
    env(),
  );
}

async function exchange(code: string): Promise<Response> {
  return app.request(
    "/auth/docs/exchange",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    },
    env(),
  );
}

async function verify(sessionValue: string): Promise<Response> {
  return app.request(
    "/auth/docs/verify",
    { headers: { [DOCS_SESSION_HEADER]: sessionValue } },
    env(),
  );
}

/** The whole flow, for tests whose subject is what happens afterwards. */
async function signInToDocs(userId: number): Promise<string> {
  const cookie = await appSession(userId);
  const granted = await grant(cookie);
  expect(granted.status).toBe(200);
  const { code } = (await granted.json()) as { code: string };
  const exchanged = await exchange(code);
  expect(exchanged.status).toBe(200);
  const { session } = (await exchanged.json()) as { session: string };
  return session;
}

// --------------------------------------------------------------------------
// POST /auth/docs/grant
// --------------------------------------------------------------------------

describe("POST /auth/docs/grant", () => {
  test("refuses a request with no session", async () => {
    // Origin is present so this isolates the missing session: the Origin check
    // runs first, deliberately, so omitting it here would assert 403 and prove
    // nothing about authentication.
    const res = await app.request(
      "/auth/docs/grant",
      { method: "POST", headers: { Origin: APP } },
      env(),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthenticated");
  });

  test("refuses a request with no Origin header", async () => {
    // A server-side fetch sends no Origin of its own, so the website's authorize
    // page must pin one. Without this check the route would be a cross-site POST
    // that mints a code from someone's ambient cookie.
    const userId = seedUser("admin-noorigin@nemar.test", "admin");
    const cookie = await appSession(userId);
    const res = await app.request(
      "/auth/docs/grant",
      { method: "POST", headers: { Cookie: `nemar_session=${cookie}` } },
      env(),
    );
    expect(res.status).toBe(403);
  });

  test("refuses a foreign Origin", async () => {
    const userId = seedUser("admin-badorigin@nemar.test", "admin");
    const cookie = await appSession(userId);
    const res = await app.request(
      "/auth/docs/grant",
      {
        method: "POST",
        headers: { Cookie: `nemar_session=${cookie}`, Origin: "https://evil.example" },
      },
      env(),
    );
    expect(res.status).toBe(403);
  });

  test("accepts the staging origin, not just production", async () => {
    // The caller pins its own request origin rather than a hardcoded host, so
    // test.nemar.org has to pass the *.nemar.org rule.
    const userId = seedUser("admin-staging@nemar.test", "admin");
    const cookie = await appSession(userId);
    const res = await app.request(
      "/auth/docs/grant",
      {
        method: "POST",
        headers: { Cookie: `nemar_session=${cookie}`, Origin: "https://test.nemar.org" },
      },
      env(),
    );
    expect(res.status).toBe(200);
  });

  test("answers 404, not 403, for a signed-in non-admin", async () => {
    // Mirrors adminGate on the website: someone who does not already know the
    // operations documentation exists must not learn it from a status code.
    const userId = seedUser("member@nemar.test", "member");
    const res = await grant(await appSession(userId));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });

  test("writes no grant row for a non-admin", async () => {
    const userId = seedUser("member2@nemar.test", "member");
    await grant(await appSession(userId));
    const row = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM docs_grants").get();
    expect(row?.n).toBe(0);
  });

  test("mints a code for an admin", async () => {
    const userId = seedUser("admin@nemar.test", "admin");
    const res = await grant(await appSession(userId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; expires_in: number };
    expect(body.expires_in).toBe(DOCS_GRANT_TTL_SECONDS);
    expect(body.code.length).toBeGreaterThan(20);
  });

  test("mints a code for an owner", async () => {
    const userId = seedUser("owner@nemar.test", "owner");
    const res = await grant(await appSession(userId));
    expect(res.status).toBe(200);
  });

  test("stores the code hashed, never in plaintext", async () => {
    const userId = seedUser("admin3@nemar.test", "admin");
    const res = await grant(await appSession(userId));
    const { code } = (await res.json()) as { code: string };
    expect(grantRow(await hashGrantCode(code))).toBeTruthy();
    const plaintext = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM docs_grants WHERE code_hash = ?")
      .get(code);
    expect(plaintext?.n).toBe(0);
  });

  test("carries auth_method across from the app session", async () => {
    // So the docs session records that the identity behind it was proven by
    // ORCID, rather than resetting that history at the host boundary.
    const userId = seedUser("admin4@nemar.test", "admin");
    const res = await grant(await appSession(userId, "orcid"));
    const { code } = (await res.json()) as { code: string };
    expect(grantRow(await hashGrantCode(code))?.auth_method).toBe("orcid");
  });

  test("refuses a revoked app session", async () => {
    const userId = seedUser("admin5@nemar.test", "admin");
    const cookie = await appSession(userId);
    db.run("UPDATE web_sessions SET revoked_at = datetime('now') WHERE user_id = ?", [userId]);
    expect((await grant(cookie)).status).toBe(401);
  });

  test("a docs session cannot mint another grant", async () => {
    // The `ws.scope = 'app'` predicate in DOCS_GRANT_INSERT_SQL: without it one
    // eight-hour docs session could renew itself forever without ever
    // revisiting the app host.
    const userId = seedUser("admin6@nemar.test", "admin");
    const docsSession = await signInToDocs(userId);
    const res = await grant(docsSession);
    expect(res.status).toBe(401);
  });
});

// --------------------------------------------------------------------------
// POST /auth/docs/exchange
// --------------------------------------------------------------------------

describe("POST /auth/docs/exchange", () => {
  test("trades a live code for a docs session", async () => {
    const userId = seedUser("admin7@nemar.test", "admin");
    const granted = await grant(await appSession(userId));
    const { code } = (await granted.json()) as { code: string };

    const res = await exchange(code);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: string; max_age_seconds: number };
    expect(body.max_age_seconds).toBe(DOCS_SESSION_TTL_SECONDS);
    expect(body.session.length).toBeGreaterThan(20);
    expect(docsSessionCount(userId)).toBe(1);
  });

  test("consumes the grant, so the same code cannot be spent twice", async () => {
    const userId = seedUser("admin8@nemar.test", "admin");
    const granted = await grant(await appSession(userId));
    const { code } = (await granted.json()) as { code: string };

    expect((await exchange(code)).status).toBe(200);
    const second = await exchange(code);
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toBe("invalid_grant");
    // And no second session was created by the refused attempt.
    expect(docsSessionCount(userId)).toBe(1);
  });

  test("leaves no grant row behind after a successful exchange", async () => {
    const userId = seedUser("admin9@nemar.test", "admin");
    const granted = await grant(await appSession(userId));
    const { code } = (await granted.json()) as { code: string };
    await exchange(code);
    expect(grantRow(await hashGrantCode(code))).toBeNull();
  });

  test("refuses a code that never existed", async () => {
    const res = await exchange("not-a-real-code-at-all");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  test("refuses an expired grant", async () => {
    const userId = seedUser("admin10@nemar.test", "admin");
    const granted = await grant(await appSession(userId));
    const { code } = (await granted.json()) as { code: string };
    db.run("UPDATE docs_grants SET expires_at = datetime('now', '-1 second') WHERE code_hash = ?", [
      await hashGrantCode(code),
    ]);
    expect((await exchange(code)).status).toBe(400);
    expect(docsSessionCount(userId)).toBe(0);
  });

  test("refuses when the account was demoted after the grant", async () => {
    // Every gate is re-checked by the statement that mints, because state can
    // change between the two halves of a handoff.
    const userId = seedUser("admin11@nemar.test", "admin");
    const granted = await grant(await appSession(userId));
    const { code } = (await granted.json()) as { code: string };
    db.run("UPDATE users SET role = 'member' WHERE id = ?", [userId]);
    expect((await exchange(code)).status).toBe(400);
    expect(docsSessionCount(userId)).toBe(0);
  });

  test("refuses when the account was revoked after the grant", async () => {
    const userId = seedUser("admin12@nemar.test", "admin");
    const granted = await grant(await appSession(userId));
    const { code } = (await granted.json()) as { code: string };
    db.run("UPDATE users SET status = 'revoked' WHERE id = ?", [userId]);
    expect((await exchange(code)).status).toBe(400);
    expect(docsSessionCount(userId)).toBe(0);
  });

  test("the minted session is scoped docs and is not a remember-me session", async () => {
    const userId = seedUser("admin13@nemar.test", "admin");
    await signInToDocs(userId);
    const row = db
      .query<{ scope: string; remember: number; auth_method: string | null }, [number]>(
        "SELECT scope, remember, auth_method FROM web_sessions WHERE user_id = ? AND scope = 'docs'",
      )
      .get(userId);
    expect(row?.scope).toBe("docs");
    expect(row?.remember).toBe(0);
    expect(row?.auth_method).toBe("orcid");
  });
});

// --------------------------------------------------------------------------
// GET /auth/docs/verify
// --------------------------------------------------------------------------

describe("GET /auth/docs/verify", () => {
  test("refuses a request with no session header", async () => {
    const res = await app.request("/auth/docs/verify", {}, env());
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_session");
  });

  test("accepts a live docs session and reports the role", async () => {
    const userId = seedUser("admin14@nemar.test", "admin");
    const session = await signInToDocs(userId);
    const res = await verify(session);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; role: string; username: string | null };
    expect(body.ok).toBe(true);
    expect(body.role).toBe("admin");
    expect(body.username).toBe("admin14");
  });

  test("REFUSES AN APP SESSION COOKIE presented as a docs session", async () => {
    // The privilege crossing this gate would otherwise open: both scopes live
    // in one table, so without the scope predicate any dashboard cookie would
    // read the gated documentation.
    const userId = seedUser("admin15@nemar.test", "admin");
    const cookie = await appSession(userId);
    const res = await verify(cookie);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_session");
  });

  test("refuses an unknown session value", async () => {
    expect((await verify("nonsense-value")).status).toBe(401);
  });

  test("refuses once the docs session is revoked", async () => {
    const userId = seedUser("admin16@nemar.test", "admin");
    const session = await signInToDocs(userId);
    db.run("UPDATE web_sessions SET revoked_at = datetime('now') WHERE scope = 'docs'");
    expect((await verify(session)).status).toBe(401);
  });

  test("refuses once the docs session has expired", async () => {
    const userId = seedUser("admin17@nemar.test", "admin");
    const session = await signInToDocs(userId);
    db.run(
      "UPDATE web_sessions SET expires_at = datetime('now', '-1 second') WHERE scope = 'docs'",
    );
    expect((await verify(session)).status).toBe(401);
  });

  test("answers 403 when the account is demoted while holding a docs session", async () => {
    // Re-read on every call, so revoking an admin takes effect on the next page
    // view rather than eight hours later.
    const userId = seedUser("admin18@nemar.test", "admin");
    const session = await signInToDocs(userId);
    db.run("UPDATE users SET role = 'member' WHERE id = ?", [userId]);
    const res = await verify(session);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("not_authorized");
  });

  test("refuses when the account itself is revoked", async () => {
    const userId = seedUser("admin19@nemar.test", "admin");
    const session = await signInToDocs(userId);
    db.run("UPDATE users SET status = 'revoked' WHERE id = ?", [userId]);
    expect((await verify(session)).status).toBe(401);
  });
});

// --------------------------------------------------------------------------
// Cascade from the app's own sign-out
// --------------------------------------------------------------------------

describe("logout cascades to docs sessions", () => {
  test("signing out of the app revokes the docs session too", async () => {
    const userId = seedUser("admin20@nemar.test", "admin");
    const appCookie = await appSession(userId);
    const granted = await grant(appCookie);
    const { code } = (await granted.json()) as { code: string };
    const { session } = (await (await exchange(code)).json()) as { session: string };
    expect((await verify(session)).status).toBe(200);

    const out = await app.request(
      "/auth/logout",
      { method: "POST", headers: { Cookie: `nemar_session=${appCookie}`, Origin: APP } },
      env(),
    );
    expect(out.status).toBe(200);

    // Without the cascade this stays 200 for the rest of the eight hours.
    expect((await verify(session)).status).toBe(401);
  });

  test("one account's sign-out leaves another's docs session alone", async () => {
    const first = seedUser("admin21@nemar.test", "admin");
    const second = seedUser("admin22@nemar.test", "admin");
    const firstDocs = await signInToDocs(first);
    const secondDocs = await signInToDocs(second);

    const secondApp = await appSession(second);
    await app.request(
      "/auth/logout",
      { method: "POST", headers: { Cookie: `nemar_session=${secondApp}`, Origin: APP } },
      env(),
    );

    expect((await verify(secondDocs)).status).toBe(401);
    expect((await verify(firstDocs)).status).toBe(200);
  });
});
