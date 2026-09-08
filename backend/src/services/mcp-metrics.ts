// MCP server per-tool-call metrics (epic #1065 phase 2, issue #1294).
//
// One Cloudflare Analytics Engine data point per `tools/call`, mirroring the
// existing `buildAccessDataPoint` shape (index + blobs + doubles;
// services/access-metrics.ts) rather than inventing a second convention --
// see .context/mcp-server-design.md section 8. A DEDICATED Analytics Engine
// dataset (ANALYTICS_MCP, not ANALYTICS) so blob positions never collide
// with buildAccessDataPoint's own (dataset_id, source, detail) shape.
//
// Write-only here, same as access-metrics.ts: a future dashboard reads the
// nemar_mcp_metrics dataset via the account-scoped Analytics Engine SQL API,
// not a binding.

import type { Bindings } from "../types/bindings";

/** One `tools/call` measurement. `datasetId` is `undefined`/null for a tool
 *  (or a call) with no single dataset in scope -- `search_datasets` names no
 *  dataset id, so its point's blob2 is always "-". `cacheStatus` is "none"
 *  for a tool call that never consults the projection cache at all -- both
 *  phase 2 tools (`search_datasets`, `describe_dataset`) always report
 *  "none": neither touches the phase 3 `list_recordings`/`get_events`
 *  projection cache section 7 describes. */
export interface McpToolCallEvent {
  tool: string;
  datasetId?: string | null;
  cacheStatus: "hit" | "miss" | "none";
  elapsedMs: number;
  upstreamBytes: number;
}

/**
 * Build the Analytics Engine data point for one `tools/call`. Pure (no I/O),
 * unit-testable without a live binding. Field ordering is the contract a
 * future read-side query depends on:
 *   indexes[0] = tool          (group/sample key)
 *   blob1      = tool
 *   blob2      = dataset_id (or "-" when the call named none)
 *   blob3      = cache_status
 *   double1    = elapsed_ms
 *   double2    = upstream_bytes
 */
export function buildMcpDataPoint(event: McpToolCallEvent): AnalyticsEngineDataPoint {
  return {
    indexes: [event.tool],
    blobs: [event.tool, event.datasetId ?? "-", event.cacheStatus],
    doubles: [event.elapsedMs, event.upstreamBytes],
  };
}

/**
 * Emit one MCP tool-call data point. No-op when the ANALYTICS_MCP binding is
 * absent (dev/test, or before provisioning). Never throws: telemetry must
 * not be able to break a tool response, success or error alike -- the point
 * is the measurement, not the success (see the route's `withToolMetrics`).
 */
export function recordMcpToolCall(
  env: Pick<Bindings, "ANALYTICS_MCP">,
  event: McpToolCallEvent,
): void {
  if (!env.ANALYTICS_MCP) return;
  try {
    env.ANALYTICS_MCP.writeDataPoint(buildMcpDataPoint(event));
  } catch (err) {
    console.error("[mcp-metrics] writeDataPoint failed:", err);
  }
}
