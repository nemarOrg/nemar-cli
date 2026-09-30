/**
 * Real-route tests for the catalog's `latest_version_at`: when a dataset's
 * newest version was released, read from the same `dataset_versions` row that
 * names `latest_version`. `datasets.updated_at` is bumped by enrichment
 * reindex, finalize and the DOI callbacks, so after a catalog-wide reindex
 * every dataset's `updated_at` read "just now" while its release had not
 * moved; the website's "Updated" badge needs the release date instead.
 * Driven through the registered Hono routes against a real bun:sqlite-backed
 * D1, like catalog-sort-published.test.ts, with no mocks.
 *
 * The rows are modeled on datasets seen in production on 2026-09-30, with
 * dates rounded to plausible values rather than copied: nm000279 was released
 * 2026-09-16 and re-enriched 2026-09-29; nm000284 released a second version
 * after its first. nm000291 is an anonymous deposit, whose release date is not
 * withheld (only identifiers are).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { datasetDetailEnvelopeSchema, datasetListEnvelopeSchema } from "../../shared/contract";
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

function insertVersion(db: Database, datasetId: string, version: string, createdAt: string): void {
  db.query(
    "INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at) VALUES (?, ?, ?, 'ezid', ?)",
  ).run(datasetId, version, `10.82901/nemar.${datasetId}.${version}`, createdAt);
}

interface Row {
  dataset_id: string;
  updated_at: string;
  latest_version: string | null;
  latest_version_at?: string | null;
}

const byId = (rows: Row[], id: string): Row => {
  const row = rows.find((r) => r.dataset_id === id);
  if (!row) throw new Error(`${id} missing from the response`);
  return row;
};

describe("latest_version_at is the newest version's release date", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = new Hono();
    registerCatalogRoutes(app);

    // One release, then a catalog-wide re-enrichment bumped updated_at.
    insertDataset(db, "nm000279", {
      created_at: "2026-07-05 20:31:40",
      updated_at: "2026-09-29 23:29:20",
      first_published_at: "2026-09-16 17:22:37",
    });
    insertVersion(db, "nm000279", "v1.0.0", "2026-09-16 17:22:05");

    // Two releases. The newer row is inserted FIRST, so the answer cannot be
    // "the last row inserted" or the highest rowid.
    insertDataset(db, "nm000284", {
      created_at: "2026-09-17 18:46:36",
      updated_at: "2026-09-29 23:32:11",
      first_published_at: "2026-09-24 17:15:40",
    });
    insertVersion(db, "nm000284", "v1.0.1", "2026-09-28 17:57:21");
    insertVersion(db, "nm000284", "v1.0.0", "2026-09-24 17:15:33");

    // A bare (untagged) version row, as older rows were stored.
    insertDataset(db, "nm000290", {
      created_at: "2026-08-01 00:00:00",
      updated_at: "2026-09-29 23:40:00",
      first_published_at: "2026-08-02 00:00:00",
    });
    insertVersion(db, "nm000290", "1.2.3", "2026-08-02 09:30:00");

    // A draft that was never released: no version row.
    insertDataset(db, "nm000300", {
      created_at: "2026-09-10 12:00:00",
      updated_at: "2026-09-29 23:41:00",
    });

    // An anonymous deposit: identifiers are withheld, the release date is not.
    insertDataset(db, "nm000291", {
      created_at: "2026-09-20 10:00:00",
      updated_at: "2026-09-29 23:42:00",
      anonymous: 1,
    });
    insertVersion(db, "nm000291", "v1.0.0", "2026-09-28 19:43:14");
  });

  async function list(qs = ""): Promise<Row[]> {
    const res = await app.request(`/?${qs}`, {}, env(db));
    expect(res.status).toBe(200);
    return ((await res.json()) as { datasets: Row[] }).datasets;
  }

  test("the public list serves the release date, not the row's last touch", async () => {
    const rows = await list();
    expect(byId(rows, "nm000279").latest_version_at).toBe("2026-09-16 17:22:05");
    expect(byId(rows, "nm000279").updated_at).toBe("2026-09-29 23:29:20");
  });

  test("with two versions it serves the newer one's date", async () => {
    const row = byId(await list(), "nm000284");
    expect(row.latest_version).toBe("v1.0.1");
    expect(row.latest_version_at).toBe("2026-09-28 17:57:21");
  });

  test("it names the same row as latest_version, for a bare stored version too", async () => {
    const row = byId(await list(), "nm000290");
    expect(row.latest_version).toBe("v1.2.3");
    expect(row.latest_version_at).toBe("2026-08-02 09:30:00");
  });

  test("a dataset with no version row serves null, not a missing key", async () => {
    const row = byId(await list(), "nm000300");
    expect(row.latest_version).toBeNull();
    expect("latest_version_at" in row).toBe(true);
    expect(row.latest_version_at).toBeNull();
  });

  test("touching updated_at does not move it", async () => {
    db.run("UPDATE datasets SET updated_at = '2026-09-30 08:00:00'");
    const rows = await list();
    expect(byId(rows, "nm000279").latest_version_at).toBe("2026-09-16 17:22:05");
    expect(byId(rows, "nm000284").latest_version_at).toBe("2026-09-28 17:57:21");
  });

  test("the detail route serves it too", async () => {
    const res = await app.request("/nm000284", {}, env(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dataset: Row };
    expect(body.dataset.latest_version).toBe("v1.0.1");
    expect(body.dataset.latest_version_at).toBe("2026-09-28 17:57:21");

    const draft = await app.request("/nm000300", {}, env(db));
    expect(((await draft.json()) as { dataset: Row }).dataset.latest_version_at).toBeNull();
  });

  test("the authenticated ?mine=true branch serves it", async () => {
    const API_KEY = "latest-version-at-mine-key-0123456789abcdef";
    db.run(
      "INSERT INTO users (id, username, email, password_hash, status, role, email_verified) VALUES (41, 'lvamine', 'lvamine@example.org', 'x', 'approved', 'member', 1)",
    );
    db.run("UPDATE datasets SET owner_user_id = 41");
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (41, ?, ?)").run(
      await hashApiKey(API_KEY),
      API_KEY.slice(0, 8),
    );

    const res = await app.request(
      "/?mine=true",
      { headers: { Authorization: `Bearer ${API_KEY}` } },
      env(db),
    );
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { datasets: Row[] }).datasets;
    expect(byId(rows, "nm000284").latest_version_at).toBe("2026-09-28 17:57:21");
    expect(byId(rows, "nm000300").latest_version_at).toBeNull();
  });

  test("an anonymous deposit still serves its release date", async () => {
    const row = byId(await list(), "nm000291");
    expect(row.latest_version_at).toBe("2026-09-28 19:43:14");

    const res = await app.request("/nm000291", {}, env(db));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dataset: Row }).dataset.latest_version_at).toBe(
      "2026-09-28 19:43:14",
    );
  });

  test("the degraded fallback list serves it too", async () => {
    // The fallback joins users, so the fixtures need a real owner.
    db.run(
      "INSERT INTO users (id, username, email, password_hash, status, role, email_verified) VALUES (42, 'lvafallback', 'lvafallback@example.org', 'x', 'approved', 'member', 1)",
    );
    db.run("UPDATE datasets SET owner_user_id = 42");

    // A "no such column" failure from the public prefix query is what sends the
    // handler into the fallback; every other statement runs on the real D1.
    // `d.dataset_id AS id` appears in the prefix query and not in the fallback.
    const base = realD1(db);
    const degraded = {
      DB: {
        prepare(sql: string) {
          if (sql.includes("d.dataset_id AS id")) {
            const failing = {
              bind: () => failing,
              all: () => {
                throw new Error("no such column: d.fake_consolidation_column");
              },
            };
            return failing;
          }
          return base.prepare(sql);
        },
      } as unknown as D1Database,
      ENVIRONMENT: "development",
    } as Bindings;

    const res = await app.request("/", {}, degraded);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { datasets: Row[]; fallback?: boolean };
    expect(body.fallback).toBe(true);
    expect(byId(body.datasets, "nm000284").latest_version_at).toBe("2026-09-28 17:57:21");
    expect(byId(body.datasets, "nm000300").latest_version_at).toBeNull();
  });

  test("list and detail responses still satisfy the shared contract", async () => {
    const listBody = await (await app.request("/", {}, env(db))).json();
    expect(datasetListEnvelopeSchema.safeParse(listBody).success).toBe(true);
    const detailBody = await (await app.request("/nm000284", {}, env(db))).json();
    const parsed = datasetDetailEnvelopeSchema.safeParse(detailBody);
    expect(parsed.success).toBe(true);
  });
});
