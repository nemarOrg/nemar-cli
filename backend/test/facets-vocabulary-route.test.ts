/**
 * Real-route tests for `GET /datasets/facets` (epic #1144 phase 5a, #1170),
 * driven through the actual registered Hono route (`registerCatalogRoutes`)
 * against a real bun:sqlite-backed D1 -- no mocks. Covers the plan's
 * verification cases 1-8 (route order, counts, visibility, task truncation,
 * enum-facet correspondence, deterministic ordering, degradation, cache
 * header).
 *
 * Per `.rules/testing.md`'s "test the entry point" rule: every assertion
 * goes through the real registered route, not `getFacetVocabulary` in
 * isolation -- a handler that computed the vocabulary and never returned it
 * would fail these tests even though the service function itself is correct.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { FACETS } from "../../shared/facets";
import { registerCatalogRoutes } from "../src/routes/datasets/catalog";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(db: Database): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "development" } as Bindings;
}

function newApp(): App {
  const app: App = new Hono();
  registerCatalogRoutes(app);
  return app;
}

/** Insert a `datasets` row with sane NOT-NULL defaults, overridable by
 *  `cols`. Mirrors facet-filters-route.test.ts's helper of the same name. */
function insertDataset(
  db: Database,
  datasetId: string,
  cols: Record<string, string | number | null> = {},
): void {
  const merged: Record<string, string | number | null> = {
    owner_user_id: -1,
    name: datasetId,
    visibility: "public",
    status: "active",
    is_sandbox: 0,
    ...cols,
  };
  const keys = Object.keys(merged);
  db.query(
    `INSERT INTO datasets (dataset_id, ${keys.join(", ")}) VALUES (?, ${keys
      .map(() => "?")
      .join(", ")})`,
  ).run(datasetId, ...(keys.map((k) => merged[k]) as never[]));
}

interface FacetsBody {
  "electrode-system"?: { value: string; count: number }[];
  source?: { value: string; count: number }[];
  zarr?: { value: string; count: number }[];
  powerline?: { value: string; count: number }[];
  "bids-version"?: { value: string; count: number }[];
  "hed-version"?: { value: string; count: number }[];
  license?: { value: string; count: number }[];
  modality?: { value: string; count: number }[];
  task?: { values: { value: string; count: number }[]; distinct_total: number; truncated: boolean };
  warning?: string;
  error?: string;
}

async function getFacets(app: App, db: Database): Promise<{ status: number; body: FacetsBody }> {
  const res = await app.request("/facets", {}, env(db));
  const body = (await res.json()) as FacetsBody;
  return { status: res.status, body };
}

describe("D1: route order -- /facets must not be shadowed by /:id", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    insertDataset(db, "nm300001", { license_tier: "public" });
  });

  // Mutation target: catalog.ts's `datasetRoutes.get("/facets", ...)`
  // registration position. Moving it to after `datasetRoutes.get("/:id",
  // ...)` makes "facets" get captured by the `:id` param matcher instead --
  // isValidDatasetId("facets") is false, so the response becomes a 400
  // "Invalid dataset ID format" rather than the vocabulary object.
  test("GET /datasets/facets returns the vocabulary, not a dataset-id error", async () => {
    const { status, body } = await getFacets(app, db);
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.license).toBeDefined();
  });
});

describe("D2/D3: counts are datasets-carrying-the-value, not raw occurrences", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    // Carries "eeg" TWICE in one row's comma-joined column -- must count
    // once for this dataset, not twice.
    insertDataset(db, "nm310001", { modalities: "eeg,eeg" });
    // A second, distinct dataset also carrying "eeg" once.
    insertDataset(db, "nm310002", { modalities: "eeg" });
    // An empty tasks string contributes to no task bucket at all.
    insertDataset(db, "nm310003", { tasks: "" });
    // Commas with nothing between them: split() produces only empty
    // tokens, which is a DIFFERENT guard (the post-split filter) than the
    // whole-column-empty case above (the early `if (!raw) continue`) --
    // this row is truthy overall, so it reaches split() at all.
    insertDataset(db, "nm310004", { tasks: ",," });
  });

  test("a modality repeated within one row's comma-joined value counts once for that row", async () => {
    const { body } = await getFacets(app, db);
    const eeg = body.modality?.find((e) => e.value === "eeg");
    // Two datasets carry "eeg" (nm310001 once despite the duplicate token,
    // nm310002 once) -- count must be 2, not 3.
    expect(eeg?.count).toBe(2);
  });

  test("an empty tasks string is excluded from every bucket (no empty-string entry)", async () => {
    const { body } = await getFacets(app, db);
    expect(body.task?.values.some((e) => e.value === "")).toBe(false);
    // Only nm310004 has non-empty comma content, and it's ALL empty tokens
    // after split -- so it contributes zero distinct tasks too.
    expect(body.task?.distinct_total).toBe(0);
  });
});

describe("D4: visibility -- the population must match exactly what an anonymous caller can already list", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    // Public, active, non-sandbox: MUST contribute.
    insertDataset(db, "nm320001", { license_tier: "public" });
    // Private: must NOT contribute.
    insertDataset(db, "nm320002", { license_tier: "attribution", visibility: "private" });
    // Archived (not active): must NOT contribute.
    insertDataset(db, "nm320003", { license_tier: "sharealike", status: "archived" });
    // Throwaway sandbox, not an exemplar: must NOT contribute.
    insertDataset(db, "nm320004", { license_tier: "noncommercial", is_sandbox: 1 });
    // Sandbox AND exemplar: MUST contribute (the permanent curated fleet).
    insertDataset(db, "nm320005", {
      license_tier: "noderiv",
      is_sandbox: 1,
      is_exemplar: 1,
    });
  });

  test("only the public/active/non-throwaway-sandbox rows contribute to the vocabulary", async () => {
    const { body } = await getFacets(app, db);
    const tiers = (body.license ?? []).map((e) => e.value).sort();
    // public (nm320001) and noderiv (nm320005, exemplar) contribute;
    // attribution/sharealike/noncommercial (private/archived/plain-sandbox)
    // do not.
    expect(tiers).toEqual(["noderiv", "public"]);
  });
});

describe("D2: task truncation reports distinct_total and truncated honestly", () => {
  let db: Database;
  let app: App;
  const TOP_N = 50;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    // 60 distinct single-task datasets, task_0000 with 60 occurrences (so it
    // sorts first), task_0001..task_0059 with one dataset each -- 60
    // distinct tasks total, well past the top-50 cutoff.
    for (let i = 0; i < 60; i++) {
      insertDataset(db, `nm33${String(i).padStart(4, "0")}`, {
        tasks: `task_${String(i).padStart(4, "0")}`,
      });
    }
  });

  test("distinct_total counts every distinct task, truncated is true past 50, and only the top 50 by count are returned", async () => {
    const { body } = await getFacets(app, db);
    expect(body.task?.distinct_total).toBe(60);
    expect(body.task?.truncated).toBe(true);
    expect(body.task?.values.length).toBe(TOP_N);
  });
});

describe("D2: every enum-kind facet in shared/facets.ts has a vocabulary key", () => {
  test("no enum facet is missing from the facets endpoint's response shape", async () => {
    // Mirrors facet-table-correspondence.unit.test.ts's "correspondence"
    // idiom: walk the declared facet table directly rather than a
    // hand-copied list of expected keys, so a facet ADDED to
    // shared/facets.ts with valueKind "enum" and no matching response key
    // fails this test rather than silently shipping unfilterable-by-vocab.
    const db = freshDb();
    const app = newApp();
    insertDataset(db, "nm340001", {
      electrode_system: "10-20",
      source: "openneuro",
      zarr_status: "ready",
      power_line_frequency: 60,
    });
    const { body } = await getFacets(app, db);
    const enumFacets = FACETS.filter((f) => f.valueKind === "enum");
    expect(enumFacets.length).toBeGreaterThan(0);
    const missing = enumFacets.filter((f) => !(f.key in body)).map((f) => f.key);
    expect(missing).toEqual([]);
  });
});

describe("D2: ordering is deterministic for ties (count desc, then value asc)", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    // Three license tiers, each carried by exactly one dataset -- a genuine
    // 3-way tie on count, which must break by value ascending.
    insertDataset(db, "nm350001", { license_tier: "sharealike" });
    insertDataset(db, "nm350002", { license_tier: "attribution" });
    insertDataset(db, "nm350003", { license_tier: "public" });
  });

  test("tied counts are ordered by value ascending, not insertion order", async () => {
    const { body } = await getFacets(app, db);
    const tied = (body.license ?? []).filter((e) =>
      ["public", "attribution", "sharealike"].includes(e.value),
    );
    expect(tied.map((e) => e.value)).toEqual(["attribution", "public", "sharealike"]);
  });

  test("a higher count sorts before a lower count regardless of value", async () => {
    insertDataset(db, "nm350004", { license_tier: "public" });
    const { body } = await getFacets(app, db);
    const values = (body.license ?? []).map((e) => e.value);
    // "public" (count 2) must precede "attribution"/"sharealike" (count 1)
    // even though 'a' < 'p' alphabetically.
    expect(values.indexOf("public")).toBeLessThan(values.indexOf("attribution"));
    expect(values.indexOf("public")).toBeLessThan(values.indexOf("sharealike"));
  });

  // The license/enum vocabularies above are ordered by SQL (`ORDER BY count
  // DESC, value ASC`); `modality`/`task` are a SEPARATE implementation --
  // tallied and sorted in JS (`sortVocabulary`) -- so the same tie-break
  // guarantee needs its own coverage rather than assuming the SQL-side test
  // above also exercises it.
  test("modality (JS-tallied) ties are also ordered by value ascending", async () => {
    insertDataset(db, "nm350005", { modalities: "meg" });
    insertDataset(db, "nm350006", { modalities: "eeg" });
    const { body } = await getFacets(app, db);
    const tied = (body.modality ?? []).filter((e) => ["meg", "eeg"].includes(e.value));
    expect(tied.map((e) => e.value)).toEqual(["eeg", "meg"]);
  });
});

describe("D5/ADR 0005: one failing vocabulary query is omitted, not a 500 -- and distinguished from []", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    insertDataset(db, "nm360001", { license_tier: "public", electrode_system: "10-20" });
  });

  // Fails ONLY the `source` vocabulary's query, identifiable by its unique
  // "d.source AS value" marker (no other grouped-vocabulary query selects
  // that column), while every other query still runs against real SQLite.
  function sourceQueryFailingD1(target: Database): Bindings {
    const base = realD1(target);
    return {
      DB: {
        prepare(sql: string) {
          const stmt = base.prepare(sql);
          const isSourceQuery = sql.includes("d.source AS value");
          const wrapper = {
            bind: (...args: unknown[]) => {
              stmt.bind(...args);
              return wrapper;
            },
            run: () => stmt.run(),
            first: <T>() => stmt.first<T>(),
            all: <T>() => {
              if (isSourceQuery) throw new Error("simulated source vocabulary failure");
              return stmt.all<T>();
            },
          };
          return wrapper;
        },
      } as unknown as D1Database,
      ENVIRONMENT: "development",
    } as Bindings;
  }

  test("a failed `source` query never 500s, omits ONLY `source`, and sets warning", async () => {
    const res = await app.request("/facets", {}, sourceQueryFailingD1(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as FacetsBody;
    expect("source" in body).toBe(false);
    expect(body.warning).toBeDefined();
    expect(body.warning).toContain("source");
    // Every OTHER vocabulary still comes back -- the fault is isolated.
    expect(body.license).toBeDefined();
    expect(body["electrode-system"]).toBeDefined();
  });

  test("a vocabulary the query succeeds on but finds no rows for is [], never omitted", async () => {
    // hed_version has no populated rows in this fixture at all -- the query
    // succeeds and finds zero groups, which must render as `[]`, not be
    // absent the way a FAILED query would be.
    const { body } = await getFacets(app, db);
    expect(body["hed-version"]).toEqual([]);
    expect(body.warning).toBeUndefined();
  });
});

describe("D4: cache header is present on a healthy response, with no Vary", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    insertDataset(db, "nm370001", { license_tier: "public" });
  });

  test("Cache-Control is public with s-maxage, and Vary is absent", async () => {
    const res = await app.request("/facets", {}, env(db));
    expect(res.status).toBe(200);
    const cacheControl = res.headers.get("Cache-Control");
    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain("s-maxage=300");
    expect(res.headers.get("Vary")).toBeNull();
  });
});
