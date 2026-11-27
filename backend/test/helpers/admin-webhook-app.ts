// The real admin and webhook routers on one app, for a suite in `test/` (which has no `hono` of its
// own) that serves the Worker on a loopback port for the CLI to reach. Nothing is stubbed: these are
// the production routers behind their real authentication.

import { Hono } from "hono";
import { adminRoutes } from "../../src/routes/admin";
import webhooks from "../../src/routes/webhooks";
import type { Bindings, Variables } from "../../src/types/bindings";

export type AdminWebhookApp = Hono<{ Bindings: Bindings; Variables: Variables }>;

export function makeAdminWebhookApp(): AdminWebhookApp {
  const app: AdminWebhookApp = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  app.route("/webhooks", webhooks);
  return app;
}
