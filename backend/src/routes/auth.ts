/**
 * Authentication routes
 *
 * Handles user registration, email verification, and login.
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  ORCID_ID_PATTERN,
  type OrcidNameLookupStatus,
  orcidIdSchema,
} from "../../../shared/contract/publication.js";
import { escapeHtml } from "../lib/escape";
import { inactiveAccountBody, isActiveAccountStatus } from "../services/account-tier";
import {
  getAdminEmailsForCategory,
  resolveEmailConfig,
  sendAdminNotificationEmail,
  sendKeyReadyEmail,
  sendKeyRegenerationVerificationEmail,
  sendVerificationEmail,
} from "../services/email";
import { validateGitHubUsername } from "../services/github";
import { getDatasetsToken } from "../services/github-auth";
import { fetchOrcidName, orcidPubBase } from "../services/orcid-auth";
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

  // #1052: a lookup has three answers, and only a 404 is evidence about the
  // account. `unavailable` (5xx, 429, a transport failure) used to arrive here
  // as `null` and be reported to the caller as `valid: false` -- telling
  // someone mid-signup that their own handle does not exist because GitHub was
  // having a bad minute.
  let lookup: Awaited<ReturnType<typeof validateGitHubUsername>>;
  try {
    lookup = await validateGitHubUsername(username, await getDatasetsToken(c.env));
  } catch (error) {
    // The helper does not throw for a lookup failure; reaching here means
    // getDatasetsToken did (no App key, no PAT).
    console.error("GitHub auth error in check-github:", error);
    return c.json({ error: "Unable to verify GitHub username" }, 503);
  }
  if (lookup.status === "unavailable") {
    console.error(`GitHub API error in check-github: ${lookup.detail}`);
    return c.json({ error: "Unable to verify GitHub username" }, 503);
  }
  const githubUser = lookup.status === "found" ? lookup.user : null;

  // Only check registration if GitHub user exists (use canonical login for case-insensitive match)
  let registered = false;
  if (githubUser) {
    try {
      const db = c.env.DB;
      const existingUser = await db
        .prepare("SELECT id FROM users WHERE github_username = ? COLLATE NOCASE")
        .bind(githubUser.login)
        .first();
      registered = !!existingUser;
    } catch (dbError) {
      console.error("Database error checking GitHub registration:", dbError);
      return c.json({ error: "Unable to check registration status" }, 503);
    }
  }

  return c.json({ valid: !!githubUser, username: githubUser?.login, registered });
});

/**
 * GET /auth/orcid-name - Read the given/family name on a public ORCID record
 *
 * Pre-signup lookup, alongside check-username and check-github (#1255). ORCID
 * is required at signup and is the canonical source of the researcher name
 * that DOIs cite, but a record may hide its name. The CLI calls this right
 * after the ORCID prompt so it can ask for the name ONLY in that case,
 * instead of asking everyone for something we usually already know.
 *
 * A pre-flight GET rather than a flag on the signup response: signup is the
 * call that creates the account, so discovering "we need a name" from its
 * response would mean failing a submitted registration and re-driving the
 * prompts. This is idempotent, costs one public ORCID read, and mirrors the
 * two pre-signup checks that already exist.
 *
 * The three outcomes are reported separately (`found` / `no_public_name` /
 * `lookup_failed`): the caller prompts for a name in the last two, but the
 * sentence it shows the user differs, and blaming a private record for an
 * ORCID outage is the kind of small lie that costs a support round-trip.
 */
authRoutes.get("/orcid-name", async (c) => {
  const orcid = c.req.query("orcid")?.trim();

  if (!orcid) {
    return c.json({ error: "ORCID iD required" }, 400);
  }
  if (!ORCID_ID_PATTERN.test(orcid)) {
    return c.json({ error: "ORCID must be in format 0000-0000-0000-000X" }, 400);
  }

  try {
    const name = await fetchOrcidName(orcid, orcidPubBase(c.env));
    // Half a name is not citable, so it is not "found".
    const status: OrcidNameLookupStatus = name.given && name.family ? "found" : "no_public_name";
    return c.json({ status, given_name: name.given, family_name: name.family });
  } catch (err) {
    // Distinct from no_public_name on purpose (#1255 review item 10): the
    // caller must be able to say "ORCID is unreachable right now" rather than
    // accusing the user's record of hiding a name it may well publish.
    console.warn(`[orcid-name] lookup failed for ${orcid}:`, err);
    return c.json({
      status: "lookup_failed" satisfies OrcidNameLookupStatus,
      given_name: null,
      family_name: null,
    });
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
    .max(39, "GitHub username is too long")
    .regex(
      /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/,
      "GitHub username must start and end with a letter or number, and can only contain letters, numbers, and hyphens",
    ),
  description: z
    .string()
    .min(
      20,
      "Please provide a brief description of why you need NEMAR access (at least 20 characters)",
    )
    .max(500, "Description must be at most 500 characters"),
  // ORCID is now required: it's the canonical source for the user's name (#835).
  orcid: orcidIdSchema,
  // Supplied only when the ORCID record hides its name (#1255): the server
  // still reads ORCID first, so these are a fallback, never an override.
  given_name: z.string().trim().min(1).max(100).optional(),
  family_name: z.string().trim().min(1).max(100).optional(),
  affiliation: z.string().max(200, "Affiliation must be at most 200 characters").optional(),
  // city/country required for US export-control / sanctions screening (#835).
  city: z.string().min(1, "City is required").max(120, "City must be at most 120 characters"),
  country: z
    .string()
    .min(1, "Country is required")
    .max(120, "Country must be at most 120 characters"),
});

/**
 * POST /auth/signup - Register a new user
 */
authRoutes.post("/signup", zValidator("json", signupSchema), async (c) => {
  const {
    username,
    email,
    password,
    github_username,
    description,
    orcid,
    given_name: suppliedGivenName,
    family_name: suppliedFamilyName,
    affiliation,
    city,
    country,
  } = c.req.valid("json");
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

    // NOTE: the signup de-dup checks below (username / email / github_username)
    // deliberately do NOT filter `deleted_at IS NULL` — they must see ALL rows,
    // including tombstones, to honor the UNIQUE constraints. Re-signup with a
    // deleted user's old email/username/github is enabled by the tombstone
    // MASKING (email -> deleted+<id>@deleted.invalid, username/github -> NULL),
    // which frees those values, NOT by excluding deleted rows here. See the
    // DELETE /admin/users/by-id/:id tombstone + migration 0037.

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

    // Direct dup check on the raw input (case-insensitive). Common case:
    // the username is already registered exactly as typed. Saves one GitHub
    // API call and lets the request 409 even when the GitHub user happens
    // not to resolve (e.g., user was renamed/deleted on GitHub after
    // signing up here).
    const directDupGithub = await db
      .prepare("SELECT id FROM users WHERE github_username = ? COLLATE NOCASE")
      .bind(github_username)
      .first();
    if (directDupGithub) {
      return c.json({ error: "GitHub account already linked to another user" }, 409);
    }

    // Validate GitHub username exists. This is also where we recover the
    // canonical login (matters for case-variant dedup below).
    const githubLookup = await validateGitHubUsername(
      github_username,
      await getDatasetsToken(c.env),
    );
    // #1052: a GitHub outage is not a verdict on the handle. Refusing a
    // registration with "does not exist" when GitHub 500s sends someone to
    // change a field that was right, and the change does not help.
    if (githubLookup.status === "unavailable") {
      console.error(`[signup] GitHub lookup unavailable: ${githubLookup.detail}`);
      return c.json(
        {
          error: "GitHub unavailable",
          message:
            "GitHub could not be reached to verify your username; try again in a few minutes",
        },
        503,
      );
    }
    if (githubLookup.status === "not_found") {
      return c.json(
        {
          error: "GitHub user not found",
          message: `The GitHub username '${github_username}' does not exist`,
        },
        400,
      );
    }
    const githubUser = githubLookup.user;

    // Re-check with the canonical login when GitHub normalized the case.
    // Catches the "Octocat" stored vs "octocat" submitted shape.
    if (githubUser.login.toLowerCase() !== github_username.toLowerCase()) {
      const canonicalDup = await db
        .prepare("SELECT id FROM users WHERE github_username = ? COLLATE NOCASE")
        .bind(githubUser.login)
        .first();
      if (canonicalDup) {
        return c.json({ error: "GitHub account already linked to another user" }, 409);
      }
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Generate verification token
    const verificationToken = generateVerificationToken();
    const verificationExpires = generateExpirationTimestamp(24); // 24 hours

    // ORCID is canonical for the name: pull given/family from the public
    // record rather than asking the user to type it. The record wins whenever
    // it has a name; the client-supplied pair is the fallback for a record
    // that hides its name (or a transient lookup failure), which the CLI
    // collects after GET /auth/orcid-name reports found: false.
    //
    // The name is what DOIs cite (#1255) and publishing is blocked without
    // it, so landing an account with NULL names is a real cost -- but not one
    // worth failing a registration over. The gap closes when the record is
    // made public and `nemar admin backfill-names` (or the next ORCID link)
    // reads it. PATCH /auth/profile does now accept a typed name, but NOT for
    // this account: signup requires an ORCID, and ADR 0042 keeps the name
    // ORCID-canonical for every account that has a verified one.
    let givenName: string | null = null;
    let familyName: string | null = null;
    try {
      const n = await fetchOrcidName(orcid, orcidPubBase(c.env));
      givenName = n.given;
      familyName = n.family;
    } catch (nameErr) {
      console.warn(`[signup] ORCID name fetch failed for ${orcid}`, nameErr);
    }
    // Both halves come from the same source: mixing a record given name with
    // a typed family name would produce a name neither party stated. A
    // partial from the record is kept rather than discarded when the client
    // supplied nothing usable -- it is not citable on its own, but it is a
    // head start for the backfill.
    if ((!givenName || !familyName) && suppliedGivenName && suppliedFamilyName) {
      givenName = suppliedGivenName;
      familyName = suppliedFamilyName;
    }

    // Insert user
    await db
      .prepare(
        `
      INSERT INTO users (
        username, email, password_hash, github_username, description,
        verification_token, verification_expires_at, orcid,
        given_name, family_name, affiliation, city, country
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .bind(
        username,
        email,
        passwordHash,
        githubUser.login,
        description,
        verificationToken,
        verificationExpires,
        orcid,
        givenName,
        familyName,
        affiliation || null,
        city,
        country,
      )
      .run();

    // Send verification email
    const verificationUrl = `${c.env.API_BASE_URL}/auth/verify?token=${verificationToken}`;

    let emailSent = false;
    try {
      const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
      await sendVerificationEmail(
        email,
        username,
        verificationUrl,
        c.env.RESEND_API_KEY,
        fromEmail,
        replyTo,
        isDev,
        c.env,
      );
      emailSent = true;
    } catch (emailError) {
      console.error("Failed to send verification email:", emailError);
      // User created but email failed - they can use resend-verification
    }

    // Audit log failure should not block signup response
    try {
      await db
        .prepare(
          `INSERT INTO audit_log (action, resource_type, resource_id, details)
           VALUES ('user_signup', 'user', ?, ?)`,
        )
        .bind(username, JSON.stringify({ email, github_username, description }))
        .run();
    } catch (auditError) {
      console.error("Failed to write signup audit log for user:", username, auditError);
    }

    // Whether the account actually landed with a citable name (#1255 review
    // item 4). The client's own pre-flight can say "found" and this insert's
    // lookup can still fail transiently a moment later, and the account is
    // created either way -- so the account-creating call is the one that has
    // to report the truth, or the user learns about it at publish time.
    const researcherName = givenName && familyName ? "recorded" : "missing";

    return c.json(
      {
        message: "Registration successful",
        email_sent: emailSent,
        researcher_name: researcherName,
        // ADR 0040 phase 2: verifying the email is the last step that gates
        // the account itself, so these are the only steps a new signup owes.
        // Admin approval is no longer one of them — it is the separate,
        // later, upload-access decision, and telling someone to wait for it
        // now stalls them in front of a key they could already fetch. The
        // missing-name hint (#1255) rides along last: it is about how a DOI
        // will cite this person, not about whether the account works.
        next_steps: [
          emailSent
            ? "Check your email for a verification link"
            : "Verification email failed to send. Use 'nemar auth resend-verification' to try again",
          ...(emailSent ? ["Click the link to verify your email address"] : []),
          "Run 'nemar auth retrieve-key' to get your API key",
          "Run 'nemar auth login' to sign in with it",
          ...(researcherName === "missing"
            ? [
                "No researcher name is on file; DOIs cannot cite you until your ORCID record shows your name publicly",
              ]
            : []),
        ],
      },
      201,
    );
  } catch (error) {
    console.error("Signup error:", error);

    // Handle DB UNIQUE constraint violations as a safety net
    // D1 errors may not be standard Error instances, so check multiple ways
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("UNIQUE constraint failed")) {
      if (msg.includes("users.username")) {
        return c.json({ error: "Username already taken" }, 409);
      }
      if (msg.includes("users.email")) {
        return c.json({ error: "Email already registered" }, 409);
      }
      if (msg.includes("users.github_username")) {
        return c.json({ error: "GitHub account already linked to another user" }, 409);
      }
      console.error("Unhandled UNIQUE constraint column in signup:", msg);
      return c.json({ error: "An account with these details already exists" }, 409);
    }

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
      AND deleted_at IS NULL
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
    <p>Your NEMAR account is ${user.status === "revoked" ? "no longer active" : "active and ready to use"}.</p>
    ${
      user.status === "revoked"
        ? "<p>Contact a NEMAR administrator if you believe this is an error.</p>"
        : "<p>Run <code style='background: #e5e7eb; padding: 2px 6px; border-radius: 4px;'>nemar auth retrieve-key</code> to get your API key, then <code style='background: #e5e7eb; padding: 2px 6px; border-radius: 4px;'>nemar auth login</code> to sign in with it.</p>"
    }
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

  // The account is now active (ADR 0040 phase 2), so this is the moment the
  // API key becomes retrievable — and therefore the moment the mail that
  // explains how to retrieve it belongs. It used to be sent at approval,
  // which is no longer when the key becomes available. Best-effort: a mail
  // failure must not undo a verification that has already committed, and the
  // user can still run `nemar auth retrieve-key` without ever seeing it.
  //
  // Whether it actually went is tracked, because the success page below is
  // the ONLY other place this user is told how to get their key. Promising
  // an email that was never sent (delivery fenced in dev, RESEND_API_KEY
  // unset, Resend refusing) leaves them waiting on an inbox instead of
  // running one command.
  let keyEmailSent = false;
  try {
    if (c.env.RESEND_API_KEY) {
      const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
      await sendKeyReadyEmail(
        user.email,
        user.username,
        c.env.RESEND_API_KEY,
        fromEmail,
        replyTo,
        isDev,
        c.env,
      );
      keyEmailSent = true;
    } else {
      console.error(`RESEND_API_KEY unset; key-ready email not sent for user id=${user.id}`);
    }
  } catch (emailError) {
    console.error("Failed to send key-ready email:", emailError);
  }

  // Notify admins who have user_approval notifications enabled
  try {
    const adminEmails = await getAdminEmailsForCategory(db, "user_approval");
    if (adminEmails.length > 0) {
      const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
      await sendAdminNotificationEmail(
        adminEmails,
        {
          id: user.id,
          username: user.username,
          email: user.email,
          github_username: user.github_username,
          description: user.description || "No description provided",
        },
        c.env.RESEND_API_KEY,
        fromEmail,
        replyTo,
        isDev,
        c.env,
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
    <p style="margin: 0; font-size: 18px; opacity: 0.9;">Welcome to NEMAR, ${escapeHtml(user.username)}</p>
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
        <span><strong>Get your API key</strong> - Run <code>nemar auth retrieve-key</code>, then <code>nemar auth login</code></span>
      </div>
      <div style="display: flex; align-items: flex-start;">
        <span style="background: #e5e7eb; color: #6b7280; border-radius: 50%; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; margin-right: 12px; flex-shrink: 0; font-size: 12px;">3</span>
        <span><strong>To upload</strong> - Run <code>nemar sandbox</code> for the training run, and ask an admin for upload access</span>
      </div>
    </div>
  </div>

  <p style="color: #6b7280; font-size: 14px; margin-top: 30px;">
    You can close this page. Your account is active${
      keyEmailSent
        ? "; we've emailed you the steps to retrieve your API key."
        : " — run <code>nemar auth retrieve-key</code> to get your API key."
    }
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
      AND u.deleted_at IS NULL
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

  // ADR 0040 phase 2: an API key is issued at `verified`, so logging in with
  // one has to work at `verified` too. `pending` and `revoked` are refused
  // with the shared body (services/account-tier.ts).
  if (!isActiveAccountStatus(result.status)) {
    return c.json(inactiveAccountBody(result.status), 403);
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
    .prepare("SELECT id, username, status FROM users WHERE email = ? AND deleted_at IS NULL")
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
  const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
  await sendVerificationEmail(
    email,
    user.username,
    verificationUrl,
    c.env.RESEND_API_KEY,
    fromEmail,
    replyTo,
    isDev,
    c.env,
  );

  return c.json({ message: "Verification email sent" });
});

// ============================================================================
// Retrieve API Key (verified or approved accounts, requires email + password)
// ============================================================================

const retrieveKeySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
});

/**
 * POST /auth/retrieve-key - Retrieve API key using email and password.
 *
 * Works from `verified` (ADR 0040 phase 2): the API key is base-tier, and
 * this route is where it is minted — nothing creates a token at approval, so
 * a legacy `verified` row with no token gets one here on first call, exactly
 * as an approved row always did. Returns the existing key's prefix (and a 409)
 * when one was already issued.
 */
authRoutes.post("/retrieve-key", zValidator("json", retrieveKeySchema), async (c) => {
  const { email, password } = c.req.valid("json");
  const db = c.env.DB;

  // Find user by email
  const user = await db
    .prepare(
      "SELECT id, username, email, password_hash, status FROM users WHERE email = ? AND deleted_at IS NULL",
    )
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

  // ADR 0040 phase 2: the key belongs to the base tier, so `verified` is
  // enough. Admin approval is the upload decision and happens later, against
  // an account that already holds a key.
  if (!isActiveAccountStatus(user.status)) {
    return c.json(inactiveAccountBody(user.status), 403);
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
    // No active token; generate a new one (the first retrieval after email
    // verification, or a legacy `verified` row that predates ADR 0040)
    const { apiKey, apiKeyPrefix } = generateApiKey();
    const hashedKey = await hashApiKey(apiKey);

    try {
      await db
        .prepare(
          `INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, name)
           VALUES (?, ?, ?, 'Retrieved Token')`,
        )
        .bind(user.id, hashedKey, apiKeyPrefix)
        .run();
    } catch (tokenError) {
      console.error("Failed to create token for user:", user.id, tokenError);
      return c.json(
        {
          error: "Failed to generate API key",
          message:
            "Could not create your API key. Please try again. " +
            "If the problem persists, contact an administrator.",
        },
        500,
      );
    }

    // Audit log failure should not prevent key delivery
    try {
      await db
        .prepare(
          `INSERT INTO audit_log (user_id, action, resource_type, resource_id)
           VALUES (?, 'key_retrieved', 'user', ?)`,
        )
        .bind(user.id, user.username)
        .run();
    } catch (auditError) {
      console.error("Failed to write audit log for key retrieval, user:", user.id, auditError);
    }

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
      details: { api_key_prefix: existingToken.api_key_prefix },
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
authRoutes.post("/request-key-regeneration", zValidator("json", regenRequestSchema), async (c) => {
  const { email } = c.req.valid("json");
  const db = c.env.DB;

  // Find user
  const user = await db
    .prepare("SELECT id, username, email, status FROM users WHERE email = ? AND deleted_at IS NULL")
    .bind(email)
    .first<{ id: number; username: string; email: string; status: string }>();

  // Regeneration follows the key: it is issuable at `verified` (ADR 0040
  // phase 2), so losing it must be recoverable at `verified` too.
  if (!user || !isActiveAccountStatus(user.status)) {
    // Intentionally vague
    return c.json({
      message: "If an active account exists with this email, a verification link will be sent",
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
    const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
    await sendKeyRegenerationVerificationEmail(
      user.email,
      user.username,
      confirmUrl,
      c.env.RESEND_API_KEY,
      fromEmail,
      replyTo,
      isDev,
      c.env,
    );
  } catch (emailError) {
    console.error("Failed to send key regeneration email:", emailError);
  }

  return c.json({
    message: "If an active account exists with this email, a verification link will be sent",
  });
});

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
       FROM users WHERE verification_token = ? AND deleted_at IS NULL`,
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

  if (!isActiveAccountStatus(user.status)) {
    return c.json(inactiveAccountBody(user.status), 403);
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

  // Return HTML page with the new API key (prevent browser caching)
  c.header("Cache-Control", "no-store, no-cache, must-revalidate");
  c.header("Pragma", "no-cache");
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
