/**
 * The depositor's license notice (ADR 0139, decision 7, amendment of 2026-11-25; epic #2182, card
 * B6): after a first run's result is stored, once per request and outcome, through the dev mail
 * fence. Apart from `license-permission.ts` so that the review's view, which reads permissions,
 * never imports the mail code.
 */

import { LICENSE_EVIDENCE_ADDRESS } from "../../../shared/license-lineage.js";
import {
  type LicenseNoticeMailState,
  type ReadyMailOutcome,
  type RecordedMail,
  isActionRequiredOutcome,
} from "../../../shared/license-permission.js";
import { READY_TO_APPROVE_HEADLINE } from "../../../shared/publication-auto-deny.js";
import type { Bindings } from "../types/bindings.js";
import {
  DevEmailFenceError,
  resolveEmailConfig,
  sendLicenseNoticeEmail,
  sendLicenseRecordedEmail,
} from "./email.js";
import { isNonProductionEnv } from "./environment.js";
import { mailPublicationRequest, screenEmailSection } from "./identifier-screen.js";
import { licenseNoticeLines, permissionFactOf } from "./license-permission.js";
import { errorWords } from "./publication-review-log.js";
import { readReview, rowViewOf } from "./publication-review-rows.js";
import { publicationReviewEmailSection } from "./publication-review-view.js";

export type LicenseNoticeOutcome =
  | "no_row"
  | "not_needed"
  | "not_waiting"
  | "covered"
  | "already_sent"
  | LicenseNoticeMailState;

/**
 * After a review's result is stored: when a first run reported a lineage that needs action, and its
 * request is still waiting for its decision and is not covered by a recorded permission, mail the
 * requester the message once for the request and that outcome. The notice row is claimed before the
 * send, so a repeat sends nothing; what became of the mail is recorded on it. Never throws: a fault
 * is logged with ids and an error class only, and the mail it would have sent is not retried.
 */
export async function licenseNoticeAfterStore(
  env: Bindings,
  reviewId: number,
): Promise<LicenseNoticeOutcome> {
  try {
    return await notice(env, reviewId);
  } catch (err) {
    console.error(`[license-notice] review ${reviewId}: not sent (${errorWords(err)})`);
    return "failed";
  }
}

async function notice(env: Bindings, reviewId: number): Promise<LicenseNoticeOutcome> {
  const db = env.DB;
  const row = await readReview(db, reviewId);
  if (!row || row.confirmOf !== null) return "no_row";
  const view = rowViewOf(row, Date.now());
  const report = view.kind === "reported" ? view.report : null;
  const outcome = report?.evidence.lineage?.outcome ?? null;
  if (report === null || !isActionRequiredOutcome(outcome)) return "not_needed";
  const request = await db
    .prepare("SELECT id, dataset_id, status, requested_by FROM publication_requests WHERE id = ?")
    .bind(row.requestId)
    .first<{ id: number; dataset_id: string; status: string; requested_by: number }>();
  if (!request || request.dataset_id !== row.datasetId || request.status !== "requested") {
    return "not_waiting";
  }
  if ((await permissionFactOf(db, request, row, report)) !== null) return "covered";

  const claimed = await db
    .prepare(
      `INSERT INTO license_permission_notices (request_id, outcome, review_id) VALUES (?, ?, ?)
       ON CONFLICT (request_id, outcome) DO NOTHING`,
    )
    .bind(request.id, outcome, row.id)
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) return "already_sent";

  let state: LicenseNoticeMailState = "failed";
  try {
    const user = await db
      .prepare(
        "SELECT email, username FROM users WHERE id = ? AND deleted_at IS NULL AND email IS NOT NULL",
      )
      .bind(request.requested_by)
      .first<{ email: string; username: string }>();
    if (user) {
      const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
      // In production a reply reaches support, where it becomes the ticket the evidence is recorded
      // against. Elsewhere the Worker's own reply-to stays: a staging reply to support@ would open a
      // production ticket.
      const reply = isNonProductionEnv(env) ? replyTo : LICENSE_EVIDENCE_ADDRESS;
      try {
        await sendLicenseNoticeEmail(
          user.email,
          user.username,
          row.datasetId,
          licenseNoticeLines(row.datasetId, row, report),
          env.RESEND_API_KEY ?? "",
          fromEmail,
          reply,
          isDev,
          env,
        );
        state = "sent";
      } catch (err) {
        state = err instanceof DevEmailFenceError ? "fenced" : "failed";
        console.error(`[license-notice] request ${request.id}: mail not sent (${errorWords(err)})`);
      }
    } else {
      state = "no_recipient";
      console.warn(
        `[license-notice] request ${request.id}: requester ${request.requested_by} has no address to mail`,
      );
    }
  } finally {
    await db
      .prepare(
        "UPDATE license_permission_notices SET mail_state = ? WHERE request_id = ? AND outcome = ?",
      )
      .bind(state, request.id, outcome)
      .run();
  }
  return state;
}

// ---------------------------------------------------------------------------------------------
// After a permission is recorded
// ---------------------------------------------------------------------------------------------

/**
 * What a recorded permission sends (lead ruling on PR #2393): the request's verdict is derived
 * again, and when it is now a pass with a clear screen (the review section's "Ready to approve"
 * headline, which `passedSection` gives only then) the administrators get the existing
 * publication-request mail with that section, through the admin fence
 * (`getAdminEmailsForCategory`, production only unless `DEV_ADMIN_NOTIFICATIONS`). The requester
 * is always told, in one fixed sentence, through the delivery fence. Never throws: a fault is
 * logged with ids and an error class only.
 */
export async function afterPermissionRecorded(
  env: Bindings,
  requestId: number,
): Promise<RecordedMail> {
  let administrators: ReadyMailOutcome = "undelivered";
  let depositor: LicenseNoticeMailState = "failed";
  try {
    const request = await env.DB.prepare(
      `SELECT pr.dataset_id, pr.requested_by, pr.anonymous, pr.identifier_screen_status,
              pr.identifier_screen_report, u.email, u.username
         FROM publication_requests pr
         LEFT JOIN users u ON u.id = pr.requested_by AND u.deleted_at IS NULL
        WHERE pr.id = ?`,
    )
      .bind(requestId)
      .first<{
        dataset_id: string;
        requested_by: number;
        anonymous: number | null;
        identifier_screen_status: string | null;
        identifier_screen_report: string | null;
        email: string | null;
        username: string | null;
      }>();
    if (!request) return { administrators, depositor };
    const screen = screenEmailSection(
      request.dataset_id,
      request.identifier_screen_status,
      request.identifier_screen_report,
    );
    const review = await publicationReviewEmailSection(env, requestId, Date.now(), {
      screenStatusLine: screen.headline,
    });
    // A review that could not be read is said so, never taken for one that is not ready.
    if (review?.unreadable === true) {
      administrators = "review_unreadable";
    } else if (review?.headline !== READY_TO_APPROVE_HEADLINE) {
      administrators = "not_ready";
    } else {
      try {
        const out = await mailPublicationRequest(env, {
          requestId,
          datasetId: request.dataset_id,
          username: request.username ?? `user ${request.requested_by}`,
          anonymous: request.anonymous === 1,
          screen,
          review,
        });
        administrators = out.delivered > 0 ? "sent" : "undelivered";
      } catch (err) {
        console.error(
          `[license-permission] request ${requestId}: ready mail not sent (${errorWords(err)})`,
        );
      }
    }
    if (request.email !== null && request.username !== null) {
      const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
      try {
        await sendLicenseRecordedEmail(
          request.email,
          request.username,
          request.dataset_id,
          env.RESEND_API_KEY ?? "",
          fromEmail,
          isNonProductionEnv(env) ? replyTo : LICENSE_EVIDENCE_ADDRESS,
          isDev,
          env,
        );
        depositor = "sent";
      } catch (err) {
        depositor = err instanceof DevEmailFenceError ? "fenced" : "failed";
        console.error(
          `[license-permission] request ${requestId}: depositor mail not sent (${errorWords(err)})`,
        );
      }
    } else {
      depositor = "no_recipient";
      console.warn(
        `[license-permission] request ${requestId}: requester ${request.requested_by} has no address to mail`,
      );
    }
  } catch (err) {
    console.error(
      `[license-permission] request ${requestId}: mail step failed (${errorWords(err)})`,
    );
  }
  return { administrators, depositor };
}
