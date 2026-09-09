/**
 * Minimal Worker entry for the MCP smoke script (epic #1065 phase 2, issue
 * #1294; issue #1324).
 *
 * `wrangler dev --local` cannot start `backend/src/index.ts` in this
 * environment: that entry module also exports two plain string constants
 * (`NON_PROD_SANDBOX_CLEANUP_QUERY`, `PROD_SANDBOX_CLEANUP_QUERY`, pre-dating
 * this phase -- epic #923's cron-safety work) alongside the default
 * handler, and the local workerd runtime used here rejects any named export
 * that is not a function or `ExportedHandler`
 * (`Uncaught TypeError: Incorrect type for map entry '...': the provided
 * value is not of type 'function or ExportedHandler'`). Filed as #1324;
 * fixing `index.ts`'s export shape is out of this phase's scope.
 *
 * This entry re-exports ONLY the mcp sub-app's `fetch`, so the smoke
 * script can exercise the real MCP transport under real workerd without
 * that unrelated blocker. It is deliberately not `main` in any real
 * `wrangler-sccn.toml` environment -- see `mcp-smoke.wrangler.toml`, this
 * script's own throwaway config, for the bindings it declares (a local-only
 * `DB`, `ENVIRONMENT=development`, nothing else).
 */

import { mcpRoutes } from "../src/routes/mcp.js";
import type { Bindings } from "../src/types/bindings.js";

export default {
  fetch: (request: Request, env: Bindings, ctx: ExecutionContext) =>
    mcpRoutes.fetch(request, env, ctx),
};
