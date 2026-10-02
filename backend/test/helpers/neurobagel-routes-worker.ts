/**
 * A Worker entry that serves only the Neurobagel read route, mounted at `/neurobagel` as
 * the api app mounts it. neurobagel-read-route.test.ts bundles this file and runs it in
 * workerd through Miniflare, next to the R2 and D1 simulators, because that is the only
 * place the route's 200 branch (it streams an R2 object's body) can run from bun:test.
 */

import { Hono } from "hono";
import { neurobagelRoutes } from "../../src/routes/neurobagel";
import type { Bindings, Variables } from "../../src/types/bindings";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
app.route("/neurobagel", neurobagelRoutes);

export default app;
