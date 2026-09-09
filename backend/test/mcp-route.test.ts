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
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import {
  composeCitation,
  describeDatasetOutputSchema,
  searchDatasetsOutputSchema,
} from "../../shared/contract/mcp";
import { __limits } from "../src/middleware/rateLimit";
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

  test("tools/list returns exactly the six phase 2+3+4 tools, with the cache hint", async () => {
    const { res, body } = await postModern(app, env(db), 2, "tools/list");
    expect(res.status).toBe(200);
    const tools = body.result?.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "describe_dataset",
      "get_events",
      "list_recordings",
      "read_window",
      "render_overview",
      "search_datasets",
    ]);
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
      // Explicit values, not just typeof -- CONVERTED_ID was inserted with
      // has_hed: 1, PENDING_ID with has_hed: 0 (PR #1323 review item G.15).
      expect(converted?.has_hed).toBe(true);
      expect(pending?.has_hed).toBe(false);
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
      // A dataset_versions row exists for CONVERTED_ID ("1.2.0" ->
      // canonicalized "v1.2.0"), so the citation carries a version segment
      // (PR #1323 review item G.14).
      expect(output.citation).toContain("(v1.2.0)");
      const costHint = output.cost_hint as { next_cheapest_tool: string; reason: string };
      expect(costHint.next_cheapest_tool).toBe("list_recordings");
      expect(costHint.reason).toContain("ready");
    });

    test("the pending row: cost_hint states pending, and the citation has no version segment", async () => {
      const { body } = await callTool(app, env(db), 7, "describe_dataset", {
        dataset_id: PENDING_ID,
      });
      const output = structuredContentOf(body);
      const costHint = output.cost_hint as { reason: string };
      expect(costHint.reason).toContain("pending");
      // No dataset_versions row exists for PENDING_ID, so composeCitation's
      // version segment is omitted entirely (PR #1323 review item G.14).
      expect(output.citation).not.toContain("(v");
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

// ---------------------------------------------------------------------------
// Rate limiter 429 carries the MCP CORS headers (PR #1323 review item G.12).
// The double-cast bridge in routes/mcp.ts hits rateLimiter's REAL,
// non-"development" code path, which reads the real caches.default global --
// absent under bun:test. This block installs a real in-memory CacheStorage
// stand-in for its own duration only, EXACTLY the technique
// zarr-data-cache.test.ts's "rate limiter exemption for redirect candidates"
// block uses (see that file's RateLimitCache, lines ~1873-1962), restored in
// afterAll so no other suite sharing this process (root `bun test` runs
// test/ and backend/test/ together) sees a stray global.
// ---------------------------------------------------------------------------

function keyFor(request: RequestInfo | URL): string {
  return request instanceof Request ? request.url : String(request);
}

class RateLimitCache implements Cache {
  private store = new Map<string, { body: string; headers: Record<string, string> }>();

  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    const entry = this.store.get(keyFor(req));
    return entry ? new Response(entry.body, { headers: entry.headers }) : undefined;
  }

  async put(req: RequestInfo | URL, res: Response): Promise<void> {
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    this.store.set(keyFor(req), { body: await res.text(), headers });
  }

  async delete(): Promise<boolean> {
    return false;
  }
  async add(): Promise<void> {
    throw new Error("not implemented");
  }
  async addAll(): Promise<void> {
    throw new Error("not implemented");
  }
  async keys(): Promise<readonly Request[]> {
    return [];
  }
  async matchAll(): Promise<readonly Response[]> {
    return [];
  }

  clear(): void {
    this.store.clear();
  }

  /** Seed a bucket directly at the real cap boundary, in the exact shape
   *  rateLimiter writes, mirroring zarr-data-cache.test.ts's identical
   *  helper -- lets this test prove enforcement AT the real MAX_REQUESTS cap
   *  without looping hundreds of real requests through the app. */
  seedCount(url: string, count: number): void {
    this.store.set(url, {
      body: JSON.stringify({ count }),
      headers: { "Cache-Control": `max-age=${__limits.WINDOW_SIZE}` },
    });
  }
}

describe("rate limiter 429 carries the MCP CORS headers (PR #1323 review item G.12)", () => {
  const rlCache = new RateLimitCache();
  // biome-ignore lint/suspicious/noExplicitAny: test-only runtime patch, mirrors zarr-data-cache.test.ts
  let originalCaches: any;

  beforeAll(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only runtime patch
    originalCaches = (globalThis as any).caches;
    // biome-ignore lint/suspicious/noExplicitAny: test-only runtime patch
    (globalThis as any).caches = { default: rlCache } as unknown as CacheStorage;
  });

  afterAll(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only runtime restore
    (globalThis as any).caches = originalCaches;
  });

  beforeEach(() => {
    rlCache.clear();
  });

  test("a POST past the ip bucket cap is 429 with Access-Control-Allow-Origin and the MCP Allow-Methods", async () => {
    const ip = "203.0.113.77";
    // /mcp matches none of AUTH_PATHS/DATA_PATH_RE/ZARR_PATH_RE and carries
    // no Authorization header, so it lands in the plain "ip" bucket
    // (__selectBucket's fallthrough), capped at MAX_REQUESTS.
    const key = `https://rate-limit.internal/rl:ip:${ip}`;
    rlCache.seedCount(key, __limits.MAX_REQUESTS);

    const db = freshDb();
    const app = createMcpRoutes();
    // ENVIRONMENT must NOT be "development" here -- that's rateLimiter's own
    // bypass, and this test exists specifically to exercise the real,
    // non-bypassed code path (mirrors zarr-data-cache.test.ts's rlEnv()).
    const prodEnv = { DB: realD1(db), ENVIRONMENT: "production" } as unknown as Bindings;

    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Mcp-Method": "server/discover",
          "CF-Connecting-IP": ip,
          Origin: "https://nemar.org",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: { _meta: MODERN_META },
        }),
      },
      prodEnv,
      ctx,
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://nemar.org");
    expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
  });
});

// ---------------------------------------------------------------------------
// search_datasets filter wiring on the no-query (catalog list) path (PR
// #1323 review item G.16). A self-contained fixture pair, independent of the
// shared outer describe block's fixtures, so each filter's narrowing is
// proven against a row that actually HAS a different value (not just a row
// with a NULL/unset column, which is a weaker proof of the filter working).
// ---------------------------------------------------------------------------

describe("search_datasets filter wiring on the no-query path (PR #1323 review item G.16)", () => {
  let db: Database;
  let app: App;
  const EEG_ID = "nm500020";
  const MEG_ID = "nm500021";

  beforeEach(() => {
    db = freshDb();
    app = createMcpRoutes();
    insertDataset(db, EEG_ID, {
      name: "Filter Wiring EEG Fixture",
      modalities: "eeg",
      tasks: "rest",
      has_hed: 1,
    });
    insertDataset(db, MEG_ID, {
      name: "Filter Wiring MEG Fixture",
      modalities: "meg",
      tasks: "faces",
      has_hed: 0,
    });
  });

  test("modality narrows to the matching row", async () => {
    const { body } = await callTool(app, env(db), 1, "search_datasets", { modality: "eeg" });
    const output = structuredContentOf(body);
    const results = output.results as Array<Record<string, unknown>>;
    expect(results.map((r) => r.dataset_id)).toEqual([EEG_ID]);
  });

  test("task narrows to the matching row", async () => {
    const { body } = await callTool(app, env(db), 2, "search_datasets", { task: "faces" });
    const output = structuredContentOf(body);
    const results = output.results as Array<Record<string, unknown>>;
    expect(results.map((r) => r.dataset_id)).toEqual([MEG_ID]);
  });

  test("has_hed narrows to the matching row", async () => {
    const { body } = await callTool(app, env(db), 3, "search_datasets", { has_hed: true });
    const output = structuredContentOf(body);
    const results = output.results as Array<Record<string, unknown>>;
    expect(results.map((r) => r.dataset_id)).toEqual([EEG_ID]);
  });
});

// ---------------------------------------------------------------------------
// search_datasets limit wiring on both paths (PR #1323 review item G.17).
// ---------------------------------------------------------------------------

describe("search_datasets limit wiring on both paths (PR #1323 review item G.17)", () => {
  let db: Database;
  let app: App;
  const ID_A = "nm500030";
  const ID_B = "nm500031";

  beforeEach(() => {
    db = freshDb();
    app = createMcpRoutes();
    insertDataset(db, ID_A, { name: "Limit Wiring Fixture Alpha" });
    insertDataset(db, ID_B, { name: "Limit Wiring Fixture Beta" });
  });

  test("no-query path: limit at the cap (100) echoes in output.limit and returns both rows", async () => {
    const { body } = await callTool(app, env(db), 1, "search_datasets", { limit: 100 });
    const output = structuredContentOf(body);
    expect(output.limit).toBe(100);
    expect((output.results as unknown[]).length).toBe(2);
  });

  test("no-query path: limit: 1 returns exactly one row, proving the LIMIT ? bind", async () => {
    const { body } = await callTool(app, env(db), 2, "search_datasets", { limit: 1 });
    const output = structuredContentOf(body);
    expect(output.limit).toBe(1);
    expect((output.results as unknown[]).length).toBe(1);
    // count is the total over the predicate, independent of the page size.
    expect(output.count).toBe(2);
  });

  test("query path: limit at the cap (100) echoes in output.limit", async () => {
    const { body } = await callTool(app, env(db), 3, "search_datasets", {
      query: "Limit Wiring Fixture",
      limit: 100,
    });
    const output = structuredContentOf(body);
    expect(output.limit).toBe(100);
    expect((output.results as unknown[]).length).toBe(2);
  });

  test("query path: limit: 1 returns one row", async () => {
    const { body } = await callTool(app, env(db), 4, "search_datasets", {
      query: "Limit Wiring Fixture",
      limit: 1,
    });
    const output = structuredContentOf(body);
    expect(output.limit).toBe(1);
    expect((output.results as unknown[]).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A count: 0 response is not an error (PR #1323 review item G.18).
// ---------------------------------------------------------------------------

describe("search_datasets: count 0 is not an error (PR #1323 review item G.18)", () => {
  let db: Database;
  let app: App;
  const ID = "nm500040";

  beforeEach(() => {
    db = freshDb();
    app = createMcpRoutes();
    insertDataset(db, ID, { name: "Count Zero Fixture", zarr_status: "pending" });
  });

  test("a non-matching query returns count 0 with no isError", async () => {
    const { res, body } = await callTool(app, env(db), 1, "search_datasets", {
      query: "totally-unrelated-nonsense-xyz",
    });
    expect(res.status).toBe(200);
    const result = body.result as { isError?: boolean };
    expect(result.isError).not.toBe(true);
    const output = structuredContentOf(body);
    expect(output.count).toBe(0);
    expect((output.results as unknown[]).length).toBe(0);
  });

  test("has_zarr: true with no converted fixture returns count 0 with no isError", async () => {
    const { res, body } = await callTool(app, env(db), 2, "search_datasets", { has_zarr: true });
    expect(res.status).toBe(200);
    const result = body.result as { isError?: boolean };
    expect(result.isError).not.toBe(true);
    const output = structuredContentOf(body);
    expect(output.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// zarr_status: "failed" on describe_dataset, and search_datasets' index-
// unavailable degradation (PR #1323 review item G.19).
// ---------------------------------------------------------------------------

describe("describe_dataset zarr_status failed; search_datasets index-unavailable (PR #1323 review item G.19)", () => {
  let db: Database;
  let app: App;
  const FAILED_ID = "nm500050";

  beforeEach(() => {
    db = freshDb();
    app = createMcpRoutes();
    insertDataset(db, FAILED_ID, { name: "Failed Conversion Fixture", zarr_status: "failed" });
  });

  test("describe_dataset reports zarr_status: failed, and the cost_hint reason names it", async () => {
    const { body } = await callTool(app, env(db), 1, "describe_dataset", {
      dataset_id: FAILED_ID,
    });
    const output = structuredContentOf(body);
    expect(output.zarr_status).toBe("failed");
    const costHint = output.cost_hint as { reason: string };
    expect(costHint.reason).toContain("failed");
  });

  test("search_datasets(query) answers isError when the FTS index is unavailable (datasets_fts dropped)", async () => {
    db.exec("DROP TABLE datasets_fts");
    const { res, body } = await callTool(app, env(db), 2, "search_datasets", { query: "anything" });
    expect(res.status).toBe(200);
    const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain("search index");
  });
});

// The taste caps live in `readWindowInputSchema`'s `superRefine`, and
// `mcp-schema-parity.test.ts` already proves the schema accepts 60 and rejects
// 61. What it cannot prove is what a CLIENT sees, and that is what
// `scripts/mcp/verify_streamable_http.py` asserts on when it verifies a live
// deploy: it requires the refusal text to name a cap. If the SDK ever reports a
// zod `custom` issue as a bare "Invalid arguments" without the message, that
// script starts failing against a perfectly healthy server, and the failure
// would look like a broken cap rather than a changed error format. This test is
// the wire-level half of that contract.
describe("read_window taste caps refuse over the wire, naming the cap (phase 5)", () => {
  let db: Database;
  let app: App;
  const ID = "nm500060";

  beforeEach(() => {
    db = freshDb();
    app = createMcpRoutes();
    insertDataset(db, ID, { name: "Taste Cap Fixture", zarr_status: "ready" });
  });

  test("one second past the duration_s cap is refused, and the text names the cap", async () => {
    // One channel keeps the 3840 channel-second product cap satisfied (61 x 1),
    // so `duration_s` is the ONLY cap crossed and the message can only be its.
    // This is refused by the input schema before the tool body runs, so it needs
    // no store, no index and no S3.
    const { res, body } = await callTool(app, env(db), 1, "read_window", {
      dataset_id: ID,
      recording: "sub-01/eeg/sub-01_task-x_eeg.zarr",
      group: "eeg",
      duration_s: 61,
      channels: [0],
      taste: true,
    });
    expect(res.status).toBe(200);
    const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const text = result.content.map((block) => block.text).join(" ");
    expect(text.toLowerCase()).toContain("cap");
    expect(text).toContain("duration_s");
    // The remedy travels with the refusal: a client that hits the cap should be
    // told what to do instead, not merely told no.
    expect(text).toContain("recipe");
  });

  test("at the cap (60) it is NOT refused for a cap reason", async () => {
    // The mirror of the above, and the reason the probe in the Python script
    // uses 61 rather than 60: every cap compares with `>`, so 60 is accepted by
    // the schema and any refusal here comes from the data path instead. Asserted
    // as "not a cap refusal" rather than "succeeds", because this fixture has no
    // store behind it.
    const { res, body } = await callTool(app, env(db), 2, "read_window", {
      dataset_id: ID,
      recording: "sub-01/eeg/sub-01_task-x_eeg.zarr",
      group: "eeg",
      duration_s: 60,
      channels: [0],
      taste: true,
    });
    expect(res.status).toBe(200);
    const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
    const text = result.content.map((block) => block.text).join(" ");
    expect(text).not.toContain("exceeds the 60 s cap");
  });
});
