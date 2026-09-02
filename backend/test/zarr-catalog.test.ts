/**
 * Tests for the top-level Zarr discovery catalog (issue #1062, epic #1181
 * phase 2): backend/src/services/zarr-catalog.ts.
 *
 * Three layers, each tested at its own real boundary (no mocks):
 *  - `ZARR_CATALOG_CANDIDATE_SQL` -- the entry point for exclusion logic
 *    (private/pending/zero-store rows), run against a real bun:sqlite
 *    freshDb with every migration applied. Testing `buildZarrCatalog` alone
 *    with hand-built "excluded" rows would not catch a regression in the
 *    SQL predicate itself, since production never hands buildZarrCatalog a
 *    row the query didn't already select (.rules/testing.md, "test the
 *    entry point, not the piece").
 *  - `buildZarrCatalog` -- pure, so shape/ordering/CSV-parsing is asserted
 *    directly against hand-built rows as a supplement to the SQL test above.
 *  - `uploadZarrCatalogJson` (the PUT) -- exercised against a real local
 *    `Bun.serve()` receiver via `ZarrCatalogS3Options.endpointUrl`, per this
 *    repo's no-mock-fetch policy. Covers both a successful PUT and the
 *    403-must-throw fail-loud path.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  ZARR_CATALOG_CANDIDATE_SQL,
  ZarrCatalogForbiddenError,
  type ZarrCatalogSourceRow,
  buildZarrCatalog,
  fetchZarrCatalogObject,
  publishZarrCatalog,
  uploadZarrCatalogJson,
} from "../src/services/zarr-catalog";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

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

function candidateRows(db: Database): ZarrCatalogSourceRow[] {
  return db.query(ZARR_CATALOG_CANDIDATE_SQL).all() as ZarrCatalogSourceRow[];
}

describe("ZARR_CATALOG_CANDIDATE_SQL: the real exclusion predicate", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
    insertDataset(db, "on500001", {
      name: "Public ready with stores",
      zarr_status: "ready",
      zarr_store_count: 41,
    });
    insertDataset(db, "on500002", {
      name: "Private but otherwise ready",
      visibility: "private",
      zarr_status: "ready",
      zarr_store_count: 5,
    });
    insertDataset(db, "on500003", {
      name: "Public but still pending",
      zarr_status: "pending",
      zarr_store_count: null,
    });
    insertDataset(db, "on500004", {
      name: "Public ready but zero stores",
      zarr_status: "ready",
      zarr_store_count: 0,
    });
    insertDataset(db, "on500005", {
      name: "Public ready, count never populated",
      zarr_status: "ready",
    });
    insertDataset(db, "on500006", {
      name: "Archived, otherwise qualifying",
      status: "archived",
      zarr_status: "ready",
      zarr_store_count: 7,
    });
    // Exemplar sandbox, public: legitimate catalog entry (brief D3 note,
    // mirrors recording-stats-sweep.ts's own candidate SQL reasoning).
    insertDataset(db, "xx099901", {
      name: "Public exemplar copy",
      is_sandbox: 1,
      is_exemplar: 1,
      zarr_status: "ready",
      zarr_store_count: 12,
    });
  });

  test("only the public/active/ready/store_count>0 rows are selected -- private, pending, zero-store, archived, and unpopulated-count rows are all excluded", () => {
    const rows = candidateRows(db);
    // on500001 (qualifies) and xx099901 (a public exemplar, which DOES
    // qualify -- see the dedicated test below) are the only two rows any of
    // on500002 (private), on500003 (pending), on500004 (zero stores),
    // on500005 (NULL store_count), on500006 (archived) fail to be.
    expect(rows.map((r) => r.dataset_id).sort()).toEqual(["on500001", "xx099901"]);
  });

  test("a public exemplar sandbox copy IS included (not excluded like a throwaway sandbox)", () => {
    const rows = candidateRows(db);
    expect(rows.map((r) => r.dataset_id)).toContain("xx099901");
  });

  test("the SQL has no is_sandbox/is_exemplar predicate at all: a public non-exemplar sandbox row also qualifies", () => {
    // Deliberate, per the SQL's own doc comment (mirrors
    // recording-stats-sweep.ts's candidate SQL): visibility/status/zarr
    // state are the only gates. A public xx-band row happens to be rare in
    // production (sandbox rows are normally private), but nothing in this
    // query excludes one if it exists.
    insertDataset(db, "xx090001", {
      name: "Public non-exemplar sandbox",
      is_sandbox: 1,
      is_exemplar: 0,
      zarr_status: "ready",
      zarr_store_count: 3,
    });
    const rows = candidateRows(db);
    expect(rows.map((r) => r.dataset_id)).toContain("xx090001");
  });

  test("ordered by dataset_id", () => {
    db.query("UPDATE datasets SET visibility = 'public' WHERE dataset_id = 'on500002'").run();
    const rows = candidateRows(db);
    expect(rows.map((r) => r.dataset_id)).toEqual(["on500001", "on500002", "xx099901"]);
  });

  // Issue #1068, epic #1181 phase 8: the two verify fields are derived from
  // the JSON sweep_stamps column (ADR 0034/0035), not a stored column --
  // proved at the real SQL entry point, not just in buildZarrCatalog's pure
  // unit tests below.
  test("zarr_verify_status/zarr_verified_at are derived from sweep_stamps via json_extract", () => {
    db.query("UPDATE datasets SET sweep_stamps = ? WHERE dataset_id = 'on500001'").run(
      JSON.stringify({ zarr_verify_status: "verified", zarr_verified_at: "2026-09-01 00:00:00" }),
    );
    const rows = candidateRows(db);
    const row = rows.find((r) => r.dataset_id === "on500001");
    expect(row?.zarr_verify_status).toBe("verified");
    expect(row?.zarr_verified_at).toBe("2026-09-01 00:00:00");
  });

  test("a never-swept row (sweep_stamps NULL) projects both verify fields as null", () => {
    const rows = candidateRows(db);
    const row = rows.find((r) => r.dataset_id === "on500001");
    expect(row?.zarr_verify_status).toBeNull();
    expect(row?.zarr_verified_at).toBeNull();
  });
});

describe("buildZarrCatalog: shape, ordering, and CSV-to-array parsing", () => {
  const row = (overrides: Partial<ZarrCatalogSourceRow> = {}): ZarrCatalogSourceRow => ({
    dataset_id: "on500001",
    name: "A dataset",
    concept_doi: "10.82901/x1",
    license: "CC0",
    modalities: "eeg,meg",
    tasks: "rest,motor",
    subject_count: 41,
    has_hed: 1,
    hed_version: "8.2.0",
    zarr_status: "ready",
    zarr_store_count: 41,
    recording_count: 41,
    recordings_unavailable: 0,
    total_recording_duration: 90000.5,
    zarr_converted_at: "2026-08-01T00:00:00.000Z",
    zarr_source_commit: "abc123",
    zarr_errors: 0,
    // Issue #1068, epic #1181 phase 8.
    zarr_verify_status: "verified",
    zarr_verified_at: "2026-08-02T00:00:00.000Z",
    ...overrides,
  });

  test("the document envelope carries format/format_version/count/contract_base", () => {
    const catalog = buildZarrCatalog([row()], {
      contractBase: "https://zarr.nemar.org",
      generatedUtc: "2026-09-02T00:00:00.000Z",
    });
    expect(catalog.format).toBe("nemar-zarr-catalog");
    expect(catalog.format_version).toBe(1);
    expect(catalog.generated_utc).toBe("2026-09-02T00:00:00.000Z");
    expect(catalog.contract_base).toBe("https://zarr.nemar.org/");
    expect(catalog.count).toBe(1);
  });

  test("a missing trailing slash on contractBase is normalized, and index_url agrees with it", () => {
    const catalog = buildZarrCatalog([row({ dataset_id: "on007763" })], {
      contractBase: "https://zarr.nemar.org",
    });
    expect(catalog.datasets[0].index_url).toBe("https://zarr.nemar.org/on007763/zarr/index.json");
  });

  test("an already-slashed contractBase does not get a double slash", () => {
    const catalog = buildZarrCatalog([row({ dataset_id: "on007763" })], {
      contractBase: "https://zarr.nemar.org/",
    });
    expect(catalog.datasets[0].index_url).toBe("https://zarr.nemar.org/on007763/zarr/index.json");
  });

  test("modalities/tasks comma-joined TEXT columns become arrays", () => {
    const catalog = buildZarrCatalog([row({ modalities: "eeg,meg", tasks: "rest, motor " })], {
      contractBase: "https://zarr.nemar.org",
    });
    expect(catalog.datasets[0].modalities).toEqual(["eeg", "meg"]);
    expect(catalog.datasets[0].tasks).toEqual(["rest", "motor"]);
  });

  test("NULL modalities/tasks become an empty array, not null or a crash", () => {
    const catalog = buildZarrCatalog([row({ modalities: null, tasks: null })], {
      contractBase: "https://zarr.nemar.org",
    });
    expect(catalog.datasets[0].modalities).toEqual([]);
    expect(catalog.datasets[0].tasks).toEqual([]);
  });

  test("every declared field maps from its source row 1:1 (doi <- concept_doi, store_count <- zarr_store_count)", () => {
    const catalog = buildZarrCatalog([row()], { contractBase: "https://zarr.nemar.org" });
    const d = catalog.datasets[0];
    expect(d.doi).toBe("10.82901/x1");
    expect(d.license).toBe("CC0");
    expect(d.subject_count).toBe(41);
    expect(d.has_hed).toBe(1);
    expect(d.hed_version).toBe("8.2.0");
    expect(d.store_count).toBe(41);
    expect(d.recording_count).toBe(41);
    expect(d.recordings_unavailable).toBe(0);
    expect(d.total_recording_duration).toBe(90000.5);
    expect(d.zarr_converted_at).toBe("2026-08-01T00:00:00.000Z");
    expect(d.zarr_source_commit).toBe("abc123");
    expect(d.zarr_errors).toBe(0);
    expect(d.zarr_verify_status).toBe("verified");
    expect(d.zarr_verified_at).toBe("2026-08-02T00:00:00.000Z");
  });

  // Issue #1068 (epic #1181 phase 8), decision 2: the catalog POPULATION is
  // unchanged (still every has_zarr row), and the two verify fields ride
  // along per entry -- null on a fresh conversion the sweep has not reached.
  test("zarr_verify_status/zarr_verified_at are null on a fresh, unverified conversion", () => {
    const catalog = buildZarrCatalog([row({ zarr_verify_status: null, zarr_verified_at: null })], {
      contractBase: "https://zarr.nemar.org",
    });
    expect(catalog.count).toBe(1);
    expect(catalog.datasets[0].zarr_verify_status).toBeNull();
    expect(catalog.datasets[0].zarr_verified_at).toBeNull();
  });

  test("a 'failed' verdict still rides along on its own entry -- population is not filtered by verdict", () => {
    const catalog = buildZarrCatalog(
      [row({ dataset_id: "on500009", zarr_verify_status: "failed" })],
      { contractBase: "https://zarr.nemar.org" },
    );
    expect(catalog.count).toBe(1);
    expect(catalog.datasets[0].zarr_verify_status).toBe("failed");
  });

  test("preserves the input row order (the SQL query owns ORDER BY dataset_id)", () => {
    const catalog = buildZarrCatalog(
      [row({ dataset_id: "on500003" }), row({ dataset_id: "on500001" })],
      { contractBase: "https://zarr.nemar.org" },
    );
    expect(catalog.datasets.map((d) => d.dataset_id)).toEqual(["on500003", "on500001"]);
  });

  test("an empty candidate set builds a well-formed, empty document", () => {
    const catalog = buildZarrCatalog([], { contractBase: "https://zarr.nemar.org" });
    expect(catalog.count).toBe(0);
    expect(catalog.datasets).toEqual([]);
  });

  test("generatedUtc defaults to the current time when omitted", () => {
    const before = Date.now();
    const catalog = buildZarrCatalog([], { contractBase: "https://zarr.nemar.org" });
    const parsed = Date.parse(catalog.generated_utc);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(Date.now());
  });

  // PR #1201 review, item 2: buildZarrCatalog must defend its OWN
  // eligibility postcondition, not just trust that every caller pre-filters
  // with ZARR_CATALOG_CANDIDATE_SQL's WHERE clause. Feeds a deliberately
  // UNFILTERED row set -- exactly the shape a future caller (a different
  // query, a batch backfill script, ...) might hand it -- and asserts only
  // the genuinely eligible row survives.
  test("defends its own postcondition: filters out non-ready/zero-store rows even when given unfiltered input", () => {
    const catalog = buildZarrCatalog(
      [
        row({ dataset_id: "on600001", zarr_status: "ready", zarr_store_count: 5 }),
        row({ dataset_id: "on600002", zarr_status: "pending", zarr_store_count: 5 }),
        row({ dataset_id: "on600003", zarr_status: "failed", zarr_store_count: 5 }),
        row({ dataset_id: "on600004", zarr_status: "ready", zarr_store_count: 0 }),
        row({ dataset_id: "on600005", zarr_status: "ready", zarr_store_count: null }),
        row({ dataset_id: "on600006", zarr_status: null, zarr_store_count: 5 }),
      ],
      { contractBase: "https://zarr.nemar.org" },
    );
    expect(catalog.datasets.map((d) => d.dataset_id)).toEqual(["on600001"]);
    expect(catalog.count).toBe(1);
  });
});

describe("uploadZarrCatalogJson: real local receiver, no mocked fetch", () => {
  let server: Server;
  let received: {
    method: string;
    path: string;
    contentType: string | null;
    cacheControl: string | null;
    body: string;
  } | null;
  let nextStatus: number;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        received = {
          method: req.method,
          path: url.pathname,
          contentType: req.headers.get("content-type"),
          cacheControl: req.headers.get("cache-control"),
          body: await req.text(),
        };
        return new Response(nextStatus === 200 ? "" : "denied", { status: nextStatus });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  beforeEach(() => {
    received = null;
    nextStatus = 200;
  });

  function options() {
    return {
      bucket: "test-bucket",
      region: "us-east-2",
      accessKeyId: "AKIATEST",
      secretAccessKey: "secret",
      endpointUrl: `http://127.0.0.1:${server.port}`,
    };
  }

  test("PUTs to /zarr-catalog.json with the right content-type and body", async () => {
    const json = JSON.stringify({ format: "nemar-zarr-catalog", count: 0, datasets: [] });
    await uploadZarrCatalogJson(options(), json);
    expect(received).not.toBeNull();
    expect(received?.method).toBe("PUT");
    expect(received?.path).toBe("/zarr-catalog.json");
    expect(received?.contentType).toBe("application/json");
    expect(received?.cacheControl).toBe("public, max-age=3600");
    expect(received?.body).toBe(json);
  });

  test("a 403 response is FAILED LOUD -- the promise rejects, the error is never swallowed", async () => {
    nextStatus = 403;
    await expect(uploadZarrCatalogJson(options(), "{}")).rejects.toThrow(/403/);
  });

  test("a 500 response also throws (any non-2xx is fatal, not just 403)", async () => {
    nextStatus = 500;
    await expect(uploadZarrCatalogJson(options(), "{}")).rejects.toThrow(/500/);
  });
});

describe("fetchZarrCatalogObject: real local receiver, no mocked fetch", () => {
  let server: Server;
  let nextStatus: number;
  let nextBody: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(nextBody, {
          status: nextStatus,
          headers: nextStatus === 200 ? { etag: '"abc123"' } : {},
        });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  beforeEach(() => {
    nextStatus = 200;
    nextBody = "";
  });

  function options() {
    return {
      bucket: "test-bucket",
      region: "us-east-2",
      accessKeyId: "AKIATEST",
      secretAccessKey: "secret",
      endpointUrl: `http://127.0.0.1:${server.port}`,
    };
  }

  test("a 200 returns the body text and etag", async () => {
    nextBody = JSON.stringify({ format: "nemar-zarr-catalog", count: 0, datasets: [] });
    const result = await fetchZarrCatalogObject(options());
    expect(result?.body).toBe(nextBody);
    expect(result?.etag).toBe('"abc123"');
  });

  test("a 404 (not yet published) returns null, not a throw", async () => {
    nextStatus = 404;
    const result = await fetchZarrCatalogObject(options());
    expect(result).toBeNull();
  });

  // PR #1201 review, item 5: a 403 on this fixed, always-expected-to-exist
  // key is far more likely an IAM/policy regression than "not published
  // yet" -- so, unlike getZarrIndex's per-dataset analogue, it is NOT
  // folded into the same null result as a 404. It throws a distinct typed
  // error so a caller (once zarr-data.ts is updated) can answer 503 rather
  // than a 404 that masquerades as "not published".
  test("a 403 throws ZarrCatalogForbiddenError (distinct from the 404 null), not swallowed as absence", async () => {
    nextStatus = 403;
    await expect(fetchZarrCatalogObject(options())).rejects.toBeInstanceOf(
      ZarrCatalogForbiddenError,
    );
  });

  test("a 403 logs at console.error (not warn) with the bucket and key", async () => {
    nextStatus = 403;
    const originalError = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      await expect(fetchZarrCatalogObject(options())).rejects.toThrow();
    } finally {
      console.error = originalError;
    }
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const [message, detail] = calls[0] as [string, { bucket?: string; key?: string }];
    expect(message).toContain("403");
    expect(detail.bucket).toBe("test-bucket");
    expect(detail.key).toBe("zarr-catalog.json");
  });

  test("any other non-2xx (a real infra failure) throws a plain Error, not ZarrCatalogForbiddenError", async () => {
    nextStatus = 500;
    await expect(fetchZarrCatalogObject(options())).rejects.toThrow(/500/);
    await expect(fetchZarrCatalogObject(options())).rejects.not.toBeInstanceOf(
      ZarrCatalogForbiddenError,
    );
  });
});

describe("publishZarrCatalog: configuration guard", () => {
  test("throws when ZARR_CACHE_BASE_URL is unconfigured, before touching S3", async () => {
    const db = freshDb();
    const env = {
      DB: realD1(db),
      ENVIRONMENT: "development",
      S3_BUCKET: "test-bucket",
      AWS_REGION: "us-east-2",
      AWS_ACCESS_KEY_ID: "AKIATEST",
      AWS_SECRET_ACCESS_KEY: "secret",
      // ZARR_CACHE_BASE_URL intentionally omitted.
    } as unknown as Bindings;
    await expect(publishZarrCatalog(env)).rejects.toThrow(/ZARR_CACHE_BASE_URL/);
  });

  // PR #1201 review, item 6: an unconfigured bucket must fail here, with a
  // name, rather than deep inside aws4fetch against `https://undefined.s3...`.
  test("throws when S3_BUCKET is unconfigured, before attempting the PUT", async () => {
    const db = freshDb();
    const env = {
      DB: realD1(db),
      ENVIRONMENT: "development",
      ZARR_CACHE_BASE_URL: "https://zarr.nemar.org",
      AWS_REGION: "us-east-2",
      AWS_ACCESS_KEY_ID: "AKIATEST",
      AWS_SECRET_ACCESS_KEY: "secret",
      // S3_BUCKET intentionally omitted.
    } as unknown as Bindings;
    await expect(publishZarrCatalog(env)).rejects.toThrow(/S3_BUCKET/);
  });
});
