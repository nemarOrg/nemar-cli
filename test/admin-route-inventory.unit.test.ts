/**
 * Pins the admin router's route table across the #902/#903 admin.ts split.
 *
 * Hono's `.routes` lists one entry per handler in each registration chain, so
 * a route registered with extra middleware (zValidator, ownerMiddleware, ...)
 * appears once per handler. Pinning the per-route ENTRY COUNT therefore also
 * catches a validator or middleware silently dropped while code moves between
 * files — not just a lost route.
 *
 * Counts are compared as an unordered map: the split regroups registrations
 * by domain file, and no admin path/method pair is ambiguous with another
 * (static segments outrank params in Hono's RegExpRouter), so registration
 * order is not load-bearing.
 *
 * Expected values were captured from admin.ts as of #903 commit 1, BEFORE any
 * code moved. If this test fails after an intentional route change, update
 * the map in the same commit and say so in the commit message.
 */

import { describe, expect, test } from "bun:test";
import { adminMiddleware, authMiddleware } from "../backend/src/middleware/auth";
import { adminRoutes } from "../backend/src/routes/admin";

const EXPECTED_ENTRIES: Record<string, number> = {
  // Router-level middleware (authMiddleware + adminMiddleware).
  "ALL /*": 2,

  // Users / accounts
  "GET /users": 1,
  "GET /users/:username": 1,
  "POST /users/:username/role": 3,
  "POST /approve/:username": 1,
  // #1012: id-keyed approve for web/ORCID accounts (username = NULL).
  "POST /approve/by-id/:id": 1,
  "POST /revoke/:username": 1,
  "DELETE /users/by-id/:id": 2,
  "POST /regenerate-iam/:username": 1,
  "GET /stats": 1,
  "GET /audit": 1,
  "GET /email-preferences": 1,
  "PUT /email-preferences": 2,
  "POST /notify": 2,
  "POST /test-fixtures/seed-web-user": 2,

  // DOI / enrichment
  "POST /datasets/:id/doi/concept": 2,
  "POST /datasets/:id/doi/publish": 2,
  "GET /datasets/:id/doi": 1,
  "POST /datasets/:id/doi/update": 2,
  "POST /datasets/:id/enrichment": 2,
  "GET /datasets/:id/files": 1,
  "DELETE /zenodo/deposition/:id": 1,

  // Fleet governance / visibility / CI
  "PATCH /datasets/:id/visibility": 2,
  "GET /fleet/drift": 1,
  "POST /datasets/:id/enforce": 2,
  "POST /datasets/:id/revalidate": 1,
  "POST /datasets/enforce/bulk": 2,
  "GET /datasets/:id/ci": 1,
  "POST /datasets/:id/ci": 1,
  "POST /datasets/:id/ci/validate": 1,
  "POST /datasets/:id/ci/sync": 1,

  // Publication workflow
  "GET /publish/requests": 1,
  "POST /publish/:id/deny": 2,
  "POST /publish/:id/approve": 2,
  "POST /datasets/:id/s3-lock": 1,

  // Dataset lifecycle (sweeps, doctor, deletion, reindex, manifests)
  "POST /datasets/archive-sweep": 1,
  "POST /datasets/zarr-sweep": 1,
  "POST /datasets/channel-montage-sweep": 1,
  "POST /datasets/recording-stats-sweep": 1,
  "POST /datasets/signal-defaults-sweep": 1,
  "POST /datasets/hed-sweep": 1,
  "POST /datasets/availability-report-sweep": 1,
  "POST /datasets/data-integrity-sweep": 1,
  "POST /doctor/scan": 1,
  "POST /doctor/fix": 1,
  "POST /datasets/:id/reset": 1,
  "DELETE /datasets/:id": 1,
  "POST /datasets/bulk-delete": 2,
  "POST /datasets/:id/reindex": 1,
  "POST /datasets/reindex/bulk": 1,
  "POST /vectorize/reindex-all": 1,
  "POST /datasets/:id/manifest/:version": 1,
  "POST /datasets/:id/availability-report": 1,
  "POST /manifest/dispatch": 2,
  "GET /summary/coverage": 1,

  // OpenNeuro imports
  "POST /datasets/import": 4,
  "GET /imports": 1,
  "POST /imports/:id/rollback": 1,
  "POST /imports/:id/retry": 1,
  "POST /imports/:id/verify": 1,
  "POST /imports/dispatch-cooldown": 2,

  // Staging exemplars (epic #923, Phase 5)
  "POST /datasets/exemplar": 2,
  "POST /datasets/:id/exemplar/remint-dois": 1,

  // Notices
  "GET /notices": 1,
  "POST /notices": 2,
  "DELETE /notices/:id": 1,

  // Withdrawal / restore (epic #967 phase 4, #971)
  "POST /datasets/:id/withdraw": 2,
  "POST /datasets/:id/restore": 2,

  // Zarr catalog (issue #1062, epic #1181 phase 2)
  "POST /zarr-catalog/publish": 1,

  // Zarr fidelity verification sweep (issue #1068, epic #1181 phase 8)
  "POST /datasets/zarr-fidelity-sweep": 1,
};

describe("admin route inventory", () => {
  test("route table matches the pre-split pin exactly", () => {
    const actual: Record<string, number> = {};
    for (const r of adminRoutes.routes) {
      const key = `${r.method} ${r.path}`;
      actual[key] = (actual[key] ?? 0) + 1;
    }
    expect(actual).toEqual(EXPECTED_ENTRIES);
  });

  test("entry total is pinned", () => {
    expect(adminRoutes.routes.length).toBe(96);
  });

  // The count pin above can't see a SWAP of the two router-level middleware
  // entries. Order is load-bearing: authMiddleware resolves the user that
  // adminMiddleware's role check reads.
  test("router-level middleware order is pinned (auth before admin)", () => {
    const star = adminRoutes.routes.filter((r) => r.method === "ALL" && r.path === "/*");
    expect(star.map((r) => r.handler)).toEqual([authMiddleware, adminMiddleware]);
  });
});
