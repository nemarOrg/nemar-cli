/**
 * Web-dashboard auth routes (#569).
 *
 * Passwordless 6-digit code flow for the dashboard at nemar.org
 * (moving to app.nemar.org per nemarOrg/website#46). The CLI's
 * password + API-token flow in `auth.ts` is untouched; these routes
 * exist alongside it under the same `/auth` mount.
 *
 *   POST /auth/code/request - mail a code
 *   POST /auth/code/verify  - check the code, set a session cookie
 *   POST /auth/logout       - clear the cookie + revoke the session row
 *   GET  /auth/me           - current user, or { user: null }
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
import { webSessionMiddleware } from "../middleware/webSession";
import {
  constantTimeEqualHex,
  generateAuthCode,
  hashAuthCode,
  maskEmail,
} from "../services/auth-code";
import { resolveEmailConfig, sendPasswordlessCodeEmail } from "../services/email";
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  isAllowedOrigin,
  issueSession,
  maybeSlideExpiry,
  revokeSession,
} from "../services/web-session";
import type { Bindings, Variables } from "../types/bindings";

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
 * Shape the public user payload returned by /verify and /me.
 */
function publicUser(row: { id: number; email: string; role: string | null; status: string }) {
  return {
    id: row.id,
    email: row.email,
    role: row.role ?? "member",
    status: userStatusForDashboard(row.status) ?? row.status,
  };
}

// ---------------------------------------------------------------
// POST /auth/code/request
// ---------------------------------------------------------------

authWebRoutes.post("/code/request", zValidator("json", emailSchema), async (c) => {
  const { email } = c.req.valid("json");
  const db = c.env.DB;

  try {
    // Per-email rate limit. Counted before any row insert so a flood
    // of requests against one address can't outrun the bucket.
    const minuteCount = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM auth_codes
          WHERE email = ? AND created_at > datetime('now','-1 minute')`,
      )
      .bind(email)
      .first<{ n: number }>();
    if ((minuteCount?.n ?? 0) >= PER_MINUTE_LIMIT) {
      return c.json({ error: "Too many requests. Try again in a minute." }, 429);
    }
    const hourCount = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM auth_codes
          WHERE email = ? AND created_at > datetime('now','-1 hour')`,
      )
      .bind(email)
      .first<{ n: number }>();
    if ((hourCount?.n ?? 0) >= PER_HOUR_LIMIT) {
      return c.json({ error: "Too many requests. Try again later." }, 429);
    }

    // Create the user lazily if absent. signup_source='web' marks the
    // row as needing onboarding to fill in username/github_username
    // before it can be approved. Existing users (CLI signup or
    // earlier web signup) are not modified here.
    const existing = await db
      .prepare("SELECT id, status FROM users WHERE email = ? LIMIT 1")
      .bind(email)
      .first<{ id: number; status: string }>();
    if (!existing) {
      await db
        .prepare(`INSERT INTO users (email, status, signup_source) VALUES (?, 'pending', 'web')`)
        .bind(email)
        .run();
    } else if (existing.status === "revoked") {
      // Don't tip off the requester (no enumeration leak), just don't
      // mail a code and don't return 200-but-no-email. The masked
      // response is still 200 to look identical to the success path.
      return c.json(
        isDevOrTest(c.env)
          ? { ok: true, masked_email: maskEmail(email), dev_skip: "revoked" }
          : { ok: true, masked_email: maskEmail(email) },
      );
    }

    // Rotate any active code for this email before inserting a new
    // one — keeps "I clicked twice" UX from getting the wrong code,
    // but invalidates the in-flight code so an attacker can't race.
    await db
      .prepare(
        `UPDATE auth_codes SET used_at = datetime('now')
          WHERE email = ? AND used_at IS NULL`,
      )
      .bind(email)
      .run();

    const code = generateAuthCode();
    const codeHash = await hashAuthCode(code, c.env);
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();
    await db
      .prepare("INSERT INTO auth_codes (email, code_hash, expires_at) VALUES (?, ?, ?)")
      .bind(email, codeHash, expiresAt)
      .run();

    // Best-effort email send. Mirrors auth.ts:269 — a failed send
    // does not propagate; the user can request another code.
    try {
      const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
      await sendPasswordlessCodeEmail(email, code, c.env.RESEND_API_KEY, fromEmail, replyTo, isDev);
    } catch (emailError) {
      console.error("[auth-web] failed to send passwordless code email", emailError);
    }

    const body: Record<string, unknown> = {
      ok: true,
      masked_email: maskEmail(email),
    };
    if (isDevOrTest(c.env)) body.dev_code = code;

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

    // Mark code consumed.
    await db
      .prepare(`UPDATE auth_codes SET used_at = datetime('now') WHERE id = ?`)
      .bind(row.id)
      .run();

    const user = await db
      .prepare("SELECT id, email, role, status FROM users WHERE email = ? LIMIT 1")
      .bind(email)
      .first<{ id: number; email: string; role: string | null; status: string }>();
    if (!user) {
      // Should be impossible — /code/request creates the row. Treat
      // as a server-side anomaly.
      console.error(`[auth-web] /code/verify: code matched for ${email} but no users row found`);
      return c.json({ error: "Account not found" }, 500);
    }
    if (user.status === "revoked") {
      return c.json({ error: "Account revoked" }, 403);
    }

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
  await revokeSession(c.env, cookieIdRaw);

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
