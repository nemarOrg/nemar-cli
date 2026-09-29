/**
 * A Worker entry that serves only the public news routes, mounted at
 * `/news` as the api app mounts them.
 *
 * news-media-routes.test.ts bundles this file and runs it in workerd through
 * Miniflare, next to the R2 simulator. That is the only way to reach the
 * 200 branch of `GET /news/media/:file` from bun:test: under bun, reading
 * `.body` from an object Miniflare's Node-side proxy returns throws
 * `DataCloneError`, but inside workerd the route streams the real object.
 */

import { Hono } from "hono";
import { newsRoutes } from "../../src/routes/news";
import type { Bindings, Variables } from "../../src/types/bindings";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
app.route("/news", newsRoutes);

export default app;
