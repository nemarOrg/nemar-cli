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
 *  (c) every other failure is a word, and none refuses the run; the tag's commit is the dispatcher's, read before
 *      staging for every run of the archive: a GitHub fault defers the run for as long as it lasts and an absent
 *      tag refuses it (ADR 0143), so staging is handed the commit and asks GitHub nothing;
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
import { COMPUTE_PIPELINE_REFUSAL_STATUS } from "../../shared/contract/compute-admin";
import {
  SERVING_INDEX_CONTAINER_PATH,
  decodeLaunchSpecEnv,
} from "../../shared/contract/compute-launch";
import { createJob } from "../src/services/compute-jobs";
import { buildLaunch } from "../src/services/compute-lifecycle";
import {
  SERVING_INDEX_DEFERRED_WORD,
  SOURCE_COMMIT_DEFERRED_WORD,
  dispatchPipelineJob,
  recipeJobSpec,
  servingIndexForRun,
  servingIndexRefusal,
  sourceCommitForRun,
  sourceCommitRefusal,
} from "../src/services/compute-pipeline";
import { servingIndexKey } from "../src/services/compute-records";
import { signComputeToken } from "../src/services/compute-tokens";
import { __resetInstallationTokenCacheForTests } from "../src/services/github-auth";
import { getZarrIndexResponse } from "../src/services/s3";
import {
  SERVING_INDEX_DEFER_MINUTES,
  SERVING_INDEX_FAULT_REASONS,
  isServingIndexFault,
  stageServingIndex,
} from "../src/services/serving-index-staging";
import type { Bindings } from "../src/types/bindings";
import {
  CALLBACK_SECRET,
  type LifecycleFixture,
  RUNTIME_IMAGE,
  RUNTIME_IMAGE_DIGEST,
  reread,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import {
  fundPipelines,
  seedEegDataset,
  seedPipelinesAccount,
} from "./helpers/compute-pipeline-fixture";
import { makeRoutesApp } from "./helpers/compute-routes-app";
import {
  type GithubCompareStandin,
  startGithubCompareStandin,
} from "./helpers/github-compare-standin";
import { logged } from "./helpers/logs";

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
/** A store as the converter lists it, with one EEG group; `over` replaces members of the group. */
const storeOf = (over: Record<string, unknown> = {}) => ({
  path: "sub-01/eeg/sub-01_task-rest_eeg.set",
  zarr: "sub-01/eeg/sub-01_task-rest_eeg.zarr",
  groups: [
    { name: "eeg_250hz", modality: "EEG", rate: 250, n_channels: 64, n_samples: 75000, ...over },
  ],
});

/** An index document as the converter writes it; `over` replaces top-level members. */
const indexDoc = (commit: unknown, over: Record<string, unknown> = {}) => ({
  format_version: 3,
  dataset_id: ID,
  source_commit: commit,
  store_count: 1,
  stores: [storeOf()],
  ...over,
});

/** The index as TEXT: the digest is over these exact bytes. */
const indexText = (commit: unknown, over: Record<string, unknown> = {}) =>
  `${JSON.stringify(indexDoc(commit, over), null, 2)}\n`;

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
    const staged = await stageServingIndex(devEnv(), ID, T);
    const bytes = new TextEncoder().encode(text);
    expect(staged).toEqual({
      staged: true,
      sha256: sha(bytes),
      size: bytes.length,
      sourceCommit: T,
    });
    const kept = await fx.harness.records.get(servingIndexKey(sha(bytes)));
    expect(new Uint8Array(await (kept as R2ObjectBody).arrayBuffer())).toEqual(bytes);
    // Staging is handed the tag's commit and asks GitHub nothing: no tag, no compare.
    expect(github.log.filter((r) => r.path.startsWith("/repos/"))).toEqual([]);
    expect(compareRequests()).toEqual([]);
  });

  test("an index of another commit is not staged, and nothing is kept (MUTATION: accept any commit)", async () => {
    github.tag(ID, TAG, T);
    github.index(ID, indexText(S));
    expect(await stageServingIndex(devEnv(), ID, T)).toEqual({
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
    expect(await stageServingIndex(devEnv(), ID, T)).toEqual({
      staged: false,
      reason: "source_commit_differs",
    });
    expect(compareRequests()).toEqual([]);
    expect(await servingCopies()).toEqual([]);
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
      "index_unusable",
    ],
    [
      "an index that is a JSON array",
      () => {
        github.tag(ID, TAG, T);
        github.index(ID, "[]");
      },
      "index_unusable",
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
  ];
  for (const [label, arrange, reason] of cases) {
    test(`${label}: ${reason}`, async () => {
      arrange();
      expect(await stageServingIndex(devEnv(), ID, T)).toEqual({ staged: false, reason });
      expect(await servingCopies()).toEqual([]);
    });
  }

  test("an index over the recipe's 64 MiB is not read past its bound (MUTATION: drop the bound)", async () => {
    github.tag(ID, TAG, T);
    github.index(ID, { stream: " ".repeat(COMPUTE_SERVING_INDEX_MAX_BYTES + 1) });
    expect(await stageServingIndex(devEnv(), ID, T)).toEqual({
      staged: false,
      reason: "index_too_large",
    });
  });

  test("a key that holds other bytes is never overwritten, and nothing is staged (MUTATION: keep whatever is there)", async () => {
    const text = indexText(T);
    github.tag(ID, TAG, T);
    github.index(ID, text);
    await fx.harness.records.put(servingIndexKey(sha(text)), "other bytes");
    let staged: unknown;
    const lines = await logged(async () => {
      staged = await stageServingIndex(devEnv(), ID, T);
    });
    expect(staged).toEqual({ staged: false, reason: "index_not_stored" });
    // Its own line, with the digest, never the generic one (MUTATION: share the put failure's line).
    expect(lines.filter((l) => l.startsWith("[serving-index]"))).toEqual([
      `[serving-index] copy_conflict sha256=${sha(text)}`,
    ]);
    const kept = await fx.harness.records.get(servingIndexKey(sha(text)));
    expect(await (kept as R2ObjectBody).text()).toBe("other bytes");
  });

  test("a copy already kept with the same bytes is staged again, as one object", async () => {
    github.tag(ID, TAG, T);
    github.index(ID, indexText(T));
    const first = await stageServingIndex(devEnv(), ID, T);
    const second = await stageServingIndex(devEnv(), ID, T);
    expect(second).toEqual(first);
    expect(await servingCopies()).toHaveLength(1);
  });

  test("with no records bucket nothing is staged", async () => {
    github.tag(ID, TAG, T);
    github.index(ID, indexText(T));
    const env = devEnv();
    let staged: unknown;
    const lines = await logged(async () => {
      staged = await stageServingIndex(
        { ...env, COMPUTE_RECORDS: undefined } as unknown as Bindings,
        ID,
        T,
      );
    });
    expect(staged).toEqual({ staged: false, reason: "index_not_stored" });
    // The store's throw is logged by the error's class name alone (MUTATION: log the conflict line).
    expect(lines.filter((l) => l.startsWith("[serving-index]"))).toEqual([
      "[serving-index] copy_put_failed error=Error",
    ]);
  });

  test("a store that throws mid-put is logged by its class name", async () => {
    github.tag(ID, TAG, T);
    github.index(ID, indexText(T));
    const env = devEnv();
    const records = env.COMPUTE_RECORDS as R2Bucket;
    const broken = {
      head: (key: string) => records.head(key),
      get: (key: string) => records.get(key),
      put: () => {
        throw new TypeError("the bucket refused");
      },
    } as unknown as R2Bucket;
    let staged: unknown;
    const lines = await logged(async () => {
      staged = await stageServingIndex({ ...env, COMPUTE_RECORDS: broken }, ID, T);
    });
    expect(staged).toEqual({ staged: false, reason: "index_not_stored" });
    expect(lines.filter((l) => l.startsWith("[serving-index]"))).toEqual([
      "[serving-index] copy_put_failed error=TypeError",
    ]);
  });
});

// --- (c2): an index the recipe would refuse is never staged -------------------------------------------------

describe("an index the recipe cannot use is index_unusable, and the run goes ahead without it at once", () => {
  const bad: Array<[string, string]> = [
    ["a byte order mark", `\ufeff${indexText(T)}`],
    [
      "a repeated member name",
      indexText(T).replace('"format_version": 3,', '"format_version": 3,\n  "store_count": 2,'),
    ],
    ["no list of stores", indexText(T, { stores: {} })],
    ["a store count that is not whole", indexText(T, { store_count: 1.5 })],
    ["a store count below zero", indexText(T, { store_count: -1 })],
    ["a store that is not an object", indexText(T, { stores: ["x"] })],
    ["an absolute store path", indexText(T, { stores: [{ ...storeOf(), path: "/sub-01/x.set" }] })],
    [
      "a store path with a dot segment",
      indexText(T, { stores: [{ ...storeOf(), zarr: "sub-01/.partial/x.zarr" }] }),
    ],
    [
      "a store path with a query character",
      indexText(T, { stores: [{ ...storeOf(), path: "sub-01/x?.set" }] }),
    ],
    ["a store with no list of groups", indexText(T, { stores: [{ ...storeOf(), groups: null }] })],
    ["a group with no name", indexText(T, { stores: [storeOf({ name: "" })] })],
    [
      "a group name with a control character",
      indexText(T, { stores: [storeOf({ name: "eeg\u0001" })] }),
    ],
    ["a group with no modality", indexText(T, { stores: [storeOf({ modality: null })] })],
    ["a rate of zero", indexText(T, { stores: [storeOf({ rate: 0 })] })],
    ["a rate that is text", indexText(T, { stores: [storeOf({ rate: "250" })] })],
    ["a rate that is a boolean", indexText(T, { stores: [storeOf({ rate: true })] })],
    ["a fractional channel count", indexText(T, { stores: [storeOf({ n_channels: 1.5 })] })],
    ["too many channels", indexText(T, { stores: [storeOf({ n_channels: 100_001 })] })],
    ["a negative sample count", indexText(T, { stores: [storeOf({ n_samples: -1 })] })],
    ["too many samples", indexText(T, { stores: [storeOf({ n_samples: 10 ** 11 + 1 })] })],
  ];
  for (const [label, text] of bad) {
    test(`${label}: index_unusable, nothing kept, and no deferral`, async () => {
      github.tag(ID, TAG, T);
      github.index(ID, text);
      expect(await stageServingIndex(devEnv(), ID, T)).toEqual({
        staged: false,
        reason: "index_unusable",
      });
      expect(await servingCopies()).toEqual([]);
      expect(isServingIndexFault("index_unusable")).toBe(false);
    });
  }

  test("the edges the recipe accepts are staged: zero stores, zero channels and samples, the largest counts", async () => {
    for (const over of [
      { stores: [], store_count: 0 },
      { stores: [storeOf({ n_channels: 0, n_samples: 0 })] },
      { stores: [storeOf({ n_channels: 100_000, n_samples: 10 ** 11, rate: 0.5 })] },
      { stores: [{ ...storeOf(), groups: [] }] },
    ]) {
      github.reset();
      github.tag(ID, TAG, T);
      github.index(ID, indexText(T, over));
      expect((await stageServingIndex(devEnv(), ID, T)).staged, JSON.stringify(over)).toBe(true);
    }
  });
});

// --- (c3): a fault defers the run, for at most 24 hours ------------------------------------------------------

describe("a fault defers the run; after 24 hours, or for an absent index, it runs without one", () => {
  const run = (env: Bindings) => servingIndexForRun(env, ica, "bids", ID, TAG, T);
  const deferredStamps = async (env: Bindings) =>
    (
      await env.DB.prepare(
        "SELECT id, state, refusal_code, job_id FROM compute_pipeline_stamps WHERE dataset_id = ?1 ORDER BY id",
      )
        .bind(ID)
        .all<{ id: number; state: string; refusal_code: string | null; job_id: string | null }>()
    ).results;
  const backdate = (env: Bindings, hours: number) =>
    env.DB.prepare(
      `UPDATE compute_pipeline_stamps SET created_at = datetime('now', '-${hours} hours') WHERE dataset_id = ?1`,
    )
      .bind(ID)
      .run();

  for (const [label, arrange, reason] of [
    [
      "the index cannot be read",
      () => {
        github.tag(ID, TAG, T);
        github.index(ID, { http: 503 });
      },
      "index_unreadable",
    ],
  ] as Array<[string, () => void, string]>) {
    test(`${label}: deferred, a refused stamp records it, and nothing is dispatched (MUTATION: run on a fault)`, async () => {
      const env = devEnv();
      await seedEegDataset(env, ID);
      arrange();
      const decided = await run(env);
      expect(decided).toMatchObject({ kind: "deferred", reason });
      const stamps = await deferredStamps(env);
      expect(stamps).toEqual([
        {
          id: (decided as { stampId: number }).stampId,
          state: "refused",
          refusal_code: SERVING_INDEX_DEFERRED_WORD,
          job_id: null,
        },
      ]);
      // The next pass defers again, and a refused stamp never blocks the claim of a run.
      expect((await run(env)).kind).toBe("deferred");
      expect(await deferredStamps(env)).toHaveLength(2);
    });
  }

  test("a fault 24 hours after the first deferral runs without the index, recording the fault, and with the tag's commit (MUTATION: defer for ever; measure from the newest deferral)", async () => {
    const env = devEnv();
    await seedEegDataset(env, ID);
    github.index(ID, { http: 503 });
    expect((await run(env)).kind).toBe("deferred");
    expect((await run(env)).kind).toBe("deferred");
    // The first deferral 25 hours ago and the second an hour ago: the wait is measured from the first.
    await env.DB.prepare(
      "UPDATE compute_pipeline_stamps SET created_at = datetime('now', CASE WHEN id = (SELECT MIN(id) FROM compute_pipeline_stamps) THEN '-25 hours' ELSE '-1 hours' END)",
    ).run();
    expect(await run(env)).toEqual({
      kind: "run",
      servingIndex: { staged: false, reason: "index_unreadable" },
    });
    const spec = icaSpec({ staged: false, reason: "index_unreadable" });
    expect(spec.serving_index).toEqual({ reason: "index_unreadable" });
    expect(spec.args.slice(-2)).toEqual([RECIPE_SOURCE_COMMIT_FLAG, T]);
  });

  test("a fault under 24 hours keeps deferring (MUTATION: end the wait early)", async () => {
    const env = devEnv();
    await seedEegDataset(env, ID);
    github.index(ID, { http: 503 });
    expect((await run(env)).kind).toBe("deferred");
    await backdate(env, 23);
    expect((await run(env)).kind).toBe("deferred");
  });

  test("an earlier run's deferral never shortens a later run's wait", async () => {
    const env = devEnv();
    await seedEegDataset(env, ID);
    github.index(ID, { http: 503 });
    expect((await run(env)).kind).toBe("deferred");
    await backdate(env, 48);
    // That run went ahead and ended: a failed stamp of the same tuple.
    await env.DB.prepare(
      `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, input, attempt, state, refusal_code)
       VALUES (?1, ?2, ?3, ?4, ?5, 'bids', 99, 'failed', 'job_failed')`,
    )
      .bind(ID, TAG, ica.name, ica.version, ica.engine)
      .run();
    expect((await run(env)).kind).toBe("deferred");
  });

  for (const [label, arrange, reason] of [
    ["no index", () => github.tag(ID, TAG, T), "no_index"],
    [
      "an index of another commit",
      () => {
        github.tag(ID, TAG, T);
        github.index(ID, indexText(S));
      },
      "source_commit_differs",
    ],
    [
      "an index the recipe cannot use",
      () => {
        github.tag(ID, TAG, T);
        github.index(ID, indexText(T, { stores: {} }));
      },
      "index_unusable",
    ],
  ] as Array<[string, () => void, string]>) {
    test(`${label}: runs at once without the index, and no stamp is written (MUTATION: defer every word)`, async () => {
      const env = devEnv();
      await seedEegDataset(env, ID);
      arrange();
      expect(await run(env)).toEqual({
        kind: "run",
        servingIndex: { staged: false, reason },
      });
      expect(await deferredStamps(env)).toEqual([]);
    });
  }

  test("a staged index runs at once", async () => {
    const env = devEnv();
    await seedEegDataset(env, ID);
    github.tag(ID, TAG, T);
    github.index(ID, indexText(T));
    expect((await run(env)).kind).toBe("run");
    expect(await deferredStamps(env)).toEqual([]);
  });

  test("a live stamp of the tuple refuses the deferral's claim as live_attempt_exists", async () => {
    const env = devEnv();
    await seedEegDataset(env, ID);
    github.index(ID, { http: 503 });
    await env.DB.prepare(
      `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, input, attempt, state)
       VALUES (?1, ?2, ?3, ?4, ?5, 'bids', 1, 'dispatched')`,
    )
      .bind(ID, TAG, ica.name, ica.version, ica.engine)
      .run();
    expect(await run(env)).toEqual({ kind: "live_attempt_exists" });
  });

  test("the dispatch answers a deferral with serving_index_deferred, the word, the stamp and when it runs without the index (MUTATION: dispatch through a deferral)", async () => {
    const env = devEnv();
    await seedEegDataset(env, ID);
    github.index(ID, { http: 503 });
    const before = Date.now();
    const deferred = await run(env);
    if (deferred.kind !== "deferred") throw new Error("not deferred");
    const refusal = servingIndexRefusal(deferred, ID, TAG);
    expect(refusal).toEqual({
      ok: false,
      code: "serving_index_deferred",
      datasetId: ID,
      version: TAG,
      reason: "index_unreadable",
      stampId: deferred.stampId,
      runsWithoutIndexAfter: deferred.runsWithoutIndexAfter,
    });
    // The first deferral is this one: 24 hours from now.
    const after = Date.parse(deferred.runsWithoutIndexAfter);
    expect(after - before).toBeGreaterThanOrEqual(SERVING_INDEX_DEFER_MINUTES * 60_000 - 1000);
    expect(after - Date.now()).toBeLessThanOrEqual(SERVING_INDEX_DEFER_MINUTES * 60_000);
    // A later deferral names the same time, measured from the first (to the clock's second).
    await backdate(env, 10);
    const again = await run(env);
    if (again.kind !== "deferred") throw new Error("not deferred");
    expect(
      Math.abs(Date.parse(again.runsWithoutIndexAfter) - (after - 10 * 3_600_000)),
    ).toBeLessThan(5_000);
    expect(servingIndexRefusal({ kind: "live_attempt_exists" }, ID, TAG)).toEqual({
      ok: false,
      code: "live_attempt_exists",
      datasetId: ID,
      version: TAG,
    });
    expect(COMPUTE_PIPELINE_REFUSAL_STATUS.serving_index_deferred).toBe(503);
  });

  test("exactly 1,440 minutes after the first deferral the run goes ahead; a minute short it is deferred", async () => {
    const env = devEnv();
    await seedEegDataset(env, ID);
    github.index(ID, { http: 503 });
    expect((await run(env)).kind).toBe("deferred");
    const setAge = (minutes: number) =>
      env.DB.prepare(
        `UPDATE compute_pipeline_stamps SET created_at = datetime('now', '-${minutes} minutes') WHERE id = (SELECT MIN(id) FROM compute_pipeline_stamps)`,
      ).run();
    await setAge(SERVING_INDEX_DEFER_MINUTES - 1);
    expect((await run(env)).kind).toBe("deferred");
    await setAge(SERVING_INDEX_DEFER_MINUTES);
    expect((await run(env)).kind).toBe("run");
  });

  test("the fault words and the wait are the ruling's", () => {
    expect([...SERVING_INDEX_FAULT_REASONS].sort()).toEqual(
      [
        "github_unreadable",
        "index_not_stored",
        "index_unreadable",
        "no_github_credentials",
        "token_mint_failed",
      ].sort(),
    );
    expect(SERVING_INDEX_DEFER_MINUTES).toBe(24 * 60);
  });
});

describe("a 403 is read with the dataset row: an absent index runs at once, a ready copy's 403 defers", () => {
  const run = (env: Bindings) => servingIndexForRun(env, ica, "bids", ID, TAG, T);
  const S3 = {
    S3_BUCKET: "example-bucket",
    AWS_REGION: "us-east-2",
    AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
    AWS_SECRET_ACCESS_KEY: "secret",
  };
  const setCopy = (env: Bindings, status: string | null, stores: number | null) =>
    env.DB.prepare(
      "UPDATE datasets SET zarr_status = ?1, zarr_store_count = ?2 WHERE dataset_id = ?3",
    )
      .bind(status, stores, ID)
      .run();

  /** The object store as a stand-in that answers 403 for the index; GitHub stays the loopback stand-in. */
  async function withS3Answering403<T>(work: () => Promise<T>): Promise<T> {
    const real = globalThis.fetch;
    const seam = seams.NEMAR_ZARR_INDEX_BASE;
    seams.NEMAR_ZARR_INDEX_BASE = undefined;
    // An HTTP response fixture for the object store: the 403 a missing object answers without ListBucket.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes(".amazonaws.com/")) return new Response("", { status: 403 });
      return real(input as RequestInfo, init);
    }) as typeof fetch;
    try {
      return await work();
    } finally {
      globalThis.fetch = real;
      seams.NEMAR_ZARR_INDEX_BASE = seam;
    }
  }

  for (const [label, status, stores, expected] of [
    ["a copy that is not converted", null, null, "no_index"],
    ["a pending conversion", "pending", 3, "no_index"],
    ["a ready copy with no store", "ready", 0, "no_index"],
    ["a ready copy with stores", "ready", 3, "index_unreadable"],
  ] as Array<[string, string | null, number | null, string]>) {
    for (const via of ["S3", "the index seam"] as const) {
      test(`${label}, through ${via}: ${expected} (MUTATION: read every 403 as a fault; as absent)`, async () => {
        const env = devEnv(via === "S3" ? S3 : {});
        await seedEegDataset(env, ID);
        await setCopy(env, status, stores);
        github.tag(ID, TAG, T);
        github.index(ID, { http: 403 });
        const decided = via === "S3" ? await withS3Answering403(() => run(env)) : await run(env);
        if (expected === "no_index") {
          expect(decided).toEqual({
            kind: "run",
            servingIndex: { staged: false, reason: "no_index" },
          });
        } else {
          expect(decided).toMatchObject({ kind: "deferred", reason: "index_unreadable" });
        }
      });
    }
  }

  const options = {
    bucket: "example-bucket",
    region: "us-east-2",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
  };
  for (const [status, expected] of [
    [404, "null"],
    [403, "forbidden"],
    [500, "throws"],
    [200, "response"],
  ] as Array<[number, string]>) {
    test(`getZarrIndexResponse on a ${status}: ${expected}`, async () => {
      const real = globalThis.fetch;
      // An HTTP response fixture for the object store's answer, the error path under test.
      globalThis.fetch = (async () =>
        new Response(status === 200 ? "{}" : "", { status })) as unknown as typeof fetch;
      try {
        const got = getZarrIndexResponse(options, ID);
        if (expected === "throws") await expect(got).rejects.toThrow();
        else if (expected === "null") expect(await got).toBeNull();
        else if (expected === "forbidden") expect(await got).toBe("forbidden");
        else expect(((await got) as Response).status).toBe(200);
      } finally {
        globalThis.fetch = real;
      }
    });
  }
});

// --- (c4): every run of the archive is handed its tag's commit, or waits for it (ADR 0143) -------------------------

describe("every run of the archive reads its tag's commit first: a fault defers it for as long as it lasts, an absent tag refuses it", () => {
  const stamps = async (env: Bindings) =>
    (
      await env.DB.prepare(
        "SELECT state, refusal_code, job_id FROM compute_pipeline_stamps WHERE dataset_id = ?1 ORDER BY id",
      )
        .bind(ID)
        .all<{ state: string; refusal_code: string | null; job_id: string | null }>()
    ).results;

  for (const recipe of [ica, floor]) {
    test(`${recipe.name}: the tag's commit, found with or without the tag's leading v, and nothing written`, async () => {
      const env = devEnv();
      await seedEegDataset(env, ID);
      github.tag(ID, "1.0.0", T);
      expect(await sourceCommitForRun(env, recipe, "bids", ID, TAG)).toEqual({
        kind: "commit",
        commit: T,
      });
      expect(await stamps(env)).toEqual([]);
    });
  }

  test("a tag the repository does not have is tag_absent: refused as version_tag_absent with nothing written, and logged (MUTATION: run it without a commit)", async () => {
    const env = devEnv();
    await seedEegDataset(env, ID);
    let decided: unknown;
    const lines = await logged(async () => {
      decided = await sourceCommitForRun(env, floor, "bids", ID, TAG);
    });
    expect(decided).toEqual({ kind: "tag_absent" });
    expect(lines).toContain(`[compute-pipeline] version_tag_absent dataset=${ID} version=${TAG}`);
    expect(await stamps(env)).toEqual([]);
    expect(sourceCommitRefusal({ kind: "tag_absent" }, ID, TAG)).toEqual({
      ok: false,
      code: "version_tag_absent",
      datasetId: ID,
      version: TAG,
    });
    expect(COMPUTE_PIPELINE_REFUSAL_STATUS.version_tag_absent).toBe(409);
  });

  for (const [label, env, arrange, reason] of [
    [
      "GitHub cannot answer",
      () => devEnv(),
      () => github.tag(ID, TAG, { http: 502 }),
      "github_unreadable",
    ],
    [
      "production without the GitHub App",
      () => fx.env(),
      () => github.tag(ID, TAG, T),
      "no_github_credentials",
    ],
  ] as Array<[string, () => Bindings, () => void, string]>) {
    test(`${label}: deferred with a refused stamp, and still deferred two days on, never run without its commit (MUTATION: let the deferral run out; run on a fault)`, async () => {
      const on = env();
      await seedEegDataset(on, ID);
      arrange();
      const first = await sourceCommitForRun(on, floor, "bids", ID, TAG);
      expect(first).toMatchObject({ kind: "deferred", reason });
      expect(await stamps(on)).toEqual([
        { state: "refused", refusal_code: SOURCE_COMMIT_DEFERRED_WORD, job_id: null },
      ]);
      await on.DB.prepare(
        "UPDATE compute_pipeline_stamps SET created_at = datetime('now', '-48 hours') WHERE dataset_id = ?1",
      )
        .bind(ID)
        .run();
      expect(await sourceCommitForRun(on, floor, "bids", ID, TAG)).toMatchObject({
        kind: "deferred",
        reason,
      });
      if (first.kind !== "deferred") throw new Error("not deferred");
      expect(sourceCommitRefusal(first, ID, TAG)).toEqual({
        ok: false,
        code: "source_commit_deferred",
        datasetId: ID,
        version: TAG,
        reason,
        stampId: first.stampId,
      });
      expect(COMPUTE_PIPELINE_REFUSAL_STATUS.source_commit_deferred).toBe(503);
    });
  }

  test("production without the GitHub App asks GitHub nothing", async () => {
    const env = fx.env();
    await seedEegDataset(env, ID);
    await sourceCommitForRun(env, floor, "bids", ID, TAG);
    expect(github.log).toEqual([]);
  });

  test("a live stamp of the tuple refuses the deferral's claim as live_attempt_exists", async () => {
    const env = devEnv();
    await seedEegDataset(env, ID);
    github.tag(ID, TAG, { http: 502 });
    await env.DB.prepare(
      `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, input, attempt, state)
       VALUES (?1, ?2, ?3, ?4, ?5, 'bids', 1, 'dispatched')`,
    )
      .bind(ID, TAG, floor.name, floor.version, floor.engine)
      .run();
    expect(await sourceCommitForRun(env, floor, "bids", ID, TAG)).toEqual({
      kind: "live_attempt_exists",
    });
  });

  test("through the dispatch, a floor run of the archive is deferred or refused before any job is made (MUTATION: dispatch without reading the commit)", async () => {
    const env = devEnv();
    await seedPipelinesAccount(env);
    await fundPipelines(env);
    await seedEegDataset(env, ID);
    const admin = { kind: "admin", userId: 1 } as const;
    const dispatch = () =>
      dispatchPipelineJob(env, { recipe: "nemar-floor", datasetId: ID, actor: admin });
    github.tag(ID, TAG, { http: 502 });
    expect(await dispatch()).toMatchObject({
      ok: false,
      code: "source_commit_deferred",
      reason: "github_unreadable",
    });
    github.reset();
    expect(await dispatch()).toMatchObject({ ok: false, code: "version_tag_absent", version: TAG });
    const jobs = await env.DB.prepare("SELECT COUNT(*) AS n FROM compute_jobs").first<{
      n: number;
    }>();
    expect(jobs?.n).toBe(0);
    expect((await stamps(env)).map((s) => [s.state, s.refusal_code])).toEqual([
      ["refused", SOURCE_COMMIT_DEFERRED_WORD],
    ]);
    // And with the tag there, the job is made and handed the commit.
    github.tag(ID, TAG, T);
    const made = await dispatch();
    expect(made).toMatchObject({ ok: true });
  });
});

// --- (d): the job --------------------------------------------------------------------------------------------

const ica = findRecipe("nemar-ica") as NonNullable<ReturnType<typeof findRecipe>>;
const floor = findRecipe("nemar-floor") as NonNullable<ReturnType<typeof findRecipe>>;
const image = { ref: RUNTIME_IMAGE, digest: RUNTIME_IMAGE_DIGEST };
const HEX = "7".repeat(64);
const STAGED = { staged: true as const, sha256: HEX, size: 812, sourceCommit: T };

function icaSpec(
  servingIndex: Parameters<typeof recipeJobSpec>[1]["servingIndex"],
  sourceCommit: string | undefined = T,
) {
  return recipeJobSpec(ica, {
    datasetId: ID,
    tag: TAG,
    input: "bids",
    image,
    env: { ENVIRONMENT: "development" },
    ...(sourceCommit === undefined ? {} : { sourceCommit }),
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

  test("none staged: the arguments hand the run the tag's commit and no index, and the word is recorded (MUTATION: hand the flag anyway; hand the commit only with a staged index)", () => {
    for (const reason of [
      "source_commit_differs",
      "no_index",
      "index_unusable",
      "index_too_large",
      "index_unreadable",
    ] as const) {
      const spec = icaSpec({ staged: false, reason });
      expect(spec.args).toEqual([...base, RECIPE_SOURCE_COMMIT_FLAG, T]);
      expect(spec.args).not.toContain(RECIPE_SERVING_INDEX_FLAG);
      expect(spec.serving_index).toEqual({ reason });
    }
  });

  test("a run of the archive with no commit, or one that is not a full commit, is a programming error, never a job (ADR 0143)", () => {
    expect(() =>
      recipeJobSpec(ica, {
        datasetId: ID,
        tag: TAG,
        input: "bids",
        image,
        env: { ENVIRONMENT: "development" },
        servingIndex: { staged: false, reason: "no_index" },
      }),
    ).toThrow(RangeError);
    expect(() => icaSpec({ staged: false, reason: "no_index" }, T.slice(0, 12))).toThrow(
      RangeError,
    );
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
      sourceCommit: T,
      servingIndex: STAGED,
    });
    expect(spec.serving_index).toBeUndefined();
    expect(spec.args).not.toContain(RECIPE_SERVING_INDEX_FLAG);
    // It is handed the tag's commit all the same (ADR 0143).
    expect(spec.args.slice(-2)).toEqual([RECIPE_SOURCE_COMMIT_FLAG, T]);
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

describe("an index built from another commit than the tag's (on007823 in the local run of 2026-11-27)", () => {
  test("the run is dispatched at once with the tag's commit and no index, and the launch carries both (MUTATION: hand --source-commit only with a staged index)", async () => {
    const env = devEnv();
    await seedEegDataset(env, ID);
    github.tag(ID, TAG, T);
    github.index(ID, indexText(S));
    const decided = await servingIndexForRun(env, ica, "bids", ID, TAG, T);
    if (decided.kind !== "run") throw new Error(`not run: ${decided.kind}`);
    expect(decided.servingIndex).toEqual({
      staged: false,
      reason: "source_commit_differs",
    });
    const job = await icaJob(env, decided.servingIndex);
    const launch = await launchOf(env, job.id);
    const args = launch.args as string[];
    // The commit the recipe records as extensions.nemar.dataset.source_commit: the TAG's, never the index's.
    expect(args.slice(-2)).toEqual([RECIPE_SOURCE_COMMIT_FLAG, T]);
    expect(args.filter((a) => a === RECIPE_SOURCE_COMMIT_FLAG)).toHaveLength(1);
    expect(args).not.toContain(S);
    expect(args).not.toContain(RECIPE_SERVING_INDEX_FLAG);
    expect("serving_index" in launch).toBe(false);
    expect(await servingCopies()).toEqual([]);
  });
});

describe("the launch specification and the serving index route", () => {
  test("a staged index is in the launch specification, and the route signs exactly that copy for ten minutes", async () => {
    const env = devEnv();
    const text = indexText(T);
    github.tag(ID, TAG, T);
    github.index(ID, text);
    const staged = await stageServingIndex(env, ID, T);
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
    const staged = await stageServingIndex(env, ID, T);
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
    const staged = await stageServingIndex(env, ID, T);
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
    const staged = await stageServingIndex(env, ID, T);
    if (!staged.staged) throw new Error(staged.reason);
    const job = await icaJob(env, staged);
    const token = await tokenOf(env, job.id);
    await env.DB.prepare("UPDATE compute_jobs SET state = 'cancelled' WHERE id = ?1")
      .bind(job.id)
      .run();
    expect((await callRoute(env, job.id, token)).body.code).toBe("job_not_found");
  });
});
