/**
 * Admin routes
 *
 * Handles user approval, revocation, and management.
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { adminMiddleware, authMiddleware } from "../middleware/auth";
import {
  sendApprovalEmail,
  sendPublicationApprovedEmail,
  sendPublicationDeniedEmail,
  sendRevocationEmail,
} from "../services/email";
import { decrypt, encrypt } from "../services/encryption";
import {
  checkWorkflowExists,
  deployWorkflows,
  getWorkflowRuns,
  removeCollaborator,
  setRepoVisibility,
} from "../services/github";
import { generateIamUsername, revokeUserIamAccess, setupUserIamAccess } from "../services/iam";
import { generateManifest } from "../services/manifest";
import { applyObjectLock, getManifest, uploadManifest } from "../services/s3";
import { generateApiKey, hashApiKey } from "../services/token";
import {
  type ZenodoDeposition,
  type ZenodoMetadata,
  createDeposition,
  createNewVersion,
  deleteDeposition,
  downloadFile,
  formatRecordUrl,
  getDeposition,
  getPrereservedDoi,
  publishDeposition,
  uploadFile,
} from "../services/zenodo";
import type { Bindings, Variables } from "../types/bindings";

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

  const users = await db
    .prepare(query)
    .bind(...params)
    .all();

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
  `,
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
        message:
          user.status === "pending"
            ? "User needs to verify their email first"
            : "User status is not eligible for approval",
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
  `,
    )
    .bind(user.id)
    .run();

  // Create token
  await db
    .prepare(
      `
    INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, name)
    VALUES (?, ?, ?, 'Primary Token')
  `,
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
  `,
    )
    .bind(
      adminUser.id,
      user.username,
      JSON.stringify({
        approved_by: adminUser.username,
        email_sent: emailSent,
        iam_setup: iamSetupSuccess,
        iam_username: iamUsername || null,
      }),
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
  // Uses owner credentials to forcefully delete ALL access keys
  let iamRevoked = false;
  let iamRevocationError: string | null = null;
  let iamRevocationSteps: string[] = [];

  if (user.aws_iam_username && user.aws_access_key_id_encrypted && c.env.ENCRYPTION_KEY) {
    try {
      const accessKeyId = await decrypt(user.aws_access_key_id_encrypted, c.env.ENCRYPTION_KEY);

      // Use aggressive cleanup with owner credentials
      const result = await revokeUserIamAccess(
        {
          accessKeyId: c.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
          region: c.env.AWS_REGION,
        },
        user.aws_iam_username,
        accessKeyId,
      );

      iamRevoked = result.success;
      iamRevocationSteps = result.steps;

      if (result.errors.length > 0) {
        // Partial failure - some steps succeeded, some failed
        iamRevocationError = result.errors.join("; ");
        console.error(
          "IAM revocation partial failure for",
          user.username,
          "\nErrors:",
          result.errors,
          "\nSteps:",
          result.steps,
        );

        // Track partial failures for follow-up
        try {
          await db
            .prepare(
              `INSERT INTO iam_revocation_failures (user_id, username, iam_username, error_message, created_at)
               VALUES (?, ?, ?, ?, datetime('now'))`,
            )
            .bind(user.id, user.username, user.aws_iam_username, iamRevocationError)
            .run();
        } catch {
          console.error("Could not track IAM failure in database");
        }
      } else {
        // Complete success
        console.log(
          `IAM revocation succeeded for ${user.username}:\n${result.steps.join("\n")}`,
        );
      }
    } catch (error) {
      // Complete failure - couldn't even start cleanup
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.error(
        "CRITICAL SECURITY: Failed to revoke IAM access for",
        user.username,
        errorMessage,
      );

      iamRevocationError = errorMessage;

      // Track complete failures
      try {
        await db
          .prepare(
            `INSERT INTO iam_revocation_failures (user_id, username, iam_username, error_message, created_at)
             VALUES (?, ?, ?, ?, datetime('now'))`,
          )
          .bind(user.id, user.username, user.aws_iam_username, errorMessage)
          .run();
      } catch {
        console.error("Could not track IAM failure in database");
      }
    }
  }

  // Clear IAM credentials from database (even if revocation failed)
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
  `,
    )
    .bind(user.id)
    .run();

  // Update user status
  // If IAM revocation failed, mark as revoked_iam_pending for manual cleanup
  const finalStatus = iamRevoked || !user.aws_iam_username ? "revoked" : "revoked_iam_pending";

  await db
    .prepare(
      `
    UPDATE users
    SET status = ?,
        revoked_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `,
    )
    .bind(finalStatus, user.id)
    .run();

  // Remove from datasets they have access to (tracked in dataset_collaborators)
  const collaborations = await db
    .prepare(
      "SELECT dc.id, d.github_repo FROM dataset_collaborators dc JOIN datasets d ON dc.dataset_id = d.id WHERE dc.user_id = ?",
    )
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
  `,
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
      }),
    )
    .run();

  // If IAM revocation had errors, return warning with detailed steps
  if (iamRevocationError) {
    return c.json(
      {
        warning: iamRevoked
          ? "User revoked with partial IAM cleanup"
          : "User revoked with IAM cleanup failure",
        message: iamRevoked
          ? "User's API tokens revoked. Some IAM cleanup steps failed but S3 access keys were deleted."
          : "User's API tokens and database access revoked, but S3 credentials may still be active",
        user: {
          username: user.username,
          status: finalStatus,
        },
        iam_cleanup: {
          success: iamRevoked,
          errors: iamRevocationError,
          steps_attempted: iamRevocationSteps,
          aws_iam_username: user.aws_iam_username,
        },
        action_required: iamRevoked
          ? [
              "Review IAM cleanup steps above",
              `Check AWS console for user '${user.aws_iam_username}'`,
              "Verify no orphaned resources remain",
            ]
          : [
              `1. Manually delete IAM user '${user.aws_iam_username}' in AWS console`,
              "2. Or use AWS CLI: aws iam list-access-keys --user-name <username>",
              "3. Delete each key: aws iam delete-access-key --user-name <username> --access-key-id <key>",
              "4. Delete user: aws iam delete-user --user-name <username>",
              `5. Update user status: UPDATE users SET status = 'revoked' WHERE username = '${user.username}'`,
            ],
        security_impact: iamRevoked
          ? "Most IAM resources cleaned up. Review steps for any remaining items."
          : "User can still upload/download S3 data until manual cleanup completes",
        repos_removed: reposRemoved,
        failed_removals: failedRemovals.length > 0 ? failedRemovals : undefined,
        email_sent: emailSent,
        iam_revoked: iamRevoked,
      },
      207, // 207 Multi-Status: partial success
    );
  }

  // Full revocation succeeded
  return c.json({
    message: `User ${username} access has been fully revoked`,
    user: {
      username: user.username,
      status: finalStatus,
    },
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
      `SELECT id, username, email, status, is_admin, aws_iam_username, aws_access_key_id_encrypted
       FROM users WHERE username = ?`,
    )
    .bind(username)
    .first<{
      id: number;
      username: string;
      email: string;
      status: string;
      is_admin: number;
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

  const datasetPrefixes = datasets.results.map((d) => d.dataset_id);

  // Track warning if old key revocation fails (security concern)
  let oldKeyRevocationWarning: string | undefined;

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
        oldAccessKeyId,
      );
    } catch (error) {
      console.error("Failed to revoke old access key:", error);
      oldKeyRevocationWarning = `Old access key may still be active: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
  }

  // Create new IAM credentials
  const isAdmin = Boolean(user.is_admin);
  const awsConfig = {
    accessKeyId: c.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
    region: c.env.AWS_REGION,
  };

  try {
    const {
      createIamUser,
      createAccessKey,
      putUserPolicy,
      generateS3PolicyDocument,
      generateAdminS3PolicyDocument,
      generateIamUsername,
      deleteAccessKey,
    } = await import("../services/iam");

    const iamUsername = generateIamUsername(user.username);

    // Create or get existing IAM user
    await createIamUser(awsConfig, user.username);

    // Create new access keys
    const { accessKeyId, secretAccessKey } = await createAccessKey(awsConfig, iamUsername);

    // Restore policy: admins get full bucket access, regular users get their datasets only
    const policyDocument = isAdmin
      ? generateAdminS3PolicyDocument(c.env.S3_BUCKET)
      : generateS3PolicyDocument(c.env.S3_BUCKET, datasetPrefixes);
    await putUserPolicy(awsConfig, iamUsername, "nemar-s3-access", policyDocument);

    // Encrypt and store credentials
    const encryptedAccessKeyId = await encrypt(accessKeyId, c.env.ENCRYPTION_KEY);
    const encryptedSecretAccessKey = await encrypt(secretAccessKey, c.env.ENCRYPTION_KEY);

    // Update user with new IAM credentials - cleanup AWS if this fails
    try {
      await db
        .prepare(
          `UPDATE users
           SET aws_iam_username = ?,
               aws_access_key_id_encrypted = ?,
               aws_secret_access_key_encrypted = ?
           WHERE id = ?`,
        )
        .bind(iamUsername, encryptedAccessKeyId, encryptedSecretAccessKey, user.id)
        .run();
    } catch (dbError) {
      // Cleanup orphaned AWS credentials
      console.error("Database update failed, cleaning up AWS credentials:", dbError);
      try {
        await deleteAccessKey(awsConfig, iamUsername, accessKeyId);
      } catch (cleanupError) {
        console.error("Failed to cleanup AWS credentials after DB failure:", cleanupError);
      }
      throw dbError;
    }

    // Log the action (non-blocking - credentials already created)
    const datasetsRestoredCount = isAdmin ? "all" : datasetPrefixes.length;
    try {
      await db
        .prepare(
          "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(
          adminUser.id,
          "iam_regenerated",
          "user",
          user.username,
          JSON.stringify({
            username: user.username,
            is_admin: isAdmin,
            datasets_restored: datasetsRestoredCount,
          }),
        )
        .run();
    } catch (auditError) {
      console.error("Failed to write audit log for IAM regeneration:", auditError);
      // Do not fail the request - the credential regeneration succeeded
    }

    return c.json({
      message: "IAM credentials regenerated successfully",
      user: {
        username: user.username,
        iam_username: iamUsername,
        is_admin: isAdmin,
      },
      datasets_restored: isAdmin ? "all (full bucket access)" : datasetPrefixes.length,
      warning: oldKeyRevocationWarning,
    });
  } catch (error) {
    console.error("Failed to regenerate IAM credentials:", error);
    return c.json(
      {
        error: "Failed to create IAM credentials",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
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
  `,
    )
    .first();

  return c.json({ stats });
});

/**
 * GET /admin/audit - Get audit log
 */
adminRoutes.get("/audit", async (c) => {
  const limit = Number.parseInt(c.req.query("limit") || "50", 10);
  const offset = Number.parseInt(c.req.query("offset") || "0", 10);
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
  `,
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
      }),
    )
    .optional(),
  sandbox: z.boolean().optional().default(false),
});

adminRoutes.post(
  "/datasets/:id/doi/concept",
  zValidator("json", createConceptDoiSchema),
  async (c) => {
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
  `,
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
        is_sandbox: number | null;
      }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    // Block DOI creation for sandbox datasets
    if (dataset.is_sandbox || dataset.dataset_id.startsWith("xx")) {
      return c.json(
        {
          error: "Cannot create DOI for sandbox datasets",
          message:
            "Sandbox datasets are for testing only. DOIs are permanent and should only be created for real datasets.",
          dataset_id: dataset.dataset_id,
        },
        400,
      );
    }

    // Check if dataset already has a DOI (before environment checks for clearer errors)
    if (dataset.concept_doi) {
      return c.json(
        {
          error: "Dataset already has a concept DOI",
          concept_doi: dataset.concept_doi,
          zenodo_url: dataset.zenodo_concept_id
            ? formatRecordUrl(Number.parseInt(dataset.zenodo_concept_id), body.sandbox)
            : null,
        },
        400,
      );
    }

    // SAFETY: Block production DOI creation in non-production environments
    // Production DOIs create permanent records in DataCite registry and consume DOI quota.
    // Development/staging should only use sandbox to avoid polluting production registry.
    // Only check environment for production DOI requests (skip for sandbox)
    if (!body.sandbox) {
      const environment = c.env.ENVIRONMENT;

      // FAIL CLOSED: If environment is not explicitly set, reject production DOIs
      if (!environment) {
        console.error("SECURITY: ENVIRONMENT variable not configured - blocking production DOI");
        return c.json(
          {
            error: "Server misconfiguration: ENVIRONMENT variable not set",
            message: "Cannot create production DOIs without explicit environment configuration",
            action_required: "Set ENVIRONMENT variable to 'production' in production environment",
          },
          500,
        );
      }

      // Normalize and validate environment
      const normalizedEnv = environment.toLowerCase().trim();
      const validEnvironments = ["production", "development", "staging", "test"];

      if (!validEnvironments.includes(normalizedEnv)) {
        console.error(`SECURITY: Invalid ENVIRONMENT value: ${environment}`);
        return c.json(
          {
            error: "Server misconfiguration: Invalid ENVIRONMENT value",
            message: `ENVIRONMENT must be one of: ${validEnvironments.join(", ")}`,
            current_value: environment,
          },
          500,
        );
      }

      // Block production DOI in non-production
      if (normalizedEnv !== "production") {
        return c.json(
          {
            error: "Production DOI creation blocked in non-production environment",
            message:
              "Cannot create production DOIs in development or test environments. Use --sandbox flag for testing, or deploy to production.",
            environment: normalizedEnv,
            dataset_id: dataset.dataset_id,
          },
          400,
        );
      }
    }

    // Prepare metadata
    const metadata: ZenodoMetadata = {
      title: body.title || `${dataset.name} - BIDS Dataset`,
      description:
        body.description || dataset.description || `BIDS-formatted dataset: ${dataset.name}`,
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
        500,
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
          is_sandbox = ?,
          updated_at = datetime('now')
      WHERE dataset_id = ?
    `,
        )
        .bind(conceptDoi, deposition.id.toString(), body.sandbox ? 1 : 0, datasetId)
        .run();

      // Audit log
      await db
        .prepare(
          `
      INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
      VALUES (?, 'doi_concept_created', 'dataset', ?, ?)
    `,
        )
        .bind(
          adminUser.id,
          datasetId,
          JSON.stringify({
            concept_doi: conceptDoi,
            zenodo_id: deposition.id,
            sandbox: body.sandbox,
          }),
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
        warning:
          "DOI is pre-reserved but not yet published. It will become active on first version publish.",
      });
    } catch (error) {
      console.error("Failed to create concept DOI:", error);
      return c.json(
        {
          error: "Failed to create concept DOI",
          details: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

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

adminRoutes.post(
  "/datasets/:id/doi/publish",
  zValidator("json", publishVersionDoiSchema),
  async (c) => {
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
  `,
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
        is_sandbox: number | null;
      }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    // Block DOI publishing for sandbox datasets
    if (dataset.is_sandbox || dataset.dataset_id.startsWith("xx")) {
      return c.json(
        {
          error: "Cannot publish DOI for sandbox datasets",
          message:
            "Sandbox datasets are for testing only. DOIs are permanent and should only be created for real datasets.",
          dataset_id: dataset.dataset_id,
        },
        400,
      );
    }

    if (!dataset.concept_doi || !dataset.zenodo_concept_id) {
      return c.json(
        {
          error: "Dataset does not have a concept DOI",
          message: "Create a concept DOI first with POST /admin/datasets/:id/doi/concept",
        },
        400,
      );
    }

    const zenodoToken = body.sandbox ? c.env.ZENODO_SANDBOX_API_KEY : c.env.ZENODO_API_KEY;

    if (!zenodoToken) {
      return c.json({ error: "Zenodo API key not configured" }, 500);
    }

    try {
      // Check if this is the first version (concept deposition not yet published)
      const conceptDeposition = await getDeposition(
        Number.parseInt(dataset.zenodo_concept_id),
        zenodoToken,
        body.sandbox,
      );

      let versionDeposition: ZenodoDeposition;

      if (!conceptDeposition.submitted) {
        // First version - use the concept deposition directly
        versionDeposition = conceptDeposition;

        // Update metadata with version
        // Note: We'd typically update metadata here, but for simplicity we'll proceed
      } else {
        // Create a new version
        versionDeposition = await createNewVersion(
          Number.parseInt(dataset.zenodo_concept_id),
          zenodoToken,
          body.sandbox,
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
          zenodoToken,
        );
      } else {
        throw new Error("Zenodo deposition has no bucket URL for uploads");
      }

      // Publish the deposition
      const publishedDeposition = await publishDeposition(
        versionDeposition.id,
        zenodoToken,
        body.sandbox,
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
    `,
        )
        .bind(versionDoi || null, publishedDeposition.id.toString(), datasetId)
        .run();

      // Audit log
      await db
        .prepare(
          `
      INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
      VALUES (?, 'doi_version_published', 'dataset', ?, ?)
    `,
        )
        .bind(
          adminUser.id,
          datasetId,
          JSON.stringify({
            version: body.version,
            version_doi: versionDoi,
            zenodo_id: publishedDeposition.id,
            sandbox: body.sandbox,
          }),
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
        500,
      );
    }
  },
);

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
  `,
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
      ? formatRecordUrl(Number.parseInt(dataset.zenodo_concept_id))
      : null,
    zenodo_latest_version_url: dataset.zenodo_latest_version_id
      ? formatRecordUrl(Number.parseInt(dataset.zenodo_latest_version_id))
      : null,
  });
});

/**
 * DELETE /admin/zenodo/deposition/:id - Delete unpublished Zenodo deposition
 *
 * Used by tests to cleanup unpublished depositions in sandbox.
 * WARNING: Only works for unpublished depositions. Published DOIs cannot be deleted.
 */
adminRoutes.delete("/zenodo/deposition/:id", async (c) => {
  const depositionId = Number.parseInt(c.req.param("id"));
  const sandbox = c.req.query("sandbox") === "true";

  // Get appropriate token
  const zenodoToken = sandbox ? c.env.ZENODO_SANDBOX_API_KEY : c.env.ZENODO_API_KEY;

  if (!zenodoToken) {
    return c.json(
      {
        error: "Zenodo API token not configured",
        message: sandbox ? "ZENODO_SANDBOX_API_KEY not set" : "ZENODO_API_KEY not set",
      },
      500,
    );
  }

  try {
    await deleteDeposition(depositionId, zenodoToken, sandbox);
    return c.body(null, 204);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`Failed to delete Zenodo deposition ${depositionId}:`, errorMessage);

    return c.json(
      {
        error: "Failed to delete deposition",
        message: errorMessage,
        deposition_id: depositionId,
        sandbox,
      },
      500,
    );
  }
});

// ============================================================================
// Repository Visibility
// ============================================================================

const visibilitySchema = z.object({
  visibility: z.enum(["public", "private"]),
});

/**
 * PATCH /admin/datasets/:id/visibility - Change repository visibility
 */
adminRoutes.patch("/datasets/:id/visibility", zValidator("json", visibilitySchema), async (c) => {
  const datasetId = c.req.param("id");
  const { visibility } = c.req.valid("json");
  const db = c.env.DB;
  const adminUser = c.get("user");

  const dataset = await db
    .prepare("SELECT dataset_id, github_repo FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ dataset_id: string; github_repo: string | null }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  if (!dataset.github_repo) {
    return c.json({ error: "Dataset has no GitHub repository" }, 400);
  }

  const repoName = dataset.github_repo.split("/")[1];
  if (!repoName) {
    return c.json({ error: "Invalid repository format" }, 500);
  }

  const isPrivate = visibility === "private";
  const result = await setRepoVisibility(repoName, isPrivate, c.env.GITHUB_ADMIN_PAT);

  if (!result.ok) {
    return c.json({ error: `Failed to set repository to ${visibility}: ${result.error}` }, 500);
  }

  // Update dataset visibility in database to match GitHub repo
  let dbUpdateResult;
  try {
    dbUpdateResult = await db
      .prepare("UPDATE datasets SET visibility = ? WHERE dataset_id = ?")
      .bind(visibility, datasetId)
      .run();

    if (!dbUpdateResult.success || dbUpdateResult.meta.changes === 0) {
      const errorDetails =
        dbUpdateResult.meta.changes === 0 ? "Dataset not found in database" : "Database update did not succeed";

      console.error(
        `CRITICAL: Failed to update database visibility for ${datasetId}. GitHub is now ${visibility} but database is out of sync.`,
      );

      // Try to revert GitHub repo visibility
      const revertResult = await setRepoVisibility(repoName, !isPrivate, c.env.GITHUB_ADMIN_PAT);
      if (revertResult.ok) {
        return c.json(
          {
            error: "Database update failed, reverted GitHub repository to original state",
            details: errorDetails,
            dataset_id: datasetId,
          },
          500,
        );
      }
      return c.json(
        {
          error: "CRITICAL: Database update failed AND repository revert failed",
          details: errorDetails,
          dataset_id: datasetId,
          github_visibility: visibility,
          database_visibility: visibility === "public" ? "private" : "public",
          revert_error: revertResult.error,
          action_required: `Manually update database: UPDATE datasets SET visibility = '${visibility}' WHERE dataset_id = '${datasetId}'`,
        },
        500,
      );
    }
  } catch (dbError) {
    const msg = dbError instanceof Error ? dbError.message : String(dbError);
    console.error(`CRITICAL: Exception updating database visibility for ${datasetId}:`, msg);

    // Try to revert GitHub repo visibility
    const revertResult = await setRepoVisibility(repoName, !isPrivate, c.env.GITHUB_ADMIN_PAT);
    if (revertResult.ok) {
      return c.json(
        {
          error: "Database update failed, reverted GitHub repository to original state",
          details: msg,
          dataset_id: datasetId,
        },
        500,
      );
    }
    return c.json(
      {
        error: "CRITICAL: Database update failed AND repository revert failed",
        details: msg,
        dataset_id: datasetId,
        github_visibility: visibility,
        database_visibility: visibility === "public" ? "private" : "public",
        revert_error: revertResult.error,
        action_required: `Manually update database: UPDATE datasets SET visibility = '${visibility}' WHERE dataset_id = '${datasetId}'`,
      },
      500,
    );
  }

  // Audit log (non-fatal but warn user if fails)
  let auditLogFailed = false;
  let auditLogError: string | undefined;

  try {
    await db
      .prepare(
        "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        adminUser.id,
        "repo_visibility_changed",
        "dataset",
        datasetId,
        JSON.stringify({ visibility, changed_by: adminUser.username }),
      )
      .run();
  } catch (auditError) {
    auditLogFailed = true;
    auditLogError = auditError instanceof Error ? auditError.message : String(auditError);
    console.error("AUDIT LOG FAILURE: Visibility change for dataset", datasetId, "was not logged:", auditLogError);
  }

  return c.json({
    message: `Repository visibility set to ${visibility}`,
    dataset_id: datasetId,
    visibility,
    warning: auditLogFailed
      ? `Audit log write failed: ${auditLogError}. Operation succeeded but was not logged for compliance.`
      : undefined,
  });
});

// ============================================================================
// CI Management
// ============================================================================

/**
 * GET /admin/datasets/:id/ci - Check CI workflow status
 */
adminRoutes.get("/datasets/:id/ci", async (c) => {
  const datasetId = c.req.param("id");
  const db = c.env.DB;

  const dataset = await db
    .prepare("SELECT dataset_id, github_repo FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ dataset_id: string; github_repo: string | null }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  if (!dataset.github_repo) {
    return c.json({ error: "Dataset has no GitHub repository" }, 400);
  }

  const repoName = dataset.github_repo.split("/")[1];
  if (!repoName) {
    return c.json({ error: "Invalid repository format" }, 500);
  }

  const pat = c.env.GITHUB_ADMIN_PAT;

  let bidsWorkflowExists = false;
  let versionCheckExists = false;
  let latestRunStatus = "unknown";
  let latestRunUrl: string | null = null;

  try {
    bidsWorkflowExists = await checkWorkflowExists(
      repoName,
      ".github/workflows/bids-validation.yml",
      pat,
    );

    versionCheckExists = await checkWorkflowExists(
      repoName,
      ".github/workflows/version-check.yml",
      pat,
    );

    if (bidsWorkflowExists) {
      const runs = await getWorkflowRuns(repoName, "bids-validation.yml", pat);
      if (runs.length > 0) {
        const latest = runs[0];
        latestRunStatus = latest.conclusion || latest.status;
        latestRunUrl = latest.html_url;
      } else {
        latestRunStatus = "no_runs";
      }
    }
  } catch (githubError) {
    const msg = githubError instanceof Error ? githubError.message : String(githubError);
    return c.json({ error: `GitHub API error: ${msg}` }, 502);
  }

  return c.json({
    dataset_id: datasetId,
    bids_validation: {
      present: bidsWorkflowExists,
      status: bidsWorkflowExists ? latestRunStatus : "missing",
      url: latestRunUrl,
    },
    version_check: {
      present: versionCheckExists,
    },
  });
});

/**
 * POST /admin/datasets/:id/ci - Deploy CI workflows to repository
 */
adminRoutes.post("/datasets/:id/ci", async (c) => {
  const datasetId = c.req.param("id");
  const db = c.env.DB;
  const adminUser = c.get("user");

  const dataset = await db
    .prepare("SELECT dataset_id, github_repo FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ dataset_id: string; github_repo: string | null }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  if (!dataset.github_repo) {
    return c.json({ error: "Dataset has no GitHub repository" }, 400);
  }

  const repoName = dataset.github_repo.split("/")[1];
  if (!repoName) {
    return c.json({ error: "Invalid repository format" }, 500);
  }

  const WORKFLOW_FILES = ["bids-validation.yml", "version-check.yml", "pr-merge.yml"];
  const result = await deployWorkflows(repoName, c.env.GITHUB_ADMIN_PAT);

  if (!result.success) {
    return c.json(
      {
        error: "Failed to deploy some workflows",
        deployed: WORKFLOW_FILES.length - result.errors.length,
        failed: result.errors,
      },
      500,
    );
  }

  try {
    await db
      .prepare(
        "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        adminUser.id,
        "ci_workflows_deployed",
        "dataset",
        datasetId,
        JSON.stringify({ deployed_by: adminUser.username }),
      )
      .run();
  } catch (auditError) {
    console.error("Audit log write failed for CI deploy:", auditError);
  }

  return c.json({
    message: "CI workflows deployed successfully",
    dataset_id: datasetId,
    workflows_deployed: WORKFLOW_FILES,
  });
});

// ============================================================================
// Publication Workflow (Admin)
// ============================================================================

/**
 * GET /admin/publish/requests - List publication requests
 */
adminRoutes.get("/publish/requests", async (c) => {
  const db = c.env.DB;
  const status = c.req.query("status");

  let query = `
    SELECT pr.*, u.username as requested_by_username, u.email as requested_by_email
    FROM publication_requests pr
    JOIN users u ON pr.requested_by = u.id
  `;
  const params: string[] = [];

  if (status) {
    query += " WHERE pr.status = ?";
    params.push(status);
  }

  query += " ORDER BY pr.requested_at DESC";

  const requests = await db
    .prepare(query)
    .bind(...params)
    .all<{
      id: number;
      dataset_id: string;
      status: string;
      requested_at: string;
      requested_by_username: string;
      requested_by_email: string;
      steps_completed: string;
      current_step: string | null;
      last_error: string | null;
    }>();

  return c.json({
    requests: requests.results.map((r) => ({
      ...r,
      steps_completed: JSON.parse(r.steps_completed || "[]"),
    })),
    count: requests.results.length,
  });
});

/**
 * POST /admin/publish/:id/deny - Deny a publication request
 */
const denySchema = z.object({
  reason: z.string().min(1, "Reason is required").max(2000, "Reason too long"),
});

adminRoutes.post("/publish/:id/deny", zValidator("json", denySchema), async (c) => {
  const datasetId = c.req.param("id");
  const { reason } = c.req.valid("json");
  const adminUser = c.get("user");
  const db = c.env.DB;

  const request = await db
    .prepare(
      "SELECT id, status, requested_by FROM publication_requests WHERE dataset_id = ? AND status IN ('requested', 'approving') ORDER BY requested_at DESC LIMIT 1",
    )
    .bind(datasetId)
    .first<{ id: number; status: string; requested_by: number }>();

  if (!request) {
    return c.json({ error: "No active publication request found" }, 404);
  }

  await db
    .prepare(
      `UPDATE publication_requests
       SET status = 'denied', denied_at = datetime('now'), denied_by = ?, denied_reason = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(adminUser.id, reason, request.id)
    .run();

  // Notify the requesting user
  try {
    const user = await db
      .prepare("SELECT username, email FROM users WHERE id = ?")
      .bind(request.requested_by)
      .first<{ username: string; email: string }>();

    if (user) {
      await sendPublicationDeniedEmail(
        user.email,
        user.username,
        datasetId,
        reason,
        c.env.RESEND_API_KEY,
      );
    }
  } catch (emailError) {
    console.error("Failed to send denial email:", emailError);
  }

  return c.json({
    message: "Publication request denied",
    dataset_id: datasetId,
    reason,
  });
});

/**
 * POST /admin/publish/:id/approve - Approve and run publication orchestrator
 *
 * Steps:
 * 1. ci_check - Verify CI exists and is passing (deploy if missing)
 * 2. repo_public - Make repository public
 * 3. tag_protect - Apply tag protection rules (prevent version tag deletion)
 * 4. doi_create - Create concept DOI if not exists
 * 5. s3_lock - Apply S3 Object Lock (Governance mode)
 * 6. notify_user - Send publication confirmation email
 *
 * Body: { resume?: boolean } - if true, skip already-completed steps
 */
const approveSchema = z.object({
  resume: z.boolean().optional().default(false),
  sandbox: z.boolean().optional().default(false),
});

adminRoutes.post("/publish/:id/approve", zValidator("json", approveSchema), async (c) => {
  const datasetId = c.req.param("id");
  const { resume, sandbox } = c.req.valid("json");
  const adminUser = c.get("user");
  const db = c.env.DB;

  // Find the publication request
  const request = await db
    .prepare(
      "SELECT id, status, steps_completed FROM publication_requests WHERE dataset_id = ? AND status IN ('requested', 'approving') ORDER BY requested_at DESC LIMIT 1",
    )
    .bind(datasetId)
    .first<{ id: number; status: string; steps_completed: string }>();

  if (!request) {
    return c.json({ error: "No active publication request found" }, 404);
  }

  const stepsCompleted: string[] = resume ? JSON.parse(request.steps_completed || "[]") : [];
  const allSteps = [
    "ci_check",
    "repo_public",
    "tag_protect",
    "doi_create",
    "s3_lock",
    "notify_user",
  ];
  const stepsToRun = allSteps.filter((s) => !stepsCompleted.includes(s));

  if (stepsToRun.length === 0) {
    return c.json({
      message: "All steps already completed",
      dataset_id: datasetId,
      status: "published",
    });
  }

  // Mark as approving
  await db
    .prepare(
      "UPDATE publication_requests SET status = 'approving', approved_by = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(adminUser.id, request.id)
    .run();

  // Get dataset info
  const dataset = await db
    .prepare(
      `SELECT d.*, u.username as owner_username, u.email as owner_email
       FROM datasets d
       JOIN users u ON d.owner_user_id = u.id
       WHERE d.dataset_id = ?`,
    )
    .bind(datasetId)
    .first<{
      id: number;
      dataset_id: string;
      name: string;
      github_repo: string | null;
      concept_doi: string | null;
      zenodo_concept_id: string | null;
      owner_username: string;
      owner_email: string;
    }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  // Block publication of sandbox datasets
  if (dataset.dataset_id.startsWith("xx")) {
    return c.json(
      {
        error: "Cannot publish sandbox datasets",
        message: "Sandbox datasets (xx-prefix) are for testing only and cannot be published.",
        dataset_id: datasetId,
      },
      400,
    );
  }

  if (!dataset.github_repo) {
    return c.json({ error: "Dataset has no GitHub repository" }, 400);
  }

  const repoName = dataset.github_repo.split("/")[1];
  if (!repoName) {
    return c.json({ error: "Invalid repository format" }, 500);
  }

  const pat = c.env.GITHUB_ADMIN_PAT;
  const completed: string[] = [...stepsCompleted];
  const requestId = request.id;

  // Helper to update progress in D1
  async function updateProgress(step: string, error?: string) {
    if (!error) {
      completed.push(step);
    }
    await db
      .prepare(
        `UPDATE publication_requests
         SET steps_completed = ?, current_step = ?, last_error = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(JSON.stringify(completed), error ? step : null, error || null, requestId)
      .run();
  }

  // Step 1: CI Check
  if (stepsToRun.includes("ci_check")) {
    try {
      await db
        .prepare(
          "UPDATE publication_requests SET current_step = 'ci_check', updated_at = datetime('now') WHERE id = ?",
        )
        .bind(request.id)
        .run();

      const bidsExists = await checkWorkflowExists(
        repoName,
        ".github/workflows/bids-validation.yml",
        pat,
      );
      if (!bidsExists) {
        await deployWorkflows(repoName, pat);
      }

      // Check latest run status (if workflow existed, verify it passes)
      // Freshly deployed workflows have no runs yet, which is acceptable
      const runs = await getWorkflowRuns(repoName, "bids-validation.yml", pat);
      if (runs.length > 0) {
        const latest = runs[0];
        if (latest.conclusion === "failure") {
          await updateProgress("ci_check", "BIDS validation CI is failing");
          return c.json(
            {
              error: "CI check failed: BIDS validation is failing",
              dataset_id: datasetId,
              step: "ci_check",
              steps_completed: completed,
            },
            422,
          );
        }
      }

      await updateProgress("ci_check");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateProgress("ci_check", msg);
      return c.json(
        { error: `CI check failed: ${msg}`, step: "ci_check", steps_completed: completed },
        500,
      );
    }
  }

  // Step 2: Make repo public
  if (stepsToRun.includes("repo_public")) {
    try {
      await db
        .prepare(
          "UPDATE publication_requests SET current_step = 'repo_public', updated_at = datetime('now') WHERE id = ?",
        )
        .bind(request.id)
        .run();

      const result = await setRepoVisibility(repoName, false, pat);
      if (!result.ok) {
        await updateProgress("repo_public", `Failed to make repo public: ${result.error}`);
        return c.json(
          {
            error: `Failed to make repo public: ${result.error}`,
            step: "repo_public",
            steps_completed: completed,
          },
          500,
        );
      }

      // Update dataset visibility in database to match GitHub repo visibility
      let dbUpdateResult;
      try {
        dbUpdateResult = await db
          .prepare("UPDATE datasets SET visibility = 'public' WHERE dataset_id = ?")
          .bind(datasetId)
          .run();

        if (!dbUpdateResult.success) {
          throw new Error("Database update did not succeed");
        }

        if (dbUpdateResult.meta.changes === 0) {
          throw new Error("Dataset not found in database");
        }
      } catch (dbError) {
        const msg = dbError instanceof Error ? dbError.message : String(dbError);
        console.error(
          `CRITICAL: Failed to update database visibility for ${datasetId} after making repo public:`,
          msg,
        );
        await updateProgress("repo_public", `Database visibility update failed: ${msg}`);
        return c.json(
          {
            error: "Critical: Database update failed after making repository public",
            details: msg,
            dataset_id: datasetId,
            github_visibility: "public",
            database_visibility: "private (update failed)",
            action_required: `Manually update database: UPDATE datasets SET visibility = 'public' WHERE dataset_id = '${datasetId}'`,
          },
          500,
        );
      }

      await updateProgress("repo_public");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateProgress("repo_public", msg);
      return c.json(
        { error: `repo_public failed: ${msg}`, step: "repo_public", steps_completed: completed },
        500,
      );
    }
  }

  // Step 3: Tag protection (before DOI to prevent tag manipulation)
  if (stepsToRun.includes("tag_protect")) {
    try {
      await db
        .prepare(
          "UPDATE publication_requests SET current_step = 'tag_protect', updated_at = datetime('now') WHERE id = ?",
        )
        .bind(requestId)
        .run();

      const { applyTagProtection } = await import("../services/github");
      const tagProtected = await applyTagProtection(repoName, pat);

      if (!tagProtected) {
        await updateProgress("tag_protect", "Failed to apply tag protection rules");
        return c.json(
          {
            error: "Tag protection failed",
            step: "tag_protect",
            steps_completed: completed,
          },
          500,
        );
      }

      await updateProgress("tag_protect");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateProgress("tag_protect", msg);
      return c.json(
        { error: `Tag protection failed: ${msg}`, step: "tag_protect", steps_completed: completed },
        500,
      );
    }
  }

  // Step 4: Create concept DOI (if not exists)
  if (stepsToRun.includes("doi_create")) {
    try {
      await db
        .prepare(
          "UPDATE publication_requests SET current_step = 'doi_create', updated_at = datetime('now') WHERE id = ?",
        )
        .bind(request.id)
        .run();

      if (!dataset.concept_doi) {
        // SAFETY: Block production DOI creation in non-production environments
        if (!sandbox) {
          const environment = c.env.ENVIRONMENT;
          if (!environment) {
            await updateProgress("doi_create", "ENVIRONMENT variable not configured");
            return c.json(
              {
                error: "Server misconfiguration: ENVIRONMENT variable not set",
                message: "Cannot create production DOIs without explicit environment configuration. Use --sandbox for testing.",
                step: "doi_create",
                steps_completed: completed,
              },
              500,
            );
          }
          const normalizedEnv = environment.toLowerCase().trim();
          if (normalizedEnv !== "production") {
            await updateProgress("doi_create", "Production DOI blocked in non-production");
            return c.json(
              {
                error: "Production DOI creation blocked in non-production environment",
                message: "Use --sandbox flag for testing, or deploy to production.",
                environment: normalizedEnv,
                step: "doi_create",
                steps_completed: completed,
              },
              400,
            );
          }
        }

        const { createDeposition: createDep, getPrereservedDoi: getDoi } = await import(
          "../services/zenodo"
        );
        const zenodoToken = sandbox ? c.env.ZENODO_SANDBOX_API_KEY : c.env.ZENODO_API_KEY;
        if (!zenodoToken) {
          const errorMsg = sandbox ? "Zenodo sandbox API key not configured" : "Zenodo API key not configured";
          await updateProgress("doi_create", errorMsg);
          return c.json(
            {
              error: errorMsg,
              step: "doi_create",
              steps_completed: completed,
            },
            500,
          );
        }

        const metadata = {
          title: `${dataset.name} - BIDS Dataset`,
          description: `BIDS-formatted dataset: ${dataset.name}`,
          creators: [{ name: dataset.owner_username }],
          keywords: ["BIDS", "neuroscience", "neuroimaging", "NEMAR"],
          license: "cc-by-nc-4.0",
          related_identifiers: [
            {
              identifier: `https://github.com/${dataset.github_repo}`,
              relation: "isSupplementTo",
              resource_type: "dataset",
            },
          ],
        };

        const deposition = await createDep(metadata, zenodoToken, sandbox);
        const conceptDoi = getDoi(deposition);

        if (conceptDoi) {
          await db
            .prepare(
              "UPDATE datasets SET concept_doi = ?, zenodo_concept_id = ?, is_sandbox = ?, updated_at = datetime('now') WHERE dataset_id = ?",
            )
            .bind(conceptDoi, deposition.id.toString(), sandbox ? 1 : 0, datasetId)
            .run();
        }
      }

      await updateProgress("doi_create");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateProgress("doi_create", msg);
      return c.json(
        { error: `DOI creation failed: ${msg}`, step: "doi_create", steps_completed: completed },
        500,
      );
    }
  }

  // Step 5: S3 Object Lock (batched to stay within CF Workers subrequest limits)
  if (stepsToRun.includes("s3_lock")) {
    try {
      await db
        .prepare(
          "UPDATE publication_requests SET current_step = 's3_lock', updated_at = datetime('now') WHERE id = ?",
        )
        .bind(request.id)
        .run();

      const s3Options = {
        bucket: c.env.S3_BUCKET,
        region: c.env.AWS_REGION,
        accessKeyId: c.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
      };

      let totalLocked = 0;
      const allFailed: string[] = [];
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const lockResult = await applyObjectLock(s3Options, datasetId, offset);
        totalLocked += lockResult.locked;
        allFailed.push(...lockResult.failed);
        hasMore = lockResult.hasMore;
        offset += 40;
      }

      if (allFailed.length > 0) {
        const msg = `${totalLocked} locked, ${allFailed.length} failed`;
        await updateProgress("s3_lock", msg);
        return c.json(
          {
            error: `S3 lock partially failed: ${msg}`,
            step: "s3_lock",
            steps_completed: completed,
            details: { locked: totalLocked, failed: allFailed },
          },
          500,
        );
      }

      await updateProgress("s3_lock");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateProgress("s3_lock", msg);
      return c.json(
        { error: `S3 lock failed: ${msg}`, step: "s3_lock", steps_completed: completed },
        500,
      );
    }
  }

  // Step 6: Notify user
  if (stepsToRun.includes("notify_user")) {
    try {
      await db
        .prepare(
          "UPDATE publication_requests SET current_step = 'notify_user', updated_at = datetime('now') WHERE id = ?",
        )
        .bind(request.id)
        .run();

      // Re-read DOI in case it was just created
      const updatedDataset = await db
        .prepare("SELECT concept_doi FROM datasets WHERE dataset_id = ?")
        .bind(datasetId)
        .first<{ concept_doi: string | null }>();

      await sendPublicationApprovedEmail(
        dataset.owner_email,
        dataset.owner_username,
        datasetId,
        updatedDataset?.concept_doi || null,
        c.env.RESEND_API_KEY,
      );

      await updateProgress("notify_user");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateProgress("notify_user", msg);
      return c.json(
        { error: `Notification failed: ${msg}`, step: "notify_user", steps_completed: completed },
        500,
      );
    }
  }

  // Mark as published
  await db
    .prepare(
      `UPDATE publication_requests
       SET status = 'published', approved_at = datetime('now'), current_step = NULL, last_error = NULL, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(request.id)
    .run();

  // Audit log
  // Audit log (non-fatal but warn user if fails)
  let auditLogFailed = false;
  let auditLogError: string | undefined;

  try {
    await db
      .prepare(
        "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        adminUser.id,
        "dataset_published",
        "dataset",
        datasetId,
        JSON.stringify({ approved_by: adminUser.username, steps: allSteps }),
      )
      .run();
  } catch (auditError) {
    auditLogFailed = true;
    auditLogError = auditError instanceof Error ? auditError.message : String(auditError);
    console.error("AUDIT LOG FAILURE: Dataset publication for", datasetId, "was not logged:", auditLogError);
  }

  return c.json({
    message: "Dataset published successfully",
    dataset_id: datasetId,
    status: "published",
    steps_completed: allSteps,
    warning: auditLogFailed
      ? `Audit log write failed: ${auditLogError}. Publication succeeded but was not logged for compliance.`
      : undefined,
  });
});

/**
 * POST /admin/datasets/:id/s3-lock - Apply S3 Object Lock to dataset
 */
adminRoutes.post("/datasets/:id/s3-lock", async (c) => {
  const datasetId = c.req.param("id");
  const db = c.env.DB;

  const dataset = await db
    .prepare("SELECT dataset_id FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ dataset_id: string }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  try {
    const s3Options = {
      bucket: c.env.S3_BUCKET,
      region: c.env.AWS_REGION,
      accessKeyId: c.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
    };

    let totalLocked = 0;
    const allFailed: string[] = [];
    let offset = 0;
    let hasMore = true;
    let total = 0;

    while (hasMore) {
      const result = await applyObjectLock(s3Options, datasetId, offset);
      totalLocked += result.locked;
      allFailed.push(...result.failed);
      hasMore = result.hasMore;
      total = result.total;
      offset += 40;
    }

    return c.json({
      message: allFailed.length === 0 ? "All objects locked" : "Some objects failed to lock",
      dataset_id: datasetId,
      locked: totalLocked,
      total,
      failed: allFailed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `S3 lock failed: ${msg}` }, 500);
  }
});

// ============================================================================
// Manifest Generation
// ============================================================================

/**
 * POST /admin/datasets/:id/manifest/:version - Generate or regenerate a version manifest
 *
 * Traverses the git tree at the given version tag and generates a JSON manifest
 * mapping file paths to their S3 annex keys.
 */
adminRoutes.post("/datasets/:id/manifest/:version", async (c) => {
  const datasetId = c.req.param("id");
  const version = c.req.param("version");
  const db = c.env.DB;

  // Accept optional DOI in request body
  const body = await c.req.json<{ doi?: string }>().catch(() => ({}));

  const dataset = await db
    .prepare("SELECT dataset_id, github_repo, concept_doi FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ dataset_id: string; github_repo: string | null; concept_doi: string | null }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  if (!dataset.github_repo) {
    return c.json({ error: "Dataset has no GitHub repository" }, 400);
  }

  const repoName = dataset.github_repo.split("/")[1];
  if (!repoName) {
    return c.json({ error: "Invalid repository format" }, 500);
  }

  const pat = c.env.GITHUB_ADMIN_PAT;

  // Resolve version DOI: use provided value, or try existing manifest
  let versionDoi: string | null = 'doi' in body ? (body.doi ?? null) : null;
  if (!versionDoi) {
    const s3Options = {
      bucket: c.env.S3_BUCKET,
      region: c.env.AWS_REGION,
      accessKeyId: c.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
    };
    const existing = await getManifest(s3Options, datasetId, version);
    if (existing) {
      const parsed = JSON.parse(existing) as { doi?: string | null };
      versionDoi = parsed.doi ?? null;
    }
  }

  try {
    const manifest = await generateManifest(
      repoName,
      version,
      pat,
      datasetId,
      versionDoi,
      dataset.concept_doi,
    );

    await uploadManifest(
      {
        bucket: c.env.S3_BUCKET,
        region: c.env.AWS_REGION,
        accessKeyId: c.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
      },
      datasetId,
      version,
      JSON.stringify(manifest, null, 2),
    );

    return c.json({
      message: "Manifest generated and uploaded",
      dataset_id: datasetId,
      version: manifest.version,
      files_count: Object.keys(manifest.files).length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Manifest generation failed: ${msg}` }, 500);
  }
});
