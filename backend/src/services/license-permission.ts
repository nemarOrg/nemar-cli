/**
 * License permission evidence, Worker side (ADR 0139, decision 7 and its amendment of 2026-11-25;
 * epic #2182, card B6). The rule is `shared/license-permission.ts`; this module reads and writes it.
 *
 *  - {@link permissionFactOf}: the recorded permission, if any, that covers the lineage of a
 *    reviewed request, for the derivation (`LiveFacts.license_permission`), the depositor's status
 *    and the admin route. A permission recorded against this request or an earlier one of the same
 *    dataset counts; one recorded against a later request does not reach back.
 *  - {@link licenseNoticeLines}: the depositor's message, for the notice mail
 *    (`license-notice.ts`, which alone imports the mail code, so the review's view stays clear of
 *    it) and the publication status.
 *
 * The evidence column is never selected here: no surface, log or mail built from this module can
 * carry it.
 */

import {
  type PermissionBasis,
  type RecordedPermission,
  isActionRequiredOutcome,
  licensePermissionRequest,
  parsePermissionBasis,
  parseSourceIds,
  permissionCovers,
} from "../../../shared/license-permission.js";
import type { PublicationReviewReport } from "../../../shared/publication-review.js";
import type { PublicationReviewRow } from "./publication-review-rows.js";

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
