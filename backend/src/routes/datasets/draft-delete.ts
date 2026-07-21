/**
 * Owner-callable draft deletion (#575): DELETE /datasets/:id for private,
 * DOI-less datasets with no active publication request.
 *
 * Moved verbatim from routes/datasets.ts (#906, epic #902); the only
 * intentional changes are import paths and the register-function wrapper.
 */

import { authMiddleware } from "../../middleware/auth";
import { deleteDatasetCascade } from "../../services/deletion";
import { hasRole } from "../../types/bindings";
import type { DatasetsRouter } from "./shared";

export type DraftDeletability = { deletable: true } | { deletable: false; reason: string };

/**
 * Pure draft-deletability guard for owner-callable DELETE /datasets/:id (#575).
 * A dataset is an owner-deletable draft only when it is private, has no concept
 * DOI, and has no active publication request. Returns the reason the first
 * failing guard trips so the dashboard can explain the disabled action.
 */
export function evaluateDraftDeletability(args: {
  visibility: string | null;
  conceptDoi: string | null;
  activePubRequests: number;
}): DraftDeletability {
  if (args.visibility !== "private") {
    return {
      deletable: false,
      reason: "Dataset is public; deleting a published dataset is an admin operation.",
    };
  }
  if (args.conceptDoi !== null) {
    return {
      deletable: false,
      reason: "Dataset has a concept DOI; deleting it is an admin operation.",
    };
  }
  if (args.activePubRequests > 0) {
    return {
      deletable: false,
      reason: "Dataset has an active publication request; deny or complete it first.",
    };
  }
  return { deletable: true };
}

export function registerDraftDeleteRoutes(datasetRoutes: DatasetsRouter): void {
  /**
   * DELETE /datasets/:id - Owner-callable draft delete (#575).
   *
   * Self-service deletion for the dashboard. Allowed for the owner (or an admin)
   * only when the dataset is an unpublished draft: private, no concept DOI, and no
   * active publication request. Published datasets stay on the admin path
   * (DELETE /admin/datasets/:id), which owns the DOI-lifecycle conversation.
   * Returns 403 not_deletable (+ reason) when a guard trips, 204 on success.
   */
  datasetRoutes.delete("/:id", authMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const currentUser = c.get("user");
    const db = c.env.DB;

    const dataset = await db
      .prepare(
        "SELECT id, name, owner_user_id, visibility, concept_doi FROM datasets WHERE dataset_id = ?",
      )
      .bind(datasetId)
      .first<{
        id: number;
        name: string;
        owner_user_id: number;
        visibility: string | null;
        concept_doi: string | null;
      }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    if (dataset.owner_user_id !== currentUser.id && !hasRole(currentUser.role, "admin")) {
      return c.json({ error: "Only the dataset owner or an admin can delete this dataset" }, 403);
    }

    // Draft-only guards (pure decision in evaluateDraftDeletability). A failure
    // returns 403 not_deletable with the specific reason so the dashboard can
    // explain why the action is unavailable.
    // Block on a request the pipeline/admin is actively engaged with: 'requested'
    // (awaiting admin) or 'approving' (orchestrator running). 'blocked' is
    // deliberately NOT here -- a blocked request is a user-stalled CI failure the
    // owner owns, and letting them discard that draft is the whole point of #575.
    // ('approved' is not a real status; the valid set is requested/approving/
    // published/denied/blocked.)
    const activePubReq = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM publication_requests WHERE dataset_id = ? AND status IN ('requested', 'approving')",
      )
      .bind(datasetId)
      .first<{ count: number }>();
    const deletability = evaluateDraftDeletability({
      visibility: dataset.visibility,
      conceptDoi: dataset.concept_doi,
      activePubRequests: activePubReq?.count ?? 0,
    });
    if (!deletability.deletable) {
      return c.json({ error: "not_deletable", reason: deletability.reason }, 403);
    }

    const result = await deleteDatasetCascade(db, c.env, datasetId, {});

    // Audit log (best-effort).
    try {
      await db
        .prepare("INSERT INTO audit_log (action, user_id, details) VALUES (?, ?, ?)")
        .bind(
          "dataset_deleted",
          currentUser.id,
          JSON.stringify({
            dataset_id: datasetId,
            dataset_name: dataset.name,
            owner_user_id: dataset.owner_user_id,
            via: "owner_draft_delete",
            steps: result.steps,
            warnings: result.warnings,
          }),
        )
        .run();
    } catch (err) {
      console.error("Failed to write owner-delete audit log:", err);
      result.warnings.push("Audit log write failed");
    }

    // 204 on a clean cascade; 207 (with the partial result) if a step failed so
    // the dashboard can surface what was left behind. A delete can be "deleted"
    // yet carry non-fatal warnings (e.g. Vectorize / bucket-policy cleanup); the
    // 204 can't carry a body, so log them (they're also persisted in the audit
    // row) rather than dropping them silently.
    if (result.deleted) {
      if (result.warnings.length > 0) {
        console.warn(
          `[owner-delete] ${datasetId} deleted with non-fatal warnings:`,
          result.warnings,
        );
      }
      return c.body(null, 204);
    }
    return c.json(result, 207);
  });
}
