/**
 * Admin route: the upstream staleness report (epic #1046 phase 4a, #1910; ADR 0111).
 *
 * `GET /admin/upstream-status[?limit=N][&after=onNNNNNN][&dataset=onNNNNNN]`
 *
 * READ-ONLY: it writes nothing to D1, GitHub or S3, sends no mail and files no issue, so it is
 * safe to call anywhere. Outside production it runs and finds no mirrors (the dev database holds
 * only fixtures), which is correct. One call examines at most 100 mirrors and answers where to
 * resume (`next_cursor`, a dataset id passed back as `after`) and how many remain.
 *
 * 400 is a malformed `after` or `dataset`; 404 a `dataset` outside the population (not a managed
 * OpenNeuro mirror, or withdrawn); 502 means OpenNeuro could not be read for any mirror that
 * needed it (the body is still the page, every such row `unchecked`); 500 is a D1 failure.
 * A report with stale mirrors is still 200: stale is a finding, not an error. The service holds
 * the rules; this file is the HTTP shell.
 */

import { CURSOR_RE, runUpstreamStatusPage } from "../../services/upstream-status";
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
    const limitRaw = Number.parseInt(c.req.query("limit") || "", 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;

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
      console.error("[upstream-status] database failure:", msg);
      return c.json(
        { error: `Failed to read datasets, import_jobs or dataset_versions: ${msg}` },
        500,
      );
    }
  });
}
