/**
 * Epic #775 Phase 1 — OpenNeuro discovery + NEMAR dedup data layer.
 *
 * No mocks: the pure functions (modality filter, page parser, set-diff, status
 * bucketing) are tested directly, and the two dedup queries run against a real
 * bun:sqlite DB seeded with the actual `import_jobs` migration + a datasets
 * slice — same approach as archive-retry/catalog-fold tests.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVE_IMPORTS_QUERY,
  type DiscoveredDataset,
  IMPORTED_SOURCE_IDS_QUERY,
  bucketActiveImports,
  diffNewDatasets,
  discoverOpenNeuroDatasets,
  keepByModality,
  parseDatasetsPage,
} from "../src/services/openneuro-discovery";

describe("keepByModality", () => {
  test("in-scope modalities (incl. mixed) pass", () => {
    expect(keepByModality(["eeg"])).toBe(true);
    expect(keepByModality(["meg"])).toBe(true);
    expect(keepByModality(["ieeg"])).toBe(true);
    expect(keepByModality(["emg"])).toBe(true);
    expect(keepByModality(["nirs"])).toBe(true); // fNIRS
    expect(keepByModality(["motion"])).toBe(true); // MoBI
    expect(keepByModality(["eeg", "motion"])).toBe(true); // MoBI eeg+motion
    expect(keepByModality(["eeg", "mri"])).toBe(true); // mixed
    expect(keepByModality(["MOTION"])).toBe(true); // case-insensitive
    expect(keepByModality(["EEG"])).toBe(true); // case-insensitive
  });

  test("out-of-scope / empty / garbage rejected", () => {
    expect(keepByModality(["mri"])).toBe(false);
    expect(keepByModality(["pet"])).toBe(false);
    expect(keepByModality(["bold", "anat"])).toBe(false);
    expect(keepByModality([])).toBe(false);
    // @ts-expect-error defensive against non-array
    expect(keepByModality(null)).toBe(false);
    // @ts-expect-error defensive against non-string items
    expect(keepByModality([1, {}])).toBe(false);
  });
});

describe("parseDatasetsPage", () => {
  test("extracts datasets + cursor from a real response shape", () => {
    const json = {
      data: {
        datasets: {
          pageInfo: { hasNextPage: true, endCursor: "CURSOR1" },
          edges: [
            {
              node: {
                id: "ds000001",
                latestSnapshot: { tag: "1.0.0", summary: { modalities: ["EEG"] } },
              },
            },
            {
              node: {
                id: "ds000002",
                latestSnapshot: { tag: "00002", summary: { modalities: ["mri"] } },
              },
            },
          ],
        },
      },
    };
    const page = parseDatasetsPage(json);
    expect(page.hasNextPage).toBe(true);
    expect(page.endCursor).toBe("CURSOR1");
    expect(page.datasets).toEqual([
      { id: "ds000001", latestTag: "1.0.0", modalities: ["eeg"] }, // lowercased
      { id: "ds000002", latestTag: "00002", modalities: ["mri"] },
    ]);
  });

  test("tolerates missing latestSnapshot / summary / modalities without throwing", () => {
    const json = {
      data: {
        datasets: {
          pageInfo: {},
          edges: [
            { node: { id: "ds1" } }, // no snapshot
            { node: { id: "ds2", latestSnapshot: { tag: "1.0.0" } } }, // no summary
            { node: { id: "ds3", latestSnapshot: { summary: {} } } }, // no modalities/tag
            { node: { id: 123 } }, // bad id -> skipped
            "not-an-edge",
          ],
        },
      },
    };
    const page = parseDatasetsPage(json);
    expect(page.hasNextPage).toBe(false);
    expect(page.endCursor).toBeNull();
    expect(page.datasets).toEqual([
      { id: "ds1", latestTag: null, modalities: [] },
      { id: "ds2", latestTag: "1.0.0", modalities: [] },
      { id: "ds3", latestTag: null, modalities: [] },
    ]);
  });

  test("non-object / error payload -> empty terminal page", () => {
    expect(parseDatasetsPage(null)).toEqual({
      datasets: [],
      hasNextPage: false,
      endCursor: null,
      count: null,
      edgeCount: 0,
    });
    expect(parseDatasetsPage({ errors: [{ message: "boom" }] })).toEqual({
      datasets: [],
      hasNextPage: false,
      endCursor: null,
      count: null,
      edgeCount: 0,
    });
  });
});

describe("diffNewDatasets", () => {
  const ds = (id: string): DiscoveredDataset => ({ id, latestTag: "1.0.0", modalities: ["eeg"] });

  test("returns discovered minus imported/inFlight/terminal, order preserved", () => {
    const discovered = [ds("ds1"), ds("ds2"), ds("ds3"), ds("ds4"), ds("ds5")];
    const result = diffNewDatasets(
      discovered,
      new Set(["ds2"]), // imported
      new Set(["ds3"]), // in-flight
      new Set(["ds4"]), // terminal
    );
    expect(result.map((d) => d.id)).toEqual(["ds1", "ds5"]);
  });

  test("empty exclusions -> all new; everything excluded -> empty", () => {
    const discovered = [ds("ds1"), ds("ds2")];
    expect(diffNewDatasets(discovered, new Set(), new Set(), new Set()).map((d) => d.id)).toEqual([
      "ds1",
      "ds2",
    ]);
    expect(diffNewDatasets(discovered, new Set(["ds1", "ds2"]), new Set(), new Set())).toHaveLength(
      0,
    );
  });
});

describe("bucketActiveImports", () => {
  test("buckets in-flight vs terminal; excludes complete/failed", () => {
    const { inFlight, terminal } = bucketActiveImports([
      { source_id: "ds1", status: "preparing" },
      { source_id: "ds2", status: "copying" },
      { source_id: "ds3", status: "finalizing" },
      { source_id: "ds4", status: "quarantined" },
      { source_id: "ds5", status: "rolled_back" },
      { source_id: "ds6", status: "complete" }, // covered by datasets.source_id
      { source_id: "ds7", status: "failed" }, // transient; Phase 2 decides retry
    ]);
    expect([...inFlight].sort()).toEqual(["ds1", "ds2", "ds3"]);
    expect([...terminal].sort()).toEqual(["ds4", "ds5"]);
  });
});

describe("dedup queries (real bun:sqlite)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    // datasets slice the dedup query touches (incl. owner_user_id, used to
    // exclude folded catalog shadow rows).
    db.run(
      "CREATE TABLE datasets (dataset_id TEXT PRIMARY KEY, source TEXT, source_id TEXT, owner_user_id INTEGER);",
    );
    // The ACTUAL import_jobs migration (0044).
    const m0044 = readFileSync(
      join(import.meta.dir, "..", "src/db/migrations/0044_import_jobs.sql"),
      "utf8",
    );
    db.exec(m0044); // exec (not run): the migration is multi-statement
  });

  test("IMPORTED_SOURCE_IDS_QUERY returns only real managed openneuro source_ids (excludes catalog shadows)", () => {
    db.run(
      `INSERT INTO datasets (dataset_id, source, source_id, owner_user_id) VALUES
        ('on000132','openneuro','ds000132',15),  -- real managed import
        ('on007964','openneuro','ds007964',15),  -- real managed import
        ('ds000246','openneuro','ds000246',-1),  -- folded CATALOG SHADOW: must be excluded (#646)
        ('ds001785','openneuro','ds001785',-1),  -- folded CATALOG SHADOW: must be excluded
        ('nm000200','nemar.org',NULL,15),        -- not openneuro
        ('on999','openneuro',NULL,15);           -- openneuro but no source_id`,
    );
    const ids = (db.query(IMPORTED_SOURCE_IDS_QUERY).all() as { source_id: string }[]).map(
      (r) => r.source_id,
    );
    // ds000246 / ds001785 (owner=-1 catalog shadows) are NOT counted as imported,
    // so discovery will pick them up as candidates -- the 2026-06-20 stall fix.
    expect(ids.sort()).toEqual(["ds000132", "ds007964"]);
  });

  test("ACTIVE_IMPORTS_QUERY + bucketActiveImports over real import_jobs rows", () => {
    db.run(
      `INSERT INTO import_jobs (dataset_id, source, source_id, status) VALUES
        ('on1','openneuro','ds1','copying'),
        ('on2','openneuro','ds2','quarantined'),
        ('on3','openneuro','ds3','complete'),
        ('on4','openneuro','ds4','finalizing');`,
    );
    const rows = db.query(ACTIVE_IMPORTS_QUERY).all() as { source_id: string; status: string }[];
    const { inFlight, terminal } = bucketActiveImports(rows);
    expect([...inFlight].sort()).toEqual(["ds1", "ds4"]);
    expect([...terminal]).toEqual(["ds2"]);
  });
});

describe("discoverOpenNeuroDatasets pagination (injected fetch, real Responses)", () => {
  // Build a real GraphQL-page Response from dataset specs. No mock library:
  // a plain function returning genuine Response objects, testing the real loop.
  const node = (id: string, modalities: string[]) => ({
    node: { id, latestSnapshot: { tag: "1.0.0", summary: { modalities } } },
  });
  const pageResponse = (
    edges: ReturnType<typeof node>[],
    hasNextPage: boolean,
    endCursor: string | null,
  ) =>
    new Response(
      JSON.stringify({ data: { datasets: { pageInfo: { hasNextPage, endCursor }, edges } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  test("follows the cursor across pages and filters by modality", async () => {
    const pages = [
      pageResponse([node("ds1", ["eeg"]), node("ds2", ["mri"])], true, "C1"),
      pageResponse([node("ds3", ["meg"]), node("ds4", ["eeg", "mri"])], false, null),
    ];
    let i = 0;
    const got = await discoverOpenNeuroDatasets({ fetchImpl: async () => pages[i++] });
    expect(i).toBe(2); // both pages fetched
    expect(got.map((d) => d.id)).toEqual(["ds1", "ds3", "ds4"]); // ds2 (mri-only) dropped
  });

  test("a mid-scan GraphQL error with NO usable data THROWS instead of ending the scan silently", async () => {
    const pages = [
      pageResponse([node("ds1", ["eeg"])], true, "C1"),
      new Response(JSON.stringify({ data: null, errors: [{ message: "rate limited" }] }), {
        status: 200,
      }),
    ];
    let i = 0;
    await expect(discoverOpenNeuroDatasets({ fetchImpl: async () => pages[i++] })).rejects.toThrow(
      /no usable data.datasets on page 1: rate limited/,
    );
  });

  test("a PARTIAL errors array (valid data.datasets + per-dataset field error) does NOT throw", async () => {
    // OpenNeuro returns HTTP 200 with valid `data.datasets` AND an `errors` array
    // when one dataset's latestSnapshot 404s (path [...,"latestSnapshot"]). The scan
    // must proceed -- skipping only the broken dataset -- not abort the whole import.
    // This is the real-world bug that left auto-import dead despite real candidates.
    const pages = [
      new Response(
        JSON.stringify({
          data: {
            datasets: {
              pageInfo: { hasNextPage: true, endCursor: "C1" },
              // ds1 valid; ds2's snapshot resolution failed -> field nulled.
              edges: [node("ds1", ["eeg"]), { node: { id: "ds2", latestSnapshot: null } }],
            },
          },
          errors: [
            { message: "Not Found", path: ["datasets", "edges", 1, "node", "latestSnapshot"] },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      pageResponse([node("ds3", ["meg"])], false, null),
    ];
    let i = 0;
    const got = await discoverOpenNeuroDatasets({ fetchImpl: async () => pages[i++] });
    expect(i).toBe(2); // pagination continued past the partial-error page
    // ds1 + ds3 kept; ds2 (null snapshot -> no modalities) skipped, not fatal.
    expect(got.map((d) => d.id)).toEqual(["ds1", "ds3"]);
  });

  test("hitting the maxPages cap with more pages THROWS (never silently truncates)", async () => {
    // Every page claims another page -> the cap, not the API, stops the scan.
    const fetchImpl = async () => pageResponse([node("dsX", ["eeg"])], true, "NEXT");
    await expect(discoverOpenNeuroDatasets({ fetchImpl, maxPages: 2 })).rejects.toThrow(
      /maxPages cap \(2\)/,
    );
  });

  test("a non-2xx HTTP response THROWS", async () => {
    const fetchImpl = async () => new Response("upstream down", { status: 503 });
    await expect(discoverOpenNeuroDatasets({ fetchImpl })).rejects.toThrow(/HTTP 503 on page 0/);
  });

  test("a 200 with data.datasets=null (no errors array) THROWS, not a silent empty scan", async () => {
    // GraphQL partial success: the connection field is null but there is no
    // `errors` array. parseDatasetsPage would read it as an empty terminal page;
    // discover must throw so dedup never mistakes it for "nothing new" (#784).
    const fetchImpl = async () =>
      new Response(JSON.stringify({ data: { datasets: null } }), { status: 200 });
    await expect(discoverOpenNeuroDatasets({ fetchImpl })).rejects.toThrow(
      /no usable data\.datasets on page 0/,
    );
  });

  // A page WITH OpenNeuro's pageInfo.count (the total). The completeness guard
  // cross-checks scanned edges against this total.
  const pageWithCount = (
    edges: ReturnType<typeof node>[],
    count: number,
    hasNextPage: boolean,
    endCursor: string | null,
  ) =>
    new Response(
      JSON.stringify({
        data: { datasets: { pageInfo: { count, hasNextPage, endCursor }, edges } },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  test("THROWS if pagination ends far below pageInfo.count (silent-truncation guard)", async () => {
    // OpenNeuro reports 1000 total but the connection claims no next page after 3
    // edges -> a truncated scan. Must fail loud, not import a 3-of-1000 slice.
    const fetchImpl = async () =>
      pageWithCount(
        [node("ds1", ["eeg"]), node("ds2", ["meg"]), node("ds3", ["nirs"])],
        1000,
        false,
        null,
      );
    await expect(discoverOpenNeuroDatasets({ fetchImpl })).rejects.toThrow(
      /truncated: scanned 3 of ~1000/,
    );
  });

  test("full coverage (scanned ~= pageInfo.count) does NOT throw", async () => {
    // 2 pages, 4 datasets, count=4 -> complete; the guard passes.
    const pages = [
      pageWithCount([node("ds1", ["eeg"]), node("ds2", ["meg"])], 4, true, "C1"),
      pageWithCount([node("ds3", ["ieeg"]), node("ds4", ["motion"])], 4, false, null),
    ];
    let i = 0;
    const got = await discoverOpenNeuroDatasets({ fetchImpl: async () => pages[i++] });
    expect(got.map((d) => d.id)).toEqual(["ds1", "ds2", "ds3", "ds4"]); // incl. motion
  });
});
