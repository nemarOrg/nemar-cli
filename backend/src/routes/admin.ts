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
import { removeCollaborator } from "../services/github";
import { encrypt, decrypt } from "../services/encryption";
import {
  setupUserIamAccess,
  revokeUserIamAccess,
  generateIamUsername,
} from "../services/iam";
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
    return c.json({ error: "User already approved" }, 409);
  }

  // Allow approval of verified users OR re-approval of revoked users
  if (user.status !== "verified" && user.status !== "revoked") {
    return c.json(
      {
        error: "User is not eligible for approval",
        status: user.status,
        message: user.status === "pending" ? "User needs to verify their email first" : "User status is not eligible for approval",
      },
      400,
    );
  }

  // Generate API token
  const { apiKey, apiKeyPrefix } = generateApiKey();
  const hashedKey = await hashApiKey(apiKey);

  // Create per-user IAM credentials for S3 access
  let iamSetupSuccess = false;
  let iamUsername = "";
  let iamSetupError = "";
  try {
    // Check if encryption key is configured
    if (!c.env.ENCRYPTION_KEY) {
      throw new Error("ENCRYPTION_KEY not configured");
    }

    // Setup IAM user with access keys
    const iamResult = await setupUserIamAccess(
      {
        accessKeyId: c.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
        region: c.env.AWS_REGION,
      },
      c.env.S3_BUCKET,
      user.username,
    );

    iamUsername = iamResult.iamUsername;

    // Encrypt and store credentials
    const encryptedAccessKeyId = await encrypt(iamResult.accessKeyId, c.env.ENCRYPTION_KEY);
    const encryptedSecretAccessKey = await encrypt(iamResult.secretAccessKey, c.env.ENCRYPTION_KEY);

    // Update user with IAM credentials
    await db
      .prepare(
        `
      UPDATE users
      SET aws_iam_username = ?,
          aws_access_key_id_encrypted = ?,
          aws_secret_access_key_encrypted = ?
      WHERE id = ?
    `,
      )
      .bind(iamUsername, encryptedAccessKeyId, encryptedSecretAccessKey, user.id)
      .run();

    iamSetupSuccess = true;
  } catch (error) {
    console.error("Failed to setup IAM access for user:", error);
    iamSetupError = error instanceof Error ? error.message : "Unknown error";
    // Continue with approval even if IAM setup fails
    // Admin can manually set up IAM later
  }

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

  // Note: We no longer auto-add users to all repos
  // Users request access to specific datasets via `nemar dataset request-access`

  // Send approval email with API key
  let emailSent = false;
  try {
    await sendApprovalEmail(user.email, user.username, apiKey, c.env.RESEND_API_KEY);
    emailSent = true;
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
        email_sent: emailSent,
        iam_setup: iamSetupSuccess,
        iam_username: iamUsername || null,
      })
    )
    .run();

  return c.json({
    message: `User ${username} has been approved`,
    user: {
      username: user.username,
      email: user.email,
      status: "approved",
    },
    api_key: apiKey,
    email_sent: emailSent,
    iam_setup: iamSetupSuccess,
    iam_username: iamUsername || undefined,
    iam_error: iamSetupError || undefined,
    warning: !iamSetupSuccess
      ? `IAM setup failed: ${iamSetupError}. User will not be able to upload datasets until IAM is configured manually.`
      : undefined,
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

  // Find user (include IAM credentials for revocation)
  const user = await db
    .prepare(`
      SELECT id, username, email, github_username, status,
             aws_iam_username, aws_access_key_id_encrypted
      FROM users WHERE username = ?
    `)
    .bind(username)
    .first<{
      id: number;
      username: string;
      email: string;
      github_username: string;
      status: string;
      aws_iam_username: string | null;
      aws_access_key_id_encrypted: string | null;
    }>();

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  if (user.status === "revoked") {
    return c.json({ error: "User already revoked" }, 409);
  }

  // Revoke IAM access if configured - SECURITY CRITICAL
  let iamRevoked = false;
  if (user.aws_iam_username && user.aws_access_key_id_encrypted && c.env.ENCRYPTION_KEY) {
    try {
      const accessKeyId = await decrypt(user.aws_access_key_id_encrypted, c.env.ENCRYPTION_KEY);
      await revokeUserIamAccess(
        {
          accessKeyId: c.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
          region: c.env.AWS_REGION,
        },
        user.aws_iam_username,
        accessKeyId,
      );
      iamRevoked = true;
    } catch (error) {
      // SECURITY: IAM revocation failure is critical - user's S3 credentials may still work
      console.error("SECURITY WARNING: Failed to revoke IAM access for", user.username, error);
      return c.json(
        {
          error: "Failed to revoke IAM access - user credentials may still be active",
          details: error instanceof Error ? error.message : "Unknown error",
          security_warning: "User's S3 access keys may still be functional. Manual AWS cleanup required.",
          aws_iam_username: user.aws_iam_username,
          action_required: `Manually delete IAM user '${user.aws_iam_username}' in AWS console or retry revocation`,
        },
        500,
      );
    }
  }

  // Clear IAM credentials from database
  await db
    .prepare(`
      UPDATE users
      SET aws_iam_username = NULL,
          aws_access_key_id_encrypted = NULL,
          aws_secret_access_key_encrypted = NULL
      WHERE id = ?
    `)
    .bind(user.id)
    .run();

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

  // Remove from datasets they have access to (tracked in dataset_collaborators)
  const collaborations = await db
    .prepare("SELECT dc.id, d.github_repo FROM dataset_collaborators dc JOIN datasets d ON dc.dataset_id = d.id WHERE dc.user_id = ?")
    .bind(user.id)
    .all<{ id: number; github_repo: string | null }>();

  let reposRemoved = 0;
  const failedRemovals: string[] = [];
  for (const collab of collaborations.results || []) {
    if (collab.github_repo) {
      // Extract repo name with defensive check
      const parts = collab.github_repo.split("/");
      if (parts.length !== 2 || !parts[1]) {
        console.error(`Invalid github_repo format: ${collab.github_repo}`);
        failedRemovals.push(collab.github_repo);
        continue;
      }
      const repoName = parts[1];
      try {
        await removeCollaborator(repoName, user.github_username, c.env.GITHUB_ADMIN_PAT);
        reposRemoved++;
      } catch (error) {
        console.error(`Failed to remove from ${collab.github_repo}:`, error);
        failedRemovals.push(collab.github_repo);
      }
    }
  }

  // Clear their collaborator records
  await db.prepare("DELETE FROM dataset_collaborators WHERE user_id = ?").bind(user.id).run();

  // Send revocation email
  let emailSent = false;
  try {
    await sendRevocationEmail(user.email, user.username, c.env.RESEND_API_KEY);
    emailSent = true;
  } catch (error) {
    console.error("Failed to send revocation email:", error);
  }

  // Clear S3 permissions
  await db.prepare("DELETE FROM user_s3_permissions WHERE user_id = ?").bind(user.id).run();

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
        failed_removals: failedRemovals,
        email_sent: emailSent,
        iam_revoked: iamRevoked,
      })
    )
    .run();

  return c.json({
    message: `User ${username} access has been revoked`,
    repos_removed: reposRemoved,
    failed_removals: failedRemovals.length > 0 ? failedRemovals : undefined,
    email_sent: emailSent,
    iam_revoked: iamRevoked,
  });
});

/**
 * POST /admin/regenerate-iam/:username - Regenerate IAM credentials for a user
 * Useful when IAM setup failed during approval or credentials need to be rotated
 * Also restores access to all existing datasets the user owns
 */
adminRoutes.post("/regenerate-iam/:username", async (c) => {
  const username = c.req.param("username");
  const db = c.env.DB;
  const adminUser = c.get("user");

  // Find user
  const user = await db
    .prepare(
      `SELECT id, username, email, status, aws_iam_username, aws_access_key_id_encrypted
       FROM users WHERE username = ?`
    )
    .bind(username)
    .first<{
      id: number;
      username: string;
      email: string;
      status: string;
      aws_iam_username: string | null;
      aws_access_key_id_encrypted: string | null;
    }>();

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  if (user.status !== "approved") {
    return c.json({ error: "User must be approved to have IAM credentials" }, 400);
  }

  // Check if encryption key is configured
  if (!c.env.ENCRYPTION_KEY) {
    return c.json({ error: "ENCRYPTION_KEY not configured" }, 500);
  }

  // Get user's existing datasets to restore access
  const datasets = await db
    .prepare("SELECT dataset_id FROM datasets WHERE owner_user_id = ?")
    .bind(user.id)
    .all<{ dataset_id: string }>();

  const datasetPrefixes = datasets.results.map((d) => `datasets/${d.dataset_id}`);

  // Revoke old IAM credentials if they exist (but don't delete the user - we'll reuse it)
  if (user.aws_iam_username && user.aws_access_key_id_encrypted) {
    try {
      const oldAccessKeyId = await decrypt(user.aws_access_key_id_encrypted, c.env.ENCRYPTION_KEY);
      // Only delete the old access key, not the entire IAM user
      const { deleteAccessKey } = await import("../services/iam");
      await deleteAccessKey(
        {
          accessKeyId: c.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
          region: c.env.AWS_REGION,
        },
        user.aws_iam_username,
        oldAccessKeyId
      );
    } catch (error) {
      console.warn("Failed to revoke old access key:", error);
      // Continue anyway - we'll create new ones
    }
  }

  // Create new IAM credentials
  try {
    const { createIamUser, createAccessKey, putUserPolicy, generateS3PolicyDocument, generateIamUsername } =
      await import("../services/iam");

    const iamUsername = generateIamUsername(user.username);

    // Create or get existing IAM user
    await createIamUser(
      {
        accessKeyId: c.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
        region: c.env.AWS_REGION,
      },
      user.username
    );

    // Create new access keys
    const { accessKeyId, secretAccessKey } = await createAccessKey(
      {
        accessKeyId: c.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
        region: c.env.AWS_REGION,
      },
      iamUsername
    );

    // Restore policy with access to all user's datasets
    const policyDocument = generateS3PolicyDocument(c.env.S3_BUCKET, datasetPrefixes);
    await putUserPolicy(
      {
        accessKeyId: c.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
        region: c.env.AWS_REGION,
      },
      iamUsername,
      "nemar-s3-access",
      policyDocument
    );

    // Encrypt and store credentials
    const encryptedAccessKeyId = await encrypt(accessKeyId, c.env.ENCRYPTION_KEY);
    const encryptedSecretAccessKey = await encrypt(secretAccessKey, c.env.ENCRYPTION_KEY);

    // Update user with new IAM credentials
    await db
      .prepare(
        `UPDATE users
         SET aws_iam_username = ?,
             aws_access_key_id_encrypted = ?,
             aws_secret_access_key_encrypted = ?
         WHERE id = ?`
      )
      .bind(iamUsername, encryptedAccessKeyId, encryptedSecretAccessKey, user.id)
      .run();

    // Log the action
    await db
      .prepare("INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)")
      .bind(
        adminUser.id,
        "iam_regenerated",
        "user",
        user.id,
        JSON.stringify({ username: user.username, datasets_restored: datasetPrefixes.length })
      )
      .run();

    return c.json({
      message: "IAM credentials regenerated successfully",
      user: {
        username: user.username,
        iam_username: iamUsername,
      },
      datasets_restored: datasetPrefixes.length,
    });
  } catch (error) {
    console.error("Failed to regenerate IAM credentials:", error);
    return c.json(
      {
        error: "Failed to create IAM credentials",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
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
