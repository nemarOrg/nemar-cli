/**
 * Shared tool-outcome shape for the registered MCP tools (epic #1065 phase
 * 2, issue #1294; PR #1323 review item E.9).
 *
 * A tool callback returns this instead of a bare `CallToolResult` so
 * `withToolMetrics` (`server.ts`) can read the optional `metrics` facts
 * without special-casing per tool. The dataset id for the metrics point
 * does NOT travel through this type: `withToolMetrics` reads it from the
 * REQUEST ARGS via its own `getDatasetId` callback, captured BEFORE the
 * tool runs, so a thrown D1 error is still attributed to the right
 * dataset -- a value the tool's own (possibly never-reached) return could
 * not supply. Lives in its own module, not `server.ts`, so a tool file can
 * import the type without a `tools/*.ts` <-> `server.ts` import cycle.
 */

import type { CallToolResult } from "@modelcontextprotocol/server";
import type { CacheLike } from "../routes/zarr-data.js";
import type { Bindings } from "../types/bindings.js";
import type { ZarrRoutesLike } from "./index-reader.js";

export interface ToolOutcome {
  result: CallToolResult;
  /** Optional cache/byte facts for the metrics point. Both default inside
   *  `withToolMetrics` ("none" / 0) when a tool has nothing to report --
   *  true of both phase 2 tools, which read D1 only and never touch the
   *  phase 3 projection cache or a store byte. */
  metrics?: {
    cacheStatus?: "hit" | "miss" | "none";
    upstreamBytes?: number;
  };
}

/**
 * Shared dependency bundle for the three recording-level tools (epic #1065
 * phase 3, issue #1295; plan decision 9). One shape so `server.ts` builds it
 * once per request and every tool reads the same fields the same way,
 * rather than each tool inventing its own subset.
 *
 *  - `env`/`executionCtx`: the same per-request values `BuildMcpServerDeps`
 *    already carries (`server.ts`).
 *  - `cache`: a thunk (never a bare value), matching `ZarrDataDeps.cache` in
 *    `routes/zarr-data.ts` -- `caches.default` must be read lazily per
 *    request, not at module load, since it does not exist outside a Worker
 *    (bun:test included).
 *  - `fetch`: the upstream fetch used for `events.parquet` (hyparquet's
 *    `asyncBufferFromUrl`), the `events.tsv` fallback, and the `view/*`
 *    pyramid chunks -- injectable so tests point it at a local fixture
 *    server instead of the real network.
 *  - `zarrRoutes`: the real zarr sub-app instance (`index-reader.ts`'s
 *    `ZarrRoutesLike`), so `index.json` reads go through its D1 gate, edge
 *    cache, and purge list unchanged.
 *  - `rawGithubBase`: `https://raw.githubusercontent.com` by default (the
 *    `GITHUB_RAW_ORIGIN` `zarr-fidelity-sweep.ts` already uses) -- the
 *    `get_events` `events.tsv` fallback's content host.
 */
export interface RecordingToolDeps {
  env: Bindings;
  executionCtx: ExecutionContext;
  cache: () => CacheLike;
  fetch: typeof fetch;
  zarrRoutes: ZarrRoutesLike;
  rawGithubBase: string;
}
