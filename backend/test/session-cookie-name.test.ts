/**
 * The app session cookie's name (epic #2014 phase #2015, ADR 0119 decision 10).
 *
 * `nemar_session` is host-scoped to `app.nemar.org` by a `Domain` attribute, and nothing stops
 * another `nemar.org` subdomain from planting a cookie of the same name for the whole zone. A
 * `__Host-` cookie cannot carry a `Domain` and the browser refuses to let any other host set it,
 * so the session moves to `__Host-nemar_session`. The move is a window, not a switch: the writer
 * is behind `HOST_PREFIXED_SESSION_COOKIE` and the readers accept both names, so a session minted
 * before the flag is still a session after it.
 *
 * Everything here goes through the real routes and the real middleware over a real database. Names
 * and attribute strings are literals on purpose: a test that imported the constants would agree
 * with whatever they said.
 *
 *   WRITERS (five): `POST /auth/code/verify`, `POST /auth/logout`, the `GET /auth/me` slide,
 *   `GET /auth/orcid/callback` and `POST /auth/orcid/finalize`. With the flag off each sends
 *   today's header byte for byte; with it on each sends the new name with no `Domain`, then the
 *   legacy clears.
 *
 *   READERS (two): `webSessionMiddleware` (`/auth/me`) and `resolveCookieUser` inside
 *   `authMiddleware` (`/users/me`). Both take the new name first, fall back to the legacy one only
 *   when the new one is ABSENT, and never rescue an invalid new cookie with a valid legacy one.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { Hono } from "hono";
import { authOrcidRoutes } from "../src/routes/auth-orcid";
import { authWebRoutes } from "../src/routes/auth-web";
import { userRoutes } from "../src/routes/users";
import { hashAuthCode } from "../src/services/auth-code";
import { PENDING_COOKIE_NAME, encodeState, signPending } from "../src/services/orcid-auth";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const APP = "https://app.nemar.org";
const ENCRYPTION_KEY = "session-cookie-test-encryption-key-0123456";
const CSRF = "csrf-session-cookie";
const SIGN_IN_EMAIL = "cookie-signin@nemar.test";
const SIGNUP_EMAIL = "cookie-signup@nemar.test";
const LINKED_ORCID = "0000-0001-5109-353X";
const NEW_ORCID = "0000-0002-1825-0097";
const PROD_DOMAIN = "app.nemar.org";

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
        return Response.json({ orcid: LINKED_ORCID, name: "Ada Lovelace", access_token: "x" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  // ORCID's public record API, read behind the response by the name refresh. Served locally so
  // nothing leaves the machine.
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

interface Mode {
  /** The value of `HOST_PREFIXED_SESSION_COOKIE`; `undefined` leaves it unset. */
  flag: string | undefined;
  /** The value of `WEB_SESSION_COOKIE_DOMAIN`. */
  domain: string;
}

function env(mode: Mode): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    ENCRYPTION_KEY,
    WEB_SESSION_COOKIE_DOMAIN: mode.domain,
    HOST_PREFIXED_SESSION_COOKIE: mode.flag,
    ORCID_CLIENT_ID: "APP-TEST",
    ORCID_CLIENT_SECRET: "test-secret",
    ORCID_API_BASE: `http://localhost:${orcidToken.port}`,
    APP_BASE_URL: APP,
  } as unknown as Bindings;
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authWebRoutes);
  app.route("/auth", authOrcidRoutes);
  app.route("/users", userRoutes);
});

// ---------------------------------------------------------------------------------------------
// The header strings. Written out, not built from the production constants.
// ---------------------------------------------------------------------------------------------

const VALUE = "[A-Za-z0-9_-]{43}";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Today's header, which the flag-off writers must still send byte for byte. */
function legacyIssued(domain: string, maxAge?: number): RegExp {
  const parts = [`nemar_session=${VALUE}`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/"];
  if (domain) parts.push(`Domain=${escapeRe(domain)}`);
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return new RegExp(`^${parts.join("; ")}$`);
}

/** The new name: no `Domain`, ever. */
function hostIssued(maxAge?: number): RegExp {
  const parts = [`__Host-nemar_session=${VALUE}`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/"];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return new RegExp(`^${parts.join("; ")}$`);
}

function legacyCleared(domain: string): string {
  const parts = ["nemar_session=", "HttpOnly", "Secure", "SameSite=Lax", "Path=/"];
  if (domain) parts.push(`Domain=${domain}`);
  parts.push("Max-Age=0");
  return parts.join("; ");
}

const HOST_CLEARED = "__Host-nemar_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

/** The session cookies of one response, in the order they were sent. Other cookies (the ORCID
 *  state and pending cookies) are not the subject of this file. */
function sessionCookies(res: Response): string[] {
  return res.headers
    .getSetCookie()
    .filter((c) => c.startsWith("nemar_session=") || c.startsWith("__Host-nemar_session="));
}

// ---------------------------------------------------------------------------------------------
// The five writers, each as a function of the environment it runs under.
// ---------------------------------------------------------------------------------------------

function seedWebUser(email: string, orcid: string | null = null): number {
  db.run(
    `INSERT INTO users (email, status, signup_source, email_verified, given_name, family_name,
                        orcid, orcid_verified, service_access)
     VALUES (?, 'verified', 'web', 1, 'Ada', 'Lovelace', ?, ?, 0)`,
    [email, orcid, orcid ? 1 : 0],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error(`seed failed for ${email}`);
  return row.id;
}

async function plantCode(mode: Mode, email: string, code: string): Promise<void> {
  db.run(
    `INSERT INTO auth_codes (email, code_hash, expires_at, user_id)
     VALUES (?, ?, datetime('now', '+10 minutes'), NULL)`,
    [email, await hashAuthCode(code, env(mode))],
  );
}

interface Writer {
  name: string;
  /** The `Max-Age` its issued cookie carries, or undefined for a browser-session cookie. */
  maxAge: number | undefined;
  /** True when the response clears the session instead of issuing one. */
  clears: boolean;
  run(mode: Mode): Promise<Response>;
}

const THIRTY_DAYS = 30 * 24 * 60 * 60;

const WRITERS: Writer[] = [
  {
    name: "POST /auth/code/verify",
    maxAge: undefined,
    clears: false,
    async run(mode) {
      seedWebUser(SIGN_IN_EMAIL);
      await plantCode(mode, SIGN_IN_EMAIL, "123456");
      return app.request(
        "/auth/code/verify",
        {
          method: "POST",
          headers: { Origin: APP, "content-type": "application/json" },
          body: JSON.stringify({ email: SIGN_IN_EMAIL, code: "123456", remember: false }),
        },
        env(mode),
      );
    },
  },
  {
    name: "POST /auth/logout",
    maxAge: 0,
    clears: true,
    async run(mode) {
      const id = seedWebUser(SIGN_IN_EMAIL);
      const { cookieIdRaw } = await issueSession(env(mode), id, false, null, null, "orcid");
      return app.request(
        "/auth/logout",
        { method: "POST", headers: { Origin: APP, Cookie: `nemar_session=${cookieIdRaw}` } },
        env(mode),
      );
    },
  },
  {
    name: "GET /auth/me (the expiry slide)",
    maxAge: THIRTY_DAYS,
    clears: false,
    async run(mode) {
      const id = seedWebUser(SIGN_IN_EMAIL);
      const { cookieIdRaw } = await issueSession(env(mode), id, true, null, null, "orcid");
      // A remember-me session in the last week of its life is the one the slide re-issues.
      db.run("UPDATE web_sessions SET expires_at = datetime('now', '+1 day')");
      return app.request(
        "/auth/me",
        { headers: { Cookie: `nemar_session=${cookieIdRaw}` } },
        env(mode),
      );
    },
  },
  {
    name: "GET /auth/orcid/callback (sign-in)",
    maxAge: undefined,
    clears: false,
    async run(mode) {
      const id = seedWebUser(SIGN_IN_EMAIL, LINKED_ORCID);
      db.run(
        "INSERT INTO oauth_identities (user_id, provider, provider_subject, display_name) VALUES (?, 'orcid', ?, 'Ada')",
        [id, LINKED_ORCID],
      );
      return app.request(
        new Request(`${APP}/auth/orcid/callback?state=${CSRF}&code=fake-code`, {
          headers: {
            Cookie: `nemar_oauth_state=${encodeState({ csrf: CSRF, mode: "login", next: "/dashboard" })}`,
          },
        }),
        undefined,
        env(mode),
      );
    },
  },
  {
    name: "POST /auth/orcid/finalize (sign-up)",
    maxAge: undefined,
    clears: false,
    async run(mode) {
      const pending = await signPending(
        { orcid: NEW_ORCID, name: "Ada Lovelace", exp: Date.now() + 60_000 },
        ENCRYPTION_KEY,
      );
      return app.request(
        "/auth/orcid/finalize",
        {
          method: "POST",
          headers: {
            Origin: APP,
            Cookie: `${PENDING_COOKIE_NAME}=${pending}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ email: SIGNUP_EMAIL, city: "Cambridge", country: "GB" }),
        },
        env(mode),
      );
    },
  },
];

describe("the writers, with the flag off", () => {
  // Unset is production today. Every other spelling is also "off": only the exact string "1"
  // turns the new name on, so a flag typed as "true" or "0" cannot move anyone's cookie by mistake.
  const OFF_FLAGS: Array<string | undefined> = [undefined, "", "0", "true", "yes", "1 "];

  for (const writer of WRITERS) {
    for (const flag of OFF_FLAGS) {
      for (const domain of [PROD_DOMAIN, ""]) {
        test(`${writer.name} sends today's header byte for byte (flag ${JSON.stringify(flag)}, Domain ${JSON.stringify(domain)})`, async () => {
          const res = await writer.run({ flag, domain });
          expect(res.status === 200 || res.status === 302).toBe(true);
          const cookies = sessionCookies(res);
          if (writer.clears) {
            expect(cookies).toEqual([legacyCleared(domain)]);
          } else {
            expect(cookies).toHaveLength(1);
            expect(cookies[0]).toMatch(legacyIssued(domain, writer.maxAge));
          }
        });
      }
    }
  }
});

describe("the writers, with the flag on", () => {
  for (const writer of WRITERS) {
    test(`${writer.name} sets the new name with no Domain, then clears the legacy name both ways`, async () => {
      const res = await writer.run({ flag: "1", domain: PROD_DOMAIN });
      expect(res.status === 200 || res.status === 302).toBe(true);
      const cookies = sessionCookies(res);
      if (writer.clears) {
        expect(cookies).toEqual([HOST_CLEARED, legacyCleared(PROD_DOMAIN), legacyCleared("")]);
      } else {
        expect(cookies).toHaveLength(3);
        expect(cookies[0]).toMatch(hostIssued(writer.maxAge));
        expect(cookies[0]).not.toContain("Domain");
        expect(cookies.slice(1)).toEqual([legacyCleared(PROD_DOMAIN), legacyCleared("")]);
      }
    });

    test(`${writer.name} never routes the new name through the configured Domain`, async () => {
      // Another Domain, so a leak of the setting into the new cookie cannot hide behind the
      // value the cases above use.
      const res = await writer.run({ flag: "1", domain: "elsewhere.example" });
      const [first] = sessionCookies(res);
      expect(first.startsWith("__Host-nemar_session=")).toBe(true);
      expect(first).not.toContain("Domain");
      expect(first).not.toContain("elsewhere.example");
    });

    test(`${writer.name} sends a single legacy clear when no Domain is configured`, async () => {
      // Staging keeps `WEB_SESSION_COOKIE_DOMAIN` empty, so the two clears are the same cookie:
      // sending the identical header twice would be noise.
      const res = await writer.run({ flag: "1", domain: "" });
      const cookies = sessionCookies(res);
      if (writer.clears) {
        expect(cookies).toEqual([HOST_CLEARED, legacyCleared("")]);
      } else {
        expect(cookies).toHaveLength(2);
        expect(cookies[0]).toMatch(hostIssued(writer.maxAge));
        expect(cookies[1]).toBe(legacyCleared(""));
      }
    });
  }

  test("a sign-in sets a cookie that signs the same person in on the next request", async () => {
    const mode: Mode = { flag: "1", domain: PROD_DOMAIN };
    const id = seedWebUser(SIGN_IN_EMAIL);
    await plantCode(mode, SIGN_IN_EMAIL, "123456");
    const signIn = await app.request(
      "/auth/code/verify",
      {
        method: "POST",
        headers: { Origin: APP, "content-type": "application/json" },
        body: JSON.stringify({ email: SIGN_IN_EMAIL, code: "123456", remember: false }),
      },
      env(mode),
    );
    const issued = sessionCookies(signIn)[0].split(";")[0];
    expect(issued.startsWith("__Host-nemar_session=")).toBe(true);

    const me = await app.request("/auth/me", { headers: { Cookie: issued } }, env(mode));
    expect(((await me.json()) as { user: { id: number } }).user.id).toBe(id);
  });

  test("the expiry slide upgrades a legacy-only session to the new name, with the same value", async () => {
    const mode: Mode = { flag: "1", domain: PROD_DOMAIN };
    const id = seedWebUser(SIGN_IN_EMAIL);
    const { cookieIdRaw } = await issueSession(env(mode), id, true, null, null, "orcid");
    db.run("UPDATE web_sessions SET expires_at = datetime('now', '+1 day')");
    const res = await app.request(
      "/auth/me",
      { headers: { Cookie: `nemar_session=${cookieIdRaw}` } },
      env(mode),
    );
    const [issued] = sessionCookies(res);
    expect(issued.split(";")[0]).toBe(`__Host-nemar_session=${cookieIdRaw}`);
  });
});

describe("the readers", () => {
  const MODE: Mode = { flag: undefined, domain: "" };

  /** Two live accounts with a session each, so a response says which cookie was honoured. */
  async function twoSessions(): Promise<{
    alice: { id: number; cookie: string };
    bob: { id: number; cookie: string };
  }> {
    const aliceId = seedWebUser("alice@nemar.test");
    const bobId = seedWebUser("bob@nemar.test");
    const a = await issueSession(env(MODE), aliceId, false, null, null, "orcid");
    const b = await issueSession(env(MODE), bobId, false, null, null, "orcid");
    return {
      alice: { id: aliceId, cookie: a.cookieIdRaw },
      bob: { id: bobId, cookie: b.cookieIdRaw },
    };
  }

  /** What each of the two readers makes of one `Cookie` header: the id it signed in, or null. */
  async function whoAmI(cookieHeader: string): Promise<{ web: number | null; api: number | null }> {
    const web = await app.request("/auth/me", { headers: { Cookie: cookieHeader } }, env(MODE));
    const webBody = (await web.json()) as { user: { id: number } | null };
    const api = await app.request("/users/me", { headers: { Cookie: cookieHeader } }, env(MODE));
    const apiBody = api.status === 200 ? ((await api.json()) as { user: { id: number } }) : null;
    return { web: webBody.user?.id ?? null, api: apiBody?.user.id ?? null };
  }

  test("a request carrying only the legacy name is authenticated by both readers", async () => {
    const { alice } = await twoSessions();
    expect(await whoAmI(`nemar_session=${alice.cookie}`)).toEqual({
      web: alice.id,
      api: alice.id,
    });
  });

  test("a request carrying only the new name is authenticated by both readers", async () => {
    const { alice } = await twoSessions();
    expect(await whoAmI(`__Host-nemar_session=${alice.cookie}`)).toEqual({
      web: alice.id,
      api: alice.id,
    });
  });

  test("with both names, the new one wins, in either order on the wire", async () => {
    const { alice, bob } = await twoSessions();
    const expected = { web: alice.id, api: alice.id };
    expect(
      await whoAmI(`__Host-nemar_session=${alice.cookie}; nemar_session=${bob.cookie}`),
    ).toEqual(expected);
    expect(
      await whoAmI(`nemar_session=${bob.cookie}; __Host-nemar_session=${alice.cookie}`),
    ).toEqual(expected);
  });

  test("an invalid new cookie is not rescued by a valid legacy one", async () => {
    // The planted-cookie case the dual read must not reopen: whoever can plant `nemar_session`
    // for the zone cannot make it the session by also being able to spoil the real one, and a
    // browser that holds a real `__Host-` cookie never has it displaced by a legacy one.
    const { alice } = await twoSessions();
    expect(
      await whoAmI(`__Host-nemar_session=not-a-live-session; nemar_session=${alice.cookie}`),
    ).toEqual({ web: null, api: null });
    expect(
      await whoAmI(`nemar_session=${alice.cookie}; __Host-nemar_session=not-a-live-session`),
    ).toEqual({ web: null, api: null });
  });

  test("an empty new cookie is invalid too, and does not fall through to the legacy one", async () => {
    const { alice } = await twoSessions();
    expect(await whoAmI(`__Host-nemar_session=; nemar_session=${alice.cookie}`)).toEqual({
      web: null,
      api: null,
    });
  });

  test("a revoked session behind the new name stays revoked, whatever the legacy cookie holds", async () => {
    const { alice, bob } = await twoSessions();
    db.run("UPDATE web_sessions SET revoked_at = datetime('now') WHERE user_id = ?", [alice.id]);
    expect(
      await whoAmI(`__Host-nemar_session=${alice.cookie}; nemar_session=${bob.cookie}`),
    ).toEqual({
      web: null,
      api: null,
    });
  });
});

describe("the flag in the Worker configuration", () => {
  const config = Bun.TOML.parse(
    readFileSync(join(import.meta.dir, "../wrangler-sccn.toml"), "utf-8"),
  ) as {
    vars?: Record<string, unknown>;
    env?: Record<string, { vars?: Record<string, unknown> }>;
  };

  test("it is on in the dev Worker's vars and nowhere in production's", () => {
    // Production turns it on only after the website reads the new name and the API has
    // released, which is the owner's act and not a line in this file (ADR 0119 decision 10).
    expect(config.env?.dev?.vars?.HOST_PREFIXED_SESSION_COOKIE).toBe("1");
    expect(config.vars).toBeDefined();
    expect(Object.keys(config.vars ?? {})).not.toContain("HOST_PREFIXED_SESSION_COOKIE");
  });

  test("it is the only table that names it", () => {
    const named: string[] = [];
    (function walk(node: unknown, path: string) {
      if (typeof node !== "object" || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        const here = path === "" ? key : `${path}.${key}`;
        if (key === "HOST_PREFIXED_SESSION_COOKIE") named.push(here);
        walk(value, here);
      }
    })(config, "");
    expect(named).toEqual(["env.dev.vars.HOST_PREFIXED_SESSION_COOKIE"]);
  });
});
