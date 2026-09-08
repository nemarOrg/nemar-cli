/**
 * `render_overview` and its pure helpers (`overview.ts`) -- epic #1065
 * phase 3, issue #1295, plan decision 8.
 *
 * Pure-function tests (`pickViewLevel`, `buildChunkPlan`,
 * `reassembleViewChunks`, `renderOverviewPng`) run against nm000329's REAL
 * live geometry (138750 samples, 5 view levels, `view/5` 135 columns in one
 * chunk of `chunk_columns: 135`) and the REAL decoded level-5 chunk bytes
 * (`test/fixtures/mcp/nm000329-view5-c-0-0-0.bin`, `curl -sL -A
 * "nemar-cli/mcp-phase3"` against the live S3 object).
 *
 * The route-level tests drive `render_overview` through `createMcpRoutes`
 * exactly like `mcp-recording-tools.test.ts`: real D1, a real
 * `Bun.serve()` fixture upstream, a real `InMemoryCache`. The request log
 * is the evidence the PR's definition of done asks for: only `view/<L>/`
 * keys are ever read, never `/0/c/` (level 0) and never `zarr.json`.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decode as decodePng } from "fast-png";
import type { Hono } from "hono";
import {
  buildChunkPlan,
  computeRowPx,
  computeViewLevelColumns,
  pickViewLevel,
  reassembleViewChunks,
  renderOverviewPng,
} from "../src/mcp/overview.js";
import { type McpRoutesDeps, createMcpRoutes } from "../src/routes/mcp.js";
import { createZarrDataRoutes } from "../src/routes/zarr-data.js";
import { decodeBloscZstdInt16 } from "../src/services/blosc-decode.js";
import type { Bindings } from "../src/types/bindings.js";
import nm000111IndexV1Raw from "./fixtures/mcp/nm000111-index-v1.json";
import nm000329IndexRaw from "./fixtures/mcp/nm000329-index.json";
import { InMemoryCache } from "./helpers/cache.js";
import { freshDb, realD1 } from "./helpers/d1.js";
import { type FixtureServer, startFixtureServer } from "./helpers/fixture-server.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const NM000329_N_SAMPLES = 138750;
const NM000329_N_VIEW_LEVELS = 5;

describe("pickViewLevel (nm000329 eeg_250hz: 138750 samples, 5 levels)", () => {
  const cases: Array<[number, number]> = [
    [100, 5],
    [800, 3],
    [4000, 2],
    [40000, 1],
  ];
  for (const [widthPx, expected] of cases) {
    test(`width_px ${widthPx} picks level ${expected}`, () => {
      expect(pickViewLevel(NM000329_N_SAMPLES, NM000329_N_VIEW_LEVELS, widthPx)).toBe(expected);
    });
  }

  test("computeViewLevelColumns matches the live geometry", () => {
    const cols = computeViewLevelColumns(NM000329_N_SAMPLES, NM000329_N_VIEW_LEVELS);
    expect(cols).toEqual([34687, 8671, 2167, 541, 135]);
  });

  test("level 0 is never a candidate; nViewLevels < 1 throws", () => {
    expect(() => pickViewLevel(1000, 0, 100)).toThrow();
  });
});

describe("buildChunkPlan", () => {
  test("the last level (135 columns, chunk_columns 135) is one chunk", () => {
    const plan = buildChunkPlan({ level: 5, levelColumns: 135, viewChunkColumns: 1024 });
    expect(plan.chunkColumns).toBe(1024);
    expect(plan.chunkKeys).toEqual(["view/5/c/0/0/0"]);
  });

  test("a middle level (2167 columns, chunk 1024) spans three chunks", () => {
    const plan = buildChunkPlan({ level: 3, levelColumns: 2167, viewChunkColumns: 1024 });
    expect(plan.chunkKeys).toEqual(["view/3/c/0/0/0", "view/3/c/0/0/1", "view/3/c/0/0/2"]);
  });

  test("missing view_chunk_columns defaults to 1024", () => {
    const plan = buildChunkPlan({ level: 1, levelColumns: 34687, viewChunkColumns: null });
    expect(plan.chunkColumns).toBe(1024);
    expect(plan.chunkKeys.length).toBe(Math.ceil(34687 / 1024));
  });
});

describe("renderOverviewPng on the real decoded level-5 chunk", () => {
  const chunkBytes = new Uint8Array(
    readFileSync(new URL("./fixtures/mcp/nm000329-view5-c-0-0-0.bin", import.meta.url)),
  );
  const decoded = decodeBloscZstdInt16(chunkBytes);
  const N_CHANNELS = 63;
  const TOTAL_COLUMNS = 135;

  test("the decoded chunk has the expected [2, 63, 135] length", () => {
    expect(decoded.length).toBe(2 * N_CHANNELS * TOTAL_COLUMNS);
  });

  test("reassembleViewChunks accepts a single chunk unchanged", () => {
    const reassembled = reassembleViewChunks({
      nChannels: N_CHANNELS,
      totalColumns: TOTAL_COLUMNS,
      chunks: [decoded],
    });
    expect(reassembled.length).toBe(decoded.length);
    expect(Array.from(reassembled)).toEqual(Array.from(decoded));
  });

  test("computeRowPx: 63 channels gives 19px rows; 320 channels gives 3px rows", () => {
    expect(computeRowPx(63)).toBe(19);
    expect(computeRowPx(320)).toBe(3);
  });

  test("produces a PNG with the expected geometry, decodable, with dark pixels in every band", () => {
    const widthPx = 100;
    const rendered = renderOverviewPng({
      nChannels: N_CHANNELS,
      totalColumns: TOTAL_COLUMNS,
      widthPx,
      data: decoded,
    });
    const rowPx = computeRowPx(N_CHANNELS);
    const expectedHeight = N_CHANNELS * rowPx + (N_CHANNELS - 1);
    expect(rendered.widthPx).toBe(widthPx);
    expect(rendered.heightPx).toBe(expectedHeight);

    const image = decodePng(rendered.png);
    expect(image.width).toBe(widthPx);
    expect(image.height).toBe(expectedHeight);
    expect(image.channels).toBe(1);
    expect(image.depth).toBe(8);

    // Every channel band has at least one dark (bar) pixel.
    const bandStride = rowPx + 1;
    for (let ch = 0; ch < N_CHANNELS; ch++) {
      const bandTop = ch * bandStride;
      let sawDark = false;
      for (let r = 0; r < rowPx && !sawDark; r++) {
        for (let x = 0; x < widthPx; x++) {
          if (image.data[(bandTop + r) * widthPx + x] < 128) {
            sawDark = true;
            break;
          }
        }
      }
      expect(sawDark).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Route-level tests
// ---------------------------------------------------------------------------

type App = Hono<{ Bindings: Bindings }>;

const V3_ID = "nm000329";
const V3_COMMIT = "7172d2d492dad63650f80cdb83352a0e9d4420f7";
const V1_ID = "nm000111";
const V1_COMMIT = "510a05377459cf857e60b861ab377bc53b5b5b29";
const FIRST_STORE_ZARR = "sub-1/ses-0/eeg/sub-1_ses-0_task-imagery_acq-calibration_run-0_eeg.zarr";

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function encode(doc: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(doc));
}

const FIXTURE_PUBLIC_ORIGIN = "https://fixture.nemar.test";

function translatingFetch(real: typeof fetch, fixtureBase: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(FIXTURE_PUBLIC_ORIGIN)) {
      return real(fixtureBase + url.slice(FIXTURE_PUBLIC_ORIGIN.length), init);
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

function errorTextOf(body: JsonRpcResponse): string {
  expect(body.error).toBeUndefined();
  const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
  expect(result.isError).toBe(true);
  return result.content[0]?.text ?? "";
}

interface ImageContentBlock {
  type: "image";
  data: string;
  mimeType: string;
}
interface TextContentBlock {
  type: "text";
  text: string;
}

function contentOf(body: JsonRpcResponse): { isError?: boolean; content: unknown[] } {
  expect(body.error).toBeUndefined();
  const result = body.result as { isError?: boolean; content: unknown[] };
  expect(result.isError).not.toBe(true);
  return result;
}

describe("render_overview (route)", () => {
  let db: Database;
  let app: App;
  let fixtureServer: FixtureServer;
  let cache: InMemoryCache;

  beforeAll(() => {
    fixtureServer = startFixtureServer();

    const rewrittenV3Index = {
      ...nm000329IndexRaw,
      data_base: `${FIXTURE_PUBLIC_ORIGIN}/${V3_ID}/zarr/`,
      contract_base: `${FIXTURE_PUBLIC_ORIGIN}/${V3_ID}/zarr/`,
      events_parquet: `${FIXTURE_PUBLIC_ORIGIN}/${V3_ID}/zarr/events.parquet`,
    };
    fixtureServer.files.set(`${V3_ID}/zarr/index.json`, encode(rewrittenV3Index));
    fixtureServer.files.set(`${V1_ID}/zarr/index.json`, encode(nm000111IndexV1Raw));

    const view5Chunk = new Uint8Array(
      readFileSync(new URL("./fixtures/mcp/nm000329-view5-c-0-0-0.bin", import.meta.url)),
    );
    fixtureServer.files.set(
      `${V3_ID}/zarr/${FIRST_STORE_ZARR}/eeg_250hz/view/5/c/0/0/0`,
      view5Chunk,
    );

    cache = new InMemoryCache();
    const zarrRoutes = createZarrDataRoutes({
      cache: () => cache,
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
      s3Base: fixtureServer.url,
    });
    const deps: McpRoutesDeps = {
      onerror: (err) => console.error("[mcp overview test] transport error", err),
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
    });
    insertDataset(V1_ID, {
      zarr_status: "ready",
      zarr_store_count: 6,
      zarr_source_commit: V1_COMMIT,
    });
  });

  function env(database: Database): Bindings {
    return { DB: realD1(database), ENVIRONMENT: "development" } as unknown as Bindings;
  }

  test("width_px 100 picks level 5, reads only view/5/ keys, never /0/c/ or zarr.json", async () => {
    const { body } = await callTool(app, env(db), 1, "render_overview", {
      dataset_id: V3_ID,
      recording: FIRST_STORE_ZARR,
      width_px: 100,
    });
    const result = contentOf(body);
    const content = result.content as Array<ImageContentBlock | TextContentBlock>;
    const image = content.find((c): c is ImageContentBlock => c.type === "image");
    const text = content.find((c): c is TextContentBlock => c.type === "text");
    expect(image).toBeDefined();
    expect(image?.mimeType).toBe("image/png");
    expect(image?.data.length).toBeGreaterThan(0);

    const metadata = JSON.parse(text?.text ?? "{}");
    expect(metadata.level).toBe(5);
    expect(metadata.chunks_read).toBe(1);
    expect(metadata.width_px).toBe(100);
    expect(metadata.envelope?.dtype).toBe("int16");

    const objectRequests = fixtureServer.requestLog.filter((r) => r.url.includes(`${V3_ID}/zarr/`));
    const chunkOrMetaRequests = objectRequests.filter((r) => r.url !== `${V3_ID}/zarr/index.json`);
    expect(chunkOrMetaRequests.length).toBeGreaterThan(0);
    for (const r of chunkOrMetaRequests) {
      expect(r.url).toContain("view/5/");
    }
    expect(fixtureServer.requestLog.some((r) => r.url.includes("zarr.json"))).toBe(false);
    expect(fixtureServer.requestLog.some((r) => /\/0\/c\//.test(r.url))).toBe(false);
  });

  test("a second call at the same width is a cache hit with an empty request log", async () => {
    await callTool(app, env(db), 1, "render_overview", {
      dataset_id: V3_ID,
      recording: FIRST_STORE_ZARR,
      width_px: 100,
    });
    fixtureServer.requestLog.length = 0;

    const { body } = await callTool(app, env(db), 2, "render_overview", {
      dataset_id: V3_ID,
      recording: FIRST_STORE_ZARR,
      width_px: 100,
    });
    const result = contentOf(body);
    const text = (result.content as TextContentBlock[]).find((c) => c.type === "text");
    const metadata = JSON.parse(text?.text ?? "{}");
    expect(metadata.chunks_read).toBe(0);
    expect(metadata.bytes_read).toBe(0);
    expect(fixtureServer.requestLog.length).toBe(0);
  });

  test("a v1 (legacy) group with no pyramid answers a distinct 'no pyramid' error", async () => {
    const { body } = await callTool(app, env(db), 1, "render_overview", {
      dataset_id: V1_ID,
      recording: "sub-I003/eeg/sub-I003_task-sleep_eeg.zarr",
    });
    const text = errorTextOf(body);
    expect(text).toContain("no view/* pyramid");
  });

  test("an unknown group name answers a group-not-found error listing the real groups", async () => {
    const { body } = await callTool(app, env(db), 1, "render_overview", {
      dataset_id: V3_ID,
      recording: FIRST_STORE_ZARR,
      group: "not-a-real-group",
    });
    const text = errorTextOf(body);
    expect(text).toContain("no group named");
    expect(text).toContain("eeg_250hz");
  });
});
