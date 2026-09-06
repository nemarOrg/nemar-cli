/**
 * User routes
 *
 * Handles authenticated user operations.
 *
 * `POST /me/upload-access/request` (ADR 0042, #1253) lives here rather than in
 * auth-web.ts for one reason: this router mounts `authMiddleware`, which
 * accepts BOTH the CLI's bearer token and the dashboard's `nemar_session`
 * cookie, and the request has to be makeable from either. The auth-web routes
 * mount `webSessionMiddleware` and are cookie-only by design.
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { auditLogStatement } from "../db/audit-log";
import { authMiddleware } from "../middleware/auth";
import {
  getAdminEmailsForCategory,
  resolveEmailConfig,
  sendUploadAccessRequestEmail,
} from "../services/email";
import { validateGitHubUsername } from "../services/github";
import { getDatasetsToken } from "../services/github-auth";
import {
  ALREADY_APPROVED_REFUSAL,
  WHY_MAX_CHARS,
  checkUploadAccessRequest,
  githubUnverifiedRefusal,
} from "../services/upload-access";
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
      service_access,
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
      service_access: number;
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
      role: user.role,
      orcid: user.orcid || null,
      created_at: userDetails?.created_at,
      approved_at: userDetails?.approved_at,
      dataset_count: userDetails?.dataset_count || 0,
      sandbox_completed: !!userDetails?.sandbox_completed,
      sandbox_completed_at: userDetails?.sandbox_completed_at,
      sandbox_dataset_id: userDetails?.sandbox_dataset_id,
      // Tiered access (website ADR 0010): admin-granted permission to upload/compute.
      service_access: !!userDetails?.service_access,
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

// ---------------------------------------------------------------
// POST /users/me/upload-access/request  (ADR 0042, #1253)
// ---------------------------------------------------------------

/**
 * Bounds only. The 20-character minimum, the trim, and every account-state
 * precondition live in services/upload-access.ts so they answer with the typed
 * `{ error, message, missing }` shape the website renders -- zValidator's own
 * 400 body is a zod issue tree, which no client of this endpoint reads.
 * `WHY_MAX_CHARS * 4` is a transport bound, not the rule: it stops a megabyte
 * of text at the door while leaving the real limit to the one place that
 * reports it properly.
 */
const uploadAccessRequestSchema = z.object({
  why: z
    .string()
    .max(WHY_MAX_CHARS * 4)
    .optional()
    .default(""),
});

/**
 * Ask for upload access, once (ADR 0042).
 *
 * The account row carries the whole request: `upload_access_requested_at` is
 * when, `description` is why, and `service_access` is whether an admin has
 * since answered. There is no request table because there is no second
 * request -- approval closes this one permanently and revocation is an admin
 * action with its own audit trail, not a re-opening.
 *
 * Three outcomes:
 *   201 + `{ ok: true }`                the request was opened and mailed
 *   200 + `{ already_requested: true }` one is already open; NOT re-mailed
 *   409 `already_approved`              the grant is already held
 *
 * Idempotency is enforced by the conditional UPDATE, not by the SELECT above
 * it: `WHERE upload_access_requested_at IS NULL` means exactly one of two
 * concurrent requests writes the stamp, and `changes` is what decides which
 * one sends the email. A pre-check alone would let a double-clicked button mail
 * every admin twice.
 */
userRoutes.post(
  "/me/upload-access/request",
  zValidator("json", uploadAccessRequestSchema),
  async (c) => {
    const authUser = c.get("user");
    const db = c.env.DB;
    const { why } = c.req.valid("json");
    const text = why.trim();

    try {
      const row = await db
        .prepare(
          `SELECT id, username, email, given_name, family_name, github_username,
                  city, country, affiliation, orcid, email_verified, service_access,
                  upload_access_requested_at
             FROM users
            WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(authUser.id)
        .first<{
          id: number;
          username: string | null;
          email: string;
          given_name: string | null;
          family_name: string | null;
          github_username: string | null;
          city: string | null;
          country: string | null;
          affiliation: string | null;
          orcid: string | null;
          email_verified: number;
          service_access: number;
          upload_access_requested_at: string | null;
        }>();

      if (!row) {
        // The credential resolved but the row is gone (tombstoned mid-request).
        return c.json({ error: "Account not found" }, 403);
      }

      // Checked on `service_access` rather than on `status`: the grant is the
      // thing being requested, and the gate that would refuse an upload reads
      // that column too (services/upload-gate.ts). ADR 0040 makes the two
      // equivalent, but only one of them is what this endpoint is about.
      if (row.service_access === 1) {
        return c.json(ALREADY_APPROVED_REFUSAL, 409);
      }

      // Answered BEFORE the preconditions: an open request is already on an
      // admin's desk, and telling its owner to go fix their profile would
      // imply the request had failed.
      if (row.upload_access_requested_at) {
        return c.json({
          ok: true,
          already_requested: true,
          requested_at: row.upload_access_requested_at,
        });
      }

      const refusal = checkUploadAccessRequest(row, text);
      if (refusal) return c.json(refusal, 400);

      // Past the pure checks every required field is non-empty, which is what
      // lets the rest of this handler treat them as strings.
      const githubHandle = (row.github_username ?? "").trim();

      // Existence only -- not ownership. Nobody proves they control the
      // account here; what the review needs is that the handle an admin will
      // add as a repository collaborator actually resolves. Same known
      // limitation as CLI signup and PATCH /auth/profile: validateGitHubUsername
      // returns null for ANY non-OK response, so a GitHub outage reads as "does
      // not exist" rather than as a 503.
      const githubUser = await validateGitHubUsername(githubHandle, await getDatasetsToken(c.env));
      if (!githubUser) {
        return c.json(githubUnverifiedRefusal(githubHandle), 400);
      }

      const stamped = await db
        .prepare(
          `UPDATE users
              SET upload_access_requested_at = datetime('now'),
                  description = ?,
                  updated_at = datetime('now')
            WHERE id = ?
              AND upload_access_requested_at IS NULL
              AND service_access = 0
              AND deleted_at IS NULL`,
        )
        .bind(text, row.id)
        .run();

      if ((stamped.meta?.changes ?? 0) === 0) {
        // Lost the race to a concurrent request (or to an approval landing in
        // the same instant). Either way one request is open or answered and
        // this call must not mail a second copy.
        const current = await db
          .prepare("SELECT upload_access_requested_at FROM users WHERE id = ?")
          .bind(row.id)
          .first<{ upload_access_requested_at: string | null }>();
        return c.json({
          ok: true,
          already_requested: true,
          requested_at: current?.upload_access_requested_at ?? null,
        });
      }

      // Outside the write, and non-fatal, for the reason applyEmailVerification
      // records: the request HAS landed by now, and rolling it back over a
      // failed audit insert is the worse outcome. Loud in the log instead.
      try {
        await auditLogStatement(db, {
          userId: row.id,
          action: "upload_access_requested",
          resourceType: "user",
          resourceId: String(row.id),
          // The text itself is on the row and in the admin's inbox; the audit
          // row carries the shape of the event, not a second copy of the prose
          // (ADR 0036).
          details: JSON.stringify({
            via: c.get("authMethod") === "cookie" ? "web" : "cli",
            why_chars: text.length,
          }),
        }).run();
      } catch (auditErr) {
        console.error(
          `AUDIT GAP: upload_access_requested row not written for id=${row.id} (the request DID land):`,
          auditErr,
        );
      }

      // Admins only. The requester gets no mail here: they already know they
      // asked, and the answer they are waiting for is the upload-access-granted
      // mail that approval sends (ADR 0040 phase 2).
      try {
        const adminEmails = await getAdminEmailsForCategory(db, "user_approval");
        if (adminEmails.length > 0) {
          const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
          await sendUploadAccessRequestEmail(
            adminEmails,
            {
              id: row.id,
              username: (row.username ?? "").trim(),
              given_name: (row.given_name ?? "").trim(),
              family_name: (row.family_name ?? "").trim(),
              email: row.email,
              orcid: row.orcid,
              github_username: githubUser.login,
              city: (row.city ?? "").trim(),
              country: (row.country ?? "").trim(),
              affiliation: row.affiliation,
              why: text,
            },
            c.env.RESEND_API_KEY,
            fromEmail,
            replyTo,
            isDev,
            c.env,
          );
        } else {
          console.error(
            "[upload-access] no admin recipients for user_approval; request stored but nobody was told",
          );
        }
      } catch (emailErr) {
        // Best-effort by construction: the request is stored and visible in
        // `nemar admin users --awaiting-approval` whether or not the mail went.
        console.error("[upload-access] admin notification failed", emailErr);
      }

      return c.json({ ok: true, already_requested: false }, 201);
    } catch (err) {
      console.error("[users] /me/upload-access/request failed", err);
      return c.json({ error: "Failed to submit upload access request" }, 500);
    }
  },
);
