/**
 * The depositor's license notice (ADR 0139, decision 7, amendment of 2026-11-25; epic #2182, card
 * B6): after a first run's result is stored, once per request and outcome, through the dev mail
 * fence. Apart from `license-permission.ts` so that the review's view, which reads permissions,
 * never imports the mail code.
 */

import { LICENSE_EVIDENCE_ADDRESS } from "../../../shared/license-lineage.js";
import {
  type LicenseNoticeMailState,
  isActionRequiredOutcome,
} from "../../../shared/license-permission.js";
import type { Bindings } from "../types/bindings.js";
import { DevEmailFenceError, resolveEmailConfig, sendLicenseNoticeEmail } from "./email.js";
import { isNonProductionEnv } from "./environment.js";
import { licenseNoticeLines, permissionFactOf } from "./license-permission.js";
import { errorWords } from "./publication-review-log.js";
import { readReview, rowViewOf } from "./publication-review-rows.js";

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
