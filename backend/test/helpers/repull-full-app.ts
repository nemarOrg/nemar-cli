/**
 * The NEMAR API as the re-pull suites past the open pull request need it (epic #1046 phase 6): the
 * REAL datasets router, the REAL admin router (so `/admin/repulls*`, `/admin/pr-reviews*` and the
 * s3-lock route `POST /admin/datasets/:id/s3-lock` are each the production route, behind its real
 * auth and admin middleware) and the REAL users router (`/users/me`, which the merge reads for the
 * administrator's linked GitHub login), and the REAL report callback of an automatic run,
 * `POST /webhooks/repull-state`.
 *
 * Lives in backend/test/helpers so `hono` resolves from the backend's own dependencies; the root
 * suites import this, not Hono, as the other CLI suites reach the backend.
 */

import { Hono } from "hono";
import { adminRoutes } from "../../src/routes/admin";
import { registerRepullStateCallbackRoutes } from "../../src/routes/callbacks/repull-state";
import { datasetRoutes } from "../../src/routes/datasets";
import { userRoutes } from "../../src/routes/users";
import type { Bindings, Variables } from "../../src/types/bindings";

export function makeRepullFullApp(): (req: Request, env: Bindings) => Response | Promise<Response> {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/datasets", datasetRoutes);
  app.route("/admin", adminRoutes);
  app.route("/users", userRoutes);
  // The report callback an automatic run posts to (epic #1046 phase 7), as the webhooks router
  // registers it: on a router of its own, at the path the Worker serves it.
  const webhooks = new Hono<{ Bindings: Bindings }>();
  registerRepullStateCallbackRoutes(webhooks);
  app.route("/webhooks", webhooks);
  return (req, env) =>
    app.fetch(req, env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext);
}
