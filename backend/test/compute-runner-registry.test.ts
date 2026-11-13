/**
 * The runner registry through NEMAR's REAL routes (portable compute, card DM-05; decisions D4, D5, D7):
 * the owner's `/admin/compute/runners` routes, the runner's `/compute/runners/token` and `/me`, the
 * refusal of both credential prefixes by every other path, and the dark switch, over a real migrated
 * database (bun:sqlite behind `realD1`) with real API keys hashed as production hashes them. Nothing is
 * stood in for; the one `worker.fetch` case proves the routers are mounted by `index.ts`.
 *
 * What is pinned, each with a test of its own:
 *  - only an owner registers, lists or revokes (an administrator is `owner_only`, a member 403);
 *  - the secret is answered once, only its hash is stored, and neither the secret nor an access token is
 *    in any row, audit row or listing; `accounting: "su"` is `runner_accounting_unbuilt`;
 *  - the exchange: one 900-second token row on D1's clock, hashed at rest; `last_seen_at` and the version
 *    written; an unknown, revoked or malformed secret is ONE answer (`runner_unknown`); another protocol
 *    is `protocol_unsupported`; a bad body `invalid_body`; the credential is judged BEFORE the body;
 *  - the token opens `GET /compute/runners/me` and nothing else: it is refused on `GET /users/me`, on the
 *    admin router, and by `resolveApiKeyUser` (even when the `tokens` table holds its hash), the secret
 *    likewise, and neither prefix is looked up; an expired token is `runner_token_expired`;
 *  - revoke ends the token at once, releases an unstarted claim, makes a started job `unreported` with no
 *    lease and keeps its runner, leaves every other job alone, and replays safely;
 *  - the switch: off (unset, any other word, compute off, another environment) refuses the exchange and
 *    the token's use, and writes nothing.
 * MUTATIONS, each run alone: drop the `nmr_` or the `nmra_` prefix from the refusal; drop the `expires_at`
 * term of the token lookup; read the body before the credential; drop the switch from the exchange or from
 * `runnerAccess`; drop the revoked-registration term of the secret lookup; drop a statement of the revoke.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import { RUNNER_REFUSALS, RUNNER_REFUSAL_STATUS } from "../../shared/compute-state";
import {
  RUNNER_ACCESS_TOKEN_RE,
  RUNNER_PROTOCOL,
  RUNNER_SECRET_RE,
  RunnerRegisterResponseSchema,
  RunnerTokenResponseSchema,
} from "../../shared/contract/compute-runner";
import worker from "../src/index";
import { resolveApiKeyUser } from "../src/middleware/auth";
import { adminRoutes } from "../src/routes/admin";
import { computeRunnerRoutes } from "../src/routes/compute-runners";
import { userRoutes } from "../src/routes/users";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { COMPUTE_KEYS, type ComputeWho, seedComputeUsers } from "./helpers/compute-app";
import { freshDb, realD1 } from "./helpers/d1";

/** A row or a JSON body read back by a test, whose fields the assertions name. */
// biome-ignore lint/suspicious/noExplicitAny: test rows and bodies are read field by field
type Loose = Record<string, any>;

const MARK = "SECRET-MARKER-7731";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
app.route("/admin", adminRoutes);
app.route("/compute/runners", computeRunnerRoutes);
app.route("/users", userRoutes);

let db: Database;
let ids: Record<ComputeWho, number>;

const ON = { ENVIRONMENT: "production", COMPUTE_ENABLED: "1", COMPUTE_RUNNERS_ENABLED: "1" };

function envOf(over: Record<string, unknown> = {}): Bindings {
  return { DB: realD1(db), ...ON, ...over } as unknown as Bindings;
}

beforeEach(async () => {
  db = freshDb();
  ids = await seedComputeUsers(db);
});

interface Called {
  status: number;
  body: Loose;
  text: string;
  headers: Headers;
}

async function call(
  method: string,
  path: string,
  o: {
    who?: ComputeWho | null;
    bearer?: string;
    body?: unknown;
    raw?: string;
    env?: Bindings;
  } = {},
): Promise<Called> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (o.bearer !== undefined) headers.Authorization = `Bearer ${o.bearer}`;
  else if (o.who) headers.Authorization = `Bearer ${COMPUTE_KEYS[o.who]}`;
  const res = await app.request(
    path,
    {
      method,
      headers,
      body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)),
    },
    o.env ?? envOf(),
  );
  const text = await res.text();
  let body: Loose = {};
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON; `text` is what the assertion reads.
  }
  return { status: res.status, body, text, headers: res.headers };
}

const REGISTRATION = {
  name: "lab_a_cpu",
  pool: "cpu",
  cores: 16,
  memory_mb: 64_000,
  gpus: 0,
  scratch_gb: 500,
  backend: "local",
  runtimes: ["docker"],
  arch: "amd64",
  accounting: "none",
  site: "lab_a",
  trust: "lab",
};

const register = (who: ComputeWho | null, over: Record<string, unknown> = {}) =>
  call("POST", "/admin/compute/runners", { who, body: { ...REGISTRATION, ...over } });

/** Register as the owner and return the id and the secret. */
async function registered(over: Record<string, unknown> = {}) {
  const res = await register("owner", over);
  expect(res.status).toBe(201);
  return RunnerRegisterResponseSchema.parse(res.body);
}

const exchange = (secret: string, body: unknown = RUN_BODY, env?: Bindings) =>
  call("POST", "/compute/runners/token", { bearer: secret, body, env });

const RUN_BODY = { protocol: RUNNER_PROTOCOL, runner_version: "0.1.0" };

/** Register, exchange, and return what a runner holds. */
async function runnerWithToken(over: Record<string, unknown> = {}) {
  const { runner_id, secret } = await registered(over);
  const res = await exchange(secret);
  expect(res.status).toBe(200);
  const { access_token } = RunnerTokenResponseSchema.parse(res.body);
  return { runnerId: runner_id, secret, token: access_token };
}

const count = (sql: string, ...binds: unknown[]) =>
  (db.query(sql).get(...(binds as never[])) as { n: number }).n;
const rows = (table: string) => JSON.stringify(db.query(`SELECT * FROM ${table}`).all());
const sha256 = hashApiKey;

describe("who may register, list and revoke", () => {
  test("no key is a 401, a member a 403 and an administrator who is not an owner is owner_only, on every route", async () => {
    const { runner_id } = await registered({ name: "existing" });
    const attempts: Array<[string, string, unknown?]> = [
      ["POST", "/admin/compute/runners", REGISTRATION],
      ["GET", "/admin/compute/runners"],
      ["POST", `/admin/compute/runners/${runner_id}/revoke`, {}],
    ];
    for (const [who, status, code] of [
      [null, 401, undefined],
      ["member", 403, undefined],
      ["admin", 403, "owner_only"],
      ["admin2", 403, "owner_only"],
    ] as const) {
      for (const [method, path, body] of attempts) {
        const res = await call(method, path, { who, body });
        expect([who, method, path, res.status]).toEqual([who, method, path, status]);
        if (code) expect(res.body.code).toBe(code);
      }
    }
    // Nothing the refused calls asked for happened.
    expect(count("SELECT COUNT(*) AS n FROM compute_runners")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM compute_runners WHERE revoked_at IS NOT NULL")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'compute.runner.%'")).toBe(
      1,
    );
  });

  test("a second owner may register, list and revoke too", async () => {
    const res = await register("owner2", { name: "second" });
    expect(res.status).toBe(201);
    expect((await call("GET", "/admin/compute/runners", { who: "owner2" })).status).toBe(200);
  });
});

describe("registration", () => {
  test("the secret is answered once, with the id, and only its hash is stored", async () => {
    const res = await register("owner");
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const parsed = RunnerRegisterResponseSchema.parse(res.body);
    expect(parsed.secret).toMatch(RUNNER_SECRET_RE);
    expect(Object.keys(res.body).sort()).toEqual(["runner_id", "secret"]);

    const row = db.query("SELECT * FROM compute_runners").get() as Record<string, unknown>;
    expect(row.id).toBe(parsed.runner_id);
    expect(row.secret_hash).toBe(await sha256(parsed.secret));
    expect(row.registered_by).toBe(ids.owner);
    expect(row.revoked_at).toBeNull();
    expect(JSON.parse(row.runtimes as string)).toEqual(["docker"]);
    // The clear secret is in no table at all.
    for (const table of ["compute_runners", "compute_runner_tokens", "audit_log"]) {
      expect([table, rows(table).includes(parsed.secret)]).toEqual([table, false]);
    }
    expect(rows("audit_log").includes(await sha256(parsed.secret))).toBe(false);
  });

  test("it writes one audit row, of the shape of the event and nothing that identifies the machine or the secret", async () => {
    const { runner_id } = await registered();
    const audit = db
      .query("SELECT * FROM audit_log WHERE action = 'compute.runner.registered'")
      .all() as Array<Loose>;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      user_id: ids.owner,
      resource_type: "compute_runner",
      resource_id: runner_id,
    });
    expect(JSON.parse(audit[0]?.details)).toEqual({
      pool: "cpu",
      backend: "local",
      accounting: "none",
      trust: "lab",
    });
  });

  test("a registration works with the switches off (the owner prepares; the exchange is what is dark)", async () => {
    const res = await call("POST", "/admin/compute/runners", {
      who: "owner",
      body: REGISTRATION,
      env: envOf({ COMPUTE_ENABLED: undefined, COMPUTE_RUNNERS_ENABLED: undefined }),
    });
    expect(res.status).toBe(201);
  });

  test("accounting su is refused as runner_accounting_unbuilt, and nothing is written", async () => {
    const res = await register("owner", { accounting: "su" });
    expect(res.status).toBe(RUNNER_REFUSAL_STATUS.runner_accounting_unbuilt);
    expect(res.body.code).toBe("runner_accounting_unbuilt");
    expect(count("SELECT COUNT(*) AS n FROM compute_runners")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'compute.runner.%'")).toBe(
      0,
    );
  });

  test("an invalid body is a 400 that names fields and never echoes a value; a mistyped key is refused", async () => {
    for (const body of [
      { ...REGISTRATION, name: `${MARK} Bad Name` },
      { ...REGISTRATION, cores: 0 },
      { ...REGISTRATION, runtimes: [] },
      { ...REGISTRATION, runtimes: ["docker", "docker"] },
      { ...REGISTRATION, backend: MARK },
      { ...REGISTRATION, site: `${MARK}!` },
      { ...REGISTRATION, extra: MARK },
      { ...REGISTRATION, secret: MARK },
    ]) {
      const res = await call("POST", "/admin/compute/runners", { who: "owner", body });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_body");
      expect(res.text).not.toContain(MARK);
    }
    const notJson = await call("POST", "/admin/compute/runners", { who: "owner", raw: "{nope" });
    expect(notJson.status).toBe(400);
    expect(count("SELECT COUNT(*) AS n FROM compute_runners")).toBe(0);
  });

  test("a live name is taken, and a revoked registration's name is free again", async () => {
    const first = await registered();
    const again = await register("owner");
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("runner_name_taken");
    expect(count("SELECT COUNT(*) AS n FROM compute_runners")).toBe(1);
    expect(
      (await call("POST", `/admin/compute/runners/${first.runner_id}/revoke`, { who: "owner" }))
        .status,
    ).toBe(200);
    expect((await register("owner")).status).toBe(201);
  });
});

describe("the listing", () => {
  test("it lists every registration without a hash or a secret, newest first, runtimes as a list", async () => {
    const a = await registered({ name: "first" });
    await registered({
      name: "second",
      runtimes: ["apptainer", "docker"],
      backend: "slurm",
      trust: "hpc",
    });
    await call("POST", `/admin/compute/runners/${a.runner_id}/revoke`, { who: "owner" });
    const res = await call("GET", "/admin/compute/runners", { who: "owner" });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(a.secret);
    expect(res.text).not.toContain("secret_hash");
    expect(res.text).not.toContain(await sha256(a.secret));
    const list = res.body.runners as Array<Loose>;
    expect(list.map((r) => r.name).sort()).toEqual(["first", "second"]);
    const second = list.find((r) => r.name === "second");
    expect(second).toMatchObject({
      runtimes: ["apptainer", "docker"],
      backend: "slurm",
      trust: "hpc",
      revoked_at: null,
    });
    const first = list.find((r) => r.name === "first");
    expect(first).toMatchObject({ revoke_reason: "owner_revoked" });
    expect(typeof first?.revoked_at).toBe("string");
  });
});

describe("the exchange", () => {
  test("a secret buys one token for 900 seconds on D1's clock, hashed at rest, and the runner's last seen is written", async () => {
    const { runner_id, secret } = await registered();
    const res = await exchange(secret, { protocol: RUNNER_PROTOCOL, runner_version: "1.2.3-rc.1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const parsed = RunnerTokenResponseSchema.parse(res.body);
    expect(parsed.access_token).toMatch(RUNNER_ACCESS_TOKEN_RE);
    expect(parsed.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    const tokens = db.query("SELECT * FROM compute_runner_tokens").all() as Array<Loose>;
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.runner_id).toBe(runner_id);
    expect(tokens[0]?.token_hash).toBe(await sha256(parsed.access_token));
    expect(rows("compute_runner_tokens").includes(parsed.access_token)).toBe(false);
    expect(rows("compute_runners").includes(parsed.access_token)).toBe(false);
    // 900 seconds from D1's own clock, and the answer says the same instant.
    const ahead = (
      db
        .query(
          "SELECT CAST(strftime('%s', expires_at) AS INTEGER) - CAST(strftime('%s', 'now') AS INTEGER) AS s FROM compute_runner_tokens",
        )
        .get() as { s: number }
    ).s;
    expect(ahead).toBeGreaterThanOrEqual(898);
    expect(ahead).toBeLessThanOrEqual(900);
    expect(parsed.expires_at).toBe(`${tokens[0]?.expires_at.replace(" ", "T")}Z`);

    const runner = db.query("SELECT * FROM compute_runners").get() as Loose;
    expect(runner.runner_version).toBe("1.2.3-rc.1");
    expect(typeof runner.last_seen_at).toBe("string");
  });

  test("each exchange mints a new token, and expired tokens of the runner are dropped", async () => {
    const { secret, runner_id } = await registered();
    const first = RunnerTokenResponseSchema.parse((await exchange(secret)).body);
    db.run("UPDATE compute_runner_tokens SET expires_at = datetime('now', '-1 seconds')");
    const second = RunnerTokenResponseSchema.parse((await exchange(secret)).body);
    expect(second.access_token).not.toBe(first.access_token);
    const left = db
      .query("SELECT token_hash FROM compute_runner_tokens WHERE runner_id = ?")
      .all(runner_id);
    expect(left).toEqual([{ token_hash: await sha256(second.access_token) }]);
  });

  test("an unknown, a revoked and a malformed secret are ONE answer, and write nothing", async () => {
    const { runner_id, secret } = await registered();
    await call("POST", `/admin/compute/runners/${runner_id}/revoke`, { who: "owner" });
    const answers: Called[] = [];
    for (const bearer of [
      `nmr_${"0".repeat(64)}`,
      secret,
      "nmr_short",
      `nmra_${"0".repeat(64)}`,
      COMPUTE_KEYS.owner,
      "",
    ]) {
      answers.push(await exchange(bearer));
    }
    const noHeader = await app.request(
      "/compute/runners/token",
      { method: "POST", body: JSON.stringify(RUN_BODY) },
      envOf(),
    );
    for (const a of answers) {
      expect(a.status).toBe(RUNNER_REFUSAL_STATUS.runner_unknown);
      expect(a.text).toBe(JSON.stringify({ error: "runner_unknown" }));
    }
    expect(noHeader.status).toBe(401);
    expect(await noHeader.json()).toEqual({ error: "runner_unknown" });
    expect(count("SELECT COUNT(*) AS n FROM compute_runner_tokens")).toBe(0);
  });

  test("an access token is not a secret: it buys no token", async () => {
    const { token } = await runnerWithToken();
    const res = await exchange(token);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("runner_unknown");
    expect(count("SELECT COUNT(*) AS n FROM compute_runner_tokens")).toBe(1);
  });

  test("another protocol is protocol_unsupported (426) and a bad body invalid_body (400), after the secret was judged", async () => {
    const { secret } = await registered();
    const other = await exchange(secret, { protocol: "nemar.runner.v2", runner_version: "0.1.0" });
    expect([other.status, other.body]).toEqual([426, { error: "protocol_unsupported" }]);
    for (const body of [
      {},
      { protocol: RUNNER_PROTOCOL },
      { runner_version: "0.1.0" },
      { protocol: RUNNER_PROTOCOL, runner_version: "not a version" },
      { ...RUN_BODY, extra: 1 },
      { protocol: 1, runner_version: "0.1.0" },
    ]) {
      const res = await exchange(secret, body);
      expect([JSON.stringify(body), res.status, res.body]).toEqual([
        JSON.stringify(body),
        400,
        { error: "invalid_body" },
      ]);
    }
    expect((await exchange(secret, undefined, undefined)).status).toBe(200);
    const notJson = await call("POST", "/compute/runners/token", { bearer: secret, raw: "{nope" });
    expect([notJson.status, notJson.body]).toEqual([400, { error: "invalid_body" }]);
    const huge = await call("POST", "/compute/runners/token", {
      bearer: secret,
      raw: JSON.stringify({ ...RUN_BODY, pad: "x".repeat(4096) }),
    });
    expect([huge.status, huge.body]).toEqual([400, { error: "invalid_body" }]);
    expect(count("SELECT COUNT(*) AS n FROM compute_runner_tokens")).toBe(1);
  });

  test("the credential is judged BEFORE the body: a caller without a secret learns nothing about the body", async () => {
    for (const body of [RUN_BODY, { protocol: "nemar.runner.v2" }, { nope: true }]) {
      const res = await exchange(`nmr_${"1".repeat(64)}`, body);
      expect([res.status, res.body]).toEqual([401, { error: "runner_unknown" }]);
    }
    const notJson = await call("POST", "/compute/runners/token", {
      bearer: `nmr_${"1".repeat(64)}`,
      raw: "{nope",
    });
    expect([notJson.status, notJson.body]).toEqual([401, { error: "runner_unknown" }]);
  });

  test("every refusal word is one the protocol declares, with its declared status", async () => {
    const { secret, token } = await runnerWithToken();
    const seen: Called[] = [
      await exchange(`nmr_${"1".repeat(64)}`),
      await exchange(secret, { protocol: "x", runner_version: "0.1.0" }),
      await exchange(secret, {}),
      await call("GET", "/compute/runners/me", { bearer: `nmra_${"1".repeat(64)}` }),
      await exchange(secret, RUN_BODY, envOf({ COMPUTE_RUNNERS_ENABLED: undefined })),
      await call("GET", "/users/me", { bearer: token }),
    ];
    for (const r of seen) {
      const word = r.body.error as string;
      expect([word, (RUNNER_REFUSALS as readonly string[]).includes(word)]).toEqual([word, true]);
      expect(r.status).toBe((RUNNER_REFUSAL_STATUS as Record<string, number>)[word] as number);
    }
  });
});

describe("what a token opens", () => {
  test("an exchanged token works on GET /compute/runners/me and answers the runner's id, name and capacity", async () => {
    const { runnerId, token } = await runnerWithToken({ runtimes: ["apptainer", "podman"] });
    const res = await call("GET", "/compute/runners/me", { bearer: token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      runner_id: runnerId,
      name: "lab_a_cpu",
      pool: "cpu",
      cores: 16,
      memory_mb: 64_000,
      gpus: 0,
      scratch_gb: 500,
      backend: "local",
      runtimes: ["apptainer", "podman"],
      arch: "amd64",
      accounting: "none",
      site: "lab_a",
      trust: "lab",
    });
  });

  test("/me refuses no header, a secret, an API key, a malformed token and an unissued token as runner_unknown", async () => {
    const { secret } = await runnerWithToken();
    for (const bearer of [secret, COMPUTE_KEYS.owner, "nmra_short", `nmra_${"2".repeat(64)}`]) {
      const res = await call("GET", "/compute/runners/me", { bearer });
      expect([bearer.slice(0, 6), res.status, res.body]).toEqual([
        bearer.slice(0, 6),
        401,
        { error: "runner_unknown" },
      ]);
    }
    const bare = await app.request("/compute/runners/me", {}, envOf());
    expect([bare.status, await bare.json()]).toEqual([401, { error: "runner_unknown" }]);
  });

  test("the token is refused on GET /users/me and on the admin router, and the secret too, by the word of the protocol", async () => {
    const { secret, token } = await runnerWithToken();
    for (const bearer of [token, secret]) {
      for (const [method, path] of [
        ["GET", "/users/me"],
        ["GET", "/admin/compute/runners"],
        ["GET", "/admin/compute/status"],
        ["GET", "/admin/compute/pools"],
      ] as const) {
        const res = await call(method, path, { bearer });
        expect([bearer.slice(0, 6), path, res.status, res.body]).toEqual([
          bearer.slice(0, 6),
          path,
          401,
          { error: "runner_credential_not_accepted" },
        ]);
      }
    }
  });

  test("resolveApiKeyUser refuses both prefixes BEFORE any lookup, and even when `tokens` holds their hash", async () => {
    const { secret, token } = await runnerWithToken();
    // No database at all: a lookup would throw, so a refusal that comes back made none.
    for (const credential of [secret, token, `nmr_${"3".repeat(64)}`, "nmra_x", "nmr_"]) {
      expect([
        credential.slice(0, 6),
        await resolveApiKeyUser({} as unknown as Bindings, credential),
      ]).toEqual([credential.slice(0, 6), { kind: "runner_credential" }]);
    }
    // Even a row of `tokens` that names such a value's hash, for a live account, does not authenticate it.
    for (const credential of [secret, token]) {
      db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
        ids.owner,
        await sha256(credential),
        credential.slice(0, 8),
      );
      expect(await resolveApiKeyUser(envOf(), credential)).toEqual({ kind: "runner_credential" });
      const res = await call("GET", "/users/me", { bearer: credential });
      expect([res.status, res.body]).toEqual([401, { error: "runner_credential_not_accepted" }]);
    }
    // An ordinary key is untouched by the rule: `nm_` is not `nmr_`.
    expect((await resolveApiKeyUser(envOf(), COMPUTE_KEYS.owner)).kind).toBe("user");
  });

  test("an expired token is runner_token_expired, judged on D1's clock", async () => {
    const { token } = await runnerWithToken();
    db.run("UPDATE compute_runner_tokens SET expires_at = datetime('now', '+30 seconds')");
    expect((await call("GET", "/compute/runners/me", { bearer: token })).status).toBe(200);
    db.run("UPDATE compute_runner_tokens SET expires_at = datetime('now', '-1 seconds')");
    const res = await call("GET", "/compute/runners/me", { bearer: token });
    expect([res.status, res.body]).toEqual([401, { error: "runner_token_expired" }]);
  });

  test("a token whose registration is revoked is refused even if its row is still there", async () => {
    const { token } = await runnerWithToken();
    db.run(
      "UPDATE compute_runners SET revoked_at = datetime('now'), revoke_reason = 'owner_revoked'",
    );
    expect(count("SELECT COUNT(*) AS n FROM compute_runner_tokens")).toBe(1);
    const res = await call("GET", "/compute/runners/me", { bearer: token });
    expect([res.status, res.body]).toEqual([401, { error: "runner_unknown" }]);
  });
});

describe("the dark switch", () => {
  const OFF: Array<[string, Record<string, unknown>]> = [
    ["the runners switch unset", { COMPUTE_RUNNERS_ENABLED: undefined }],
    ["the runners switch true", { COMPUTE_RUNNERS_ENABLED: "true" }],
    ["the runners switch 0", { COMPUTE_RUNNERS_ENABLED: "0" }],
    ["the runners switch a number", { COMPUTE_RUNNERS_ENABLED: 1 }],
    ["compute off", { COMPUTE_ENABLED: undefined }],
    ["compute true", { COMPUTE_ENABLED: "true" }],
    ["the environment staging", { ENVIRONMENT: "staging" }],
    ["the environment unset", { ENVIRONMENT: undefined }],
  ];

  test.each(OFF)(
    "%s refuses the exchange and the use of a token, and writes nothing",
    async (_name, over) => {
      const { secret, token } = await runnerWithToken();
      const before = rows("compute_runners");
      const tokensBefore = rows("compute_runner_tokens");
      const off = envOf(over);
      const ex = await exchange(secret, RUN_BODY, off);
      expect([ex.status, ex.body]).toEqual([503, { error: "runners_disabled" }]);
      const me = await call("GET", "/compute/runners/me", { bearer: token, env: off });
      expect([me.status, me.body]).toEqual([503, { error: "runners_disabled" }]);
      expect(rows("compute_runners")).toBe(before);
      expect(rows("compute_runner_tokens")).toBe(tokensBefore);
      // On again, the same token and secret work: switching off revoked nothing.
      expect((await call("GET", "/compute/runners/me", { bearer: token })).status).toBe(200);
    },
  );

  test("the switch is judged before the credential: a bad secret is runners_disabled, not runner_unknown, while it is off", async () => {
    const off = envOf({ COMPUTE_RUNNERS_ENABLED: undefined });
    const res = await exchange(`nmr_${"4".repeat(64)}`, RUN_BODY, off);
    expect([res.status, res.body]).toEqual([503, { error: "runners_disabled" }]);
  });
});

describe("mounting", () => {
  test("the Worker mounts the runner routes at /compute/runners and the owner's at /admin/compute/runners", async () => {
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    const off = { DB: realD1(db), ENVIRONMENT: "production" } as unknown as Bindings;
    const me = await worker.fetch(
      new Request("https://api.nemar.org/compute/runners/me"),
      off,
      ctx,
    );
    expect([me.status, await me.json()]).toEqual([503, { error: "runners_disabled" }]);
    const list = await worker.fetch(
      new Request("https://api.nemar.org/admin/compute/runners", {
        headers: { Authorization: `Bearer ${COMPUTE_KEYS.owner}` },
      }),
      off,
      ctx,
    );
    expect(list.status).toBe(200);
    expect(z.object({ runners: z.array(z.unknown()) }).safeParse(await list.json()).success).toBe(
      true,
    );
  });
});

// --- Revoke ----------------------------------------------------------------------------------------

let jobSeq = 0;
const jobId = () => `job_${(++jobSeq).toString(16).padStart(24, "0")}`;
const lease = () => (++jobSeq).toString(16).padStart(32, "0");

/** A runner job row through the real schema; returns its id. */
function seedJob(over: Record<string, unknown>): string {
  const row: Record<string, unknown> = {
    id: jobId(),
    source: "cli",
    kind: "batch",
    app_id: "nemar-launch",
    app_version: "1.0.0",
    spec_digest: "a".repeat(64),
    partition: "shared",
    pool: "cpu",
    nodes: 1,
    cores_per_node: 4,
    minutes: 60,
    executor: "runner",
    accounting: "none",
    ...over,
  };
  const cols = Object.keys(row);
  db.query(
    `INSERT INTO compute_jobs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  ).run(...(cols.map((c) => row[c]) as never[]));
  return row.id as string;
}

const jobRow = (id: string) => db.query("SELECT * FROM compute_jobs WHERE id = ?").get(id) as Loose;

describe("revoke", () => {
  test("it ends the token at once, releases an unstarted claim and makes a started job unreported with no lease", async () => {
    const mine = await runnerWithToken();
    const other = await runnerWithToken({ name: "other_runner" });
    const claimed = seedJob({
      runner_id: mine.runnerId,
      runner_claimed_at: "2026-11-13 10:00:00",
      lease_id: lease(),
      lease_expires_at: "2026-11-13 10:10:00",
      claim_attempts: 1,
      runner_backend: "local",
    });
    const started = seedJob({
      runner_id: mine.runnerId,
      runner_claimed_at: "2026-11-13 10:00:00",
      lease_id: lease(),
      lease_expires_at: "2026-11-13 10:10:00",
      claim_attempts: 1,
      state: "running",
      started_at: "2026-11-13 10:01:00",
    });
    const archiving = seedJob({
      runner_id: mine.runnerId,
      runner_claimed_at: "2026-11-13 10:00:00",
      lease_id: lease(),
      lease_expires_at: "2026-11-13 10:10:00",
      state: "archiving",
      started_at: "2026-11-13 10:01:00",
    });
    // A slurm job in its scheduler's queue has no `started_at` yet, but is not a claim to give away.
    const queued = seedJob({
      runner_id: mine.runnerId,
      runner_claimed_at: "2026-11-13 10:00:00",
      lease_id: lease(),
      lease_expires_at: "2026-11-13 10:10:00",
      state: "queued",
      runner_backend: "slurm",
    });
    // A row that says it started while still `created` is a started job, never a claim to release.
    const oddlyStarted = seedJob({
      runner_id: mine.runnerId,
      runner_claimed_at: "2026-11-13 10:00:00",
      lease_id: lease(),
      lease_expires_at: "2026-11-13 10:10:00",
      started_at: "2026-11-13 10:01:00",
    });
    const lost = seedJob({
      runner_id: mine.runnerId,
      runner_claimed_at: "2026-11-13 10:00:00",
      lease_id: lease(),
      lease_expires_at: "2026-11-13 10:10:00",
      state: "unreported",
      started_at: "2026-11-13 10:01:00",
    });
    const finished = seedJob({
      runner_id: mine.runnerId,
      runner_claimed_at: "2026-11-13 10:00:00",
      lease_id: lease(),
      lease_expires_at: "2026-11-13 10:10:00",
      state: "finished",
      started_at: "2026-11-13 10:01:00",
      ended_at: "2026-11-13 10:05:00",
    });
    const cancelledUnstarted = seedJob({
      runner_id: mine.runnerId,
      runner_claimed_at: "2026-11-13 10:00:00",
      lease_id: lease(),
      lease_expires_at: "2026-11-13 10:10:00",
      state: "cancelled",
      ended_at: "2026-11-13 10:05:00",
    });
    const waiting = seedJob({});
    const othersClaim = seedJob({
      runner_id: other.runnerId,
      runner_claimed_at: "2026-11-13 10:00:00",
      lease_id: lease(),
      lease_expires_at: "2026-11-13 10:10:00",
    });
    const othersStarted = seedJob({
      runner_id: other.runnerId,
      runner_claimed_at: "2026-11-13 10:00:00",
      lease_id: lease(),
      lease_expires_at: "2026-11-13 10:10:00",
      state: "running",
      started_at: "2026-11-13 10:01:00",
    });
    const snapshot = (id: string) => JSON.stringify(jobRow(id));
    const untouched = [finished, cancelledUnstarted, waiting, othersClaim, othersStarted].map(
      (id) => [id, snapshot(id)],
    );
    const lostLeaseBefore = jobRow(lost).lease_id;
    expect(lostLeaseBefore).not.toBeNull();

    expect((await call("GET", "/compute/runners/me", { bearer: mine.token })).status).toBe(200);
    const res = await call("POST", `/admin/compute/runners/${mine.runnerId}/revoke`, {
      who: "owner",
    });
    expect([res.status, res.body]).toEqual([
      200,
      { runner_id: mine.runnerId, revoked: true, already_revoked: false },
    ]);

    // The token stops at once, and the secret buys nothing.
    const me = await call("GET", "/compute/runners/me", { bearer: mine.token });
    expect([me.status, me.body]).toEqual([401, { error: "runner_unknown" }]);
    expect((await exchange(mine.secret)).status).toBe(401);
    expect(
      count("SELECT COUNT(*) AS n FROM compute_runner_tokens WHERE runner_id = ?", mine.runnerId),
    ).toBe(0);

    // The unstarted claim is released: waiting again, claim and lease cleared, the claim still counted.
    expect(jobRow(claimed)).toMatchObject({
      state: "created",
      runner_id: null,
      runner_claimed_at: null,
      lease_id: null,
      lease_expires_at: null,
      claim_attempts: 1,
      runner_backend: "local",
    });
    // A started job is unreported with no lease, and still names its runner.
    for (const id of [started, archiving, lost, queued, oddlyStarted]) {
      expect(jobRow(id)).toMatchObject({
        state: "unreported",
        lease_id: null,
        lease_expires_at: null,
        runner_id: mine.runnerId,
      });
    }
    expect(jobRow(started).started_at).toBe("2026-11-13 10:01:00");
    // Everything else is as it was: a job that ended, one never claimed, another runner's.
    for (const [id, before] of untouched)
      expect([id, snapshot(id as string)]).toEqual([id, before]);

    // The registration is revoked, with a reason, and the other runner still works.
    expect(
      db
        .query("SELECT revoke_reason, revoked_at FROM compute_runners WHERE id = ?")
        .get(mine.runnerId),
    ).toMatchObject({ revoke_reason: "owner_revoked" });
    expect((await call("GET", "/compute/runners/me", { bearer: other.token })).status).toBe(200);
    const audit = db
      .query("SELECT * FROM audit_log WHERE action = 'compute.runner.revoked'")
      .all() as Array<Loose>;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ user_id: ids.owner, resource_id: mine.runnerId });
  });

  test("a second revoke changes nothing and answers already_revoked; an unknown or malformed id is runner_not_found", async () => {
    const { runnerId } = await runnerWithToken();
    const first = await call("POST", `/admin/compute/runners/${runnerId}/revoke`, { who: "owner" });
    expect(first.status).toBe(200);
    const tablesBefore = [rows("compute_runners"), rows("compute_jobs"), rows("audit_log")];
    const again = await call("POST", `/admin/compute/runners/${runnerId}/revoke`, {
      who: "owner2",
    });
    expect([again.status, again.body]).toEqual([
      200,
      { runner_id: runnerId, revoked: true, already_revoked: true },
    ]);
    expect([rows("compute_runners"), rows("compute_jobs"), rows("audit_log")]).toEqual(
      tablesBefore,
    );
    for (const id of [`rnr_${"0".repeat(24)}`, "rnr_x", "nope", `rnr_${"A".repeat(24)}`]) {
      const res = await call("POST", `/admin/compute/runners/${id}/revoke`, { who: "owner" });
      expect([id, res.status, res.body.code]).toEqual([id, 404, "runner_not_found"]);
    }
  });
});
