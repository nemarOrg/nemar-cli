/**
 * Admin route: on-demand weekly import summary (epic #1306 phase 4, #1312).
 *
 * Same shape as its two siblings under `/admin/imports/`. The cron is the regular
 * driver; this exists so an operator can read the report without waiting for
 * Monday, which during an incident is exactly when they want it.
 *
 * **Dry run by default**, and `apply` refuses outside production, because the issue
 * lands on the `nemarDatasets` org that dev shares with prod.
 *
 * A dry run also FORCES past the once-per-week gate. That is the difference between
 * this and the cron: the gate exists to stop a duplicate issue being filed, and a
 * dry run files nothing, so refusing to render the report would only withhold it
 * from the person who asked. An `apply` is still gated.
 */

import { isNonProductionEnv } from "../../services/environment";
import { runWeeklyImportSummary } from "../../services/import-weekly-summary-sweep";
import type { AdminRouter } from "./shared";

/**
 * `deps.summary` defaults to the real `runWeeklyImportSummary` and exists so a route
 * test can register this exact route with the GitHub and coverage boundaries
 * substituted, the same DI-seam idiom the sibling routes use. Exercised by
 * `backend/test/import-weekly-route.test.ts`.
 */
export function registerImportWeeklyRoutes(
  admin: AdminRouter,
  deps: { summary?: typeof runWeeklyImportSummary } = {},
): void {
  const summary = deps.summary ?? runWeeklyImportSummary;

  /**
   * POST /admin/imports/weekly-summary?apply=1
   *
   * Always 200 when the report was produced, even if the week needs attention: an
   * unhealthy week is a successful RUN, and a monitoring caller has to be able to
   * tell "the pipeline is unwell" from "the report is broken". 502 is reserved for a
   * report that could not be produced at all.
   *
   * A report with `facts.errors` in it is still a 200: those are the parts that came
   * back unknown, which the body states as unknown rather than as zero. That is the
   * phase's whole contract, so degrading it to an error would defeat it.
   */
  admin.post("/imports/weekly-summary", async (c) => {
    const apply = c.req.query("apply") === "1" || c.req.query("apply") === "true";

    if (apply && isNonProductionEnv(c.env)) {
      return c.json(
        {
          error:
            "apply is production-only: the weekly summary is filed on a repo shared with production, so a staging apply would post the real one. Re-run without apply to read the report.",
        },
        403,
      );
    }

    let result: Awaited<ReturnType<typeof runWeeklyImportSummary>>;
    try {
      // `force` on a dry run: see the note at the top. An apply stays gated, so the
      // once-per-week guarantee is unaffected.
      result = await summary(c.env, { apply, force: !apply });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[import-weekly] summary threw:", err);
      return c.json({ error: `Weekly import summary failed before it could report: ${msg}` }, 502);
    }

    return c.json({ ...result, ok: true });
  });
}
