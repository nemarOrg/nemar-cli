/**
 * Admin routes: OpenNeuro import (create import, view import jobs,
 * rollback/retry quarantined imports; issue #754).
 *
 * Moved verbatim from routes/admin.ts in #903 (epic #902); the only
 * intentional changes are import paths, `adminRoutes` -> `admin`, and
 * audit-log INSERTs routed through auditLogStatement().
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { adminMiddleware, authMiddleware } from "../../middleware/auth";

import { auditLogStatement } from "../../db/audit-log";
import { SYSTEM_USER_ID } from "../../lib/constants";
import { stampDatasetIntegrity } from "../../services/dataset-metadata-columns";
import { deleteDatasetCascade } from "../../services/deletion";
import { type GitHubRepo, createRepository, deleteRepository } from "../../services/github";
import { getDatasetsToken } from "../../services/github-auth";
import { verifyDatasetVersionS3 } from "../../services/import-integrity";
import { IMPORT_STATUSES } from "../../services/import-recovery";
import { recoverRow } from "../../services/import-retry";
import { hasRole } from "../../types/bindings";
import type { AdminRouter } from "./shared";

/**
 * Per-source rule tying a NEMAR `dataset_id` to the upstream `source_id`
 * it was imported from (#1030).
 *
 * Registered per source rather than expressed as one global rule, because
 * the correspondence is a property of the *source*, not of datasets:
 *
 * - `openneuro` mirrors share their six digits with the upstream id —
 *   `on007964` IS `ds007964`. That is a contract, not a coincidence.
 * - `nm######` datasets are NEMAR-native uploads with `source` and
 *   `source_id` both NULL. They have nothing to correspond to, and never
 *   reach this endpoint.
 * - Further prefixes are expected, and there is no reason to assume they
 *   will share OpenNeuro's shape. An unregistered source is rejected
 *   outright below, so adding one is a deliberate decision rather than a
 *   silent inheritance of the wrong rule.
 *
 * Why enforce it at all: nemarOrg/website#190 rewrites legacy citation
 * URLs (`/dataexplorer/detail?dataset_id=ds007964` → `/dataset/on007964`)
 * on the strength of this contract, and that target is also where the DOI
 * `10.82901/nemar.on007964` lands. A violating row would not 404 — it would
 * route a *cited* URL to the *wrong dataset*, silently.
 */
/**
 * A `Map`, not a plain object: an object literal inherits from
 * `Object.prototype`, so a lookup keyed on `"constructor"` or `"toString"`
 * resolves to an inherited function and then gets *called* — returning a
 * truthy value instead of rejecting an unknown source. The unit test pins
 * that case.
 */
const SOURCE_ID_RULES = new Map<string, (datasetId: string, sourceId: string) => boolean>([
  [
    "openneuro",
    (datasetId, sourceId) => /^ds\d{6}$/.test(sourceId) && datasetId.slice(2) === sourceId.slice(2),
  ],
]);

/**
 * True when `source_id` is a legal upstream id for `dataset_id` under the
 * rule registered for `source`. An unregistered source is never legal —
 * failing closed keeps a new source from inheriting a correspondence that
 * may not hold for it.
 */
export function isValidSourceIdForDataset(
  source: string,
  datasetId: string,
  sourceId: string,
): boolean {
  const rule = SOURCE_ID_RULES.get(source);
  return rule ? rule(datasetId, sourceId) === true : false;
}

export function registerImportRoutes(admin: AdminRouter): void {
  // ─── Import external dataset ────────────────────────────────────────────────

  // 8 chars: 2-char prefix + 6 digits (e.g., on007262)
  const importDatasetSchema = z
    .object({
      dataset_id: z
        .string()
        .regex(/^on\d{6}$/, "Import only supports 'on' prefix datasets (on######)"),
      name: z.string().min(1).max(200),
      description: z.string().optional(),
      source: z.enum(["openneuro"]),
      source_id: z.string().min(1).max(50),
    })
    // Cross-field: the two ids are individually well-formed but must also
    // correspond (#1030). Rejected here rather than left to convention,
    // because a mismatch is invisible after the fact and misroutes cited
    // URLs once website#190 ships.
    .refine((v) => isValidSourceIdForDataset(v.source, v.dataset_id, v.source_id), {
      path: ["source_id"],
      message:
        "source_id does not correspond to dataset_id for this source (openneuro: on###### must match ds###### digit-for-digit)",
    });

  /**
   * POST /admin/datasets/import
   *
   * Import a dataset from an external source (e.g., OpenNeuro).
   * Creates the D1 record and GitHub repo with a caller-specified dataset ID.
   * The calling admin becomes the dataset owner (owner_user_id).
   * Does not set up S3 credentials or presigned URLs; the CLI handles data copy.
   */
  admin.post(
    "/datasets/import",
    authMiddleware,
    adminMiddleware,
    zValidator("json", importDatasetSchema),
    async (c) => {
      const { dataset_id, name, description, source, source_id } = c.req.valid("json");
      const db = c.env.DB;
      const admin = c.get("user");

      // OpenNeuro import is production-only (epic #923). `on######` ids are
      // deterministic (mapped from the source `ds######`), so a dev/test import
      // of a dataset prod has already imported would collide on the repo name in
      // the shared nemarDatasets org. Staging exemplars use the xx clone tool,
      // not this endpoint; import-pipeline E2E stays a prod-sandbox activity.
      if (c.env.ENVIRONMENT !== "production") {
        return c.json(
          {
            error: "OpenNeuro import is disabled outside production",
            message:
              "on###### ids are deterministic and would collide with production imports in the shared nemarDatasets org. Use the exemplar clone tool for staging test datasets.",
          },
          403,
        );
      }

      // Check for duplicate
      const existing = await db
        .prepare("SELECT dataset_id FROM datasets WHERE dataset_id = ?")
        .bind(dataset_id)
        .first<{ dataset_id: string }>();

      if (existing) {
        return c.json({ error: `Dataset ${dataset_id} already exists` }, 409);
      }

      // Create GitHub repo
      const pat = await getDatasetsToken(c.env);
      let githubRepo: GitHubRepo;
      try {
        githubRepo = await createRepository(
          dataset_id,
          `${name} - NEMAR Dataset (imported from OpenNeuro ${source_id})`,
          true,
          pat,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("already exists")) {
          return c.json({ error: `GitHub repo nemarDatasets/${dataset_id} already exists` }, 409);
        }
        console.error("Failed to create GitHub repo for import:", error);
        return c.json({ error: `Failed to create GitHub repository: ${msg}` }, 500);
      }

      // Insert D1 record
      try {
        await db
          .prepare(
            `INSERT INTO datasets (dataset_id, name, description, owner_user_id, github_repo, is_sandbox, visibility, source, source_id, last_activity_at)
           VALUES (?, ?, ?, ?, ?, 0, 'private', ?, ?, datetime('now'))`,
          )
          .bind(
            dataset_id,
            name,
            description || null,
            admin.id,
            githubRepo.full_name,
            source,
            source_id,
          )
          .run();

        // #754: seed the import_jobs state row the moment the dataset exists, so
        // the import has end-to-end state even if every later callback is lost.
        // A re-import after rollback resets a prior terminal row (preparing wins).
        // Non-fatal: a failure here only loses tracking, not the import.
        if (source_id) {
          try {
            await db
              .prepare(
                `INSERT INTO import_jobs (dataset_id, source, source_id, stage, status, created_at, updated_at)
               VALUES (?, ?, ?, 'prepare', 'preparing', datetime('now'), datetime('now'))
               ON CONFLICT(dataset_id) DO UPDATE SET
                 source = excluded.source, source_id = excluded.source_id,
                 stage = 'prepare', status = 'preparing',
                 last_error = NULL, completed_at = NULL, updated_at = datetime('now')`,
              )
              .bind(dataset_id, source || "openneuro", source_id)
              .run();
          } catch (importJobErr) {
            console.error(
              `[import] failed to seed import_jobs row for ${dataset_id}:`,
              importJobErr,
            );
          }
        }

        // #646: if this on* mirror's OpenNeuro source was already folded into
        // `datasets` as a sentinel catalog row (dataset_id = source_id), remove
        // that shadow so it doesn't double-list next to the new managed mirror.
        // The 0028 fold dedups shadows whose on* mirror already existed at
        // migration time; a mirror imported AFTER the fold needs this cleanup.
        // Non-fatal: the import already succeeded; a stale shadow only mis-lists.
        if (source_id) {
          try {
            const shadow = await db
              .prepare("DELETE FROM datasets WHERE owner_user_id = ? AND dataset_id = ?")
              .bind(SYSTEM_USER_ID, source_id)
              .run();
            if ((shadow.meta?.changes ?? 0) > 0) {
              console.log(
                `[import] removed folded catalog shadow ${source_id} superseded by managed mirror ${dataset_id}`,
              );
            }
          } catch (shadowErr) {
            console.error(
              `[import] failed to remove folded catalog shadow ${source_id}:`,
              shadowErr,
            );
          }
        }
      } catch (error) {
        console.error("Failed to insert dataset record:", error);
        const dbMsg = error instanceof Error ? error.message : String(error);
        // Clean up GitHub repo
        try {
          await deleteRepository(dataset_id, pat);
        } catch (cleanupErr) {
          console.error("Failed to clean up GitHub repo after D1 failure:", cleanupErr);
          return c.json(
            {
              error: `Failed to create dataset record: ${dbMsg}. GitHub repo nemarDatasets/${dataset_id} was created but could not be cleaned up. Manual deletion required.`,
            },
            500,
          );
        }
        return c.json({ error: `Failed to create dataset record: ${dbMsg}` }, 500);
      }

      // Audit log
      try {
        await auditLogStatement(db, {
          userId: admin.id,
          action: "dataset_imported",
          details: JSON.stringify({ dataset_id, source, source_id, name }),
        }).run();
      } catch (err) {
        console.error(
          `Failed to write audit log for dataset import ${dataset_id} by admin ${admin.id}:`,
          err,
        );
      }

      return c.json(
        {
          dataset_id,
          name,
          github_repo: githubRepo.full_name,
          source,
          source_id,
        },
        201,
      );
    },
  );

  // ============================================================================
  // Import jobs (issue #754) - import state view + rollback/retry
  // ============================================================================

  /** GET /admin/imports[?status=][?blocklisted=1] - list import_jobs with
   *  by-status counts. `blocklisted` filters to (or excludes) retry-engine
   *  blocklisted rows (#969); combinable with `status`. */
  admin.get("/imports", async (c) => {
    const db = c.env.DB;
    const status = c.req.query("status");
    const blocklistedParam = c.req.query("blocklisted");
    let query = `SELECT dataset_id, source, source_id, stage, status, last_error,
                      workflow_run_url, created_at, updated_at, completed_at,
                      recovery_attempts, first_incomplete_at, next_retry_at,
                      blocklisted, blocklist_reason, maintainer_notified_at,
                      integrity_checked_at
               FROM import_jobs`;
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (status) {
      conditions.push("status = ?");
      params.push(status);
    }
    if (blocklistedParam !== undefined) {
      conditions.push("blocklisted = ?");
      params.push(blocklistedParam === "1" || blocklistedParam === "true" ? 1 : 0);
    }
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(" AND ")}`;
    }
    // Surface the rows that need a human first.
    query += " ORDER BY (status = 'failed') DESC, (status = 'quarantined') DESC, updated_at DESC";
    const rows = await db
      .prepare(query)
      .bind(...params)
      .all<{ status: string }>();
    const results = rows.results ?? [];
    // by_status is always a FLEET-WIDE count (independent of the ?status=/
    // ?blocklisted= filters) so the CLI summary line isn't misleading when a
    // filter is applied.
    const counts = await db
      .prepare("SELECT status, COUNT(*) AS n FROM import_jobs GROUP BY status")
      .all<{ status: string; n: number }>();
    const by_status: Record<string, number> = {};
    for (const s of IMPORT_STATUSES) by_status[s] = 0;
    for (const row of counts.results ?? []) by_status[row.status] = row.n;
    return c.json({ imports: results, total: results.length, by_status });
  });

  /**
   * POST /admin/imports/:id/rollback - operator-confirmed cleanup of a
   * failed/quarantined import (deletes GitHub repo + S3 + D1 via the same cascade
   * as DELETE /admin/datasets/:id), then marks the import_jobs row rolled_back.
   */
  admin.post("/imports/:id/rollback", async (c) => {
    const datasetId = c.req.param("id");
    const requestingUser = c.get("user");
    const db = c.env.DB;

    const job = await db
      .prepare("SELECT status FROM import_jobs WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ status: string }>();
    if (!job) return c.json({ error: "No import job for this dataset" }, 404);
    if (job.status !== "failed" && job.status !== "quarantined") {
      return c.json(
        { error: `Import is '${job.status}', not failed/quarantined; refusing rollback` },
        409,
      );
    }

    // Defensive permission mirror of DELETE /datasets/:id: an import whose dataset
    // somehow became published needs owner role (it should never be in quarantine,
    // but never auto-delete a published dataset).
    const dataset = await db
      .prepare("SELECT owner_user_id, concept_doi, visibility FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ owner_user_id: number; concept_doi: string | null; visibility: string }>();
    if (dataset) {
      if (dataset.owner_user_id === SYSTEM_USER_ID) {
        return c.json({ error: "System catalog entry; cannot roll back here" }, 400);
      }
      const hasDoiOrPublished = dataset.concept_doi !== null || dataset.visibility === "public";
      if (hasDoiOrPublished && !hasRole(requestingUser.role, "owner")) {
        return c.json(
          { error: "This import's dataset is published; only the NEMAR owner can roll it back" },
          403,
        );
      }
    }

    let result: Awaited<ReturnType<typeof deleteDatasetCascade>>;
    try {
      result = await deleteDatasetCascade(db, c.env, datasetId, { bypassGovernance: true });
    } catch (err) {
      return c.json(
        { error: `Rollback cascade failed: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
    if (!result.deleted) {
      // Partial cascade: leave the row quarantined (surfaced) rather than claim a
      // clean rollback. The operator sees the warnings and can retry.
      await db
        .prepare(
          `UPDATE import_jobs SET status = 'quarantined', last_error = ?, updated_at = datetime('now')
         WHERE dataset_id = ?`,
        )
        .bind(`manual rollback incomplete: ${result.warnings.join("; ")}`, datasetId)
        .run();
      return c.json({
        ok: false,
        dataset_id: datasetId,
        rolled_back: false,
        steps: result.steps,
        warnings: result.warnings,
      });
    }
    await db
      .prepare(
        `UPDATE import_jobs SET status = 'rolled_back', last_error = ?, completed_at = datetime('now'), updated_at = datetime('now')
       WHERE dataset_id = ?`,
      )
      .bind(`manual rollback by user ${requestingUser.id}`, datasetId)
      .run();
    return c.json({
      ok: true,
      dataset_id: datasetId,
      rolled_back: true,
      steps: result.steps,
      warnings: result.warnings,
    });
  });

  /**
   * POST /admin/imports/:id/retry - reset a failed/quarantined row to `preparing`
   * so a re-dispatched import is expected. Does not itself re-run the workflow
   * (the operator re-dispatches onboard-openneuro.yml; the prepare callback also
   * self-heals the row). Also un-parks the row from the retry-engine blocklist
   * (#969): a manual retry is an explicit operator decision to try again, so it
   * clears blocklisted/blocklist_reason and resets next_retry_at so the retry
   * sweep doesn't immediately re-park it before the re-dispatch lands.
   */
  admin.post("/imports/:id/retry", async (c) => {
    const datasetId = c.req.param("id");
    const res = await c.env.DB.prepare(
      `UPDATE import_jobs
       SET status = 'preparing', stage = 'prepare', last_error = NULL, completed_at = NULL,
           blocklisted = 0, blocklist_reason = NULL, next_retry_at = NULL, updated_at = datetime('now')
     WHERE dataset_id = ? AND status IN ('failed', 'quarantined', 'incomplete')`,
    )
      .bind(datasetId)
      .run();
    if (res.meta.changes === 0) {
      return c.json(
        { error: "No failed/quarantined/incomplete import to retry for this dataset" },
        409,
      );
    }
    return c.json({ ok: true, dataset_id: datasetId, status: "preparing" });
  });

  /**
   * POST /admin/imports/:id/verify - force verifyDatasetVersionS3 now (#969).
   * Lets an operator seed a specific dataset into the retry lane without
   * waiting for the reclassification sweep to reach it, or confirm a row is
   * genuinely healthy. On verified-complete, recovers UNCONDITIONALLY (via
   * recoverRow) regardless of prior status: the retry engine blocklists a row
   * WITHOUT changing its status (a blocklisted row can be `quarantined` or
   * `failed`, not just `incomplete`), so gating recovery on
   * status='incomplete' would silently no-op for exactly the rows this
   * endpoint exists to un-park. Always stamps `integrity_checked_at`.
   *
   * Also stamps the `datasets`/`dataset_versions` completeness columns via
   * {@link stampDatasetIntegrity} (#980) for BOTH outcomes -- this is a full
   * per-key verification either way, so a forced check that lands on
   * incomplete is exactly as informative to the catalog as one that lands on
   * complete, and skipping the incomplete branch would leave the column NULL
   * (or stale) until the general sweep happens to reach the same dataset.
   * The stamp is best-effort catalog bookkeeping, NOT the operator-facing
   * result: a stamp failure must not 500 the response or skip the
   * `import_verify_forced` audit-log write below, so it's caught and logged
   * rather than left to propagate.
   */
  admin.post("/imports/:id/verify", async (c) => {
    const datasetId = c.req.param("id");
    const job = await c.env.DB.prepare("SELECT status FROM import_jobs WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ status: string }>();
    if (!job) return c.json({ error: "No import job for this dataset" }, 404);

    const verified = await verifyDatasetVersionS3(c.env, datasetId);

    if (verified.complete) {
      await recoverRow(c.env.DB, datasetId);
    } else if (job.status === "complete") {
      await c.env.DB.prepare(
        `UPDATE import_jobs
            SET status = 'incomplete',
                first_incomplete_at = COALESCE(first_incomplete_at, datetime('now')),
                next_retry_at = datetime('now'),
                integrity_checked_at = datetime('now'),
                updated_at = datetime('now')
          WHERE dataset_id = ?`,
      )
        .bind(datasetId)
        .run();
    } else {
      await c.env.DB.prepare(
        "UPDATE import_jobs SET integrity_checked_at = datetime('now') WHERE dataset_id = ?",
      )
        .bind(datasetId)
        .run();
    }

    try {
      await stampDatasetIntegrity(c.env.DB, datasetId, verified);
    } catch (err) {
      console.error(
        `[imports] verify stamp failed for ${datasetId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    await auditLogStatement(c.env.DB, {
      userId: c.get("user").id,
      action: "import_verify_forced",
      resourceId: datasetId,
      details: JSON.stringify(verified),
    }).run();

    // Explicit pick, not a spread: verifyDatasetVersionS3's runtime result
    // carries extra bytesPresent/declaredBytes/declaredFiles/version fields
    // beyond the declared ImportIntegrityResult return type. A spread would
    // silently leak those onto the wire even though the CLI's
    // ImportVerifyResponse (src/lib/api/admin.ts) doesn't declare them.
    return c.json({
      dataset_id: datasetId,
      complete: verified.complete,
      missingKeys: verified.missingKeys,
      zeroByteKeys: verified.zeroByteKeys,
      expectedCount: verified.expectedCount,
      presentCount: verified.presentCount,
    });
  });

  const dispatchCooldownSchema = z.object({
    dataset_ids: z.array(z.string().min(1)).min(1).max(200),
  });

  /**
   * POST /admin/imports/dispatch-cooldown - push `next_retry_at` forward for
   * datasets `recover --execute` just dispatched out-of-band (#981).
   *
   * The Phase-2 retry cron (services/import-retry.ts sweepImportRetries)
   * independently scans `incomplete` rows with `next_retry_at <= now` and
   * re-dispatches onboard-openneuro.yml for them. `recover --execute`
   * reclassifies a row to `incomplete` with `next_retry_at = now` (see
   * /imports/:id/verify above) and then dispatches the same workflow itself,
   * so without this call the next cron tick can re-dispatch the very same
   * dataset a second time. +6 hours mirrors the retry engine's base backoff
   * (RETRY_BACKOFF_BASE_MS, services/import-retry.ts) -- long enough that
   * recover's own dispatch is well underway before the cron would otherwise
   * reconsider these rows.
   *
   * The WHERE mirrors IMPORT_RETRY_CANDIDATES_QUERY's cron-eligible status
   * set (`incomplete`, `failed`, `quarantined`) rather than pinning to
   * `incomplete` alone: `recover --execute`'s verify step does NOT reduce
   * every target to a two-outcome complete/incomplete model -- that
   * collapse only happens for a target that started `complete` (see
   * /imports/:id/verify above). A target that was already `failed` or
   * `quarantined` (e.g. a now-recoverable upstream-inaccessible row) stays
   * in that status through verify and is still dispatched here, so it must
   * be protected too or the cron can re-dispatch it a second time (the same
   * #981 bug, just for the failed/quarantined branch). `complete` is
   * deliberately excluded: verify already moved a genuinely-incomplete row
   * off `complete`, so a target still `complete` has nothing for the cron
   * to re-dispatch. `blocklisted` rows aren't added to the WHERE either --
   * a blocklisted row isn't a cron candidate regardless of status, so its
   * cooldown state is moot. Also deliberately does NOT touch
   * `recovery_attempts`: a manual recover is an operator action, not a
   * retry-engine dispatch, and must not burn the automatic retry budget.
   */
  admin.post(
    "/imports/dispatch-cooldown",
    zValidator("json", dispatchCooldownSchema),
    async (c) => {
      const { dataset_ids } = c.req.valid("json");
      const db = c.env.DB;

      const placeholders = dataset_ids.map(() => "?").join(", ");
      const result = await db
        .prepare(
          `UPDATE import_jobs
              SET next_retry_at = datetime('now', '+6 hours'), updated_at = datetime('now')
            WHERE dataset_id IN (${placeholders})
              AND status IN ('incomplete', 'failed', 'quarantined')`,
        )
        .bind(...dataset_ids)
        .run();
      const updated = result.meta.changes ?? 0;

      await auditLogStatement(db, {
        userId: c.get("user").id,
        action: "import_dispatch_cooldown",
        resourceType: "dataset",
        resourceId: dataset_ids.join(","),
        details: JSON.stringify({ dataset_ids, updated }),
      }).run();

      return c.json({ updated });
    },
  );
}
