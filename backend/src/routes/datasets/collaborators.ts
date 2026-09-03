/**
 * Collaborator and access-request management: request/approve/deny access,
 * invites, and collaborator listing/removal.
 *
 * Moved verbatim from routes/datasets.ts (#906, epic #902); the only
 * intentional changes are import paths, the register-function wrapper, and
 * reattaching grantCollaborator's doc block (it sat stranded above
 * isDatasetCollaborator in the monolith).
 */

import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { resolveEmailConfig, sendAccessRequestEmail } from "../../services/email";
import { addCollaborator, removeCollaborator } from "../../services/github";
import { getDatasetsToken } from "../../services/github-auth";
import { type Bindings, type Variables, hasRole } from "../../types/bindings";
import { extractRepoName } from "./shared";
import type { DatasetsRouter } from "./shared";

type GrantResult = { ok: true } | { ok: false; stage: "github" | "db" | "s3"; error: unknown };

/**
 * Grant a user collaborator (push) access to a dataset repo, shared by the
 * `invite` and access-request `approve` flows.
 *
 * Order matters and differs from the old inline code: the GitHub grant happens
 * first, then the `dataset_collaborators` row is written **before** the S3
 * permission and is treated as FATAL. That row is the index used to later
 * remove the collaborator (on revoke / make-private reconcile); writing S3
 * access without it would leave an unremovable grant. Both DB writes are
 * idempotent (INSERT OR IGNORE) so re-approving is safe.
 */

async function grantCollaborator(
  env: Bindings,
  db: D1Database,
  opts: {
    repoName: string;
    datasetPk: number;
    datasetId: string;
    granteeUserId: number;
    granteeGithubUsername: string;
    grantedBy: number;
    accessType: "requested" | "invited";
  },
): Promise<GrantResult> {
  try {
    await addCollaborator(
      opts.repoName,
      opts.granteeGithubUsername,
      "push",
      await getDatasetsToken(env),
    );
  } catch (error) {
    console.error("Failed to add collaborator on GitHub:", error);
    return { ok: false, stage: "github", error };
  }

  // dataset_collaborators FIRST and FATAL: it is the removal index.
  try {
    await db
      .prepare(
        "INSERT OR IGNORE INTO dataset_collaborators (dataset_id, user_id, granted_by, access_type) VALUES (?, ?, ?, ?)",
      )
      .bind(opts.datasetPk, opts.granteeUserId, opts.grantedBy, opts.accessType)
      .run();
  } catch (error) {
    console.error(
      "CRITICAL: Failed to record collaborator for",
      opts.datasetId,
      opts.granteeGithubUsername,
      "(GitHub access already granted; retry is idempotent):",
      error,
    );
    return { ok: false, stage: "db", error };
  }

  // S3 permission: sole authorization source for uploads.
  try {
    await db
      .prepare(
        "INSERT OR IGNORE INTO user_s3_permissions (user_id, s3_prefix, permission, granted_by) VALUES (?, ?, 'read_write', ?)",
      )
      .bind(opts.granteeUserId, opts.datasetId, opts.grantedBy)
      .run();
  } catch (error) {
    console.error(
      "CRITICAL: Failed to grant S3 permission for",
      opts.datasetId,
      opts.granteeGithubUsername,
      "(GitHub + collaborator row exist; retry is idempotent):",
      error,
    );
    return { ok: false, stage: "s3", error };
  }

  // Resolve any pending access request for this user, so the owner's queue does
  // not keep showing a request that was satisfied via invite or approve.
  // Best-effort: the grant itself already succeeded.
  try {
    await db
      .prepare(
        "UPDATE access_requests SET status = 'approved', decided_at = CURRENT_TIMESTAMP, decided_by = ? WHERE dataset_id = ? AND user_id = ? AND status = 'pending'",
      )
      .bind(opts.grantedBy, opts.datasetPk, opts.granteeUserId)
      .run();
  } catch (error) {
    console.error(
      "Failed to resolve pending access request for",
      opts.datasetId,
      opts.granteeGithubUsername,
      error,
    );
  }

  // Audit log (non-fatal).
  try {
    await db
      .prepare(
        "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, 'dataset_access_granted', 'dataset', ?, ?)",
      )
      .bind(
        opts.grantedBy,
        opts.datasetId,
        JSON.stringify({ grantee_user_id: opts.granteeUserId, access_type: opts.accessType }),
      )
      .run();
  } catch (error) {
    console.error("Failed to write audit log:", error);
  }

  return { ok: true };
}

/**
 * POST /datasets/:id/invite - Invite a user as collaborator (owner/admin only)
 *
 * Works for both public and private repos.
 */
// Invite by username (CLI) or email (dashboard, #578), mutually exclusive.
// Exported for unit testing the mutual-exclusion contract.
export const inviteSchema = z
  .object({
    username: z.string().min(1).optional(),
    email: z.string().email().optional(),
  })
  .refine((d) => (d.username ? 1 : 0) + (d.email ? 1 : 0) === 1, {
    message: "Provide exactly one of 'username' or 'email'",
  });

/**
 * Shared owner/admin guard + dataset/requester/pending-request resolution for
 * the approve and deny endpoints. Returns a typed error response or the
 * resolved rows.
 */
async function resolveAccessRequest(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
): Promise<
  | { error: Response }
  | {
      dataset: { id: number; dataset_id: string; name: string; github_repo: string | null };
      requester: { id: number; username: string; github_username: string | null; status: string };
    }
> {
  const datasetId = c.req.param("id");
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const db = c.env.DB;

  const dataset = await db
    .prepare(
      "SELECT id, dataset_id, name, github_repo, owner_user_id FROM datasets WHERE dataset_id = ?",
    )
    .bind(datasetId)
    .first<{
      id: number;
      dataset_id: string;
      name: string;
      github_repo: string | null;
      owner_user_id: number;
    }>();

  if (!dataset) {
    return { error: c.json({ error: "Dataset not found" }, 404) };
  }

  if (dataset.owner_user_id !== currentUser.id && !hasRole(currentUser.role, "admin")) {
    return {
      error: c.json({ error: "Only dataset owner or admin can decide access requests" }, 403),
    };
  }

  const requester = await db
    .prepare(
      "SELECT id, username, github_username, status FROM users WHERE username = ? AND deleted_at IS NULL",
    )
    .bind(username)
    .first<{ id: number; username: string; github_username: string | null; status: string }>();

  if (!requester) {
    return { error: c.json({ error: `User '${username}' not found` }, 404) };
  }

  const reqRow = await db
    .prepare("SELECT status FROM access_requests WHERE dataset_id = ? AND user_id = ?")
    .bind(dataset.id, requester.id)
    .first<{ status: string }>();

  if (!reqRow || reqRow.status !== "pending") {
    return { error: c.json({ error: `No pending access request from '${username}'` }, 404) };
  }

  return { dataset, requester };
}

export function registerCollaboratorRoutes(datasetRoutes: DatasetsRouter): void {
  /**
   * POST /datasets/:id/request-access - Request collaborator access to a dataset
   *
   * Publish-gated (epic #713):
   *  - PUBLIC dataset  -> grant nothing; the data is already world-readable.
   *    Contributions go through PRs; write access is granted by the owner via
   *    `invite`. Returns { action: 'none' }.
   *  - PRIVATE dataset -> record a pending access request and notify the owner;
   *    the owner/admin approves or denies. No auto-grant. Returns
   *    { action: 'requested' }.
   */
  datasetRoutes.post("/:id/request-access", authMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const user = c.get("user");
    const db = c.env.DB;

    // Get dataset info
    const dataset = await db
      .prepare(
        "SELECT id, dataset_id, name, github_repo, owner_user_id, visibility FROM datasets WHERE dataset_id = ?",
      )
      .bind(datasetId)
      .first<{
        id: number;
        dataset_id: string;
        name: string;
        github_repo: string | null;
        owner_user_id: number;
        visibility: string;
      }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    if (!dataset.github_repo) {
      return c.json({ error: "Dataset has no GitHub repository" }, 400);
    }

    // Check if already a collaborator
    const existing = await db
      .prepare("SELECT id FROM dataset_collaborators WHERE dataset_id = ? AND user_id = ?")
      .bind(dataset.id, user.id)
      .first();

    if (existing) {
      return c.json({ error: "You already have access to this dataset" }, 409);
    }

    // Check if user is the owner
    if (dataset.owner_user_id === user.id) {
      return c.json({ error: "You are the owner of this dataset" }, 409);
    }

    // PUBLIC: nothing to grant. Public repos are world-readable; write access is
    // granted by the owner via `invite`, and metadata changes go through PRs. The
    // old behavior auto-granted push + S3 to anyone here, which was meaningless on
    // public data and the main authorization hole on private data.
    if (dataset.visibility === "public") {
      return c.json({
        action: "none",
        message: `${dataset.name} is public and already readable by anyone. To contribute, fork and open a pull request, or ask the owner to invite you for write access.`,
        dataset_id: datasetId,
        github_repo: dataset.github_repo,
      });
    }

    // If a request is already pending, do not reset created_at or re-notify the
    // owner on a repeat call; just acknowledge it.
    const priorRequest = await db
      .prepare("SELECT status FROM access_requests WHERE dataset_id = ? AND user_id = ?")
      .bind(dataset.id, user.id)
      .first<{ status: string }>();
    if (priorRequest?.status === "pending") {
      return c.json({
        action: "requested",
        message: `Your access request for ${dataset.name} is already pending the owner's review.`,
        dataset_id: datasetId,
      });
    }

    // PRIVATE (fail-closed for any non-'public' value): queue a request for the
    // owner to approve. Upsert so a re-request after a denial returns to pending.
    try {
      await db
        .prepare(
          `INSERT INTO access_requests (dataset_id, user_id, status)
           VALUES (?, ?, 'pending')
           ON CONFLICT (dataset_id, user_id)
           DO UPDATE SET status = 'pending', created_at = CURRENT_TIMESTAMP, decided_at = NULL, decided_by = NULL`,
        )
        .bind(dataset.id, user.id)
        .run();
    } catch (error) {
      console.error("Failed to record access request:", error);
      return c.json({ error: "Failed to submit access request" }, 500);
    }

    // Notify the owner (best-effort; the request is durable via the CLI either way).
    try {
      const owner = await db
        .prepare("SELECT email FROM users WHERE id = ? AND deleted_at IS NULL")
        .bind(dataset.owner_user_id)
        .first<{ email: string }>();
      if (owner?.email) {
        const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
        await sendAccessRequestEmail(
          owner.email,
          datasetId,
          dataset.name,
          user.username,
          c.env.RESEND_API_KEY,
          fromEmail,
          replyTo,
          isDev,
          c.env,
        );
      }
    } catch (emailError) {
      console.error("Failed to send access request notification:", emailError);
    }

    // Audit log (non-critical)
    try {
      await db
        .prepare(
          "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, 'dataset_access_requested', 'dataset', ?, ?)",
        )
        .bind(user.id, datasetId, JSON.stringify({ status: "pending" }))
        .run();
    } catch (logError) {
      console.error("Failed to write audit log:", logError);
    }

    return c.json({
      action: "requested",
      message: `Access request submitted for ${dataset.name}. The owner will review it.`,
      dataset_id: datasetId,
    });
  });

  datasetRoutes.post("/:id/invite", authMiddleware, zValidator("json", inviteSchema), async (c) => {
    const datasetId = c.req.param("id");
    const { username, email } = c.req.valid("json");
    const currentUser = c.get("user");
    const db = c.env.DB;

    // Get dataset info
    const dataset = await db
      .prepare(
        "SELECT id, dataset_id, name, github_repo, owner_user_id FROM datasets WHERE dataset_id = ?",
      )
      .bind(datasetId)
      .first<{
        id: number;
        dataset_id: string;
        name: string;
        github_repo: string | null;
        owner_user_id: number;
      }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    // Only owner or admin can invite
    if (dataset.owner_user_id !== currentUser.id && !hasRole(currentUser.role, "admin")) {
      return c.json({ error: "Only dataset owner or admin can invite collaborators" }, 403);
    }

    if (!dataset.github_repo) {
      return c.json({ error: "Dataset has no GitHub repository" }, 400);
    }

    // Find the user to invite, by email (#578) or username. The email path uses
    // structured error codes the dashboard maps to UX copy; the username path
    // keeps its original messages for the CLI.
    let invitee: {
      id: number;
      username: string;
      github_username: string | null;
      status: string;
    } | null;
    if (email) {
      invitee = await db
        .prepare(
          "SELECT id, username, github_username, status FROM users WHERE LOWER(email) = LOWER(?) AND deleted_at IS NULL",
        )
        .bind(email)
        .first<{ id: number; username: string; github_username: string; status: string }>();
      if (!invitee) {
        return c.json(
          {
            error: "user_not_found",
            message: "This person doesn't have a NEMAR account yet — ask them to sign up first.",
          },
          404,
        );
      }
      if (invitee.status !== "approved") {
        return c.json(
          {
            error: "user_pending_approval",
            message: "This person has a NEMAR account but is not approved yet.",
          },
          409,
        );
      }
    } else {
      invitee = await db
        .prepare(
          "SELECT id, username, github_username, status FROM users WHERE username = ? AND deleted_at IS NULL",
        )
        .bind(username)
        .first<{ id: number; username: string; github_username: string; status: string }>();
      if (!invitee) {
        return c.json({ error: `User '${username}' not found` }, 404);
      }
      if (invitee.status !== "approved") {
        return c.json({ error: `User '${username}' is not approved yet` }, 400);
      }
    }
    const inviteeLabel = invitee.username;

    // Web-only signups (migration 0026) can have a NULL github_username. Granting
    // to an empty GitHub handle would create a phantom repo collaborator that
    // can't be removed, so surface an actionable error instead of an opaque 500
    // from the GitHub grant step.
    if (!invitee.github_username) {
      return c.json(
        {
          error: "user_no_github",
          message:
            "This person has a NEMAR account but hasn't linked a GitHub account yet. Ask them to complete their profile before inviting.",
        },
        409,
      );
    }

    // Check if already a collaborator
    const existing = await db
      .prepare("SELECT id FROM dataset_collaborators WHERE dataset_id = ? AND user_id = ?")
      .bind(dataset.id, invitee.id)
      .first();

    if (existing) {
      return c.json({ error: `User '${inviteeLabel}' already has access to this dataset` }, 409);
    }

    // Check if invitee is the owner
    if (dataset.owner_user_id === invitee.id) {
      return c.json({ error: `User '${inviteeLabel}' is the owner of this dataset` }, 409);
    }

    // Extract repo name with defensive check
    const repoName = extractRepoName(dataset.github_repo);
    if (!repoName) {
      console.error(`Invalid github_repo format: ${dataset.github_repo}`);
      return c.json({ error: "Dataset has invalid GitHub repository configuration" }, 500);
    }

    // Grant push access (GitHub + dataset_collaborators + S3), shared with approve.
    const grant = await grantCollaborator(c.env, db, {
      repoName,
      datasetPk: dataset.id,
      datasetId,
      granteeUserId: invitee.id,
      granteeGithubUsername: invitee.github_username,
      grantedBy: currentUser.id,
      accessType: "invited",
    });
    if (!grant.ok) {
      if (grant.stage === "github") {
        return c.json({ error: "Failed to grant access on GitHub" }, 500);
      }
      return c.json(
        {
          error: "Failed to configure access",
          message:
            "GitHub access was granted but the access record or S3 upload permission could not be set. Contact an administrator.",
          dataset_id: datasetId,
        },
        500,
      );
    }

    return c.json({
      message: `User '${inviteeLabel}' invited to ${dataset.name}`,
      dataset_id: datasetId,
      invitee: inviteeLabel,
    });
  });

  /**
   * GET /datasets/:id/access-requests - List access requests (owner/admin only)
   *
   * Defaults to pending; pass ?status=approved|denied to see decided ones.
   */
  datasetRoutes.get("/:id/access-requests", authMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const currentUser = c.get("user");
    const db = c.env.DB;

    const dataset = await db
      .prepare("SELECT id, owner_user_id FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ id: number; owner_user_id: number }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    if (dataset.owner_user_id !== currentUser.id && !hasRole(currentUser.role, "admin")) {
      return c.json({ error: "Only dataset owner or admin can view access requests" }, 403);
    }

    const requested = c.req.query("status");
    const status =
      requested === "approved" || requested === "denied" || requested === "pending"
        ? requested
        : "pending";

    const rows = await db
      .prepare(
        `SELECT u.username, u.github_username, ar.status, ar.created_at, ar.decided_at
         FROM access_requests ar
         JOIN users u ON ar.user_id = u.id
         WHERE ar.dataset_id = ? AND ar.status = ? AND u.deleted_at IS NULL
         ORDER BY ar.created_at ASC`,
      )
      .bind(dataset.id, status)
      .all();

    const requests = rows.results ?? [];
    return c.json({ dataset_id: datasetId, status, requests, count: requests.length });
  });

  /**
   * POST /datasets/:id/access-requests/:username/approve - grant the request
   * (owner/admin only). Creates the collaborator + S3 permission.
   */
  datasetRoutes.post("/:id/access-requests/:username/approve", authMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const username = c.req.param("username");
    const currentUser = c.get("user");
    const db = c.env.DB;

    const resolved = await resolveAccessRequest(c);
    if ("error" in resolved) return resolved.error;
    const { dataset, requester } = resolved;

    // The requester must be a usable grant target: approved + a linked GitHub
    // account. Web-only signups (migration 0026) can have a NULL github_username;
    // granting to an empty username would make a phantom GitHub collaborator that
    // can never be removed. Mirrors the invite endpoint's status guard.
    if (requester.status !== "approved") {
      return c.json({ error: `User '${username}' is not an approved account` }, 400);
    }
    if (!requester.github_username) {
      return c.json({ error: `User '${username}' has no linked GitHub account` }, 400);
    }

    if (!dataset.github_repo) {
      return c.json({ error: "Dataset has no GitHub repository" }, 400);
    }
    const repoName = extractRepoName(dataset.github_repo);
    if (!repoName) {
      console.error(`Invalid github_repo format: ${dataset.github_repo}`);
      return c.json({ error: "Dataset has invalid GitHub repository configuration" }, 500);
    }

    // grantCollaborator also flips the pending access_requests row to 'approved'
    // (best-effort) once the grant lands, so no separate UPDATE is needed here.
    const grant = await grantCollaborator(c.env, db, {
      repoName,
      datasetPk: dataset.id,
      datasetId,
      granteeUserId: requester.id,
      granteeGithubUsername: requester.github_username,
      grantedBy: currentUser.id,
      accessType: "requested",
    });
    if (!grant.ok) {
      if (grant.stage === "github") {
        return c.json({ error: "Failed to grant access on GitHub" }, 500);
      }
      // GitHub grant landed but a DB write failed; the request stays pending and a
      // retry is safe (the grants are idempotent).
      return c.json(
        {
          error: "Failed to configure access",
          message:
            "GitHub access was granted but the access record or S3 upload permission could not be set. Retry this approve once; the grant is idempotent.",
          dataset_id: datasetId,
          username,
        },
        500,
      );
    }

    return c.json({
      message: `Access approved for '${username}' on ${dataset.name}`,
      dataset_id: datasetId,
      username,
    });
  });

  /**
   * POST /datasets/:id/access-requests/:username/deny - reject the request
   * (owner/admin only). No GitHub/S3 grant; the user may request again later.
   */
  datasetRoutes.post("/:id/access-requests/:username/deny", authMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const username = c.req.param("username");
    const currentUser = c.get("user");
    const db = c.env.DB;

    const resolved = await resolveAccessRequest(c);
    if ("error" in resolved) return resolved.error;
    const { dataset, requester } = resolved;

    await db
      .prepare(
        "UPDATE access_requests SET status = 'denied', decided_at = CURRENT_TIMESTAMP, decided_by = ? WHERE dataset_id = ? AND user_id = ?",
      )
      .bind(currentUser.id, dataset.id, requester.id)
      .run();

    try {
      await db
        .prepare(
          "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, 'dataset_access_denied', 'dataset', ?, ?)",
        )
        .bind(currentUser.id, datasetId, JSON.stringify({ requester: username }))
        .run();
    } catch (logError) {
      console.error("Failed to write audit log:", logError);
    }

    return c.json({
      message: `Access denied for '${username}' on ${dataset.name}`,
      dataset_id: datasetId,
      username,
    });
  });

  /**
   * GET /datasets/:id/collaborators - List collaborators for a dataset
   */
  datasetRoutes.get("/:id/collaborators", authMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const currentUser = c.get("user");
    const db = c.env.DB;

    // Get dataset info
    const dataset = await db
      .prepare("SELECT id, owner_user_id FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ id: number; owner_user_id: number }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    // Only owner or admin can view collaborators
    if (dataset.owner_user_id !== currentUser.id && !hasRole(currentUser.role, "admin")) {
      return c.json({ error: "Only dataset owner or admin can view collaborators" }, 403);
    }

    const collaborators = await db
      .prepare(
        `SELECT u.username, u.github_username, dc.access_type, dc.granted_at,
                g.username as granted_by_username
         FROM dataset_collaborators dc
         JOIN users u ON dc.user_id = u.id AND u.deleted_at IS NULL
         LEFT JOIN users g ON dc.granted_by = g.id
         WHERE dc.dataset_id = ?
         ORDER BY dc.granted_at DESC`,
      )
      .bind(dataset.id)
      .all();

    return c.json({
      dataset_id: datasetId,
      collaborators: collaborators.results,
      count: collaborators.results.length,
    });
  });

  /**
   * DELETE /datasets/:id/collaborators/:username - Remove a collaborator (#577).
   *
   * Owner or admin only. Removes the dataset_collaborators row + the per-dataset
   * S3 permission (the authoritative upload gate) and revokes GitHub push.
   * 404 if the user is not a collaborator on this dataset; 403 if not owner/admin.
   */
  datasetRoutes.delete("/:id/collaborators/:username", authMiddleware, async (c) => {
    const datasetId = c.req.param("id");
    const targetUsername = c.req.param("username");
    const currentUser = c.get("user");
    const db = c.env.DB;

    const dataset = await db
      .prepare("SELECT id, owner_user_id, github_repo FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ id: number; owner_user_id: number; github_repo: string | null }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    if (dataset.owner_user_id !== currentUser.id && !hasRole(currentUser.role, "admin")) {
      return c.json({ error: "Only dataset owner or admin can remove collaborators" }, 403);
    }

    const target = await db
      .prepare(
        "SELECT id, username, github_username FROM users WHERE username = ? AND deleted_at IS NULL",
      )
      .bind(targetUsername)
      .first<{ id: number; username: string; github_username: string | null }>();

    if (!target) {
      return c.json({ error: "not_found", message: `User '${targetUsername}' not found` }, 404);
    }

    // Removing the owner is out of scope (owner transfer is its own flow).
    if (target.id === dataset.owner_user_id) {
      return c.json(
        { error: "cannot_remove_owner", message: "The dataset owner cannot be removed." },
        400,
      );
    }

    // The dataset_collaborators row is the membership index; 404 if absent.
    const membership = await db
      .prepare("SELECT id FROM dataset_collaborators WHERE dataset_id = ? AND user_id = ?")
      .bind(dataset.id, target.id)
      .first<{ id: number }>();

    if (!membership) {
      return c.json(
        {
          error: "not_found",
          message: `User '${targetUsername}' is not a collaborator on this dataset`,
        },
        404,
      );
    }

    // Revoke GitHub push first (best-effort): a stale GitHub grant is far less
    // dangerous than leaving the S3/collaborator rows in place, which are the real
    // upload authorization removed below. Log but don't fail on a GitHub hiccup.
    const repoName = dataset.github_repo ? extractRepoName(dataset.github_repo) : null;
    if (repoName && target.github_username) {
      try {
        const ok = await removeCollaborator(
          repoName,
          target.github_username,
          await getDatasetsToken(c.env),
        );
        if (!ok) {
          console.warn(
            `[collaborators] GitHub removal returned not-ok for ${target.github_username} on ${repoName}`,
          );
        }
      } catch (err) {
        console.error(
          `[collaborators] GitHub removal failed for ${datasetId}/${targetUsername}:`,
          err,
        );
      }
    }

    // Authoritative revocation, S3 permission FIRST (the upload gate) then the
    // membership index. A throw on either is fatal -> 500 with the membership
    // still consistent (the S3 row is gone first, so the user can't upload even
    // if the membership delete is retried). changes=0 on the S3 delete is a
    // benign idempotent case (no row -> no access), logged for visibility.
    try {
      const s3Del = await db
        .prepare("DELETE FROM user_s3_permissions WHERE user_id = ? AND s3_prefix = ?")
        .bind(target.id, datasetId)
        .run();
      if ((s3Del.meta.changes ?? 0) === 0) {
        console.warn(
          `[collaborators] no user_s3_permissions row for user=${target.id} prefix=${datasetId} (already absent)`,
        );
      }
      await db
        .prepare("DELETE FROM dataset_collaborators WHERE dataset_id = ? AND user_id = ?")
        .bind(dataset.id, target.id)
        .run();
    } catch (err) {
      console.error(`[collaborators] DB removal failed for ${datasetId}/${targetUsername}:`, err);
      return c.json({ error: "Failed to remove collaborator access" }, 500);
    }

    // Audit log (non-fatal).
    try {
      await db
        .prepare(
          "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES (?, 'dataset_collaborator_removed', 'dataset', ?, ?)",
        )
        .bind(
          currentUser.id,
          datasetId,
          JSON.stringify({ removed_user_id: target.id, removed_username: target.username }),
        )
        .run();
    } catch (err) {
      console.error("Failed to write collaborator-removal audit log:", err);
    }

    return c.body(null, 204);
  });
}
