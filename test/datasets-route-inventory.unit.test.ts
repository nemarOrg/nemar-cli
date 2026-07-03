/**
 * Pins the datasets router's route table across the #902/#906 datasets.ts split.
 *
 * Hono's `.routes` lists one entry per handler in each registration chain, so
 * a route registered with extra middleware (authMiddleware, cliVersionGuard,
 * zValidator, ...) appears once per handler. Pinning the per-route ENTRY COUNT
 * therefore also catches a validator or middleware silently dropped while code
 * moves between files — not just a lost route.
 *
 * Counts are compared as an unordered map: the split regroups registrations by
 * concern file, and no datasets path/method pair is ambiguous with another
 * across files (the only overlapping same-method pair, GET /search vs GET /:id,
 * stays within catalog.ts in monolith order; static segments outrank params in
 * Hono's RegExpRouter), so cross-file registration order is not load-bearing.
 *
 * Expected values were captured from datasets.ts as of #906 commit 1, BEFORE
 * any code moved. If this test fails after an intentional route change, update
 * the map in the same commit and say so in the commit message.
 */

import { describe, expect, test } from "bun:test";
import { datasetRoutes } from "../backend/src/routes/datasets";

const EXPECTED_ENTRIES: Record<string, number> = {
  // Create & upload lifecycle
  "POST /": 4,
  "POST /:id/upload-urls": 3,
  "POST /:id/upload-credentials": 4,
  "POST /:id/download-credentials": 3,
  "POST /:id/finalize": 2,

  // Catalog / search / discovery
  "GET /": 2,
  "GET /search": 2,
  "GET /resolve/:sourceId": 2,
  "GET /:id": 2,

  // Collaborators / access requests
  "POST /:id/request-access": 2,
  "POST /:id/invite": 3,
  "GET /:id/access-requests": 2,
  "POST /:id/access-requests/:username/approve": 2,
  "POST /:id/access-requests/:username/deny": 2,
  "GET /:id/collaborators": 2,
  "DELETE /:id/collaborators/:username": 2,

  // Draft deletion
  "DELETE /:id": 2,

  // Publication workflow
  "POST /:id/publish/request": 2,
  "GET /:id/publish/status": 2,
  "POST /:id/publish/resend": 2,
  "GET /:id/ci/status": 2,
  "POST /:id/publish": 2,

  // Version manifests
  "GET /:id/manifest": 2,
  "GET /:id/manifest/:version": 2,
  "GET /:id/versions": 2,
};

describe("datasets route inventory", () => {
  test("route table matches the pre-split pin exactly", () => {
    const actual: Record<string, number> = {};
    for (const r of datasetRoutes.routes) {
      const key = `${r.method} ${r.path}`;
      actual[key] = (actual[key] ?? 0) + 1;
    }
    expect(actual).toEqual(EXPECTED_ENTRIES);
  });

  test("entry total is pinned", () => {
    expect(datasetRoutes.routes.length).toBe(57);
  });

  // The datasets router deliberately has NO router-level middleware — auth is
  // wired per-route (authMiddleware or optionalAuthMiddleware as the first
  // handler). Guard against a `.use()` sneaking in during the split.
  test("no router-level middleware", () => {
    const star = datasetRoutes.routes.filter((r) => r.method === "ALL");
    expect(star).toEqual([]);
  });
});
