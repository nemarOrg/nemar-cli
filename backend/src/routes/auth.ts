/**
 * Authentication routes
 *
 * Handles user registration, email verification, and login.
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  sendAdminNotificationEmail,
  sendKeyReadyEmail,
  sendKeyRegenerationVerificationEmail,
  sendVerificationEmail,
} from "../services/email";
import { validateGitHubUsername } from "../services/github";
import { hashPassword, validatePasswordStrength, verifyPassword } from "../services/password";
import {
  generateApiKey,
  generateExpirationTimestamp,
  generateVerificationToken,
  hashApiKey,
} from "../services/token";
import type { Bindings, Variables } from "../types/bindings";

export const authRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * GET /auth/check-username - Check if username is available
 */
authRoutes.get("/check-username", async (c) => {
  const username = c.req.query("username")?.trim();

  if (!username) {
    return c.json({ error: "Username required" }, 400);
  }

  // Validate format
  if (username.length < 3 || username.length > 30) {
    return c.json({ available: false, reason: "Username must be 3-30 characters" });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return c.json({
      available: false,
      reason: "Username can only contain letters, numbers, underscores, and hyphens",
    });
  }

  try {
    const db = c.env.DB;
    const existing = await db
      .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
      .bind(username)
      .first();

    return c.json({ available: !existing });
  } catch (error) {
    console.error("Database error in check-username:", error);
    return c.json({ error: "Unable to check username availability" }, 503);
  }
});

/**
 * GET /auth/check-github - Check if GitHub username exists
 */
authRoutes.get("/check-github", async (c) => {
  const username = c.req.query("username")?.trim();

  if (!username) {
    return c.json({ error: "GitHub username required" }, 400);
  }

  try {
    const githubUser = await validateGitHubUsername(username, c.env.GITHUB_ADMIN_PAT);
    return c.json({ valid: !!githubUser, username: githubUser?.login });
  } catch (error) {
    console.error("GitHub API error in check-github:", error);
    return c.json({ error: "Unable to verify GitHub username" }, 503);
  }
});

// Signup request schema
const signupSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username must be at most 30 characters")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Username can only contain letters, numbers, underscores, and hyphens",
    ),
  email: z.string().email("Invalid email address"),
  password: z.string().min(12, "Password must be at least 12 characters").max(128),
  github_username: z
    .string()
    .min(1, "GitHub username is required")
    .max(39, "GitHub username is too long"),
  description: z
    .string()
    .min(
      20,
      "Please provide a brief description of why you need NEMAR access (at least 20 characters)",
    )
    .max(500, "Description must be at most 500 characters"),
  orcid: z
    .string()
    .regex(/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/, "ORCID must be in format 0000-0000-0000-000X")
    .optional(),
});

/**
 * POST /auth/signup - Register a new user
 */
authRoutes.post("/signup", zValidator("json", signupSchema), async (c) => {
  const { username, email, password, github_username, description, orcid } = c.req.valid("json");
  const db = c.env.DB;

  try {
    // Validate password strength
    const passwordCheck = validatePasswordStrength(password);
    if (!passwordCheck.valid) {
      return c.json(
        {
          error: "Password does not meet requirements",
          details: passwordCheck.errors,
        },
        400,
      );
    }

    // Check if username already exists
    const existingUsername = await db
      .prepare("SELECT id FROM users WHERE username = ?")
      .bind(username)
      .first();

    if (existingUsername) {
      return c.json({ error: "Username already taken" }, 409);
    }

    // Check if email already exists
    const existingEmail = await db
      .prepare("SELECT id FROM users WHERE email = ?")
      .bind(email)
      .first();

    if (existingEmail) {
      return c.json({ error: "Email already registered" }, 409);
    }

    // Validate GitHub username exists
    const githubUser = await validateGitHubUsername(github_username, c.env.GITHUB_ADMIN_PAT);
    if (!githubUser) {
      return c.json(
        {
          error: "GitHub user not found",
          message: `The GitHub username '${github_username}' does not exist`,
        },
        400,
      );
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Generate verification token
    const verificationToken = generateVerificationToken();
    const verificationExpires = generateExpirationTimestamp(24); // 24 hours

    // Insert user
    await db
      .prepare(
        `
      INSERT INTO users (
        username, email, password_hash, github_username, description,
        verification_token, verification_expires_at, orcid
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .bind(
        username,
        email,
        passwordHash,
        github_username,
        description,
        verificationToken,
        verificationExpires,
        orcid || null,
      )
      .run();

    // Send verification email
    const verificationUrl = `${c.env.API_BASE_URL}/auth/verify?token=${verificationToken}`;

    try {
      await sendVerificationEmail(email, username, verificationUrl, c.env.RESEND_API_KEY);
    } catch (emailError) {
      console.error("Failed to send verification email:", emailError);
      // User created but email failed - they can request a new verification
    }

    // Log audit event
    await db
      .prepare(
        `
      INSERT INTO audit_log (action, resource_type, resource_id, details)
      VALUES ('user_signup', 'user', ?, ?)
    `,
      )
      .bind(username, JSON.stringify({ email, github_username, description }))
      .run();

    return c.json(
      {
        message: "Registration successful",
        next_steps: [
          "Check your email for a verification link",
          "Click the link to verify your email address",
          "Wait for admin approval",
          "Once approved, you will receive your API key",
        ],
      },
      201,
    );
  } catch (error) {
    console.error("Signup error:", error);
    return c.json(
      {
        error: "Signup failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

/**
 * GET /auth/verify - Verify email address
 */
authRoutes.get("/verify", async (c) => {
  const token = c.req.query("token");

  if (!token) {
    return c.json({ error: "Verification token required" }, 400);
  }

  const db = c.env.DB;

  // Find user with this token
  const user = await db
    .prepare(
      `
    SELECT id, username, email, github_username, description, status, verification_expires_at
    FROM users
    WHERE verification_token = ?
  `,
    )
    .bind(token)
    .first<{
      id: number;
      username: string;
      email: string;
      github_username: string;
      description: string | null;
      status: string;
      verification_expires_at: string;
    }>();

  if (!user) {
    return c.json({ error: "Invalid verification token" }, 400);
  }

  if (user.status !== "pending") {
    // Already verified or other status - return HTML page directly
    return c.html(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Already Verified - NEMAR</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 40px 20px; text-align: center;">
  <div style="background: #2563eb; color: white; padding: 40px 20px; border-radius: 12px; margin-bottom: 30px;">
    <h1 style="margin: 0 0 10px 0; font-size: 28px;">Already Verified</h1>
    <p style="margin: 0; font-size: 18px; opacity: 0.9;">Your email has already been verified</p>
  </div>

  <div style="background: #f9fafb; padding: 30px; border-radius: 12px;">
    <p>Your NEMAR account is ${user.status === "approved" ? "approved and ready to use" : "awaiting admin approval"}.</p>
    ${user.status === "approved" ? "<p>Use <code style='background: #e5e7eb; padding: 2px 6px; border-radius: 4px;'>nemar auth login</code> to sign in with your API key.</p>" : "<p>You'll receive an email with your API key once approved.</p>"}
  </div>

  <p style="color: #9ca3af; font-size: 12px; margin-top: 40px;">
    NEMAR - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
    `);
  }

  // Check if token expired
  const expiresAt = new Date(user.verification_expires_at);
  if (expiresAt < new Date()) {
    return c.json(
      {
        error: "Verification token has expired",
        message: "Please request a new verification email",
      },
      400,
    );
  }

  // Update user status
  await db
    .prepare(
      `
    UPDATE users
    SET email_verified = 1,
        status = 'verified',
        verification_token = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `,
    )
    .bind(user.id)
    .run();

  // Log audit event
  await db
    .prepare(
      `
    INSERT INTO audit_log (user_id, action, resource_type, resource_id)
    VALUES (?, 'email_verified', 'user', ?)
  `,
    )
    .bind(user.id, user.username)
    .run();

  // Notify all admins about the new user needing approval
  try {
    const adminUsers = await db
      .prepare("SELECT email FROM users WHERE role IN ('owner', 'admin') AND status = 'approved'")
      .all<{ email: string }>();

    if (adminUsers.results && adminUsers.results.length > 0) {
      const adminEmails = adminUsers.results.map((a) => a.email);
      await sendAdminNotificationEmail(
        adminEmails,
        {
          username: user.username,
          email: user.email,
          github_username: user.github_username,
          description: user.description || "No description provided",
        },
        c.env.RESEND_API_KEY,
      );
    }
  } catch (emailError) {
    console.error("Failed to send admin notification:", emailError);
    // Don't fail verification if admin notification fails
  }

  // Return success page directly (no frontend dependency)
  return c.html(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Email Verified - NEMAR</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 40px 20px; text-align: center;">
  <div style="background: linear-gradient(135deg, #16a34a 0%, #22c55e 100%); color: white; padding: 40px 20px; border-radius: 12px; margin-bottom: 30px;">
    <h1 style="margin: 0 0 10px 0; font-size: 28px;">Email Verified!</h1>
    <p style="margin: 0; font-size: 18px; opacity: 0.9;">Welcome to NEMAR, ${user.username}</p>
  </div>

  <div style="background: #f9fafb; padding: 30px; border-radius: 12px; text-align: left;">
    <h2 style="color: #333; font-size: 18px; margin: 0 0 20px 0;">What happens next?</h2>

    <div style="margin-bottom: 20px;">
      <div style="display: flex; align-items: flex-start; margin-bottom: 15px;">
        <span style="background: #16a34a; color: white; border-radius: 50%; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; margin-right: 12px; flex-shrink: 0; font-size: 12px;">✓</span>
        <span><strong>Email verified</strong> - You've completed this step</span>
      </div>
      <div style="display: flex; align-items: flex-start; margin-bottom: 15px;">
        <span style="background: #f59e0b; color: white; border-radius: 50%; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; margin-right: 12px; flex-shrink: 0; font-size: 12px;">2</span>
        <span><strong>Admin review</strong> - An admin will review your request</span>
      </div>
      <div style="display: flex; align-items: flex-start;">
        <span style="background: #e5e7eb; color: #6b7280; border-radius: 50%; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; margin-right: 12px; flex-shrink: 0; font-size: 12px;">3</span>
        <span><strong>Get API key</strong> - Once approved, you'll receive your API key via email</span>
      </div>
    </div>
  </div>

  <p style="color: #6b7280; font-size: 14px; margin-top: 30px;">
    You can close this page. We'll email you when your account is approved.
  </p>

  <p style="color: #9ca3af; font-size: 12px; margin-top: 40px;">
    NEMAR - Neuroelectromagnetic Data Archive and Tools Resource<br>
    <a href="https://nemar-cli.pages.dev" style="color: #9ca3af;">Documentation</a>
  </p>
</body>
</html>
  `);
});

// Login request schema
const loginSchema = z.object({
  api_key: z.string().min(32, "Invalid API key format"),
});

/**
 * POST /auth/login - Validate API key and return user info
 */
authRoutes.post("/login", zValidator("json", loginSchema), async (c) => {
  const { api_key } = c.req.valid("json");
  const db = c.env.DB;

  // Import hash function
  const { hashApiKey } = await import("../services/token");
  const hashedKey = await hashApiKey(api_key);

  // Find token and user
  const result = await db
    .prepare(
      `
    SELECT
      t.id as token_id,
      u.id as user_id,
      u.username,
      u.email,
      u.github_username,
      u.status,
      u.role,
      u.sandbox_completed,
      u.sandbox_dataset_id
    FROM tokens t
    JOIN users u ON t.user_id = u.id
    WHERE t.api_key_hash = ?
      AND t.revoked_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
  `,
    )
    .bind(hashedKey)
    .first<{
      token_id: number;
      user_id: number;
      username: string;
      email: string;
      github_username: string;
      status: string;
      role: string | null;
      sandbox_completed: number;
      sandbox_dataset_id: string | null;
    }>();

  if (!result) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  if (result.status !== "approved") {
    return c.json(
      {
        error: "Account not approved",
        status: result.status,
      },
      403,
    );
  }

  // Update last_used_at
  await db
    .prepare("UPDATE tokens SET last_used_at = datetime('now') WHERE id = ?")
    .bind(result.token_id)
    .run();

  return c.json({
    valid: true,
    user: {
      username: result.username,
      email: result.email,
      github_username: result.github_username,
      role: result.role || "member",
      sandbox_completed: result.sandbox_completed === 1,
      sandbox_dataset_id: result.sandbox_dataset_id,
    },
  });
});

/**
 * POST /auth/resend-verification - Resend verification email
 */
const resendSchema = z.object({
  email: z.string().email(),
});

authRoutes.post("/resend-verification", zValidator("json", resendSchema), async (c) => {
  const { email } = c.req.valid("json");
  const db = c.env.DB;

  // Find user
  const user = await db
    .prepare("SELECT id, username, status FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: number; username: string; status: string }>();

  if (!user) {
    // Don't reveal if email exists
    return c.json({
      message: "If an account exists with this email, a verification link will be sent",
    });
  }

  if (user.status !== "pending") {
    return c.json({ message: "Email already verified" });
  }

  // Generate new token
  const verificationToken = generateVerificationToken();
  const verificationExpires = generateExpirationTimestamp(24);

  // Update user
  await db
    .prepare(
      `
    UPDATE users
    SET verification_token = ?,
        verification_expires_at = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `,
    )
    .bind(verificationToken, verificationExpires, user.id)
    .run();

  // Send email
  const verificationUrl = `${c.env.API_BASE_URL}/auth/verify?token=${verificationToken}`;
  await sendVerificationEmail(email, user.username, verificationUrl, c.env.RESEND_API_KEY);

  return c.json({ message: "Verification email sent" });
});

// ============================================================================
// Retrieve API Key (approved users only, requires email + password)
// ============================================================================

const retrieveKeySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
});

/**
 * POST /auth/retrieve-key - Retrieve API key using email and password.
 * Only works for approved users. Returns the existing API key prefix
 * and generates a new key if needed (e.g., first retrieval after approval).
 */
authRoutes.post("/retrieve-key", zValidator("json", retrieveKeySchema), async (c) => {
  const { email, password } = c.req.valid("json");
  const db = c.env.DB;

  // Find user by email
  const user = await db
    .prepare("SELECT id, username, email, password_hash, status FROM users WHERE email = ?")
    .bind(email)
    .first<{
      id: number;
      username: string;
      email: string;
      password_hash: string;
      status: string;
    }>();

  if (!user) {
    // Intentionally vague to prevent email enumeration
    return c.json({ error: "Invalid email or password" }, 401);
  }

  // Verify password
  const passwordValid = await verifyPassword(password, user.password_hash);
  if (!passwordValid) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  if (user.status !== "approved") {
    return c.json(
      {
        error: "Account not approved",
        message:
          user.status === "pending"
            ? "Please verify your email first"
            : user.status === "verified"
              ? "Your account is awaiting admin approval"
              : "Your account access has been revoked",
      },
      403,
    );
  }

  // Check if user has an active (non-revoked, non-expired) token
  const existingToken = await db
    .prepare(
      `SELECT id, api_key_prefix FROM tokens
       WHERE user_id = ? AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(user.id)
    .first<{ id: number; api_key_prefix: string }>();

  if (!existingToken) {
    // No active token; generate a new one (e.g., first login after approval)
    const { apiKey, apiKeyPrefix } = generateApiKey();
    const hashedKey = await hashApiKey(apiKey);

    await db
      .prepare(
        `INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, name)
         VALUES (?, ?, ?, 'Retrieved Token')`,
      )
      .bind(user.id, hashedKey, apiKeyPrefix)
      .run();

    await db
      .prepare(
        `INSERT INTO audit_log (user_id, action, resource_type, resource_id)
         VALUES (?, 'key_retrieved', 'user', ?)`,
      )
      .bind(user.id, user.username)
      .run();

    return c.json({
      message: "API key generated successfully",
      api_key: apiKey,
      note: "Store this key securely. It will not be shown again.",
    });
  }

  // User already has a token but we cannot show the actual key (only hash is stored).
  // They need to use regenerate-key if they lost it.
  return c.json(
    {
      error: "API key already issued",
      api_key_prefix: existingToken.api_key_prefix,
      message:
        "An API key has already been generated for your account. " +
        "If you lost it, use 'nemar auth regenerate-key' to get a new one.",
    },
    409,
  );
});

// ============================================================================
// Request API Key Regeneration (sends verification email)
// ============================================================================

const regenRequestSchema = z.object({
  email: z.string().email(),
});

/**
 * POST /auth/request-key-regeneration - Request a new API key.
 * Sends a verification email; clicking the link generates a new key and revokes the old one.
 */
authRoutes.post(
  "/request-key-regeneration",
  zValidator("json", regenRequestSchema),
  async (c) => {
    const { email } = c.req.valid("json");
    const db = c.env.DB;

    // Find user
    const user = await db
      .prepare("SELECT id, username, email, status FROM users WHERE email = ?")
      .bind(email)
      .first<{ id: number; username: string; email: string; status: string }>();

    if (!user || user.status !== "approved") {
      // Intentionally vague
      return c.json({
        message: "If an approved account exists with this email, a verification link will be sent",
      });
    }

    // Generate a regeneration verification token
    const regenToken = generateVerificationToken();
    const regenExpires = generateExpirationTimestamp(1); // 1 hour

    // Store the token on the user record
    await db
      .prepare(
        `UPDATE users
         SET verification_token = ?,
             verification_expires_at = ?,
             updated_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(regenToken, regenExpires, user.id)
      .run();

    // Send verification email
    const confirmUrl = `${c.env.API_BASE_URL}/auth/confirm-key-regeneration?token=${regenToken}`;
    try {
      await sendKeyRegenerationVerificationEmail(
        user.email,
        user.username,
        confirmUrl,
        c.env.RESEND_API_KEY,
      );
    } catch (emailError) {
      console.error("Failed to send key regeneration email:", emailError);
    }

    return c.json({
      message: "If an approved account exists with this email, a verification link will be sent",
    });
  },
);

// ============================================================================
// Confirm Key Regeneration (via email link)
// ============================================================================

/**
 * GET /auth/confirm-key-regeneration?token=... - Confirm key regeneration.
 * Revokes old tokens, generates a new API key, and shows it in a success page.
 */
authRoutes.get("/confirm-key-regeneration", async (c) => {
  const token = c.req.query("token");

  if (!token) {
    return c.json({ error: "Token required" }, 400);
  }

  const db = c.env.DB;

  const user = await db
    .prepare(
      `SELECT id, username, email, status, verification_expires_at
       FROM users WHERE verification_token = ?`,
    )
    .bind(token)
    .first<{
      id: number;
      username: string;
      email: string;
      status: string;
      verification_expires_at: string;
    }>();

  if (!user) {
    return c.json({ error: "Invalid or expired token" }, 400);
  }

  if (user.status !== "approved") {
    return c.json({ error: "Account is not approved" }, 403);
  }

  // Check expiration
  const expiresAt = new Date(user.verification_expires_at);
  if (expiresAt < new Date()) {
    return c.json(
      {
        error: "Token has expired",
        message: "Please request a new key regeneration link",
      },
      400,
    );
  }

  // Revoke all existing tokens
  const revokeResult = await db
    .prepare(
      `UPDATE tokens SET revoked_at = datetime('now')
       WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .bind(user.id)
    .run();

  // Generate new API key
  const { apiKey, apiKeyPrefix } = generateApiKey();
  const hashedKey = await hashApiKey(apiKey);

  await db
    .prepare(
      `INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, name)
       VALUES (?, ?, ?, 'Regenerated Token')`,
    )
    .bind(user.id, hashedKey, apiKeyPrefix)
    .run();

  // Clear the verification token
  await db
    .prepare(
      `UPDATE users
       SET verification_token = NULL,
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(user.id)
    .run();

  // Audit log
  await db
    .prepare(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
       VALUES (?, 'key_regenerated', 'user', ?, ?)`,
    )
    .bind(
      user.id,
      user.username,
      JSON.stringify({ tokens_revoked: revokeResult.meta?.changes || 0 }),
    )
    .run();

  // Return HTML page with the new API key
  return c.html(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New API Key - NEMAR</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 40px 20px; text-align: center;">
  <div style="background: linear-gradient(135deg, #16a34a 0%, #22c55e 100%); color: white; padding: 40px 20px; border-radius: 12px; margin-bottom: 30px;">
    <h1 style="margin: 0 0 10px 0; font-size: 28px;">New API Key Generated</h1>
    <p style="margin: 0; font-size: 18px; opacity: 0.9;">Your old key has been revoked</p>
  </div>

  <div style="background: #f9fafb; padding: 30px; border-radius: 12px; text-align: left;">
    <h2 style="color: #333; font-size: 18px; margin: 0 0 15px 0;">Your New API Key</h2>
    <div style="background-color: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 13px; word-break: break-all; margin: 16px 0;">
      ${apiKey}
    </div>
    <p style="color: #dc2626; font-weight: bold; font-size: 14px;">
      Copy this key now. It will not be shown again.
    </p>

    <h2 style="color: #333; font-size: 18px; margin: 25px 0 15px 0;">Login with your new key</h2>
    <div style="background-color: #f4f4f5; padding: 12px; border-radius: 8px; font-family: monospace; font-size: 13px;">
      nemar auth login
    </div>
  </div>

  <p style="color: #9ca3af; font-size: 12px; margin-top: 40px;">
    NEMAR - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `);
});
