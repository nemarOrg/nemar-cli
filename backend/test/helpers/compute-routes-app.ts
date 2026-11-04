/**
 * The compute and webhook routers as the compute suites need them: the REAL `computeRoutes` and the REAL
 * `webhooks` router, mounted at `/compute` and `/webhooks` as `backend/src/index.ts` mounts them, over a
 * real migrated database and the real bindings of `compute-lifecycle-fixture.ts`. Nothing is stood in
 * for. `serveRoutes` puts the same handler on a real loopback port, so a Tapis stand-in that fires a
 * webhook reaches the very address the Worker subscribed.
 */

import { Hono } from "hono";
import { computeRoutes } from "../../src/routes/compute";
import webhooks from "../../src/routes/webhooks";
import type { Bindings, Variables } from "../../src/types/bindings";

export type RoutesHandle = (req: Request, env: Bindings) => Response | Promise<Response>;

export function makeRoutesApp(): RoutesHandle {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/compute", computeRoutes);
  app.route("/webhooks", webhooks);
  return (req, env) =>
    app.fetch(req, env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext);
}

/** A real HTTP server for the routes; `env` is read at each request, so a test can change it. */
export function serveRoutes(handle: RoutesHandle, env: () => Bindings) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => handle(req, env()),
  });
}
