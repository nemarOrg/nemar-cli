/**
 * The dataset-level neuroschema `processing` and `signalJourney` extensions of NEMAR's pipeline in
 * `GET /:id/metadata.json` (ADR 0134 decision 9 as amended 2026-11-26, epic #2324 phase B4), through the
 * real `dataRoutes` router over a real bun:sqlite D1 carrying every production migration. The rows are
 * written with SQL the tables accept, as reconciliation and the derivative store leave them
 * (`compute-progress-reconcile.test.ts` drives those writers); the seeded datasets have no version row, so
 * the handler reaches no bucket.
 *
 * What is pinned, each case by the mutation it names: both entries describe each recipe's PROMOTED run
 * (its current public derivative) and validate against the vendored neuroschema extensions container; the
 * `stored` counts are the kept rule over the last declared checkpoint; a run in progress, a canary run and
 * a failed run show nothing, and no `in_progress` link is ever served; a newer promoted run replaces an
 * older one; counts that break the writer's rules show no entry; a private dataset, a concealed deposit and a
 * withdrawn dataset get nothing.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  compileNeuroschemaValidator,
  formatAjvErrors,
} from "../../test/contract/neuroschema-validator";
import { dataRoutes } from "../src/routes/data";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { logged } from "./helpers/logs";
import { newJobId, seedDerivative, seedIcaStamp } from "./helpers/quality-fixture";

/** The document's `extensions`, judged by the vendored neuroschema extensions container. */
const validateExtensions = compileNeuroschemaValidator(
  "nsc:/extensions/extensionsContainer.schema.json",
);

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

const env = (): Bindings => ({ DB: realD1(db), ENVIRONMENT: "test" }) as Bindings;

function seed(
  id: string,
  over: { visibility?: string; anonymous?: number; withdrawnAt?: string } = {},
): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox, anonymous, modalities,
                           first_published_at, withdrawn_at)
     VALUES (?, ?, -1, 'active', ?, 0, ?, 'eeg', ?, ?)`,
    [
      id,
      id,
      over.visibility ?? "public",
      over.anonymous ?? 0,
      // A concealed deposit is never published (a trigger refuses the pair).
      over.anonymous === 1 ? null : "2026-01-01 00:00:00",
      over.withdrawnAt ?? null,
    ],
  );
}

const DECLARED = ["import", "preprocess", "quality", "stored"];
/** Reconciled counts of a four-recording run: two reached the last checkpoint. */
const COUNTS: Record<string, [number, number, number, number]> = {
  import: [3, 1, 0, 4],
  preprocess: [2, 1, 1, 4],
  quality: [2, 0, 2, 4],
};
const linkFor = (sha: string) => ({
  recipe_version: "1.0.0",
  processing_status: "completed",
  location: "desc-nemarfloor_signalJourney.json",
  sha256: sha.repeat(64),
  sj_version: "0.1.0",
});

/**
 * One ended run of nemar-floor on the dataset, as reconciliation leaves it: its stamp, its run row (outcome,
 * recipe version, declared order, link) and its reconciled counts, the `stored` row still pending. With
 * `derivative`, its derivative row as the store leaves it. Returns the stamp id.
 */
async function endedRun(
  id: string,
  over: {
    state?: "succeeded" | "failed";
    link?: string | null;
    counts?: Record<string, [number, number, number, number]>;
    derivative?: { retention: "canary" | "catalog" | "published"; storedAt?: string };
  } = {},
): Promise<number> {
  const d1 = realD1(db);
  const jobId = newJobId();
  const runs = (
    db.query("SELECT COUNT(*) AS n FROM compute_pipeline_stamps WHERE dataset_id = ?").get(id) as {
      n: number;
    }
  ).n;
  const stampId = await seedIcaStamp(d1, {
    datasetId: id,
    jobId,
    state: over.state ?? "succeeded",
    version: `v1.0.${runs}`,
    recipe: "nemar-floor",
  });
  db.run(
    `INSERT INTO compute_pipeline_progress_runs (stamp_id, job_id, reports, reconciled_at, outcome,
       recipe_version, declared, link)
     VALUES (?, ?, 0, datetime('now'), 'reconciled', '1.0.0', ?, ?)`,
    [
      stampId,
      jobId,
      JSON.stringify(DECLARED),
      over.link === undefined ? JSON.stringify(linkFor("a")) : over.link,
    ],
  );
  for (const [checkpoint, [p, f, s, t]] of Object.entries(over.counts ?? COUNTS)) {
    db.run(
      `INSERT INTO compute_pipeline_progress (stamp_id, checkpoint, passed, failed, skipped, total,
         reported_at, reconciled)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 1)`,
      [stampId, checkpoint, p, f, s, t],
    );
  }
  db.run(
    `INSERT INTO compute_pipeline_progress (stamp_id, checkpoint, passed, failed, skipped, total,
       reported_at, reconciled)
     VALUES (?, 'stored', 0, 0, 2, 4, datetime('now'), 0)`,
    [stampId],
  );
  if (over.derivative) {
    await seedDerivative(d1, {
      datasetId: id,
      stampId,
      jobId,
      recipe: "nemar-floor",
      recipeVersion: "1.0.0",
      retention: over.derivative.retention,
      storedAt: over.derivative.storedAt,
      qualityPlugins: "[]",
    });
  }
  return stampId;
}

/** A run of nemar-floor dispatched and reporting now: its job running, its run row not reconciled. */
function reporting(id: string): void {
  db.run(
    `INSERT INTO compute_jobs (id, account_id, source, kind, app_id, app_version, spec_digest,
                               partition, pool, nodes, cores_per_node, minutes, state, held_milli)
     VALUES ('job_0123456789abcdef01234567', 1, 'pipeline', 'batch', 'nemar-launch', '1.0.0', ?, 'shared',
             'cpu', 1, 4, 60, 'running', 0)`,
    ["d".repeat(64)],
  );
  db.run(
    `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, attempt, state, job_id, input)
     VALUES (?, 'v9.9.9', 'nemar-floor', '1.0.1', 'eegprep@0.5.0', 1, 'dispatched', 'job_0123456789abcdef01234567', 'bids')`,
    [id],
  );
  const stamp = (
    db.query("SELECT MAX(id) AS id FROM compute_pipeline_stamps").get() as { id: number }
  ).id;
  db.run(
    "INSERT INTO compute_pipeline_progress_runs (stamp_id, job_id, reports, reported_at) VALUES (?, 'job_0123456789abcdef01234567', 1, datetime('now'))",
    [stamp],
  );
}

const PROCESSING = {
  recipe_version: "1.0.0",
  declared_checkpoints: DECLARED,
  counts: {
    import: { passed: 3, failed: 1, skipped: 0, total: 4 },
    preprocess: { passed: 2, failed: 1, skipped: 1, total: 4 },
    quality: { passed: 2, failed: 0, skipped: 2, total: 4 },
    stored: { passed: 2, failed: 0, skipped: 2, total: 4 },
  },
};

async function get(id: string) {
  const res = await app.request(`/${id}/metadata.json`, {}, env());
  return {
    status: res.status,
    // biome-ignore lint/suspicious/noExplicitAny: the document is read field by field
    body: (res.status === 200 ? await res.json() : null) as Record<string, any> | null,
  };
}

beforeEach(() => {
  db = freshDb();
  app = new Hono();
  app.route("/", dataRoutes);
});

describe("pipeline extensions in metadata.json describe the promoted run", () => {
  test("its processing entry, with stored kept, and its link are served, and the extensions validate (MUTATION: stored as never made)", async () => {
    seed("nm000501");
    await endedRun("nm000501", { derivative: { retention: "catalog" } });
    const { status, body } = await get("nm000501");
    expect(status).toBe(200);
    expect(body?.extensions.processing).toEqual({
      level: "dataset",
      recipes: { "nemar-floor": PROCESSING },
    });
    expect(body?.extensions.signalJourney).toEqual({
      recipes: { "nemar-floor": linkFor("a") },
    });
    if (!validateExtensions(body?.extensions)) throw new Error(formatAjvErrors(validateExtensions));
  });

  test("a run in progress shows no in_progress link and leaves the promoted run's entries standing", async () => {
    seed("nm000502");
    await endedRun("nm000502", { derivative: { retention: "published" } });
    reporting("nm000502");
    const { body } = await get("nm000502");
    expect(body?.extensions.signalJourney.recipes["nemar-floor"]).toEqual(linkFor("a"));
    expect(body?.extensions.processing.recipes["nemar-floor"]).toEqual(PROCESSING);
  });

  test("a run in progress, a canary run and a failed run show nothing on their own (MUTATION: drop the public derivative term)", async () => {
    seed("nm000503");
    reporting("nm000503");
    await endedRun("nm000503", { derivative: { retention: "canary" } });
    await endedRun("nm000503", { state: "failed", link: null });
    const { body } = await get("nm000503");
    expect(Object.keys(body?.extensions ?? {})).toEqual(["nemar"]);
  });

  test("a newer unpromoted run never replaces the promoted one; a newer promoted run does, on both namespaces", async () => {
    seed("nm000504");
    await endedRun("nm000504", {
      derivative: { retention: "catalog", storedAt: "2026-11-20 10:00:00" },
    });
    await endedRun("nm000504", {
      link: JSON.stringify(linkFor("b")),
      derivative: { retention: "canary", storedAt: "2026-11-21 10:00:00" },
    });
    expect((await get("nm000504")).body?.extensions.signalJourney.recipes["nemar-floor"]).toEqual(
      linkFor("a"),
    );
    await endedRun("nm000504", {
      link: JSON.stringify(linkFor("c")),
      counts: { import: [4, 0, 0, 4], preprocess: [4, 0, 0, 4], quality: [4, 0, 0, 4] },
      derivative: { retention: "catalog", storedAt: "2026-11-22 10:00:00" },
    });
    const { body } = await get("nm000504");
    expect(body?.extensions.signalJourney.recipes["nemar-floor"]).toEqual(linkFor("c"));
    expect(body?.extensions.processing.recipes["nemar-floor"].counts.stored).toEqual({
      passed: 4,
      failed: 0,
      skipped: 0,
      total: 4,
    });
  });

  test("a promoted run with no link shows its counts alone; one whose counts break the rules shows its link alone, with a log line", async () => {
    seed("nm000505");
    await endedRun("nm000505", { link: null, derivative: { retention: "catalog" } });
    const { body } = await get("nm000505");
    expect(body?.extensions.processing.recipes["nemar-floor"]).toEqual(PROCESSING);
    expect(body?.extensions).not.toHaveProperty("signalJourney");
    seed("nm000506");
    await endedRun("nm000506", {
      // More recordings pass a later checkpoint than an earlier one: the cascade is broken.
      counts: { import: [1, 3, 0, 4], preprocess: [2, 0, 2, 4], quality: [2, 0, 2, 4] },
      derivative: { retention: "catalog" },
    });
    let second: Awaited<ReturnType<typeof get>> | null = null;
    const lines = await logged(async () => {
      second = await get("nm000506");
    });
    const answer = second as Awaited<ReturnType<typeof get>> | null;
    expect(answer?.body?.extensions).not.toHaveProperty("processing");
    expect(answer?.body?.extensions.signalJourney.recipes["nemar-floor"]).toEqual(linkFor("a"));
    expect(lines.join("\n")).toContain(
      "processing_not_shown dataset=nm000506 recipe=nemar-floor reason=cascade_broken",
    );
  });

  test("a private dataset, a concealed deposit and a withdrawn dataset get nothing", async () => {
    seed("nm000507", { visibility: "private" });
    await endedRun("nm000507", { derivative: { retention: "catalog" } });
    expect((await get("nm000507")).status).toBe(404);
    seed("nm000508", { anonymous: 1 });
    await endedRun("nm000508", { derivative: { retention: "catalog" } });
    const concealed = await get("nm000508");
    expect(concealed.status).toBe(200);
    expect(concealed.body?.extensions).not.toHaveProperty("processing");
    expect(concealed.body?.extensions).not.toHaveProperty("signalJourney");
    seed("nm000509", { withdrawnAt: "2026-11-24 10:00:00" });
    await endedRun("nm000509", { derivative: { retention: "catalog" } });
    const withdrawn = await get("nm000509");
    expect(withdrawn.body?.extensions).not.toHaveProperty("processing");
    expect(withdrawn.body?.extensions).not.toHaveProperty("signalJourney");
  });
});
