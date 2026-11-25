/**
 * The dataset-level neuroschema `dataQuality` in `GET /:id/metadata.json` and `GET /:id/page-bundle.json`
 * (ADR 0137 decisions 7 and 8, epic #2324 phase B1, #2331), through the real `dataRoutes` router over a
 * real bun:sqlite D1 carrying every production migration. The summaries are nemar-ica's real one (copied
 * from nemar-process P7); the stamps, derivatives and summaries are rows written with SQL the tables
 * accept, as the derivative store and reconciliation leave them (`quality-documents.test.ts` drives those
 * writers). The seeded datasets have no version row, so neither handler reaches a bucket.
 *
 * What is pinned, each case by the mutation it names:
 *  - only a recipe's CURRENT PUBLIC derivative shows: stored, `catalog` or `published`, the newest by
 *    `stored_at` (the larger key on a tie); a canary, a copying, failed or expired row never does, and a
 *    current derivative without a summary shows none rather than an older run's;
 *  - the dataset is bound from the rows, never from a summary: a summary kept for another dataset's stamp
 *    never shows;
 *  - a private dataset is a 404 on both documents, and a concealed deposit gets no pipeline namespace;
 *  - `metadata.json` and the page bundle carry the same `processing`, `signalJourney` (an `in_progress`
 *    link included) and `dataQuality`, and the extensions validate against the vendored neuroschema.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  compileNeuroschemaValidator,
  formatAjvErrors,
} from "../../test/contract/neuroschema-validator";
import { dataRoutes } from "../src/routes/data";
import { CURRENT_QUALITY_DOCUMENTS_SQL } from "../src/services/quality-documents";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { fixtureEntry, newJobId, seedDerivative, seedIcaStamp } from "./helpers/quality-fixture";

const validateExtensions = compileNeuroschemaValidator(
  "nsc:/extensions/extensionsContainer.schema.json",
);

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

const env = (): Bindings => ({ DB: realD1(db), ENVIRONMENT: "test" }) as Bindings;
// biome-ignore lint/suspicious/noExplicitAny: documents are read field by field
type Loose = Record<string, any>;

const ENTRY = fixtureEntry();

function seedDataset(
  id: string,
  over: { visibility?: string; anonymous?: number; withdrawnAt?: string } = {},
): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox, anonymous, modalities,
                           withdrawn_at)
     VALUES (?, ?, -1, 'active', ?, 0, ?, 'eeg', ?)`,
    [id, id, over.visibility ?? "public", over.anonymous ?? 0, over.withdrawnAt ?? null],
  );
}

/** A run of the dataset with its kept summary (`entry`, or none), and its derivative as given. */
async function run(
  datasetId: string,
  over: {
    entry?: Loose | null;
    retention?: "canary" | "catalog" | "published";
    state?: "copying" | "stored" | "failed" | "expired";
    storedAt?: string;
    key?: string;
    summaryDataset?: string;
    recipe?: string;
    supersededAt?: string | null;
    expiresAt?: string | null;
  } = {},
) {
  const d1 = realD1(db);
  const jobId = newJobId();
  // Each run reads its own version, so each holds its own succeeded stamp.
  const runs = (
    db
      .query("SELECT COUNT(*) AS n FROM compute_pipeline_stamps WHERE dataset_id = ?")
      .get(datasetId) as { n: number }
  ).n;
  const stampId = await seedIcaStamp(d1, {
    datasetId,
    jobId,
    version: `v1.0.${runs}`,
    recipe: over.recipe,
  });
  const key = await seedDerivative(d1, {
    datasetId,
    stampId,
    jobId,
    recipe: over.recipe,
    retention: over.retention ?? "catalog",
    state: over.state,
    storedAt: over.storedAt,
    key: over.key,
    supersededAt: over.supersededAt,
    expiresAt: over.expiresAt,
  });
  const entry = over.entry === undefined ? ENTRY : over.entry;
  if (entry !== null) {
    db.run(
      "INSERT INTO compute_quality_documents (stamp_id, dataset_id, recipe, entry, record_sha256) VALUES (?, ?, ?, ?, ?)",
      [
        stampId,
        over.summaryDataset ?? datasetId,
        over.recipe ?? "nemar-ica",
        JSON.stringify(entry),
        "4".repeat(64),
      ],
    );
  }
  return { stampId, key, jobId };
}

async function metadata(id: string) {
  const res = await app.request(`/${id}/metadata.json`, {}, env());
  return {
    status: res.status,
    body: (res.status === 200 ? await res.json() : null) as Loose | null,
  };
}

async function bundleMetadata(id: string) {
  const res = await app.request(`/${id}/page-bundle.json`, {}, env());
  if (res.status !== 200) return { status: res.status, data: null };
  const body = (await res.json()) as Loose;
  expect(body.metadata.ok).toBe(true);
  return {
    status: res.status,
    data: body.metadata.data as Loose,
    complete: body.complete,
    pipelineDegraded: body.pipeline_degraded,
    cacheControl: res.headers.get("Cache-Control"),
  };
}

const quality = async (id: string) => (await metadata(id)).body?.extensions.dataQuality;

beforeEach(() => {
  db = freshDb();
  app = new Hono();
  app.route("/", dataRoutes);
});

describe("which derivative's summary a page shows", () => {
  test("a promoted derivative's summary is served, and the extensions validate", async () => {
    seedDataset("nm000901");
    await run("nm000901", { retention: "catalog" });
    const { status, body } = await metadata("nm000901");
    expect(status).toBe(200);
    expect(body?.extensions.dataQuality).toEqual({
      level: "dataset",
      recipes: { "nemar-ica": ENTRY },
    });
    if (!validateExtensions(body?.extensions)) throw new Error(formatAjvErrors(validateExtensions));
  });

  test("a canary never shows (MUTATION: drop the retention term)", async () => {
    seedDataset("nm000902");
    await run("nm000902", { retention: "canary" });
    expect(await quality("nm000902")).toBeUndefined();
    seedDataset("nm000903");
    await run("nm000903", { retention: "published" });
    expect((await quality("nm000903"))?.recipes["nemar-ica"]).toEqual(ENTRY);
  });

  test("a copying, failed or expired derivative never shows (MUTATION: drop the state term)", async () => {
    for (const [id, state] of [
      ["nm000904", "copying"],
      ["nm000905", "failed"],
      ["nm000906", "expired"],
    ] as const) {
      seedDataset(id);
      await run(id, { retention: "catalog", state });
      expect(await quality(id), state).toBeUndefined();
    }
  });

  test("the newest by stored_at wins, and a newer canary does not displace it (MUTATION: order by key alone)", async () => {
    seedDataset("nm000907");
    const older = { ...ENTRY, dataset_version: "v1.0.0" };
    const newer = { ...ENTRY, dataset_version: "v1.0.1" };
    await run("nm000907", { entry: newer, storedAt: "2026-11-21 10:00:00", key: "1".repeat(64) });
    await run("nm000907", { entry: older, storedAt: "2026-11-20 10:00:00", key: "f".repeat(64) });
    await run("nm000907", {
      entry: { ...ENTRY, dataset_version: "v9.9.9" },
      retention: "canary",
      storedAt: "2026-11-22 10:00:00",
    });
    expect((await quality("nm000907"))?.recipes["nemar-ica"].dataset_version).toBe("v1.0.1");
  });

  test("a superseded catalog row is never current, however new (MUTATION: drop either superseded term)", async () => {
    seedDataset("nm000913");
    // The newer row was superseded by a later promotion of the older one (ADR 0123).
    await run("nm000913", {
      entry: { ...ENTRY, dataset_version: "superseded" },
      storedAt: "2026-11-22 10:00:00",
      supersededAt: "2026-11-23 10:00:00",
      expiresAt: "2099-01-01 00:00:00",
    });
    await run("nm000913", {
      entry: { ...ENTRY, dataset_version: "current" },
      storedAt: "2026-11-20 10:00:00",
    });
    expect((await quality("nm000913"))?.recipes["nemar-ica"].dataset_version).toBe("current");
    // One current derivative per recipe: the superseded row is not a second one the read would overwrite.
    const rows = db.query(CURRENT_QUALITY_DOCUMENTS_SQL).all("nm000913") as Loose[];
    expect(rows.map((r) => JSON.parse(r.entry).dataset_version)).toEqual(["current"]);
  });

  test("a row past its date is never current, and never hides an older one (MUTATION: drop either date term)", async () => {
    seedDataset("nm000914");
    await run("nm000914", {
      entry: { ...ENTRY, dataset_version: "dated" },
      storedAt: "2026-01-02 10:00:00",
      expiresAt: "2026-01-03 00:00:00",
    });
    await run("nm000914", {
      entry: { ...ENTRY, dataset_version: "current" },
      storedAt: "2026-01-01 10:00:00",
    });
    expect((await quality("nm000914"))?.recipes["nemar-ica"].dataset_version).toBe("current");
    seedDataset("nm000915");
    await run("nm000915", { storedAt: "2026-01-02 10:00:00", expiresAt: "2026-01-03 00:00:00" });
    expect(await quality("nm000915")).toBeUndefined();
  });

  test("a tie on stored_at goes to the larger key", async () => {
    seedDataset("nm000908");
    await run("nm000908", { entry: { ...ENTRY, dataset_version: "small" }, key: "2".repeat(64) });
    await run("nm000908", { entry: { ...ENTRY, dataset_version: "large" }, key: "e".repeat(64) });
    expect((await quality("nm000908"))?.recipes["nemar-ica"].dataset_version).toBe("large");
  });

  test("a current derivative without a summary shows none, never an older run's (MUTATION: pick the newest summary)", async () => {
    seedDataset("nm000909");
    await run("nm000909", { storedAt: "2026-11-20 10:00:00" });
    await run("nm000909", { entry: null, storedAt: "2026-11-21 10:00:00" });
    expect(await quality("nm000909")).toBeUndefined();
  });

  test("a summary kept for another dataset never shows (MUTATION: drop the dataset bind on the summary)", async () => {
    seedDataset("nm000910");
    seedDataset("nm000911");
    // A summary row that names nm000911 for a stamp whose derivative is nm000910's.
    await run("nm000910", { summaryDataset: "nm000911" });
    expect(await quality("nm000910")).toBeUndefined();
    expect(await quality("nm000911")).toBeUndefined();
  });

  test("each recipe shows its own current summary; an entry that does not parse is left out", async () => {
    seedDataset("nm000912");
    await run("nm000912");
    const floorEntry = { ...ENTRY, recipe_version: "1.0.0-b2" };
    await run("nm000912", { recipe: "nemar-floor", entry: floorEntry });
    expect(Object.keys((await quality("nm000912"))?.recipes ?? {})).toEqual([
      "nemar-floor",
      "nemar-ica",
    ]);
    db.run("UPDATE compute_quality_documents SET entry = '{not json' WHERE recipe = 'nemar-floor'");
    expect(Object.keys((await quality("nm000912"))?.recipes ?? {})).toEqual(["nemar-ica"]);
  });
});

describe("the dataset's gate", () => {
  test("a private dataset is a 404 on both documents", async () => {
    seedDataset("nm000920", { visibility: "private" });
    await run("nm000920");
    expect((await metadata("nm000920")).status).toBe(404);
    expect((await bundleMetadata("nm000920")).status).toBe(404);
  });

  test("a concealed deposit gets no pipeline namespace on either document (MUTATION: drop the anonymous gate)", async () => {
    seedDataset("nm000921", { anonymous: 1 });
    await run("nm000921");
    db.run(
      "INSERT INTO compute_pipeline_documents (dataset_id, namespace, recipe, stamp_id, entry) VALUES ('nm000921', 'signalJourney', 'nemar-ica', 1, ?)",
      [
        JSON.stringify({
          recipe_version: "1.0.0-b2",
          processing_status: "failed",
          location: null,
          sha256: null,
          sj_version: null,
        }),
      ],
    );
    const meta = await metadata("nm000921");
    expect(meta.status).toBe(200);
    expect(meta.body?.extensions).not.toHaveProperty("dataQuality");
    expect(meta.body?.extensions).not.toHaveProperty("signalJourney");
    const bundle = await bundleMetadata("nm000921");
    expect(bundle.data?.extensions).not.toHaveProperty("dataQuality");
    expect(bundle.data?.extensions).not.toHaveProperty("signalJourney");
  });
});

describe("a withdrawn dataset (owner ruling of 2026-11-25)", () => {
  test("shows no dataQuality on either document, whatever its visibility (MUTATION: drop the withdrawn term)", async () => {
    // A withdrawal flips the dataset private first; a row still public with `withdrawn_at` set is the case
    // the read must refuse on its own, as the view route does.
    seedDataset("nm000922", { withdrawnAt: "2026-11-24 10:00:00" });
    await run("nm000922");
    const meta = await metadata("nm000922");
    expect(meta.status).toBe(200);
    expect(meta.body?.extensions).not.toHaveProperty("dataQuality");
    const bundle = await bundleMetadata("nm000922");
    expect(bundle.data?.extensions).not.toHaveProperty("dataQuality");
    seedDataset("nm000923", { visibility: "private", withdrawnAt: "2026-11-24 10:00:00" });
    await run("nm000923");
    expect((await metadata("nm000923")).status).toBe(404);
    expect((await bundleMetadata("nm000923")).status).toBe(404);
  });
});

describe("the page bundle when the pipeline read fails (#2375 review)", () => {
  test("keeps the metadata, leaves the namespaces out and is not cached; metadata.json still answers (MUTATION: fail the component, or call it complete)", async () => {
    seedDataset("nm000924");
    db.run(
      "UPDATE datasets SET description = 'A description that must survive.' WHERE dataset_id = 'nm000924'",
    );
    await run("nm000924");
    // A real failure of the read: the table it reads is gone.
    db.run("DROP TABLE compute_quality_documents");
    const bundle = await bundleMetadata("nm000924");
    expect(bundle.status).toBe(200);
    expect(bundle.data?.name).toBe("nm000924");
    expect(bundle.data?.description).toBe("A description that must survive.");
    for (const ns of ["processing", "signalJourney", "dataQuality"]) {
      expect(bundle.data?.extensions, ns).not.toHaveProperty(ns);
    }
    expect(bundle.pipelineDegraded).toBe(true);
    expect(bundle.complete).toBe(false);
    expect(bundle.cacheControl).toBe("no-store");
    const meta = await metadata("nm000924");
    expect(meta.status).toBe(200);
    expect(meta.body?.description).toBe("A description that must survive.");
    expect(meta.body?.extensions).not.toHaveProperty("dataQuality");
  });

  test("a bundle whose pipeline read succeeds is complete and says so", async () => {
    seedDataset("nm000925");
    await run("nm000925");
    const bundle = await bundleMetadata("nm000925");
    expect(bundle.pipelineDegraded).toBe(false);
    expect(bundle.complete).toBe(true);
    expect(bundle.data?.extensions.dataQuality.recipes["nemar-ica"]).toEqual(ENTRY);
  });
});

describe("metadata.json and the page bundle agree (#2331)", () => {
  test("processing, signalJourney with an in_progress link, and dataQuality (MUTATION: drop the bundle's read)", async () => {
    seedDataset("nm000930");
    const ica = await run("nm000930");
    const processing = {
      recipe_version: "1.0.0-b2",
      declared_checkpoints: ["import", "quality", "stored"],
      counts: {
        import: { passed: 1, failed: 0, skipped: 0, total: 1 },
        quality: { passed: 1, failed: 0, skipped: 0, total: 1 },
        stored: { passed: 1, failed: 0, skipped: 0, total: 1 },
      },
    };
    db.run(
      "INSERT INTO compute_pipeline_documents (dataset_id, namespace, recipe, stamp_id, entry) VALUES ('nm000930', 'processing', 'nemar-ica', ?, ?)",
      [ica.stampId, JSON.stringify(processing)],
    );
    // A run of nemar-floor reporting now: its link is worked out on read, on both documents.
    db.run(
      `INSERT INTO compute_jobs (id, account_id, source, kind, app_id, app_version, spec_digest,
                                 partition, pool, nodes, cores_per_node, minutes, state, held_milli)
       VALUES ('job_00000000000000000000beef', 1, 'pipeline', 'batch', 'nemar-launch', '1.0.0', ?, 'shared',
               'cpu', 1, 4, 60, 'running', 0)`,
      ["d".repeat(64)],
    );
    db.run(
      `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, attempt, state, job_id, input)
       VALUES ('nm000930', 'v1.0.0', 'nemar-floor', '1.0.0-b2', 'eegprep@0.5.0', 1, 'dispatched', 'job_00000000000000000000beef', 'bids')`,
    );
    const floorStamp = (
      db.query("SELECT MAX(id) AS id FROM compute_pipeline_stamps").get() as { id: number }
    ).id;
    db.run(
      "INSERT INTO compute_pipeline_progress_runs (stamp_id, job_id, reports, reported_at) VALUES (?, 'job_00000000000000000000beef', 1, datetime('now'))",
      [floorStamp],
    );

    const meta = await metadata("nm000930");
    const bundle = await bundleMetadata("nm000930");
    expect(bundle.complete).toBe(true);
    const fromMeta = meta.body?.extensions as Loose;
    const fromBundle = bundle.data?.extensions as Loose;
    expect(fromMeta.processing.recipes["nemar-ica"]).toEqual(processing);
    expect(fromMeta.signalJourney.recipes["nemar-floor"].processing_status).toBe("in_progress");
    expect(fromMeta.dataQuality.recipes["nemar-ica"]).toEqual(ENTRY);
    for (const ns of ["processing", "signalJourney", "dataQuality"]) {
      expect(fromBundle[ns], ns).toEqual(fromMeta[ns]);
    }
    if (!validateExtensions(fromBundle)) throw new Error(formatAjvErrors(validateExtensions));
  });
});
