/**
 * `buildMcpDataPoint` / `recordMcpToolCall` (epic #1065 phase 2, issue
 * #1294). The binding-shaped collector below is an infrastructure fake at
 * the runtime boundary (the same pattern `zarr-data-cache.test.ts` already
 * uses for `ANALYTICS`: a `writeDataPoint` that appends to an array), not a
 * mock of business logic.
 *
 * The last describe block drives the REAL sub-app (`createMcpRoutes()`) end
 * to end for the "one point per tools/call, including on the error path"
 * assertion, rather than re-deriving a route here -- `mcp-route.test.ts`
 * owns the full protocol/tool-surface coverage; this file only checks that
 * `withToolMetrics` (`src/mcp/server.ts`) actually wires `recordMcpToolCall`
 * into every tool call, on all three finishes (`"ok"` / `"tool_error"` /
 * `"exception"`).
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type McpRoutesDeps, createMcpRoutes } from "../src/routes/mcp";
import { createZarrDataRoutes } from "../src/routes/zarr-data";
import {
  type McpToolCallEvent,
  buildMcpDataPoint,
  recordMcpToolCall,
} from "../src/services/mcp-metrics";
import type { Bindings } from "../src/types/bindings";
import nm000329IndexRaw from "./fixtures/mcp/nm000329-index.json";
import { InMemoryCache } from "./helpers/cache";
import { freshDb, realD1 } from "./helpers/d1";
import { type FixtureServer, startFixtureServer } from "./helpers/fixture-server";

describe("buildMcpDataPoint", () => {
  test("shape: indexes/blobs/doubles in the documented order, including the outcome blob", () => {
    const event: McpToolCallEvent = {
      tool: "describe_dataset",
      datasetId: "nm000329",
      cacheStatus: "none",
      elapsedMs: 12.5,
      upstreamBytes: 0,
      outcome: "ok",
    };
    expect(buildMcpDataPoint(event)).toEqual({
      indexes: ["describe_dataset"],
      blobs: ["describe_dataset", "nm000329", "none", "ok"],
      doubles: [12.5, 0],
    });
  });

  test("a call naming no dataset reports blob2 as '-'", () => {
    const event: McpToolCallEvent = {
      tool: "search_datasets",
      datasetId: undefined,
      cacheStatus: "none",
      elapsedMs: 3,
      upstreamBytes: 0,
      outcome: "ok",
    };
    expect(buildMcpDataPoint(event).blobs).toEqual(["search_datasets", "-", "none", "ok"]);
  });

  test("a null dataset_id also reports blob2 as '-'", () => {
    const event: McpToolCallEvent = {
      tool: "search_datasets",
      datasetId: null,
      cacheStatus: "none",
      elapsedMs: 3,
      upstreamBytes: 0,
      outcome: "ok",
    };
    expect(buildMcpDataPoint(event).blobs).toEqual(["search_datasets", "-", "none", "ok"]);
  });

  test("outcome blob carries tool_error and exception verbatim", () => {
    const toolError: McpToolCallEvent = {
      tool: "describe_dataset",
      datasetId: "nm599999",
      cacheStatus: "none",
      elapsedMs: 1,
      upstreamBytes: 0,
      outcome: "tool_error",
    };
    const exception: McpToolCallEvent = {
      tool: "describe_dataset",
      datasetId: "nm000001",
      cacheStatus: "none",
      elapsedMs: 1,
      upstreamBytes: 0,
      outcome: "exception",
    };
    expect(buildMcpDataPoint(toolError).blobs?.[3]).toBe("tool_error");
    expect(buildMcpDataPoint(exception).blobs?.[3]).toBe("exception");
  });
});

describe("recordMcpToolCall", () => {
  test("no-ops without the ANALYTICS_MCP binding", () => {
    // Must not throw with the binding absent (dev/test, or before
    // provisioning) -- Pick<Bindings, "ANALYTICS_MCP"> with the key omitted.
    expect(() =>
      recordMcpToolCall({} as Pick<Bindings, "ANALYTICS_MCP">, {
        tool: "search_datasets",
        cacheStatus: "none",
        elapsedMs: 1,
        upstreamBytes: 0,
        outcome: "ok",
      }),
    ).not.toThrow();
  });

  test("records one point via a binding whose writeDataPoint appends to an array", () => {
    const points: AnalyticsEngineDataPoint[] = [];
    const env = {
      ANALYTICS_MCP: {
        writeDataPoint: (p: AnalyticsEngineDataPoint) => {
          points.push(p);
        },
      },
    } as unknown as Pick<Bindings, "ANALYTICS_MCP">;

    recordMcpToolCall(env, {
      tool: "describe_dataset",
      datasetId: "nm000329",
      cacheStatus: "none",
      elapsedMs: 7,
      upstreamBytes: 0,
      outcome: "ok",
    });

    expect(points.length).toBe(1);
    expect(points[0].indexes).toEqual(["describe_dataset"]);
    expect(points[0].blobs).toEqual(["describe_dataset", "nm000329", "none", "ok"]);
    expect(points[0].doubles).toEqual([7, 0]);
  });

  test("a throwing writeDataPoint is swallowed, never breaking the caller", () => {
    const env = {
      ANALYTICS_MCP: {
        writeDataPoint: () => {
          throw new Error("boom");
        },
      },
    } as unknown as Pick<Bindings, "ANALYTICS_MCP">;
    const originalError = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      expect(() =>
        recordMcpToolCall(env, {
          tool: "search_datasets",
          cacheStatus: "none",
          elapsedMs: 1,
          upstreamBytes: 0,
          outcome: "ok",
        }),
      ).not.toThrow();
      expect(calls.length).toBe(1);
    } finally {
      console.error = originalError;
    }
  });
});

describe("withToolMetrics wiring, driven through the real sub-app", () => {
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      p.catch(() => {});
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  const MODERN_META = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  };

  let db: Database;
  let points: AnalyticsEngineDataPoint[];

  beforeEach(() => {
    db = freshDb();
    points = [];
    db.query(
      "INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, status, is_sandbox) VALUES ('nm500010', -1, 'Metrics Fixture', 'public', 'active', 0)",
    ).run();
  });

  function envWithCollector(): Bindings {
    return {
      DB: realD1(db),
      ENVIRONMENT: "development",
      ANALYTICS_MCP: {
        writeDataPoint: (p: AnalyticsEngineDataPoint) => {
          points.push(p);
        },
      },
    } as unknown as Bindings;
  }

  async function callTool(
    name: string,
    args: Record<string, unknown>,
    env: Bindings = envWithCollector(),
  ) {
    const app = createMcpRoutes();
    return app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Mcp-Method": "tools/call",
          "Mcp-Name": name,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args, _meta: MODERN_META },
        }),
      },
      env,
      ctx,
    );
  }

  test("a successful search_datasets call records exactly one point, outcome ok", async () => {
    const res = await callTool("search_datasets", {});
    expect(res.status).toBe(200);
    expect(points.length).toBe(1);
    expect(points[0].indexes).toEqual(["search_datasets"]);
    expect(points[0].blobs?.[1]).toBe("-"); // search_datasets names no dataset id
    expect(points[0].blobs?.[3]).toBe("ok");
    expect(points[0].doubles?.[0]).toBeGreaterThanOrEqual(0);
  });

  test("a describe_dataset call records the requested dataset_id, outcome ok", async () => {
    const res = await callTool("describe_dataset", { dataset_id: "nm500010" });
    expect(res.status).toBe(200);
    expect(points.length).toBe(1);
    expect(points[0].blobs?.[0]).toBe("describe_dataset");
    expect(points[0].blobs?.[1]).toBe("nm500010");
    expect(points[0].blobs?.[3]).toBe("ok");
    expect(points[0].doubles?.[0]).toBeGreaterThanOrEqual(0);
  });

  test("an unknown-id describe_dataset call (isError: true) still records exactly one point, outcome tool_error, dataset id included", async () => {
    const res = await callTool("describe_dataset", { dataset_id: "nm599999" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { isError?: boolean } };
    expect(body.result.isError).toBe(true);
    expect(points.length).toBe(1);
    expect(points[0].blobs?.[1]).toBe("nm599999");
    expect(points[0].blobs?.[3]).toBe("tool_error");
    expect(points[0].doubles?.[0]).toBeGreaterThanOrEqual(0);
  });

  test("a thrown D1 error (no migrated schema) still records exactly one point, outcome exception, the requested dataset id attributed", async () => {
    // A completely unmigrated database -- freshDb() with no schema applied
    // at all -- so the tool's own SELECT throws "no such table: datasets"
    // before it can return anything. getDatasetId(args) in withToolMetrics
    // reads args.dataset_id BEFORE the tool runs, so this id is still
    // attributed even though the tool itself never got far enough to
    // report one.
    const { Database: BunDatabase } = await import("bun:sqlite");
    const emptyDb = new BunDatabase(":memory:");
    const env: Bindings = {
      DB: realD1(emptyDb),
      ENVIRONMENT: "development",
      ANALYTICS_MCP: {
        writeDataPoint: (p: AnalyticsEngineDataPoint) => {
          points.push(p);
        },
      },
    } as unknown as Bindings;

    const res = await callTool("describe_dataset", { dataset_id: "nm500010" }, env);
    // The transport answers an error (the SDK's own tool-execution catch
    // surfaces a thrown error as a result, not a bare HTTP 500) -- what
    // matters here is that exactly one metrics point was still written,
    // with the right id and outcome, before/around that error surfacing.
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(points.length).toBe(1);
    expect(points[0].blobs?.[0]).toBe("describe_dataset");
    expect(points[0].blobs?.[1]).toBe("nm500010");
    expect(points[0].blobs?.[3]).toBe("exception");
    expect(points[0].doubles?.[0]).toBeGreaterThanOrEqual(0);
  });
});

describe("cache_status metrics for the three recording-level tools (PR review item 16)", () => {
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      p.catch(() => {});
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  const MODERN_META = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  };

  const V3_ID = "nm000329";
  const V3_COMMIT = "7172d2d492dad63650f80cdb83352a0e9d4420f7";
  const FIXTURE_PUBLIC_ORIGIN = "https://fixture.nemar.test";
  const FIRST_STORE_ZARR =
    "sub-1/ses-0/eeg/sub-1_ses-0_task-imagery_acq-calibration_run-0_eeg.zarr";

  function translatingFetch(real: typeof fetch, fixtureBase: string): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(FIXTURE_PUBLIC_ORIGIN)) {
        return real(fixtureBase + url.slice(FIXTURE_PUBLIC_ORIGIN.length), init);
      }
      return real(input, init);
    }) as typeof fetch;
  }

  let db: Database;
  let fixtureServer: FixtureServer;
  let points: AnalyticsEngineDataPoint[];
  let deps: McpRoutesDeps;
  let app: ReturnType<typeof createMcpRoutes>;

  beforeEach(() => {
    db = freshDb();
    db.query(
      `INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, status, is_sandbox, zarr_status, zarr_store_count, zarr_source_commit)
       VALUES (?, -1, ?, 'public', 'active', 0, 'ready', ?, ?)`,
    ).run(V3_ID, V3_ID, (nm000329IndexRaw as { store_count: number }).store_count, V3_COMMIT);

    fixtureServer = startFixtureServer();
    const rewrittenIndex = {
      ...nm000329IndexRaw,
      data_base: `${FIXTURE_PUBLIC_ORIGIN}/${V3_ID}/zarr/`,
      contract_base: `${FIXTURE_PUBLIC_ORIGIN}/${V3_ID}/zarr/`,
      events_parquet: `${FIXTURE_PUBLIC_ORIGIN}/${V3_ID}/zarr/events.parquet`,
    };
    fixtureServer.files.set(
      `${V3_ID}/zarr/index.json`,
      new TextEncoder().encode(JSON.stringify(rewrittenIndex)),
    );
    fixtureServer.files.set(
      `${V3_ID}/zarr/events.parquet`,
      new Uint8Array(
        readFileSync(new URL("./fixtures/mcp/nm000329-events.parquet", import.meta.url)),
      ),
    );
    fixtureServer.files.set(
      `${V3_ID}/zarr/${FIRST_STORE_ZARR}/eeg_250hz/view/5/c/0/0/0`,
      new Uint8Array(
        readFileSync(new URL("./fixtures/mcp/nm000329-view5-c-0-0-0.bin", import.meta.url)),
      ),
    );

    const cache = new InMemoryCache();
    points = [];
    deps = {
      onerror: () => {},
      cache: () => cache,
      fetch: translatingFetch(fetch, fixtureServer.url),
      zarrRoutes: createZarrDataRoutes({
        cache: () => cache,
        fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
        s3Base: fixtureServer.url,
      }),
      rawGithubBase: fixtureServer.url,
    };
    app = createMcpRoutes(deps);
  });

  function envWithCollector(): Bindings {
    return {
      DB: realD1(db),
      ENVIRONMENT: "development",
      ANALYTICS_MCP: {
        writeDataPoint: (p: AnalyticsEngineDataPoint) => {
          points.push(p);
        },
      },
    } as unknown as Bindings;
  }

  async function callTool(name: string, args: Record<string, unknown>) {
    return app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Mcp-Method": "tools/call",
          "Mcp-Name": name,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args, _meta: MODERN_META },
        }),
      },
      envWithCollector(),
      ctx,
    );
  }

  test("list_recordings: first call miss, second call hit (blob index 2)", async () => {
    await callTool("list_recordings", { dataset_id: V3_ID });
    await callTool("list_recordings", { dataset_id: V3_ID });
    expect(points.length).toBe(2);
    expect(points[0].blobs?.[2]).toBe("miss");
    expect(points[1].blobs?.[2]).toBe("hit");
  });

  test("get_events: first call miss, second call hit (blob index 2)", async () => {
    const args = { dataset_id: V3_ID, recording: FIRST_STORE_ZARR };
    await callTool("get_events", args);
    await callTool("get_events", args);
    expect(points.length).toBe(2);
    expect(points[0].blobs?.[2]).toBe("miss");
    expect(points[1].blobs?.[2]).toBe("hit");
  });

  test("render_overview: first call miss, second call hit (blob index 2)", async () => {
    const args = { dataset_id: V3_ID, recording: FIRST_STORE_ZARR, width_px: 100 };
    await callTool("render_overview", args);
    await callTool("render_overview", args);
    expect(points.length).toBe(2);
    expect(points[0].blobs?.[2]).toBe("miss");
    expect(points[1].blobs?.[2]).toBe("hit");
  });
});
