/**
 * The `NemarApiRpc` entrypoint, wired end to end in workerd (ADR 0078).
 *
 * WHY THIS RUNS IN MINIFLARE. `rpc/entrypoint.ts` imports
 * `cloudflare:workers`, which bun cannot resolve, so no bun test can load the
 * class at all. What a bun test cannot see is exactly what this file is for:
 * that `src/worker.ts` (the Worker's `main`) still exports the HTTP app as its
 * default AND exports the class under the name a caller's binding names, and
 * that each method reaches the function behind it with a working `env`. So the
 * Worker is bundled by the PRODUCTION bundler (`wrangler deploy --dry-run
 * --outdir`, from `backend/`, with `wrangler-sccn.toml`; see `helpers/worker-bundle.ts`) and the bundle
 * runs in real workerd, next to a second Worker that holds a service binding
 * to it, the same shape the private site's Worker has in production. The rules
 * the methods apply are proven in `private-site-rpc.test.ts`.
 *
 * The D1 database is Miniflare's own, with every migration applied by
 * `helpers/miniflare-d1.ts` (which says what it changes in each file's text,
 * and why).
 *
 * The bundle is given to Miniflare as an explicit module rather than a
 * script: Hono's logger contains a dynamic `import()` of a computed specifier,
 * which Miniflare's module walker refuses and workerd itself resolves fine.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { NEMAR_API_RPC_ENTRYPOINT } from "../../shared/contract/private-site.js";
import { hashApiKey } from "../src/services/token";
import { hashCookieId } from "../src/services/web-session";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";
import { bundleWorker, wranglerCompatibility } from "./helpers/worker-bundle";

const API_KEY = "nm_rpc-entry-test-key-0123456789abcdef012345";
const APP_COOKIE = "rpc-entry-app-session-cookie-value-0123456789";

/**
 * The caller: a Worker whose only job is to call the binding and report what
 * came back, including a throw.
 *
 * Its arguments usually arrive as JSON, which can carry only what JSON can. A
 * request with `build` makes the caller construct a `describeAccounts` request
 * itself, so a value that exists only in a Worker (NaN, a bigint, a sparse
 * array, a Map, a function, an `RpcTarget`) crosses the binding as the RPC
 * serializer carries it, which no JSON body could show.
 */
const CALLER = `import { RpcTarget } from "cloudflare:workers";

const VALUES = {
  nan: () => Number.NaN,
  infinity: () => Number.POSITIVE_INFINITY,
  negativeZero: () => -0,
  bigint: () => 7n,
  sparse: () => { const a = new Array(3); a[0] = 1; return a; },
  hugeSparse: () => { const a = new Array(2 ** 32 - 1); a[0] = 1; return a; },
  map: () => new Map([[1, 2]]),
  set: () => new Set([1]),
  date: () => new Date(0),
  bytes: () => new Uint8Array([1]),
  fn: () => () => 1,
  target: () => new RpcTarget(),
  nested: () => [[1]],
};

export default {
  async fetch(request, env) {
    const { method, args, build } = await request.json();
    try {
      if (build) {
        const value = VALUES[build.value]();
        const userIds = build.placement === "element" ? [value] : value;
        return Response.json({
          result: await env.API[method]({ credential: build.credential, userIds }),
        });
      }
      return Response.json({ result: await env.API[method](...args) });
    } catch (err) {
      return Response.json({ thrown: String(err) }, { status: 500 });
    }
  },
};`;

let mf: Miniflare;
let d1: D1Database;

/** Call a binding method from inside the caller Worker. `getWorker()` rather
 *  than `dispatchFetch`, because under bun `dispatchFetch` cannot route by
 *  hostname (Miniflare carries the URL in an undici dispatcher, which bun's
 *  `fetch` ignores), so it always reaches the FIRST worker, which is the API. */
async function call(method: string, ...args: unknown[]): Promise<unknown> {
  const caller = await mf.getWorker("caller");
  const res = await caller.fetch("http://caller.test/", {
    method: "POST",
    body: JSON.stringify({ method, args }),
  });
  const body = (await res.json()) as { result?: unknown; thrown?: string };
  if (body.thrown) throw new Error(`the binding threw: ${body.thrown}`);
  return body.result;
}

/** Call `describeAccounts` with `userIds` built INSIDE the caller Worker from the
 *  named value, as the whole `userIds` or as its one element. */
async function callBuilt(
  credential: unknown,
  value: string,
  placement: "whole" | "element",
): Promise<unknown> {
  const caller = await mf.getWorker("caller");
  const res = await caller.fetch("http://caller.test/", {
    method: "POST",
    body: JSON.stringify({ method: "describeAccounts", build: { credential, value, placement } }),
  });
  const body = (await res.json()) as { result?: unknown; thrown?: string };
  if (body.thrown) throw new Error(`the binding threw: ${body.thrown}`);
  return body.result;
}

/** An HTTP request to the API Worker, the first in the list. Not through
 *  `getWorker()`, whose proxy path refuses any `Origin` Miniflare does not
 *  itself host, and the grant route needs one. */
async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return (await mf.dispatchFetch(`http://localhost${path}`, init as never)) as unknown as Response;
}

/** The browser's `state` and the grant request that carries it. */
const STATE = "EntryTestBrowserState-0123456789_abcdefghi";
const GRANT_REQUEST = {
  method: "POST",
  headers: {
    Cookie: `nemar_session=${APP_COOKIE}`,
    Origin: "https://app.nemar.org",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ state: STATE }),
};

let userId: number;

beforeAll(async () => {
  const { date, flags } = wranglerCompatibility();
  mf = new Miniflare({
    workers: [
      {
        name: "nemar-api",
        modules: [{ type: "ESModule", path: "worker.js", contents: bundleWorker() }],
        compatibilityDate: date,
        compatibilityFlags: flags,
        d1Databases: { DB: "nemar-db-rpc-entry-test" },
        // The documented rate-limit bypass, as the worker-driven bun tests use.
        bindings: { ENVIRONMENT: "development" },
      },
      {
        name: "caller",
        modules: true,
        script: CALLER,
        compatibilityDate: date,
        serviceBindings: { API: { name: "nemar-api", entrypoint: NEMAR_API_RPC_ENTRYPOINT } },
      },
    ],
  });
  d1 = (await mf.getD1Database("DB", "nemar-api")) as unknown as D1Database;

  await applyMigrations(d1, migrationFiles());

  await d1
    .prepare(
      `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified, account_kind)
       VALUES ('rpcentry', 'rpcentry@nemar.test', 'x', 'verified', 'member', 'web', 1, 'person')`,
    )
    .run();
  const row = await d1
    .prepare("SELECT id FROM users WHERE username = 'rpcentry'")
    .first<{ id: number }>();
  if (!row) throw new Error("seed failed");
  userId = row.id;
  await d1
    .prepare("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .bind(userId, await hashApiKey(API_KEY), API_KEY.slice(0, 8))
    .run();
  await d1
    .prepare(
      `INSERT INTO web_sessions (user_id, cookie_id_hash, expires_at, auth_method)
       VALUES (?, ?, datetime('now', '+1 hour'), 'orcid')`,
    )
    .bind(userId, await hashCookieId(APP_COOKIE))
    .run();
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
}, 30_000);

describe("src/worker.ts in workerd", () => {
  test("the default export is still the HTTP app", async () => {
    const res = await apiFetch("/health");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
  });

  test("resolvePrincipal answers through the binding, for a key and against one", async () => {
    const resolved = (await call("resolvePrincipal", { kind: "api_key", value: API_KEY })) as {
      ok: boolean;
      principal?: { userId: number; username: string; role: string };
    };
    expect(resolved.ok).toBe(true);
    expect(resolved.principal).toMatchObject({ userId, username: "rpcentry", role: "member" });

    expect(
      await call("resolvePrincipal", { kind: "api_key", value: `${API_KEY.slice(0, -1)}x` }),
    ).toEqual({ ok: false, error: "invalid_credential" });
  });

  test("describeAccounts answers through the binding, in the order asked, and refuses through it", async () => {
    const credential = { kind: "api_key", value: API_KEY };
    const absent = userId + 1_000_000;
    expect(await call("describeAccounts", { credential, userIds: [absent, userId] })).toEqual({
      ok: true,
      accounts: [
        { userId: absent, state: "gone" },
        {
          userId,
          state: "active",
          username: "rpcentry",
          givenName: null,
          familyName: null,
          orcid: null,
        },
      ],
    });
    expect(await call("describeAccounts", { credential, userIds: [] })).toEqual({
      ok: false,
      error: "invalid_request",
    });
    expect(
      await call("describeAccounts", {
        credential: { kind: "api_key", value: `${API_KEY.slice(0, -1)}x` },
        userIds: [userId],
      }),
    ).toEqual({ ok: false, error: "invalid_credential" });
  });

  describe("describeAccounts with ids built in the caller Worker", () => {
    // Values that JSON cannot carry, as the RPC serializer carries them. Every one
    // is `invalid_request` as the whole `userIds` and as the element of one, and
    // none throws: a refusal is a value, whatever crosses the binding (ADR 0078).
    // The huge sparse array has the longest length an array can have, so it shows
    // the serializer and the method carry it and answer at once; the length bound
    // itself is held at 101 ids in `private-site-rpc.test.ts`.
    const VALUES = [
      "nan",
      "infinity",
      "negativeZero",
      "bigint",
      "sparse",
      "hugeSparse",
      "map",
      "set",
      "date",
      "bytes",
      "fn",
      "target",
      "nested",
    ] as const;

    for (const value of VALUES) {
      test(`${value} is invalid_request, whole or as an element`, async () => {
        const credential = { kind: "api_key", value: API_KEY };
        for (const placement of ["whole", "element"] as const) {
          expect({
            value,
            placement,
            answer: await callBuilt(credential, value, placement),
          }).toEqual({ value, placement, answer: { ok: false, error: "invalid_request" } });
        }
      });
    }

    test("the control: a plain array of ids built in the caller is answered", async () => {
      // Shows the harness reaches the method with a request that is valid, so the
      // refusals above are the method's and not a failure of the path.
      const caller = await mf.getWorker("caller");
      const res = await caller.fetch("http://caller.test/", {
        method: "POST",
        body: JSON.stringify({
          method: "describeAccounts",
          args: [{ credential: { kind: "api_key", value: API_KEY }, userIds: [userId] }],
        }),
      });
      const body = (await res.json()) as { result: { ok: boolean } };
      expect(body.result.ok).toBe(true);
    });
  });

  test("describeAccounts reads D1's own flags and takes 100 ids in one statement", async () => {
    // What a bun test cannot show: the flags come back from D1's binding as the
    // integers the rules compare with, and 100 bound ids are one statement.
    const insert = (
      name: string,
      status: string,
      orcid: string,
      verified: number,
      conflict: number,
    ) =>
      d1
        .prepare(
          `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified,
                              given_name, family_name, orcid, orcid_verified, identity_conflict, account_kind)
           VALUES (?, ?, 'x', ?, 'member', 'web', 1, 'Given', 'Family', ?, ?, ?, 'person')`,
        )
        .bind(name, `${name}@nemar.test`, status, orcid, verified, conflict)
        .run();
    const idOf = async (name: string) =>
      (
        await d1
          .prepare("SELECT id FROM users WHERE username = ?")
          .bind(name)
          .first<{ id: number }>()
      )?.id ?? 0;

    const ORCID = "0000-0002-1825-0097";
    await insert("described-canonical", "approved", ORCID, 1, 0);
    await insert("described-duplicate", "verified", ORCID, 1, 1);
    await insert("described-unverified", "verified", "0000-0001-9000-0002", 0, 0);
    await insert("described-pending", "pending", "0000-0001-9000-0003", 1, 0);
    const named = [
      await idOf("described-canonical"),
      await idOf("described-duplicate"),
      await idOf("described-unverified"),
      await idOf("described-pending"),
    ];
    const absent = Array.from({ length: 96 }, (_, i) => 2_000_000 + i);
    const result = (await call("describeAccounts", {
      credential: { kind: "api_key", value: API_KEY },
      userIds: [...named, ...absent],
    })) as { ok: boolean; accounts: { userId: number; state: string; orcid?: string | null }[] };

    expect(result.ok).toBe(true);
    expect(result.accounts).toHaveLength(100);
    expect(result.accounts.map((a) => a.userId)).toEqual([...named, ...absent]);
    expect(result.accounts.slice(0, 4)).toEqual([
      expect.objectContaining({ state: "active", orcid: ORCID }),
      expect.objectContaining({ state: "active", orcid: null }),
      expect.objectContaining({ state: "active", orcid: null }),
      { userId: named[3], state: "inactive" },
    ]);
    expect(result.accounts.slice(4).every((a) => a.state === "gone")).toBe(true);
  });

  test("the whole handoff: HTTP grant, then exchange, resolve and sign-out over the binding", async () => {
    const granted = await apiFetch("/auth/private/grant", GRANT_REQUEST);
    expect(granted.status).toBe(200);
    const { code } = (await granted.json()) as { code: string };

    const exchanged = (await call("exchangePrivateGrant", {
      code,
      state: STATE,
      userAgent: "entry-test",
      clientIp: "192.0.2.1",
    })) as { ok: boolean; session: string; principal: { userId: number } };
    expect(exchanged.ok).toBe(true);
    expect(exchanged.principal.userId).toBe(userId);

    const credential = { kind: "session", value: exchanged.session };
    expect(await call("resolvePrincipal", credential)).toMatchObject({ ok: true });
    expect(await call("revokePrivateSession", { value: exchanged.session })).toEqual({ ok: true });
    expect(await call("resolvePrincipal", credential)).toEqual({
      ok: false,
      error: "invalid_credential",
    });
  });

  test("smoke: a session read through the entry lands its last_used_at touch", async () => {
    // A SMOKE TEST, and what it can and cannot prove matters more than its
    // result. It can prove the touch lands when a session is read through the
    // real entry in workerd. It CANNOT prove the class hands the touch to
    // `ctx.waitUntil`: measured, local workerd completes the floating write
    // even with `this.ctx` removed from the class, so this passes either way.
    // That hand-off is proven only by the bun test in `private-site-rpc.test.ts`
    // (the function passes its touch to the context it is given), and the
    // class passing `this.ctx` along is guarded by reading it. Wound back
    // first, so only the touch can move the value forward.
    const granted = await apiFetch("/auth/private/grant", GRANT_REQUEST);
    const { code } = (await granted.json()) as { code: string };
    const { session } = (await call("exchangePrivateGrant", {
      code,
      state: STATE,
      userAgent: null,
      clientIp: null,
    })) as { session: string };
    const hash = await hashCookieId(session);
    await d1
      .prepare(
        "UPDATE web_sessions SET last_used_at = '2020-01-01 00:00:00' WHERE cookie_id_hash = ?",
      )
      .bind(hash)
      .run();

    expect(await call("resolvePrincipal", { kind: "session", value: session })).toMatchObject({
      ok: true,
    });

    let touched = "2020-01-01 00:00:00";
    for (let i = 0; i < 50 && touched === "2020-01-01 00:00:00"; i++) {
      const row = await d1
        .prepare("SELECT last_used_at FROM web_sessions WHERE cookie_id_hash = ?")
        .bind(hash)
        .first<{ last_used_at: string }>();
      touched = row?.last_used_at ?? touched;
      if (touched === "2020-01-01 00:00:00") await Bun.sleep(20);
    }
    expect(touched).not.toBe("2020-01-01 00:00:00");
  });
});
