/**
 * The runner queue through NEMAR's REAL routes (portable compute, card DM-07; ADR 0121 decisions 2, 4 and 6;
 * plan D2, D4 and D6): claim, heartbeat, complete, leases, deadlines, cancels and the settlement of an
 * `accounting = 'none'` job, over a real migrated database (bun:sqlite behind `realD1`, and Miniflare's D1
 * for the races), Miniflare's R2 and the real local S3 interface the presigned PUTs reach.
 *
 * THE RUNNER IS A CLIENT OF THE REAL ROUTES over a real loopback port: it claims, sends heartbeats, uploads
 * its outputs through the bundle-less outputs and complete routes WITH the lease header and its job token,
 * and completes. The only thing played is what a container would write (the launcher's three documents), built
 * from the launch specification the Worker answered, never from a number the Worker stored. NO NEMAR DECISION
 * IS STOOD IN FOR: rows are aged and states are set with SQL the tables accept, where a case is about what
 * the sweep does with a row in that shape.
 *
 * What is pinned, each group with the mutation that kills it named in its tests (the list is in the PR):
 *  (a) the claim: the winner test (50 races on both engines never give a job to two runners), a list of
 *      three, a misfit that is skipped, a dataset made private after dispatch, `runner_outdated`, the
 *      statement's predicates;
 *  (b) a whole run: claim, `started`, outputs through the routes under the lease, `uploading`, `complete`;
 *      finished, digest set, usage set, settled with charge 0, no ledger row, records copied, a repeat
 *      answers the same state, a stale lease is refused;
 *  (c) leases and deadlines: three unstarted expiries, a silent started job, outputs that completed, a
 *      revoked runner's job, a deadline, a cancel that reaches the runner;
 *  (d) security: a claim that outlived a revoke, a demotion or a deletion wins nothing; a cleared lease
 *      refuses the three launcher routes; a cleared nonce is minted again; every state, revoked and expiry of
 *      a cancel-requested job; the statements' text;
 *  (e) lifecycle: records that never landed are replayed, a waiting job's cancel ends in SQL and frees its
 *      tuple and its slot, the records copy, the two attention words, and a cancel-requested `unreported`
 *      row that DM-05's revoke left.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { findRecipe } from "../../shared/compute-recipes";
import { LAUNCHER_FILES } from "../../shared/contract/compute";
import { ComputeStatusResponseSchema } from "../../shared/contract/compute-admin";
import { LaunchSpecSchema, decodeLaunchSpecEnv } from "../../shared/contract/compute-launch";
import {
  RUNNER_LEASE_HEADER,
  RUNNER_PROTOCOL,
  RunnerClaimResponseSchema,
  RunnerCompleteResponseSchema,
  RunnerHeartbeatResponseSchema,
} from "../../shared/contract/compute-runner";
import { adminRoutes } from "../src/routes/admin";
import { computeRoutes } from "../src/routes/compute";
import { computeRunnerRoutes } from "../src/routes/compute-runners";
import { getJob } from "../src/services/compute-jobs";
import { dispatchPipelineJob } from "../src/services/compute-pipeline";
import { recordKey, sha256Hex } from "../src/services/compute-records";
import {
  CLAIM_RUNNER_JOB_SQL,
  claimRunnerJobs,
  runnerVersionAtLeast,
  sweepRunnerLeases,
} from "../src/services/compute-runner-queue";
import {
  type RunnerPrincipal,
  exchangeRunnerSecret,
  registerRunner,
  resolveRunnerAccess,
} from "../src/services/compute-runners";
import type { Bindings, Variables } from "../src/types/bindings";
import { COMPUTE_KEYS, seedComputeUsers } from "./helpers/compute-app";
import {
  type LifecycleFixture,
  RUNTIME_IMAGE_DIGEST,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { seedEegDataset, seedPipelinesAccount } from "./helpers/compute-pipeline-fixture";
import { roundTripD1, seedUser, setPolicy } from "./helpers/compute-seed";

// --- The world ---------------------------------------------------------------------------------------

let fx: LifecycleFixture;
let ids: Record<keyof typeof COMPUTE_KEYS, number>;
let env: Bindings;
let base = "";
let server: ReturnType<typeof Bun.serve>;
const pending: Promise<unknown>[] = [];

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
app.route("/admin", adminRoutes);
app.route("/compute/runners", computeRunnerRoutes);
app.route("/compute", computeRoutes);
const handle = (req: Request, e: Bindings) =>
  app.fetch(req, e, {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext);

/** Wait for everything the routes handed to `waitUntil` (the records copy after a completion). */
const flush = async () => {
  while (pending.length > 0) await pending.shift();
};

beforeAll(async () => {
  fx = await startLifecycleFixture({ withD1: true });
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => handle(req, env),
  });
  base = `http://127.0.0.1:${server.port}`;
}, 120_000);

beforeEach(async () => {
  // What the last case handed to `waitUntil` runs against that case's database: let it end first.
  await flush();
  await fx.reset();
  ids = await seedComputeUsers(fx.harness.db);
  env = fx.env({ COMPUTE_RUNNERS_ENABLED: "1", API_BASE_URL: base });
  await seedPipelinesAccount(env);
});

afterAll(async () => {
  server?.stop(true);
  await fx?.dispose();
}, 30_000);

/** A row or a JSON body read back by a case, whose fields the assertions name. */
// biome-ignore lint/suspicious/noExplicitAny: test rows and bodies are read field by field
type Loose = Record<string, any>;

const sql = (statement: string, ...binds: unknown[]) =>
  env.DB.prepare(statement)
    .bind(...binds)
    .run();
const row = async (id: string) =>
  (await env.DB.prepare("SELECT * FROM compute_jobs WHERE id = ?1")
    .bind(id)
    .first<Loose>()) as Loose;
const count = async (statement: string, ...binds: unknown[]) =>
  (
    await env.DB.prepare(statement)
      .bind(...binds)
      .first<{ n: number }>()
  )?.n ?? 0;

// --- Seeds ---------------------------------------------------------------------------------------------

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
let seq = 0;

/** A public EEG dataset with a ready Zarr serving copy, and its id. */
async function dataset(e: Bindings = env): Promise<string> {
  const id = `nm${String(1000 + ++seq).padStart(6, "0")}`;
  await seedEegDataset(e, id);
  await e.DB.prepare(
    "UPDATE datasets SET zarr_source_commit = ?1, zarr_status = 'ready', zarr_store_count = 3 WHERE dataset_id = ?2",
  )
    .bind(COMMIT, id)
    .run();
  return id;
}

/** A runner job dispatched the way an administrator dispatches one: stamp, job, records. Its id. */
async function dispatch(e: Bindings = env, datasetId?: string): Promise<string> {
  const id = datasetId ?? (await dataset(e));
  const admin = ids?.admin ?? 1;
  const r = await dispatchPipelineJob(e, {
    recipe: "nemar-floor-zarr",
    datasetId: id,
    actor: { kind: "admin", userId: admin },
    executor: "runner",
  });
  if (!r.ok) throw new Error(`could not dispatch: ${r.code}`);
  return r.jobId;
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
} as const;

interface Runner {
  id: string;
  token: string;
  principal: RunnerPrincipal;
}

/** A registered runner with an access token: the owner's registration and the runner's exchange, as production does them. */
async function runner(
  e: Bindings = env,
  over: Record<string, unknown> = {},
  owner: number = ids.owner,
): Promise<Runner> {
  const body = { ...REGISTRATION, name: `runner_${++seq}`, ...over } as Parameters<
    typeof registerRunner
  >[2];
  const { runnerId, secret } = await registerRunner(e.DB, owner, body);
  void secret;
  const issued = await exchangeRunnerSecret(e.DB, runnerId, "0.1.0");
  if (!issued) throw new Error("no token");
  const access = await resolveRunnerAccess(e.DB, issued.accessToken);
  if (access.kind !== "ok") throw new Error("no access");
  return { id: runnerId, token: issued.accessToken, principal: access.runner };
}

interface Reply {
  status: number;
  body: Loose;
}

async function post(path: string, token: string | null, body: unknown): Promise<Reply> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Loose = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed };
}

const CLAIM = (free_slots: number, over: Record<string, unknown> = {}) => ({
  protocol: RUNNER_PROTOCOL,
  free_slots,
  runtimes: ["docker"],
  arch: "amd64",
  runner_version: "0.1.0",
  ...over,
});

const claim = (r: Runner, n = 1, over: Record<string, unknown> = {}) =>
  post("/compute/runners/claim", r.token, CLAIM(n, over));
const heartbeat = (r: Runner, job_id: string, lease_id: string, phase: "started" | "uploading") =>
  post("/compute/runners/heartbeat", r.token, { job_id, lease_id, phase });
const complete = (
  r: Runner,
  job_id: string,
  lease_id: string,
  over: Record<string, unknown> = {},
) =>
  post("/compute/runners/complete", r.token, {
    job_id,
    lease_id,
    exit_number: 0,
    launcher_failure_code: null,
    launcher_detail: null,
    usage: { wall_seconds: 120, cpu_seconds: 400, max_rss_mb: 2048 },
    usage_partial: false,
    scratch_discarded: true,
    ...over,
  });

type Claimed = { id: string; lease_id: string; launch_spec_env: string; lease_expires_at: string };

/** Claim one job and return its entry (and fail the case if the answer is not one entry). */
async function claimOne(r: Runner): Promise<Claimed> {
  const res = await claim(r, 1);
  expect(res.status).toBe(200);
  const parsed = RunnerClaimResponseSchema.parse(res.body);
  expect(parsed.jobs).toHaveLength(1);
  return parsed.jobs[0] as unknown as Claimed;
}

/** A job dispatched and claimed, and the runner that holds it. */
async function claimed(over: Record<string, unknown> = {}) {
  const r = await runner(env, over);
  const jobId = await dispatch();
  const entry = await claimOne(r);
  expect(entry.id).toBe(jobId);
  return { r, jobId, entry };
}

const sha = async (text: string) => sha256Hex(new TextEncoder().encode(text));

interface Uploaded {
  outputs: number;
  puts: number[];
  complete: number;
}

/**
 * What the runner's launcher does with the routes, from the launch specification the Worker answered: the
 * outputs call, the presigned PUTs, the complete call. `lease` is the `X-Compute-Lease` value sent (null: no
 * header). Never asserts: a refusal is a status the case reads.
 */
async function uploadAs(
  entry: Claimed,
  o: { lease?: string | null; files?: Array<{ path: string; content: string }> } = {},
): Promise<Uploaded> {
  const decoded = decodeLaunchSpecEnv(entry.launch_spec_env);
  if (!decoded.ok) throw new Error("the launcher would refuse the launch specification");
  const spec = LaunchSpecSchema.parse(JSON.parse(decoded.text));
  const files = o.files ?? [{ path: "report.txt", content: "the report" }];
  const enc = new TextEncoder();
  const launcherText: Record<string, string> = {
    [LAUNCHER_FILES.result]: JSON.stringify({
      job_id: entry.id,
      failure_code: null,
      detail: null,
      exit_number: 0,
      entry_exit_code: 0,
    }),
    [LAUNCHER_FILES.provenance]: JSON.stringify({
      job_id: entry.id,
      // What the launcher hashed: the text it decoded, never a number the Worker stored.
      launch_spec_digest: await sha(decoded.text),
      bundle_digest: null,
      image: { uri: spec.image.uri, digest: RUNTIME_IMAGE_DIGEST },
      runtime_version: "queue-test 1.0",
      staging: [],
      timings: { run: 1 },
      slurm_job_id: null,
      entry_exit_code: 0,
    }),
    [LAUNCHER_FILES.manifest]: JSON.stringify({
      job_id: entry.id,
      files: await Promise.all(
        files.map(async (f) => ({
          path: f.path,
          size: enc.encode(f.content).length,
          sha256: await sha(f.content),
        })),
      ),
    }),
    [LAUNCHER_FILES.log]: "launcher log line\n",
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Compute-Job-Token": spec.job_token,
  };
  const lease = o.lease === undefined ? entry.lease_id : o.lease;
  if (lease !== null) headers[RUNNER_LEASE_HEADER] = lease;
  const outputsRes = await fetch(`${spec.api_base}/compute/jobs/${entry.id}/outputs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      outputs: await Promise.all(
        files.map(async (f) => ({
          path: f.path,
          size: enc.encode(f.content).length,
          sha256: await sha(f.content),
        })),
      ),
      launcher: Object.values(LAUNCHER_FILES).map((name) => ({
        name,
        size: enc.encode(launcherText[name] as string).length,
      })),
    }),
  });
  const result: Uploaded = { outputs: outputsRes.status, puts: [], complete: 0 };
  if (outputsRes.status === 200) {
    const { uploads } = (await outputsRes.json()) as {
      uploads: Array<{ path: string; url: string }>;
    };
    for (const u of uploads) {
      const content = u.path.startsWith("outputs/")
        ? (files.find((f) => `outputs/${f.path}` === u.path)?.content as string)
        : (launcherText[u.path.replace("launcher/", "")] as string);
      const put = await fetch(u.url, { method: "PUT", body: enc.encode(content) });
      result.puts.push(put.status);
    }
  } else {
    await outputsRes.text();
  }
  const completeRes = await fetch(`${spec.api_base}/compute/jobs/${entry.id}/outputs/complete`, {
    method: "POST",
    headers,
  });
  result.complete = completeRes.status;
  await completeRes.text();
  return result;
}

const age = (id: string, column: string, modifier: string) =>
  sql(`UPDATE compute_jobs SET ${column} = datetime('now', ?2) WHERE id = ?1`, id, modifier);

/** The admin routes, as an owner or an administrator. */
async function admin(
  method: "GET" | "POST",
  path: string,
  who: "owner" | "admin" = "admin",
  body?: unknown,
) {
  const res = await handle(
    new Request(`http://api.test/admin${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${COMPUTE_KEYS[who]}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  const text = await res.text();
  let parsed: Loose = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed };
}

const revokeRunner = (id: string) => admin("POST", `/compute/runners/${id}/revoke`, "owner", {});

/** A real bucket that fails its next `n` writes, as an outage of the store would. */
const failing = (n: number): R2Bucket => {
  let left = n;
  const real = fx.harness.records;
  return {
    put: async (key: string, value: unknown, options?: unknown) => {
      if (left-- > 0) throw new Error("the store is down");
      return real.put(key, value as ArrayBuffer, options as Parameters<R2Bucket["put"]>[2]);
    },
    get: (key: string) => real.get(key),
    head: (key: string) => real.head(key),
    delete: (key: string) => real.delete(key),
    list: (o?: Parameters<R2Bucket["list"]>[0]) => real.list(o),
  } as unknown as R2Bucket;
};

// --- (a) The claim -----------------------------------------------------------------------------------------

describe("the claim", () => {
  test("answers the lease, the specification and the image, and records the claim (MUTATION: drop the launch digest write)", async () => {
    const r = await runner();
    const jobId = await dispatch();
    const res = await claim(r, 1);
    expect(res.status).toBe(200);
    const parsed = RunnerClaimResponseSchema.parse(res.body);
    expect(parsed.min_runner_version).toBe("0.1.0");
    expect(parsed.jobs).toHaveLength(1);
    const entry = parsed.jobs[0] as unknown as Claimed & {
      image: { digest: string };
      cores: number;
      memory_mb: number;
      minutes: number;
    };
    expect(entry).toMatchObject({ id: jobId, cores: 4, memory_mb: 16384, minutes: 120 });
    expect(entry.image.digest).toBe(RUNTIME_IMAGE_DIGEST);
    const job = await row(jobId);
    expect(job).toMatchObject({
      state: "created",
      runner_id: r.id,
      runner_backend: "local",
      lease_id: entry.lease_id,
      claim_attempts: 1,
      executor: "runner",
      accounting: "none",
    });
    expect(job.runner_claimed_at).not.toBeNull();
    expect(job.lease_expires_at).not.toBeNull();
    // The digest is the SHA-256 of the specification TEXT the runner decodes from what it was answered.
    const decoded = decodeLaunchSpecEnv(entry.launch_spec_env);
    expect(decoded.ok).toBe(true);
    expect(job.launch_spec_digest).toBe(await sha((decoded as { text: string }).text));
    // Nothing waits for the same runner any more.
    expect(RunnerClaimResponseSchema.parse((await claim(r, 1)).body).jobs).toHaveLength(0);
  });

  test("a claim for three slots with three fitting jobs answers three distinct jobs with three distinct leases", async () => {
    const r = await runner();
    const wanted = [await dispatch(), await dispatch(), await dispatch()];
    // `created_at` has one-second resolution: make the order they were made in a fact of the rows.
    for (const [i, id] of wanted.entries()) await age(id, "created_at", `-${3 - i} minutes`);
    const res = await claim(r, 3);
    const jobs = RunnerClaimResponseSchema.parse(res.body).jobs as unknown as Claimed[];
    expect(new Set(jobs.map((j) => j.id))).toEqual(new Set(wanted));
    expect(new Set(jobs.map((j) => j.lease_id)).size).toBe(3);
    // The oldest first: the order they were made in.
    expect(jobs.map((j) => j.id)).toEqual(wanted);
  });

  test("a job the runner cannot hold is not claimed, and does not block a newer one that fits (MUTATION: drop the cores term)", async () => {
    const small = await runner(env, { cores: 2 });
    const big = await runner();
    const jobId = await dispatch();
    expect(RunnerClaimResponseSchema.parse((await claim(small, 1)).body).jobs).toHaveLength(0);
    expect((await row(jobId)).runner_id).toBeNull();
    expect((await claimOne(big)).id).toBe(jobId);
    // A memory misfit and a GPU misfit likewise.
    const lean = await runner(env, { memory_mb: 1000 });
    await dispatch();
    expect(RunnerClaimResponseSchema.parse((await claim(lean, 1)).body).jobs).toHaveLength(0);
  });

  test("a runner of another pool claims nothing", async () => {
    const gpu = await runner(env, { pool: "gpu", gpus: 1 });
    await dispatch();
    expect(RunnerClaimResponseSchema.parse((await claim(gpu, 1)).body).jobs).toHaveLength(0);
  });

  test("a dataset made private after dispatch is not claimed, and is again once it is public (MUTATION: drop the eligibility term)", async () => {
    const r = await runner();
    const id = await dataset();
    const jobId = await dispatch(env, id);
    await sql("UPDATE datasets SET visibility = 'private' WHERE dataset_id = ?1", id);
    expect(RunnerClaimResponseSchema.parse((await claim(r, 1)).body).jobs).toHaveLength(0);
    expect((await row(jobId)).runner_id).toBeNull();
    await sql("UPDATE datasets SET visibility = 'public' WHERE dataset_id = ?1", id);
    expect((await claimOne(r)).id).toBe(jobId);
  });

  test("a job whose cancel is recorded, or whose claims are used up, is not claimed", async () => {
    const r = await runner();
    const a = await dispatch();
    const b = await dispatch();
    await sql("UPDATE compute_jobs SET cancel_requested_at = datetime('now') WHERE id = ?1", a);
    await sql("UPDATE compute_jobs SET claim_attempts = 3 WHERE id = ?1", b);
    expect(RunnerClaimResponseSchema.parse((await claim(r, 2)).body).jobs).toHaveLength(0);
  });

  test("an outdated runner is refused runner_outdated before anything is claimed; another protocol is its own word; a bad body is invalid_body", async () => {
    const r = await runner();
    await dispatch();
    const old = await claim(r, 1, { runner_version: "0.0.9" });
    expect([old.status, old.body.error]).toEqual([426, "runner_outdated"]);
    const other = await post(
      "/compute/runners/claim",
      r.token,
      CLAIM(1, { protocol: "nemar.runner.v2" }),
    );
    expect([other.status, other.body.error]).toEqual([426, "protocol_unsupported"]);
    const bad = await post("/compute/runners/claim", r.token, CLAIM(0));
    expect([bad.status, bad.body.error]).toEqual([400, "invalid_body"]);
    const extra = await post("/compute/runners/claim", r.token, { ...CLAIM(1), surprise: 1 });
    expect([extra.status, extra.body.error]).toEqual([400, "invalid_body"]);
    expect(await count("SELECT COUNT(*) AS n FROM compute_jobs WHERE runner_id IS NOT NULL")).toBe(
      0,
    );
    const none = await post("/compute/runners/claim", null, CLAIM(1));
    expect([none.status, none.body.error]).toEqual([401, "runner_unknown"]);
  });

  test("the version rule: at least 0.1.0, a pre-release below its release", () => {
    expect(runnerVersionAtLeast("0.1.0")).toBe(true);
    expect(runnerVersionAtLeast("0.1.1")).toBe(true);
    expect(runnerVersionAtLeast("1.0.0")).toBe(true);
    expect(runnerVersionAtLeast("0.0.9")).toBe(false);
    expect(runnerVersionAtLeast("0.1.0-rc1")).toBe(false);
    expect(runnerVersionAtLeast("0.2.0-rc1")).toBe(true);
    expect(runnerVersionAtLeast("not a version")).toBe(false);
  });

  test("the statement carries every predicate, literally (MUTATION: delete any one)", () => {
    const s = CLAIM_RUNNER_JOB_SQL;
    for (const term of [
      "executor = 'runner'",
      "accounting = 'none'",
      "state = 'created'",
      "runner_claimed_at IS NULL",
      "records_written_at IS NOT NULL",
      "cancel_requested_at IS NULL",
      "claim_attempts < ?5",
      "cores_per_node <= ?7",
      "COALESCE(j.memory_mb, 0) <= ?8",
      "gpus <= ?9",
      "FROM compute_runners r JOIN users u ON u.id = r.registered_by",
      "r.revoked_at IS NULL",
      "u.role = 'owner' AND u.status = 'approved' AND u.deleted_at IS NULL",
      "d.visibility = 'public'",
      "d.anonymous = 0",
      "ORDER BY j.created_at ASC",
    ]) {
      expect(s).toContain(term);
    }
  });
});

// --- The race ---------------------------------------------------------------------------------------------------

describe("two runners racing for one job", () => {
  const worlds = () => [
    {
      name: "bun:sqlite",
      d1: fx.env().DB,
      racing: (e: Bindings) => ({ ...e, DB: roundTripD1(e.DB) }),
    },
    { name: "Miniflare D1", d1: fx.harness.d1 as D1Database, racing: (e: Bindings) => e },
  ];
  for (const which of [0, 1]) {
    test(`50 rounds never give a job to both [${which === 0 ? "bun:sqlite" : "Miniflare D1"}] (MUTATION: drop runner_claimed_at IS NULL from the claim)`, async () => {
      const w = worlds()[which] as ReturnType<typeof worlds>[number];
      const e = fx.env({ DB: w.d1, COMPUTE_RUNNERS_ENABLED: "1", API_BASE_URL: base });
      if (which === 1) {
        await seedPipelinesAccount(e, { reuse: true });
      }
      const owner = which === 0 ? ids.owner : await seedUser(w.d1, { role: "owner" });
      const a = await runner(e, {}, owner);
      const b = await runner(e, {}, owner);
      const racing = w.racing(e);
      let rounds = 0;
      for (let i = 0; i < 50; i++) {
        const jobId = await dispatch(e);
        const [x, y] = await Promise.all([
          claimRunnerJobs(racing, a.principal, 1),
          claimRunnerJobs(racing, b.principal, 1),
        ]);
        expect(x.jobs.length + y.jobs.length).toBe(1);
        const job = (await getJob(e.DB, jobId)) as NonNullable<Awaited<ReturnType<typeof getJob>>>;
        expect(job.claim_attempts).toBe(1);
        expect([a.id, b.id]).toContain(job.runner_id as string);
        const winner = x.jobs.length === 1 ? x.jobs[0] : y.jobs[0];
        expect(job.lease_id).toBe(winner?.lease_id as string);
        rounds++;
      }
      expect(rounds).toBe(50);
    }, 240_000);
  }
});

// --- (b) A whole run ----------------------------------------------------------------------------------------------

describe("one job's whole run through the routes", () => {
  test("claim, started, outputs under the lease, uploading, complete: finished, settled with charge 0, no ledger, records copied (MUTATION: write a ledger row, or drop settled_final_at from the stamp)", async () => {
    const r = await runner();
    const jobId = await dispatch();
    const entry = await claimOne(r);
    const beat = await heartbeat(r, jobId, entry.lease_id, "started");
    expect(beat.status).toBe(200);
    expect(RunnerHeartbeatResponseSchema.parse(beat.body).cancel).toBe(false);
    expect(await row(jobId)).toMatchObject({ state: "running" });
    expect((await row(jobId)).started_at).not.toBeNull();

    const up = await uploadAs(entry);
    expect(up.outputs).toBe(200);
    expect(up.puts.every((s) => s === 200)).toBe(true);
    expect(up.complete).toBe(200);
    expect((await row(jobId)).outputs_completed_at).not.toBeNull();

    expect((await heartbeat(r, jobId, entry.lease_id, "uploading")).status).toBe(200);
    expect(await row(jobId)).toMatchObject({ state: "archiving" });

    const done = await complete(r, jobId, entry.lease_id);
    expect(done.status).toBe(200);
    expect(RunnerCompleteResponseSchema.parse(done.body).state).toBe("finished");
    await flush();

    const job = await row(jobId);
    expect(job).toMatchObject({
      state: "finished",
      failure_code: null,
      charged_milli: 0,
      held_milli: 0,
      runner_wall_seconds: 120,
      runner_cpu_seconds: 400,
      runner_max_rss_mb: 2048,
      executor: "runner",
      accounting: "none",
      lease_id: entry.lease_id,
    });
    expect(job.launch_spec_digest).not.toBeNull();
    expect(job.results_verified_at).not.toBeNull();
    expect(job.settled_provisional_at).not.toBeNull();
    expect(job.settled_final_at).not.toBeNull();
    expect(job.ended_at).not.toBeNull();
    expect(job.result_records_at).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM compute_ledger WHERE job_id = ?1", jobId)).toBe(
      0,
    );
    expect(await fx.harness.records.head(recordKey(jobId, "result.json"))).not.toBeNull();
    expect(await fx.harness.records.head(recordKey(jobId, "provenance.json"))).not.toBeNull();

    // A repeat answers the same state and writes nothing; a different usage is not taken.
    const again = await complete(r, jobId, entry.lease_id, {
      usage: { wall_seconds: 9, cpu_seconds: 9, max_rss_mb: 9 },
    });
    expect(again.status).toBe(200);
    expect(again.body.state).toBe("finished");
    expect(await row(jobId)).toMatchObject({ runner_wall_seconds: 120, ended_at: job.ended_at });
    // The lease is kept, so a heartbeat on a terminal job is lease_lost.
    const late = await heartbeat(r, jobId, entry.lease_id, "uploading");
    expect([late.status, late.body.error]).toEqual([409, "lease_lost"]);
  });

  test("a stale lease's outputs and complete are refused: a lease the sweep released and another runner replaced (MUTATION: drop the lease header check)", async () => {
    const a = await runner();
    const b = await runner();
    const jobId = await dispatch();
    const first = await claimOne(a);
    await age(jobId, "lease_expires_at", "-1 minute");
    await sweepRunnerLeases(env);
    expect((await row(jobId)).runner_id).toBeNull();
    const second = await claimOne(b);
    expect(second.lease_id).not.toBe(first.lease_id);
    expect(await row(jobId)).toMatchObject({ claim_attempts: 2, runner_id: b.id });

    // The first runner's lease: outputs, outputs-complete, heartbeat and complete are all refused.
    const stale = await uploadAs(first, { lease: first.lease_id });
    expect(stale.outputs).toBe(404);
    expect(stale.complete).toBe(404);
    expect((await heartbeat(a, jobId, first.lease_id, "started")).body.error).toBe("lease_lost");
    const late = await complete(a, jobId, first.lease_id);
    expect([late.status, late.body.error]).toEqual([409, "lease_lost"]);
    expect((await row(jobId)).state).toBe("created");
    // The second runner's lease is the one that works, with the first claim's token (the token is the job's).
    const ok = await uploadAs(second);
    expect(ok.outputs).toBe(200);
  });

  test("a failure the runner reports without launcher documents: its declared code and detail, the code its exit number names, or runner_lost", async () => {
    const reports: Array<[Record<string, unknown>, string, string | null]> = [
      [
        {
          exit_number: 13,
          launcher_failure_code: "runtime_error",
          launcher_detail: "entry_failed",
        },
        "runtime_error",
        "entry_failed",
      ],
      // A detail not declared for its code is not used; the exit number names the code.
      [
        { exit_number: 13, launcher_failure_code: "runtime_error", launcher_detail: "made_up" },
        "runtime_error",
        null,
      ],
      [{ exit_number: 15, launcher_failure_code: null, launcher_detail: null }, "time_limit", null],
      [
        { exit_number: 99, launcher_failure_code: null, launcher_detail: null },
        "runner_lost",
        "lease_expired",
      ],
    ];
    for (const [over, code, detail] of reports) {
      const { r, jobId, entry } = await claimed();
      const res = await complete(r, jobId, entry.lease_id, over);
      expect(res.body.state).toBe("failed");
      await flush();
      const job = await row(jobId);
      expect([job.failure_code, job.failure_detail]).toEqual([code, detail]);
      expect(job).toMatchObject({ charged_milli: 0 });
      expect(job.settled_final_at).not.toBeNull();
      expect(await count("SELECT COUNT(*) AS n FROM compute_ledger WHERE job_id = ?1", jobId)).toBe(
        0,
      );
    }
  });

  test("a lease that is not the job's, a job of another runner and a job nobody made are all lease_lost, on heartbeat and complete (MUTATION: drop the lease compare of complete)", async () => {
    const { r, jobId, entry } = await claimed();
    const other = await runner();
    const wrong = "ab".repeat(16);
    for (const phase of ["started", "uploading"] as const) {
      const beat = await heartbeat(r, jobId, wrong, phase);
      expect([beat.status, beat.body.error]).toEqual([409, "lease_lost"]);
      expect((await heartbeat(other, jobId, entry.lease_id, phase)).body.error).toBe("lease_lost");
      expect((await heartbeat(r, `job_${"0".repeat(24)}`, wrong, phase)).body.error).toBe(
        "lease_lost",
      );
    }
    for (const [who, lease] of [
      [r, wrong],
      [other, entry.lease_id],
    ] as const) {
      const res = await complete(who, jobId, lease);
      expect([res.status, res.body.error]).toEqual([409, "lease_lost"]);
    }
    expect(await row(jobId)).toMatchObject({ state: "created", runner_wall_seconds: null });
  });

  test("the usage is written once per job (MUTATION: drop the IS NULL term)", async () => {
    const { r, jobId, entry } = await claimed();
    await sql("UPDATE compute_jobs SET runner_wall_seconds = 5 WHERE id = ?1", jobId);
    expect((await complete(r, jobId, entry.lease_id, { exit_number: 13 })).body.state).toBe(
      "failed",
    );
    expect((await row(jobId)).runner_wall_seconds).toBe(5);
  });

  test("an exit of 0 with no outputs completed fails verification (result_upload_failed, not_completed)", async () => {
    const { r, jobId, entry } = await claimed();
    const res = await complete(r, jobId, entry.lease_id);
    expect(res.body.state).toBe("failed");
    expect(await row(jobId)).toMatchObject({
      failure_code: "result_upload_failed",
      failure_detail: "not_completed",
    });
  });

  test("two completions at once end the job once (acceptance is at most once)", async () => {
    const { r, jobId, entry } = await claimed();
    await heartbeat(r, jobId, entry.lease_id, "started");
    await uploadAs(entry);
    const racing = [complete(r, jobId, entry.lease_id), complete(r, jobId, entry.lease_id)];
    const answers = await Promise.all(racing);
    expect(answers.map((a) => a.body.state)).toEqual(["finished", "finished"]);
    await flush();
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM compute_jobs WHERE id = ?1 AND state = 'finished'",
        jobId,
      ),
    ).toBe(1);
  });
});

// --- (c) Leases, deadlines and cancels -----------------------------------------------------------------------------------

describe("leases and deadlines", () => {
  test("three unstarted expiries release the claim twice and then fail claims_exhausted (MUTATION: claim_attempts >= to > in the exhausted rows)", async () => {
    const r = await runner();
    const jobId = await dispatch();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const entry = await claimOne(r);
      expect(entry.id).toBe(jobId);
      expect((await row(jobId)).claim_attempts).toBe(attempt);
      await age(jobId, "lease_expires_at", "-1 minute");
      await sweepRunnerLeases(env);
      if (attempt < 3) {
        expect(await row(jobId)).toMatchObject({
          state: "created",
          runner_id: null,
          lease_id: null,
        });
      }
    }
    const job = await row(jobId);
    expect(job).toMatchObject({
      state: "failed",
      failure_code: "runner_lost",
      failure_detail: "claims_exhausted",
      platform_failure: 1,
      charged_milli: 0,
    });
    expect(job.settled_final_at).not.toBeNull();
  });

  test("a job whose last claim a revoke gave back is failed claims_exhausted too, not left waiting for ever", async () => {
    const r = await runner();
    const jobId = await dispatch();
    await claimOne(r);
    await sql("UPDATE compute_jobs SET claim_attempts = 3 WHERE id = ?1", jobId);
    expect((await revokeRunner(r.id)).status).toBe(200);
    expect(await row(jobId)).toMatchObject({ state: "created", runner_id: null });
    await sweepRunnerLeases(env);
    expect(await row(jobId)).toMatchObject({ state: "failed", failure_detail: "claims_exhausted" });
  });

  test("a silent started job goes unreported keeping its lease, then fails lease_expired after the give-up wait (MUTATION: unreport on a current lease)", async () => {
    const { r, jobId, entry } = await claimed();
    await heartbeat(r, jobId, entry.lease_id, "started");
    // A lease that is still current changes nothing.
    await sweepRunnerLeases(env);
    expect((await row(jobId)).state).toBe("running");
    await age(jobId, "lease_expires_at", "-1 minute");
    await sweepRunnerLeases(env);
    expect(await row(jobId)).toMatchObject({ state: "unreported", lease_id: entry.lease_id });
    // Not yet: the give-up wait is 60 minutes.
    await sweepRunnerLeases(env);
    expect((await row(jobId)).state).toBe("unreported");
    await age(jobId, "lease_expires_at", "-61 minutes");
    await sweepRunnerLeases(env);
    expect(await row(jobId)).toMatchObject({
      state: "failed",
      failure_code: "runner_lost",
      failure_detail: "lease_expired",
      charged_milli: 0,
    });
  });

  test("a heartbeat renews an unreported job's lease, so a runner that is still alive is not given up on (MUTATION: renew only live-state rows other than unreported)", async () => {
    const { r, jobId, entry } = await claimed();
    await heartbeat(r, jobId, entry.lease_id, "started");
    await age(jobId, "lease_expires_at", "-1 minute");
    await sweepRunnerLeases(env);
    expect(await row(jobId)).toMatchObject({ state: "unreported", lease_id: entry.lease_id });
    // The runner was only partitioned: its next heartbeat is accepted and renews the lease.
    const beat = await heartbeat(r, jobId, entry.lease_id, "uploading");
    expect(beat.status).toBe(200);
    // Past the give-up wait since the ORIGINAL expiry, but the lease was renewed, so it is not given up on.
    await sweepRunnerLeases(env);
    expect((await row(jobId)).state).toBe("unreported");
    await age(jobId, "lease_expires_at", "-61 minutes");
    await sweepRunnerLeases(env);
    expect(await row(jobId)).toMatchObject({ state: "failed", failure_detail: "lease_expired" });
  });

  test("a job whose outputs completed is verified to finished when its runner goes silent (MUTATION: fail it instead)", async () => {
    const { r, jobId, entry } = await claimed();
    await heartbeat(r, jobId, entry.lease_id, "started");
    expect((await uploadAs(entry)).complete).toBe(200);
    await age(jobId, "lease_expires_at", "-1 minute");
    await sweepRunnerLeases(env);
    const job = await row(jobId);
    expect(job).toMatchObject({ state: "finished", charged_milli: 0, failure_code: null });
    expect(job.results_verified_at).not.toBeNull();
    expect(job.settled_final_at).not.toBeNull();
    // The copy of its files followed in the same call.
    expect(job.result_records_at).not.toBeNull();
  });

  test("a revoked runner's started job without completed outputs fails runner_revoked on the next sweep; one whose outputs completed is verified (MUTATION: wait the give-up minutes)", async () => {
    const r = await runner();
    const silent = await dispatch();
    const loaded = await dispatch();
    await age(silent, "created_at", "-2 minutes");
    await age(loaded, "created_at", "-1 minutes");
    const [s, l] = RunnerClaimResponseSchema.parse((await claim(r, 2)).body)
      .jobs as unknown as Claimed[];
    expect([s?.id, l?.id]).toEqual([silent, loaded]);
    for (const e of [s, l] as Claimed[]) await heartbeat(r, e.id, e.lease_id, "started");
    expect((await uploadAs(l as Claimed)).complete).toBe(200);

    const revoked = await revokeRunner(r.id);
    expect(revoked.status).toBe(200);
    for (const id of [silent, loaded]) {
      expect(await row(id)).toMatchObject({
        state: "unreported",
        lease_id: null,
        lease_expires_at: null,
        runner_id: r.id,
      });
    }
    // The dead runner's lease can no longer land anything.
    expect((await uploadAs(s as Claimed)).outputs).toBe(404);

    await sweepRunnerLeases(env);
    expect(await row(silent)).toMatchObject({
      state: "failed",
      failure_code: "runner_lost",
      failure_detail: "runner_revoked",
    });
    const verified = await row(loaded);
    expect(verified).toMatchObject({ state: "finished", failure_code: null });
    expect(verified.results_verified_at).not.toBeNull();
  });

  test("runner_revoked is written nowhere but the queue (a source search)", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name);
        if (e.isDirectory()) walk(path);
        else if (e.name.endsWith(".ts")) {
          // Code lines only: a comment may name the word.
          const code = readFileSync(path, "utf8")
            .split("\n")
            .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
            .join("\n");
          if (/["'`]runner_revoked["'`]/.test(code))
            hits.push(path.replace(/^.*backend\/src\//, ""));
        }
      }
    };
    walk(join(import.meta.dir, "../src"));
    expect(hits).toEqual(["services/compute-runner-queue.ts"]);
  });

  test("a started job past its minutes plus the grace fails deadline_exceeded, even with its lease current (MUTATION: drop the grace)", async () => {
    const { r, jobId, entry } = await claimed();
    await heartbeat(r, jobId, entry.lease_id, "started");
    // 120 minutes plus 15: not yet at 134, past at 136.
    await age(jobId, "started_at", "-134 minutes");
    await sweepRunnerLeases(env);
    expect((await row(jobId)).state).toBe("running");
    await age(jobId, "started_at", "-136 minutes");
    await sweepRunnerLeases(env);
    expect(await row(jobId)).toMatchObject({
      state: "failed",
      failure_code: "runner_lost",
      failure_detail: "deadline_exceeded",
    });
  });

  test("a cancel reaches the runner on its heartbeat and the job ends cancelled; a started heartbeat cannot walk it back (MUTATION: drop the cancel guard of the started write)", async () => {
    const { r, jobId, entry } = await claimed();
    const cancelled = await admin("POST", `/compute/jobs/${jobId}/cancel`);
    expect(cancelled.status).toBe(200);
    // A claimed job keeps the intent; nothing ended it.
    expect(cancelled.body.job.state).toBe("created");
    const beat = await heartbeat(r, jobId, entry.lease_id, "started");
    expect(RunnerHeartbeatResponseSchema.parse(beat.body).cancel).toBe(true);
    expect((await row(jobId)).state).toBe("created");
    const done = await complete(r, jobId, entry.lease_id, { exit_number: 143 });
    expect(done.body.state).toBe("cancelled");
    await flush();
    const job = await row(jobId);
    expect(job).toMatchObject({ state: "cancelled", cancel_reason: "admin", charged_milli: 0 });
    expect(job.settled_final_at).not.toBeNull();
    expect(job.result_records_at).not.toBeNull();
  });
});

// --- (d) Security -----------------------------------------------------------------------------------------------------------

describe("a claim that outlived the runner's standing wins nothing", () => {
  test("a runner context captured before a revoke admits nothing after the revoke committed (MUTATION: drop the revoked_at term)", async () => {
    const r = await runner();
    const jobId = await dispatch();
    expect((await revokeRunner(r.id)).status).toBe(200);
    const claimedNow = await claimRunnerJobs(env, r.principal, 3);
    expect(claimedNow.jobs).toEqual([]);
    expect(await row(jobId)).toMatchObject({
      runner_id: null,
      claim_attempts: 0,
      state: "created",
    });
  });

  test("so does one whose registering owner was demoted, or deleted (MUTATION: drop the owner standing term)", async () => {
    const jobId = await dispatch();
    for (const change of [
      "UPDATE users SET role = 'admin' WHERE id = ?1",
      "UPDATE users SET deleted_at = datetime('now') WHERE id = ?1",
      "UPDATE users SET status = 'revoked' WHERE id = ?1",
    ]) {
      const owner = await seedUser(env.DB, { role: "owner" });
      const r = await runner(env, {}, owner);
      await sql(change, owner);
      expect((await claimRunnerJobs(env, r.principal, 3)).jobs).toEqual([]);
    }
    expect(await row(jobId)).toMatchObject({ runner_id: null, claim_attempts: 0 });
  });
});

describe("the launcher routes of a runner job need the current lease", () => {
  test("with the row's lease_id NULL, bundle, outputs and outputs-complete are refused, with no header and with a well-formed one (MUTATION: compare (header ?? null) === lease_id)", async () => {
    const { jobId, entry } = await claimed();
    await sql("UPDATE compute_jobs SET lease_id = NULL WHERE id = ?1", jobId);
    const decoded = decodeLaunchSpecEnv(entry.launch_spec_env) as { text: string };
    const spec = LaunchSpecSchema.parse(JSON.parse(decoded.text));
    for (const lease of [null, entry.lease_id, "0".repeat(32)]) {
      for (const path of ["bundle", "outputs", "outputs/complete"]) {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "X-Compute-Job-Token": spec.job_token,
        };
        if (lease !== null) headers[RUNNER_LEASE_HEADER] = lease;
        const res = await fetch(`${base}/compute/jobs/${jobId}/${path}`, {
          method: "POST",
          headers,
          body: path === "outputs" ? JSON.stringify({ outputs: [], launcher: [] }) : undefined,
        });
        expect([lease, path, res.status]).toEqual([lease, path, 404]);
        expect((await res.json()) as { code: string }).toMatchObject({ code: "job_not_found" });
      }
    }
  });

  test("a missing or malformed header is refused while the lease is set, and the right one is accepted", async () => {
    const { entry } = await claimed();
    expect((await uploadAs(entry, { lease: null })).outputs).toBe(404);
    expect((await uploadAs(entry, { lease: "XYZ" })).outputs).toBe(404);
    expect((await uploadAs(entry, { lease: entry.lease_id.toUpperCase() })).outputs).toBe(404);
    expect((await uploadAs(entry)).outputs).toBe(200);
  });

  test("a claimed job whose webhook nonce was cleared gets a fresh one, and its job token works (MUTATION: drop the COALESCE)", async () => {
    const r = await runner();
    const jobId = await dispatch();
    await sql("UPDATE compute_jobs SET webhook_nonce = NULL WHERE id = ?1", jobId);
    const entry = await claimOne(r);
    expect((await row(jobId)).webhook_nonce).not.toBeNull();
    expect((await uploadAs(entry)).outputs).toBe(200);
  });

  test("a Tapis job's launcher routes do not look at a lease header", async () => {
    // The lease check is for `executor = 'runner'` only: the Tapis callbacks suite pins the Tapis path, and
    // a runner job's check is the only branch that reads the header (a source search).
    const src = readFileSync(
      join(import.meta.dir, "../src/routes/callbacks/compute-job-callbacks.ts"),
      "utf8",
    );
    expect(src).toContain('job.executor === "runner" && !holdsCurrentLease(c, job)');
  });
});

describe("no cancel-requested runner job stays live unless its lease is current", () => {
  const STATES = ["created", "running", "archiving", "unreported"] as const;
  for (const state of STATES) {
    for (const revoked of [false, true]) {
      for (const expired of [false, true]) {
        test(`${state}, runner revoked ${revoked}, lease expired ${expired} (MUTATION: drop the expiry term of the cancelled rows)`, async () => {
          const { r, jobId, entry } = await claimed();
          if (state !== "created") {
            await sql(
              "UPDATE compute_jobs SET state = ?2, started_at = datetime('now', '-5 minutes') WHERE id = ?1",
              jobId,
              state,
            );
          }
          await admin("POST", `/compute/jobs/${jobId}/cancel`);
          expect((await row(jobId)).cancel_requested_at).not.toBeNull();
          if (revoked) {
            await sql(
              "UPDATE compute_runners SET revoked_at = datetime('now'), revoke_reason = 'owner_revoked' WHERE id = ?1",
              r.id,
            );
          }
          if (expired) await age(jobId, "lease_expires_at", "-1 minute");
          await sweepRunnerLeases(env);
          const after = await row(jobId);
          if (!revoked && !expired) {
            expect(["created", "running", "archiving", "unreported"]).toContain(after.state);
            expect(after.state).toBe(state);
          } else {
            expect(after.state).toBe("cancelled");
            expect(after.settled_final_at).not.toBeNull();
            expect(after.charged_milli).toBe(0);
          }
          void entry;
        });
      }
    }
  }
});

describe("the statements' text (a source search)", () => {
  const src = readFileSync(
    join(import.meta.dir, "../src/services/compute-runner-queue.ts"),
    "utf8",
  );
  const literals = [...src.matchAll(/`([^`]*)`/g)].map((m) => m[1] as string);

  test("every statement that writes a live state to a runner job carries cancel_requested_at IS NULL (MUTATION: drop it from one)", () => {
    const writers = literals.filter((t) => {
      if (!/^\s*UPDATE compute_jobs\b/.test(t)) return false;
      const set = /\bSET\b([\s\S]*?)\bWHERE\b/.exec(t)?.[1] ?? "";
      return /\bstate\s*=\s*'(running|archiving|unreported)'/.test(set);
    });
    // Three: the started write, the uploading write, and the move to unreported.
    expect(writers).toHaveLength(3);
    for (const w of writers) expect(w).toContain("cancel_requested_at IS NULL");
  });

  test("the claim statement contains the compute_runners revoked_at IS NULL predicate", () => {
    expect(CLAIM_RUNNER_JOB_SQL).toMatch(/FROM compute_runners r[\s\S]*r\.revoked_at IS NULL/);
  });
});

// --- (e) Lifecycle ------------------------------------------------------------------------------------------------------------

describe("records that never landed", () => {
  test("a runner job created with recordsWritten false is not claimed; after the replay sweep the next claim admits it (MUTATION: skip the replay)", async () => {
    const r = await runner();
    const bad = fx.env({
      COMPUTE_RUNNERS_ENABLED: "1",
      API_BASE_URL: base,
      COMPUTE_RECORDS: failing(2),
    });
    const id = await dataset();
    const made = await dispatchPipelineJob(bad, {
      recipe: "nemar-floor-zarr",
      datasetId: id,
      actor: { kind: "admin", userId: ids.admin },
      executor: "runner",
    });
    expect(made.ok && made.recordsWritten).toBe(false);
    const jobId = (made as { jobId: string }).jobId;
    expect((await row(jobId)).records_written_at).toBeNull();
    expect(RunnerClaimResponseSchema.parse((await claim(r, 1)).body).jobs).toHaveLength(0);

    // Too young to replay: the dispatch's own retry is not over.
    await sweepRunnerLeases(env);
    expect((await row(jobId)).records_written_at).toBeNull();
    await age(jobId, "created_at", "-6 minutes");
    const swept = await sweepRunnerLeases(env);
    expect(swept.replayed).toBe(1);
    expect((await row(jobId)).records_written_at).not.toBeNull();
    expect((await claimOne(r)).id).toBe(jobId);
  });

  test("a row whose specification cannot be rebuilt as the recorded digest is left alone, not written with another", async () => {
    const bad = fx.env({
      COMPUTE_RUNNERS_ENABLED: "1",
      API_BASE_URL: base,
      COMPUTE_RECORDS: failing(2),
    });
    const id = await dataset();
    const made = await dispatchPipelineJob(bad, {
      recipe: "nemar-floor-zarr",
      datasetId: id,
      actor: { kind: "admin", userId: ids.admin },
      executor: "runner",
    });
    const jobId = (made as { jobId: string }).jobId;
    await age(jobId, "created_at", "-6 minutes");
    // The dataset's recorded commit changed since: the rebuilt text is another text.
    await sql(
      "UPDATE datasets SET zarr_source_commit = ?1 WHERE dataset_id = ?2",
      "f".repeat(40),
      id,
    );
    const swept = await sweepRunnerLeases(env);
    expect(swept.replayed).toBe(0);
    expect((await row(jobId)).records_written_at).toBeNull();
    expect(await fx.harness.records.head(recordKey(jobId, "spec.json"))).toBeNull();
  });
});

describe("the cancel of a waiting runner job", () => {
  test("ends in SQL: cancelled, settled with charge 0, the slot and the tuple freed (MUTATION: drop the stamp end, or the settled stamp)", async () => {
    const owner = ids.owner;
    await setPolicy(env.DB, owner, { runners: { maxLiveJobs: { cpu: 1, gpu: 8 } } });
    const id = await dataset();
    const first = await dispatch(env, id);
    // The cap is full: a second job is refused.
    const second = await dispatchPipelineJob(env, {
      recipe: "nemar-floor-zarr",
      datasetId: await dataset(),
      actor: { kind: "admin", userId: ids.admin },
      executor: "runner",
    });
    expect(second).toMatchObject({ ok: false, code: "over_concurrency" });
    // The tuple is held: the same dataset again is a live attempt.
    const again = await dispatchPipelineJob(env, {
      recipe: "nemar-floor-zarr",
      datasetId: id,
      actor: { kind: "admin", userId: ids.admin },
      executor: "runner",
    });
    expect(again).toMatchObject({ ok: false, code: "live_attempt_exists" });

    const res = await admin("POST", `/compute/jobs/${first}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.job).toMatchObject({ state: "cancelled", settled: true, charged_milli: 0 });
    const job = await row(first);
    expect(job).toMatchObject({ state: "cancelled", cancel_reason: "admin", charged_milli: 0 });
    expect(job.settled_provisional_at).not.toBeNull();
    expect(job.settled_final_at).not.toBeNull();
    expect(job.ended_at).not.toBeNull();
    expect(job.retention_until).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM compute_ledger WHERE job_id = ?1", first)).toBe(
      0,
    );
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM compute_pipeline_stamps WHERE job_id = ?1 AND state = 'dispatched'",
        first,
      ),
    ).toBe(0);

    // The slot is free: a second runner job fits; the tuple is free: a new dispatch of it succeeds.
    const fits = await dispatchPipelineJob(env, {
      recipe: "nemar-floor-zarr",
      datasetId: id,
      actor: { kind: "admin", userId: ids.admin },
      executor: "runner",
    });
    expect(fits.ok).toBe(true);
    // And the person's route says the same for a job that is already over.
    const replay = await admin("POST", `/compute/jobs/${first}/cancel`);
    expect(replay.body.outcome).toBe("already_cancelled");
  });

  test("a claim that won first keeps the intent: nothing ends the job from under its runner", async () => {
    const { r, jobId, entry } = await claimed();
    const res = await admin("POST", `/compute/jobs/${jobId}/cancel`);
    expect(res.body.job.state).toBe("created");
    expect((await row(jobId)).cancel_requested_at).not.toBeNull();
    expect(
      RunnerHeartbeatResponseSchema.parse(
        (await heartbeat(r, jobId, entry.lease_id, "started")).body,
      ).cancel,
    ).toBe(true);
  });

  test("an unclaimed job whose cancel was recorded and never carried out is ended by the sweep", async () => {
    const jobId = await dispatch();
    await sql(
      "UPDATE compute_jobs SET cancel_requested_at = datetime('now'), cancel_reason = 'user' WHERE id = ?1",
      jobId,
    );
    await sweepRunnerLeases(env);
    expect(await row(jobId)).toMatchObject({ state: "cancelled", cancel_reason: "user" });
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM compute_pipeline_stamps WHERE job_id = ?1 AND state = 'dispatched'",
        jobId,
      ),
    ).toBe(0);
  });

  test("an unreported row DM-05's revoke left (runner set, lease and expiry NULL) with a cancel ends cancelled on one sweep", async () => {
    const { jobId } = await claimed();
    await sql(
      `UPDATE compute_jobs SET state = 'unreported', lease_id = NULL, lease_expires_at = NULL,
              started_at = datetime('now', '-3 minutes'), cancel_requested_at = datetime('now') WHERE id = ?1`,
      jobId,
    );
    const swept = await sweepRunnerLeases(env);
    expect(swept.cancelled).toBe(1);
    expect(await row(jobId)).toMatchObject({ state: "cancelled", charged_milli: 0 });
  });
});

describe("the records copy of a runner job", () => {
  test("complete copies the records; one whose first copy failed is copied by the sweep (MUTATION: drop the sweep's copy step)", async () => {
    const r = await runner();
    const jobId = await dispatch();
    const entry = await claimOne(r);
    await heartbeat(r, jobId, entry.lease_id, "started");
    expect((await uploadAs(entry)).complete).toBe(200);
    // The store is down for the completion's copy: the answer still says finished.
    const saved = env;
    env = fx.env({ COMPUTE_RUNNERS_ENABLED: "1", API_BASE_URL: base });
    const down = failing(1000);
    env = { ...env, COMPUTE_RECORDS: down };
    const done = await complete(r, jobId, entry.lease_id);
    expect(done.body.state).toBe("finished");
    await flush();
    expect((await row(jobId)).result_records_at).toBeNull();
    env = saved;
    const swept = await sweepRunnerLeases(env);
    expect(swept.copied).toBe(1);
    expect((await row(jobId)).result_records_at).not.toBeNull();
    expect(await fx.harness.records.head(recordKey(jobId, "result.json"))).not.toBeNull();
  });
});

describe("the two attention words", () => {
  test("GET /admin/compute/status counts a live runner row cancelled 61 minutes ago and a terminal row left uncopied past the window (MUTATION: drop the executor term)", async () => {
    const { jobId } = await claimed();
    await sql(
      "UPDATE compute_jobs SET cancel_requested_at = datetime('now', '-61 minutes') WHERE id = ?1",
      jobId,
    );
    const other = await dispatch();
    await sql(
      `UPDATE compute_jobs SET state = 'finished', settled_provisional_at = datetime('now'),
              settled_final_at = datetime('now'), ended_at = datetime('now', '-4 days'),
              results_verified_at = datetime('now'), outputs_completed_at = datetime('now') WHERE id = ?1`,
      other,
    );
    const res = await admin("GET", "/compute/status");
    expect(res.status).toBe(200);
    expect(ComputeStatusResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.attention).toMatchObject({
      runner_cancel_pending_failed: 1,
      runner_copy_abandoned: 1,
      cancel_pending_failed: 0,
      copy_abandoned: 0,
    });
  });

  test("a cancel 59 minutes old and a terminal row inside the window are not counted", async () => {
    const { jobId } = await claimed();
    await sql(
      "UPDATE compute_jobs SET cancel_requested_at = datetime('now', '-59 minutes') WHERE id = ?1",
      jobId,
    );
    const other = await dispatch();
    await sql(
      `UPDATE compute_jobs SET state = 'finished', settled_provisional_at = datetime('now'),
              settled_final_at = datetime('now'), ended_at = datetime('now', '-2 days') WHERE id = ?1`,
      other,
    );
    const res = await admin("GET", "/compute/status");
    expect(res.body.attention).toMatchObject({
      runner_cancel_pending_failed: 0,
      runner_copy_abandoned: 0,
    });
  });
});

describe("the recipe of a runner job is the recipe's", () => {
  test("the registry entry the queue relies on", () => {
    expect(findRecipe("nemar-floor-zarr")?.executors).toEqual(["runner"]);
  });
});
