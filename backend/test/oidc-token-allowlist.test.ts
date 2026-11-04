/**
 * An OpenID Connect access token authenticates NOTHING outside the OIDC routes (epic #2014 phase
 * #2018; ADR 0119 rule 4).
 *
 * The request list is the Worker's own route table (`__workerRouteTable`), not a list written here,
 * so a route added later is called by this test the day it exists. Every route is called twice
 * through the REAL Worker, once with a live access token minted by the real flow (for an account that
 * passes every rule, holding every scope a person can grant) and once with an unknown key of the API
 * key's shape, and the two answers must agree: the same status, the same body for a success (the
 * anonymous answer), and the same kind of refusal otherwise. Wherever the unknown key meets the
 * API-key refusal, the access token must meet the OIDC one (`oidc_token_not_accepted`), which is what
 * proves the token was recognized and refused rather than looked up as a key. And no answer to the
 * access token may carry anything of its account.
 *
 * The OIDC routes themselves are the allowlist: discovery, the key set and the four `/oauth`
 * endpoints. `oidcBearer` is checked by reference on the same table: it may sit only on userinfo.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { COMPOSED_HANDLER } from "hono/utils/constants";
import { __workerRouteTable } from "../src/index";
import { isOidcBearerMiddleware } from "../src/middleware/oidc-bearer";
import { resolvePrincipal } from "../src/rpc/principal";
import {
  authorize,
  redeem,
  registerClient,
  rotateKeys,
  seedAccount,
  sessionCookie,
} from "./helpers/oidc-flow";
import { type OidcHarness, startOidcHarness } from "./helpers/oidc-harness";

/** The OIDC routes, under either mount: the only paths an OIDC token may be meant for. */
const OIDC_ROUTE_RE =
  /^(\/nemar)?(\/\.well-known\/openid-configuration|\/oauth\/(jwks|token|userinfo|revoke|introspect))$/;

/** Where `oidcBearer` may sit: the resource routes that serve a scope. Today, userinfo only. */
const OIDC_BEARER_ROUTE_RE = /^(\/nemar)?\/oauth\/userinfo$/;

/** A value for every path parameter the table uses; an absent dataset, client, key or account. */
const PARAM_VALUES: Record<string, string> = {
  id: "nm099900",
  datasetId: "nm099900",
  dataset: "nm099900",
  version: "1.0.0",
  client_id: `oc_${"0".repeat(24)}`,
  kid: "0".repeat(16),
  sub: `nmu_${"0".repeat(32)}`,
  userId: "999999",
  username: "nobody-zz",
  login: "nobody-zz",
  name: "x",
  pr: "1",
  slug: "x",
  sourceId: "ds999999",
  tag: "x",
  file: "x",
};

/** An API key nobody holds: `nm_` and 43 base64url characters, the shape `generateApiKey` makes. */
const UNKNOWN_KEY = `nm_${"Q".repeat(43)}`;

/** What `resolveBearerUser` answers for a key that is not live. */
const API_KEY_REFUSAL = "Invalid or expired API key";

interface Call {
  method: string;
  path: string;
}

/** Every distinct (method, path) of the table, with path parameters filled in; middleware left out. */
function requestList(): Call[] {
  const seen = new Set<string>();
  const out: Call[] = [];
  for (const route of __workerRouteTable()) {
    // `use(...)` registers as ALL with a wildcard: that is middleware, not a route. `app.all(path)`
    // without one is a route, called with GET and POST.
    if (route.method === "ALL" && route.path.includes("*")) continue;
    if (OIDC_ROUTE_RE.test(route.path)) continue;
    const methods = route.method === "ALL" ? ["GET", "POST"] : [route.method];
    const path = route.path
      .replace(/:([A-Za-z_]+)(\{[^}]*\})?/g, (_m, name: string) => {
        const value = PARAM_VALUES[name];
        if (value === undefined) throw new Error(`no test value for the path parameter :${name}`);
        return value;
      })
      .replace(/\*/g, "x");
    for (const method of methods) {
      const key = `${method} ${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ method, path });
    }
  }
  return out;
}

/**
 * A success body with the values that differ between any two calls blanked: times, request ids, and
 * what a public route mints afresh for every caller (the device flow's codes and its address that
 * carries one). Keys only, so a value that names an account still differs and still fails.
 */
function stable(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), (key, value) =>
      /time|date|_at$|^at$|request_?id|nonce|etag|_code$|_complete$/i.test(key)
        ? "<varies>"
        : value,
    );
  } catch {
    return text.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<time>");
  }
}

/** What kind of refusal a body is: its top-level keys, or its content type when it is not JSON. */
function refusalClass(res: { json: Record<string, unknown> | null; headers: Headers }): string {
  if (res.json) return Object.keys(res.json).sort().join(",");
  return `non-json:${res.headers.get("Content-Type") ?? ""}`;
}

let h: OidcHarness;
let accessToken: string;
let refreshToken: string;
let clientSecret: string;
let accountFingerprints: string[];

beforeAll(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
  await rotateKeys(h);
  const client = await registerClient(h);
  const orcid = "0000-0002-1825-0097";
  const userId = seedAccount(h, {
    status: "approved",
    serviceAccess: true,
    orcid,
    identity: orcid,
  });
  // An administrator, so a route that would honour the token would have every reason to.
  h.db.query("UPDATE users SET role = 'owner' WHERE id = ?").run(userId);
  const cookie = await sessionCookie(h, userId);
  const code = await authorize(h, client, cookie, {
    scope: "openid profile email orcid nemar.account offline_access",
  });
  const res = await redeem(h, client, code);
  expect(res.status).toBe(200);
  const issued = res.json as { access_token: string; refresh_token: string };
  accessToken = issued.access_token;
  refreshToken = issued.refresh_token;
  clientSecret = client.secret;
  const account = h.db
    .query<{ username: string; email: string; oidc_subject: string }, [number]>(
      "SELECT username, email, oidc_subject FROM users WHERE id = ?",
    )
    .get(userId);
  accountFingerprints = [
    account?.username as string,
    account?.email as string,
    account?.oidc_subject as string,
  ];
  // The token is live where it is meant to be.
  const info = await h.call("GET", "/oauth/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(info.status).toBe(200);
});

async function callWith(call: Call, token: string) {
  const write = !["GET", "HEAD", "OPTIONS"].includes(call.method);
  return h.call(call.method, call.path, {
    key: token,
    ...(write ? { body: {} } : {}),
  });
}

describe("an OIDC access token is refused by every route that is not an OIDC route", () => {
  test("the table is read, and is large enough that this is not vacuous", () => {
    const list = requestList();
    expect(list.length).toBeGreaterThan(300);
    // The OIDC routes are in the table and are the ones left out.
    const all = __workerRouteTable().map((r) => r.path);
    for (const path of ["/oauth/token", "/oauth/userinfo", "/oauth/revoke", "/oauth/introspect"]) {
      expect(all).toContain(path);
    }
  });

  test(
    "every route answers the access token exactly as it answers an unknown API key",
    async () => {
      const list = requestList();
      const mismatches: string[] = [];
      const leaks: string[] = [];
      let oidcRefusals = 0;
      let calls = 0;
      for (const call of list) {
        calls += 1;
        const unknown = await callWith(call, UNKNOWN_KEY);
        const oidc = await callWith(call, accessToken);
        const label = `${call.method} ${call.path}`;
        for (const fingerprint of accountFingerprints) {
          if (oidc.text.includes(fingerprint)) leaks.push(label);
        }
        if (oidc.status !== unknown.status) {
          mismatches.push(`${label}: status ${oidc.status} vs ${unknown.status}`);
          continue;
        }
        if (unknown.status < 400) {
          if (stable(oidc.text) !== stable(unknown.text)) mismatches.push(`${label}: body`);
          continue;
        }
        if (unknown.json?.error === API_KEY_REFUSAL) {
          // The key path refused the unknown key; it must have recognized the OIDC token as one.
          if (oidc.json?.code !== "oidc_token_not_accepted") {
            mismatches.push(`${label}: not refused as an OIDC token (${oidc.text.slice(0, 80)})`);
          } else {
            oidcRefusals += 1;
          }
          continue;
        }
        if (refusalClass(oidc) !== refusalClass(unknown)) {
          mismatches.push(`${label}: refusal ${refusalClass(oidc)} vs ${refusalClass(unknown)}`);
        }
      }
      expect(mismatches).toEqual([]);
      expect(leaks).toEqual([]);
      expect(calls).toBe(list.length);
      // Most authenticated routes go through the key path; a handful is a sign the token was not sent.
      expect(oidcRefusals).toBeGreaterThan(100);
    },
    { timeout: 120_000 },
  );

  test("the refresh token and the client secret are refused the same way", async () => {
    for (const token of [refreshToken, clientSecret]) {
      // Routes behind the key path. An optional-auth route (`/datasets?mine=true`) answers both
      // tokens with its anonymous branch, which the table-wide test above already compares.
      for (const path of ["/users/me", "/auth/keys", "/admin/users"]) {
        const res = await h.call("GET", path, { key: token });
        expect({ path, status: res.status, code: res.json?.code }).toEqual({
          path,
          status: 401,
          code: "oidc_token_not_accepted",
        });
      }
    }
  });

  test("the service-binding entrypoint resolves an OIDC token to no one", async () => {
    for (const value of [accessToken, refreshToken]) {
      expect(await resolvePrincipal(h.env, { kind: "api_key", value })).toEqual({
        ok: false,
        error: "invalid_credential",
      });
    }
  });
});

describe("oidcBearer sits only on the routes that serve a scope", () => {
  test("every route that carries it is an allowlisted resource route, and userinfo carries it", () => {
    // Mounting a sub-app that has its own error handler wraps each of its handlers and keeps the
    // original under Hono's COMPOSED_HANDLER key (`app.route`), so unwrap before comparing.
    const unwrap = (handler: unknown): unknown => {
      let current = handler;
      while (typeof current === "function" && COMPOSED_HANDLER in current) {
        current = (current as unknown as Record<string, unknown>)[COMPOSED_HANDLER];
      }
      return current;
    };
    const carriers = __workerRouteTable().filter((r) => isOidcBearerMiddleware(unwrap(r.handler)));
    for (const route of carriers) {
      expect({
        route: `${route.method} ${route.path}`,
        allowed: OIDC_BEARER_ROUTE_RE.test(route.path),
      }).toEqual({ route: `${route.method} ${route.path}`, allowed: true });
    }
    const methods = carriers.filter((r) => r.path === "/oauth/userinfo").map((r) => r.method);
    expect(methods.sort()).toEqual(["GET", "POST"]);
  });
});
