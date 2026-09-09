/**
 * Hostname -> sub-app fork decision for the single worker (epic #923; the
 * `mcp` arm added epic #1065 phase 2).
 *
 * The one worker answers on the api host, the data host, the zarr host, and
 * the mcp host. In production those are api/data/zarr/mcp.nemar.org; the
 * staging worker adds the data-test/zarr-test/mcp-test.nemar.org mirrors via
 * env vars. Kept pure (no I/O, no Hono context) so the fork table is
 * unit-testable without instantiating the whole worker.
 *
 * The caller passes the hostname parsed from `c.req.url` (NOT the Host header),
 * so a forged `Host:` can't steer an api-host request into the data/zarr/mcp
 * forks.
 */

import type { Bindings } from "../types/bindings.js";

export type HostRoute = "data" | "zarr" | "mcp" | "api";

export function resolveHostRoute(
  hostname: string,
  env: Pick<Bindings, "DATA_HOSTNAME" | "ZARR_HOSTNAME" | "MCP_HOSTNAME">,
): HostRoute {
  const host = hostname.toLowerCase();
  const dataHost = (env.DATA_HOSTNAME || "data.nemar.org").toLowerCase();
  const zarrHost = (env.ZARR_HOSTNAME || "zarr.nemar.org").toLowerCase();
  const mcpHost = (env.MCP_HOSTNAME || "mcp.nemar.org").toLowerCase();
  if (host === dataHost) return "data";
  if (host === zarrHost) return "zarr";
  if (host === mcpHost) return "mcp";
  return "api";
}
