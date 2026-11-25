/**
 * Admin routes of the paced re-screen (`nemar admin repo publish screen-batch`; epic #2182,
 * card D4; ADR 0086, amendment of 2026-11-25). The logic is `services/screen-batch.ts`; the
 * screens themselves are dispatched one at a time through `POST /admin/publish/:id/identifier-screen`
 * with the batch's id.
 *
 *   POST /admin/publish/screen-batches            { dataset_ids }
 *     201 { batch_id, total, skipped }            the batch exists; `skipped` are dataset ids with
 *                                                 no open request or that are never screened
 *     400 empty_batch                             no request is left to screen
 *     400 batch_too_large                         more than MAX_BATCH_SIZE
 *   POST /admin/publish/screen-batches/:batch/close
 *     200 { closed: true }                        the administrator stopped dispatching; the
 *                                                 digest follows when the started screens report
 *     404 screen_batch_not_found                  no such batch, or its digest was already sent
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { auditLogStatement } from "../../db/audit-log";
import { isValidDatasetId } from "../../services/datasetId";
import { isScreenExempt } from "../../services/identifier-screen-stored";
import { errorMessage } from "../../services/repo-metadata";
import { MAX_BATCH_SIZE, closeScreenBatch, createScreenBatch } from "../../services/screen-batch";
import type { AdminRouter } from "./shared";

const createSchema = z.object({
  // The size is checked in the handler so its refusal has a word of its own.
  dataset_ids: z.array(z.string().refine(isValidDatasetId, "not a dataset id")).min(1),
});

export function registerScreenBatchRoutes(admin: AdminRouter): void {
  admin.post("/publish/screen-batches", zValidator("json", createSchema), async (c) => {
    const { dataset_ids: ids } = c.req.valid("json");
    const unique = [...new Set(ids)];
    if (unique.length > MAX_BATCH_SIZE) {
      return c.json(
        {
          error: "batch_too_large",
          message: `A batch holds at most ${MAX_BATCH_SIZE} requests; this one names ${unique.length}. Narrow the selection.`,
        },
        400,
      );
    }
    // A sandbox dataset is never screened, so it is not in a batch that would wait on it.
    const exempt = unique.filter((id) => isScreenExempt(id));
    const screenable = unique.filter((id) => !isScreenExempt(id));
    const adminUser = c.get("user");
    let created: Awaited<ReturnType<typeof createScreenBatch>>;
    try {
      created =
        screenable.length === 0 ? null : await createScreenBatch(c.env, adminUser.id, screenable);
    } catch (err) {
      console.error("[screen-batch] could not create a batch:", errorMessage(err));
      return c.json(
        { error: "batch_create_failed", message: "The batch could not be recorded. Try again." },
        500,
      );
    }
    if (!created) {
      return c.json(
        {
          error: "empty_batch",
          message: "None of these datasets has an open publication request that is screened.",
        },
        400,
      );
    }
    try {
      await auditLogStatement(c.env.DB, {
        userId: adminUser.id,
        action: "identifier_screen_batch",
        resourceType: "screen_batch",
        resourceId: String(created.batchId),
        details: JSON.stringify({
          total: created.total,
          skipped: created.skipped.length + exempt.length,
        }),
      }).run();
    } catch (err) {
      console.error(
        `[screen-batch] audit write for batch ${created.batchId} failed:`,
        errorMessage(err),
      );
    }
    return c.json(
      { batch_id: created.batchId, total: created.total, skipped: [...created.skipped, ...exempt] },
      201,
    );
  });

  admin.post("/publish/screen-batches/:batch/close", async (c) => {
    const batchId = Number(c.req.param("batch"));
    if (!Number.isSafeInteger(batchId) || batchId < 1) {
      return c.json({ error: "screen_batch_not_found", message: "No such screen batch." }, 404);
    }
    if (!(await closeScreenBatch(c.env, batchId))) {
      return c.json(
        { error: "screen_batch_not_found", message: "No such open screen batch." },
        404,
      );
    }
    return c.json({ closed: true });
  });
}
