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
