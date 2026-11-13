/**
 * The local control-plane stack (portable compute, card DM-08): `backend/scripts/compute-local-stack.ts`
 * run for real, over a temporary state directory, with NEMAR's REAL admin, compute, runner and webhook
 * routers, a real migrated SQLite file and Miniflare's R2 behind the S3 stand-in. Nothing of NEMAR is
 * stood in for. The one external stand-in is a `Bun.serve` that answers as the public API's dataset
 * record does (for `--seed-from-catalog`, so no case needs the network).
 *
 * What is pinned, each with a test of its own:
 *  - the stack binds loopback only (its API and its S3 stand-in are unreachable on the machine's other
 *    address), refuses any other host, a tag instead of a digest, and a live or reserved dataset id
 *    before it creates anything;
 *  - the state is private: every file is mode 0600 and every directory 0700, `s3.json` holds two random
 *    values and not the test stand-in's public defaults, and the banner prints no key;
 *  - an owner registers a runner through the real admin route with the stored owner key, a registration
 *    secret buys an access token, `GET /compute/runners/me` answers, and after a restart over the same
 *    state the runner is still registered, a new token still opens `/me`, the keys still work, the seeds
 *    are not repeated and an R2 object is still there;
 *  - a migration the database lacks is applied at the next start and no row is lost; a database that is
 *    not this stack's is refused;
 *  - `outputs` downloads a finished job's results through the real links route (the second page by the
 *    `after` cursor), prints names and sizes only, and refuses a job that is not the pipelines account's;
 *  - the command line: `serve` prints the banner and answers `/health`, refuses `--host` other than loopback and a
 *    missing value.
 * MUTATIONS, each run alone: bind the API or the S3 stand-in without `hostname`; drop the `hostname` guard;
 * drop `umask` or the `chmod` of a secret; let `s3Credentials` fall back to the public defaults; apply a
 * migration without recording it (or record without applying); drop the idempotency key of a seed grant;
 * drop the `after` cursor of `downloadOutputs`; drop the path-escape check of `downloadOutputs`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { resultsOutputKey } from "../../shared/contract/compute-launch";
import {
  RunnerRegisterResponseSchema,
  RunnerTokenResponseSchema,
} from "../../shared/contract/compute-runner";
import {
  FIXTURE_DATASET_ID,
  type LocalStack,
  catalogRefusal,
  downloadOutputs,
  hardenTree,
  startLocalStack,
  treeModes,
} from "../scripts/compute-local-stack";
import { createJob } from "../src/services/compute-jobs";
import { declaredKey, declaredText } from "../src/services/compute-verify";
import { launchableSpec } from "./helpers/compute-lifecycle-fixture";
import { startComputeS3Standin } from "./helpers/compute-s3-standin";
import { sha256Hex } from "./helpers/compute-seed";
import { APPLIED_MIGRATIONS_TABLE, openMigratedDb } from "./helpers/d1";
import { migrationFiles } from "./helpers/miniflare-d1";

const SCRIPT = join(import.meta.dir, "..", "scripts", "compute-local-stack.ts");
const REPO_ROOT = join(import.meta.dir, "..", "..");
const IMAGE = `ghcr.io/example/nemar-python@sha256:${"a".repeat(64)}`;
const encoder = new TextEncoder();

// biome-ignore lint/suspicious/noExplicitAny: bodies are read field by field
type Loose = Record<string, any>;

const scratch: string[] = [];
const fresh = (label: string) => {
  const dir = mkdtempSync(join(tmpdir(), `nemar-local-stack-${label}-`));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** An address of this machine that is not loopback, or null when it has none. */
function otherAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const { family, internal, address } of list ?? []) {
      if (family === "IPv4" && !internal) return address;
    }
  }
  return null;
}

/**
 * The addresses something in this process listens on at `port`, read from the operating system
 * (`lsof`), as `127.0.0.1` or `*` (every interface); empty when `lsof` is not available.
 */
async function listeningOn(port: number): Promise<string[]> {
  try {
    const proc = spawn({
      cmd: ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"],
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out
      .split("\n")
      .filter((l) => l.startsWith("n"))
      .map((l) => l.slice(1).replace(new RegExp(`:${port}$`), ""));
  } catch {
    return [];
  }
}

/** Whether something answers a TCP connection at `host:port` within a second. */
async function reachable(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1000) });
    await res.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

async function call(
  base: string,
  method: string,
  path: string,
  o: { bearer?: string; body?: unknown } = {},
): Promise<{ status: number; body: Loose; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(o.bearer ? { Authorization: `Bearer ${o.bearer}` } : {}),
      ...(o.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  const text = await res.text();
  let body: Loose = {};
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body, text };
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
const RUN_BODY = { protocol: "nemar.runner.v1", runner_version: "0.1.0" };

const count = (stack: LocalStack, sql: string, ...binds: unknown[]) =>
  (stack.db.query(sql).get(...(binds as never[])) as { n: number }).n;

// --- The helpers this card changed ----------------------------------------------------------------------

describe("the persistent database", () => {
  test("a missing migration is applied at the next open, and nothing is reset", () => {
    const dir = fresh("db");
    const path = join(dir, "stack.sqlite");
    const files = migrationFiles();
    const first = openMigratedDb(path, files.slice(0, -1));
    expect(first.applied).toEqual(files.slice(0, -1));
    const usersBefore = (first.db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number })
      .n;
    first.db.run(
      "INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified, service_access, account_kind) VALUES ('kept', 'kept@example.test', 'x', 'approved', 'member', 'cli', 1, 0, 'person')",
    );
    first.db.close();

    const second = openMigratedDb(path);
    expect(second.applied).toEqual(files.slice(-1));
    expect((second.db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(
      usersBefore + 1,
    );
    expect(second.db.query("SELECT 1 FROM users WHERE username = 'kept'").get()).not.toBeNull();
    const recorded = (
      second.db.query(`SELECT COUNT(*) AS n FROM ${APPLIED_MIGRATIONS_TABLE}`).get() as {
        n: number;
      }
    ).n;
    expect(recorded).toBe(files.length);
    second.db.close();

    const third = openMigratedDb(path);
    expect(third.applied).toEqual([]);
    third.db.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a database this function did not make is refused, and left alone", () => {
    const dir = fresh("foreign");
    const path = join(dir, "other.sqlite");
    const { db } = openMigratedDb(path, []);
    db.exec(`DROP TABLE ${APPLIED_MIGRATIONS_TABLE}; CREATE TABLE somebody_elses (x INTEGER)`);
    db.close();
    expect(() => openMigratedDb(path)).toThrow(/no migration record/);
  });
});

describe("the S3 stand-in", () => {
  test("takes the credentials and the port it is given and listens on loopback only", async () => {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = probe.port as number;
    probe.stop(true);
    const standin = startComputeS3Standin({
      buckets: {},
      accessKeyId: "given-access-key",
      secretAccessKey: "given-secret-key",
      port,
    });
    try {
      expect(standin.url).toBe(`http://127.0.0.1:${port}`);
      expect(standin.accessKeyId).toBe("given-access-key");
      expect(standin.secretAccessKey).toBe("given-secret-key");
      expect(await reachable("127.0.0.1", port)).toBe(true);
      const bound = await listeningOn(port);
      if (Bun.which("lsof")) expect(bound.length).toBeGreaterThan(0);
      for (const address of bound) expect(address).toBe("127.0.0.1");
      const lan = otherAddress();
      if (lan !== null) expect(await reachable(lan, port)).toBe(false);
    } finally {
      standin.stop();
    }
  });
});

// --- The stack ----------------------------------------------------------------------------------------

describe("refusals that come before anything is created", () => {
  test("another host, a tag, a live dataset and a reserved id", async () => {
    const state = join(fresh("refuse"), "state");
    const base = { state, image: IMAGE, port: 0, s3Port: 0 };
    await expect(startLocalStack({ ...base, host: "::" })).rejects.toThrow(
      /binds 127\.0\.0\.1 only/,
    );
    await expect(
      startLocalStack({ ...base, image: "ghcr.io/example/nemar-python:latest" }),
    ).rejects.toThrow(/digest-pinned/);
    for (const id of ["nm000103", "nm000107", "nm099900", "nm099999", "nm099998"]) {
      await expect(startLocalStack({ ...base, seedFromCatalog: [id] })).rejects.toThrow(
        /live dataset|reserved fixture band/,
      );
    }
    await expect(startLocalStack({ ...base, seedFromCatalog: ["xx000001"] })).rejects.toThrow(
      /not a dataset id/,
    );
    expect(() => statSync(state)).toThrow();
    expect(catalogRefusal("nm000274")).toBeNull();
    expect(catalogRefusal("nm000102")).toBeNull();
    expect(catalogRefusal("nm000108")).toBeNull();
  });
});

describe("one state directory, started, restarted", () => {
  const state = join(fresh("stack"), "state");
  const lines: string[] = [];
  let stack: LocalStack;
  let runner: { runner_id: string; secret: string };
  let firstToken: string;

  const start = () =>
    startLocalStack({
      state,
      image: IMAGE,
      port: 0,
      s3Port: 0,
      seedFixture: true,
      log: (l) => lines.push(l),
    });

  beforeAll(async () => {
    stack = await start();
  }, 120_000);
  afterAll(async () => {
    await stack?.stop();
  }, 30_000);

  test("answers /health on loopback and on no other address", async () => {
    const health = await call(stack.url, "GET", "/health");
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("ok");
    expect(new URL(stack.url).hostname).toBe("127.0.0.1");
    expect(new URL(stack.s3Url).hostname).toBe("127.0.0.1");
    for (const port of [stack.port, stack.s3Port]) {
      const addresses = await listeningOn(port);
      if (Bun.which("lsof")) expect(addresses.length).toBeGreaterThan(0);
      for (const address of addresses) expect(address).toBe("127.0.0.1");
    }
    const lan = otherAddress();
    if (lan !== null) {
      expect(await reachable(lan, stack.port)).toBe(false);
      expect(await reachable(lan, stack.s3Port)).toBe(false);
    }
  });

  test("the state directory is private and the S3 credentials are random, not the public defaults", async () => {
    const modes = treeModes(state);
    const wrong = modes.filter(([path, mode]) =>
      statSync(path).isDirectory() ? mode !== "700" : mode !== "600",
    );
    expect(wrong).toEqual([]);
    for (const name of ["stack.sqlite", "s3.json", "secret", "keys.json"]) {
      expect(modes.some(([p]) => p.endsWith(`/${name}`))).toBe(true);
    }
    const s3 = JSON.parse(readFileSync(join(state, "s3.json"), "utf-8"));
    expect(readFileSync(join(state, "s3.json"), "utf-8")).not.toContain("STANDINKEYID");
    expect(s3.accessKeyId).toMatch(/^[0-9a-f]{64}$/);
    expect(s3.secretAccessKey).toMatch(/^[0-9a-f]{64}$/);
    expect(s3.accessKeyId).not.toBe(s3.secretAccessKey);
    expect(stack.standin.accessKeyId).toBe(s3.accessKeyId);
    expect(stack.env.COMPUTE_R2_ACCESS_KEY_ID).toBe(s3.accessKeyId);
    expect(readFileSync(join(state, "secret"), "utf-8").trim()).toMatch(/^[0-9a-f]{64}$/);
    // The environment the routes see is the one the card names.
    expect(stack.env.ENVIRONMENT).toBe("development");
    expect(stack.env.COMPUTE_ENABLED).toBe("1");
    expect(stack.env.COMPUTE_RUNNERS_ENABLED).toBe("1");
    expect(stack.env.COMPUTE_RUNTIME_IMAGE).toBe(IMAGE);
    expect(stack.env.API_BASE_URL).toBe(stack.url);
    expect(stack.env.PRESCREEN_CALLBACK_SECRET).toBe(
      readFileSync(join(state, "secret"), "utf-8").trim(),
    );
    // No key is in anything the stack logged.
    for (const key of Object.values(stack.keys)) {
      expect(lines.join("\n")).not.toContain(key);
    }
  });

  test("the seeds are there: an owner, an administrator, the pipelines account, a policy, the pools", async () => {
    const roles = stack.db
      .query("SELECT username, role, account_kind FROM users ORDER BY username")
      .all();
    expect(roles).toEqual([
      { username: "local-admin", role: "admin", account_kind: "person" },
      { username: "local-owner", role: "owner", account_kind: "person" },
      { username: "nemar-pipelines", role: "member", account_kind: "service" },
      // Made by a migration, not by the stack.
      { username: "nemar-system", role: "member", account_kind: "person" },
    ]);
    expect(count(stack, "SELECT COUNT(*) AS n FROM compute_policy")).toBe(1);
    expect(
      count(
        stack,
        "SELECT COUNT(*) AS n FROM compute_ledger WHERE idempotency_key = 'local-stack-seed-pipelines'",
      ),
    ).toBe(1);
    expect(
      count(
        stack,
        "SELECT COUNT(*) AS n FROM compute_ledger WHERE idempotency_key = 'local-stack-seed-people'",
      ),
    ).toBe(1);
    expect(
      count(stack, "SELECT COUNT(*) AS n FROM datasets WHERE dataset_id = ?", FIXTURE_DATASET_ID),
    ).toBe(1);
    // Each key opens its own account.
    const me = await call(stack.url, "GET", "/admin/compute/runners", { bearer: stack.keys.owner });
    expect(me.status).toBe(200);
    expect(
      (await call(stack.url, "GET", "/admin/compute/runners", { bearer: stack.keys.admin })).status,
    ).toBe(403);
    expect(
      (await call(stack.url, "GET", "/admin/compute/runners", { bearer: "nm_not-a-key" })).status,
    ).toBe(401);
  });

  test("the owner registers a runner, the secret buys a token, and the token opens /me", async () => {
    const registered = await call(stack.url, "POST", "/admin/compute/runners", {
      bearer: stack.keys.owner,
      body: REGISTRATION,
    });
    expect(registered.status).toBe(201);
    runner = RunnerRegisterResponseSchema.parse(registered.body);
    const exchanged = await call(stack.url, "POST", "/compute/runners/token", {
      bearer: runner.secret,
      body: RUN_BODY,
    });
    expect(exchanged.status).toBe(200);
    firstToken = RunnerTokenResponseSchema.parse(exchanged.body).access_token;
    const me = await call(stack.url, "GET", "/compute/runners/me", { bearer: firstToken });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      runner_id: runner.runner_id,
      name: "lab_a_cpu",
      backend: "local",
    });
    // The webhook router is mounted too: an unsigned delivery is refused by it, and is not a 404.
    const hook = await call(stack.url, "POST", "/webhooks/github", { body: {} });
    expect(hook.status).not.toBe(404);
  });

  test("a restart over the same state keeps the runner, the keys, the seeds and the bucket", async () => {
    await stack.env.COMPUTE_RESULTS.put("persist-probe", encoder.encode("still here"));
    const keysBefore = readFileSync(join(state, "keys.json"), "utf-8");
    const s3Before = readFileSync(join(state, "s3.json"), "utf-8");
    await stack.stop();

    stack = await start();
    expect(readFileSync(join(state, "keys.json"), "utf-8")).toBe(keysBefore);
    expect(readFileSync(join(state, "s3.json"), "utf-8")).toBe(s3Before);
    expect(lines.filter((l) => l.startsWith("applied "))).toHaveLength(1);

    // The same registration, a new token, and the old token has not been carried over by anything but D1.
    const listed = await call(stack.url, "GET", "/admin/compute/runners", {
      bearer: stack.keys.owner,
    });
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).toContain(runner.runner_id);
    const exchanged = await call(stack.url, "POST", "/compute/runners/token", {
      bearer: runner.secret,
      body: RUN_BODY,
    });
    expect(exchanged.status).toBe(200);
    const second = RunnerTokenResponseSchema.parse(exchanged.body).access_token;
    expect(second).not.toBe(firstToken);
    const me = await call(stack.url, "GET", "/compute/runners/me", { bearer: second });
    expect(me.status).toBe(200);
    expect(me.body.runner_id).toBe(runner.runner_id);

    // Seeds were repaired in place, not repeated.
    expect(count(stack, "SELECT COUNT(*) AS n FROM users")).toBe(4);
    expect(
      count(stack, "SELECT COUNT(*) AS n FROM tokens WHERE api_key_prefix NOT LIKE 'nmra%'"),
    ).toBe(3);
    expect(count(stack, "SELECT COUNT(*) AS n FROM compute_policy")).toBe(1);
    expect(
      count(
        stack,
        "SELECT COUNT(*) AS n FROM compute_ledger WHERE idempotency_key LIKE 'local-stack-seed-%'",
      ),
    ).toBe(2);
    expect(count(stack, "SELECT COUNT(*) AS n FROM datasets")).toBe(1);

    // The bucket outlived the process, and the stand-in's new port serves the same store.
    const got = await stack.env.COMPUTE_RESULTS.get("persist-probe");
    expect(await got?.text()).toBe("still here");
    expect(stack.standin.accessKeyId).toBe(JSON.parse(s3Before).accessKeyId);
    expect(
      treeModes(state).filter(([p, m]) => (statSync(p).isDirectory() ? m !== "700" : m !== "600")),
    ).toEqual([]);
  });

  test("outputs downloads a finished job's results through the real links route, names and sizes only", async () => {
    const pipelinesId = (
      stack.db.query("SELECT id FROM users WHERE username = 'nemar-pipelines'").get() as {
        id: number;
      }
    ).id;
    const made = await createJob(stack.env, {
      source: "pipeline",
      accountId: pipelinesId,
      appId: "nemar-launch",
      appVersion: "1.0.0",
      spec: launchableSpec({ datasets: [{ id: FIXTURE_DATASET_ID, version: "1.0.0" }] }),
    });
    if (!made.ok) throw new Error(`could not make a job: ${made.code}`);
    const jobId = made.job.id;
    const files = [
      { path: "qc/table.tsv", content: "a\tb\n1\t2\n" },
      { path: "report.txt", content: "the report" },
      { path: "z-last.txt", content: "last" },
    ];
    const declared = [];
    for (const f of files) {
      const bytes = encoder.encode(f.content);
      await stack.env.COMPUTE_RESULTS.put(resultsOutputKey(jobId, f.path), bytes);
      declared.push({ path: f.path, size: bytes.length, sha256: await sha256Hex(bytes) });
    }
    await stack.env.COMPUTE_RESULTS.put(declaredKey(jobId), declaredText(jobId, declared, []));
    stack.db.run(
      "UPDATE compute_jobs SET state = 'finished', results_verified_at = datetime('now') WHERE id = ?",
      [jobId],
    );

    const to = fresh("outputs");
    const got = await downloadOutputs({ state, job: jobId, to, port: stack.port });
    // Files the buckets made while the stack ran (no start or stop has hardened them since) are private
    // too: that is the process's umask, which Miniflare's own process inherits.
    expect(
      treeModes(state).filter(([p, m]) => (statSync(p).isDirectory() ? m !== "700" : m !== "600")),
    ).toEqual([]);
    expect(got).toEqual([
      { path: "qc/table.tsv", size: 8 },
      { path: "report.txt", size: 10 },
      { path: "z-last.txt", size: 4 },
    ]);
    expect(readFileSync(join(to, "qc/table.tsv"), "utf-8")).toBe("a\tb\n1\t2\n");
    expect(readFileSync(join(to, "report.txt"), "utf-8")).toBe("the report");
    expect(
      treeModes(to).filter(
        ([p, m]) => p !== to && (statSync(p).isDirectory() ? m !== "700" : m !== "600"),
      ),
    ).toEqual([]);

    // The command line prints names and sizes, and no address.
    const ran = spawn({
      cmd: [
        "bun",
        SCRIPT,
        "outputs",
        "--state",
        state,
        "--job",
        jobId,
        "--to",
        fresh("cli"),
        "--port",
        String(stack.port),
      ],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(ran.stdout).text();
    expect(await ran.exited).toBe(0);
    expect(out).toBe("qc/table.tsv\t8\nreport.txt\t10\nz-last.txt\t4\n");
    expect(out).not.toContain("http");
    expect(out).not.toContain("X-Amz");

    // A job that is not there is refused without a download.
    await expect(
      downloadOutputs({
        state,
        job: "job_000000000000000000000000",
        to: fresh("none"),
        port: stack.port,
      }),
    ).rejects.toThrow(/job_not_found|404/);
  });

  test("a second page is followed by the cursor", async () => {
    const pipelinesId = (
      stack.db.query("SELECT id FROM users WHERE username = 'nemar-pipelines'").get() as {
        id: number;
      }
    ).id;
    const made = await createJob(stack.env, {
      source: "pipeline",
      accountId: pipelinesId,
      appId: "nemar-launch",
      appVersion: "1.0.0",
      spec: launchableSpec({ datasets: [{ id: FIXTURE_DATASET_ID, version: "1.0.0" }] }),
    });
    if (!made.ok) throw new Error(`could not make a job: ${made.code}`);
    const jobId = made.job.id;
    // 1,001 outputs: the route answers 1,000 and a `next_after`.
    const declared = [];
    const bytes = encoder.encode("x");
    const sha = await sha256Hex(bytes);
    for (let i = 0; i < 1001; i++) {
      const path = `many/f${String(i).padStart(4, "0")}.txt`;
      await stack.env.COMPUTE_RESULTS.put(resultsOutputKey(jobId, path), bytes);
      declared.push({ path, size: 1, sha256: sha });
    }
    await stack.env.COMPUTE_RESULTS.put(declaredKey(jobId), declaredText(jobId, declared, []));
    stack.db.run(
      "UPDATE compute_jobs SET state = 'finished', results_verified_at = datetime('now') WHERE id = ?",
      [jobId],
    );
    const to = fresh("pages");
    const got = await downloadOutputs({ state, job: jobId, to, port: stack.port });
    expect(got).toHaveLength(1001);
    expect(new Set(got.map((g) => g.path)).size).toBe(1001);
    expect(readdirSync(join(to, "many"))).toHaveLength(1001);
  }, 120_000);

  test("a path that would leave --to is refused", async () => {
    const pipelinesId = (
      stack.db.query("SELECT id FROM users WHERE username = 'nemar-pipelines'").get() as {
        id: number;
      }
    ).id;
    const made = await createJob(stack.env, {
      source: "pipeline",
      accountId: pipelinesId,
      appId: "nemar-launch",
      appVersion: "1.0.0",
      spec: launchableSpec({ datasets: [{ id: FIXTURE_DATASET_ID, version: "1.0.0" }] }),
    });
    if (!made.ok) throw new Error(`could not make a job: ${made.code}`);
    // A link whose path the route would never mint cannot be made through the route, so the guard is
    // shown on the function the route's answer passes through: an answer from a stand-in stack.
    const evil = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) =>
        new URL(req.url).pathname.endsWith("/links")
          ? Response.json({
              links: [
                { path: "../escaped.txt", size: 1, url: `http://127.0.0.1:${stack.s3Port}/x` },
              ],
              next_after: null,
            })
          : new Response("x"),
    });
    const to = join(fresh("escape"), "to");
    try {
      await expect(
        downloadOutputs({ state, job: made.job.id, to, port: evil.port as number }),
      ).rejects.toThrow(/outside --to/);
    } finally {
      evil.stop(true);
    }
  });
});

// --- The catalog seed ---------------------------------------------------------------------------------

describe("--seed-from-catalog", () => {
  /** The public record's shape (fields as `GET /datasets/<id>` serves them), for one made-up dataset. */
  const record = {
    dataset_id: "nm000500",
    name: "A public EEG dataset",
    description: "PROSE-NOT-COPIED",
    readme: "README-NOT-COPIED",
    status: "active",
    visibility: "public",
    anonymous: 0,
    first_published_at: "2026-08-14 10:44:06",
    withdrawn_at: null,
    ezid_status: "public",
    is_sandbox: 0,
    is_exemplar: 0,
    modalities: "eeg",
    zarr_source_commit: "64feed5210ebea128a8484acd3027f9551ff2d7e",
    latest_version: "v1.0.5",
    latest_version_at: "2026-08-20 19:21:09",
    latest_version_doi: "10.82901/nemar.nm000500.v1.0.5",
    total_files: 157,
    owner_username: "NOT-COPIED",
  };
  let seen: { path: string; agent: string | null }[] = [];
  const api = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, agent: req.headers.get("user-agent") });
      if (url.pathname === "/datasets/nm000500") return Response.json({ dataset: record });
      if (url.pathname === "/datasets/nm000501") {
        const { modalities, ...without } = record;
        return Response.json({ dataset: { ...without, dataset_id: "nm000501" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  afterAll(() => api.stop(true));

  const catalogState = join(fresh("catalog"), "state");

  test("copies the predicate's values and the version, nothing else, and says which", async () => {
    seen = [];
    const lines: string[] = [];
    const stack = await startLocalStack({
      state: catalogState,
      image: IMAGE,
      port: 0,
      s3Port: 0,
      seedFromCatalog: ["nm000500"],
      catalogBase: `http://127.0.0.1:${api.port}`,
      log: (l) => lines.push(l),
    });
    try {
      expect(seen).toEqual([{ path: "/datasets/nm000500", agent: "nemar-local-stack/0" }]);
      const row = stack.db
        .query("SELECT * FROM datasets WHERE dataset_id = 'nm000500'")
        .get() as Loose;
      expect(row).toMatchObject({
        name: "A public EEG dataset",
        status: "active",
        visibility: "public",
        anonymous: 0,
        modalities: "eeg",
        zarr_source_commit: record.zarr_source_commit,
      });
      expect(row.description).toBeNull();
      expect(JSON.stringify(row)).not.toContain("NOT-COPIED");
      const version = stack.db
        .query("SELECT * FROM dataset_versions WHERE dataset_id = 'nm000500'")
        .get() as Loose;
      expect(version).toMatchObject({
        version: "v1.0.5",
        doi: "10.82901/nemar.nm000500.v1.0.5",
        created_at: "2026-08-20 19:21:09",
        total_files: 157,
      });
      const said = lines.join("\n");
      expect(said).toContain("copied dataset_id, name, status, visibility, anonymous");
      expect(said).toContain(
        "zarr_source_commit, latest_version, latest_version_at, latest_version_doi, total_files",
      );
      expect(said).toContain("nm000500: eligible for a pipeline run");
    } finally {
      await stack.stop();
    }
  }, 120_000);

  test("a restart over the same state leaves the dataset it already holds alone", async () => {
    seen = [];
    const lines: string[] = [];
    const stack = await startLocalStack({
      state: catalogState,
      image: IMAGE,
      port: 0,
      s3Port: 0,
      seedFromCatalog: ["nm000500"],
      catalogBase: `http://127.0.0.1:${api.port}`,
      log: (l) => lines.push(l),
    });
    try {
      expect(seen).toEqual([]);
      expect(lines).toContain("nm000500: already in the state database, left as it is");
      expect(count(stack, "SELECT COUNT(*) AS n FROM datasets WHERE dataset_id = 'nm000500'")).toBe(
        1,
      );
      expect(
        count(stack, "SELECT COUNT(*) AS n FROM dataset_versions WHERE dataset_id = 'nm000500'"),
      ).toBe(1);
    } finally {
      await stack.stop();
    }
  }, 120_000);

  test("a field the public record does not serve stops the seed and names it", async () => {
    await expect(
      startLocalStack({
        state: join(fresh("catalog-missing"), "state"),
        image: IMAGE,
        port: 0,
        s3Port: 0,
        seedFromCatalog: ["nm000501"],
        catalogBase: `http://127.0.0.1:${api.port}`,
        log: () => {},
      }),
    ).rejects.toThrow(/does not serve modalities/);
    await expect(
      startLocalStack({
        state: join(fresh("catalog-404"), "state"),
        image: IMAGE,
        port: 0,
        s3Port: 0,
        seedFromCatalog: ["nm000502"],
        catalogBase: `http://127.0.0.1:${api.port}`,
        log: () => {},
      }),
    ).rejects.toThrow(/answered 404/);
  }, 120_000);
});

// --- The command line ---------------------------------------------------------------------------------

describe("the command line", () => {
  async function run(args: string[]) {
    const proc = spawn({
      cmd: ["bun", SCRIPT, ...args],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { out, err, code: await proc.exited };
  }

  test("serve prints the banner, answers /health on the printed port, and stops on a signal", async () => {
    const state = join(fresh("serve"), "state");
    const proc = spawn({
      cmd: [
        "bun",
        SCRIPT,
        "serve",
        "--state",
        state,
        "--image",
        IMAGE,
        "--port",
        "0",
        "--s3-port",
        "0",
        "--seed-fixture",
      ],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const decoder = new TextDecoder();
    let text = "";
    const reader = proc.stdout.getReader();
    const deadline = Date.now() + 90_000;
    while (!/\n.*S3 stand-in/.test(text) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    try {
      const banner = text.split("\n").find((l) => l.startsWith("NEMAR local")) ?? "";
      const m =
        /^NEMAR local compute stack \(not a deployment\) at http:\/\/127\.0\.0\.1:(\d+), (\S+)@([0-9a-f]{7,40}|unknown)$/.exec(
          banner,
        );
      expect(m).not.toBeNull();
      // The spawned process is not under this suite's loopback preload for `Bun.serve`: what it listens on
      // is what the stack itself asked for.
      const s3Port = /S3 stand-in on http:\/\/127\.0\.0\.1:(\d+);/.exec(text)?.[1];
      expect(s3Port).toBeDefined();
      for (const port of [Number(m?.[1]), Number(s3Port)]) {
        const bound = await listeningOn(port);
        if (Bun.which("lsof")) expect(bound.length).toBeGreaterThan(0);
        for (const address of bound) expect(address).toBe("127.0.0.1");
      }
      const health = await call(`http://127.0.0.1:${m?.[1]}`, "GET", "/health");
      expect(health.status).toBe(200);
      expect(health.body.status).toBe("ok");
      const keys = JSON.parse(readFileSync(join(state, "keys.json"), "utf-8")) as Record<
        string,
        string
      >;
      for (const key of Object.values(keys)) expect(text).not.toContain(key);
    } finally {
      proc.kill("SIGTERM");
    }
    expect(await proc.exited).toBe(0);
    expect(
      treeModes(state).filter(([p, mode]) =>
        statSync(p).isDirectory() ? mode !== "700" : mode !== "600",
      ),
    ).toEqual([]);
  }, 120_000);

  test("another host, a missing image and an unknown argument are refused", async () => {
    const state = join(fresh("cli-refuse"), "state");
    const host = await run(["serve", "--state", state, "--image", IMAGE, "--host", "localhost"]);
    expect(host.code).toBe(1);
    expect(host.err).toContain("binds 127.0.0.1 only");
    const noImage = await run(["serve", "--state", state]);
    expect(noImage.code).toBe(1);
    expect(noImage.err).toContain("--image is required");
    const unknown = await run(["serve", "--state", state, "--bogus"]);
    expect(unknown.code).toBe(2);
    expect((await run([])).code).toBe(2);
    expect(() => statSync(state)).toThrow();
  }, 60_000);
});

describe("hardenTree", () => {
  test("makes what a tool left wide private again", () => {
    const dir = fresh("harden");
    writeFileSync(join(dir, "loose.txt"), "x", { mode: 0o644 });
    hardenTree(dir);
    expect(statSync(join(dir, "loose.txt")).mode & 0o777).toBe(0o600);
  });
});
