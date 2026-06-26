/**
 * Admin routes
 *
 * Handles user approval, revocation, and management.
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { adminMiddleware, authMiddleware, ownerMiddleware } from "../middleware/auth";

import { datasetLandingUrl, datasetVersionLandingUrl } from "../../../shared/datacite-constants.js";
import { LIVE_DATASETS, isLiveDataset } from "../constants";
import { tombstoneUserStatement } from "../db/user-tombstone";
import { SYSTEM_USER_ID } from "../lib/constants";
import { shouldSkipArchive } from "../services/archive-policy";
import {
  type RecipientGroup,
  type RecipientGroupOrUser,
  broadcastRequestSchema,
  getBroadcastRecipientByUsername,
  getBroadcastRecipients,
  sendBroadcast,
} from "../services/broadcast";
import {
  type NemarCatalogRecord,
  importCatalogRecords,
  syncCatalog,
} from "../services/catalog-sync";
import {
  type DataCiteEnrichment,
  bidsToDataCite,
  buildDataCiteXml,
  nemarMetadataToEnrichment,
  parseNemarMetadata,
} from "../services/datacite";
import {
  DatasetReindexError,
  type ReindexFilter,
  buildReindexFilterQuery,
  runDatasetSync,
  runEnrichmentForDataset,
} from "../services/dataset-reindex";
import { reembedDatasetVector } from "../services/dataset-search";
import { deleteDatasetCascade } from "../services/deletion";
import { DOCTOR_CHECKS, getCheck, listChecks } from "../services/doctor/registry";
import type { CheckContext, Finding } from "../services/doctor/types";
import {
  type DoiProvider,
  type DoiResult,
  buildOrcidEnrichment,
  createEzidVersionDoi,
  createConceptDoi as dispatchCreateConceptDoi,
  parseDoiProvider,
  planReadmeBadgeCommit,
  resolveEzidAuth,
} from "../services/doi";
import {
  parseEmailPreferences,
  resolveEmailConfig,
  sendKeyReadyEmail,
  sendPublicationApprovedEmail,
  sendPublicationDeniedEmail,
  sendRevocationEmail,
} from "../services/email";
import { decrypt } from "../services/encryption";
import {
  type EzidAuth,
  TEST_SHOULDER,
  extractDoi,
  makePublic as ezidMakePublic,
  updateIdentifier as ezidUpdateIdentifier,
} from "../services/ezid";
import {
  type DriftBucket,
  classifyDatasetDrift,
  gatherRepoDriftState,
} from "../services/fleet-drift";
import {
  type GitHubRepo,
  addCollaborator,
  checkWorkflowExists,
  commitEnrichmentWithBidsignore,
  createOrUpdateFile,
  createRelease,
  createRepository,
  createTag,
  deleteRepoFile,
  deleteRepository,
  deployWorkflows,
  downloadReleaseArchive,
  ensureRepoToSpec,
  getBlobContent,
  getBranchRulesetInfo,
  getMainBranchSha,
  getTreeAtRef,
  getWorkflowRuns,
  removeCollaborator,
  setRepoVisibility,
  syncWorkflowTemplates,
  triggerBidsValidation,
  triggerManifestGeneration,
  validateDeployedWorkflows,
} from "../services/github";
import { getDatasetsToken } from "../services/github-auth";
import { revokeUserIamAccess } from "../services/iam";
import { IMPORT_STATUSES } from "../services/import-recovery";
import { generateManifest } from "../services/manifest";
import { buildCoverageReport } from "../services/manifest-coverage";
import { syncDatasetToNemar } from "../services/nemar-sync";
import { createNotice, deleteNotice, listAllNotices } from "../services/notices";
import {
  errorMessage,
  extractRepoName,
  readBidsDescription,
  readRepoMetadata,
} from "../services/repo-metadata";
import { mirrorReconcileRemovals, resolveRepoCollaborators } from "../services/repo-spec";
import { withRetry } from "../services/retry";
import {
  applyObjectLockBatch,
  deleteDatasetObjects,
  getArchiveSize,
  getDatasetS3Stats,
  getManifest,
  getZarrIndex,
  markDatasetPrivate,
  markDatasetPublic,
  uploadManifest,
  waitForPublicPropagation,
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
import { isCentralManifestWorkflowEnabled, publishEzidVersionDoiViaCentral } from "./webhooks";

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
  | "version_doi"
  | "s3_lock"
  | "sync_nemar"
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

  // Hide tombstoned (soft-deleted) users by default; ?include_deleted=true lets
  // an admin audit them (they show as masked deleted+<id>@deleted.invalid rows).
  if (c.req.query("include_deleted") !== "true") {
    conditions.push("deleted_at IS NULL");
  }

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
      AND u.deleted_at IS NULL
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
      .prepare(
        "SELECT id, username, role, status FROM users WHERE username = ? AND deleted_at IS NULL",
      )
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
        .prepare(
          "SELECT COUNT(*) as count FROM users WHERE role = 'owner' AND status = 'approved' AND deleted_at IS NULL",
        )
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
    .prepare(
      "SELECT id, username, email, github_username, status FROM users WHERE username = ? AND deleted_at IS NULL",
    )
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

  // Note: Per-user IAM credentials are no longer created. S3 access is now
  // managed through backend-scoped credentials (presigned URLs and STS tokens).
  // The D1 user_s3_permissions table is the sole authorization source.

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
    const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
    await sendKeyReadyEmail(
      user.email,
      user.username,
      c.env.RESEND_API_KEY,
      fromEmail,
      replyTo,
      isDev,
    );
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
      FROM users WHERE username = ? AND deleted_at IS NULL
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

  // Remove from every dataset repo they touch: collaborator grants
  // (dataset_collaborators) UNION repos they own (datasets.owner_user_id).
  // Owner-owned repos were previously never removed (epic #713 gap).
  const collaborations = await db
    .prepare(
      `SELECT d.github_repo FROM dataset_collaborators dc JOIN datasets d ON dc.dataset_id = d.id WHERE dc.user_id = ?
       UNION
       SELECT github_repo FROM datasets WHERE owner_user_id = ?`,
    )
    .bind(user.id, user.id)
    .all<{ github_repo: string | null }>();

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
        await removeCollaborator(repoName, user.github_username, await getDatasetsToken(c.env));
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
    const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
    await sendRevocationEmail(
      user.email,
      user.username,
      c.env.RESEND_API_KEY,
      fromEmail,
      replyTo,
      isDev,
    );
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
 * DELETE /admin/users/by-id/:id - Tombstone (soft-delete) a user. Owner-only.
 *
 * Keyed by integer id because web signups have username = NULL (migration 0026).
 * This is a soft delete, NOT a hard DELETE: the row is kept (so its id is never
 * reused and audit_log / ownership references stay valid), but the PII columns
 * are masked, `deleted_at` is stamped, and all credentials are revoked. The
 * masked email is a collision-safe `deleted+<id>@deleted.invalid` placeholder
 * keyed on the PK, which frees the original email/username/github for a future
 * re-signup while satisfying the UNIQUE constraints. `deleted_at` is the
 * soft-delete discriminator every auth/list query filters on; status is also
 * flipped to 'revoked' so existing status-pinned queries treat the row as dead.
 *
 * Guards: never the system sentinel (id <= 0), never self, never the last owner.
 * Idempotent: re-deleting an already-tombstoned user is a 200 no-op.
 *
 * Keyed `by-id` (not :username) so it can address web signups (NULL username)
 * and so it can never be confused with the username-keyed GET/POST user routes.
 */
adminRoutes.delete("/users/by-id/:id", ownerMiddleware, async (c) => {
  const db = c.env.DB;
  const adminUser = c.get("user");

  const id = Number.parseInt(c.req.param("id"), 10);
  // Reject non-positive ids AND the system sentinel in one guard. (id <= 0
  // already covers SYSTEM_USER_ID = -1 today; the explicit term keeps the guard
  // correct if the sentinel is ever made a positive value.)
  if (!Number.isInteger(id) || id <= 0 || id === SYSTEM_USER_ID) {
    return c.json({ error: "Invalid or non-deletable user id" }, 400);
  }
  if (id === adminUser.id) {
    return c.json({ error: "Cannot delete your own account" }, 400);
  }

  const target = await db
    .prepare(
      `SELECT id, username, email, github_username, role, status, deleted_at,
              aws_iam_username, aws_access_key_id_encrypted
       FROM users WHERE id = ?`,
    )
    .bind(id)
    .first<{
      id: number;
      username: string | null;
      email: string | null;
      github_username: string | null;
      role: string | null;
      status: string;
      deleted_at: string | null;
      aws_iam_username: string | null;
      aws_access_key_id_encrypted: string | null;
    }>();

  if (!target) {
    return c.json({ error: "User not found" }, 404);
  }

  // Idempotent: already tombstoned -> 200 no-op (no re-mask, no error).
  if (target.deleted_at) {
    return c.json({ deleted: true, already_deleted: true, id: target.id });
  }

  // Last-owner protection (a deleted owner must not strand the org without one).
  if (target.role === "owner") {
    const owners = await db
      .prepare(
        "SELECT COUNT(*) as count FROM users WHERE role = 'owner' AND status = 'approved' AND deleted_at IS NULL",
      )
      .first<{ count: number }>();
    if (owners && owners.count <= 1) {
      return c.json({ error: "Cannot delete the last owner" }, 400);
    }
  }

  // Capture the github handle + email BEFORE masking (masking nulls/rewrites
  // them). github is needed for collaborator removal; email is used ONLY to
  // expire outstanding login codes (auth_codes is keyed by the original email).
  // Neither is stored anywhere afterward — a tombstone truly erases the PII.
  const originalGithub = target.github_username;
  const originalEmail = target.email;

  // Best-effort IAM cleanup if (legacy) per-user IAM creds exist. Per-user IAM
  // is deprecated and rows generally have aws_iam_username NULL, but if one is
  // set we must not leave live keys behind. Non-fatal: recorded, never blocks.
  let iamWarning: string | null = null;
  if (target.aws_iam_username && target.aws_access_key_id_encrypted) {
    if (!c.env.ENCRYPTION_KEY) {
      // Creds exist but we can't decrypt them to revoke — surface loudly rather
      // than silently leave live IAM keys behind (the columns are still nulled
      // by the mask below, but the AWS-side keys would remain active).
      iamWarning = "ENCRYPTION_KEY not configured; live IAM credentials were NOT revoked";
      console.error(
        `[delete-user] ENCRYPTION_KEY missing for id=${id}; live IAM creds NOT revoked`,
      );
    } else {
      try {
        const accessKeyId = await decrypt(target.aws_access_key_id_encrypted, c.env.ENCRYPTION_KEY);
        const result = await revokeUserIamAccess(
          {
            accessKeyId: c.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
            region: c.env.AWS_REGION,
          },
          target.aws_iam_username,
          accessKeyId,
        );
        if (result.errors.length > 0) iamWarning = result.errors.join("; ");
      } catch (error) {
        iamWarning = errorMessage(error);
        console.error(`[delete-user] IAM revoke failed for id=${id}:`, iamWarning);
      }
    }
  }

  // Best-effort GitHub collaborator removal (mirrors revoke). Uses the captured
  // github_username because masking nulls it below.
  let reposRemoved = 0;
  const failedRemovals: string[] = [];
  if (originalGithub) {
    // Non-fatal: if the lookup itself fails (D1 hiccup) skip GitHub cleanup. The
    // batch below still clears the dataset_collaborators rows, and the tombstone
    // must not be blocked by a best-effort step.
    let collaborations: { results: { github_repo: string | null }[] | null } = { results: [] };
    try {
      collaborations = await db
        .prepare(
          `SELECT d.github_repo FROM dataset_collaborators dc JOIN datasets d ON dc.dataset_id = d.id WHERE dc.user_id = ?
           UNION
           SELECT github_repo FROM datasets WHERE owner_user_id = ?`,
        )
        .bind(id, id)
        .all<{ github_repo: string | null }>();
    } catch (error) {
      console.error(`[delete-user] collaborations lookup failed for id=${id}:`, error);
    }
    for (const collab of collaborations.results || []) {
      const repoName = collab.github_repo?.split("/")[1];
      if (!repoName) continue;
      try {
        await removeCollaborator(repoName, originalGithub, await getDatasetsToken(c.env));
        reposRemoved++;
      } catch (error) {
        console.error(`[delete-user] failed to remove from ${collab.github_repo}:`, error);
        if (collab.github_repo) failedRemovals.push(collab.github_repo);
      }
    }
  }

  // PII mask + tombstone + credential revocation in a single db.batch(): D1
  // wraps a batch in one implicit transaction (all statements commit, or all
  // roll back on any failure — see Cloudflare D1 docs, "Batched statements are
  // SQL transactions"), so the email mask and the `deleted_at` stamp can never
  // half-apply and leave an auth-resolvable row. `AND deleted_at IS NULL` on the
  // mask makes it idempotent. The placeholder email embeds the PK (globally
  // unique, never reused under AUTOINCREMENT) so the email UNIQUE constraint
  // can't be hit, and .invalid (RFC 6761) can never be a real/deliverable
  // address. web_sessions are revoked explicitly because a soft delete does NOT
  // trigger their ON DELETE CASCADE; collaborator + S3-permission rows likewise.
  // A batch failure rolls back atomically and is reported as a clear 500 so the
  // caller knows the user was NOT deleted and can retry (idempotent).
  let batch: D1Result[];
  try {
    batch = await db.batch([
      tombstoneUserStatement(db, id),
      db
        .prepare(
          "UPDATE tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
        )
        .bind(id),
      db
        .prepare(
          "UPDATE web_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
        )
        .bind(id),
      db.prepare("DELETE FROM dataset_collaborators WHERE user_id = ?").bind(id),
      db.prepare("DELETE FROM user_s3_permissions WHERE user_id = ?").bind(id),
      // Expire any outstanding passwordless login codes for the original email so
      // a code issued just before deletion can't be submitted (it would otherwise
      // be consumed and then cleanly denied — this avoids even that round-trip).
      db
        .prepare(
          "UPDATE auth_codes SET used_at = datetime('now') WHERE email = ? AND used_at IS NULL",
        )
        .bind(originalEmail),
    ]);
  } catch (error) {
    console.error(`[delete-user] tombstone batch failed for id=${id}:`, error);
    return c.json(
      {
        error: "Tombstone transaction failed; user was NOT deleted. Retry or contact an operator.",
        detail: errorMessage(error),
      },
      500,
    );
  }
  const tokensRevoked = batch[1]?.meta.changes ?? 0;
  const sessionsRevoked = batch[2]?.meta.changes ?? 0;

  // Audit log (audit_log.user_id has no cascade, so the row survives). resource_id
  // is the non-PII integer id and details carries NO original username/email —
  // the whole point of the tombstone is to erase that PII (see migration 0037).
  // A failed audit write must NOT 500 the already-committed tombstone (that would
  // mislead the caller into thinking the delete failed); log the gap instead.
  try {
    await db
      .prepare(
        "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, 'user_deleted', 'user', ?, ?)",
      )
      .bind(
        adminUser.id,
        String(id),
        JSON.stringify({
          // Non-PII actor id (the row's user_id is the same); avoids retaining the
          // admin's username if they are themselves tombstoned later.
          deleted_by_id: adminUser.id,
          tokens_revoked: tokensRevoked,
          sessions_revoked: sessionsRevoked,
          repos_removed: reposRemoved,
          masked: true,
        }),
      )
      .run();
  } catch (error) {
    console.error(
      `[delete-user] audit_log insert failed for id=${id} (tombstone committed):`,
      error,
    );
  }

  return c.json({
    deleted: true,
    id: target.id,
    steps: {
      tokens_revoked: tokensRevoked,
      sessions_revoked: sessionsRevoked,
      collaborators_cleared: true,
      s3_perms_cleared: true,
      github_repos_removed: reposRemoved,
      failed_removals: failedRemovals.length > 0 ? failedRemovals : undefined,
      iam_warning: iamWarning ?? undefined,
    },
    masked: true,
  });
});

/**
 * POST /admin/regenerate-iam/:username - Deprecated
 *
 * Per-user IAM credentials are no longer used. S3 access is managed through
 * backend-scoped credentials (presigned URLs and STS tokens). The D1
 * user_s3_permissions table is the sole authorization source.
 */
adminRoutes.post("/regenerate-iam/:username", async (c) => {
  return c.json(
    {
      message:
        "IAM credential regeneration is no longer needed. S3 access is managed through backend-scoped credentials.",
      status: "deprecated",
    },
    410,
  );
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
      (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) as total_users,
      (SELECT COUNT(*) FROM users WHERE status = 'pending' AND deleted_at IS NULL) as pending_users,
      (SELECT COUNT(*) FROM users WHERE status = 'verified' AND deleted_at IS NULL) as verified_users,
      (SELECT COUNT(*) FROM users WHERE status = 'approved' AND deleted_at IS NULL) as approved_users,
      (SELECT COUNT(*) FROM users WHERE status = 'revoked' AND deleted_at IS NULL) as revoked_users,
      -- total_datasets counts real managed datasets only; folded legacy
      -- catalog rows (owner = SYSTEM_USER_ID, #646) are reported separately so
      -- the headline count isn't inflated by the ~180 folded legacy catalog rows.
      (SELECT COUNT(*) FROM datasets WHERE owner_user_id != ${SYSTEM_USER_ID}) as total_datasets,
      (SELECT COUNT(*) FROM datasets WHERE owner_user_id = ${SYSTEM_USER_ID}) as catalog_datasets,
      (SELECT COUNT(*) FROM tokens WHERE revoked_at IS NULL) as active_tokens
  `,
    )
    .first();

  return c.json({ stats });
});

/**
 * POST /admin/datasets/archive-sweep?limit=N — one-time/periodic backfill that
 * seeds the archive_status / archive_size columns (migration 0036) from S3 for
 * the observability dashboard (epic #695). Going-forward writes land via
 * /webhooks/archive-ready; this seeds historical archives that predate it.
 *
 * Bounded per invocation (default 50, max 200) to stay under the Worker
 * subrequest cap — getArchiveSize LISTs `<id>/archives/` once per dataset. Run
 * repeatedly until `remaining` reaches 0. Idempotent: only rows never checked
 * (archive_checked_at IS NULL) are candidates, so a re-run picks up where it
 * left off.
 */
adminRoutes.post("/datasets/archive-sweep", async (c) => {
  const db = c.env.DB;
  const limitRaw = Number.parseInt(c.req.query("limit") || "50", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

  // Candidates: real (non-catalog), public, non-sandbox datasets we have never
  // checked for an archive. Public-only because archives are a published-data
  // concern and the data-plane download is public-only (loadPublishedDataset).
  // A bare throw here (e.g. migration 0036 not yet applied) would surface a
  // contextless 500, so handle it explicitly.
  let candidates: { dataset_id: string; file_size: number | null; total_files: number | null }[];
  try {
    const candidateRows = await db
      .prepare(
        // file_size/total_files (migration 0020) let us mark an oversized dataset
        // with no archive as 'skipped' (#752) instead of just 'absent'.
        `SELECT dataset_id, file_size, total_files FROM datasets
         WHERE owner_user_id != ${SYSTEM_USER_ID}
           AND (is_sandbox = 0 OR is_sandbox IS NULL)
           AND visibility = 'public'
           AND archive_checked_at IS NULL
         ORDER BY dataset_id
         LIMIT ?`,
      )
      .bind(limit)
      .all<{ dataset_id: string; file_size: number | null; total_files: number | null }>();
    candidates = candidateRows.results ?? [];
  } catch (err) {
    console.error("[archive-sweep] candidate query failed:", err);
    return c.json({ error: "Failed to query sweep candidates (is migration 0036 applied?)" }, 500);
  }

  const s3 = getS3Config(c.env);
  let ready = 0;
  let absent = 0;
  let skipped = 0;
  const errors: { dataset_id: string; error: string }[] = [];

  for (const { dataset_id, file_size, total_files } of candidates) {
    // Separate try/catch per phase so an error is attributed to the operation
    // that failed (S3 LIST vs D1 write), not lumped together.
    let size: number;
    try {
      size = await getArchiveSize(s3, dataset_id);
    } catch (err) {
      errors.push({ dataset_id, error: `s3: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    try {
      if (size > 0) {
        await db
          .prepare(
            // Clear any stale archive_skip_reason: a real zip exists (#752).
            "UPDATE datasets SET archive_status = 'ready', archive_size = ?, archive_checked_at = datetime('now'), archive_skip_reason = NULL WHERE dataset_id = ?",
          )
          .bind(size, dataset_id)
          .run();
        ready++;
      } else {
        // Checked, no archive on S3. If the dataset is over the size policy
        // (#752), record WHY no zip exists (archive_skip_reason) so the UI shows
        // the direct-download recipe instead of "missing archive". Otherwise it's
        // genuinely absent: stamp checked_at, leave archive_status NULL.
        const decision = shouldSkipArchive({ totalBytes: file_size, totalFiles: total_files });
        if (decision.skip) {
          await db
            .prepare(
              "UPDATE datasets SET archive_skip_reason = ?, archive_checked_at = datetime('now') WHERE dataset_id = ?",
            )
            .bind(decision.reason ?? "archive skipped (size policy)", dataset_id)
            .run();
          skipped++;
        } else {
          await db
            .prepare(
              "UPDATE datasets SET archive_checked_at = datetime('now') WHERE dataset_id = ?",
            )
            .bind(dataset_id)
            .run();
          absent++;
        }
      }
    } catch (err) {
      // S3 confirmed the size; only the D1 write failed. Note the branch (ready
      // vs skip/absent) + size so a re-run's duplicate entry is explicable and a
      // dropped archive_skip_reason write is attributable, not masked as "ready".
      errors.push({
        dataset_id,
        error: `d1 write [${size > 0 ? "ready" : "skip/absent"}] (s3 size=${size}): ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const remainingRow = await db
    .prepare(
      `SELECT COUNT(*) as n FROM datasets
       WHERE owner_user_id != ${SYSTEM_USER_ID}
         AND (is_sandbox = 0 OR is_sandbox IS NULL)
         AND visibility = 'public'
         AND archive_checked_at IS NULL`,
    )
    .first<{ n: number }>()
    .catch((err) => {
      console.error("[archive-sweep] remaining count failed:", err);
      return null;
    });

  // ok=false when any candidate errored so a scripted caller can gate on it
  // instead of seeing a 200 while nothing was written.
  if (candidates.length > 0 && errors.length === candidates.length) {
    console.error(
      `[archive-sweep] all ${candidates.length} candidates failed; first: ${errors[0]?.error}`,
    );
  }
  return c.json({
    ok: errors.length === 0,
    checked: candidates.length,
    ready,
    absent,
    skipped,
    errors,
    remaining: remainingRow?.n ?? null,
  });
});

/**
 * POST /admin/datasets/zarr-sweep?limit=N — one-time/periodic backfill that
 * reconciles the datasets.zarr_status column (migration 0035) from S3 truth for
 * the observability dashboard (epic #695). The Hallu backfill cron wrote zarr
 * stores to S3 but never POSTed /webhooks/zarr-ready, so ~213 already-converted
 * public datasets sit at zarr_status NULL while the viewer streams them fine.
 * This is the zarr analogue of /datasets/archive-sweep; the going-forward fix is
 * a /webhooks/zarr-ready POST from the Hallu driver.
 *
 * Bounded per invocation (default 50, max 200): getZarrIndex does ONE signed GET
 * of `<id>/zarr/index.json` per dataset (cheaper than a LIST). Idempotent via
 * the zarr_checked_at column (migration 0038): only rows never confirmed by the
 * webhook AND never checked by the sweep are candidates, so an absent-zarr
 * dataset is stamped once and never rescanned. Run until `remaining` reaches 0.
 */
adminRoutes.post("/datasets/zarr-sweep", async (c) => {
  const db = c.env.DB;
  const limitRaw = Number.parseInt(c.req.query("limit") || "50", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

  // Candidates: real (non-catalog), public, non-sandbox datasets whose zarr
  // state is still unknown — neither the webhook (zarr_status) nor a prior sweep
  // (zarr_checked_at) has touched them. Public-only because zarr.nemar.org only
  // serves public datasets (zarr-data.ts). Mirrors archive-sweep's candidacy.
  let candidates: { dataset_id: string }[];
  try {
    const candidateRows = await db
      .prepare(
        `SELECT dataset_id FROM datasets
         WHERE owner_user_id != ${SYSTEM_USER_ID}
           AND (is_sandbox = 0 OR is_sandbox IS NULL)
           AND visibility = 'public'
           AND zarr_status IS NULL
           AND zarr_checked_at IS NULL
         ORDER BY dataset_id
         LIMIT ?`,
      )
      .bind(limit)
      .all<{ dataset_id: string }>();
    candidates = candidateRows.results ?? [];
  } catch (err) {
    console.error("[zarr-sweep] candidate query failed:", err);
    return c.json({ error: "Failed to query sweep candidates (is migration 0038 applied?)" }, 500);
  }

  const s3 = getS3Config(c.env);
  let ready = 0;
  let absent = 0;
  const errors: { dataset_id: string; error: string }[] = [];

  for (const { dataset_id } of candidates) {
    // ONE signed GET of <id>/zarr/index.json. Returns null on 404 OR 403 (both
    // treated as absent -> stamp checked, see getZarrIndex); only a non-2xx infra
    // error or bad JSON throws, which is recorded below and keeps the row a
    // candidate for the next run (not mis-stamped absent).
    let index: Awaited<ReturnType<typeof getZarrIndex>>;
    try {
      index = await getZarrIndex(s3, dataset_id);
    } catch (err) {
      errors.push({ dataset_id, error: `s3: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    try {
      if (index) {
        // Converted: record latest-only state, mirroring /webhooks/zarr-ready.
        // zarr_converted_at is left untouched (we don't know the true backfill
        // time and won't fabricate one); zarr_status='ready' is the truth signal
        // the dashboard reads. ETag + source_commit are seeded for free.
        await db
          .prepare(
            `UPDATE datasets
             SET zarr_status = 'ready',
                 zarr_store_count = ?,
                 zarr_index_etag = COALESCE(?, zarr_index_etag),
                 zarr_source_commit = COALESCE(?, zarr_source_commit),
                 zarr_checked_at = datetime('now')
             WHERE dataset_id = ?`,
          )
          .bind(index.storeCount, index.etag, index.sourceCommit, dataset_id)
          .run();
        ready++;
      } else {
        // No index.json: stamp checked so the sweep won't rescan, but leave
        // zarr_status NULL (absence is not a 'failed' conversion).
        await db
          .prepare("UPDATE datasets SET zarr_checked_at = datetime('now') WHERE dataset_id = ?")
          .bind(dataset_id)
          .run();
        absent++;
      }
    } catch (err) {
      errors.push({
        dataset_id,
        error: `d1${index ? ` (stores=${index.storeCount})` : ""}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const remainingRow = await db
    .prepare(
      `SELECT COUNT(*) as n FROM datasets
       WHERE owner_user_id != ${SYSTEM_USER_ID}
         AND (is_sandbox = 0 OR is_sandbox IS NULL)
         AND visibility = 'public'
         AND zarr_status IS NULL
         AND zarr_checked_at IS NULL`,
    )
    .first<{ n: number }>()
    .catch((err) => {
      console.error("[zarr-sweep] remaining count failed:", err);
      return null;
    });

  if (candidates.length > 0 && errors.length === candidates.length) {
    console.error(
      `[zarr-sweep] all ${candidates.length} candidates failed; first: ${errors[0]?.error}`,
    );
  }
  return c.json({
    ok: errors.length === 0,
    checked: candidates.length,
    ready,
    absent,
    errors,
    remaining: remainingRow?.n ?? null,
  });
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
          await getDatasetsToken(c.env),
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
      const pat = await getDatasetsToken(c.env);
      const tree = await getTreeAtRef(repoName, "main", pat);
      const descFile = tree.find((f) => f.path === "dataset_description.json");
      if (!descFile) {
        return c.json(
          { error: "Cannot refresh metadata: dataset_description.json not found in repo" },
          400,
        );
      }
      const content = await getBlobContent(repoName, descFile.sha, pat);
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
          const nemarContent = await getBlobContent(repoName, nemarMetaFile.sha, pat);
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
        .prepare(
          "SELECT version, doi FROM dataset_versions WHERE dataset_id = ? ORDER BY created_at DESC",
        )
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
      updateOptions.target = datasetLandingUrl(datasetId);
      metadataRefreshed = true;
    }

    // Change status
    if (body.status) {
      if (body.status === "public" && dataset.ezid_status === "reserved") {
        updateOptions.status = "public";
        updateOptions.target = datasetLandingUrl(datasetId);
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
        .prepare(
          "SELECT version, doi FROM dataset_versions WHERE dataset_id = ? ORDER BY created_at DESC",
        )
        .bind(datasetId)
        .all<{ version: string; doi: string }>();

      const pat = await getDatasetsToken(c.env);
      for (const ver of versions.results || []) {
        try {
          const versionIdentifier = `${dataset.ezid_identifier}.V${ver.version.toUpperCase()}`;
          const repoName = dataset.github_repo?.split("/")[1];
          if (!repoName) {
            warnings.push(`Version ${ver.version}: skipped DOI update (no valid github_repo)`);
            continue;
          }
          const tree = await getTreeAtRef(repoName, "main", pat);
          const descFile = tree.find((f) => f.path === "dataset_description.json");
          if (!descFile) continue;
          const content = await getBlobContent(repoName, descFile.sha, pat);
          const bidsDesc = JSON.parse(content) as Record<string, unknown>;

          let vEnrichment = buildOrcidEnrichment(
            bidsDesc,
            dataset.owner_username,
            dataset.owner_orcid || undefined,
          );
          const nemarMetaFile =
            tree.find((f) => f.path === ".nemar/metadata.json") ||
            tree.find((f) => f.path === "nemar_metadata.json");
          if (nemarMetaFile) {
            try {
              const nemarContent = await getBlobContent(repoName, nemarMetaFile.sha, pat);
              const nemarParsed = parseNemarMetadata(JSON.parse(nemarContent));
              if (nemarParsed) vEnrichment = nemarMetadataToEnrichment(nemarParsed, vEnrichment);
            } catch (metaErr) {
              console.warn(
                `[doi/update] Metadata enrichment skipped for version ${ver.version}: ${metaErr instanceof Error ? metaErr.message : String(metaErr)}`,
              );
            }
          }

          const vDoi = extractDoi(versionIdentifier);
          const vMetadata = bidsToDataCite(datasetId, vDoi, bidsDesc, vEnrichment);
          vMetadata.version = ver.version;
          const vXml = buildDataCiteXml(vMetadata);
          const vTarget = datasetVersionLandingUrl(datasetId, ver.version);
          await ezidUpdateIdentifier(auth, versionIdentifier, {
            dataciteXml: vXml,
            target: vTarget,
          });
          versionDoiUpdated++;
        } catch (vErr) {
          warnings.push(
            `Version ${ver.version} DOI update failed: ${vErr instanceof Error ? vErr.message : String(vErr)}`,
          );
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

const enrichmentSchemaV2 = z
  .object({
    version: z.literal("2.0"),
    pipeline_stage: z.enum(["seeded", "enriched", "validated"]).optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    methods_description: z.string().optional(),
    license: z.string().optional(),
    dataset_type: z.string().optional(),
    resource_type_general: z.string().optional(),
    resource_type_specific: z.string().optional(),
    modalities: z.array(z.string()).optional(),
    sizes: z.array(z.string()).optional(),
    formats: z.array(z.string()).optional(),
    source_hash: z.string().optional(),
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
  })
  .passthrough();

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

  const pat = await getDatasetsToken(c.env);
  const metadataContent = JSON.stringify(body, null, 2);
  const isV2 = body.version === "2.0";
  const metadataPath = isV2 ? ".nemar/metadata.json" : "nemar_metadata.json";

  const entriesToIgnore = isV2 ? [".nemar/"] : ["nemar_metadata.json"];

  try {
    const commitResult = await commitEnrichmentWithBidsignore(
      repoName,
      "main",
      metadataPath,
      metadataContent,
      entriesToIgnore,
      "Update NEMAR metadata enrichment",
      pat,
    );
    if (commitResult.bidsignoreReadError) {
      console.warn(
        `[enrichment] Could not read .bidsignore for ${datasetId}; committed metadata alone: ${commitResult.bidsignoreReadError}`,
      );
    }

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
      bidsignore_updated: commitResult.bidsignoreUpdated,
      commit_mode: commitResult.commitMode,
      ...(commitResult.bidsignoreReadError
        ? { bidsignore_read_error: commitResult.bidsignoreReadError }
        : {}),
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
    const tree = await getTreeAtRef(repoName, "main", await getDatasetsToken(c.env));
    const files = tree
      .filter((f) => f.type === "blob")
      .map((f) => ({ path: f.path, size: f.size || 0 }));

    // Use S3 for real sizes (git tree shows symlink sizes for annexed files)
    let totalSize = files.reduce((sum, f) => sum + f.size, 0);
    let fileCount = files.length;
    const { getDatasetS3Stats, extractExtensions } = await import("../services/s3.js");
    try {
      const s3Stats = await getDatasetS3Stats(
        {
          bucket: c.env.S3_BUCKET,
          region: c.env.AWS_REGION,
          accessKeyId: c.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
        },
        datasetId,
      );
      if (s3Stats.totalSize > totalSize) {
        totalSize = s3Stats.totalSize;
        fileCount = s3Stats.objectCount ?? fileCount;
      }
    } catch (s3Err) {
      console.warn(
        `[admin/files] S3 stats failed for ${datasetId}, using tree sizes: ${s3Err instanceof Error ? s3Err.message : String(s3Err)}`,
      );
    }

    const extensions = extractExtensions(files.map((f) => f.path));

    return c.json({
      dataset_id: datasetId,
      file_count: fileCount,
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
  const pat = await getDatasetsToken(c.env);
  const result = await setRepoVisibility(repoName, isPrivate, pat);

  if (!result.ok) {
    return c.json({ error: `Failed to set repository to ${visibility}: ${result.error}` }, 500);
  }

  // Update S3 bucket policy based on visibility
  try {
    if (visibility === "public") {
      await markDatasetPublic(getS3Config(c.env), datasetId);
    } else {
      // Carve the dataset back out of public access when reverting to private
      await markDatasetPrivate(getS3Config(c.env), datasetId);
    }
  } catch (s3Error) {
    const s3Msg = s3Error instanceof Error ? s3Error.message : String(s3Error);
    console.error(`WARNING: Failed to update S3 policy for ${datasetId}:`, s3Msg);
    // GitHub visibility changed but S3 policy failed - revert GitHub
    const revertResult = await setRepoVisibility(repoName, !isPrivate, pat);
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
    const ghRevertResult = await setRepoVisibility(repoName, !isPrivate, pat);

    let s3Reverted = false;
    try {
      const s3Opts = getS3Config(c.env);
      if (visibility === "public") {
        // We had granted public access; revert by re-carving it out
        await markDatasetPrivate(s3Opts, datasetId);
      } else {
        await markDatasetPublic(s3Opts, datasetId);
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

  // Enforce the target repo spec for the new visibility (epic #713): public ->
  // lock main (branch + tag ruleset, green-gated) + reconcile collaborators;
  // private -> remove the branch ruleset + reconcile. Non-fatal: visibility is
  // already changed at GitHub/S3/D1.
  let specEnforcement: Awaited<ReturnType<typeof ensureRepoToSpec>> | undefined;
  try {
    const { ownerLogin, approvedWriters } = await resolveRepoCollaborators(db, datasetId);
    specEnforcement = await ensureRepoToSpec(repoName, pat, {
      visibility,
      collaborators: { ownerLogin, approvedWriters },
    });
  } catch (specError) {
    console.error(`Repo-spec enforcement failed for ${datasetId} (non-fatal):`, specError);
  }
  // Mirror reconcile removals into D1 (own try/catch; flags a divergence).
  await mirrorReconcileRemovals(db, datasetId, specEnforcement?.reconcile?.removed);

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
    spec_enforcement: specEnforcement?.steps,
    warning: auditLogFailed
      ? `Audit log write failed: ${auditLogError}. Operation succeeded but was not logged for compliance.`
      : undefined,
  });
});

// ============================================================================
// Fleet governance (epic #713)
// ============================================================================

/**
 * GET /admin/fleet/drift - Report dataset repos that are off the governance
 * spec. Read-only; gathers live GitHub state per repo (sequential, to respect
 * the shared App rate limit) and classifies into drift buckets. Filter with
 * ?prefix=nm, ?visibility=public|private, ?limit=N (default 25, max 50).
 */
adminRoutes.get("/fleet/drift", async (c) => {
  const db = c.env.DB;
  const prefix = c.req.query("prefix");
  const visFilter = c.req.query("visibility");
  const limit = Math.min(Math.max(Number.parseInt(c.req.query("limit") ?? "25", 10) || 25, 1), 50);

  const clauses: string[] = ["github_repo IS NOT NULL", "dataset_id != 'nm099999'"];
  const binds: unknown[] = [];
  if (prefix) {
    clauses.push("dataset_id LIKE ?");
    binds.push(`${prefix}%`);
  }
  if (visFilter === "public" || visFilter === "private") {
    clauses.push("visibility = ?");
    binds.push(visFilter);
  }

  const rows = await db
    .prepare(
      `SELECT dataset_id, github_repo, visibility FROM datasets
        WHERE ${clauses.join(" AND ")} ORDER BY dataset_id LIMIT ?`,
    )
    .bind(...binds, limit)
    .all<{ dataset_id: string; github_repo: string; visibility: string }>();

  const datasets = rows.results ?? [];
  const pat = await getDatasetsToken(c.env);
  const buckets: Partial<Record<DriftBucket, string[]>> = {};
  const repos: Array<{ dataset_id: string; buckets: DriftBucket[] }> = [];

  for (const d of datasets) {
    const repoName = d.github_repo.split("/")[1];
    if (!repoName) continue;
    const visibility = d.visibility === "public" ? "public" : "private";
    let result: DriftBucket[];
    try {
      result = classifyDatasetDrift(await gatherRepoDriftState(repoName, visibility, pat));
    } catch (e) {
      console.error(`[fleet/drift] gather failed for ${d.dataset_id}:`, e);
      continue;
    }
    repos.push({ dataset_id: d.dataset_id, buckets: result });
    for (const b of result) {
      const list = buckets[b] ?? [];
      list.push(d.dataset_id);
      buckets[b] = list;
    }
  }

  const counts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));
  return c.json({ scanned: datasets.length, limit, counts, buckets, repos });
});

const enforceSchema = z.object({ dry_run: z.boolean().optional() });

/**
 * POST /admin/datasets/:id/enforce - Bring one dataset repo to spec via
 * ensureRepoToSpec (public locks + reconciles; private removes the ruleset +
 * reconciles). `dry_run` defaults to TRUE (must pass `dry_run:false` to apply),
 * matching the bulk endpoint so a bare `{}` body never mutates.
 */
adminRoutes.post("/datasets/:id/enforce", zValidator("json", enforceSchema), async (c) => {
  const datasetId = c.req.param("id");
  const dryRun = c.req.valid("json").dry_run !== false;
  const db = c.env.DB;

  // Live datasets hold real data; refuse to APPLY governance changes to them
  // without an explicit override. Dry-run (read-only) is always allowed.
  if (!dryRun && isLiveDataset(datasetId) && c.req.query("force") !== "true") {
    return c.json(
      {
        error: `Refusing to enforce live dataset ${datasetId}. Pass ?force=true to override.`,
      },
      403,
    );
  }

  const dataset = await db
    .prepare("SELECT github_repo, visibility FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ github_repo: string | null; visibility: string }>();
  if (!dataset) return c.json({ error: "Dataset not found" }, 404);
  if (!dataset.github_repo) return c.json({ error: "Dataset has no GitHub repository" }, 400);
  const repoName = dataset.github_repo.split("/")[1];
  if (!repoName) return c.json({ error: "Invalid repository format" }, 500);

  const visibility = dataset.visibility === "public" ? "public" : "private";
  const pat = await getDatasetsToken(c.env);
  const { ownerLogin, approvedWriters } = await resolveRepoCollaborators(db, datasetId);

  let result: Awaited<ReturnType<typeof ensureRepoToSpec>>;
  try {
    result = await ensureRepoToSpec(repoName, pat, {
      visibility,
      collaborators: { ownerLogin, approvedWriters },
      dryRun: dryRun,
    });
  } catch (e) {
    return c.json(
      { error: "Enforcement failed", details: e instanceof Error ? e.message : String(e) },
      500,
    );
  }

  if (!dryRun) await mirrorReconcileRemovals(db, datasetId, result.reconcile?.removed);
  return c.json({ dataset_id: datasetId, dry_run: dryRun, result });
});

/**
 * POST /admin/datasets/:id/revalidate - Re-run central BIDS validation on the
 * dataset's `main` HEAD so a fresh `Run BIDS Validation` check-run lands there
 * (the enforce green-gate only reads HEAD; a `[skip ci]` metadata commit leaves
 * it uncovered). Unifies the two cases the manual #713 rollout handled by hand:
 *   - inline workflow still present -> `syncWorkflowTemplates` commits the shim,
 *     and that push auto-triggers validation;
 *   - shim already deployed -> `triggerBidsValidation` dispatches it directly.
 * Already-protected repos are skipped (locked => no re-validation needed).
 * Live datasets are refused without `?force=true` (mirrors ci/sync, #730).
 * The CLI polls the resulting check-run, then runs `enforce` for the greens.
 */
adminRoutes.post("/datasets/:id/revalidate", async (c) => {
  const datasetId = c.req.param("id");
  const db = c.env.DB;
  const adminUser = c.get("user");
  const force = c.req.query("force") === "true";

  if (isLiveDataset(datasetId) && !force) {
    return c.json(
      { error: `Refusing to revalidate live dataset ${datasetId}. Pass ?force=true to override.` },
      403,
    );
  }

  const dataset = await db
    .prepare("SELECT github_repo FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ github_repo: string | null }>();
  if (!dataset) return c.json({ error: "Dataset not found" }, 404);
  if (!dataset.github_repo) return c.json({ error: "Dataset has no GitHub repository" }, 400);
  const repoName = dataset.github_repo.split("/")[1];
  if (!repoName) return c.json({ error: "Invalid repository format" }, 500);

  const pat = await getDatasetsToken(c.env);

  // Skip-if-locked: a protected repo is already green-gated; no need to churn it.
  try {
    const ruleset = await getBranchRulesetInfo(repoName, pat);
    if (ruleset.present && !force) {
      const headSha = await getMainBranchSha(repoName, "main", pat).catch(() => null);
      return c.json({ dataset_id: datasetId, skipped: "already_protected", head_sha: headSha });
    }
  } catch (e) {
    // Non-fatal: if we can't read the ruleset, fall through and revalidate.
    console.error(`[revalidate] ruleset check failed for ${datasetId}:`, e);
  }

  let triggeredBy: "sync" | "dispatch";
  let headSha: string;
  try {
    // Ensure the central shim is deployed. If it was inline, the sync commit
    // auto-triggers validation; re-read HEAD to point the caller at the new sha.
    const sync = await syncWorkflowTemplates(repoName, "main", pat);
    if (sync.listFailed) {
      return c.json(
        { error: "Workflow listing failed (transient?)", details: sync.errors.join("; ") },
        502,
      );
    }
    if (sync.errors.length > 0) {
      return c.json({ error: "Workflow sync failed", details: sync.errors.join("; ") }, 502);
    }
    if (sync.committed) {
      triggeredBy = "sync";
      headSha = await getMainBranchSha(repoName, "main", pat);
    } else {
      triggeredBy = "dispatch";
      headSha = await getMainBranchSha(repoName, "main", pat);
      await triggerBidsValidation(datasetId, headSha, pat);
    }
  } catch (e) {
    return c.json(
      { error: "Revalidation failed", details: e instanceof Error ? e.message : String(e) },
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
        "ci_revalidate",
        "dataset",
        datasetId,
        JSON.stringify({ by: adminUser.username, triggered_by: triggeredBy, head_sha: headSha }),
      )
      .run();
  } catch (auditError) {
    console.error("Audit log write failed for revalidate:", auditError);
  }

  return c.json({ dataset_id: datasetId, head_sha: headSha, triggered_by: triggeredBy });
});

const enforceBulkSchema = z.object({
  prefix: z.string().optional(),
  visibility: z.enum(["public", "private"]).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  dry_run: z.boolean().optional(),
});

/**
 * POST /admin/datasets/enforce/bulk - Run ensureRepoToSpec across a filtered set
 * SEQUENTIALLY (shared App rate limit). `dry_run` defaults to TRUE; pass
 * `dry_run:false` to actually apply. Always excludes nm099999. Owner-only.
 */
adminRoutes.post("/datasets/enforce/bulk", zValidator("json", enforceBulkSchema), async (c) => {
  if (c.get("user").role !== "owner") {
    return c.json({ error: "Only the NEMAR owner can bulk-enforce" }, 403);
  }
  const db = c.env.DB;
  const { prefix, visibility, limit, dry_run } = c.req.valid("json");
  const dryRun = dry_run !== false; // default to a dry run
  const cap = limit ?? 25;

  // Never bulk-mutate the test dataset or any LIVE production dataset. The
  // values are compile-time constants (no user input), so inlining them is
  // injection-safe and mirrors the existing nm099999 literal.
  const liveList = [...LIVE_DATASETS].map((id) => `'${id}'`).join(", ");
  const clauses: string[] = [
    "github_repo IS NOT NULL",
    "dataset_id != 'nm099999'",
    `dataset_id NOT IN (${liveList})`,
  ];
  const binds: unknown[] = [];
  if (prefix) {
    clauses.push("dataset_id LIKE ?");
    binds.push(`${prefix}%`);
  }
  if (visibility) {
    clauses.push("visibility = ?");
    binds.push(visibility);
  }

  const rows = await db
    .prepare(
      `SELECT dataset_id, github_repo, visibility FROM datasets
        WHERE ${clauses.join(" AND ")} ORDER BY dataset_id LIMIT ?`,
    )
    .bind(...binds, cap)
    .all<{ dataset_id: string; github_repo: string; visibility: string }>();

  const datasets = rows.results ?? [];
  const pat = await getDatasetsToken(c.env);
  const results: Array<{
    dataset_id: string;
    steps?: Record<string, { status: string; detail?: string }>;
    error?: string;
  }> = [];

  for (const d of datasets) {
    const repoName = d.github_repo.split("/")[1];
    if (!repoName) {
      results.push({ dataset_id: d.dataset_id, error: "invalid repo format" });
      continue;
    }
    const vis = d.visibility === "public" ? "public" : "private";
    try {
      const { ownerLogin, approvedWriters } = await resolveRepoCollaborators(db, d.dataset_id);
      const spec = await ensureRepoToSpec(repoName, pat, {
        visibility: vis,
        collaborators: { ownerLogin, approvedWriters },
        dryRun: dryRun,
      });
      if (!dryRun) await mirrorReconcileRemovals(db, d.dataset_id, spec.reconcile?.removed);
      results.push({ dataset_id: d.dataset_id, steps: spec.steps });
    } catch (e) {
      results.push({ dataset_id: d.dataset_id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return c.json({ dry_run: dryRun, count: datasets.length, results });
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

  const pat = await getDatasetsToken(c.env);

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

  // Deploying workflows commits to the repo's main branch (same class of
  // mutation as ci/sync). Live datasets hold real data; refuse without an
  // explicit override.
  if (isLiveDataset(datasetId) && c.req.query("force") !== "true") {
    return c.json(
      {
        error: `Refusing to modify live dataset ${datasetId}. Pass ?force=true to override.`,
      },
      403,
    );
  }

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

  // Post-deploy parseability check moved out of the Worker (issue #472).
  // The CLI polls POST /admin/datasets/:id/ci/validate after this returns.
  // The legacy ?validate=false query param is accepted but ignored — old
  // CLIs that sent it still get a successful, fast deploy.
  const result = await deployWorkflows(repoName, await getDatasetsToken(c.env));

  if (!result.success) {
    return c.json(
      {
        error: "Failed to deploy some workflows",
        deployed: result.deployed,
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
    workflows_deployed: result.deployed,
  });
});

/**
 * POST /admin/datasets/:id/ci/validate - One-shot parseability probe.
 *
 * Called by the CLI after the deploy endpoint returns. The CLI handles the
 * indexing-lag wait and retry on its own machine, keeping the Worker
 * wall-clock budget out of the loop (issue #472).
 *
 * Returns valid/missing/errors for the workflows defined by the current
 * template set. Best-effort: a 500 from GitHub or a transport error lands in
 * `errors` rather than failing the response.
 *
 * Verb choice: this is a read-only probe and a strict REST reading would
 * favor GET. We keep POST to stay consistent with the rest of the ci/*
 * family (POST /ci to deploy, POST /ci/sync to bring drift back in line —
 * both admin-only RPC-style operations). Mixing verbs across the family
 * would surprise admin tooling that scripts these endpoints.
 */
adminRoutes.post("/datasets/:id/ci/validate", async (c) => {
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

  const result = await validateDeployedWorkflows(repoName, await getDatasetsToken(c.env));
  return c.json({
    dataset_id: datasetId,
    valid: result.valid,
    missing: result.missing,
    errors: result.errors,
  });
});

/**
 * POST /admin/datasets/:id/ci/sync - Bring deployed CI workflows in sync with
 * the current templates. Only files that drift or are missing are written,
 * in a single tree commit. Idempotent and cheap when nothing has changed
 * (single Contents-API listing).
 */
adminRoutes.post("/datasets/:id/ci/sync", async (c) => {
  const datasetId = c.req.param("id");
  const db = c.env.DB;
  const adminUser = c.get("user");

  // ci/sync commits to the repo's main branch (overwrites workflow files).
  // Live datasets hold real data; refuse without an explicit override.
  if (isLiveDataset(datasetId) && c.req.query("force") !== "true") {
    return c.json(
      {
        error: `Refusing to modify live dataset ${datasetId}. Pass ?force=true to override.`,
      },
      403,
    );
  }

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

  const result = await syncWorkflowTemplates(repoName, "main", await getDatasetsToken(c.env));

  try {
    await db
      .prepare(
        "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        adminUser.id,
        "ci_workflows_synced",
        "dataset",
        datasetId,
        JSON.stringify({
          synced_by: adminUser.username,
          changed: result.changed,
          added: result.added,
          errors: result.errors,
          committed: result.committed,
          list_failed: result.listFailed,
        }),
      )
      .run();
  } catch (auditError) {
    console.error("Audit log write failed for CI sync:", auditError);
  }

  // 207 (Multi-Status) when the call surfaced any partial failures so
  // automation and `--all` loops don't false-green on partial errors.
  const status = result.errors.length > 0 ? 207 : 200;
  return c.json(
    {
      dataset_id: datasetId,
      checked: result.checked,
      changed: result.changed,
      added: result.added,
      errors: result.errors,
      committed: result.committed,
      list_failed: result.listFailed,
    },
    status,
  );
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
      prescreen_status: string | null;
      prescreen_reasons: string | null;
      prescreen_issue_url: string | null;
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
      "SELECT id, status, requested_by FROM publication_requests WHERE dataset_id = ? AND status IN ('requested', 'approving', 'blocked') ORDER BY requested_at DESC LIMIT 1",
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
      const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
      await sendPublicationDeniedEmail(
        user.email,
        user.username,
        datasetId,
        reason,
        c.env.RESEND_API_KEY,
        fromEmail,
        replyTo,
        isDev,
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
 *  2. s3_public_read - Grant public read by removing the dataset's private
 *      carve-out from the bucket policy (see services/bucket-policy.ts). Runs
 *      first among the mutations (epic #736, Phase 4) for propagation lead time.
 *  3. repo_public - Make repository public
 *  4. tag_protect - Apply tag protection rules (prevent version tag deletion)
 *  5. doi_create - Create concept DOI if not exists
 *  6. update_metadata - Update dataset_description.json with DOI
 *  7. update_readme - Generate/update README with dataset info
 *  8. create_tag - Create git tag for the version
 *  9. create_release - Create GitHub release from tag
 * 10. upload_to_zenodo - Upload release archive to Zenodo
 * 11. publish_doi - Publish the Zenodo DOI (permanent and irreversible!)
 * 12. s3_lock - Apply S3 Object Lock (Governance mode)
 * 13. sync_nemar - Sync metadata to nemar.org datapipeline (non-fatal)
 * 14. notify_user - Send publication confirmation email
 *
 * (Archive zip generation is NOT an orchestrator step -- the central
 * run-version-doi.yml workflow dispatches generate-archive after the version
 * DOI mint; see #670.)
 *
 * Body: { resume?: boolean } - if true, skip already-completed steps
 */
const approveSchema = z.object({
  resume: z.boolean().optional().default(false),
  sandbox: z.boolean().optional().default(false),
  s3_lock_continuation_token: z.string().optional(),
  // Total S3 object count for the dataset's `objects/` prefix. The server
  // computes this once on the first s3_lock call (when no continuation
  // token is sent) and returns it via `s3_lock_total` in every response;
  // the CLI threads it back on subsequent calls so progress reporting
  // ("Locking S3 objects: 1240/4963 (25.0%)") survives across the many
  // sequential Worker invocations a large dataset requires. See #284.
  s3_lock_total: z.number().int().nonnegative().optional(),
  // Pre-#385 CLIs (v0.8.4 and earlier) sent `s3_lock_offset` for
  // offset-paginated batching. The server no longer reads it AND no
  // longer returns it on the response, which means an old CLI's inner
  // pagination loop breaks out on the very first `hasMore: true`,
  // silently reporting "lock complete" after only the first batch — a
  // dataset published this way ends up with most objects unlocked. We
  // detect this case explicitly and reject with 426 so the admin sees a
  // clear "upgrade required" message instead of corrupt-by-omission
  // success.
  s3_lock_offset: z.number().optional(),
  skip_ci_check: z.boolean().optional().default(false),
});

adminRoutes.post("/publish/:id/approve", zValidator("json", approveSchema), async (c) => {
  const datasetId = c.req.param("id");
  const { resume, sandbox } = c.req.valid("json");
  const body = c.req.valid("json");
  const adminUser = c.get("user");
  const db = c.env.DB;

  // Refuse pre-#385 CLIs that still drive s3_lock by offset. See the
  // approveSchema comment for the silent-partial-lock failure mode this
  // prevents.
  if (body.s3_lock_offset !== undefined && body.s3_lock_continuation_token === undefined) {
    console.warn(
      `[publish] rejecting pre-0.8.5 CLI for ${datasetId}: s3_lock_offset is no longer supported`,
    );
    return c.json(
      {
        error: "Outdated nemar-cli; please upgrade to >=0.8.5 for S3 lock streaming",
        message:
          "This server uses S3 ListObjectsV2 continuation tokens for s3_lock. Upgrade with `bun add -g @nemarOrg/nemar-cli@latest` and re-run.",
      },
      // 426 Upgrade Required signals a strictly-non-retryable client problem
      // so the CLI's transient-error retry classifier won't mask it.
      426,
    );
  }

  // Find the publication request
  const request = await db
    .prepare(
      "SELECT id, status, steps_completed FROM publication_requests WHERE dataset_id = ? AND status IN ('requested', 'approving', 'blocked') ORDER BY requested_at DESC LIMIT 1",
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
    // Flip S3 public as early as possible (epic #736, Phase 4 / #741): it is the
    // first mutation after the validation gates, so the bucket-policy change has
    // the most time to propagate before create_tag fires generate-archive.
    "s3_public_read",
    "repo_public",
    "tag_protect",
    "doi_create",
    "update_metadata",
    "update_readme",
    "create_tag",
    "create_release",
    "upload_to_zenodo",
    "publish_doi", // Permanent and irreversible!
    "version_doi",
    "s3_lock",
    "sync_nemar",
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

  const pat = await getDatasetsToken(c.env);
  const completed: PublicationStep[] = [...stepsCompleted];
  const requestId = request.id;
  const stepResults: StepResult[] = [];

  // Track step start time for duration measurement
  let currentStepStartMs = 0;

  // Captured at the end of the s3_lock step so the final success response
  // can include the last-batch count. The CLI accumulates `s3_lock_batch_count`
  // from every response (including the non-hasMore final one) to render the
  // completed percentage; omitting it from the final response means the CLI's
  // counter reads short by exactly the last batch. (#284)
  let s3LockFinalTotal: number | undefined;
  let s3LockFinalBatchCount: number | undefined;

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
          const deployResult = await deployWorkflows(repoName, pat);
          if (!deployResult.success) {
            throw new Error(
              `Failed to deploy CI workflows to ${repoName}: ${deployResult.errors.join("; ")}`,
            );
          }
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
          {
            error: `CI check failed: ${msg}`,
            step: "ci_check",
            steps_completed: completed,
            step_results: stepResults,
          },
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

  // Add the S3 public-read bucket policy (deny-list removal). Runs as the FIRST
  // mutation after the validation gates (epic #736, Phase 4 / #741) so the
  // bucket-policy change has the most time to propagate before create_tag fires
  // generate-archive.
  if (stepsToRun.includes("s3_public_read")) {
    try {
      await startStep("s3_public_read");

      const { attempts: s3PublicAttempts } = await withRetry(
        () => markDatasetPublic(getS3Config(c.env), datasetId),
        "s3_public_read",
      );

      // Non-fatal propagation gate: confirm a real blob is actually anonymously
      // readable, so a stuck/slow propagation is surfaced rather than silently
      // assumed (the nm000111 failure mode). Run it via waitUntil
      // (fire-and-forget) so its bounded poll (~10s) overlaps the subsequent
      // publish steps instead of adding serial latency toward the Worker
      // wall-clock limit -- the gate is observability-only and the cascade
      // proceeds regardless (Phase 1's signed reads removed the hard dependency).
      c.executionCtx.waitUntil(
        (async () => {
          try {
            const propagation = await waitForPublicPropagation(getS3Config(c.env), datasetId);
            if (propagation.checked && !propagation.propagated) {
              console.warn(
                `[publish] s3_public_read: public access not yet propagated for ${datasetId} after ${propagation.attempts} probes (key=${propagation.key})`,
              );
            } else {
              console.log(
                `[publish] s3_public_read: propagation ${
                  propagation.checked
                    ? `confirmed in ${propagation.attempts} probe(s)`
                    : "skipped (no annexed objects)"
                } for ${datasetId}`,
              );
            }
          } catch (gateErr) {
            console.warn(
              `[publish] s3_public_read: propagation probe errored for ${datasetId} (non-fatal):`,
              gateErr instanceof Error ? gateErr.message : String(gateErr),
            );
          }
        })(),
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

  // Make the repository public (runs after the S3 public flip; the two are
  // independent, S3 goes first for propagation lead time).
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

      // Enforce the published-repo spec (epic #713): lock main (ruleset,
      // green-gated) + reconcile collaborators. Non-fatal; visibility is
      // already public + verified above.
      let publishSpec: Awaited<ReturnType<typeof ensureRepoToSpec>> | undefined;
      try {
        const { ownerLogin, approvedWriters } = await resolveRepoCollaborators(db, datasetId);
        publishSpec = await ensureRepoToSpec(repoName, pat, {
          visibility: "public",
          collaborators: { ownerLogin, approvedWriters },
        });
        // Surface a non-green/failed protection step in the bulk-approval log,
        // since the orchestrator response does not carry the per-step detail.
        const offSteps = Object.entries(publishSpec.steps)
          .filter(([, s]) => s.status !== "ok")
          .map(([k, s]) => `${k}=${s.status}${s.detail ? `(${s.detail})` : ""}`);
        if (offSteps.length > 0) {
          console.warn(`[repo-spec] ${datasetId} enforcement non-ok steps: ${offSteps.join(", ")}`);
        }
      } catch (specError) {
        console.error(`Repo-spec enforcement failed for ${datasetId} (non-fatal):`, specError);
      }
      // Mirror reconcile removals into D1 (own try/catch; flags a divergence).
      await mirrorReconcileRemovals(db, datasetId, publishSpec?.reconcile?.removed);

      await updateProgress("repo_public");
    } catch (err) {
      const msg = errorMessage(err);
      await updateProgress("repo_public", msg);
      return c.json(
        {
          error: `repo_public failed: ${msg}`,
          step: "repo_public",
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
  }

  // Tag protection (before DOI to prevent tag manipulation)
  // Idempotent: applyTagProtection treats 422 (rule already exists) as
  // success and throws HttpError with status + body on terminal failure.
  // No inline withRetry: githubFetchWithRetry inside applyTagProtection
  // already absorbs short propagation 5xx/404 windows. Persistent failures
  // (e.g., GitHub "Repository has been locked" right after a visibility
  // flip) are surfaced as 500 so the CLI's retry-with-delay loop can
  // re-invoke from a fresh Worker (and a fresh propagation window).
  if (stepsToRun.includes("tag_protect")) {
    try {
      await startStep("tag_protect");

      const { applyTagProtection } = await import("../services/github");
      await applyTagProtection(repoName, pat);

      await updateProgress("tag_protect");
    } catch (err) {
      const msg = errorMessage(err);
      await updateProgress("tag_protect", msg);
      return c.json(
        {
          error: `Tag protection failed: ${msg}`,
          step: "tag_protect",
          steps_completed: completed,
          step_results: stepResults,
        },
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
              console.warn(
                "[publish] doi_create: .nemar/metadata.json enrichment skipped:",
                nemarErr,
              );
            }
          }
        }

        // EZID DOIs are deterministic (buildConceptIdentifier is a pure function
        // of datasetId), and createEzidConceptDoi already handles the
        // "already exists" case by fetching the existing record. That makes
        // EZID minting idempotent under retry, which is what we want here:
        // EZID/DataCite propagation can briefly fail with transient 5xx or
        // network errors during approval. Zenodo's createDeposition is NOT
        // idempotent (each call mints a fresh deposition), so we only retry
        // when the provider is EZID.
        const { createConceptDoi: doiDispatch } = await import("../services/doi");
        const doiCall = () =>
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
          );
        const { result: doiResult, attempts: doiAttempts } =
          provider === "ezid"
            ? await withRetry(doiCall, "doi_create")
            : { result: await doiCall(), attempts: 1 };
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

        // Keep the in-memory `dataset` snapshot in sync with the DB write so
        // later steps in this same invocation (publish_doi, etc.) don't read
        // a stale null and fail with "No EZID identifier found".
        dataset.concept_doi = doiResult.doi;
        dataset.doi_provider = provider;
        dataset.is_sandbox = sandbox ? 1 : 0;
        if (provider === "ezid") {
          dataset.ezid_identifier = doiResult.providerRecordId;
          dataset.ezid_status = doiResult.status;
        } else {
          dataset.zenodo_concept_id = doiResult.providerRecordId;
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
      return c.json(
        { error: parseMsg, step: stepName, steps_completed: completed, step_results: stepResults },
        500,
      );
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
        {
          error: "No Zenodo deposition ID found",
          step: stepName,
          steps_completed: completed,
          step_results: stepResults,
        },
        500,
      );
    }
    const depositionId = Number.parseInt(row.zenodo_concept_id, 10);
    if (Number.isNaN(depositionId)) {
      const msg = `Invalid Zenodo deposition ID: ${row.zenodo_concept_id}`;
      console.error(`[publish] ${msg} for dataset ${datasetId}`);
      await updateProgress(stepName, msg);
      return c.json(
        { error: msg, step: stepName, steps_completed: completed, step_results: stepResults },
        500,
      );
    }
    const isSandbox = row.is_sandbox === 1;
    const token = isSandbox ? c.env.ZENODO_SANDBOX_API_KEY : c.env.ZENODO_API_KEY;
    if (!token) {
      const msg = isSandbox
        ? "Zenodo sandbox API key not configured"
        : "Zenodo API key not configured";
      await updateProgress(stepName, msg);
      return c.json(
        { error: msg, step: stepName, steps_completed: completed, step_results: stepResults },
        500,
      );
    }
    return { depositionId, token, isSandbox };
  }

  // --- Helper: get version and tag from dataset_description.json ---
  // NOTE: This helper only reads; version defaulting is handled in update_metadata
  // to avoid creating [skip ci] commits that the create_tag step would tag.
  async function getVersionTag(
    stepName: PublicationStep,
  ): Promise<{ version: string; tag: string; datasetDesc: Record<string, unknown> } | Response> {
    const result = await readDatasetDescription(stepName);
    if (result instanceof Response) return result;
    const datasetDesc = result;
    const version = String(datasetDesc.Version || "1.0.0");
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

      // Preserve existing DatasetDOI in SourceDatasets before overwriting
      const existingDoi = datasetDesc.DatasetDOI;
      if (typeof existingDoi === "string" && existingDoi && existingDoi !== conceptDoi) {
        const sources: Array<Record<string, unknown>> = Array.isArray(datasetDesc.SourceDatasets)
          ? [...(datasetDesc.SourceDatasets as Array<Record<string, unknown>>)]
          : [];
        const alreadyPresent = sources.some(
          (s) => typeof s.DOI === "string" && s.DOI === existingDoi,
        );
        if (!alreadyPresent) {
          sources.push({ DOI: existingDoi });
          datasetDesc.SourceDatasets = sources;
          console.log(
            `[publish] Preserved existing DatasetDOI "${existingDoi}" in SourceDatasets for ${datasetId}`,
          );
        }
      }

      datasetDesc.DatasetDOI = conceptDoi;

      // Set default Version if missing so create_tag doesn't need to write a
      // separate [skip ci] commit (which would prevent the version-doi CI from
      // triggering on the tag push).
      if (!datasetDesc.Version) {
        console.info(
          `[publish] No Version in dataset_description.json for ${repoName}; defaulting to 1.0.0`,
        );
        datasetDesc.Version = "1.0.0";
      }

      await createOrUpdateFile(
        repoName,
        "dataset_description.json",
        JSON.stringify(datasetDesc, null, 2),
        `Update DatasetDOI with concept DOI: ${conceptDoi} [skip ci]`,
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

      // Decide whether the README needs a commit. Skips the no-op case
      // (current badge already present in README.md) so --resume runs do
      // not stack empty "Add DOI badge" commits that re-trigger CI.
      const plan = planReadmeBadgeCommit({
        readmeContent,
        doiBadge,
        conceptDoi,
        contentSourcePath: contentSource?.path,
      });

      if (!plan.commit) {
        console.log(`[publish] update_readme skipping commit for ${repoName}: ${plan.reason}`);
      } else {
        await createOrUpdateFile(repoName, "README.md", plan.content, plan.message, pat);
      }

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

      // Update GitHub repo description (name only) and homepage (DOI URL)
      const { setRepoDescription } = await import("../services/github.js");
      const descResult = await setRepoDescription(
        repoName,
        dataset.name,
        pat,
        conceptDoi ? `https://doi.org/${conceptDoi}` : undefined,
      );
      let descWarning: string | undefined;
      if (!descResult.ok) {
        descWarning = `Repo description not set: ${descResult.error}`;
        console.warn(`[publish] ${descWarning}`);
      }

      await updateProgress("update_readme", descWarning);
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

      const nemarUrl = datasetLandingUrl(datasetId);
      const archiveLine = `**Download:** [${tag}.zip](https://github.com/nemarDatasets/${repoName}/archive/refs/tags/${tag}.zip)`;
      const sections = [
        `# ${dataset.name} - Version ${version}`,
        `BIDS-formatted dataset published via [NEMAR](${nemarUrl}).`,
        archiveLine,
      ];
      if (datasetDesc.DatasetDOI) {
        sections.push(`**DOI:** https://doi.org/${datasetDesc.DatasetDOI}`);
      }
      const releaseBody = sections.join("\n\n");

      const { attempts: createReleaseAttempts } = await withRetry(
        () => createRelease(repoName, tag, tag, releaseBody, pat),
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

  // Step: upload_to_zenodo - Disabled (EZID is now the DOI provider)
  // The step is kept in allSteps so existing DB records with upload_to_zenodo
  // in steps_completed remain valid.
  if (stepsToRun.includes("upload_to_zenodo")) {
    console.log("[publish] Zenodo upload skipped (disabled)");
    await updateProgress("upload_to_zenodo");
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
        const target = datasetLandingUrl(datasetId);
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

  // Step: version_doi - Create version DOI record and manifest via webhook
  // This creates the version DOI record and manifest directly (same logic as
  // the publish-version-doi webhook). We can't self-fetch in Cloudflare Workers,
  // so we call the service functions directly. The central run-version-doi.yml
  // (Phase 2 of #601, on nemarDatasets/.github) serves as the
  // tag-push-triggered counterpart for PR/patch scenarios.
  if (stepsToRun.includes("version_doi")) {
    try {
      await startStep("version_doi");

      const vtResult = await getVersionTag("version_doi");
      if (vtResult instanceof Response) {
        // updateProgress was already called by readDatasetDescription inside getVersionTag
        // so we just mark completed to avoid double-recording and unnecessary retries
        await updateProgress("version_doi");
      } else {
        const { version } = vtResult;

        // Only stable semver versions get permanent DOIs (matches webhook guard)
        if (!/^\d+\.\d+\.\d+$/.test(version)) {
          console.info(
            `[publish] version_doi skipped for ${datasetId}: non-stable version "${version}"`,
          );
        }

        // Re-read dataset to get latest state (concept DOI may have been set in earlier steps)
        const freshDataset = !/^\d+\.\d+\.\d+$/.test(version)
          ? null
          : await db.prepare("SELECT * FROM datasets WHERE dataset_id = ?").bind(datasetId).first<{
              id: number;
              dataset_id: string;
              name: string;
              github_repo: string | null;
              concept_doi: string | null;
              ezid_identifier: string | null;
              doi_provider: string | null;
            }>();

        if (!freshDataset) {
          // Non-stable version, or dataset disappeared during publish
          if (/^\d+\.\d+\.\d+$/.test(version)) {
            console.error(
              `[publish] version_doi: dataset ${datasetId} not found in D1 (deleted during publish?)`,
            );
          }
          await updateProgress("version_doi");
        } else if (!freshDataset.ezid_identifier) {
          console.info(`[publish] version_doi skipped for ${datasetId}: no EZID identifier`);
          await updateProgress("version_doi");
        } else if (!freshDataset.concept_doi) {
          console.info(`[publish] version_doi skipped for ${datasetId}: no concept DOI`);
          await updateProgress("version_doi");
        } else {
          // Auto-detect sandbox from EZID test shoulder prefix (both paths).
          const sandboxPrefix = TEST_SHOULDER.replace(/^doi:/, "").split("/")[0];
          const isSandboxDoi = freshDataset.ezid_identifier.includes(sandboxPrefix);

          if (isCentralManifestWorkflowEnabled(c.env)) {
            // Central flow (#751): cheap O(1) mint + dispatch. No inline
            // generateManifest (the file-count wall) and no inline
            // dataset_versions insert — /webhooks/manifest-ready owns the row
            // once the dispatched manifest job uploads to S3, the same single
            // owner as the tag-triggered webhook path.
            const minted = await publishEzidVersionDoiViaCentral(c.env, {
              dataset: freshDataset,
              repoName,
              version,
              sandbox: isSandboxDoi,
              pat,
              requestSource: "admin",
            });
            if (minted.warnings?.length) {
              for (const w of minted.warnings) {
                console.warn(`[publish:version_doi] ${w}`);
              }
            }
            console.log(`[publish] Version DOI dispatched for ${datasetId}: ${minted.doi}`);
            await updateProgress(
              "version_doi",
              minted.warnings?.length
                ? `DOI created (${minted.doi}) but: ${minted.warnings.join("; ")}`
                : undefined,
            );
          } else {
            // LEGACY inline path (centralFlow disabled, e.g. prod before the
            // #751 cutover). Reads the full repo tree and generates the manifest
            // inline; retained unchanged for the pre-cutover env.
            const repoMeta = await readRepoMetadata(
              repoName,
              pat,
              undefined,
              freshDataset.name,
              `v${version}`,
            );
            for (const w of repoMeta.warnings) {
              console.warn("[publish:version_doi]", w);
            }

            // Query existing version DOIs for concept DOI HasVersion relations
            const versionRows = await db
              .prepare("SELECT doi FROM dataset_versions WHERE dataset_id = ?")
              .bind(datasetId)
              .all<{ doi: string }>();
            const existingVersionDois = versionRows.results.map((r) => r.doi);

            const result = await createEzidVersionDoi(
              {
                EZID_USERNAME: c.env.EZID_USERNAME,
                EZID_PASSWORD: c.env.EZID_PASSWORD,
                EZID_SANDBOX_USERNAME: c.env.EZID_SANDBOX_USERNAME,
                EZID_SANDBOX_PASSWORD: c.env.EZID_SANDBOX_PASSWORD,
              },
              {
                datasetId,
                conceptIdentifier: freshDataset.ezid_identifier,
                version,
                bidsDescription: repoMeta.bidsDescription,
                githubRepo: freshDataset.github_repo || `nemarDatasets/${repoName}`,
                sandbox: isSandboxDoi,
                existingVersionDois,
                enrichment: repoMeta.enrichment,
              },
            );

            // Surface warnings from DOI creation (e.g., concept DOI HasVersion update failed)
            if (result.warnings?.length) {
              for (const w of result.warnings) {
                console.warn(`[publish:version_doi] ${w}`);
              }
            }

            // DOI is now public and permanent. DB and manifest failures below are
            // non-fatal but must be surfaced for operator awareness.
            let dbError: string | undefined;
            try {
              await db
                .prepare(
                  "UPDATE datasets SET latest_version_doi = ?, updated_at = datetime('now') WHERE id = ?",
                )
                .bind(result.doi, freshDataset.id)
                .run();

              await db
                .prepare(
                  "INSERT OR IGNORE INTO dataset_versions (dataset_id, version, doi, provider) VALUES (?, ?, ?, 'ezid')",
                )
                .bind(datasetId, version, result.doi)
                .run();
            } catch (err) {
              dbError = errorMessage(err);
              console.error(
                `[publish] DOI ${result.doi} is PUBLIC but DB update failed for ${datasetId}:`,
                err,
              );
            }

            // Generate and upload version manifest (proceeds regardless of DB failure)
            const manifest = await generateManifest(
              repoName,
              version,
              pat,
              datasetId,
              result.doi,
              freshDataset.concept_doi,
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

            console.log(`[publish] Version DOI created for ${datasetId}: ${result.doi}`);
            const issues = [
              ...(dbError ? [`DB update failed: ${dbError}`] : []),
              ...(result.warnings || []),
            ];
            await updateProgress(
              "version_doi",
              issues.length ? `DOI created (${result.doi}) but: ${issues.join("; ")}` : undefined,
            );
          }
        }
      }
    } catch (err) {
      // Non-fatal: the CI workflow may still handle this as a fallback
      const msg = errorMessage(err);
      console.error(`[publish] version_doi failed for ${datasetId}: ${msg}`);
      await updateProgress("version_doi", msg);
    }
  }

  // Step 12: S3 Object Lock — streamed via S3 ListObjectsV2 continuation
  // tokens. Each invocation issues exactly one LIST page (capped to
  // batchSize keys via max-keys) plus up to batchSize PutObjectRetention
  // calls — bounded subrequest cost regardless of dataset size. The CLI
  // re-invokes with the returned `s3_lock_continuation_token` until
  // `hasMore` is false. Idempotent: 403 = already-locked = counted as
  // success, so retries on the same token are safe.
  //
  // The previous offset-based approach paginated the entire dataset on
  // every call (full LIST + 40-PUT slice), which compounded across
  // batches and tripped Cloudflare's per-invocation subrequest cap on
  // the SCCN deployment for datasets with even a few hundred objects
  // (#385).
  if (stepsToRun.includes("s3_lock")) {
    try {
      await startStep("s3_lock");

      // Count total objects once at the start of the s3_lock stream so the
      // CLI can render a real progress bar instead of just a running count
      // (#284). The CLI threads `s3_lock_total` back via the request body
      // on every subsequent call so we don't re-count per page.
      //
      // Subrequest budget note: the counting sweep uses ceil(N/1000) LIST
      // subrequests; for a 6500-object dataset that is ~7 LISTs on top of
      // the 1 LIST + 100 PUTs from applyObjectLockBatch. The Workers Paid
      // cap is 1000 subrequests, so we cap the sweep at 20 LISTs (20 000
      // objects). If the dataset is larger the count is skipped and the CLI
      // falls back to a running count without a denominator — better than
      // risking a "Too many subrequests" failure on the first invocation.
      const MAX_COUNT_LISTS = 20;
      let s3LockTotal = body.s3_lock_total;
      if (s3LockTotal === undefined && body.s3_lock_continuation_token === undefined) {
        const stats = await getDatasetS3Stats(getS3Config(c.env), datasetId, MAX_COUNT_LISTS);
        // stats.objectCount is undefined when the cap was hit; leave
        // s3LockTotal as undefined so the CLI shows "N locked" without a
        // denominator rather than an incorrect percentage.
        if (stats.objectCount !== undefined) {
          s3LockTotal = stats.objectCount;
        }
      }

      const lockResult = await applyObjectLockBatch(
        getS3Config(c.env),
        datasetId,
        body.s3_lock_continuation_token,
      );

      if (lockResult.failed.length > 0) {
        const msg = `${lockResult.locked} locked, ${lockResult.failed.length} failed`;
        await updateProgress("s3_lock", msg);
        return c.json(
          {
            error: `S3 lock partially failed: ${msg}`,
            step: "s3_lock",
            steps_completed: completed,
            step_results: stepResults,
            details: lockResult,
            // Echo the same token the caller sent so the CLI's retry
            // replays this exact batch (idempotent: 403=already-locked).
            // Without this echo, the CLI would lose its place and
            // re-stream from page 1 on retry.
            s3_lock_continuation_token: body.s3_lock_continuation_token,
            s3_lock_total: s3LockTotal,
            s3_lock_batch_count: lockResult.locked,
          },
          500,
        );
      }

      if (lockResult.hasMore) {
        // More pages to lock — return next continuation token for the
        // CLI to thread into its next invocation.
        return c.json({
          message: `S3 lock in progress: ${lockResult.locked} locked in this batch`,
          step: "s3_lock",
          steps_completed: completed,
          step_results: stepResults,
          s3_lock_continuation_token: lockResult.nextContinuationToken,
          s3_lock_total: s3LockTotal,
          s3_lock_batch_count: lockResult.locked,
          hasMore: true,
        });
      }

      // Capture values for the final success response so the CLI's running
      // counter reaches the true total (not short by the last batch).
      s3LockFinalTotal = s3LockTotal;
      s3LockFinalBatchCount = lockResult.locked;
      await updateProgress("s3_lock");
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

  // NOTE (#670): the archive is generated by the central run-version-doi.yml
  // workflow, which always dispatches `generate-archive` after minting the
  // version DOI. The `create_tag` step above pushes the `v*` tag, which fires
  // the GitHub App push webhook -> triggerVersionDoiRun -> run-version-doi.yml
  // -> generate-archive. A separate orchestrator-side `generate_archive` step
  // used to ALSO dispatch here, producing two redundant Generate Archive runs
  // per publish; it was removed (run-generate-archive.yml also gained an
  // S3 skip-if-exists guard as defense-in-depth).

  // Step 14: Sync metadata to nemar.org datapipeline
  if (stepsToRun.includes("sync_nemar")) {
    try {
      await startStep("sync_nemar");

      // OpenNeuro-imported datasets need alternate_id mapping before syncing
      if (datasetId.startsWith("on")) {
        console.log(
          `[publish] Skipping nemar.org sync for OpenNeuro dataset ${datasetId} (alternate_id not yet supported)`,
        );
        await updateProgress("sync_nemar");
      } else if (!c.env.NEMAR_USERNAME || !c.env.NEMAR_PASSWORD) {
        console.warn("[publish] NEMAR_USERNAME/PASSWORD not configured; skipping nemar.org sync");
        await updateProgress("sync_nemar");
      } else {
        const nemarUser = c.env.NEMAR_USERNAME;
        const nemarPass = c.env.NEMAR_PASSWORD;
        // Gather source data
        const s3Cfg = getS3Config(c.env);
        const tree = await getTreeAtRef(repoName, "main", pat);
        const bidsFile = tree.find((f) => f.path === "dataset_description.json");
        let bidsDescription: Record<string, unknown> = {};
        if (bidsFile) {
          try {
            bidsDescription = JSON.parse(await getBlobContent(repoName, bidsFile.sha, pat));
          } catch (err) {
            console.warn(`[publish] Failed to parse dataset_description.json: ${err}`);
          }
        }

        const readmeFile = tree.find((f) => f.path === "README" || f.path === "README.md");
        const readme = readmeFile ? await getBlobContent(repoName, readmeFile.sha, pat) : "";

        const nemarMetaFile = tree.find((f) => f.path === ".nemar/metadata.json");
        let nemarMeta = null;
        if (nemarMetaFile) {
          try {
            const raw = JSON.parse(await getBlobContent(repoName, nemarMetaFile.sha, pat));
            const parsed = parseNemarMetadata(raw);
            if (parsed && parsed.version === "2.0") nemarMeta = parsed;
          } catch (err) {
            console.warn(`[publish] Failed to parse .nemar/metadata.json: ${err}`);
          }
        }

        // Gather D1 data, S3 stats, repo info in parallel
        const [latestVersion, updatedDoi, pubRequest, s3Stats, zipFileSize] = await Promise.all([
          db
            .prepare(
              "SELECT version, doi, created_at FROM dataset_versions WHERE dataset_id = ? ORDER BY created_at DESC LIMIT 1",
            )
            .bind(datasetId)
            .first<{ version: string; doi: string; created_at: string }>(),
          db
            .prepare("SELECT concept_doi, created_at FROM datasets WHERE dataset_id = ?")
            .bind(datasetId)
            .first<{ concept_doi: string | null; created_at: string | null }>(),
          db
            .prepare("SELECT approved_at FROM publication_requests WHERE id = ?")
            .bind(requestId)
            .first<{ approved_at: string | null }>(),
          getDatasetS3Stats(s3Cfg, datasetId).catch((err) => {
            console.warn(`[publish] S3 stats failed for ${datasetId}: ${err}`);
            return { totalSize: 0, objectCount: 0 };
          }),
          getArchiveSize(s3Cfg, datasetId).catch((err) => {
            console.warn(`[publish] Archive size failed for ${datasetId}: ${err}`);
            return 0;
          }),
        ]);

        // Try to read version manifest from S3 for accurate file sizes
        let manifest = null;
        if (latestVersion?.version) {
          try {
            const raw = await getManifest(s3Cfg, datasetId, latestVersion.version);
            if (raw) {
              try {
                manifest = JSON.parse(raw);
              } catch (parseErr) {
                console.warn(
                  `[publish] Manifest JSON corrupted for ${datasetId} v${latestVersion.version}: ${parseErr}`,
                );
              }
            }
          } catch (err) {
            console.warn(`[publish] Failed to fetch manifest from S3 for ${datasetId}: ${err}`);
          }
        }

        const syncResult = await syncDatasetToNemar(nemarUser, nemarPass, {
          datasetId,
          bidsDescription,
          nemarMetadata: nemarMeta,
          readme,
          tree,
          conceptDoi: updatedDoi?.concept_doi || null,
          latestVersionDoi: latestVersion?.doi || null,
          latestVersion: latestVersion?.version || null,
          versionCreatedAt: latestVersion?.created_at || null,
          ownerUsername: dataset.owner_username,
          createdAt: updatedDoi?.created_at || null,
          publishDate: pubRequest?.approved_at || null,
          repoName,
          pat,
          manifest,
          s3Stats,
          zipFileSize,
        });

        // Update sync tracking
        await db
          .prepare(
            `UPDATE datasets SET nemar_sync_status = ?, nemar_sync_at = CASE WHEN ? = 'synced' THEN datetime('now') ELSE nemar_sync_at END, nemar_sync_error = ?, updated_at = datetime('now') WHERE dataset_id = ?`,
          )
          .bind(
            syncResult.synced ? "synced" : "failed",
            syncResult.synced ? "synced" : "failed",
            syncResult.errors.length ? syncResult.errors.join("; ") : null,
            datasetId,
          )
          .run();

        if (!syncResult.synced) {
          console.warn(
            `[publish] nemar.org sync partially failed for ${datasetId}: ${syncResult.errors.join("; ")}`,
          );
        }

        await updateProgress(
          "sync_nemar",
          syncResult.synced ? undefined : syncResult.errors.join("; "),
        );
      }
    } catch (err) {
      const msg = errorMessage(err);
      // Non-fatal: nemar.org sync failure should not block publication
      console.warn(`[publish] nemar.org sync failed for ${datasetId} (non-fatal): ${msg}`);
      try {
        await db
          .prepare(
            "UPDATE datasets SET nemar_sync_status = 'failed', nemar_sync_error = ?, updated_at = datetime('now') WHERE dataset_id = ?",
          )
          .bind(msg, datasetId)
          .run();
      } catch (d1Err) {
        console.warn(`[publish] Failed to update sync status in D1: ${d1Err}`);
      }
      await updateProgress("sync_nemar", msg);
    }
  }

  // Step 15: Notify user (non-fatal — mirrors sync_nemar pattern)
  let notifyUserWarning: string | undefined;
  if (stepsToRun.includes("notify_user")) {
    try {
      await startStep("notify_user");

      // Re-read DOI in case it was just created
      const updatedDataset = await db
        .prepare("SELECT concept_doi FROM datasets WHERE dataset_id = ?")
        .bind(datasetId)
        .first<{ concept_doi: string | null }>();

      const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
      await sendPublicationApprovedEmail(
        dataset.owner_email,
        dataset.owner_username,
        datasetId,
        updatedDataset?.concept_doi || null,
        c.env.RESEND_API_KEY,
        fromEmail,
        replyTo,
        isDev,
      );

      await updateProgress("notify_user");
    } catch (err) {
      const msg = errorMessage(err);
      // Non-fatal: email failure must not block publication after DOI is minted
      console.error(`[publish] notify_user failed for ${datasetId} (non-fatal): ${msg}`);
      notifyUserWarning = `Notification email failed: ${msg}`;
      try {
        await db
          .prepare(
            "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(
            adminUser.id,
            "notify_user_failed",
            "dataset",
            datasetId,
            JSON.stringify({ error: msg, owner_email: dataset.owner_email }),
          )
          .run();
      } catch (auditErr) {
        console.warn(`[publish] Failed to write notify_user failure to audit log: ${auditErr}`);
      }
      await updateProgress("notify_user", msg);
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

  // Combine all non-fatal warnings into the response so operators can act
  // without tailing logs. Both warnings are optional and independent.
  const auditWarning = auditLogFailed
    ? `Audit log write failed: ${auditLogError}. Publication succeeded but was not logged for compliance.`
    : undefined;
  const responseWarnings = [auditWarning, notifyUserWarning].filter(Boolean);

  return c.json({
    message: "Dataset published successfully",
    dataset_id: datasetId,
    status: "published",
    steps_completed: allSteps,
    step_results: stepResults,
    // Always return the final s3_lock totals so the CLI's running counter
    // reaches the true total. Without these the last batch is never counted
    // and the progress display reads short by a full page (e.g. 3963/4963
    // instead of 4963/4963) even when locking succeeded. (#284)
    s3_lock_total: s3LockFinalTotal,
    s3_lock_batch_count: s3LockFinalBatchCount,
    warning: responseWarnings.length > 0 ? responseWarnings.join(" | ") : undefined,
  });
});

/**
 * POST /admin/datasets/:id/s3-lock - Apply S3 Object Lock to dataset
 *
 * Streamed via S3 ListObjectsV2 continuation tokens — see
 * `applyObjectLockBatch` for the per-invocation subrequest contract.
 */
adminRoutes.post("/datasets/:id/s3-lock", async (c) => {
  const datasetId = c.req.param("id");
  const db = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as { continuation_token?: string };

  const dataset = await db
    .prepare("SELECT dataset_id FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ dataset_id: string }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  try {
    const result = await applyObjectLockBatch(
      getS3Config(c.env),
      datasetId,
      body.continuation_token,
    );

    return c.json({
      message: result.failed.length === 0 ? "Batch locked" : "Some objects failed",
      dataset_id: datasetId,
      locked: result.locked,
      failed: result.failed.map((f) => ({ key: f.key, error: f.error })),
      hasMore: result.hasMore,
      continuation_token: result.nextContinuationToken,
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
 *
 * Optional body `{ doi?: string }`: explicit version DOI. If omitted, the
 * handler tries to read the DOI from the existing manifest.json on S3. Under
 * the central manifest workflow (`MANIFEST_VIA_CENTRAL_WORKFLOW=true`),
 * publish-time `dataset_versions` inserts happen on the `/webhooks/manifest-ready`
 * callback path, so admin recovery of a stranded version may need to backfill
 * the `dataset_versions` row here. The caller must supply `doi` explicitly
 * when no manifest.json exists on S3 (or the existing manifest carries no
 * DOI), because there is no inline DOI minting in this admin path.
 */
adminRoutes.post("/datasets/:id/manifest/:version", async (c) => {
  const datasetId = c.req.param("id");
  const version = c.req.param("version");
  const db = c.env.DB;

  // Accept optional DOI in request body
  const body = await c.req.json<{ doi?: string }>().catch(() => ({}));

  const dataset = await db
    .prepare(
      "SELECT dataset_id, github_repo, concept_doi, doi_provider FROM datasets WHERE dataset_id = ?",
    )
    .bind(datasetId)
    .first<{
      dataset_id: string;
      github_repo: string | null;
      concept_doi: string | null;
      doi_provider: string | null;
    }>();

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

  const pat = await getDatasetsToken(c.env);

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

    // Backfill dataset_versions row if missing. Under the central manifest
    // workflow (#557), publish-time inserts run on /webhooks/manifest-ready;
    // a stranded version (manifest+S3 present, D1 row absent) needs this
    // admin path to repair the gap. OR IGNORE keeps the legacy double-write
    // path safe.
    const versionDoiForRow = versionDoi ?? manifest.doi ?? null;
    let dataset_versions_backfilled = false;
    if (versionDoiForRow) {
      const existing = await db
        .prepare("SELECT doi FROM dataset_versions WHERE dataset_id = ? AND version = ?")
        .bind(datasetId, version)
        .first<{ doi: string }>();
      if (!existing) {
        const provider = dataset.doi_provider === "zenodo" ? "zenodo" : "ezid";
        try {
          await db
            .prepare(
              "INSERT OR IGNORE INTO dataset_versions (dataset_id, version, doi, provider) VALUES (?, ?, ?, ?)",
            )
            .bind(datasetId, version, versionDoiForRow, provider)
            .run();
          dataset_versions_backfilled = true;
        } catch (err) {
          console.error(
            `[admin manifest regen] dataset_versions backfill failed for ${datasetId}@${version}:`,
            err,
          );
        }
      }
    } else {
      console.warn(
        `[admin manifest regen] no DOI resolved for ${datasetId}@${version}; skipping dataset_versions backfill (caller must pass {doi: "..."} body to repair)`,
      );
    }

    return c.json({
      message: "Manifest generated and uploaded",
      dataset_id: datasetId,
      version: manifest.version,
      files_count: Object.keys(manifest.files).length,
      dataset_versions_backfilled,
    });
  } catch (err) {
    const msg = errorMessage(err);
    return c.json({ error: `Manifest generation failed: ${msg}` }, 500);
  }
});

// ============================================================================
// Admin Doctor: scan + fix stuck-dataset patterns
// ============================================================================

/**
 * POST /admin/doctor/scan - Run diagnostic checks across datasets.
 *
 * Body (all optional):
 *   - check: name of a single check (omit to run all)
 *   - dataset_id: narrow the scan to one dataset
 *
 * Read-only. Returns findings per check.
 */
adminRoutes.post("/doctor/scan", async (c) => {
  type ScanBody = { check?: string; dataset_id?: string };
  const body = (await c.req.json<ScanBody>().catch(() => ({}))) as ScanBody;

  let checks = DOCTOR_CHECKS;
  if (body.check) {
    const found = getCheck(body.check);
    if (!found) {
      return c.json({ error: `Unknown check: ${body.check}`, available: listChecks() }, 400);
    }
    checks = [found];
  }

  const ctx: CheckContext = {
    db: c.env.DB,
    s3: getS3Config(c.env),
    githubPat: await getDatasetsToken(c.env),
  };

  const results: Record<string, { description: string; count: number; findings: Finding[] }> = {};
  for (const check of checks) {
    const findings = await check.scan(ctx, body.dataset_id);
    results[check.name] = {
      description: check.description,
      count: findings.length,
      findings,
    };
  }

  return c.json({
    scanned: checks.map((c) => c.name),
    results,
  });
});

/**
 * POST /admin/doctor/fix - Apply a check's remediation.
 *
 * Body:
 *   - check (required): name of the check
 *   - dataset_id (optional): narrow to one dataset
 *   - dry_run (optional, default false): list findings without writing
 *
 * Returns per-dataset fix results. Fixes are serial to bound worker memory
 * and respect downstream rate limits (GitHub, S3, EZID).
 */
adminRoutes.post("/doctor/fix", async (c) => {
  type FixBody = { check?: string; dataset_id?: string; dry_run?: boolean };
  const body = (await c.req.json<FixBody>().catch(() => ({}))) as FixBody;

  if (!body.check) {
    return c.json({ error: "check is required", available: listChecks() }, 400);
  }
  const check = getCheck(body.check);
  if (!check) {
    return c.json({ error: `Unknown check: ${body.check}`, available: listChecks() }, 400);
  }

  const ctx: CheckContext = {
    db: c.env.DB,
    s3: getS3Config(c.env),
    githubPat: await getDatasetsToken(c.env),
  };

  const findings = await check.scan(ctx, body.dataset_id);

  if (body.dry_run) {
    return c.json({
      check: body.check,
      dry_run: true,
      would_fix: findings.length,
      findings,
    });
  }

  const results: Array<{
    dataset_id: string;
    version?: string;
    status: "fixed" | "skipped" | "failed";
    message?: string;
    details?: Record<string, unknown>;
  }> = [];
  for (const finding of findings) {
    const result = await check.fix(ctx, finding);
    results.push({
      dataset_id: finding.dataset_id,
      version: finding.version,
      ...result,
    });
  }

  return c.json({
    check: body.check,
    total: findings.length,
    fixed: results.filter((r) => r.status === "fixed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  });
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
    const pat = await getDatasetsToken(c.env);
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

  // Folded legacy catalog rows (#646) are sentinel-owned, with no GitHub repo /
  // S3 of their own, and are re-created from the upstream nemar.org catalog on
  // the next catalog sync, so deleting one here is futile. Refuse with a clear
  // 400. deleteDatasetCascade also refuses (defense-in-depth for other callers).
  if (dataset.owner_user_id === SYSTEM_USER_ID) {
    return c.json(
      {
        error: `"${datasetId}" is a system catalog entry (owner=nemar-system) managed by the nemar.org catalog sync and cannot be deleted here.`,
        dataset_id: datasetId,
      },
      400,
    );
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

// ─── Bulk delete datasets ────────────────────────────────────────────────────

const bulkDeleteSchema = z.object({
  dataset_ids: z
    .array(z.string().regex(/^(nm|xx|on)\d{6}$/, "Invalid dataset ID format"))
    .min(1)
    .max(200)
    .transform((ids) => [...new Set(ids)]),
});

/**
 * POST /admin/datasets/bulk-delete - Delete multiple datasets at once
 *
 * Only works on unpublished datasets (private, no DOI, no active pub requests).
 * Intended for cleaning up phantom/orphaned datasets.
 * Requires owner role.
 */
adminRoutes.post("/datasets/bulk-delete", zValidator("json", bulkDeleteSchema), async (c) => {
  const requestingUser = c.get("user");
  if (!hasRole(requestingUser.role, "owner")) {
    return c.json({ error: "Only the NEMAR owner can bulk-delete datasets" }, 403);
  }

  const { dataset_ids } = c.req.valid("json");
  const db = c.env.DB;
  const results: Array<{ dataset_id: string; deleted: boolean; error?: string }> = [];

  for (const datasetId of dataset_ids) {
    try {
      // Safety: only delete private datasets with no DOI
      const dataset = await db
        .prepare("SELECT visibility, concept_doi FROM datasets WHERE dataset_id = ?")
        .bind(datasetId)
        .first<{ visibility: string; concept_doi: string | null }>();

      if (!dataset) {
        results.push({ dataset_id: datasetId, deleted: false, error: "not found" });
        continue;
      }
      if (dataset.concept_doi || dataset.visibility === "public") {
        results.push({ dataset_id: datasetId, deleted: false, error: "has DOI or is public" });
        continue;
      }

      const result = await deleteDatasetCascade(db, c.env, datasetId);
      results.push({
        dataset_id: datasetId,
        deleted: result.deleted,
        error: result.warnings.join("; ") || undefined,
      });
    } catch (err) {
      results.push({
        dataset_id: datasetId,
        deleted: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const deletedCount = results.filter((r) => r.deleted).length;
  const failedCount = results.filter((r) => !r.deleted).length;

  // Audit log (non-fatal; don't fail the response if audit write fails)
  try {
    await db
      .prepare(
        "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        requestingUser.id,
        "bulk_delete",
        "dataset",
        dataset_ids.join(","),
        JSON.stringify({ deleted: deletedCount, failed: failedCount, ids: dataset_ids }),
      )
      .run();
  } catch (auditErr) {
    console.error(
      `[bulk-delete] Failed to write audit log (${deletedCount} deleted, ${failedCount} failed):`,
      auditErr,
    );
  }

  return c.json({ deleted: deletedCount, failed: failedCount, results });
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
          console.error(`[import] failed to seed import_jobs row for ${dataset_id}:`, importJobErr);
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
          console.error(`[import] failed to remove folded catalog shadow ${source_id}:`, shadowErr);
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

// ---------------------------------------------------------------------------
// nemar.org Datapipeline Sync
// ---------------------------------------------------------------------------

/**
 * POST /admin/datasets/:id/sync - Manually sync a dataset to nemar.org
 *
 * Gathers metadata from D1/GitHub and pushes to nemar.org datapipeline API.
 * Useful for backfilling datasets published before this feature existed.
 */
adminRoutes.post("/datasets/:id/sync", async (c) => {
  const datasetId = c.req.param("id");

  // Thin wrapper around runDatasetSync (epic #417 phase 3) so the admin
  // and post-version-DOI sync paths share one implementation, and so this
  // endpoint also populates the Phase 2 metadata columns.
  try {
    const result = await runDatasetSync(c.env, datasetId);
    return c.json({
      dataset_id: datasetId,
      synced: result.synced,
      errors: result.errors,
      metadata_columns_written: result.metadata_columns_written,
      ...(result.metadata_columns_error && {
        metadata_columns_error: result.metadata_columns_error,
      }),
      ...(result.nemar_sync_skipped && { nemar_sync_skipped: true }),
    });
  } catch (err) {
    if (err instanceof DatasetReindexError) {
      return c.json({ error: err.message }, err.statusCode);
    }
    console.error(`[admin/sync] Unexpected error for ${datasetId}:`, err);
    return c.json({ error: errorMessage(err) }, 500);
  }
});

/**
 * POST /admin/datasets/:id/reindex - Refresh enrichment + nemar.org sync +
 * Phase 2 metadata columns for a single dataset (epic #417 phase 3).
 *
 * Body: { skip_enrichment?: boolean, skip_sync?: boolean, ref?: string }
 *
 * Returns per-step status so a transient failure in one path does not
 * cause the operator to repeat the entire reindex.
 */
adminRoutes.post("/datasets/:id/reindex", async (c) => {
  const datasetId = c.req.param("id");
  // Parse body directly so chunked-transfer requests (no Content-Length
  // header) still produce a body. An empty body is treated as defaults.
  let body: { skip_enrichment?: boolean; skip_sync?: boolean; ref?: string } = {};
  try {
    const raw = await c.req.text();
    if (raw.length > 0) body = JSON.parse(raw);
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  const skipEnrichment = body.skip_enrichment === true;
  const skipSync = body.skip_sync === true;
  if (skipEnrichment && skipSync) {
    return c.json({ error: "skip_enrichment and skip_sync cannot both be true" }, 400);
  }

  const result: {
    dataset_id: string;
    enrichment: { status: "ok" | "failed" | "skipped"; ref?: string; error?: string };
    sync: {
      status: "ok" | "failed" | "skipped";
      errors?: string[];
      metadata_columns_written?: boolean;
      metadata_columns_error?: string;
    };
  } = {
    dataset_id: datasetId,
    enrichment: { status: "skipped" },
    sync: { status: "skipped" },
  };

  if (!skipEnrichment) {
    const enr = await runEnrichmentForDataset(c.env, datasetId, { ref: body.ref });
    result.enrichment = enr.ok
      ? { status: "ok", ref: enr.ref }
      : { status: "failed", ref: enr.ref, error: enr.error };
  }

  if (!skipSync) {
    try {
      const sync = await runDatasetSync(c.env, datasetId);
      // `nemar_sync_skipped` is set when the upstream push was intentionally
      // suppressed (today: OpenNeuro datasets that have no alternate_id
      // mapping). Map that to status="skipped" so callers can distinguish a
      // real failure from a benign skip. Metadata columns are still written
      // in the skip case, so we keep that field accurate.
      const syncStatus: "ok" | "failed" | "skipped" = sync.nemar_sync_skipped
        ? "skipped"
        : sync.synced
          ? "ok"
          : "failed";
      result.sync = {
        status: syncStatus,
        errors: sync.errors,
        metadata_columns_written: sync.metadata_columns_written,
        ...(sync.metadata_columns_error && {
          metadata_columns_error: sync.metadata_columns_error,
        }),
      };
    } catch (err) {
      if (err instanceof DatasetReindexError) {
        return c.json(
          { ...result, sync: { status: "failed", errors: [err.message] } },
          err.statusCode,
        );
      }
      console.error(`[admin/reindex] Unexpected sync error for ${datasetId}:`, err);
      return c.json({ ...result, sync: { status: "failed", errors: [errorMessage(err)] } }, 500);
    }
  }

  return c.json(result);
});

/**
 * POST /admin/datasets/reindex/bulk - Run reindex across a filtered set of
 * datasets. Sequential to respect upstream rate limits (epic #417 phase 3).
 *
 * Body: {
 *   filter: "all" | "missing-metadata" | "stale",
 *   older_than_days?: number,
 *   skip_enrichment?: boolean,
 *   skip_sync?: boolean,
 *   dry_run?: boolean,
 * }
 */
adminRoutes.post("/datasets/reindex/bulk", async (c) => {
  let body: {
    filter?: string;
    older_than_days?: number;
    skip_enrichment?: boolean;
    skip_sync?: boolean;
    dry_run?: boolean;
  } = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  const validFilters: ReindexFilter[] = ["all", "missing-metadata", "stale"];
  if (!body.filter || !validFilters.includes(body.filter as ReindexFilter)) {
    return c.json({ error: `filter must be one of: ${validFilters.join(", ")}` }, 400);
  }
  const filter = body.filter as ReindexFilter;
  const skipEnrichment = body.skip_enrichment === true;
  const skipSync = body.skip_sync === true;
  if (skipEnrichment && skipSync) {
    return c.json({ error: "skip_enrichment and skip_sync cannot both be true" }, 400);
  }

  let query: { sql: string; params: unknown[] };
  try {
    query = buildReindexFilterQuery(filter, { olderThanDays: body.older_than_days });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }

  // Guard against the Worker-deployed-before-migration partial-deploy window:
  // the filter SQL references Phase 2 columns (subject_count, modalities,
  // metadata_updated_at, etc.). If migration 0020 hasn't been applied yet,
  // D1 returns a column-not-found error. Map that to 503 with a clear
  // message instead of a generic 500 so operators know what to do.
  let datasetIds: string[];
  const startedAt = Date.now();
  try {
    const rows = await c.env.DB.prepare(query.sql)
      .bind(...query.params)
      .all<{ dataset_id: string }>();
    datasetIds = (rows.results ?? []).map((r) => r.dataset_id);
  } catch (err) {
    const msg = errorMessage(err);
    if (/no such column|undefined column/i.test(msg)) {
      console.error(
        "[admin/reindex/bulk] D1 query failed; migration 0020 may not be applied:",
        err,
      );
      return c.json(
        {
          error:
            "Bulk reindex query references columns added by migration 0020. Apply the migration (wrangler d1 migrations apply) and retry.",
          details: msg,
        },
        503,
      );
    }
    console.error("[admin/reindex/bulk] D1 query failed unexpectedly:", err);
    return c.json({ error: msg }, 500);
  }

  if (body.dry_run === true) {
    return c.json({
      filter,
      dry_run: true,
      total: datasetIds.length,
      datasets: datasetIds,
      elapsed_ms: Date.now() - startedAt,
    });
  }

  type PerDataset = {
    dataset_id: string;
    enrichment: { status: "ok" | "failed" | "skipped"; error?: string };
    sync: {
      status: "ok" | "failed" | "skipped";
      errors?: string[];
      metadata_columns_error?: string;
    };
  };
  const results: PerDataset[] = [];

  // Sequential to keep per-dataset failures isolated and respect upstream
  // rate limits (nemar.org, OpenRouter, GitHub). The runtime budget for a
  // Cloudflare Worker request is the limiting factor for very large batches;
  // operators should narrow the filter or split into multiple runs.
  for (const datasetId of datasetIds) {
    const entry: PerDataset = {
      dataset_id: datasetId,
      enrichment: { status: "skipped" },
      sync: { status: "skipped" },
    };
    if (!skipEnrichment) {
      const enr = await runEnrichmentForDataset(c.env, datasetId);
      entry.enrichment = enr.ok ? { status: "ok" } : { status: "failed", error: enr.error };
    }
    if (!skipSync) {
      try {
        const sync = await runDatasetSync(c.env, datasetId);
        entry.sync = {
          status: sync.synced ? "ok" : "failed",
          errors: sync.errors,
          ...(sync.metadata_columns_error && {
            metadata_columns_error: sync.metadata_columns_error,
          }),
        };
      } catch (err) {
        // Per-dataset failure must surface in server logs in addition to the
        // response body so an operator running with -i (or a CI job that
        // only checks HTTP status) still gets a trace.
        console.error(`[admin/reindex/bulk] ${datasetId} sync threw:`, err);
        entry.sync = { status: "failed", errors: [errorMessage(err)] };
      }
    }
    if (entry.enrichment.status === "failed") {
      console.warn(
        `[admin/reindex/bulk] ${datasetId} enrichment failed: ${entry.enrichment.error}`,
      );
    }
    results.push(entry);
  }

  return c.json({
    filter,
    total: results.length,
    results,
    elapsed_ms: Date.now() - startedAt,
  });
});

/**
 * GET /admin/sync/status - List sync status for all published datasets
 */
adminRoutes.get("/sync/status", async (c) => {
  const db = c.env.DB;

  const results = await db
    .prepare(
      `SELECT d.dataset_id, d.name, d.nemar_sync_status, d.nemar_sync_at, d.nemar_sync_error
       FROM datasets d
       WHERE d.visibility = 'public' OR d.concept_doi IS NOT NULL
       ORDER BY d.nemar_sync_status IS NULL DESC, d.nemar_sync_status = 'failed' DESC, d.dataset_id`,
    )
    .all<{
      dataset_id: string;
      name: string;
      nemar_sync_status: string | null;
      nemar_sync_at: string | null;
      nemar_sync_error: string | null;
    }>();

  return c.json({
    datasets: results.results,
    total: results.results.length,
    synced: results.results.filter((d) => d.nemar_sync_status === "synced").length,
    failed: results.results.filter((d) => d.nemar_sync_status === "failed").length,
    pending: results.results.filter((d) => d.nemar_sync_status === null).length,
  });
});

// ============================================================================
// Import jobs (issue #754) - import state view + rollback/retry
// ============================================================================

/** GET /admin/imports[?status=] - list import_jobs with by-status counts. */
adminRoutes.get("/imports", async (c) => {
  const db = c.env.DB;
  const status = c.req.query("status");
  let query = `SELECT dataset_id, source, source_id, stage, status, last_error,
                      workflow_run_url, created_at, updated_at, completed_at
               FROM import_jobs`;
  const params: string[] = [];
  if (status) {
    query += " WHERE status = ?";
    params.push(status);
  }
  // Surface the rows that need a human first.
  query += " ORDER BY (status = 'failed') DESC, (status = 'quarantined') DESC, updated_at DESC";
  const rows = await db
    .prepare(query)
    .bind(...params)
    .all<{ status: string }>();
  const results = rows.results ?? [];
  // by_status is always a FLEET-WIDE count (independent of the ?status= filter)
  // so the CLI summary line isn't misleading when a filter is applied.
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
adminRoutes.post("/imports/:id/rollback", async (c) => {
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
 * self-heals the row).
 */
adminRoutes.post("/imports/:id/retry", async (c) => {
  const datasetId = c.req.param("id");
  const res = await c.env.DB.prepare(
    `UPDATE import_jobs
       SET status = 'preparing', stage = 'prepare', last_error = NULL, completed_at = NULL, updated_at = datetime('now')
     WHERE dataset_id = ? AND status IN ('failed', 'quarantined')`,
  )
    .bind(datasetId)
    .run();
  if (res.meta.changes === 0) {
    return c.json({ error: "No failed/quarantined import to retry for this dataset" }, 409);
  }
  return c.json({ ok: true, dataset_id: datasetId, status: "preparing" });
});

// ============================================================================
// Catalog Sync (nemar.org catalog -> D1)
// ============================================================================

/**
 * POST /admin/catalog/sync - Fold pre-fetched catalog records into `datasets`
 *
 * The nemar.org API requires GET with a JSON body, which Workers' fetch()
 * rejects. The GitHub Action fetches the catalog and POSTs records here.
 * Accepts { records: NemarCatalogRecord[] } in the request body. New/changed
 * rows are marked embedding_dirty=1 for the scheduled re-embed.
 */
adminRoutes.post("/catalog/sync", async (c) => {
  const body = await c.req.json<{ records?: unknown[] }>();

  if (body.records && Array.isArray(body.records) && body.records.length > 0) {
    // Validate records before importing
    const validRecords: NemarCatalogRecord[] = [];
    const validationErrors: string[] = [];
    for (const [i, raw] of (body.records as Array<Record<string, unknown>>).entries()) {
      if (!raw.id || typeof raw.id !== "string") {
        validationErrors.push(`Record ${i}: missing or invalid 'id'`);
        continue;
      }
      if (!raw.name || typeof raw.name !== "string") {
        validationErrors.push(`Record ${i} (${raw.id}): missing or invalid 'name'`);
        continue;
      }
      validRecords.push(raw as unknown as NemarCatalogRecord);
    }
    if (validRecords.length === 0) {
      return c.json(
        { error: "No valid records in payload", validation_errors: validationErrors },
        400,
      );
    }
    if (validationErrors.length > 0) {
      console.warn(
        `[catalog-sync] ${validationErrors.length} records failed validation, importing ${validRecords.length}`,
      );
    }

    const result = await importCatalogRecords(c.env.DB, validRecords);
    return c.json({
      records_synced: result.recordsSynced,
      errors: result.errors,
      duration_ms: result.durationMs,
    });
  }

  // No records provided; try fetching directly (will fail in Workers due to GET+body)
  const result = await syncCatalog(c.env.DB);
  return c.json({
    records_synced: result.recordsSynced,
    errors: result.errors,
    duration_ms: result.durationMs,
  });
});

/**
 * GET /admin/catalog/status - Show catalog sync history
 */
adminRoutes.get("/catalog/status", async (c) => {
  const db = c.env.DB;

  try {
    // #646: records_indexed is no longer written (vectors are re-embedded
    // lazily by the embedding_dirty drain cron, not counted during sync), so
    // it's dropped from the status projection.
    const logs = await db
      .prepare(
        `SELECT id, started_at, completed_at, records_synced, errors, status
         FROM catalog_sync_log
         ORDER BY started_at DESC
         LIMIT 10`,
      )
      .all<{
        id: number;
        started_at: string;
        completed_at: string | null;
        records_synced: number;
        errors: string | null;
        status: string;
      }>();

    // #646: the catalog is now the folded legacy rows in `datasets` (the
    // sentinel-owned source-of-truth rows), not the dropped nemar_catalog table.
    const catalogCount = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM datasets WHERE owner_user_id = ? AND status = 'active'",
      )
      .bind(SYSTEM_USER_ID)
      .first<{ count: number }>();

    return c.json({
      catalog_size: catalogCount?.count ?? 0,
      recent_syncs: logs.results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Narrow the graceful path to a missing catalog_sync_log (the only
    // optional table here). A missing `datasets` is a real infra failure and
    // must surface as a 500, not a misleading "not initialized" 200.
    if (msg.includes("no such table: catalog_sync_log")) {
      return c.json({
        catalog_size: 0,
        recent_syncs: [],
        message: "catalog_sync_log not initialized",
      });
    }
    return c.json({ error: "Failed to query catalog status", details: msg }, 500);
  }
});

/**
 * POST /admin/vectorize/reindex-all - Re-embed datasets' vectors from the
 * `datasets` source of truth (#646 Phase 4). Fixes the stale-vector backlog.
 *
 * Keyset-paginated to stay within Worker limits: pass `after` = the previous
 * response's `last_id` and repeat until `has_more` is false.
 * Body: { limit?: number (1..500, default 200), after?: string, dry_run?: boolean }
 */
adminRoutes.post("/vectorize/reindex-all", async (c) => {
  if (!c.env.AI || !c.env.VECTORIZE) {
    return c.json({ error: "AI or VECTORIZE binding not configured" }, 400);
  }
  let body: { limit?: number; after?: string; dry_run?: boolean } = {};
  try {
    body = await c.req.json();
  } catch {
    // empty body is fine; defaults apply
  }
  const limit = Math.min(Math.max(Number(body.limit) || 200, 1), 500);
  const after = typeof body.after === "string" ? body.after : "";
  const startedAt = Date.now();

  const rows = await c.env.DB.prepare(
    `SELECT dataset_id FROM datasets
     WHERE status = 'active' AND visibility = 'public'
       AND (is_sandbox = 0 OR is_sandbox IS NULL)
       AND dataset_id > ?
     ORDER BY dataset_id
     LIMIT ?`,
  )
    .bind(after, limit)
    .all<{ dataset_id: string }>();
  const ids = (rows.results ?? []).map((r) => r.dataset_id);
  const lastId = ids.at(-1) ?? after;
  const hasMore = ids.length === limit;

  if (body.dry_run === true) {
    return c.json({
      dry_run: true,
      total: ids.length,
      last_id: lastId,
      has_more: hasMore,
      elapsed_ms: Date.now() - startedAt,
    });
  }

  let embedded = 0;
  for (const id of ids) {
    if (await reembedDatasetVector(c.env.DB, c.env.AI, c.env.VECTORIZE, id)) embedded++;
  }
  return c.json({
    scanned: ids.length,
    embedded,
    failed: ids.length - embedded,
    last_id: lastId,
    has_more: hasMore,
    elapsed_ms: Date.now() - startedAt,
  });
});

// ============================================================================
// Email Notification Preferences
// ============================================================================

const emailPreferencesSchema = z.object({
  user_approval: z.boolean().optional(),
  publication_request: z.boolean().optional(),
  announcements: z.boolean().optional(),
});

/**
 * Resolve whose email preferences a request targets. With no `?user=`, it's the
 * caller (any admin manages their own). With `?user=<username>` it's that user --
 * but only an OWNER may manage someone else's (admins manage only themselves).
 * Pure resolution + a typed error result so the two handlers stay DRY.
 */
export async function resolveEmailPrefsTarget(
  db: D1Database,
  requester: { id: number; username: string; role: string | null },
  requested: string | undefined,
): Promise<{ id: number; username: string } | { error: string; status: 403 | 404 }> {
  if (!requested || requested === requester.username) {
    return { id: requester.id, username: requester.username };
  }
  if (requester.role !== "owner") {
    return { error: "Only owners can manage other users' email preferences", status: 403 };
  }
  const target = await db
    .prepare("SELECT id, username FROM users WHERE username = ? AND deleted_at IS NULL")
    .bind(requested)
    .first<{ id: number; username: string }>();
  if (!target) {
    return { error: `User not found: ${requested}`, status: 404 };
  }
  return { id: target.id, username: target.username };
}

/**
 * GET /admin/email-preferences[?user=<username>] - Get email notification
 * preferences for the caller, or (owner-only) for another user via `?user=`.
 */
adminRoutes.get("/email-preferences", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const target = await resolveEmailPrefsTarget(db, user, c.req.query("user"));
  if ("error" in target) return c.json({ error: target.error }, target.status);

  const row = await db
    .prepare("SELECT email_preferences FROM users WHERE id = ?")
    .bind(target.id)
    .first<{ email_preferences: string | null }>();

  if (!row) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json({ ...parseEmailPreferences(row.email_preferences), username: target.username });
});

/**
 * PUT /admin/email-preferences[?user=<username>] - Update email notification
 * preferences for the caller, or (owner-only) for another user via `?user=`.
 */
adminRoutes.put("/email-preferences", zValidator("json", emailPreferencesSchema), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const body = c.req.valid("json");

  const target = await resolveEmailPrefsTarget(db, user, c.req.query("user"));
  if ("error" in target) return c.json({ error: target.error }, target.status);

  // Load existing preferences
  const row = await db
    .prepare("SELECT email_preferences FROM users WHERE id = ?")
    .bind(target.id)
    .first<{ email_preferences: string | null }>();

  const current = parseEmailPreferences(row?.email_preferences ?? null);

  const updated = {
    user_approval: body.user_approval ?? current.user_approval,
    publication_request: body.publication_request ?? current.publication_request,
    announcements: body.announcements ?? current.announcements,
  };

  await db
    .prepare("UPDATE users SET email_preferences = ? WHERE id = ?")
    .bind(JSON.stringify(updated), target.id)
    .run();

  // Audit who changed whose prefs when an owner edits another user (#808 follow-up).
  if (target.id !== user.id) {
    await db
      .prepare(
        "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, 'email_preferences_updated', 'user', ?, ?)",
      )
      .bind(user.id, String(target.id), JSON.stringify({ target: target.username, updated }))
      .run();
  }

  return c.json({ ...updated, username: target.username });
});

// ============================================================================
// Notices
// ============================================================================

/**
 * GET /admin/notices - List all notices (including expired)
 */
adminRoutes.get("/notices", async (c) => {
  const db = c.env.DB;
  const notices = await listAllNotices(db);
  return c.json({ notices });
});

const createNoticeSchema = z.object({
  message: z.string().min(1).max(1000),
  level: z.enum(["info", "warning", "critical"]).default("info"),
  scope: z.enum(["all", "admins", "members"]).default("all"),
  expires_at: z.string().datetime({ offset: true }).optional(),
});

/**
 * POST /admin/notices - Create a notice
 */
adminRoutes.post("/notices", zValidator("json", createNoticeSchema), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const body = c.req.valid("json");

  const notice = await createNotice(db, body, user.id);
  return c.json(notice, 201);
});

/**
 * DELETE /admin/notices/:id - Delete a notice
 */
adminRoutes.delete("/notices/:id", async (c) => {
  const db = c.env.DB;
  const id = Number.parseInt(c.req.param("id"), 10);

  if (Number.isNaN(id)) {
    return c.json({ error: "Invalid notice ID" }, 400);
  }

  const deleted = await deleteNotice(db, id);
  if (!deleted) {
    return c.json({ error: "Notice not found" }, 404);
  }

  return c.json({ message: "Notice deleted" });
});

// ============================================================================
// Broadcast Emails
// ============================================================================

/**
 * POST /admin/notify - Send broadcast email to a user group or single user.
 *
 * Group send: { to: 'all'|'admins'|'members', ... }
 * Per-user send: { user: '<username>', ... }
 *
 * 'to' and 'user' are mutually exclusive. Per-user sends ignore the
 * announcements email preference (these are direct admin transactional
 * messages, not broadcasts) but still require an approved account with an
 * email on file. Audit log records the recipient as `user:<username>` so the
 * group/transactional distinction is queryable post-hoc.
 */
adminRoutes.post("/notify", zValidator("json", broadcastRequestSchema), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const body = c.req.valid("json");

  // Per-user transactional path
  if (body.user) {
    const lookup = await getBroadcastRecipientByUsername(db, body.user);
    if (!lookup.ok) {
      switch (lookup.error) {
        case "not_found":
          return c.json({ error: `User not found: ${body.user}` }, 404);
        case "not_approved":
          return c.json({ error: `User '${body.user}' is not approved` }, 400);
        case "no_email":
          return c.json({ error: `User '${body.user}' has no email on file` }, 400);
        default: {
          const _exhaustive: never = lookup.error;
          return c.json({ error: `Cannot send to '${body.user}': ${_exhaustive}` }, 400);
        }
      }
    }

    const auditGroup: RecipientGroupOrUser = `user:${lookup.username}`;

    if (body.dry_run) {
      return c.json({
        dry_run: true,
        recipient_group: auditGroup,
        recipient_count: 1,
        recipients: [lookup.email],
      });
    }

    const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
    const result = await sendBroadcast(
      db,
      c.env.RESEND_API_KEY,
      fromEmail,
      {
        sentById: user.id,
        group: auditGroup,
        subject: body.subject,
        bodyMarkdown: body.body,
        recipients: [lookup.email],
      },
      replyTo,
      isDev,
    );

    if (result.error === "email_service_unconfigured") {
      return c.json({ error: "email_service_unconfigured" }, 500);
    }
    return c.json(result);
  }

  // Group broadcast path (existing behavior)
  const group = body.to as RecipientGroup;
  const recipients = await getBroadcastRecipients(db, group);

  if (recipients.length === 0) {
    return c.json({ error: "No recipients match the selected group" }, 404);
  }

  if (body.dry_run) {
    return c.json({
      dry_run: true,
      recipient_group: group,
      recipient_count: recipients.length,
      recipients,
    });
  }

  const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
  const result = await sendBroadcast(
    db,
    c.env.RESEND_API_KEY,
    fromEmail,
    {
      sentById: user.id,
      group,
      subject: body.subject,
      bodyMarkdown: body.body,
      recipients,
    },
    replyTo,
    isDev,
  );

  if (result.error === "email_service_unconfigured") {
    return c.json({ error: "email_service_unconfigured" }, 500);
  }
  return c.json(result);
});

// ---------------------------------------------------------------------------
// Test-only fixtures
// ---------------------------------------------------------------------------

const seedWebUserSchema = z.object({
  email: z
    .string()
    .email()
    .max(320)
    .transform((e) => e.trim().toLowerCase()),
  // Optional. Defaults to 'pending' to mirror what the legacy
  // INSERT-OR-IGNORE produced. The cookie-auth tests (#572) seed
  // directly as 'approved' because the cookie path in authMiddleware
  // gates on status='approved'.
  status: z.enum(["pending", "verified", "approved", "revoked"]).optional(),
});

/**
 * POST /admin/test-fixtures/seed-web-user
 *
 * Inserts a minimal users row (`signup_source='web'`, default
 * `status='pending'`) for the passwordless email-code flow tests.
 * Exists because #595 made `/auth/code/request` a no-op for
 * unregistered emails; the live-API test suite for #569 now needs to
 * pre-seed a row before each happy-path case instead of relying on the
 * old INSERT-OR-IGNORE behaviour. The optional `status` field also lets
 * the #572 cookie-auth tests bypass the admin-approval ceremony for a
 * synthetic web-only account.
 *
 * Guarded two ways:
 *   1. ENVIRONMENT must NOT be 'production'. The dev and SCCN-dev
 *      Workers leave this on; api.nemar.org would 403.
 *   2. The route inherits `adminMiddleware`, so only admin/owner tokens
 *      can call it even in dev.
 *
 * Returns `{ user: { id, email, status } }`. Idempotent: a subsequent
 * call for the same email returns the existing row's id and updates
 * the status if requested, instead of 409'ing — saves test teardown.
 */
adminRoutes.post(
  "/test-fixtures/seed-web-user",
  zValidator("json", seedWebUserSchema),
  async (c) => {
    if (c.env.ENVIRONMENT === "production") {
      return c.json({ error: "Not available in production" }, 403);
    }
    const { email, status } = c.req.valid("json");
    const desiredStatus = status ?? "pending";
    const db = c.env.DB;

    try {
      await db
        .prepare("INSERT OR IGNORE INTO users (email, status, signup_source) VALUES (?, ?, 'web')")
        .bind(email, desiredStatus)
        .run();

      // If the caller asked for a specific status and the row pre-existed
      // with a different value, bring it in line so the fixture is
      // deterministic across reruns. Idempotent for the common case
      // where the row already has the desired status.
      if (status) {
        const upd = await db
          .prepare("UPDATE users SET status = ? WHERE email = ?")
          .bind(desiredStatus, email)
          .run();
        // Defend against a silent status mismatch: if the UPDATE matched
        // 0 rows (e.g., the email normalised differently between the
        // INSERT and UPDATE), the caller would silently get back a row
        // with the pre-existing status and the dependent tests would
        // 401 with a confusing "user is pending" failure mode rather
        // than a clear seed error. Surface it loudly here.
        if ((upd.meta?.changes ?? 0) === 0) {
          console.error("[seed-web-user] UPDATE matched 0 rows for email", email);
          return c.json({ error: "Failed to set requested status; row missing post-insert" }, 500);
        }
      }

      const row = await db
        .prepare("SELECT id, email, status FROM users WHERE email = ? LIMIT 1")
        .bind(email)
        .first<{ id: number; email: string; status: string }>();
      if (!row) {
        // Insert failed and no pre-existing row — schema or constraint issue.
        return c.json({ error: "Failed to seed user" }, 500);
      }
      return c.json({ user: row });
    } catch (err) {
      console.error("[seed-web-user] D1 error", err);
      return c.json({ error: "Failed to seed user" }, 500);
    }
  },
);

/**
 * GET /admin/summary/coverage
 *
 * Reports which published (dataset_id, version) pairs have summary.json
 * at the current target schema (1.1) vs which are stale or missing.
 * Powers `nemar admin summary check` and the weekly drift cron.
 *
 * Read-only: walks the version table and probes data.nemar.org for the
 * schema string. Bounded parallelism keeps us within data.nemar.org's
 * rate limit. No GitHub API calls.
 *
 * Epic #618 / phase 2 (#620).
 */
adminRoutes.get("/summary/coverage", async (c) => {
  try {
    const report = await buildCoverageReport(c.env);
    // no-store on every response: the weekly drift cron and on-demand
    // operator CLI both pull this through the same Cloudflare edge POP that
    // would otherwise apply heuristic TTL to a 200. A cached coverage report
    // can silently mask a real drift week (cron sees yesterday's "all green"
    // when probes failed for half the catalog). Phase 3's page-bundle is
    // meticulous about no-store on partial failure; the coverage endpoint
    // — which feeds page-bundle's repair loop — must match that discipline.
    c.header("Cache-Control", "no-store, must-revalidate");
    return c.json(report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[summary/coverage] failed:", msg);
    return c.json({ error: `Failed to build coverage report: ${msg}` }, 500);
  }
});

const dispatchManifestSchema = z.object({
  dataset_id: z.string().min(1),
  version: z.string().min(1),
  skip_canary: z.boolean().optional(),
});

/**
 * POST /admin/manifest/dispatch
 *
 * Fires `repository_dispatch[generate-manifest]` at `nemarDatasets/.github`
 * for a specific (dataset_id, version) pair WITHOUT seeding a manifest_jobs
 * row. The workflow runs with `skip_callback: true` so it just regenerates
 * manifest.json + summary.json on S3 without trying to phone back to a
 * non-existent in-flight job.
 *
 * Use case: backfill stale summary.json schema versions, or manually
 * re-run after a generator change. Looks up `doi` + `concept_doi` from
 * D1 so the caller only needs (dataset_id, version).
 *
 * Epic #618 / phase 2 (#620). Sibling: `triggerManifestGeneration` in
 * webhooks.ts handles the live-publish path with the full HMAC handshake.
 */
adminRoutes.post("/manifest/dispatch", zValidator("json", dispatchManifestSchema), async (c) => {
  const { dataset_id, version, skip_canary } = c.req.valid("json");

  const row = await c.env.DB.prepare(
    `SELECT v.doi, d.concept_doi
         FROM dataset_versions v
         JOIN datasets d ON d.dataset_id = v.dataset_id
         WHERE v.dataset_id = ? AND v.version = ?
         LIMIT 1`,
  )
    .bind(dataset_id, version)
    .first<{ doi: string; concept_doi: string | null }>();

  if (!row) {
    return c.json({ error: `No published version row for ${dataset_id}@${version}` }, 404);
  }

  // Token fetch is intentionally OUTSIDE the try/catch below so a programming
  // error here (e.g. renamed env var, App-auth failure) surfaces as 500 with
  // its real message instead of being collapsed into a 502 "Dispatch failed"
  // that points the operator at GitHub instead of at our config.
  const pat = await getDatasetsToken(c.env);

  // Hard invariant pinning the security note: callback_token / callback_url
  // are safe to leave empty ONLY when skip_callback is true (the workflow
  // won't validate the token, so a real secret would just leak into runner
  // logs). If a future refactor flips skipCallback to false here the
  // assertion fires loudly instead of silently dispatching with empty
  // credentials. Mirrors the comment on `triggerManifestGeneration`'s
  // `skipCallback` option in services/github.ts.
  const skipCallback = true;
  const callbackToken = "";
  const callbackUrl = "";
  if (!skipCallback && (callbackToken === "" || callbackUrl === "")) {
    throw new Error("internal: empty callback_token/callback_url requires skipCallback=true");
  }

  try {
    await triggerManifestGeneration(
      dataset_id,
      version,
      row.doi,
      row.concept_doi,
      callbackToken,
      callbackUrl,
      pat,
      { skipCanary: skip_canary ?? false, skipCallback },
    );
    return c.json({ dispatched: true, dataset_id, version });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[manifest/dispatch] failed dataset=${dataset_id} version=${version}:`, msg);
    return c.json({ error: `Dispatch failed: ${msg}` }, 502);
  }
});
