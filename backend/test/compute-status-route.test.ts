/**
 * `GET /admin/compute/status` (epic #2005 phase A4, #2009; ADR 0118), through the REAL admin router
 * and its middleware (`app.fetch`), over a real migrated database, with real API keys, against the
 * Tapis stand-in (`helpers/tapis-standin.ts`, which recorded nothing from a real tenant) and, for the
 * storage bindings, the two real Miniflare R2 buckets of the compute harness. The route is what the
 * owner uses to check credentials once the secrets are set, so what is pinned is what it says and
 * what it must never say:
 *
 *  - who may call it: an administrator and an owner, nobody else;
 *  - an unconfigured Worker reports `unconfigured`, makes no request, and the same shape for every
 *    other answer: booleans and fixed words;
 *  - each piece (the strategy, each R2 binding, the signing secrets, the ACCESS key) is its own
 *    boolean, and each flips alone;
 *  - the token step and the health step are one real mint and one real health call, and each answers
 *    with the kind of the error when it failed (`unauthorized`, `unavailable`, `invalid_response`);
 *  - no secret value, no tenant address, no tenant name and no username is in any answer, in either
 *    strategy.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ComputeStatusResponseSchema } from "../../shared/contract/compute-admin";
import { STATUS_TIMEOUT_MS, computeStatus } from "../src/services/compute-status";
import { __resetTapisTokenCacheForTests } from "../src/services/tapis/auth";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  makeComputeApp,
  seedComputeUsers,
} from "./helpers/compute-app";
import { type ComputeHarness, startComputeHarness } from "./helpers/compute-harness";
import { type TapisStandin, startTapisStandin } from "./helpers/tapis-standin";

const handle = makeComputeApp();

let harness: ComputeHarness;
let standin: TapisStandin;
let previousOverride: string | undefined;

beforeAll(async () => {
  harness = await startComputeHarness();
  standin = startTapisStandin({
    tenantId: "tenant-mark-7731",
    username: "username-mark-7731",
    password: "password-mark-7731",
    serviceToken: "service-token-mark-7731",
  });
  previousOverride = (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL;
}, 60_000);

afterAll(async () => {
  (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL = previousOverride;
  standin.stop();
  await harness.dispose();
});

beforeEach(async () => {
  await harness.reset();
  await seedComputeUsers(harness.db);
  standin.reset();
  __resetTapisTokenCacheForTests();
  (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL = undefined;
});

const ACCESS_KEY_MARK = "access-key-mark-7731";
const R2_ENDPOINT_MARK = "https://r2-endpoint-mark-7731.invalid";

/** Everything a fully configured Worker has, under one strategy; `over` replaces a field. */
function configured(strategy: "password" | "service", over: Record<string, unknown> = {}) {
  return harness.env({
    ENVIRONMENT: "production",
    COMPUTE_R2_S3_ENDPOINT: R2_ENDPOINT_MARK,
    COMPUTE_R2_ACCESS_KEY_ID: "r2-key-id-mark-7731",
    COMPUTE_R2_SECRET_ACCESS_KEY: "r2-secret-mark-7731",
    TAPIS_AUTH_STRATEGY: strategy,
    // Nothing listens here (a closed port), and its path carries a mark that must never be echoed.
    TAPIS_BASE_URL: "https://127.0.0.1:1/tenant-mark-7731",
    TAPIS_TENANT_ID: standin.tenantId,
    ...(strategy === "password"
      ? { TAPIS_USERNAME: standin.username, TAPIS_PASSWORD: standin.password }
      : { TAPIS_SERVICE_TOKEN: standin.serviceToken, TAPIS_USERNAME: standin.username }),
    ACCESS_GATEWAY_API_KEY: ACCESS_KEY_MARK,
    ...over,
  } as never);
}

interface Called {
  status: number;
  text: string;
  body: Record<string, any>;
}

async function status(who: ComputeWho | null, env = harness.env()): Promise<Called> {
  const headers: Record<string, string> = {};
  if (who) headers.Authorization = `Bearer ${COMPUTE_KEYS[who]}`;
  const res = await handle(new Request("http://api.test/admin/compute/status", { headers }), env);
  const text = await res.text();
  let body: Record<string, any> = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, body };
}

function useStandin() {
  (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL = standin.url;
}

describe("who may ask", () => {
  test("an administrator and an owner may, a member and a stranger may not", async () => {
    expect((await status("admin")).status).toBe(200);
    expect((await status("owner")).status).toBe(200);
    expect((await status("member")).status).toBe(403);
    expect((await status(null)).status).toBe(401);
  });
});

describe("an unconfigured Worker", () => {
  test("with an address but no credentials: `unconfigured` for the token, and only the health call is made", async () => {
    useStandin();
    const res = await status("admin", harness.env({ COMPUTE_RECORDS: undefined } as never));
    expect(res.status).toBe(200);
    // With nothing set (the override stands in for the address only), the strategy is the gap.
    expect(res.body).toEqual({
      switches: {
        environment: "production",
        compute_enabled: false,
        pipelines_dispatch_enabled: false,
      },
      tapis: {
        configured: false,
        strategy: null,
        problems: ["TAPIS_AUTH_STRATEGY:missing", "TAPIS_TENANT_ID:missing"],
        token: "unconfigured",
        health: "ok",
      },
      storage: { records_binding: false, results_binding: true, signing_configured: true },
      access: { key_configured: false },
    });
    // The health call is the one request an address alone allows.
    expect(standin.log.map((r) => r.path)).toEqual(["/v3/jobs/healthcheck"]);
  });

  test("with nothing at all: `unconfigured` for both steps, every flag false, and nothing is sent", async () => {
    const env = harness.env({
      COMPUTE_RECORDS: undefined,
      COMPUTE_RESULTS: undefined,
      COMPUTE_R2_S3_ENDPOINT: undefined,
      COMPUTE_R2_ACCESS_KEY_ID: undefined,
      COMPUTE_R2_SECRET_ACCESS_KEY: undefined,
    } as never);
    (globalThis as { NEMAR_COMPUTE_S3_URL?: string }).NEMAR_COMPUTE_S3_URL = undefined;
    try {
      const res = await status("admin", env);
      expect(res.body).toEqual({
        switches: {
          environment: "production",
          compute_enabled: false,
          pipelines_dispatch_enabled: false,
        },
        tapis: {
          configured: false,
          strategy: null,
          problems: [
            "TAPIS_AUTH_STRATEGY:missing",
            "TAPIS_BASE_URL:missing",
            "TAPIS_TENANT_ID:missing",
          ],
          token: "unconfigured",
          health: "unconfigured",
        },
        storage: { records_binding: false, results_binding: false, signing_configured: false },
        access: { key_configured: false },
      });
      expect(standin.log).toHaveLength(0);
    } finally {
      (globalThis as { NEMAR_COMPUTE_S3_URL?: string }).NEMAR_COMPUTE_S3_URL = harness.standin.url;
    }
  });

  test("the answer parses with the contract's open schema", async () => {
    const res = await status("admin");
    expect(ComputeStatusResponseSchema.safeParse(res.body).success).toBe(true);
    // Open: a key a newer Worker adds, anywhere, is kept.
    const future = { ...res.body, added: 1, tapis: { ...res.body.tapis, added_too: [1] } };
    const parsed = ComputeStatusResponseSchema.parse(future);
    expect((parsed as Record<string, unknown>).added).toBe(1);
    expect((parsed.tapis as Record<string, unknown>).added_too).toEqual([1]);
  });
});

describe("the switches, as the Worker reads them", () => {
  test("report the environment as a word, and each switch only when it is truly on", async () => {
    const answers: Array<[Record<string, unknown>, string, boolean, boolean]> = [
      [{ ENVIRONMENT: "production" }, "production", false, false],
      [{ ENVIRONMENT: "production", COMPUTE_ENABLED: "1" }, "production", true, false],
      [
        {
          ENVIRONMENT: "production",
          COMPUTE_ENABLED: "1",
          COMPUTE_PIPELINES_DISPATCH_ENABLED: "1",
        },
        "production",
        true,
        true,
      ],
      [{ ENVIRONMENT: "development", COMPUTE_ENABLED: "1" }, "development", true, false],
      [{ ENVIRONMENT: "production", COMPUTE_ENABLED: "true" }, "production", false, false],
      [
        { ENVIRONMENT: "production", COMPUTE_PIPELINES_DISPATCH_ENABLED: "1" },
        "production",
        false,
        false,
      ],
      // Anything else is the word `other`, never the value.
      [{ ENVIRONMENT: "staging", COMPUTE_ENABLED: "1" }, "other", false, false],
      [{ ENVIRONMENT: " Production ", COMPUTE_ENABLED: "1" }, "other", false, false],
    ];
    for (const [over, environment, compute, dispatch] of answers) {
      const res = await status("admin", harness.env(over as never));
      expect(res.body.switches).toEqual({
        environment,
        compute_enabled: compute,
        pipelines_dispatch_enabled: dispatch,
      });
    }
  });
});

describe("each piece is its own flag", () => {
  test("a fully configured Worker reports every flag true, and both steps ok", async () => {
    useStandin();
    for (const strategy of ["password", "service"] as const) {
      __resetTapisTokenCacheForTests();
      const res = await status("admin", configured(strategy));
      expect(res.status).toBe(200);
      expect(res.body.tapis).toEqual({
        configured: true,
        strategy,
        problems: [],
        token: "ok",
        health: "ok",
      });
      expect(res.body.storage).toEqual({
        records_binding: true,
        results_binding: true,
        signing_configured: true,
      });
      expect(res.body.access).toEqual({ key_configured: true });
    }
  });

  test("each binding and secret, missing alone, flips only its own flag", async () => {
    useStandin();
    const cases: Array<[Record<string, unknown>, (b: Record<string, any>) => unknown]> = [
      [{ COMPUTE_RECORDS: undefined }, (b) => b.storage.records_binding],
      [{ COMPUTE_RESULTS: undefined }, (b) => b.storage.results_binding],
      [{ COMPUTE_R2_ACCESS_KEY_ID: undefined }, (b) => b.storage.signing_configured],
      [{ COMPUTE_R2_SECRET_ACCESS_KEY: "" }, (b) => b.storage.signing_configured],
      [{ COMPUTE_RECORDS_BUCKET_NAME: undefined }, (b) => b.storage.signing_configured],
      [{ ACCESS_GATEWAY_API_KEY: undefined }, (b) => b.access.key_configured],
      [{ ACCESS_GATEWAY_API_KEY: "  " }, (b) => b.access.key_configured],
    ];
    for (const [over, flag] of cases) {
      const res = await status("admin", configured("password", over));
      const body = res.body;
      expect(flag(body)).toBe(false);
      // Everything else is still configured and working.
      const all = [
        body.storage.records_binding,
        body.storage.results_binding,
        body.storage.signing_configured,
        body.access.key_configured,
      ];
      expect(all.filter((v) => v === false)).toHaveLength(1);
      expect(body.tapis.configured).toBe(true);
    }
  });

  test("the strategy is null and its missing names are listed when it cannot be used", async () => {
    useStandin();
    const res = await status("admin", configured("password", { TAPIS_PASSWORD: undefined }));
    expect(res.body.tapis).toEqual({
      configured: false,
      strategy: null,
      problems: ["TAPIS_PASSWORD:missing"],
      token: "unconfigured",
      health: "ok",
    });
    const unknown = await status("admin", configured("password", { TAPIS_AUTH_STRATEGY: "oauth" }));
    expect(unknown.body.tapis.problems).toEqual(["TAPIS_AUTH_STRATEGY:unknown"]);
    expect(unknown.text).not.toContain("oauth");
  });
});

describe("the token step and the health step", () => {
  test("make one real mint and one real health call, and leave the token cache alone", async () => {
    useStandin();
    await status("admin", configured("password"));
    expect(standin.mints()).toEqual({ password: 1, service: 0 });
    expect(standin.log.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "GET /v3/jobs/healthcheck",
      "POST /v3/oauth2/tokens",
    ]);
    // A second call mints again: the answer is about the credentials now, not about a cache.
    await status("admin", configured("password"));
    expect(standin.mints().password).toBe(2);
  });

  test("under the service strategy the token is minted for the configured username, or skipped", async () => {
    useStandin();
    const res = await status("admin", configured("service"));
    expect(res.body.tapis.token).toBe("ok");
    const mint = standin.log.find((r) => r.route === "POST /v3/tokens");
    expect(mint?.headers["x-tapis-token"]).toBe(standin.serviceToken);
    expect(JSON.parse(mint?.body ?? "").token_username).toBe(standin.username);

    standin.reset();
    const noProbe = await status("admin", configured("service", { TAPIS_USERNAME: undefined }));
    expect(noProbe.body.tapis).toEqual({
      configured: true,
      strategy: "service",
      problems: [],
      token: "skipped",
      health: "ok",
    });
    expect(standin.log.map((r) => r.path)).toEqual(["/v3/jobs/healthcheck"]);
  });

  test("a credential Tapis refuses is `unauthorized`, and the health step still answers", async () => {
    useStandin();
    const res = await status("admin", configured("password", { TAPIS_PASSWORD: "wrong" }));
    expect(res.body.tapis).toMatchObject({ configured: true, token: "unauthorized", health: "ok" });
    const service = await status("admin", configured("service", { TAPIS_SERVICE_TOKEN: "wrong" }));
    expect(service.body.tapis).toMatchObject({ token: "unauthorized", health: "ok" });
  });

  test("a server that is down is `unavailable` for both steps, and the route still answers 200", async () => {
    useStandin();
    standin.down();
    try {
      const res = await status("admin", configured("password"));
      expect(res.status).toBe(200);
      expect(res.body.tapis).toMatchObject({
        configured: true,
        token: "unavailable",
        health: "unavailable",
      });
    } finally {
      standin.up();
    }
  });

  test("each step is tried once: an admin's request is not held by retries", async () => {
    useStandin();
    standin.fail("GET /v3/jobs/healthcheck", 503, 9);
    standin.fail("POST /v3/oauth2/tokens", 503, 9);
    const res = await status("admin", configured("password"));
    expect(res.body.tapis).toMatchObject({ token: "unavailable", health: "unavailable" });
    expect(standin.log.map((r) => r.path).sort()).toEqual([
      "/v3/jobs/healthcheck",
      "/v3/oauth2/tokens",
    ]);
  });

  test("a Tapis that hangs is `unavailable` for both steps inside the timeout", async () => {
    useStandin();
    standin.hang("GET /v3/jobs/healthcheck", 9);
    standin.hang("POST /v3/oauth2/tokens", 9);
    const started = Date.now();
    // The route's own timeout is 8 seconds; the service takes it as a parameter, so this asks for 150 ms.
    const answer = await computeStatus(configured("password"), { timeoutMs: 150 });
    expect(answer.tapis).toMatchObject({ token: "unavailable", health: "unavailable" });
    expect(Date.now() - started).toBeLessThan(2000);
    // The route's default is a bound well inside a Worker request's patience.
    expect(STATUS_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  test("a token answer of the wrong shape is `invalid_response`, under either strategy", async () => {
    useStandin();
    const bodies: unknown[] = [
      { status: "success", message: "x" },
      { status: "success", result: {} },
      { status: "success", result: { access_token: { access_token: "", expires_in: 3600 } } },
      { status: "success", result: { access_token: { access_token: "t", expires_in: 0 } } },
      { status: "success", result: { access_token: { access_token: "t" } } },
      [],
      null,
    ];
    for (const strategy of ["password", "service"] as const) {
      for (const body of bodies) {
        __resetTapisTokenCacheForTests();
        standin.respond(
          strategy === "password" ? "POST /v3/oauth2/tokens" : "POST /v3/tokens",
          201,
          body,
        );
        const res = await status("admin", configured(strategy));
        expect(res.status).toBe(200);
        expect(res.body.tapis).toMatchObject({ token: "invalid_response", health: "ok" });
      }
    }
    // Nothing was ever sent with an empty token.
    expect(standin.log.filter((r) => r.headers["x-tapis-token"] === "")).toEqual([]);
  });

  test("a health answer of the wrong shape is `invalid_response`", async () => {
    useStandin();
    for (const body of [{}, [], null, { status: 7 }, "ok"]) {
      standin.respond("GET /v3/jobs/healthcheck", 200, body);
      const res = await status("admin", configured("password"));
      expect(res.body.tapis).toMatchObject({ token: "ok", health: "invalid_response" });
    }
  });

  test("the route's own default timeout is the status ceiling, for the mint and for the health call", async () => {
    useStandin();
    const original = AbortSignal.timeout;
    const asked: number[] = [];
    AbortSignal.timeout = ((ms: number) => {
      asked.push(ms);
      return original.call(AbortSignal, ms);
    }) as typeof AbortSignal.timeout;
    try {
      await status("admin", configured("password"));
    } finally {
      AbortSignal.timeout = original;
    }
    // One mint and one health call, each held to the route's 8 seconds, and not to the client's 15.
    expect(STATUS_TIMEOUT_MS).toBe(8000);
    expect(asked).toEqual([STATUS_TIMEOUT_MS, STATUS_TIMEOUT_MS]);
  });

  test("a body that is not JSON is `invalid_response`, and a refusal is `rejected`", async () => {
    useStandin();
    standin.nonJson("POST /v3/oauth2/tokens");
    standin.fail("GET /v3/jobs/healthcheck", 400);
    const res = await status("admin", configured("password"));
    expect(res.body.tapis).toMatchObject({ token: "invalid_response", health: "rejected" });
  });
});

describe("what the answer never holds", () => {
  const MARKS = [
    "tenant-mark-7731",
    "username-mark-7731",
    "password-mark-7731",
    "service-token-mark-7731",
    "r2-key-id-mark-7731",
    "r2-secret-mark-7731",
    ACCESS_KEY_MARK,
    "r2-endpoint-mark-7731",
  ];

  test("no secret value, address, tenant name or username, in any state, under either strategy", async () => {
    for (const strategy of ["password", "service"] as const) {
      const cases: Array<() => Promise<Called>> = [
        async () => {
          useStandin();
          return status("admin", configured(strategy));
        },
        async () => {
          useStandin();
          return status(
            "admin",
            configured(strategy, {
              TAPIS_PASSWORD: "password-mark-7731-x",
              TAPIS_SERVICE_TOKEN: "service-token-mark-7731-x",
            }),
          );
        },
        async () => {
          (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL = undefined;
          // The address is the variable's, a closed port, so every call fails to connect.
          return status("admin", configured(strategy));
        },
        async () => {
          useStandin();
          return status("admin", configured(strategy, { TAPIS_AUTH_STRATEGY: "tenant-mark-7731" }));
        },
      ];
      for (const run of cases) {
        __resetTapisTokenCacheForTests();
        const res = await run();
        expect(res.status).toBe(200);
        for (const mark of MARKS) expect(res.text).not.toContain(mark);
        expect(res.text).not.toContain(standin.url);
        expect(res.text).not.toContain("127.0.0.1");
      }
    }
  });

  test("the mint and the health call do not write to the database", async () => {
    useStandin();
    const tables = [
      "audit_log",
      "users",
      "tokens",
      "compute_pools",
      "compute_ledger",
      "compute_jobs",
    ];
    const counts = () =>
      tables.map(
        (t) => (harness.db.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n,
      );
    const before = counts();
    await status("admin", configured("password"));
    expect(counts()).toEqual(before);
  });
});
