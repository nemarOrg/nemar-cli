/**
 * Admin routes: dataset withdrawal / restore (epic #967 phase 4, #971).
 *
 * Thin HTTP wrappers over services/withdraw.ts: `dry_run` defaults to TRUE on
 * both endpoints (mirror POST /datasets/:id/enforce, fleet.ts) so a bare `{}`
 * body never mutates. There is no per-endpoint prod guard here beyond the
 * ordinary admin-role check -- the safety comes from the default dry-run, the
 * per-dataset precondition checks in the service, and (for the real
 * production run) the CLI's own not-on-the-checked-in-list `--force` guard,
 * which is client-side (scripts/withdrawn-datasets.json is never loaded by
 * the Worker).
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { restoreDataset, withdrawDataset } from "../../services/withdraw";
import type { AdminRouter } from "./shared";

export function registerWithdrawRoutes(admin: AdminRouter): void {
  const withdrawSchema = z.object({
    reason: z.string().min(1).optional(),
    dry_run: z.boolean().optional(),
  });

  /**
   * POST /admin/datasets/:id/withdraw - Make a dataset private and tombstone
   * its concept + version EZID DOIs. `dry_run` defaults to true.
   */
  admin.post("/datasets/:id/withdraw", zValidator("json", withdrawSchema), async (c) => {
    const datasetId = c.req.param("id");
    const body = c.req.valid("json");
    const dryRun = body.dry_run !== false;
    const adminUser = c.get("user");

    if (!dryRun && !body.reason) {
      return c.json({ error: "reason is required to execute a withdrawal" }, 400);
    }

    const result = await withdrawDataset(c.env, datasetId, body.reason ?? "", {
      dryRun,
      actorUserId: adminUser.id,
    });
    return c.json(result);
  });

  const restoreSchema = z.object({
    dry_run: z.boolean().optional(),
  });

  /**
   * POST /admin/datasets/:id/restore - Reverse a withdrawal: make the dataset
   * public again and restore its concept + version EZID DOIs. `dry_run`
   * defaults to true.
   */
  admin.post("/datasets/:id/restore", zValidator("json", restoreSchema), async (c) => {
    const datasetId = c.req.param("id");
    const body = c.req.valid("json");
    const dryRun = body.dry_run !== false;
    const adminUser = c.get("user");

    const result = await restoreDataset(c.env, datasetId, {
      dryRun,
      actorUserId: adminUser.id,
    });
    return c.json(result);
  });
}
