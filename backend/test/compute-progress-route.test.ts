/**
 * `POST /compute/jobs/:id/progress` (ADR 0134 decision 3, epic #2324 phase 2) through the REAL compute
 * router over real migrations: a real `nemar-floor` pipeline job dispatched to the Tapis stand-in, and the
 * token read out of the launch specification Tapis RECEIVED, as the launcher reads it.
 *
 * What is pinned: an accepted report stores rows and the run row and no document; every refusal of the
 * door is the same 404 and writes nothing; a job that is not a dispatched pipeline job on Tapis in an
 * accepted state is `bad_state`; a body over the cap is 413 and a body that breaks the schema or does not
 * fit the recipe is 400, none writing anything; a second report within the floor is 429 with Retry-After and
 * leaves the rows as they were, and one after the floor is stored; of two concurrent reports exactly one is
 * stored; with compute off the route is 503 and writes nothing; a reconciled run accepts nothing; no line a
 * report logs carries the token.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { PROGRESS_FORMAT, type Progress } from "../../shared/contract/compute-progress";
import { submitComputeJob } from "../src/services/compute-lifecycle";
import { dispatchPipelineJob } from "../src/services/compute-pipeline";
import { liveSignalJourneyLinks } from "../src/services/compute-pipeline-progress";
import type { Bindings } from "../src/types/bindings";
import {
  type LifecycleFixture,
  jobTokenSeenByTapis,
  makeJob,
  reread,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import {
  fundPipelines,
  seedEegDataset,
  seedPipelinesAccount,
} from "./helpers/compute-pipeline-fixture";
import { type RoutesHandle, makeRoutesApp, serveRoutes } from "./helpers/compute-routes-app";
import { logged } from "./helpers/logs";

let fx: LifecycleFixture;
let handle: RoutesHandle;
let server: Server;
let env: Bindings;

beforeAll(async () => {
  fx = await startLifecycleFixture();
  handle = makeRoutesApp();
}, 120_000);

beforeEach(async () => {
  await fx.reset();
  server = serveRoutes(handle, () => env);
  env = fx.env({ API_BASE_URL: `http://127.0.0.1:${server.port}` });
  await seedPipelinesAccount(env);
  await fundPipelines(env);
});

afterEach(() => {
  server.stop(true);
});

afterAll(async () => {
  await fx?.dispose();
}, 30_000);

// biome-ignore lint/suspicious/noExplicitAny: bodies and rows are read field by field
type Loose = Record<string, any>;

let seq = 0;

/** A dispatched floor job on Tapis (BIDS input), its token and its stamp. */
async function tapisJob() {
  const datasetId = `nm${String(7000 + ++seq).padStart(6, "0")}`;
  await seedEegDataset(env, datasetId);
  const d = await dispatchPipelineJob(env, {
    recipe: "nemar-floor",
    datasetId,
    actor: { kind: "admin", userId: 1 },
  });
  if (!d.ok) throw new Error(`could not dispatch: ${d.code}`);
  const job = await reread(env, d.jobId);
  const token = jobTokenSeenByTapis(fx, job.tapis_uuid as string);
  const stamp = await env.DB.prepare("SELECT id FROM compute_pipeline_stamps WHERE job_id = ?1")
    .bind(d.jobId)
    .first<{ id: number }>();
  return { jobId: d.jobId, token, datasetId, stampId: stamp?.id as number };
}

const progress = (over: Partial<Progress> = {}): Progress => ({
  format: PROGRESS_FORMAT,
  checkpoint: "import",
  counts: {
    import: { passed: 2, failed: 1, skipped: 0, total: 5 },
    preprocess: { passed: 1, failed: 0, skipped: 1, total: 5 },
    quality: { passed: 0, failed: 0, skipped: 1, total: 5 },
  },
  failures: [{ path: "sub-03/eeg/c.edf", code: "load_failed", step: "load", checkpoint: "import" }],
  ...over,
});

async function report(
  jobId: string,
  init: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Loose; retryAfter: string | null; text: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...init.headers };
  if (init.token !== undefined) headers["X-Compute-Job-Token"] = init.token;
  const res = await handle(
    new Request(`http://api.test/compute/jobs/${jobId}/progress`, {
      method: "POST",
      headers,
      body: init.raw ?? JSON.stringify(init.body ?? progress()),
    }),
    env,
  );
  const text = await res.text();
  let body: Loose = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body, retryAfter: res.headers.get("Retry-After"), text };
}

const progressRows = async (stampId: number) =>
  (
    await env.DB.prepare(
      "SELECT checkpoint, passed, failed, skipped, total FROM compute_pipeline_progress WHERE stamp_id = ?1 ORDER BY checkpoint",
    )
      .bind(stampId)
      .all<Loose>()
  ).results;
const anyRows = async () =>
  (
    await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM compute_pipeline_progress) + (SELECT COUNT(*) FROM compute_pipeline_progress_runs) + (SELECT COUNT(*) FROM compute_pipeline_documents) AS n",
    ).first<{ n: number }>()
  )?.n ?? 0;
const setState = (jobId: string, state: string) =>
  env.DB.prepare("UPDATE compute_jobs SET state = ?1 WHERE id = ?2").bind(state, jobId).run();

describe("an accepted report", () => {
  test("stores the counts and the run row, and no document", async () => {
    const { jobId, token, stampId, datasetId } = await tapisJob();
    const res = await report(jobId, { token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await progressRows(stampId)).toEqual([
      { checkpoint: "import", passed: 2, failed: 1, skipped: 0, total: 5 },
      { checkpoint: "preprocess", passed: 1, failed: 0, skipped: 1, total: 5 },
      { checkpoint: "quality", passed: 0, failed: 0, skipped: 1, total: 5 },
    ]);
    const run = await env.DB.prepare(
      "SELECT * FROM compute_pipeline_progress_runs WHERE stamp_id = ?1",
    )
      .bind(stampId)
      .first<Loose>();
    expect(run).toMatchObject({ job_id: jobId, checkpoint: "import", reports: 1 });
    // Nothing live is a document: the in_progress link is worked out on read.
    const docs = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM compute_pipeline_documents WHERE dataset_id = ?1",
    )
      .bind(datasetId)
      .first<{ n: number }>();
    expect(docs?.n).toBe(0);
    expect(await liveSignalJourneyLinks(env.DB, datasetId)).toMatchObject({
      "nemar-floor": { processing_status: "in_progress" },
    });
  });

  test("is accepted in submitted, queued and running, since D1 lags Tapis (MUTATION: running only)", async () => {
    for (const state of ["submitted", "queued", "running"]) {
      const { jobId, token } = await tapisJob();
      await setState(jobId, state);
      expect((await report(jobId, { token })).status, state).toBe(200);
    }
  });
});

describe("the door", () => {
  test("a wrong token, another job's token, no header, a malformed id and a terminal job are one 404, writing nothing", async () => {
    const a = await tapisJob();
    const b = await tapisJob();
    const refusals = [
      await report(a.jobId, { token: "0".repeat(64) }),
      await report(a.jobId, { token: b.token }),
      await report(a.jobId, {}),
      await report("job_xyz", { token: a.token }),
    ];
    await setState(b.jobId, "finished");
    refusals.push(await report(b.jobId, { token: b.token }));
    for (const r of refusals) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual(refusals[0]?.body as Loose);
    }
    expect(await anyRows()).toBe(0);
  });
});

describe("refusals after the door", () => {
  test("archiving and unreported are bad_state (409) and write nothing", async () => {
    for (const state of ["archiving", "unreported"]) {
      const { jobId, token } = await tapisJob();
      await setState(jobId, state);
      const res = await report(jobId, { token });
      expect([state, res.status, res.body.code]).toEqual([state, 409, "bad_state"]);
    }
    expect(await anyRows()).toBe(0);
  });

  test("a job with no pipeline stamp is bad_state", async () => {
    const made = await makeJob(fx, { env });
    await submitComputeJob(env, made.job.id);
    const job = await reread(env, made.job.id);
    expect(job.tapis_uuid).toBeTruthy();
    const token = jobTokenSeenByTapis(fx, job.tapis_uuid as string);
    const res = await report(made.job.id, { token });
    expect([res.status, res.body.code]).toEqual([409, "bad_state"]);
    expect(await anyRows()).toBe(0);
  });

  test("a body declared or sent over the cap is 413; one that breaks the schema or the recipe is 400; nothing is written", async () => {
    const { jobId, token } = await tapisJob();
    const declared = await report(jobId, {
      token,
      headers: { "Content-Length": "20000" },
      raw: "{}",
    });
    expect(declared.status).toBe(413);
    const sent = await report(jobId, {
      token,
      raw: JSON.stringify({ ...progress(), pad: "x".repeat(17_000) }),
    });
    expect(sent.status).toBe(413);
    for (const bad of [
      { ...progress(), extra: 1 },
      {
        ...progress(),
        counts: {
          ...progress().counts,
          import: { passed: 1, failed: 0, skipped: 0, total: 5, x: 1 },
        },
      },
      { ...progress(), failures: [{ ...progress().failures[0], detail: "x" }] },
      progress({ counts: { import: progress().counts.import } }),
      progress({ checkpoint: "ica" }),
      progress({
        counts: { ...progress().counts, quality: { passed: 0, failed: 0, skipped: 1, total: 6 } },
      }),
    ]) {
      const res = await report(jobId, { token, body: bad });
      expect([res.status, res.body.code]).toEqual([400, "invalid_spec"]);
    }
    expect(await anyRows()).toBe(0);
  });

  test("a database fault reading the stamp is 503 storage_unavailable with a fixed-word log (M3)", async () => {
    const { jobId, token } = await tapisJob();
    // A real fault, not a stand-in: the stamps table is moved away and back.
    await env.DB.prepare("ALTER TABLE compute_pipeline_stamps RENAME TO stamps_away").run();
    let res: Awaited<ReturnType<typeof report>> | undefined;
    const lines = await logged(async () => {
      res = await report(jobId, { token });
    });
    await env.DB.prepare("ALTER TABLE stamps_away RENAME TO compute_pipeline_stamps").run();
    expect([res?.status, res?.body.code]).toEqual([503, "storage_unavailable"]);
    expect(lines.some((l) => l.includes("progress_stamp_read_failed"))).toBe(true);
    for (const line of lines) expect(line).not.toContain(token);
  });

  test("with compute off it is 503 and writes nothing", async () => {
    const { jobId, token } = await tapisJob();
    env = { ...env, COMPUTE_ENABLED: undefined } as Bindings;
    const res = await report(jobId, { token });
    expect([res.status, res.body.code]).toEqual([503, "compute_disabled"]);
    expect(await anyRows()).toBe(0);
  });
});

describe("the rate floor and the gate", () => {
  test("a second report within the floor is 429 with Retry-After and changes nothing; after the floor it is stored (MUTATION: drop the floor)", async () => {
    const { jobId, token, stampId } = await tapisJob();
    expect((await report(jobId, { token })).status).toBe(200);
    const later = progress({
      counts: { ...progress().counts, quality: { passed: 1, failed: 0, skipped: 1, total: 5 } },
    });
    const soon = await report(jobId, { token, body: later });
    expect([soon.status, soon.body.code, soon.retryAfter]).toEqual([429, "report_too_soon", "60"]);
    expect((await progressRows(stampId)).find((r) => r.checkpoint === "quality")?.passed).toBe(0);
    await env.DB.prepare(
      "UPDATE compute_pipeline_progress_runs SET reported_at = datetime('now', '-60 seconds') WHERE stamp_id = ?1",
    )
      .bind(stampId)
      .run();
    expect((await report(jobId, { token, body: later })).status).toBe(200);
    expect((await progressRows(stampId)).find((r) => r.checkpoint === "quality")?.passed).toBe(1);
  });

  test("of two concurrent reports exactly one is stored", async () => {
    const { jobId, token, stampId } = await tapisJob();
    const [x, y] = await Promise.all([report(jobId, { token }), report(jobId, { token })]);
    expect([x.status, y.status].sort()).toEqual([200, 429]);
    const run = await env.DB.prepare(
      "SELECT reports FROM compute_pipeline_progress_runs WHERE stamp_id = ?1",
    )
      .bind(stampId)
      .first<{ reports: number }>();
    expect(run?.reports).toBe(1);
  });

  test("a reconciled run accepts nothing (MUTATION: drop reconciled_at IS NULL from the gate)", async () => {
    const { jobId, token, stampId } = await tapisJob();
    expect((await report(jobId, { token })).status).toBe(200);
    await env.DB.prepare(
      "UPDATE compute_pipeline_progress_runs SET reconciled_at = datetime('now'), outcome = 'reconciled', reported_at = datetime('now', '-120 seconds') WHERE stamp_id = ?1",
    )
      .bind(stampId)
      .run();
    const res = await report(jobId, { token, body: progress({ checkpoint: "quality" }) });
    expect([res.status, res.body.code]).toEqual([409, "bad_state"]);
    const run = await env.DB.prepare(
      "SELECT checkpoint, reports FROM compute_pipeline_progress_runs WHERE stamp_id = ?1",
    )
      .bind(stampId)
      .first<Loose>();
    expect(run).toEqual({ checkpoint: "import", reports: 1 });
  });

  test("no line a report logs carries the token or a recording path", async () => {
    const { jobId, token } = await tapisJob();
    const lines = await logged(async () => {
      await report(jobId, { token });
      await report(jobId, { token });
      await report(jobId, { token: "0".repeat(64) });
    });
    for (const line of lines) {
      expect(line).not.toContain(token);
      expect(line).not.toContain("sub-03");
    }
  });
});
