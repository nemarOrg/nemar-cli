/**
 * `nemar admin compute move-charge <job> --to <account id>` (epic #2021 phase D4, #2025; ADR 0118, the
 * amendment of this phase), driven through the real entry point against the REAL admin router behind its real
 * authentication, over real SQLite carrying every migration, served on a loopback port and reached through
 * TEST_API_URL. The charge it moves is one the REAL tenant sweep wrote (a Tapis job nobody reserved, cancelled
 * and charged to the partner's pool, against the Tapis stand-in of Epic A, which recorded nothing from a real
 * tenant). What the command prints is what the route answers.
 *
 * The properties, each with a test of its own: the owner moves a charge and the command says how much and to
 * whom; `--json` prints the Worker's answer and only that; a repeat says it was already moved; an
 * administrator is refused (the move is the owner's) and nothing moves; a job id or an account number that is
 * malformed is refused before anything is sent; the Worker's refusals (a job that was reserved, an account not
 * in good standing) exit 1 with its sentence; and the help says who may.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { sweepTenantJobs } from "../backend/src/services/compute-tenant-sweep";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  makeComputeApp,
  seedComputeUsers,
} from "../backend/test/helpers/compute-app";
import {
  type LifecycleFixture,
  MINUTE,
  makeJob,
  setTapisTimes,
  startLifecycleFixture,
} from "../backend/test/helpers/compute-lifecycle-fixture";
import { fundAccount, seedUser } from "../backend/test/helpers/compute-seed";
import { ComputeMoveChargeResponseSchema } from "../shared/contract/compute-admin";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const handle = makeComputeApp();

let fx: LifecycleFixture;
let configDir: string;
let seen: string[] = [];

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/notices") return Response.json({ notices: [] });
    seen.push(`${req.method} ${url.pathname}`);
    return handle(req, fx.env());
  },
});
const API = `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
  fx = await startLifecycleFixture();
}, 120_000);

afterAll(async () => {
  server.stop(true);
  await fx?.dispose();
}, 30_000);

beforeEach(async () => {
  await fx.reset();
  await seedComputeUsers(fx.harness.db);
  seen = [];
  configDir = mkdtempSync(join(tmpdir(), "nemar-move-charge-cli-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

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
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  })) {
    if (v !== undefined) env[k] = v;
  }
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, "admin", "compute", "move-charge", ...args],
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

async function tapisToken(): Promise<string> {
  const res = await fetch(`${fx.tapis.url}/v3/oauth2/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "password",
      username: fx.tapis.username,
      password: fx.tapis.password,
    }),
  });
  const body = (await res.json()) as { result: { access_token: { access_token: string } } };
  return body.result.access_token.access_token;
}

/** A Tapis job nobody reserved, run for 30 minutes on four cores, swept: cancelled and charged to the tenant pool. */
async function unreservedJob(): Promise<string> {
  const res = await fetch(`${fx.tapis.url}/v3/jobs/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Tapis-Token": await tapisToken() },
    body: JSON.stringify({
      name: "someone else's job",
      appId: "partner-app",
      appVersion: "2.1.0",
      owner: "stranger-1",
      execSystemLogicalQueue: "shared",
      nodeCount: 1,
      coresPerNode: 4,
      memoryMB: 8000,
      maxMinutes: 60,
      tags: [],
    }),
  });
  const uuid = ((await res.json()) as { result: { uuid: string } }).result.uuid;
  fx.tapis.advance(uuid, "QUEUED");
  fx.tapis.advance(uuid, "RUNNING");
  setTapisTimes(fx, uuid, 30 * MINUTE, null);
  await sweepTenantJobs(fx.env(), "live");
  return (
    fx.harness.db.query("SELECT id FROM compute_jobs WHERE tapis_uuid = ?").get(uuid) as {
      id: string;
    }
  ).id;
}

const charged = (kind: string, ref: string) =>
  (
    fx.harness.db
      .query("SELECT charged_milli FROM compute_pools WHERE holder_kind = ? AND holder_ref = ?")
      .get(kind, ref) as { charged_milli: number } | null
  )?.charged_milli ?? 0;

describe("the owner moves a charge", () => {
  test("it says how much moved and to whom, and the pools moved", async () => {
    const job = await unreservedJob();
    const person = await seedUser(fx.env().DB);
    await fundAccount(fx.env().DB, person, 50_000);
    const before = charged("partner", "tenant");
    expect(before).toBeGreaterThanOrEqual(2000);
    seen = [];
    const r = await runCli("owner", [job, "--to", String(person)]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`of cpu moved to account ${person}`);
    expect(r.stdout).toMatch(/^[0-9.]+ SU of cpu moved/m);
    expect(seen).toEqual([`POST /admin/compute/jobs/${job}/move-charge`]);
    expect(charged("partner", "tenant")).toBe(0);
    expect(charged("account", String(person))).toBe(before);
  });

  test("--json prints the Worker's answer, and only that, on standard output", async () => {
    const job = await unreservedJob();
    const person = await seedUser(fx.env().DB);
    await fundAccount(fx.env().DB, person, 50_000);
    const r = await runCli("owner", [job, "--to", String(person), "--json"]);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(ComputeMoveChargeResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      job_id: job,
      to_account_id: person,
      pool: "cpu",
      replayed: false,
    });
    expect(r.stderr.trim()).toBe("");
  });

  test("a repeat says it was already moved, and moves nothing", async () => {
    const job = await unreservedJob();
    const person = await seedUser(fx.env().DB);
    await fundAccount(fx.env().DB, person, 50_000);
    await runCli("owner", [job, "--to", String(person)]);
    const after = charged("account", String(person));
    const again = await runCli("owner", [job, "--to", String(person)]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("already moved");
    expect(charged("account", String(person))).toBe(after);
  });
});

describe("what it refuses", () => {
  test("an administrator is refused: the move is the owner's, and nothing moves", async () => {
    const job = await unreservedJob();
    const person = await seedUser(fx.env().DB);
    await fundAccount(fx.env().DB, person, 50_000);
    const r = await runCli("admin", [job, "--to", String(person)]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("Only an owner can do that.");
    expect(charged("account", String(person))).toBe(0);
    expect(charged("partner", "tenant")).toBeGreaterThanOrEqual(2000);
  });

  test("no key, and a job id or an account number that is not valid, are refused before anything is sent", async () => {
    const none = await runCli(null, ["job_0123456789abcdef01234567", "--to", "5"]);
    expect(none.exitCode).toBe(1);
    for (const args of [
      ["not-a-job", "--to", "5"],
      ["job_0123456789abcdef01234567", "--to", "five"],
      ["job_0123456789abcdef01234567", "--to", "0"],
      ["job_0123456789abcdef01234567", "--to", "-3"],
      ["job_0123456789abcdef01234567", "--to", "1.5"],
      ["job_0123456789abcdef01234567"],
    ]) {
      seen = [];
      const r = await runCli("owner", args);
      expect([args.join(" "), r.exitCode]).toEqual([args.join(" "), 1]);
      expect(seen).toEqual([]);
    }
  });

  test("the Worker's refusals are shown with its sentence and exit 1: a reserved job, an account not in good standing", async () => {
    const reserved = await makeJob(fx);
    const person = await seedUser(fx.env().DB);
    await fundAccount(fx.env().DB, person, 50_000);
    const a = await runCli("owner", [reserved.job.id, "--to", String(person)]);
    expect(a.exitCode).toBe(1);
    expect(a.stdout + a.stderr).toContain(
      "That job was reserved, so its charge is not the partner's to move.",
    );

    const job = await unreservedJob();
    const pending = await seedUser(fx.env().DB, { status: "pending" });
    await fundAccount(fx.env().DB, pending, 50_000);
    const b = await runCli("owner", [job, "--to", String(pending)]);
    expect(b.exitCode).toBe(1);
    expect(b.stdout + b.stderr).toContain("That account is deleted or not in good standing.");
  });

  test("its help says it is the owner's and what it keeps", async () => {
    const r = await runCli("owner", ["--help-all"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Owner only.");
    expect(r.stdout).toContain("counted once");
    expect(r.stdout).toContain("Exit codes:");
  });
});
