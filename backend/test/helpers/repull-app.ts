/**
 * The NEMAR API as the re-pull suites need it: the REAL datasets router (`GET /datasets/:id` and
 * `GET /datasets/:id/versions`) and the REAL `/admin/repulls` routes, each behind its real auth
 * middleware (the admin routes behind the admin middleware too, as `routes/admin/index.ts` mounts
 * them).
 *
 * Lives in backend/test/helpers so `hono` resolves from the backend's own dependencies; the root
 * test imports this, not Hono, as the other CLI suites reach the backend.
 */

import { Hono } from "hono";
import { adminMiddleware, authMiddleware } from "../../src/middleware/auth";
import { registerUpstreamRepullRoutes } from "../../src/routes/admin/upstream-repulls";
import { datasetRoutes } from "../../src/routes/datasets";
import type { Bindings, Variables } from "../../src/types/bindings";

export function makeRepullApp(): (req: Request, env: Bindings) => Response | Promise<Response> {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/datasets", datasetRoutes);
  const admin = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  admin.use("*", authMiddleware);
  admin.use("*", adminMiddleware);
  registerUpstreamRepullRoutes(admin);
  app.route("/admin", admin);
  return (req, env) =>
    app.fetch(req, env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext);
}
