/**
 * Real route tests for identity uniqueness (#1254, epic #1250; ADR 0043).
 *
 * One person, one account: an ORCID iD, an email address (case-insensitively)
 * or a GitHub handle backs at most one live account. Migration 0077 enforces
 * it in the database; these tests drive the four APPLICATION entry points that
 * have to refuse before the database has to, plus the unlink that stops an
 * account claiming an iD it can no longer prove.
 *
 * Real engine throughout: bun:sqlite behind realD1 with every migration
 * applied, real Hono dispatch via `app.request()`, real zod validation, real
 * bcrypt at signup, real session issuance via `issueSession()`, real HMAC code
 * hashing via the production `hashAuthCode`, and real pending-cookie signing
 * via `signPending`. The two external boundaries -- ORCID's public record API
 * and GitHub's /users/:login -- are a local `Bun.serve()` reached through the
 * bindings production already uses to point at a mirror. No mocks.
 *
 * ENTRY POINTS, NOT HELPERS. Every case below goes through the HTTP route, so
 * it can catch the thing that actually went wrong in production: a check that
 * existed but looked at the wrong table. `findOrcidHolder` returning the right
 * row proves nothing if finalize never calls it.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { authRoutes } from "../src/routes/auth";
import { authOrcidRoutes } from "../src/routes/auth-orcid";
import { authWebRoutes } from "../src/routes/auth-web";
import { PENDING_COOKIE_NAME, encodeState, signPending } from "../src/services/orcid-auth";
import { hashPassword } from "../src/services/password";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ORIGIN = "https://nemar.org";
const APP = "https://app.nemar.org";
const ENCRYPTION_KEY = "identity-refusal-test-encryption-key-0123";
const CSRF = "csrf-identity-refusal-test";

const HELD_ORCID = "0000-0002-1974-1293";
const OTHER_ORCID = "0000-0002-1825-0097";
/** Valid iD whose check digit is X, used to prove the uppercase rule. */
const X_ORCID = "0000-0001-5109-353X";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
/** Serves ORCID personal-details, ORCID /oauth/token, and GitHub /users/:login. */
let external: Server;
/**
 * GitHub `/users/:login` hits since the last reset.
 *
 * This is what makes the signup PRE-CHECKS falsifiable at all. Migration
 * 0077's partial unique indexes would reject a duplicate email or iD at the
 * INSERT anyway, and signup's catch turns that into the same 409 body -- so a
 * status-and-body assertion alone passes whether or not the pre-check exists.
 * The pre-checks run BEFORE `validateGitHubUsername`, so the observable
 * difference is that a refused signup spends no GitHub API call. That is also
 * why they are ordered that way: a duplicate must not cost a rate-limited
 * request against a shared token.
 */
let githubCalls = 0;
let externalBase: string;
/** Which iD the local ORCID token endpoint hands back for the next callback. */
let tokenOrcid = OTHER_ORCID;

beforeAll(() => {
  external = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/oauth/token") {
        return Response.json({ orcid: tokenOrcid, name: "Ada Lovelace", access_token: "unused" });
      }
      if (url.pathname.endsWith("/personal-details")) {
        return Response.json({
          name: { "given-names": { value: "Ada" }, "family-name": { value: "Lovelace" } },
        });
      }
      const gh = url.pathname.match(/^\/users\/(.+)$/);
      if (gh) {
        githubCalls += 1;
        return Response.json({ login: gh[1], id: 4242 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  externalBase = `http://localhost:${external.port}`;
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = externalBase;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  external.stop(true);
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    ENCRYPTION_KEY,
    ORCID_CLIENT_ID: "APP-TEST",
    ORCID_CLIENT_SECRET: "test-secret",
    ORCID_API_BASE: externalBase,
    ORCID_PUB_API_BASE: externalBase,
    APP_BASE_URL: APP,
    WEB_SESSION_COOKIE_DOMAIN: "",
    GITHUB_ADMIN_PAT: "test-pat-not-used-against-a-real-host",
    API_BASE_URL: "http://localhost:8787",
  } as unknown as Bindings;
}

beforeEach(() => {
  db = freshDb();
  tokenOrcid = OTHER_ORCID;
  githubCalls = 0;
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authRoutes);
  app.route("/auth", authOrcidRoutes);
  app.route("/auth", authWebRoutes);
});

// --------------------------------------------------------------------------
// Seeding
// --------------------------------------------------------------------------

interface SeedOpts {
  orcid?: string | null;
  /** Give the row the oauth_identities row for its iD. */
  identityBacked?: boolean;
  github?: string | null;
  username?: string | null;
  deleted?: boolean;
}

function seedUser(email: string, opts: SeedOpts = {}): number {
  db.run(
    `INSERT INTO users (username, email, status, signup_source, email_verified,
                        orcid, orcid_verified, github_username, deleted_at)
     VALUES (?, ?, 'verified', 'web', 1, ?, ?, ?, ?)`,
    [
      opts.username ?? null,
      email,
      opts.orcid ?? null,
      opts.orcid ? 1 : 0,
      opts.github ?? null,
      opts.deleted ? "2026-01-01 00:00:00" : null,
    ],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error(`seed failed for ${email}`);
  if (opts.identityBacked && opts.orcid) {
    db.run(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', ?)",
      [row.id, opts.orcid],
    );
  }
  return row.id;
}

function userByEmail(email: string) {
  return db
    .query<
      {
        id: number;
        email: string;
        orcid: string | null;
        orcid_verified: number;
        github_username: string | null;
      },
      [string]
    >("SELECT id, email, orcid, orcid_verified, github_username FROM users WHERE email = ?")
    .get(email);
}

async function sessionCookie(userId: number): Promise<string> {
  const { cookieIdRaw } = await issueSession(env(), userId, false, null, null, "orcid");
  return `nemar_session=${cookieIdRaw}`;
}

// --------------------------------------------------------------------------
// CLI signup
// --------------------------------------------------------------------------

function signup(body: Record<string, unknown> = {}): Promise<Response> {
  return app.request(
    "/auth/signup",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "newuser",
        email: "newuser@example.org",
        password: "Correct-Horse-Battery-9",
        github_username: "newuser",
        description: "I would like to deposit EEG datasets collected in our lab.",
        orcid: OTHER_ORCID,
        city: "San Diego",
        country: "USA",
        ...body,
      }),
    },
    env(),
  );
}

describe("CLI signup refuses a duplicate identity", () => {
  test("a case-variant of a live address is refused with the Settings message", async () => {
    seedUser("Ada@Lab.org");
    const res = await signup({ email: "ADA@lab.ORG" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string; message: string };
    expect(body.code).toBe("email_in_use");
    // The `error` string is unchanged (the CLI prints it and pins it), and the
    // actionable sentence rides alongside in `message`.
    expect(body.error).toBe("Email already registered");
    expect(body.message).toContain("nemar.org/settings");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get()?.n).toBe(2);
    // Refused by the pre-check, not by the index at INSERT time: no GitHub
    // call was spent. Without this the assertions above pass either way.
    expect(githubCalls).toBe(0);
  });

  test("an iD held only through users.orcid is refused (the 42/43 hole)", async () => {
    // No oauth_identities row: exactly the shape a CLI signup could never see
    // before #1254, because nothing checked users.orcid at all.
    seedUser("holder@example.org", { orcid: HELD_ORCID });
    const res = await signup({ orcid: HELD_ORCID });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string; message: string };
    expect(body.code).toBe("orcid_in_use");
    expect(body.message).toContain("nemar.org/settings");
    expect(githubCalls).toBe(0);
  });

  test("an iD held only through oauth_identities is refused too", async () => {
    // The mirror image: users.orcid is NULL and the identity row carries it.
    const id = seedUser("linked@example.org");
    db.run(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', ?)",
      [id, HELD_ORCID],
    );
    const res = await signup({ orcid: HELD_ORCID });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("orcid_in_use");
    expect(githubCalls).toBe(0);
  });

  test("a case-variant GitHub handle is refused", async () => {
    seedUser("gh@example.org", { github: "Octocat" });
    const res = await signup({ github_username: "octocat" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("github_in_use");
    expect(body.error).toBe("GitHub account already linked to another user");
  });

  test("a tombstoned row does not block re-signup with its freed address", async () => {
    // The tombstone MASKS the address rather than holding it, so the live-only
    // predicate the email check now uses must not resurrect it as a collision.
    seedUser("deleted+7@deleted.invalid", { deleted: true });
    const res = await signup({ email: "newuser@example.org" });
    expect(res.status).toBe(201);
  });

  test("an iD held by a TOMBSTONED row does not block a new signup", async () => {
    seedUser("deleted+8@deleted.invalid", { orcid: HELD_ORCID, deleted: true });
    const res = await signup({ orcid: HELD_ORCID });
    expect(res.status).toBe(201);
  });
});

describe("CLI signup normalises what it stores", () => {
  test("a mixed-case address is stored lowercase", async () => {
    const res = await signup({ email: "Ada.Lovelace@Example.ORG" });
    expect(res.status).toBe(201);
    expect(userByEmail("ada.lovelace@example.org")).toBeTruthy();
  });

  test("a pasted @handle is accepted and stored without the @", async () => {
    // Before #1254 the regex rejected the leading "@" outright, so a pasted
    // handle failed validation rather than being cleaned up.
    const res = await signup({ github_username: "@octocat" });
    expect(res.status).toBe(201);
    expect(userByEmail("newuser@example.org")?.github_username).toBe("octocat");
  });

  test("a lowercase check digit is accepted and stored uppercase", async () => {
    const res = await signup({ orcid: X_ORCID.toLowerCase() });
    expect(res.status).toBe(201);
    expect(userByEmail("newuser@example.org")?.orcid).toBe(X_ORCID);
  });

  test("a full ORCID URI is reduced to the bare iD", async () => {
    const res = await signup({ orcid: `https://orcid.org/${OTHER_ORCID}` });
    expect(res.status).toBe(201);
    expect(userByEmail("newuser@example.org")?.orcid).toBe(OTHER_ORCID);
  });

  test("a garbage-prefixed iD is rejected, not silently 'normalised'", async () => {
    // `normalizeOrcid` anchors BOTH ends. Anchoring only the tail -- which it
    // did until the #1254 review -- turns `garbage0000-...-0097` into a valid
    // iD and stores it as if the user had typed one, so a fat-fingered paste
    // silently claims somebody else's identifier.
    const res = await signup({ orcid: `garbage${OTHER_ORCID}` });
    expect(res.status).toBe(400);
    expect(userByEmail("newuser@example.org")).toBeNull();
  });
});

describe("an address is found whatever case it was stored or typed in", () => {
  // The regression this pins: signup started lowercasing the stored address,
  // while `retrieve-key` / `resend-verification` / `request-key-regeneration`
  // still looked it up exact-case. Someone who signed up as
  // `John.Smith@gmail.com` and typed it that way got "Invalid email or
  // password" -- a dead end with no way to tell it from a wrong password.
  const MIXED = "John.Smith@Example.ORG";
  const OTHER_CASE = "JOHN.smith@example.org";
  const PASSWORD = "Correct-Horse-Battery-9";

  /**
   * A LEGACY row: stored with its address exactly as typed, the way every row
   * created before #1254 was.
   *
   * This is what makes the NOCASE lookups load-bearing, and it is why these
   * tests do NOT go through signup. Normalising the REQUEST is not enough on
   * its own: once the request is lowercased, an exact-case lookup still
   * matches every row this phase creates, because those are lowercased too.
   * It is the ~600 rows already in the catalog that an exact-case lookup
   * cannot find.
   */
  async function seedLegacy(): Promise<void> {
    db.run(
      `INSERT INTO users (username, email, password_hash, github_username, status,
                          signup_source, email_verified, orcid, orcid_verified,
                          verification_token)
       VALUES ('legacy', ?, ?, 'legacy-gh', 'verified', 'cli', 1, ?, 0, 'seed-token')`,
      [MIXED, await hashPassword(PASSWORD), OTHER_ORCID],
    );
  }

  function storedToken(): string | null {
    return (
      db
        .query<{ verification_token: string | null }, [string]>(
          "SELECT verification_token FROM users WHERE email = ?",
        )
        .get(MIXED)?.verification_token ?? null
    );
  }

  /**
   * Both notification routes answer vaguely on purpose (no account
   * enumeration), so a status code cannot tell found from not-found -- and
   * `resend-verification` sends its email OUTSIDE a try/catch, so the dev
   * delivery fence can turn a successful lookup into a 500. The honest
   * observable is the side effect that happens BEFORE the send: each rotates
   * `verification_token`, and only for a row it actually found.
   */
  async function post(path: string, email = OTHER_CASE): Promise<void> {
    await app
      .request(
        path,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        },
        env(),
      )
      .catch(() => undefined);
  }

  test("signup stores a mixed-case address lowercased", async () => {
    const res = await signup({
      email: MIXED,
      username: "jsmith",
      github_username: "jsmith",
    });
    expect(res.status).toBe(201);
    expect(userByEmail("john.smith@example.org")).toBeTruthy();
  });

  test("retrieve-key finds a legacy mixed-case row typed in another case", async () => {
    await seedLegacy();
    const res = await app.request(
      "/auth/retrieve-key",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: OTHER_CASE, password: PASSWORD }),
      },
      env(),
    );
    // 200 (key minted) or 409 (key already issued) both mean the row was
    // found. 401 is the bug: "Invalid email or password" for a correct
    // password, with no way for the user to tell which half was wrong.
    expect([200, 409]).toContain(res.status);
  });

  test("a wrong password on a found legacy row is still refused", async () => {
    // The guard against a lookup so loose that it stops proving anything.
    await seedLegacy();
    const res = await app.request(
      "/auth/retrieve-key",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: OTHER_CASE, password: "not-the-password" }),
      },
      env(),
    );
    expect(res.status).toBe(401);
  });

  test("resend-verification finds a legacy row typed in another case", async () => {
    await seedLegacy();
    db.run("UPDATE users SET status = 'pending' WHERE email = ?", [MIXED]);
    await post("/auth/resend-verification");
    expect(storedToken()).not.toBe("seed-token");
    expect(storedToken()).toBeTruthy();
  });

  test("key regeneration finds a legacy row typed in another case", async () => {
    await seedLegacy();
    await post("/auth/request-key-regeneration");
    expect(storedToken()).not.toBe("seed-token");
  });

  test("an address matching NO account rotates nothing", async () => {
    // The guard against a rotation assertion that would pass on any input.
    await seedLegacy();
    db.run("UPDATE users SET status = 'pending' WHERE email = ?", [MIXED]);
    await post("/auth/resend-verification", "nobody@example.org");
    expect(storedToken()).toBe("seed-token");
  });
});

// --------------------------------------------------------------------------
// ORCID finalize
// --------------------------------------------------------------------------

async function finalize(orcid: string, body: Record<string, unknown> = {}): Promise<Response> {
  const pending = await signPending(
    { orcid, name: "Ada Lovelace", exp: Date.now() + 60_000 },
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
      body: JSON.stringify({
        email: "brandnew@example.org",
        city: "San Diego",
        country: "USA",
        ...body,
      }),
    },
    env(),
  );
}

describe("ORCID finalize refuses a duplicate identity", () => {
  test("an iD held only through users.orcid is refused as orcid_in_use", async () => {
    // THE production bug: row 42 holds the iD with no identity row, so the
    // identity-table check finalize used to do said "unclaimed" and made a
    // second account for the same person.
    seedUser("holder@example.org", { orcid: HELD_ORCID });
    const res = await finalize(HELD_ORCID);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string; message: string };
    expect(body.error).toBe("orcid_in_use");
    expect(body.code).toBe("orcid_in_use");
    expect(body.message).toContain("nemar.org/settings");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get()?.n).toBe(2);
  });

  test("an iD held through oauth_identities keeps the pre-existing code", async () => {
    // `orcid_already_linked` is what the website already handles; #1254 must
    // not rename it out from under it.
    seedUser("linked@example.org", { orcid: HELD_ORCID, identityBacked: true });
    const res = await finalize(HELD_ORCID);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string; message: string };
    expect(body.error).toBe("orcid_already_linked");
    expect(body.message).toContain("nemar.org/settings");
  });

  test("a case-variant of a live address is refused", async () => {
    seedUser("Ada@Lab.org");
    const res = await finalize(OTHER_ORCID, { email: "ADA@LAB.ORG" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string; message: string };
    expect(body.error).toBe("email_in_use");
    expect(body.message).toContain("nemar.org/settings");
  });

  test("a clean signup lands, with the address trimmed and lowercased", async () => {
    // The iD is already canonical here and cannot be otherwise: `verifyPending`
    // rejects a token whose iD is not in canonical form, so finalize's own
    // `normalizeOrcid` is a belt-and-braces guarantee about what gets STORED,
    // not a repair for user input. The typed-iD path is covered on signup.
    //
    // The address is the interesting half: `"  Brand.New@Example.ORG "` used to
    // 400, because the schema ran `.email()` before its own trim.
    const res = await finalize(X_ORCID, { email: "  Brand.New@Example.ORG " });
    expect(res.status).toBe(200);
    const row = userByEmail("brand.new@example.org");
    expect(row).toBeTruthy();
    expect(row?.orcid).toBe(X_ORCID);
    // The identity row must carry the SAME canonical spelling, or the two
    // halves of "who holds this iD" disagree.
    const ident = db
      .query<{ provider_subject: string }, [number]>(
        "SELECT provider_subject FROM oauth_identities WHERE user_id = ?",
      )
      .get(row?.id as number);
    expect(ident?.provider_subject).toBe(X_ORCID);
  });
});

// --------------------------------------------------------------------------
// Races: the loser of a concurrent claim
// --------------------------------------------------------------------------

/**
 * Make the next INSERT on `users` fail with a REAL SQLite UNIQUE error, using
 * SQLite's own trigger machinery -- the same fault injection
 * web-email-verification.test.ts uses to block writes.
 *
 * Nothing is mocked: the production statement runs against a database that
 * genuinely raises the error, with the exact message text
 * (`UNIQUE constraint failed: users.<col>`) that both engines produce -- the
 * same text real D1 emits, verified with `wrangler d1 execute --local`. That
 * is what makes it a test of the error MAPPING rather than of a string this
 * test invented.
 *
 * A trigger rather than a real second request because the window is between a
 * SELECT and an INSERT inside one handler: there is no way to interleave a
 * second HTTP request into it deterministically.
 */
function raiseUniqueOnUserInsert(column: string): void {
  db.run(
    `CREATE TRIGGER race_on_user_insert BEFORE INSERT ON users
     BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: users.${column}'); END`,
  );
}

describe("finalize maps a lost race to its typed refusal", () => {
  test("a concurrent email claim is 409 email_in_use, not a generic 500", async () => {
    raiseUniqueOnUserInsert("email");
    const res = await finalize(OTHER_ORCID);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string; message: string };
    expect(body.code).toBe("email_in_use");
    expect(body.message).toContain("nemar.org/settings");
  });

  test("a concurrent iD claim is 409 orcid_in_use", async () => {
    raiseUniqueOnUserInsert("orcid");
    const res = await finalize(OTHER_ORCID);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("orcid_in_use");
  });

  test("a UNIQUE hit on some OTHER column is not dressed up as a collision", async () => {
    // `users.email` is a substring of `users.email_verified`, so a substring
    // match would report an unrelated constraint failure as "that address is
    // taken" and send the user to go change an address that is fine.
    raiseUniqueOnUserInsert("email_verified");
    const res = await finalize(OTHER_ORCID);
    expect(res.status).toBe(500);
  });

  test("a non-uniqueness identity-insert failure is a 500, and leaves no orphan", async () => {
    // The users row commits before the identity insert, so it must be removed
    // either way -- an account with an email and no ORCID login is a dead end.
    // What must NOT happen is reporting `orcid_already_linked` for a D1 fault,
    // which sends the user to unlink an iD from an account that does not exist.
    db.run(
      `CREATE TRIGGER race_on_identity_insert BEFORE INSERT ON oauth_identities
       BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`,
    );
    const res = await finalize(OTHER_ORCID);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("Sign-up failed");
    expect(userByEmail("brandnew@example.org")).toBeNull();
  });

  test("a concurrent identity claim IS orcid_already_linked, and leaves no orphan", async () => {
    db.run(
      `CREATE TRIGGER race_on_identity_insert BEFORE INSERT ON oauth_identities
       BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: oauth_identities.provider, oauth_identities.provider_subject'); END`,
    );
    const res = await finalize(OTHER_ORCID);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("orcid_already_linked");
    expect(userByEmail("brandnew@example.org")).toBeNull();
  });
});

// --------------------------------------------------------------------------
// ORCID link / relink, through the callback
// --------------------------------------------------------------------------

function callback(cookie: string, mode: "login" | "link" | "relink"): Promise<Response> {
  return app.request(
    `/auth/orcid/callback?code=authcode&state=${CSRF}`,
    {
      headers: {
        Cookie: `nemar_oauth_state=${encodeState({ csrf: CSRF, mode, next: "/settings" })}; ${cookie}`,
      },
    },
    env(),
  );
}

function redirectError(res: Response): string | null {
  const location = res.headers.get("Location");
  return location ? new URL(location).searchParams.get("error") : null;
}

describe("ORCID link refuses an iD another account holds", () => {
  test("link is refused when the iD sits on another row's users.orcid", async () => {
    // decideLinkOutcome sees no identity row and says `link_new`; the new
    // users.orcid check is the only thing standing between that and two rows
    // claiming one iD.
    seedUser("holder@example.org", { orcid: OTHER_ORCID });
    const mine = seedUser("me@example.org");
    const res = await callback(await sessionCookie(mine), "link");
    expect(res.status).toBe(302);
    expect(redirectError(res)).toBe("orcid_in_use");
    expect(userByEmail("me@example.org")?.orcid).toBeNull();
  });

  test("link is refused with the pre-existing code when another row is identity-backed", async () => {
    seedUser("holder@example.org", { orcid: OTHER_ORCID, identityBacked: true });
    const mine = seedUser("me@example.org");
    const res = await callback(await sessionCookie(mine), "link");
    expect(redirectError(res)).toBe("orcid_linked_other");
  });

  test("relink is refused by the same check, not waved through by the mode", async () => {
    // #913 lets an explicit relink swap an account's own iD. It must not
    // become a way to take an iD off another account.
    seedUser("holder@example.org", { orcid: OTHER_ORCID });
    const mine = seedUser("me@example.org", { orcid: HELD_ORCID, identityBacked: true });
    const res = await callback(await sessionCookie(mine), "relink");
    expect(redirectError(res)).toBe("orcid_in_use");
    expect(userByEmail("me@example.org")?.orcid).toBe(HELD_ORCID);
  });

  test("a link that loses a race redirects to orcid_in_use, not orcid_error", async () => {
    // Both constraints spell the same fact and either can fire first, so the
    // callback has to recognise both. This one is the identity table's.
    const mine = seedUser("me@example.org");
    db.run(
      `CREATE TRIGGER race_on_identity_insert BEFORE INSERT ON oauth_identities
       BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: oauth_identities.provider, oauth_identities.provider_subject'); END`,
    );
    const res = await callback(await sessionCookie(mine), "link");
    expect(redirectError(res)).toBe("orcid_in_use");
  });

  test("a link losing the users.orcid race redirects to orcid_in_use too", async () => {
    const mine = seedUser("me@example.org");
    db.run(
      `CREATE TRIGGER race_on_user_update BEFORE UPDATE OF orcid ON users
       BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: users.orcid'); END`,
    );
    const res = await callback(await sessionCookie(mine), "link");
    expect(redirectError(res)).toBe("orcid_in_use");
  });

  test("an unrelated write failure is still the generic error", async () => {
    // The guard against a catch so wide it labels every failure a collision.
    const mine = seedUser("me@example.org");
    db.run(
      `CREATE TRIGGER race_on_identity_insert BEFORE INSERT ON oauth_identities
       BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`,
    );
    const res = await callback(await sessionCookie(mine), "link");
    expect(redirectError(res)).toBe("orcid_error");
  });

  test("linking an unclaimed iD still works", async () => {
    // The guard against a check that refuses everything.
    const mine = seedUser("me@example.org");
    const res = await callback(await sessionCookie(mine), "link");
    expect(redirectError(res)).toBeNull();
    expect(userByEmail("me@example.org")?.orcid).toBe(OTHER_ORCID);
  });

  test("re-linking the iD this account already holds is not a conflict", async () => {
    const mine = seedUser("me@example.org", { orcid: OTHER_ORCID, identityBacked: true });
    const res = await callback(await sessionCookie(mine), "login");
    expect(redirectError(res)).toBeNull();
    expect(userByEmail("me@example.org")?.orcid).toBe(OTHER_ORCID);
  });
});

// --------------------------------------------------------------------------
// Unlink
// --------------------------------------------------------------------------

describe("ORCID unlink releases the iD", () => {
  test("unlink clears users.orcid as well as orcid_verified", async () => {
    // Keeping users.orcid is what produced row 42: an account claiming an iD
    // it can no longer sign in with, invisible to the identity-table check.
    const id = seedUser("me@example.org", { orcid: HELD_ORCID, identityBacked: true });
    const res = await app.request(
      "/auth/orcid/unlink",
      { method: "POST", headers: { Origin: ORIGIN, Cookie: await sessionCookie(id) } },
      env(),
    );
    expect(res.status).toBe(200);
    const row = userByEmail("me@example.org");
    expect(row?.orcid).toBeNull();
    expect(row?.orcid_verified).toBe(0);
    expect(
      db
        .query<{ n: number }, [number]>(
          "SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ?",
        )
        .get(id)?.n,
    ).toBe(0);
  });

  test("the released iD is then free for another account to claim", async () => {
    // The point of clearing it, stated as behaviour rather than as a column
    // value: before #1254 this signup would have been refused forever by an
    // account that no longer had the link.
    const id = seedUser("me@example.org", { orcid: HELD_ORCID, identityBacked: true });
    await app.request(
      "/auth/orcid/unlink",
      { method: "POST", headers: { Origin: ORIGIN, Cookie: await sessionCookie(id) } },
      env(),
    );
    const res = await signup({ orcid: HELD_ORCID });
    expect(res.status).toBe(201);
  });
});

// --------------------------------------------------------------------------
// Passwordless sign-in against a legacy row
// --------------------------------------------------------------------------

describe("the email-code sign-in finds a legacy mixed-case row", () => {
  // Same regression as the CLI routes, on the flow most of the production
  // population actually uses. `emailFieldSchema` lowercases the REQUEST, so an
  // exact-case lookup misses every row stored as typed -- and /code/request
  // answers those with the masked "if your email is on file" 200 and then
  // sends nothing, which is indistinguishable from a typo and unreportable.
  //
  // `@nemar.test` because that is the suffix the non-production fence admits
  // for the dev_code echo (services/auth-code.ts), which is what lets the
  // whole request -> verify round trip run here without an inbox.
  const LEGACY = "Legacy.User@Nemar.test";
  const LOWERCASE = "legacy.user@nemar.test";

  function seedLegacyWebRow(): number {
    return seedUser(LEGACY, { orcid: OTHER_ORCID });
  }

  async function codeRequest(email: string): Promise<Response> {
    return app.request(
      "/auth/code/request",
      {
        method: "POST",
        headers: { Origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ email }),
      },
      env(),
    );
  }

  test("request issues a real code instead of the silent skip", async () => {
    seedLegacyWebRow();
    const res = await codeRequest(LOWERCASE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dev_code?: string; dev_skip?: string };
    // `dev_skip: "unregistered"` is the exact symptom: the route decided no
    // such account exists and returned the masked 200 having sent nothing.
    expect(body.dev_skip).toBeUndefined();
    expect(body.dev_code).toMatch(/^\d{6}$/);
  });

  test("verify then signs the legacy row in", async () => {
    const id = seedLegacyWebRow();
    const code = ((await (await codeRequest(LOWERCASE)).json()) as { dev_code?: string }).dev_code;
    const res = await app.request(
      "/auth/code/verify",
      {
        method: "POST",
        headers: { Origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ email: LOWERCASE, code, remember: false }),
      },
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: number } };
    expect(body.user.id).toBe(id);
  });

  test("an address matching no account still gets the silent skip", async () => {
    // The guard against a lookup so loose it stops distinguishing anything --
    // and against losing the #595 no-enumeration property while fixing this.
    seedLegacyWebRow();
    const res = await codeRequest("nobody@nemar.test");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dev_code?: string; dev_skip?: string };
    expect(body.dev_skip).toBe("unregistered");
    expect(body.dev_code).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// PATCH /auth/profile
// --------------------------------------------------------------------------

describe("profile GitHub collisions", () => {
  async function patchProfile(userId: number, handle: string): Promise<Response> {
    return app.request(
      "/auth/profile",
      {
        method: "PATCH",
        headers: {
          Origin: ORIGIN,
          Cookie: await sessionCookie(userId),
          "content-type": "application/json",
        },
        body: JSON.stringify({ github_username: handle, city: "San Diego", country: "USA" }),
      },
      env(),
    );
  }

  test("a taken handle is refused with the shared message", async () => {
    seedUser("holder@example.org", { github: "Octocat" });
    const mine = seedUser("me@example.org");
    const res = await patchProfile(mine, "octocat");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string; message: string };
    expect(body.error).toBe("github_in_use");
    expect(body.code).toBe("github_in_use");
    expect(body.message).toContain("nemar.org/settings");
  });

  test("a handle claimed mid-write is still github_in_use, not a 500", async () => {
    // The TOCTOU window past the dedup SELECT: two concurrent PATCHes claiming
    // the same free handle both pass the pre-check and the loser's UPDATE hits
    // idx_users_github. Real SQLite error text via a trigger, so this tests
    // the mapping rather than a string the test invented.
    const mine = seedUser("me@example.org");
    db.run(
      `CREATE TRIGGER race_on_profile_update BEFORE UPDATE OF github_username ON users
       BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: users.github_username'); END`,
    );
    const res = await patchProfile(mine, "brand-new-handle");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("github_in_use");
  });

  test("an unrelated write failure is still a 500", async () => {
    // The guard against a catch so wide it labels every failure a collision.
    const mine = seedUser("me@example.org");
    db.run(
      `CREATE TRIGGER race_on_profile_update BEFORE UPDATE OF github_username ON users
       BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`,
    );
    const res = await patchProfile(mine, "brand-new-handle");
    expect(res.status).toBe(500);
  });
});

// --------------------------------------------------------------------------
// Email change
// --------------------------------------------------------------------------

describe("email change refuses a target another account holds", () => {
  test("request refuses a case-variant of a live address", async () => {
    seedUser("Taken@Nemar.test");
    const id = seedUser("me@nemar.test");
    const res = await app.request(
      "/auth/email/change/request",
      {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          Cookie: await sessionCookie(id),
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: "TAKEN@nemar.TEST" }),
      },
      env(),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string; message: string };
    expect(body.error).toBe("email_in_use");
    expect(body.message).toContain("nemar.org/settings");
  });

  test("verify refuses a case-variant claimed between request and verify", async () => {
    // The whole flow, driven for real: ask for a code against a free address,
    // let someone else claim a case-variant of it, then redeem the code. The
    // re-check at verify is the only thing between that and a write the
    // partial unique index would reject.
    const id = seedUser("me@nemar.test");
    const cookie = await sessionCookie(id);
    const requested = await app.request(
      "/auth/email/change/request",
      {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({ email: "moved@nemar.test" }),
      },
      env(),
    );
    expect(requested.status).toBe(200);
    const code = ((await requested.json()) as { dev_code?: string }).dev_code;
    expect(code).toMatch(/^\d{6}$/);

    seedUser("Moved@Nemar.Test");

    const verified = await app.request(
      "/auth/email/change/verify",
      {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({ email: "moved@nemar.test", code }),
      },
      env(),
    );
    expect(verified.status).toBe(409);
    expect(((await verified.json()) as { code: string }).code).toBe("email_in_use");
    expect(userByEmail("me@nemar.test")).toBeTruthy();
  });

  test("an uncontested change still lands, lowercased", async () => {
    const id = seedUser("me@nemar.test");
    const cookie = await sessionCookie(id);
    const requested = await app.request(
      "/auth/email/change/request",
      {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({ email: "Moved@Nemar.Test" }),
      },
      env(),
    );
    const code = ((await requested.json()) as { dev_code?: string }).dev_code as string;
    const verified = await app.request(
      "/auth/email/change/verify",
      {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({ email: "MOVED@nemar.test", code }),
      },
      env(),
    );
    expect(verified.status).toBe(200);
    expect(userByEmail("moved@nemar.test")?.id).toBe(id);
  });
});
