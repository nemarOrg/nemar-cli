/**
 * Real-route tests for `has_zarr` and the zarr fields on the public catalog
 * (issue #1062, epic #1181 phase 2), driven through the actual registered
 * Hono routes (`registerCatalogRoutes`) against a real bun:sqlite-backed D1
 * -- no mocks, and no hand-copied SQL. Mirrors facet-filters-route.test.ts's
 * harness (freshDb/realD1, listIds/searchIds helpers).
 *
 * Per `.rules/testing.md`'s "test the entry point" rule: every assertion
 * here goes through the real registered route, not `buildDatasetFilterClauses`
 * in isolation -- a handler that parsed `has_zarr` and never threaded it into
 * `filters` would fail these tests even though the clause builder is correct.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { datasetDetailSchema } from "../../shared/contract/dataset";
import { registerZarrReadyRoutes } from "../src/routes/callbacks/zarr-ready";
import {
  deriveZarrIndexUrl,
  parseZarrDataFailures,
  registerCatalogRoutes,
} from "../src/routes/datasets/catalog";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { installWorkersTimingSafeEqual } from "./helpers/workers-crypto";

// `crypto.subtle.timingSafeEqual` is a Cloudflare Workers extension to Web
// Crypto that bun's runtime lacks, so the zarr-ready handler's token check
// needs it. See helpers/workers-crypto.ts for why this isn't a mock and why
// it's still installed now that lib/constant-time.ts feature-detects this
// itself: it keeps this suite exercising the native branch.
installWorkersTimingSafeEqual();

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(db: Database, zarrCacheBaseUrl?: string): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "development",
    ...(zarrCacheBaseUrl ? { ZARR_CACHE_BASE_URL: zarrCacheBaseUrl } : {}),
  } as Bindings;
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

interface ListedDataset {
  dataset_id: string;
  zarr_status?: string | null;
  zarr_store_count?: number | null;
  zarr_converted_at?: string | null;
  zarr_source_commit?: string | null;
  zarr_errors?: number | null;
  zarr_failure_count?: number | null;
  zarr_deterministic?: number | null;
  zarr_failed_at?: string | null;
  zarr_index_url?: string | null;
}

async function listDatasets(app: App, db: Database, qs: string): Promise<ListedDataset[]> {
  const res = await app.request(`/?${qs}`, {}, env(db));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { datasets: ListedDataset[] };
  return body.datasets;
}

async function searchIds(app: App, db: Database, qs: string): Promise<string[]> {
  const res = await app.request(`/search?${qs}`, {}, env(db));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { results: { id: string }[] };
  return body.results.map((r) => r.id);
}

describe("has_zarr filter: GET /datasets", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    insertDataset(db, "nm400001", {
      name: "Ready with stores",
      zarr_status: "ready",
      zarr_store_count: 3,
    });
    insertDataset(db, "nm400002", {
      name: "Ready but zero stores",
      zarr_status: "ready",
      zarr_store_count: 0,
    });
    insertDataset(db, "nm400003", { name: "Pending", zarr_status: "pending" });
    insertDataset(db, "nm400004", { name: "Never converted" }); // zarr_status NULL
  });

  test("has_zarr=1 returns only the ready-with-stores row", async () => {
    const rows = await listDatasets(app, db, "has_zarr=1");
    expect(rows.map((r) => r.dataset_id)).toEqual(["nm400001"]);
  });

  test("has_zarr=true (website convention) behaves identically to has_zarr=1", async () => {
    const rows = await listDatasets(app, db, "has_zarr=true");
    expect(rows.map((r) => r.dataset_id)).toEqual(["nm400001"]);
  });

  test("no has_zarr filter returns every row, including pending/zero-store/NULL", async () => {
    const rows = await listDatasets(app, db, "");
    expect(rows.map((r) => r.dataset_id).sort()).toEqual([
      "nm400001",
      "nm400002",
      "nm400003",
      "nm400004",
    ]);
  });

  test("a ready row with a NULL store_count is excluded (COALESCE guard)", async () => {
    insertDataset(db, "nm400005", { name: "Ready, count never populated", zarr_status: "ready" });
    const rows = await listDatasets(app, db, "has_zarr=1");
    expect(rows.map((r) => r.dataset_id)).not.toContain("nm400005");
  });
});

// PR #1201 review, item 8: has_zarr combined with an unrelated legacy filter
// (has_hed) and a facet-adjacent one (modality), through the real route --
// proves the two clauses AND together rather than one silently overriding
// the other.
// Issue #1068, epic #1181 phase 8: has_zarr keeps its EXISTING meaning
// ("converted", ready + stores) under every caller that already relies on
// it; has_zarr_verified is a SEPARATE, stricter filter this sweep feeds.
describe("has_zarr_verified filter: GET /datasets (issue #1068, epic #1181 phase 8)", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    insertDataset(db, "nm004301", {
      name: "Ready with stores, verified",
      zarr_status: "ready",
      zarr_store_count: 3,
      sweep_stamps: JSON.stringify({ zarr_verify_status: "verified" }),
    });
    insertDataset(db, "nm004302", {
      name: "Ready with stores, failed verification",
      zarr_status: "ready",
      zarr_store_count: 3,
      sweep_stamps: JSON.stringify({ zarr_verify_status: "failed" }),
    });
    insertDataset(db, "nm004303", {
      name: "Ready with stores, unverifiable",
      zarr_status: "ready",
      zarr_store_count: 3,
      sweep_stamps: JSON.stringify({ zarr_verify_status: "unverifiable" }),
    });
    insertDataset(db, "nm004304", {
      name: "Ready with stores, never swept",
      zarr_status: "ready",
      zarr_store_count: 3,
    });
    insertDataset(db, "nm004305", {
      name: "Not converted at all",
      zarr_status: "pending",
    });
  });

  test("has_zarr=1 (UNCHANGED meaning) returns every converted row regardless of verify status", async () => {
    const rows = await listDatasets(app, db, "has_zarr=1");
    expect(rows.map((r) => r.dataset_id).sort()).toEqual([
      "nm004301",
      "nm004302",
      "nm004303",
      "nm004304",
    ]);
  });

  test("has_zarr_verified=1 returns ONLY the verified row", async () => {
    const rows = await listDatasets(app, db, "has_zarr_verified=1");
    expect(rows.map((r) => r.dataset_id)).toEqual(["nm004301"]);
  });

  test("has_zarr_verified=true (website convention) behaves identically to =1", async () => {
    const rows = await listDatasets(app, db, "has_zarr_verified=true");
    expect(rows.map((r) => r.dataset_id)).toEqual(["nm004301"]);
  });

  test("no has_zarr_verified filter returns every row, including the unswept/failed/unverifiable ones", async () => {
    const rows = await listDatasets(app, db, "");
    expect(rows.map((r) => r.dataset_id).sort()).toEqual([
      "nm004301",
      "nm004302",
      "nm004303",
      "nm004304",
      "nm004305",
    ]);
  });

  test("the zarr_verify_status/zarr_verified_at fields are present on the list row", async () => {
    const rows = await listDatasets(app, db, "");
    const verified = rows.find((r) => r.dataset_id === "nm004301") as unknown as {
      zarr_verify_status?: string | null;
    };
    const neverSwept = rows.find((r) => r.dataset_id === "nm004304") as unknown as {
      zarr_verify_status?: string | null;
    };
    expect(verified.zarr_verify_status).toBe("verified");
    expect(neverSwept.zarr_verify_status).toBeNull();
  });

  test("GET /datasets/:id also derives zarr_verify_status/zarr_verified_at", async () => {
    db.query(
      "UPDATE datasets SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.zarr_verified_at', '2026-09-01 00:00:00') WHERE dataset_id = 'nm004301'",
    ).run();
    const res = await app.request("/nm004301", {}, env(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dataset: { zarr_verify_status?: string | null; zarr_verified_at?: string | null };
    };
    expect(body.dataset.zarr_verify_status).toBe("verified");
    expect(body.dataset.zarr_verified_at).toBe("2026-09-01 00:00:00");
  });
});

describe("has_zarr combined with another filter: GET /datasets", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    insertDataset(db, "nm405001", {
      name: "Ready + HED",
      zarr_status: "ready",
      zarr_store_count: 3,
      has_hed: 1,
      modalities: "eeg",
    });
    insertDataset(db, "nm405002", {
      name: "Ready, no HED",
      zarr_status: "ready",
      zarr_store_count: 3,
      has_hed: 0,
      modalities: "eeg",
    });
    insertDataset(db, "nm405003", {
      name: "HED, but not ready",
      zarr_status: "pending",
      has_hed: 1,
      modalities: "eeg",
    });
    insertDataset(db, "nm405004", {
      name: "Ready + HED, different modality",
      zarr_status: "ready",
      zarr_store_count: 3,
      has_hed: 1,
      modalities: "meg",
    });
  });

  test("has_zarr=1&has_hed=1 requires BOTH -- excludes the not-ready and no-HED rows", async () => {
    const rows = await listDatasets(app, db, "has_zarr=1&has_hed=1");
    // nm405001/nm405004 are both ready+HED (differing only by modality,
    // irrelevant to this filter pair); nm405002 lacks HED and nm405003
    // isn't ready -- both correctly excluded.
    expect(rows.map((r) => r.dataset_id).sort()).toEqual(["nm405001", "nm405004"]);
  });

  test("has_zarr=1&modality=eeg requires BOTH -- excludes the ready+HED meg row", async () => {
    const rows = await listDatasets(app, db, "has_zarr=1&modality=eeg");
    expect(rows.map((r) => r.dataset_id).sort()).toEqual(["nm405001", "nm405002"]);
  });
});

describe("has_zarr filter: GET /datasets/search", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    insertDataset(db, "nm410001", {
      name: "Search Zarr Fixture Alpha",
      zarr_status: "ready",
      zarr_store_count: 5,
    });
    insertDataset(db, "nm410002", {
      name: "Search Zarr Fixture Beta",
      zarr_status: "pending",
    });
  });

  const Q = `q=${encodeURIComponent("Search Zarr Fixture")}`;

  test("has_zarr=1 excludes a pending dataset from search results", async () => {
    const ids = await searchIds(app, db, `${Q}&has_zarr=1`);
    expect(ids).toEqual(["nm410001"]);
  });

  test("no has_zarr filter returns both datasets from search", async () => {
    const ids = await searchIds(app, db, Q);
    expect(ids.sort()).toEqual(["nm410001", "nm410002"]);
  });

  test("has_zarr also applies on the exact-id lookup tier", async () => {
    // nm410002 (pending) hits the exact-id tier for its own id and must be
    // filtered out there too, not just on the fused FTS/semantic tiers.
    const idsWithFilter = await searchIds(app, db, "q=nm410002&has_zarr=1");
    expect(idsWithFilter).not.toContain("nm410002");
  });
});

// Issue #1068, epic #1181 phase 8, PR #1203 review item 14: has_zarr_verified
// must filter GET /datasets/search server-side, not just the list endpoint.
describe("has_zarr_verified filter: GET /datasets/search", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    insertDataset(db, "nm411001", {
      name: "Search Verified Fixture Alpha",
      zarr_status: "ready",
      zarr_store_count: 5,
      sweep_stamps: JSON.stringify({ zarr_verify_status: "verified" }),
    });
    insertDataset(db, "nm411002", {
      name: "Search Verified Fixture Beta",
      zarr_status: "ready",
      zarr_store_count: 5,
      sweep_stamps: JSON.stringify({ zarr_verify_status: "failed" }),
    });
  });

  const Q = `q=${encodeURIComponent("Search Verified Fixture")}`;

  test("has_zarr_verified=1 excludes a has_zarr row that failed verification", async () => {
    const ids = await searchIds(app, db, `${Q}&has_zarr_verified=1`);
    expect(ids).toEqual(["nm411001"]);
  });

  test("no has_zarr_verified filter returns both datasets from search", async () => {
    const ids = await searchIds(app, db, Q);
    expect(ids.sort()).toEqual(["nm411001", "nm411002"]);
  });

  test("has_zarr_verified also applies on the exact-id lookup tier", async () => {
    const idsWithFilter = await searchIds(app, db, "q=nm411002&has_zarr_verified=1");
    expect(idsWithFilter).not.toContain("nm411002");
  });
});

describe("the zarr fields are present on GET /datasets rows", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    insertDataset(db, "nm420001", {
      name: "Full zarr facts",
      zarr_status: "ready",
      zarr_store_count: 41,
      zarr_converted_at: "2026-08-01T00:00:00.000Z",
      zarr_source_commit: "abc123",
      zarr_errors: 2,
      zarr_failure_count: 1,
      zarr_deterministic: 1,
      zarr_failed_at: "2026-08-01T00:05:00.000Z",
    });
  });

  test("every new zarr_* field from FACET_PROJECTION_COLUMNS is on the list row", async () => {
    const rows = await listDatasets(app, db, "");
    const row = rows.find((r) => r.dataset_id === "nm420001");
    expect(row).toBeDefined();
    expect(row?.zarr_store_count).toBe(41);
    expect(row?.zarr_converted_at).toBe("2026-08-01T00:00:00.000Z");
    expect(row?.zarr_source_commit).toBe("abc123");
    expect(row?.zarr_errors).toBe(2);
    expect(row?.zarr_failure_count).toBe(1);
    expect(row?.zarr_deterministic).toBe(1);
    expect(row?.zarr_failed_at).toBe("2026-08-01T00:05:00.000Z");
  });

  // #1169-review precedent (facet-filters-route.test.ts): ?mine=true shares
  // executeAndReturn/FACET_PROJECTION_COLUMNS with the public branch, but
  // "it's the same code" is exactly the kind of claim that needs driving for
  // real -- ?mine is the branch a signed-in user actually hits.
  test("the zarr fields are also present on the authenticated ?mine=true branch", async () => {
    const API_KEY = "zarr-mine-fields-key-0123456789abcdef012345";
    db.run(
      "INSERT INTO users (id, username, email, password_hash, status, role, email_verified) VALUES (21, 'zarrmine', 'zarrmine@example.org', 'x', 'approved', 'member', 1)",
    );
    db.run("UPDATE datasets SET owner_user_id = 21 WHERE dataset_id = 'nm420001'");
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (21, ?, ?)").run(
      await hashApiKey(API_KEY),
      API_KEY.slice(0, 8),
    );

    const res = await app.request(
      "/?mine=true",
      { headers: { Authorization: `Bearer ${API_KEY}` } },
      env(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { datasets: ListedDataset[] };
    const row = body.datasets.find((r) => r.dataset_id === "nm420001");
    expect(row?.zarr_store_count).toBe(41);
    expect(row?.zarr_errors).toBe(2);
    expect(row?.zarr_deterministic).toBe(1);
  });
});

describe("zarr_index_url is derived, and null when not ready", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    insertDataset(db, "nm043001", {
      name: "Ready dataset",
      zarr_status: "ready",
      zarr_store_count: 2,
    });
    insertDataset(db, "nm043002", { name: "Pending dataset", zarr_status: "pending" });
  });

  test("a ready dataset gets an absolute index_url built from ZARR_CACHE_BASE_URL", async () => {
    const res = await app.request("/", {}, env(db, "https://zarr.nemar.org"));
    const body = (await res.json()) as { datasets: ListedDataset[] };
    const row = body.datasets.find((r) => r.dataset_id === "nm043001");
    expect(row?.zarr_index_url).toBe("https://zarr.nemar.org/nm043001/zarr/index.json");
  });

  test("a non-ready dataset gets a null index_url even when ZARR_CACHE_BASE_URL is set", async () => {
    const res = await app.request("/", {}, env(db, "https://zarr.nemar.org"));
    const body = (await res.json()) as { datasets: ListedDataset[] };
    const row = body.datasets.find((r) => r.dataset_id === "nm043002");
    expect(row?.zarr_index_url).toBeNull();
  });

  test("a ready dataset gets a null index_url when ZARR_CACHE_BASE_URL is unset", async () => {
    const res = await app.request("/", {}, env(db));
    const body = (await res.json()) as { datasets: ListedDataset[] };
    const row = body.datasets.find((r) => r.dataset_id === "nm043001");
    expect(row?.zarr_index_url).toBeNull();
  });

  test("GET /datasets/:id also derives zarr_index_url", async () => {
    const res = await app.request("/nm043001", {}, env(db, "https://zarr.nemar.org"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dataset: { zarr_index_url?: string | null } };
    expect(body.dataset.zarr_index_url).toBe("https://zarr.nemar.org/nm043001/zarr/index.json");
  });
});

// PR #1201 review, item 8: deriveZarrIndexUrl unit-tested directly, beyond
// the route-level "default prod host" coverage above -- a non-default base
// (staging's zarr-test.nemar.org) and a base carrying its own trailing
// slash, which a caller could plausibly pass since ZARR_CACHE_BASE_URL is a
// raw env var with no format enforcement upstream.
describe("deriveZarrIndexUrl (unit)", () => {
  test("works with a non-default (staging) base host", () => {
    expect(deriveZarrIndexUrl("https://zarr-test.nemar.org", "on007763", "ready")).toBe(
      "https://zarr-test.nemar.org/on007763/zarr/index.json",
    );
  });

  test("a base with its own trailing slash does not produce a double slash", () => {
    expect(deriveZarrIndexUrl("https://zarr.nemar.org/", "on007763", "ready")).toBe(
      "https://zarr.nemar.org/on007763/zarr/index.json",
    );
  });

  test("null base (ZARR_CACHE_BASE_URL unset) is always null regardless of status", () => {
    expect(deriveZarrIndexUrl(null, "on007763", "ready")).toBeNull();
  });

  test("non-'ready' status is always null regardless of base", () => {
    expect(deriveZarrIndexUrl("https://zarr.nemar.org", "on007763", "pending")).toBeNull();
    expect(deriveZarrIndexUrl("https://zarr.nemar.org", "on007763", null)).toBeNull();
    expect(deriveZarrIndexUrl("https://zarr.nemar.org", "on007763", undefined)).toBeNull();
  });
});

describe("zarr_data_failures is a parsed object on GET /datasets/:id, never a raw string", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
    insertDataset(db, "nm044001", {
      name: "Compacted failures",
      zarr_status: "ready",
      zarr_store_count: 2,
      zarr_data_failures: JSON.stringify({
        count: 36,
        detail_ref: "zarr/index.json",
        compacted_by: "migration_0074",
      }),
    });
    insertDataset(db, "nm044002", {
      name: "Fresh-write failures (no compacted_by)",
      zarr_status: "ready",
      zarr_store_count: 2,
      zarr_data_failures: JSON.stringify({ count: 5, detail_ref: "zarr/index.json" }),
    });
    insertDataset(db, "nm044003", {
      name: "No failures on record",
      zarr_status: "ready",
      zarr_store_count: 2,
      zarr_data_failures: null,
    });
    // Legacy shape, defensive per the brief: should not exist post migration
    // 0074, but the parser must not crash or forward it raw.
    insertDataset(db, "nm044004", {
      name: "Legacy array shape",
      zarr_status: "ready",
      zarr_store_count: 2,
      zarr_data_failures: JSON.stringify([{ path: "a" }, { path: "b" }, { path: "c" }]),
    });
    // PR #1201 review, item 1: malformed input must never 500 the response.
    insertDataset(db, "nm044005", {
      name: "Malformed JSON",
      zarr_status: "ready",
      zarr_store_count: 2,
      zarr_data_failures: "{not valid json",
    });
    insertDataset(db, "nm044006", {
      name: "Bare number (parses, but neither object nor array)",
      zarr_status: "ready",
      zarr_store_count: 2,
      zarr_data_failures: "42",
    });
  });

  test("a compacted-by-migration object is served as-is, as an object", async () => {
    const res = await app.request("/nm044001", {}, env(db));
    const body = (await res.json()) as {
      dataset: { zarr_data_failures: unknown };
    };
    expect(body.dataset.zarr_data_failures).toEqual({
      count: 36,
      detail_ref: "zarr/index.json",
      compacted_by: "migration_0074",
    });
  });

  test("a fresh-write object (no compacted_by) is served as an object", async () => {
    const res = await app.request("/nm044002", {}, env(db));
    const body = (await res.json()) as {
      dataset: { zarr_data_failures: unknown };
    };
    expect(body.dataset.zarr_data_failures).toEqual({ count: 5, detail_ref: "zarr/index.json" });
  });

  test("NULL is served as null, not an empty object", async () => {
    const res = await app.request("/nm044003", {}, env(db));
    const body = (await res.json()) as {
      dataset: { zarr_data_failures: unknown };
    };
    expect(body.dataset.zarr_data_failures).toBeNull();
  });

  test("a legacy array is defensively converted to {count, detail_ref}, never forwarded raw", async () => {
    const res = await app.request("/nm044004", {}, env(db));
    const body = (await res.json()) as {
      dataset: { zarr_data_failures: unknown };
    };
    expect(body.dataset.zarr_data_failures).toEqual({ count: 3, detail_ref: "zarr/index.json" });
    expect(typeof body.dataset.zarr_data_failures).toBe("object");
  });

  test("malformed JSON never 500s the response -- 200 with zarr_data_failures null", async () => {
    const res = await app.request("/nm044005", {}, env(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dataset: { zarr_data_failures: unknown } };
    expect(body.dataset.zarr_data_failures).toBeNull();
  });

  test("a bare parsed number never 500s the response -- 200 with zarr_data_failures null", async () => {
    const res = await app.request("/nm044006", {}, env(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dataset: { zarr_data_failures: unknown } };
    expect(body.dataset.zarr_data_failures).toBeNull();
  });
});

describe("the zarr summary survives callback -> D1 -> GET /datasets/:id -> the contract", () => {
  /**
   * The seam three separate reviews found broken, driven end to end rather than
   * per layer. `zarrFailureColumns` wrote `pending`/`discovered` into the stored
   * object (#1197), `parseZarrDataFailures` projected neither, and the contract
   * stripped what it did not declare -- so counts that existed in D1 reached no
   * consumer, and every layer's own tests passed. Only a test that runs the REAL
   * callback route against a real D1 and then the REAL detail route over the
   * same row, and finally parses the response with the shipped contract, can
   * fail when one of the three is missed.
   */
  let db: Database;
  let catalog: App;
  let callbacks: Hono<{ Bindings: Bindings }>;
  const TOKEN = "round-trip-webhook-token";
  const DATASET = "nm044100";

  const post = (body: Record<string, unknown>) =>
    callbacks.request(
      "/zarr-ready",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Token": TOKEN },
        body: JSON.stringify(body),
      },
      { DB: realD1(db), NEMAR_WEBHOOK_TOKEN: TOKEN, ENVIRONMENT: "test" } as Bindings,
    );

  /** GET /datasets/:id, parsed by the SHIPPED contract, not by hand. */
  const detail = async () => {
    const res = await catalog.request(`/${DATASET}`, {}, env(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dataset: Record<string, unknown> };
    // #1224 review: the detail route now stringifies `id` at the source
    // (catalog.ts), so this no longer needs a hand stringification
    // workaround -- parse the response exactly as served.
    return datasetDetailSchema.parse(body.dataset);
  };

  beforeEach(() => {
    db = freshDb();
    catalog = newApp();
    callbacks = new Hono<{ Bindings: Bindings }>();
    registerZarrReadyRoutes(callbacks);
    // `file_size` is set because the SHIPPED contract requires the derived
    // `file_size_formatted` to be a string; the list/detail shaping derives it
    // from this column, and parsing the response with the real contract is the
    // point of this block.
    insertDataset(db, DATASET, { name: "Round trip", file_size: 123456 });
  });

  test("the coverage counts reach the response the converter reported them for", async () => {
    expect(
      (
        await post({
          dataset_id: DATASET,
          status: "ready",
          store_count: 2,
          errors: 41,
          failure_count: 36,
          data_failures: [{ path: "sub-03/eeg/c_eeg.edf", code: "file_read_error" }],
          pending_count: 5,
          discovered_count: 43,
        })
      ).status,
    ).toBe(200);

    const summary = (await detail()).zarr_data_failures;
    expect(summary?.count).toBe(1);
    expect(summary?.pending).toBe(5);
    expect(summary?.discovered).toBe(43);
    expect(summary?.detail_ref).toBe("zarr/index.json");
  });

  test("an unpublished sibling document is visible, and clears when it publishes", async () => {
    // Until now this condition existed only as a console.warn in the Worker log:
    // unqueryable, and gone with the log. index.json and manifest.json then
    // disagree about which stores exist, and nothing off-node could say so.
    await post({
      dataset_id: DATASET,
      status: "ready",
      store_count: 2,
      errors: 0,
      events_upload_failed: true,
      manifest_upload_failed: true,
    });
    const failed = (await detail()).zarr_data_failures;
    expect(failed?.events_upload_failed).toBe(true);
    expect(failed?.manifest_upload_failed).toBe(true);
    // A run with no failures and no pending recordings is not "clean" while a
    // sibling is missing, so the summary is written at all.
    expect(failed?.count).toBe(0);

    // The next run publishes both, reports them false, and the claim goes away
    // rather than sticking to the row forever.
    await post({
      dataset_id: DATASET,
      status: "ready",
      store_count: 2,
      errors: 0,
      events_upload_failed: false,
      manifest_upload_failed: false,
    });
    expect((await detail()).zarr_data_failures).toBeNull();
  });

  test("a converter that reports none of them still round-trips", async () => {
    // The pre-#1197 body shape: the summary must stay exactly the #1191 object.
    await post({
      dataset_id: DATASET,
      status: "ready",
      store_count: 2,
      errors: 1,
      failure_count: 1,
      data_failures: [{ path: "a" }],
    });
    expect((await detail()).zarr_data_failures).toEqual({
      count: 1,
      detail_ref: "zarr/index.json",
    });
  });
});

describe("parseZarrDataFailures: malformed input logs and returns null (PR #1201 review, item 1)", () => {
  let originalError: typeof console.error;
  let calls: unknown[][];

  beforeEach(() => {
    calls = [];
    originalError = console.error;
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };
  });

  afterEach(() => {
    console.error = originalError;
  });

  test("an unparseable non-empty string logs '[catalog] zarr_data_failures unparseable...' and returns null", () => {
    const result = parseZarrDataFailures("{not valid json", "nm044005");
    expect(result).toBeNull();
    expect(calls.length).toBe(1);
    const [message, detail] = calls[0] as [string, { dataset_id?: string; reason?: string }];
    expect(message).toBe("[catalog] zarr_data_failures unparseable, treating as none");
    expect(detail.dataset_id).toBe("nm044005");
    expect(typeof detail.reason).toBe("string");
    expect(detail.reason?.length).toBeGreaterThan(0);
  });

  test("a bare number (parses fine, but is neither object nor array) also logs and returns null", () => {
    const result = parseZarrDataFailures("42", "nm044006");
    expect(result).toBeNull();
    expect(calls.length).toBe(1);
    const [message, detail] = calls[0] as [string, { dataset_id?: string; reason?: string }];
    expect(message).toBe("[catalog] zarr_data_failures unparseable, treating as none");
    expect(detail.dataset_id).toBe("nm044006");
    expect(detail.reason).toContain("number");
  });

  test("a well-formed object does NOT log (the common, expected case stays silent)", () => {
    const result = parseZarrDataFailures(
      JSON.stringify({ count: 1, detail_ref: "zarr/index.json" }),
      "nm044001",
    );
    expect(result).toEqual({ count: 1, detail_ref: "zarr/index.json" });
    expect(calls.length).toBe(0);
  });

  test("null/absent input does NOT log either", () => {
    expect(parseZarrDataFailures(null, "nm044003")).toBeNull();
    expect(parseZarrDataFailures(undefined, "nm044003")).toBeNull();
    expect(calls.length).toBe(0);
  });
});
