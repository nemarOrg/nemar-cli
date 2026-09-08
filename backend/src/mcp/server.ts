/**
 * The NEMAR MCP server instance (epic #1065 phase 2, issue #1294).
 *
 * `buildMcpServer` is the factory `createMcpHandler` (routes/mcp.ts) calls
 * once per request -- the SDK's per-request-factory model, since the factory
 * is the only way it can see `env` (design doc section 2, and
 * `.context/mcp-server-design.md` section 7's "the tool registry is
 * module-scope" rule: only the transport and the `McpServer` instance are
 * per-request; the zod schemas and every static lookup table below are
 * constructed once at module load and reused).
 *
 * Every tool callback is wrapped in `withToolMetrics`, which times the call
 * and writes exactly one Analytics Engine point per invocation -- on the
 * success path AND the error path (a thrown exception, or a returned
 * `isError: true` result): the point is the measurement, not the success.
 */

import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import pkg from "../../../package.json" with { type: "json" };
import { recordMcpToolCall } from "../services/mcp-metrics.js";
import type { Bindings } from "../types/bindings.js";
import {
  describeDatasetInputSchema4,
  describeDatasetOutputSchema4,
  searchDatasetsInputSchema4,
  searchDatasetsOutputSchema4,
} from "./schemas.js";
import { describeDatasetTool } from "./tools/describe-dataset.js";
import { searchDatasetsTool } from "./tools/search-datasets.js";

/** What `createMcpHandler`'s factory is called with per request (routes/mcp.ts):
 *  `env` for the tools' D1/AI/Vectorize access and the metrics binding;
 *  `executionCtx`/`era` are accepted for parity with the SDK's own
 *  `McpRequestContext` shape (not used by phase 2's two tools, neither of
 *  which defers work past the response or varies by protocol era). */
export interface BuildMcpServerDeps {
  env: Bindings;
  executionCtx: ExecutionContext;
  era: "legacy" | "modern";
}

const INSTRUCTIONS = [
  "NEMAR (Neuroelectromagnetic Data Archive and Tools Resource) archives, describes, and serves",
  "EEG, MEG, iEEG, and related electrophysiology datasets in BIDS format.",
  "Start with search_datasets to find a dataset by keyword or facet, then describe_dataset for",
  "its metadata, license, DOI, citation, and Zarr conversion status.",
  "Recording-level tools (list_recordings, get_events, render_overview, read_window) arrive in",
  "later phases of this server.",
].join(" ");

/** Times `fn`, writes one metrics point per call (success or error -- a
 *  thrown exception re-throws AFTER the point is written; a returned
 *  `isError: true` result records normally, since it is a successful
 *  RETURN as far as this wrapper is concerned), and unwraps `fn`'s
 *  `{ result, datasetId }` outcome to the bare `CallToolResult`
 *  `registerTool` expects. `cache_status` is "none" for every phase 2
 *  tool: neither `search_datasets` nor `describe_dataset` touches the
 *  phase 3 `list_recordings`/`get_events` projection cache (design doc
 *  section 7); `upstream_bytes` is 0 for the same reason -- both tools
 *  read D1 only, never a store byte. */
function withToolMetrics<Args>(
  env: Bindings,
  toolName: string,
  fn: (args: Args) => Promise<{ result: CallToolResult; datasetId?: string | null }>,
): (args: Args) => Promise<CallToolResult> {
  return async (args: Args): Promise<CallToolResult> => {
    const start = performance.now();
    let datasetId: string | null | undefined;
    try {
      const outcome = await fn(args);
      datasetId = outcome.datasetId;
      return outcome.result;
    } finally {
      recordMcpToolCall(env, {
        tool: toolName,
        datasetId: datasetId ?? null,
        cacheStatus: "none",
        elapsedMs: performance.now() - start,
        upstreamBytes: 0,
      });
    }
  };
}

export function buildMcpServer(deps: BuildMcpServerDeps): McpServer {
  const server = new McpServer(
    { name: "nemar", version: pkg.version },
    {
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
      // 24h: the tool registry is fixed at deploy time (design doc section
      // 2.2), so there is no reason for a client to re-fetch tools/list or
      // re-probe server/discover inside a day.
      cacheHints: {
        "tools/list": { ttlMs: 86_400_000, cacheScope: "public" },
        "server/discover": { ttlMs: 86_400_000, cacheScope: "public" },
      },
    },
  );

  server.registerTool(
    "search_datasets",
    {
      title: "Search datasets",
      description:
        "Search or browse the public NEMAR dataset catalog by keyword, modality, task, HED " +
        "presence, or Zarr conversion status. A count of 0 is not an error -- an unrecognized " +
        "modality/task value simply matches nothing; call describe_dataset on a hit to see the " +
        "catalog's actual vocabulary for that dataset.",
      inputSchema: searchDatasetsInputSchema4,
      outputSchema: searchDatasetsOutputSchema4,
    },
    withToolMetrics(deps.env, "search_datasets", (args) => searchDatasetsTool(deps.env, args)),
  );

  server.registerTool(
    "describe_dataset",
    {
      title: "Describe dataset",
      description:
        "Get a dataset's descriptive metadata (name, DOI, license, citation, modalities, " +
        "tasks, subject count, HED and Zarr status) plus a cost_hint naming the cheapest next " +
        "tool to call. Never reads index.json -- the largest index in the catalog is 12.8 MB.",
      inputSchema: describeDatasetInputSchema4,
      outputSchema: describeDatasetOutputSchema4,
    },
    withToolMetrics(deps.env, "describe_dataset", (args) => describeDatasetTool(deps.env, args)),
  );

  return server;
}
