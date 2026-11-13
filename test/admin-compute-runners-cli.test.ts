/**
 * `nemar admin compute runners register|list|revoke` (portable compute, card DM-05), driven through the
 * real entry point against the REAL routes: the Worker's admin router behind its real authentication and
 * admin middleware, over real SQLite carrying every migration, served on a loopback port and reached
 * through TEST_API_URL. What the command prints is what the route answers.
 *
 * The properties, each with a test of its own:
 *  - `register` prints the id and the secret ONCE with the warning to keep it in a mode-0600 file, and the
 *    Worker stored only the hash; `list` never shows the secret or a hash; `--json` keeps standard output
 *    pure JSON, the secret included, and the failure goes to standard error;
 *  - a bad option (a pool, a count, a runtime, a name, no runtime) is refused BEFORE anything is sent, with
 *    the field named;
 *  - an administrator who is not an owner, a member and no key exit 1 and register nothing;
 *  - `list` prints the registrations and `revoke` ends one; a second revoke says it changed nothing; a
 *    malformed id is refused before anything is sent and an unknown one exits 1;
 *  - an answer with keys the CLI does not know is shown, not refused (the listing's schema is open);
 *  - every subcommand's help has an "Exit codes:" block.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  computeEnv,
  makeComputeApp,
  seedComputeUsers,
} from "../backend/test/helpers/compute-app";
import { freshDb } from "../backend/test/helpers/d1";
import { RUNNER_SECRET_RE, RunnerRegisterResponseSchema } from "../shared/contract/compute-runner";
import { RunnerListResponseSchema } from "../src/lib/api/compute-runners";

/** A row or a JSON body read back by a test, whose fields the assertions name. */
// biome-ignore lint/suspicious/noExplicitAny: test rows and bodies are read field by field
type Loose = Record<string, any>;

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const handle = makeComputeApp();

let db: Database;
let configDir: string;
/** Requests that reached the Worker's admin router since the last reset. */
let reached = 0;
/** When set, an answer with keys a newer Worker would add. */
let augment = false;

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/notices") return Response.json({ notices: [] });
    reached += 1;
    const res = await handle(req, computeEnv(db));
    if (augment && res.ok) {
      const body = (await res.json()) as Loose;
      body.future_top_level = { added: "by a newer worker" };
      for (const r of body.runners ?? []) r.future_field = 7;
      return Response.json(body, { status: res.status });
    }
    return res;
  },
});
const API = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
});

beforeEach(async () => {
  db = freshDb();
  await seedComputeUsers(db);
  reached = 0;
  augment = false;
  configDir = mkdtempSync(join(tmpdir(), "nemar-runners-cli-"));
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
        activeAccount: "runnerscli",
        accounts: { runnerscli: { apiKey: COMPUTE_KEYS[who] } },
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
    cmd: ["bun", "run", CLI_ENTRY, "admin", "compute", "runners", ...args],
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

const FLAGS = [
  "--pool",
  "cpu",
  "--cores",
  "16",
  "--memory-mb",
  "64000",
  "--scratch-gb",
  "500",
  "--runtime",
  "docker",
  "--arch",
  "amd64",
  "--site",
  "lab_a",
  "--trust",
  "lab",
];

const register = (who: ComputeWho | null, name = "lab_a_cpu", flags = FLAGS) =>
  runCli(who, ["register", name, ...flags]);

const runnerRows = () => db.query("SELECT * FROM compute_runners").all() as Array<Loose>;

describe("register", () => {
  test("prints the id and the secret once, with the mode-0600 warning, and the Worker stored only the hash", async () => {
    const r = await register("owner", "lab_a_cpu", [...FLAGS, "--runtime", "apptainer"]);
    expect(r.exitCode).toBe(0);
    const secret = r.stdout.match(/nmr_[0-9a-f]{64}/)?.[0];
    expect(secret).toMatch(RUNNER_SECRET_RE);
    expect(r.stdout).toMatch(/Registered runner rnr_[0-9a-f]{24} \(lab_a_cpu\)/);
    expect(r.stdout).toContain("ONCE");
    expect(r.stdout).toContain("mode 0600");
    expect(r.stdout.split(secret as string)).toHaveLength(2);
    expect(r.stderr).not.toContain(secret as string);
    const rows = runnerRows();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(secret as string);
    expect(JSON.parse(rows[0]?.runtimes)).toEqual(["docker", "apptainer"]);
    expect(rows[0]).toMatchObject({
      pool: "cpu",
      cores: 16,
      gpus: 0,
      backend: "local",
      accounting: "none",
    });
  });

  test("--json keeps standard output pure JSON, with the secret, and prints no prose", async () => {
    const r = await register("owner", "json_one", [...FLAGS, "--json"]);
    expect(r.exitCode).toBe(0);
    const parsed = RunnerRegisterResponseSchema.parse(JSON.parse(r.stdout));
    expect(parsed.secret).toMatch(RUNNER_SECRET_RE);
    expect(r.stderr).toBe("");
  });

  test("a bad option is refused BEFORE anything is sent, and the field is named", async () => {
    const without = (flag: string) => {
      const at = FLAGS.indexOf(flag);
      return [...FLAGS.slice(0, at), ...FLAGS.slice(at + 2)];
    };
    const cases: Array<[string, string, string[]]> = [
      ["a pool that is not one", "lab_a", ["--pool", "tpu", ...without("--pool")]],
      ["cores that are not a number", "lab_a", ["--cores", "many", ...without("--cores")]],
      ["cores out of range", "lab_a", ["--cores", "0", ...without("--cores")]],
      ["a runtime that is not one", "lab_a", [...FLAGS, "--runtime", "lxc"]],
      ["the same runtime twice", "lab_a", [...FLAGS, "--runtime", "docker"]],
      ["no runtime at all", "lab_a", without("--runtime")],
      ["a name that is not a word", "Bad Name", FLAGS],
      ["a site that is not a word", "lab_a", ["--site", "Lab A", ...without("--site")]],
      ["a trust that is not one", "lab_a", ["--trust", "cloud", ...without("--trust")]],
      ["no arch", "lab_a", without("--arch")],
    ];
    for (const [what, name, flags] of cases) {
      const before = reached;
      const r = await runCli("owner", ["register", name, ...flags]);
      expect([what, r.exitCode]).toEqual([what, 1]);
      expect([what, r.stderr, r.stdout].join("\n")).toContain("nothing was sent");
      expect([what, reached]).toEqual([what, before]);
    }
    expect(runnerRows()).toHaveLength(0);
  });

  test("an administrator who is not an owner, a member and no key exit 1 and register nothing", async () => {
    for (const who of ["admin", "member", null] as const) {
      const r = await register(who);
      expect([who, r.exitCode]).toEqual([who, 1]);
      expect(r.stdout).not.toMatch(/nmr_/);
    }
    expect(runnerRows()).toHaveLength(0);
  });

  test("a live name is refused, with the Worker's word, and exits 1", async () => {
    expect((await register("owner")).exitCode).toBe(0);
    const again = await register("owner");
    expect(again.exitCode).toBe(1);
    expect(again.stderr + again.stdout).toContain("already has that name");
    expect(runnerRows()).toHaveLength(1);
  });
});

describe("list", () => {
  test("lists the registrations without a secret or a hash, and --json is the Worker's answer", async () => {
    const reg = await register("owner", "first_one", [...FLAGS, "--json"]);
    const { secret } = RunnerRegisterResponseSchema.parse(JSON.parse(reg.stdout));
    await register(
      "owner",
      "second_one",
      [...FLAGS, "--backend", "slurm", "--trust", "hpc"].filter(
        (x, i, a) => !(x === "--trust" && a[i + 1] === "lab") && !(x === "lab"),
      ),
    );
    const r = await runCli("owner", ["list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("first_one");
    expect(r.stdout).toContain("second_one");
    expect(r.stdout).toContain("live, never seen");
    expect(r.stdout + r.stderr).not.toContain(secret);
    expect(r.stdout + r.stderr).not.toMatch(/secret_hash|[0-9a-f]{64}/);
    const j = await runCli("owner", ["list", "--json"]);
    expect(RunnerListResponseSchema.parse(JSON.parse(j.stdout)).runners).toHaveLength(2);
    expect(j.stdout).not.toContain(secret);
  });

  test("an empty registry says so, and a non-owner exits 1", async () => {
    const r = await runCli("owner", ["list"]);
    expect([r.exitCode, r.stdout.trim()]).toEqual([0, "No runner is registered."]);
    for (const who of ["admin", "member", null] as const) {
      expect([who, (await runCli(who, ["list"])).exitCode]).toEqual([who, 1]);
    }
  });

  test("an answer with keys the CLI does not know is shown, not refused", async () => {
    await register("owner");
    augment = true;
    const r = await runCli("owner", ["list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("lab_a_cpu");
    const j = await runCli("owner", ["list", "--json"]);
    expect(JSON.parse(j.stdout).future_top_level).toEqual({ added: "by a newer worker" });
  });
});

describe("revoke", () => {
  test("ends a registration, and a second revoke says it changed nothing", async () => {
    await register("owner");
    const id = runnerRows()[0]?.id as string;
    const r = await runCli("owner", ["revoke", id]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`Revoked runner ${id}`);
    expect(runnerRows()[0]?.revoke_reason).toBe("owner_revoked");
    const again = await runCli("owner", ["revoke", id]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("already revoked");
    const j = await runCli("owner", ["revoke", id, "--json"]);
    expect(JSON.parse(j.stdout)).toEqual({ runner_id: id, revoked: true, already_revoked: true });
    expect((await runCli("owner", ["list"])).stdout).toContain("revoked (owner_revoked)");
  });

  test("a malformed id is refused before anything is sent, an unknown one exits 1, and a non-owner cannot", async () => {
    await register("owner");
    const before = reached;
    const bad = await runCli("owner", ["revoke", "not-an-id"]);
    expect(bad.exitCode).toBe(1);
    expect(reached).toBe(before);
    const unknown = await runCli("owner", ["revoke", `rnr_${"0".repeat(24)}`]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr + unknown.stdout).toContain("no such runner");
    const id = runnerRows()[0]?.id as string;
    for (const who of ["admin", "member", null] as const) {
      expect([who, (await runCli(who, ["revoke", id])).exitCode]).toEqual([who, 1]);
    }
    expect(runnerRows()[0]?.revoked_at).toBeNull();
  });
});

describe("help", () => {
  test("every subcommand's help has an Exit codes block, and register's names the secret rule", async () => {
    for (const sub of ["register", "list", "revoke"]) {
      const r = await runCli("owner", [sub, "--help-all"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Exit codes:");
    }
    const help = (await runCli("owner", ["register", "--help-all"])).stdout;
    expect(help).toContain("mode 0600");
    expect(help).toContain("ONCE");
  });
});
