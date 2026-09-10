/**
 * Worker-entry fork test for the `mcp` host route (epic #1065 phase 2,
 * issue #1294) -- drives the worker the way Cloudflare does, the same
 * approach `cron-dev-safety.test.ts` uses for the sandbox-cleanup queries.
 *
 * `backend/src/index.ts` exports only `default { fetch, scheduled }` (the
 * Hono `app` is a module-local const; `cron-dev-safety.test.ts` already
 * establishes the precedent of importing named SQL constants rather than
 * `app` itself), so this imports the default export and calls
 * `worker.fetch(request, env, ctx)` directly, exactly as `wrangler`/workerd
 * would. `ctx` is a minimal `ExecutionContext` fake (`waitUntil` collecting
 * promises, `passThroughOnException` a no-op) -- an infrastructure fake at
 * the runtime boundary, not a mock of business logic.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import worker from "../src/index";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function env(db: Database, extra: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    // rateLimiter runs inside the api middleware stack on the "api" route,
    // and mcpRoutes carries its own rateLimiter mount too -- bypass both the
    // same way every other route-level test does (see rateLimit.ts's own
    // documented "development" bypass); caches.default doesn't exist under
    // bun:test.
    ENVIRONMENT: "development",
    ...extra,
  } as unknown as Bindings;
}

describe("mcp host fork (epic #1065 phase 2)", () => {
  let db: Database;

  test("https://mcp.nemar.org/ resolves to the mcp sub-app's descriptor", async () => {
    db = freshDb();
    const res = await worker.fetch(new Request("https://mcp.nemar.org/"), env(db), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; endpoint: string };
    expect(body.service).toBe("nemar-mcp");
    expect(body.endpoint).toBe("https://mcp.nemar.org/mcp");
  });

  test("the MCP_HOSTNAME override (mcp-test.nemar.org) also resolves to the mcp sub-app", async () => {
    db = freshDb();
    const res = await worker.fetch(
      new Request("https://mcp-test.nemar.org/"),
      env(db, { MCP_HOSTNAME: "mcp-test.nemar.org" }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; endpoint: string };
    expect(body.service).toBe("nemar-mcp");
    expect(body.endpoint).toBe("https://mcp-test.nemar.org/mcp");
  });

  test("the api host reaches the mcp handler through the /mcp path mount", async () => {
    db = freshDb();
    // GET is disallowed on the Streamable HTTP transport endpoint (the SDK's
    // own dual-era 405 posture) -- this also proves the path mount reaches
    // the real mcp handler rather than falling through to the api app's own
    // 404, which would answer a JSON body, not a bare 405.
    const res = await worker.fetch(new Request("https://api.nemar.org/mcp"), env(db), ctx);
    expect(res.status).toBe(405);
  });
});
