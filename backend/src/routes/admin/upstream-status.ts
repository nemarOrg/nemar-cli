/**
 * Admin route: the upstream staleness report (epic #1046 phase 4a, #1910; ADR 0111).
 *
 * `GET /admin/upstream-status[?limit=N][&after=onNNNNNN]` or `?dataset=onNNNNNN`
 *
 * READ-ONLY: the report itself writes nothing to D1, GitHub or S3, sends no mail and files no
 * issue, so it is safe to call anywhere; authentication, which wraps the route, still stamps
 * `tokens.last_used_at`. Outside production it runs and finds no mirrors (the dev database holds
 * only fixtures), which is correct. One call examines at most 100 mirrors and answers where to
 * resume (`next_cursor`, a dataset id passed back as `after`) and how many remain. `counts` is for
 * the page; aggregating pages is the caller's job.
 *
 * 400 is a malformed `after`, `dataset` or `limit` (a `limit` that is not a positive integer), or
 * `dataset` together with `after`; 404 a `dataset` outside the population (not a managed OpenNeuro
 * mirror, or withdrawn); 502 means at least one row needed an OpenNeuro verdict and every such row
 * ended `unchecked` (the body is still the page); 500 is a D1 failure, or, separately labeled, a
 * defect after D1 was read.
 *
 * A 200 is NOT proof that everything was compared. A partial failure leaves some rows `unchecked`
 * and lists the problem in `errors[]`; a page of only unknown-tag rows with OpenNeuro down is 200
 * with those rows `unknown` and their reasons naming the failure. A caller that needs "every
 * mirror compared" must read `errors[]` and the `unchecked` count, not only the status. A report
 * with stale mirrors is still 200: stale is a finding, not an error. The service holds the rules;
 * this file is the HTTP shell.
 */

import {
  CURSOR_RE,
  UpstreamStatusDatabaseError,
  runUpstreamStatusPage,
} from "../../services/upstream-status";
import type { AdminRouter } from "./shared";

export function registerUpstreamStatusRoutes(admin: AdminRouter): void {
  admin.get("/upstream-status", async (c) => {
    const after = c.req.query("after");
    if (after !== undefined && !CURSOR_RE.test(after)) {
      return c.json({ error: "`after` must look like on000001" }, 400);
    }
    const dataset = c.req.query("dataset");
    if (dataset !== undefined && !CURSOR_RE.test(dataset)) {
      return c.json({ error: "`dataset` must look like on000001" }, 400);
    }
    if (dataset !== undefined && after !== undefined) {
      return c.json({ error: "`dataset` and `after` cannot be combined" }, 400);
    }
    const limitRaw = c.req.query("limit");
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      if (!/^[0-9]+$/.test(limitRaw) || Number.parseInt(limitRaw, 10) < 1) {
        return c.json({ error: "`limit` must be a positive integer" }, 400);
      }
      limit = Number.parseInt(limitRaw, 10);
    }

    try {
      const page = await runUpstreamStatusPage(c.env, { after, limit, dataset });
      if (dataset !== undefined && page.rows.length === 0) {
        return c.json(
          { error: `${dataset} is not a managed OpenNeuro mirror, or is withdrawn` },
          404,
        );
      }
      if (!page.ok) return c.json(page, 502);
      return c.json(page);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof UpstreamStatusDatabaseError) {
        console.error("[upstream-status] database failure:", msg);
        return c.json(
          { error: `Failed to read datasets, import_jobs or dataset_versions: ${msg}` },
          500,
        );
      }
      console.error("[upstream-status] defect after the database was read:", err);
      return c.json(
        { error: `The report failed after D1 was read (not a database failure): ${msg}` },
        500,
      );
    }
  });
}
