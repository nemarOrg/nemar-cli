/**
 * `nemar admin compute jobs cancel|advance` (epic #2005 phase A5, #2010; ADR 0118), driven through the
 * real entry point against the REAL routes: the Worker's admin router behind its real authentication and
 * admin middleware, over real SQLite carrying every migration, Miniflare's R2 through the Worker's own
 * bindings and the Tapis stand-in behind it (which recorded nothing from a real tenant), served on a
 * loopback port and reached through TEST_API_URL. What the command prints is what the route answers.
 *
 * The properties, each with a test of its own: `advance` submits a created job and says so; `--json`
 * prints the Worker's answer and nothing else on standard output; `cancel` ends a job that never started;
 * a platform failure is shown as an information flag, never a refund; a malformed id is refused before
 * anything is sent; an unknown job, a member's key and no key at all exit 1; an answer with keys the CLI
 * does not know is shown, not refused (the schema is open); and no token, address or identity is printed.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  makeComputeApp,
  seedComputeUsers,
} from "../backend/test/helpers/compute-app";
import {
  type LifecycleFixture,
  MINUTE,
  jobTokenSeenByTapis,
  launchSpecEnvSeenByTapis,
  makeJob,
  reread,
  setTapisTimes,
  startLifecycleFixture,
} from "../backend/test/helpers/compute-lifecycle-fixture";
import { ComputeJobAdminResponseSchema } from "../shared/contract/compute-admin";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const handle = makeComputeApp();

let fx: LifecycleFixture;
let configDir: string;
/** Requests the server saw (the `/notices` call of the CLI is not counted). */
let seen: string[] = [];
let augment = false;

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/notices") return Response.json({ notices: [] });
    seen.push(`${req.method} ${url.pathname}`);
    const res = await handle(req, fx.env());
    if (augment && res.ok) {
      const body = (await res.json()) as Record<string, any>;
      body.future_top_level = { added: "by a newer worker" };
      if (body.job) body.job.future_nested = 7;
      return Response.json(body, { status: res.status });
    }
    return res;
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
  augment = false;
  configDir = mkdtempSync(join(tmpdir(), "nemar-compute-jobs-cli-"));
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
    cmd: ["bun", "run", CLI_ENTRY, "admin", "compute", "jobs", ...args],
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

describe("advance", () => {
  test("its help says the submit is refused while compute is switched off, and what stays", async () => {
    const r = await runCli("admin", ["advance", "--help-all"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("The submit is refused while compute is switched off");
    expect(r.stdout).toContain("compute_disabled");
  });

  test("it submits a created job and prints the job as the Worker shows it", async () => {
    const made = await makeJob(fx);
    const r = await runCli("admin", ["advance", made.job.id]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("outcome: submitted (submit: submitted)");
    expect(r.stdout).toContain(`job ${made.job.id}`);
    expect(r.stdout).toContain("state: submitted (Tapis PENDING)");
    expect(r.stdout).toContain("held 4 SU, charged 0 SU, not settled");
    expect(r.stdout).toContain("flags: none");
    expect((await reread(made.env, made.job.id)).state).toBe("submitted");
    expect(seen).toEqual([`POST /admin/compute/jobs/${made.job.id}/advance`]);
  });

  test("--json prints the Worker's answer, and only that, on standard output", async () => {
    const made = await makeJob(fx);
    const r = await runCli("admin", ["advance", made.job.id, "--json"]);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(ComputeJobAdminResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ ok: true, outcome: "submitted", job: { state: "submitted" } });
    expect(r.stderr.trim()).toBe("");
  });

  test("a platform failure is shown as an information flag, with its charge, and no refund", async () => {
    const made = await makeJob(fx);
    await runCli("admin", ["advance", made.job.id]);
    const uuid = (await reread(made.env, made.job.id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "RUNNING");
    await runCli("admin", ["advance", made.job.id]);
    fx.tapis.advance(uuid, "FAILED", "JOB_LAUNCH_FAILURE");
    setTapisTimes(fx, uuid, 30 * MINUTE, 0);
    const r = await runCli("admin", ["advance", made.job.id]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("failure: launch_failed");
    expect(r.stdout).toContain(
      "platform failure: yes (NEMAR caused it; compensate by a manual grant if warranted)",
    );
    expect(r.stdout).toContain("held 4 SU, charged 2 SU, settled");
    expect(r.stdout.toLowerCase()).not.toContain("refund");
  });

  test("an answer with keys the CLI does not know is shown, not refused", async () => {
    const made = await makeJob(fx);
    augment = true;
    const r = await runCli("admin", ["advance", made.job.id]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("outcome: submitted");
  });
});

describe("cancel", () => {
  test("it ends a job that never started, and says so", async () => {
    const made = await makeJob(fx);
    const r = await runCli("owner", ["cancel", made.job.id]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("outcome: cancel_requested");
    expect(r.stdout).toContain("state: cancelled");
    expect((await reread(made.env, made.job.id)).cancel_reason).toBe("admin");
  });

  test("a job that has already ended otherwise exits 1", async () => {
    const made = await makeJob(fx);
    await runCli("admin", ["advance", made.job.id]);
    const uuid = (await reread(made.env, made.job.id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "FAILED", "JOB_LAUNCH_FAILURE");
    await runCli("admin", ["advance", made.job.id]);
    const r = await runCli("admin", ["cancel", made.job.id]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("already ended");
  });
});

describe("refusals", () => {
  test("a malformed id is refused before anything is sent", async () => {
    for (const id of ["nope", "job_XYZ", "JOB_0123456789ABCDEF01234567"]) {
      for (const verb of ["cancel", "advance"]) {
        const r = await runCli("admin", [verb, id]);
        expect([id, verb, r.exitCode]).toEqual([id, verb, 1]);
        expect(r.stdout + r.stderr).toContain("not a job id");
      }
    }
    expect(seen).toEqual([]);
  });

  test("an unknown job, a member's key and no key at all exit 1", async () => {
    const made = await makeJob(fx);
    for (const verb of ["cancel", "advance"]) {
      expect((await runCli("admin", [verb, "job_000000000000000000000000"])).exitCode).toBe(1);
      expect((await runCli("member", [verb, made.job.id])).exitCode).toBe(1);
      expect((await runCli(null, [verb, made.job.id])).exitCode).toBe(1);
    }
    expect((await reread(made.env, made.job.id)).state).toBe("created");
  });
});

describe("what is printed", () => {
  test("no token, address, specification or identity is on standard output or standard error", async () => {
    const made = await makeJob(fx);
    const first = await runCli("admin", ["advance", made.job.id]);
    const uuid = (await reread(made.env, made.job.id)).tapis_uuid as string;
    const token = jobTokenSeenByTapis(fx, uuid);
    // The value Tapis holds carries the token, and the plain token is not a substring of it.
    const launchValue = launchSpecEnvSeenByTapis(fx, uuid);
    fx.tapis.advance(uuid, "RUNNING");
    const second = await runCli("admin", ["advance", made.job.id, "--json"]);
    const user = fx.harness.db
      .query("SELECT username, email FROM users WHERE id = ?")
      .get(made.accountId) as { username: string; email: string };
    for (const out of [first, second]) {
      const all = out.stdout + out.stderr;
      for (const word of [
        token,
        launchValue,
        fx.tapis.url,
        "NEMAR_LAUNCH_SPEC",
        "analyse",
        user.email,
        user.username,
      ]) {
        expect([word, all.includes(word)]).toEqual([word, false]);
      }
    }
  });
});
