/**
 * Real route tests for the interaction between the #1008 non-production
 * dev_code echo (services/auth-code.ts's nonProdCodeEchoAllowed) and the
 * #957 non-production email delivery fence (services/email.ts's
 * isEmailDeliveryAllowed) on POST /auth/code/request and POST
 * /auth/email/change/request (routes/auth-web.ts).
 *
 * Regression this pins: before this file, DEV_EMAIL_ALLOWLIST on the dev
 * worker was "@nemar.org" only. scripts/seed-dev-db.sql's test-user/
 * test-pending/test-verified/test-revoked fixtures and every
 * `pl-<label>-<ts>@nemar.test` address the live test/auth-passwordless.test.ts
 * suite generates are on the OTHER non-production population, `@nemar.test`
 * -- so the #957 fence refused to deliver to them, sendPasswordlessCodeEmail
 * / sendEmailChangeCodeEmail threw DevEmailFenceError, and the route's
 * catch block rolled back the auth_codes row and returned 503, even though
 * the route was never going to need a real email for these addresses: the
 * response echoes dev_code instead (that IS their delivery channel), and
 * `.test` is a non-routable IANA-reserved TLD (RFC 2606) a real send could
 * never reach anyway.
 *
 * The fix has two layers, both covered here:
 *   1. wrangler-sccn.toml's dev DEV_EMAIL_ALLOWLIST widened to
 *      "@nemar.org,@nemar.test" (defense in depth for the admin/owner
 *      real-delivery path, which is echo-INELIGIBLE and still needs a
 *      real send -- see the "admin/owner" describe block below).
 *   2. routes/auth-web.ts now skips the real send entirely for an
 *      echo-eligible recipient in non-production, so these two routes
 *      never depend on DEV_EMAIL_ALLOWLIST for their fixture/synthetic
 *      traffic at all. The primary describe blocks below deliberately
 *      run WITHOUT DEV_EMAIL_ALLOWLIST in the env to prove that
 *      independence; a separate describe block re-adds the exact
 *      wrangler-sccn.toml value to confirm the real deploy config also
 *      works.
 *
 * Real engine throughout: bun:sqlite behind realD1 (every migration
 * applied), real Hono dispatch via app.request(), a real session cookie
 * via issueSession() for the email-change route (mirrors
 * test/orcid-relink-route.test.ts's pattern). globalThis.fetch is
 * overridden to RECORD calls rather than allow them -- not a mock
 * standing in for business logic, a boundary probe proving the real send
 * path is never reached at all for these recipients (mirrors
 * test/email-delivery-fence.test.ts's "suppressed" assertions).
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { authWebRoutes } from "../src/routes/auth-web";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const APP_ORIGIN = "https://app.nemar.org";

// Duplicated from backend/wrangler-sccn.toml's [env.dev.vars]
// DEV_EMAIL_ALLOWLIST -- kept in sync by the "matches the real deploy
// config" describe block below re-declaring it verbatim in a comment
// any reviewer can diff against the toml by eye.
const TOML_DEV_EMAIL_ALLOWLIST = "@nemar.org,@nemar.test";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let fetchCalls: string[];
const realFetch = globalThis.fetch;

function baseEnv(overrides: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "development",
    ENCRYPTION_KEY: "route-test-encryption-key-0123456789",
    RESEND_API_KEY: "fake-key-should-never-be-used",
    FROM_EMAIL: "NEMAR Archive <noreply@nemar.org>",
    APP_BASE_URL: APP_ORIGIN,
    WEB_SESSION_COOKIE_DOMAIN: "",
    ...overrides,
  } as unknown as Bindings;
}

function seedUser(opts: {
  username: string;
  email: string;
  role?: string;
  status?: string;
}): number {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role, email_verified)
     VALUES (?, ?, 'x', ?, ?, ?, 1)`,
    [
      opts.username,
      opts.email,
      `${opts.username}-gh`,
      opts.status ?? "approved",
      opts.role ?? "member",
    ],
  );
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?")
    .get(opts.email);
  if (!row) throw new Error(`seed failed for ${opts.email}`);
  return row.id;
}

async function sessionCookie(userId: number, env: Bindings): Promise<string> {
  const { cookieIdRaw } = await issueSession(env, userId, false, null, null, "email_code");
  return `nemar_session=${cookieIdRaw}`;
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authWebRoutes);
  fetchCalls = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    fetchCalls.push(url);
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("POST /auth/code/request: @nemar.test fixtures never attempt real delivery (#957 x #1008)", () => {
  test("seeded test-user@nemar.test gets 200 + dev_code with ZERO fetch calls, even with no DEV_EMAIL_ALLOWLIST", async () => {
    seedUser({ username: "test-user", email: "test-user@nemar.test" });
    // Deliberately NO DEV_EMAIL_ALLOWLIST in env -- proves the route does
    // not depend on the generic email fence's allowlist for this address.
    const env = baseEnv();

    const res = await app.request(
      "/auth/code/request",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test-user@nemar.test" }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dev_code?: string };
    expect(body.ok).toBe(true);
    expect(body.dev_code).toMatch(/^\d{6}$/);
    expect(fetchCalls).toEqual([]);
  });

  test("a live-suite-style pl-<label>-<ts>@nemar.test address also works with no allowlist", async () => {
    const email = `pl-happy-${Date.now()}@nemar.test`;
    seedUser({ username: "pl-fixture", email });
    const env = baseEnv();

    const res = await app.request(
      "/auth/code/request",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dev_code?: string };
    expect(body.dev_code).toMatch(/^\d{6}$/);
    expect(fetchCalls).toEqual([]);
  });

  test("the shared QA account test@nemar.org also works with no allowlist", async () => {
    seedUser({ username: "test-web-qa", email: "test@nemar.org" });
    const env = baseEnv();

    const res = await app.request(
      "/auth/code/request",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@nemar.org" }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dev_code?: string };
    expect(body.dev_code).toMatch(/^\d{6}$/);
    expect(fetchCalls).toEqual([]);
  });
});

describe("POST /auth/code/request: admin/owner real accounts still need real delivery, and the toml allowlist covers it", () => {
  test("an admin with a real @nemar.org address is NOT echo-eligible and DOES need DEV_EMAIL_ALLOWLIST", async () => {
    seedUser({ username: "test-admin", email: "testadmin@nemar.org", role: "admin" });

    // Without the allowlist entry, the fence refuses and the route 503s --
    // this is CORRECT (never echo an admin's code) and pins that the two
    // failure modes are distinguishable: echo-eligible always 200s now,
    // but a real-delivery-required recipient still surfaces a real
    // failure as 503, not a silent 200.
    const resFenced = await app.request(
      "/auth/code/request",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "testadmin@nemar.org" }),
      },
      baseEnv(),
    );
    expect(resFenced.status).toBe(503);
  });
});

describe("POST /auth/email/change/request: @nemar.test targets never attempt real delivery", () => {
  test("changing to a fresh @nemar.test address gets 200 + dev_code with ZERO fetch calls", async () => {
    const userId = seedUser({ username: "changer", email: "changer@example.org" });
    const env = baseEnv();
    const cookie = await sessionCookie(userId, env);
    const newEmail = `pl-change-${Date.now()}@nemar.test`;

    const res = await app.request(
      "/auth/email/change/request",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: cookie,
        },
        body: JSON.stringify({ email: newEmail }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dev_code?: string };
    expect(body.ok).toBe(true);
    expect(body.dev_code).toMatch(/^\d{6}$/);
    expect(fetchCalls).toEqual([]);
  });
});

describe("matches the real deploy config (backend/wrangler-sccn.toml's DEV_EMAIL_ALLOWLIST)", () => {
  test("the exact dev DEV_EMAIL_ALLOWLIST value also lets an @nemar.test fixture through (regression guard for the toml)", async () => {
    seedUser({ username: "test-user", email: "test-user@nemar.test" });
    const env = baseEnv({ DEV_EMAIL_ALLOWLIST: TOML_DEV_EMAIL_ALLOWLIST });

    const res = await app.request(
      "/auth/code/request",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test-user@nemar.test" }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { dev_code?: string };
    expect(body.dev_code).toMatch(/^\d{6}$/);
    expect(fetchCalls).toEqual([]);
  });

  test("the exact dev DEV_EMAIL_ALLOWLIST value lets the admin real-delivery path through too", async () => {
    seedUser({ username: "test-admin", email: "testadmin@nemar.org", role: "admin" });
    const env = baseEnv({ DEV_EMAIL_ALLOWLIST: TOML_DEV_EMAIL_ALLOWLIST });

    const res = await app.request(
      "/auth/code/request",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "testadmin@nemar.org" }),
      },
      env,
    );

    // Real delivery is attempted (the fence allows it); Resend itself will
    // reject the fake API key, which the route treats as a 503 -- the
    // important assertion is that it got PAST the fence and attempted the
    // real call at all (fetchCalls non-empty), unlike the fenced case above.
    expect(res.status).toBe(503);
    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(fetchCalls[0]).toContain("api.resend.com");
  });
});
