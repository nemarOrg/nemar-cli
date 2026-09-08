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
import type { McpToolName } from "../../../shared/contract/mcp.js";
import { recordMcpToolCall } from "../services/mcp-metrics.js";
import type { Bindings } from "../types/bindings.js";
import {
  describeDatasetInputSchema4,
  describeDatasetOutputSchema4,
  searchDatasetsInputSchema4,
  searchDatasetsOutputSchema4,
} from "./schemas.js";
import type { ToolOutcome } from "./tool-types.js";
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

/**
 * Times `fn`, writes exactly one metrics point per call, and unwraps `fn`'s
 * {@link ToolOutcome} to the bare `CallToolResult` `registerTool` expects.
 *
 * `getDatasetId(args)` is called BEFORE `fn`, not derived from `fn`'s
 * return -- so a thrown error (a D1 query failure, say) still attributes
 * the metrics point to the right dataset instead of recording `"-"`
 * because the tool never got far enough to report one itself.
 *
 * `outcome` distinguishes three finishes: `"ok"` (a normal result),
 * `"tool_error"` (`result.isError: true` -- a business-logic error the
 * tool handled, e.g. an unknown dataset id), and `"exception"` (`fn`
 * threw; the point is written and then the error is RETHROWN unchanged,
 * so the transport's own error handling is unaffected by this wrapper).
 * `cache_status`/`upstream_bytes` come from `fn`'s optional
 * `outcome.metrics`, defaulting to `"none"`/`0` when absent -- true of
 * both phase 2 tools, which read D1 only and never touch the phase 3
 * projection cache or a store byte.
 */
function withToolMetrics<Args>(
  env: Bindings,
  toolName: McpToolName,
  getDatasetId: (args: Args) => string | null | undefined,
  fn: (args: Args) => Promise<ToolOutcome>,
): (args: Args) => Promise<CallToolResult> {
  return async (args: Args): Promise<CallToolResult> => {
    const datasetId = getDatasetId(args) ?? null;
    const start = performance.now();
    try {
      const outcome = await fn(args);
      recordMcpToolCall(env, {
        tool: toolName,
        datasetId,
        cacheStatus: outcome.metrics?.cacheStatus ?? "none",
        elapsedMs: performance.now() - start,
        upstreamBytes: outcome.metrics?.upstreamBytes ?? 0,
        outcome: outcome.result.isError ? "tool_error" : "ok",
      });
      return outcome.result;
    } catch (err) {
      recordMcpToolCall(env, {
        tool: toolName,
        datasetId,
        cacheStatus: "none",
        elapsedMs: performance.now() - start,
        upstreamBytes: 0,
        outcome: "exception",
      });
      throw err;
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
    withToolMetrics(
      deps.env,
      "search_datasets",
      // search_datasets names no single dataset id.
      () => undefined,
      (args) => searchDatasetsTool(deps.env, args),
    ),
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
    withToolMetrics(
      deps.env,
      "describe_dataset",
      (args) => args.dataset_id,
      (args) => describeDatasetTool(deps.env, args),
    ),
  );

  return server;
}
