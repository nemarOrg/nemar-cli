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
