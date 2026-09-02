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
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerCatalogRoutes } from "../src/routes/datasets/catalog";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

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
});
