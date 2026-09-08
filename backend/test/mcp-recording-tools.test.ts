/**
 * Real-route tests for `list_recordings` and `get_events` (epic #1065 phase
 * 3, issue #1295; plan decisions 6, 7). Driven through `createMcpRoutes(deps)`
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
import { type McpRoutesDeps, createMcpRoutes } from "../src/routes/mcp.js";
import { createZarrDataRoutes } from "../src/routes/zarr-data.js";
import { GITHUB_RAW_ORIGIN } from "../src/services/zarr-fidelity-sweep.js";
import type { Bindings } from "../src/types/bindings.js";
import nm000111IndexV1Raw from "./fixtures/mcp/nm000111-index-v1.json";
import nm000329IndexRaw from "./fixtures/mcp/nm000329-index.json";
import { InMemoryCache } from "./helpers/cache.js";
import { freshDb, realD1 } from "./helpers/d1.js";
import { type FixtureServer, startFixtureServer } from "./helpers/fixture-server.js";

type App = Hono<{ Bindings: Bindings }>;

const V3_ID = "nm000329";
const V3_COMMIT = "7172d2d492dad63650f80cdb83352a0e9d4420f7";
const V1_ID = "nm000111";
const V1_COMMIT = "510a05377459cf857e60b861ab377bc53b5b5b29";
const PENDING_ID = "nm500601";

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
    // ADR 0027 non-raw exclusion (decision 5/6) has something real to
    // exclude -- the live nm000111 slice has no such store on its own.
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

    const parquetBytes = new Uint8Array(
      readFileSync(new URL("./fixtures/mcp/nm000329-events.parquet", import.meta.url)),
    );
    fixtureServer.files.set(`${V3_ID}/zarr/events.parquet`, parquetBytes);

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
      ...cols,
    };
    const keys = Object.keys(merged);
    db.query(
      `INSERT INTO datasets (dataset_id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})`,
    ).run(datasetId, ...(keys.map((k) => merged[k]) as never[]));
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
  });
});
