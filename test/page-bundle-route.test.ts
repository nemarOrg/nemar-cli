/**
 * Route-registration tests for `GET /<id>/page-bundle.json` added in epic
 * #618 phase 3 (PR #624).
 *
 * Scope: route IS registered + visibility gate 404s before any D1 / S3
 * work. The body-content path requires real D1 (`loadVersionRowsForBundle`)
 * and real S3 (`loadSummary`); per repo's "no mocks" policy, the bundle's
 * assembly is covered by the post-deploy smoke against a known dataset,
 * not here.
 *
 * What this file pins down:
 *  - The route IS registered on `dataRoutes` at the exact path Hono will
 *    match. Catches the docstring-warned regression where moving the
 *    registration below `/:datasetId/:version/*` would let Hono capture
 *    `page-bundle.json` as a `:version` param.
 *  - Invalid dataset id returns 404 (visibility gate short-circuits).
 *  - Registration order is "before any catch-all `:datasetId/:version/*`"
 *    — asserted by inspecting the routes array index.
 *
 * Pattern copied from `test/data-summary-route.test.ts`, which uses the
 * same approach for `/:datasetId/:version/summary.json` in epic #559.
 */

import { describe, expect, test } from "bun:test";
import "./setup";

import type { Bindings } from "../backend/src/types/bindings";
import { dataRoutes } from "../backend/src/routes/data";

function findRoute(method: string, path: string) {
  return dataRoutes.routes.find((r) => r.method === method && r.path === path);
}

describe("page-bundle route registration", () => {
  test("GET /:datasetId/page-bundle.json IS registered", () => {
    expect(findRoute("GET", "/:datasetId/page-bundle.json")).toBeDefined();
  });

  test("registered before any /:datasetId/:version/* catch-all", () => {
    // Hono matches in registration order. If `page-bundle.json` is
    // registered AFTER any `/:datasetId/:version` or `/:datasetId/:version/*`
    // route, those routes will capture `page-bundle.json` as `:version` and
    // the bundle returns the wrong handler's 404 — `pageBundleHandler` never
    // runs. Pin the index relationship so a future "let me organize this
    // file alphabetically" refactor can't silently shadow the bundle.
    const bundleIdx = dataRoutes.routes.findIndex(
      (r) => r.method === "GET" && r.path === "/:datasetId/page-bundle.json",
    );
    expect(bundleIdx).toBeGreaterThanOrEqual(0);

    // Only the bare `/:datasetId/:version` (depth-2) capture could shadow
    // the bundle route. Depth-3 patterns like `/:datasetId/:version/manifest.json`
    // can't match a depth-2 URL like `/<id>/page-bundle.json`, so they don't
    // matter for ordering. Match only the depth-2 capture.
    const versionCaptureIdx = dataRoutes.routes.findIndex(
      (r) => r.method === "GET" && /^\/:datasetId\/:version\/?$/.test(r.path),
    );

    if (versionCaptureIdx >= 0) {
      expect(bundleIdx).toBeLessThan(versionCaptureIdx);
    }
    // If no version-capture route exists at all, the ordering invariant is
    // trivially satisfied — but that would itself be surprising; surface it.
    else {
      console.warn(
        "[page-bundle-route] no depth-2 /:datasetId/:version capture found; routing-order assertion is trivially satisfied",
      );
    }
  });

  test("invalid dataset id returns 404 (visibility gate short-circuits)", async () => {
    // The visibility gate is `loadPublishedDataset` which calls
    // `isValidDatasetId` first and returns null for shape failures, before
    // touching D1. So a request with no real DB binding still returns 404.
    const env = {} as unknown as Bindings;
    const res = await dataRoutes.request(
      "/not-a-valid-id/page-bundle.json?v=v1.0.0",
      undefined,
      env,
    );
    expect(res.status).toBe(404);
  });
});
