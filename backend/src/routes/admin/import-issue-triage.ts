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
 * `apply` additionally refuses outside production, because that repo is shared
 * with production rather than environment-scoped.
 */

import { auditLogStatement } from "../../db/audit-log";
import { isNonProductionEnv } from "../../services/environment";
import {
  IMPORT_ISSUE_SWEEP_DEFAULT_LIMIT,
  IMPORT_ISSUE_SWEEP_MAX_LIMIT,
  runImportIssueSweep,
} from "../../services/import-issue-sweep";
import type { AdminRouter } from "./shared";

/**
 * `deps.sweep` defaults to the real `runImportIssueSweep` and exists so a route
 * test can register this exact route with the GitHub/S3 boundaries substituted,
 * the same DI-seam idiom `registerZarrFidelitySweepRoutes` uses. Exercised by
 * `backend/test/import-issue-triage-route.test.ts`, which is what covers the
 * production guard, the 502 predicate, the audit gate and the query parsing --
 * none of which the service tests can reach.
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
   * A run in which every ATTEMPTED issue failed answers 502: a 200 there would
   * read as "triage ran cleanly and found nothing to do", which is the opposite
   * of what happened. A partial result is a successful run and stays 200, as is
   * an empty candidate set.
   */
  admin.post("/imports/issue-triage", async (c) => {
    const limitRaw = Number.parseInt(c.req.query("limit") || "", 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
    const apply = c.req.query("apply") === "1" || c.req.query("apply") === "true";

    // `IMPORT_FAILURE_ISSUES_REPO` is hardcoded and `nemarDatasets` is SHARED
    // between production and dev (AGENTS.md), so an `apply` from a staging
    // worker closes and relabels real production issues. `runImportIssueSweepCron`
    // carries this guard for the cron; the route needs its own, because a
    // `TEST_ADMIN_API_KEY` reaches here. The dry run stays available everywhere:
    // it is a read, and reading the production tracker from staging is the point.
    if (apply && isNonProductionEnv(c.env)) {
      return c.json(
        {
          error:
            "apply is production-only: the import-failure tracker is a single repo shared with production, so a staging apply would write to it. Re-run without apply for the plan.",
        },
        403,
      );
    }

    let result: Awaited<ReturnType<typeof runImportIssueSweep>>;
    try {
      result = await sweep(c.env, { limit, apply });
    } catch (err) {
      // The sweep threw before it could report, so there is no honest count and
      // nothing was written. Deliberately NOT described as a listing failure:
      // `getDatasetsToken` throwing on a misconfigured App is the other likely
      // cause and sends an operator looking at labels instead of credentials.
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[import-issue-triage] sweep failed before it could report:", err);
      return c.json({ error: `Import-issue triage failed before it could report: ${msg}` }, 500);
    }

    // Only a run that actually changed something is worth an audit row; a dry
    // run is a read. `closed`/`relabelled` count landed writes, so this cannot
    // fire for a run whose every write failed.
    //
    // Outside the try above on purpose: an audit failure must not turn a run
    // that really did close issues into a 500 that reads as "nothing happened"
    // while up to `limit` issues are closed on GitHub and the result is
    // discarded. It is reported instead, as `audit_failed`.
    // Releasing a rollup closes and comments on a real issue, so it counts as a
    // change: without it in the gate, a run whose only writes were releases left
    // no durable record of them at all.
    let auditFailed: string | undefined;
    if (apply && (result.closed > 0 || result.relabelled > 0 || result.rollupsReleased > 0)) {
      try {
        await auditLogStatement(c.env.DB, {
          userId: c.get("user").id,
          action: "import_issue_triage",
          resourceType: "dataset",
          resourceId: [
            ...result.plan
              .filter((e) => e.kind !== "keep" && !e.failed)
              .map((e) => e.datasetId ?? `#${e.issueNumber}`),
            ...result.rollups.filter((r) => r.outcome === "released").map((r) => `#${r.number}`),
          ].join(","),
          details: JSON.stringify({
            closed: result.closed,
            relabelled: result.relabelled,
            kept: result.kept,
            rollups_released: result.rollupsReleased,
            errors: result.errors.length,
          }),
        }).run();
      } catch (err) {
        auditFailed = err instanceof Error ? err.message : String(err);
        console.error("[import-issue-triage] audit row failed after applying:", err);
      }
    }

    // Two independent total failures, because there are two halves that can fail
    // wholesale and each has its own denominator:
    //
    //   - every WRITE failed. Measured over attempts, not over `examined`: a
    //     `keep` attempts nothing and so cannot fail, and counting keeps is what
    //     let the realistic write outage -- PAT lost `issues: write`, repo
    //     archived, secondary rate limit -- answer 200 with 10 keeps and 5 failed
    //     writes. A `comment`-stage error is excluded: its state change landed.
    //   - nothing could be JUDGED. Every examined row failed to decide, which is
    //     the original zarr-shaped predicate and the only total failure a dry run
    //     can have. It must be measured over plan failures alone: `>= attempted`
    //     over a dry run's zero attempts would make any single error fatal.
    const failedWrites = result.errors.filter((e) => e.stage === "apply").length;
    const failedPlans = result.errors.filter((e) => e.stage === "plan").length;
    const everyWriteFailed = result.attempted > 0 && failedWrites >= result.attempted;
    const nothingCouldBeJudged = result.examined > 0 && failedPlans >= result.examined;
    if (everyWriteFailed || nothingCouldBeJudged) {
      return c.json(
        {
          ...result,
          ok: false,
          error: everyWriteFailed
            ? `All ${result.attempted} attempted write(s) failed; see errors[]`
            : `None of the ${result.examined} examined issue(s) could be verified; see errors[]`,
          // Under `details` as well as at the top level: the CLI's `request()`
          // turns any non-2xx into an ApiError that keeps `details`, so this is
          // what makes the causes reachable from the thrown error rather than
          // printing a count with no reasons.
          details: { errors: result.errors },
          ...(auditFailed ? { audit_failed: auditFailed } : {}),
        },
        502,
      );
    }
    return c.json({ ...result, ok: true, ...(auditFailed ? { audit_failed: auditFailed } : {}) });
  });
}
