/**
 * mcp.nemar.org: the NEMAR MCP server (epic #1065 phase 2, issue #1294;
 * ADR 0049; `.context/mcp-server-design.md`).
 *
 * A self-contained sub-app, modeled on `createZarrDataRoutes`
 * (`backend/src/routes/zarr-data.ts`): its own origin gate and rate-limit
 * bridge rather than the api middleware stack (the global `cors()` in
 * `index.ts` allows `*.nemar.org` broadly; this host scopes CORS to the
 * MCP-specific headers the Streamable HTTP transport needs). Two routes:
 *
 *  - `GET /`: a small JSON descriptor, so a bare `mcp.nemar.org/` (or
 *    `mcp-test.nemar.org/`) doesn't 404 confusingly and a client can learn
 *    its own canonical endpoint from the request origin it actually hit.
 *  - `/mcp`: the Streamable HTTP transport endpoint (`POST`/`OPTIONS`; `GET`/
 *    `DELETE` answer 405 -- the SDK's own dual-era `legacy: 'stateless'`
 *    posture, see design doc section 2.1). Built with `createMcpHandler`
 *    PER REQUEST, because the factory `createMcpHandler` takes
 *    (`buildMcpServer`, `backend/src/mcp/server.ts`) has no other way to see
 *    `env` -- the tool definitions and zod schemas themselves are module
 *    scope and constructed once (design doc section 7).
 *
 * Mounted on the `mcp` host fork in `index.ts` and path-mounted at `/mcp` on
 * the api host for workers.dev/dev access (decision 2): the SAME code
 * serves both entry points, but the path mount forwards only the exact
 * `/mcp` path, so the descriptor at `/` is reachable only via the host fork
 * (`mcp.nemar.org` / `mcp-test.nemar.org`), not the workers.dev fallback.
 */

import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Context } from "hono";
import { Hono } from "hono";
import { buildMcpServer } from "../mcp/server.js";
import { rateLimiter } from "../middleware/rateLimit.js";
import type { Bindings } from "../types/bindings.js";
import { allowedOrigin, corsHeaders } from "./zarr-data.js";

/** Test/DI seam (matching `ZarrDataDeps`'s precedent): `onerror` is the one
 *  piece of injectable behavior `createMcpHandler` itself exposes. Defaults
 *  to a `[mcp]`-prefixed console.error, logged once per out-of-band error or
 *  rejected request (never altering the response -- the SDK reports these
 *  for observability only). */
export interface McpRoutesDeps {
  onerror: (error: Error) => void;
}

const defaultDeps: McpRoutesDeps = {
  onerror: (error) => console.error("[mcp] transport error", error),
};

/** JSON-RPC `-32000` error body for a request whose `Origin` header is
 *  present but not on the NEMAR allowlist -- mirrors the shape the SDK's own
 *  origin-validation middleware would answer with (design doc section 3),
 *  since this sub-app validates Origin itself rather than delegating to the
 *  SDK's framework adapter (decision: no `@modelcontextprotocol/hono`, this
 *  server lives inside the existing single worker behind `resolveHostRoute`,
 *  not a standalone app with its own DNS-rebinding checks). `id: null`: the
 *  gate runs before the JSON-RPC body is parsed, so no request id is known. */
function originRejectedResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Origin not allowed" },
    }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );
}

/** Build the mcp.nemar.org sub-app. `deps` is the test/DI seam above;
 *  defaults to the real onerror logger so `index.ts` (which imports the
 *  plain `mcpRoutes` export below) is untouched. */
export function createMcpRoutes(deps: McpRoutesDeps = defaultDeps): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();

  // Any uncaught throw from a handler lands here instead of a bare,
  // CORS-less Workers 500 -- same rationale as zarr-data.ts's app.onError.
  app.onError((err, c) => {
    console.error("[mcp] unhandled", { path: c.req.path }, err);
    return c.body(null, 500, corsHeaders(c.req.header("origin") ?? null));
  });

  // Rate limiter: the same double-cast bridge and OPTIONS exemption
  // zarr-data.ts's own "*" middleware uses (see that file's comment block
  // for the full rationale) -- this sub-app dispatches straight from the
  // host fork in index.ts, bypassing the api middleware stack (and its
  // rate limiter) the same way the zarr sub-app does. No redirect/observe-only
  // concept here (MCP has none), so this is the bridge alone: default
  // buckets, so an anonymous caller lands in `ip`.
  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    // SAFETY: see zarr-data.ts's identical cast for the full justification --
    // rateLimiter only touches c.env, c.req, and c.json, all present on any
    // Hono context regardless of the static Variables generic.
    const res = await rateLimiter(c as unknown as Parameters<typeof rateLimiter>[0], next);
    if (res && res.status === 429) {
      for (const [k, v] of Object.entries(corsHeaders(c.req.header("origin") ?? null))) {
        res.headers.set(k, v);
      }
    }
    return res;
  });

  // Origin gate: a request WITH an Origin header that allowedOrigin()
  // (zarr-data.ts) does not accept is rejected outright, mirroring the
  // SDK's own origin-validation middleware (design doc section 3) -- this
  // server never mounts @modelcontextprotocol/hono's createMcpHonoApp, so
  // that validation has to live here instead. A request with NO Origin
  // header (every non-browser client: `mcp` PyPI, Claude Code, curl, an
  // HPC job) passes through untouched. OPTIONS is exempt -- the preflight
  // itself always succeeds (app.options("/mcp", ...) below), same as
  // zarr-data.ts's own OPTIONS-before-CORS-check pattern; only the
  // browser's own missing-ACAO check blocks a disallowed origin's actual
  // request.
  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const origin = c.req.header("origin") ?? null;
    if (origin && !allowedOrigin(origin)) return originRejectedResponse();
    return next();
  });

  // Small JSON descriptor so a bare mcp.nemar.org/ (or mcp-test.nemar.org/)
  // doesn't 404 confusingly. `endpoint` is derived from the request's own
  // origin, not hardcoded, so mcp-test.nemar.org describes ITSELF as the
  // endpoint rather than advertising the prod host.
  app.get("/", (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json({
      service: "nemar-mcp",
      endpoint: `${origin}/mcp`,
      protocol: ["2026-07-28", "legacy-stateless"],
      docs: "https://docs.nemar.org",
    });
  });

  // Preflight: registered BEFORE app.all("/mcp", ...) below so it matches
  // first. Always 204 regardless of Origin (same as zarr-data.ts's OPTIONS
  // handler) -- a disallowed origin gets no Access-Control-Allow-Origin, so
  // the BROWSER blocks the follow-up request; the preflight itself is never
  // the thing that fails. Headers/methods here are MCP's own (Streamable
  // HTTP's Mcp-Method/Mcp-Name/MCP-Protocol-Version, POST/OPTIONS only), not
  // zarr's Range/GET/HEAD set -- corsHeaders(origin) supplies the shared
  // Vary/Expose-Headers/Max-Age/Allow-Origin fields, overridden here for the
  // two that differ per transport.
  app.options("/mcp", (c) => {
    const origin = c.req.header("origin") ?? null;
    const headers = {
      ...corsHeaders(origin),
      "Access-Control-Allow-Headers":
        "Content-Type, Accept, Mcp-Method, Mcp-Name, MCP-Protocol-Version",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
    return c.body(null, 204, headers);
  });

  // The Streamable HTTP transport endpoint. A fresh createMcpHandler per
  // request: the factory (buildMcpServer) is the only way it can see `env`.
  // GET/DELETE answer 405 via the SDK's own default legacy: 'stateless'
  // posture (design doc section 2.1) -- no branching needed here for that.
  app.all("/mcp", async (c: Context<{ Bindings: Bindings }>) => {
    const origin = c.req.header("origin") ?? null;
    const handler = createMcpHandler(
      (ctx) => buildMcpServer({ env: c.env, executionCtx: c.executionCtx, era: ctx.era }),
      { onerror: deps.onerror },
    );
    const response = await handler.fetch(c.req.raw);
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  });

  return app;
}

export const mcpRoutes = createMcpRoutes();
