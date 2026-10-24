/**
 * Admin route: record the upstream snapshot for the mirrors that predate it (epic #1046
 * phase 2, #1908; ADR 0111, decision 4).
 *
 * `POST /admin/datasets/upstream-backfill[?execute=1][&limit=N][&after=<dataset_id>@<version>]`
 *
 * A dry run by default. One call examines at most 50 version rows (default 25) and answers
 * where to resume (`next_cursor`) and where the whole pass stands (`counts`). Re-running is
 * safe: the write never overwrites a recorded value, so rows already examined drop out of the
 * candidate set, and `after` exists only to step past a row that keeps erroring.
 *
 * 502 means the call must not be read as progress: every read failed, or every description
 * read as absent in a batch of two or more (a credential GitHub cannot see the repositories
 * with answers 404 to all of them), and in both cases nothing was written. 500 is a database
 * failure while choosing candidates. The service holds the rules; this file is the HTTP shell.
 */

import { CURSOR_RE, runUpstreamBackfill } from "../../services/upstream-backfill";
import type { AdminRouter } from "./shared";

export function registerUpstreamBackfillRoutes(admin: AdminRouter): void {
  admin.post("/datasets/upstream-backfill", async (c) => {
    const after = c.req.query("after");
    if (after !== undefined && !CURSOR_RE.test(after)) {
      return c.json({ error: "`after` must look like on000001@1.0.0" }, 400);
    }
    const execute = ["1", "true"].includes(c.req.query("execute") ?? "");
    const limitRaw = Number.parseInt(c.req.query("limit") || "", 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;

    try {
      const result = await runUpstreamBackfill(c.env, { execute, limit, after });
      if (!result.ok) return c.json(result, 502);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[upstream-backfill] database failure:", msg);
      return c.json(
        { error: `Failed to read or write dataset_versions (is migration 0101 applied?): ${msg}` },
        500,
      );
    }
  });
}
