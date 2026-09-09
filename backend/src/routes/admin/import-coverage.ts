/**
 * Admin route: on-demand import coverage sweep (epic #1306 phase 3, #1311).
 *
 * Same shape as `routes/admin/import-issue-triage.ts`: the daily cron is the
 * regular driver, and this route exists for an operator who wants an answer now --
 * which for a coverage check is the common case, because the question "is the
 * importer actually keeping up?" is one someone asks during an incident.
 *
 * Grouped under `/admin/imports/` with the phase 2 sibling rather than under
 * `/admin/datasets/` as #1311's text suggested: the concern is the import
 * pipeline, not a dataset, and admin route paths are pinned by
 * `test/admin-route-inventory.unit.test.ts` so moving one later is churn.
 *
 * **Dry run by default**, and `apply` refuses outside production, because the
 * issue it files lives on the `nemarDatasets` org that dev shares with prod.
 */

import { auditLogStatement } from "../../db/audit-log";
import { isNonProductionEnv } from "../../services/environment";
import { runImportCoverageSweep } from "../../services/import-coverage-sweep";
import type { AdminRouter } from "./shared";

/**
 * `deps.sweep` defaults to the real `runImportCoverageSweep` and exists so a route
 * test can register this exact route with the OpenNeuro and GitHub boundaries
 * substituted, the same DI-seam idiom `registerZarrFidelitySweepRoutes` and
 * `registerImportIssueTriageRoutes` use. Exercised by
 * `backend/test/import-coverage-route.test.ts`.
 */
export function registerImportCoverageRoutes(
  admin: AdminRouter,
  deps: { sweep?: typeof runImportCoverageSweep } = {},
): void {
  const sweep = deps.sweep ?? runImportCoverageSweep;

  /**
   * POST /admin/imports/coverage-sweep?apply=1
   *
   * No `limit`: the sweep is fleet-level, one GraphQL scan plus three D1 reads,
   * so there is nothing to batch.
   *
   * **`status: "unknown"` answers 502.** A 200 there would read as "coverage
   * checked out fine" when in fact nothing could be checked, and that specific
   * confusion -- an unreadable pipeline reported as a healthy one -- is the
   * failure this whole phase exists to prevent. An `alarm` is a 200: the sweep
   * ran and reported the truth, which is a successful run.
   */
  admin.post("/imports/coverage-sweep", async (c) => {
    const apply = c.req.query("apply") === "1" || c.req.query("apply") === "true";

    if (apply && isNonProductionEnv(c.env)) {
      return c.json(
        {
          error:
            "apply is production-only: the coverage issue lives on a repo shared with production, so a staging apply would file or close the real one. Re-run without apply for the verdict.",
        },
        403,
      );
    }

    let result: Awaited<ReturnType<typeof runImportCoverageSweep>>;
    try {
      result = await sweep(c.env, { apply });
    } catch (err) {
      // The sweep is written not to throw -- discovery, D1 and reporting failures
      // are all captured into `errors` -- so reaching here is a bug or an
      // environment fault, not a coverage verdict.
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[import-coverage] sweep threw:", err);
      return c.json({ error: `Import coverage sweep failed before it could report: ${msg}` }, 500);
    }

    // Only a run that actually changed the issue is worth an audit row; a dry run
    // is a read, and an alarming run that merely refreshed the body is routine.
    let auditFailed: string | undefined;
    const changed = apply && result.issue !== null && result.issue.action !== "unchanged";
    if (changed && result.issue) {
      try {
        await auditLogStatement(c.env.DB, {
          userId: c.get("user").id,
          action: "import_coverage_sweep",
          resourceType: "dataset",
          resourceId: `#${result.issue.number}`,
          details: JSON.stringify({
            status: result.status,
            kind: result.kind,
            issue_action: result.issue.action,
            never_attempted: result.backlog.neverAttempted.length,
            dispatch_age_hours: result.dispatchAgeHours,
            enabled: result.enabled,
          }),
        }).run();
      } catch (err) {
        auditFailed = err instanceof Error ? err.message : String(err);
        console.error("[import-coverage] audit row failed after applying:", err);
      }
    }

    if (result.status === "unknown") {
      return c.json(
        {
          ...result,
          ok: false,
          error: `Coverage could not be determined: ${result.reason}`,
          // Under `details` too, so the CLI's ApiError keeps the causes rather
          // than printing a verdict with no explanation.
          details: { errors: result.errors },
          ...(auditFailed ? { audit_failed: auditFailed } : {}),
        },
        502,
      );
    }
    return c.json({ ...result, ok: true, ...(auditFailed ? { audit_failed: auditFailed } : {}) });
  });
}
