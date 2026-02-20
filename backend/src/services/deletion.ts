/**
 * Dataset cascade deletion service
 *
 * Shared logic for deleting a dataset and all its associated resources:
 * GitHub repo, S3 objects, and D1 database records. Used by both the
 * admin DELETE endpoint and the scheduled cleanup cron.
 */

import type { Bindings } from "../types/bindings.js";
import { isValidDatasetId } from "./datasetId.js";
import { deleteRepository } from "./github.js";
import { type DeleteResult, deleteDatasetObjects } from "./s3.js";

export interface DeletionSteps {
  github: { success: boolean; error?: string };
  s3: DeleteResult & { skipped?: boolean };
  d1: { success: boolean; versionsDeleted: number; pubRequestsDeleted: number; error?: string };
}

export interface DeletionResult {
  datasetId: string;
  deleted: boolean;
  steps: DeletionSteps;
  warnings: string[];
}

/**
 * Delete a dataset and all associated resources.
 *
 * Steps:
 * 1. Delete GitHub repository (idempotent, continues on 404)
 * 2. Delete S3 objects (unless skipS3 is set)
 * 3. Delete D1 records (dataset_versions, publication_requests,
 *    dataset_collaborators, datasets) in a single atomic batch
 */
export async function deleteDatasetCascade(
  db: D1Database,
  env: Bindings,
  datasetId: string,
  options: { skipS3?: boolean; bypassGovernance?: boolean } = {},
): Promise<DeletionResult> {
  if (!isValidDatasetId(datasetId)) {
    throw new Error(`Invalid dataset ID: "${datasetId}"`);
  }

  const warnings: string[] = [];
  const steps: DeletionSteps = {
    github: { success: false },
    s3: { deleted: 0, failed: [], skipped: false },
    d1: { success: false, versionsDeleted: 0, pubRequestsDeleted: 0 },
  };

  // Step 1: Delete GitHub repository
  try {
    await deleteRepository(datasetId, env.GITHUB_ADMIN_PAT);
    steps.github.success = true;
  } catch (err) {
    steps.github.error = err instanceof Error ? err.message : String(err);
    warnings.push(`GitHub repo deletion failed: ${steps.github.error}`);
  }

  // Step 2: Delete S3 objects
  if (options.skipS3) {
    steps.s3.skipped = true;
  } else {
    try {
      const s3Options = {
        bucket: env.S3_BUCKET,
        region: env.AWS_REGION,
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      };
      const s3Result = await deleteDatasetObjects(
        s3Options,
        datasetId,
        options.bypassGovernance ?? false,
      );
      steps.s3.deleted = s3Result.deleted;
      steps.s3.failed = s3Result.failed;
      if (s3Result.failed.length > 0) {
        warnings.push(`${s3Result.failed.length} S3 objects failed to delete`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`S3 deletion failed: ${msg}`);
      steps.s3.failed.push({ key: `${datasetId}/*`, error: msg });
    }
  }

  // Step 3: Delete D1 records (batched for atomicity)
  try {
    const batchResults = await db.batch([
      db.prepare("DELETE FROM dataset_versions WHERE dataset_id = ?").bind(datasetId),
      db.prepare("DELETE FROM publication_requests WHERE dataset_id = ?").bind(datasetId),
      db
        .prepare(
          "DELETE FROM dataset_collaborators WHERE dataset_id IN (SELECT id FROM datasets WHERE dataset_id = ?)",
        )
        .bind(datasetId),
      db.prepare("DELETE FROM user_s3_permissions WHERE s3_prefix = ?").bind(datasetId),
      db.prepare("DELETE FROM datasets WHERE dataset_id = ?").bind(datasetId),
    ]);

    steps.d1.versionsDeleted = batchResults[0].meta.changes ?? 0;
    steps.d1.pubRequestsDeleted = batchResults[1].meta.changes ?? 0;
    steps.d1.success = true;
  } catch (err) {
    steps.d1.error = err instanceof Error ? err.message : String(err);
    warnings.push(`D1 cleanup failed: ${steps.d1.error}`);
  }

  return {
    datasetId,
    deleted:
      steps.d1.success && steps.github.success && (options.skipS3 || steps.s3.failed.length === 0),
    steps,
    warnings,
  };
}
