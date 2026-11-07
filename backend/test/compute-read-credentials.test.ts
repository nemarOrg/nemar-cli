/**
 * Who may read what on `/compute` (epic #2021 phase D2, #2023; ADR 0119, the addendum of this phase),
 * through the REAL Worker entry point (`startOidcHarness`: the middleware stack, the host and mount
 * routing, the real compute router) over real migrated SQLite, with credentials the real flows issued:
 * a CLI key stored hashed, a session cookie from `issueSession`, access tokens from the real
 * authorization routes and token endpoint, and a client credentials token from the real token endpoint.
 *
 * What is pinned:
 *  1. THE CREDENTIAL MATRIX. `/compute/me*` takes a key, the cookie, and an access token with
 *     `compute.read`; a token without the scope is 403 `insufficient_scope` and names the scope in its
 *     challenge; nothing at all is 401; garbage, a refresh token and a client secret are 401
 *     `invalid_token`. `/compute/stats` takes only a client credentials token with `compute.stats`: a key
 *     and a person's token are 403 `forbidden_credential` (a person's token BEFORE its scope is judged),
 *     a token without the scope is 403 `insufficient_scope`, nothing is 401 `missing_credential`. An
 *     OIDC token on an existing route (`/users/me`) is still refused.
 *  2. ISOLATION. Person B cannot read person A's job, charges or pools by any credential; an OIDC token
 *     for A lists only A's jobs.
 *  3. EVERY ACCESS STATE is answered on every `/compute/me*` route, over the OIDC credential too.
 *  4. THE STATS BODY names nobody: no key, and no value, of any account, subject, name, email, pseudonym,
 *     Tapis owner or client, found by walking the JSON.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { COMPUTE_ACCESS_STATES } from "../../shared/compute-access-state";
import {
  ComputeMeResponseSchema,
  ComputeStatsResponseSchema,
  ComputeUsageResponseSchema,
  ComputeUserJobResponseSchema,
  ComputeUserJobsResponseSchema,
} from "../../shared/contract/compute-user";
import { hashApiKey } from "../src/services/token";
import { fundAccount } from "./helpers/compute-seed";
import { chargeAt, insertJob, partnerOverrunAt } from "./helpers/compute-user-seed";
import {
  type RegisteredClient,
  authorize,
  basic,
  formPost,
  redeem,
  registerClient,
  rotateKeys,
  seedAccount,
  sessionCookie,
} from "./helpers/oidc-flow";
import { type Answer, type OidcHarness, startOidcHarness } from "./helpers/oidc-harness";

let h: OidcHarness;
let readClient: RegisteredClient;
let plainClient: RegisteredClient;
let machine: RegisteredClient;

let a: { id: number; key: string; cookie: string; email: string; username: string };
let b: { id: number; key: string; cookie: string; email: string; username: string };

const KEY_A = `cred-key-a-${"A".repeat(43)}`;
const KEY_B = `cred-key-b-${"B".repeat(43)}`;

async function person(key: string) {
  const id = seedAccount(h, { status: "approved" });
  h.db
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(id, await hashApiKey(key), key.slice(0, 8));
  const row = h.db
    .query<{ email: string; username: string }, [number]>(
      "SELECT email, username FROM users WHERE id = ?",
    )
    .get(id) as { email: string; username: string };
  return { id, key, cookie: await sessionCookie(h, id), ...row };
}

/** A live access token for an account, with the scope text given. */
async function accessToken(
  client: RegisteredClient,
  who: { id: number; cookie: string },
  scope: string,
): Promise<string> {
  const code = await authorize(h, client, who.cookie, { scope });
  const res = await redeem(h, client, code);
  expect(res.status).toBe(200);
  return (res.json as { access_token: string }).access_token;
}

async function machineToken(client: RegisteredClient): Promise<string> {
  const res = await formPost(
    h,
    "/oauth/token",
    { grant_type: "client_credentials" },
    { authorization: basic(client.clientId, client.secret) },
  );
  expect(res.status).toBe(200);
  return (res.json as { access_token: string }).access_token;
}

const get = (path: string, over: { key?: string; cookie?: string } = {}): Promise<Answer> =>
  h.call("GET", path, {
    ...(over.key ? { key: over.key } : {}),
    ...(over.cookie ? { headers: { Cookie: over.cookie } } : {}),
  });

beforeAll(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
  await rotateKeys(h);
  readClient = await registerClient(h, {
    allowed_scopes: ["openid", "compute.read", "profile", "offline_access"],
    allowed_grants: ["authorization_code", "refresh_token"],
    audience: "https://api.nemar.org/compute",
  });
  plainClient = await registerClient(h);
  machine = await registerClient(h, {
    allowed_scopes: ["compute.stats"],
    allowed_grants: ["client_credentials"],
    first_party: false,
  });
  a = await person(KEY_A);
  b = await person(KEY_B);
  // A has an active grant and a pool; B has jobs, charges and a pool of their own.
  h.db.query("UPDATE users SET compute_access = 'active' WHERE id = ?").run(a.id);
  h.db.query("UPDATE users SET compute_access = 'active' WHERE id = ?").run(b.id);
  await fundAccount(h.env.DB, a.id, 11_000);
  await fundAccount(h.env.DB, b.id, 99_000);
  const ja = insertJob(h.db, {
    account_id: a.id,
    app_id: "a-app",
    created_at: "2026-10-05 10:00:00",
  });
  const jb = insertJob(h.db, {
    account_id: b.id,
    app_id: "b-app",
    created_at: "2026-10-05 11:00:00",
  });
  chargeAt(h.db, { accountId: a.id, jobId: ja, milli: 1_000, at: "2026-10-05 10:30:00" });
  chargeAt(h.db, { accountId: b.id, jobId: jb, milli: 4_000, at: "2026-10-05 11:30:00" });
}, 60_000);

const PERSON_ROUTES = ["/compute/me", "/compute/me/usage", "/compute/me/jobs"];

describe("the credential matrix on /compute/me*", () => {
  test("a CLI key, the session cookie and an access token with compute.read each reach the caller's own data", async () => {
    const token = await accessToken(readClient, a, "openid compute.read");
    for (const how of [{ key: KEY_A }, { cookie: a.cookie }, { key: token }]) {
      const res = await get("/compute/me", how);
      expect([Object.keys(how)[0], res.status]).toEqual([Object.keys(how)[0], 200]);
      expect(ComputeMeResponseSchema.safeParse(res.json).success).toBe(true);
      expect(
        (res.json as { pools: { cpu: { granted_milli: number } } }).pools.cpu.granted_milli,
      ).toBe(11_000);
    }
  });

  test("a live token without compute.read is 403 insufficient_scope, with the scope in the challenge", async () => {
    const token = await accessToken(plainClient, a, "openid profile");
    for (const path of PERSON_ROUTES) {
      const res = await get(path, { key: token });
      expect([path, res.status, res.json?.code]).toEqual([path, 403, "insufficient_scope"]);
      expect(res.headers.get("WWW-Authenticate")).toBe(
        'Bearer error="insufficient_scope", scope="compute.read"',
      );
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  test("no credential is 401; garbage, a refresh token and a client secret are 401 invalid_token", async () => {
    expect((await get("/compute/me")).status).toBe(401);
    const code = await authorize(h, readClient, a.cookie, {
      scope: "openid compute.read offline_access",
    });
    const issued = (await redeem(h, readClient, code)).json as { refresh_token: string };
    for (const bad of [`nmo_at_${"x".repeat(43)}`, issued.refresh_token, readClient.secret]) {
      const res = await get("/compute/me", { key: bad });
      expect([bad.slice(0, 7), res.status, res.json?.code]).toEqual([
        bad.slice(0, 7),
        401,
        "invalid_token",
      ]);
      expect(res.headers.get("WWW-Authenticate")).toBe('Bearer error="invalid_token"');
    }
  });

  test("a client credentials token is not a person: refused on every /compute/me* route", async () => {
    const token = await machineToken(machine);
    for (const path of PERSON_ROUTES) {
      const res = await get(path, { key: token });
      // It has no compute.read, so the scope check refuses it first; either way it reads nothing.
      expect([path, res.status]).toEqual([path, 403]);
      expect(res.text).not.toContain("granted_milli");
    }
  });

  test("a client credentials token that did carry compute.read is still not a person (forbidden_credential)", async () => {
    const token = await machineToken(machine);
    // Widen the live token's scopes by hand, to reach the account check behind the scope check.
    h.db
      .query("UPDATE oidc_tokens SET scopes = ? WHERE user_id IS NULL")
      .run('["compute.read","compute.stats"]');
    for (const path of PERSON_ROUTES) {
      const res = await get(path, { key: token });
      expect([path, res.status, res.json?.code]).toEqual([path, 403, "forbidden_credential"]);
    }
    h.db.query("UPDATE oidc_tokens SET scopes = ? WHERE user_id IS NULL").run('["compute.stats"]');
  });

  test("an account that no longer passes its client's rule is refused at once (the token is read live)", async () => {
    const c = await person(`cred-key-live-${"L".repeat(43)}`);
    const token = await accessToken(readClient, c, "openid compute.read");
    expect((await get("/compute/me", { key: token })).status).toBe(200);
    h.db.query("UPDATE users SET status = 'revoked' WHERE id = ?").run(c.id);
    const after = await get("/compute/me", { key: token });
    expect([after.status, after.json?.code]).toEqual([401, "invalid_token"]);
  });

  test("an existing route still refuses an OIDC token, and so does the cancel route", async () => {
    const token = await accessToken(readClient, a, "openid compute.read");
    const users = await get("/users/me", { key: token });
    expect([users.status, users.json?.code]).toEqual([401, "oidc_token_not_accepted"]);
    const cancel = await h.call("POST", "/compute/jobs/job_000000000000000000000001/cancel", {
      key: token,
      body: {},
    });
    expect([cancel.status, cancel.json?.code]).toEqual([401, "oidc_token_not_accepted"]);
    const admin = await get("/admin/compute/status", { key: token });
    expect(admin.status).toBe(401);
  });
});

describe("the credential matrix on /compute/stats", () => {
  test("only a client credentials token carrying compute.stats reaches it", async () => {
    const token = await machineToken(machine);
    const res = await get("/compute/stats?from=2026-10-01&to=2026-10-31", { key: token });
    expect(res.status).toBe(200);
    expect(ComputeStatsResponseSchema.safeParse(res.json).success).toBe(true);
  });

  test("a CLI key is 403 forbidden_credential, and a valid key and an invalid one are answered the same", async () => {
    const valid = await get("/compute/stats", { key: KEY_A });
    const invalid = await get("/compute/stats", { key: `nm_${"Z".repeat(43)}` });
    for (const res of [valid, invalid]) {
      expect([res.status, res.json?.code]).toEqual([403, "forbidden_credential"]);
    }
    expect(valid.text).toBe(invalid.text);
  });

  test("a person's token is 403 forbidden_credential, whether or not it carries a scope the route names", async () => {
    const withRead = await accessToken(readClient, a, "openid compute.read");
    const without = await accessToken(plainClient, a, "openid profile");
    for (const token of [withRead, without]) {
      const res = await get("/compute/stats", { key: token });
      expect([res.status, res.json?.code]).toEqual([403, "forbidden_credential"]);
    }
  });

  test("a person's token that carries compute.stats by some fault is still not a client", async () => {
    const c = await person(`cred-key-fault-${"F".repeat(43)}`);
    const token = await accessToken(readClient, c, "openid compute.read");
    h.db
      .query(`UPDATE oidc_tokens SET scopes = '["compute.read","compute.stats"]' WHERE user_id = ?`)
      .run(c.id);
    const res = await get("/compute/stats", { key: token });
    expect([res.status, res.json?.code]).toEqual([403, "forbidden_credential"]);
  });

  test("the session cookie alone is no credential: 401 missing_credential", async () => {
    const none = await get("/compute/stats");
    const cookie = await get("/compute/stats", { cookie: a.cookie });
    for (const res of [none, cookie]) {
      expect([res.status, res.json?.code]).toEqual([401, "missing_credential"]);
      expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    }
  });

  test("a live client token without compute.stats is 403 insufficient_scope; garbage and non-bearer are 401", async () => {
    const token = await machineToken(machine);
    h.db.query(`UPDATE oidc_tokens SET scopes = '["openid"]' WHERE user_id IS NULL`).run();
    const res = await get("/compute/stats", { key: token });
    expect([res.status, res.json?.code]).toEqual([403, "insufficient_scope"]);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer error="insufficient_scope", scope="compute.stats"',
    );
    h.db.query("UPDATE oidc_tokens SET scopes = '[\"compute.stats\"]' WHERE user_id IS NULL").run();
    const garbage = await get("/compute/stats", { key: `nmo_at_${"q".repeat(43)}` });
    expect([garbage.status, garbage.json?.code]).toEqual([401, "invalid_token"]);
    const basicAuth = await h.call("GET", "/compute/stats", {
      headers: { Authorization: "Basic abc" },
    });
    expect([basicAuth.status, basicAuth.json?.code]).toEqual([401, "invalid_token"]);
  });

  test("a disabled client's token is refused at once", async () => {
    const other = await registerClient(h, {
      allowed_scopes: ["compute.stats"],
      allowed_grants: ["client_credentials"],
      first_party: false,
    });
    const token = await machineToken(other);
    expect((await get("/compute/stats", { key: token })).status).toBe(200);
    h.db
      .query(
        "UPDATE oidc_clients SET status = 'disabled', disabled_at = datetime('now') WHERE client_id = ?",
      )
      .run(other.clientId);
    const after = await get("/compute/stats", { key: token });
    expect(after.status).toBe(401);
  });
});

describe("every access state is answered on every /compute/me* route", () => {
  for (const state of COMPUTE_ACCESS_STATES) {
    test(`state ${state}`, async () => {
      const c = await person(`cred-key-${state}-${"S".repeat(43)}`);
      h.db.query("UPDATE users SET compute_access = ? WHERE id = ?").run(state, c.id);
      const token = await accessToken(readClient, c, "openid compute.read");
      const job = insertJob(h.db, { account_id: c.id });
      for (const how of [{ key: c.key }, { cookie: c.cookie }, { key: token }]) {
        for (const path of [...PERSON_ROUTES, `/compute/me/jobs/${job}`]) {
          const res = await get(path, how);
          expect([state, path, Object.keys(how)[0], res.status]).toEqual([
            state,
            path,
            Object.keys(how)[0],
            200,
          ]);
        }
      }
      const me = await get("/compute/me", { key: token });
      expect((me.json as { access: { state: string } }).access.state).toBe(state);
    });
  }
});

describe("isolation: a credential reads its own account and no other", () => {
  test("B cannot read A's job by any credential, and the answer is the one for an absent job", async () => {
    const jobA = h.db
      .query<{ id: string }, [number]>("SELECT id FROM compute_jobs WHERE account_id = ? LIMIT 1")
      .get(a.id)?.id as string;
    const tokenB = await accessToken(readClient, b, "openid compute.read");
    const absent = await get("/compute/me/jobs/job_0000000000000000deadbeef", { key: KEY_B });
    for (const how of [{ key: KEY_B }, { cookie: b.cookie }, { key: tokenB }]) {
      const res = await get(`/compute/me/jobs/${jobA}`, how);
      expect([Object.keys(how)[0], res.status]).toEqual([Object.keys(how)[0], 404]);
      expect(res.text).toBe(absent.text);
    }
    expect((await get(`/compute/me/jobs/${jobA}`, { key: KEY_A })).status).toBe(200);
  });

  test("an OIDC token for A lists only A's jobs, and A's usage and pools are A's alone", async () => {
    const tokenA = await accessToken(readClient, a, "openid compute.read");
    const jobs = await get("/compute/me/jobs", { key: tokenA });
    expect(ComputeUserJobsResponseSchema.safeParse(jobs.json).success).toBe(true);
    const mine = new Set(
      h.db
        .query<{ id: string }, [number]>("SELECT id FROM compute_jobs WHERE account_id = ?")
        .all(a.id)
        .map((r) => r.id),
    );
    const listed = (jobs.json as { jobs: Array<{ id: string }> }).jobs;
    expect(listed.length).toBeGreaterThan(0);
    for (const j of listed) expect(mine.has(j.id)).toBe(true);

    const usage = await get("/compute/me/usage?from=2026-10-05&to=2026-10-05&group=app", {
      key: tokenA,
    });
    expect(ComputeUsageResponseSchema.safeParse(usage.json).success).toBe(true);
    expect((usage.json as { rows: unknown[] }).rows).toEqual([
      { app: "a-app", charged_milli: 1_000, jobs: 1 },
    ]);
    expect(usage.text).not.toContain("b-app");

    const me = await get("/compute/me", { key: tokenA });
    expect((me.json as { pools: { cpu: { granted_milli: number } } }).pools.cpu.granted_milli).toBe(
      11_000,
    );
    expect(me.text).not.toContain("99000");
  });

  test("each route's answer is built for the caller: B's token sees B's figures on the very same routes", async () => {
    const tokenB = await accessToken(readClient, b, "openid compute.read");
    const me = await get("/compute/me", { key: tokenB });
    expect((me.json as { pools: { cpu: { granted_milli: number } } }).pools.cpu.granted_milli).toBe(
      99_000,
    );
    const usage = await get("/compute/me/usage?from=2026-10-05&to=2026-10-05", { key: tokenB });
    expect((usage.json as { rows: unknown[] }).rows).toEqual([{ charged_milli: 4_000, jobs: 1 }]);
    const detail = await get(
      `/compute/me/jobs/${h.db.query<{ id: string }, [number]>("SELECT id FROM compute_jobs WHERE account_id = ? LIMIT 1").get(b.id)?.id}`,
      { key: tokenB },
    );
    expect(ComputeUserJobResponseSchema.safeParse(detail.json).success).toBe(true);
  });
});

describe("the stats body names nobody", () => {
  const FORBIDDEN_KEY =
    /account|user|sub$|subject|email|name|orcid|owner|gateway|client|token|pseudonym/i;

  /** Every key and every scalar value of a JSON document. */
  function walk(node: unknown, keys: string[] = [], values: string[] = []) {
    if (Array.isArray(node)) for (const n of node) walk(n, keys, values);
    else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        keys.push(k);
        walk(v, keys, values);
      }
    } else values.push(String(node));
    return { keys, values };
  }

  test("aggregates only: exact rows, and no key or value that identifies an account", async () => {
    // A stranger world: people, a pipelines account, a swept (unreserved) partner job, all with
    // identifying values the body must not carry.
    const pipelines = await person(`cred-key-pipe-${"P".repeat(43)}`);
    const c = await person(`cred-key-c-${"C".repeat(43)}`);
    // The account a swept (unreserved) job was matched to: it ran nothing itself in the window.
    const d = await person(`cred-key-d-${"D".repeat(43)}`);
    const seen: string[] = [];
    const mk = (over: Parameters<typeof insertJob>[1]) => insertJob(h.db, over);
    const day1 = "2026-09-10 12:00:00";
    const day2 = "2026-09-11 12:00:00";
    const j1 = mk({
      account_id: c.id,
      partition: "shared",
      source: "cli",
      state: "finished",
      created_at: day1,
      tapis_owner: "someone.tapis",
    });
    const j2 = mk({
      account_id: c.id,
      partition: "shared",
      source: "cli",
      state: "failed",
      created_at: day2,
    });
    const j3 = mk({
      account_id: b.id,
      partition: "gpu",
      pool: "gpu",
      source: "web",
      state: "cancelled",
      created_at: day2,
    });
    const p1 = mk({
      account_id: pipelines.id,
      partition: "shared",
      source: "pipeline",
      state: "finished",
      created_at: day1,
    });
    const swept = mk({
      account_id: d.id,
      partition: "shared",
      source: "partner",
      state: "cancelled",
      flag_unreserved: 1,
      client_id: "tenant",
      created_at: day1,
    });
    chargeAt(h.db, { accountId: c.id, jobId: j1, milli: 3_000, at: day1 });
    chargeAt(h.db, { accountId: c.id, jobId: j2, milli: 500, at: day2 });
    chargeAt(h.db, { accountId: b.id, jobId: j3, milli: 9_000, at: day2, pool: "gpu" });
    chargeAt(h.db, { accountId: pipelines.id, jobId: p1, milli: 200, at: day1 });
    partnerOverrunAt(h.db, { jobId: swept, milli: 700, at: day1 });
    seen.push(
      c.email,
      c.username,
      d.email,
      pipelines.email,
      pipelines.username,
      b.email,
      "someone.tapis",
    );
    for (const row of h.db
      .query<{ oidc_subject: string }, []>(
        "SELECT oidc_subject FROM users WHERE oidc_subject IS NOT NULL",
      )
      .all()) {
      seen.push(row.oidc_subject);
    }

    const token = await machineToken(machine);
    const res = await get("/compute/stats?from=2026-09-10&to=2026-09-11", { key: token });
    expect(res.status).toBe(200);
    expect(ComputeStatsResponseSchema.safeParse(res.json).success).toBe(true);
    const body = res.json as {
      from: string;
      to: string;
      by_day_partition_source: unknown[];
      active_people: number;
      jobs_by_outcome: Record<string, number>;
    };
    expect(body.by_day_partition_source).toEqual([
      // Day 1: c's 3,000 and the pipeline's 200 (shared/cli and shared/pipeline), and the swept job's 700 (shared/partner).
      { day: "2026-09-10", partition: "shared", source: "cli", charged_milli: 3_000, jobs: 1 },
      { day: "2026-09-10", partition: "shared", source: "partner", charged_milli: 700, jobs: 1 },
      { day: "2026-09-10", partition: "shared", source: "pipeline", charged_milli: 200, jobs: 1 },
      { day: "2026-09-11", partition: "gpu", source: "web", charged_milli: 9_000, jobs: 1 },
      { day: "2026-09-11", partition: "shared", source: "cli", charged_milli: 500, jobs: 1 },
    ]);
    // c and b made jobs in the window; the pipelines account and the swept job's match do not count as people.
    expect(body.active_people).toBe(2);
    expect(body.jobs_by_outcome).toEqual({ finished: 2, failed: 1, cancelled: 2 });
    expect(body.from).toBe("2026-09-10");

    const { keys, values } = walk(res.json);
    const badKeys = keys.filter((k) => FORBIDDEN_KEY.test(k) && k !== "active_people");
    expect(badKeys).toEqual([]);
    for (const secret of seen) {
      expect([secret, res.text.includes(secret)]).toEqual([secret, false]);
      expect(values).not.toContain(secret);
    }
    // And no number that is an account id appears as a value of an id-like key (there is no such key).
    expect(res.text).not.toContain("account_id");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("an empty window is zeros that were counted, not an absence", async () => {
    const token = await machineToken(machine);
    const res = await get("/compute/stats?from=2020-01-01&to=2020-01-31", { key: token });
    expect(res.json).toEqual({
      from: "2020-01-01",
      to: "2020-01-31",
      by_day_partition_source: [],
      active_people: 0,
      jobs_by_outcome: { finished: 0, failed: 0, cancelled: 0 },
    });
  });

  test("the window is validated like usage's: invalid_range", async () => {
    const token = await machineToken(machine);
    for (const query of ["from=2026-10-06&to=2026-10-05", "from=2020-01-01", "to=nope"]) {
      const res = await get(`/compute/stats?${query}`, { key: token });
      expect([query, res.status, res.json?.code]).toEqual([query, 400, "invalid_range"]);
    }
  });
});
