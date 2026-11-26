/**
 * License permission evidence, Worker side (ADR 0139, decision 7 and its amendment of 2026-11-25;
 * epic #2182, card B6). The rule is `shared/license-permission.ts`; this module reads and writes it.
 *
 *  - {@link permissionFactOf}: the recorded permission, if any, that covers the lineage of a
 *    reviewed request, for the derivation (`LiveFacts.license_permission`), the depositor's status
 *    and the admin route. A permission recorded against this request or an earlier one of the same
 *    dataset counts; one recorded against a later request does not reach back.
 *  - {@link licenseNoticeAfterStore}: after a first run's result is stored, the depositor's notice,
 *    once per request and outcome, through the dev mail fence.
 *
 * The evidence column is never selected here: no surface, log or mail built from this module can
 * carry it.
 */

import { LICENSE_EVIDENCE_ADDRESS } from "../../../shared/license-lineage.js";
import {
  type LicenseNoticeMailState,
  type PermissionBasis,
  type RecordedPermission,
  isActionRequiredOutcome,
  licensePermissionRequest,
  parsePermissionBasis,
  parseSourceIds,
  permissionCovers,
} from "../../../shared/license-permission.js";
import type { PublicationReviewReport } from "../../../shared/publication-review.js";
import type { Bindings } from "../types/bindings.js";
import { DevEmailFenceError, resolveEmailConfig, sendLicenseNoticeEmail } from "./email.js";
import { isNonProductionEnv } from "./environment.js";
import { errorWords } from "./publication-review-log.js";
import { type PublicationReviewRow, readReview, rowViewOf } from "./publication-review-rows.js";

type Db = D1Database;

/** A dataset's permissions recorded up to a request, oldest first, without the evidence. */
const PERMISSIONS_SQL = `SELECT lp.id, lp.outcome, lp.target_license, lp.source_ids, lp.ticket_id,
       lp.recorded_at, u.username AS recorded_by_username
  FROM license_permissions lp LEFT JOIN users u ON u.id = lp.recorded_by
 WHERE lp.dataset_id = ? AND lp.request_id <= ?
 ORDER BY lp.id`;

export interface CoveringPermission extends RecordedPermission {
  id: number;
}

/** The first permission of the dataset, recorded up to `requestId`, that covers `basis`; or null. */
export async function coveringPermission(
  db: Db,
  datasetId: string,
  requestId: number,
  basis: PermissionBasis,
): Promise<CoveringPermission | null> {
  const { results } = await db.prepare(PERMISSIONS_SQL).bind(datasetId, requestId).all<{
    id: number;
    outcome: string;
    target_license: string | null;
    source_ids: string;
    ticket_id: number;
    recorded_at: string;
    recorded_by_username: string | null;
  }>();
  for (const p of results ?? []) {
    const ids = parseSourceIds(p.source_ids);
    if (ids === null) continue;
    if (
      permissionCovers(
        { outcome: p.outcome, target_license: p.target_license, source_ids: ids },
        basis,
      )
    ) {
      return {
        id: Number(p.id),
        recorded_at: p.recorded_at,
        recorded_by: p.recorded_by_username,
        ticket_id: Number(p.ticket_id),
      };
    }
  }
  return null;
}

/**
 * The review's basis, when it agrees with what the report says the lineage was: null when none was
 * stored, it does not read, or its outcome is not the report's (the report is what the reasons are
 * derived from, so a permission is matched against nothing else).
 */
export function reviewBasisOf(
  row: Pick<PublicationReviewRow, "lineageBasis">,
  report: PublicationReviewReport | null,
): PermissionBasis | null {
  const outcome = report?.evidence.lineage?.outcome ?? null;
  if (!isActionRequiredOutcome(outcome)) return null;
  const basis = parsePermissionBasis(row.lineageBasis);
  return basis !== null && basis.outcome === outcome ? basis : null;
}

/**
 * The recorded permission that covers a reviewed request's lineage, or null: no lineage reason, no
 * basis that agrees with the report, or no permission that covers it. Throws when the read fails,
 * like every live fact (the derivation never answers from a fact it could not read).
 */
export async function permissionFactOf(
  db: Db,
  request: { id: number; dataset_id: string },
  row: Pick<PublicationReviewRow, "lineageBasis">,
  report: PublicationReviewReport | null,
): Promise<CoveringPermission | null> {
  const basis = reviewBasisOf(row, report);
  if (basis === null) return null;
  return coveringPermission(db, request.dataset_id, request.id, basis);
}

// ---------------------------------------------------------------------------------------------
// The depositor's notice
// ---------------------------------------------------------------------------------------------

export type LicenseNoticeOutcome =
  | "no_row"
  | "not_needed"
  | "not_waiting"
  | "covered"
  | "already_sent"
  | LicenseNoticeMailState;

/**
 * The depositor's message for a reviewed request whose lineage needs action, or null when it does
 * not: the lines the notice mail and the publication status print.
 */
export function licenseNoticeLines(
  datasetId: string,
  row: Pick<PublicationReviewRow, "lineageBasis">,
  report: PublicationReviewReport | null,
): string[] {
  const outcome = report?.evidence.lineage?.outcome ?? null;
  if (!isActionRequiredOutcome(outcome)) return [];
  return [licensePermissionRequest(datasetId, outcome, reviewBasisOf(row, report))];
}

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
