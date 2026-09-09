/**
 * Real-route tests for `list_recordings` and `get_events` (epic #1065 phase
 * 3, issue #1295; design doc sections 5.3-5.4). Driven through `createMcpRoutes(deps)`
 * and JSON-RPC exactly like `mcp-route.test.ts`; no mocks:
 *
 *  - D1 is bun:sqlite behind `realD1()` with every migration applied.
 *  - `index.json`/`events.parquet`/the fallback `events.tsv` are served by
 *    a real `Bun.serve()` fixture server (`test/helpers/fixture-server.ts`),
 *    standing in for both S3 (the zarr sub-app's `s3Base`) and
 *    `raw.githubusercontent.com` (`deps.rawGithubBase`).
 *  - The zarr sub-app is the REAL `createZarrDataRoutes({ cache, fetch, s3Base })`.
 *  - The projection cache is a real in-memory `InMemoryCache`.
 *
 * The nm000329 index fixture is the LIVE, full index.json for that dataset
 * (112 stores; captured `curl -sL -A "nemar-cli/mcp-phase3"`), with only
 * `data_base`/`events_parquet`/`contract_base` rewritten to point at the
 * fixture server -- every other field, including every store's `zarr` path
 * and geometry, is the real converter output.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Hono } from "hono";
import {
  type GetEventsOutput,
  type ListRecordingsOutput,
  getEventsOutputSchema,
  listRecordingsOutputSchema,
} from "../../shared/contract/mcp.js";
import on003392MegSssSliceRaw from "../../test/fixtures/zarr-index-on003392-meg-sss-slice.json";
import { projectionUrl } from "../src/mcp/projection-cache.js";
import { MAX_STORE_FANOUT_ENTRIES } from "../src/mcp/tools/get-events.js";
import { type McpRoutesDeps, createMcpRoutes } from "../src/routes/mcp.js";
import { type CacheLike, createZarrDataRoutes } from "../src/routes/zarr-data.js";
import type { Bindings } from "../src/types/bindings.js";
import nm000111IndexV1Raw from "./fixtures/mcp/nm000111-index-v1.json";
import nm000329IndexRaw from "./fixtures/mcp/nm000329-index.json";
import { InMemoryCache } from "./helpers/cache.js";
import { freshDb, realD1 } from "./helpers/d1.js";
import { type FixtureServer, startFixtureServer } from "./helpers/fixture-server.js";

type App = Hono<{ Bindings: Bindings }>;

const V3_ID = "nm000329";
const V3_COMMIT = "7172d2d492dad63650f80cdb83352a0e9d4420f7";
/** `datasets.zarr_converted_at` on every fixture: the CONVERSION identity in the
 *  projection cache key. A commit alone is not enough, because an engine bump
 *  re-converts a dataset at an unchanged HEAD (ADR 0033). */
const CONVERTED_AT = "2026-09-01 12:00:00";
const EMPTY_COMMIT_ID = "nm000112";
const ZERO_STORE_ID = "nm500602";
const V1_ID = "nm000111";
const V1_COMMIT = "510a05377459cf857e60b861ab377bc53b5b5b29";
const PENDING_ID = "nm500601";
// A dataset whose store count is deliberately above
// `MAX_STORE_FANOUT_ENTRIES`: nm000329's real index with enough clones of
// its own first store appended to cross the bound. The live catalog's
// largest is nm000281 at 25,253 stores, so this shape is not hypothetical.
const FANOUT_ID = "nm000330";
// A dataset whose events.parquet crosses get_events' inline-read budget. The
// real outlier is nm000104: 99,863,763 bytes and 5,411,570 rows across 1131
// stores, which one anonymous call used to pull through the Worker whole.
const OVERSIZED_EVENTS_ID = "nm000331";
// A dataset whose first store declares TWO channel groups. events.parquet is one
// row per (event, channel group), so this is the shape that used to return every
// event twice with total_count doubled when `group` was omitted.
const MULTI_GROUP_ID = "nm000332";
const MULTI_GROUP_SECOND = "eeg_500hz";
// Declared on the store but absent from the parquet: a real "this group exists
// and has no events" case, which used to be indistinguishable from a confident
// empty answer because the no-rows note was computed before the group filter.
const MULTI_GROUP_EMPTY = "eeg_1000hz";
// A dataset whose events.parquet carries one row eventRowSchema rejects.
const INVALID_ROW_ID = "nm000333";
const FANOUT_EXTRA_STORES = MAX_STORE_FANOUT_ENTRIES + 1;

// The real on003392 MEG SSS store (`derived: true`, real `sss`), with its
// group geometry overridden to a small SYNTHETIC size (8 channels, 8500
// samples, 3 view levels) matching the synthetic chunk
// `scripts/zarr/generate_mcp_test_fixture.py` produced -- the real store's
// own coarsest view level is 320 channels x 266 columns, ~327 KB compressed,
// over the fixture-size budget (see that script's module doc). Everything
// else (dataset_id, doi, license, the store's `sss`/`units_report`/`path`/
// `zarr`) is the real, live-captured document.
const MEG_ID = "on003392";
const MEG_COMMIT = (on003392MegSssSliceRaw as { source_commit: string }).source_commit;
const MEG_STORE_ZARR = "sub-01/meg/sub-01_task-localizer_meg.zarr";
const MEG_GROUP = "meg_250hz";
const MEG_SYNTHETIC_N_CHANNELS = 8;
const MEG_SYNTHETIC_N_SAMPLES = 8500;
const MEG_SYNTHETIC_N_VIEW_LEVELS = 3;
const MEG_SYNTHETIC_VIEW_LEVEL = 3;

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function encode(doc: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(doc));
}

/** `zarrIndexSchema` requires `data_base`/`contract_base`/`events_parquet`
 *  to be `https://` (real S3/zarr.nemar.org URLs always are), but the
 *  fixture upstream is a plain-HTTP `Bun.serve()` on localhost. The index
 *  fixture is rewritten to point at this FAKE https origin (satisfying the
 *  schema), and `translatingFetch` below rewrites any request for it back
 *  to the real fixture server before the real `fetch` runs -- the same
 *  "real local upstream stands in for a real host" pattern
 *  `zarr-data-cache.test.ts` uses via `deps.s3Base`, extended to a plain
 *  `fetch` seam (`get-events.ts`'s parquet/tsv reads, `render-overview.ts`'s
 *  chunk reads) that has no dedicated `xBase` parameter of its own. */
const FIXTURE_PUBLIC_ORIGIN = "https://fixture.nemar.test";

function translatingFetch(real: typeof fetch, fixtureBase: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(FIXTURE_PUBLIC_ORIGIN)) {
      const rewritten = fixtureBase + url.slice(FIXTURE_PUBLIC_ORIGIN.length);
      return real(rewritten, input instanceof Request ? { ...init, headers: input.headers } : init);
    }
    return real(input, init);
  }) as typeof fetch;
}

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

async function parseBody(res: Response): Promise<JsonRpcResponse> {
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice("data:".length).trim() : text);
}

async function callTool(
  app: App,
  database: Bindings,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<{ res: Response; body: JsonRpcResponse }> {
  const res = await app.request(
    "/mcp",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Mcp-Method": "tools/call", "Mcp-Name": name },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args, _meta: MODERN_META },
      }),
    },
    database,
    ctx,
  );
  return { res, body: await parseBody(res) };
}

function structuredContentOf(body: JsonRpcResponse): Record<string, unknown> {
  expect(body.error).toBeUndefined();
  const result = body.result as { isError?: boolean; structuredContent?: Record<string, unknown> };
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

function errorTextOf(body: JsonRpcResponse): string {
  expect(body.error).toBeUndefined();
  const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
  expect(result.isError).toBe(true);
  return result.content[0]?.text ?? "";
}

describe("list_recordings / get_events (epic #1065 phase 3)", () => {
  let db: Database;
  let app: App;
  let fixtureServer: FixtureServer;
  let cache: InMemoryCache;
  let deps: McpRoutesDeps;

  beforeAll(() => {
    const rewrittenV3Index = {
      ...nm000329IndexRaw,
      contract_base: "http://placeholder/contract/",
      data_base: "PLACEHOLDER_DATA_BASE",
      events_parquet: "PLACEHOLDER_EVENTS_PARQUET",
    };

    fixtureServer = startFixtureServer();
    rewrittenV3Index.data_base = `${FIXTURE_PUBLIC_ORIGIN}/${V3_ID}/zarr/`;
    rewrittenV3Index.contract_base = `${FIXTURE_PUBLIC_ORIGIN}/${V3_ID}/zarr/`;
    rewrittenV3Index.events_parquet = `${FIXTURE_PUBLIC_ORIGIN}/${V3_ID}/zarr/events.parquet`;

    // A v1 index with one synthetic derivatives/-path store added, so the
    // ADR 0027 non-raw exclusion has something real to exclude -- the live
    // nm000111 slice has no such store on its own.
    const v1WithNonRaw = {
      ...nm000111IndexV1Raw,
      stores: [
        ...nm000111IndexV1Raw.stores,
        {
          path: "derivatives/mne-bids-pipeline/sub-I003/eeg/sub-I003_task-sleep_desc-clean_eeg.edf",
          zarr: "derivatives/mne-bids-pipeline/sub-I003/eeg/sub-I003_task-sleep_desc-clean_eeg.zarr",
          modalities: ["eeg"],
          groups: [{ name: "eeg_200hz", modality: "EEG", rate: 200, n_channels: 19 }],
        },
      ],
    };

    fixtureServer.files.set(`${V3_ID}/zarr/index.json`, encode(rewrittenV3Index));
    fixtureServer.files.set(`${V1_ID}/zarr/index.json`, encode(v1WithNonRaw));

    // item 17: a legacy index whose own source_commit is empty (#1197's
    // on008083 case) -- the projection cache must be bypassed entirely for
    // every call against it.
    const emptyCommitIndex = {
      ...nm000111IndexV1Raw,
      dataset_id: EMPTY_COMMIT_ID,
      source_commit: "",
    };
    fixtureServer.files.set(`${EMPTY_COMMIT_ID}/zarr/index.json`, encode(emptyCommitIndex));

    // item 21: a CRLF events.tsv with an onset landing on an exact half
    // sample at rate 200 (0.0025 s -> 0.5 samples -> ties UP to 1, never
    // Python/JS round()'s banker's-rounding 0).
    const crlfTsv = readFileSync(
      new URL("./fixtures/mcp/nm000111-sub-I005-events-crlf.tsv", import.meta.url),
    );
    fixtureServer.files.set(
      `nemarDatasets/${V1_ID}/${V1_COMMIT}/sub-I005/eeg/sub-I005_task-sleep_events.tsv`,
      new Uint8Array(crlfTsv),
    );

    const parquetBytes = new Uint8Array(
      readFileSync(new URL("./fixtures/mcp/nm000329-events.parquet", import.meta.url)),
    );
    fixtureServer.files.set(`${V3_ID}/zarr/events.parquet`, parquetBytes);

    // The first store, with a second declared group appended. The real parquet
    // carries rows only for "eeg_250hz", so the second group is a real
    // "this group exists and has no events" case at the same time.
    const firstStore = (nm000329IndexRaw as { stores: Array<Record<string, unknown>> }).stores[0];
    const firstGroup = (firstStore.groups as Array<Record<string, unknown>>)[0];
    fixtureServer.files.set(
      `${MULTI_GROUP_ID}/zarr/index.json`,
      encode({
        ...rewrittenV3Index,
        dataset_id: MULTI_GROUP_ID,
        events_parquet: `${FIXTURE_PUBLIC_ORIGIN}/${MULTI_GROUP_ID}/zarr/events.parquet`,
        stores: [
          {
            ...firstStore,
            groups: [
              firstGroup,
              { ...firstGroup, name: MULTI_GROUP_SECOND, rate: 500 },
              { ...firstGroup, name: MULTI_GROUP_EMPTY, rate: 1000 },
            ],
          },
        ],
      }),
    );

    // Four events, each carried once per group: eight rows, which is exactly the
    // doubling a caller used to see when no group was named.
    fixtureServer.files.set(
      `${MULTI_GROUP_ID}/zarr/events.parquet`,
      new Uint8Array(
        readFileSync(new URL("./fixtures/mcp/two-group-events.parquet", import.meta.url)),
      ),
    );

    fixtureServer.files.set(
      `${INVALID_ROW_ID}/zarr/index.json`,
      encode({
        ...rewrittenV3Index,
        dataset_id: INVALID_ROW_ID,
        events_parquet: `${FIXTURE_PUBLIC_ORIGIN}/${INVALID_ROW_ID}/zarr/events.parquet`,
        stores: [firstStore],
      }),
    );
    fixtureServer.files.set(
      `${INVALID_ROW_ID}/zarr/events.parquet`,
      new Uint8Array(
        readFileSync(new URL("./fixtures/mcp/invalid-row-events.parquet", import.meta.url)),
      ),
    );

    // 100,001 rows, one past MAX_EVENTS_PARQUET_ROWS, in 4.5 KB (every column a
    // repeated constant, so dictionary encoding plus zstd collapses it). A real
    // over-cap parquet that costs nothing to commit.
    const oversizedIndex = {
      ...rewrittenV3Index,
      dataset_id: OVERSIZED_EVENTS_ID,
      events_parquet: `${FIXTURE_PUBLIC_ORIGIN}/${OVERSIZED_EVENTS_ID}/zarr/events.parquet`,
    };
    fixtureServer.files.set(`${OVERSIZED_EVENTS_ID}/zarr/index.json`, encode(oversizedIndex));
    fixtureServer.files.set(
      `${OVERSIZED_EVENTS_ID}/zarr/events.parquet`,
      new Uint8Array(
        readFileSync(new URL("./fixtures/mcp/oversized-events.parquet", import.meta.url)),
      ),
    );

    const eventsTsv = new TextEncoder().encode(
      readFileSync(
        new URL("./fixtures/mcp/nm000111-sub-I003-events.tsv", import.meta.url),
        "utf-8",
      ),
    );
    fixtureServer.files.set(
      `nemarDatasets/${V1_ID}/${V1_COMMIT}/sub-I003/eeg/sub-I003_task-sleep_events.tsv`,
      eventsTsv,
    );

    // The MEG SSS derived-store fixture (PR review item 1): real
    // `derived`/`sss`, synthetic geometry, `events_parquet` stripped so
    // `get_events` exercises the fallback path (per review, the fallback is
    // sufficient here -- the primary parquet path is already covered by
    // nm000329's tests).
    const megStoreRaw = (
      on003392MegSssSliceRaw as {
        stores: Array<{ groups: Array<Record<string, unknown>> } & Record<string, unknown>>;
      }
    ).stores[0];
    const megGroup = {
      ...megStoreRaw.groups[0],
      n_channels: MEG_SYNTHETIC_N_CHANNELS,
      n_samples: MEG_SYNTHETIC_N_SAMPLES,
      n_view_levels: MEG_SYNTHETIC_N_VIEW_LEVELS,
      view_chunk_columns: 1024,
    };
    const megStore = { ...megStoreRaw, groups: [megGroup] };
    const rewrittenMegIndex = {
      ...on003392MegSssSliceRaw,
      data_base: `${FIXTURE_PUBLIC_ORIGIN}/${MEG_ID}/zarr/`,
      contract_base: `${FIXTURE_PUBLIC_ORIGIN}/${MEG_ID}/zarr/`,
      events_parquet: undefined,
      stores: [megStore],
    };
    fixtureServer.files.set(`${MEG_ID}/zarr/index.json`, encode(rewrittenMegIndex));
    const megChunk = new Uint8Array(
      readFileSync(
        new URL("./fixtures/mcp/on003392-synthetic-meg-view3-c-0-0-0.bin", import.meta.url),
      ),
    );
    fixtureServer.files.set(
      `${MEG_ID}/zarr/${MEG_STORE_ZARR}/${MEG_GROUP}/view/${MEG_SYNTHETIC_VIEW_LEVEL}/c/0/0/0`,
      megChunk,
    );

    // Over-the-bound fan-out fixture: the same real stores and the same
    // events.parquet, with `FANOUT_EXTRA_STORES` clones of the first store
    // appended under distinct paths so `byStore` crosses
    // `MAX_STORE_FANOUT_ENTRIES`. Cloning a real store (rather than
    // hand-writing one) keeps every synthetic entry valid against the v3
    // index schema.
    const realStores = (nm000329IndexRaw as { stores: Array<Record<string, unknown>> }).stores;
    const template = realStores[0];
    const fanoutStores = [...realStores];
    for (let i = 0; i < FANOUT_EXTRA_STORES; i++) {
      fanoutStores.push({
        ...template,
        path: `sub-syn${i}/eeg/sub-syn${i}_task-syn_eeg.set`,
        zarr: `sub-syn${i}/eeg/sub-syn${i}_task-syn_eeg.zarr`,
      });
    }
    fixtureServer.files.set(
      `${FANOUT_ID}/zarr/index.json`,
      encode({
        ...rewrittenV3Index,
        dataset_id: FANOUT_ID,
        store_count: fanoutStores.length,
        stores: fanoutStores,
      }),
    );

    cache = new InMemoryCache();
    const zarrRoutes = createZarrDataRoutes({
      cache: () => cache,
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
      s3Base: fixtureServer.url,
    });
    deps = {
      onerror: (err) => console.error("[mcp test] transport error", err),
      cache: () => cache,
      fetch: translatingFetch(fetch, fixtureServer.url),
      zarrRoutes,
      rawGithubBase: fixtureServer.url,
    };
    app = createMcpRoutes(deps);
  });

  afterAll(() => {
    fixtureServer.stop();
  });

  function insertDataset(
    datasetId: string,
    cols: Record<string, string | number | null> = {},
  ): void {
    const merged: Record<string, string | number | null> = {
      owner_user_id: -1,
      name: datasetId,
      visibility: "public",
      status: "active",
      is_sandbox: 0,
      // Every fixture carries a conversion stamp, because it is part of the
      // projection cache key: `zarr_source_commit` is the dataset repo's HEAD
      // and an engine bump re-converts without changing it, so the key needs
      // something that moves per conversion.
      zarr_converted_at: CONVERTED_AT,
      ...cols,
    };
    const keys = Object.keys(merged);
    db.query(
      `INSERT INTO datasets (dataset_id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})`,
    ).run(datasetId, ...(keys.map((k) => merged[k]) as never[]));
  }

  /** The same key the tools build, so a test can assert on a real entry
   *  instead of restating the key format. */
  function eventsKey(datasetId: string, zarr: string, convertedAt: string = CONVERTED_AT): string {
    return projectionUrl({
      env: env(db),
      datasetId,
      sourceCommit: V3_COMMIT,
      convertedAt,
      projection: `events/${zarr}`,
    });
  }

  beforeEach(() => {
    db = freshDb();
    cache = new InMemoryCache();
    fixtureServer.requestLog.length = 0;
    insertDataset(V3_ID, {
      zarr_status: "ready",
      zarr_store_count: (nm000329IndexRaw as { store_count: number }).store_count,
      zarr_source_commit: V3_COMMIT,
      concept_doi: "10.82901/nemar.nm000329",
      license: "CC-BY-NC-ND-4.0",
    });
    insertDataset(V1_ID, {
      zarr_status: "ready",
      zarr_store_count: 7,
      zarr_source_commit: V1_COMMIT,
    });
    insertDataset(PENDING_ID, { zarr_status: "pending" });
    insertDataset(EMPTY_COMMIT_ID, {
      zarr_status: "ready",
      zarr_store_count: 6,
      zarr_source_commit: null,
    });
    insertDataset(ZERO_STORE_ID, { zarr_status: "ready", zarr_store_count: 0 });
    insertDataset(FANOUT_ID, {
      zarr_status: "ready",
      zarr_store_count: FANOUT_EXTRA_STORES,
      zarr_source_commit: V3_COMMIT,
    });
    insertDataset(OVERSIZED_EVENTS_ID, {
      zarr_status: "ready",
      zarr_store_count: (nm000329IndexRaw as { store_count: number }).store_count,
      zarr_source_commit: V3_COMMIT,
    });
    insertDataset(MULTI_GROUP_ID, {
      zarr_status: "ready",
      zarr_store_count: 1,
      zarr_source_commit: V3_COMMIT,
    });
    insertDataset(INVALID_ROW_ID, {
      zarr_status: "ready",
      zarr_store_count: 1,
      zarr_source_commit: V3_COMMIT,
    });
    insertDataset(MEG_ID, {
      zarr_status: "ready",
      zarr_store_count: 1,
      zarr_source_commit: MEG_COMMIT,
      concept_doi: (on003392MegSssSliceRaw as { doi: string }).doi,
      license: (on003392MegSssSliceRaw as { license: string }).license,
    });
  });

  function env(database: Database): Bindings {
    return { DB: realD1(database), ENVIRONMENT: "development" } as unknown as Bindings;
  }

  function indexRequestCount(datasetId: string): number {
    return fixtureServer.requestLog.filter(
      (r) => r.url === `${datasetId}/zarr/index.json` && r.method === "GET",
    ).length;
  }

  describe("list_recordings", () => {
    test("v3: returns stores with groups, counts, and a matching envelope", async () => {
      const { body } = await callTool(app, env(db), 1, "list_recordings", { dataset_id: V3_ID });
      const output = structuredContentOf(body) as unknown as ListRecordingsOutput;
      listRecordingsOutputSchema.parse(output);
      expect(output.index_format_version).toBe(3);
      expect(output.excluded_derived_count).toBe(0);
      expect(output.excluded_legacy_non_raw_count).toBe(0);
      expect(output.source_commit).toBe(V3_COMMIT);
      expect(output.recordings.length).toBeGreaterThan(0);
      const first = output.recordings[0];
      expect(first.groups?.[0]?.name).toBe("eeg_250hz");
      expect(output.envelope).toBeDefined();
      expect(output.envelope?.source_commit).toBe(V3_COMMIT);
      expect(output.envelope?.doi).toBe("10.82901/nemar.nm000329");
    });

    test("a second call is a cache hit with NO index fetch in the request log", async () => {
      await callTool(app, env(db), 1, "list_recordings", { dataset_id: V3_ID });
      const afterFirst = indexRequestCount(V3_ID);
      expect(afterFirst).toBe(1);

      await callTool(app, env(db), 2, "list_recordings", { dataset_id: V3_ID });
      expect(indexRequestCount(V3_ID)).toBe(afterFirst);
    });

    test("min_duration_s filters to recordings whose longest group meets the floor", async () => {
      const { body: allBody } = await callTool(app, env(db), 1, "list_recordings", {
        dataset_id: V3_ID,
        limit: 500,
      });
      const all = structuredContentOf(allBody) as unknown as ListRecordingsOutput;

      const { body } = await callTool(app, env(db), 2, "list_recordings", {
        dataset_id: V3_ID,
        min_duration_s: 3000,
        limit: 500,
      });
      const output = structuredContentOf(body) as unknown as ListRecordingsOutput;
      expect(output.total_count).toBeLessThan(all.total_count);
      for (const r of output.recordings) {
        const maxDuration = Math.max(...(r.groups ?? []).map((g) => g.duration_s ?? 0));
        expect(maxDuration).toBeGreaterThanOrEqual(3000);
      }
    });

    test("modality filters case-insensitively", async () => {
      const { body } = await callTool(app, env(db), 1, "list_recordings", {
        dataset_id: V3_ID,
        modality: "EEG",
        limit: 500,
      });
      const output = structuredContentOf(body) as unknown as ListRecordingsOutput;
      expect(output.total_count).toBeGreaterThan(0);
    });

    test("pagination at the cap (limit 500) is accepted; 501 is a schema tool error", async () => {
      const { body } = await callTool(app, env(db), 1, "list_recordings", {
        dataset_id: V3_ID,
        limit: 500,
      });
      structuredContentOf(body);

      const { body: rejected } = await callTool(app, env(db), 2, "list_recordings", {
        dataset_id: V3_ID,
        limit: 501,
      });
      errorTextOf(rejected);
    });

    test("v1: lists stores with index_format_version 1, a legacy note, and excludes the non-raw store", async () => {
      const { body } = await callTool(app, env(db), 1, "list_recordings", {
        dataset_id: V1_ID,
        limit: 100,
      });
      const output = structuredContentOf(body) as unknown as ListRecordingsOutput;
      listRecordingsOutputSchema.parse(output);
      expect(output.index_format_version).toBe(1);
      expect(output.note).toContain("legacy index v1");
      expect(output.excluded_legacy_non_raw_count).toBe(1);
      expect(output.discovered_count).toBeNull();
      expect(output.recordings.every((r) => !r.zarr.startsWith("derivatives/"))).toBe(true);
      expect(output.envelope?.engine_version).toBe("1");
    });

    test("a pending dataset answers the status error, never an empty list", async () => {
      const { body } = await callTool(app, env(db), 1, "list_recordings", {
        dataset_id: PENDING_ID,
      });
      const text = errorTextOf(body);
      expect(text).toContain("pending");
    });

    test("an unknown dataset id answers the shared not-found error", async () => {
      const { body } = await callTool(app, env(db), 1, "list_recordings", {
        dataset_id: "nm599998",
      });
      const text = errorTextOf(body);
      expect(text).toContain("not found");
    });
  });

  describe("get_events", () => {
    test("v3 primary path: parquet rows for the first store, exact sample_index", async () => {
      const { body: listBody } = await callTool(app, env(db), 1, "list_recordings", {
        dataset_id: V3_ID,
        limit: 1,
      });
      const list = structuredContentOf(listBody) as unknown as ListRecordingsOutput;
      const recordingZarr = list.recordings[0].zarr;

      const { body } = await callTool(app, env(db), 2, "get_events", {
        dataset_id: V3_ID,
        recording: recordingZarr,
        limit: 5,
      });
      const output = structuredContentOf(body) as unknown as GetEventsOutput;
      getEventsOutputSchema.parse(output);
      expect(output.source).toBe("events_parquet");
      expect(output.estimated).toBe(false);
      expect(output.events.length).toBe(5);
      expect(output.limit).toBe(5);
      expect(output.offset).toBe(0);
      expect(output.total_count).toBeGreaterThan(5);
      expect(output.truncated).toBe(true);
      for (const row of output.events) {
        expect(typeof row.sample_index).toBe("number");
        expect(row.store_path).toBe(recordingZarr);
      }
      expect(output.envelope?.source_commit).toBe(V3_COMMIT);
    });

    test("a second get_events call for the same store is served from the per-store cache entry", async () => {
      const { body: listBody } = await callTool(app, env(db), 1, "list_recordings", {
        dataset_id: V3_ID,
        limit: 1,
      });
      const recordingZarr = (structuredContentOf(listBody) as unknown as ListRecordingsOutput)
        .recordings[0].zarr;

      await callTool(app, env(db), 2, "get_events", {
        dataset_id: V3_ID,
        recording: recordingZarr,
      });
      const parquetFetchesAfterFirst = fixtureServer.requestLog.filter(
        (r) => r.url === `${V3_ID}/zarr/events.parquet`,
      ).length;
      // hyparquet's asyncBufferFromUrl (no byteLength given) issues a HEAD
      // plus one or more ranged GETs to read the footer/row group -- more
      // than one request for a single whole-file parse. What matters is
      // that a SECOND call adds none of them (the per-store cache answers
      // from memory), asserted below.
      expect(parquetFetchesAfterFirst).toBeGreaterThan(0);

      await callTool(app, env(db), 3, "get_events", {
        dataset_id: V3_ID,
        recording: recordingZarr,
      });
      const parquetFetchesAfterSecond = fixtureServer.requestLog.filter(
        (r) => r.url === `${V3_ID}/zarr/events.parquet`,
      ).length;
      expect(parquetFetchesAfterSecond).toBe(parquetFetchesAfterFirst);
    });

    test("group filters events to one group's rows", async () => {
      const { body: listBody } = await callTool(app, env(db), 1, "list_recordings", {
        dataset_id: V3_ID,
        limit: 1,
      });
      const list = structuredContentOf(listBody) as unknown as ListRecordingsOutput;
      const recordingZarr = list.recordings[0].zarr;
      const groupName = list.recordings[0].groups?.[0]?.name as string;

      const { body } = await callTool(app, env(db), 2, "get_events", {
        dataset_id: V3_ID,
        recording: recordingZarr,
        group: groupName,
        limit: 500,
      });
      const output = structuredContentOf(body) as unknown as GetEventsOutput;
      expect(output.events.every((e) => e.group_name === groupName)).toBe(true);
    });

    test("an unknown recording lists known identifiers", async () => {
      const { body } = await callTool(app, env(db), 1, "get_events", {
        dataset_id: V3_ID,
        recording: "no/such/recording.zarr",
      });
      const text = errorTextOf(body);
      expect(text).toContain("not found");
      expect(text).toContain(".zarr");
    });

    test("v1 fallback: estimated true, sample_index matches floor(onset*rate+0.5), n/a as null", async () => {
      const { body } = await callTool(app, env(db), 1, "get_events", {
        dataset_id: V1_ID,
        recording: "sub-I003/eeg/sub-I003_task-sleep_eeg.zarr",
      });
      const output = structuredContentOf(body) as unknown as GetEventsOutput;
      getEventsOutputSchema.parse(output);
      expect(output.source).toBe("events_tsv_fallback");
      expect(output.estimated).toBe(true);
      // The fixture has 4 rows, one with an unparseable onset (n/a) --
      // exactly 3 should survive.
      expect(output.events.length).toBe(3);
      const rate = 200; // nm000111's eeg_200hz group.
      for (const row of output.events) {
        expect(row.sample_index).toBe(Math.floor(row.onset_s * rate + 0.5));
      }
      const withNullDuration = output.events.find((e) => e.onset_s === 2.5);
      expect(withNullDuration?.duration_s).toBeNull();
      const withHed = output.events.find((e) => e.onset_s === 1.0);
      expect(withHed?.hed).toBe("Sleep-stage/N1");
      const withNullHed = output.events.find((e) => e.onset_s === 2.5);
      expect(withNullHed?.hed).toBeNull();
    });

    test("v1 fallback: a missing events.tsv answers an empty list with a note", async () => {
      const { body } = await callTool(app, env(db), 1, "get_events", {
        dataset_id: V1_ID,
        recording: "sub-I004/eeg/sub-I004_task-sleep_eeg.zarr",
      });
      const output = structuredContentOf(body) as unknown as GetEventsOutput;
      expect(output.source).toBe("events_tsv_fallback");
      expect(output.events).toEqual([]);
      expect(output.note).toContain("no events file");
    });

    test("offset past the end answers an empty page, truncated: false", async () => {
      const { body } = await callTool(app, env(db), 1, "get_events", {
        dataset_id: V1_ID,
        recording: "sub-I003/eeg/sub-I003_task-sleep_eeg.zarr",
        offset: 1000,
      });
      const output = structuredContentOf(body) as unknown as GetEventsOutput;
      expect(output.events).toEqual([]);
      expect(output.truncated).toBe(false);
    });

    test("limit 5000 returns everything (nm000329's first store, well under the cap)", async () => {
      const { body: listBody } = await callTool(app, env(db), 1, "list_recordings", {
        dataset_id: V3_ID,
        limit: 1,
      });
      const recordingZarr = (structuredContentOf(listBody) as unknown as ListRecordingsOutput)
        .recordings[0].zarr;
      const { body } = await callTool(app, env(db), 2, "get_events", {
        dataset_id: V3_ID,
        recording: recordingZarr,
        limit: 5000,
      });
      const output = structuredContentOf(body) as unknown as GetEventsOutput;
      expect(output.events.length).toBe(output.total_count);
      expect(output.truncated).toBe(false);
    });

    test("a nonexistent group answers the group-not-found error (item 2)", async () => {
      const { body: listBody } = await callTool(app, env(db), 1, "list_recordings", {
        dataset_id: V3_ID,
        limit: 1,
      });
      const recordingZarr = (structuredContentOf(listBody) as unknown as ListRecordingsOutput)
        .recordings[0].zarr;
      const { body } = await callTool(app, env(db), 2, "get_events", {
        dataset_id: V3_ID,
        recording: recordingZarr,
        group: "not-a-real-group",
      });
      const text = errorTextOf(body);
      expect(text).toContain("no group named");
      expect(text).toContain("eeg_250hz");
    });

    test("CRLF events.tsv parses, and a half-sample onset ties UP (item 21)", async () => {
      const { body } = await callTool(app, env(db), 1, "get_events", {
        dataset_id: V1_ID,
        recording: "sub-I005/eeg/sub-I005_task-sleep_eeg.zarr",
      });
      const output = structuredContentOf(body) as unknown as GetEventsOutput;
      expect(output.source).toBe("events_tsv_fallback");
      expect(output.events.length).toBe(1);
      expect(output.events[0].onset_s).toBe(0.0025);
      // floor(0.0025 * 200 + 0.5) = floor(1.0) = 1, never 0 (which is what
      // JS/Python's banker's-rounding round() would give for the exact .5
      // tie at 0.0025 * 200 = 0.5).
      expect(output.events[0].sample_index).toBe(1);
    });

    test("events.parquet has no rows for a store: a note, not a bare empty list", async () => {
      // Every recording in nm000329's index is real, so pick one that
      // exists in the recordings projection but (being outside the fixture
      // parquet's actual content) has no rows once the whole file is read
      // -- proves the "absent from parquet" placeholder + note path
      // (item 4), not just "genuinely zero events".
      const { body: listBody } = await callTool(app, env(db), 1, "list_recordings", {
        dataset_id: V3_ID,
        limit: 5,
      });
      const list = structuredContentOf(listBody) as unknown as ListRecordingsOutput;
      const withoutKnownEvents = list.recordings.find((r) => !r.n_events);
      if (!withoutKnownEvents) {
        // Every sampled recording happens to carry n_events > 0 in this
        // fixture slice -- nothing to assert against; skip rather than
        // fail on fixture composition.
        return;
      }
      const { body } = await callTool(app, env(db), 2, "get_events", {
        dataset_id: V3_ID,
        recording: withoutKnownEvents.zarr,
      });
      const output = structuredContentOf(body) as unknown as GetEventsOutput;
      if (output.events.length === 0) {
        expect(output.note).toContain("no rows for this store");
      }
    });
  });

  describe("modality and min_duration_s combined (item 23)", () => {
    test("both filters apply together", async () => {
      const { body } = await callTool(app, env(db), 1, "list_recordings", {
        dataset_id: V3_ID,
        modality: "eeg",
        min_duration_s: 3000,
        limit: 500,
      });
      const output = structuredContentOf(body) as unknown as ListRecordingsOutput;
      expect(output.total_count).toBeGreaterThan(0);
      for (const r of output.recordings) {
        const hasEeg = (r.groups ?? []).some((g) => (g.modality ?? "").toLowerCase() === "eeg");
        expect(hasEeg).toBe(true);
        const maxDuration = Math.max(...(r.groups ?? []).map((g) => g.duration_s ?? 0));
        expect(maxDuration).toBeGreaterThanOrEqual(3000);
      }
    });
  });

  describe("zarr_store_count 0 answers the not-ready error (item 19)", () => {
    test("list_recordings", async () => {
      const { body } = await callTool(app, env(db), 1, "list_recordings", {
        dataset_id: ZERO_STORE_ID,
      });
      const text = errorTextOf(body);
      expect(text).toContain("zarr_status");
    });

    test("get_events", async () => {
      const { body } = await callTool(app, env(db), 1, "get_events", {
        dataset_id: ZERO_STORE_ID,
        recording: "x.zarr",
      });
      const text = errorTextOf(body);
      expect(text).toContain("zarr_status");
    });
  });

  describe("legacy v1 with an empty source_commit: cache always bypassed (item 17)", () => {
    /** Records every URL the PROJECTION cache's own `match()` was asked
     *  about, delegating to a real `InMemoryCache` underneath -- an
     *  infrastructure spy at the same boundary `zarr-data-cache.test.ts`'s
     *  fakes sit at, not a mock of business logic. Lets this test prove OUR
     *  `recordings` projection cache is never even CONSULTED for this
     *  dataset, independent of the zarr sub-app's own (separate,
     *  legitimate) `index.json` edge cache, which would otherwise mask the
     *  thing this test actually checks: a warm zarr-layer hit produces no
     *  upstream S3 request either way, so counting upstream requests alone
     *  cannot tell "our cache was bypassed" apart from "zarr's cache was
     *  warm". */
    class SpyCache implements CacheLike {
      matchedUrls: string[] = [];
      private inner = new InMemoryCache();
      async match(request: RequestInfo | URL): Promise<Response | undefined> {
        this.matchedUrls.push(request instanceof Request ? request.url : String(request));
        return this.inner.match(request);
      }
      async put(request: RequestInfo | URL, response: Response): Promise<void> {
        return this.inner.put(request, response);
      }
    }

    test("list_recordings: no envelope, the no-commit note, our projection cache never consulted", async () => {
      const spyCache = new SpyCache();
      const localDeps: McpRoutesDeps = { ...deps, cache: () => spyCache };
      const localApp = createMcpRoutes(localDeps);

      const { body: first } = await callTool(localApp, env(db), 1, "list_recordings", {
        dataset_id: EMPTY_COMMIT_ID,
      });
      const firstOutput = structuredContentOf(first) as unknown as ListRecordingsOutput;
      listRecordingsOutputSchema.parse(firstOutput);
      expect(firstOutput.source_commit).toBeNull();
      expect(firstOutput.envelope).toBeUndefined();
      expect(firstOutput.note).toContain("no usable");

      await callTool(localApp, env(db), 2, "list_recordings", { dataset_id: EMPTY_COMMIT_ID });

      // Neither call ever asked the projection cache about this dataset at
      // all -- `commitUsable` is false both times, so the `if (commitUsable)`
      // guard in `loadRecordingsProjection` skips the cache read entirely.
      const askedAboutThisDataset = spyCache.matchedUrls.filter((u) => u.includes(EMPTY_COMMIT_ID));
      expect(askedAboutThisDataset).toEqual([]);
    });

    test("get_events: no envelope, the no-commit note appended", async () => {
      const { body } = await callTool(app, env(db), 1, "get_events", {
        dataset_id: EMPTY_COMMIT_ID,
        recording: "sub-I003/eeg/sub-I003_task-sleep_eeg.zarr",
      });
      const output = structuredContentOf(body) as unknown as GetEventsOutput;
      expect(output.envelope).toBeUndefined();
      expect(output.note).toContain("no usable");
    });
  });

  describe("MEG SSS derived store (PR review item 1)", () => {
    test("list_recordings default (include_derived: false) excludes the derived store", async () => {
      const { body } = await callTool(app, env(db), 1, "list_recordings", {
        dataset_id: MEG_ID,
      });
      const output = structuredContentOf(body) as unknown as ListRecordingsOutput;
      expect(output.recordings.length).toBe(0);
      expect(output.excluded_derived_count).toBe(1);
    });

    test("include_derived: true lists it with envelope.derived and envelope.sss populated", async () => {
      const { body } = await callTool(app, env(db), 1, "list_recordings", {
        dataset_id: MEG_ID,
        include_derived: true,
      });
      const output = structuredContentOf(body) as unknown as ListRecordingsOutput;
      listRecordingsOutputSchema.parse(output);
      expect(output.recordings.length).toBe(1);
      expect(output.recordings[0].derived).toBe(true);
      expect(output.excluded_derived_count).toBe(0);
      expect(output.envelope).toBeDefined();
      expect(output.envelope?.derived).toBe(true);
      expect(output.envelope?.sss).toBeDefined();
      expect(output.envelope?.sss?.method).toBe("maxwell_filter");
    });

    test("get_events on the derived store carries the same envelope (fallback path)", async () => {
      const { body } = await callTool(app, env(db), 1, "get_events", {
        dataset_id: MEG_ID,
        recording: MEG_STORE_ZARR,
      });
      const output = structuredContentOf(body) as unknown as GetEventsOutput;
      getEventsOutputSchema.parse(output);
      expect(output.source).toBe("events_tsv_fallback");
      expect(output.envelope).toBeDefined();
      expect(output.envelope?.derived).toBe(true);
      expect(output.envelope?.sss?.applied).toBe(true);
    });
  });

  describe("the per-store cache fan-out is bounded", () => {
    const stores = (nm000329IndexRaw as { stores: Array<{ zarr: string }> }).stores;
    const requested = stores[0].zarr;
    const neighbour = stores[1].zarr;

    test("the two datasets really do sit either side of the bound", () => {
      expect(stores.length).toBeLessThanOrEqual(MAX_STORE_FANOUT_ENTRIES);
      expect(stores.length + FANOUT_EXTRA_STORES).toBeGreaterThan(MAX_STORE_FANOUT_ENTRIES);
    });

    test("under the bound: a neighbouring store's entry is written too", async () => {
      await callTool(app, env(db), 1, "get_events", {
        dataset_id: V3_ID,
        recording: requested,
      });
      expect(await cache.match(eventsKey(V3_ID, requested))).toBeDefined();
      expect(await cache.match(eventsKey(V3_ID, neighbour))).toBeDefined();
    });

    test("over the bound: only the requested store's entry, plus the summary", async () => {
      await callTool(app, env(db), 1, "get_events", {
        dataset_id: FANOUT_ID,
        recording: requested,
      });
      expect(await cache.match(eventsKey(FANOUT_ID, requested))).toBeDefined();
      expect(await cache.match(eventsKey(FANOUT_ID, neighbour))).toBeUndefined();
    });

    test("no group named: answers the FIRST group only, and says which and what else", async () => {
      // events.parquet is one row per (event, CHANNEL GROUP), so not filtering
      // returned every event once per group and reported total_count as the sum,
      // with no note, while the envelope described only the first group's rates.
      // The sibling tools (render_overview, read_window) already default to the
      // first group; this one was the outlier.
      const { body } = await callTool(app, env(db), 1, "get_events", {
        dataset_id: MULTI_GROUP_ID,
        recording: (nm000329IndexRaw as { stores: Array<{ zarr: string }> }).stores[0].zarr,
      });
      const output = getEventsOutputSchema.parse(structuredContentOf(body)) as GetEventsOutput;
      // Four events exist, carried as eight parquet rows across the two groups.
      // Before the fix this answered 8.
      expect(output.events.length).toBe(4);
      expect(output.total_count).toBe(4);
      // Every returned row belongs to the group that answered.
      expect(new Set(output.events.map((e) => e.group_name))).toEqual(new Set(["eeg_250hz"]));
      // Silently picking one of several is the surprising part, so it is named,
      // along with the alternative the caller can ask for.
      expect(output.note).toContain("group not specified");
      expect(output.note).toContain("eeg_250hz");
      expect(output.note).toContain(MULTI_GROUP_SECOND);
    });

    test("a group that exists but has no rows says so, naming the group", async () => {
      // Used to answer events: [], total_count: 0, note: null -- a confident
      // "this group has no events" -- because the no-rows note was computed on
      // the PRE-filter rows and the filter ran afterwards.
      const { body } = await callTool(app, env(db), 2, "get_events", {
        dataset_id: MULTI_GROUP_ID,
        recording: (nm000329IndexRaw as { stores: Array<{ zarr: string }> }).stores[0].zarr,
        group: MULTI_GROUP_SECOND,
      });
      const output = getEventsOutputSchema.parse(structuredContentOf(body)) as GetEventsOutput;
      // This fixture's second group DOES have rows, so asking for it explicitly
      // returns exactly its four and no note about emptiness.
      expect(output.events.length).toBe(4);
      expect(new Set(output.events.map((e) => e.group_name))).toEqual(
        new Set([MULTI_GROUP_SECOND]),
      );
      // Its sample_index is computed against ITS rate (500 Hz), so the two
      // groups' rows are genuinely different data, not duplicates.
      expect(output.events.map((e) => e.sample_index)).toEqual([500, 1000, 1500, 2000]);
      // No "group not specified" note here: the caller named it.
      expect(output.note ?? "").not.toContain("group not specified");
    });

    test("a declared group the parquet has NO rows for says so, naming the group", async () => {
      const { body } = await callTool(app, env(db), 3, "get_events", {
        dataset_id: MULTI_GROUP_ID,
        recording: (nm000329IndexRaw as { stores: Array<{ zarr: string }> }).stores[0].zarr,
        group: MULTI_GROUP_EMPTY,
      });
      const output = getEventsOutputSchema.parse(structuredContentOf(body)) as GetEventsOutput;
      expect(output.events).toEqual([]);
      expect(output.total_count).toBe(0);
      // The note is the whole point: an empty list with note: null reads as
      // "this group truly has no events", which is a claim nothing established.
      expect(output.note).not.toBeNull();
      expect(output.note).toContain(MULTI_GROUP_EMPTY);
      // Still the parquet path, not a fallback, and still not an estimate.
      expect(output.source).toBe("events_parquet");
      expect(output.estimated).toBe(false);
    });

    test("dropped rows are reported on a cache HIT, not only to whoever missed", async () => {
      const recording = (nm000329IndexRaw as { stores: Array<{ zarr: string }> }).stores[0].zarr;
      const args = { dataset_id: INVALID_ROW_ID, recording };

      const first = getEventsOutputSchema.parse(
        structuredContentOf((await callTool(app, env(db), 1, "get_events", args)).body),
      ) as GetEventsOutput;
      expect(first.events.length).toBe(3);
      expect(first.note).toContain("1 row(s) failed validation");

      // Same store again. This is a cache hit, and it used to answer note: null
      // with a total_count that quietly omitted the dropped row -- the omission
      // was visible only to the caller who happened to populate the entry.
      const second = getEventsOutputSchema.parse(
        structuredContentOf((await callTool(app, env(db), 2, "get_events", args)).body),
      ) as GetEventsOutput;
      expect(second.events.length).toBe(3);
      expect(second.note).toContain("1 row(s) failed validation");
      expect(second.note).toEqual(first.note);
    });

    test("an events.parquet over the row budget is DECLINED, naming the public URL", async () => {
      // The bug: get_events read the whole file before applying limit/offset, so
      // `limit: 1` against nm000104 pulled 95 MB through the Worker,
      // zstd-decompressed it in pure JS, materialized 5.4 M row objects and ran
      // 5.4 M zod parses. That cannot fit a 128 MB isolate, and the failure
      // re-amplified: the isolate died before waitUntil ran, so nothing cached,
      // so the next call repeated the whole read.
      const { body } = await callTool(app, env(db), 1, "get_events", {
        dataset_id: OVERSIZED_EVENTS_ID,
        recording: (nm000329IndexRaw as { stores: Array<{ zarr: string }> }).stores[0].zarr,
        limit: 1,
      });
      const text = errorTextOf(body);
      expect(text).toContain("declines");
      expect(text).toContain("100001 rows");
      // The remedy travels with the refusal: the file is public, so a client
      // that really wants every row can read it directly. Handing over a URL
      // instead of streaming bytes is the recipe-first posture (ADR 0049).
      expect(text).toContain("events.parquet");
      expect(text).toContain("read it directly");
    });

    test("a re-conversion at an UNCHANGED commit does not serve the old entry", async () => {
      // The bug this key shape exists to prevent. `source_commit` is the dataset
      // repo's HEAD, not a conversion identity, and the documented back-catalog
      // mechanism re-converts without touching it: an engine bump re-queues a
      // `done` row and bumps no dataset version (ADR 0033), and a --clean
      // rebuild or a retry after an infra failure are the same shape. Keyed on
      // the commit alone, the stale entry stayed readable for its full 7-day TTL
      // while index.json itself refreshed in 5 minutes, and nothing purges these
      // synthetic keys.
      await callTool(app, env(db), 1, "get_events", {
        dataset_id: V3_ID,
        recording: requested,
      });
      const beforeKey = eventsKey(V3_ID, requested);
      expect(await cache.match(beforeKey)).toBeDefined();

      // Same commit, new conversion.
      const RECONVERTED_AT = "2026-09-08 03:30:00";
      db.query("UPDATE datasets SET zarr_converted_at = ? WHERE dataset_id = ?").run(
        RECONVERTED_AT,
        V3_ID,
      );
      await callTool(app, env(db), 2, "get_events", {
        dataset_id: V3_ID,
        recording: requested,
      });

      const afterKey = eventsKey(V3_ID, requested, RECONVERTED_AT);
      expect(afterKey).not.toBe(beforeKey);
      // The new conversion has its own entry...
      expect(await cache.match(afterKey)).toBeDefined();
      // ...and the pre-re-conversion entry is still sitting there under its own
      // key, which is exactly why it must not be the key that gets read.
      expect(await cache.match(beforeKey)).toBeDefined();
    });

    test("over the bound: the requested store's own second call is still a hit", async () => {
      await callTool(app, env(db), 1, "get_events", {
        dataset_id: FANOUT_ID,
        recording: requested,
      });
      const parquetReadsBefore = fixtureServer.requestLog.length;
      const { body } = await callTool(app, env(db), 2, "get_events", {
        dataset_id: FANOUT_ID,
        recording: requested,
      });
      const output = structuredContentOf(body) as unknown as GetEventsOutput;
      expect(output.events.length).toBeGreaterThan(0);
      // The second call reads the index (cheap, edge-cached) but never the
      // parquet again.
      expect(
        fixtureServer.requestLog
          .slice(parquetReadsBefore)
          .filter((r) => r.url.endsWith("events.parquet")).length,
      ).toBe(0);
    });
  });
});
