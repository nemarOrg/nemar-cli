/**
 * Authentication middleware
 *
 * Validates API keys from Authorization header and sets user context.
 */

import type { Context, Next } from "hono";
import { hashApiKey } from "../services/token";
import type { AuthUser, Bindings, Variables } from "../types/bindings";

type AuthContext = Context<{ Bindings: Bindings; Variables: Variables }>;

/**
 * Middleware to require valid API key authentication
 *
 * Expects: Authorization: Bearer <api_key>
 * Sets: c.get('user') with the authenticated user
 */
export async function authMiddleware(c: AuthContext, next: Next) {
  const authHeader = c.req.header("Authorization");

  if (!authHeader) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }

  if (!authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Invalid Authorization header format. Use: Bearer <api_key>" }, 401);
  }

  const apiKey = authHeader.substring(7);

  if (!apiKey || apiKey.length < 32) {
    return c.json({ error: "Invalid API key format" }, 401);
  }

  // Hash the key for lookup
  const hashedKey = await hashApiKey(apiKey);

  // Find token and associated user
  const result = await c.env.DB.prepare(
    `
    SELECT
      u.id,
      u.username,
      u.email,
      u.github_username,
      u.is_admin,
      u.status,
      t.id as token_id
    FROM tokens t
    JOIN users u ON t.user_id = u.id
    WHERE t.api_key_hash = ?
      AND t.revoked_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
  `,
  )
    .bind(hashedKey)
    .first<{
      id: number;
      username: string;
      email: string;
      github_username: string;
      is_admin: number;
      status: string;
      token_id: number;
    }>();

  if (!result) {
    return c.json({ error: "Invalid or expired API key" }, 401);
  }

  if (result.status !== "approved") {
    return c.json(
      {
        error: "Account not approved",
        status: result.status,
        message:
          result.status === "verified"
            ? "Your account is awaiting admin approval"
            : "Your account access has been revoked",
      },
      403,
    );
  }

  // Update last_used_at for the token
  await c.env.DB.prepare("UPDATE tokens SET last_used_at = datetime('now') WHERE id = ?")
    .bind(result.token_id)
    .run();

  // Set user in context
  const user: AuthUser = {
    id: result.id,
    username: result.username,
    email: result.email,
    github_username: result.github_username,
    is_admin: result.is_admin === 1,
  };

  c.set("user", user);

  await next();
}

/**
 * Middleware to require admin role
 *
 * Must be used after authMiddleware
 */
export async function adminMiddleware(c: AuthContext, next: Next) {
  const user = c.get("user");

  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  if (!user.is_admin) {
    return c.json({ error: "Admin access required" }, 403);
  }

  await next();
}

/**
 * Optional auth middleware - sets user if authenticated, but doesn't require it
 */
export async function optionalAuthMiddleware(c: AuthContext, next: Next) {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    await next();
    return;
  }

  const apiKey = authHeader.substring(7);
  if (!apiKey || apiKey.length < 32) {
    await next();
    return;
  }

  const hashedKey = await hashApiKey(apiKey);

  const result = await c.env.DB.prepare(
    `
    SELECT
      u.id,
      u.username,
      u.email,
      u.github_username,
      u.is_admin,
      u.status
    FROM tokens t
    JOIN users u ON t.user_id = u.id
    WHERE t.api_key_hash = ?
      AND t.revoked_at IS NULL
      AND u.status = 'approved'
  `,
  )
    .bind(hashedKey)
    .first<{
      id: number;
      username: string;
      email: string;
      github_username: string;
      is_admin: number;
      status: string;
    }>();

  if (result) {
    c.set("user", {
      id: result.id,
      username: result.username,
      email: result.email,
      github_username: result.github_username,
      is_admin: result.is_admin === 1,
    });
  }

  await next();
}
