/**
 * `data_papers` through the real HTTP entry points (ADR 0077).
 *
 * Drives the real `dataRoutes` router (`GET /:id/metadata.json`, and
 * `GET /:id/page-bundle.json`, which carries its own SELECT and feeds the same
 * builder) and the real catalog detail route against a real bun:sqlite D1
 * carrying every production migration. The seeded datasets have no
 * `dataset_versions` row, so neither data handler reaches S3.
 *
 * What this pins that the builder cannot: that BOTH handlers actually select the
 * column (dropping it from either SELECT leaves a hand-built-row test green),
 * that the two documents agree, and that the catalog detail route's `SELECT d.*`
 * does not hand the raw JSON text to the public.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { dataRoutes } from "../src/routes/data";
import { registerCatalogRoutes } from "../src/routes/datasets/catalog";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

const SCI_DATA = {
  doi: "10.1038/s41597-019-0027-4",
  title: "Multi-channel EEG recordings during a sustained-attention driving task",
  year: 2019,
  venue: "Scientific Data",
  judge_model: "claude-sonnet-5-5",
};

let db: Database;
let dataApp: App;
let catalogApp: App;
let errors: string[];
const originalError = console.error;

function seed(id: string, dataPapers: string | null, anonymous = 0): void {
  db.run(
    `INSERT INTO datasets
       (dataset_id, name, owner_user_id, status, visibility, is_sandbox, data_papers, anonymous)
     VALUES (?, ?, -1, 'active', 'public', 0, ?, ?)`,
    [id, id, dataPapers, anonymous],
  );
}

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
}

async function metadataJson(id: string): Promise<Record<string, unknown>> {
  const res = await dataApp.request(`/${id}/metadata.json`, {}, env());
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function pageBundleMetadata(id: string): Promise<Record<string, unknown>> {
  const res = await dataApp.request(`/${id}/page-bundle.json`, {}, env());
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    metadata: { ok: boolean; data?: Record<string, unknown> };
  };
  expect(body.metadata.ok).toBe(true);
  return body.metadata.data as Record<string, unknown>;
}

beforeEach(() => {
  db = freshDb();
  dataApp = new Hono();
  dataApp.route("/", dataRoutes);
  catalogApp = new Hono();
  registerCatalogRoutes(catalogApp);
  errors = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.error = originalError;
  db.close();
});

describe("a NULL column omits the key (not judged yet)", () => {
  test("metadata.json and page-bundle both leave data_papers out", async () => {
    seed("nm000860", null);
    expect("data_papers" in (await metadataJson("nm000860"))).toBe(false);
    expect("data_papers" in (await pageBundleMetadata("nm000860"))).toBe(false);
  });
});

describe("the text '[]' serves an empty list (gated, no data paper)", () => {
  test("metadata.json and page-bundle both serve []", async () => {
    seed("nm000861", "[]");
    expect((await metadataJson("nm000861")).data_papers).toEqual([]);
    expect((await pageBundleMetadata("nm000861")).data_papers).toEqual([]);
  });
});

describe("a stored list is served", () => {
  test("both documents carry the same list, after related_identifiers", async () => {
    seed("nm000862", JSON.stringify([SCI_DATA]));

    const meta = await metadataJson("nm000862");
    const bundle = await pageBundleMetadata("nm000862");

    expect(meta.data_papers).toEqual([SCI_DATA]);
    expect(bundle.data_papers).toEqual(meta.data_papers);
    const keys = Object.keys(meta);
    expect(keys.indexOf("data_papers")).toBe(keys.indexOf("related_identifiers") + 1);
  });

  test("an anonymous deposit serves it like any other dataset (owner decision, ADR 0077)", async () => {
    seed("nm000863", JSON.stringify([SCI_DATA]), 1);

    const meta = await metadataJson("nm000863");

    expect(meta.anonymous).toBe(true);
    expect(meta.data_papers).toEqual([SCI_DATA]);
    expect((await pageBundleMetadata("nm000863")).data_papers).toEqual([SCI_DATA]);
  });
});

describe("a stored value that is valid JSON but the wrong shape never becomes a 500", () => {
  test.each([
    ["an object", '{"doi":"10.1/x"}'],
    ["a list with an entry that has no doi", '[{"title":"no doi"}]'],
    ["a list with an entry that is not an object", '["10.1038/s41597-019-0027-4"]'],
    ["a list with a wrong-typed year", '[{"doi":"10.1/x","year":"2019"}]'],
  ])("%s: 200, key omitted, error logged", async (_label, text) => {
    seed("nm000864", text);

    const meta = await metadataJson("nm000864");

    expect("data_papers" in meta).toBe(false);
    expect("data_papers" in (await pageBundleMetadata("nm000864"))).toBe(false);
    expect(errors.some((e) => e.includes("nm000864") && e.includes("data_papers"))).toBe(true);
  });

  test("the column's json_valid CHECK stops text that is not JSON before it is ever stored", () => {
    expect(() => seed("nm000865", "{not json")).toThrow();
  });
});

describe("the catalog detail route does not leak the raw column", () => {
  test("GET /datasets/:id has no data_papers key, for a list, '[]' and NULL alike", async () => {
    seed("nm000866", JSON.stringify([SCI_DATA]));
    seed("nm000867", "[]");
    seed("nm000868", null);

    for (const id of ["nm000866", "nm000867", "nm000868"]) {
      const res = await catalogApp.request(`/${id}`, {}, env());
      expect(res.status).toBe(200);
      const body = (await res.json()) as { dataset: Record<string, unknown> };
      expect("data_papers" in body.dataset).toBe(false);
      expect(body.dataset.dataset_id).toBe(id);
    }
  });
});
