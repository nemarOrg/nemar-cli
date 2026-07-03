/**
 * Version manifests: list manifests, fetch a version manifest, and the
 * authenticated versions listing.
 *
 * Moved verbatim from routes/datasets.ts (#906, epic #902); the only
 * intentional changes are import paths and the register-function wrapper.
 */

import { authMiddleware, optionalAuthMiddleware } from "../../middleware/auth";
import { getFileContent } from "../../services/github";
import { getDatasetsToken } from "../../services/github-auth";
import { getManifest, listManifests } from "../../services/s3";
import { hasRole } from "../../types/bindings";
import { extractRepoName } from "./shared";
import type { DatasetsRouter } from "./shared";

export function registerManifestRoutes(datasetRoutes: DatasetsRouter): void {
  // ============================================================================
  // Version Manifests
  // ============================================================================

  /**
   * GET /datasets/:id/manifest - List available version manifests
   */
  datasetRoutes.get("/:id/manifest", optionalAuthMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const db = c.env.DB;

    const dataset = await db
      .prepare("SELECT dataset_id, visibility, owner_user_id FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ dataset_id: string; visibility: string; owner_user_id: number }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    // Public datasets: anyone can view manifests
    // Private datasets: only owner/admin
    if (dataset.visibility !== "public") {
      const user = c.get("user");
      if (!user || (!hasRole(user.role, "admin") && user.id !== dataset.owner_user_id)) {
        return c.json({ error: "Access denied" }, 403);
      }
    }

    const s3Options = {
      bucket: c.env.S3_BUCKET,
      region: c.env.AWS_REGION,
      accessKeyId: c.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
    };

    const versions = await listManifests(s3Options, datasetId);

    return c.json({
      dataset_id: datasetId,
      versions,
    });
  });

  /**
   * GET /datasets/:id/manifest/:version - Get a specific version manifest
   */
  datasetRoutes.get("/:id/manifest/:version", optionalAuthMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const version = c.req.param("version");
    const db = c.env.DB;

    const dataset = await db
      .prepare("SELECT dataset_id, visibility, owner_user_id FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ dataset_id: string; visibility: string; owner_user_id: number }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    if (dataset.visibility !== "public") {
      const user = c.get("user");
      if (!user || (!hasRole(user.role, "admin") && user.id !== dataset.owner_user_id)) {
        return c.json({ error: "Access denied" }, 403);
      }
    }

    const s3Options = {
      bucket: c.env.S3_BUCKET,
      region: c.env.AWS_REGION,
      accessKeyId: c.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
    };

    const manifestJson = await getManifest(s3Options, datasetId, version);
    if (!manifestJson) {
      return c.json({ error: "Manifest not found for this version" }, 404);
    }

    return c.json(JSON.parse(manifestJson));
  });

  /**
   * GET /datasets/:id/versions - Get version history for a dataset
   *
   * Returns the current version from dataset_description.json and all
   * recorded version DOIs from the dataset_versions table.
   *
   * Authorization: Owner, collaborator, or admin
   */
  datasetRoutes.get("/:id/versions", authMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const user = c.get("user");
    const db = c.env.DB;

    const dataset = await db
      .prepare(
        "SELECT id, dataset_id, owner_user_id, github_repo FROM datasets WHERE dataset_id = ?",
      )
      .bind(datasetId)
      .first<{
        id: number;
        dataset_id: string;
        owner_user_id: number;
        github_repo: string | null;
      }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    // Check access: owner, admin, or collaborator
    if (!hasRole(user.role, "admin") && user.id !== dataset.owner_user_id) {
      const collabResult = await db
        .prepare("SELECT 1 FROM dataset_collaborators WHERE dataset_id = ? AND user_id = ?")
        .bind(dataset.id, user.id)
        .first();
      if (!collabResult) {
        return c.json({ error: "Access denied" }, 403);
      }
    }

    // Get current version from dataset_description.json via GitHub
    let currentVersion = "1.0.0";
    if (dataset.github_repo) {
      const repoName = extractRepoName(dataset.github_repo);
      if (repoName) {
        try {
          const content = await getFileContent(
            repoName,
            "dataset_description.json",
            await getDatasetsToken(c.env),
          );
          if (content) {
            const desc = JSON.parse(content);
            if (typeof desc.Version === "string") {
              currentVersion = desc.Version;
            }
          }
        } catch (err) {
          console.error(`[versions] Failed to read version for ${datasetId}:`, err);
        }
      }
    }

    // Get version DOIs from database
    const versions = await db
      .prepare(
        "SELECT version, doi, provider, created_at FROM dataset_versions WHERE dataset_id = ? ORDER BY created_at DESC",
      )
      .bind(datasetId)
      .all<{ version: string; doi: string; provider: string; created_at: string }>();

    return c.json({
      dataset_id: datasetId,
      current_version: currentVersion,
      versions: versions.results ?? [],
    });
  });
}
