/**
 * `profile_gaps` on both user payloads, and its equality with the
 * upload-access refusal (#1268, ADR 0045).
 *
 * The property this file exists to hold: for ONE account row, the list
 * `GET /users/me` reports, the list `GET /auth/me` reports, and the `missing`
 * array `POST /users/me/upload-access/request` refuses with are the same
 * fields in the same order. Before phase 8 they were three implementations of
 * one rule; they are now one function called three times, and the way to notice
 * that changing is to ask all three about the same row and compare.
 *
 * Real engine throughout: bun:sqlite behind realD1 with every migration
 * applied, real Hono dispatch through `authMiddleware` and
 * `webSessionMiddleware`, real hashed API keys, real session issuance. The one
 * external boundary the request path touches is GitHub's `/users/:login`,
 * served by a local `Bun.serve()` through the `NEMAR_GITHUB_API_URL` override —
 * and only the tests that get PAST the profile check reach it. No mocks.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { computeProfileGaps } from "../../shared/contract/profile-gaps.js";
import { userMeResponseSchema, webUserSchema } from "../../shared/contract/user.js";
import { authWebRoutes } from "../src/routes/auth-web";
import { userRoutes } from "../src/routes/users";
import { hashApiKey } from "../src/services/token";
import { checkUploadAccessRequest } from "../src/services/upload-access";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const USER_KEY = "gaps-user-key-0123456789abcdef0123456789abcd";
const ENCRYPTION_KEY = "profile-gaps-test-encryption-key-0123456789";
const USER_EMAIL = "gaps@nemar.test";
const ORIGIN = "https://nemar.org";
const WHY = "Depositing our lab's 64-channel EEG study of motor imagery, 40 participants.";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let githubServer: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  githubServer = Bun.serve({
    port: 0,
    // Every handle resolves: this suite is about the PROFILE half of the
    // refusal, which is answered before the lookup is ever spent.
    fetch: (req) =>
      new Response(
        JSON.stringify({ login: new URL(req.url).pathname.split("/").pop(), id: 4242 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://localhost:${githubServer.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  githubServer.stop(true);
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    ENCRYPTION_KEY,
    WEB_SESSION_COOKIE_DOMAIN: "",
    GITHUB_ADMIN_PAT: "test-pat-never-used-against-a-real-host",
  } as unknown as Bindings;
}

interface Overrides {
  username?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  github_username?: string | null;
  city?: string | null;
  country?: string | null;
  email_verified?: number;
  orcid_verified?: number;
  status?: string;
  username_auto_assigned?: number;
}

/** A complete account by default; each test blanks the columns it is about. */
async function seedUser(overrides: Overrides = {}): Promise<number> {
  const row = {
    username: "arivers",
    given_name: "Ada",
    family_name: "Rivers",
    github_username: "adarivers",
    city: "San Diego",
    country: "USA",
    email_verified: 1,
    orcid_verified: 1,
    status: "verified",
    username_auto_assigned: 0,
    ...overrides,
  };
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name, github_username, city, country, affiliation,
                        orcid, orcid_verified, signup_source, service_access,
                        username_auto_assigned)
     VALUES (?, ?, 'x', ?, 'member', ?, ?, ?, ?, ?, ?, 'Swartz Center',
             '0000-0002-1825-0097', ?, 'web', 0, ?)`,
  ).run(
    row.username,
    USER_EMAIL,
    row.status,
    row.email_verified,
    row.given_name,
    row.family_name,
    row.github_username,
    row.city,
    row.country,
    row.orcid_verified,
    row.username_auto_assigned,
  );
  const u = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?")
    .get(USER_EMAIL);
  if (!u) throw new Error("seed failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(USER_KEY),
    USER_KEY.slice(0, 8),
  );
  return u.id;
}

function usersMe(): Promise<Response> {
  return app.request("/users/me", { headers: { Authorization: `Bearer ${USER_KEY}` } }, env());
}

async function authMe(userId: number): Promise<Response> {
  const { cookieIdRaw } = await issueSession(env(), userId, false, null, null, "orcid");
  return app.request("/auth/me", { headers: { Cookie: `nemar_session=${cookieIdRaw}` } }, env());
}

function requestUploadAccess(): Promise<Response> {
  return app.request(
    "/users/me/upload-access/request",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${USER_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ why: WHY }),
    },
    env(),
  );
}

/** The three answers about one row, as bare field-name lists. */
async function allThree(userId: number): Promise<{
  usersMe: string[];
  authMe: string[];
  missing: string[];
}> {
  const cli = userMeResponseSchema.parse(await (await usersMe()).json());
  const web = webUserSchema.parse((await (await authMe(userId)).json()).user);
  const refusal = await (await requestUploadAccess()).json();
  return {
    usersMe: (cli.user.profile_gaps ?? []).map((g) => g.field),
    authMe: web.profile_gaps.map((g) => g.field),
    missing: refusal.missing ?? [],
  };
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/users", userRoutes);
  app.route("/auth", authWebRoutes);
});

describe("GET /users/me carries profile_gaps", () => {
  test("an incomplete account lists exactly what it is missing, in matrix order", async () => {
    await seedUser({ username: null, city: null, github_username: null });
    const body = userMeResponseSchema.parse(await (await usersMe()).json());
    expect(body.user.profile_gaps?.map((g) => g.field)).toEqual([
      "username",
      "github_username",
      "city",
    ]);
  });

  test("each entry carries blocks and set_on, not just a field name", async () => {
    await seedUser({ city: null });
    const body = userMeResponseSchema.parse(await (await usersMe()).json());
    expect(body.user.profile_gaps).toEqual([
      { field: "city", blocks: ["upload_access"], set_on: ["web", "cli"] },
    ]);
  });

  test("a complete account gets an EMPTY list, which is not the same as none", async () => {
    await seedUser();
    const body = userMeResponseSchema.parse(await (await usersMe()).json());
    // The CLI prints "nothing outstanding" for [] and "not checked" for absent.
    expect(body.user.profile_gaps).toEqual([]);
  });

  test("a pending account cannot reach this endpoint at all", async () => {
    // Not a gap-reporting decision: `authMiddleware` refuses an inactive
    // account before the route runs, which is why the `email_verified` gap is
    // only ever OBSERVED on /auth/me (cookie sessions admit `pending`). Pinned
    // so a later widening of that gate is a deliberate change rather than a
    // surprise about which payload can carry which gap.
    await seedUser({ status: "pending", email_verified: 0 });
    expect((await usersMe()).status).toBe(403);
  });

  test("a verified ORCID iD makes the name halves web-only", async () => {
    await seedUser({ given_name: null, orcid_verified: 1 });
    const body = userMeResponseSchema.parse(await (await usersMe()).json());
    expect(body.user.profile_gaps).toEqual([
      { field: "given_name", blocks: ["upload_access", "publication"], set_on: ["web"] },
    ]);
  });

  test("username_auto_assigned is reported, both ways round", async () => {
    await seedUser({ username_auto_assigned: 1 });
    const on = userMeResponseSchema.parse(await (await usersMe()).json());
    expect(on.user.username_auto_assigned).toBe(true);

    db = freshDb();
    await seedUser({ username_auto_assigned: 0 });
    const off = userMeResponseSchema.parse(await (await usersMe()).json());
    expect(off.user.username_auto_assigned).toBe(false);
  });
});

describe("GET /auth/me carries the same two fields", () => {
  test("the dashboard payload validates and lists the same gaps", async () => {
    const id = await seedUser({ country: null, family_name: null });
    const parsed = webUserSchema.safeParse((await (await authMe(id)).json()).user);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.profile_gaps.map((g) => g.field)).toEqual(["family_name", "country"]);
    expect(parsed.data.username_auto_assigned).toBe(false);
  });

  test("the two-state dashboard `status` does not change what the gaps say", async () => {
    // publicUser maps `verified` -> "active" for the dashboard; the gap rules
    // read the INTERNAL status, where "pending" is the unverified tier.
    const id = await seedUser({ status: "pending", email_verified: 0 });
    const user = webUserSchema.parse((await (await authMe(id)).json()).user);
    expect(user.status).toBe("pending");
    expect(user.profile_gaps.map((g) => g.field)).toEqual(["email_verified"]);
  });
});

describe("one row, three answers", () => {
  test("the refusal's `missing` is exactly the profile gaps, same order", async () => {
    const id = await seedUser({ username: null, city: null, country: null });
    const answers = await allThree(id);
    expect(answers.missing).toEqual(["username", "city", "country"]);
    expect(answers.usersMe).toEqual(answers.missing);
    expect(answers.authMe).toEqual(answers.missing);
  });

  test("holds for a row missing every profile field at once", async () => {
    const id = await seedUser({
      username: null,
      given_name: null,
      family_name: null,
      github_username: null,
      city: null,
      country: null,
    });
    const answers = await allThree(id);
    expect(answers.missing).toEqual([
      "username",
      "given_name",
      "family_name",
      "github_username",
      "city",
      "country",
    ]);
    expect(answers.usersMe).toEqual(answers.missing);
    expect(answers.authMe).toEqual(answers.missing);
  });

  test("an unverified inbox is answered first, and alone", async () => {
    // `email_not_verified` has its own code and its own endpoint and comes
    // ahead of the profile check -- but it is the same first gap the payloads
    // report, not a fourth vocabulary. Asserted on the PURE precondition
    // because `authMiddleware` refuses a `pending` account before the route
    // (see above), so this state is unreachable through the endpoint.
    const id = await seedUser({ status: "pending", email_verified: 0, city: null });
    const refusal = checkUploadAccessRequest(
      {
        email_verified: 0,
        username: "arivers",
        given_name: "Ada",
        family_name: "Rivers",
        github_username: "adarivers",
        city: null,
        country: "USA",
      },
      WHY,
    );
    expect(refusal?.error).toBe("email_not_verified");
    expect(refusal?.missing).toEqual(["email_verified"]);
    const web = webUserSchema.parse((await (await authMe(id)).json()).user);
    expect(web.profile_gaps.map((g) => g.field)).toEqual(["email_verified", "city"]);
  });

  test("a complete row is refused for nothing and reports nothing", async () => {
    const id = await seedUser();
    const answers = await allThree(id);
    expect(answers.missing).toEqual([]);
    expect(answers.usersMe).toEqual([]);
    expect(answers.authMe).toEqual([]);
  });

  test("the pure function and the live route agree on the same row", async () => {
    // Belt and braces on the refactor: the SELECT feeding the route could drop
    // a column and still return a plausible list. This computes the answer
    // straight from the row and compares.
    await seedUser({ github_username: null, country: null });
    const row = db
      .query<
        {
          status: string;
          email_verified: number;
          orcid_verified: number;
          username: string | null;
          given_name: string | null;
          family_name: string | null;
          github_username: string | null;
          city: string | null;
          country: string | null;
        },
        [string]
      >(
        `SELECT status, email_verified, orcid_verified, username, given_name, family_name,
                github_username, city, country FROM users WHERE email = ?`,
      )
      .get(USER_EMAIL);
    if (!row) throw new Error("row vanished");
    const expected = computeProfileGaps({
      status: row.status,
      email_verified: row.email_verified === 1,
      orcid_verified: row.orcid_verified === 1,
      username: row.username,
      given_name: row.given_name,
      family_name: row.family_name,
      github_username: row.github_username,
      city: row.city,
      country: row.country,
    });
    const body = userMeResponseSchema.parse(await (await usersMe()).json());
    expect(body.user.profile_gaps).toEqual(expected);
  });
});
