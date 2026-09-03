/**
 * Admin route: on-demand refresh of the top-level Zarr discovery catalog
 * (issue #1062, epic #1181 phase 2).
 *
 * The daily cron (backend/src/index.ts) is the regular publisher; this
 * exists for an operator who just fixed a stuck conversion and doesn't want
 * to wait for the next tick. Same `publishZarrCatalog` implementation as the
 * cron -- one function, two callers, so they cannot drift (mirrors the
 * recording-stats-sweep / signal-defaults-sweep admin-route-plus-cron shape
 * in datasets-lifecycle.ts).
 */

import { publishZarrCatalog } from "../../services/zarr-catalog";
import type { AdminRouter } from "./shared";

/**
 * `deps.publish` defaults to the real `publishZarrCatalog` and exists so
 * `backend/test/zarr-catalog-publish-route.test.ts` can register this exact
 * route against a fresh app with the S3 boundary substituted (a real local
 * `Bun.serve()` receiver), the same "one true network boundary substituted"
 * idiom `runRecordingStatsSweep`'s `fetchIndex` parameter uses -- not a
 * second implementation of this handler's auth/error-shaping logic.
 * `registerZarrCatalogRoutes(adminRoutes)` (routes/admin/index.ts) omits it,
 * so production always resolves the default.
 */
export function registerZarrCatalogRoutes(
  admin: AdminRouter,
  deps: { publish?: typeof publishZarrCatalog } = {},
): void {
  const publish = deps.publish ?? publishZarrCatalog;

  /**
   * POST /admin/zarr-catalog/publish
   *
   * Rebuilds `zarr-catalog.json` from the current `datasets` table and PUTs
   * it to this env's own bucket. Fails loud (500 with the underlying
   * message) on any D1/S3 error, including a 403 -- see
   * `publishZarrCatalog`'s doc comment for why that is never swallowed.
   */
  admin.post("/zarr-catalog/publish", async (c) => {
    try {
      const result = await publish(c.env);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[zarr-catalog] publish failed:", msg);
      return c.json({ error: `Failed to publish zarr catalog: ${msg}` }, 500);
    }
  });
}
