/**
 * Username assignment at web sign-in (#1268, ADR 0045).
 *
 * ADR 0042 built the batch path: an admin sweep names the accounts whose
 * `username IS NULL`. It closes the 19 that exist and nothing after them — a
 * web sign-up whose owner abandons onboarding lands right back in that state.
 * Phase 8 adds the lazy path at the three doors a web account comes through,
 * and this file drives all three for real:
 *
 *   POST /auth/code/verify     the emailed-code sign-in (assignment batched
 *                              into the sign-in's own transaction)
 *   POST /auth/orcid/finalize  the ORCID sign-up
 *   GET  /auth/orcid/callback  the ORCID sign-in of an already-linked account
 *
 * The two ORCID paths assign AFTER the response, chained behind the ORCID name
 * refresh they depend on, so those tests wait for the row rather than for the
 * response — a real wait on real async work, not a mock of it.
 *
 * Real engine throughout: bun:sqlite behind realD1 with every migration
 * applied, real Hono dispatch, real session issuance, the production
 * `hashAuthCode`, and local `Bun.serve()` instances standing in for ORCID's
 * token endpoint and public record API. No mocks.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { authOrcidRoutes } from "../src/routes/auth-orcid";
import { authWebRoutes } from "../src/routes/auth-web";
import { hashAuthCode } from "../src/services/auth-code";
import { PENDING_COOKIE_NAME, encodeState, signPending } from "../src/services/orcid-auth";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ORIGIN = "https://nemar.org";
const APP = "https://app.nemar.org";
const ENCRYPTION_KEY = "username-assign-test-encryption-key-012345";
const CSRF = "csrf-username-assign";
/** `@nemar.test` is the synthetic-target suffix the non-production email fence
 *  admits, so nothing here can reach a real inbox (AGENTS.md). */
const EMAIL = "abandoned@nemar.test";
const SIGNUP_EMAIL = "brandnew@nemar.test";
const CALLBACK_ORCID = "0000-0001-5109-353X";
const PENDING_ORCID = "0000-0002-1825-0097";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let orcidToken: Server;
let orcidPub: Server;
let realFetch: typeof fetch;

beforeAll(() => {
  orcidToken = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/oauth/token") {
        return Response.json({ orcid: CALLBACK_ORCID, name: "Ada Lovelace", access_token: "x" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  // ORCID's PUBLIC record API, which `refreshUserName` reads and whose host is
  // derived from a fixed map rather than from ORCID_API_BASE -- so it is
  // redirected by moving fetch's destination, not by an env knob.
  orcidPub = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        name: { "given-names": { value: "Ada" }, "family-name": { value: "Lovelace" } },
      }),
  });
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname.endsWith("orcid.org")) {
      const local = new URL(url.pathname + url.search, `http://127.0.0.1:${orcidPub.port}`);
      return realFetch(new Request(local, req));
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  orcidToken.stop(true);
  orcidPub.stop(true);
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    ENCRYPTION_KEY,
    WEB_SESSION_COOKIE_DOMAIN: "",
    ORCID_CLIENT_ID: "APP-TEST",
    ORCID_CLIENT_SECRET: "test-secret",
    ORCID_API_BASE: `http://localhost:${orcidToken.port}`,
    APP_BASE_URL: APP,
  } as unknown as Bindings;
}

/** A web/ORCID-shaped row: `username IS NULL`, which is the state this whole
 *  feature is about. `given`/`family` are what decide whether it can be fixed. */
function seedWebUser(
  email: string,
  { given = "Ada", family = "Lovelace", orcid = null as string | null } = {},
): number {
  db.run(
    `INSERT INTO users (email, status, signup_source, email_verified, given_name, family_name,
                        orcid, orcid_verified, service_access)
     VALUES (?, 'pending', 'web', 0, ?, ?, ?, ?, 0)`,
    [email, given, family, orcid, orcid ? 1 : 0],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error(`seed failed for ${email}`);
  return row.id;
}

/** An unrelated account already holding a username, to force a collision. */
function seedTakenUsername(username: string): void {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES (?, ?, 'x', 'approved', 'member', 1)`,
    [username, `${username}@nemar.test`],
  );
}

async function plantCode(email: string, code: string): Promise<void> {
  db.run(
    `INSERT INTO auth_codes (email, code_hash, expires_at, user_id)
     VALUES (?, ?, datetime('now', '+10 minutes'), NULL)`,
    [email, await hashAuthCode(code, env())],
  );
}

function codeVerify(email: string, code: string): Promise<Response> {
  return app.request(
    "/auth/code/verify",
    {
      method: "POST",
      headers: { Origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email, code, remember: false }),
    },
    env(),
  );
}

function usernameOf(id: number): { username: string | null; auto: number } {
  const row = db
    .query<{ username: string | null; username_auto_assigned: number }, [number]>(
      "SELECT username, username_auto_assigned FROM users WHERE id = ?",
    )
    .get(id);
  if (!row) throw new Error(`no user ${id}`);
  return { username: row.username, auto: row.username_auto_assigned };
}

function auditRows(id: number): { action: string; details: string | null }[] {
  return db
    .query<{ action: string; details: string | null }, [number]>(
      "SELECT action, details FROM audit_log WHERE user_id = ? AND action = 'username_auto_assigned'",
    )
    .all(id);
}

/**
 * Wait for an after-response assignment to land.
 *
 * The two ORCID paths run the name refresh and the assignment behind the
 * response (`afterResponse`), so the row is written a few microtasks later.
 * This polls the real database rather than sleeping a fixed interval, and gives
 * up loudly instead of hanging.
 */
async function waitForUsername(id: number, attempts = 200): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    const { username } = usernameOf(id);
    if (username) return username;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return null;
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authWebRoutes);
  app.route("/auth", authOrcidRoutes);
});

describe("POST /auth/code/verify", () => {
  test("names an abandoned account from its name, in the sign-in itself", async () => {
    const id = seedWebUser(EMAIL);
    await plantCode(EMAIL, "123456");

    const res = await codeVerify(EMAIL, "123456");
    expect(res.status).toBe(200);

    // Written by the time the response is built -- not after it.
    expect(usernameOf(id)).toEqual({ username: "alovelace", auto: 1 });
    // ...and REPORTED, so the dashboard does not have to re-fetch to learn it.
    const body = await res.json();
    expect(body.user.username).toBe("alovelace");
    expect(body.user.username_auto_assigned).toBe(true);
  });

  test("suffixes past a collision rather than failing the sign-in", async () => {
    seedTakenUsername("alovelace");
    const id = seedWebUser(EMAIL);
    await plantCode(EMAIL, "123456");

    const res = await codeVerify(EMAIL, "123456");
    expect(res.status).toBe(200);
    expect(usernameOf(id).username).toBe("alovelace-2");
  });

  test("no family name leaves the column NULL, and signs the user in anyway", async () => {
    // ADR 0042: nothing is invented from the email local part. Onboarding asks.
    const id = seedWebUser(EMAIL, { given: "Prince", family: null as unknown as string });
    await plantCode(EMAIL, "123456");

    const res = await codeVerify(EMAIL, "123456");
    expect(res.status).toBe(200);
    expect(usernameOf(id)).toEqual({ username: null, auto: 0 });
    expect((await res.json()).user.username).toBeNull();
    expect(auditRows(id)).toHaveLength(0);
  });

  test("a name that folds to nothing in ASCII is the same answer", async () => {
    const id = seedWebUser(EMAIL, { given: "美子", family: "山田" });
    await plantCode(EMAIL, "123456");
    expect((await codeVerify(EMAIL, "123456")).status).toBe(200);
    expect(usernameOf(id).username).toBeNull();
  });

  test("an account that already has a username keeps it, and is not re-marked", async () => {
    const id = seedWebUser(EMAIL);
    db.run("UPDATE users SET username = 'chosen' WHERE id = ?", [id]);
    await plantCode(EMAIL, "123456");

    expect((await codeVerify(EMAIL, "123456")).status).toBe(200);
    expect(usernameOf(id)).toEqual({ username: "chosen", auto: 0 });
    expect(auditRows(id)).toHaveLength(0);
  });

  test("the assignment is audited, with the door it came through", async () => {
    const id = seedWebUser(EMAIL);
    await plantCode(EMAIL, "123456");
    await codeVerify(EMAIL, "123456");

    const rows = auditRows(id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details ?? "{}")).toEqual({
      username: "alovelace",
      source: "code_signin",
    });
  });
});

describe("POST /auth/orcid/finalize", () => {
  async function finalize(): Promise<Response> {
    const pending = await signPending(
      { orcid: PENDING_ORCID, name: "Ada Lovelace", exp: Date.now() + 60_000 },
      ENCRYPTION_KEY,
    );
    return app.request(
      "/auth/orcid/finalize",
      {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          Cookie: `${PENDING_COOKIE_NAME}=${pending}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: SIGNUP_EMAIL, city: "Cambridge", country: "GB" }),
      },
      env(),
    );
  }

  test("a brand-new sign-up gets its name from ORCID and then a username", async () => {
    // The INSERT writes no name at all: both come from the public record, which
    // is why the assignment is chained BEHIND the refresh rather than beside it.
    const res = await finalize();
    expect(res.status).toBe(200);
    const id = (await res.json()).user.id as number;

    expect(await waitForUsername(id)).toBe("alovelace");
    expect(usernameOf(id).auto).toBe(1);
    expect(JSON.parse(auditRows(id)[0]?.details ?? "{}")).toEqual({
      username: "alovelace",
      source: "orcid_signup",
    });
  });

  test("a collision is suffixed here too", async () => {
    seedTakenUsername("alovelace");
    const res = await finalize();
    const id = (await res.json()).user.id as number;
    expect(await waitForUsername(id)).toBe("alovelace-2");
  });
});

describe("GET /auth/orcid/callback (sign-in)", () => {
  function callback(): Request {
    return new Request(`${APP}/auth/orcid/callback?state=${CSRF}&code=fake-code`, {
      method: "GET",
      headers: {
        Cookie: `nemar_oauth_state=${encodeState({ csrf: CSRF, mode: "login", next: "/dashboard" })}`,
      },
    });
  }

  test("an already-linked account with no username gets one at sign-in", async () => {
    // Deliberately seeded with NO name: the ORCID record supplies it on the way
    // through, which is the case a sweep-only design never reaches.
    const id = seedWebUser(EMAIL, {
      given: null as unknown as string,
      family: null as unknown as string,
      orcid: CALLBACK_ORCID,
    });
    db.run(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject, display_name) VALUES (?, 'orcid', ?, 'Ada')",
      [id, CALLBACK_ORCID],
    );

    const res = await app.request(callback(), undefined, env());
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${APP}/dashboard`);

    expect(await waitForUsername(id)).toBe("alovelace");
    expect(JSON.parse(auditRows(id)[0]?.details ?? "{}")).toEqual({
      username: "alovelace",
      source: "orcid_signin",
    });
  });
});

describe("PATCH /auth/profile clears the mark", () => {
  async function patch(id: number, body: unknown): Promise<Response> {
    const { cookieIdRaw } = await issueSession(env(), id, false, null, null, "orcid");
    return app.request(
      "/auth/profile",
      {
        method: "PATCH",
        headers: {
          Origin: ORIGIN,
          Cookie: `nemar_session=${cookieIdRaw}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      env(),
    );
  }

  test("changing an auto-assigned username retires the offer", async () => {
    const id = seedWebUser(EMAIL);
    await plantCode(EMAIL, "123456");
    await codeVerify(EMAIL, "123456");
    expect(usernameOf(id).auto).toBe(1);

    const res = await patch(id, { username: "ada" });
    expect(res.status).toBe(200);
    expect(usernameOf(id)).toEqual({ username: "ada", auto: 0 });
    expect((await res.json()).user.username_auto_assigned).toBe(false);
  });

  test("re-saving the SAME username is not a change and keeps the offer", async () => {
    // The Settings form sends every field on every save; a routine save of the
    // city must not silently retire an offer the user has not answered.
    const id = seedWebUser(EMAIL);
    await plantCode(EMAIL, "123456");
    await codeVerify(EMAIL, "123456");

    const res = await patch(id, { username: "alovelace", city: "London" });
    expect(res.status).toBe(200);
    expect(usernameOf(id)).toEqual({ username: "alovelace", auto: 1 });
  });
});
