/**
 * `nemar compute submit|logs|results|cancel` end to end (epic #2021 phase D3b, #2024; ADR 0118, the amendment
 * of phase D3): the REAL CLI, spawned with an isolated NEMAR_CONFIG_DIR, against the REAL compute router, the
 * REAL admin router and the REAL webhook router behind their real authentication, served by `Bun.serve` over
 * real migrated SQLite, Miniflare's R2 through the Worker's own bindings, the real local S3 interface (the
 * address the Worker signs is the one the CLI PUTs to) and the Tapis stand-in of Epic A. Nothing is stood in
 * for a NEMAR decision. The Tapis stand-in and the S3 interface were built from published specifications; no
 * response of either was recorded from a real service. The test plays two parts of the world: the cluster
 * (it moves the job's Tapis status and fires the webhook the Worker subscribed) and the launcher (it writes
 * the job's outputs and launcher files, `playLauncher`).
 *
 * What is pinned, each with a test of its own:
 *  - the story: a person granted compute access through the real admin route submits a script with an inline
 *    header and `--wait`s for `finished`; `results --download` fetches and VERIFIES the files; a second job is
 *    submitted and canceled; `balance` shows the charge and the release;
 *  - a refused hold writes nothing and sends no byte: the CLI exits 1 with the Worker's sentence, no job, no
 *    ledger entry, no object in either bucket, no PUT to the store;
 *  - a finalize after the upload hour is the Worker's `upload_expired` sentence and exit 1, and the hold is
 *    released; a 503 after the hold is retried with the SAME Idempotency-Key and finishes the one job;
 *  - Ctrl-C while waiting exits 3 and does NOT cancel; a download whose bytes changed is deleted and exits 1;
 *  - `--json` is only the Worker's answer for each command, and a bearer link never reaches the debug log.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";
import { hashApiKey } from "../backend/src/services/token";
import type { Bindings } from "../backend/src/types/bindings";
import { makeComputeApp } from "../backend/test/helpers/compute-app";
import {
  MINUTE,
  playLauncher,
  setTapisTimes,
} from "../backend/test/helpers/compute-lifecycle-fixture";
import { serveRoutes } from "../backend/test/helpers/compute-routes-app";
import { setPolicy } from "../backend/test/helpers/compute-seed";
import { seedUser } from "../backend/test/helpers/compute-seed";
import {
  type Person,
  type World,
  jobRow,
  newPerson,
  resetWorld,
  startWorld,
} from "../backend/test/helpers/compute-submit-world";
import { resultsOutputKey } from "../shared/contract/compute-launch";
import { COMPUTE_TERMS_VERSION } from "../shared/contract/compute-terms";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

let w: World;
let server: ReturnType<typeof Bun.serve>;
let API = "";
let workerEnv: Bindings;
let configDir: string;
let work: string;
/** Every request the server saw: method and path (never a body). */
let seen: Array<{ method: string; path: string }> = [];
/** Before the next request that matches, run this (a clock moved, a store gone). One shot. */
let beforeRequest:
  | ((method: string, path: string) => Promise<Bindings | undefined> | undefined)
  | null = null;

const adminApp = makeComputeApp();

beforeAll(async () => {
  w = await startWorld();
  const routes = serveRoutes(w.handle, () => workerEnv);
  routes.stop(true);
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      seen.push({ method: req.method, path: url.pathname });
      let env = workerEnv;
      if (beforeRequest) {
        const hook = beforeRequest;
        const replaced = await hook(req.method, url.pathname);
        if (replaced) env = replaced;
      }
      if (url.pathname.startsWith("/admin") || url.pathname.startsWith("/users")) {
        return adminApp(req, env);
      }
      return w.handle(req, env);
    },
  });
  API = `http://127.0.0.1:${server.port}`;
}, 120_000);

beforeEach(async () => {
  await resetWorld(w);
  workerEnv = w.env({ API_BASE_URL: API });
  seen = [];
  beforeRequest = null;
  configDir = mkdtempSync(join(tmpdir(), "nemar-compute-e2e-cfg-"));
  work = mkdtempSync(join(tmpdir(), "nemar-compute-e2e-work-"));
  w.fx.harness.standin.log.length = 0;
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

afterAll(async () => {
  server?.stop(true);
  await w?.fx.dispose();
}, 30_000);

// --- The CLI -----------------------------------------------------------------------------------------------

interface Ran {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: API,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
    ...extra,
  })) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

function signInAs(who: Person | null): void {
  if (who === null) {
    rmSync(join(configDir, "config.json"), { force: true });
    return;
  }
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ activeAccount: "e2e", accounts: { e2e: { apiKey: who.key } } }),
  );
}

function start(
  who: Person | null,
  args: string[],
  extra: Record<string, string> = {},
  globalFlags: string[] = [],
) {
  signInAs(who);
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...globalFlags, "compute", ...args],
    cwd: work,
    env: cliEnv(extra),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc;
}

async function finish(proc: Subprocess<"ignore", "pipe", "pipe">): Promise<Ran> {
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited };
}

const cli = async (who: Person | null, ...args: string[]): Promise<Ran> => finish(start(who, args));

function jsonOf(r: Ran): Record<string, any> {
  expect(r.stdout.trim().startsWith("{")).toBe(true);
  return JSON.parse(r.stdout);
}

// --- People -------------------------------------------------------------------------------------------------

let keys = 0;

/** A person who asked for compute access and was granted it through the REAL admin route, with a key. */
async function grantedPerson(grantMilli = 100_000): Promise<Person> {
  const env = w.env();
  await setPolicy(env.DB, w.fx.ownerId, { defaultGrantMilli: { cpu: grantMilli, gpu: 0 } });
  const id = await seedUser(env.DB, {});
  w.fx.harness.db
    .query(
      `UPDATE users SET compute_access = 'requested', compute_access_requested_at = datetime('now'),
         compute_purpose = ?, compute_terms_version = ?, compute_terms_accepted_at = datetime('now')
       WHERE id = ?`,
    )
    .run(
      "Run ICA decompositions on public EEG datasets for a methods comparison.",
      COMPUTE_TERMS_VERSION,
      id,
    );
  w.fx.harness.db
    .query(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', ?)",
    )
    .run(id, `0000-0002-${String(id).padStart(4, "0")}-0000`);
  const key = `e2e-person-key-${++keys}-0123456789abcdef0123456789abcdef`;
  w.fx.harness.db
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(id, await hashApiKey(key), key.slice(0, 8));

  const admin = await seedUser(env.DB, { role: "admin" });
  const adminKey = `e2e-admin-key-${++keys}-0123456789abcdef0123456789abcdef`;
  w.fx.harness.db
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(admin, await hashApiKey(adminKey), adminKey.slice(0, 8));
  const granted = await adminApp(
    new Request(`http://api.test/admin/compute/access/grant/by-id/${id}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
      body: JSON.stringify({ reason: "reviewed" }),
    }),
    w.env({ ENVIRONMENT: "test" }),
  );
  expect(granted.status).toBe(200);
  return { id, key };
}

// --- The cluster and the launcher ----------------------------------------------------------------------------

async function waitFor<T>(what: string, read: () => T | undefined | null, ms = 60_000): Promise<T> {
  const stop = Date.now() + ms;
  for (;;) {
    const got = read();
    if (got !== undefined && got !== null) return got;
    if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

/** The one job of an account (other than the ones to ignore) that Tapis has, once it does. */
async function submittedJob(
  accountId: number,
  ignore: readonly string[] = [],
): Promise<{ id: string; uuid: string }> {
  return waitFor("a job at Tapis", () => {
    const rows = w.fx.harness.db
      .query(
        "SELECT id, tapis_uuid FROM compute_jobs WHERE account_id = ? AND tapis_uuid IS NOT NULL",
      )
      .all(accountId) as Array<{ id: string; tapis_uuid: string }>;
    const fresh = rows.filter((r) => !ignore.includes(r.id));
    const only = fresh[0];
    return fresh.length === 1 && only ? { id: only.id, uuid: only.tapis_uuid } : null;
  });
}

async function specOf(id: string): Promise<{ bundle?: { sha256: string } }> {
  const object = await w.fx.harness.records.get(`records/${id}/spec.json`);
  return JSON.parse(await (object as { text(): Promise<string> }).text());
}

/** The cluster runs the job and the launcher uploads its outputs; Tapis says FINISHED. */
async function runToFinished(
  accountId: number,
  outputs: Array<{ path: string; content: string }>,
  ignore: readonly string[] = [],
): Promise<string> {
  const { id, uuid } = await submittedJob(accountId, ignore);
  for (const status of ["QUEUED", "RUNNING", "ARCHIVING"]) {
    w.fx.tapis.advance(uuid, status);
    await w.fx.tapis.fireWebhook(uuid);
  }
  const spec = await specOf(id);
  const job = await readJob(id);
  await playLauncher(w.fx, workerEnv, job as never, uuid, {
    outputs,
    bundleDigest: spec.bundle?.sha256 ?? null,
  });
  w.fx.tapis.advance(uuid, "FINISHED");
  setTapisTimes(w.fx, uuid, 30 * MINUTE, 0);
  (w.fx.tapis.jobs.get(uuid)?.record as Record<string, unknown>).remoteResultInfo = "0";
  await w.fx.tapis.fireWebhook(uuid);
  return id;
}

async function readJob(id: string) {
  const { getJob } = await import("../backend/src/services/compute-jobs");
  const job = await getJob(workerEnv.DB, id);
  if (!job) throw new Error("no such job");
  return job;
}

const ledger = (jobId: string): string[] =>
  (
    w.fx.harness.db
      .query("SELECT kind FROM compute_ledger WHERE job_id = ? ORDER BY id")
      .all(jobId) as Array<{
      kind: string;
    }>
  ).map((r) => r.kind);

function script(name = "analysis.py", body = "print('hello from a job')\n"): string {
  const path = join(work, name);
  writeFileSync(path, body);
  return path;
}

const HEADER = [
  "# /// nemar",
  '# name = "header-job"',
  "# cores = 2",
  '# time = "30m"',
  '# datasets = ["nm000104@1.0.0"]',
  "# ///",
  "print('hello from a job')",
  "",
].join("\n");

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

// --- The story ----------------------------------------------------------------------------------------------

describe("the whole story", () => {
  test("submit --wait to finished, results --download verified, a second job canceled, balance shows charge and release", async () => {
    const p = await grantedPerson();
    script("analysis.py", HEADER);

    const proc = start(p, ["submit", "analysis.py", "--wait"]);
    const driver = (async () =>
      runToFinished(p.id, [
        { path: "report.txt", content: "the report\n" },
        { path: "deep/table.csv", content: "a,b\n1,2\n" },
      ]))();
    const done = await finish(proc);
    const firstId = await driver;
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain("Submitted job_");
    expect(done.stdout).toContain("(header-job)");
    expect(done.stdout).toMatch(/\d\d:\d\d:\d\d {2}submitted/);
    expect(done.stdout).toMatch(/\d\d:\d\d:\d\d {2}finished/);
    expect(done.stdout).toContain(`Job ${firstId} finished.`);
    expect(jobRow(w, firstId).state).toBe("finished");
    expect(ledger(firstId)).toEqual(["hold", "charge"]);

    // results: list, then download and verify
    const listed = await cli(p, "results", firstId);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("2 files");
    expect(listed.stdout).toContain("report.txt");
    expect(listed.stdout).toContain(
      "Anyone who holds a link can download that file until the link expires",
    );
    expect(listed.stdout).not.toContain("X-Amz-Signature");
    expect(listed.stdout).not.toContain("http://");

    const dir = join(work, "out");
    const downloaded = await cli(p, "results", firstId, "--download", dir);
    expect(downloaded.exitCode).toBe(0);
    expect(readFileSync(join(dir, "report.txt"), "utf8")).toBe("the report\n");
    expect(readFileSync(join(dir, "deep/table.csv"), "utf8")).toBe("a,b\n1,2\n");
    expect(readdirSync(dir).filter((n) => n.endsWith(".part"))).toEqual([]);
    // A second run leaves verified files alone.
    const again = await cli(p, "results", firstId, "--download", dir);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("already   report.txt");

    // the second job: submitted, then canceled
    script("second.py");
    const second = start(p, ["submit", "second.py"]);
    const secondRan = await finish(second);
    expect(secondRan.exitCode).toBe(0);
    const secondId = (secondRan.stdout.match(/job_[0-9a-f]{24}/) as RegExpMatchArray)[0];
    const { uuid } = await submittedJob(p.id, [firstId]);
    expect(jobRow(w, secondId).state).toBe("submitted");
    const canceled = await cli(p, "cancel", secondId, "--yes");
    expect(canceled.exitCode).toBe(0);
    expect(canceled.stdout).toContain(`Cancel recorded for ${secondId}`);
    // the cluster carries the cancel out (the stand-in's own cancel moves the job to CANCELLED)
    await w.fx.tapis.fireWebhook(uuid);
    const { runComputeAdvanceCron } = await import("../backend/src/services/compute-advance");
    await runComputeAdvanceCron(workerEnv);
    expect(jobRow(w, secondId).state).toBe("cancelled");

    const balance = await cli(p, "balance");
    expect(balance.exitCode).toBe(0);
    const row = balance.stdout.split("\n").find((l) => l.startsWith("cpu")) as string;
    const [, granted, held, charged, available] = row.split(/\s+/);
    expect(granted).toBe("100.000");
    expect(held).toBe("0.000");
    // the first job: 2 cores for 30 minutes is 1 SU
    expect(Number(charged)).toBeGreaterThanOrEqual(1);
    expect(Number(available)).toBeCloseTo(100 - Number(charged), 3);
  }, 180_000);
});

describe("a refused hold writes nothing and sends no byte", () => {
  test("insufficient balance: exit 1 with the Worker's sentence; no job, no ledger entry, no object, no PUT", async () => {
    const p = await grantedPerson(100); // 0.1 SU
    script("analysis.py", HEADER);
    const before = (
      w.fx.harness.db.query("SELECT COUNT(*) AS n FROM compute_ledger").get() as { n: number }
    ).n;
    const r = await cli(p, "submit", "analysis.py");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      "Your compute balance is used up. Contact an administrator to ask for more",
    );
    expect(r.stderr).not.toContain("refund");
    expect(r.stdout).toBe("");
    expect(
      (
        w.fx.harness.db
          .query("SELECT COUNT(*) AS n FROM compute_jobs WHERE account_id = ?")
          .get(p.id) as { n: number }
      ).n,
    ).toBe(0);
    expect(
      (w.fx.harness.db.query("SELECT COUNT(*) AS n FROM compute_ledger").get() as { n: number }).n,
    ).toBe(before);
    expect(await w.fx.harness.keys(w.fx.harness.records)).toEqual([]);
    expect(await w.fx.harness.keys(w.fx.harness.results)).toEqual([]);
    expect(w.fx.harness.standin.log.filter((e) => e.method === "PUT")).toEqual([]);
    expect(seen.filter((s) => s.method === "POST" && s.path.endsWith("/finalize"))).toEqual([]);
  }, 60_000);

  test("without compute access: exit 1, the Worker's sentence and the way to ask, no admin hint", async () => {
    const stranger = await newPerson(w, { access: "none" });
    script("analysis.py", HEADER);
    const r = await cli(stranger, "submit", "analysis.py");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Your account does not have compute access.");
    expect(r.stderr).toContain("nemar compute request-access");
    expect(r.stderr).not.toContain("admin privileges");
  }, 60_000);
});

describe("the upload hour and a storage fault", () => {
  test("a finalize after the hour: the Worker's sentence, exit 1, the job failed upload_expired and the hold released", async () => {
    const p = await grantedPerson();
    script("analysis.py", HEADER);
    beforeRequest = async (method, path) => {
      if (method === "POST" && path.endsWith("/finalize")) {
        const id = path.split("/")[3] as string;
        w.fx.harness.db
          .query("UPDATE compute_jobs SET created_at = datetime('now', '-61 minutes') WHERE id = ?")
          .run(id);
        beforeRequest = null;
      }
      return undefined;
    };
    const r = await cli(p, "submit", "analysis.py");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("The upload window closed and the job was ended; submit it again.");
    const row = w.fx.harness.db
      .query("SELECT id, state, failure_code FROM compute_jobs WHERE account_id = ?")
      .get(p.id) as { id: string; state: string; failure_code: string };
    expect([row.state, row.failure_code]).toEqual(["failed", "upload_expired"]);
    expect(ledger(row.id)).toEqual(["hold", "release"]);
  }, 60_000);

  test("a 503 after the hold is retried with the same key and finishes the one job", async () => {
    const p = await grantedPerson();
    script("analysis.py", HEADER);
    let failed = false;
    beforeRequest = async (method, path) => {
      if (!failed && method === "POST" && path === "/compute/jobs") {
        failed = true;
        const real = w.fx.harness.records;
        const broken = new Proxy(real, {
          get(target, prop) {
            if (prop === "put") {
              return async () => {
                throw new Error("the store is down");
              };
            }
            const value = (target as unknown as Record<string | symbol, unknown>)[prop];
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return { ...workerEnv, COMPUTE_RECORDS: broken } as Bindings;
      }
      return undefined;
    };
    const r = await cli(p, "submit", "analysis.py");
    expect(failed).toBe(true);
    expect(r.exitCode).toBe(0);
    const rows = w.fx.harness.db
      .query("SELECT id, state FROM compute_jobs WHERE account_id = ?")
      .all(p.id) as Array<{ id: string; state: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("submitted");
    expect(ledger((rows[0] as { id: string }).id)).toEqual(["hold"]);
    expect(seen.filter((s) => s.method === "POST" && s.path === "/compute/jobs")).toHaveLength(2);
  }, 60_000);
});

describe("Ctrl-C while waiting", () => {
  test("detaches with exit 3 and does NOT cancel the job", async () => {
    const p = await grantedPerson();
    script("analysis.py", HEADER);
    const proc = start(p, ["submit", "analysis.py", "--wait"]);
    // read standard output as it comes until the wait loop has printed the job's state
    const reader = proc.stdout.getReader();
    let text = "";
    const decoder = new TextDecoder();
    const stop = Date.now() + 60_000;
    while (!/\d\d:\d\d:\d\d {2}submitted/.test(text)) {
      if (Date.now() > stop) throw new Error("the CLI never started waiting");
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    proc.kill("SIGINT");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(3);
    expect(stderr).toContain("is still running and was not canceled");
    const row = w.fx.harness.db
      .query("SELECT id, state, cancel_requested_at FROM compute_jobs WHERE account_id = ?")
      .get(p.id) as { id: string; state: string; cancel_requested_at: string | null };
    expect(row.state).toBe("submitted");
    expect(row.cancel_requested_at).toBeNull();
    expect(seen.filter((s) => s.path.endsWith("/cancel"))).toEqual([]);
  }, 90_000);
});

describe("a download whose bytes changed", () => {
  test("is deleted and reported, and the command exits 1", async () => {
    const p = await grantedPerson();
    script("analysis.py", HEADER);
    const proc = start(p, ["submit", "analysis.py", "--wait"]);
    const driver = runToFinished(p.id, [{ path: "report.txt", content: "the report\n" }]);
    await finish(proc);
    const id = await driver;
    await w.fx.harness.results.put(
      resultsOutputKey(id, "report.txt"),
      new TextEncoder().encode("thE report\n"),
    );
    const dir = join(work, "out");
    const r = await cli(p, "results", id, "--download", dir);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("FAILED    report.txt: the size or checksum did not match");
    expect(existsSync(join(dir, "report.txt"))).toBe(false);
    expect(existsSync(join(dir, "report.txt.part"))).toBe(false);
  }, 120_000);
});

describe("logs and cancel of a job that ended", () => {
  test("a job's log is printed as plain text; --tail keeps the end; a job with no log is exit 1", async () => {
    const p = await grantedPerson();
    script("analysis.py", HEADER);
    const proc = start(p, ["submit", "analysis.py"]);
    await finish(proc);
    const { id, uuid } = await submittedJob(p.id);
    const early = await cli(p, "logs", id);
    expect(early.exitCode).toBe(1);
    expect(early.stderr).toContain("The job has no log yet.");
    w.fx.tapis.advance(uuid, "RUNNING");
    await w.fx.tapis.fireWebhook(uuid);
    w.fx.tapis.setOutput(
      uuid,
      "tapisjob.out",
      "line one\nline two\n\u001b[31mred\u001b[0m\nline four\n",
    );
    const log = await cli(p, "logs", id);
    expect(log.exitCode).toBe(0);
    expect(log.stdout).not.toContain("\u001b");
    expect(log.stdout).toContain("line one\nline two\n[31mred[0m\nline four\n");
    const tail = await cli(p, "logs", id, "--tail", "2");
    expect(tail.stdout).toBe("[31mred[0m\nline four\n");
    const asJson = await cli(p, "logs", id, "--json");
    expect(Object.keys(jsonOf(asJson)).sort()).toEqual(["job_id", "text", "truncated"]);
  }, 90_000);

  test("cancel of a job that already ended says so and changes nothing", async () => {
    const p = await grantedPerson();
    script("analysis.py", HEADER);
    const proc = start(p, ["submit", "analysis.py", "--wait"]);
    const driver = runToFinished(p.id, [{ path: "r.txt", content: "r" }]);
    await finish(proc);
    const id = await driver;
    const r = await cli(p, "cancel", id, "--yes");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("had already ended");
    expect(jobRow(w, id).state).toBe("finished");
  }, 120_000);

  test("another person's job is 'No such job.' for logs, results and cancel", async () => {
    const owner = await grantedPerson();
    const other = await grantedPerson();
    script("analysis.py", HEADER);
    await finish(start(owner, ["submit", "analysis.py"]));
    const { id } = await submittedJob(owner.id);
    for (const args of [
      ["logs", id],
      ["results", id],
      ["cancel", id, "--yes"],
    ]) {
      const r = await cli(other, ...args);
      expect([args[0], r.exitCode]).toEqual([args[0], 1]);
      expect(r.stderr).toContain("No such job.");
    }
  }, 90_000);
});

describe("--json is only the Worker's answer", () => {
  test("submit, results, cancel and logs each print one JSON document and nothing else on standard output", async () => {
    const p = await grantedPerson();
    script("analysis.py", HEADER);
    const submitted = await cli(p, "submit", "analysis.py", "--json");
    expect(submitted.exitCode).toBe(0);
    const doc = jsonOf(submitted);
    expect(doc).toMatchObject({
      state: "submitted",
      name: "header-job",
      submitted: true,
      replayed: false,
    });
    expect(JSON.stringify(doc)).not.toContain("X-Amz");
    expect(submitted.stdout).not.toContain("http");
    // sentences went to standard error
    expect(submitted.stderr).toContain("Submitted job_");

    const cancel = jsonOf(await cli(p, "cancel", doc.job_id, "--yes", "--json"));
    expect(cancel).toMatchObject({ ok: true, outcome: "cancel_requested", cancelled: true });

    const refused = await cli(p, "results", doc.job_id, "--json");
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("not in a state");

    // a finished job: results --json carries the Worker's document, links included
    const second = start(p, ["submit", "analysis.py", "--wait", "--json"]);
    const driver = runToFinished(
      p.id,
      [{ path: "report.txt", content: "the report\n" }],
      [doc.job_id],
    );
    const waited = await finish(second);
    const id = await driver;
    expect(waited.exitCode).toBe(0);
    expect(jsonOf(waited)).toMatchObject({ job: { id, state: "finished" } });
    const results = jsonOf(await cli(p, "results", id, "--json"));
    expect(results).toMatchObject({
      bearer_links: true,
      truncated: false,
      next_after: null,
      total: 1,
    });
    expect(results.files[0].sha256).toBe(sha("the report\n"));
    const renewed = jsonOf(await cli(p, "results", id, "--renew", "--json"));
    expect(renewed.files).toHaveLength(1);
  }, 180_000);
});

describe("a bearer link never reaches the debug log", () => {
  test("results --debug writes a log without any signature", async () => {
    const p = await grantedPerson();
    script("analysis.py", HEADER);
    const proc = start(p, ["submit", "analysis.py", "--wait"]);
    const driver = runToFinished(p.id, [{ path: "report.txt", content: "the report\n" }]);
    await finish(proc);
    const id = await driver;
    const r = await finish(start(p, ["results", id], {}, ["--debug"]));
    expect(r.exitCode).toBe(0);
    const logs = readAllText(join(configDir, "logs"));
    expect(logs).toContain("/results");
    expect(logs).toContain("[REDACTED]");
    expect(logs).not.toMatch(/X-Amz-Signature=(?!\[REDACTED\])[0-9a-f]{20,}/i);
    expect(logs).not.toContain(p.key);
  }, 120_000);
});

function readAllText(dir: string): string {
  let out = "";
  const walk = (d: string) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, name.name);
      if (name.isDirectory()) walk(full);
      else out += readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}
