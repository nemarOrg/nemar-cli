/**
 * The NEMAR API as `nemar admin repull plan`'s command-line suite needs it: the REAL datasets
 * router (`GET /datasets/:id` and `GET /datasets/:id/versions`) behind its real auth middleware.
 *
 * Lives in backend/test/helpers so `hono` resolves from the backend's own dependencies; the root
 * test imports this, not Hono, as the other CLI suites reach the backend.
 */

import { Hono } from "hono";
import { datasetRoutes } from "../../src/routes/datasets";
import type { Bindings, Variables } from "../../src/types/bindings";

export function makeRepullApp(): (req: Request, env: Bindings) => Response | Promise<Response> {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/datasets", datasetRoutes);
  return (req, env) =>
    app.fetch(req, env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext);
}
