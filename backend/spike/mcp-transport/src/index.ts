/**
 * Streamable HTTP entry point (issue #1293 spike), wired exactly as the
 * phase 1 plan's verified facts prescribe, from the SDK's own
 * `examples/hono/server.ts`:
 *
 *   const handler = createMcpHandler(buildServer);
 *   const app = createMcpHonoApp();
 *   app.all('/mcp', c => handler.fetch(c.req.raw));
 *
 * `createMcpHandler`'s default `legacy: 'stateless'` serves both the
 * 2026-07-28 envelope and a plain 2025-era `initialize` handshake from this
 * one route -- see smoke.sh for both legs.
 */

import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildServer } from "./server.js";

const handler = createMcpHandler(buildServer);
// `createMcpHonoApp()` arms localhost host/origin validation by default,
// which is what we want here: `wrangler dev` serves on 127.0.0.1, and
// smoke.sh's curl calls carry no Origin header (a non-browser client), so
// the DNS-rebinding/origin checks pass through unaffected.
const app = createMcpHonoApp();
app.get("/", (c) => c.json({ service: "mcp-transport-spike", mount: "/mcp" }));
app.all("/mcp", (c) => handler.fetch(c.req.raw));

export default app;
