/**
 * Admin route: on-demand import-failure issue triage (epic #1306, issue #1310).
 *
 * Same shape as `routes/admin/zarr-fidelity-sweep.ts`: the daily cron is the
 * regular driver, and this route exists for an operator who wants a batch now.
 * One implementation (`runImportIssueSweep`) shared by both callers so they
 * cannot drift.
 *
 * **Dry run by default.** `apply` must be sent explicitly, because the write
 * side closes and relabels real issues on nemarDatasets/.github. That matches
 * `backfill-names`, the other admin operation that changes many rows at once.
 */

import { auditLogStatement } from "../../db/audit-log";
import {
  IMPORT_ISSUE_SWEEP_DEFAULT_LIMIT,
  IMPORT_ISSUE_SWEEP_MAX_LIMIT,
  runImportIssueSweep,
} from "../../services/import-issue-sweep";
import type { AdminRouter } from "./shared";

/**
 * `deps.sweep` defaults to the real `runImportIssueSweep` and exists so a route
 * test can register this exact route with the GitHub/S3 boundaries substituted,
 * the same DI-seam idiom `registerZarrFidelitySweepRoutes` uses.
 */
export function registerImportIssueTriageRoutes(
  admin: AdminRouter,
  deps: { sweep?: typeof runImportIssueSweep } = {},
): void {
  const sweep = deps.sweep ?? runImportIssueSweep;

  /**
   * POST /admin/imports/issue-triage?limit=N&apply=1
   *
   * Bounded batch (default {@link IMPORT_ISSUE_SWEEP_DEFAULT_LIMIT}, max
   * {@link IMPORT_ISSUE_SWEEP_MAX_LIMIT}). Without `apply`, reports the plan
   * and writes nothing.
   *
   * A run in which EVERY examined issue errored answers 502: a 200 there would
   * read as "triage ran cleanly and found nothing to do", which is the opposite
   * of what happened. A partial result is a successful run and stays 200, as is
   * an empty candidate set.
   */
  admin.post("/imports/issue-triage", async (c) => {
    const limitRaw = Number.parseInt(c.req.query("limit") || "", 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
    const apply = c.req.query("apply") === "1" || c.req.query("apply") === "true";

    try {
      const result = await sweep(c.env, { limit, apply });

      // Only a run that actually changed something is worth an audit row; a dry
      // run is a read.
      if (apply && (result.closed > 0 || result.relabelled > 0)) {
        await auditLogStatement(c.env.DB, {
          userId: c.get("user").id,
          action: "import_issue_triage",
          resourceType: "dataset",
          resourceId: result.plan
            .filter((e) => e.kind !== "keep")
            .map((e) => e.datasetId ?? `#${e.issueNumber}`)
            .join(","),
          details: JSON.stringify({
            closed: result.closed,
            relabelled: result.relabelled,
            kept: result.kept,
            errors: result.errors.length,
          }),
        }).run();
      }

      const totalFailure = result.examined > 0 && result.errors.length === result.examined;
      if (totalFailure) {
        return c.json(
          {
            ...result,
            ok: false,
            error: `All ${result.examined} examined issue(s) errored; see errors[]`,
          },
          502,
        );
      }
      return c.json({ ...result, ok: true });
    } catch (err) {
      // Reaching here means the issue LISTING failed, so there is no honest
      // count to report and nothing was touched.
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[import-issue-triage] sweep failed:", msg);
      return c.json({ error: `Failed to list import-failure issues: ${msg}` }, 500);
    }
  });
}
