/**
 * The publication review as a gate on approval (ADR 0102, sections 8 and 9).
 *
 * `POST /admin/publish/:id/approve` and `approve-dispatch` ask this module, after the identifier
 * screen's gate and before the request is marked `approving`, whether the review lets the approval
 * through. It never approves or denies anything: it answers yes, or a refusal in the shared words
 * (`reviewGateRefusalText`), and it records the administrator's override when one was needed.
 *
 * What it pins, and why each line is here:
 *
 *  - **With the flag off it reads nothing.** Production is dark until the review is switched on, so
 *    a fault of the review table must not stop an approval there. The mechanical rules that hold
 *    with the flag off live outside this module (the blocked refusal, the store's re-block).
 *  - **It fails closed.** A read that fails, or anything that throws after the request was read,
 *    is a refusal (`unverified`), never a pass and never a 500 (ADR 0053, ADR 0054).
 *  - **Hard reasons are checked before the override.** Nothing clears them, so an override in the
 *    body changes nothing for a request that has one.
 *  - **An override attaches to what was shown, or to nothing.** It names the review it was given
 *    for and the reasons shown; it is recorded only when that review is still the one in force,
 *    and only by a statement that pins the row as it was read (`RECORD_OVERRIDE_SQL`).
 *  - **A recorded override is its approver's.** It satisfies a later run only when that run is
 *    attributed to the same administrator (`resolveApprover`, ADR 0080): the web executor's run
 *    passes on its clicker's override, and any other administrator's run does not.
 */

import {
  REQUEST_BLOCKED_CODE,
  type RequestBlockedRefusalBody,
} from "../../../shared/contract/publication-review-admin.js";
import { REASONS, cureOf, shownBlockReason } from "../../../shared/publication-review.js";

/**
 * The 409 body for a blocked request. It holds whatever the flag says and for every dataset, since
 * it is the mechanical rule and not the review's verdict, so it is its own code rather than
 * `publication_review_not_clear`. The block reason is a top-level field so the CLI's hints for it
 * work unchanged, and it is shown only when it is a plain word (`shownBlockReason`).
 */
export function requestBlockedRefusal(
  datasetId: string,
  blockReason: string | null,
): RequestBlockedRefusalBody {
  const rule = REASONS.request_blocked;
  return {
    error: REQUEST_BLOCKED_CODE,
    block_reason: shownBlockReason({ status: "blocked", block_reason: blockReason }),
    message: `${rule.sentence} ${cureOf("request_blocked", datasetId, false)}`,
  };
}
