/**
 * Staging the serving index for a run of the archive (ADR 0141, epic #2324 phase B2b), over a real migrated
 * database, Miniflare's R2 through the Worker's own bindings and the real local S3 interface the presigned
 * addresses are signed for, with a real loopback server standing in for the two EXTERNAL services (GitHub's tag
 * lookup, and the serving copy's `index.json`). It says:
 *
 *  (a) the index is staged only when its own `source_commit` is exactly the tag's commit: the exact bytes are
 *      kept under their SHA-256, and the size and digest are the bytes';
 *  (b) an index of another commit is refused, and so is one that differs from the tag by metadata only (the
 *      Zarr input's `metadata_only` allowance is never asked for: no compare is requested);
 *  (c) every other failure is a word, and none refuses the run;
 *  (d) nemar-ica's archive job carries the index's path and the tag's commit, and records the digest or the word;
 *  (e) the launch specification carries a staged index, and nothing of an absent one;
 *  (f) the serving index route signs the copy the RECORDED specification names, and refuses every other job
 *      with the one answer of the launcher's door.
 *
 * nemar-ica stays a placeholder (no path dispatches it), so the dispatch is exercised through the functions it
 * calls, in its order: `stageServingIndex`, `recipeJobSpec`, `createJob`, `buildLaunch`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  RECIPE_SERVING_INDEX_FLAG,
  RECIPE_SOURCE_COMMIT_FLAG,
  findRecipe,
  recipeArguments,
} from "../../shared/compute-recipes";
import {
  COMPUTE_SERVING_INDEX_MAX_BYTES,
  PIPELINES_TAPIS_OWNER,
} from "../../shared/contract/compute";
import {
  SERVING_INDEX_CONTAINER_PATH,
  decodeLaunchSpecEnv,
} from "../../shared/contract/compute-launch";
import { createJob } from "../src/services/compute-jobs";
import { buildLaunch } from "../src/services/compute-lifecycle";
import { recipeJobSpec } from "../src/services/compute-pipeline";
import { servingIndexKey } from "../src/services/compute-records";
import { signComputeToken } from "../src/services/compute-tokens";
import { __resetInstallationTokenCacheForTests } from "../src/services/github-auth";
import { stageServingIndex } from "../src/services/serving-index-staging";
import type { Bindings } from "../src/types/bindings";
import {
  CALLBACK_SECRET,
  type LifecycleFixture,
  RUNTIME_IMAGE,
  RUNTIME_IMAGE_DIGEST,
  reread,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { fundPipelines, seedPipelinesAccount } from "./helpers/compute-pipeline-fixture";
import { makeRoutesApp } from "./helpers/compute-routes-app";
import {
  type GithubCompareStandin,
  startGithubCompareStandin,
} from "./helpers/github-compare-standin";

let fx: LifecycleFixture;
let github: GithubCompareStandin;
const handle = makeRoutesApp();
const seams = globalThis as { NEMAR_GITHUB_API_URL?: string; NEMAR_ZARR_INDEX_BASE?: string };
const previousSeams = { github: seams.NEMAR_GITHUB_API_URL, index: seams.NEMAR_ZARR_INDEX_BASE };

beforeAll(async () => {
  fx = await startLifecycleFixture();
  github = startGithubCompareStandin();
  seams.NEMAR_GITHUB_API_URL = github.url;
  seams.NEMAR_ZARR_INDEX_BASE = github.indexBase;
}, 120_000);

beforeEach(async () => {
  github.reset();
  __resetInstallationTokenCacheForTests();
  await fx.reset();
});

afterAll(async () => {
  github?.stop();
  seams.NEMAR_GITHUB_API_URL = previousSeams.github;
  seams.NEMAR_ZARR_INDEX_BASE = previousSeams.index;
  await fx?.dispose();
}, 30_000);

/** `development`: the index seam is honored and GitHub is read without the App only outside production. */
const devEnv = (over: Partial<Bindings> = {}): Bindings =>
  fx.env({ ENVIRONMENT: "development", ...over });

const T = "0123456789abcdef0123456789abcdef01234567";
const S = "89abcdef0123456789abcdef0123456789abcdef";
const ID = "nm000104";
const TAG = "v1.0.0";
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** An index as the converter writes it, as TEXT: the digest is over these exact bytes. */
const indexText = (commit: unknown) =>
  `${JSON.stringify(
    {
      format_version: 3,
      dataset_id: ID,
      source_commit: commit,
      store_count: 1,
      stores: [{ path: "sub-01/eeg/sub-01_task-rest_eeg.zarr", source_path: "sub-01/eeg/x.set" }],
    },
    null,
    2,
  )}\n`;

async function servingCopies(): Promise<string[]> {
  const listed = await fx.harness.records.list({ prefix: "serving-index/" });
  return listed.objects.map((o) => o.key);
}

const compareRequests = () => github.log.filter((r) => r.path.includes("/compare/"));

// --- (a) and (b): the commit must match exactly --------------------------------------------------------

describe("the index is staged only when it was built from the tag's own commit", () => {
  test("an index of the tag's commit is kept byte for byte under its SHA-256, with its size", async () => {
    const text = indexText(T);
    github.tag(ID, TAG, T);
    github.index(ID, text);
    const staged = await stageServingIndex(devEnv(), ID, TAG);
    const bytes = new TextEncoder().encode(text);
    expect(staged).toEqual({
      staged: true,
      sha256: sha(bytes),
      size: bytes.length,
      sourceCommit: T,
    });
    const kept = await fx.harness.records.get(servingIndexKey(sha(bytes)));
    expect(new Uint8Array(await (kept as R2ObjectBody).arrayBuffer())).toEqual(bytes);
    // The tag is looked up as a tag; no compare is ever asked.
    expect(github.log.some((r) => r.path.endsWith(`/commits/refs/tags/${TAG}`))).toBe(true);
    expect(compareRequests()).toEqual([]);
  });

  test("an index of another commit is not staged, and nothing is kept (MUTATION: accept any commit)", async () => {
    github.tag(ID, TAG, T);
    github.index(ID, indexText(S));
    expect(await stageServingIndex(devEnv(), ID, TAG)).toEqual({
      staged: false,
      reason: "source_commit_differs",
    });
    expect(await servingCopies()).toEqual([]);
  });

  test("an index that differs from the tag by metadata only is refused too: metadata_only is never asked (MUTATION: fall back to checkZarrSource's allowance)", async () => {
    github.tag(ID, TAG, T);
    github.index(ID, indexText(S));
    // What GitHub would answer: S is ahead of T by a metadata path only, which the Zarr input accepts.
    github.compare(ID, T, S, {
      status: "ahead",
      behind_by: 0,
      ahead_by: 1,
      files: [{ filename: ".nemar/zarr.json", status: "modified" }],
    });
    expect(await stageServingIndex(devEnv(), ID, TAG)).toEqual({
      staged: false,
      reason: "source_commit_differs",
    });
    expect(compareRequests()).toEqual([]);
    expect(await servingCopies()).toEqual([]);
  });

  test("a tag without its leading v is found as the Zarr check finds it", async () => {
    github.tag(ID, "1.0.0", T);
    github.index(ID, indexText(T));
    expect((await stageServingIndex(devEnv(), ID, TAG)).staged).toBe(true);
  });
});

// --- (c): every other failure is a word ------------------------------------------------------------------

describe("anything else stages nothing, with a word, and never throws", () => {
  const cases: Array<[string, () => void, string]> = [
    ["no index", () => github.tag(ID, TAG, T), "no_index"],
    [
      "an index the copy cannot serve",
      () => {
        github.tag(ID, TAG, T);
        github.index(ID, { http: 500 });
      },
      "index_unreadable",
    ],
    [
      "an index that is not JSON",
      () => {
        github.tag(ID, TAG, T);
        github.index(ID, "{not json");
      },
      "index_unreadable",
    ],
    [
      "an index that is a JSON array",
      () => {
        github.tag(ID, TAG, T);
        github.index(ID, "[]");
      },
      "index_unreadable",
    ],
    [
      "an index without a commit",
      () => {
        github.tag(ID, TAG, T);
        github.index(ID, indexText(null));
      },
      "index_commit_unusable",
    ],
    [
      "an index with an abbreviated commit",
      () => {
        github.tag(ID, TAG, T);
        github.index(ID, indexText(T.slice(0, 12)));
      },
      "index_commit_unusable",
    ],
    ["a tag GitHub does not have", () => github.index(ID, indexText(T)), "tag_absent"],
    [
      "a tag GitHub cannot answer",
      () => {
        github.tag(ID, TAG, { http: 502 });
        github.index(ID, indexText(T));
      },
      "github_unreadable",
    ],
  ];
  for (const [label, arrange, reason] of cases) {
    test(`${label}: ${reason}`, async () => {
      arrange();
      expect(await stageServingIndex(devEnv(), ID, TAG)).toEqual({ staged: false, reason });
      expect(await servingCopies()).toEqual([]);
    });
  }

  test("an index over the recipe's 64 MiB is not read past its bound (MUTATION: drop the bound)", async () => {
    github.tag(ID, TAG, T);
    github.index(ID, { stream: " ".repeat(COMPUTE_SERVING_INDEX_MAX_BYTES + 1) });
    expect(await stageServingIndex(devEnv(), ID, TAG)).toEqual({
      staged: false,
      reason: "index_too_large",
    });
  });

  test("production without the GitHub App asks nothing and stages nothing", async () => {
    github.tag(ID, TAG, T);
    github.index(ID, indexText(T));
    expect(await stageServingIndex(fx.env(), ID, TAG)).toEqual({
      staged: false,
      reason: "no_github_credentials",
    });
    expect(github.log).toEqual([]);
  });

  test("a key that holds other bytes is never overwritten, and nothing is staged (MUTATION: keep whatever is there)", async () => {
    const text = indexText(T);
    github.tag(ID, TAG, T);
    github.index(ID, text);
    await fx.harness.records.put(servingIndexKey(sha(text)), "other bytes");
    expect(await stageServingIndex(devEnv(), ID, TAG)).toEqual({
      staged: false,
      reason: "index_not_stored",
    });
    const kept = await fx.harness.records.get(servingIndexKey(sha(text)));
    expect(await (kept as R2ObjectBody).text()).toBe("other bytes");
  });

  test("a copy already kept with the same bytes is staged again, as one object", async () => {
    github.tag(ID, TAG, T);
    github.index(ID, indexText(T));
    const first = await stageServingIndex(devEnv(), ID, TAG);
    const second = await stageServingIndex(devEnv(), ID, TAG);
    expect(second).toEqual(first);
    expect(await servingCopies()).toHaveLength(1);
  });

  test("with no records bucket nothing is staged", async () => {
    github.tag(ID, TAG, T);
    github.index(ID, indexText(T));
    const env = devEnv();
    expect(
      await stageServingIndex(
        { ...env, COMPUTE_RECORDS: undefined } as unknown as Bindings,
        ID,
        TAG,
      ),
    ).toEqual({ staged: false, reason: "index_not_stored" });
  });
});

// --- (d): the job --------------------------------------------------------------------------------------------

const ica = findRecipe("nemar-ica") as NonNullable<ReturnType<typeof findRecipe>>;
const floor = findRecipe("nemar-floor") as NonNullable<ReturnType<typeof findRecipe>>;
const image = { ref: RUNTIME_IMAGE, digest: RUNTIME_IMAGE_DIGEST };
const HEX = "7".repeat(64);
const STAGED = { staged: true as const, sha256: HEX, size: 812, sourceCommit: T };

function icaSpec(servingIndex: Parameters<typeof recipeJobSpec>[1]["servingIndex"]) {
  return recipeJobSpec(ica, {
    datasetId: ID,
    tag: TAG,
    input: "bids",
    image,
    env: { ENVIRONMENT: "development" },
    ...(servingIndex === undefined ? {} : { servingIndex }),
  });
}

describe("nemar-ica's archive job names what was staged", () => {
  const base = recipeArguments({ datasetId: ID, tag: TAG, imageDigest: RUNTIME_IMAGE_DIGEST });

  test("a staged index: the arguments hand the run the file and the tag's commit, and the digest is recorded", () => {
    const spec = icaSpec(STAGED);
    expect(spec.args).toEqual([
      ...base,
      RECIPE_SERVING_INDEX_FLAG,
      SERVING_INDEX_CONTAINER_PATH,
      RECIPE_SOURCE_COMMIT_FLAG,
      T,
    ]);
    // `--dataset-id` is there once, from the archive's own arguments.
    expect(spec.args.filter((a) => a === "--dataset-id")).toHaveLength(1);
    expect(spec.serving_index).toEqual({ sha256: HEX, size: 812 });
  });

  test("none staged: the arguments are the archive's own, and the word is recorded (MUTATION: hand the flag anyway)", () => {
    const spec = icaSpec({ staged: false, reason: "source_commit_differs" });
    expect(spec.args).toEqual(base);
    expect(spec.serving_index).toEqual({ reason: "source_commit_differs" });
  });

  test("a recipe that keys the index cannot be specified without what was staged", () => {
    expect(() => icaSpec(undefined)).toThrow(RangeError);
  });

  test("the floor's archive job never carries a serving index, whatever it is handed", () => {
    const spec = recipeJobSpec(floor, {
      datasetId: ID,
      tag: TAG,
      input: "bids",
      image,
      env: { ENVIRONMENT: "development" },
      servingIndex: STAGED,
    });
    expect(spec.serving_index).toBeUndefined();
    expect(spec.args).not.toContain(RECIPE_SERVING_INDEX_FLAG);
  });
});

// --- (e) and (f): the launch and the route -------------------------------------------------------------------

/** A pipeline job of nemar-ica's archive run, made through the real `createJob`, with the copy kept or not. */
async function icaJob(env: Bindings, staged: Parameters<typeof icaSpec>[0]) {
  const accountId = await seedPipelinesAccount(env);
  await fundPipelines(env, 100_000_000, true);
  const made = await createJob(env, {
    source: "pipeline",
    accountId,
    tapisOwner: PIPELINES_TAPIS_OWNER,
    idempotencyKey: `b2b-${crypto.randomUUID()}`,
    appId: ica.appId,
    appVersion: ica.appVersion,
    spec: icaSpec(staged),
    executor: "tapis",
  });
  if (!made.ok) throw new Error(`no job: ${made.code}`);
  if (!made.recordsWritten) throw new Error("the records did not land");
  return reread(env, made.job.id);
}

async function launchOf(env: Bindings, jobId: string): Promise<Record<string, unknown>> {
  const built = await buildLaunch(env, await reread(env, jobId));
  if (!built.ok) throw new Error(`unbuildable: ${built.why}`);
  const decoded = decodeLaunchSpecEnv(built.launch.launchSpecEnv);
  if (!decoded.ok) throw new Error(decoded.reason);
  return JSON.parse(decoded.text);
}

async function callRoute(env: Bindings, jobId: string, token: string) {
  const res = await handle(
    new Request(`http://api.test/compute/jobs/${jobId}/serving-index`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Compute-Job-Token": token },
    }),
    env,
  );
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, string> };
}

const tokenOf = async (env: Bindings, jobId: string) =>
  signComputeToken(
    "job",
    { jobId, nonce: (await reread(env, jobId)).webhook_nonce as string },
    CALLBACK_SECRET,
  );

describe("the launch specification and the serving index route", () => {
  test("a staged index is in the launch specification, and the route signs exactly that copy for ten minutes", async () => {
    const env = devEnv();
    const text = indexText(T);
    github.tag(ID, TAG, T);
    github.index(ID, text);
    const staged = await stageServingIndex(env, ID, TAG);
    if (!staged.staged) throw new Error(staged.reason);
    const job = await icaJob(env, staged);
    const launch = await launchOf(env, job.id);
    expect(launch.serving_index).toEqual({ sha256: staged.sha256, size: staged.size });
    expect(launch.args as string[]).toContain(SERVING_INDEX_CONTAINER_PATH);
    const reply = await callRoute(env, job.id, await tokenOf(env, job.id));
    expect(reply.status).toBe(200);
    const url = new URL(reply.body.url as string);
    expect(decodeURIComponent(url.pathname)).toBe(
      `/nemar-compute-records/serving-index/${staged.sha256}.json`,
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    const fetched = new Uint8Array(await (await fetch(reply.body.url as string)).arrayBuffer());
    expect(sha(fetched)).toBe(staged.sha256);
    expect(fetched.length).toBe(staged.size);
  });

  test("none staged: nothing of it is in the launch, and the route gives the door's one refusal (MUTATION: put the word in the launch; sign without a recorded digest)", async () => {
    const env = devEnv();
    const job = await icaJob(env, { staged: false, reason: "no_index" });
    const launch = await launchOf(env, job.id);
    expect("serving_index" in launch).toBe(false);
    const wrong = await callRoute(env, job.id, "0".repeat(64));
    const none = await callRoute(env, job.id, await tokenOf(env, job.id));
    expect([none.status, none.text]).toEqual([wrong.status, wrong.text]);
    expect(none.body.code).toBe("job_not_found");
  });

  test("a recorded digest whose copy is gone, or holds other bytes, gets the same refusal (MUTATION: sign without the head)", async () => {
    const env = devEnv();
    github.tag(ID, TAG, T);
    github.index(ID, indexText(T));
    const staged = await stageServingIndex(env, ID, TAG);
    if (!staged.staged) throw new Error(staged.reason);
    const job = await icaJob(env, staged);
    const token = await tokenOf(env, job.id);
    const wrong = await callRoute(env, job.id, "0".repeat(64));
    await fx.harness.records.put(servingIndexKey(staged.sha256), "short");
    const resized = await callRoute(env, job.id, token);
    expect([resized.status, resized.text]).toEqual([wrong.status, wrong.text]);
    await fx.harness.records.delete(servingIndexKey(staged.sha256));
    const gone = await callRoute(env, job.id, token);
    expect([gone.status, gone.text]).toEqual([wrong.status, wrong.text]);
  });

  test("the route reads the RECORDED specification: one whose bytes are not the row's digest names nothing", async () => {
    const env = devEnv();
    github.tag(ID, TAG, T);
    github.index(ID, indexText(T));
    const staged = await stageServingIndex(env, ID, TAG);
    if (!staged.staged) throw new Error(staged.reason);
    const job = await icaJob(env, staged);
    const key = `records/${job.id}/spec.json`;
    const recorded = JSON.parse(await ((await fx.harness.records.get(key)) as R2ObjectBody).text());
    await fx.harness.records.put(key, JSON.stringify({ ...recorded, name: "changed" }));
    const reply = await callRoute(env, job.id, await tokenOf(env, job.id));
    expect(reply.body.code).toBe("job_not_found");
  });

  test("a terminal job's token is refused at this route as at the others", async () => {
    const env = devEnv();
    github.tag(ID, TAG, T);
    github.index(ID, indexText(T));
    const staged = await stageServingIndex(env, ID, TAG);
    if (!staged.staged) throw new Error(staged.reason);
    const job = await icaJob(env, staged);
    const token = await tokenOf(env, job.id);
    await env.DB.prepare("UPDATE compute_jobs SET state = 'cancelled' WHERE id = ?1")
      .bind(job.id)
      .run();
    expect((await callRoute(env, job.id, token)).body.code).toBe("job_not_found");
  });
});
