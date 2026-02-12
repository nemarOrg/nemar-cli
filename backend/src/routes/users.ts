/**
 * User routes
 *
 * Handles authenticated user operations.
 */

import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";
import type { Bindings, Variables } from "../types/bindings";

export const userRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// All user routes require authentication
userRoutes.use("*", authMiddleware);

/**
 * GET /users/me - Get current authenticated user info
 */
userRoutes.get("/me", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  // Get additional user details including sandbox status
  const userDetails = await db
    .prepare(
      `
    SELECT
      created_at,
      approved_at,
      sandbox_completed,
      sandbox_completed_at,
      sandbox_dataset_id,
      (SELECT COUNT(*) FROM datasets WHERE owner_user_id = ? AND is_sandbox = 0) as dataset_count
    FROM users
    WHERE id = ?
  `,
    )
    .bind(user.id, user.id)
    .first<{
      created_at: string;
      approved_at: string;
      sandbox_completed: number;
      sandbox_completed_at: string | null;
      sandbox_dataset_id: string | null;
      dataset_count: number;
    }>();

  // Get token info
  const tokenInfo = await db
    .prepare(
      `
    SELECT api_key_prefix, created_at, last_used_at
    FROM tokens
    WHERE user_id = ? AND revoked_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `,
    )
    .bind(user.id)
    .first<{
      api_key_prefix: string;
      created_at: string;
      last_used_at: string | null;
    }>();

  return c.json({
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      github_username: user.github_username,
      is_admin: user.is_admin,
      orcid: user.orcid || null,
      created_at: userDetails?.created_at,
      approved_at: userDetails?.approved_at,
      dataset_count: userDetails?.dataset_count || 0,
      sandbox_completed: !!userDetails?.sandbox_completed,
      sandbox_completed_at: userDetails?.sandbox_completed_at,
      sandbox_dataset_id: userDetails?.sandbox_dataset_id,
    },
    token: tokenInfo
      ? {
          prefix: tokenInfo.api_key_prefix,
          created_at: tokenInfo.created_at,
          last_used_at: tokenInfo.last_used_at,
        }
      : null,
  });
});

/**
 * GET /users/me/datasets - List datasets owned by current user
 */
userRoutes.get("/me/datasets", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  const datasets = await db
    .prepare(
      `
    SELECT
      dataset_id,
      name,
      description,
      status,
      github_repo,
      concept_doi,
      created_at,
      updated_at
    FROM datasets
    WHERE owner_user_id = ?
    ORDER BY created_at DESC
  `,
    )
    .bind(user.id)
    .all();

  return c.json({ datasets: datasets.results });
});
