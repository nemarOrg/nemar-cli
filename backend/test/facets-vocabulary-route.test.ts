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
import { FACET_VOCABULARY_KEYS } from "../src/services/dataset-facet-vocabulary";
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

// The hand-written shape below is a TYPE convenience for reading fields off
// the parsed body. It is NOT the source of truth for which keys exist -- the
// test immediately after this block asserts the real response against the
// exported FACET_VOCABULARY_KEYS, so a key added to the service without being
// added here (or vice versa) fails rather than drifting silently. #1171
// review flagged that the export claimed a consumer it did not have.
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

describe("the response shape is the exported key list, not a second hand-written one", () => {
  let db: Database;
  let app: App;
  beforeEach(() => {
    db = freshDb();
    app = newApp();
    insertDataset(db, "nm900001", {
      modalities: "eeg",
      tasks: "rest",
      license_tier: "public",
      electrode_system: "10-10",
      source: "openneuro",
      zarr_status: "ready",
      bids_version: "1.9.0",
    });
  });

  test("a fully-successful response carries exactly FACET_VOCABULARY_KEYS", async () => {
    // #1171 review: FACET_VOCABULARY_KEYS documented itself as existing so a
    // test would not hand-list the keys twice, and then no test imported it.
    // This is that consumer.
    //
    // What it catches, verified by mutation: the RESPONSE drifting from the
    // declaration -- a declared key the assembly fails to set, or a key set
    // that was never declared. What it does NOT catch, also verified: a key
    // deleted from GROUPED_VOCAB_KEYS, because FACET_VOCABULARY_KEYS is
    // derived from that same list, so both sides move together and still
    // match. The enum-facet correspondence test below is what covers that
    // direction, by checking against shared/facets.ts instead.
    const { status, body } = await getFacets(app, db);
    expect(status).toBe(200);
    expect(body.warning).toBeUndefined();
    const returned = Object.keys(body as Record<string, unknown>).sort();
    expect(returned).toEqual([...FACET_VOCABULARY_KEYS].sort());
  });
});

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

// #1171 test review. Each block below exists because a mutation to the
// production line it targets produced ZERO failures across the whole suite.
describe("gaps found by mutation after the first review round", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
  });

  // Rated 9/10 by the reviewer. `bids-version` is one of the nine documented
  // vocabularies and the only one no test asserted on: deleting it from the
  // response entirely left 18/18 green. The generic key-list test added
  // earlier catches it now, but a direct assertion is what names the field
  // when it breaks, and it pins the VALUES rather than only the key.
  test("bids-version returns the distinct versions with counts", async () => {
    insertDataset(db, "nm330001", { bids_version: "1.9.0" });
    insertDataset(db, "nm330002", { bids_version: "1.9.0" });
    insertDataset(db, "nm330003", { bids_version: "1.10.0" });
    const { body } = await getFacets(app, db);
    expect(body["bids-version"]).toEqual([
      { value: "1.9.0", count: 2 },
      { value: "1.10.0", count: 1 },
    ]);
  });

  // Rated 6/10. The existing truncation test uses 60 distinct tasks, which
  // cannot distinguish `>` from `>=`. At EXACTLY the cap nothing is cut, so
  // `truncated` must be false -- a `>=` regression would claim a complete
  // list was truncated.
  test("exactly TASK_TOP_N distinct tasks is NOT truncated", async () => {
    // 50 distinct task labels across 50 datasets, one each.
    for (let i = 0; i < 50; i++) {
      insertDataset(db, `nm3400${String(i).padStart(2, "0")}`, { tasks: `task${i}` });
    }
    const { body } = await getFacets(app, db);
    expect(body.task?.distinct_total).toBe(50);
    expect(body.task?.truncated).toBe(false);
    expect(body.task?.values.length).toBe(50);
  });

  // Rated 6/10. NULL exclusion is real in the SQL but only incidentally
  // covered: every fixture that populates a grouped column does so on 100%
  // of its rows, so a regression letting NULLs through would surface as a
  // literal null/"null" entry that nothing asserts against. One mixed fixture
  // covers all five nullable grouped columns at once.
  test("NULLs never appear as a value in any grouped vocabulary", async () => {
    insertDataset(db, "nm350001", {
      electrode_system: "10-10",
      source: "openneuro",
      zarr_status: "ready",
      power_line_frequency: 60,
      bids_version: "1.9.0",
    });
    // Every one of those five left NULL on this row.
    insertDataset(db, "nm350002", {});
    const { body } = await getFacets(app, db);
    for (const key of [
      "electrode-system",
      "source",
      "zarr",
      "powerline",
      "bids-version",
    ] as const) {
      const values = (body[key] ?? []).map((e) => e.value);
      expect(values).not.toContain(null as unknown as string);
      expect(values).not.toContain("null");
      // Exactly the one populated row contributes; the NULL row contributes
      // nothing rather than a phantom bucket.
      expect(body[key]?.length).toBe(1);
      expect(body[key]?.[0].count).toBe(1);
    }
  });

  // Rated 7/10. The production comment says a degraded response is left at
  // the no-store default "so a transient query failure doesn't get pinned at
  // the edge", and nothing verified it. Forcing the header on regardless
  // passed 149/149. A regression here pins an INCOMPLETE vocabulary at the
  // CDN for up to five minutes for every anonymous caller.
  test("a degraded response is never edge-cached", async () => {
    insertDataset(db, "nm360001", { source: "openneuro" });
    const failing = ((target: Database): Bindings => {
      const base = realD1(target);
      return {
        DB: {
          prepare(sql: string) {
            const stmt = base.prepare(sql);
            const isSource = sql.includes("d.source AS value");
            const wrapper = {
              bind: (...args: unknown[]) => {
                stmt.bind(...args);
                return wrapper;
              },
              run: () => stmt.run(),
              first: <T>() => stmt.first<T>(),
              all: <T>() => {
                if (isSource) throw new Error("simulated source vocabulary failure");
                return stmt.all<T>();
              },
            };
            return wrapper;
          },
        } as unknown as D1Database,
        ENVIRONMENT: "development",
      } as Bindings;
    })(db);

    const res = await app.request("/facets", {}, failing);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FacetsBody;
    expect(body.warning).toBeDefined();
    expect(body.source).toBeUndefined();
    // The whole point: no s-maxage on a response that is missing a vocabulary.
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
