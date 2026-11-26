/**
 * Admin route: record license permission evidence against a publication request (epic #2182, card
 * B6; ADR 0139 decision 7 and its amendment of 2026-11-25).
 *
 *   POST /admin/publish/:id/license-permission
 *   { "ticket_id": <n>, "evidence": "<summary>", "request_id"?: <n>, "apply"?: true }
 *
 * The depositor sent evidence from the original authors (or, for `redistribution_prohibited`, from
 * the source repository) to support@nemar.org, where it became a support ticket (ADR 0112). The
 * administrator records it here, against the dataset's active request:
 *
 *  - The request's review in force must report a lineage that needs action, and must have stored
 *    the lineage it was served (its basis, migration 0154), whose outcome is the report's.
 *  - The ticket must exist and be visible to the administrator (ADR 0112's one predicate; a
 *    ticket they may not see is "not found").
 *  - Without `apply` it is a dry run: it answers what would be recorded (the request, the outcome,
 *    the target license and the sources) and writes nothing.
 *  - With `apply`, the permission and its audit row (`license_permission_recorded`) are written in
 *    one batch. The permission names exactly the sources behind the review's outcome. Then the
 *    verdict is derived again: a `pass` with a clear screen mails the administrators the existing
 *    "Ready to approve" mail, and the depositor is always told the evidence was recorded
 *    (`afterPermissionRecorded`, both through the mail fences; the answer's `mail` says what went).
 *
 * The evidence (1 to 1,000 characters, the administrator's own summary of what was received) is
 * stored and never echoed: not in the answer, not in the audit row, not in a log, and never sent to
 * a model. A refusal answers `{ error: <sentence>, code: <word> }`:
 *   400 invalid_dataset_id
 *   404 no_active_request, ticket_not_found
 *   409 request_mismatch, no_lineage_reason, basis_unrecorded, basis_mismatch,
 *       dataset_files_unreadable, already_covered
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { INVALID_DATASET_ID_MESSAGE } from "../../../../shared/contract/publication.js";
import {
  DATASET_OWN_FILE_IDS,
  LICENSE_PERMISSION_AUDIT_ACTION,
  LICENSE_PERMISSION_DRY_RUN,
  LICENSE_PERMISSION_EVIDENCE_MAX,
  LICENSE_PERMISSION_RECORDED,
  LICENSE_PERMISSION_REFUSAL_TEXT,
  type LicensePermissionRefusal,
  isActionRequiredOutcome,
  licensePermissionRecordedLine,
  licensePermissionRequest,
  parsePermissionBasis,
} from "../../../../shared/license-permission.js";
import { AUDIT_IF_PREVIOUS_CHANGED_SQL, auditLogParams } from "../../db/audit-log";
import { ACTIVE_REQUEST_TAIL_SQL } from "../../services/approval-dispatch";
import { isValidDatasetId } from "../../services/datasetId";
import { afterPermissionRecorded } from "../../services/license-notice";
import { coveringPermission } from "../../services/license-permission";
import { loadVisibleTicket } from "../../services/mail-admin";
import {
  derivePublicationReview,
  readReviewContext,
  reportOf,
} from "../../services/publication-review-view";
import type { AdminRouter } from "./shared";

const bodySchema = z
  .object({
    ticket_id: z.number().int().positive(),
    evidence: z.string().trim().min(1).max(LICENSE_PERMISSION_EVIDENCE_MAX),
    request_id: z.number().int().positive().optional(),
    apply: z.boolean().optional(),
  })
  .strict();

const STATUS: Record<LicensePermissionRefusal, 404 | 409> = {
  no_active_request: 404,
  request_mismatch: 409,
  no_lineage_reason: 409,
  basis_unrecorded: 409,
  basis_mismatch: 409,
  dataset_files_unreadable: 409,
  ticket_not_found: 404,
  already_covered: 409,
};

export function registerLicensePermissionRoutes(admin: AdminRouter): void {
  admin.post("/publish/:id/license-permission", zValidator("json", bodySchema), async (c) => {
    const datasetId = c.req.param("id");
    if (!isValidDatasetId(datasetId)) {
      return c.json({ error: "invalid_dataset_id", message: INVALID_DATASET_ID_MESSAGE }, 400);
    }
    const body = c.req.valid("json");
    const admin = c.get("user");
    const db = c.env.DB;
    const refuse = (code: LicensePermissionRefusal, extra: Record<string, unknown> = {}) =>
      c.json(
        {
          error: LICENSE_PERMISSION_REFUSAL_TEXT[code].replaceAll("<dataset>", datasetId),
          code,
          ...extra,
        },
        STATUS[code],
      );

    const active = await db
      .prepare(`SELECT id ${ACTIVE_REQUEST_TAIL_SQL}`)
      .bind(datasetId)
      .first<{ id: number }>();
    if (!active) return refuse("no_active_request");
    if (body.request_id !== undefined && body.request_id !== active.id) {
      return refuse("request_mismatch");
    }
    const ctx = await readReviewContext(c.env, active.id);
    if (!ctx) return refuse("no_active_request");
    const d = await derivePublicationReview({ env: c.env, nowMs: Date.now(), ...ctx });

    const report = reportOf(d.rowView);
    const outcome = report?.evidence.lineage?.outcome ?? null;
    if (d.row === null || report === null || !isActionRequiredOutcome(outcome)) {
      return refuse("no_lineage_reason");
    }
    if (d.permission !== null) {
      return refuse("already_covered", { line: licensePermissionRecordedLine(d.permission) });
    }
    const basis = parsePermissionBasis(d.row.lineageBasis);
    if (basis === null) return refuse("basis_unrecorded");
    if (basis.outcome !== outcome) return refuse("basis_mismatch");
    if (
      basis.sources.length === 0 ||
      basis.sources.some((s) => DATASET_OWN_FILE_IDS.includes(s.id))
    ) {
      return refuse("dataset_files_unreadable");
    }

    const ticket = await loadVisibleTicket(db, { id: admin.id, role: admin.role }, body.ticket_id);
    if (!ticket) return refuse("ticket_not_found");

    const sourceIds = basis.sources.map((s) => s.id);
    const preview = {
      dataset_id: datasetId,
      request_id: active.id,
      review_id: d.row.id,
      outcome,
      target_license: basis.target_license,
      sources: basis.sources,
      ticket_id: body.ticket_id,
      // What the depositor was asked for, so the administrator checks the evidence against it.
      request_line: licensePermissionRequest(datasetId, outcome, basis),
    };
    if (body.apply !== true) {
      return c.json({ applied: false, message: LICENSE_PERMISSION_DRY_RUN, ...preview });
    }

    const [userId, action, resourceType, resourceId, details] = auditLogParams({
      userId: admin.id,
      action: LICENSE_PERMISSION_AUDIT_ACTION,
      resourceType: "dataset",
      resourceId: datasetId,
      // Ids, closed words and the ticket; never the evidence.
      details: JSON.stringify({
        request_id: active.id,
        review_id: d.row.id,
        outcome,
        target_license: basis.target_license,
        source_ids: sourceIds,
        ticket_id: body.ticket_id,
      }),
    });
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO license_permissions
             (dataset_id, request_id, outcome, target_license, source_ids, ticket_id, evidence,
              recorded_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          datasetId,
          active.id,
          outcome,
          basis.target_license,
          JSON.stringify(sourceIds),
          body.ticket_id,
          body.evidence,
          admin.id,
        ),
      db
        .prepare(AUDIT_IF_PREVIOUS_CHANGED_SQL)
        .bind(userId, action, resourceType, resourceId, details),
    ]);
    const permissionId = Number(results[0]?.meta?.last_row_id);
    const recorded = await coveringPermission(db, datasetId, active.id, basis);
    // Close the loop: the verdict is derived again, the administrators get "Ready to approve" when
    // it is now a pass with a clear screen, and the depositor is told; both through the mail fences.
    const mail = await afterPermissionRecorded(c.env, active.id);
    return c.json({
      applied: true,
      message: LICENSE_PERMISSION_RECORDED,
      permission_id: permissionId,
      line: recorded === null ? null : licensePermissionRecordedLine(recorded),
      mail,
      ...preview,
    });
  });
}
