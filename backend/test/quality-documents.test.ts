/**
 * A run's dataset quality summary (ADR 0137 decision 8, epic #2324 phase B1), from its product in the
 * results bucket to a dataset's pages, through the real entry points: `reconcilePipelineProgress` over
 * Miniflare's R2 and a real migrated database, `promoteDerivative` (the admin route's promotion), and
 * `readPipelineExtensions`, the one read `/<id>/metadata.json` and the page bundle serve. The product is
 * nemar-ica's own, copied from nemar-process P7 (`test/fixtures/quality/ica-views`). A nemar-ica run is a
 * Tapis job this suite does not make, so its succeeded stamp is seeded with SQL the table accepts, and its
 * product is put where the launcher uploads it.
 *
 * What is pinned, each case by the mutation it names:
 *  - a succeeded run's summary is kept for its stamp, bound to the STAMP's dataset, member for member;
 *  - the summary names the very record bytes the run's link names;
 *  - a summary that names another record, counts other recordings, or names a plugin the recipe does not
 *    run is not kept, with a fixed-word log line, and the run is reconciled all the same;
 *  - a run with no summary, and a failed run, keep none; a summary that cannot be read now leaves the run
 *    for a later call;
 *  - a page shows a summary only once its derivative is promoted: canary shows nothing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import {
  declaredCheckpoints,
  recipeQualityDocumentPath,
  recipeRequiredOutputs,
} from "../../shared/compute-recipes";
import { resultsOutputKey } from "../../shared/contract/compute-launch";
import {
  compileNeuroschemaValidator,
  formatAjvErrors,
} from "../../test/contract/neuroschema-validator";
import { promoteDerivative } from "../src/services/compute-derivatives";
import {
  readPipelineExtensions,
  reconcilePipelineProgress,
} from "../src/services/compute-pipeline-progress";
import { CURRENT_QUALITY_DOCUMENTS_SQL } from "../src/services/quality-documents";
import type { Bindings } from "../src/types/bindings";
import { type ComputeHarness, startComputeHarness } from "./helpers/compute-harness";
import { seedEegDataset } from "./helpers/compute-pipeline-fixture";
import { logged } from "./helpers/logs";
import {
  ICA,
  fixtureEntry,
  newJobId,
  productFiles,
  seedDerivative,
  seedIcaStamp,
  wideEdgesDocument,
} from "./helpers/quality-fixture";

let harness: ComputeHarness;
let derivativesHost: Miniflare;
let derivatives: R2Bucket;
let env: Bindings;

beforeAll(async () => {
  harness = await startComputeHarness();
  derivativesHost = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2024-12-01",
    r2Buckets: ["COMPUTE_DERIVATIVES"],
  });
  derivatives = (await derivativesHost.getR2Bucket("COMPUTE_DERIVATIVES")) as unknown as R2Bucket;
}, 120_000);

beforeEach(async () => {
  await harness.reset();
  env = harness.env({
    // The promotion reads only D1; the store must be bound and named for it, as in production.
    COMPUTE_DERIVATIVES: derivatives,
    COMPUTE_DERIVATIVES_BUCKET_NAME: "nemar-compute-derivatives",
  });
});

afterAll(async () => {
  await harness?.dispose();
  await derivativesHost?.dispose();
}, 30_000);

// biome-ignore lint/suspicious/noExplicitAny: rows are read field by field
type Loose = Record<string, any>;

let seq = 0;
const DOCUMENT = "desc-nemarica_dataquality.json";
const DATASET_RECORD = "desc-nemarica_signalJourney.json";
const TABLE = "desc-nemarica_recordings.tsv";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A finished nemar-ica run of a new dataset: its stamp, and its product where the launcher uploads it,
 * each file as `edit` leaves it (`null` leaves a file out).
 */
async function finishedRun(
  edit: (files: Map<string, Uint8Array>) => void = () => {},
  state: "succeeded" | "failed" = "succeeded",
  /** Another run of a dataset already seeded, at another version (its summary says so). */
  of?: { datasetId: string; version: string },
) {
  const datasetId = of?.datasetId ?? `nm${String(9100 + ++seq).padStart(6, "0")}`;
  if (of === undefined) await seedEegDataset(env, datasetId);
  const jobId = newJobId();
  const stampId = await seedIcaStamp(env.DB, { datasetId, jobId, state, version: of?.version });
  const files = productFiles();
  if (of !== undefined) {
    edited(files, DOCUMENT, (doc) => {
      doc.recipes["nemar-ica"].dataset_version = of.version;
    });
  }
  edit(files);
  for (const [rel, bytes] of files) {
    await harness.results.put(resultsOutputKey(jobId, `product/${rel}`), bytes);
  }
  return { datasetId, jobId, stampId, files };
}

const kept = (stampId: number) =>
  env.DB.prepare("SELECT * FROM compute_quality_documents WHERE stamp_id = ?1")
    .bind(stampId)
    .first<Loose>();
const runRow = (stampId: number) =>
  env.DB.prepare("SELECT outcome FROM compute_pipeline_progress_runs WHERE stamp_id = ?1")
    .bind(stampId)
    .first<{ outcome: string }>();

const edited = (files: Map<string, Uint8Array>, name: string, edit: (doc: Loose) => void) => {
  const doc = JSON.parse(new TextDecoder().decode(files.get(name))) as Loose;
  edit(doc);
  files.set(name, new TextEncoder().encode(JSON.stringify(doc)));
};

describe("a succeeded run's dataset summary", () => {
  test("is kept for its stamp, bound to the stamp's dataset, naming the bytes the run's link names", async () => {
    const run = await finishedRun();
    expect(await reconcilePipelineProgress(env)).toMatchObject({ reconciled: 1, errored: 0 });
    expect((await runRow(run.stampId))?.outcome).toBe("reconciled");
    const row = await kept(run.stampId);
    // The document names no dataset and its record names on007823: the row is the stamp's.
    expect(row).toMatchObject({ dataset_id: run.datasetId, recipe: "nemar-ica" });
    expect(JSON.parse(row?.entry)).toEqual(fixtureEntry());
    const recordSha = await sha256Hex(run.files.get(DATASET_RECORD) as Uint8Array);
    expect(row?.record_sha256).toBe(recordSha);
    const link = await env.DB.prepare(
      "SELECT link FROM compute_pipeline_progress_runs WHERE stamp_id = ?1",
    )
      .bind(run.stampId)
      .first<{ link: string }>();
    expect(JSON.parse(link?.link as string).sha256).toBe(recordSha);
    // The recipe's quality checkpoint, nemar-quality and nemar-spectrum, passed for the one recording.
    const quality = await env.DB.prepare(
      "SELECT passed, total FROM compute_pipeline_progress WHERE stamp_id = ?1 AND checkpoint = 'quality'",
    )
      .bind(run.stampId)
      .first<Loose>();
    expect(quality).toEqual({ passed: 1, total: 1 });
  });

  test("that names another record is not kept, and the run is reconciled (MUTATION: skip the digest check)", async () => {
    const run = await finishedRun((files) => {
      // The same record, written again: another file, so another digest.
      edited(files, DATASET_RECORD, () => {});
    });
    const lines = await logged(async () => {
      await reconcilePipelineProgress(env);
    });
    expect(await kept(run.stampId)).toBeNull();
    expect((await runRow(run.stampId))?.outcome).toBe("reconciled");
    expect(lines).toContain(
      `[compute-pipeline-progress] quality_not_written stamp=${run.stampId} reason=record_digest_mismatch`,
    );
  });

  test("that counts other recordings than the table is not kept (MUTATION: drop the counts check)", async () => {
    const run = await finishedRun((files) => {
      const table = new TextDecoder().decode(files.get(TABLE));
      const [header, row] = table.trimEnd().split("\n");
      const failed = (row as string)
        .replace("sub-CUCOV076", "sub-CUCOV077")
        .replace("\tsucceeded\tn/a\tn/a\t", "\tfailed\tload_failed\tload\t");
      files.set(TABLE, new TextEncoder().encode(`${header}\n${row}\n${failed}\n`));
    });
    const lines = await logged(async () => {
      await reconcilePipelineProgress(env);
    });
    expect(await kept(run.stampId)).toBeNull();
    expect(lines).toContain(
      `[compute-pipeline-progress] quality_not_written stamp=${run.stampId} reason=counts_mismatch`,
    );
  });

  test("that names a plugin the recipe does not run is not kept (MUTATION: accept any prefix)", async () => {
    const run = await finishedRun((files) =>
      edited(files, DOCUMENT, (doc) => {
        const e = doc.recipes["nemar-ica"];
        e.distributions["nemar-floor-extra:x"] = e.distributions.icaRank;
        e.observed_range["nemar-floor-extra:x"] = e.observed_range.icaRank;
      }),
    );
    const lines = await logged(async () => {
      await reconcilePipelineProgress(env);
    });
    expect(await kept(run.stampId)).toBeNull();
    expect(lines).toContain(
      `[compute-pipeline-progress] quality_not_written stamp=${run.stampId} reason=metric_unknown_plugin`,
    );
  });

  test("that outgrows the column when written again is not kept, and the run is reconciled (MUTATION: drop the entry size check)", async () => {
    // The review's construction (#2375): 62,641 bytes, every rule kept, edges written `1000e17, ...`, an
    // entry of over 146,000 characters that the 0157 CHECK would refuse, failing the whole batch.
    const run = await finishedRun((files) => files.set(DOCUMENT, wideEdgesDocument()));
    const lines = await logged(async () => {
      expect(await reconcilePipelineProgress(env)).toMatchObject({ reconciled: 1, errored: 0 });
    });
    expect((await runRow(run.stampId))?.outcome).toBe("reconciled");
    expect(await kept(run.stampId)).toBeNull();
    expect(lines).toContain(
      `[compute-pipeline-progress] quality_not_written stamp=${run.stampId} reason=entry_too_large`,
    );
  });

  test("that is missing, or of a failed run, is not kept", async () => {
    const missing = await finishedRun((files) => files.delete(DOCUMENT));
    const failed = await finishedRun(() => {}, "failed");
    const lines = await logged(async () => {
      await reconcilePipelineProgress(env);
    });
    expect(await kept(missing.stampId)).toBeNull();
    expect(await kept(failed.stampId)).toBeNull();
    expect((await runRow(missing.stampId))?.outcome).toBe("reconciled");
    expect((await runRow(failed.stampId))?.outcome).toBe("reconciled");
    expect(lines).toContain(
      `[compute-pipeline-progress] quality_not_written stamp=${missing.stampId} reason=document_missing`,
    );
    expect(lines.some((l) => l.includes(`stamp=${failed.stampId} reason=`))).toBe(false);
  });

  test("that cannot be read now leaves the run for a later call (MUTATION: write the run without it)", async () => {
    const run = await finishedRun();
    const documentKey = resultsOutputKey(run.jobId, `product/${DOCUMENT}`);
    // The results bucket stops answering for the one file, as an outage of R2 would.
    const real = harness.results;
    const failing = {
      get: (k: string) => (k === documentKey ? Promise.reject(new Error("outage")) : real.get(k)),
      head: (k: string) => (k === documentKey ? Promise.reject(new Error("outage")) : real.head(k)),
      list: real.list.bind(real),
      put: real.put.bind(real),
      delete: real.delete.bind(real),
    } as unknown as R2Bucket;
    const later = await reconcilePipelineProgress({ ...env, COMPUTE_RESULTS: failing });
    expect(later).toMatchObject({ reconciled: 0, later: 1 });
    expect(await runRow(run.stampId)).toBeNull();
    expect(await reconcilePipelineProgress(env)).toMatchObject({ reconciled: 1 });
    expect(await kept(run.stampId)).not.toBeNull();
  });

  test("the registry names the files nemar-process writes (MUTATION: another label or suffix)", () => {
    expect(recipeRequiredOutputs(ICA)).toEqual({
      record: `product/${DATASET_RECORD}`,
      table: `product/${TABLE}`,
    });
    expect(recipeQualityDocumentPath(ICA)).toBe(`product/${DOCUMENT}`);
  });
});

describe("a page shows a summary once its derivative is promoted", () => {
  const validateExtensions = compileNeuroschemaValidator(
    "nsc:/extensions/extensionsContainer.schema.json",
  );

  test("no derivative and a canary show nothing; the real promotion shows the run's summary, counts and link together (MUTATION: drop the retention term)", async () => {
    const run = await finishedRun();
    await reconcilePipelineProgress(env);
    expect(await kept(run.stampId)).not.toBeNull();
    expect(await readPipelineExtensions(env.DB, run.datasetId)).toEqual({});

    const key = await seedDerivative(env.DB, {
      datasetId: run.datasetId,
      stampId: run.stampId,
      jobId: run.jobId,
    });
    expect(await readPipelineExtensions(env.DB, run.datasetId)).toEqual({});

    const promoted = await promoteDerivative(env, {
      key,
      to: "catalog",
      userId: 1,
      role: "admin",
    });
    expect(promoted.ok).toBe(true);
    const extensions = await readPipelineExtensions(env.DB, run.datasetId);
    expect(extensions.dataQuality).toEqual({
      level: "dataset",
      recipes: { "nemar-ica": fixtureEntry() },
    });
    // The same run's counts (one recording, passed everywhere, stored kept) and the link to the very record
    // its summary names.
    const counts = { passed: 1, failed: 0, skipped: 0, total: 1 };
    expect(extensions.processing?.recipes["nemar-ica"]).toEqual({
      recipe_version: ICA.version,
      declared_checkpoints: declaredCheckpoints(ICA),
      counts: Object.fromEntries(declaredCheckpoints(ICA).map((c) => [c, counts])),
    });
    const recordSha = await sha256Hex(run.files.get(DATASET_RECORD) as Uint8Array);
    expect(extensions.signalJourney?.recipes["nemar-ica"]).toMatchObject({
      processing_status: "completed",
      location: DATASET_RECORD,
      sha256: recordSha,
    });
    expect(
      (extensions.dataQuality?.recipes["nemar-ica"] as { record_sha256: string }).record_sha256,
    ).toBe(recordSha);
    if (!validateExtensions(extensions)) throw new Error(formatAjvErrors(validateExtensions));
  });

  test("a superseded catalog row is replaced, however new it is (MUTATION: drop either superseded term)", async () => {
    // A is stored after B; promoting A then B supersedes A (ADR 0123), so the page shows B's summary.
    const a = await finishedRun();
    const b = await finishedRun(() => {}, "succeeded", {
      datasetId: a.datasetId,
      version: "v1.0.1",
    });
    await reconcilePipelineProgress(env);
    expect(await kept(a.stampId)).not.toBeNull();
    expect(await kept(b.stampId)).not.toBeNull();
    const keyA = await seedDerivative(env.DB, {
      datasetId: a.datasetId,
      stampId: a.stampId,
      jobId: a.jobId,
      storedAt: "2026-11-21 10:00:00",
    });
    const keyB = await seedDerivative(env.DB, {
      datasetId: a.datasetId,
      stampId: b.stampId,
      jobId: b.jobId,
      storedAt: "2026-11-20 10:00:00",
    });
    const shown = async () =>
      (
        (await readPipelineExtensions(env.DB, a.datasetId)).dataQuality?.recipes["nemar-ica"] as
          | Loose
          | undefined
      )?.dataset_version;
    const admin = { to: "catalog" as const, userId: 1, role: "admin" };
    expect((await promoteDerivative(env, { key: keyA, ...admin })).ok).toBe(true);
    expect(await shown()).toBe("v1.0.0");
    expect((await promoteDerivative(env, { key: keyB, ...admin })).ok).toBe(true);
    const superseded = await env.DB.prepare(
      "SELECT superseded_at FROM compute_derivatives WHERE key = ?1",
    )
      .bind(keyA)
      .first<{ superseded_at: string | null }>();
    expect(superseded?.superseded_at).not.toBeNull();
    expect(await shown()).toBe("v1.0.1");
    // B alone is current: A is not a second row the read happens to overwrite.
    const current = await env.DB.prepare(CURRENT_QUALITY_DOCUMENTS_SQL)
      .bind(a.datasetId)
      .all<Loose>();
    expect(current.results.map((r) => JSON.parse(r.entry).dataset_version)).toEqual(["v1.0.1"]);
  });

  test("a superseded row the owner then publishes is public again (MUTATION: drop the published clause, or keep it on the inner rows only)", async () => {
    // The review's sequence (#2375 round 2): publishing never clears `superseded_at`.
    const a = await finishedRun();
    const b = await finishedRun(() => {}, "succeeded", {
      datasetId: a.datasetId,
      version: "v1.0.1",
    });
    await reconcilePipelineProgress(env);
    const keyA = await seedDerivative(env.DB, {
      datasetId: a.datasetId,
      stampId: a.stampId,
      jobId: a.jobId,
      storedAt: "2026-11-21 10:00:00",
    });
    const keyB = await seedDerivative(env.DB, {
      datasetId: a.datasetId,
      stampId: b.stampId,
      jobId: b.jobId,
      storedAt: "2026-11-20 10:00:00",
    });
    const admin = { to: "catalog" as const, userId: 1, role: "admin" };
    expect((await promoteDerivative(env, { key: keyA, ...admin })).ok).toBe(true);
    expect((await promoteDerivative(env, { key: keyB, ...admin })).ok).toBe(true);
    const published = await promoteDerivative(env, {
      key: keyA,
      to: "published",
      userId: 1,
      role: "owner",
    });
    expect(published.ok).toBe(true);
    const row = await env.DB.prepare(
      "SELECT retention, superseded_at FROM compute_derivatives WHERE key = ?1",
    )
      .bind(keyA)
      .first<{ retention: string; superseded_at: string | null }>();
    expect(row?.retention).toBe("published");
    expect(row?.superseded_at).not.toBeNull();
    const extensions = await readPipelineExtensions(env.DB, a.datasetId);
    expect(
      (extensions.dataQuality?.recipes["nemar-ica"] as Loose | undefined)?.dataset_version,
    ).toBe("v1.0.0");
    const current = await env.DB.prepare(CURRENT_QUALITY_DOCUMENTS_SQL)
      .bind(a.datasetId)
      .all<Loose>();
    expect(current.results.map((r) => JSON.parse(r.entry).dataset_version)).toEqual(["v1.0.0"]);
  });
});
