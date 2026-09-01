/**
 * Real-route tests for the facet filter engine (epic #1144 phase 3, #1147),
 * driven through the actual registered Hono routes (`registerCatalogRoutes`)
 * against a real bun:sqlite-backed D1 -- no mocks, and no hand-copied SQL.
 * Covers the plan's verification cases 2-7:
 *
 *  2. Overlap, not containment, for pair facets.
 *  3. The `--channels` derived-pair-with-exemplar-fallback, three ways.
 *  4. The unknown-excluded-by-default policy and `excluded_unknown`.
 *  5. `bids_version` prefix/exact matching, including the `v`-prefix and the
 *     lexicographic-`>=` trap ('1.9.0' > '1.10.0' as strings).
 *  6. `enum` (OR + drop-unrecognised) and `text` (case-insensitive, literal
 *     `%`/`_`) facet kinds.
 *  7. Every facet exercised against BOTH `GET /datasets` and `GET
 *     /datasets/search`, plus the regression that `/search` now honours
 *     `license`, `author`, `task`, `has_doi`, `recent`, `data_complete`
 *     (D6) -- and that it still does NOT fold `?search=` into its own `q`
 *     matching (constraint 6).
 *
 * Per `.rules/testing.md`'s "test the entry point" rule: every assertion
 * here goes through the real registered route, not `buildFacetClauses` in
 * isolation -- a handler that parses a flag and never threads it into
 * `filters` would fail these tests even though the clause builder itself is
 * correct.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { FACETS, type FacetKey } from "../../shared/facets";
import { registerCatalogRoutes } from "../src/routes/datasets/catalog";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(db: Database): Bindings {
  // No AI/VECTORIZE bound: GET /datasets/search takes its "text" (FTS-only)
  // tier, which is exactly the tier that runs the facet clauses -- the
  // semantic tier is Phase-3-irrelevant and exercised elsewhere.
  return { DB: realD1(db), ENVIRONMENT: "development" } as Bindings;
}

function newApp(): App {
  const app: App = new Hono();
  registerCatalogRoutes(app);
  return app;
}

/** Insert a `datasets` row with sane NOT-NULL defaults, overridable by
 *  `cols`. Every column not mentioned defaults to SQLite NULL (or the
 *  schema's own DEFAULT), which is exactly the "not yet populated" state
 *  most of these tests need. */
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

async function listIds(app: App, db: Database, qs: string): Promise<string[]> {
  const res = await app.request(`/?${qs}`, {}, env(db));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { datasets: { dataset_id: string }[] };
  return body.datasets.map((d) => d.dataset_id);
}

async function searchIds(app: App, db: Database, qs: string): Promise<string[]> {
  const res = await app.request(`/search?${qs}`, {}, env(db));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { results: { id: string }[] };
  return body.results.map((r) => r.id);
}

describe("D1: overlap, not containment, for pair facets", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    // age_min/age_max is a genuine pair (no fallback). 12..25 must MATCH a
    // query of 5..18 under overlap; a containment implementation
    // (age_min >= 5 AND age_max <= 18) would wrongly exclude it (25 > 18).
    insertDataset(db, "nm200001", { age_min: 12, age_max: 25 });
    // Clearly outside 5..18 either way -- the negative control.
    insertDataset(db, "nm200002", { age_min: 30, age_max: 40 });
  });

  test("--age 5..18 matches a dataset spanning 12..25 (overlap)", async () => {
    const ids = await listIds(app, db, "age=5..18");
    expect(ids).toContain("nm200001");
  });

  test("--age 5..18 excludes a dataset spanning 30..40 (no overlap)", async () => {
    const ids = await listIds(app, db, "age=5..18");
    expect(ids).not.toContain("nm200002");
  });

  test("--recording-length overlap: a 100..200 store matches a 150..250 query", async () => {
    db.query(
      "UPDATE datasets SET recording_duration_min = 100, recording_duration_max = 200 WHERE dataset_id = 'nm200001'",
    ).run();
    const ids = await listIds(app, db, "recording-length=150..250");
    expect(ids).toContain("nm200001");
  });
});

describe("D1/D5: --channels, the derived-pair-with-exemplar-fallback facet", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    // Pair populated. n_channels is a deliberately WRONG decoy (999) so a
    // COALESCE(n_channels, channel_count_max) transposition -- exemplar
    // taking priority over the derived pair -- is observably different
    // from the correct COALESCE(channel_count_max, n_channels).
    insertDataset(db, "nm210001", {
      channel_count_min: 10,
      channel_count_max: 20,
      n_channels: 999,
    });
    // Pair NULL, exemplar populated.
    insertDataset(db, "nm210002", { n_channels: 15 });
    // Both NULL: no signal at all.
    insertDataset(db, "nm210003", {});
  });

  test("the derived pair wins where present, not the decoy exemplar", async () => {
    // Only the decoy (999) overlaps this range; the true pair (10..20) does
    // not. A transposed COALESCE would wrongly include nm210001 here.
    const ids = await listIds(app, db, "channels=900..1000");
    expect(ids).not.toContain("nm210001");
    expect(ids).not.toContain("nm210002");
    expect(ids).not.toContain("nm210003");
  });

  test("the exemplar is used where the pair is absent", async () => {
    const ids = await listIds(app, db, "channels=10..20");
    expect(ids).toContain("nm210001"); // true pair 10..20 overlaps itself
    expect(ids).toContain("nm210002"); // exemplar 15 falls inside 10..20
  });

  test("both-NULL is excluded by default", async () => {
    const ids = await listIds(app, db, "channels=10..20");
    expect(ids).not.toContain("nm210003");
  });

  test("include_unknown=1 includes the both-NULL row", async () => {
    const ids = await listIds(app, db, "channels=10..20&include_unknown=1");
    expect(ids).toContain("nm210001");
    expect(ids).toContain("nm210002");
    expect(ids).toContain("nm210003");
  });
});

describe("D4/ADR 0005: unknown is excluded by default, and reported", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    insertDataset(db, "nm220001", {
      name: "Unknown Policy Fixture Populated",
      total_recording_duration: 100,
    });
    insertDataset(db, "nm220002", {
      name: "Unknown Policy Fixture Unpopulated",
      total_recording_duration: null,
    });
  });

  test("GET /datasets: default excludes the NULL row and reports excluded_unknown", async () => {
    const res = await app.request("/?duration=50..150", {}, env(db));
    const body = (await res.json()) as {
      datasets: { dataset_id: string }[];
      excluded_unknown?: number;
    };
    expect(body.datasets.map((d) => d.dataset_id)).toEqual(["nm220001"]);
    expect(body.excluded_unknown).toBe(1);
  });

  test("GET /datasets: include_unknown=1 includes it, excluded_unknown drops to 0", async () => {
    const res = await app.request("/?duration=50..150&include_unknown=1", {}, env(db));
    const body = (await res.json()) as {
      datasets: { dataset_id: string }[];
      excluded_unknown?: number;
    };
    expect(body.datasets.map((d) => d.dataset_id).sort()).toEqual(["nm220001", "nm220002"]);
    expect(body.excluded_unknown).toBe(0);
  });

  test("GET /datasets: excluded_unknown is ABSENT (not 0) when no facet is active", async () => {
    const res = await app.request("/", {}, env(db));
    const body = (await res.json()) as { excluded_unknown?: number };
    expect(body.excluded_unknown).toBeUndefined();
    expect("excluded_unknown" in body).toBe(false);
  });

  test("GET /datasets/search: default excludes the NULL row and reports excluded_unknown", async () => {
    const res = await app.request("/search?q=Unknown+Policy+Fixture&duration=50..150", {}, env(db));
    const body = (await res.json()) as {
      results: { id: string }[];
      excluded_unknown?: number;
    };
    expect(body.results.map((r) => r.id)).toEqual(["nm220001"]);
    expect(body.excluded_unknown).toBe(1);
  });

  test("GET /datasets/search: include_unknown=1 includes it, excluded_unknown drops to 0", async () => {
    const res = await app.request(
      "/search?q=Unknown+Policy+Fixture&duration=50..150&include_unknown=1",
      {},
      env(db),
    );
    const body = (await res.json()) as {
      results: { id: string }[];
      excluded_unknown?: number;
    };
    expect(body.results.map((r) => r.id).sort()).toEqual(["nm220001", "nm220002"]);
    expect(body.excluded_unknown).toBe(0);
  });

  test("GET /datasets/search: excluded_unknown is ABSENT when no facet is active", async () => {
    const res = await app.request("/search?q=Unknown+Policy+Fixture", {}, env(db));
    const body = (await res.json()) as { excluded_unknown?: number };
    expect("excluded_unknown" in body).toBe(false);
  });

  // ADR 0005 / D4: excluded_unknown is reporting, never a precondition for
  // serving. A real D1, wrapped to fail ONLY the widened (include_unknown)
  // COUNT query -- identifiable by its distinctive "OR ... IS NULL" clause,
  // absent from every other query this handler issues -- while every other
  // query (including the real main list + real count) still runs against
  // actual SQLite. Mirrors the project's established writeFailingD1 pattern
  // (backend/test/signal-defaults-sweep.test.ts): a fault-injection wrapper
  // around a real D1, not a canned-response fake.
  function excludedUnknownFailingD1(target: Database): Bindings {
    const base = realD1(target);
    return {
      DB: {
        prepare(sql: string) {
          const stmt = base.prepare(sql);
          const isWidenedCount = sql.includes("total_recording_duration IS NULL");
          const wrapper = {
            bind: (...args: unknown[]) => {
              stmt.bind(...args);
              return wrapper;
            },
            run: () => stmt.run(),
            first: <T>() => {
              if (isWidenedCount) throw new Error("simulated D1 failure");
              return stmt.first<T>();
            },
            all: <T>() => stmt.all<T>(),
          };
          return wrapper;
        },
      } as unknown as D1Database,
      ENVIRONMENT: "development",
    } as Bindings;
  }

  test("GET /datasets: a failed excluded_unknown query omits the field, never 500s", async () => {
    const res = await app.request("/?duration=50..150", {}, excludedUnknownFailingD1(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      datasets: { dataset_id: string }[];
      excluded_unknown?: number;
    };
    // The main list and its real count are unaffected by the injected fault.
    expect(body.datasets.map((d) => d.dataset_id)).toEqual(["nm220001"]);
    expect("excluded_unknown" in body).toBe(false);
  });

  test("GET /datasets/search: a failed excluded_unknown query omits the field, never 500s", async () => {
    const res = await app.request(
      "/search?q=Unknown+Policy+Fixture&duration=50..150",
      {},
      excludedUnknownFailingD1(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { id: string }[];
      excluded_unknown?: number;
    };
    expect(body.results.map((r) => r.id)).toEqual(["nm220001"]);
    expect("excluded_unknown" in body).toBe(false);
  });
});

describe("D5: bids_version is prefix/exact only, never a lexicographic >=", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    insertDataset(db, "nm230001", { bids_version: "1.9.0" });
    insertDataset(db, "nm230002", { bids_version: "1.10.0" });
    insertDataset(db, "nm230003", { bids_version: "1.10.1" });
    insertDataset(db, "nm230004", { bids_version: "1.11.0" });
    insertDataset(db, "nm230005", { bids_version: "v1.2.1" });
    insertDataset(db, "nm230006", { bids_version: "1.80.0" });
  });

  test("--bids-version 1.10 matches 1.10.0 and 1.10.1 by prefix, not 1.9.0 or 1.11.0", async () => {
    const ids = (await listIds(app, db, "bids-version=1.10")).sort();
    expect(ids).toEqual(["nm230002", "nm230003"]);
  });

  test("'1.9.0' sorting above '1.10.0' lexicographically must not leak in: 1.9.0 is excluded", async () => {
    // The trap this guards: a naive `bids_version >= '1.10'` filter would
    // wrongly include '1.9.0', because '1.9.0' > '1.10' as a string
    // ('9' > '1' at the second character). Prefix/exact matching cannot
    // make this mistake; this assertion fails if anyone reintroduces `>=`.
    const ids = await listIds(app, db, "bids-version=1.10");
    expect(ids).not.toContain("nm230001");
  });

  test("leading 'v' is normalized on both the filter value and the stored column", async () => {
    const ids = await listIds(app, db, "bids-version=1.2.1");
    expect(ids).toEqual(["nm230005"]);
  });

  test("--bids-version 1.8 matches '1.8'/'1.8.%' only, never '1.80.0'", async () => {
    const ids = await listIds(app, db, "bids-version=1.8");
    expect(ids).not.toContain("nm230006");
  });
});

describe("D5: enum facets OR their members and drop unrecognised tokens", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    insertDataset(db, "nm240001", { electrode_system: "10-20", power_line_frequency: 60 });
    insertDataset(db, "nm240002", { electrode_system: "biosemi", power_line_frequency: 50 });
    insertDataset(db, "nm240003", { electrode_system: null, power_line_frequency: null });
  });

  test("a recognised token filters normally", async () => {
    const ids = await listIds(app, db, "electrode-system=10-20");
    expect(ids).toEqual(["nm240001"]);
  });

  test("mixed recognised+unrecognised: keeps the recognised member, drops the rest", async () => {
    const ids = await listIds(app, db, "electrode-system=10-20,bogus-token");
    expect(ids).toEqual(["nm240001"]);
  });

  test("ALL-unrecognised tokens mean 'no filter', never 'match nothing'", async () => {
    const ids = (await listIds(app, db, "electrode-system=bogus-token")).sort();
    expect(ids).toEqual(["nm240001", "nm240002", "nm240003"]);
  });

  test("powerline binds numerically: 50 does not also match the 60 row", async () => {
    const ids = await listIds(app, db, "powerline=50");
    expect(ids).toEqual(["nm240002"]);
  });

  test("a comma-separated enum ORs its members", async () => {
    const ids = (await listIds(app, db, "electrode-system=10-20,biosemi")).sort();
    expect(ids).toEqual(["nm240001", "nm240002"]);
  });
});

describe("D5: text facets are case-insensitive and treat %/_ as literals", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    insertDataset(db, "nm241001", {
      eeg_reference: "50% average reference",
      placement_scheme: "Cz standard",
    });
    insertDataset(db, "nm241002", {
      eeg_reference: "linked ears",
      placement_scheme: "custom_10-05",
    });
    // Deliberately contains the SUBSTRING "50" with no literal '%', and the
    // SHAPE "custom?10-05" with a plain letter instead of '_' -- these are
    // what an UNESCAPED LIKE would wrongly treat '%'/'_' as wildcards over.
    insertDataset(db, "nm241003", {
      eeg_reference: "over 50 electrodes",
      placement_scheme: "customX10-05",
    });
  });

  test("matches case-insensitively", async () => {
    const ids = await listIds(app, db, "placement=CZ");
    expect(ids).toEqual(["nm241001"]);
  });

  test("a literal '%' in the user's value is not a wildcard", async () => {
    // Unescaped, LIKE '%50%%' means "contains 50 anywhere" (the trailing
    // '%%' collapses to '%'), which would ALSO match nm241003's "over 50
    // electrodes" even though it has no percent sign at all.
    const ids = await listIds(app, db, `reference=${encodeURIComponent("50%")}`);
    expect(ids).toEqual(["nm241001"]);
  });

  test("a literal '_' in the user's value matches only a real underscore, not any character", async () => {
    // Unescaped, LIKE '%custom_10%' treats '_' as "any one character" and
    // so would ALSO match nm241003's "customX10-05" (X standing in for the
    // wildcard), even though it has no underscore at all.
    const ids = await listIds(app, db, "placement=custom_10");
    expect(ids).toEqual(["nm241002"]);
  });
});

describe("shared/facets.ts + dataset-facets.ts: every facet, both endpoints", () => {
  let db: Database;
  let app: App;
  const FIXTURE_ID = "nm250001";

  // One value that should MATCH the fixture row below, and one that should
  // not, per facet. Pair/pair-with-fallback non-matches are chosen clear of
  // BOTH the real pair and any decoy exemplar value.
  const matching: Record<FacetKey, string> = {
    subjects: "10..30",
    channels: "35..45",
    sessions: "3",
    size: "100MB..1GB",
    files: "100..150",
    citations: "1..10",
    duration: "1800..7200",
    "recording-length": "150..250",
    recordings: "5..15",
    unavailable: "1",
    age: "25..35",
    rate: "400..600",
    powerline: "60",
    reference: "avera",
    placement: "10-20",
    "electrode-system": "10-20",
    source: "openneuro",
    zarr: "ready",
    "bids-version": "1.10",
    "hed-version": "8.3",
  };
  const nonMatching: Record<FacetKey, string> = {
    subjects: "1..5",
    channels: "1..5",
    sessions: "99",
    size: "1..2",
    files: "1..5",
    citations: "100..200",
    duration: "1..10",
    "recording-length": "1..5",
    recordings: "1..2",
    unavailable: "50..60",
    age: "1..5",
    rate: "1..10",
    powerline: "50",
    reference: "linked ears",
    placement: "biosemi cap",
    "electrode-system": "biosemi",
    source: "gin",
    zarr: "failed",
    "bids-version": "2.0",
    "hed-version": "1.0",
  };

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    insertDataset(db, FIXTURE_ID, {
      name: "Facet Exercise Fixture",
      subject_count: 20,
      channel_count_min: 30,
      channel_count_max: 40,
      n_channels: 999,
      sessions_count: 3,
      file_size: 500 * 1024 * 1024,
      total_files: 120,
      num_citations: 4,
      total_recording_duration: 3600,
      recording_duration_min: 100,
      recording_duration_max: 200,
      recording_count: 10,
      recordings_unavailable: 1,
      age_min: 20,
      age_max: 30,
      sampling_frequency: 500,
      power_line_frequency: 60,
      eeg_reference: "average",
      placement_scheme: "10-20 standard",
      electrode_system: "10-20",
      source: "openneuro",
      zarr_status: "ready",
      bids_version: "1.10.0",
      hed_version: "8.3.0",
    });
  });

  for (const facet of FACETS) {
    test(`--${facet.key} matching value includes the fixture (GET /datasets)`, async () => {
      const ids = await listIds(app, db, `${facet.key}=${encodeURIComponent(matching[facet.key])}`);
      expect(ids).toContain(FIXTURE_ID);
    });

    test(`--${facet.key} non-matching value excludes the fixture (GET /datasets)`, async () => {
      const ids = await listIds(
        app,
        db,
        `${facet.key}=${encodeURIComponent(nonMatching[facet.key])}`,
      );
      expect(ids).not.toContain(FIXTURE_ID);
    });

    test(`--${facet.key} matching value includes the fixture (GET /datasets/search)`, async () => {
      const ids = await searchIds(
        app,
        db,
        `q=${encodeURIComponent("Facet Exercise")}&${facet.key}=${encodeURIComponent(matching[facet.key])}`,
      );
      expect(ids).toContain(FIXTURE_ID);
    });

    test(`--${facet.key} non-matching value excludes the fixture (GET /datasets/search)`, async () => {
      const ids = await searchIds(
        app,
        db,
        `q=${encodeURIComponent("Facet Exercise")}&${facet.key}=${encodeURIComponent(nonMatching[facet.key])}`,
      );
      expect(ids).not.toContain(FIXTURE_ID);
    });
  }
});

describe("D6: GET /datasets/search now honours the legacy filters it used to ignore", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    insertDataset(db, "nm260001", {
      name: "Regression License Fixture Alpha",
      license_tier: "public",
      authors: "Ada Regression",
      tasks: "rest",
      concept_doi: "10.5072/x1",
      data_complete: 1,
      created_at: new Date().toISOString(),
    });
    insertDataset(db, "nm260002", {
      name: "Regression License Fixture Beta",
      license_tier: "noncommercial",
      authors: "Bob Regression",
      tasks: "memory",
      concept_doi: null,
      data_complete: 0,
      created_at: "2020-01-01T00:00:00.000Z",
    });
  });

  const Q = `q=${encodeURIComponent("Regression License Fixture")}`;

  test("license", async () => {
    expect(await searchIds(app, db, `${Q}&license=public`)).toEqual(["nm260001"]);
  });

  test("author", async () => {
    expect(await searchIds(app, db, `${Q}&author=${encodeURIComponent("Ada")}`)).toEqual([
      "nm260001",
    ]);
  });

  test("task", async () => {
    expect(await searchIds(app, db, `${Q}&task=memory`)).toEqual(["nm260002"]);
  });

  test("has_doi", async () => {
    expect(await searchIds(app, db, `${Q}&has_doi=true`)).toEqual(["nm260001"]);
  });

  test("data_complete", async () => {
    expect(await searchIds(app, db, `${Q}&data_complete=1`)).toEqual(["nm260001"]);
  });

  test("recent", async () => {
    expect(await searchIds(app, db, `${Q}&recent=1`)).toEqual(["nm260001"]);
  });

  test("constraint 6: a stray ?search= param is ignored, not ANDed against q", async () => {
    // If the search handler ever starts populating filters.search from its
    // own `search` query param again, this would AND an unrelated LIKE/FTS
    // clause against the real query and return nothing.
    const ids = await searchIds(app, db, `${Q}&search=${encodeURIComponent("totally-unrelated")}`);
    expect(ids.sort()).toEqual(["nm260001", "nm260002"]);
  });
});

describe("an invalid facet range surfaces as 400 on both endpoints", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
  });

  test("GET /datasets?subjects=abc -> 400", async () => {
    const res = await app.request("/?subjects=abc", {}, env(db));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("abc");
  });

  test("GET /datasets/search?...&subjects=abc -> 400", async () => {
    const res = await app.request(
      `/search?q=${encodeURIComponent("anything")}&subjects=abc`,
      {},
      env(db),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("abc");
  });
});
