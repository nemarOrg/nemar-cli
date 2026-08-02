/**
 * Web-dashboard auth routes (#569).
 *
 * Passwordless 6-digit code flow for the dashboard at nemar.org
 * (moving to app.nemar.org per nemarOrg/website#46). The CLI's
 * password + API-token flow in `auth.ts` is untouched; these routes
 * exist alongside it under the same `/auth` mount.
 *
 *   POST  /auth/code/request - mail a code
 *   POST  /auth/code/verify  - check the code, set a session cookie
 *   POST  /auth/logout       - clear the cookie + revoke the session row
 *   GET   /auth/me           - current user, or { user: null }
 *   PATCH /auth/profile      - self-service profile edit (#912)
 *
 * Notes for readers:
 *   - In development and test environments the `request` response
 *     includes `dev_code` so live-API tests can finish the flow
 *     without an email inbox. Production must never see this field;
 *     a defensive `if (env.ENVIRONMENT === 'production')` guard plus
 *     a corresponding test enforces the boundary.
 *   - First-time email-only signups land as `status='pending'`
 *     `signup_source='web'`. Admin approval (out of scope here) lifts
 *     them to `'approved'`. Until then the dashboard sees
 *     `status: 'pending'` and can render an onboarding screen.
 *   - Per-email rate limit is enforced inline by counting
 *     `auth_codes` rows in the relevant window. No KV / new table —
 *     `idx_auth_codes_email_active` covers the lookup.
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { auditLogStatement } from "../db/audit-log";
import { webSessionMiddleware } from "../middleware/webSession";
import {
  constantTimeEqualHex,
  generateAuthCode,
  hashAuthCode,
  maskEmail,
  nonProdCodeEchoAllowed,
  nonProdCodeRequestAllowed,
} from "../services/auth-code";
import { resolveEmailConfig, sendPasswordlessCodeEmail } from "../services/email";
import { validateGitHubUsername } from "../services/github";
import { getDatasetsToken } from "../services/github-auth";
import { githubHandleChanged, normalizeProfilePatch } from "../services/profile";
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  isAllowedOrigin,
  issueSession,
  maybeSlideExpiry,
  revokeSession,
} from "../services/web-session";
import { type Bindings, type UserRole, type Variables, parseRole } from "../types/bindings";

export const authWebRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const CODE_TTL_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;
const PER_MINUTE_LIMIT = 1;
const PER_HOUR_LIMIT = 5;

const emailSchema = z.object({
  email: z
    .string()
    .email()
    .max(320)
    .transform((e) => e.trim().toLowerCase()),
});

const verifySchema = z.object({
  email: z
    .string()
    .email()
    .max(320)
    .transform((e) => e.trim().toLowerCase()),
  code: z.string().regex(/^\d{6}$/, "code must be 6 digits"),
  remember: z.boolean(),
});

function isDevOrTest(env: Bindings): boolean {
  return env.ENVIRONMENT === "development" || env.ENVIRONMENT === "test";
}

/**
 * Map internal user.status to the dashboard-facing two-state value.
 *   approved        -> "active"
 *   pending|verified -> "pending"
 *   revoked          -> null (caller should refuse the sign-in)
 */
function userStatusForDashboard(internal: string): "active" | "pending" | null {
  if (internal === "approved") return "active";
  if (internal === "pending" || internal === "verified") return "pending";
  return null; // revoked or unknown
}

/**
 * Shape the public user payload returned by /verify and /me. `role`
 * is the validated `UserRole` from the DB; null falls back to
 * 'member' for the dashboard payload so the frontend always sees a
 * value it can switch on. Profile fields (#910) are nullable
 * passthroughs — the website treats each as optional and renders its
 * "not set" state on null.
 */
function publicUser(row: {
  id: number;
  email: string;
  role: UserRole | null;
  status: string;
  given_name: string | null;
  family_name: string | null;
  orcid: string | null;
  orcid_verified: boolean;
  github_username: string | null;
  city: string | null;
  country: string | null;
  affiliation: string | null;
  service_access: boolean;
}) {
  return {
    id: row.id,
    email: row.email,
    role: row.role ?? "member",
    status: userStatusForDashboard(row.status) ?? row.status,
    given_name: row.given_name,
    family_name: row.family_name,
    orcid: row.orcid,
    orcid_verified: row.orcid_verified,
    github_username: row.github_username,
    city: row.city,
    country: row.country,
    affiliation: row.affiliation,
    // Tiered access (ADR 0010): base accounts are false until an admin
    // grants service (upload + compute) access.
    service_access: row.service_access,
  };
}

// ---------------------------------------------------------------
// POST /auth/code/request
// ---------------------------------------------------------------

authWebRoutes.post("/code/request", zValidator("json", emailSchema), async (c) => {
  const { email } = c.req.valid("json");
  const db = c.env.DB;

  try {
    // #595: only ever email a code to an address that already has a
    // users row. Previously this endpoint INSERT-OR-IGNOREd a phantom
    // 'pending'/'web' row for any valid-looking email and shipped a
    // code, so a typo'd address still triggered a real Resend send
    // ("you have a NEMAR account") and littered the users table with
    // rows that could never sign in. Account creation now flows
    // through the CLI (`nemar auth signup`) exclusively; the dashboard
    // hint points typo'd users at docs.nemar.org/installation.
    //
    // Option B from #595 (silent skip): respond with the same 200 +
    // masked_email shape whether the email is registered or not, but
    // omit the email send. Pros: no account-enumeration channel via
    // status code, and timing is consistent because we exit early
    // BEFORE any code generation / hashing work. Cons: typo'd emails
    // silently fail; the dashboard surfaces an "if your email is on
    // file, you'll get a code shortly" copy and a CTA pointing typo'd
    // users at the CLI sign-up (companion issue on nemarOrg/website).
    const existing = await db
      .prepare("SELECT status, role FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1")
      .bind(email)
      .first<{ status: string; role: string | null }>();

    if (!existing) {
      return c.json(
        isDevOrTest(c.env)
          ? { ok: true, masked_email: maskEmail(email), dev_skip: "unregistered" }
          : { ok: true, masked_email: maskEmail(email) },
      );
    }

    if (existing.status === "revoked") {
      // Don't tip off the requester (no enumeration leak). The masked
      // response is the same 200 shape as the success path.
      return c.json(
        isDevOrTest(c.env)
          ? { ok: true, masked_email: maskEmail(email), dev_skip: "revoked" }
          : { ok: true, masked_email: maskEmail(email) },
      );
    }

    // #1008: the non-production D1 mirrors real production users, and
    // non-production responses echo `dev_code` below. Only issue codes
    // for admins/owners and the synthetic test accounts; everyone else
    // gets the same silent-ok shape as an unregistered address. Exits
    // BEFORE code generation and the Resend send, like the #595 paths.
    if (isDevOrTest(c.env) && !nonProdCodeRequestAllowed(existing.role, email)) {
      return c.json({ ok: true, masked_email: maskEmail(email), dev_skip: "not_allowlisted" });
    }

    const code = generateAuthCode();
    const codeHash = await hashAuthCode(code, c.env);
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();

    // Atomic rate-limited INSERT. SELECT-then-INSERT had a race window
    // where two concurrent requests both passed the gate before either
    // wrote a row. `INSERT … SELECT … WHERE (count subquery) < limit`
    // is a single D1 statement; under SQLite's serialised write
    // semantics only one of two concurrent requests can satisfy the
    // WHERE, the other's `changes()` returns 0.
    const insertResult = await db
      .prepare(
        `INSERT INTO auth_codes (email, code_hash, expires_at)
         SELECT ?, ?, ?
         WHERE (SELECT COUNT(*) FROM auth_codes
                 WHERE email = ?
                   AND created_at > datetime('now','-1 minute')) < ?
           AND (SELECT COUNT(*) FROM auth_codes
                 WHERE email = ?
                   AND created_at > datetime('now','-1 hour')) < ?`,
      )
      .bind(email, codeHash, expiresAt, email, PER_MINUTE_LIMIT, email, PER_HOUR_LIMIT)
      .run();
    if ((insertResult.meta?.changes ?? 0) === 0) {
      return c.json({ error: "Too many requests. Try again later." }, 429);
    }
    const newCodeId = insertResult.meta?.last_row_id ?? 0;

    // Invalidate any earlier active codes for this email so a previous
    // in-flight code can't still verify. Excludes the just-inserted
    // row by id so we never invalidate our own code.
    await db
      .prepare(
        `UPDATE auth_codes SET used_at = datetime('now')
          WHERE email = ? AND used_at IS NULL AND id != ?`,
      )
      .bind(email, newCodeId)
      .run();

    // Email send. A failure here means the user has no way to receive
    // the code — returning 200 would silently strand them. Roll the
    // auth_codes row back so the per-minute cap doesn't punish the
    // retry, and surface 503 so the frontend can retry / show a
    // useful error rather than wait for a code that never arrives.
    try {
      const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
      await sendPasswordlessCodeEmail(email, code, c.env.RESEND_API_KEY, fromEmail, replyTo, isDev);
    } catch (emailError) {
      console.error("[auth-web] failed to send passwordless code email", emailError);
      await db
        .prepare("DELETE FROM auth_codes WHERE id = ?")
        .bind(newCodeId)
        .run()
        .catch((cleanupErr) =>
          console.error("[auth-web] failed to roll back auth_codes row", cleanupErr),
        );
      return c.json({ error: "Could not deliver sign-in code; try again shortly." }, 503);
    }

    const body: Record<string, unknown> = {
      ok: true,
      masked_email: maskEmail(email),
    };
    // #1008: echo only for synthetic accounts. Admins/owners passed the
    // allowlist above but must read their code from the actual email —
    // the response body is readable by whoever sent the request.
    if (isDevOrTest(c.env) && nonProdCodeEchoAllowed(email)) body.dev_code = code;

    // Final belt-and-braces: never leak the code in production. If
    // ENVIRONMENT is misconfigured at deploy time, this assertion
    // turns the bug into a 500 instead of an exfiltration.
    if (c.env.ENVIRONMENT === "production" && "dev_code" in body) {
      console.error(
        "[auth-web] FATAL: dev_code present in production response — refusing to ship the response",
      );
      return c.json({ error: "Internal error" }, 500);
    }

    return c.json(body);
  } catch (err) {
    console.error("[auth-web] /code/request failed", err);
    return c.json({ error: "Failed to send code" }, 500);
  }
});

// ---------------------------------------------------------------
// POST /auth/code/verify
// ---------------------------------------------------------------

authWebRoutes.post("/code/verify", zValidator("json", verifySchema), async (c) => {
  const origin = c.req.header("Origin");
  if (!isAllowedOrigin(origin)) {
    return c.json({ error: "Origin not allowed" }, 403);
  }

  const { email, code, remember } = c.req.valid("json");
  const db = c.env.DB;

  try {
    const row = await db
      .prepare(
        `SELECT id, code_hash, attempts FROM auth_codes
          WHERE email = ? AND used_at IS NULL AND expires_at > datetime('now')
          ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(email)
      .first<{ id: number; code_hash: string; attempts: number }>();
    if (!row) {
      return c.json({ error: "Invalid or expired code" }, 401);
    }

    const submittedHash = await hashAuthCode(code, c.env);
    if (!constantTimeEqualHex(submittedHash, row.code_hash)) {
      const newAttempts = row.attempts + 1;
      if (newAttempts >= MAX_CODE_ATTEMPTS) {
        await db
          .prepare(`UPDATE auth_codes SET attempts = ?, used_at = datetime('now') WHERE id = ?`)
          .bind(newAttempts, row.id)
          .run();
      } else {
        await db
          .prepare("UPDATE auth_codes SET attempts = ? WHERE id = ?")
          .bind(newAttempts, row.id)
          .run();
      }
      return c.json({ error: "Invalid or expired code" }, 401);
    }

    // Consume the code via a conditional UPDATE that succeeds only
    // while `used_at IS NULL`. Two parallel verifies that both pass
    // the hash compare would otherwise both issue sessions; the
    // conditional update lets exactly one win and the other gets 401.
    const consumeResult = await db
      .prepare("UPDATE auth_codes SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL")
      .bind(row.id)
      .run();
    if ((consumeResult.meta?.changes ?? 0) === 0) {
      // Lost the race to a concurrent verify, or another path
      // invalidated the code between SELECT and here. Refuse without
      // leaking the cause.
      return c.json({ error: "Invalid or expired code" }, 401);
    }

    const userRow = await db
      .prepare(
        `SELECT id, email, role, status,
                given_name, family_name, orcid, orcid_verified,
                github_username, city, country, affiliation, service_access
           FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .bind(email)
      .first<{
        id: number;
        email: string;
        role: string | null;
        status: string;
        given_name: string | null;
        family_name: string | null;
        orcid: string | null;
        // NOT NULL DEFAULT 0 in D1 (0050), so plain number.
        orcid_verified: number;
        github_username: string | null;
        city: string | null;
        country: string | null;
        affiliation: string | null;
        // NOT NULL DEFAULT 0 in D1 (0062), so plain number.
        service_access: number;
      }>();
    if (!userRow) {
      // No live users row for a matched code. Normally impossible
      // (/code/request creates the row), but it now happens cleanly when the
      // account was tombstoned after a code was issued: the masked email no
      // longer matches the original, and deleted_at excludes the row. Deny
      // (the tombstone also expires outstanding codes; this is belt-and-suspenders).
      return c.json({ error: "Account not found" }, 403);
    }
    if (userRow.status === "revoked") {
      return c.json({ error: "Account revoked" }, 403);
    }
    const user = {
      id: userRow.id,
      email: userRow.email,
      role: parseRole(userRow.role, userRow.email),
      status: userRow.status,
      given_name: userRow.given_name,
      family_name: userRow.family_name,
      orcid: userRow.orcid,
      orcid_verified: userRow.orcid_verified === 1,
      github_username: userRow.github_username,
      city: userRow.city,
      country: userRow.country,
      affiliation: userRow.affiliation,
      service_access: userRow.service_access === 1,
    };

    // Mark email as verified — the user just proved they control the
    // inbox by repeating a code that was emailed to them. This is the
    // web-flow analogue of the CLI's email verification step. NOOP for
    // users already at email_verified=1.
    await db
      .prepare("UPDATE users SET email_verified = 1 WHERE email = ? AND email_verified = 0")
      .bind(email)
      .run();

    const userAgent = c.req.header("User-Agent") ?? null;
    const ip =
      c.req.header("CF-Connecting-IP") ||
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
      null;

    const { cookieIdRaw, maxAgeSeconds } = await issueSession(
      c.env,
      user.id,
      remember,
      userAgent,
      ip,
      "email_code",
    );

    const cookie = buildSessionCookie(cookieIdRaw, {
      domain: c.env.WEB_SESSION_COOKIE_DOMAIN || undefined,
      maxAgeSeconds,
    });
    c.header("Set-Cookie", cookie);

    return c.json({ user: publicUser(user) });
  } catch (err) {
    console.error("[auth-web] /code/verify failed", err);
    return c.json({ error: "Verification failed" }, 500);
  }
});

// ---------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------

authWebRoutes.post("/logout", webSessionMiddleware, async (c) => {
  const origin = c.req.header("Origin");
  // Logout still requires a valid origin so a third-party page can't
  // forcibly sign the user out via a hidden form post.
  if (!isAllowedOrigin(origin)) {
    return c.json({ error: "Origin not allowed" }, 403);
  }

  const cookieIdRaw = c.var.webSessionCookieId ?? null;
  // Always clear the cookie client-side, even if the server-side
  // revoke fails (D1 transient, etc.). The user asked to sign out;
  // we honour that locally and log the server-side failure so an
  // operator can clean up the lingering web_sessions row later.
  try {
    await revokeSession(c.env, cookieIdRaw);
  } catch (err) {
    console.error("[auth-web] /logout: revokeSession failed; clearing cookie anyway", err);
  }

  c.header("Set-Cookie", buildClearedSessionCookie(c.env.WEB_SESSION_COOKIE_DOMAIN || undefined));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------
// GET /auth/me
// ---------------------------------------------------------------

authWebRoutes.get("/me", webSessionMiddleware, async (c) => {
  const webUser = c.var.webUser;
  const session = c.var.webSession;
  if (!webUser || !session) {
    return c.json({ user: null });
  }

  // Slide expiry for long-lived sessions whose remaining lifetime
  // dropped below the refresh threshold. Re-issues Set-Cookie only
  // when the wall-clock actually moves.
  const slid = await maybeSlideExpiry(c.env, session);
  if (slid && c.var.webSessionCookieId) {
    c.header(
      "Set-Cookie",
      buildSessionCookie(c.var.webSessionCookieId, {
        domain: c.env.WEB_SESSION_COOKIE_DOMAIN || undefined,
        maxAgeSeconds: slid.maxAgeSeconds,
      }),
    );
  }

  return c.json({ user: publicUser(webUser) });
});

// ---------------------------------------------------------------
// PATCH /auth/profile
// ---------------------------------------------------------------

// Loose shape bounds only; the field semantics (trim, @-strip, non-empty
// city/country, empty-string-clears) live in normalizeProfilePatch so they
// are unit-testable. Bounds match finalizeSchema in auth-orcid.ts where the
// same columns are first written (city/country 120, affiliation 200).
const profilePatchSchema = z.object({
  github_username: z.string().max(60).optional(),
  city: z.string().max(120).optional(),
  country: z.string().max(120).optional(),
  affiliation: z.string().max(200).optional(),
});

/**
 * Self-service profile edit (#912; nemarOrg/website#135). Accepts any subset
 * of github_username / city / country / affiliation — see profile.ts for the
 * per-field rules. Name is ORCID-canonical (#835) and not editable here.
 *
 * A changed GitHub handle gets the same three checks as CLI signup: direct
 * dup (COLLATE NOCASE, 409 even when the handle no longer resolves), live
 * existence against the GitHub API, and a canonical-login re-dedup when
 * GitHub normalises what was typed. Re-saving the current handle skips all
 * three so a routine "Save profile" never spends a GitHub call.
 */
authWebRoutes.patch(
  "/profile",
  webSessionMiddleware,
  zValidator("json", profilePatchSchema),
  async (c) => {
    if (!isAllowedOrigin(c.req.header("Origin"))) {
      return c.json({ error: "Origin not allowed" }, 403);
    }
    const webUser = c.var.webUser;
    if (!webUser) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const normalized = normalizeProfilePatch(c.req.valid("json"));
    if (!normalized.ok) {
      return c.json({ error: normalized.error, message: normalized.message }, 400);
    }
    const patch = normalized.patch;
    const db = c.env.DB;

    try {
      if (
        typeof patch.github_username === "string" &&
        githubHandleChanged(patch.github_username, webUser.github_username)
      ) {
        const dup = await db
          .prepare(
            `SELECT id FROM users
              WHERE github_username = ? COLLATE NOCASE AND id != ? AND deleted_at IS NULL
              LIMIT 1`,
          )
          .bind(patch.github_username, webUser.id)
          .first<{ id: number }>();
        if (dup) {
          return c.json(
            { error: "github_in_use", message: "GitHub account already linked to another user" },
            409,
          );
        }

        // Known limitation shared with CLI signup: validateGitHubUsername
        // returns null for any non-OK GitHub response, so a GitHub-side
        // outage reads as "does not exist" here rather than a 5xx.
        const githubUser = await validateGitHubUsername(
          patch.github_username,
          await getDatasetsToken(c.env),
        );
        if (!githubUser) {
          return c.json(
            {
              error: "invalid_github_username",
              message: `The GitHub username '${patch.github_username}' does not exist`,
            },
            400,
          );
        }
        // GitHub resolves renames/case variants to a canonical login; store
        // that, and re-run the dup check when it differs from what was typed
        // beyond case (the COLLATE NOCASE check above already covered case).
        if (githubUser.login.toLowerCase() !== patch.github_username.toLowerCase()) {
          const canonicalDup = await db
            .prepare(
              `SELECT id FROM users
                WHERE github_username = ? COLLATE NOCASE AND id != ? AND deleted_at IS NULL
                LIMIT 1`,
            )
            .bind(githubUser.login, webUser.id)
            .first<{ id: number }>();
          if (canonicalDup) {
            return c.json(
              { error: "github_in_use", message: "GitHub account already linked to another user" },
              409,
            );
          }
        }
        patch.github_username = githubUser.login;
      }

      const sets: string[] = [];
      const binds: (string | null)[] = [];
      if (patch.github_username !== undefined) {
        sets.push("github_username = ?");
        binds.push(patch.github_username);
      }
      if (patch.city !== undefined) {
        sets.push("city = ?");
        binds.push(patch.city);
      }
      if (patch.country !== undefined) {
        sets.push("country = ?");
        binds.push(patch.country);
      }
      if (patch.affiliation !== undefined) {
        sets.push("affiliation = ?");
        binds.push(patch.affiliation);
      }

      // One D1 batch == one implicit transaction: the update and its audit
      // row land together. Details carry the new values — profile fields,
      // not secrets — so an admin can reconstruct what changed.
      await db.batch([
        db
          .prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ? AND deleted_at IS NULL`)
          .bind(...binds, webUser.id),
        auditLogStatement(db, {
          userId: webUser.id,
          action: "profile_updated",
          resourceType: "user",
          resourceId: String(webUser.id),
          details: JSON.stringify(patch),
        }),
      ]);

      // Re-read so the response reflects what actually landed (the website
      // also re-reads /auth/me on reload; this keeps both in agreement).
      const row = await db
        .prepare(
          `SELECT id, email, role, status,
                  given_name, family_name, orcid, orcid_verified,
                  github_username, city, country, affiliation, service_access
             FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        )
        .bind(webUser.id)
        .first<{
          id: number;
          email: string;
          role: string | null;
          status: string;
          given_name: string | null;
          family_name: string | null;
          orcid: string | null;
          // NOT NULL DEFAULT 0 in D1 (0050), so plain number.
          orcid_verified: number;
          github_username: string | null;
          city: string | null;
          country: string | null;
          affiliation: string | null;
          // NOT NULL DEFAULT 0 in D1 (0062), so plain number.
          service_access: number;
        }>();
      if (!row) {
        // Session resolved but the row is gone (tombstoned mid-request).
        return c.json({ error: "Account not found" }, 403);
      }

      return c.json({
        ok: true,
        user: publicUser({
          id: row.id,
          email: row.email,
          role: parseRole(row.role, row.email),
          status: row.status,
          given_name: row.given_name,
          family_name: row.family_name,
          orcid: row.orcid,
          orcid_verified: row.orcid_verified === 1,
          github_username: row.github_username,
          city: row.city,
          country: row.country,
          affiliation: row.affiliation,
          service_access: row.service_access === 1,
        }),
      });
    } catch (err) {
      // Safety net for the TOCTOU window past the dedup SELECTs: two
      // concurrent PATCHes claiming the same free handle both pass the
      // pre-check, and the loser's UPDATE hits idx_users_github (0012,
      // COLLATE NOCASE). Same net CLI signup carries in auth.ts.
      const msg = String(err);
      if (msg.includes("UNIQUE constraint failed") && msg.includes("users.github_username")) {
        return c.json(
          { error: "github_in_use", message: "GitHub account already linked to another user" },
          409,
        );
      }
      console.error("[auth-web] /profile PATCH failed", err);
      return c.json({ error: "Failed to update profile" }, 500);
    }
  },
);
