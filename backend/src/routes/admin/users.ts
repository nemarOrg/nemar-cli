/**
 * Admin routes: user accounts (list/approve/revoke/role/delete), IAM
 * regeneration, system stats, audit-log view, email notification
 * preferences, broadcast email, and the web-user test fixture.
 *
 * Moved verbatim from routes/admin.ts in #903 (epic #902); the only
 * intentional changes are import paths, `adminRoutes` -> `admin`, and
 * audit-log INSERTs routed through auditLogStatement().
 */

import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { z } from "zod";
import { orcidIdSchema } from "../../../../shared/contract/publication.js";
import { ownerMiddleware } from "../../middleware/auth";

import { auditLogStatement } from "../../db/audit-log";
import { tombstoneUserStatement } from "../../db/user-tombstone";
import { SYSTEM_USER_ID } from "../../lib/constants";
import {
  type RecipientGroup,
  type RecipientGroupOrUser,
  broadcastRequestSchema,
  getBroadcastRecipientByUsername,
  getBroadcastRecipients,
  sendBroadcast,
} from "../../services/broadcast";
import {
  parseEmailPreferences,
  resolveEmailConfig,
  sendKeyReadyEmail,
  sendRevocationEmail,
  sendWebApprovalEmail,
} from "../../services/email";
import { decrypt } from "../../services/encryption";
import { isNonProductionEnv } from "../../services/environment";
import { removeCollaborator } from "../../services/github";
import { getDatasetsToken } from "../../services/github-auth";
import { revokeUserIamAccess } from "../../services/iam";
import { errorMessage } from "../../services/repo-metadata";
import { type Bindings, type Variables, isDemotion, parseRole } from "../../types/bindings";
import type { AdminRouter } from "./shared";

/** Row shape shared by both approve routes (username-keyed and id-keyed). */
interface ApprovableUserRow {
  id: number;
  username: string | null;
  email: string;
  status: string;
  signup_source: string | null;
  orcid_verified: number;
  service_access: number;
}

const APPROVABLE_USER_COLUMNS =
  "id, username, email, status, signup_source, orcid_verified, service_access";

/**
 * Approval eligibility (#1012). `verified` and `revoked` are approvable as
 * before. `pending` is additionally approvable for ORCID-verified web
 * signups: ORCID is the identity proof there (email is collected, not
 * verified, by design) and admin review is the gate. CLI signups stay
 * blocked at `pending` until they verify their email — there is no ORCID
 * proof backing those rows.
 */
function isApprovable(user: ApprovableUserRow): boolean {
  if (user.status === "verified" || user.status === "revoked") return true;
  return user.status === "pending" && user.signup_source === "web" && user.orcid_verified === 1;
}

/** The 400 body both approve routes return for an ineligible status. */
function ineligibilityMessage(user: ApprovableUserRow): string {
  if (user.status !== "pending") return "User status is not eligible for approval";
  return user.signup_source === "web"
    ? "Web signup is not ORCID-verified; not eligible for approval"
    : "User needs to verify their email first";
}

/**
 * The upload grant, on its own, for an account that is already `approved` but
 * carries no `service_access` (ADR 0040). Migration 0075 removed that
 * combination from the catalog, and the approve routes below are the only
 * thing that can create it again, so reaching this is a repair, not a normal
 * path — but a 409 here would leave an admin with no way to fix a row whose
 * status says "approved" while the upload gate says no.
 */
async function regrantUploadAccess(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  user: ApprovableUserRow,
): Promise<Response> {
  const db = c.env.DB;
  const adminUser = c.get("user");

  // Grant + audit in one db.batch(): D1 wraps a batch in a single implicit
  // transaction (same reasoning as the tombstone batch further down), so the
  // repair cannot commit without its audit row. Unbatched, a throwing audit
  // insert would 500 an admin whose grant HAD landed, and the retry would then
  // 409 "already approved" — a dead end for an operation that succeeded.
  // Nothing here talks to the network, so there is no ordering constraint
  // forcing the two apart, unlike finalizeApproval's email step.
  try {
    await db.batch([
      db
        .prepare(
          `
    UPDATE users
    SET service_access = 1,
        service_access_granted_at = datetime('now'),
        service_access_granted_by = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `,
        )
        .bind(adminUser.id, user.id),
      auditLogStatement(db, {
        userId: adminUser.id,
        action: "user_upload_access_granted",
        resourceType: "user",
        resourceId: user.username ?? String(user.id),
        details: JSON.stringify({
          granted_by: adminUser.username,
          granted_by_id: adminUser.id,
          repair: "status was already approved with service_access=0",
        }),
      }),
    ]);
  } catch (error) {
    // The batch rolled back atomically, so nothing was granted: report the
    // failure rather than a success the caller cannot verify. Retrying is safe
    // (the row is still approved-without-grant, so it lands here again).
    console.error(`[approve] upload-access repair batch failed for id=${user.id}:`, error);
    return c.json(
      {
        error: "Upload access was NOT granted; the grant transaction failed. Retry.",
        detail: errorMessage(error),
      },
      500,
    );
  }

  const label = user.username ?? `id ${user.id}`;
  return c.json({
    message: `User ${label} already had status 'approved'; upload access granted`,
    note: "Only the upload grant was written — the account was already approved, so no status change or approval email was needed.",
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      status: "approved",
      service_access: true,
    },
    email_sent: false,
  });
}

/**
 * Shared approval finalizer for POST /admin/approve/:username and
 * POST /admin/approve/by-id/:id (#1012): status flip, upload grant,
 * notification email, audit row, response. Callers have already 404'd on a
 * missing row, 409'd on an `approved` row that already holds the grant, and
 * 400'd on ineligible statuses.
 *
 * The status flip and `service_access` move together (ADR 0040): approval IS
 * the upload decision, and this is the single writer of `service_access = 1`.
 * Splitting them is what #1249 was — an admin approving a user who then could
 * not upload.
 *
 * Web/ORCID accounts have `username = NULL`, so anything username-shaped is
 * conditional: they get a dashboard-flavored approval email instead of the
 * CLI retrieve-key one, and the audit resource id falls back to the stable
 * numeric id. Nothing GitHub- or IAM-side happens for either kind of
 * account — approval has been a pure status transition since per-user IAM
 * and auto-collaborator adds were removed.
 */
async function finalizeApproval(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  user: ApprovableUserRow,
): Promise<Response> {
  const db = c.env.DB;
  const adminUser = c.get("user");

  await db
    .prepare(
      `
    UPDATE users
    SET status = 'approved',
        approved_at = datetime('now'),
        service_access = 1,
        service_access_granted_at = datetime('now'),
        service_access_granted_by = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `,
    )
    .bind(adminUser.id, user.id)
    .run();

  // Note: API token is NOT created here. CLI users retrieve it via
  // `nemar auth retrieve-key`, which generates the token on first call;
  // web users sign in with an email code and never hold an API key.

  // Send approval notification email. Skipped (not failed) when the email
  // service is unconfigured, so approval still completes in dev/test.
  let emailSent = false;
  try {
    if (c.env.RESEND_API_KEY) {
      const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
      if (user.username) {
        await sendKeyReadyEmail(
          user.email,
          user.username,
          c.env.RESEND_API_KEY,
          fromEmail,
          replyTo,
          isDev,
          c.env,
        );
      } else {
        await sendWebApprovalEmail(
          user.email,
          c.env.RESEND_API_KEY,
          fromEmail,
          replyTo,
          isDev,
          c.env,
        );
      }
      emailSent = true;
    } else {
      console.error(`RESEND_API_KEY unset; approval email not sent for user id=${user.id}`);
    }
  } catch (error) {
    console.error("Failed to send approval email:", error);
  }

  // Audit log. resource_id is the username where one exists (unchanged for
  // CLI accounts) and the stable numeric id otherwise (web/ORCID accounts).
  //
  // NOT batched with the UPDATE above, unlike regrantUploadAccess: `email_sent`
  // is only known after the notification attempt, and that attempt must follow
  // the commit (never tell a user they are approved before the row says so).
  // So this is the role-change route's shape instead — a failed audit write is
  // logged, never propagated. The approval and its grant have already
  // committed, and 500ing here would tell the admin their completed action
  // failed and send them into a retry that now 409s.
  try {
    await auditLogStatement(db, {
      userId: adminUser.id,
      action: "user_approved",
      resourceType: "user",
      resourceId: user.username ?? String(user.id),
      details: JSON.stringify({
        approved_by: adminUser.username,
        email_sent: emailSent,
        // ADR 0040: the grant is part of the approval, so the audit row says so
        // rather than leaving upload access to be inferred from the status.
        service_access_granted: true,
      }),
    }).run();
  } catch (error) {
    console.error(
      `AUDIT GAP: user_approved row not written for id=${user.id} (approval and upload grant DID commit):`,
      error,
    );
  }

  const label = user.username ?? `id ${user.id}`;
  return c.json({
    message: `User ${label} has been approved`,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      status: "approved",
      service_access: true,
    },
    email_sent: emailSent,
  });
}

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

export function registerUsersRoutes(admin: AdminRouter): void {
  /**
   * GET /admin/users - List users with optional status filter
   */
  admin.get("/users", async (c) => {
    const status = c.req.query("status"); // pending, verified, approved, revoked
    const role = c.req.query("role"); // owner, admin, member
    const db = c.env.DB;

    // service_access is what separates an uploader from a browse-only account
    // now that they no longer track `status` one-for-one (ADR 0040); the
    // identity columns are here because a web/ORCID row has username = NULL
    // and is otherwise unidentifiable in the listing (#1251).
    let query = `
    SELECT
      id, username, email, github_username, status,
      email_verified, role, created_at, approved_at, revoked_at,
      signup_source, service_access, service_access_granted_at,
      given_name, family_name, orcid
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
  admin.get("/users/:username", async (c) => {
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
  admin.post(
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
        await auditLogStatement(db, {
          userId: requestingUser.id,
          action: "role_changed",
          resourceType: "user",
          resourceId: username,
          details: JSON.stringify({
            changed_by: requestingUser.username,
            old_role: oldRole,
            new_role: newRole,
            tokens_revoked: tokensRevoked,
            token_revocation_failed: tokenRevocationFailed,
          }),
        }).run();
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
   *
   * Only reaches accounts that have a username, i.e. CLI signups. Web/ORCID
   * signups have username = NULL (migration 0026) and are approved via
   * POST /admin/approve/by-id/:id below (#1012).
   */
  admin.post("/approve/:username", async (c) => {
    const username = c.req.param("username");
    const db = c.env.DB;

    // Find user
    const user = await db
      .prepare(
        `SELECT ${APPROVABLE_USER_COLUMNS} FROM users WHERE username = ? AND deleted_at IS NULL`,
      )
      .bind(username)
      .first<ApprovableUserRow>();

    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    if (user.status === "approved") {
      // An approved row that never got the grant is the #1249 shape; repair it
      // instead of 409ing an admin into a dead end (ADR 0040).
      if (!user.service_access) return regrantUploadAccess(c, user);
      return c.json({ error: "User already approved" }, 409);
    }

    if (!isApprovable(user)) {
      return c.json(
        {
          error: "User is not eligible for approval",
          status: user.status,
          message: ineligibilityMessage(user),
        },
        400,
      );
    }

    // Note: Per-user IAM credentials are no longer created. S3 access is now
    // managed through backend-scoped credentials (presigned URLs and STS tokens).
    // The D1 user_s3_permissions table is the sole authorization source.

    return finalizeApproval(c, user);
  });

  /**
   * POST /admin/approve/by-id/:id - Approve a user by their stable numeric id.
   *
   * Exists because web/ORCID signups have username = NULL by design
   * (migration 0026), so the username-keyed route above can never address
   * them (#1012). Mirrors DELETE /admin/users/by-id/:id, which is id-keyed
   * for the same reason. Works for any account kind — a CLI user can be
   * approved by id too — with identical status gating: `verified` and
   * `revoked` always, plus `pending` for ORCID-verified web signups (ORCID
   * is the identity proof; the collected email is deliberately unverified).
   *
   * Most ORCID signups never need this: they auto-approve to base access on
   * sign-up (migration 0062, epic #1013). This route covers the rows that
   * don't — re-approving a revoked web account, and any web row that landed
   * `pending` outside the auto-approve path.
   */
  admin.post("/approve/by-id/:id", async (c) => {
    const db = c.env.DB;

    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isInteger(id) || id <= 0 || id === SYSTEM_USER_ID) {
      return c.json({ error: "Invalid user id" }, 400);
    }

    const user = await db
      .prepare(`SELECT ${APPROVABLE_USER_COLUMNS} FROM users WHERE id = ? AND deleted_at IS NULL`)
      .bind(id)
      .first<ApprovableUserRow>();

    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    if (user.status === "approved") {
      // Same repair path as the username route above (ADR 0040).
      if (!user.service_access) return regrantUploadAccess(c, user);
      return c.json({ error: "User already approved" }, 409);
    }

    if (!isApprovable(user)) {
      return c.json(
        {
          error: "User is not eligible for approval",
          status: user.status,
          message: ineligibilityMessage(user),
        },
        400,
      );
    }

    return finalizeApproval(c, user);
  });

  /**
   * POST /admin/revoke/:username - Revoke a user's access
   */
  admin.post("/revoke/:username", async (c) => {
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

    // service_access (migration 0062) gates real (non-sandbox) uploads and
    // compute independently of `status` -- clearing it here closes issue
    // #1069 (a revoked user kept the grant and could still pass
    // realDatasetServiceGate if `status` were ever restored without an
    // explicit re-grant). The two grant stamps go with it (ADR 0040): revoke
    // is the eraser of what approval wrote, so a later listing cannot show a
    // revoked account still carrying "granted by X on Y".
    await db
      .prepare(
        `
    UPDATE users
    SET status = ?,
        service_access = 0,
        service_access_granted_at = NULL,
        service_access_granted_by = NULL,
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
        c.env,
      );
      emailSent = true;
    } catch (error) {
      console.error("Failed to send revocation email:", error);
    }

    // Clear S3 permissions
    await db.prepare("DELETE FROM user_s3_permissions WHERE user_id = ?").bind(user.id).run();

    // Audit log (non-blocking). By this point tokens, IAM credentials, GitHub
    // collaborations, S3 permissions, `status` and `service_access` have all
    // already been changed and cannot be rolled back — a throwing audit insert
    // must not turn that completed revocation into a 500 that reads as "the
    // user still has access". Log the gap loudly instead: an unaudited
    // revocation is a record-keeping problem, a falsely-reported one is a
    // security problem.
    try {
      await auditLogStatement(db, {
        userId: adminUser.id,
        action: "user_revoked",
        resourceType: "user",
        resourceId: user.username,
        details: JSON.stringify({
          revoked_by: adminUser.username,
          repos_removed: reposRemoved,
          failed_removals: failedRemovals,
          email_sent: emailSent,
          iam_revoked: iamRevoked,
          // Mirrors the approval audit row: upload access is a thing that was
          // taken away here, not something to infer from the status (ADR 0040).
          service_access_cleared: true,
        }),
      }).run();
    } catch (error) {
      console.error(
        `AUDIT GAP: user_revoked row not written for ${user.username} (the revocation DID complete):`,
        error,
      );
    }

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
  admin.delete("/users/by-id/:id", ownerMiddleware, async (c) => {
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
          const accessKeyId = await decrypt(
            target.aws_access_key_id_encrypted,
            c.env.ENCRYPTION_KEY,
          );
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
          error:
            "Tombstone transaction failed; user was NOT deleted. Retry or contact an operator.",
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
      await auditLogStatement(db, {
        userId: adminUser.id,
        action: "user_deleted",
        resourceType: "user",
        resourceId: String(id),
        details: JSON.stringify({
          // Non-PII actor id (the row's user_id is the same); avoids retaining the
          // admin's username if they are themselves tombstoned later.
          deleted_by_id: adminUser.id,
          tokens_revoked: tokensRevoked,
          sessions_revoked: sessionsRevoked,
          repos_removed: reposRemoved,
          masked: true,
        }),
      }).run();
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
  admin.post("/regenerate-iam/:username", async (c) => {
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
  admin.get("/stats", async (c) => {
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
   * GET /admin/audit - Get audit log
   */
  admin.get("/audit", async (c) => {
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
  // Email Notification Preferences
  // ============================================================================

  const emailPreferencesSchema = z.object({
    user_approval: z.boolean().optional(),
    publication_request: z.boolean().optional(),
    announcements: z.boolean().optional(),
  });

  /**
   * GET /admin/email-preferences[?user=<username>] - Get email notification
   * preferences for the caller, or (owner-only) for another user via `?user=`.
   */
  admin.get("/email-preferences", async (c) => {
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
  admin.put("/email-preferences", zValidator("json", emailPreferencesSchema), async (c) => {
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
      await auditLogStatement(db, {
        userId: user.id,
        action: "email_preferences_updated",
        resourceType: "user",
        resourceId: String(target.id),
        details: JSON.stringify({ target: target.username, updated }),
      }).run();
    }

    return c.json({ ...updated, username: target.username });
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
  admin.post("/notify", zValidator("json", broadcastRequestSchema), async (c) => {
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
        c.env,
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
      c.env,
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
    // Optional profile columns (#910) so the passwordless suite can
    // assert a populated /auth/me payload, not just the all-null
    // default. Applied via UPDATE after the insert, so they also stick
    // on a pre-existing fixture row.
    profile: z
      .object({
        given_name: z.string().max(200).optional(),
        family_name: z.string().max(200).optional(),
        // Shared iD validator, not a bare length check: `max(19)` accepted
        // any 19-character string as an ORCID, which is how a fixture row
        // could carry an iD the rest of the system would never accept.
        orcid: orcidIdSchema.optional(),
        orcid_verified: z.boolean().optional(),
        github_username: z.string().max(39).optional(),
        city: z.string().max(200).optional(),
        country: z.string().max(200).optional(),
        affiliation: z.string().max(300).optional(),
      })
      .optional(),
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
   *   1. Must be a non-production Worker. `isNonProductionEnv` is fail-closed
   *      (an unset/typo'd ENVIRONMENT is treated as production), so
   *      api.nemar.org 403s even if the binding is missing.
   *   2. The route inherits `adminMiddleware`, so only admin/owner tokens
   *      can call it even in dev.
   *
   * Returns `{ user: { id, email, status } }`. Idempotent: a subsequent
   * call for the same email returns the existing row's id and updates
   * the status if requested, instead of 409'ing — saves test teardown.
   */
  admin.post("/test-fixtures/seed-web-user", zValidator("json", seedWebUserSchema), async (c) => {
    if (!isNonProductionEnv(c.env)) {
      return c.json({ error: "Not available in production" }, 403);
    }
    const { email, status, profile } = c.req.valid("json");
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

      // Profile columns (#910): applied as a separate UPDATE so they land
      // whether the row was just inserted or pre-existed. Only the keys
      // the caller sent are written; omitted keys keep their value.
      if (profile) {
        const sets: string[] = [];
        const binds: (string | number)[] = [];
        for (const key of [
          "given_name",
          "family_name",
          "orcid",
          "github_username",
          "city",
          "country",
          "affiliation",
        ] as const) {
          const v = profile[key];
          if (typeof v === "string") {
            sets.push(`${key} = ?`);
            binds.push(v);
          }
        }
        if (typeof profile.orcid_verified === "boolean") {
          sets.push("orcid_verified = ?");
          binds.push(profile.orcid_verified ? 1 : 0);
        }
        if (sets.length > 0) {
          const upd = await db
            .prepare(`UPDATE users SET ${sets.join(", ")} WHERE email = ?`)
            .bind(...binds, email)
            .run();
          if ((upd.meta?.changes ?? 0) === 0) {
            console.error("[seed-web-user] profile UPDATE matched 0 rows for email", email);
            return c.json({ error: "Failed to set profile; row missing post-insert" }, 500);
          }
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
  });
}
