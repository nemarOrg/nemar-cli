/**
 * The denial of a publication request: the ONE code path an administrator's
 * `POST /admin/publish/:id/deny` and the automatic denial (ADR 0139, decision 2) both take.
 *
 * Moved out of `routes/admin/publish.ts` unchanged (#1603; ADR 0105, decision 11). The newest
 * active request is read, then refused by the shared words, in this order, before any write (a
 * denial that is refused changes nothing and mails nobody):
 *   404                       no active request
 *   409 request_mismatch      `requestId` names a request that is not that one
 *   409 deny_after_publishing a step outside the validation-only ones is done or is the one the run
 *                             was on when it stopped, WHATEVER the status
 *   409 approval_in_flight    an approval is running for it (`approvalInFlightSql`)
 * Then ONE conditional write whose terms are the lease predicate and the `updated_at` that was read,
 * so a request that moved between the read and the write is refused rather than overwritten; a
 * lost write is read again and answered with the true reason, by the same rule as the first read.
 *
 * The automatic denial adds terms of its own (`guard`: still `requested`, the review still the one
 * in force), a column (`set`: `auto_denied = 1`) and statements that must commit with the write or
 * not at all (`before`, `after`: the cap's claim and the audit row), which then run in one batch.
 * With none of those the write is the single statement it always was.
 *
 * Mail is the caller's: an administrator's denial mails the requester the administrator's reason,
 * and the automatic one mails the requester and the owner its own transparent account.
 */

import {
  APPROVAL_IN_FLIGHT_MESSAGE,
  DENY_AFTER_PUBLISHING_MESSAGE,
  REQUEST_MISMATCH_MESSAGE,
} from "../../../shared/contract/publication.js";
import { publishingHasStarted } from "../../../shared/publication-steps.js";
import {
  ACTIVE_REQUEST_TAIL_SQL,
  APPROVAL_CLAIM_CLEAR_SQL,
  approvalInFlightSql,
} from "./approval-dispatch.js";

/** The deny route's answer for a dataset with no active request, as it has always been. */
export const DENY_NOT_FOUND = { error: "No active publication request found" };

/** The deny route's refusal of a request an approval is running for. */
export const DENY_IN_FLIGHT = {
  error: "approval_in_flight",
  message: APPROVAL_IN_FLIGHT_MESSAGE,
};

/** The statuses of a request the deny route may still act on (`ACTIVE_REQUEST_TAIL_SQL`). */
export const DENIABLE_STATUSES: readonly string[] = ["requested", "approving", "blocked"];

/**
 * Why a request cannot be denied, or null when it can: the two refusals, in the one order they
 * apply (started publishing before in flight, so a live run that has gone past the validation steps
 * is told what matters). Read on the first look at the request and again after a lost write, so both
 * answer by the same rule.
 *
 * The first refusal ignores the status and the block reason on purpose, and so differs from the
 * approval's gate (`publishingStanding`, which will not trust the steps of a `requested` row or of
 * a `blocked` one with another reason, so that new content cannot skip the gates). The gate asks
 * whether to trust old steps; a denial asks whether anything irreversible has happened. A run that
 * made the S3 objects public-read and the repository public, and was then walked back for the
 * owner's name, keeps those steps when the owner requests again, and the data is still public. A
 * request's completed steps are that request's own acts, so one that has started publishing is
 * never denied, whatever its status.
 *
 * The rule is `publishingHasStarted` (shared with the depositor's withdrawal). It reads two columns,
 * because a step is recorded as done only after it has run: a step outside the validation-only
 * ones in either `steps_completed` or `current_step` means the data may be public (ADR 0105,
 * decision 11).
 */
export function denyRefusal(row: {
  steps_completed: string | null;
  current_step: string | null;
  in_flight: number;
}): { error: string; message: string } | null {
  if (publishingHasStarted(row)) {
    return { error: "deny_after_publishing", message: DENY_AFTER_PUBLISHING_MESSAGE };
  }
  return row.in_flight === 1 ? DENY_IN_FLIGHT : null;
}

export interface DenyArgs {
  datasetId: string;
  /** The request the caller means; refused (`request_mismatch`) when it is not the active one. */
  requestId?: number;
  deniedBy: number;
  reason: string;
  /** More terms on the write, ANDed with the route's; their binds follow the route's. */
  guard?: { sql: string; binds: (string | number | null)[] };
  /** More assignments on the write (no leading or trailing comma), with no binds. */
  set?: string;
  /** Statements before the write, in the same batch, for the request id that was read. */
  before?: (requestId: number) => D1PreparedStatement[];
  /** Statements after the write, in the same batch; each guards itself (`changes()`). */
  after?: (requestId: number) => D1PreparedStatement[];
}

export type DenyOutcome =
  | { kind: "denied"; requestId: number; requestedBy: number }
  | {
      kind: "refused";
      status: 404 | 409;
      body: { error: string; message?: string };
    };

/** Deny the dataset's active request, or say why not. Throws only when the database does. */
export async function denyPublicationRequest(db: D1Database, args: DenyArgs): Promise<DenyOutcome> {
  const request = await db
    .prepare(
      `SELECT id, requested_by, steps_completed, current_step, updated_at,
              ${approvalInFlightSql()} AS in_flight ${ACTIVE_REQUEST_TAIL_SQL}`,
    )
    .bind(args.datasetId)
    .first<{
      id: number;
      requested_by: number;
      steps_completed: string | null;
      current_step: string | null;
      updated_at: string;
      in_flight: number;
    }>();

  if (!request) return { kind: "refused", status: 404, body: DENY_NOT_FOUND };
  if (args.requestId !== undefined && args.requestId !== request.id) {
    return {
      kind: "refused",
      status: 409,
      body: { error: "request_mismatch", message: REQUEST_MISMATCH_MESSAGE },
    };
  }
  const refused = denyRefusal(request);
  if (refused) return { kind: "refused", status: 409, body: refused };

  const write = db
    .prepare(
      `UPDATE publication_requests
       SET status = 'denied', denied_at = datetime('now'), denied_by = ?, denied_reason = ?,
           ${APPROVAL_CLAIM_CLEAR_SQL}, ${args.set ? `${args.set}, ` : ""}updated_at = datetime('now')
       WHERE id = ? AND status IN ('requested', 'approving', 'blocked')
         AND NOT ${approvalInFlightSql()} AND updated_at = ?${args.guard ? ` AND ${args.guard.sql}` : ""}`,
    )
    .bind(args.deniedBy, args.reason, request.id, request.updated_at, ...(args.guard?.binds ?? []));

  const before = args.before?.(request.id) ?? [];
  const after = args.after?.(request.id) ?? [];
  let changed: number;
  if (before.length === 0 && after.length === 0) {
    changed = (await write.run()).meta.changes ?? 0;
  } else {
    const results = await db.batch([...before, write, ...after]);
    changed = results[before.length]?.meta?.changes ?? 0;
  }

  if (changed !== 1) {
    // The request moved after it was read here. Say why: a request that is no longer active
    // (published, denied) is "not found", and one that is still active is refused for the reason it
    // has NOW. Anything else (it was only touched, and nothing is running) reads as a run that is
    // writing to it: the sentence tells the administrator to wait and deny it again.
    const now = await db
      .prepare(
        `SELECT status, steps_completed, current_step, ${approvalInFlightSql()} AS in_flight
           FROM publication_requests WHERE id = ?`,
      )
      .bind(request.id)
      .first<{
        status: string;
        steps_completed: string | null;
        current_step: string | null;
        in_flight: number;
      }>();
    if (!now || !DENIABLE_STATUSES.includes(now.status)) {
      return { kind: "refused", status: 404, body: DENY_NOT_FOUND };
    }
    return { kind: "refused", status: 409, body: denyRefusal(now) ?? DENY_IN_FLIGHT };
  }
  return { kind: "denied", requestId: request.id, requestedBy: request.requested_by };
}
