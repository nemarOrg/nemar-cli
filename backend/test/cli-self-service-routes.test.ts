/**
 * Token-authenticated self-service identity routes (#1266, epic #1250; ADR
 * 0044), plus the old-address notification #1054 asks for.
 *
 * The claim under test is parity: the SAME handler, reached with the CLI's
 * bearer token instead of the dashboard's session cookie, applies the same
 * rules and raises the same refusals. So every case here drives the HTTP route
 * with an `Authorization: Bearer` header and asserts on what landed in the
 * database or in the mail.
 *
 * Real engine throughout: bun:sqlite behind `realD1` with every migration
 * applied, real Hono dispatch, real zod validation, real HMAC code hashing via
 * the production `hashAuthCode`, real API-key hashing via `hashApiKey`, real
 * session issuance via `issueSession`, real ORCID state signing via
 * `signCliState`. The two external boundaries -- ORCID and GitHub -- are a
 * local `Bun.serve()` reached through the bindings production already uses to
 * point at a mirror, and Resend is redirected to another local server by
 * `withFakeResend`, so services/email.ts runs unchanged including its
 * non-production delivery fence. No mocks.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { authOrcidRoutes } from "../src/routes/auth-orcid";
import { authWebRoutes } from "../src/routes/auth-web";
import { hashAuthCode } from "../src/services/auth-code";
import { STATE_COOKIE_NAME, signCliState } from "../src/services/orcid-auth";
import { hashApiKey } from "../src/services/token";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { type CapturedEmail, asSend, sendsTo, withFakeResend } from "./helpers/resend";

const APP = "https://app.nemar.org";
const ENCRYPTION_KEY = "cli-self-service-test-encryption-key-0123";

/** Keys are >= 32 chars: `resolveBearerUser` refuses anything shorter. */
const ADA_KEY = "cli-self-service-ada-key-0123456789abcdef";
const BOB_KEY = "cli-self-service-bob-key-0123456789abcdef";

const ADA_ORCID = "0000-0002-1825-0097";
const BOB_ORCID = "0000-0002-1974-1293";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let external: Server;
let externalBase: string;
/** Which iD the local ORCID token endpoint hands back for the next callback. */
let tokenOrcid = ADA_ORCID;
/** GitHub logins the local mirror should answer 404 for. */
let missingGithubLogins = new Set<string>();

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
        if (missingGithubLogins.has(gh[1])) return new Response("not found", { status: 404 });
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

/**
 * `DEV_EMAIL_ALLOWLIST` defaults to the synthetic test domain so the mail this
 * suite asserts on is actually delivered. Individual tests pass "" to exercise
 * the fence, which is the state the dev worker is really in for a real user's
 * address (AGENTS.md: ~609 real addresses behind a live Resend key).
 */
function env(allowlist = "@nemar.test"): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    ENCRYPTION_KEY,
    RESEND_API_KEY: "test-resend-key",
    FROM_EMAIL: "NEMAR <noreply@nemar.test>",
    DEV_EMAIL_ALLOWLIST: allowlist,
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

interface SeedOpts {
  username?: string | null;
  status?: string;
  github?: string | null;
  orcid?: string | null;
  orcidVerified?: boolean;
  identityBacked?: boolean;
  givenName?: string | null;
  familyName?: string | null;
}

async function seedUser(email: string, apiKey: string | null, opts: SeedOpts = {}): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, signup_source,
                        email_verified, orcid, orcid_verified, github_username,
                        given_name, family_name)
     VALUES (?, ?, 'x', ?, 'member', 'cli', 1, ?, ?, ?, ?, ?)`,
    [
      opts.username ?? null,
      email,
      opts.status ?? "verified",
      opts.orcid ?? null,
      opts.orcidVerified ? 1 : 0,
      opts.github ?? null,
      opts.givenName ?? null,
      opts.familyName ?? null,
    ],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error(`seed failed for ${email}`);
  if (apiKey) {
    db.run("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)", [
      row.id,
      await hashApiKey(apiKey),
      apiKey.slice(0, 8),
    ]);
  }
  if (opts.identityBacked && opts.orcid) {
    db.run(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', ?)",
      [row.id, opts.orcid],
    );
  }
  return row.id;
}

function userRow(id: number) {
  return db
    .query<
      {
        id: number;
        email: string;
        username: string | null;
        github_username: string | null;
        given_name: string | null;
        family_name: string | null;
        city: string | null;
        country: string | null;
        orcid: string | null;
        orcid_verified: number;
        email_verified: number;
      },
      [number]
    >(
      `SELECT id, email, username, github_username, given_name, family_name, city, country,
              orcid, orcid_verified, email_verified FROM users WHERE id = ?`,
    )
    .get(id);
}

/** A bearer-authenticated JSON call, the way the CLI makes it: no Origin. */
function withToken(
  path: string,
  apiKey: string,
  body: unknown,
  method = "POST",
  bindings: Bindings = env(),
): Promise<Response> {
  return app.request(
    path,
    {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    },
    bindings,
  );
}

beforeEach(() => {
  db = freshDb();
  tokenOrcid = ADA_ORCID;
  missingGithubLogins = new Set();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authOrcidRoutes);
  app.route("/auth", authWebRoutes);
});

// ---------------------------------------------------------------------------
// Email change over a bearer token
// ---------------------------------------------------------------------------

/** Run the whole two-step change and hand back the captured mail. */
async function changeEmail(
  apiKey: string,
  newAddress: string,
  bindings: Bindings,
): Promise<{ request: Response; verify: Response; mail: CapturedEmail[] }> {
  return withFakeResend(async (calls) => {
    const request = await withToken(
      "/auth/email/change/request",
      apiKey,
      { email: newAddress },
      "POST",
      bindings,
    );
    const requestBody = (await request.clone().json()) as { dev_code?: string };
    const verify = await withToken(
      "/auth/email/change/verify",
      apiKey,
      { email: newAddress, code: requestBody.dev_code ?? "000000" },
      "POST",
      bindings,
    );
    return { request, verify, mail: calls };
  });
}

describe("POST /auth/email/change/* with a bearer token", () => {
  test("changes the address end to end and tells the OLD one", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);

    const { request, verify, mail } = await changeEmail(ADA_KEY, "ada-new@nemar.test", env());

    expect(request.status).toBe(200);
    expect(verify.status).toBe(200);
    const body = (await verify.json()) as { ok: boolean; old_address_notified: boolean };
    expect(body.ok).toBe(true);
    expect(body.old_address_notified).toBe(true);

    const row = userRow(ada);
    expect(row?.email).toBe("ada-new@nemar.test");
    // The new inbox was just proved, so the flag follows the address.
    expect(row?.email_verified).toBe(1);

    // The notice goes to the address that LOST the account -- that is its
    // entire job (#1054), and sending it to the new one would tell the person
    // who just typed the code something they already know.
    const notices = sendsTo(mail, "ada@nemar.test");
    expect(notices.length).toBe(1);
    expect(notices[0].subject).toBe("Your NEMAR account email was changed");
    // Masked, because whoever reads the old inbox may not be the owner.
    expect(notices[0].html).toContain("a******@nemar.test");
    expect(notices[0].html).not.toContain("ada-new@nemar.test");
    expect(notices[0].html).toContain("If this was not you");
    expect(notices[0].html).toContain("nemar.org/support");
  });

  test("a failed notice does not fail the change", async () => {
    // The change has already committed by the time the notice is attempted;
    // rolling it back over an undeliverable email would be the worse outcome.
    const ada = await seedUser("ada@nemar.test", ADA_KEY);

    const result = await withFakeResend(
      async (calls) => {
        const request = await withToken("/auth/email/change/request", ADA_KEY, {
          email: "ada-new@nemar.test",
        });
        const { dev_code } = (await request.json()) as { dev_code: string };
        const verify = await withToken("/auth/email/change/verify", ADA_KEY, {
          email: "ada-new@nemar.test",
          code: dev_code,
        });
        return { verify, calls };
      },
      // Resend refuses every send, exactly as a real outage does.
      { status: 500 },
    );

    expect(result.verify.status).toBe(200);
    const body = (await result.verify.json()) as { ok: boolean; old_address_notified: boolean };
    expect(body.ok).toBe(true);
    // Reported rather than hidden: the caller can say the notice did not land.
    expect(body.old_address_notified).toBe(false);
    expect(userRow(ada)?.email).toBe("ada-new@nemar.test");
  });

  test("off production the notice is fenced to allow-listed addresses", async () => {
    // The dev D1 carries ~609 real addresses and the dev worker holds a live
    // Resend key (AGENTS.md). The old address is the one recipient in this
    // flow that the caller did not choose, so the fence has to cover it.
    const ada = await seedUser("ada@nemar.test", ADA_KEY);

    const { verify, mail } = await changeEmail(ADA_KEY, "ada-new@nemar.test", env(""));

    expect(verify.status).toBe(200);
    expect((await verify.json()) as { old_address_notified: boolean }).toMatchObject({
      old_address_notified: false,
    });
    expect(sendsTo(mail, "ada@nemar.test")).toEqual([]);
    // The change still happened; only the mail was withheld.
    expect(userRow(ada)?.email).toBe("ada-new@nemar.test");
  });

  test("refuses an address another live account holds", async () => {
    await seedUser("ada@nemar.test", ADA_KEY);
    await seedUser("taken@nemar.test", null);

    const res = await withToken("/auth/email/change/request", ADA_KEY, {
      email: "TAKEN@nemar.test",
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string; message: string };
    expect(body.error).toBe("email_in_use");
    expect(body.code).toBe("email_in_use");
    expect(body.message).toContain("nemar.org/settings");
    // Nothing was mailed and no code exists for the target.
    expect(
      db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM auth_codes WHERE email = ?")
        .get("taken@nemar.test")?.n,
    ).toBe(0);
  });

  test("a code issued for one account cannot be redeemed by another's token", async () => {
    // The whole point of the 0066 user_id binding, now reachable from two
    // credentials: a second person holding the same inbox (or the same code)
    // must not be able to attach the address to THEIR account.
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    const bob = await seedUser("bob@nemar.test", BOB_KEY);

    const request = await withToken("/auth/email/change/request", ADA_KEY, {
      email: "shared@nemar.test",
    });
    const { dev_code } = (await request.json()) as { dev_code: string };

    const stolen = await withToken("/auth/email/change/verify", BOB_KEY, {
      email: "shared@nemar.test",
      code: dev_code,
    });

    expect(stolen.status).toBe(401);
    expect((await stolen.json()) as { error: string }).toMatchObject({ error: "code_expired" });
    expect(userRow(bob)?.email).toBe("bob@nemar.test");
    expect(userRow(ada)?.email).toBe("ada@nemar.test");

    // And the rightful owner's code still works afterwards.
    const mine = await withFakeResend(() =>
      withToken("/auth/email/change/verify", ADA_KEY, {
        email: "shared@nemar.test",
        code: dev_code,
      }),
    );
    expect(mine.status).toBe(200);
    expect(userRow(ada)?.email).toBe("shared@nemar.test");
  });

  test("a wrong code is refused and the address does not move", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    await withToken("/auth/email/change/request", ADA_KEY, { email: "ada-new@nemar.test" });

    const res = await withToken("/auth/email/change/verify", ADA_KEY, {
      email: "ada-new@nemar.test",
      code: "000000",
    });

    // 000000 is a valid draw, so pin the assertion to the account instead of
    // to the status alone.
    expect(userRow(ada)?.email).toBe("ada@nemar.test");
    if (res.status !== 200) {
      expect((await res.json()) as { error: string }).toMatchObject({ error: "code_incorrect" });
    }
  });

  test("the current address is refused with a sentence, not a bare code", async () => {
    await seedUser("ada@nemar.test", ADA_KEY);
    const res = await withToken("/auth/email/change/request", ADA_KEY, { email: "ada@nemar.test" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("same_email");
    expect(body.message).toContain("already the address");
  });

  test("an unknown token is refused before anything is mailed", async () => {
    await seedUser("ada@nemar.test", ADA_KEY);
    const res = await withToken("/auth/email/change/request", `${ADA_KEY}-wrong`, {
      email: "ada-new@nemar.test",
    });
    expect(res.status).toBe(401);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM auth_codes").get()?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PATCH /auth/profile over a bearer token
// ---------------------------------------------------------------------------

describe("PATCH /auth/profile with a bearer token", () => {
  test("sets the GitHub handle, checked against GitHub", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    const res = await withToken("/auth/profile", ADA_KEY, { github_username: "@octocat" }, "PATCH");
    expect(res.status).toBe(200);
    // The leading "@" people paste is stripped by the shared normaliser.
    expect(userRow(ada)?.github_username).toBe("octocat");
  });

  test("refuses a GitHub handle that does not exist", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    missingGithubLogins.add("ghost-handle");
    const res = await withToken(
      "/auth/profile",
      ADA_KEY,
      { github_username: "ghost-handle" },
      "PATCH",
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "invalid_github_username",
    });
    expect(userRow(ada)?.github_username).toBeNull();
  });

  test("refuses a GitHub handle another live account holds", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    await seedUser("other@nemar.test", null, { github: "Octocat" });
    const res = await withToken("/auth/profile", ADA_KEY, { github_username: "octocat" }, "PATCH");
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "github_in_use" });
    expect(userRow(ada)?.github_username).toBeNull();
  });

  test("sets a username while it is empty, and refuses one that is taken", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    await seedUser("other@nemar.test", null, { username: "Taken" });

    const ok = await withToken("/auth/profile", ADA_KEY, { username: "alovelace" }, "PATCH");
    expect(ok.status).toBe(200);
    expect(userRow(ada)?.username).toBe("alovelace");

    const clash = await withToken("/auth/profile", ADA_KEY, { username: "taken" }, "PATCH");
    expect(clash.status).toBe(409);
    expect((await clash.json()) as { error: string }).toMatchObject({ error: "username_taken" });
    expect(userRow(ada)?.username).toBe("alovelace");
  });

  test("refuses a rename once an admin has approved the account", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY, {
      username: "alovelace",
      status: "approved",
    });
    const res = await withToken("/auth/profile", ADA_KEY, { username: "adal" }, "PATCH");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("username_locked");
    expect(body.message).toContain("contact an admin");
    expect(userRow(ada)?.username).toBe("alovelace");
  });

  test("sets the name when no verified ORCID speaks for the account", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    const res = await withToken(
      "/auth/profile",
      ADA_KEY,
      { given_name: "Ada", family_name: "Lovelace" },
      "PATCH",
    );
    expect(res.status).toBe(200);
    const row = userRow(ada);
    expect(row?.given_name).toBe("Ada");
    expect(row?.family_name).toBe("Lovelace");
  });

  test("refuses a name edit while a verified ORCID iD is linked", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY, {
      orcid: ADA_ORCID,
      orcidVerified: true,
      givenName: "Ada",
      familyName: "Lovelace",
    });
    const res = await withToken("/auth/profile", ADA_KEY, { given_name: "Augusta" }, "PATCH");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("name_is_orcid_canonical");
    expect(body.message).toContain("orcid.org");
    expect(userRow(ada)?.given_name).toBe("Ada");
  });

  test("sets city and country, and refuses a blank one", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    const ok = await withToken(
      "/auth/profile",
      ADA_KEY,
      { city: " San Diego ", country: "USA" },
      "PATCH",
    );
    expect(ok.status).toBe(200);
    const row = userRow(ada);
    expect(row?.city).toBe("San Diego");
    expect(row?.country).toBe("USA");

    const blank = await withToken("/auth/profile", ADA_KEY, { city: "   " }, "PATCH");
    expect(blank.status).toBe(400);
    expect((await blank.json()) as { error: string }).toMatchObject({ error: "city_required" });
    expect(userRow(ada)?.city).toBe("San Diego");
  });

  test("a token still cannot edit somebody else's row", async () => {
    // The patch is scoped by the credential, never by anything in the body.
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    const bob = await seedUser("bob@nemar.test", BOB_KEY);
    const res = await withToken(
      "/auth/profile",
      BOB_KEY,
      { username: "bobby", id: ada, user_id: ada },
      "PATCH",
    );
    expect(res.status).toBe(200);
    expect(userRow(bob)?.username).toBe("bobby");
    expect(userRow(ada)?.username).toBeNull();
  });

  test("no credential at all is still refused", async () => {
    await seedUser("ada@nemar.test", ADA_KEY);
    const res = await app.request(
      "/auth/profile",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "nobody" }),
      },
      env(),
    );
    // No bearer and no allowed Origin: the cookie half's CSRF gate answers
    // first, exactly as it did before tokens were accepted here.
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// ORCID: cli-start -> cli-handoff -> callback
// ---------------------------------------------------------------------------

/** The `t=` token out of a cli-start response. */
function handoffToken(authorizeUrl: string): string {
  const t = new URL(authorizeUrl).searchParams.get("t");
  if (!t) throw new Error(`no state token in ${authorizeUrl}`);
  return t;
}

/** Walk the handoff and hand back the state cookie value and the csrf. */
async function walkHandoff(token: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.request(`/auth/orcid/cli-handoff?t=${encodeURIComponent(token)}`, {}, env());
  expect(res.status).toBe(302);
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  expect(cookie.startsWith(`${STATE_COOKIE_NAME}=`)).toBe(true);
  const csrf = new URL(res.headers.get("Location") ?? "https://x/").searchParams.get("state");
  if (!csrf) throw new Error("handoff redirect carried no state");
  return { cookie, csrf };
}

function callback(csrf: string, cookies: string[]): Promise<Response> {
  return app.request(
    `/auth/orcid/callback?code=orcid-code&state=${encodeURIComponent(csrf)}`,
    { headers: { Cookie: cookies.join("; ") } },
    env(),
  );
}

describe("POST /auth/orcid/cli-start", () => {
  test("mints a handoff a browser with no session can complete", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    tokenOrcid = ADA_ORCID;

    const started = await withToken("/auth/orcid/cli-start", ADA_KEY, { mode: "link" });
    expect(started.status).toBe(200);
    const body = (await started.json()) as {
      authorize_url: string;
      expires_in: number;
      mode: string;
    };
    expect(body.mode).toBe("link");
    expect(body.expires_in).toBe(600);
    expect(body.authorize_url.startsWith(`${APP}/auth/orcid/cli-handoff?t=`)).toBe(true);

    const { cookie, csrf } = await walkHandoff(handoffToken(body.authorize_url));
    // No `nemar_session` cookie anywhere: this is a browser opened from a
    // terminal, which is the whole reason the account rides in the state.
    const res = await callback(csrf, [cookie]);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${APP}/settings`);
    const row = userRow(ada);
    expect(row?.orcid).toBe(ADA_ORCID);
    expect(row?.orcid_verified).toBe(1);
    expect(
      db
        .query<{ n: number }, [number]>(
          "SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ?",
        )
        .get(ada)?.n,
    ).toBe(1);
  });

  test("a state minted for one account never links to another", async () => {
    // The browser that finishes the flow may well be signed in as somebody
    // else. The signed state names the account, and it wins -- a bystanding
    // cookie is not evidence of intent.
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    const bob = await seedUser("bob@nemar.test", BOB_KEY);
    tokenOrcid = ADA_ORCID;

    const started = await withToken("/auth/orcid/cli-start", ADA_KEY, { mode: "link" });
    const { authorize_url } = (await started.json()) as { authorize_url: string };
    const { cookie, csrf } = await walkHandoff(handoffToken(authorize_url));
    const { cookieIdRaw } = await issueSession(env(), bob, false, null, null, "email_code");

    const res = await callback(csrf, [cookie, `nemar_session=${cookieIdRaw}`]);

    expect(res.status).toBe(302);
    expect(userRow(ada)?.orcid).toBe(ADA_ORCID);
    expect(userRow(bob)?.orcid).toBeNull();
    expect(
      db
        .query<{ user_id: number }, [string]>(
          "SELECT user_id FROM oauth_identities WHERE provider_subject = ?",
        )
        .get(ADA_ORCID)?.user_id,
    ).toBe(ada);
  });

  test("a tampered state links nothing", async () => {
    // The user id is covered by the signature, so editing it is not an
    // account swap -- it is an unreadable state.
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    const bob = await seedUser("bob@nemar.test", BOB_KEY);

    const forged = await signCliState(
      { csrf: "forged-csrf", mode: "link", userId: bob, next: "/settings", exp: Date.now() + 60000 },
      "not-the-worker-key",
    );
    const handoff = await app.request(
      `/auth/orcid/cli-handoff?t=${encodeURIComponent(forged)}`,
      {},
      env(),
    );
    expect(handoff.status).toBe(302);
    expect(handoff.headers.get("Location")).toBe(`${APP}/login?error=orcid_state`);
    expect(handoff.headers.get("Set-Cookie")).toBeNull();

    // And presenting it straight at the callback fails the csrf compare too.
    const res = await callback("forged-csrf", [`${STATE_COOKIE_NAME}=${forged}`]);
    expect(res.headers.get("Location")).toContain("error=orcid_state");
    expect(userRow(ada)?.orcid).toBeNull();
    expect(userRow(bob)?.orcid).toBeNull();
  });

  test("an expired intent is refused at the handoff", async () => {
    await seedUser("ada@nemar.test", ADA_KEY);
    const stale = await signCliState(
      { csrf: "stale", mode: "link", userId: 1, next: "/settings", exp: Date.now() - 1000 },
      ENCRYPTION_KEY,
    );
    const res = await app.request(
      `/auth/orcid/cli-handoff?t=${encodeURIComponent(stale)}`,
      {},
      env(),
    );
    expect(res.headers.get("Location")).toBe(`${APP}/login?error=orcid_state`);
  });

  test("relink swaps the iD; a plain link on a linked account is refused early", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY, {
      orcid: ADA_ORCID,
      orcidVerified: true,
      identityBacked: true,
    });

    const refused = await withToken("/auth/orcid/cli-start", ADA_KEY, { mode: "link" });
    expect(refused.status).toBe(409);
    const refusal = (await refused.json()) as { error: string; message: string };
    expect(refusal.error).toBe("orcid_already_have");
    expect(refusal.message).toContain("orcid relink");

    tokenOrcid = BOB_ORCID;
    const started = await withToken("/auth/orcid/cli-start", ADA_KEY, { mode: "relink" });
    expect(started.status).toBe(200);
    const { authorize_url } = (await started.json()) as { authorize_url: string };
    const { cookie, csrf } = await walkHandoff(handoffToken(authorize_url));
    const res = await callback(csrf, [cookie]);

    expect(res.status).toBe(302);
    expect(userRow(ada)?.orcid).toBe(BOB_ORCID);
    const subjects = db
      .query<{ provider_subject: string }, [number]>(
        "SELECT provider_subject FROM oauth_identities WHERE user_id = ?",
      )
      .all(ada)
      .map((r) => r.provider_subject);
    expect(subjects).toEqual([BOB_ORCID]);
  });

  test("refuses an iD another live account already holds", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    await seedUser("holder@nemar.test", null, { orcid: BOB_ORCID });
    tokenOrcid = BOB_ORCID;

    const started = await withToken("/auth/orcid/cli-start", ADA_KEY, { mode: "link" });
    const { authorize_url } = (await started.json()) as { authorize_url: string };
    const { cookie, csrf } = await walkHandoff(handoffToken(authorize_url));
    const res = await callback(csrf, [cookie]);

    expect(res.headers.get("Location")).toContain("error=orcid_in_use");
    expect(userRow(ada)?.orcid).toBeNull();
  });

  test("an intent for a revoked account links nothing", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    const started = await withToken("/auth/orcid/cli-start", ADA_KEY, { mode: "link" });
    const { authorize_url } = (await started.json()) as { authorize_url: string };
    const { cookie, csrf } = await walkHandoff(handoffToken(authorize_url));
    // Revoked between minting and finishing -- up to ten minutes apart.
    db.run("UPDATE users SET status = 'revoked' WHERE id = ?", [ada]);

    const res = await callback(csrf, [cookie]);

    expect(res.headers.get("Location")).toContain("error=orcid_account");
    expect(userRow(ada)?.orcid).toBeNull();
  });

  test("needs a credential", async () => {
    await seedUser("ada@nemar.test", ADA_KEY);
    const res = await app.request(
      "/auth/orcid/cli-start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "relink" }),
      },
      env(),
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /auth/orcid/unlink with a bearer token", () => {
  test("drops the identity row and the claim on the iD", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY, {
      orcid: ADA_ORCID,
      orcidVerified: true,
      identityBacked: true,
    });

    const res = await withToken("/auth/orcid/unlink", ADA_KEY, {});

    expect(res.status).toBe(200);
    const row = userRow(ada);
    expect(row?.orcid).toBeNull();
    expect(row?.orcid_verified).toBe(0);
    expect(
      db
        .query<{ n: number }, [number]>(
          "SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ?",
        )
        .get(ada)?.n,
    ).toBe(0);
  });

  test("unlinks only the acting account", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY, {
      orcid: ADA_ORCID,
      orcidVerified: true,
      identityBacked: true,
    });
    await seedUser("bob@nemar.test", BOB_KEY, {
      orcid: BOB_ORCID,
      orcidVerified: true,
      identityBacked: true,
    });

    const res = await withToken("/auth/orcid/unlink", BOB_KEY, {});

    expect(res.status).toBe(200);
    expect(userRow(ada)?.orcid).toBe(ADA_ORCID);
  });
});

// ---------------------------------------------------------------------------
// The cookie half is unchanged
// ---------------------------------------------------------------------------

describe("the session path keeps its own rules", () => {
  test("a cookie without an allowed Origin is still refused", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    const { cookieIdRaw } = await issueSession(env(), ada, false, null, null, "email_code");

    const res = await app.request(
      "/auth/profile",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nemar_session=${cookieIdRaw}`,
          Origin: "https://evil.example.com",
        },
        body: JSON.stringify({ username: "alovelace" }),
      },
      env(),
    );

    expect(res.status).toBe(403);
    expect(userRow(ada)?.username).toBeNull();
  });

  test("a pending account can still change the address it typed wrong", async () => {
    // `authMiddleware`'s cookie path refuses `pending` (ADR 0040); this route
    // must not, because an unverified inbox is exactly what a wrong address
    // produces and the change is the only way out of it.
    const ada = await seedUser("ada@nemar.test", null, { status: "pending" });
    db.run("UPDATE users SET email_verified = 0 WHERE id = ?", [ada]);
    const { cookieIdRaw } = await issueSession(env(), ada, false, null, null, "email_code");

    const res = await app.request(
      "/auth/email/change/request",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nemar_session=${cookieIdRaw}`,
          Origin: "https://nemar.org",
        },
        body: JSON.stringify({ email: "ada-fixed@nemar.test" }),
      },
      env(),
    );

    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// One assertion that the mail helper is really seeing sends
// ---------------------------------------------------------------------------

describe("the change code itself", () => {
  test("goes to the NEW address and nowhere else", async () => {
    await seedUser("ada@nemar.test", ADA_KEY);
    // Echo-eligible targets skip the send (the echo IS the delivery off
    // production), so a non-synthetic target is what proves the recipient.
    const mail = await withFakeResend(async (calls) => {
      await withToken(
        "/auth/email/change/request",
        ADA_KEY,
        { email: "ada-new@nemar.test" },
        "POST",
        env(),
      );
      return calls;
    });
    // `@nemar.test` is echo-eligible, so nothing is mailed for the CODE at
    // all -- which is the fence working, and is asserted so a change that
    // starts mailing dev targets fails here.
    expect(mail.filter((c) => c.path === "/emails").map((c) => asSend(c).subject)).toEqual([]);
  });
});
