/**
 * Test-only helpers: fake GitHub server + request counter.
 *
 * Counts requests bucketed by method + URL path, so tests can assert "exactly
 * 4 calls were made" or "no calls hit /git/trees". Not a mock of `fetch` — the
 * real fetch path runs against a local Bun.serve HTTP server.
 */

import type { Server } from "bun";

export interface RecordedCall {
  method: string;
  path: string;
}

export interface FakeGithubHandlers {
  /**
   * For each request, look up by `${METHOD} ${path}` (path without query string).
   * Return a Response or undefined; undefined means 404 with empty body.
   * Handlers can be stateful (use captured variables) for the 422-retry test.
   */
  [methodPath: string]: (req: Request) => Promise<Response> | Response;
}

export interface FakeGithubServer {
  server: Server;
  url: string;
  port: number;
  calls: RecordedCall[];
  countByPath: Record<string, number>;
  countByMethodPath: Record<string, number>;
  reset(): void;
  stop(): void;
}

export function startFakeGithub(handlers: FakeGithubHandlers): FakeGithubServer {
  const state: Pick<FakeGithubServer, "calls" | "countByPath" | "countByMethodPath"> = {
    calls: [],
    countByPath: {},
    countByMethodPath: {},
  };

  const server = Bun.serve({
    port: 0,
    async fetch(req: Request) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method.toUpperCase();
      const methodPath = `${method} ${path}`;
      state.calls.push({ method, path });
      state.countByPath[path] = (state.countByPath[path] ?? 0) + 1;
      state.countByMethodPath[methodPath] = (state.countByMethodPath[methodPath] ?? 0) + 1;

      const handler = handlers[methodPath];
      if (!handler) {
        return new Response(JSON.stringify({ message: `no fake handler for ${methodPath}` }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return handler(req);
    },
  });

  return {
    server,
    url: `http://localhost:${server.port}`,
    port: server.port,
    calls: state.calls,
    countByPath: state.countByPath,
    countByMethodPath: state.countByMethodPath,
    reset() {
      state.calls.length = 0;
      for (const k of Object.keys(state.countByPath)) delete state.countByPath[k];
      for (const k of Object.keys(state.countByMethodPath)) delete state.countByMethodPath[k];
    },
    stop() {
      server.stop(true);
    },
  };
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
