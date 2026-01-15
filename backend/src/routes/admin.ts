/**
 * Admin routes
 *
 * Handles user approval, revocation, and management.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { Bindings, Variables } from "../types/bindings";
import { authMiddleware, adminMiddleware } from "../middleware/auth";
import { generateApiKey, hashApiKey } from "../services/token";
import { sendApprovalEmail, sendRevocationEmail } from "../services/email";
import { addCollaboratorToAllRepos, removeCollaboratorFromAllRepos } from "../services/github";
import {
  createDeposition,
  publishDeposition,
  createNewVersion,
  uploadFile,
  getDeposition,
  downloadFile,
  getPrereservedDoi,
  formatRecordUrl,
  type ZenodoMetadata,
} from "../services/zenodo";

export const adminRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// All admin routes require authentication and admin role
adminRoutes.use("*", authMiddleware);
adminRoutes.use("*", adminMiddleware);

/**
 * GET /admin/users - List users with optional status filter
 */
adminRoutes.get("/users", async (c) => {
  const status = c.req.query("status"); // pending, verified, approved, revoked
  const db = c.env.DB;

  let query = `
    SELECT
      id, username, email, github_username, status,
      email_verified, is_admin, created_at, approved_at, revoked_at
    FROM users
  `;
  const params: string[] = [];

  if (status) {
    query += " WHERE status = ?";
    params.push(status);
  }

  query += " ORDER BY created_at DESC";

  const users = await db.prepare(query).bind(...params).all();

  return c.json({
    users: users.results,
    count: users.results.length,
  });
});

/**
 * GET /admin/users/:username - Get details for a specific user
 */
adminRoutes.get("/users/:username", async (c) => {
  const username = c.req.param("username");
  const db = c.env.DB;

  const user = await db
    .prepare(
      `
    SELECT
      u.*,
      (SELECT COUNT(*) FROM datasets WHERE owner_user_id = u.id) as dataset_count,
      (SELECT COUNT(*) FROM tokens WHERE user_id = u.id AND revoked_at IS NULL) as active_tokens
    FROM users u
    WHERE u.username = ?
  `
    )
    .bind(username)
    .first();

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json({ user });
});

/**
 * POST /admin/approve/:username - Approve a user and generate API token
 */
adminRoutes.post("/approve/:username", async (c) => {
  const username = c.req.param("username");
  const db = c.env.DB;
  const adminUser = c.get("user");

  // Find user
  const user = await db
    .prepare("SELECT id, username, email, github_username, status FROM users WHERE username = ?")
    .bind(username)
    .first<{
      id: number;
      username: string;
      email: string;
      github_username: string;
      status: string;
    }>();

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  if (user.status === "approved") {
    return c.json({ error: "User already approved" }, 400);
  }

  if (user.status !== "verified") {
    return c.json(
      {
        error: "User has not verified email",
        status: user.status,
        message: user.status === "pending" ? "User needs to verify their email first" : "User status is not eligible for approval",
      },
      400
    );
  }

  // Generate API token
  const { apiKey, apiKeyPrefix } = generateApiKey();
  const hashedKey = await hashApiKey(apiKey);

  // Update user status
  await db
    .prepare(
      `
    UPDATE users
    SET status = 'approved',
        approved_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `
    )
    .bind(user.id)
    .run();

  // Create token
  await db
    .prepare(
      `
    INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, name)
    VALUES (?, ?, ?, 'Primary Token')
  `
    )
    .bind(user.id, hashedKey, apiKeyPrefix)
    .run();

  // Add user as collaborator to all existing repos
  let reposAdded = 0;
  let repoErrors: string[] = [];

  try {
    const result = await addCollaboratorToAllRepos(user.github_username, c.env.GITHUB_ADMIN_PAT);
    reposAdded = result.count;
    repoErrors = result.errors;
  } catch (error) {
    console.error("Failed to add collaborator to repos:", error);
  }

  // Send approval email with API key
  try {
    await sendApprovalEmail(user.email, user.username, apiKey, c.env.RESEND_API_KEY);
  } catch (error) {
    console.error("Failed to send approval email:", error);
  }

  // Audit log
  await db
    .prepare(
      `
    INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
    VALUES (?, 'user_approved', 'user', ?, ?)
  `
    )
    .bind(
      adminUser.id,
      user.username,
      JSON.stringify({
        approved_by: adminUser.username,
        repos_added: reposAdded,
        repo_errors: repoErrors,
      })
    )
    .run();

  return c.json({
    message: `User ${username} has been approved`,
    repos_added: reposAdded,
    repo_errors: repoErrors.length > 0 ? repoErrors : undefined,
  });
});

/**
 * POST /admin/revoke/:username - Revoke a user's access
 */
adminRoutes.post("/revoke/:username", async (c) => {
  const username = c.req.param("username");
  const db = c.env.DB;
  const adminUser = c.get("user");

  // Prevent self-revocation
  if (username === adminUser.username) {
    return c.json({ error: "Cannot revoke your own access" }, 400);
  }

  // Find user
  const user = await db
    .prepare("SELECT id, username, email, github_username, status FROM users WHERE username = ?")
    .bind(username)
    .first<{
      id: number;
      username: string;
      email: string;
      github_username: string;
      status: string;
    }>();

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  if (user.status === "revoked") {
    return c.json({ error: "User already revoked" }, 400);
  }

  // Revoke all tokens
  await db
    .prepare(
      `
    UPDATE tokens
    SET revoked_at = datetime('now')
    WHERE user_id = ? AND revoked_at IS NULL
  `
    )
    .bind(user.id)
    .run();

  // Update user status
  await db
    .prepare(
      `
    UPDATE users
    SET status = 'revoked',
        revoked_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `
    )
    .bind(user.id)
    .run();

  // Remove from all repos
  let reposRemoved = 0;

  try {
    const result = await removeCollaboratorFromAllRepos(user.github_username, c.env.GITHUB_ADMIN_PAT);
    reposRemoved = result.count;
  } catch (error) {
    console.error("Failed to remove collaborator from repos:", error);
  }

  // Send revocation email
  try {
    await sendRevocationEmail(user.email, user.username, c.env.RESEND_API_KEY);
  } catch (error) {
    console.error("Failed to send revocation email:", error);
  }

  // Audit log
  await db
    .prepare(
      `
    INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
    VALUES (?, 'user_revoked', 'user', ?, ?)
  `
    )
    .bind(
      adminUser.id,
      user.username,
      JSON.stringify({
        revoked_by: adminUser.username,
        repos_removed: reposRemoved,
      })
    )
    .run();

  return c.json({
    message: `User ${username} access has been revoked`,
    repos_removed: reposRemoved,
  });
});

/**
 * GET /admin/stats - Get system statistics
 */
adminRoutes.get("/stats", async (c) => {
  const db = c.env.DB;

  const stats = await db
    .prepare(
      `
    SELECT
      (SELECT COUNT(*) FROM users) as total_users,
      (SELECT COUNT(*) FROM users WHERE status = 'pending') as pending_users,
      (SELECT COUNT(*) FROM users WHERE status = 'verified') as verified_users,
      (SELECT COUNT(*) FROM users WHERE status = 'approved') as approved_users,
      (SELECT COUNT(*) FROM users WHERE status = 'revoked') as revoked_users,
      (SELECT COUNT(*) FROM datasets) as total_datasets,
      (SELECT COUNT(*) FROM tokens WHERE revoked_at IS NULL) as active_tokens
  `
    )
    .first();

  return c.json({ stats });
});

/**
 * GET /admin/audit - Get audit log
 */
adminRoutes.get("/audit", async (c) => {
  const limit = parseInt(c.req.query("limit") || "50", 10);
  const offset = parseInt(c.req.query("offset") || "0", 10);
  const db = c.env.DB;

  const logs = await db
    .prepare(
      `
    SELECT
      a.*,
      u.username as actor_username
    FROM audit_log a
    LEFT JOIN users u ON a.user_id = u.id
    ORDER BY a.timestamp DESC
    LIMIT ? OFFSET ?
  `
    )
    .bind(limit, offset)
    .all();

  return c.json({
    logs: logs.results,
    count: logs.results.length,
  });
});

// ============================================================================
// DOI Management
// ============================================================================

/**
 * POST /admin/datasets/:id/doi/concept - Create concept DOI for a dataset
 *
 * WARNING: DOIs are PERMANENT and cannot be deleted.
 * This creates a pre-reserved DOI on Zenodo without publishing it.
 * The DOI becomes active when published.
 */
const createConceptDoiSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  authors: z
    .array(
      z.object({
        name: z.string(),
        affiliation: z.string().optional(),
      })
    )
    .optional(),
  sandbox: z.boolean().optional().default(false),
});

adminRoutes.post("/datasets/:id/doi/concept", zValidator("json", createConceptDoiSchema), async (c) => {
  const datasetId = c.req.param("id");
  const body = c.req.valid("json");
  const adminUser = c.get("user");
  const db = c.env.DB;

  // Get dataset info
  const dataset = await db
    .prepare(
      `
    SELECT d.*, u.username as owner_username
    FROM datasets d
    JOIN users u ON d.owner_user_id = u.id
    WHERE d.dataset_id = ?
  `
    )
    .bind(datasetId)
    .first<{
      id: number;
      dataset_id: string;
      name: string;
      description: string | null;
      github_repo: string | null;
      concept_doi: string | null;
      zenodo_concept_id: string | null;
      owner_username: string;
    }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  if (dataset.concept_doi) {
    return c.json(
      {
        error: "Dataset already has a concept DOI",
        concept_doi: dataset.concept_doi,
        zenodo_url: dataset.zenodo_concept_id
          ? formatRecordUrl(parseInt(dataset.zenodo_concept_id), body.sandbox)
          : null,
      },
      400
    );
  }

  // Prepare metadata
  const metadata: ZenodoMetadata = {
    title: body.title || `${dataset.name} - BIDS Dataset`,
    description: body.description || dataset.description || `BIDS-formatted dataset: ${dataset.name}`,
    creators: body.authors || [{ name: dataset.owner_username }],
    keywords: ["BIDS", "neuroscience", "neuroimaging", "NEMAR"],
    license: "cc-by-nc-4.0",
    related_identifiers: dataset.github_repo
      ? [
          {
            identifier: `https://github.com/${dataset.github_repo}`,
            relation: "isSupplementTo",
            resource_type: "dataset",
          },
        ]
      : undefined,
  };

  // Get the appropriate Zenodo API key
  const zenodoToken = body.sandbox ? c.env.ZENODO_SANDBOX_API_KEY : c.env.ZENODO_API_KEY;

  if (!zenodoToken) {
    return c.json(
      {
        error: body.sandbox
          ? "Zenodo sandbox API key not configured"
          : "Zenodo API key not configured",
      },
      500
    );
  }

  try {
    // Create deposition on Zenodo (pre-reserve DOI)
    const deposition = await createDeposition(metadata, zenodoToken, body.sandbox);

    const conceptDoi = getPrereservedDoi(deposition);
    if (!conceptDoi) {
      throw new Error("Zenodo did not return a pre-reserved DOI");
    }

    // Update dataset with DOI info
    await db
      .prepare(
        `
      UPDATE datasets
      SET concept_doi = ?,
          zenodo_concept_id = ?,
          updated_at = datetime('now')
      WHERE dataset_id = ?
    `
      )
      .bind(conceptDoi, deposition.id.toString(), datasetId)
      .run();

    // Audit log
    await db
      .prepare(
        `
      INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
      VALUES (?, 'doi_concept_created', 'dataset', ?, ?)
    `
      )
      .bind(
        adminUser.id,
        datasetId,
        JSON.stringify({
          concept_doi: conceptDoi,
          zenodo_id: deposition.id,
          sandbox: body.sandbox,
        })
      )
      .run();

    // Generate the repo name for the setup command
    const repoName = dataset.github_repo ? dataset.github_repo.split("/")[1] : datasetId;

    return c.json({
      message: "Concept DOI created successfully",
      concept_doi: conceptDoi,
      zenodo_id: deposition.id,
      zenodo_url: formatRecordUrl(deposition.id, body.sandbox),
      setup_command: `gh secret set NEMAR_WEBHOOK_TOKEN --repo nemarDatasets/${repoName}`,
      warning: "DOI is pre-reserved but not yet published. It will become active on first version publish.",
    });
  } catch (error) {
    console.error("Failed to create concept DOI:", error);
    return c.json(
      {
        error: "Failed to create concept DOI",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

/**
 * POST /admin/datasets/:id/doi/publish - Publish a version DOI
 *
 * This is typically called by GitHub Actions on PR merge.
 * It creates a new version DOI under the concept DOI.
 */
const publishVersionDoiSchema = z.object({
  version: z.string(),
  release_url: z.string().url(),
  sandbox: z.boolean().optional().default(false),
});

adminRoutes.post("/datasets/:id/doi/publish", zValidator("json", publishVersionDoiSchema), async (c) => {
  const datasetId = c.req.param("id");
  const body = c.req.valid("json");
  const adminUser = c.get("user");
  const db = c.env.DB;

  // Get dataset info
  const dataset = await db
    .prepare(
      `
    SELECT d.*, u.username as owner_username
    FROM datasets d
    JOIN users u ON d.owner_user_id = u.id
    WHERE d.dataset_id = ?
  `
    )
    .bind(datasetId)
    .first<{
      id: number;
      dataset_id: string;
      name: string;
      description: string | null;
      concept_doi: string | null;
      zenodo_concept_id: string | null;
      zenodo_latest_version_id: string | null;
      owner_username: string;
    }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  if (!dataset.concept_doi || !dataset.zenodo_concept_id) {
    return c.json(
      {
        error: "Dataset does not have a concept DOI",
        message: "Create a concept DOI first with POST /admin/datasets/:id/doi/concept",
      },
      400
    );
  }

  const zenodoToken = body.sandbox ? c.env.ZENODO_SANDBOX_API_KEY : c.env.ZENODO_API_KEY;

  if (!zenodoToken) {
    return c.json({ error: "Zenodo API key not configured" }, 500);
  }

  try {
    // Check if this is the first version (concept deposition not yet published)
    const conceptDeposition = await getDeposition(
      parseInt(dataset.zenodo_concept_id),
      zenodoToken,
      body.sandbox
    );

    let versionDeposition;

    if (!conceptDeposition.submitted) {
      // First version - use the concept deposition directly
      versionDeposition = conceptDeposition;

      // Update metadata with version
      // Note: We'd typically update metadata here, but for simplicity we'll proceed
    } else {
      // Create a new version
      versionDeposition = await createNewVersion(
        parseInt(dataset.zenodo_concept_id),
        zenodoToken,
        body.sandbox
      );
    }

    // Download the release zip from GitHub
    const releaseZipUrl = body.release_url.endsWith(".zip")
      ? body.release_url
      : `${body.release_url.replace(/\/$/, "")}/archive/refs/tags/${body.version}.zip`;

    console.log(`Downloading release from: ${releaseZipUrl}`);

    const zipContent = await downloadFile(releaseZipUrl);
    const zipFilename = `${datasetId}-${body.version}.zip`;

    // Upload to Zenodo
    if (versionDeposition.links.bucket) {
      await uploadFile(
        versionDeposition.id,
        versionDeposition.links.bucket,
        zipFilename,
        zipContent,
        zenodoToken
      );
    } else {
      throw new Error("Zenodo deposition has no bucket URL for uploads");
    }

    // Publish the deposition
    const publishedDeposition = await publishDeposition(
      versionDeposition.id,
      zenodoToken,
      body.sandbox
    );

    const versionDoi = publishedDeposition.doi || publishedDeposition.metadata?.doi;

    // Update dataset with version DOI
    await db
      .prepare(
        `
      UPDATE datasets
      SET latest_version_doi = ?,
          zenodo_latest_version_id = ?,
          updated_at = datetime('now')
      WHERE dataset_id = ?
    `
      )
      .bind(versionDoi || null, publishedDeposition.id.toString(), datasetId)
      .run();

    // Audit log
    await db
      .prepare(
        `
      INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
      VALUES (?, 'doi_version_published', 'dataset', ?, ?)
    `
      )
      .bind(
        adminUser.id,
        datasetId,
        JSON.stringify({
          version: body.version,
          version_doi: versionDoi,
          zenodo_id: publishedDeposition.id,
          sandbox: body.sandbox,
        })
      )
      .run();

    return c.json({
      message: "Version DOI published successfully",
      version: body.version,
      version_doi: versionDoi,
      concept_doi: dataset.concept_doi,
      zenodo_url: formatRecordUrl(publishedDeposition.id, body.sandbox),
      warning: "DOI is now PERMANENT and cannot be deleted.",
    });
  } catch (error) {
    console.error("Failed to publish version DOI:", error);
    return c.json(
      {
        error: "Failed to publish version DOI",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

/**
 * GET /admin/datasets/:id/doi - Get DOI info for a dataset
 */
adminRoutes.get("/datasets/:id/doi", async (c) => {
  const datasetId = c.req.param("id");
  const db = c.env.DB;

  const dataset = await db
    .prepare(
      `
    SELECT dataset_id, name, concept_doi, latest_version_doi, zenodo_concept_id, zenodo_latest_version_id
    FROM datasets
    WHERE dataset_id = ?
  `
    )
    .bind(datasetId)
    .first<{
      dataset_id: string;
      name: string;
      concept_doi: string | null;
      latest_version_doi: string | null;
      zenodo_concept_id: string | null;
      zenodo_latest_version_id: string | null;
    }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  return c.json({
    dataset_id: dataset.dataset_id,
    name: dataset.name,
    concept_doi: dataset.concept_doi,
    latest_version_doi: dataset.latest_version_doi,
    zenodo_concept_url: dataset.zenodo_concept_id
      ? formatRecordUrl(parseInt(dataset.zenodo_concept_id))
      : null,
    zenodo_latest_version_url: dataset.zenodo_latest_version_id
      ? formatRecordUrl(parseInt(dataset.zenodo_latest_version_id))
      : null,
  });
});
