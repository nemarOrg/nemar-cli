/**
 * Web-dashboard auth routes (#569).
 *
 * Passwordless 6-digit code flow for the dashboard at nemar.org
 * (moving to app.nemar.org per nemarOrg/website#46). The CLI's
 * password + API-token flow in `auth.ts` is untouched; these routes
 * exist alongside it under the same `/auth` mount.
 *
 *   POST  /auth/code/request          - mail a code
 *   POST  /auth/code/verify           - check the code, set a session cookie
 *   POST  /auth/logout                - clear the cookie + revoke the session row
 *   GET   /auth/me                    - current user, or { user: null }
 *   PATCH /auth/profile               - self-service profile edit (#912)
 *   POST  /auth/email/change/request  - mail an ownership code to a NEW address (#911)
 *   POST  /auth/email/change/verify   - verify it, move users.email (#911)
 *   POST  /auth/email/verify/request  - re-mail the verification code (ADR 0040)
 *   POST  /auth/email/verify          - redeem it: pending -> verified (ADR 0040)
 *   GET   /auth/profile/username-suggestion - a default username (ADR 0042)
 *
 * Notes for readers:
 *   - In development and test environments the `request` response
 *     includes `dev_code` so live-API tests can finish the flow
 *     without an email inbox. Production must never see this field;
 *     a defensive `if (env.ENVIRONMENT === 'production')` guard plus
 *     a corresponding test enforces the boundary.
 *   - Web accounts are created by the ORCID flow (auth-orcid.ts) and land
 *     at `status='pending'` with `email_verified=0` (ADR 0040 phase 2;
 *     the auto-approval that migration 0062 shipped is gone). They reach
 *     `verified` — the base tier — by redeeming an emailed code, either
 *     through /auth/email/verify or through a /auth/code/verify sign-in,
 *     which proves the same inbox by the same means. Upload access is a
 *     separate later grant an admin makes by id via
 *     `POST /admin/approve/by-id/:id` (#1012), since a web row has
 *     `username = NULL` and the username-keyed approve route cannot
 *     address it. The dashboard renders its verify-your-email step while
 *     `status` is `'pending'`.
 *   - Rate limits are enforced inline by counting `auth_codes` rows
 *     in the relevant window: per-email buckets on every request
 *     endpoint, plus a per-account bucket on the two that are
 *     session-bound, /email/change/request and /email/verify/request
 *     (keyed on the 0066 user_id column). No KV / new table —
 *     `idx_auth_codes_email_active` covers the email lookups; the
 *     user_id count is unindexed, which is fine at auth_codes' size.
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { auditLogStatement } from "../db/audit-log";
import { timingSafeEqual } from "../lib/constant-time";
import { webSessionMiddleware } from "../middleware/webSession";
import {
  CODE_TTL_MINUTES,
  MAX_CODE_ATTEMPTS,
  PER_HOUR_LIMIT,
  PER_MINUTE_LIMIT,
  USER_BOUND_CODE_INSERT_SQL,
  USER_BOUND_CODE_LOOKUP_SQL,
  generateAuthCode,
  hashAuthCode,
  maskEmail,
  nonProdCodeEchoAllowed,
  nonProdCodeRequestAllowed,
} from "../services/auth-code";
import {
  resolveEmailConfig,
  sendEmailChangeCodeEmail,
  sendPasswordlessCodeEmail,
} from "../services/email";
import {
  applyEmailVerification,
  issueEmailVerificationCode,
  notifyAdminsOfVerifiedAccount,
} from "../services/email-verification";
import { validateGitHubUsername } from "../services/github";
import { getDatasetsToken } from "../services/github-auth";
import {
  type ProfilePatchInput,
  githubHandleChanged,
  normalizeProfilePatch,
} from "../services/profile";
import {
  isUsernameUniqueViolation,
  pickAvailableUsername,
  suggestUsername,
} from "../services/username";
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  isAllowedOrigin,
  maybeSlideExpiry,
  prepareSessionInsert,
  revokeSession,
} from "../services/web-session";
import { type Bindings, type UserRole, type Variables, parseRole } from "../types/bindings";

export const authWebRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

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
 *   verified|approved -> "active"
 *   pending           -> "pending"
 *   revoked           -> null (caller should refuse the sign-in)
 *
 * `verified` moved to "active" in ADR 0040 phase 2, and the two-state shape
 * survived the move because the second state got a job: "pending" now means
 * exactly one thing the dashboard can act on — verify your email. It used to
 * cover `verified` as well, where the page could only say "wait for an admin"
 * with no button under it. What a dashboard cannot read off this value is
 * whether the account may upload; that is `service_access`, reported
 * separately by publicUser, because an active account is the norm and an
 * upload grant is the exception.
 */
function userStatusForDashboard(internal: string): "active" | "pending" | null {
  if (internal === "approved" || internal === "verified") return "active";
  if (internal === "pending") return "pending";
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
  email_verified: boolean;
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
    // The two things the website needs to render the account's own state,
    // and they are deliberately separate flags rather than more `status`
    // values (ADR 0040): `email_verified` is the step the user can complete
    // themselves and is what "pending" means, `service_access` is the grant
    // only an admin can make. Collapsing them into one enum is what made the
    // old dashboard tell base-tier users to wait for an admin who was never
    // coming (website ADR 0010, epic #1013 — NOT this repo's ADR 0010).
    email_verified: row.email_verified,
    given_name: row.given_name,
    family_name: row.family_name,
    orcid: row.orcid,
    orcid_verified: row.orcid_verified,
    github_username: row.github_username,
    city: row.city,
    country: row.country,
    affiliation: row.affiliation,
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

    // #1008 + #957: echo-eligible non-production recipients (the shared QA
    // account, and every @nemar.test fixture scripts/seed-dev-db.sql and the
    // live passwordless suite create) skip the real send entirely. dev_code
    // below IS their delivery channel, and `.test` is a non-routable
    // IANA-reserved TLD (RFC 2606) a real send could never usefully reach
    // anyway. This also means these flows never depend on
    // DEV_EMAIL_ALLOWLIST (services/email.ts's separate, generic
    // non-production delivery fence) -- belt-and-suspenders so an allowlist
    // gap can never turn a dev/test sign-in the echo would have served into
    // a 503. Admins/owners passed the allowlist above via role, not email,
    // so they are NOT echo-eligible here and still get a real send: the
    // response body is readable by whoever sent the request.
    const echoOnly = isDevOrTest(c.env) && nonProdCodeEchoAllowed(email);

    if (!echoOnly) {
      // Email send. A failure here means the user has no way to receive
      // the code — returning 200 would silently strand them. Roll the
      // auth_codes row back so the per-minute cap doesn't punish the
      // retry, and surface 503 so the frontend can retry / show a
      // useful error rather than wait for a code that never arrives.
      try {
        const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
        await sendPasswordlessCodeEmail(
          email,
          code,
          c.env.RESEND_API_KEY,
          fromEmail,
          replyTo,
          isDev,
          c.env,
        );
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
    }

    const body: Record<string, unknown> = {
      ok: true,
      masked_email: maskEmail(email),
    };
    if (echoOnly) body.dev_code = code;

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

/** The sign-in code lookup. user_id IS NULL: sign-in codes are the
 *  unauthenticated kind (0066). Email-change codes carry the requester's
 *  user_id and are consumed only by /email/change/verify — this filter keeps
 *  the two flows from ever redeeming each other's codes. Exported so the
 *  code-binding test runs the production SQL, not a copy. */
export const SIGNIN_CODE_LOOKUP_SQL = `SELECT id, code_hash, attempts FROM auth_codes
          WHERE email = ? AND user_id IS NULL
            AND used_at IS NULL AND expires_at > datetime('now')
          ORDER BY created_at DESC LIMIT 1`;

authWebRoutes.post("/code/verify", zValidator("json", verifySchema), async (c) => {
  const origin = c.req.header("Origin");
  if (!isAllowedOrigin(origin)) {
    return c.json({ error: "Origin not allowed" }, 403);
  }

  const { email, code, remember } = c.req.valid("json");
  const db = c.env.DB;

  try {
    // This route is UNAUTHENTICATED, so "no such code" and "wrong digits"
    // stay collapsed into one answer: telling an anonymous caller which one
    // it was reveals whether a code is outstanding for that address. The
    // session-bound verify routes distinguish them (see CODE_EXPIRED_BODY),
    // because there the caller already holds the account.
    const row = await db
      .prepare(SIGNIN_CODE_LOOKUP_SQL)
      .bind(email)
      .first<{ id: number; code_hash: string; attempts: number }>();
    if (!row) {
      return c.json({ error: "Invalid or expired code" }, 401);
    }

    const submittedHash = await hashAuthCode(code, c.env);
    if (!timingSafeEqual(submittedHash, row.code_hash)) {
      // Same bookkeeping as the session-bound routes; the count it returns is
      // deliberately not reported here.
      await recordFailedAttempt(db, row);
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
        `SELECT id, email, role, status, email_verified,
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
        // NOT NULL DEFAULT 0 in D1 (0001), so plain number.
        email_verified: number;
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
    const userAgent = c.req.header("User-Agent") ?? null;
    const ip =
      c.req.header("CF-Connecting-IP") ||
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
      null;

    // Mark the email verified AND, if the account was still `pending`, move
    // it to `verified` — the user just proved they control the inbox by
    // repeating a code that was emailed to them, which is the whole content
    // of that transition (ADR 0040 phase 2). Signing in is therefore a second
    // road to the base tier, and the dedicated /auth/email/verify endpoint is
    // the first; whichever a user reaches first, the other becomes a no-op.
    // `approved` and `revoked` rows are never re-tiered by this.
    //
    // The session row goes in the SAME transaction: the code was consumed
    // above and cannot be replayed, so a session INSERT that failed on its
    // own would leave a burned code, a possibly-promoted account, and no way
    // in — and the retry would read "Invalid or expired code". Either the
    // whole sign-in lands or none of it does. The session cookie is minted
    // before the write and only sent once the batch has committed.
    const prepared = await prepareSessionInsert(
      c.env,
      userRow.id,
      remember,
      userAgent,
      ip,
      "email_code",
    );
    let promoted: boolean;
    try {
      ({ promoted } = await applyEmailVerification(db, userRow.id, "code_signin", [
        prepared.statement,
      ]));
    } catch (writeErr) {
      // Distinct from the generic 500 below, and distinct in the log: the
      // operator needs the account id to see what state it is in. Nothing in
      // the batch landed, so the account is exactly as it was — and the code
      // goes back, so the user can simply try the one they already have.
      console.error(
        `[auth-web] /code/verify: sign-in transaction failed after the code was consumed (user id=${userRow.id}); nothing was written, restoring the code`,
        writeErr,
      );
      await restoreConsumedCode(db, row.id, email);
      return c.json(
        {
          error: "sign_in_incomplete",
          message:
            "Your code was accepted but the sign-in could not be completed, so nothing was changed. Try again with the same code, or request a new one.",
        },
        500,
      );
    }

    const user = {
      id: userRow.id,
      email: userRow.email,
      role: parseRole(userRow.role, userRow.email),
      status: promoted ? "verified" : userRow.status,
      email_verified: true,
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

    if (promoted) {
      // Same notification a CLI signup fires from its verification link, at
      // the equivalent moment. Gated on `promoted`, so a returning user
      // signing in for the hundredth time never re-notifies anyone.
      await notifyAdminsOfVerifiedAccount(c.env, {
        id: userRow.id,
        email: userRow.email,
        github_username: userRow.github_username,
        description: "Web sign-up (ORCID); verified via sign-in code.",
      });
    }

    const cookie = buildSessionCookie(prepared.cookieIdRaw, {
      domain: c.env.WEB_SESSION_COOKIE_DOMAIN || undefined,
      maxAgeSeconds: prepared.maxAgeSeconds,
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
// `username` is bounded at 60 rather than at its real 30 so that a 31-character
// attempt is refused by validateUsernameFormat with `username_too_long` — the
// code the website maps to a field message — instead of by zod's issue tree.
// given_name/family_name match signupSchema's 100.
const profilePatchSchema = z.object({
  github_username: z.string().max(60).optional(),
  city: z.string().max(120).optional(),
  country: z.string().max(120).optional(),
  affiliation: z.string().max(200).optional(),
  username: z.string().max(60).optional(),
  given_name: z.string().max(100).optional(),
  family_name: z.string().max(100).optional(),
});

// The schema above and ProfilePatchInput in profile.ts describe the same
// body from two sides (runtime bounds here, field semantics there). They
// cannot share a declaration without the service importing this route, so
// lock them together structurally: the assignment below fails to compile
// (the alias resolves to never) if either side gains, loses, or retypes a
// field the other does not.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const _profilePatchShapesAgree: MutuallyAssignable<
  z.infer<typeof profilePatchSchema>,
  ProfilePatchInput
> = true;

/**
 * Self-service profile edit (#912; nemarOrg/website#135, #301). Accepts any
 * subset of github_username / city / country / affiliation / username /
 * given_name / family_name — see profile.ts for the per-field rules.
 *
 * A changed GitHub handle gets the same three checks as CLI signup: direct
 * dup (COLLATE NOCASE, 409 even when the handle no longer resolves), live
 * existence against the GitHub API, and a canonical-login re-dedup when
 * GitHub normalises what was typed. Re-saving the current handle skips all
 * three so a routine "Save profile" never spends a GitHub call.
 *
 * `username` and the name pair (ADR 0042) are the two fields whose rules
 * depend on the ACCOUNT rather than on the submitted value, so they cost one
 * extra read and are checked together:
 *   - a username may be set while NULL -- at ANY status, including `approved`,
 *     because the 19 web/ORCID rows this phase exists for are approved and
 *     hold NULL, and a first assignment is not a change -- and CHANGED until
 *     an admin approves the account, after which a rename is locked (409
 *     `username_locked`): it is what `nemar admin approve <username>`
 *     addresses and what the dataset repos an approved account owns are
 *     attributed to.
 *   - a name is refused (409 `name_is_orcid_canonical`) while a VERIFIED ORCID
 *     is linked, because ORCID is re-read on every sign-in and would overwrite
 *     the edit. Without a linked iD there is nothing to overwrite it, and ADR
 *     0041 needs the name filled in before that account can publish at all.
 * Re-submitting the current username is a no-op rather than a refusal, for the
 * same reason `githubHandleChanged` exists: the Settings form sends every field
 * on every save, so an approved account must still be able to save its city.
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
        patch.username !== undefined ||
        patch.given_name !== undefined ||
        patch.family_name !== undefined
      ) {
        // One read for both rules, and only when one of them is in the patch:
        // a plain city/country save must not pay for it. `webUser` carries
        // status and orcid_verified already but NOT username, and reading them
        // from one statement keeps the three decisions consistent with each
        // other rather than with two different moments.
        const account = await db
          .prepare(
            "SELECT username, status, orcid, orcid_verified FROM users WHERE id = ? AND deleted_at IS NULL",
          )
          .bind(webUser.id)
          .first<{
            username: string | null;
            status: string;
            orcid: string | null;
            orcid_verified: number;
          }>();
        if (!account) {
          return c.json({ error: "Account not found" }, 403);
        }

        if (patch.username !== undefined) {
          const current = (account.username ?? "").trim();
          if (current.toLowerCase() === patch.username.toLowerCase()) {
            // Same handle, possibly re-cased: not a change, so neither the
            // approval lock nor the uniqueness check applies. Dropped from the
            // patch so a full-form save from an approved account still writes
            // its other fields.
            patch.username = undefined;
          } else if (account.status === "revoked") {
            // Defence in depth, and unreachable today: findSessionByCookieId
            // filters `u.status != 'revoked'`, so a revoked account has no
            // session to PATCH with and is answered 401 by the middleware
            // above. Kept because the alternative -- letting a revoked account
            // rename itself if that filter ever moves -- is the worse failure,
            // and because it says out loud that revocation is not a state
            // profile edits happen in.
            return c.json(
              {
                error: "account_revoked",
                message: "This account is revoked; contact an admin",
              },
              409,
            );
          } else if (current !== "" && account.status === "approved") {
            // The lock is on a CHANGE, not on the field. `current === ""` is
            // the 19 web/ORCID rows this phase exists for: they were approved
            // (or re-approved) while holding NULL, and telling them "your
            // username is fixed once approved" would leave them permanently
            // without one -- which is the exact state ADR 0042 exists to end.
            // A first assignment is not a change, so it is allowed at any
            // status.
            return c.json(
              {
                error: "username_locked",
                message:
                  "Your username is fixed once an admin has approved your account; contact an admin to change it",
              },
              409,
            );
          } else {
            const taken = await db
              .prepare(
                `SELECT id FROM users
                  WHERE username = ? COLLATE NOCASE AND id != ? AND deleted_at IS NULL
                  LIMIT 1`,
              )
              .bind(patch.username, webUser.id)
              .first<{ id: number }>();
            if (taken) {
              return c.json(
                { error: "username_taken", message: "That username is already taken" },
                409,
              );
            }
          }
        }

        if (
          (patch.given_name !== undefined || patch.family_name !== undefined) &&
          account.orcid_verified === 1 &&
          (account.orcid ?? "").trim() !== ""
        ) {
          return c.json(
            {
              error: "name_is_orcid_canonical",
              message:
                "Your name comes from your ORCID record and is refreshed on every sign-in. Update it at orcid.org and sign in again.",
            },
            409,
          );
        }
      }

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

        // #1052: three answers, not two. A 5xx or a transport failure used to
        // arrive as `null` and be reported as "does not exist", which told
        // someone their own handle was wrong and left them editing a correct
        // field. `unavailable` is now its own 503 and the save is not applied.
        const githubLookup = await validateGitHubUsername(
          patch.github_username,
          await getDatasetsToken(c.env),
        );
        if (githubLookup.status === "unavailable") {
          console.error(`[auth-web] /profile GitHub lookup unavailable: ${githubLookup.detail}`);
          return c.json(
            {
              error: "github_unavailable",
              message: "GitHub could not be reached; try again in a few minutes",
            },
            503,
          );
        }
        if (githubLookup.status === "not_found") {
          return c.json(
            {
              error: "invalid_github_username",
              message: `The GitHub username '${patch.github_username}' does not exist`,
            },
            400,
          );
        }
        const githubUser = githubLookup.user;
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
      if (patch.username !== undefined) {
        sets.push("username = ?");
        binds.push(patch.username);
      }
      if (patch.given_name !== undefined) {
        sets.push("given_name = ?");
        binds.push(patch.given_name);
      }
      if (patch.family_name !== undefined) {
        sets.push("family_name = ?");
        binds.push(patch.family_name);
      }

      // Every field in the patch turned out to be a no-op (the only way to get
      // here is re-submitting your own current username). Answer with the
      // current row rather than building `UPDATE users SET  WHERE ...`.
      if (sets.length === 0) {
        const unchanged = await fetchPublicUserById(db, webUser.id);
        if (!unchanged) return c.json({ error: "Account not found" }, 403);
        return c.json({ ok: true, user: unchanged });
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
      const user = await fetchPublicUserById(db, webUser.id);
      if (!user) {
        // Session resolved but the row is gone (tombstoned mid-request).
        return c.json({ error: "Account not found" }, 403);
      }

      return c.json({ ok: true, user });
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
      // The same window for `username`, and the same answer. This one is
      // reachable ONLY as a race: the pre-check above is COLLATE NOCASE while
      // the column's own UNIQUE constraint (migration 0001) is case-sensitive,
      // so anything the constraint would refuse the pre-check has already
      // refused — unless another request claimed the name in between. A
      // case-VARIANT race (`Ada` and `ada` arriving together) slips past both
      // and is what Phase 4's case-insensitive unique index closes.
      if (isUsernameUniqueViolation(err)) {
        return c.json({ error: "username_taken", message: "That username is already taken" }, 409);
      }
      console.error("[auth-web] /profile PATCH failed", err);
      return c.json({ error: "Failed to update profile" }, 500);
    }
  },
);

// ---------------------------------------------------------------
// POST /auth/email/change/{request,verify}
// ---------------------------------------------------------------

const emailChangeVerifySchema = z.object({
  email: z
    .string()
    .email()
    .max(320)
    .transform((e) => e.trim().toLowerCase()),
  code: z.string().regex(/^\d{6}$/, "code must be 6 digits"),
});

/**
 * Burn one guess against an active code and report how many are left.
 *
 * Extracted because the two session-bound verify routes ran identical
 * bookkeeping, and because the count is now part of their answer: a signed-in
 * user checking a code sent to their own address gains nothing from the
 * enumeration-safe vagueness the unauthenticated sign-in path needs. The
 * fifth wrong guess also consumes the code, so `0` remaining means "request a
 * new one", not "one more try".
 */
async function recordFailedAttempt(
  db: D1Database,
  row: { id: number; attempts: number },
): Promise<number> {
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
  return Math.max(0, MAX_CODE_ATTEMPTS - newAttempts);
}

/**
 * Put a just-consumed code back, after the write it was consumed FOR failed.
 *
 * The consume is deliberately its own statement rather than part of the batch
 * — it is the mutual-exclusion gate, and inside the transaction the loser of a
 * race would go on to be promoted and handed a session. The cost is this
 * window: a batch that throws leaves a spent code and nothing else, which
 * would make the user's next attempt read "expired" for a code they had
 * correctly just typed. Restoring it closes that.
 *
 * Skipped when a NEWER code exists for the address: `/…/request` rotates
 * older codes by setting `used_at`, and reviving one behind a rotation would
 * leave two live codes for one inbox. Best-effort — the caller is already on
 * a failure path and a failed restore only costs the user a new code.
 */
async function restoreConsumedCode(db: D1Database, codeId: number, email: string): Promise<void> {
  await db
    .prepare(
      `UPDATE auth_codes SET used_at = NULL
        WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM auth_codes newer WHERE newer.email = ? AND newer.id > ?)`,
    )
    .bind(codeId, email, codeId)
    .run()
    .catch((err) => console.error("[auth-web] failed to restore a consumed code", err));
}

/**
 * The 401 body for a code that is gone — expired, already used, burned by
 * five wrong guesses, or never issued.
 *
 * Deliberately DIFFERENT from the wrong-digits answer on the session-bound
 * routes (#1252 review): collapsing the two told a user re-checking their own
 * inbox to look harder at digits that could never work again. There is no
 * enumeration to protect here — the caller already holds a session for the
 * account the code belongs to. `POST /auth/code/verify`, which is
 * unauthenticated, keeps its single collapsed answer for exactly that reason.
 */
const CODE_EXPIRED_BODY = {
  error: "code_expired",
  message: "That code has expired or has already been used. Request a new one.",
} as const;

/** Re-read a user by id and shape the dashboard payload (same SELECT the
 *  /code/verify path runs by email). Null when the row is gone/tombstoned. */
async function fetchPublicUserById(
  db: D1Database,
  userId: number,
): Promise<ReturnType<typeof publicUser> | null> {
  const row = await db
    .prepare(
      `SELECT id, email, role, status, email_verified,
              given_name, family_name, orcid, orcid_verified,
              github_username, city, country, affiliation, service_access
         FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .bind(userId)
    .first<{
      id: number;
      email: string;
      role: string | null;
      status: string;
      // NOT NULL DEFAULT 0 in D1 (0001), so plain number.
      email_verified: number;
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
  if (!row) return null;
  return publicUser({
    id: row.id,
    email: row.email,
    role: parseRole(row.role, row.email),
    status: row.status,
    email_verified: row.email_verified === 1,
    given_name: row.given_name,
    family_name: row.family_name,
    orcid: row.orcid,
    orcid_verified: row.orcid_verified === 1,
    github_username: row.github_username,
    city: row.city,
    country: row.country,
    affiliation: row.affiliation,
    service_access: row.service_access === 1,
  });
}

/**
 * Self-service email change, step 1 (#911; nemarOrg/website#133). The
 * authenticated user submits a NEW address; a 6-digit code is mailed to that
 * address to prove ownership before anything is written. Reuses the
 * auth_codes table and the /code/request mechanics (atomic rate-limited
 * insert, rotation, rollback-on-send-failure, dev_code echo rules).
 *
 * Purpose-mixing with sign-in codes is structurally impossible, twice over:
 * a change code is only ever issued for an address with NO users row
 * (collisions are refused here), while /code/verify requires a users row for
 * the address; and since 0066 the queries themselves are disjoint — change
 * codes carry the requester's user_id, /code/verify filters user_id IS NULL,
 * and /email/change/verify filters user_id = <session user>.
 */
authWebRoutes.post(
  "/email/change/request",
  webSessionMiddleware,
  zValidator("json", emailSchema),
  async (c) => {
    if (!isAllowedOrigin(c.req.header("Origin"))) {
      return c.json({ error: "Origin not allowed" }, 403);
    }
    const webUser = c.var.webUser;
    if (!webUser) {
      return c.json({ error: "Authentication required" }, 401);
    }
    const { email } = c.req.valid("json");
    const db = c.env.DB;

    try {
      if (email === webUser.email.toLowerCase()) {
        return c.json({ error: "same_email" }, 409);
      }
      // Deliberate, bounded enumeration tradeoff (PR #1053 review): unlike
      // /code/request's #595 silent skip, this DOES tell the caller whether
      // an address is registered — without it, a legitimate rename to a
      // taken address dead-ends on a code that can never verify. The oracle
      // is bounded: caller must hold a session, the route sits in the
      // auth-ip bucket (10/min/IP, rateLimit.ts), and the per-user cap
      // below throttles how fast one account can cycle targets.
      const collision = await db
        .prepare("SELECT id FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1")
        .bind(email)
        .first<{ id: number }>();
      if (collision) {
        return c.json({ error: "email_in_use" }, 409);
      }

      // #1008 analogue: the non-production D1 mirrors real production users,
      // so a staging session must not be able to mail an arbitrary real
      // address — this endpoint targets addresses precisely because they're
      // NOT registered, so /code/request's registered-user allowlist can't
      // apply. Outside production only synthetic test targets get a send,
      // with no role bypass (an admin session must not be a mail-anyone
      // primitive either). Same silent-ok shape as /code/request.
      if (isDevOrTest(c.env) && !nonProdCodeEchoAllowed(email)) {
        return c.json({ ok: true, masked_email: maskEmail(email), dev_skip: "not_allowlisted" });
      }

      const code = generateAuthCode();
      const codeHash = await hashAuthCode(code, c.env);
      const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();

      // Atomic rate-limited INSERT binding the code to THIS session's user:
      // only the account that asked for the change can redeem it, so a second
      // person reading a shared inbox cannot attach the address to their own
      // account by pasting the code first. See USER_BOUND_CODE_INSERT_SQL (services/auth-code.ts).
      const insertResult = await db
        .prepare(USER_BOUND_CODE_INSERT_SQL)
        .bind(
          email,
          codeHash,
          expiresAt,
          webUser.id,
          email,
          PER_MINUTE_LIMIT,
          email,
          PER_HOUR_LIMIT,
          webUser.id,
          PER_HOUR_LIMIT,
        )
        .run();
      if ((insertResult.meta?.changes ?? 0) === 0) {
        return c.json({ error: "Too many requests. Try again later." }, 429);
      }
      const newCodeId = insertResult.meta?.last_row_id ?? 0;

      // Rotate only THIS user's earlier change codes for the address; another
      // user's pending request must not be silently invalidated (their code
      // is unusable by anyone else anyway, per the user_id binding).
      await db
        .prepare(
          `UPDATE auth_codes SET used_at = datetime('now')
            WHERE email = ? AND user_id = ? AND used_at IS NULL AND id != ?`,
        )
        .bind(email, webUser.id, newCodeId)
        .run();

      // #1008 + #957: same echo-skips-the-send reasoning as /code/request
      // above. Every non-production target that reaches this point is
      // already echo-eligible (the early return above admits nothing
      // else), so this is unconditional here -- kept as an explicit check
      // rather than an assumption so this route can never silently start
      // depending on send succeeding for a target the early return widens
      // to admit in the future.
      const echoOnly = isDevOrTest(c.env) && nonProdCodeEchoAllowed(email);

      if (!echoOnly) {
        try {
          const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
          await sendEmailChangeCodeEmail(
            email,
            code,
            c.env.RESEND_API_KEY,
            fromEmail,
            replyTo,
            isDev,
            c.env,
          );
        } catch (emailError) {
          console.error("[auth-web] failed to send email-change code email", emailError);
          await db
            .prepare("DELETE FROM auth_codes WHERE id = ?")
            .bind(newCodeId)
            .run()
            .catch((cleanupErr) =>
              console.error("[auth-web] failed to roll back auth_codes row", cleanupErr),
            );
          return c.json({ error: "Could not deliver the code; try again shortly." }, 503);
        }
      }

      const body: Record<string, unknown> = { ok: true, masked_email: maskEmail(email) };
      if (echoOnly) body.dev_code = code;

      // Same belt-and-braces as /code/request: never ship a code in a
      // production response body.
      if (c.env.ENVIRONMENT === "production" && "dev_code" in body) {
        console.error(
          "[auth-web] FATAL: dev_code present in production response — refusing to ship the response",
        );
        return c.json({ error: "Internal error" }, 500);
      }

      return c.json(body);
    } catch (err) {
      console.error("[auth-web] /email/change/request failed", err);
      return c.json({ error: "Failed to send code" }, 500);
    }
  },
);

/**
 * Self-service email change, step 2 (#911). Verifies the code sent to the
 * new address (same compare/attempts/consume semantics as /code/verify),
 * then moves users.email in the same D1 batch as the audit row. The session
 * cookie is NOT rotated: web_sessions reference the user id, not the email,
 * so every existing session stays valid across the change.
 */
authWebRoutes.post(
  "/email/change/verify",
  webSessionMiddleware,
  zValidator("json", emailChangeVerifySchema),
  async (c) => {
    if (!isAllowedOrigin(c.req.header("Origin"))) {
      return c.json({ error: "Origin not allowed" }, 403);
    }
    const webUser = c.var.webUser;
    if (!webUser) {
      return c.json({ error: "Authentication required" }, 401);
    }
    const { email, code } = c.req.valid("json");
    const db = c.env.DB;

    try {
      if (email === webUser.email.toLowerCase()) {
        return c.json({ error: "same_email" }, 409);
      }
      // Re-check the collision: an account for this address may have been
      // created between request and verify. The users.email UNIQUE
      // constraint below is the authoritative backstop for the write race.
      const collision = await db
        .prepare("SELECT id FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1")
        .bind(email)
        .first<{ id: number }>();
      if (collision) {
        return c.json({ error: "email_in_use" }, 409);
      }

      const row = await db
        .prepare(USER_BOUND_CODE_LOOKUP_SQL)
        .bind(email, webUser.id)
        .first<{ id: number; code_hash: string; attempts: number }>();
      if (!row) {
        return c.json(CODE_EXPIRED_BODY, 401);
      }

      const submittedHash = await hashAuthCode(code, c.env);
      if (!timingSafeEqual(submittedHash, row.code_hash)) {
        const attemptsRemaining = await recordFailedAttempt(db, row);
        return c.json(
          {
            error: "code_incorrect",
            message:
              attemptsRemaining > 0
                ? `That code did not match. ${attemptsRemaining} attempt${attemptsRemaining === 1 ? "" : "s"} left before it is invalidated.`
                : "That code did not match and has now been invalidated. Request a new one.",
            attempts_remaining: attemptsRemaining,
          },
          401,
        );
      }

      // Consume-once, same conditional UPDATE as /code/verify.
      const consumeResult = await db
        .prepare("UPDATE auth_codes SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL")
        .bind(row.id)
        .run();
      if ((consumeResult.meta?.changes ?? 0) === 0) {
        // Lost the race to a concurrent redemption: the code is gone, not
        // wrong.
        return c.json(CODE_EXPIRED_BODY, 401);
      }

      // The change + its audit row in one batch. email_verified=1: the user
      // just proved control of the new inbox. A concurrent claim of the
      // address lands here as a UNIQUE violation -> 409, matching the
      // pre-checks.
      try {
        await db.batch([
          db
            .prepare("UPDATE users SET email = ?, email_verified = 1 WHERE id = ?")
            .bind(email, webUser.id),
          auditLogStatement(db, {
            userId: webUser.id,
            action: "email_changed",
            resourceType: "user",
            resourceId: String(webUser.id),
            details: JSON.stringify({ from: webUser.email, to: email }),
          }),
        ]);
      } catch (writeErr) {
        // Column-scoped, matching the profile PATCH and signup precedents: a
        // UNIQUE hit on anything OTHER than users.email must not be
        // mislabeled as an address collision — rethrow to the generic 500.
        const msg = String(writeErr);
        if (msg.includes("UNIQUE constraint failed") && msg.includes("users.email")) {
          return c.json({ error: "email_in_use" }, 409);
        }
        throw writeErr;
      }

      const user = await fetchPublicUserById(db, webUser.id);
      if (!user) {
        return c.json({ error: "Account not found" }, 403);
      }
      return c.json({ ok: true, user });
    } catch (err) {
      console.error("[auth-web] /email/change/verify failed", err);
      return c.json({ error: "Verification failed" }, 500);
    }
  },
);

// ---------------------------------------------------------------
// POST /auth/email/verify/{request,verify}
// ---------------------------------------------------------------

const emailVerifySchema = z.object({
  code: z.string().regex(/^\d{6}$/, "code must be 6 digits"),
});

/**
 * Email verification, step 1 (ADR 0040 phase 2, #1252). Mails a 6-digit code
 * to the signed-in account's OWN address so it can leave `pending` for
 * `verified`, the base tier.
 *
 * No request body: the target is `users.email` and nothing else, which is
 * what keeps this endpoint from being a mail-anyone primitive. (Changing the
 * address is a different flow with a different code — /email/change/*.)
 *
 * The rate limits, rotation, rollback-on-send-failure and non-production
 * fence all live in issueEmailVerificationCode so this route and ORCID
 * finalize cannot drift on any of them.
 */
authWebRoutes.post("/email/verify/request", webSessionMiddleware, async (c) => {
  if (!isAllowedOrigin(c.req.header("Origin"))) {
    return c.json({ error: "Origin not allowed" }, 403);
  }
  const webUser = c.var.webUser;
  if (!webUser) {
    return c.json({ error: "Authentication required" }, 401);
  }

  try {
    const email = webUser.email.toLowerCase();

    // Nothing to prove. Answering before the rate-limited insert means a
    // double-clicked button on an already-verified account cannot burn the
    // per-minute bucket of a code nobody needs.
    if (webUser.email_verified) {
      return c.json({ ok: true, already_verified: true, masked_email: maskEmail(email) });
    }

    const issued = await issueEmailVerificationCode(c.env, webUser.id, email);
    if (!issued.ok) {
      return issued.error === "rate_limited"
        ? c.json({ error: "Too many requests. Try again later." }, 429)
        : c.json({ error: "Could not deliver the code; try again shortly." }, 503);
    }

    const body: Record<string, unknown> = { ok: true, masked_email: maskEmail(email) };
    if (issued.skipped) body.dev_skip = "not_allowlisted";
    if (issued.devCode) body.dev_code = issued.devCode;

    // Same belt-and-braces as /code/request: never ship a code in a
    // production response body.
    if (c.env.ENVIRONMENT === "production" && "dev_code" in body) {
      console.error(
        "[auth-web] FATAL: dev_code present in production response — refusing to ship the response",
      );
      return c.json({ error: "Internal error" }, 500);
    }
    return c.json(body);
  } catch (err) {
    console.error("[auth-web] /email/verify/request failed", err);
    return c.json({ error: "Failed to send code" }, 500);
  }
});

/**
 * Email verification, step 2 (ADR 0040 phase 2, #1252). Redeems the code from
 * step 1 (same compare / attempts / consume-once semantics as /code/verify),
 * marks the inbox proved, and moves a `pending` account to `verified`.
 *
 * Idempotent by early return rather than by re-consuming a code: a second
 * call from an already-verified account answers 200 with the current user,
 * because a code is single-use and the honest answer to "verify me" when the
 * account is verified is "done", not "invalid code". That also means the
 * admin notification fires exactly once — it is gated on the transition
 * itself (applyEmailVerification's conditional UPDATE), not on reaching this
 * line.
 */
authWebRoutes.post(
  "/email/verify",
  webSessionMiddleware,
  zValidator("json", emailVerifySchema),
  async (c) => {
    if (!isAllowedOrigin(c.req.header("Origin"))) {
      return c.json({ error: "Origin not allowed" }, 403);
    }
    const webUser = c.var.webUser;
    if (!webUser) {
      return c.json({ error: "Authentication required" }, 401);
    }
    const { code } = c.req.valid("json");
    const db = c.env.DB;

    try {
      const email = webUser.email.toLowerCase();

      if (webUser.email_verified) {
        const current = await fetchPublicUserById(db, webUser.id);
        if (!current) return c.json({ error: "Account not found" }, 403);
        return c.json({ ok: true, already_verified: true, user: current });
      }

      const row = await db
        .prepare(USER_BOUND_CODE_LOOKUP_SQL)
        .bind(email, webUser.id)
        .first<{ id: number; code_hash: string; attempts: number }>();
      if (!row) {
        return c.json(CODE_EXPIRED_BODY, 401);
      }

      const submittedHash = await hashAuthCode(code, c.env);
      if (!timingSafeEqual(submittedHash, row.code_hash)) {
        const attemptsRemaining = await recordFailedAttempt(db, row);
        return c.json(
          {
            error: "code_incorrect",
            message:
              attemptsRemaining > 0
                ? `That code did not match. ${attemptsRemaining} attempt${attemptsRemaining === 1 ? "" : "s"} left before it is invalidated.`
                : "That code did not match and has now been invalidated. Request a new one.",
            attempts_remaining: attemptsRemaining,
          },
          401,
        );
      }

      // Consume-once, same conditional UPDATE as /code/verify: two parallel
      // redemptions of one code let exactly one through.
      const consumeResult = await db
        .prepare("UPDATE auth_codes SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL")
        .bind(row.id)
        .run();
      if ((consumeResult.meta?.changes ?? 0) === 0) {
        // Lost the race to a concurrent redemption: gone, not wrong.
        return c.json(CODE_EXPIRED_BODY, 401);
      }

      // Past this point the code is spent. If the write fails, say so
      // precisely: the generic 500 below would send the caller back to a
      // code that can never work again, and the retry would read
      // "code_incorrect" as though they had mistyped it.
      let promoted: boolean;
      try {
        ({ promoted } = await applyEmailVerification(db, webUser.id, "verify_endpoint"));
      } catch (writeErr) {
        console.error(
          `[auth-web] /email/verify: verification write failed after the code was consumed (user id=${webUser.id}); nothing was written, restoring the code`,
          writeErr,
        );
        await restoreConsumedCode(db, row.id, email);
        return c.json(
          {
            error: "verification_incomplete",
            message:
              "Your code was accepted but the change could not be saved, so nothing was changed. Try again with the same code, or request a new one.",
          },
          500,
        );
      }

      if (promoted) {
        await notifyAdminsOfVerifiedAccount(c.env, {
          id: webUser.id,
          email,
          github_username: webUser.github_username,
          description: "Web sign-up (ORCID); verified their email address.",
        });
      }

      const user = await fetchPublicUserById(db, webUser.id);
      if (!user) {
        return c.json({ error: "Account not found" }, 403);
      }
      return c.json({ ok: true, user });
    } catch (err) {
      console.error("[auth-web] /email/verify failed", err);
      return c.json({ error: "Verification failed" }, 500);
    }
  },
);

// ---------------------------------------------------------------
// GET /auth/profile/username-suggestion  (ADR 0042, #1253)
// ---------------------------------------------------------------

/**
 * Offer a default username for an account that has none.
 *
 * First initial plus family name, ASCII-folded and lowercased, with `-2`,
 * `-3`, ... appended past a collision (services/username.ts). It is a
 * SUGGESTION, not a reservation: nothing is written and nothing is held, so
 * two people offered the same base can still race for it at the PATCH — which
 * is exactly what the uniqueness check there is for. Holding a name would mean
 * a table of expiring reservations for a form most people submit in seconds.
 *
 * `{ suggestion: null, based_on: "unavailable" }` when the account has no
 * family name, or when the name folds to nothing usable in ASCII (a record
 * written entirely in a non-Latin script). Nothing is derived from the email
 * local part in that case: a handle nobody chose is worse than a blank field
 * with a prompt (ADR 0042).
 *
 * `"exhausted"` is the other null, and it is a different problem: a default
 * exists and every variant of it is taken. The user sees the same empty field
 * either way, but a saturated base is an operational fact nobody would
 * otherwise see, so it is logged as well as reported.
 *
 * Cookie-authenticated like the rest of the /auth/profile family, and read-only,
 * so it carries no Origin check — same as GET /auth/me.
 */
authWebRoutes.get("/profile/username-suggestion", webSessionMiddleware, async (c) => {
  const webUser = c.var.webUser;
  if (!webUser) {
    return c.json({ error: "Authentication required" }, 401);
  }

  try {
    const base = suggestUsername(webUser.given_name, webUser.family_name);
    if (!base) {
      return c.json({ suggestion: null, based_on: "unavailable" });
    }

    // Deleted rows are INCLUDED on purpose: a tombstone nulls the username
    // (db/user-tombstone.ts) so it holds nothing, but a row that somehow still
    // carries one would hold the UNIQUE index against this suggestion, and
    // suggesting a name the PATCH must then refuse is worse than suffixing it.
    //
    // The LIKE arm can over-match (`alovelace-institute` looks like a suffixed
    // variant and is not one), which only ever makes the taken-set larger and
    // the suggestion later in the sequence — never a collision.
    const rows = await c.env.DB.prepare(
      "SELECT username FROM users WHERE username = ? COLLATE NOCASE OR username LIKE ? ESCAPE '\\'",
    )
      .bind(base, `${base.replace(/[%_\\]/g, "\\$&")}-%`)
      .all<{ username: string | null }>();

    const taken = (rows.results ?? [])
      .map((r) => r.username)
      .filter((u): u is string => typeof u === "string");

    const suggestion = pickAvailableUsername(base, taken);
    if (!suggestion) {
      console.warn(
        `[auth-web] username suggestion exhausted for base "${base}" (${taken.length} variants taken)`,
      );
      return c.json({ suggestion: null, based_on: "exhausted" });
    }
    return c.json({ suggestion, based_on: "name" });
  } catch (err) {
    console.error("[auth-web] /profile/username-suggestion failed", err);
    return c.json({ error: "Failed to suggest a username" }, 500);
  }
});
