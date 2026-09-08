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
 * into every tool call.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { createMcpRoutes } from "../src/routes/mcp";
import {
  type McpToolCallEvent,
  buildMcpDataPoint,
  recordMcpToolCall,
} from "../src/services/mcp-metrics";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

describe("buildMcpDataPoint", () => {
  test("shape: indexes/blobs/doubles in the documented order", () => {
    const event: McpToolCallEvent = {
      tool: "describe_dataset",
      datasetId: "nm000329",
      cacheStatus: "none",
      elapsedMs: 12.5,
      upstreamBytes: 0,
    };
    expect(buildMcpDataPoint(event)).toEqual({
      indexes: ["describe_dataset"],
      blobs: ["describe_dataset", "nm000329", "none"],
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
    };
    expect(buildMcpDataPoint(event).blobs).toEqual(["search_datasets", "-", "none"]);
  });

  test("a null dataset_id also reports blob2 as '-'", () => {
    const event: McpToolCallEvent = {
      tool: "search_datasets",
      datasetId: null,
      cacheStatus: "none",
      elapsedMs: 3,
      upstreamBytes: 0,
    };
    expect(buildMcpDataPoint(event).blobs).toEqual(["search_datasets", "-", "none"]);
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
    });

    expect(points.length).toBe(1);
    expect(points[0].indexes).toEqual(["describe_dataset"]);
    expect(points[0].blobs).toEqual(["describe_dataset", "nm000329", "none"]);
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

  async function callTool(name: string, args: Record<string, unknown>) {
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
      envWithCollector(),
      ctx,
    );
  }

  test("a successful search_datasets call records exactly one point", async () => {
    const res = await callTool("search_datasets", {});
    expect(res.status).toBe(200);
    expect(points.length).toBe(1);
    expect(points[0].indexes).toEqual(["search_datasets"]);
    expect(points[0].blobs?.[1]).toBe("-"); // search_datasets names no dataset id
    expect(points[0].doubles?.[0]).toBeGreaterThanOrEqual(0);
  });

  test("a describe_dataset call records the requested dataset_id", async () => {
    const res = await callTool("describe_dataset", { dataset_id: "nm500010" });
    expect(res.status).toBe(200);
    expect(points.length).toBe(1);
    expect(points[0].blobs?.[0]).toBe("describe_dataset");
    expect(points[0].blobs?.[1]).toBe("nm500010");
    expect(points[0].doubles?.[0]).toBeGreaterThanOrEqual(0);
  });

  test("an unknown-id describe_dataset call (isError: true) still records exactly one point, dataset_id included", async () => {
    const res = await callTool("describe_dataset", { dataset_id: "nm599999" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { isError?: boolean } };
    expect(body.result.isError).toBe(true);
    expect(points.length).toBe(1);
    expect(points[0].blobs?.[1]).toBe("nm599999");
    expect(points[0].doubles?.[0]).toBeGreaterThanOrEqual(0);
  });
});
