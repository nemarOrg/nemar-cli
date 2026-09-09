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
import type { CacheLike } from "../routes/zarr-data.js";
import { recordMcpToolCall } from "../services/mcp-metrics.js";
import { GITHUB_RAW_ORIGIN } from "../services/zarr-fidelity-sweep.js";
import type { Bindings } from "../types/bindings.js";
import type { ZarrRoutesLike } from "./index-reader.js";
import {
  describeDatasetInputSchema4,
  describeDatasetOutputSchema4,
  getEventsInputSchema4,
  getEventsOutputSchema4,
  listRecordingsInputSchema4,
  listRecordingsOutputSchema4,
  readWindowInputSchema4,
  readWindowOutputSchema4,
  renderOverviewInputSchema4,
  renderOverviewOutputSchema4,
  searchDatasetsInputSchema4,
  searchDatasetsOutputSchema4,
} from "./schemas.js";
import type { RecordingToolDeps, ToolOutcome } from "./tool-types.js";
import { describeDatasetTool } from "./tools/describe-dataset.js";
import { getEventsTool } from "./tools/get-events.js";
import { listRecordingsTool } from "./tools/list-recordings.js";
import { readWindowTool } from "./tools/read-window.js";
import { renderOverviewTool } from "./tools/render-overview.js";
import { searchDatasetsTool } from "./tools/search-datasets.js";

/** What `createMcpHandler`'s factory is called with per request (routes/mcp.ts):
 *  `env` for the tools' D1/AI/Vectorize access and the metrics binding;
 *  `executionCtx`/`era` are accepted for parity with the SDK's own
 *  `McpRequestContext` shape.
 *
 *  `cache`/`fetch`/`zarrRoutes`/`rawGithubBase` (epic #1065 phase 3, issue
 *  #1295) are the recording-level tools' dependency seam:
 *  `cache` is a thunk (never a bare value) for the same reason
 *  `ZarrDataDeps.cache` in `routes/zarr-data.ts` is -- `caches.default` must
 *  be read lazily per request, since it does not exist outside a Worker
 *  (bun:test included). `zarrRoutes` defaults to the real `zarrDataRoutes`
 *  sub-app instance so `index.json` reads go through its D1 gate, edge
 *  cache, and purge list unchanged. `rawGithubBase` defaults to
 *  `GITHUB_RAW_ORIGIN` (`services/zarr-fidelity-sweep.ts`), the same
 *  content host that module's fidelity sweep already reads from. */
export interface BuildMcpServerDeps {
  env: Bindings;
  executionCtx: ExecutionContext;
  era: "legacy" | "modern";
  cache: () => CacheLike;
  fetch: typeof fetch;
  zarrRoutes: ZarrRoutesLike;
  rawGithubBase: string;
}

const INSTRUCTIONS = [
  "NEMAR (Neuroelectromagnetic Data Archive and Tools Resource) archives, describes, and serves",
  "EEG, MEG, iEEG, and related electrophysiology datasets in BIDS format.",
  "Start with search_datasets to find a dataset by keyword or facet, then describe_dataset for",
  "its metadata, license, DOI, citation, and Zarr conversion status. list_recordings, get_events,",
  "and render_overview describe a converted dataset's recordings, events, and a quick visual",
  "overview. read_window reads the actual signal: by default it returns a read recipe (zarr/S3",
  "coordinates, zero bytes touched); pass taste: true for a small, capped, inline-decoded window",
  "of physical values instead.",
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
      // Logged here, once, before the rethrow: the point below records the
      // MEASUREMENT (an exception happened), but says nothing about WHAT
      // failed -- an operator watching Analytics Engine alone has no error
      // message to go on. The transport's own error handling still gets
      // the unmodified error immediately after.
      console.error("[mcp] tool exception", { tool: toolName, datasetId }, err);
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

  // Bundled once per request for the three recording-level tools
  // (`RecordingToolDeps`, `tool-types.ts`) -- one shape so every tool reads
  // env/executionCtx/cache/fetch/zarrRoutes/rawGithubBase the same way.
  const recordingDeps: RecordingToolDeps = {
    env: deps.env,
    executionCtx: deps.executionCtx,
    cache: deps.cache,
    fetch: deps.fetch,
    zarrRoutes: deps.zarrRoutes,
    rawGithubBase: deps.rawGithubBase,
  };

  server.registerTool(
    "list_recordings",
    {
      title: "List recordings",
      description:
        "List a converted dataset's recordings (Zarr stores) with their channel groups. Parses " +
        "index.json once per (dataset, source_commit) and caches the result -- repeat calls are " +
        "cheap. A count of 0 is not an error -- an unrecognized modality value simply matches " +
        "nothing; the response note lists the dataset's actual modality vocabulary when that " +
        "happens. A dataset that has not finished converting answers a tool error naming its " +
        "actual zarr_status, never an empty list.",
      inputSchema: listRecordingsInputSchema4,
      outputSchema: listRecordingsOutputSchema4,
    },
    withToolMetrics(
      deps.env,
      "list_recordings",
      (args) => args.dataset_id,
      (args) => listRecordingsTool(recordingDeps, args),
    ),
  );

  server.registerTool(
    "get_events",
    {
      title: "Get events",
      description:
        "Get one recording's BIDS events (onset, duration, trial_type, value, HED, sample_index). " +
        "Reads events.parquet when the dataset has one (exact sample_index); otherwise falls back " +
        "to the recording's sibling events.tsv and flags the result estimated.",
      inputSchema: getEventsInputSchema4,
      outputSchema: getEventsOutputSchema4,
    },
    withToolMetrics(
      deps.env,
      "get_events",
      (args) => args.dataset_id,
      (args) => getEventsTool(recordingDeps, args),
    ),
  );

  server.registerTool(
    "render_overview",
    {
      title: "Render overview",
      description:
        "Render a quick min-max envelope image of one recording's channel group, from the " +
        "pre-computed view/* pyramid (never level 0). Cheap by construction: kilobytes read, " +
        "one PNG returned, cached per (dataset, source_commit, recording, group, width_px).",
      inputSchema: renderOverviewInputSchema4,
      outputSchema: renderOverviewOutputSchema4,
    },
    withToolMetrics(
      deps.env,
      "render_overview",
      (args) => args.dataset_id,
      (args) => renderOverviewTool(recordingDeps, args),
    ),
  );

  server.registerTool(
    "read_window",
    {
      title: "Read window",
      description:
        "Read a window of one recording's actual signal. By default (taste: false) returns a " +
        "read recipe -- zarr/zarrita/S3 coordinates and how-to snippets -- with zero signal bytes " +
        "touched. Pass taste: true (and channels, required) for a small, capped, inline-decoded " +
        "window of physical values instead: at most 60 s, 64 channels, and 65,536 channel-samples " +
        "(channels x samples) -- ask for fewer channels or a shorter window, or omit taste, past " +
        "that. Needs a v3-format-converted dataset; a dataset still on index format v1 answers a " +
        "typed error (list_recordings and get_events still work on it).",
      inputSchema: readWindowInputSchema4,
      outputSchema: readWindowOutputSchema4,
    },
    withToolMetrics(
      deps.env,
      "read_window",
      (args) => args.dataset_id,
      (args) => readWindowTool(recordingDeps, args),
    ),
  );

  return server;
}
