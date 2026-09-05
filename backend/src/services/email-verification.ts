/**
 * Email verification for web accounts (ADR 0040 phase 2, #1252).
 *
 * A web account is created by ORCID sign-up, which proves the person and not
 * the inbox: ORCID never returns an email, so the address is typed into a form
 * and taken on trust. ADR 0040 makes the base tier need both, so a web account
 * lands at `pending` and reaches `verified` by repeating a 6-digit code mailed
 * to that address.
 *
 * Three things live here because more than one route needs each of them:
 * issuing a code, performing the `pending` -> `verified` transition, and
 * telling the admins an account reached `verified`. The email-code sign-in
 * (`POST /auth/code/verify`) proves the same inbox by the same means, so it
 * performs the same transition rather than a similar one.
 *
 * Non-production delivery is fenced, for the reason recorded in AGENTS.md: the
 * dev D1 holds roughly 609 real addresses and the dev worker holds a live
 * RESEND_API_KEY. Outside production a code is only ever issued for a
 * synthetic test address, and there it is echoed in the response instead of
 * mailed — the same rule /auth/email/change/request follows, with no
 * admin/owner bypass, because this endpoint's target is an address chosen by
 * whoever is signed in.
 */

import { auditLogStatement } from "../db/audit-log";
import type { Bindings } from "../types/bindings";
import {
  CODE_TTL_MINUTES,
  PER_HOUR_LIMIT,
  PER_MINUTE_LIMIT,
  USER_BOUND_CODE_INSERT_SQL,
  generateAuthCode,
  hashAuthCode,
  nonProdCodeEchoAllowed,
} from "./auth-code";
import {
  getAdminEmailsForCategory,
  resolveEmailConfig,
  sendAdminNotificationEmail,
  sendEmailVerificationCodeEmail,
} from "./email";

export type VerificationCodeIssue =
  /** A code exists for this address. `devCode` is non-null only outside
   *  production for a synthetic target, where the echo IS the delivery. */
  | { ok: true; devCode: string | null; skipped: false }
  /** Non-production, non-synthetic target: nothing was written and nothing
   *  was sent. Callers report the same shape as success (no enumeration
   *  channel) with a `dev_skip` marker. */
  | { ok: true; devCode: null; skipped: true }
  /** The per-address or per-account bucket is full; no code was written. */
  | { ok: false; error: "rate_limited" }
  /** Resend refused the send. The row is rolled back so the per-minute cap
   *  does not punish the retry. */
  | { ok: false; error: "send_failed" };

function isDevOrTest(env: Bindings): boolean {
  return env.ENVIRONMENT === "development" || env.ENVIRONMENT === "test";
}

/**
 * Mint, store and deliver an email-verification code for `email`, bound to
 * `userId`. `email` must be the account's own address — the redeeming lookup
 * pairs (address, user), and proving that address is the entire point.
 *
 * Never throws for an expected outcome; the two callers want different things
 * from a failure (ORCID sign-up must not fail over an undelivered code, the
 * on-demand endpoint must report 429/503), so the outcome is returned.
 */
export async function issueEmailVerificationCode(
  env: Bindings,
  userId: number,
  email: string,
): Promise<VerificationCodeIssue> {
  const db = env.DB;

  // Fence check BEFORE any code generation or write, like /code/request and
  // /email/change/request: nothing is stored for a target that can never be
  // delivered to, and the timing is the same as an unregistered address.
  const echoOnly = isDevOrTest(env) && nonProdCodeEchoAllowed(email);
  if (isDevOrTest(env) && !echoOnly) {
    return { ok: true, devCode: null, skipped: true };
  }

  const code = generateAuthCode();
  const codeHash = await hashAuthCode(code, env);
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();

  const insertResult = await db
    .prepare(USER_BOUND_CODE_INSERT_SQL)
    .bind(
      email,
      codeHash,
      expiresAt,
      userId,
      email,
      PER_MINUTE_LIMIT,
      email,
      PER_HOUR_LIMIT,
      userId,
      PER_HOUR_LIMIT,
    )
    .run();
  if ((insertResult.meta?.changes ?? 0) === 0) {
    return { ok: false, error: "rate_limited" };
  }
  const newCodeId = insertResult.meta?.last_row_id ?? 0;

  // Rotate this account's earlier codes for the address so a previously
  // mailed code cannot still verify. Scoped by user_id like the email-change
  // rotation: another account's pending code is not ours to invalidate.
  await db
    .prepare(
      `UPDATE auth_codes SET used_at = datetime('now')
        WHERE email = ? AND user_id = ? AND used_at IS NULL AND id != ?`,
    )
    .bind(email, userId, newCodeId)
    .run();

  if (!echoOnly) {
    try {
      const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
      await sendEmailVerificationCodeEmail(
        email,
        code,
        env.RESEND_API_KEY,
        fromEmail,
        replyTo,
        isDev,
        env,
      );
    } catch (emailError) {
      console.error("[email-verification] failed to send verification code email", emailError);
      await db
        .prepare("DELETE FROM auth_codes WHERE id = ?")
        .bind(newCodeId)
        .run()
        .catch((cleanupErr) =>
          console.error("[email-verification] failed to roll back auth_codes row", cleanupErr),
        );
      return { ok: false, error: "send_failed" };
    }
  }

  return { ok: true, devCode: echoOnly ? code : null, skipped: false };
}

/** How the inbox was proved, recorded in the audit row's details so the two
 *  roads to `verified` stay distinguishable after the fact. */
export type EmailVerificationRoute = "verify_endpoint" | "code_signin";

/**
 * Record that an account proved its inbox, and promote it out of `pending`.
 *
 * Two statements rather than one CASE expression, because the CALLER needs to
 * know whether the tier actually moved: the admin notification belongs to the
 * transition, not to every re-proof of an inbox. The conditional UPDATE is
 * what makes that answer race-free and idempotent — only one of two
 * concurrent verifications can match `status = 'pending'`.
 *
 * `approved` and `revoked` rows are never re-tiered; they only ever gain the
 * `email_verified` stamp, which is a fact about the inbox and true regardless
 * of tier.
 *
 * The audit row is written here rather than by the callers so a new road to
 * `verified` cannot arrive without one. It is best-effort: the transition has
 * already committed by then, and failing the request would tell a user their
 * completed verification did not happen.
 */
export async function markEmailVerified(
  db: D1Database,
  userId: number,
  via: EmailVerificationRoute,
): Promise<{ promoted: boolean }> {
  const promote = await db
    .prepare(
      `UPDATE users
          SET status = 'verified',
              email_verified = 1,
              updated_at = datetime('now')
        WHERE id = ? AND status = 'pending' AND deleted_at IS NULL`,
    )
    .bind(userId)
    .run();
  if ((promote.meta?.changes ?? 0) > 0) {
    try {
      await auditLogStatement(db, {
        userId,
        action: "email_verified",
        resourceType: "user",
        resourceId: String(userId),
        details: JSON.stringify({ via, status: "verified" }),
      }).run();
    } catch (err) {
      console.error(
        `AUDIT GAP: email_verified row not written for id=${userId} (the promotion DID commit):`,
        err,
      );
    }
    return { promoted: true };
  }

  await db
    .prepare(
      `UPDATE users
          SET email_verified = 1,
              updated_at = datetime('now')
        WHERE id = ? AND email_verified = 0 AND deleted_at IS NULL`,
    )
    .bind(userId)
    .run();
  return { promoted: false };
}

/**
 * Tell the admins a new account reached `verified` — the same notification a
 * CLI signup triggers from its verification link (routes/auth.ts), fired from
 * the web flow at the equivalent moment.
 *
 * Best-effort by construction: a mail failure must never undo a transition
 * that has already committed. Call it only when `markEmailVerified` reported
 * `promoted`, which is what keeps it to exactly one send per account.
 */
export async function notifyAdminsOfVerifiedAccount(
  env: Bindings,
  user: { id: number; email: string; github_username: string | null; description: string },
): Promise<void> {
  try {
    const adminEmails = await getAdminEmailsForCategory(env.DB, "user_approval");
    if (adminEmails.length === 0) return;
    const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
    await sendAdminNotificationEmail(
      adminEmails,
      {
        id: user.id,
        username: null,
        email: user.email,
        github_username: user.github_username,
        description: user.description,
      },
      env.RESEND_API_KEY,
      fromEmail,
      replyTo,
      isDev,
      env,
    );
  } catch (err) {
    console.error("[email-verification] admin notification failed", err);
  }
}
