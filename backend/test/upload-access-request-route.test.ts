/**
 * POST /users/me/upload-access/request (ADR 0042, #1253, epic #1250).
 *
 * ADR 0040 made admin approval the single writer of `service_access` and left
 * users with no way to ask for it: the 403 pointed at a support page. This is
 * the ask, and it is also the export-control review packet, so what it refuses
 * and what it mails are the whole point.
 *
 * Real engine throughout: bun:sqlite behind realD1 with every migration
 * applied, real Hono dispatch through `authMiddleware` (so BOTH credential
 * paths are the production ones), real hashed API keys, real session issuance
 * via issueSession, real zod validation. The two external boundaries are local
 * `Bun.serve()` instances, not mocks: GitHub's `/users/:login` through the
 * `NEMAR_GITHUB_API_URL` override, and Resend through helpers/resend.ts, so
 * services/email.ts builds its real HTML and passes its real delivery fence.
 *
 * The load-bearing assertions are about what does NOT happen: a second request
 * must not mail the admins twice, and the requester must never be mailed at
 * all.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { userRoutes } from "../src/routes/users";
import { hashApiKey } from "../src/services/token";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { sendsTo, withFakeResend } from "./helpers/resend";

const USER_KEY = "uploadreq-user-key-0123456789abcdef0123456789ab";
const ENCRYPTION_KEY = "upload-access-test-encryption-key-0123456789";
/** `@nemar.test` is on DEV_EMAIL_ALLOWLIST below, which is what lets the admin
 *  notification reach the fake Resend so it can be counted at all. */
const USER_EMAIL = "requester@nemar.test";
const ADMIN_EMAIL = "uploadadmin@nemar.test";
const WHY = "Depositing our lab's 64-channel EEG study of motor imagery, 40 participants.";

/** GitHub logins the local GitHub server resolves. Anything else 404s, which
 *  is how validateGitHubUsername reports "does not exist". */
let knownGitHubLogins: Set<string>;
let server: ReturnType<typeof Bun.serve>;

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const login = new URL(req.url).pathname.match(/^\/users\/(.+)$/)?.[1];
      if (login && knownGitHubLogins.has(login)) {
        return new Response(JSON.stringify({ login, id: 4242 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://localhost:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    ENCRYPTION_KEY,
    RESEND_API_KEY: "fake-resend-key",
    DEV_EMAIL_ALLOWLIST: "@nemar.test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    GITHUB_ADMIN_PAT: "test-pat-never-used-against-a-real-host",
    WEB_SESSION_COOKIE_DOMAIN: "",
  } as unknown as Bindings;
}

function seedAdmin(): void {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access)
     VALUES ('uploadadmin', ?, 'x', 'approved', 'admin', 1, 1)`,
  ).run(ADMIN_EMAIL);
}

/** Every column the request needs, filled. Individual tests blank out the one
 *  they are about, so the fixture is complete by default and each refusal test
 *  changes exactly one thing. */
interface Overrides {
  username?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  github_username?: string | null;
  city?: string | null;
  country?: string | null;
  affiliation?: string | null;
  email_verified?: number;
  service_access?: number;
  status?: string;
  upload_access_requested_at?: string | null;
}

async function seedRequester(overrides: Overrides = {}): Promise<number> {
  const row = {
    username: "arivers",
    given_name: "Ada",
    family_name: "Rivers",
    github_username: "adarivers",
    city: "San Diego",
    country: "USA",
    affiliation: "Swartz Center",
    email_verified: 1,
    service_access: 0,
    status: "verified",
    upload_access_requested_at: null,
    ...overrides,
  };
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name, github_username, city, country, affiliation,
                        orcid, orcid_verified, signup_source, service_access,
                        upload_access_requested_at)
     VALUES (?, ?, 'x', ?, 'member', ?, ?, ?, ?, ?, ?, ?,
             '0000-0002-1825-0097', 1, 'web', ?, ?)`,
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
    row.affiliation,
    row.service_access,
    row.upload_access_requested_at,
  );
  const u = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?")
    .get(USER_EMAIL);
  if (!u) throw new Error("seed: requester insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(USER_KEY),
    USER_KEY.slice(0, 8),
  );
  return u.id;
}

function requestWithToken(why: string = WHY): Promise<Response> {
  return app.request(
    "/users/me/upload-access/request",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${USER_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ why }),
    },
    env(),
  );
}

async function requestWithCookie(userId: number, why: string = WHY): Promise<Response> {
  const { cookieIdRaw } = await issueSession(env(), userId, false, null, null, "orcid");
  return app.request(
    "/users/me/upload-access/request",
    {
      method: "POST",
      headers: { Cookie: `nemar_session=${cookieIdRaw}`, "content-type": "application/json" },
      body: JSON.stringify({ why }),
    },
    env(),
  );
}

function notifiedAt(id: number): string | null {
  return (
    db
      .query<{ upload_access_notified_at: string | null }, [number]>(
        "SELECT upload_access_notified_at FROM users WHERE id = ?",
      )
      .get(id)?.upload_access_notified_at ?? null
  );
}

function storedRow(id: number) {
  return db
    .query<{ upload_access_requested_at: string | null; description: string | null }, [number]>(
      "SELECT upload_access_requested_at, description FROM users WHERE id = ?",
    )
    .get(id);
}

beforeEach(() => {
  db = freshDb();
  knownGitHubLogins = new Set(["adarivers"]);
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/users", userRoutes);
  seedAdmin();
});

describe("upload-access request: preconditions", () => {
  test("a why text under 20 characters is refused, naming `why`", async () => {
    await seedRequester();

    const res = await requestWithToken("too short");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("why_required");
    expect(body.missing).toEqual(["why"]);
  });

  test("a why text over 500 characters is refused the same way", async () => {
    await seedRequester();

    const res = await requestWithToken("x".repeat(501));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("why_required");
  });

  test("an unverified inbox is refused before anything about the profile", async () => {
    // Should be unreachable in a well-formed catalog -- authMiddleware admits
    // only `verified`/`approved`, and both roads to `verified` set
    // email_verified. Nothing in the SCHEMA ties the two together, though, so
    // this row is constructible and the check is not decorative.
    await seedRequester({ email_verified: 0, username: null });

    const res = await requestWithToken();
    expect(res.status).toBe(400);
    const body = await res.json();
    // The username is missing too; the inbox is what it is told to fix first.
    expect(body.error).toBe("email_not_verified");
    expect(body.missing).toEqual(["email_verified"]);
  });

  test("every missing profile field is reported at once, in one refusal", async () => {
    await seedRequester({ username: null, city: "  ", country: null });

    const res = await requestWithToken();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("profile_incomplete");
    // Whitespace counts as absent, which is why `city` is in this list.
    expect(body.missing).toEqual(["username", "city", "country"]);
  });

  test("a missing name is reported as its two fields, not as one", async () => {
    // ADR 0041 needs both halves to cite a depositor, so a client has to be
    // able to highlight exactly the half that is absent.
    await seedRequester({ family_name: null });

    const body = await (await requestWithToken()).json();
    expect(body.missing).toEqual(["family_name"]);
  });

  test("a GitHub handle that does not resolve is refused", async () => {
    await seedRequester({ github_username: "ghost-account-42" });

    const res = await requestWithToken();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("github_username_unverified");
    expect(body.missing).toEqual(["github_username"]);
  });

  test("a refused request writes nothing", async () => {
    const id = await seedRequester({ country: null });

    await requestWithToken();
    const row = storedRow(id);
    expect(row?.upload_access_requested_at).toBeNull();
    expect(row?.description).toBeNull();
  });
});

describe("upload-access request: success", () => {
  test("stores the stamp and the why text, and audits it", async () => {
    const id = await seedRequester();

    const res = await withFakeResend(() => requestWithToken());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ok: true,
      already_requested: false,
      email_sent: true,
      admins_notified: 1,
    });

    const row = storedRow(id);
    expect(row?.upload_access_requested_at).toBeTruthy();
    expect(row?.description).toBe(WHY);

    const audit = db
      .query<{ user_id: number; details: string | null }, [string]>(
        "SELECT user_id, details FROM audit_log WHERE action = ?",
      )
      .all("upload_access_requested");
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBe(id);
    // The channel is derived from the credential, never from the body.
    expect(JSON.parse(audit[0].details ?? "{}")).toMatchObject({
      via: "cli",
      why_chars: WHY.length,
    });
  });

  test("mails the admins exactly one review card carrying every review field", async () => {
    await seedRequester();

    const calls = await withFakeResend(async (captured) => {
      await requestWithToken();
      return captured;
    });

    const toAdmin = sendsTo(calls, ADMIN_EMAIL);
    expect(toAdmin).toHaveLength(1);
    expect(toAdmin[0].subject).toBe("[NEMAR] Upload access requested: arivers");
    const html = toAdmin[0].html;
    for (const field of [
      "arivers",
      "Ada Rivers",
      USER_EMAIL,
      "0000-0002-1825-0097",
      "adarivers",
      "San Diego",
      "USA",
      "Swartz Center",
    ]) {
      expect(html).toContain(field);
    }
    // The why text arrives HTML-ESCAPED. Asserted in its escaped form rather
    // than by choosing a fixture without an apostrophe: escapeHtml running over
    // user-supplied prose in an admin's inbox is the property worth pinning.
    expect(html).toContain(WHY.replace("'", "&#39;"));
    // The command an admin runs next, keyed on the username the request
    // guarantees exists.
    expect(html).toContain("nemar admin approve");
  });

  test("nothing is sent to the requester", async () => {
    // The request is a message to the admins. A "we got your request" mail
    // would be a second delivery path to keep working for no new information.
    await seedRequester();

    const calls = await withFakeResend(async (captured) => {
      await requestWithToken();
      return captured;
    });
    expect(sendsTo(calls, USER_EMAIL)).toHaveLength(0);
  });

  test("a web session is accepted as well as a bearer token", async () => {
    const id = await seedRequester();

    const res = await withFakeResend(() => requestWithCookie(id));
    expect(res.status).toBe(201);

    const audit = db
      .query<{ details: string | null }, [string]>("SELECT details FROM audit_log WHERE action = ?")
      .all("upload_access_requested");
    // The channel follows the credential that authenticated the request.
    expect(JSON.parse(audit[0].details ?? "{}").via).toBe("web");
  });
});

describe("upload-access request: asking twice", () => {
  test("the second call reports the open request and mails nobody", async () => {
    const id = await seedRequester();

    const calls = await withFakeResend(async (captured) => {
      await requestWithToken();
      const second = await requestWithToken("A completely different reason, also long enough.");
      expect(second.status).toBe(200);
      const body = await second.json();
      expect(body.already_requested).toBe(true);
      expect(body.requested_at).toBeTruthy();
      return captured;
    });

    expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
    // The stored text is the FIRST one: an open request is not editable by
    // re-submitting it, or the admin's inbox and the row would disagree.
    expect(storedRow(id)?.description).toBe(WHY);
    expect(
      db
        .query<{ n: number }, [string]>("SELECT COUNT(*) as n FROM audit_log WHERE action = ?")
        .get("upload_access_requested")?.n,
    ).toBe(1);
  });

  test("an open request is reported even when the profile has since regressed", async () => {
    // The request is already with an admin; telling its owner to go fix their
    // profile would read as though it had failed.
    const id = await seedRequester({ upload_access_requested_at: "2026-09-01T00:00:00Z" });
    db.query("UPDATE users SET city = NULL WHERE id = ?").run(id);

    const res = await requestWithToken();
    expect(res.status).toBe(200);
    expect((await res.json()).already_requested).toBe(true);
  });
});

describe("upload-access request: an undelivered notification", () => {
  test("a request nobody received is stored, reported, and NOT stamped as notified", async () => {
    const id = await seedRequester();

    const res = await withFakeResend(() => requestWithToken(), { status: 500 });
    // The request itself succeeded: it is on the row and in the admin queue.
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.already_requested).toBe(false);
    // ...and the caller is told the admins were not reached, rather than being
    // handed an unqualified ok:true.
    expect(body.email_sent).toBe(false);
    expect(body.admins_notified).toBe(0);

    expect(notifiedAt(id)).toBeNull();
    expect(storedRow(id)?.upload_access_requested_at).toBeTruthy();
  });

  test("the next call re-sends instead of short-circuiting", async () => {
    // Without the second stamp this is where request-once becomes
    // request-NEVER: the row says answered, the idempotency guard refuses to
    // act, and no admin ever learns the request exists.
    const id = await seedRequester();
    await withFakeResend(() => requestWithToken(), { status: 500 });

    const calls = await withFakeResend(async (captured) => {
      const second = await requestWithToken();
      expect(second.status).toBe(200);
      const body = await second.json();
      expect(body.already_requested).toBe(true);
      expect(body.email_sent).toBe(true);
      expect(body.admins_notified).toBe(1);
      return captured;
    });

    expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
    expect(notifiedAt(id)).toBeTruthy();
  });

  test("a delivered request is never re-sent", async () => {
    await seedRequester();
    await withFakeResend(() => requestWithToken());

    const calls = await withFakeResend(async (captured) => {
      const second = await requestWithToken();
      expect((await second.json()).email_sent).toBe(true);
      return captured;
    });
    expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(0);
  });

  test("the retry carries the ORIGINAL why text, read back off the row", async () => {
    // The retry does not re-read the request body, so the card an admin
    // eventually gets is the one the user actually submitted.
    await seedRequester();
    await withFakeResend(() => requestWithToken(), { status: 500 });

    const calls = await withFakeResend(async (captured) => {
      await requestWithToken("An entirely different sentence, comfortably long enough.");
      return captured;
    });
    expect(sendsTo(calls, ADMIN_EMAIL)[0].html).toContain(WHY.replace("'", "&#39;"));
  });

  test("no eligible admin still succeeds, and says nobody was notified", async () => {
    db.query("DELETE FROM users WHERE username = 'uploadadmin'").run();
    const id = await seedRequester();

    const calls = await withFakeResend(async (captured) => {
      const res = await requestWithToken();
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.email_sent).toBe(false);
      expect(body.admins_notified).toBe(0);
      return captured;
    });

    expect(calls).toHaveLength(0);
    // Unstamped, so a later run (once an admin exists again) still notifies.
    expect(notifiedAt(id)).toBeNull();
  });
});

describe("upload-access request: already granted", () => {
  test("409s once the account holds upload access", async () => {
    await seedRequester({ service_access: 1, status: "approved" });

    const res = await requestWithToken();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already_approved");
  });

  test("a granted account cannot re-open a request by asking again", async () => {
    const id = await seedRequester({
      service_access: 1,
      status: "approved",
      upload_access_requested_at: "2026-08-01T00:00:00Z",
    });

    const calls = await withFakeResend(async (captured) => {
      await requestWithToken();
      return captured;
    });
    expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(0);
    expect(storedRow(id)?.upload_access_requested_at).toBe("2026-08-01T00:00:00Z");
  });
});
