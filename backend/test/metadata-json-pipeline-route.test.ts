/**
 * The dataset-level neuroschema `processing` and `signalJourney` extensions of NEMAR's pipeline in
 * `GET /:id/metadata.json` (ADR 0134, epic #2324 phase 2), through the real `dataRoutes` router over a
 * real bun:sqlite D1 carrying every production migration. The documents are seeded with SQL the table
 * accepts; the seeded datasets have no version row, so the handler reaches no bucket.
 *
 * What is pinned: a final `processing` entry and a `signalJourney` link are served under `extensions`,
 * and the document's extensions validate against the vendored neuroschema 0.5.0 extensions container; a `processing`
 * entry that is not final is not served; a dataset with no documents has neither key; a private dataset
 * and a concealed deposit get nothing new (404, and no pipeline keys); an entry that does not parse is
 * left out.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  compileNeuroschemaValidator,
  formatAjvErrors,
} from "../../test/contract/neuroschema-validator";

/** The document's `extensions`, judged by neuroschema 0.5.0's extensions container. */
const validateExtensions = compileNeuroschemaValidator(
  "nsc:/extensions/extensionsContainer.schema.json",
);
import { dataRoutes } from "../src/routes/data";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

const env = (): Bindings => ({ DB: realD1(db), ENVIRONMENT: "test" }) as Bindings;

function seed(id: string, over: { visibility?: string; anonymous?: number } = {}): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox, anonymous, modalities)
     VALUES (?, ?, -1, 'active', ?, 0, ?, 'eeg')`,
    [id, id, over.visibility ?? "public", over.anonymous ?? 0],
  );
}

function document(
  id: string,
  namespace: string,
  entry: unknown,
  final = 1,
  recipe = "nemar-floor",
) {
  db.run(
    "INSERT INTO compute_pipeline_documents (dataset_id, namespace, recipe, stamp_id, entry, final) VALUES (?, ?, ?, 7, ?, ?)",
    [id, namespace, recipe, typeof entry === "string" ? entry : JSON.stringify(entry), final],
  );
}

const PROCESSING = {
  recipe_version: "1.0.0",
  declared_checkpoints: ["import", "preprocess", "quality", "stored"],
  counts: {
    import: { passed: 3, failed: 1, skipped: 0, total: 4 },
    preprocess: { passed: 2, failed: 1, skipped: 1, total: 4 },
    quality: { passed: 2, failed: 0, skipped: 2, total: 4 },
    stored: { passed: 2, failed: 0, skipped: 2, total: 4 },
  },
};
const LINK = {
  recipe_version: "1.0.0",
  processing_status: "completed",
  location: "desc-nemarfloor_signalJourney.json",
  sha256: "a".repeat(64),
  sj_version: "0.1.0",
};

async function get(id: string) {
  const res = await app.request(`/${id}/metadata.json`, {}, env());
  return {
    status: res.status,
    body: (res.status === 200 ? await res.json() : null) as Record<string, any> | null,
  };
}

beforeEach(() => {
  db = freshDb();
  app = new Hono();
  app.route("/", dataRoutes);
});

describe("pipeline extensions in metadata.json", () => {
  test("a final processing entry and a link are served, and the extensions validate against neuroschema 0.5.0", async () => {
    seed("nm000501");
    document("nm000501", "processing", PROCESSING);
    document("nm000501", "signalJourney", LINK);
    const { status, body } = await get("nm000501");
    expect(status).toBe(200);
    expect(body?.extensions.processing).toEqual({
      level: "dataset",
      recipes: { "nemar-floor": PROCESSING },
    });
    expect(body?.extensions.signalJourney).toEqual({ recipes: { "nemar-floor": LINK } });
    if (!validateExtensions(body?.extensions)) throw new Error(formatAjvErrors(validateExtensions));
  });

  test("a processing entry that is not final is not served; an in_progress link is (MUTATION: serve any processing row)", async () => {
    seed("nm000502");
    document("nm000502", "processing", PROCESSING, 0);
    document(
      "nm000502",
      "signalJourney",
      { ...LINK, processing_status: "in_progress", location: null, sha256: null, sj_version: null },
      0,
    );
    const { body } = await get("nm000502");
    expect(body?.extensions).not.toHaveProperty("processing");
    expect(body?.extensions.signalJourney.recipes["nemar-floor"].processing_status).toBe(
      "in_progress",
    );
    if (!validateExtensions(body?.extensions)) throw new Error(formatAjvErrors(validateExtensions));
  });

  test("a dataset with no documents has neither key, and an entry that does not parse is left out", async () => {
    seed("nm000503");
    const { body } = await get("nm000503");
    expect(Object.keys(body?.extensions ?? {})).toEqual(["nemar"]);
    seed("nm000504");
    document("nm000504", "signalJourney", "{not json");
    document("nm000504", "signalJourney", LINK, 1, "nemar-ica");
    const second = await get("nm000504");
    expect(Object.keys(second.body?.extensions.signalJourney.recipes)).toEqual(["nemar-ica"]);
  });

  test("a private dataset and a concealed deposit get nothing new (MUTATION: drop the anonymous check)", async () => {
    seed("nm000505", { visibility: "private" });
    document("nm000505", "signalJourney", LINK);
    expect((await get("nm000505")).status).toBe(404);
    seed("nm000506", { anonymous: 1 });
    document("nm000506", "processing", PROCESSING);
    document("nm000506", "signalJourney", LINK);
    const concealed = await get("nm000506");
    expect(concealed.status).toBe(200);
    expect(concealed.body?.extensions).not.toHaveProperty("processing");
    expect(concealed.body?.extensions).not.toHaveProperty("signalJourney");
  });
});
