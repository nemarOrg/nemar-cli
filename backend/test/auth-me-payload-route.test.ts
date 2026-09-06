/**
 * The shape `GET /auth/me` hands the web dashboard (nemarOrg/website#306).
 *
 * The website's middleware parses this on every navigation, and three fields
 * were missing from it: `username` (so the dashboard fetched it from
 * `/users/me` on the side, purely because it was absent here) and the two
 * DATES behind the upload-access states, `service_access_granted_at` and
 * `upload_access_requested_at` -- without which the page can say "granted" and
 * "requested" but not when.
 *
 * Validated against `webUserSchema` from shared/contract rather than
 * field-by-field, so the contract and the route cannot drift: a field dropped
 * from the SELECT fails here, and a field added to the schema without a
 * backing column fails too.
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, real
 * Hono dispatch through webSessionMiddleware, real session issuance. Same
 * shape is echoed by /auth/code/verify, PATCH /auth/profile and
 * /auth/email/verify (all four call `publicUser`), and the PATCH path is
 * asserted below so the echo is covered too.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { authMeResponseSchema, webUserSchema } from "../../shared/contract/user.js";
import { authWebRoutes } from "../src/routes/auth-web";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ORIGIN = "https://nemar.org";
const ENCRYPTION_KEY = "auth-me-payload-test-encryption-key-012345";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    ENCRYPTION_KEY,
    WEB_SESSION_COOKIE_DOMAIN: "",
  } as unknown as Bindings;
}

interface SeedOptions {
  username?: string | null;
  serviceAccess?: 0 | 1;
  grantedAt?: string | null;
  requestedAt?: string | null;
  status?: string;
}

function seedUser(options: SeedOptions = {}): number {
  const row = {
    username: null,
    serviceAccess: 0 as 0 | 1,
    grantedAt: null,
    requestedAt: null,
    status: "verified",
    ...options,
  };
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name, orcid, orcid_verified, signup_source,
                        github_username, city, country, affiliation,
                        service_access, service_access_granted_at, upload_access_requested_at)
     VALUES (?, 'webuser@example.org', 'x', ?, 'member', 1, 'Ada', 'Lovelace',
             '0000-0002-1825-0097', 1, 'web', 'adalovelace', 'San Diego', 'USA', 'SCCN',
             ?, ?, ?)`,
  ).run(row.username, row.status, row.serviceAccess, row.grantedAt, row.requestedAt);
  const u = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE email = 'webuser@example.org'")
    .get();
  if (!u) throw new Error("seed failed");
  return u.id;
}

async function cookieFor(userId: number): Promise<string> {
  const { cookieIdRaw } = await issueSession(env(), userId, false, null, null, "orcid");
  return `nemar_session=${cookieIdRaw}`;
}

async function authMe(userId: number): Promise<Response> {
  return app.request("/auth/me", { headers: { Cookie: await cookieFor(userId) } }, env());
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authWebRoutes);
});

describe("GET /auth/me", () => {
  test("matches the published contract", async () => {
    const id = seedUser({ username: "alovelace" });

    const body = await (await authMe(id)).json();
    const parsed = authMeResponseSchema.safeParse(body);
    // Named so a failure says WHICH field, rather than "expected true".
    expect(parsed.success ? [] : parsed.error.issues.map((i) => i.path.join("."))).toEqual([]);
  });

  test("carries the username, so the dashboard need not fetch it separately", async () => {
    const id = seedUser({ username: "alovelace" });

    expect((await (await authMe(id)).json()).user.username).toBe("alovelace");
  });

  test("a web/ORCID row with no username reports null, not an empty string", async () => {
    // The 19 production rows. `null` is "not set"; "" would render as a blank
    // username rather than as the onboarding prompt the dashboard owes them.
    const id = seedUser({ username: null });

    expect((await (await authMe(id)).json()).user.username).toBeNull();
  });

  test("carries both upload-access dates", async () => {
    const id = seedUser({
      username: "alovelace",
      serviceAccess: 1,
      status: "approved",
      grantedAt: "2026-09-02T09:00:00Z",
      requestedAt: "2026-09-01T09:00:00Z",
    });

    const user = (await (await authMe(id)).json()).user;
    expect(user.service_access).toBe(true);
    expect(user.service_access_granted_at).toBe("2026-09-02T09:00:00Z");
    expect(user.upload_access_requested_at).toBe("2026-09-01T09:00:00Z");
  });

  test("an account that never asked reports both dates as null", async () => {
    const id = seedUser({ username: "alovelace" });

    const user = (await (await authMe(id)).json()).user;
    expect(user.service_access_granted_at).toBeNull();
    expect(user.upload_access_requested_at).toBeNull();
  });

  test("does NOT carry the admin-notification stamp", async () => {
    // Whether an admin's copy of the request email landed drives the
    // requester's retry and the admin queue; it is not profile content, and
    // putting it here would invite the dashboard to render it.
    const id = seedUser({ username: "alovelace", requestedAt: "2026-09-01T09:00:00Z" });
    db.query(
      "UPDATE users SET upload_access_notified_at = '2026-09-01T09:05:00Z' WHERE id = ?",
    ).run(id);

    expect((await (await authMe(id)).json()).user).not.toHaveProperty("upload_access_notified_at");
  });

  test("an anonymous browser still gets { user: null }", async () => {
    const res = await app.request("/auth/me", {}, env());
    expect(authMeResponseSchema.parse(await res.json()).user).toBeNull();
  });

  test("PATCH /auth/profile echoes the same shape", async () => {
    // Four routes build this payload from one `publicUser`; a field added to
    // the /auth/me SELECT alone would make them disagree.
    const id = seedUser({ username: null });

    const res = await app.request(
      "/auth/profile",
      {
        method: "PATCH",
        headers: {
          Origin: ORIGIN,
          Cookie: await cookieFor(id),
          "content-type": "application/json",
        },
        body: JSON.stringify({ username: "alovelace" }),
      },
      env(),
    );
    const user = (await res.json()).user;
    const parsed = webUserSchema.safeParse(user);
    expect(parsed.success ? [] : parsed.error.issues.map((i) => i.path.join("."))).toEqual([]);
    // The VALUES too, not just the shape: this response is built by a
    // different query (fetchPublicUserById) from the one /auth/me uses, and a
    // schema check alone passes just as happily on a column that came back
    // NULL because it was dropped from that SELECT.
    expect(user.username).toBe("alovelace");
    expect(user.email).toBe("webuser@example.org");
  });

  test("the PATCH echo reports the upload-access dates too", async () => {
    const id = seedUser({
      username: "alovelace",
      serviceAccess: 1,
      status: "approved",
      grantedAt: "2026-09-02T09:00:00Z",
      requestedAt: "2026-09-01T09:00:00Z",
    });

    const res = await app.request(
      "/auth/profile",
      {
        method: "PATCH",
        headers: {
          Origin: ORIGIN,
          Cookie: await cookieFor(id),
          "content-type": "application/json",
        },
        body: JSON.stringify({ city: "Boston" }),
      },
      env(),
    );
    const user = (await res.json()).user;
    expect(user.service_access_granted_at).toBe("2026-09-02T09:00:00Z");
    expect(user.upload_access_requested_at).toBe("2026-09-01T09:00:00Z");
  });
});
