/**
 * Real-route tests for the catalog's publication date (#1477): `sort=newest`
 * (the default), `sort=oldest`, `?recent=`, and the MCP `search_datasets`
 * browse order all read `PUBLISHED_AT_SQL` (first publication, else a legacy
 * `publish_date`, else row creation), not when the draft row was created.
 * Driven through the registered Hono routes and the real tool entry point
 * against a real bun:sqlite-backed D1, like catalog-has-zarr.test.ts -- no
 * mocks.
 *
 * The rows mirror production on 2026-09-22: nm000279 was drafted 2026-07-05
 * and published 2026-09-16, yet sorted 13th under `created_at DESC`, behind
 * on008768 (created and published 2026-09-08).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SearchDatasetsInput } from "../../shared/contract/mcp";
import { searchDatasetsTool } from "../src/mcp/tools/search-datasets";
import { registerCatalogRoutes } from "../src/routes/datasets/catalog";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(db: Database): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "development" } as Bindings;
}

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
  created_at: string;
  first_published_at?: string | null;
}

async function list(app: App, db: Database, qs: string): Promise<ListedDataset[]> {
  const res = await app.request(`/?${qs}`, {}, env(db));
  expect(res.status).toBe(200);
  return ((await res.json()) as { datasets: ListedDataset[] }).datasets;
}

const ids = (rows: ListedDataset[]) => rows.map((r) => r.dataset_id);

describe("date sorts order by publication, not draft creation (#1477)", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = new Hono();
    registerCatalogRoutes(app);
    // Drafted long before it went public: the case the old sort buried.
    insertDataset(db, "nm000279", {
      created_at: "2026-07-05 20:31:40",
      first_published_at: "2026-09-16 17:22:37",
    });
    // An import, published minutes after its row was created.
    insertDataset(db, "on008768", {
      created_at: "2026-09-08 22:30:51",
      first_published_at: "2026-09-08 22:43:37",
    });
    // No publication stamp: falls back to created_at.
    insertDataset(db, "nm000300", {
      created_at: "2026-09-10 12:00:00",
      first_published_at: null,
    });
  });

  test("sort=newest puts the most recently published first", async () => {
    expect(ids(await list(app, db, "sort=newest"))).toEqual(["nm000279", "nm000300", "on008768"]);
  });

  test("newest is also the default when no sort is given", async () => {
    expect(ids(await list(app, db, ""))).toEqual(["nm000279", "nm000300", "on008768"]);
  });

  test("sort=oldest is the exact reverse", async () => {
    expect(ids(await list(app, db, "sort=oldest"))).toEqual(["on008768", "nm000300", "nm000279"]);
  });

  test("sort=citations breaks ties by publication date", async () => {
    db.run("UPDATE datasets SET num_dataset_citations = 5");
    expect(ids(await list(app, db, "sort=citations"))).toEqual([
      "nm000279",
      "nm000300",
      "on008768",
    ]);
  });

  test("each row carries first_published_at, null when never published", async () => {
    const rows = await list(app, db, "sort=newest");
    expect(rows.find((r) => r.dataset_id === "nm000279")?.first_published_at).toBe(
      "2026-09-16 17:22:37",
    );
    expect(rows.find((r) => r.dataset_id === "nm000300")?.first_published_at).toBeNull();
  });

  // ?mine=true shares buildSortClause with the public branch but has its own
  // projection, so drive it for real: an owner's unpublished draft sorts by
  // its creation date among their published datasets.
  test("the authenticated ?mine=true branch sorts and projects the same way", async () => {
    const API_KEY = "sort-published-mine-key-0123456789abcdef01";
    db.run(
      "INSERT INTO users (id, username, email, password_hash, status, role, email_verified) VALUES (31, 'sortmine', 'sortmine@example.org', 'x', 'approved', 'member', 1)",
    );
    db.run("UPDATE datasets SET owner_user_id = 31");
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (31, ?, ?)").run(
      await hashApiKey(API_KEY),
      API_KEY.slice(0, 8),
    );

    const res = await app.request(
      "/?mine=true&sort=newest",
      { headers: { Authorization: `Bearer ${API_KEY}` } },
      env(db),
    );
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { datasets: ListedDataset[] }).datasets;
    expect(ids(rows)).toEqual(["nm000279", "nm000300", "on008768"]);
    expect(rows[0]?.first_published_at).toBe("2026-09-16 17:22:37");
  });
});

/** SQLite `datetime('now', '-N days')`'s own format, so string comparison
 *  against the `recent` clause holds. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
}

describe("recent= counts a dataset from its publication, not its draft (#1477)", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = new Hono();
    registerCatalogRoutes(app);
    // Drafted two months ago, published yesterday: recently published.
    insertDataset(db, "nm000401", { created_at: daysAgo(60), first_published_at: daysAgo(1) });
    // Created and published three days ago.
    insertDataset(db, "nm000402", { created_at: daysAgo(3), first_published_at: daysAgo(3) });
    // Published a month ago: not recent.
    insertDataset(db, "nm000403", { created_at: daysAgo(60), first_published_at: daysAgo(30) });
    // A legacy folded-catalog row: no stamp, but a recent publish_date, which
    // the old COALESCE(publish_date, created_at) honored and must still count.
    insertDataset(db, "ds000404", {
      created_at: daysAgo(90),
      first_published_at: null,
      publish_date: daysAgo(2),
    });
  });

  test("recent=7 keeps the three published in the last week", async () => {
    expect(ids(await list(app, db, "recent=7")).sort()).toEqual([
      "ds000404",
      "nm000401",
      "nm000402",
    ]);
  });
});

describe("MCP search_datasets browses newest-published first (#1477)", () => {
  test("the no-query branch orders like the list route's default", async () => {
    const db = freshDb();
    insertDataset(db, "nm000279", {
      created_at: "2026-07-05 20:31:40",
      first_published_at: "2026-09-16 17:22:37",
    });
    insertDataset(db, "on008768", {
      created_at: "2026-09-08 22:30:51",
      first_published_at: "2026-09-08 22:43:37",
    });
    insertDataset(db, "nm000300", { created_at: "2026-09-10 12:00:00", first_published_at: null });
    const env = { DB: realD1(db), AI: {} as never, VECTORIZE: {} as never };

    const outcome = await searchDatasetsTool(env, { limit: 10 } as SearchDatasetsInput);
    expect(outcome.result.isError).toBeUndefined();
    const text = (outcome.result.content as { text: string }[])[0].text;
    const body = JSON.parse(text) as { results: { dataset_id: string }[] };
    expect(body.results.map((r) => r.dataset_id)).toEqual(["nm000279", "nm000300", "on008768"]);
  });
});
