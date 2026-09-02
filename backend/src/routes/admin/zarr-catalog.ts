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

export function registerZarrCatalogRoutes(admin: AdminRouter): void {
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
      const result = await publishZarrCatalog(c.env);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[zarr-catalog] publish failed:", msg);
      return c.json({ error: `Failed to publish zarr catalog: ${msg}` }, 500);
    }
  });
}
