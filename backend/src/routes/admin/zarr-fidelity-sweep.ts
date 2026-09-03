/**
 * Admin route: on-demand Zarr fidelity verification sweep (issue #1068,
 * epic #1181 phase 8).
 *
 * Same shape as `routes/admin/zarr-catalog.ts` (issue #1062, phase 2): the
 * daily cron (backend/src/index.ts) is the regular driver, and this route
 * exists for an operator who wants an immediate batch without waiting for
 * the next tick. One implementation (`runZarrFidelitySweep`,
 * services/zarr-fidelity-sweep.ts) shared by both callers so they cannot
 * drift.
 */

import {
  ZARR_FIDELITY_SWEEP_DEFAULT,
  ZARR_FIDELITY_SWEEP_MAX,
  runZarrFidelitySweep,
} from "../../services/zarr-fidelity-sweep";
import type { AdminRouter } from "./shared";

/**
 * `deps.sweep` defaults to the real `runZarrFidelitySweep` and exists so
 * `backend/test/zarr-fidelity-sweep-route.test.ts` can register this exact
 * route against a fresh app with the S3/GitHub-raw boundaries substituted
 * (real local `Bun.serve()` receivers) -- the same DI-seam idiom
 * `registerZarrCatalogRoutes` uses for `publishZarrCatalog`.
 * `registerZarrFidelitySweepRoutes(adminRoutes)` (routes/admin/index.ts)
 * omits it, so production always resolves the default.
 */
export function registerZarrFidelitySweepRoutes(
  admin: AdminRouter,
  deps: { sweep?: typeof runZarrFidelitySweep } = {},
): void {
  const sweep = deps.sweep ?? runZarrFidelitySweep;

  /**
   * POST /admin/datasets/zarr-fidelity-sweep?limit=N
   *
   * Bounded batch (default {@link ZARR_FIDELITY_SWEEP_DEFAULT}, max
   * {@link ZARR_FIDELITY_SWEEP_MAX}) of the fidelity sweep. Fails loud with a
   * 500 on a candidate-query error (e.g. migration 0073 not applied);
   * per-dataset failures are collected in the response body's `errors`
   * instead of throwing (see `runZarrFidelitySweep`'s doc comment).
   *
   * PR #1203 review, item 6: a candidate QUERY failure (thrown) is a 500 as
   * before, but a call that reached D1 fine and processed at least one
   * candidate, only to have EVERY one of them error out (zero real
   * verdicts), answers 502 with `ok: false` -- a 200 there would read as
   * "the sweep ran cleanly and verified nothing", which is not what
   * happened. A partial result (some verdicts, some errors) is still a
   * successful sweep and stays 200 `ok: true`; so does an empty candidate
   * set (`processed: 0`) -- there was nothing to fail.
   */
  admin.post("/datasets/zarr-fidelity-sweep", async (c) => {
    const limitRaw = Number.parseInt(c.req.query("limit") || "", 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;

    try {
      const result = await sweep(c.env, { limit });
      const totalFailure = result.processed > 0 && result.errors.length === result.processed;
      if (totalFailure) {
        return c.json(
          {
            ...result,
            ok: false,
            error: `All ${result.processed} processed candidate(s) errored; see errors[]`,
          },
          502,
        );
      }
      return c.json({ ...result, ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[zarr-fidelity-sweep] candidate query failed:", msg);
      return c.json(
        { error: `Failed to query sweep candidates (is migration 0073 applied?): ${msg}` },
        500,
      );
    }
  });
}
