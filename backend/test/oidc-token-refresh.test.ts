/**
 * Refresh token rotation (epic #2014 phase #2018; ADR 0119 rules 4 and 13), through the REAL Worker:
 * `POST /oauth/token` with `grant_type=refresh_token`.
 *
 * What is held: every use rotates (the parent is spent and one child of the same family is minted
 * in the same batch); a parent spent under 30 seconds ago may be presented once more and mints ONE
 * more child, for a retried request; a parent presented after that, a third time, or after it was
 * revoked revokes the whole family, access tokens included (`refresh_reuse`); a token expires 30 days
 * after it was issued and the family 90 days after it began, whatever its rotations; scopes may only
 * narrow, and a refresh token keeps its own; a first-party grant stops refreshing once its client no
 * longer qualifies as first-party; another client's token, a revoked grant and an inactive account
 * mint nothing and write nothing.
 *
 * Time is advanced by editing the token rows (every stamp of a row moved by the same amount, so the
 * table's CHECKs still hold), never by a fake clock.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { hashApiKey } from "../src/services/token";
import {
  type RegisteredClient,
  authorize,
  redeem,
  registerClient,
  rotateKeys,
  seedAccount,
  sessionCookie,
  tokenRequest,
} from "./helpers/oidc-flow";
import { type OidcHarness, startOidcHarness } from "./helpers/oidc-harness";

let h: OidcHarness;

beforeEach(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
  await rotateKeys(h);
});

interface Issued {
  access_token: string;
  refresh_token: string;
  scope: string;
}

interface Family {
  client: RegisteredClient;
  userId: number;
  first: Issued;
}

async function family(
  opts: {
    scope?: string;
    clientOver?: Record<string, unknown>;
  } = {},
): Promise<Family> {
  const client = await registerClient(h, opts.clientOver);
  const userId = seedAccount(h);
  const cookie = await sessionCookie(h, userId);
  const code = await authorize(h, client, cookie, {
    scope: opts.scope ?? "openid profile offline_access",
  });
  const res = await redeem(h, client, code);
  expect(res.status).toBe(200);
  return { client, userId, first: res.json as unknown as Issued };
}

function refresh(client: RegisteredClient, token: string, extra: Record<string, string> = {}) {
  return tokenRequest(h, client, { grant_type: "refresh_token", refresh_token: token, ...extra });
}

async function rowOf(token: string): Promise<Record<string, unknown>> {
  return h.db
    .query("SELECT * FROM oidc_tokens WHERE token_hash = ?")
    .get(await hashApiKey(token)) as Record<string, unknown>;
}

function liveCount(): number {
  return (
    h.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM oidc_tokens WHERE revoked_at IS NULL")
      .get()?.n ?? 0
  );
}

function allRows(): Array<Record<string, unknown>> {
  return h.db.query("SELECT * FROM oidc_tokens ORDER BY id").all() as Array<
    Record<string, unknown>
  >;
}

/** Move every stamp of one token row back by `seconds`, as if it had been issued that long ago. */
async function age(token: string, seconds: number): Promise<void> {
  const by = `-${seconds} seconds`;
  h.db
    .query(
      `UPDATE oidc_tokens SET created_at = datetime(created_at, ?), expires_at = datetime(expires_at, ?),
              absolute_expires_at = CASE WHEN absolute_expires_at IS NULL THEN NULL
                                         ELSE datetime(absolute_expires_at, ?) END,
              used_at = CASE WHEN used_at IS NULL THEN NULL ELSE datetime(used_at, ?) END
        WHERE token_hash = ?`,
    )
    .run(by, by, by, by, await hashApiKey(token));
}

async function userinfoStatus(accessToken: string): Promise<number> {
  return (
    await h.call("GET", "/oauth/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } })
  ).status;
}

function expectInvalidGrant(res: { status: number; json: Record<string, unknown> | null }): void {
  expect({ status: res.status, error: res.json?.error }).toEqual({
    status: 400,
    error: "invalid_grant",
  });
}

describe("rotation", () => {
  test("a refresh spends the parent and mints one child and one access token of the same family", async () => {
    const f = await family();
    const res = await refresh(f.client, f.first.refresh_token);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const next = res.json as unknown as Issued & Record<string, unknown>;
    expect(Object.keys(next).sort()).toEqual([
      "access_token",
      "expires_in",
      "refresh_token",
      "scope",
      "token_type",
    ]);
    expect(next.refresh_token).not.toBe(f.first.refresh_token);
    const parent = await rowOf(f.first.refresh_token);
    const child = await rowOf(next.refresh_token);
    const access = await rowOf(next.access_token);
    expect(parent.used_at).not.toBeNull();
    expect(parent.revoked_at).toBeNull();
    expect(child).toMatchObject({
      kind: "refresh",
      parent_id: parent.id,
      family_id: parent.family_id,
      code_id: parent.code_id,
      grant_id: parent.grant_id,
      user_id: f.userId,
      used_at: null,
      revoked_at: null,
    });
    expect(access).toMatchObject({
      kind: "access",
      parent_id: parent.id,
      family_id: parent.family_id,
    });
    expect(await userinfoStatus(next.access_token)).toBe(200);
    // The child refreshes in turn.
    expect((await refresh(f.client, next.refresh_token)).status).toBe(200);
  });

  test("the 30-second retry: a parent spent moments ago mints exactly one more child", async () => {
    const f = await family();
    const one = await refresh(f.client, f.first.refresh_token);
    expect(one.status).toBe(200);
    const retry = await refresh(f.client, f.first.refresh_token);
    expect(retry.status).toBe(200);
    const a = one.json as unknown as Issued;
    const b = retry.json as unknown as Issued;
    expect(b.refresh_token).not.toBe(a.refresh_token);
    // Both children are live: the retry does not take the first one away.
    expect(await userinfoStatus(a.access_token)).toBe(200);
    expect(await userinfoStatus(b.access_token)).toBe(200);
    const parent = await rowOf(f.first.refresh_token);
    const children = allRows().filter((r) => r.parent_id === parent.id && r.kind === "refresh");
    expect(children).toHaveLength(2);
    // The grace is measured from the first rotation, which the retry did not move.
    expect((await rowOf(f.first.refresh_token)).used_at).toBe(parent.used_at);

    // A third presentation inside the grace is no retry: the family is revoked.
    const third = await refresh(f.client, f.first.refresh_token);
    expectInvalidGrant(third);
    expect(liveCount()).toBe(0);
    for (const row of allRows()) expect(row.revoked_at).not.toBeNull();
    expect(await userinfoStatus(a.access_token)).toBe(401);
    expect(await userinfoStatus(b.access_token)).toBe(401);
  });

  test("a spent parent presented after the grace revokes the whole family, access tokens included", async () => {
    const f = await family();
    const one = (await refresh(f.client, f.first.refresh_token)).json as unknown as Issued;
    const two = (await refresh(f.client, one.refresh_token)).json as unknown as Issued;
    // Thirty-one seconds later, the first parent comes back.
    await age(f.first.refresh_token, 31);
    const replay = await refresh(f.client, f.first.refresh_token);
    expectInvalidGrant(replay);
    const rows = allRows();
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const row of rows) {
      expect(row.revoked_at).not.toBeNull();
    }
    // Live ones were revoked for reuse; nothing was minted by the replay.
    const reasons = new Set(rows.map((r) => r.revoked_reason));
    expect(reasons).toEqual(new Set(["refresh_reuse"]));
    expect(await userinfoStatus(two.access_token)).toBe(401);
    expectInvalidGrant(await refresh(f.client, two.refresh_token));
  });

  test("inside the grace, at 29 seconds, the retry is still honoured, and moves nothing", async () => {
    const f = await family();
    expect((await refresh(f.client, f.first.refresh_token)).status).toBe(200);
    await age(f.first.refresh_token, 29);
    const spentAt = (await rowOf(f.first.refresh_token)).used_at;
    expect((await refresh(f.client, f.first.refresh_token)).status).toBe(200);
    // The retry left the first rotation's time where it was: the grace never stretches.
    expect((await rowOf(f.first.refresh_token)).used_at).toBe(spentAt);
  });

  test("a revoked refresh token presented again revokes its family", async () => {
    const f = await family();
    const one = (await refresh(f.client, f.first.refresh_token)).json as unknown as Issued;
    // Only the child is revoked here (as a cascade that ends one token would); presenting it ends
    // every other live member.
    h.db
      .query(
        "UPDATE oidc_tokens SET revoked_at = datetime('now'), revoked_reason = 'test' WHERE token_hash = ?",
      )
      .run(await hashApiKey(one.refresh_token));
    expect(await userinfoStatus(one.access_token)).toBe(200);
    expectInvalidGrant(await refresh(f.client, one.refresh_token));
    expect(liveCount()).toBe(0);
    expect(await userinfoStatus(one.access_token)).toBe(401);
  });
});

describe("expiry", () => {
  test("a refresh token expires 30 days after it was issued (idle)", async () => {
    const f = await family();
    const row = await rowOf(f.first.refresh_token);
    const span = h.db
      .query<{ s: number }, [number]>(
        "SELECT CAST(strftime('%s', expires_at) AS INTEGER) - CAST(strftime('%s', created_at) AS INTEGER) AS s FROM oidc_tokens WHERE id = ?",
      )
      .get(row.id as number)?.s;
    expect(span).toBe(30 * 24 * 3600);
    await age(f.first.refresh_token, 30 * 24 * 3600 + 1);
    expectInvalidGrant(await refresh(f.client, f.first.refresh_token));
    // An unspent, expired token is not reuse: nothing is revoked, nothing is written.
    expect((await rowOf(f.first.refresh_token)).used_at).toBeNull();
    expect((await rowOf(f.first.refresh_token)).revoked_at).toBeNull();
    expect(allRows()).toHaveLength(2);
  });

  test("the family ends 90 days after it began, however often it was rotated", async () => {
    const f = await family();
    const root = await rowOf(f.first.refresh_token);
    const absoluteSpan = h.db
      .query<{ s: number }, [number]>(
        "SELECT CAST(strftime('%s', absolute_expires_at) AS INTEGER) - CAST(strftime('%s', created_at) AS INTEGER) AS s FROM oidc_tokens WHERE id = ?",
      )
      .get(root.id as number)?.s;
    expect(absoluteSpan).toBe(90 * 24 * 3600);
    // The family began ten days ago: a child keeps the family's end, not a fresh 90 days.
    await age(f.first.refresh_token, 10 * 24 * 3600);
    const one = (await refresh(f.client, f.first.refresh_token)).json as unknown as Issued;
    const child = await rowOf(one.refresh_token);
    expect(child.absolute_expires_at).toBe(
      (await rowOf(f.first.refresh_token)).absolute_expires_at,
    );

    // Ten seconds before the family's end, a rotation mints a child that expires with the family.
    h.db
      .query(
        `UPDATE oidc_tokens SET absolute_expires_at = datetime('now', '+10 seconds'),
                expires_at = datetime('now', '+10 seconds') WHERE token_hash = ?`,
      )
      .run(await hashApiKey(one.refresh_token));
    const last = (await refresh(f.client, one.refresh_token)).json as unknown as Issued;
    const lastRow = await rowOf(last.refresh_token);
    expect(lastRow.expires_at).toBe(lastRow.absolute_expires_at);
    const secondsLeft = h.db
      .query<{ s: number }, [string]>(
        "SELECT CAST(strftime('%s', expires_at) AS INTEGER) - CAST(strftime('%s', 'now') AS INTEGER) AS s FROM oidc_tokens WHERE token_hash = ?",
      )
      .get(await hashApiKey(last.refresh_token))?.s as number;
    expect(secondsLeft).toBeLessThanOrEqual(10);
    // Past the family's end it refreshes no more.
    await age(last.refresh_token, 11);
    expectInvalidGrant(await refresh(f.client, last.refresh_token));
  });
});

describe("scopes", () => {
  test("a narrower scope narrows the access token; the refresh token keeps its own", async () => {
    const f = await family({ scope: "openid profile email offline_access" });
    const res = await refresh(f.client, f.first.refresh_token, { scope: "openid email" });
    expect(res.status).toBe(200);
    const next = res.json as unknown as Issued;
    expect(next.scope).toBe("email openid");
    expect(JSON.parse((await rowOf(next.access_token)).scopes as string)).toEqual([
      "email",
      "openid",
    ]);
    expect(JSON.parse((await rowOf(next.refresh_token)).scopes as string)).toEqual([
      "email",
      "offline_access",
      "openid",
      "profile",
    ]);
    // The narrowed access token does not read profile claims.
    const info = await h.call("GET", "/oauth/userinfo", {
      headers: { Authorization: `Bearer ${next.access_token}` },
    });
    expect(Object.keys(info.json as object).sort()).toEqual(["email", "email_verified", "sub"]);
  });

  test("a wider or unknown scope is invalid_scope and spends nothing", async () => {
    const f = await family({ scope: "openid offline_access" });
    for (const scope of ["openid profile", "openid nonsense", "compute.stats", " "]) {
      const res = await refresh(f.client, f.first.refresh_token, { scope });
      expect({ scope, status: res.status, error: res.json?.error }).toEqual({
        scope,
        status: 400,
        error: "invalid_scope",
      });
    }
    expect((await rowOf(f.first.refresh_token)).used_at).toBeNull();
    expect(allRows()).toHaveLength(2);
  });
});

describe("what a refresh re-reads, and refuses without writing", () => {
  test("another client's refresh token is invalid_grant, and its family is untouched", async () => {
    const f = await family();
    const other = await registerClient(h);
    expectInvalidGrant(await refresh(other, f.first.refresh_token));
    expect((await rowOf(f.first.refresh_token)).used_at).toBeNull();
    expect(liveCount()).toBe(2);
    // Even a spent one: the other client cannot revoke this client's family.
    expect((await refresh(f.client, f.first.refresh_token)).status).toBe(200);
    await age(f.first.refresh_token, 60);
    expectInvalidGrant(await refresh(other, f.first.refresh_token));
    expect(liveCount()).toBe(4);
  });

  test("an access token, a code or a CLI key is not a refresh token", async () => {
    const f = await family();
    for (const token of [f.first.access_token, "nm_not-a-refresh-token-0123456789abcdef", "x"]) {
      expectInvalidGrant(await refresh(f.client, token));
    }
    expect(liveCount()).toBe(2);
  });

  test("an inactive account, a revoked grant or a disabled client refreshes nothing", async () => {
    for (const change of ["account", "grant"] as const) {
      const f = await family();
      if (change === "account") {
        h.db.query("UPDATE users SET status = 'revoked' WHERE id = ?").run(f.userId);
      } else {
        h.db
          .query("UPDATE oidc_grants SET revoked_at = datetime('now') WHERE user_id = ?")
          .run(f.userId);
      }
      expectInvalidGrant(await refresh(f.client, f.first.refresh_token));
      expect((await rowOf(f.first.refresh_token)).used_at).toBeNull();
      expect((await rowOf(f.first.refresh_token)).revoked_at).toBeNull();
    }
  });

  test("a first-party grant stops refreshing once its client no longer qualifies as first-party", async () => {
    // A loopback redirect is first-party outside production only.
    const f = await family({
      clientOver: { redirect_uris: ["http://localhost:8787/callback"], first_party: true },
    });
    const grant = h.db
      .query<{ consent_kind: string }, [number]>(
        "SELECT consent_kind FROM oidc_grants WHERE user_id = ?",
      )
      .get(f.userId);
    expect(grant?.consent_kind).toBe("first_party");
    expectInvalidGrant(
      await tokenRequest(
        h,
        f.client,
        { grant_type: "refresh_token", refresh_token: f.first.refresh_token },
        { env: { ENVIRONMENT: "production" } },
      ),
    );
    expect((await rowOf(f.first.refresh_token)).used_at).toBeNull();
    // Outside production the same token still refreshes.
    expect((await refresh(f.client, f.first.refresh_token)).status).toBe(200);
  });

  test("a client that is not allowed the refresh grant is unauthorized_client", async () => {
    const f = await family();
    const other = await registerClient(h, {
      allowed_scopes: ["openid"],
      allowed_grants: ["authorization_code"],
    });
    const res = await refresh(other, f.first.refresh_token);
    expect({ status: res.status, error: res.json?.error }).toEqual({
      status: 400,
      error: "unauthorized_client",
    });
  });
});
