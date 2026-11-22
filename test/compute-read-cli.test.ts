/**
 * `nemar compute balance|limits|queue|list|status` (epic #2021 phase D2, #2023; ADR 0118, the addendum of
 * that phase), driven through the real entry point against the REAL compute router (the Worker's
 * `computeRoutes` behind its real authentication), over real SQLite carrying every migration, served by
 * `Bun.serve` on a loopback port and reached through TEST_API_URL. What a command prints is what the route
 * answers; nothing is stood in for.
 *
 * The properties, each with a test of its own:
 *  - each command prints the figures the ledger holds, in SU with three decimals formed from whole
 *    thousandths (never a float), and works in every access state;
 *  - `--json` standard output is exactly one JSON document, the Worker's answer, and parses against the
 *    shared contract; `list --all` reads every page;
 *  - a person sees only their own jobs; another person's job id is "No such job." and exit 1;
 *  - an option or id that is not valid exits 1 and sends nothing; an unsigned user exits 1;
 *  - a read the Worker refuses exits 1 and prints the Worker's sentence, never an empty answer.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { placeHold, settleProvisional } from "../backend/src/services/compute-ledger";
import { fundAccount, fundPlatform } from "../backend/test/helpers/compute-seed";
import {
  type Person,
  chargeAt,
  insertJob,
  personWithKey,
  readApp,
  sqliteAt,
} from "../backend/test/helpers/compute-user-seed";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import { ACCOUNT_COPY } from "../shared/contract/account-copy";
import {
  ComputeMeResponseSchema,
  ComputeUserJobResponseSchema,
  ComputeUserJobsResponseSchema,
} from "../shared/contract/compute-user";
import { durationText, suFixed } from "../src/commands/compute-read";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

let db: Database;
let me: Person;
let other: Person;
let configDir: string;
let requests = 0;
let workerEnv: Record<string, unknown> = {};

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/notices") return Response.json({ notices: [] });
    requests += 1;
    const app = readApp(db, workerEnv as never);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const res = await app.call(`${url.pathname.replace(/^\/compute/, "")}${url.search}`, {
      headers,
      method: req.method,
    });
    return new Response(res.text, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  },
});
const API = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
});

beforeEach(async () => {
  db = freshDb();
  me = await personWithKey(db);
  other = await personWithKey(db);
  configDir = mkdtempSync(join(tmpdir(), "nemar-compute-read-cli-"));
  requests = 0;
  workerEnv = {};
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

interface Ran {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** `who`: a seeded person, or null for an unsigned CLI. */
async function runCli(who: Person | null, args: string[]): Promise<Ran> {
  if (who === null) {
    rmSync(join(configDir, "config.json"), { force: true });
  } else {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        activeAccount: "computecli",
        accounts: { computecli: { apiKey: who.key } },
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
    cmd: ["bun", "run", CLI_ENTRY, ...args],
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

const compute = (who: Person | null, ...args: string[]) => runCli(who, ["compute", ...args]);

/** Standard output is exactly one JSON document. */
function jsonOf(r: Ran): Record<string, any> {
  expect(r.stdout.trim().startsWith("{")).toBe(true);
  return JSON.parse(r.stdout);
}

/** A funded person with an open hold, a settled hold, and an overrun-free balance: 67.500 SU available. */
async function fundedLedger(who: Person) {
  const d1 = realD1(db);
  await fundPlatform(d1, "people", 10_000_000);
  const pool = await fundAccount(d1, who.id, 100_000);
  const budget = (
    db
      .query<{ id: number }, []>(
        "SELECT id FROM compute_pools WHERE holder_kind = 'platform' AND holder_ref = 'people' AND pool = 'cpu'",
      )
      .get() as { id: number }
  ).id;
  const hold = async (milli: number, job: string) => {
    const r = await placeHold(d1, {
      poolId: pool,
      budgetPoolId: budget,
      amountMilli: milli,
      jobId: job,
    });
    expect(r.ok).toBe(true);
  };
  const open = insertJob(db, { account_id: who.id, state: "running" });
  await hold(20_000, open);
  const done = insertJob(db, { account_id: who.id, state: "finished" });
  await hold(30_000, done);
  expect((await settleProvisional(d1, { jobId: done, chargeMilli: 12_500 })).ok).toBe(true);
}

describe("the formatting", () => {
  test("SU have exactly three decimals, from integers, with the sign", () => {
    expect(suFixed(0)).toBe("0.000");
    expect(suFixed(1)).toBe("0.001");
    expect(suFixed(999)).toBe("0.999");
    expect(suFixed(1000)).toBe("1.000");
    expect(suFixed(12_500)).toBe("12.500");
    expect(suFixed(-500)).toBe("-0.500");
    expect(suFixed(-4000)).toBe("-4.000");
    expect(suFixed(Number.MAX_SAFE_INTEGER)).toBe("9007199254740.991");
    expect(() => suFixed(1.5)).toThrow(RangeError);
  });

  test("a wait reads as seconds, minutes or hours", () => {
    expect(durationText(38)).toBe("38s");
    expect(durationText(252)).toBe("4m 12s");
    expect(durationText(3900)).toBe("1h 5m");
  });
});

describe("nemar compute balance", () => {
  test("prints the access state and each pool's granted, held, charged and available SU", async () => {
    await fundedLedger(me);
    const r = await compute(me, "balance");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Compute access: Active");
    expect(r.stdout).toMatch(/cpu\s+100\.000\s+20\.000\s+12\.500\s+67\.500/);
    expect(r.stdout).toMatch(/gpu\s+0\.000\s+0\.000\s+0\.000\s+0\.000/);
  });

  test("a negative available (an overrun) is printed with its sign", async () => {
    const d1 = realD1(db);
    await fundPlatform(d1, "people", 10_000_000);
    const pool = await fundAccount(d1, me.id, 10_000);
    const budget = (
      db
        .query<{ id: number }, []>(
          "SELECT id FROM compute_pools WHERE holder_kind = 'platform' AND holder_ref = 'people' AND pool = 'cpu'",
        )
        .get() as { id: number }
    ).id;
    const job = insertJob(db, { account_id: me.id });
    await placeHold(d1, { poolId: pool, budgetPoolId: budget, amountMilli: 10_000, jobId: job });
    await settleProvisional(d1, { jobId: job, chargeMilli: 14_000 });
    const r = await compute(me, "balance");
    expect(r.stdout).toMatch(/cpu\s+10\.000\s+0\.000\s+14\.000\s+-4\.000/);
  });

  test("without a grant it says so and how to ask; a suspended person is told it is paused", async () => {
    const none = await personWithKey(db, { access: "none" });
    const a = await compute(none, "balance");
    expect(a.exitCode).toBe(0);
    expect(a.stdout).toContain("Compute access: Not requested");
    expect(a.stdout).toContain("nemar compute request-access");
    const paused = await personWithKey(db, { access: "suspended" });
    const pool = await fundAccount(realD1(db), paused.id, 5_000);
    db.query("UPDATE compute_pools SET frozen = 1 WHERE id = ?").run(pool);
    const b = await compute(paused, "balance");
    expect(b.exitCode).toBe(0);
    expect(b.stdout).toContain("Compute access: Suspended");
    expect(b.stdout).toContain("paused");
    // The pause already explains the freeze; a second line that offers a lift would only confuse.
    expect(b.stdout).not.toContain("frozen");
  });

  test("a frozen pool is said only while access is held; a closed account is not told an admin can lift it", async () => {
    const held = await personWithKey(db, { access: "active" });
    const heldPool = await fundAccount(realD1(db), held.id, 5_000);
    db.query("UPDATE compute_pools SET frozen = 1 WHERE id = ?").run(heldPool);
    const a = await compute(held, "balance");
    expect(a.stdout).toContain("Your pools are frozen, so new jobs are refused.");
    for (const state of ["revoked", "denied", "requested"]) {
      const who = await personWithKey(db, { access: state });
      const pool = await fundAccount(realD1(db), who.id, 5_000);
      db.query("UPDATE compute_pools SET frozen = 1 WHERE id = ?").run(pool);
      const r = await compute(who, "balance");
      expect([state, r.exitCode]).toEqual([state, 0]);
      expect([state, r.stdout.includes("frozen")]).toEqual([state, false]);
      expect([state, r.stdout.includes("lifts")]).toEqual([state, false]);
    }
  });

  test("--json is exactly the Worker's answer, parses against the contract, and stderr is empty", async () => {
    await fundedLedger(me);
    const r = await compute(me, "balance", "--json");
    expect(r.exitCode).toBe(0);
    const body = jsonOf(r);
    expect(ComputeMeResponseSchema.safeParse(body).success).toBe(true);
    expect(body.pools.cpu.available_milli).toBe(67_500);
    expect(r.stderr).toBe("");
    // Nothing is printed around the document.
    expect(JSON.parse(r.stdout)).toEqual(body);
  });
});

describe("nemar compute limits and queue", () => {
  test("limits lists the offered partitions with their ceilings and the other limits", async () => {
    const r = await compute(me, "limits");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("4 created, queued or running");
    expect(r.stdout).toContain("30 days");
    expect(r.stdout).toMatch(/shared\s+cpu\s+1\s+64\s+0\s+48h/);
    expect(r.stdout).not.toContain("large-shared");
    const j = await compute(me, "limits", "--json");
    expect(jsonOf(j).limits.max_live_jobs).toBe(4);
  });

  test("queue prints the median and the 90th percentile with five samples and none with four", async () => {
    const now = Date.now();
    const started = (partition: string, wait: number) =>
      insertJob(db, {
        partition,
        account_id: other.id,
        started_at: sqliteAt(now - 3_600_000),
        remote_submitted_at: sqliteAt(now - 3_600_000 - wait * 1000),
      });
    for (const wait of [60, 120, 180, 240, 3_900]) started("shared", wait);
    for (const wait of [5, 6, 7, 8]) started("compute", wait);
    const r = await compute(me, "queue");
    expect(r.exitCode).toBe(0);
    // Nearest rank of 5: the median is the 3rd (180s), the 90th percentile the 5th (3900s).
    expect(r.stdout).toMatch(/shared\s+3m 0s\s+1h 5m\s+5\b/);
    expect(r.stdout).toMatch(/compute\s+-\s+-\s+4 \(too few for an estimate\)/);
    const j = await compute(me, "queue", "--json");
    expect(
      jsonOf(j).queue.find((q: { partition: string }) => q.partition === "shared"),
    ).toMatchObject({
      median_seconds: 180,
      p90_seconds: 3_900,
      count: 5,
    });
  });
});

describe("nemar compute list", () => {
  function jobsAt(who: Person, n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        insertJob(db, {
          account_id: who.id,
          created_at: sqliteAt(Date.UTC(2026, 9, 1, 12, 0, i)),
          state: i % 2 === 0 ? "finished" : "running",
          charged_milli: i % 2 === 0 ? 1_500 : 0,
        }),
      );
    }
    return ids;
  }

  test("lists the caller's jobs newest first, and nobody else's", async () => {
    const mine = jobsAt(me, 3);
    const theirs = jobsAt(other, 2);
    const r = await compute(me, "list");
    expect(r.exitCode).toBe(0);
    const order = [...mine].reverse();
    const positions = order.map((id) => r.stdout.indexOf(id));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const id of theirs) expect(r.stdout).not.toContain(id);
    expect(r.stdout).toContain("1.500 SU");
  });

  test("--state filters, an empty list is exit 0 and says so", async () => {
    jobsAt(me, 4);
    const running = await compute(me, "list", "--state", "running", "--json");
    const body = jsonOf(running);
    expect(ComputeUserJobsResponseSchema.safeParse(body).success).toBe(true);
    expect(body.jobs.every((j: { state: string }) => j.state === "running")).toBe(true);
    expect(body.jobs).toHaveLength(2);
    const none = await compute(me, "list", "--state", "cancelled");
    expect(none.exitCode).toBe(0);
    expect(none.stdout).toContain("No jobs.");
  });

  test("--limit makes a page and says there are more; --all reads every page", async () => {
    const mine = jobsAt(me, 5);
    const page = await compute(me, "list", "--limit", "2");
    expect(page.exitCode).toBe(0);
    expect(page.stdout).toContain("More jobs exist");
    expect((page.stdout.match(/job_[0-9a-f]{24}/g) ?? []).length).toBe(2);
    const all = await compute(me, "list", "--limit", "2", "--all", "--json");
    const body = jsonOf(all);
    expect(body.jobs.map((j: { id: string }) => j.id)).toEqual([...mine].reverse());
    expect(body.next_after).toBeNull();
    const text = await compute(me, "list", "--limit", "2", "--all");
    expect(text.stdout).not.toContain("More jobs exist");
    expect((text.stdout.match(/job_[0-9a-f]{24}/g) ?? []).length).toBe(5);
  });

  test("a state, limit or cursor the CLI can see is wrong exits 1 and sends nothing", async () => {
    for (const args of [
      ["--state", "done"],
      ["--limit", "0"],
      ["--limit", "101"],
      ["--limit", "abc"],
      ["--limit", "1.5"],
    ]) {
      requests = 0;
      const r = await compute(me, "list", ...args);
      expect([args.join(" "), r.exitCode]).toEqual([args.join(" "), 1]);
      expect(requests).toBe(0);
    }
  });
});

describe("nemar compute status", () => {
  test("prints one job: state, resources, times, charge and failure", async () => {
    const id = insertJob(db, {
      account_id: me.id,
      state: "failed",
      failure_code: "runtime_error",
      partition: "compute",
      nodes: 2,
      cores_per_node: 128,
      minutes: 90,
      created_at: "2026-10-05 10:00:00",
      started_at: "2026-10-05 10:10:00",
      ended_at: "2026-10-05 10:40:00",
      charged_milli: 12_345,
    });
    const r = await compute(me, "status", id);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(id);
    expect(r.stdout).toContain("failed");
    expect(r.stdout).toContain("compute (cpu)");
    expect(r.stdout).toContain("2 nodes, 128 cores each");
    expect(r.stdout).toContain("1h 30m");
    expect(r.stdout).toContain("2026-10-05 10:10:00 UTC");
    expect(r.stdout).toContain("12.345 SU");
    expect(r.stdout).toContain("runtime_error");
    expect(r.stdout).not.toContain("may be out of date");
    const j = await compute(me, "status", id, "--json");
    expect(ComputeUserJobResponseSchema.safeParse(jsonOf(j)).success).toBe(true);
  });

  test("a live job whose record is old and cannot be refreshed is shown, with a warning that it may be out of date", async () => {
    // No Tapis is configured for this Worker, so the refresh of an old record cannot be made: the stored
    // record is served with `stale: true`, and the command says so (and --json carries the flag).
    const id = insertJob(db, {
      account_id: me.id,
      state: "running",
      tapis_uuid: "22222222-3333-4444-5555-666666666666",
      tapis_synced_at: "2026-10-05 10:00:00",
    });
    const r = await compute(me, "status", id);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("running");
    expect(r.stdout).toContain("may be out of date");
    const j = await compute(me, "status", id, "--json");
    expect(jsonOf(j).stale).toBe(true);
    expect(r.stdout).not.toContain("22222222-3333");
  });

  test("another person's job is 'No such job.' and exit 1, the same as an absent one", async () => {
    const theirs = insertJob(db, { account_id: other.id });
    const a = await compute(me, "status", theirs);
    const b = await compute(me, "status", "job_0000000000000000deadbeef");
    for (const r of [a, b]) {
      expect(r.exitCode).toBe(1);
      expect(r.stdout + r.stderr).toContain("No such job.");
    }
    expect(a.stdout + a.stderr).toBe(b.stdout + b.stderr);
  });

  test("an id that is not a job id exits 1 and sends nothing", async () => {
    const r = await compute(me, "status", "nm000104");
    expect(r.exitCode).toBe(1);
    expect(requests).toBe(0);
  });

  test("a job with the admin-only facts shows none of them", async () => {
    const id = insertJob(db, {
      account_id: me.id,
      flag_mismatch: 1,
      platform_failure: 1,
      slurm_job_id: "9876543",
      tapis_uuid: "11111111-2222-3333-4444-555555555555",
    });
    const r = await compute(me, "status", id, "--json");
    for (const word of ["mismatch", "platform_failure", "9876543", "11111111-2222", "flags"]) {
      expect([word, r.stdout.includes(word)]).toEqual([word, false]);
    }
  });
});

describe("the help says what the website says", () => {
  test("balance and queue embed the shared sentences", async () => {
    const balance = await compute(null, "balance", "--help-all");
    expect(balance.exitCode).toBe(0);
    expect(balance.stdout.replace(/\s+/g, " ")).toContain(
      ACCOUNT_COPY["compute_page.available_note"],
    );
    const queue = await compute(null, "queue", "--help-all");
    expect(queue.exitCode).toBe(0);
    expect(queue.stdout.replace(/\s+/g, " ")).toContain(ACCOUNT_COPY["compute_page.queue_note"]);
  });
});

describe("every command", () => {
  const commands: string[][] = [
    ["balance"],
    ["limits"],
    ["queue"],
    ["list"],
    ["status", "job_000000000000000000000001"],
  ];

  test("an unsigned user exits 1, and --json leaves standard output empty", async () => {
    for (const args of commands) {
      const plainRun = await compute(null, ...args);
      expect([args[0], plainRun.exitCode]).toEqual([args[0], 1]);
      const json = await compute(null, ...args, "--json");
      expect([args[0], json.exitCode, json.stdout]).toEqual([args[0], 1, ""]);
      expect(json.stderr).toContain("Error: Not authenticated");
    }
    expect(requests).toBe(0);
  });

  test("a Worker that refuses the read exits 1 with its sentence, never an empty answer", async () => {
    // An unreadable owner policy: `GET /compute/me` is 503 `policy_unavailable`.
    db.query("INSERT INTO compute_policy (policy_json, set_by) VALUES ('{}', 1)").run();
    for (const args of [["balance"], ["limits"], ["queue"]]) {
      const r = await compute(me, ...args);
      expect([args[0], r.exitCode]).toEqual([args[0], 1]);
      expect(r.stdout + r.stderr).toContain("could not read its limits");
    }
    const j = await compute(me, "balance", "--json");
    expect(j.exitCode).toBe(1);
    expect(j.stdout).toBe("");
    expect(j.stderr).toContain("could not read its limits");
  });

  test("--json keeps standard output pure for every command that succeeds", async () => {
    const id = insertJob(db, { account_id: me.id });
    chargeAt(db, { accountId: me.id, jobId: id, milli: 1_000, at: "2026-10-05 10:00:00" });
    for (const args of [["balance"], ["limits"], ["queue"], ["list"], ["status", id]]) {
      const r = await compute(me, ...args, "--json");
      expect([args[0], r.exitCode]).toEqual([args[0], 0]);
      expect(() => JSON.parse(r.stdout)).not.toThrow();
      expect(r.stderr).toBe("");
    }
  });

  test("the full help of each command has an Exit codes block", async () => {
    for (const name of ["balance", "limits", "queue", "list", "status"]) {
      const r = await compute(null, name, "--help-all");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Exit codes:");
    }
  });
});
