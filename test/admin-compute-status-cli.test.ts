/**
 * `nemar admin compute status` (epic #2005 phase A4, #2009; ADR 0118), driven through the real entry
 * point against the REAL route: the Worker's admin router behind its real authentication and admin
 * middleware, over real SQLite carrying every migration, served on a loopback port and reached
 * through TEST_API_URL, with the Tapis stand-in behind it (which recorded nothing from a real tenant).
 * What the command prints is what the route answers.
 *
 * The properties, each with a test of its own:
 *  - an unconfigured Worker prints `unconfigured` and exits 0, and `--json` prints the Worker's answer
 *    and nothing else on standard output;
 *  - a configured one prints the strategy, the token step and the health step as fixed words;
 *  - no secret value, no tenant address and no username is in any output, in either form;
 *  - an answer with keys the CLI does not know is shown, not refused (the schema is open);
 *  - a member's key and no key at all exit 1.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { __resetTapisTokenCacheForTests } from "../backend/src/services/tapis/auth";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  computeEnv,
  makeComputeApp,
  seedComputeUsers,
} from "../backend/test/helpers/compute-app";
import { freshDb } from "../backend/test/helpers/d1";
import { type TapisStandin, startTapisStandin } from "../backend/test/helpers/tapis-standin";
import { ComputeStatusResponseSchema } from "../shared/contract/compute-admin";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const handle = makeComputeApp();

let db: Database;
let configDir: string;
let standin: TapisStandin;
let previousOverride: string | undefined;
/** The bindings the Worker the command talks to has. */
let workerEnv: Record<string, unknown> = {};
/** When set, the route's answer gets keys a newer Worker would add. */
let augment = false;

const SECRETS = {
  password: "cli-password-mark-4410",
  serviceToken: "cli-service-token-mark-4410",
  username: "cli-username-mark-4410",
  tenant: "cli-tenant-mark-4410",
  access: "cli-access-key-mark-4410",
};

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/notices") return Response.json({ notices: [] });
    const res = await handle(req, computeEnv(db, workerEnv as never));
    if (augment && res.ok) {
      const body = (await res.json()) as Record<string, any>;
      body.future_top_level = { added: "by a newer worker" };
      body.tapis.future_nested = 7;
      return Response.json(body, { status: res.status });
    }
    return res;
  },
});
const API = `http://127.0.0.1:${server.port}`;

beforeAll(() => {
  standin = startTapisStandin({
    tenantId: SECRETS.tenant,
    username: SECRETS.username,
    password: SECRETS.password,
    serviceToken: SECRETS.serviceToken,
  });
  previousOverride = (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL;
});

afterAll(() => {
  (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL = previousOverride;
  standin.stop();
  server.stop(true);
});

beforeEach(async () => {
  db = freshDb();
  await seedComputeUsers(db);
  workerEnv = {};
  augment = false;
  standin.reset();
  __resetTapisTokenCacheForTests();
  (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL = undefined;
  configDir = mkdtempSync(join(tmpdir(), "nemar-compute-status-cli-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function configuredWorker(over: Record<string, unknown> = {}) {
  (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL = standin.url;
  workerEnv = {
    TAPIS_AUTH_STRATEGY: "password",
    TAPIS_BASE_URL: `https://${SECRETS.tenant}.invalid`,
    TAPIS_TENANT_ID: SECRETS.tenant,
    TAPIS_USERNAME: SECRETS.username,
    TAPIS_PASSWORD: SECRETS.password,
    ACCESS_GATEWAY_API_KEY: SECRETS.access,
    ...over,
  };
}

interface Ran {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(who: ComputeWho | null, args: string[]): Promise<Ran> {
  if (who === null) {
    rmSync(join(configDir, "config.json"), { force: true });
  } else {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        activeAccount: "computecli",
        accounts: { computecli: { apiKey: COMPUTE_KEYS[who] } },
      }),
    );
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: API,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    // Set by the harness that runs this suite, and a warning on standard error when NO_COLOR is also set.
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  })) {
    if (v !== undefined) env[k] = v;
  }
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, "admin", "compute", ...args],
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

function expectNoSecrets(r: Ran) {
  const all = r.stdout + r.stderr;
  for (const value of Object.values(SECRETS)) expect(all).not.toContain(value);
  expect(all).not.toContain(standin.url);
  expect(all).not.toContain(`127.0.0.1:${new URL(standin.url).port}`);
  expect(all).not.toContain(".invalid");
}

describe("status", () => {
  test("an unconfigured Worker prints `unconfigured` and exits 0", async () => {
    const r = await runCli("admin", ["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("environment: production");
    expect(r.stdout).toContain("compute switch: off");
    expect(r.stdout).toContain("pipelines dispatch switch: off");
    expect(r.stdout).toContain("token: unconfigured");
    expect(r.stdout).toContain("health: unconfigured");
    expect(r.stdout).toContain("configured: no");
    expect(r.stdout).toContain("TAPIS_AUTH_STRATEGY:missing");
    expect(r.stdout).toContain("records binding: no");
    expect(r.stdout).toContain("ACCESS key: no");
    expect(standin.log).toHaveLength(0);
    expectNoSecrets(r);
  });

  test("--json prints the Worker's answer, and only that, on standard output", async () => {
    const r = await runCli("admin", ["status", "--json"]);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(ComputeStatusResponseSchema.safeParse(body).success).toBe(true);
    expect(body.tapis).toMatchObject({ configured: false, token: "unconfigured" });
    expect(body.switches).toEqual({
      environment: "production",
      compute_enabled: false,
      pipelines_dispatch_enabled: false,
    });
    expect(r.stderr.trim()).toBe("");
  });

  test("a configured Worker prints the strategy and both steps as fixed words, and no secret", async () => {
    configuredWorker({ COMPUTE_ENABLED: "1" });
    const r = await runCli("owner", ["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("compute switch: on");
    expect(r.stdout).toContain("configured: yes (strategy password)");
    expect(r.stdout).toContain("token: ok");
    expect(r.stdout).toContain("health: ok");
    expect(r.stdout).toContain("ACCESS key: yes");
    expectNoSecrets(r);
    const j = await runCli("owner", ["status", "--json"]);
    expect(JSON.parse(j.stdout).tapis).toEqual({
      configured: true,
      strategy: "password",
      problems: [],
      token: "ok",
      health: "ok",
    });
    expectNoSecrets(j);
  });

  test("a credential Tapis refuses prints `unauthorized`, and still exits 0", async () => {
    configuredWorker({ TAPIS_PASSWORD: "not-the-password" });
    const r = await runCli("admin", ["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("token: unauthorized");
    expect(r.stdout).toContain("health: ok");
    expectNoSecrets(r);
  });

  test("a server that is down prints `unavailable` for both steps", async () => {
    configuredWorker();
    standin.down();
    try {
      const r = await runCli("admin", ["status"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("token: unavailable");
      expect(r.stdout).toContain("health: unavailable");
      expectNoSecrets(r);
    } finally {
      standin.up();
    }
  });

  test("an answer with keys the CLI does not know is shown, not refused", async () => {
    augment = true;
    const r = await runCli("admin", ["status", "--json"]);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.future_top_level).toEqual({ added: "by a newer worker" });
    expect(body.tapis.future_nested).toBe(7);
    const human = await runCli("admin", ["status"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("token: unconfigured");
  });

  test("a member's key and no key at all exit 1, and print no status", async () => {
    const member = await runCli("member", ["status"]);
    expect(member.exitCode).toBe(1);
    expect(member.stdout).not.toContain("compute switch");
    const none = await runCli(null, ["status", "--json"]);
    expect(none.exitCode).toBe(1);
    expect(none.stdout.trim()).toBe("");
  });
});
