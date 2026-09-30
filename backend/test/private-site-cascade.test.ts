/**
 * Which paths that end a credential reach the host-scoped sessions minted
 * from it, for both scopes that have one: `docs` (ADR 0056) and `private`
 * (ADR 0079).
 *
 * Real engine throughout: bun:sqlite behind `realD1` with every migration
 * applied, real routes (`/auth/logout`, the admin revoke and delete routes,
 * the self-service key routes) behind their real middleware, real sign-ins
 * through the real grant routes and exchanges. No mocks. The admin harness
 * (a target with no IAM user, no datasets, `RESEND_API_KEY` unset under
 * `ENVIRONMENT: "test"`) is the one `admin-credential-cascade.test.ts` uses,
 * so IAM, GitHub and email all no-op without a network call.
 *
 * TWO HALVES, AND THE SECOND IS AS DELIBERATE AS THE FIRST.
 *
 * The cascade: sign-out, admin revoke (by username and by id) and the owner
 * soft delete end every session AND every outstanding grant of both scopes.
 * A grant is a sixty-second licence to mint a fresh session, checked against
 * the account, so a surviving one is a way back in; each test therefore
 * asserts both, and for revoke also that restoring the account does not
 * restore the credential.
 *
 * The non-membership: a role demotion and an API key revocation end the docs
 * credential and leave the private one alone. A docs session exists only for
 * admins and can be minted from a key; a private session is neither, and
 * `resolvePrincipal` reports the live role on every call. So these tests
 * assert that the private session SURVIVES, which is the behavior ADR 0079
 * records, not a gap.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { DOCS_SESSION_HEADER } from "../../shared/contract/docs-auth.js";
import { adminRoutes } from "../src/routes/admin";
import { authRoutes } from "../src/routes/auth";
import { authDocsRoutes } from "../src/routes/auth-docs";
import { authKeysRoutes } from "../src/routes/auth-keys";
import { authPrivateRoutes } from "../src/routes/auth-private";
import { authWebRoutes } from "../src/routes/auth-web";
import { resolvePrincipal } from "../src/rpc/principal";
import { exchangePrivateGrant } from "../src/rpc/private-session";
import { hashApiKey } from "../src/services/token";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const APP = "https://app.nemar.org";
const OWNER_KEY = "nm_scope-cascade-owner-key-0123456789abcdef01";
const TARGET_KEY = "nm_scope-cascade-target-key-0123456789abcdef0";

type Scope = "docs" | "private";
const SCOPES: readonly Scope[] = ["docs", "private"];

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let targetId: number;

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    RESEND_API_KEY: "",
    APP_BASE_URL: APP,
    WEB_SESSION_COOKIE_DOMAIN: "",
  } as unknown as Bindings;
}

async function seedUser(
  username: string,
  role: string,
  kind: string,
  apiKey?: string,
): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role, email_verified, account_kind)
     VALUES (?, ?, 'x', ?, 'approved', ?, 1, ?)`,
    [username, `${username}@nemar.test`, `${username}-gh`, role, kind],
  );
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error("seed failed");
  if (apiKey) {
    db.run("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)", [
      row.id,
      await hashApiKey(apiKey),
      apiKey.slice(0, 8),
    ]);
  }
  return row.id;
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authRoutes);
  app.route("/auth", authWebRoutes);
  app.route("/auth", authDocsRoutes);
  app.route("/auth", authPrivateRoutes);
  app.route("/auth", authKeysRoutes);
  app.route("/admin", adminRoutes);
  await seedUser("scopeowner", "owner", "service", OWNER_KEY);
  // An admin, so it can hold a docs session at all; a key, so the key paths
  // have something to revoke.
  targetId = await seedUser("scopetarget", "admin", "person", TARGET_KEY);
});

// --------------------------------------------------------------------------
// Signing in, and asking whether a credential still works, per scope
// --------------------------------------------------------------------------

async function appSession(): Promise<string> {
  const { cookieIdRaw } = await issueSession(env(), targetId, false, "ua", "127.0.0.1", "orcid");
  return cookieIdRaw;
}

async function grant(scope: Scope, appCookie: string): Promise<string> {
  const res = await app.request(
    `/auth/${scope}/grant`,
    { method: "POST", headers: { Cookie: `nemar_session=${appCookie}`, Origin: APP } },
    env(),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { code: string }).code;
}

/** Spend a code; the session value on success, null on refusal. */
async function spend(scope: Scope, code: string): Promise<string | null> {
  if (scope === "private") {
    const result = await exchangePrivateGrant(env(), { code, userAgent: null, clientIp: null });
    return result.ok ? result.session : null;
  }
  const res = await app.request(
    "/auth/docs/exchange",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    },
    env(),
  );
  return res.status === 200 ? ((await res.json()) as { session: string }).session : null;
}

/** Is this session value still honored by the host it belongs to? */
async function works(scope: Scope, session: string): Promise<boolean> {
  if (scope === "private") {
    return (await resolvePrincipal(env(), { kind: "session", value: session })).ok;
  }
  const res = await app.request(
    "/auth/docs/verify",
    { headers: { [DOCS_SESSION_HEADER]: session } },
    env(),
  );
  return res.status === 200;
}

/** Sign the target in to `scope`, and hold a second, unspent code too. */
async function signIn(scope: Scope, appCookie?: string) {
  const cookie = appCookie ?? (await appSession());
  const session = await spend(scope, await grant(scope, cookie));
  if (!session) throw new Error(`could not sign in to ${scope}`);
  const unspentCode = await grant(scope, cookie);
  expect(await works(scope, session)).toBe(true);
  return { appCookie: cookie, session, unspentCode };
}

function grantRows(scope: Scope): number {
  const table = scope === "private" ? "private_grants" : "docs_grants";
  return (
    db
      .query<{ n: number }, [number]>(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`)
      .get(targetId)?.n ?? 0
  );
}

function ownerRequest(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(
    path,
    {
      method,
      headers: {
        Authorization: `Bearer ${OWNER_KEY}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    env(),
  );
}

// --------------------------------------------------------------------------
// The cascade
// --------------------------------------------------------------------------

const ENDING_EVENTS: readonly {
  name: string;
  run: (appCookie: string) => Promise<Response>;
  restorable: boolean;
}[] = [
  {
    name: "sign-out (/auth/logout)",
    run: (appCookie) =>
      app.request(
        "/auth/logout",
        { method: "POST", headers: { Cookie: `nemar_session=${appCookie}`, Origin: APP } },
        env(),
      ),
    restorable: false,
  },
  {
    name: "admin revoke by username",
    run: () => ownerRequest("POST", "/admin/revoke/scopetarget"),
    restorable: true,
  },
  {
    name: "admin revoke by id",
    run: () => ownerRequest("POST", `/admin/revoke/by-id/${targetId}`),
    restorable: true,
  },
  {
    name: "owner soft delete",
    run: () => ownerRequest("DELETE", `/admin/users/by-id/${targetId}`),
    restorable: false,
  },
];

for (const event of ENDING_EVENTS) {
  describe(`${event.name} ends both host-scoped credentials`, () => {
    for (const scope of SCOPES) {
      test(`${scope}: the session and every outstanding grant`, async () => {
        const { appCookie, session, unspentCode } = await signIn(scope);
        expect(grantRows(scope)).toBe(1);

        expect((await event.run(appCookie)).status).toBe(200);

        expect(await works(scope, session)).toBe(false);
        expect(grantRows(scope)).toBe(0);
        expect(await spend(scope, unspentCode)).toBeNull();
      });
    }

    if (event.restorable) {
      for (const scope of SCOPES) {
        test(`${scope}: restoring the account does not restore the credential`, async () => {
          // The status is restored with an UPDATE, the strongest form of the
          // precondition: it grants everything approval would, and the old
          // session and code still must not come back.
          const { appCookie, session, unspentCode } = await signIn(scope);
          expect((await event.run(appCookie)).status).toBe(200);
          db.run("UPDATE users SET status = 'approved', revoked_at = NULL WHERE id = ?", [
            targetId,
          ]);
          expect(await works(scope, session)).toBe(false);
          expect(await spend(scope, unspentCode)).toBeNull();
        });
      }
    }
  });
}

describe("sign-out ends both scopes in one transaction", () => {
  test("docs and private together, from one app cookie", async () => {
    const appCookie = await appSession();
    const docs = await signIn("docs", appCookie);
    const priv = await signIn("private", appCookie);
    const out = await app.request(
      "/auth/logout",
      { method: "POST", headers: { Cookie: `nemar_session=${appCookie}`, Origin: APP } },
      env(),
    );
    expect(out.status).toBe(200);
    expect(await works("docs", docs.session)).toBe(false);
    expect(await works("private", priv.session)).toBe(false);
  });

  test("a failure in the private half leaves nothing revoked, so the retry finishes it", async () => {
    // The same one-transaction property `docs-auth-routes.test.ts` proves for
    // the docs half, extended to the new statements: `private_grants` is
    // renamed out from under the last one, so the batch rolls back whole and
    // the app row stays live to resolve the account on the retry.
    const appCookie = await appSession();
    const priv = await signIn("private", appCookie);
    const logout = () =>
      app.request(
        "/auth/logout",
        { method: "POST", headers: { Cookie: `nemar_session=${appCookie}`, Origin: APP } },
        env(),
      );

    db.run("ALTER TABLE private_grants RENAME TO private_grants_broken");
    expect((await logout()).status).toBe(200);
    expect(await works("private", priv.session)).toBe(true);

    db.run("ALTER TABLE private_grants_broken RENAME TO private_grants");
    expect((await logout()).status).toBe(200);
    expect(await works("private", priv.session)).toBe(false);
  });

  test("a lapsed app cookie still ends the private scope and purges its grants", async () => {
    // The app session's windows and the private session's do not nest (24
    // hours from sign-in against eight from the mint), so signing out with a
    // cookie that has already expired is ordinary. `/auth/logout` resolves the
    // account from the unrevoked row regardless of expiry, as it does for docs.
    const { appCookie, session, unspentCode } = await signIn("private");
    db.run(
      "UPDATE web_sessions SET expires_at = datetime('now', '-1 hour') WHERE user_id = ? AND scope = 'app'",
      [targetId],
    );
    const out = await app.request(
      "/auth/logout",
      { method: "POST", headers: { Cookie: `nemar_session=${appCookie}`, Origin: APP } },
      env(),
    );
    expect(out.status).toBe(200);
    expect(await works("private", session)).toBe(false);
    expect(grantRows("private")).toBe(0);
    expect(await spend("private", unspentCode)).toBeNull();
  });

  test("a failed sign-out batch is logged with the account id", async () => {
    // Still 200 (the person asked to sign out, and the cookie is cleared
    // either way), but the log line names whose credentials were left live.
    const { appCookie } = await signIn("private");
    db.run("ALTER TABLE private_grants RENAME TO private_grants_broken");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await app.request(
        "/auth/logout",
        { method: "POST", headers: { Cookie: `nemar_session=${appCookie}`, Origin: APP } },
        env(),
      );
      expect(out.status).toBe(200);
      const lines = errors.mock.calls.map((args) => String(args[0]));
      expect(lines.some((line) => line.includes(`for user ${targetId}`))).toBe(true);
    } finally {
      errors.mockRestore();
      db.run("ALTER TABLE private_grants_broken RENAME TO private_grants");
    }
  });

  test("another account's private session survives this account's sign-out", async () => {
    const otherId = await seedUser("scopebystander", "member", "person");
    const { cookieIdRaw } = await issueSession(env(), otherId, false, "ua", "127.0.0.1", "orcid");
    const otherSession = await spend("private", await grant("private", cookieIdRaw));
    if (!otherSession) throw new Error("bystander sign-in failed");

    const { appCookie } = await signIn("private");
    await app.request(
      "/auth/logout",
      { method: "POST", headers: { Cookie: `nemar_session=${appCookie}`, Origin: APP } },
      env(),
    );
    expect(await works("private", otherSession)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Deliberately outside the private cascade
// --------------------------------------------------------------------------

describe("a role demotion ends the docs credential and leaves the private one", () => {
  test("docs ends, private survives and reports the new role", async () => {
    const appCookie = await appSession();
    const docs = await signIn("docs", appCookie);
    const priv = await signIn("private", appCookie);

    const res = await ownerRequest("POST", "/admin/users/scopetarget/role", { role: "member" });
    expect(res.status).toBe(200);

    expect(await works("docs", docs.session)).toBe(false);
    expect(grantRows("docs")).toBe(0);

    const principal = await resolvePrincipal(env(), { kind: "session", value: priv.session });
    expect(principal.ok && principal.principal.role).toBe("member");
    expect(grantRows("private")).toBe(1);
    expect(await spend("private", priv.unspentCode)).not.toBeNull();
  });
});

describe("revoking an API key ends the docs credential and leaves the private one", () => {
  function targetKeyId(): number {
    const row = db
      .query<{ id: number }, [number]>("SELECT id FROM tokens WHERE user_id = ?")
      .get(targetId);
    if (!row) throw new Error("no target key");
    return row.id;
  }

  async function keyRevokeCase(revoke: () => Promise<Response>) {
    const appCookie = await appSession();
    const docs = await signIn("docs", appCookie);
    const priv = await signIn("private", appCookie);

    expect((await revoke()).status).toBe(200);

    // A docs session can be minted from a key, so the key's end reaches it.
    expect(await works("docs", docs.session)).toBe(false);
    expect(grantRows("docs")).toBe(0);
    expect(await spend("docs", docs.unspentCode)).toBeNull();
    // A private session never is, so it stands.
    expect(await works("private", priv.session)).toBe(true);
    expect(await spend("private", priv.unspentCode)).not.toBeNull();
  }

  test("self-service, by id (DELETE /auth/keys/:id)", async () => {
    await keyRevokeCase(() =>
      app.request(
        `/auth/keys/${targetKeyId()}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${TARGET_KEY}` } },
        env(),
      ),
    );
  });

  test("by the owner (DELETE /admin/users/:username/keys/:id)", async () => {
    // The route that revoked only the key row: an owner cleaning up a leaked
    // key left the docs session it had minted reading the gated pages.
    await keyRevokeCase(() =>
      ownerRequest("DELETE", `/admin/users/scopetarget/keys/${targetKeyId()}`),
    );
  });

  test("by key regeneration (GET /auth/confirm-key-regeneration)", async () => {
    // The emailed link revokes EVERY key on the account and issues a new one,
    // and used to leave any docs session minted from the old keys readable.
    // The token and its expiry are what `POST /auth/request-key-regeneration`
    // writes; the expiry is a JS timestamp because the route compares it in JS.
    db.run("UPDATE users SET verification_token = ?, verification_expires_at = ? WHERE id = ?", [
      "scope-cascade-regeneration-token",
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      targetId,
    ]);
    await keyRevokeCase(() =>
      app.request(
        "/auth/confirm-key-regeneration?token=scope-cascade-regeneration-token",
        {},
        env(),
      ),
    );
    const live = db
      .query<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND revoked_at IS NULL",
      )
      .get(targetId);
    // Only the regenerated key is left.
    expect(live?.n).toBe(1);
  });

  test("self-service, the presenting key (DELETE /auth/keys/current)", async () => {
    await keyRevokeCase(() =>
      app.request(
        "/auth/keys/current",
        { method: "DELETE", headers: { Authorization: `Bearer ${TARGET_KEY}` } },
        env(),
      ),
    );
  });
});
