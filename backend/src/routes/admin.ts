/**
 * Admin routes
 *
 * Handles user approval, revocation, and management.
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { adminMiddleware, authMiddleware, ownerMiddleware } from "../middleware/auth";

import {
  type DataCiteEnrichment,
  bidsToDataCite,
  buildDataCiteXml,
  nemarMetadataToEnrichment,
  parseNemarMetadata,
} from "../services/datacite";
import { deleteDatasetCascade } from "../services/deletion";
import {
  type DoiProvider,
  type DoiResult,
  buildOrcidEnrichment,
  createConceptDoi as dispatchCreateConceptDoi,
  parseDoiProvider,
  resolveEzidAuth,
} from "../services/doi";
import {
  sendKeyReadyEmail,
  sendPublicationApprovedEmail,
  sendPublicationDeniedEmail,
  sendRevocationEmail,
} from "../services/email";
import { decrypt, encrypt } from "../services/encryption";
import {
  type EzidAuth,
  TEST_SHOULDER,
  extractDoi,
  makePublic as ezidMakePublic,
  updateIdentifier as ezidUpdateIdentifier,
} from "../services/ezid";
import {
  type GitHubRepo,
  addCollaborator,
  checkWorkflowExists,
  createOrUpdateFile,
  createRelease,
  createRepository,
  createTag,
  deleteRepoFile,
  deleteRepository,
  deployWorkflows,
  downloadReleaseArchive,
  getBlobContent,
  getMainBranchSha,
  getTreeAtRef,
  getWorkflowRuns,
  removeCollaborator,
  setRepoVisibility,
  triggerArchiveGeneration,
} from "../services/github";
import { generateIamUsername, revokeUserIamAccess, setupUserIamAccess } from "../services/iam";
import { generateManifest } from "../services/manifest";
import {
  errorMessage,
  extractRepoName,
  readBidsDescription,
  readRepoMetadata,
} from "../services/repo-metadata";
import {
  addPublicReadPolicy,
  applyObjectLock,
  deleteDatasetObjects,
  getManifest,
  removePublicReadPolicy,
  uploadManifest,
} from "../services/s3";
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
import {
  type Bindings,
  type UserRole,
  type Variables,
  hasRole,
  isDemotion,
  isValidRole,
  parseRole,
} from "../types/bindings";

/**
 * Valid publication workflow step names.
 * Steps execute in this order; completed steps are skipped on resume.
 */
type PublicationStep =
  | "ci_check"
  | "enrichment_check"
  | "repo_public"
  | "s3_public_read"
  | "tag_protect"
  | "doi_create"
  | "update_metadata"
  | "update_readme"
  | "create_tag"
  | "create_release"
  | "upload_to_zenodo"
  | "publish_doi"
  | "s3_lock"
  | "generate_archive"
  | "notify_user";

/**
 * Result of a single publication step, included in the API response.
 */
interface StepResult {
  step: PublicationStep;
  status: "completed" | "failed" | "skipped";
  attempts: number;
  duration_ms: number;
  error?: string;
}

/**
 * Retry a transient operation up to maxAttempts times.
 *
 * Only retries on network errors, 5xx responses, and 429 rate limits.
 * 4xx validation errors are not retried.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  stepName: string,
  options?: {
    maxAttempts?: number;
    delayMs?: number;
    isRetryable?: (error: unknown) => boolean;
  },
): Promise<{ result: T; attempts: number }> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const delayMs = options?.delayMs ?? 10_000;
  const isRetryable =
    options?.isRetryable ??
    ((error: unknown) => {
      if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        // Retry on network timeouts, connection errors
        if (
          msg.includes("timeout") ||
          msg.includes("network") ||
          msg.includes("econnreset") ||
          msg.includes("fetch failed") ||
          msg.includes("connection")
        ) {
          return true;
        }
        // Retry on 5xx and 429 status codes embedded in the error message
        if (/\b(5\d\d|429)\b/.test(msg)) {
          return true;
        }
      }
      return false;
    });

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      return { result, attempts: attempt };
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts && isRetryable(err)) {
        console.log(
          `[publish] ${stepName} attempt ${attempt} failed (retryable), retrying in ${delayMs}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        // Not retryable or last attempt
        break;
      }
    }
  }
  throw lastError;
}

export const adminRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

function getS3Config(env: Bindings) {
  return {
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  };
}

// All admin routes require authentication and admin role
adminRoutes.use("*", authMiddleware);
adminRoutes.use("*", adminMiddleware);

/**
 * GET /admin/users - List users with optional status filter
 */
adminRoutes.get("/users", async (c) => {
  const status = c.req.query("status"); // pending, verified, approved, revoked
  const role = c.req.query("role"); // owner, admin, member
  const db = c.env.DB;

  let query = `
    SELECT
      id, username, email, github_username, status,
      email_verified, role, created_at, approved_at, revoked_at
    FROM users
  `;
  const conditions: string[] = [];
  const params: string[] = [];

  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }
  if (role) {
    if (!["owner", "admin", "member"].includes(role)) {
      return c.json({ error: "Invalid role. Must be: owner, admin, or member" }, 400);
    }
    if (role === "member") {
      conditions.push("(role = 'member' OR role IS NULL)");
    } else {
      conditions.push("role = ?");
      params.push(role);
    }
  }

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(" AND ")}`;
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

const roleChangeSchema = z.object({
  role: z.enum(["owner", "admin", "member"]),
});

/**
 * POST /admin/users/:username/role - Change a user's role (owner-only)
 */
adminRoutes.post(
  "/users/:username/role",
  ownerMiddleware,
  zValidator("json", roleChangeSchema),
  async (c) => {
    const username = c.req.param("username");
    const { role: newRole } = c.req.valid("json");
    const db = c.env.DB;
    const requestingUser = c.get("user");

    // Cannot change own role (prevents owner self-demotion lockout)
    if (requestingUser.username === username) {
      return c.json({ error: "Cannot change your own role" }, 400);
    }

    // Find target user
    const target = await db
      .prepare("SELECT id, username, role, status FROM users WHERE username = ?")
      .bind(username)
      .first<{ id: number; username: string; role: string | null; status: string }>();

    if (!target) {
      return c.json({ error: "User not found" }, 404);
    }

    if (target.status !== "approved") {
      return c.json({ error: "User must be approved before role changes" }, 400);
    }

    const oldRole = parseRole(target.role, target.username);
    if (oldRole === null) {
      return c.json({ error: "Target user has invalid role configuration" }, 500);
    }

    if (oldRole === newRole) {
      return c.json({ error: `User already has role '${newRole}'` }, 409);
    }

    // Protect against removing the last owner
    if (oldRole === "owner" && newRole !== "owner") {
      const ownerCount = await db
        .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'owner' AND status = 'approved'")
        .first<{ count: number }>();
      if (ownerCount && ownerCount.count <= 1) {
        return c.json({ error: "Cannot remove the last owner" }, 400);
      }
    }

    // Update role
    await db
      .prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(newRole, target.id)
      .run();

    // On demotion, revoke tokens to force re-authentication
    const demoted = isDemotion(oldRole, newRole);
    let tokensRevoked = 0;
    let tokenRevocationFailed = false;
    if (demoted) {
      try {
        const result = await db
          .prepare(
            "UPDATE tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
          )
          .bind(target.id)
          .run();
        tokensRevoked = result.meta.changes ?? 0;
      } catch (error) {
        console.error(`SECURITY: Failed to revoke tokens for demoted user ${username}:`, error);
        tokenRevocationFailed = true;
      }
    }

    // Audit log (non-blocking)
    try {
      await db
        .prepare(
          "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(
          requestingUser.id,
          "role_changed",
          "user",
          username,
          JSON.stringify({
            changed_by: requestingUser.username,
            old_role: oldRole,
            new_role: newRole,
            tokens_revoked: tokensRevoked,
            token_revocation_failed: tokenRevocationFailed,
          }),
        )
        .run();
    } catch (error) {
      console.error(
        `Failed to write audit log for role change ${username} ${oldRole}->${newRole}:`,
        error,
      );
    }

    const response: Record<string, unknown> = {
      message: `User ${username} role changed from '${oldRole}' to '${newRole}'`,
      user: { username, role: newRole },
    };
    if (demoted) {
      response.tokens_revoked = tokensRevoked;
    }
    if (tokenRevocationFailed) {
      response.warning =
        "Token revocation failed. User may retain elevated session. Manually revoke tokens.";
    }

    return c.json(response);
  },
);

/**
 * POST /admin/approve/:username - Approve a user (token created via retrieve-key)
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
    iamSetupError = errorMessage(error);
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

  // Note: API token is NOT created here. The user retrieves it via
  // `nemar auth retrieve-key` which generates the token on first call.
  // This ensures the user sees the plaintext key exactly once.

  // Note: We no longer auto-add users to all repos
  // Users request access to specific datasets via `nemar dataset request-access`

  // Send approval notification email
  let emailSent = false;
  try {
    await sendKeyReadyEmail(user.email, user.username, c.env.RESEND_API_KEY);
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

  // Find user (include IAM credentials and role for revocation)
  const user = await db
    .prepare(`
      SELECT id, username, email, github_username, status, role,
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
      role: string | null;
      aws_iam_username: string | null;
      aws_access_key_id_encrypted: string | null;
    }>();

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  if (user.status === "revoked") {
    return c.json({ error: "User already revoked" }, 409);
  }

  // Only owners can revoke other owners
  if (user.role === "owner" && adminUser.role !== "owner") {
    return c.json({ error: "Only owners can revoke other owners" }, 403);
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
        console.log(`IAM revocation succeeded for ${user.username}:\n${result.steps.join("\n")}`);
      }
    } catch (error) {
      // Complete failure - couldn't even start cleanup
      const errMsg = errorMessage(error);
      console.error("CRITICAL SECURITY: Failed to revoke IAM access for", user.username, errMsg);

      iamRevocationError = errMsg;

      // Track complete failures
      try {
        await db
          .prepare(
            `INSERT INTO iam_revocation_failures (user_id, username, iam_username, error_message, created_at)
             VALUES (?, ?, ?, ?, datetime('now'))`,
          )
          .bind(user.id, user.username, user.aws_iam_username, errMsg)
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
      `SELECT id, username, email, status, role, aws_iam_username, aws_access_key_id_encrypted
       FROM users WHERE username = ?`,
    )
    .bind(username)
    .first<{
      id: number;
      username: string;
      email: string;
      status: string;
      role: string | null;
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

  const awsConfig = {
    accessKeyId: c.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
    region: c.env.AWS_REGION,
  };

  const {
    createIamUser,
    createAccessKey,
    deleteAccessKey,
    listAccessKeys,
    putUserPolicy,
    generateS3PolicyDocument,
    generateAdminS3PolicyDocument,
    generateIamUsername,
  } = await import("../services/iam");

  // Revoke ALL existing access keys for the IAM user (handles cases where
  // D1 credentials can't be decrypted, e.g. after ENCRYPTION_KEY rotation)
  if (user.aws_iam_username) {
    try {
      const existingKeys = await listAccessKeys(awsConfig, user.aws_iam_username);
      const failedKeys: string[] = [];
      for (const keyId of existingKeys) {
        try {
          await deleteAccessKey(awsConfig, user.aws_iam_username, keyId);
        } catch (error) {
          console.error(`Failed to revoke access key ${keyId}:`, error);
          failedKeys.push(keyId);
        }
      }
      if (failedKeys.length > 0) {
        oldKeyRevocationWarning = `${failedKeys.length} old access key(s) may still be active`;
      }
    } catch (error) {
      console.error("Failed to list access keys:", error);
      oldKeyRevocationWarning = `Could not list existing access keys: ${errorMessage(error)}`;
    }
  }

  // Create new IAM credentials
  const hasAdminAccess = hasRole((user.role || "member") as UserRole, "admin");

  try {
    const iamUsername = generateIamUsername(user.username);

    // Create or get existing IAM user
    await createIamUser(awsConfig, user.username);

    // Create new access keys
    const { accessKeyId, secretAccessKey } = await createAccessKey(awsConfig, iamUsername);

    // Restore policy: admins get full bucket access, regular users get their datasets only
    const policyDocument = hasAdminAccess
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
    const datasetsRestoredCount = hasAdminAccess ? "all" : datasetPrefixes.length;
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
            role: user.role || "member",
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
        role: user.role || "member",
      },
      datasets_restored: hasAdminAccess ? "all (full bucket access)" : datasetPrefixes.length,
      warning: oldKeyRevocationWarning,
    });
  } catch (error) {
    console.error("Failed to regenerate IAM credentials:", error);
    return c.json(
      {
        error: "Failed to create IAM credentials",
        details: errorMessage(error),
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
 * WARNING: Public DOIs are PERMANENT and cannot be deleted. Reserved DOIs can be deleted before being made public.
 * Creates a pre-reserved DOI via the specified provider (EZID by default, or Zenodo if explicitly requested).
 * The DOI is reserved but not published until the first version release.
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
  provider: z.enum(["ezid", "zenodo"]).optional().default("ezid"),
  skip_enrichment_check: z.boolean().optional().default(false),
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
    SELECT d.*, u.username as owner_username, u.orcid as owner_orcid
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
        ezid_identifier: string | null;
        ezid_status: string | null;
        doi_provider: string | null;
        owner_username: string;
        owner_orcid: string | null;
        is_sandbox: number | null;
        enrichment_json: string | null;
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

    // Gate on enrichment: require validated metadata before minting DOIs
    if (!body.skip_enrichment_check) {
      if (!dataset.enrichment_json) {
        return c.json(
          {
            error: "Metadata pipeline has not run yet",
            message:
              "Push to main (or trigger the LLM Metadata Enrichment workflow manually) so the metadata pipeline runs, then retry. Pass skip_enrichment_check: true to override.",
            dataset_id: dataset.dataset_id,
          },
          422,
        );
      }
      // Check pipeline_stage is "validated"
      let pipelineStage: string | undefined;
      try {
        const meta = JSON.parse(dataset.enrichment_json) as Record<string, unknown>;
        pipelineStage = typeof meta.pipeline_stage === "string" ? meta.pipeline_stage : undefined;
      } catch (parseErr) {
        console.error(
          `[doi] Corrupt enrichment_json for ${dataset.dataset_id}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        );
      }
      if (pipelineStage !== "validated") {
        return c.json(
          {
            error: `Metadata not yet validated (current stage: ${pipelineStage || "unknown"})`,
            message:
              "The metadata pipeline must reach 'validated' stage before DOI minting. Re-trigger the LLM Metadata Enrichment workflow or pass skip_enrichment_check: true to override.",
            dataset_id: dataset.dataset_id,
            pipeline_stage: pipelineStage || "unknown",
          },
          422,
        );
      }
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

    // Read BIDS + enrichment metadata from GitHub repo
    let bidsDescription: Record<string, unknown> | undefined;
    let repoEnrichment: DataCiteEnrichment | undefined;
    let bidsMetadataWarning: string | undefined;
    if (dataset.github_repo) {
      const repoName = extractRepoName(dataset.github_repo);
      if (repoName) {
        const baseEnrichment = buildOrcidEnrichment(
          undefined,
          dataset.owner_username,
          dataset.owner_orcid || undefined,
        );
        const repoMeta = await readRepoMetadata(
          repoName,
          c.env.GITHUB_ADMIN_PAT,
          baseEnrichment,
          body.title || dataset.name,
        );
        bidsDescription = repoMeta.bidsDescription;
        repoEnrichment = repoMeta.enrichment;
        if (repoMeta.warnings.length > 0) {
          bidsMetadataWarning = repoMeta.warnings.join("; ");
          console.warn("[doi]", bidsMetadataWarning);
        }
      }
    }

    const provider = body.provider;

    try {
      const result = await dispatchCreateConceptDoi(
        {
          provider,
          datasetId,
          datasetName: body.title || dataset.name,
          datasetDescription: body.description || dataset.description,
          githubRepo: dataset.github_repo,
          bidsDescription,
          enrichment: repoEnrichment,
          uploaderOrcid: dataset.owner_orcid || undefined,
          uploaderName: dataset.owner_username,
          sandbox: body.sandbox,
        },
        {
          EZID_USERNAME: c.env.EZID_USERNAME,
          EZID_PASSWORD: c.env.EZID_PASSWORD,
          EZID_SANDBOX_USERNAME: c.env.EZID_SANDBOX_USERNAME,
          EZID_SANDBOX_PASSWORD: c.env.EZID_SANDBOX_PASSWORD,
          ZENODO_API_KEY: c.env.ZENODO_API_KEY,
          ZENODO_SANDBOX_API_KEY: c.env.ZENODO_SANDBOX_API_KEY,
        },
      );

      // Update dataset with DOI info
      if (provider === "ezid") {
        await db
          .prepare(
            `
        UPDATE datasets
        SET concept_doi = ?,
            ezid_identifier = ?,
            ezid_status = ?,
            doi_provider = 'ezid',
            is_sandbox = ?,
            updated_at = datetime('now')
        WHERE dataset_id = ?
      `,
          )
          .bind(result.doi, result.providerRecordId, result.status, body.sandbox ? 1 : 0, datasetId)
          .run();
      } else {
        await db
          .prepare(
            `
        UPDATE datasets
        SET concept_doi = ?,
            zenodo_concept_id = ?,
            doi_provider = 'zenodo',
            is_sandbox = ?,
            updated_at = datetime('now')
        WHERE dataset_id = ?
      `,
          )
          .bind(result.doi, result.providerRecordId, body.sandbox ? 1 : 0, datasetId)
          .run();
      }

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
            concept_doi: result.doi,
            provider,
            provider_record_id: result.providerRecordId,
            sandbox: body.sandbox,
          }),
        )
        .run();

      // Build response based on provider
      const response: Record<string, unknown> = {
        message: "Concept DOI created successfully",
        concept_doi: result.doi,
        provider,
        warning:
          "DOI is pre-reserved but not yet published. It will become active on first version publish.",
      };

      if (bidsMetadataWarning) {
        response.metadata_warning = bidsMetadataWarning;
      }

      if (provider === "ezid") {
        response.ezid_identifier = result.providerRecordId;
        response.doi_url = `https://doi.org/${result.doi}`;
      } else {
        const zenodoId = Number.parseInt(result.providerRecordId);
        if (!Number.isNaN(zenodoId)) {
          response.zenodo_id = zenodoId;
          response.zenodo_url = formatRecordUrl(zenodoId, body.sandbox);
        }
      }

      return c.json(response);
    } catch (error) {
      console.error("Failed to create concept DOI:", error);
      return c.json(
        {
          error: "Failed to create concept DOI",
          details: errorMessage(error),
        },
        500,
      );
    }
  },
);

/**
 * POST /admin/datasets/:id/doi/publish - Publish a version DOI
 *
 * Admin endpoint to manually publish a version DOI.
 * For automated publishing, see the webhook in webhooks.ts.
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
        // Metadata is already set from concept creation; version-specific fields updated below
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
          details: errorMessage(error),
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
    SELECT dataset_id, name, concept_doi, latest_version_doi,
           zenodo_concept_id, zenodo_latest_version_id,
           ezid_identifier, ezid_status, doi_provider
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
      ezid_identifier: string | null;
      ezid_status: string | null;
      doi_provider: string | null;
    }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  return c.json({
    dataset_id: dataset.dataset_id,
    name: dataset.name,
    concept_doi: dataset.concept_doi,
    latest_version_doi: dataset.latest_version_doi,
    doi_provider: dataset.doi_provider || "zenodo",
    zenodo_concept_url: dataset.zenodo_concept_id
      ? formatRecordUrl(Number.parseInt(dataset.zenodo_concept_id))
      : null,
    zenodo_latest_version_url: dataset.zenodo_latest_version_id
      ? formatRecordUrl(Number.parseInt(dataset.zenodo_latest_version_id))
      : null,
    ezid_identifier: dataset.ezid_identifier,
    ezid_status: dataset.ezid_status,
    doi_url: dataset.concept_doi ? `https://doi.org/${dataset.concept_doi}` : null,
  });
});

/**
 * POST /admin/datasets/:id/doi/update - Update EZID DOI metadata or status
 *
 * Allows updating metadata (re-generate DataCite XML from BIDS) or
 * changing status (reserved -> public, or public -> unavailable).
 */
const updateDoiSchema = z.object({
  status: z.enum(["public", "unavailable"]).optional(),
  refresh_metadata: z.boolean().optional().default(false),
});

adminRoutes.post("/datasets/:id/doi/update", zValidator("json", updateDoiSchema), async (c) => {
  const datasetId = c.req.param("id");
  const body = c.req.valid("json");
  const db = c.env.DB;

  const dataset = await db
    .prepare(
      `
      SELECT d.dataset_id, d.concept_doi, d.ezid_identifier, d.ezid_status,
             d.doi_provider, d.github_repo, d.name, d.is_sandbox,
             u.username as owner_username, u.orcid as owner_orcid
      FROM datasets d
      JOIN users u ON d.owner_user_id = u.id
      WHERE d.dataset_id = ?
    `,
    )
    .bind(datasetId)
    .first<{
      dataset_id: string;
      concept_doi: string | null;
      ezid_identifier: string | null;
      ezid_status: string | null;
      doi_provider: string | null;
      github_repo: string | null;
      name: string;
      is_sandbox: number | null;
      owner_username: string;
      owner_orcid: string | null;
    }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  if (dataset.doi_provider !== "ezid" || !dataset.ezid_identifier) {
    return c.json({ error: "DOI update is only supported for EZID-managed DOIs" }, 400);
  }

  const isSandbox = !!dataset.is_sandbox;
  let auth: EzidAuth;
  try {
    auth = resolveEzidAuth(
      {
        EZID_USERNAME: c.env.EZID_USERNAME,
        EZID_PASSWORD: c.env.EZID_PASSWORD,
        EZID_SANDBOX_USERNAME: c.env.EZID_SANDBOX_USERNAME,
        EZID_SANDBOX_PASSWORD: c.env.EZID_SANDBOX_PASSWORD,
      },
      isSandbox,
    );
  } catch (err) {
    console.error("[admin] EZID auth failed:", err);
    return c.json({ error: "EZID credentials not configured" }, 500);
  }

  try {
    const updateOptions: {
      status?: "public" | "unavailable";
      dataciteXml?: string;
      target?: string;
    } = {};
    let metadataRefreshed = false;
    const warnings: string[] = [];

    // Refresh metadata from BIDS
    if (body.refresh_metadata) {
      if (!dataset.github_repo) {
        return c.json({ error: "Cannot refresh metadata: dataset has no GitHub repository" }, 400);
      }
      const repoName = dataset.github_repo.split("/")[1];
      if (!repoName) {
        return c.json({ error: "Cannot refresh metadata: invalid github_repo format" }, 400);
      }
      const tree = await getTreeAtRef(repoName, "main", c.env.GITHUB_ADMIN_PAT);
      const descFile = tree.find((f) => f.path === "dataset_description.json");
      if (!descFile) {
        return c.json(
          { error: "Cannot refresh metadata: dataset_description.json not found in repo" },
          400,
        );
      }
      const content = await getBlobContent(repoName, descFile.sha, c.env.GITHUB_ADMIN_PAT);
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return c.json(
          { error: "Cannot refresh metadata: dataset_description.json is not a valid JSON object" },
          400,
        );
      }
      const bidsDesc = parsed as Record<string, unknown>;
      const doi = extractDoi(dataset.ezid_identifier);
      let enrichment = buildOrcidEnrichment(
        bidsDesc,
        dataset.owner_username,
        dataset.owner_orcid || undefined,
      );

      // Read enrichment metadata (.nemar/metadata.json first, fall back to nemar_metadata.json)
      const nemarMetaFile =
        tree.find((f) => f.path === ".nemar/metadata.json") ||
        tree.find((f) => f.path === "nemar_metadata.json");
      if (nemarMetaFile) {
        try {
          const nemarContent = await getBlobContent(
            repoName,
            nemarMetaFile.sha,
            c.env.GITHUB_ADMIN_PAT,
          );
          const nemarParsed = parseNemarMetadata(JSON.parse(nemarContent));
          if (nemarParsed) {
            enrichment = nemarMetadataToEnrichment(nemarParsed, enrichment);
          }
        } catch (nemarErr) {
          console.error("Failed to parse nemar_metadata.json:", nemarErr);
          warnings.push(
            `nemar_metadata.json enrichment skipped: ${nemarErr instanceof Error ? nemarErr.message : String(nemarErr)}`,
          );
        }
      }

      // Add HasVersion relations for all existing version DOIs
      const versions = await db
        .prepare("SELECT version, doi FROM dataset_versions WHERE dataset_id = ? ORDER BY created_at DESC")
        .bind(datasetId)
        .all<{ version: string; doi: string }>();
      if (versions.results?.length) {
        const hasVersionRels = versions.results.map((v) => ({
          doi: v.doi,
          relationType: "HasVersion" as const,
        }));
        enrichment.relatedDois = [...(enrichment.relatedDois || []), ...hasVersionRels];
      }

      const metadata = bidsToDataCite(datasetId, doi, bidsDesc, enrichment);
      updateOptions.dataciteXml = buildDataCiteXml(metadata);
      updateOptions.target = `https://nemar.org/dataexplorer/detail?dataset_id=${datasetId}`;
      metadataRefreshed = true;
    }

    // Change status
    if (body.status) {
      if (body.status === "public" && dataset.ezid_status === "reserved") {
        updateOptions.status = "public";
        updateOptions.target = `https://nemar.org/dataexplorer/detail?dataset_id=${datasetId}`;
      } else if (body.status === "unavailable") {
        updateOptions.status = "unavailable";
      }
    }

    const updated = await ezidUpdateIdentifier(auth, dataset.ezid_identifier, updateOptions);

    // Update DB
    await db
      .prepare(
        "UPDATE datasets SET ezid_status = ?, updated_at = datetime('now') WHERE dataset_id = ?",
      )
      .bind(updated.status, datasetId)
      .run();

    // Also refresh version DOIs if metadata was refreshed
    let versionDoiUpdated = 0;
    if (metadataRefreshed) {
      const versions = await db
        .prepare("SELECT version, doi FROM dataset_versions WHERE dataset_id = ? ORDER BY created_at DESC")
        .bind(datasetId)
        .all<{ version: string; doi: string }>();

      for (const ver of versions.results || []) {
        try {
          const versionIdentifier = `${dataset.ezid_identifier}.V${ver.version.toUpperCase()}`;
          const repoName = dataset.github_repo!.split("/")[1];
          const tree = await getTreeAtRef(repoName, "main", c.env.GITHUB_ADMIN_PAT);
          const descFile = tree.find((f) => f.path === "dataset_description.json");
          if (!descFile) continue;
          const content = await getBlobContent(repoName, descFile.sha, c.env.GITHUB_ADMIN_PAT);
          const bidsDesc = JSON.parse(content) as Record<string, unknown>;

          let vEnrichment = buildOrcidEnrichment(bidsDesc, dataset.owner_username, dataset.owner_orcid || undefined);
          const nemarMetaFile = tree.find((f) => f.path === ".nemar/metadata.json") || tree.find((f) => f.path === "nemar_metadata.json");
          if (nemarMetaFile) {
            try {
              const nemarContent = await getBlobContent(repoName, nemarMetaFile.sha, c.env.GITHUB_ADMIN_PAT);
              const nemarParsed = parseNemarMetadata(JSON.parse(nemarContent));
              if (nemarParsed) vEnrichment = nemarMetadataToEnrichment(nemarParsed, vEnrichment);
            } catch {}
          }

          const vDoi = extractDoi(versionIdentifier);
          const vMetadata = bidsToDataCite(datasetId, vDoi, bidsDesc, vEnrichment);
          vMetadata.version = ver.version;
          const vXml = buildDataCiteXml(vMetadata);
          const vTarget = `https://nemar.org/dataexplorer/detail?dataset_id=${datasetId}&version=${ver.version}`;
          await ezidUpdateIdentifier(auth, versionIdentifier, { dataciteXml: vXml, target: vTarget });
          versionDoiUpdated++;
        } catch (vErr) {
          warnings.push(`Version ${ver.version} DOI update failed: ${vErr instanceof Error ? vErr.message : String(vErr)}`);
        }
      }
    }

    return c.json({
      message: "DOI updated successfully",
      ezid_identifier: dataset.ezid_identifier,
      status: updated.status,
      doi_url: `https://doi.org/${extractDoi(dataset.ezid_identifier)}`,
      metadata_refreshed: metadataRefreshed,
      version_dois_updated: versionDoiUpdated,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  } catch (error) {
    console.error("Failed to update DOI:", error);
    return c.json(
      {
        error: "Failed to update DOI",
        details: errorMessage(error),
      },
      500,
    );
  }
});

/**
 * POST /admin/datasets/:id/enrichment - Submit rich metadata enrichment
 *
 * Accepts NemarMetadata JSON (v1.0 or v2.0), commits to the dataset repo
 * (v1 at nemar_metadata.json, v2 at .nemar/metadata.json),
 * ensures .bidsignore includes the path, and caches in D1.
 */
const enrichmentSchemaV1 = z.object({
  version: z.literal("1.0"),
  authors: z
    .record(
      z.object({
        orcid: z.string().optional(),
        affiliation: z.string().optional(),
      }),
    )
    .optional(),
  keywords: z.array(z.string()).optional(),
  relatedDois: z
    .array(
      z.object({
        doi: z.string(),
        relationType: z.string(),
      }),
    )
    .optional(),
  fundingReferences: z
    .array(
      z.object({
        funderName: z.string(),
        awardNumber: z.string().optional(),
        awardTitle: z.string().optional(),
      }),
    )
    .optional(),
  description: z.string().optional(),
  methodsDescription: z.string().optional(),
  collectionDates: z.string().optional(),
  geoLocation: z.string().optional(),
  sizes: z.array(z.string()).optional(),
  formats: z.array(z.string()).optional(),
});

const enrichmentSchemaV2 = z.object({
  version: z.literal("2.0"),
  authors: z
    .record(
      z.object({
        orcid: z.string().optional(),
        affiliations: z
          .array(
            z.object({
              name: z.string(),
              identifier: z.string().optional(),
              scheme: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  keywords: z
    .array(
      z.object({
        term: z.string(),
        subject_scheme: z.string().optional(),
        scheme_uri: z.string().optional(),
        value_uri: z.string().optional(),
        classification_code: z.string().optional(),
      }),
    )
    .optional(),
  related_identifiers: z
    .array(
      z.object({
        identifier: z.string(),
        identifier_type: z.string(),
        relation_type: z.string(),
        resource_type_general: z.string().optional(),
      }),
    )
    .optional(),
  funding_references: z
    .array(
      z.object({
        funder_name: z.string(),
        funder_identifier: z.string().optional(),
        funder_identifier_type: z.string().optional(),
        award_number: z.string().optional(),
        award_title: z.string().optional(),
        award_uri: z.string().optional(),
      }),
    )
    .optional(),
  contributors: z
    .array(
      z.object({
        name: z.string(),
        name_type: z.string().optional(),
        given_name: z.string().optional(),
        family_name: z.string().optional(),
        orcid: z.string().optional(),
        contributor_type: z.string(),
      }),
    )
    .optional(),
  dates: z
    .array(
      z.object({
        date: z.string(),
        date_type: z.string(),
        date_information: z.string().optional(),
      }),
    )
    .optional(),
  geo_locations: z
    .array(
      z.object({
        place: z.string().optional(),
        point: z
          .object({
            latitude: z.number(),
            longitude: z.number(),
          })
          .optional(),
      }),
    )
    .optional(),
  description: z.string().optional(),
  methods_description: z.string().optional(),
  resource_type_general: z.string().optional(),
  sizes: z.array(z.string()).optional(),
  formats: z.array(z.string()).optional(),
});

const enrichmentSchema = z.discriminatedUnion("version", [enrichmentSchemaV1, enrichmentSchemaV2]);

adminRoutes.post("/datasets/:id/enrichment", zValidator("json", enrichmentSchema), async (c) => {
  const datasetId = c.req.param("id");
  const body = c.req.valid("json");
  const db = c.env.DB;

  const dataset = await db
    .prepare(
      "SELECT dataset_id, github_repo, ezid_identifier, doi_provider, is_sandbox FROM datasets WHERE dataset_id = ?",
    )
    .bind(datasetId)
    .first<{
      dataset_id: string;
      github_repo: string | null;
      ezid_identifier: string | null;
      doi_provider: string | null;
      is_sandbox: number | null;
    }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  if (!dataset.github_repo) {
    return c.json({ error: "Dataset has no GitHub repository" }, 400);
  }

  const repoName = dataset.github_repo.split("/")[1];
  if (!repoName) {
    return c.json({ error: "Invalid github_repo format" }, 400);
  }

  const pat = c.env.GITHUB_ADMIN_PAT;
  const metadataContent = JSON.stringify(body, null, 2);
  const isV2 = body.version === "2.0";
  const metadataPath = isV2 ? ".nemar/metadata.json" : "nemar_metadata.json";

  try {
    // Commit metadata to the repo (v2 uses .nemar/metadata.json, v1 uses nemar_metadata.json)
    await createOrUpdateFile(
      repoName,
      metadataPath,
      metadataContent,
      "Update NEMAR metadata enrichment",
      pat,
    );

    // Ensure .bidsignore includes the metadata path
    const tree = await getTreeAtRef(repoName, "main", pat);
    const bidsignoreFile = tree.find((f) => f.path === ".bidsignore");
    let bidsignoreContent = "";
    if (bidsignoreFile) {
      bidsignoreContent = await getBlobContent(repoName, bidsignoreFile.sha, pat);
    }
    const entriesToIgnore = isV2 ? [".nemar/"] : ["nemar_metadata.json"];
    let bidsignoreUpdated = false;
    for (const entry of entriesToIgnore) {
      if (!bidsignoreContent.includes(entry)) {
        bidsignoreContent = bidsignoreContent
          ? `${bidsignoreContent.trimEnd()}\n${entry}\n`
          : `${entry}\n`;
        bidsignoreUpdated = true;
      }
    }
    if (bidsignoreUpdated) {
      await createOrUpdateFile(
        repoName,
        ".bidsignore",
        bidsignoreContent,
        "Update .bidsignore for metadata",
        pat,
      );
    }

    // Cache in D1
    await db
      .prepare(
        "UPDATE datasets SET enrichment_json = ?, enrichment_updated_at = datetime('now'), updated_at = datetime('now') WHERE dataset_id = ?",
      )
      .bind(metadataContent, datasetId)
      .run();

    return c.json({
      message: "Enrichment saved",
      dataset_id: datasetId,
      committed: true,
      bidsignore_updated: bidsignoreUpdated,
    });
  } catch (error) {
    console.error("Failed to save enrichment:", error);
    return c.json(
      {
        error: "Failed to save enrichment",
        details: errorMessage(error),
      },
      500,
    );
  }
});

/**
 * GET /admin/datasets/:id/files - Get dataset file listing with sizes
 *
 * Returns file listing from the GitHub repo tree for computing sizes and formats.
 */
adminRoutes.get("/datasets/:id/files", async (c) => {
  const datasetId = c.req.param("id");
  const db = c.env.DB;

  const dataset = await db
    .prepare("SELECT github_repo FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ github_repo: string | null }>();

  if (!dataset?.github_repo) {
    return c.json({ error: "Dataset not found or has no GitHub repository" }, 404);
  }

  const repoName = dataset.github_repo.split("/")[1];
  if (!repoName) {
    return c.json({ error: "Invalid github_repo format" }, 400);
  }

  try {
    const tree = await getTreeAtRef(repoName, "main", c.env.GITHUB_ADMIN_PAT);
    const files = tree
      .filter((f) => f.type === "blob")
      .map((f) => ({ path: f.path, size: f.size || 0 }));

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const extensions = [
      ...new Set(
        files
          .map((f) => {
            const lastDot = f.path.lastIndexOf(".");
            return lastDot > 0 ? f.path.slice(lastDot) : null;
          })
          .filter((e): e is string => e !== null),
      ),
    ].sort();

    return c.json({
      dataset_id: datasetId,
      file_count: files.length,
      total_size: totalSize,
      extensions,
      files,
    });
  } catch (error) {
    console.error("Failed to fetch file listing:", error);
    return c.json(
      {
        error: "Failed to fetch file listing",
        details: errorMessage(error),
      },
      500,
    );
  }
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
    const errMsg = errorMessage(error);
    console.error(`Failed to delete Zenodo deposition ${depositionId}:`, errMsg);

    return c.json(
      {
        error: "Failed to delete deposition",
        message: errMsg,
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

  // Update S3 bucket policy based on visibility
  try {
    if (visibility === "public") {
      await addPublicReadPolicy(getS3Config(c.env), datasetId);
    } else {
      // Remove public read access when reverting to private
      await removePublicReadPolicy(getS3Config(c.env), datasetId);
    }
  } catch (s3Error) {
    const s3Msg = s3Error instanceof Error ? s3Error.message : String(s3Error);
    console.error(`WARNING: Failed to update S3 policy for ${datasetId}:`, s3Msg);
    // GitHub visibility changed but S3 policy failed - revert GitHub
    const revertResult = await setRepoVisibility(repoName, !isPrivate, c.env.GITHUB_ADMIN_PAT);
    if (revertResult.ok) {
      return c.json(
        {
          error: `Failed to update S3 bucket policy, reverted GitHub repository to ${isPrivate ? "public" : "private"}`,
          details: s3Msg,
          dataset_id: datasetId,
        },
        500,
      );
    }
    return c.json(
      {
        error: "CRITICAL: S3 policy update failed AND GitHub revert failed",
        details: s3Msg,
        dataset_id: datasetId,
        github_visibility: visibility,
        s3_public: visibility === "private",
        revert_error: revertResult.error,
        action_required: `Manually revert GitHub repo to ${isPrivate ? "public" : "private"} OR manually ${visibility === "public" ? "add" : "remove"} S3 public read policy for ${datasetId}`,
      },
      500,
    );
  }

  // Helper to revert GitHub + S3 visibility changes on DB failure
  async function revertVisibilityChanges(errorDetails: string): Promise<Response> {
    const ghRevertResult = await setRepoVisibility(repoName, !isPrivate, c.env.GITHUB_ADMIN_PAT);

    let s3Reverted = false;
    try {
      const s3Opts = getS3Config(c.env);
      if (visibility === "public") {
        await removePublicReadPolicy(s3Opts, datasetId);
      } else {
        await addPublicReadPolicy(s3Opts, datasetId);
      }
      s3Reverted = true;
    } catch (s3RevertError) {
      console.error(`S3 policy revert failed for ${datasetId}:`, s3RevertError);
    }

    if (ghRevertResult.ok && s3Reverted) {
      return c.json(
        {
          error: "Database update failed, reverted GitHub and S3 to original state",
          details: errorDetails,
          dataset_id: datasetId,
        },
        500,
      );
    }

    return c.json(
      {
        error: "CRITICAL: Database update failed AND rollback incomplete",
        details: errorDetails,
        dataset_id: datasetId,
        github_visibility: visibility,
        github_reverted: ghRevertResult.ok,
        s3_reverted: s3Reverted,
        database_visibility: visibility === "public" ? "private" : "public",
        revert_error: ghRevertResult.ok ? undefined : ghRevertResult.error,
        action_required:
          `Manually fix: ${!ghRevertResult.ok ? `revert GitHub to ${!isPrivate ? "public" : "private"}` : ""} ${!s3Reverted ? `revert S3 policy for ${datasetId}` : ""} update database SET visibility = '${visibility}' WHERE dataset_id = '${datasetId}'`.trim(),
      },
      500,
    );
  }

  // Update dataset visibility in database to match GitHub repo
  let dbUpdateResult: D1Result;
  try {
    dbUpdateResult = await db
      .prepare("UPDATE datasets SET visibility = ? WHERE dataset_id = ?")
      .bind(visibility, datasetId)
      .run();

    if (!dbUpdateResult.success || dbUpdateResult.meta.changes === 0) {
      const errorDetails =
        dbUpdateResult.meta.changes === 0
          ? "Dataset not found in database"
          : "Database update did not succeed";

      console.error(
        `CRITICAL: Failed to update database visibility for ${datasetId}. GitHub is now ${visibility} but database is out of sync.`,
      );

      return revertVisibilityChanges(errorDetails);
    }
  } catch (dbError) {
    const msg = dbError instanceof Error ? dbError.message : String(dbError);
    console.error(`CRITICAL: Exception updating database visibility for ${datasetId}:`, msg);

    return revertVisibilityChanges(msg);
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
    console.error(
      "AUDIT LOG FAILURE: Visibility change for dataset",
      datasetId,
      "was not logged:",
      auditLogError,
    );
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

  const WORKFLOW_FILES = [
    "bids-validation.yml",
    "version-check.yml",
    "pr-merge.yml",
    "generate-archive.yml",
    "llm-enrichment.yml",
  ];
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
 *  1. ci_check - Verify CI exists and is passing (deploy if missing)
 *  2. repo_public - Make repository public
 *  3. s3_public_read - Add public read S3 bucket policy for dataset
 *  4. tag_protect - Apply tag protection rules (prevent version tag deletion)
 *  5. doi_create - Create concept DOI if not exists
 *  6. update_metadata - Update dataset_description.json with DOI
 *  7. update_readme - Generate/update README with dataset info
 *  8. create_tag - Create git tag for the version
 *  9. create_release - Create GitHub release from tag
 * 10. upload_to_zenodo - Upload release archive to Zenodo
 * 11. publish_doi - Publish the Zenodo DOI (permanent and irreversible!)
 * 12. s3_lock - Apply S3 Object Lock (Governance mode)
 * 13. generate_archive - Trigger archive zip generation (async, non-blocking)
 * 14. notify_user - Send publication confirmation email
 *
 * Body: { resume?: boolean } - if true, skip already-completed steps
 */
const approveSchema = z.object({
  resume: z.boolean().optional().default(false),
  sandbox: z.boolean().optional().default(false),
  s3_lock_offset: z.number().optional(),
  skip_ci_check: z.boolean().optional().default(false),
});

adminRoutes.post("/publish/:id/approve", zValidator("json", approveSchema), async (c) => {
  const datasetId = c.req.param("id");
  const { resume, sandbox } = c.req.valid("json");
  const body = c.req.valid("json");
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

  const stepsCompleted: PublicationStep[] = resume
    ? JSON.parse(request.steps_completed || "[]")
    : [];
  const allSteps: readonly PublicationStep[] = [
    "ci_check",
    "enrichment_check",
    "repo_public",
    "s3_public_read",
    "tag_protect",
    "doi_create",
    "update_metadata",
    "update_readme",
    "create_tag",
    "create_release",
    "upload_to_zenodo",
    "publish_doi", // Permanent and irreversible!
    "s3_lock",
    "generate_archive",
    "notify_user",
  ] as const;
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
      `SELECT d.*, u.username as owner_username, u.email as owner_email, u.orcid as owner_orcid
       FROM datasets d
       JOIN users u ON d.owner_user_id = u.id
       WHERE d.dataset_id = ?`,
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
      ezid_identifier: string | null;
      ezid_status: string | null;
      doi_provider: string | null;
      is_sandbox: number | null;
      owner_username: string;
      owner_email: string;
      owner_orcid: string | null;
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
  const completed: PublicationStep[] = [...stepsCompleted];
  const requestId = request.id;
  const stepResults: StepResult[] = [];

  // Track step start time for duration measurement
  let currentStepStartMs = 0;

  // Helper to set current step before execution. Non-fatal on failure.
  async function startStep(step: PublicationStep) {
    currentStepStartMs = Date.now();
    try {
      await db
        .prepare(
          "UPDATE publication_requests SET current_step = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(step, requestId)
        .run();
    } catch (dbErr) {
      console.error(`[publish] Failed to set current_step to ${step}:`, dbErr);
    }
  }

  // Helper to update progress in D1. Catches its own errors to avoid
  // masking the original failure when called inside catch blocks.
  async function updateProgress(step: PublicationStep, error?: string, attempts = 1) {
    const duration_ms = currentStepStartMs > 0 ? Date.now() - currentStepStartMs : 0;
    if (!error) {
      completed.push(step);
      stepResults.push({ step, status: "completed", attempts, duration_ms });
    } else {
      stepResults.push({ step, status: "failed", attempts, duration_ms, error });
    }
    try {
      await db
        .prepare(
          `UPDATE publication_requests
           SET steps_completed = ?, current_step = ?, last_error = ?, updated_at = datetime('now')
           WHERE id = ?`,
        )
        .bind(JSON.stringify(completed), error ? step : null, error || null, requestId)
        .run();
    } catch (dbErr) {
      console.error(
        `[publish] CRITICAL: Failed to update progress for step ${step}, dataset ${datasetId}:`,
        dbErr,
      );
    }
  }

  // Step 1: CI Check
  if (stepsToRun.includes("ci_check")) {
    if (body.skip_ci_check) {
      console.warn(`[publish] CI check skipped by admin ${adminUser.username} for ${datasetId}`);
      await updateProgress("ci_check");
    } else {
      try {
        await startStep("ci_check");

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
                step_results: stepResults,
              },
              422,
            );
          }
        }

        await updateProgress("ci_check");
      } catch (err) {
        const msg = errorMessage(err);
        await updateProgress("ci_check", msg);
        return c.json(
          { error: `CI check failed: ${msg}`, step: "ci_check", steps_completed: completed, step_results: stepResults },
          500,
        );
      }
    }
  }

  // Step 2: Enrichment check (warn-only, does not block publication)
  if (stepsToRun.includes("enrichment_check")) {
    try {
      await startStep("enrichment_check");

      const enrichRow = await db
        .prepare("SELECT enrichment_json FROM datasets WHERE dataset_id = ?")
        .bind(datasetId)
        .first<{ enrichment_json: string | null }>();

      if (!enrichRow?.enrichment_json) {
        console.warn(
          `[publish] Dataset ${datasetId} has no LLM enrichment metadata. DOI will have minimal metadata.`,
        );
      }

      await updateProgress("enrichment_check");
    } catch (err) {
      // Non-fatal: log error and continue (enrichment check should not block publication)
      console.warn(
        `[publish] Enrichment check failed for ${datasetId} (non-fatal): ${errorMessage(err)}`,
      );
      await updateProgress("enrichment_check");
    }
  }

  // Step 3: Make repo public
  if (stepsToRun.includes("repo_public")) {
    try {
      await startStep("repo_public");

      const result = await setRepoVisibility(repoName, false, pat);
      if (!result.ok) {
        await updateProgress("repo_public", `Failed to make repo public: ${result.error}`);
        return c.json(
          {
            error: `Failed to make repo public: ${result.error}`,
            step: "repo_public",
            steps_completed: completed,
            step_results: stepResults,
          },
          500,
        );
      }

      // Update dataset visibility in database to match GitHub repo visibility
      let dbUpdateResult: D1Result;
      try {
        dbUpdateResult = await db
          .prepare(
            "UPDATE datasets SET visibility = 'public', updated_at = datetime('now') WHERE dataset_id = ?",
          )
          .bind(datasetId)
          .run();

        if (!dbUpdateResult.success) {
          throw new Error("Database update did not succeed");
        }

        if (dbUpdateResult.meta.changes === 0) {
          throw new Error("Dataset not found in database");
        }

        // Verify the write persisted (read-after-write check)
        const verify = await db
          .prepare("SELECT visibility FROM datasets WHERE dataset_id = ?")
          .bind(datasetId)
          .first<{ visibility: string }>();

        if (!verify || verify.visibility !== "public") {
          console.error(
            `[publish] CRITICAL: Visibility read-after-write mismatch for ${datasetId}: expected 'public', got '${verify?.visibility}'`,
          );
          throw new Error(
            `Read-after-write verification failed: visibility is '${verify?.visibility}' instead of 'public'`,
          );
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
            step_results: stepResults,
          },
          500,
        );
      }

      await updateProgress("repo_public");
    } catch (err) {
      const msg = errorMessage(err);
      await updateProgress("repo_public", msg);
      return c.json(
        { error: `repo_public failed: ${msg}`, step: "repo_public", steps_completed: completed, step_results: stepResults },
        500,
      );
    }
  }

  // Step 3: Add S3 public read bucket policy
  if (stepsToRun.includes("s3_public_read")) {
    try {
      await startStep("s3_public_read");

      const { attempts: s3PublicAttempts } = await withRetry(
        () => addPublicReadPolicy(getS3Config(c.env), datasetId),
        "s3_public_read",
      );

      await updateProgress("s3_public_read", undefined, s3PublicAttempts);
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[publish] S3 public read policy failed for ${datasetId}:`, err);
      await updateProgress("s3_public_read", msg);
      return c.json(
        {
          error: `S3 public read policy failed: ${msg}`,
          step: "s3_public_read",
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
  }

  // Step 4: Tag protection (before DOI to prevent tag manipulation)
  if (stepsToRun.includes("tag_protect")) {
    try {
      await startStep("tag_protect");

      const { applyTagProtection } = await import("../services/github");
      const tagProtected = await applyTagProtection(repoName, pat);

      if (!tagProtected) {
        await updateProgress("tag_protect", "Failed to apply tag protection rules");
        return c.json(
          {
            error: "Tag protection failed",
            step: "tag_protect",
            steps_completed: completed,
            step_results: stepResults,
          },
          500,
        );
      }

      await updateProgress("tag_protect");
    } catch (err) {
      const msg = errorMessage(err);
      await updateProgress("tag_protect", msg);
      return c.json(
        { error: `Tag protection failed: ${msg}`, step: "tag_protect", steps_completed: completed, step_results: stepResults },
        500,
      );
    }
  }

  // Step 5: Create concept DOI (if not exists)
  if (stepsToRun.includes("doi_create")) {
    try {
      await startStep("doi_create");

      if (!dataset.concept_doi) {
        // SAFETY: Block production DOI creation in non-production environments
        if (!sandbox) {
          const environment = c.env.ENVIRONMENT;
          if (!environment) {
            await updateProgress("doi_create", "ENVIRONMENT variable not configured");
            return c.json(
              {
                error: "Server misconfiguration: ENVIRONMENT variable not set",
                message:
                  "Cannot create production DOIs without explicit environment configuration. Use --sandbox for testing.",
                step: "doi_create",
                steps_completed: completed,
                step_results: stepResults,
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
                step_results: stepResults,
              },
              400,
            );
          }
        }

        // Determine provider: use dataset's setting or default to ezid
        const provider = parseDoiProvider(dataset.doi_provider);

        // Read BIDS metadata and enrichment for richer DOI records
        let bidsDesc: Record<string, unknown> | undefined;
        let enrichment: DataCiteEnrichment | undefined;
        if (repoName) {
          const descResult = await readDatasetDescription("doi_create");
          if (descResult instanceof Response) return descResult;
          bidsDesc = descResult;

          // Read .nemar/metadata.json enrichment (same pattern as doi update)
          const tree = await getTreeAtRef(repoName, "main", pat);
          const nemarMetaFile =
            tree.find((f) => f.path === ".nemar/metadata.json") ||
            tree.find((f) => f.path === "nemar_metadata.json");
          if (nemarMetaFile) {
            try {
              const nemarContent = await getBlobContent(repoName, nemarMetaFile.sha, pat);
              const nemarParsed = parseNemarMetadata(JSON.parse(nemarContent));
              if (nemarParsed) {
                enrichment = nemarMetadataToEnrichment(nemarParsed);
              }
            } catch (nemarErr) {
              console.warn(`[publish] doi_create: .nemar/metadata.json enrichment skipped:`, nemarErr);
            }
          }
        }

        const { createConceptDoi: doiDispatch } = await import("../services/doi");
        const { result: doiResult, attempts: doiAttempts } = await withRetry(
          () =>
            doiDispatch(
              {
                provider,
                datasetId,
                datasetName: dataset.name,
                datasetDescription: dataset.description,
                githubRepo: dataset.github_repo,
                bidsDescription: bidsDesc,
                enrichment,
                uploaderOrcid: dataset.owner_orcid || undefined,
                uploaderName: dataset.owner_username,
                sandbox,
              },
              {
                EZID_USERNAME: c.env.EZID_USERNAME,
                EZID_PASSWORD: c.env.EZID_PASSWORD,
                EZID_SANDBOX_USERNAME: c.env.EZID_SANDBOX_USERNAME,
                EZID_SANDBOX_PASSWORD: c.env.EZID_SANDBOX_PASSWORD,
                ZENODO_API_KEY: c.env.ZENODO_API_KEY,
                ZENODO_SANDBOX_API_KEY: c.env.ZENODO_SANDBOX_API_KEY,
              },
            ),
          "doi_create",
        );

        if (provider === "ezid") {
          await db
            .prepare(
              "UPDATE datasets SET concept_doi = ?, ezid_identifier = ?, ezid_status = ?, doi_provider = 'ezid', is_sandbox = ?, updated_at = datetime('now') WHERE dataset_id = ?",
            )
            .bind(
              doiResult.doi,
              doiResult.providerRecordId,
              doiResult.status,
              sandbox ? 1 : 0,
              datasetId,
            )
            .run();
        } else {
          await db
            .prepare(
              "UPDATE datasets SET concept_doi = ?, zenodo_concept_id = ?, doi_provider = 'zenodo', is_sandbox = ?, updated_at = datetime('now') WHERE dataset_id = ?",
            )
            .bind(doiResult.doi, doiResult.providerRecordId, sandbox ? 1 : 0, datasetId)
            .run();
        }

        await updateProgress("doi_create", undefined, doiAttempts);
      } else {
        await updateProgress("doi_create");
      }
    } catch (err) {
      const msg = errorMessage(err);
      await updateProgress("doi_create", msg);
      return c.json(
        {
          error: `DOI creation failed: ${msg}`,
          step: "doi_create",
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
  }

  // --- Helper: read dataset_description.json from repo ---
  async function readDatasetDescription(
    stepName: PublicationStep,
  ): Promise<Record<string, unknown> | Response> {
    const tree = await getTreeAtRef(repoName, "main", pat);
    const descFile = tree.find((f) => f.path === "dataset_description.json");
    if (!descFile) {
      await updateProgress(stepName, "dataset_description.json not found in repo");
      return c.json(
        {
          error: "dataset_description.json not found in repository",
          step: stepName,
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
    const content = await getBlobContent(repoName, descFile.sha, pat);
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch (parseErr) {
      const parseMsg = `dataset_description.json contains invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`;
      console.error(
        `[publish] ${parseMsg} for ${repoName}. Content starts with: ${content.substring(0, 200)}`,
      );
      await updateProgress(stepName, parseMsg);
      return c.json({ error: parseMsg, step: stepName, steps_completed: completed, step_results: stepResults }, 500);
    }
  }

  // --- Helper: get concept DOI from database ---
  async function getConceptDoi(stepName: PublicationStep): Promise<string | Response> {
    const row = await db
      .prepare("SELECT concept_doi FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ concept_doi: string | null }>();
    if (!row?.concept_doi) {
      await updateProgress(stepName, "No concept DOI found");
      return c.json(
        {
          error: `Cannot run ${stepName}: no concept DOI found`,
          step: stepName,
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
    return row.concept_doi;
  }

  // --- Helper: get Zenodo config from database ---
  async function getZenodoConfig(
    stepName: PublicationStep,
  ): Promise<{ depositionId: number; token: string; isSandbox: boolean } | Response> {
    const row = await db
      .prepare("SELECT zenodo_concept_id, is_sandbox FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ zenodo_concept_id: string | null; is_sandbox: number | null }>();
    if (!row?.zenodo_concept_id) {
      await updateProgress(stepName, "No Zenodo deposition found");
      return c.json(
        { error: "No Zenodo deposition ID found", step: stepName, steps_completed: completed, step_results: stepResults },
        500,
      );
    }
    const depositionId = Number.parseInt(row.zenodo_concept_id, 10);
    if (Number.isNaN(depositionId)) {
      const msg = `Invalid Zenodo deposition ID: ${row.zenodo_concept_id}`;
      console.error(`[publish] ${msg} for dataset ${datasetId}`);
      await updateProgress(stepName, msg);
      return c.json({ error: msg, step: stepName, steps_completed: completed, step_results: stepResults }, 500);
    }
    const isSandbox = row.is_sandbox === 1;
    const token = isSandbox ? c.env.ZENODO_SANDBOX_API_KEY : c.env.ZENODO_API_KEY;
    if (!token) {
      const msg = isSandbox
        ? "Zenodo sandbox API key not configured"
        : "Zenodo API key not configured";
      await updateProgress(stepName, msg);
      return c.json({ error: msg, step: stepName, steps_completed: completed, step_results: stepResults }, 500);
    }
    return { depositionId, token, isSandbox };
  }

  // --- Helper: get version and tag from dataset_description.json ---
  async function getVersionTag(
    stepName: PublicationStep,
  ): Promise<{ version: string; tag: string; datasetDesc: Record<string, unknown> } | Response> {
    const result = await readDatasetDescription(stepName);
    if (result instanceof Response) return result;
    const datasetDesc = result;
    if (!datasetDesc.Version) {
      console.info(
        `[publish] No Version in dataset_description.json for ${repoName}; defaulting to 1.0.0`,
      );
      datasetDesc.Version = "1.0.0";
      try {
        await createOrUpdateFile(
          repoName,
          "dataset_description.json",
          JSON.stringify(datasetDesc, null, 2),
          "Set initial version to 1.0.0 for DOI publication",
          pat,
        );
      } catch (writeErr) {
        const msg = `Failed to write default Version to dataset_description.json: ${errorMessage(writeErr)}`;
        console.error(`[publish] ${msg}`);
        await updateProgress(stepName, msg);
        return c.json({ error: msg, step: stepName, steps_completed: completed, step_results: stepResults }, 500);
      }
    }
    const version = String(datasetDesc.Version);
    return { version, tag: `v${version}`, datasetDesc };
  }

  // Step: update_metadata - Update dataset_description.json with DOI
  if (stepsToRun.includes("update_metadata")) {
    try {
      await startStep("update_metadata");

      // Get concept DOI (set by the doi_create step above)
      const doiResult = await getConceptDoi("update_metadata");
      if (doiResult instanceof Response) return doiResult;
      const conceptDoi = doiResult;

      const descResult = await readDatasetDescription("update_metadata");
      if (descResult instanceof Response) return descResult;
      const datasetDesc = descResult;

      datasetDesc.DatasetDOI = conceptDoi;

      await createOrUpdateFile(
        repoName,
        "dataset_description.json",
        JSON.stringify(datasetDesc, null, 2),
        `Update DatasetDOI with concept DOI: ${conceptDoi}`,
        pat,
      );

      await updateProgress("update_metadata");
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[publish] update_metadata failed for dataset ${datasetId}:`, err);
      await updateProgress("update_metadata", msg);
      return c.json(
        {
          error: `Metadata update failed: ${msg}`,
          step: "update_metadata",
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
  }

  // Step: update_readme - Update README.md with DOI badge
  if (stepsToRun.includes("update_readme")) {
    try {
      await startStep("update_readme");

      const doiResult = await getConceptDoi("update_readme");
      if (doiResult instanceof Response) return doiResult;
      const conceptDoi = doiResult;
      const doiUrl = `https://doi.org/${conceptDoi}`;
      const doiProvider = parseDoiProvider(dataset.doi_provider);
      const badgeImg =
        doiProvider === "zenodo"
          ? `https://zenodo.org/badge/DOI/${conceptDoi}.svg`
          : `https://img.shields.io/badge/DOI-${encodeURIComponent(conceptDoi)}-blue`;
      const doiBadge = `[![DOI](${badgeImg})](${doiUrl})`;

      const tree = await getTreeAtRef(repoName, "main", pat);
      // Find all README variants in the repo
      const readmeCandidates = ["README.md", "README.rst", "README.txt", "README"];
      const foundReadmes: { path: string; sha: string }[] = [];
      for (const candidate of readmeCandidates) {
        const found = tree.find((f) => f.path === candidate);
        if (found) foundReadmes.push(found);
      }

      // Use the best available README for content (prefer README.md, then others in order)
      const contentSource = foundReadmes[0];
      let readmeContent = "";
      if (contentSource) {
        readmeContent = await getBlobContent(repoName, contentSource.sha, pat);
      } else {
        console.warn(`[publish] No README found in ${repoName}; creating README.md with DOI badge`);
      }

      // Add DOI badge if no DOI badge exists yet.
      const hasBadge =
        readmeContent.includes("zenodo.org/badge/DOI") ||
        readmeContent.includes("img.shields.io/badge/DOI");
      if (!hasBadge) {
        readmeContent = `${doiBadge}\n\n${readmeContent}`;
      }

      // Always write to README.md (GitHub requires .md for badge rendering)
      const isRename = contentSource && contentSource.path !== "README.md";
      await createOrUpdateFile(
        repoName,
        "README.md",
        readmeContent,
        isRename
          ? `Rename ${contentSource.path} to README.md and add DOI badge: ${conceptDoi}`
          : `Add DOI badge: ${conceptDoi}`,
        pat,
      );

      // Delete any non-.md README files (handles both fresh rename and resume after partial run)
      for (const readme of foundReadmes) {
        if (readme.path === "README.md") continue;
        await deleteRepoFile(
          repoName,
          readme.path,
          readme.sha,
          `Remove old ${readme.path} (renamed to README.md)`,
          pat,
        );
        console.log(`[publish] Removed ${readme.path} from ${repoName} (using README.md)`);
        if (readme.path.endsWith(".rst")) {
          console.warn(
            `[publish] Warning: ${readme.path} was RST; content may not render correctly as Markdown`,
          );
        }
      }

      // Update GitHub repo description with dataset name and DOI
      const { setRepoDescription } = await import("../services/github.js");
      const descResult = await setRepoDescription(
        repoName,
        `${dataset.name} - DOI: ${conceptDoi}`,
        pat,
      );
      if (!descResult.ok) {
        console.warn(`[publish] Failed to set repo description (non-fatal): ${descResult.error}`);
      }

      await updateProgress("update_readme");
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[publish] update_readme failed for dataset ${datasetId}:`, err);
      await updateProgress("update_readme", msg);
      return c.json(
        {
          error: `README update failed: ${msg}`,
          step: "update_readme",
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
  }

  // Step: create_tag - Create git tag for version
  if (stepsToRun.includes("create_tag")) {
    try {
      await startStep("create_tag");

      const vtResult = await getVersionTag("create_tag");
      if (vtResult instanceof Response) return vtResult;
      const { tag, datasetDesc } = vtResult;

      const commitSha = await getMainBranchSha(repoName, "main", pat);

      const { attempts: createTagAttempts } = await withRetry(
        () =>
          createTag(
            repoName,
            tag,
            commitSha,
            `Release ${tag} - DOI: ${datasetDesc.DatasetDOI || "pending"}`,
            pat,
          ),
        "create_tag",
      );

      await updateProgress("create_tag", undefined, createTagAttempts);
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[publish] create_tag failed for dataset ${datasetId}:`, err);
      await updateProgress("create_tag", msg);
      return c.json(
        {
          error: `Tag creation failed: ${msg}`,
          step: "create_tag",
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
  }

  // Step: create_release - Create GitHub release
  if (stepsToRun.includes("create_release")) {
    try {
      await startStep("create_release");

      const vtResult = await getVersionTag("create_release");
      if (vtResult instanceof Response) return vtResult;
      const { version, tag, datasetDesc } = vtResult;

      const doiInfo = datasetDesc.DatasetDOI ? `DOI: ${datasetDesc.DatasetDOI}` : "";
      const releaseBody = `# ${dataset.name} - Version ${version}\n\n${doiInfo}\n\nBIDS-formatted dataset published via NEMAR.`;

      const { attempts: createReleaseAttempts } = await withRetry(
        () => createRelease(repoName, tag, `${dataset.name} ${tag}`, releaseBody, pat),
        "create_release",
      );

      await updateProgress("create_release", undefined, createReleaseAttempts);
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[publish] create_release failed for dataset ${datasetId}:`, err);
      await updateProgress("create_release", msg);
      return c.json(
        {
          error: `Release creation failed: ${msg}`,
          step: "create_release",
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
  }

  // Step: upload_to_zenodo - Upload release archive to Zenodo
  // For Zenodo provider: upload to existing deposition
  // For EZID provider: create a draft Zenodo deposition as backup archive (never published)
  if (stepsToRun.includes("upload_to_zenodo")) {
    const provider = parseDoiProvider(dataset.doi_provider);
    if (provider === "ezid") {
      try {
        await startStep("upload_to_zenodo");

        const vtResult = await getVersionTag("upload_to_zenodo");
        if (vtResult instanceof Response) return vtResult;
        const { tag } = vtResult;

        const archiveData = await downloadReleaseArchive(repoName, tag, pat);

        // Determine sandbox from EZID test shoulder prefix
        const sandboxPrefix = TEST_SHOULDER.replace(/^doi:/, "").split("/")[0];
        const isSandbox = dataset.ezid_identifier?.includes(sandboxPrefix) ?? false;
        const zenodoToken = isSandbox ? c.env.ZENODO_SANDBOX_API_KEY : c.env.ZENODO_API_KEY;

        if (!zenodoToken) {
          console.warn(
            `[publish] No Zenodo API key for backup archive (sandbox=${isSandbox}); skipping`,
          );
          await updateProgress("upload_to_zenodo");
        } else {
          // Check if we already have a Zenodo backup deposition
          let depositionId: number | null = null;
          const row = await db
            .prepare("SELECT zenodo_concept_id FROM datasets WHERE dataset_id = ?")
            .bind(datasetId)
            .first<{ zenodo_concept_id: string | null }>();

          if (row?.zenodo_concept_id) {
            depositionId = Number.parseInt(row.zenodo_concept_id, 10);
          }

          if (!depositionId || Number.isNaN(depositionId)) {
            // Create a new draft deposition for backup
            const deposition = await createDeposition(
              {
                title: `${dataset.name} (NEMAR backup archive)`,
                description: `Backup archive for NEMAR dataset ${datasetId}. Primary DOI: ${dataset.concept_doi}`,
                creators: [{ name: "NEMAR" }],
                keywords: ["BIDS", "neuroscience", "NEMAR", "backup"],
                version: tag.replace(/^v/, ""),
              },
              zenodoToken,
              isSandbox,
            );
            depositionId = deposition.id;

            // Store the Zenodo deposition ID for future versions
            await db
              .prepare(
                "UPDATE datasets SET zenodo_concept_id = ?, updated_at = datetime('now') WHERE dataset_id = ?",
              )
              .bind(String(depositionId), datasetId)
              .run();
          }

          const deposition = await getDeposition(depositionId, zenodoToken, isSandbox);
          if (deposition.links.bucket) {
            const filename = `${datasetId}-${tag}.zip`;
            await withRetry(
              () =>
                uploadFile(
                  depositionId as number,
                  deposition.links.bucket as string,
                  filename,
                  archiveData,
                  zenodoToken,
                  isSandbox,
                ),
              "upload_to_zenodo (backup)",
            );
          } else {
            console.warn(
              `[publish] Zenodo backup deposition ${depositionId} has no bucket URL; skipping upload`,
            );
          }

          await updateProgress("upload_to_zenodo");
        }
      } catch (err) {
        // Zenodo backup is non-fatal for EZID datasets; log and continue
        console.error(`[publish] Zenodo backup failed for ${datasetId} (non-fatal):`, err);
        await updateProgress("upload_to_zenodo");
      }
    } else {
      try {
        await startStep("upload_to_zenodo");

        const vtResult = await getVersionTag("upload_to_zenodo");
        if (vtResult instanceof Response) return vtResult;
        const { tag } = vtResult;

        const archiveData = await downloadReleaseArchive(repoName, tag, pat);

        const zenodoResult = await getZenodoConfig("upload_to_zenodo");
        if (zenodoResult instanceof Response) return zenodoResult;
        const { depositionId, token: zenodoToken, isSandbox } = zenodoResult;

        const deposition = await getDeposition(depositionId, zenodoToken, isSandbox);

        if (!deposition.links.bucket) {
          await updateProgress("upload_to_zenodo", "No bucket URL in deposition");
          return c.json(
            {
              error: "Zenodo deposition has no bucket URL",
              step: "upload_to_zenodo",
              steps_completed: completed,
              step_results: stepResults,
            },
            500,
          );
        }

        const filename = `${datasetId}-${tag}.zip`;
        const { attempts: uploadAttempts } = await withRetry(
          () =>
            uploadFile(
              depositionId,
              deposition.links.bucket as string,
              filename,
              archiveData,
              zenodoToken,
              isSandbox,
            ),
          "upload_to_zenodo",
        );

        await updateProgress("upload_to_zenodo", undefined, uploadAttempts);
      } catch (err) {
        const msg = errorMessage(err);
        console.error(`[publish] upload_to_zenodo failed for dataset ${datasetId}:`, err);
        await updateProgress("upload_to_zenodo", msg);
        return c.json(
          {
            error: `Zenodo upload failed: ${msg}`,
            step: "upload_to_zenodo",
            steps_completed: completed,
            step_results: stepResults,
          },
          500,
        );
      }
    }
  }

  // Step: publish_doi - Publish DOI (permanent and irreversible!)
  if (stepsToRun.includes("publish_doi")) {
    try {
      await startStep("publish_doi");

      const provider = parseDoiProvider(dataset.doi_provider);

      if (provider === "ezid") {
        // EZID: transition the reserved DOI to public status
        if (!dataset.ezid_identifier) {
          await updateProgress("publish_doi", "No EZID identifier found");
          return c.json(
            {
              error: "No EZID identifier found for dataset",
              step: "publish_doi",
              steps_completed: completed,
              step_results: stepResults,
            },
            500,
          );
        }

        const auth = resolveEzidAuth(c.env, sandbox || !!dataset.is_sandbox);
        const target = `https://nemar.org/dataexplorer/detail?dataset_id=${datasetId}`;
        await ezidMakePublic(auth, dataset.ezid_identifier, target);

        // Update EZID status in D1
        try {
          await db
            .prepare(
              "UPDATE datasets SET ezid_status = 'public', updated_at = datetime('now') WHERE dataset_id = ?",
            )
            .bind(datasetId)
            .run();
        } catch (dbErr) {
          console.error(
            `[publish] CRITICAL: EZID DOI published but database update failed for ${datasetId}:`,
            dbErr,
          );
        }
      } else {
        // Zenodo: publish the deposition (irreversible)
        const zenodoResult = await getZenodoConfig("publish_doi");
        if (zenodoResult instanceof Response) return zenodoResult;
        const { depositionId, token: zenodoToken, isSandbox } = zenodoResult;

        const published = await publishDeposition(depositionId, zenodoToken, isSandbox);

        // After publish, Zenodo confirms the concept DOI; update the database record.
        // The DB update is in its own try/catch because the DOI is already published at
        // this point; a DB failure must not be reported as "DOI publication failed."
        if (published.doi) {
          try {
            await db
              .prepare(
                "UPDATE datasets SET concept_doi = ?, updated_at = datetime('now') WHERE dataset_id = ?",
              )
              .bind(published.doi, datasetId)
              .run();
          } catch (dbErr) {
            console.error(
              `[publish] CRITICAL: DOI published on Zenodo (${published.doi}) but database update failed for ${datasetId}:`,
              dbErr,
            );
            await updateProgress(
              "publish_doi",
              `DOI published (${published.doi}) but DB update failed; manual correction required`,
            );
            return c.json(
              {
                error: `DOI was published successfully (${published.doi}) but database update failed. Manual database correction required.`,
                published_doi: published.doi,
                step: "publish_doi",
                steps_completed: completed,
                step_results: stepResults,
              },
              500,
            );
          }
        } else {
          console.error(
            `[publish] Zenodo publish returned no DOI for dataset ${datasetId}; response:`,
            published,
          );
        }
      }

      await updateProgress("publish_doi");
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[publish] publish_doi failed for dataset ${datasetId}:`, err);
      await updateProgress("publish_doi", msg);
      return c.json(
        {
          error: `DOI publication failed: ${msg}`,
          step: "publish_doi",
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
  }

  // Step 12: S3 Object Lock (single batch per request due to CF Workers subrequest limits)
  if (stepsToRun.includes("s3_lock")) {
    try {
      await startStep("s3_lock");

      const { result: lockResult, attempts: lockAttempts } = await withRetry(
        () => applyObjectLock(getS3Config(c.env), datasetId, body.s3_lock_offset || 0),
        "s3_lock",
      );

      if (lockResult.failed.length > 0) {
        const msg = `${lockResult.locked} locked, ${lockResult.failed.length} failed`;
        await updateProgress("s3_lock", msg, lockAttempts);
        return c.json(
          {
            error: `S3 lock partially failed: ${msg}`,
            step: "s3_lock",
            steps_completed: completed,
            step_results: stepResults,
            details: lockResult,
          },
          500,
        );
      }

      if (lockResult.hasMore) {
        // More objects to lock - return progress with next offset
        return c.json({
          message: `S3 lock in progress: ${lockResult.locked} locked, ${lockResult.total} total`,
          step: "s3_lock",
          steps_completed: completed,
          step_results: stepResults,
          s3_lock_offset: (body.s3_lock_offset || 0) + 40,
          hasMore: true,
        });
      }

      await updateProgress("s3_lock", undefined, lockAttempts);
    } catch (err) {
      const msg = errorMessage(err);
      await updateProgress("s3_lock", msg);
      return c.json(
        {
          error: `S3 lock failed: ${msg}`,
          step: "s3_lock",
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
  }

  // Step: Generate archive (async via GitHub Actions; non-blocking)
  if (stepsToRun.includes("generate_archive")) {
    try {
      await startStep("generate_archive");

      const vtResult = await getVersionTag("generate_archive");
      if (vtResult instanceof Response) {
        console.warn(`[publish] Could not get version tag for archive generation of ${datasetId}`);
        await updateProgress("generate_archive", "Could not resolve version tag");
      } else {
        await triggerArchiveGeneration(repoName, datasetId, vtResult.version, pat, {
          public: true,
        });
        await updateProgress("generate_archive");
      }
    } catch (err) {
      const msg = errorMessage(err);
      // Archive generation is non-critical; log warning but continue
      console.warn(`[publish] Archive generation trigger failed for ${datasetId}: ${msg}`);
      await updateProgress("generate_archive", msg);
    }
  }

  // Step 14: Notify user
  if (stepsToRun.includes("notify_user")) {
    try {
      await startStep("notify_user");

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
      const msg = errorMessage(err);
      await updateProgress("notify_user", msg);
      return c.json(
        { error: `Notification failed: ${msg}`, step: "notify_user", steps_completed: completed, step_results: stepResults },
        500,
      );
    }
  }

  // Final consistency check: ensure dataset visibility matches GitHub state
  const finalCheck = await db
    .prepare("SELECT visibility FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ visibility: string }>();

  if (finalCheck && finalCheck.visibility !== "public") {
    console.warn(
      `[publish] Consistency fix: dataset ${datasetId} visibility was '${finalCheck.visibility}' at end of publish, correcting to 'public'`,
    );
    await db
      .prepare(
        "UPDATE datasets SET visibility = 'public', updated_at = datetime('now') WHERE dataset_id = ?",
      )
      .bind(datasetId)
      .run();
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
    console.error(
      "AUDIT LOG FAILURE: Dataset publication for",
      datasetId,
      "was not logged:",
      auditLogError,
    );
  }

  return c.json({
    message: "Dataset published successfully",
    dataset_id: datasetId,
    status: "published",
    steps_completed: allSteps,
    step_results: stepResults,
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
  const body = (await c.req.json().catch(() => ({}))) as { offset?: number };
  const offset = body.offset || 0;

  const dataset = await db
    .prepare("SELECT dataset_id FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ dataset_id: string }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  try {
    const result = await applyObjectLock(getS3Config(c.env), datasetId, offset);

    return c.json({
      message: result.failed.length === 0 ? "Batch locked" : "Some objects failed",
      dataset_id: datasetId,
      locked: result.locked,
      total: result.total,
      failed: result.failed.map((f) => ({ key: f.key, error: f.error })),
      hasMore: result.hasMore,
      offset,
    });
  } catch (err) {
    const msg = errorMessage(err);
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
  let versionDoi: string | null = "doi" in body ? (body.doi ?? null) : null;
  if (!versionDoi) {
    const s3Options = getS3Config(c.env);
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

    await uploadManifest(getS3Config(c.env), datasetId, version, JSON.stringify(manifest, null, 2));

    return c.json({
      message: "Manifest generated and uploaded",
      dataset_id: datasetId,
      version: manifest.version,
      files_count: Object.keys(manifest.files).length,
    });
  } catch (err) {
    const msg = errorMessage(err);
    return c.json({ error: `Manifest generation failed: ${msg}` }, 500);
  }
});

// ---------------------------------------------------------------------------
// Dataset deletion
// ---------------------------------------------------------------------------

/**
 * POST /admin/datasets/:id/reset - Reset a test dataset to clean state
 *
 * Hardcoded to nm099999 only. Deletes S3 objects, recreates GitHub repo,
 * cleans D1 version/publication records, re-adds caller as collaborator.
 */
adminRoutes.post("/datasets/:id/reset", async (c) => {
  const datasetId = c.req.param("id");

  if (datasetId !== "nm099999") {
    return c.json({ error: "Reset is only allowed for test dataset nm099999" }, 400);
  }

  const requestingUser = c.get("user");
  const db = c.env.DB;

  // Ensure nm099999 row exists (another process may have deleted it)
  const dataset = await db
    .prepare("SELECT * FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ id: number; dataset_id: string; name: string; github_repo: string | null }>();

  if (!dataset) {
    await db
      .prepare(
        "INSERT INTO datasets (dataset_id, name, description, owner_user_id, status, github_repo, visibility, is_sandbox) VALUES (?, 'E2E Test Dataset', 'Persistent test dataset for E2E testing', ?, 'active', 'nemarDatasets/nm099999', 'private', 0)",
      )
      .bind(datasetId, requestingUser.id)
      .run();
  }

  const steps: { s3_deleted: number; github_recreated: boolean; d1_cleaned: boolean } = {
    s3_deleted: 0,
    github_recreated: false,
    d1_cleaned: false,
  };

  // 1. Delete S3 objects
  try {
    const s3Options = {
      bucket: c.env.S3_BUCKET,
      region: c.env.AWS_REGION,
      accessKeyId: c.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
    };
    const s3Result = await deleteDatasetObjects(s3Options, datasetId, true);
    steps.s3_deleted = s3Result.deleted;
  } catch (err) {
    console.error(
      `[reset] S3 cleanup failed for ${datasetId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // 2. Recreate GitHub repo
  try {
    const pat = c.env.GITHUB_ADMIN_PAT;
    const repoName = datasetId;
    await deleteRepository(repoName, pat);
    await createRepository(repoName, "E2E test dataset (auto-reset)", true, pat);
    await addCollaborator(repoName, requestingUser.github_username, "push", pat);
    steps.github_recreated = true;
  } catch (err) {
    console.error(
      `[reset] GitHub recreate failed for ${datasetId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // 3. Clean D1 records (keep datasets row)
  try {
    await db.batch([
      db.prepare("DELETE FROM dataset_versions WHERE dataset_id = ?").bind(datasetId),
      db.prepare("DELETE FROM publication_requests WHERE dataset_id = ?").bind(datasetId),
      db
        .prepare(
          "DELETE FROM dataset_collaborators WHERE dataset_id IN (SELECT id FROM datasets WHERE dataset_id = ?)",
        )
        .bind(datasetId),
      db.prepare("DELETE FROM user_s3_permissions WHERE s3_prefix = ?").bind(datasetId),
    ]);
    // Reset DOI and Zenodo fields on the dataset
    await db
      .prepare(
        "UPDATE datasets SET concept_doi = NULL, latest_version_doi = NULL, doi_provider = 'ezid', ezid_identifier = NULL, ezid_status = NULL, zenodo_concept_id = NULL, zenodo_latest_version_id = NULL, enrichment_json = NULL, enrichment_updated_at = NULL, visibility = 'private' WHERE dataset_id = ?",
      )
      .bind(datasetId)
      .run();
    steps.d1_cleaned = true;
  } catch (err) {
    console.error(
      `[reset] D1 cleanup failed for ${datasetId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  const githubRepo = `nemarDatasets/${datasetId}`;
  const allOk = steps.s3_deleted >= 0 && steps.github_recreated && steps.d1_cleaned;
  return c.json(
    {
      message: allOk ? `Dataset ${datasetId} reset` : `Dataset ${datasetId} partially reset`,
      success: allOk,
      github_ssh_url: `git@github.com:${githubRepo}.git`,
      steps,
    },
    allOk ? 200 : 207,
  );
});

const deleteDatasetSchema = z.object({
  force: z.boolean().optional().default(false),
});

/**
 * DELETE /admin/datasets/:id - Delete a dataset and all associated resources
 *
 * Permission:
 * - Unpublished datasets (no DOI, private): admin or owner
 * - Published datasets (with DOI or public visibility): owner only, requires force=true
 */
adminRoutes.delete("/datasets/:id", async (c) => {
  const datasetId = c.req.param("id");
  const requestingUser = c.get("user");

  // Parse optional JSON body (DELETE requests may have no body)
  let force = false;
  try {
    const body = await c.req.json();
    const parsed = deleteDatasetSchema.safeParse(body);
    if (parsed.success) {
      force = parsed.data.force;
    }
  } catch {
    // No body or invalid JSON: default force=false
  }
  const db = c.env.DB;

  // Look up dataset
  const dataset = await db
    .prepare("SELECT * FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{
      id: number;
      dataset_id: string;
      name: string;
      owner_user_id: number;
      status: string;
      visibility: string;
      concept_doi: string | null;
      latest_version_doi: string | null;
    }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  // Permission check: published datasets require owner role
  const hasDoiOrPublished = dataset.concept_doi !== null || dataset.visibility === "public";
  if (hasDoiOrPublished) {
    if (!hasRole(requestingUser.role, "owner")) {
      return c.json(
        { error: "Published datasets with DOIs can only be deleted by the NEMAR owner" },
        403,
      );
    }
    if (!force) {
      return c.json(
        {
          error: "This dataset has a DOI or is published. Set force=true to confirm deletion.",
          dataset_id: datasetId,
          concept_doi: dataset.concept_doi,
          visibility: dataset.visibility,
        },
        400,
      );
    }
  }

  // Check for active publication requests
  const activePubReq = await db
    .prepare(
      "SELECT COUNT(*) as count FROM publication_requests WHERE dataset_id = ? AND status NOT IN ('published', 'denied')",
    )
    .bind(datasetId)
    .first<{ count: number }>();

  if (activePubReq && activePubReq.count > 0) {
    return c.json(
      {
        error: `Cannot delete dataset with ${activePubReq.count} active publication request(s). Deny or complete them first.`,
      },
      409,
    );
  }

  // Perform cascade deletion
  const result = await deleteDatasetCascade(db, c.env, datasetId, {
    bypassGovernance: force,
  });

  // Audit log (best-effort; don't fail the response if audit write fails)
  try {
    await db
      .prepare("INSERT INTO audit_log (action, user_id, details) VALUES (?, ?, ?)")
      .bind(
        "dataset_deleted",
        requestingUser.id,
        JSON.stringify({
          dataset_id: datasetId,
          dataset_name: dataset.name,
          owner_user_id: dataset.owner_user_id,
          had_doi: dataset.concept_doi !== null,
          force,
          steps: result.steps,
          warnings: result.warnings,
        }),
      )
      .run();
  } catch (err) {
    console.error("Failed to write deletion audit log:", err);
    result.warnings.push("Audit log write failed");
  }

  return c.json(result, result.deleted ? 200 : 207);
});

// ─── Import external dataset ────────────────────────────────────────────────

// 8 chars: 2-char prefix + 6 digits (e.g., on007262)
const importDatasetSchema = z.object({
  dataset_id: z.string().regex(/^on\d{6}$/, "Import only supports 'on' prefix datasets (on######)"),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  source: z.enum(["openneuro"]),
  source_id: z.string().min(1).max(50),
});

/**
 * POST /admin/datasets/import
 *
 * Import a dataset from an external source (e.g., OpenNeuro).
 * Creates the D1 record and GitHub repo with a caller-specified dataset ID.
 * The calling admin becomes the dataset owner (owner_user_id).
 * Does not set up S3 credentials or presigned URLs; the CLI handles data copy.
 */
adminRoutes.post(
  "/datasets/import",
  authMiddleware,
  adminMiddleware,
  zValidator("json", importDatasetSchema),
  async (c) => {
    const { dataset_id, name, description, source, source_id } = c.req.valid("json");
    const db = c.env.DB;
    const admin = c.get("user");

    // Check for duplicate
    const existing = await db
      .prepare("SELECT dataset_id FROM datasets WHERE dataset_id = ?")
      .bind(dataset_id)
      .first<{ dataset_id: string }>();

    if (existing) {
      return c.json({ error: `Dataset ${dataset_id} already exists` }, 409);
    }

    // Create GitHub repo
    let githubRepo: GitHubRepo;
    try {
      githubRepo = await createRepository(
        dataset_id,
        `${name} - NEMAR Dataset (imported from OpenNeuro ${source_id})`,
        true,
        c.env.GITHUB_ADMIN_PAT,
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
    } catch (error) {
      console.error("Failed to insert dataset record:", error);
      const dbMsg = error instanceof Error ? error.message : String(error);
      // Clean up GitHub repo
      try {
        await deleteRepository(dataset_id, c.env.GITHUB_ADMIN_PAT);
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
      await db
        .prepare("INSERT INTO audit_log (action, user_id, details) VALUES (?, ?, ?)")
        .bind("dataset_imported", admin.id, JSON.stringify({ dataset_id, source, source_id, name }))
        .run();
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
