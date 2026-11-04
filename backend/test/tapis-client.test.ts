/**
 * The Tapis client (epic #2005 phase A4, #2009; ADR 0118), driven against a REAL local HTTP server,
 * `helpers/tapis-standin.ts`, through `globalThis.NEMAR_TAPIS_API_URL`. The client under test is the
 * production one; nothing in it is replaced.
 *
 * NO RESPONSE THIS FILE RELIES ON WAS RECORDED FROM A REAL TENANT. There is no tenant yet. The
 * stand-in answers with the request and response examples of Tapis's published OpenAPI
 * specifications and documentation, so these tests prove the client does what NEMAR means against
 * what Tapis SAYS it does, and nothing about what a real tenant does. The pull request lists what is
 * unverified: which credential strategy the operator grants, whether `listType=ALL_JOBS` returns every
 * person's jobs, the POST search body, the permission to mint service tokens, the webhook retry
 * policy, and the scheduler option for GPUs.
 *
 * What is pinned, each by a test of its own:
 *  - both credential strategies (a password grant, and a service credential that mints a token per
 *    username) are chosen by configuration, and the very same client call works under either;
 *  - a token is cached by strategy and username, refreshed inside a lead before it ends, shared by
 *    concurrent callers (one mint), and a failed mint is dropped;
 *  - a 401 refreshes the token once and retries once; a second 401 is `unauthorized`;
 *  - a hung upstream ends as `unavailable` inside the timeout; reads retry through `isRetryable` and
 *    a submit never does; a body that is not JSON, fails its schema or is too large is
 *    `invalid_response`, never partly trusted;
 *  - `submitJob` sends exactly the documented request: the tag, GPUs as a scheduler option, the
 *    partition as the logical queue, and no archive system field;
 *  - the launch specification (which holds the job's token) travels in `parameterSet`, which a Tapis
 *    job record returns to whoever can read the record: the client never hands that field back, and no
 *    credential or token is in any error message or log line.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PARTITION_NAMES } from "../../shared/contract/compute";
import {
  __resetTapisTokenCacheForTests,
  getTapisToken,
  invalidateTapisToken,
  mintTapisToken,
} from "../src/services/tapis/auth";
import {
  type SubmitJobInput,
  TAPIS_MAX_JSON_BYTES,
  TAPIS_TIMEOUT_MS,
  type TapisContext,
  cancelJob,
  downloadOutput,
  effectiveTimeoutMs,
  getJob,
  getJobHistory,
  listJobs,
  listOutputs,
  nemarJobTag,
  searchJobsByTag,
  submitJob,
  subscribeWebhook,
  tapisHealth,
} from "../src/services/tapis/client";
import { TAPIS_BASE, tapisConfig } from "../src/services/tapis/config";
import { TAPIS_ERROR_KINDS, TapisError } from "../src/services/tapis/errors";
import { type TapisStandin, startTapisStandin } from "./helpers/tapis-standin";

const OWNER = "someone-owner";
const OTHER_OWNER = "another-owner";
const JOB_ID = "job_0123456789abcdef01234567";
/** Stands for the job's token inside the launch specification. It must never be echoed. */
const TOKEN_MARK = "JOBTOKEN-MARK-5512";
const LAUNCH_SPEC = `{"schema":"nemar.launch-spec.v1","job_id":"${JOB_ID}","job_token":"${TOKEN_MARK}"}`;

let standin: TapisStandin;
let previousOverride: string | undefined;

beforeAll(() => {
  standin = startTapisStandin();
  previousOverride = (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL;
  (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL = standin.url;
});

afterAll(() => {
  (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL = previousOverride;
  standin.stop();
});

beforeEach(() => {
  standin.reset();
  __resetTapisTokenCacheForTests();
});

type EnvLike = Parameters<typeof tapisConfig>[0];

/** An address nothing listens on and that the override must keep the client away from. */
const UNREACHABLE = "https://tapis-tenant.invalid";

function passwordEnv(over: Record<string, unknown> = {}): EnvLike {
  return {
    ENVIRONMENT: "production",
    TAPIS_AUTH_STRATEGY: "password",
    TAPIS_BASE_URL: UNREACHABLE,
    TAPIS_TENANT_ID: standin.tenantId,
    TAPIS_USERNAME: standin.username,
    TAPIS_PASSWORD: standin.password,
    ...over,
  } as EnvLike;
}

function serviceEnv(over: Record<string, unknown> = {}): EnvLike {
  return {
    ENVIRONMENT: "production",
    TAPIS_AUTH_STRATEGY: "service",
    TAPIS_BASE_URL: UNREACHABLE,
    TAPIS_TENANT_ID: standin.tenantId,
    TAPIS_SERVICE_TOKEN: standin.serviceToken,
    ...over,
  } as EnvLike;
}

const STRATEGIES = [
  ["password", passwordEnv],
  ["service", serviceEnv],
] as const;

/** A call context with a short timeout and no wait between retries, so no test waits. */
function ctx(env: EnvLike, over: Partial<TapisContext> = {}): TapisContext {
  return { env, owner: OWNER, timeoutMs: 400, retryDelayMs: 1, ...over };
}

/** Run with the test override of the address removed, as a deployed Worker is. */
async function withoutOverride<T>(run: () => T | Promise<T>): Promise<T> {
  const g = globalThis as { NEMAR_TAPIS_API_URL?: string };
  const saved = g.NEMAR_TAPIS_API_URL;
  try {
    g.NEMAR_TAPIS_API_URL = undefined;
    return await run();
  } finally {
    g.NEMAR_TAPIS_API_URL = saved;
  }
}

const SUBMIT: SubmitJobInput = {
  jobId: JOB_ID,
  appId: "nemar-launch",
  appVersion: "1.0.0",
  partition: "shared",
  nodes: 1,
  coresPerNode: 8,
  memoryMb: 16384,
  gpus: 0,
  minutes: 120,
  launchSpec: LAUNCH_SPEC,
};

async function failure(run: () => Promise<unknown>): Promise<TapisError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof TapisError) return err;
    throw err;
  }
  throw new Error("expected a TapisError, but the call succeeded");
}

/** Capture what the code under test writes to the console, and put it back. */
function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const saved = { ...console };
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    console[level] = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }
  return {
    lines,
    restore: () => {
      Object.assign(console, saved);
    },
  };
}

const jobCalls = (route: string) => standin.log.filter((r) => r.route === route);

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

describe("tapisConfig and TAPIS_BASE", () => {
  test("a Worker with nothing set is unconfigured, and says which names are missing", async () => {
    // With the test override installed the address is never missing, so it is taken away here.
    const config = await withoutOverride(() => tapisConfig({} as EnvLike));
    expect(config).toEqual({
      unconfigured: true,
      problems: [
        "TAPIS_AUTH_STRATEGY:missing",
        "TAPIS_BASE_URL:missing",
        "TAPIS_TENANT_ID:missing",
      ],
    });
    // The override counts as an address, so only the strategy and the tenant are missing.
    expect(tapisConfig({} as EnvLike)).toEqual({
      unconfigured: true,
      problems: ["TAPIS_AUTH_STRATEGY:missing", "TAPIS_TENANT_ID:missing"],
    });
  });

  test("the password strategy needs a username and a password, and reads them", () => {
    expect(tapisConfig(passwordEnv({ TAPIS_BASE_URL: "https://a.example/" }))).toEqual({
      // The override is installed, so the address is the stand-in's, not the variable's.
      strategy: "password",
      baseUrl: standin.url,
      tenantId: standin.tenantId,
      username: standin.username,
      password: standin.password,
    });
    const missing = tapisConfig(passwordEnv({ TAPIS_PASSWORD: undefined, TAPIS_USERNAME: "" }));
    expect(missing).toEqual({
      unconfigured: true,
      problems: ["TAPIS_USERNAME:missing", "TAPIS_PASSWORD:missing"],
    });
  });

  test("the service strategy needs the service token, and reads an optional probe username", () => {
    expect(tapisConfig(serviceEnv())).toEqual({
      strategy: "service",
      baseUrl: standin.url,
      tenantId: standin.tenantId,
      serviceToken: standin.serviceToken,
      username: undefined,
    });
    expect(tapisConfig(serviceEnv({ TAPIS_USERNAME: "probe-user" }))).toMatchObject({
      strategy: "service",
      username: "probe-user",
    });
    expect(tapisConfig(serviceEnv({ TAPIS_SERVICE_TOKEN: undefined }))).toEqual({
      unconfigured: true,
      problems: ["TAPIS_SERVICE_TOKEN:missing"],
    });
  });

  test("a strategy that is neither is unconfigured, never a guess", () => {
    for (const strategy of ["oauth", "Password", " password", "SERVICE", ""]) {
      const config = tapisConfig(passwordEnv({ TAPIS_AUTH_STRATEGY: strategy }));
      expect(config).toMatchObject({ unconfigured: true });
      expect((config as { problems: string[] }).problems).toContain(
        strategy === "" ? "TAPIS_AUTH_STRATEGY:missing" : "TAPIS_AUTH_STRATEGY:unknown",
      );
    }
  });

  test("TAPIS_BASE is the test override when set, else the variable, without a trailing slash", async () => {
    const env = passwordEnv({ TAPIS_BASE_URL: "https://tenant.example/" });
    expect(TAPIS_BASE(env)).toBe(standin.url);
    await withoutOverride(() => {
      expect(TAPIS_BASE(env)).toBe("https://tenant.example");
      expect(TAPIS_BASE({} as EnvLike)).toBeUndefined();
      expect(TAPIS_BASE(passwordEnv({ TAPIS_BASE_URL: "  " }))).toBeUndefined();
    });
  });

  test("without the override, a variable that is not an https address is refused", async () => {
    await withoutOverride(() => {
      for (const bad of ["http://tenant.example", "tenant.example", "https://u:p@tenant.example"]) {
        expect(tapisConfig(passwordEnv({ TAPIS_BASE_URL: bad }))).toEqual({
          unconfigured: true,
          problems: ["TAPIS_BASE_URL:not_https"],
        });
      }
      expect(tapisConfig(passwordEnv({ TAPIS_BASE_URL: "https://tenant.example" }))).toMatchObject({
        strategy: "password",
        baseUrl: "https://tenant.example",
      });
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Unconfigured: nothing is sent
// ---------------------------------------------------------------------------------------------

describe("a Worker that is not configured", () => {
  test("every call is `unconfigured` and sends no request", async () => {
    const env = {} as EnvLike;
    const calls: Array<() => Promise<unknown>> = [
      () => submitJob(ctx(env), SUBMIT),
      () => getJob(ctx(env), "abc-007"),
      () => getJobHistory(ctx(env), "abc-007"),
      () => cancelJob(ctx(env), "abc-007"),
      () => searchJobsByTag(ctx(env), nemarJobTag(JOB_ID)),
      () => listJobs(ctx(env), { listType: "ALL_JOBS", limit: 10, skip: 0 }),
      () => subscribeWebhook(ctx(env), "abc-007", "https://hooks.example/x", 60),
      () => listOutputs(ctx(env), "abc-007", ""),
      () => downloadOutput(ctx(env), "abc-007", "work/outputs/a.csv", 1000),
      () => getTapisToken(env, { owner: OWNER }),
    ];
    for (const run of calls) {
      expect((await failure(run)).kind).toBe("unconfigured");
    }
    expect(standin.log).toHaveLength(0);
  });

  test("the health call is `unconfigured` without an address, and sends nothing", async () => {
    await withoutOverride(async () => {
      expect((await failure(() => tapisHealth({} as EnvLike))).kind).toBe("unconfigured");
    });
    expect(standin.log).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The two strategies, and the same client under either
// ---------------------------------------------------------------------------------------------

describe("the password strategy", () => {
  test("posts the password grant, with no token header, for the configured account", async () => {
    const env = passwordEnv();
    await getJob(ctx(env), (await submitJob(ctx(env), SUBMIT)).uuid);
    const mints = jobCalls("POST /v3/oauth2/tokens");
    expect(mints).toHaveLength(1);
    expect(JSON.parse(mints[0]?.body ?? "")).toEqual({
      username: standin.username,
      password: standin.password,
      grant_type: "password",
    });
    expect(mints[0]?.headers["x-tapis-token"]).toBeUndefined();
    expect(mints[0]?.headers["content-type"]).toContain("application/json");
    expect(jobCalls("POST /v3/tokens")).toHaveLength(0);
  });

  test("one token serves every owner (the account is the configured one)", async () => {
    const env = passwordEnv();
    await getJob(
      ctx(env, { owner: OWNER }),
      (await submitJob(ctx(env, { owner: OWNER }), SUBMIT)).uuid,
    );
    const second = await submitJob(ctx(env, { owner: OTHER_OWNER }), {
      ...SUBMIT,
      jobId: "job_aaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(standin.mints()).toEqual({ password: 1, service: 0 });
    expect(JSON.parse(jobCalls("POST /v3/jobs/submit")[1]?.body ?? "").owner).toBe(OTHER_OWNER);
    expect(second.owner).toBe(OTHER_OWNER);
  });

  test("a wrong password is `unauthorized` and is not retried", async () => {
    const env = passwordEnv({ TAPIS_PASSWORD: "not-the-password" });
    const err = await failure(() => getJob(ctx(env), "abc-007"));
    expect(err.kind).toBe("unauthorized");
    expect(err.status).toBe(401);
    expect(jobCalls("POST /v3/oauth2/tokens")).toHaveLength(1);
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(0);
  });
});

describe("the service strategy", () => {
  test("posts the service token in X-Tapis-Token and the owner's username", async () => {
    const env = serviceEnv();
    await submitJob(ctx(env, { owner: OWNER }), SUBMIT);
    const mints = jobCalls("POST /v3/tokens");
    expect(mints).toHaveLength(1);
    expect(mints[0]?.headers["x-tapis-token"]).toBe(standin.serviceToken);
    expect(JSON.parse(mints[0]?.body ?? "")).toEqual({
      account_type: "user",
      token_tenant_id: standin.tenantId,
      token_username: OWNER,
      access_token_ttl: 3600,
    });
    expect(jobCalls("POST /v3/oauth2/tokens")).toHaveLength(0);
  });

  test("a token is kept for each owner, never shared between two", async () => {
    const env = serviceEnv();
    await submitJob(ctx(env, { owner: OWNER }), SUBMIT);
    await submitJob(ctx(env, { owner: OWNER }), {
      ...SUBMIT,
      jobId: "job_bbbbbbbbbbbbbbbbbbbbbbbb",
    });
    expect(standin.mints().service).toBe(1);
    await submitJob(ctx(env, { owner: OTHER_OWNER }), {
      ...SUBMIT,
      jobId: "job_cccccccccccccccccccccccc",
    });
    expect(standin.mints().service).toBe(2);
    const usernames = jobCalls("POST /v3/tokens").map((r) => JSON.parse(r.body).token_username);
    expect(usernames).toEqual([OWNER, OTHER_OWNER]);
    // The jobs were submitted under the token of their own owner.
    const owners = [...standin.jobs.values()].map((j) => j.record.createdby);
    expect(owners).toEqual([OWNER, OWNER, OTHER_OWNER]);
  });

  test("a service credential the tenant does not accept is `unauthorized`", async () => {
    const err = await failure(() =>
      getJob(ctx(serviceEnv({ TAPIS_SERVICE_TOKEN: "nope" })), "abc-007"),
    );
    expect(err.kind).toBe("unauthorized");
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(0);
  });
});

describe.each(STRATEGIES)("the same client under the %s strategy", (_name, makeEnv) => {
  test("submits, reads, searches, cancels and lists with one set of calls", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    expect(submitted.status).toBe("PENDING");
    expect(submitted.owner).toBe(OWNER);

    standin.advance(submitted.uuid, "QUEUED");
    standin.advance(submitted.uuid, "RUNNING");
    const running = await getJob(ctx(env), submitted.uuid);
    expect(running.status).toBe("RUNNING");
    expect(running.remoteStarted).toEqual(expect.any(String));

    const found = await searchJobsByTag(ctx(env), nemarJobTag(JOB_ID));
    expect(found.map((j) => j.uuid)).toEqual([submitted.uuid]);

    const listed = await listJobs(ctx(env), { listType: "ALL_JOBS", limit: 10, skip: 0 });
    expect(listed.map((j) => j.uuid)).toEqual([submitted.uuid]);

    const history = await getJobHistory(ctx(env), submitted.uuid);
    expect(history.map((e) => e.event)).toEqual([
      "JOB_NEW_STATUS",
      "JOB_NEW_STATUS",
      "JOB_NEW_STATUS",
    ]);

    await cancelJob(ctx(env), submitted.uuid);
    expect((await getJob(ctx(env), submitted.uuid)).status).toBe("CANCELLED");
  });

  test("every call after the mint carries the minted token in X-Tapis-Token", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    await getJob(ctx(env), submitted.uuid);
    await getJobHistory(ctx(env), submitted.uuid);
    await listJobs(ctx(env), { listType: "MY_JOBS", limit: 5, skip: 0 });
    const calls = standin.log.filter((r) => r.path.startsWith("/v3/jobs/"));
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.headers["x-tapis-token"]).toMatch(/^standin-token-/);
      expect(call.status).toBe(200);
    }
    // One token, used four times.
    expect(new Set(calls.map((c) => c.headers["x-tapis-token"])).size).toBe(1);
  });

  test("a 401 refreshes the token once and retries once", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    standin.log.length = 0;
    standin.expireTokens();
    const job = await getJob(ctx(env), submitted.uuid);
    expect(job.uuid).toBe(submitted.uuid);
    // The call, the 401, a fresh mint, the retry that succeeded: and nothing else.
    expect(standin.log.map((r) => `${r.route} ${r.status}`)).toEqual([
      "GET /v3/jobs/:uuid 401",
      expect.stringMatching(/^POST \/v3\/(oauth2\/)?tokens 201$/),
      "GET /v3/jobs/:uuid 200",
    ]);
    expect(jobCalls("GET /v3/jobs/:uuid")[0]?.headers["x-tapis-token"]).not.toBe(
      jobCalls("GET /v3/jobs/:uuid")[1]?.headers["x-tapis-token"],
    );
  });

  test("a second 401 is `unauthorized`, after exactly one refresh and one retry", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    standin.log.length = 0;
    standin.rejectAllTokens(true);
    const err = await failure(() => getJob(ctx(env), submitted.uuid));
    expect(err.kind).toBe("unauthorized");
    expect(err.status).toBe(401);
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(2);
    expect(standin.log.filter((r) => r.route.includes("tokens"))).toHaveLength(1);
  });

  test("a 401 of a submit is refreshed and retried as well, because nothing was created", async () => {
    const env = makeEnv();
    await submitJob(ctx(env), SUBMIT);
    standin.expireTokens();
    await submitJob(ctx(env), { ...SUBMIT, jobId: "job_dddddddddddddddddddddddd" });
    expect([...standin.jobs.values()]).toHaveLength(2);
  });

  test("a hung upstream ends as `unavailable` inside the timeout, and reads try three times", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    standin.hang("GET /v3/jobs/:uuid", 10);
    const started = Date.now();
    const err = await failure(() => getJob(ctx(env, { timeoutMs: 150 }), submitted.uuid));
    expect(err.kind).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(3);
  });

  test("a submit that hangs is `unavailable` and is NEVER retried inside the client", async () => {
    const env = makeEnv();
    standin.hang("POST /v3/jobs/submit", 10);
    const err = await failure(() => submitJob(ctx(env, { timeoutMs: 150 }), SUBMIT));
    expect(err.kind).toBe("unavailable");
    expect(jobCalls("POST /v3/jobs/submit")).toHaveLength(1);
  });

  test("a submit answered 503 is `unavailable` and is not retried either", async () => {
    const env = makeEnv();
    standin.fail("POST /v3/jobs/submit", 503, 5);
    const err = await failure(() => submitJob(ctx(env), SUBMIT));
    expect(err.kind).toBe("unavailable");
    expect(err.status).toBe(503);
    expect(jobCalls("POST /v3/jobs/submit")).toHaveLength(1);
  });

  test("a read that is answered 503 twice and then 200 succeeds on the third try", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    standin.fail("GET /v3/jobs/:uuid", 503, 2);
    const job = await getJob(ctx(env), submitted.uuid);
    expect(job.uuid).toBe(submitted.uuid);
    expect(jobCalls("GET /v3/jobs/:uuid").map((r) => r.status)).toEqual([503, 503, 200]);
  });

  test("a read that is answered 503 three times is `unavailable`, with the status", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    standin.fail("GET /v3/jobs/:uuid", 503, 9);
    const err = await failure(() => getJob(ctx(env), submitted.uuid));
    expect(err.kind).toBe("unavailable");
    expect(err.status).toBe(503);
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(3);
  });

  test("429 is `unavailable` and a read retries it", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    standin.fail("GET /v3/jobs/:uuid", 429, 1);
    expect((await getJob(ctx(env), submitted.uuid)).uuid).toBe(submitted.uuid);
    expect(jobCalls("GET /v3/jobs/:uuid").map((r) => r.status)).toEqual([429, 200]);
    // And when it does not clear, it is `unavailable` (a rate limit is not a refusal of the request).
    standin.fail("GET /v3/jobs/:uuid", 429, 9);
    const err = await failure(() => getJob(ctx(env), submitted.uuid));
    expect(err.kind).toBe("unavailable");
    expect(err.status).toBe(429);
  });

  test("404 is `not_found`, 400 and 409 are `rejected`, each with its status and no retry", async () => {
    const env = makeEnv();
    const missing = await failure(() => getJob(ctx(env), "no-such-job-007"));
    expect(missing.kind).toBe("not_found");
    expect(missing.status).toBe(404);
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(1);

    standin.fail("POST /v3/jobs/submit", 400);
    const bad = await failure(() => submitJob(ctx(env), SUBMIT));
    expect(bad.kind).toBe("rejected");
    expect(bad.status).toBe(400);

    const submitted = await submitJob(ctx(env), {
      ...SUBMIT,
      jobId: "job_eeeeeeeeeeeeeeeeeeeeeeee",
    });
    standin.advance(submitted.uuid, "FINISHED");
    const terminal = await failure(() => cancelJob(ctx(env), submitted.uuid));
    expect(terminal.kind).toBe("rejected");
    expect(terminal.status).toBe(409);
  });

  test("403 is `unauthorized` and is not refreshed", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    standin.fail("GET /v3/jobs/:uuid", 403, 5);
    const err = await failure(() => getJob(ctx(env), submitted.uuid));
    expect(err.kind).toBe("unauthorized");
    expect(err.status).toBe(403);
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(1);
    expect(standin.log.filter((r) => r.route.includes("tokens"))).toHaveLength(1);
  });

  test("a body that is not JSON is `invalid_response`, and is not retried", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    standin.nonJson("GET /v3/jobs/:uuid", 5);
    const err = await failure(() => getJob(ctx(env), submitted.uuid));
    expect(err.kind).toBe("invalid_response");
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(1);
  });

  test("a body that fails its schema is `invalid_response`, never partly trusted", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    // A job with no uuid, one with a status that is not a string, and an envelope with no result.
    for (const body of [
      {
        status: "success",
        message: "ok",
        version: "1",
        result: { owner: "x", status: "FINISHED" },
      },
      { status: "success", message: "ok", version: "1", result: { uuid: "u-007", status: 7 } },
      { status: "success", message: "ok", version: "1" },
      { status: 7, result: { uuid: "u-007", status: "FINISHED" } },
      [],
      null,
    ]) {
      standin.respond("GET /v3/jobs/:uuid", 200, body);
      const err = await failure(() => getJob(ctx(env), submitted.uuid));
      expect(err.kind).toBe("invalid_response");
    }
  });

  test("a response over the size bound is `invalid_response`", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    const big = JSON.stringify({
      status: "success",
      message: "ok",
      version: "1",
      result: {
        uuid: submitted.uuid,
        status: "PENDING",
        lastMessage: "x".repeat(TAPIS_MAX_JSON_BYTES),
      },
    });
    standin.respond("GET /v3/jobs/:uuid", 200, big);
    const err = await failure(() => getJob(ctx(env), submitted.uuid));
    expect(err.kind).toBe("invalid_response");
  });

  test("a body that never ends is cut off at the bound, not read to its end", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    let sent = 0;
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    // No Content-Length (it is chunked): only the streaming bound can stop this.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    standin.respond("GET /v3/jobs/:uuid", 200, endless, 1, { "Content-Type": "application/json" });
    const err = await failure(() => getJob(ctx(env, { timeoutMs: 5000 }), submitted.uuid));
    expect(err.kind).toBe("invalid_response");
    // The client closed the connection; the server notices a moment later.
    for (let i = 0; i < 100 && !cancelled; i++) await new Promise((r) => setTimeout(r, 10));
    expect(cancelled).toBe(true);
    // It stopped near the bound (the server's own buffer reads a little ahead), not after reading
    // the stream for seconds: an unbounded read would have taken hundreds of megabytes by now.
    expect(sent).toBeLessThan(TAPIS_MAX_JSON_BYTES * 4);
  });

  test("a body that declares a size over the bound is refused before it is read", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    // A raw socket, because an HTTP server library drops a declared length from a streamed body: it
    // sends the headers of a 2 MiB + 1 byte answer and then goes silent. A client that waited for the
    // body would end as `unavailable`, at the timeout; only the declared length says
    // `invalid_response` at once. The cached token is used, so the call needs no mint.
    const raw = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.write(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${TAPIS_MAX_JSON_BYTES + 1}\r\n\r\n `,
          );
        },
      },
    });
    const g = globalThis as { NEMAR_TAPIS_API_URL?: string };
    const saved = g.NEMAR_TAPIS_API_URL;
    try {
      g.NEMAR_TAPIS_API_URL = `http://127.0.0.1:${raw.port}`;
      const started = Date.now();
      const err = await failure(() => getJob(ctx(env, { timeoutMs: 3000 }), submitted.uuid));
      expect(err.kind).toBe("invalid_response");
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      g.NEMAR_TAPIS_API_URL = saved;
      raw.stop(true);
    }
  });

  test("concurrent calls mint one token", async () => {
    const env = makeEnv();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => getJob(ctx(env), "no-such-job-007")),
    );
    // Every call was answered 404 (the stand-in has no such job); what is pinned is the mint count.
    expect(
      results.map((r) => (r.status === "rejected" ? (r.reason as TapisError).kind : "ok")),
    ).toEqual(Array(8).fill("not_found"));
    expect(standin.mints().password + standin.mints().service).toBe(1);
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(8);
  });

  test("a failed mint is dropped, so the next call mints afresh", async () => {
    const env = makeEnv();
    standin.fail(mintRouteOf(env), 503, 1);
    const first = await failure(() => getTapisToken(env, { owner: OWNER }));
    expect(first.kind).toBe("unavailable");
    const token = await getTapisToken(env, { owner: OWNER });
    expect(token).toMatch(/^standin-token-/);
    expect(standin.mints().password + standin.mints().service).toBe(1);
    // And a token that was minted is cached.
    expect(await getTapisToken(env, { owner: OWNER })).toBe(token);
    expect(standin.mints().password + standin.mints().service).toBe(1);
  });

  test("a mint that fails while callers wait fails them all, and is not remembered", async () => {
    const env = makeEnv();
    standin.fail(mintRouteOf(env), 503, 1);
    const settled = await Promise.allSettled(
      Array.from({ length: 4 }, () => getTapisToken(env, { owner: OWNER })),
    );
    expect(settled.every((s) => s.status === "rejected")).toBe(true);
    expect(standin.log.filter((r) => r.route.includes("tokens"))).toHaveLength(1);
    expect(typeof (await getTapisToken(env, { owner: OWNER }))).toBe("string");
  });

  test("invalidateTapisToken drops the cached token, so the next call mints again", async () => {
    const env = makeEnv();
    const first = await getTapisToken(env, { owner: OWNER });
    expect(await getTapisToken(env, { owner: OWNER })).toBe(first);
    invalidateTapisToken(env, OWNER);
    const second = await getTapisToken(env, { owner: OWNER });
    expect(second).not.toBe(first);
    expect(standin.mints().password + standin.mints().service).toBe(2);
  });

  test("a token is refreshed inside its lead and used before it", async () => {
    const env = makeEnv();
    // The stand-in's tokens live 14400 s; the lead is 300 s (5 minutes), so 14100 s is the edge.
    const t0 = 1_000_000_000_000;
    const first = await getTapisToken(env, { owner: OWNER, now: () => t0 });
    expect(await getTapisToken(env, { owner: OWNER, now: () => t0 + 14_099_000 })).toBe(first);
    expect(standin.mints().password + standin.mints().service).toBe(1);
    const refreshed = await getTapisToken(env, { owner: OWNER, now: () => t0 + 14_101_000 });
    expect(refreshed).not.toBe(first);
    expect(standin.mints().password + standin.mints().service).toBe(2);
  });
});

/** The route a strategy mints through. */
function mintRouteOf(env: EnvLike): "POST /v3/oauth2/tokens" | "POST /v3/tokens" {
  return (env as { TAPIS_AUTH_STRATEGY?: string }).TAPIS_AUTH_STRATEGY === "service"
    ? "POST /v3/tokens"
    : "POST /v3/oauth2/tokens";
}

// ---------------------------------------------------------------------------------------------
// submitJob: the documented request, exactly
// ---------------------------------------------------------------------------------------------

describe("submitJob", () => {
  test("sends exactly the documented request for a CPU job", async () => {
    await submitJob(ctx(passwordEnv()), SUBMIT);
    const sent = jobCalls("POST /v3/jobs/submit");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(sent[0]?.body ?? "")).toEqual({
      name: JOB_ID,
      appId: "nemar-launch",
      appVersion: "1.0.0",
      owner: OWNER,
      execSystemLogicalQueue: "shared",
      nodeCount: 1,
      coresPerNode: 8,
      memoryMB: 16384,
      maxMinutes: 120,
      parameterSet: { envVariables: [{ key: "NEMAR_LAUNCH_SPEC", value: LAUNCH_SPEC }] },
      tags: [`nemar_job:${JOB_ID}`],
    });
  });

  test("passes GPUs as a scheduler option and the partition as the logical queue", async () => {
    await submitJob(ctx(serviceEnv()), {
      ...SUBMIT,
      partition: "gpu-shared",
      gpus: 2,
      memoryMb: undefined,
    });
    expect(JSON.parse(jobCalls("POST /v3/jobs/submit")[0]?.body ?? "")).toEqual({
      name: JOB_ID,
      appId: "nemar-launch",
      appVersion: "1.0.0",
      owner: OWNER,
      execSystemLogicalQueue: "gpu-shared",
      nodeCount: 1,
      coresPerNode: 8,
      maxMinutes: 120,
      parameterSet: {
        envVariables: [{ key: "NEMAR_LAUNCH_SPEC", value: LAUNCH_SPEC }],
        schedulerOptions: [{ arg: "--gpus=2" }],
      },
      tags: [`nemar_job:${JOB_ID}`],
    });
  });

  test("names no archive system, no execution system and no archive directory", async () => {
    await submitJob(ctx(passwordEnv()), SUBMIT);
    const body = JSON.parse(jobCalls("POST /v3/jobs/submit")[0]?.body ?? "");
    for (const key of [
      "archiveSystemId",
      "archiveSystemDir",
      "archiveMode",
      "archiveOnAppError",
      "execSystemId",
      "execSystemExecDir",
      "execSystemOutputDir",
      "subscriptions",
      "notes",
    ]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  test("the owner is a parameter: it is the request's owner whoever it is", async () => {
    const env = serviceEnv();
    await submitJob(ctx(env, { owner: "first-person" }), SUBMIT);
    await submitJob(ctx(env, { owner: "second.person@x" }), {
      ...SUBMIT,
      jobId: "job_ffffffffffffffffffffffff",
    });
    const owners = jobCalls("POST /v3/jobs/submit").map((r) => JSON.parse(r.body).owner);
    expect(owners).toEqual(["first-person", "second.person@x"]);
  });

  test("a request it would not send is refused before anything is sent", async () => {
    const env = passwordEnv();
    const bad: Array<Partial<SubmitJobInput>> = [
      { jobId: "job_nothex" },
      { jobId: "JOB_0123456789ABCDEF01234567" },
      { appId: "" },
      { appVersion: "" },
      { partition: "not-a-partition" as never },
      { nodes: 0 },
      { nodes: 1.5 },
      { coresPerNode: 0 },
      { gpus: -1 },
      { minutes: 0 },
      { memoryMb: 0 },
      { launchSpec: "" },
      { launchSpec: "café" },
      { launchSpec: "x".repeat(64 * 1024 + 1) },
    ];
    for (const over of bad) {
      await expect(submitJob(ctx(env), { ...SUBMIT, ...over })).rejects.toThrow(RangeError);
    }
    for (const owner of ["", " ", "a b", "a\nb", "x".repeat(200), "a/b"]) {
      await expect(submitJob(ctx(env, { owner }), SUBMIT)).rejects.toThrow(RangeError);
    }
    expect(standin.log).toHaveLength(0);
  });

  test("answers the job, and never hands back the field that holds the launch specification", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    // The stand-in's record has it, as Tapis's does (the job record returns parameterSet).
    const record = standin.jobs.get(job.uuid)?.record;
    expect(JSON.stringify(record)).toContain(TOKEN_MARK);
    // The client's answer does not.
    expect(job.uuid).toEqual(expect.any(String));
    expect(job.tags).toEqual([`nemar_job:${JOB_ID}`]);
    expect(JSON.stringify(job)).not.toContain(TOKEN_MARK);
    expect(job).not.toHaveProperty("parameterSet");
    expect(job).not.toHaveProperty("subscriptions");
    const read = await getJob(ctx(env), job.uuid);
    expect(JSON.stringify(read)).not.toContain(TOKEN_MARK);
    expect(read).not.toHaveProperty("parameterSet");
    const found = await searchJobsByTag(ctx(env), nemarJobTag(JOB_ID));
    expect(JSON.stringify(found)).not.toContain(TOKEN_MARK);
  });

  test("keeps what Tapis said that this client did not ask about (open responses)", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.jobs.get(job.uuid)!.record.aFieldTapisAddedLater = { deep: [1, 2] };
    const read = await getJob(ctx(env), job.uuid);
    expect(read.aFieldTapisAddedLater).toEqual({ deep: [1, 2] });
  });
});

describe("nemarJobTag", () => {
  test("is nemar_job:<id> for a NEMAR job id, and refuses anything else", () => {
    expect(nemarJobTag(JOB_ID)).toBe(`nemar_job:${JOB_ID}`);
    for (const bad of [
      "",
      "job_x",
      "nemar_job:job_0123456789abcdef01234567",
      `${JOB_ID} `,
      "x'; DROP",
    ]) {
      expect(() => nemarJobTag(bad)).toThrow(RangeError);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The other calls, and the paths and bodies they send
// ---------------------------------------------------------------------------------------------

describe("the calls and what they send", () => {
  test("getJob and getJobHistory read the documented paths", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.advance(job.uuid, "QUEUED");
    standin.log.length = 0;
    const read = await getJob(ctx(env), job.uuid);
    expect(read.status).toBe("QUEUED");
    expect(read.remoteSubmitted).toEqual(expect.any(String));
    expect(read.remoteJobId).toEqual(expect.any(String));
    const history = await getJobHistory(ctx(env), job.uuid, { limit: 5, skip: 1 });
    expect(history).toHaveLength(1);
    // The token was minted by the submit and is cached, so no mint is made here.
    expect(standin.log.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET /v3/jobs/${job.uuid}`,
      `GET /v3/jobs/${job.uuid}/history?limit=5&skip=1`,
    ]);
  });

  test("a terminal job's condition is carried through", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.advance(job.uuid, "RUNNING");
    standin.advance(job.uuid, "FAILED", "SCHEDULER_OUT_OF_MEMORY");
    const read = await getJob(ctx(env), job.uuid);
    expect(read.status).toBe("FAILED");
    expect(read.condition).toBe("SCHEDULER_OUT_OF_MEMORY");
    expect(read.ended).toEqual(expect.any(String));
    expect(read.remoteEnded).toEqual(expect.any(String));
  });

  test("cancelJob posts to the cancel path with no body", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.log.length = 0;
    await cancelJob(ctx(env), job.uuid);
    const call = jobCalls("POST /v3/jobs/:uuid/cancel");
    expect(call).toHaveLength(1);
    expect(call[0]?.path).toBe(`/v3/jobs/${job.uuid}/cancel`);
    expect(call[0]?.body).toBe("");
    expect(standin.jobs.get(job.uuid)?.status).toBe("CANCELLED");
  });

  test("cancelJob is not retried when the answer was lost (the caller's sweep decides)", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.fail("POST /v3/jobs/:uuid/cancel", 503, 5);
    const err = await failure(() => cancelJob(ctx(env), job.uuid));
    expect(err.kind).toBe("unavailable");
    expect(jobCalls("POST /v3/jobs/:uuid/cancel")).toHaveLength(1);
  });

  test("searchJobsByTag posts the documented search body and asks only for named fields", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    await submitJob(ctx(env), { ...SUBMIT, jobId: "job_999999999999999999999999" });
    standin.log.length = 0;
    const found = await searchJobsByTag(ctx(env), nemarJobTag(JOB_ID));
    expect(found.map((j) => j.uuid)).toEqual([job.uuid]);
    const call = jobCalls("POST /v3/jobs/search")[0];
    expect(JSON.parse(call?.body ?? "")).toEqual({ search: [`tags IN ('nemar_job:${JOB_ID}')`] });
    const query = new URL(`http://x${call?.path}`).searchParams;
    expect(query.get("listType")).toBe("ALL_JOBS");
    const select = (query.get("select") ?? "").split(",");
    expect(select).toEqual(
      expect.arrayContaining(["uuid", "owner", "status", "tags", "condition"]),
    );
    // The fields that can hold a launch specification or a webhook address are never asked for.
    for (const field of ["parameterSet", "subscriptions", "fileInputs", "notes", "allAttributes"]) {
      expect(select).not.toContain(field);
    }
  });

  test("searchJobsByTag refuses a tag it would have to quote", async () => {
    const env = passwordEnv();
    for (const tag of ["", "a'b", "a b", 'x"y', "a)b", "x".repeat(200)]) {
      await expect(searchJobsByTag(ctx(env), tag)).rejects.toThrow(RangeError);
    }
    expect(standin.log).toHaveLength(0);
  });

  test("searchJobsByTag finds nothing for a tag no job has", async () => {
    const env = passwordEnv();
    await submitJob(ctx(env), SUBMIT);
    expect(await searchJobsByTag(ctx(env), "nemar_job:job_000000000000000000000000")).toEqual([]);
  });

  test("searchJobsByTag can ask for the caller's own jobs, a page at a time", async () => {
    const env = passwordEnv();
    await submitJob(ctx(env), SUBMIT);
    standin.log.length = 0;
    await searchJobsByTag(ctx(env), nemarJobTag(JOB_ID), {
      listType: "MY_JOBS",
      limit: 3,
      skip: 2,
    });
    const query = new URL(`http://x${jobCalls("POST /v3/jobs/search")[0]?.path}`).searchParams;
    expect(query.get("listType")).toBe("MY_JOBS");
    expect(query.get("limit")).toBe("3");
    expect(query.get("skip")).toBe("2");
  });

  test("listJobs sends the list type, the limit and the skip", async () => {
    const env = passwordEnv();
    for (const id of [
      "job_111111111111111111111111",
      "job_222222222222222222222222",
      "job_333333333333333333333333",
    ]) {
      await submitJob(ctx(env), { ...SUBMIT, jobId: id });
    }
    standin.log.length = 0;
    const page = await listJobs(ctx(env), { listType: "ALL_JOBS", limit: 2, skip: 1 });
    expect(page).toHaveLength(2);
    const query = new URL(`http://x${jobCalls("GET /v3/jobs/list")[0]?.path}`).searchParams;
    expect(Object.fromEntries(query)).toEqual({ listType: "ALL_JOBS", limit: "2", skip: "1" });
    for (const bad of [{ limit: 0 }, { limit: 1.5 }, { skip: -1 }, { listType: "EVERYTHING" }]) {
      await expect(
        listJobs(ctx(env), { listType: "ALL_JOBS", limit: 10, skip: 0, ...bad } as never),
      ).rejects.toThrow(RangeError);
    }
  });

  test("subscribeWebhook posts the documented subscription, with ttlminutes as Tapis spells it", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.log.length = 0;
    const address = "https://hooks.example/compute/webhook/TOKEN-IN-THE-ADDRESS";
    const made = await subscribeWebhook(ctx(env), job.uuid, address, 4320);
    expect(made.url).toEqual(expect.any(String));
    const call = jobCalls("POST /v3/jobs/subscribe/:uuid")[0];
    expect(call?.path).toBe(`/v3/jobs/subscribe/${job.uuid}`);
    expect(JSON.parse(call?.body ?? "")).toEqual({
      description: "NEMAR status hint",
      enabled: true,
      eventCategoryFilter: "JOB_NEW_STATUS",
      deliveryTargets: [{ deliveryMethod: "WEBHOOK", deliveryAddress: address }],
      ttlminutes: 4320,
    });
    expect(standin.subscriptions).toHaveLength(1);
    expect(standin.subscriptions[0]).toMatchObject({
      jobUuid: job.uuid,
      address,
      ttlminutes: 4320,
    });
  });

  test("subscribeWebhook refuses a lifetime or an address Tapis would not take, before sending", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.log.length = 0;
    for (const ttl of [0, -1, 1.5, 40321, Number.NaN]) {
      await expect(
        subscribeWebhook(ctx(env), job.uuid, "https://hooks.example/x", ttl),
      ).rejects.toThrow(RangeError);
    }
    for (const address of [
      "",
      "not a url",
      "ftp://hooks.example/x",
      `https://hooks.example/${"x".repeat(3000)}`,
    ]) {
      await expect(subscribeWebhook(ctx(env), job.uuid, address, 60)).rejects.toThrow(RangeError);
    }
    expect(standin.log).toHaveLength(0);
  });

  test("a webhook Tapis sends reaches the address that was recorded, shaped as a notification", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    const received: Array<{ headers: Record<string, string>; body: Record<string, any> }> = [];
    const receiver = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        received.push({
          headers: Object.fromEntries(req.headers),
          body: (await req.json()) as Record<string, any>,
        });
        return new Response("ok");
      },
    });
    try {
      await subscribeWebhook(ctx(env), job.uuid, `http://127.0.0.1:${receiver.port}/hook/abc`, 60);
      standin.advance(job.uuid, "RUNNING");
      const sent = await standin.fireWebhook(job.uuid);
      expect(sent).toEqual({ status: 200, body: "ok" });
      const [hit] = received;
      expect(hit?.headers["user-agent"]).toBe("Tapis/v3");
      expect(hit?.body.event).toMatchObject({
        source: "https://tapis.io/jobs",
        type: "jobs.JOB_NEW_STATUS.RUNNING",
        subject: job.uuid,
        seriesId: job.uuid,
      });
      expect(JSON.parse(hit?.body.event.data)).toMatchObject({
        newJobStatus: "RUNNING",
        jobUuid: job.uuid,
        jobOwner: OWNER,
      });
      expect(hit?.body.deliveryTarget).toEqual({
        deliveryMethod: "WEBHOOK",
        deliveryAddress: `http://127.0.0.1:${receiver.port}/hook/abc`,
      });
    } finally {
      receiver.stop(true);
    }
  });

  test("listOutputs and downloadOutput read the documented paths and the bytes", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.setOutput(job.uuid, "work/outputs/a.csv", "a,b\n1,2\n");
    standin.setOutput(job.uuid, "launcher/result.json", '{"failure":null}');
    standin.advance(job.uuid, "FINISHED");
    standin.log.length = 0;
    const listed = await listOutputs(ctx(env), job.uuid, "work/");
    expect(listed.map((f) => f.path)).toEqual(["work/outputs/a.csv"]);
    expect(listed[0]).toMatchObject({ size: 8, type: "file", name: "a.csv" });
    const bytes = await downloadOutput(ctx(env), job.uuid, "work/outputs/a.csv", 1000);
    expect(new TextDecoder().decode(bytes)).toBe("a,b\n1,2\n");
    expect(standin.log.map((r) => r.path).filter((p) => p.includes("/output/"))).toEqual([
      `/v3/jobs/${job.uuid}/output/list/work/`,
      `/v3/jobs/${job.uuid}/output/download/work/outputs/a.csv`,
    ]);
    // The root listing has an empty path and still ends the URL with a slash.
    expect((await listOutputs(ctx(env), job.uuid, "")).map((f) => f.path).sort()).toEqual([
      "launcher/result.json",
      "work/outputs/a.csv",
    ]);
  });

  test("a download over the byte bound is `invalid_response`, and one at the bound is read", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.setOutput(job.uuid, "work/outputs/big.bin", new Uint8Array(1000).fill(7));
    standin.advance(job.uuid, "FINISHED");
    const over = await failure(() =>
      downloadOutput(ctx(env), job.uuid, "work/outputs/big.bin", 999),
    );
    expect(over.kind).toBe("invalid_response");
    expect(await downloadOutput(ctx(env), job.uuid, "work/outputs/big.bin", 1000)).toHaveLength(
      1000,
    );
    const missing = await failure(() =>
      downloadOutput(ctx(env), job.uuid, "work/outputs/none.bin", 10),
    );
    expect(missing.kind).toBe("not_found");
  });

  test("a path that could escape the job's output directory is refused before sending", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.log.length = 0;
    for (const path of ["../x", "a/../b", "/abs", "a\\b", "a//b", "a\u0000b", "./x"]) {
      await expect(downloadOutput(ctx(env), job.uuid, path, 10)).rejects.toThrow(RangeError);
      await expect(listOutputs(ctx(env), job.uuid, path)).rejects.toThrow(RangeError);
    }
    for (const uuid of ["", "../x", "a/b", "a b", "a?x=1", "x".repeat(200)]) {
      await expect(getJob(ctx(env), uuid)).rejects.toThrow(RangeError);
    }
    expect(standin.log).toHaveLength(0);
  });

  test("a job uuid is encoded once, so what the path says is what was asked", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.setOutput(job.uuid, "work/outputs/a b+c.txt", "x");
    standin.advance(job.uuid, "FINISHED");
    expect(
      new TextDecoder().decode(
        await downloadOutput(ctx(env), job.uuid, "work/outputs/a b+c.txt", 10),
      ),
    ).toBe("x");
  });

  test("tapisHealth calls the unauthenticated health check, and answers ok", async () => {
    await tapisHealth(passwordEnv(), { timeoutMs: 400 });
    expect(standin.log.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v3/jobs/healthcheck"]);
    expect(standin.log[0]?.headers["x-tapis-token"]).toBeUndefined();
    standin.fail("GET /v3/jobs/healthcheck", 503, 9);
    expect(
      (await failure(() => tapisHealth(passwordEnv(), { timeoutMs: 400, retryDelayMs: 1 }))).kind,
    ).toBe("unavailable");
  });

  test("mintTapisToken always asks Tapis, and never fills the cache", async () => {
    const env = passwordEnv();
    const a = await mintTapisToken(env, { owner: OWNER, timeoutMs: 400 });
    const b = await mintTapisToken(env, { owner: OWNER, timeoutMs: 400 });
    expect(a.token).not.toBe(b.token);
    expect(a.expiresInSeconds).toBe(14_400);
    expect(standin.mints().password).toBe(2);
    await getTapisToken(env, { owner: OWNER, timeoutMs: 400 });
    expect(standin.mints().password).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------
// The bounds, and what never appears
// ---------------------------------------------------------------------------------------------

describe("bounds", () => {
  test("every call has a 15-second timeout and no call can lengthen it", () => {
    expect(TAPIS_TIMEOUT_MS).toBe(15_000);
    expect(effectiveTimeoutMs(undefined)).toBe(15_000);
    expect(effectiveTimeoutMs(200)).toBe(200);
    expect(effectiveTimeoutMs(60_000)).toBe(15_000);
    expect(effectiveTimeoutMs(0)).toBe(15_000);
    expect(effectiveTimeoutMs(-5)).toBe(15_000);
    expect(effectiveTimeoutMs(Number.NaN)).toBe(15_000);
  });

  test("a mint that hangs is `unavailable` inside the timeout too", async () => {
    standin.hang("POST /v3/oauth2/tokens", 10);
    const started = Date.now();
    const err = await failure(() => getTapisToken(passwordEnv(), { owner: OWNER, timeoutMs: 150 }));
    expect(err.kind).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("the server being down is `unavailable`, and when it is back the client works", async () => {
    const env = passwordEnv();
    standin.down();
    try {
      expect((await failure(() => getJob(ctx(env), "abc-007"))).kind).toBe("unavailable");
    } finally {
      standin.up();
    }
    const job = await submitJob(ctx(env), SUBMIT);
    expect((await getJob(ctx(env), job.uuid)).uuid).toBe(job.uuid);
  });

  test("a redirect is not followed, so the token never reaches another origin", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    const reached: Array<Record<string, string>> = [];
    const elsewhere = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        reached.push(Object.fromEntries(req.headers));
        return new Response("{}");
      },
    });
    try {
      standin.respond("GET /v3/jobs/:uuid", 302, "", 1, {
        Location: `http://127.0.0.1:${elsewhere.port}/x`,
      });
      const err = await failure(() => getJob(ctx(env), job.uuid));
      expect(err.kind).toBe("rejected");
      expect(err.status).toBe(302);
      expect(reached).toEqual([]);
    } finally {
      elsewhere.stop(true);
    }
  });

  test("the error kinds are the six the design names", () => {
    expect([...TAPIS_ERROR_KINDS]).toEqual([
      "unconfigured",
      "unauthorized",
      "not_found",
      "rejected",
      "unavailable",
      "invalid_response",
    ]);
  });
});

describe("secrets", () => {
  const SECRETS = () => [
    standin.password,
    standin.serviceToken,
    TOKEN_MARK,
    "TOKEN-IN-THE-ADDRESS",
  ];

  test("no password, token or launch specification is in an error message, a cause or a log line", async () => {
    for (const [, makeEnv] of STRATEGIES) {
      __resetTapisTokenCacheForTests();
      standin.reset();
      const env = makeEnv();
      const logs = captureConsole();
      const errors: TapisError[] = [];
      try {
        const job = await submitJob(ctx(env), SUBMIT);
        // Every kind of failure, on calls that carry a secret in the request or in the address.
        standin.fail("POST /v3/jobs/submit", 400);
        standin.fail("POST /v3/jobs/submit", 503);
        standin.respond("POST /v3/jobs/submit", 200, {
          status: "success",
          result: { launch: LAUNCH_SPEC },
        });
        standin.nonJson("POST /v3/jobs/submit");
        for (let i = 0; i < 4; i++) errors.push(await failure(() => submitJob(ctx(env), SUBMIT)));
        standin.fail("POST /v3/jobs/subscribe/:uuid", 400);
        errors.push(
          await failure(() =>
            subscribeWebhook(ctx(env), job.uuid, "https://hooks.example/TOKEN-IN-THE-ADDRESS", 60),
          ),
        );
        standin.rejectAllTokens(true);
        errors.push(await failure(() => getJob(ctx(env), job.uuid)));
        errors.push(await failure(() => submitJob(ctx(env), SUBMIT)));
        standin.rejectAllTokens(false);
        // A cached token is keyed by strategy and username, not by credential: a wrong credential is
        // only tried when nothing is cached, as after a deploy.
        __resetTapisTokenCacheForTests();
        errors.push(
          await failure(() =>
            getJob(
              ctx(makeEnv({ TAPIS_PASSWORD: "wrong", TAPIS_SERVICE_TOKEN: "wrong" })),
              job.uuid,
            ),
          ),
        );
      } finally {
        logs.restore();
      }
      expect(errors.length).toBeGreaterThanOrEqual(8);
      for (const err of errors) {
        const text = `${err.message} ${err.name} ${String(err.cause)} ${JSON.stringify(err)}`;
        for (const secret of SECRETS()) expect(text).not.toContain(secret);
        expect(err.message).not.toContain("hooks.example");
      }
      for (const line of logs.lines) {
        for (const secret of SECRETS()) expect(line).not.toContain(secret);
      }
    }
  });

  test("the minted token is not in the answer of any call either", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    const token = jobCalls("POST /v3/jobs/submit")[0]?.headers["x-tapis-token"] ?? "";
    expect(token).not.toBe("");
    const answers = [
      job,
      await getJob(ctx(env), job.uuid),
      await getJobHistory(ctx(env), job.uuid),
      await listJobs(ctx(env), { listType: "ALL_JOBS", limit: 5, skip: 0 }),
      await searchJobsByTag(ctx(env), nemarJobTag(JOB_ID)),
    ];
    expect(JSON.stringify(answers)).not.toContain(token);
  });
});

// A partition is the contract's word, and it is the logical queue of the request.
test("every partition word of the contract is accepted and sent as the logical queue", async () => {
  const env = passwordEnv();
  for (const partition of PARTITION_NAMES) {
    await submitJob(ctx(env), { ...SUBMIT, partition });
  }
  const queues = jobCalls("POST /v3/jobs/submit").map(
    (r) => JSON.parse(r.body).execSystemLogicalQueue,
  );
  expect(queues).toEqual([...PARTITION_NAMES]);
});

afterEach(() => {
  standin.rejectAllTokens(false);
});
