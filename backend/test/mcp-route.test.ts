/**
 * Real-route tests for the MCP sub-app (epic #1065 phase 2, issue #1294),
 * driven through `createMcpRoutes()` against a real bun:sqlite-backed D1 --
 * no mocks, and no hand-copied SQL. Mirrors `catalog-has-zarr.test.ts`'s
 * harness (`freshDb`/`realD1`, an `insertDataset` helper of the same shape).
 *
 * `ctx` is a minimal `ExecutionContext` fake (`waitUntil` collecting
 * promises, `passThroughOnException` a no-op) -- an infrastructure fake at
 * the runtime boundary (Hono's `c.executionCtx` getter throws when none is
 * supplied to `app.request()`), not a mock of business logic.
 *
 * A malformed `dataset_id` on `tools/call` was verified (against the real
 * `@modelcontextprotocol/server` package, not assumed) to surface as an
 * in-band tool result with `isError: true` -- the SDK's `registerTool` input
 * validation answers a normal `CallToolResult`, HTTP 200, not a JSON-RPC
 * protocol-level error the way the `Mcp-Name` mismatch below does. The plan
 * called this "a JSON-RPC validation error"; this test asserts the actual,
 * observed shape instead.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import {
  composeCitation,
  describeDatasetOutputSchema,
  searchDatasetsOutputSchema,
} from "../../shared/contract/mcp";
import { createMcpRoutes } from "../src/routes/mcp";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

type App = Hono<{ Bindings: Bindings }>;

/** Minimal `ExecutionContext` fake: an infrastructure fake at the runtime
 *  boundary (Hono's own context getter throws without one), not a mock of
 *  business logic -- nothing here stands in for a NEMAR service. */
const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function env(db: Database): Bindings {
  return {
    DB: realD1(db),
    // rateLimiter (mounted on every request by createMcpRoutes) hits the
    // real caches.default global under its non-"development" path; that
    // global doesn't exist under bun:test. "development" is rateLimiter's
    // own documented bypass.
    ENVIRONMENT: "development",
  } as unknown as Bindings;
}

/** Mirrors `catalog-has-zarr.test.ts`'s helper of the same name. */
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
    `INSERT INTO datasets (dataset_id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})`,
  ).run(datasetId, ...(keys.map((k) => merged[k]) as never[]));
}

function insertVersion(db: Database, datasetId: string, version: string, doi: string): void {
  db.query("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, ?, ?)").run(
    datasetId,
    version,
    doi,
  );
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

/** Both eras answer 200 for a successful call, but the legacy stateless
 *  fallback frames its body as a single SSE `event: message` chunk (proven
 *  against the real SDK) when the client sends
 *  `Accept: application/json, text/event-stream` -- decode either shape. */
async function parseBody(res: Response): Promise<JsonRpcResponse> {
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice("data:".length).trim() : text);
}

async function postModern(
  app: App,
  database: Bindings,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
): Promise<{ res: Response; body: JsonRpcResponse }> {
  const res = await app.request(
    "/mcp",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Mcp-Method": method, ...extraHeaders },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: { ...params, _meta: MODERN_META },
      }),
    },
    database,
    ctx,
  );
  return { res, body: await parseBody(res) };
}

async function callTool(
  app: App,
  database: Bindings,
  id: number,
  name: string,
  args: Record<string, unknown>,
  headerOverride?: string,
): Promise<{ res: Response; body: JsonRpcResponse }> {
  return postModern(
    app,
    database,
    id,
    "tools/call",
    { name, arguments: args },
    { "Mcp-Name": headerOverride ?? name },
  );
}

/** Unwrap a successful `tools/call` result into its `structuredContent`,
 *  throwing loudly (via bun:test's `expect`) when the call errored. */
function structuredContentOf(body: JsonRpcResponse): Record<string, unknown> {
  expect(body.error).toBeUndefined();
  const result = body.result as { isError?: boolean; structuredContent?: Record<string, unknown> };
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

const CONVERTED_ID = "nm500001";
const PENDING_ID = "nm500002";
const PRIVATE_ID = "nm500003";
const SANDBOX_ID = "xx500004";
const UNKNOWN_ID = "nm599999";
const COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("MCP sub-app: full protocol + tool surface (epic #1065 phase 2)", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = createMcpRoutes();

    insertDataset(db, CONVERTED_ID, {
      name: "Search Zarr Fixture Alpha",
      authors: "Ada Lovelace, Alan Turing",
      concept_doi: "10.5072/FK2fixture001",
      license: "CC-BY-4.0",
      modalities: "eeg",
      tasks: "rest",
      subject_count: 12,
      has_hed: 1,
      recording_count: 4,
      total_recording_duration: 800,
      zarr_status: "ready",
      zarr_store_count: 3,
      zarr_source_commit: COMMIT,
      created_at: "2025-05-01 00:00:00",
      sweep_stamps: JSON.stringify({
        zarr_verify_status: "verified",
        zarr_verified_at: "2025-05-02 00:00:00",
      }),
    });
    insertVersion(db, CONVERTED_ID, "1.2.0", "10.5072/FK2fixture001.v1");

    insertDataset(db, PENDING_ID, {
      name: "Search Zarr Fixture Beta",
      has_hed: 0,
      zarr_status: "pending",
      created_at: "2025-05-01 00:00:00",
    });

    insertDataset(db, PRIVATE_ID, {
      name: "Private Fixture",
      visibility: "private",
      zarr_status: "ready",
      zarr_store_count: 2,
    });

    insertDataset(db, SANDBOX_ID, {
      name: "Sandbox Fixture",
      is_sandbox: 1,
      zarr_status: "ready",
      zarr_store_count: 1,
    });
  });

  test("server/discover reports the 2026-07-28 revision", async () => {
    const { res, body } = await postModern(app, env(db), 1, "server/discover");
    expect(res.status).toBe(200);
    expect(body.result?.supportedVersions).toEqual(["2026-07-28"]);
  });

  test("tools/list returns exactly the two phase 2 tools, with the cache hint", async () => {
    const { res, body } = await postModern(app, env(db), 2, "tools/list");
    expect(res.status).toBe(200);
    const tools = body.result?.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name).sort()).toEqual(["describe_dataset", "search_datasets"]);
    expect(body.result?.ttlMs).toBe(86_400_000);
    expect(body.result?.cacheScope).toBe("public");
  });

  describe("search_datasets", () => {
    test("no arguments returns both public rows, never private or sandbox", async () => {
      const { res, body } = await callTool(app, env(db), 3, "search_datasets", {});
      expect(res.status).toBe(200);
      const output = structuredContentOf(body);
      searchDatasetsOutputSchema.parse(output);
      const results = output.results as Array<Record<string, unknown>>;
      expect(results.map((r) => r.dataset_id).sort()).toEqual([CONVERTED_ID, PENDING_ID]);
      expect(output.count).toBe(2);
      expect(output.limit).toBe(20);
      const converted = results.find((r) => r.dataset_id === CONVERTED_ID);
      const pending = results.find((r) => r.dataset_id === PENDING_ID);
      expect(converted?.has_zarr).toBe(true);
      expect(pending?.has_zarr).toBe(false);
      expect(typeof converted?.has_hed).toBe("boolean");
      expect(typeof pending?.has_hed).toBe("boolean");
    });

    test("has_zarr: true narrows to the one converted row", async () => {
      const { body } = await callTool(app, env(db), 4, "search_datasets", { has_zarr: true });
      const output = structuredContentOf(body);
      const results = output.results as Array<Record<string, unknown>>;
      expect(results.map((r) => r.dataset_id)).toEqual([CONVERTED_ID]);
      expect(output.count).toBe(1);
    });

    test("query matches the FTS hit and fills license from the follow-up query", async () => {
      const { body } = await callTool(app, env(db), 5, "search_datasets", { query: "Alpha" });
      const output = structuredContentOf(body);
      const results = output.results as Array<Record<string, unknown>>;
      expect(results.map((r) => r.dataset_id)).toEqual([CONVERTED_ID]);
      expect(results[0].license).toBe("CC-BY-4.0");
    });
  });

  describe("describe_dataset", () => {
    test("the converted row: citation, zarr_verify_status, zarr_source_commit, cost_hint", async () => {
      const { body } = await callTool(app, env(db), 6, "describe_dataset", {
        dataset_id: CONVERTED_ID,
      });
      const output = structuredContentOf(body);
      describeDatasetOutputSchema.parse(output);
      expect(output.citation).toBe(
        composeCitation({
          name: "Search Zarr Fixture Alpha",
          authors: "Ada Lovelace, Alan Turing",
          concept_doi: "10.5072/FK2fixture001",
          latest_version: "v1.2.0",
          created_at: "2025-05-01 00:00:00",
        }),
      );
      expect(output.zarr_verify_status).toBe("verified");
      expect(output.zarr_source_commit).toBe(COMMIT);
      expect(output.zarr_store_count).toBe(3);
      const costHint = output.cost_hint as { next_cheapest_tool: string; reason: string };
      expect(costHint.next_cheapest_tool).toBe("list_recordings");
      expect(costHint.reason).toContain("ready");
    });

    test("the pending row: cost_hint states pending", async () => {
      const { body } = await callTool(app, env(db), 7, "describe_dataset", {
        dataset_id: PENDING_ID,
      });
      const output = structuredContentOf(body);
      const costHint = output.cost_hint as { reason: string };
      expect(costHint.reason).toContain("pending");
    });

    test.each([
      ["a private dataset", PRIVATE_ID],
      ["a sandbox dataset", SANDBOX_ID],
      ["an unknown id", UNKNOWN_ID],
    ])("%s answers isError: true, naming search_datasets", async (_label, id) => {
      const { res, body } = await callTool(app, env(db), 8, "describe_dataset", { dataset_id: id });
      expect(res.status).toBe(200);
      const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("search_datasets");
    });

    test("a malformed dataset_id answers isError: true (SDK input-schema validation, not a JSON-RPC protocol error)", async () => {
      const { res, body } = await callTool(app, env(db), 9, "describe_dataset", {
        dataset_id: "not-an-id",
      });
      expect(res.status).toBe(200);
      const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0].text.toLowerCase()).toContain("dataset_id");
    });
  });

  test("a legacy initialize handshake plus a legacy tools/call describe_dataset both work", async () => {
    const acceptHeader = { Accept: "application/json, text/event-stream" };
    const initRes = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...acceptHeader },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 10,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "mcp-route.test.ts", version: "0.0.0" },
          },
        }),
      },
      env(db),
      ctx,
    );
    expect(initRes.status).toBe(200);
    const initBody = await parseBody(initRes);
    expect(initBody.result?.protocolVersion).toBe("2025-06-18");

    const callRes = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...acceptHeader },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: { name: "describe_dataset", arguments: { dataset_id: CONVERTED_ID } },
        }),
      },
      env(db),
      ctx,
    );
    expect(callRes.status).toBe(200);
    const callBody = await parseBody(callRes);
    const structured = structuredContentOf(callBody);
    expect(structured.dataset_id).toBe(CONVERTED_ID);
  });

  test("Mcp-Name mismatch yields HTTP 400 and JSON-RPC -32020", async () => {
    const { res, body } = await callTool(
      app,
      env(db),
      12,
      "describe_dataset",
      { dataset_id: CONVERTED_ID },
      "search_datasets",
    );
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe(-32020);
  });

  test("GET /mcp answers 405", async () => {
    const res = await app.request("/mcp", { method: "GET" }, env(db), ctx);
    expect(res.status).toBe(405);
  });

  test("GET / returns the descriptor with the endpoint built from the request origin", async () => {
    const res = await app.request("https://mcp-test.nemar.org/", {}, env(db), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; endpoint: string; protocol: string[] };
    expect(body.service).toBe("nemar-mcp");
    expect(body.endpoint).toBe("https://mcp-test.nemar.org/mcp");
    expect(body.protocol).toEqual(["2026-07-28", "legacy-stateless"]);
  });

  test("a POST with a disallowed Origin is 403", async () => {
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Mcp-Method": "server/discover",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 13,
          method: "server/discover",
          params: { _meta: MODERN_META },
        }),
      },
      env(db),
      ctx,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error?.code).toBe(-32000);
  });

  test("a POST with an allowed Origin succeeds with Access-Control-Allow-Origin set", async () => {
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Mcp-Method": "server/discover",
          Origin: "https://nemar.org",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 14,
          method: "server/discover",
          params: { _meta: MODERN_META },
        }),
      },
      env(db),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://nemar.org");
  });

  test("OPTIONS /mcp is 204 with the Mcp-* headers allowed", async () => {
    const res = await app.request(
      "/mcp",
      { method: "OPTIONS", headers: { Origin: "https://nemar.org" } },
      env(db),
      ctx,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe(
      "Content-Type, Accept, Mcp-Method, Mcp-Name, MCP-Protocol-Version",
    );
  });
});
