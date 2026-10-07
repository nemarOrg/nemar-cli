/**
 * Admin routes for the scheduled identifier sweep (epic #1610, phase 5, ADR 0088).
 *
 * GET  /admin/identifier-sweep              the weekly report, now, on demand
 * POST /admin/identifier-sweep/:id/rescreen screen one dataset again, next tick
 *
 * Both are safe on staging. The report only reads D1 and sends nothing: the
 * production tick is what mails it, once a week. A rescreen request is a D1
 * write the production tick answers; on any other worker nothing dispatches,
 * because the tick refuses outside production.
 */

import { isValidDatasetId } from "../../services/datasetId";
import {
  gatherIdentifierWeek,
  requestRescreen,
  weeklyRecordState,
} from "../../services/identifier-sweep";
import { renderIdentifierWeek } from "../../services/identifier-sweep-report";
import type { AdminRouter } from "./shared";

export function registerIdentifierSweepAdminRoutes(admin: AdminRouter): void {
  /**
   * The report the cycle would mail now, with its facts. 200 whenever it was
   * produced, unknown parts included: a week that needs attention is a
   * successful read, and the parts that could not be read say `unknown`.
   */
  admin.get("/identifier-sweep", async (c) => {
    const now = new Date();
    const facts = await gatherIdentifierWeek(c.env.DB, now);
    // Whether the week this report covers has been mailed, and how many of its
    // claims are spent: `null` when that could not be read, never "not sent".
    const weekly = await weeklyRecordState(c.env.DB, now);
    return c.json({ ok: true, facts, report: renderIdentifierWeek(facts), weekly });
  });

  /**
   * Put one dataset at the front of the sweep's queue. 404 for no such dataset,
   * 409 for one the sweep does not screen (not public, withdrawn, a sandbox id)
   * or whose stamps it cannot write.
   */
  admin.post("/identifier-sweep/:id/rescreen", async (c) => {
    const datasetId = c.req.param("id");
    if (!isValidDatasetId(datasetId)) return c.json({ error: "Invalid dataset id" }, 400);
    const user = c.get("user");
    const outcome = await requestRescreen(c.env, { datasetId, adminUserId: user.id });
    if (outcome === "not-found") return c.json({ error: "Dataset not found" }, 404);
    if (outcome === "unwritable") {
      return c.json(
        {
          error:
            "This dataset's sweep stamps are not a JSON object, so the sweep cannot record a request or a screen for it; repair the row first.",
        },
        409,
      );
    }
    if (outcome === "out-of-scope") {
      return c.json(
        {
          error:
            "The identifier sweep screens public, active, not withdrawn, non-sandbox datasets only; this one is outside that scope.",
        },
        409,
      );
    }
    return c.json({
      ok: true,
      dataset_id: datasetId,
      message:
        "Requested. The next production sweep tick dispatches it, unless a screen of it is already running.",
    });
  });
}
