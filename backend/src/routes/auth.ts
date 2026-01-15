/**
 * Authentication routes
 *
 * Handles user registration, email verification, and login.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { Bindings, Variables } from "../types/bindings";
import { hashPassword, validatePasswordStrength } from "../services/password";
import { generateVerificationToken, generateExpirationTimestamp } from "../services/token";
import { sendVerificationEmail } from "../services/email";
import { validateGitHubUsername } from "../services/github";

export const authRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Signup request schema
const signupSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username must be at most 30 characters")
    .regex(/^[a-zA-Z0-9_-]+$/, "Username can only contain letters, numbers, underscores, and hyphens"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(12, "Password must be at least 12 characters").max(128),
  github_username: z
    .string()
    .min(1, "GitHub username is required")
    .max(39, "GitHub username is too long"),
});

/**
 * POST /auth/signup - Register a new user
 */
authRoutes.post("/signup", zValidator("json", signupSchema), async (c) => {
  const { username, email, password, github_username } = c.req.valid("json");
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
        400
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
        400
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
        username, email, password_hash, github_username,
        verification_token, verification_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `
      )
      .bind(username, email, passwordHash, github_username, verificationToken, verificationExpires)
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
    `
      )
      .bind(username, JSON.stringify({ email, github_username }))
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
      201
    );
  } catch (error) {
    console.error("Signup error:", error);
    return c.json(
      {
        error: "Signup failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
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
    SELECT id, username, email, status, verification_expires_at
    FROM users
    WHERE verification_token = ?
  `
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
    return c.json({ error: "Invalid verification token" }, 400);
  }

  if (user.status !== "pending") {
    // Already verified or other status
    return c.redirect(`${c.env.FRONTEND_URL}/signup/already-verified`);
  }

  // Check if token expired
  const expiresAt = new Date(user.verification_expires_at);
  if (expiresAt < new Date()) {
    return c.json(
      {
        error: "Verification token has expired",
        message: "Please request a new verification email",
      },
      400
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
  `
    )
    .bind(user.id)
    .run();

  // Log audit event
  await db
    .prepare(
      `
    INSERT INTO audit_log (user_id, action, resource_type, resource_id)
    VALUES (?, 'email_verified', 'user', ?)
  `
    )
    .bind(user.id, user.username)
    .run();

  // Redirect to frontend success page
  return c.redirect(`${c.env.FRONTEND_URL}/signup/verified?username=${user.username}`);
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
      u.is_admin
    FROM tokens t
    JOIN users u ON t.user_id = u.id
    WHERE t.api_key_hash = ?
      AND t.revoked_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
  `
    )
    .bind(hashedKey)
    .first<{
      token_id: number;
      user_id: number;
      username: string;
      email: string;
      github_username: string;
      status: string;
      is_admin: number;
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
      403
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
      is_admin: result.is_admin === 1,
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
    return c.json({ message: "If an account exists with this email, a verification link will be sent" });
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
  `
    )
    .bind(verificationToken, verificationExpires, user.id)
    .run();

  // Send email
  const verificationUrl = `${c.env.API_BASE_URL}/auth/verify?token=${verificationToken}`;
  await sendVerificationEmail(email, user.username, verificationUrl, c.env.RESEND_API_KEY);

  return c.json({ message: "Verification email sent" });
});
