/**
 * Admin routes for the publication review (ADR 0101, section 8):
 *
 *   GET  /admin/publish/:id/review         the review of the dataset's active request: the outcome
 *                                          and its reasons in the shared words, the review in
 *                                          force with its findings and summary, and the history
 *                                          of earlier reviews
 *   POST /admin/publish/:id/review/start   start the review of the active request's current
 *                                          screened commit, or start again one that was declined,
 *                                          errored, never reported or is past its deadline
 *
 * Admin-only through the router's `authMiddleware` and `adminMiddleware`. A read needs no switch:
 * `PUBLICATION_REVIEW_ENABLED` gates the REVIEW, not the view of it, so with the review off a
 * request reads as not reviewed (and one that has a stored review shows it as advice). The read
 * decides nothing and writes nothing: no approval, no start, no audit row.
 *
 * The read is a thin adapter over `services/publication-review-view.ts`, which owns every word of
 * it; the model's summary and the notes of its findings appear in its response and in no other.
 * The start is a thin adapter over `startPublicationReview` (the one start path, which a screen
 * result takes too): it finds the request, passes the administrator, and says what the service
 * said. There is no `start --all` route; that is a loop in the command-line interface.
 */

import type { Context } from "hono";
import type {
  PublicationReviewErrorCode,
  StartPublicationReviewResponse,
} from "../../../../shared/contract/publication-review-admin";
import { auditLogStatement } from "../../db/audit-log";
import { ACTIVE_REQUEST_TAIL_SQL } from "../../services/approval-dispatch";
import { isValidDatasetId } from "../../services/datasetId";
import { isNonProductionEnv } from "../../services/environment";
import {
  type StartOutcome,
  errClass,
  startPublicationReview,
} from "../../services/publication-review";
import { readReview } from "../../services/publication-review-rows";
import { publicationReviewDetail, readFailureWords } from "../../services/publication-review-view";
import { isAllowedOrigin } from "../../services/web-session";
import type { AdminRouter } from "./shared";

/** Answer with a fixed sentence and a code from the contract's closed list. */
function refuse(
  c: Context,
  status: 400 | 403 | 404 | 409 | 500,
  code: PublicationReviewErrorCode,
  error: string,
) {
  return c.json({ error, code }, status);
}

/**
 * The refusals of a start: what the service said, as a closed code and a sentence for a person.
 * Each is a request that cannot be started as it stands (409), never a fault. A start that was
 * HANDED OVER (or whose run stands) and a start that could not hand over are answered below.
 */
const START_REFUSALS: Partial<
  Record<StartOutcome["reason"], { code: PublicationReviewErrorCode; error: string }>
> = {
  review_disabled: {
    code: "review_disabled",
    error: "The publication review is switched off on this Worker.",
  },
  not_applicable: {
    code: "not_applicable",
    error: "This dataset is not reviewed: it is an OpenNeuro mirror or an exemplar.",
  },
  not_owned_here: {
    code: "not_owned_here",
    error: "The other environment's Worker answers for that dataset.",
  },
  request_not_requested: {
    code: "request_not_requested",
    error: "Only a request that is waiting for its decision can be reviewed.",
  },
  screen_not_ready: {
    code: "screen_not_ready",
    error:
      "The identifier screen has no clear result for a commit yet, so there is nothing to review.",
  },
  running: {
    code: "running",
    error: "A review of this commit is running. Wait for its report, or for its deadline.",
  },
  has_result: {
    code: "has_result",
    error:
      "A review of this commit has already reported. A new screened commit starts a new review.",
  },
  platform_limit: {
    code: "platform_limit",
    error: "The platform's daily allowance of reviews is spent. Try again tomorrow.",
  },
};

export function registerPublicationReviewRoutes(admin: AdminRouter): void {
  admin.get("/publish/:id/review", async (c) => {
    const datasetId = c.req.param("id");
    if (!isValidDatasetId(datasetId))
      return refuse(c, 400, "bad_dataset", "That is not a dataset id.");
    try {
      const detail = await publicationReviewDetail(c.env, datasetId);
      if (detail === null) {
        return refuse(c, 404, "not_found", `${datasetId} has no active publication request.`);
      }
      return c.json(detail);
    } catch (err) {
      // Ids and fixed words only: the error text can carry SQL.
      console.error(
        `[admin/publication-review] could not read the review of ${datasetId} (${readFailureWords(err)})`,
      );
      return refuse(c, 500, "internal", "The publication review could not be read. Try again.");
    }
  });

  admin.post("/publish/:id/review/start", async (c) => {
    // A session cookie rides along with any cross-site request a browser can be tricked into
    // making, and this route spends the platform's money, so every path but a bearer key must come
    // from a NEMAR origin (the rule of `approve-dispatch`). A bearer key cannot be forged
    // cross-site and a terminal sends no Origin. Phrased as "not a token" so that an unset
    // `authMethod` fails closed.
    if (c.get("authMethod") !== "token" && !isAllowedOrigin(c.req.header("Origin"))) {
      return refuse(
        c,
        403,
        "origin_not_allowed",
        "This request did not come from a NEMAR page, so it was not accepted.",
      );
    }
    const datasetId = c.req.param("id");
    if (!isValidDatasetId(datasetId)) {
      return refuse(c, 400, "bad_dataset", "That is not a dataset id.");
    }
    const environment = isNonProductionEnv(c.env) ? "non-production" : "production";

    let outcome: StartOutcome;
    let requestId: number;
    try {
      const request = await c.env.DB.prepare(`SELECT id ${ACTIVE_REQUEST_TAIL_SQL}`)
        .bind(datasetId)
        .first<{ id: number }>();
      if (!request) {
        return refuse(c, 404, "not_found", `${datasetId} has no active publication request.`);
      }
      requestId = request.id;
      outcome = await startPublicationReview(c.env, {
        requestId,
        datasetId,
        adminUserId: c.get("user").id,
      });
    } catch (err) {
      // Ids and fixed words only: the error text can carry SQL. `startPublicationReview` throws
      // only after a database fault, and has marked a row it wrote as `dispatch_failed` first.
      console.error(
        `[admin/publication-review] could not start the review of ${datasetId} (${readFailureWords(err)})`,
      );
      return refuse(c, 500, "internal", "The publication review could not be started. Try again.");
    }

    const answer = (): StartPublicationReviewResponse => ({
      environment,
      started: outcome.started,
      reason: outcome.reason === "duplicate" ? "running" : outcome.reason,
      review_id: outcome.reviewId,
    });

    if (outcome.started) {
      await recordStart(c, datasetId, requestId, outcome);
      return c.json(answer(), 202);
    }
    const refusal = START_REFUSALS[outcome.reason];
    if (refusal) return refuse(c, 409, refusal.code, refusal.error);
    // A start that could not hand the review over: the row is recorded (so `start` can try again)
    // and the answer carries the reason with the review it concerns. Not a refusal of the
    // request, and not a start, so it is no 2xx.
    return c.json(
      {
        ...answer(),
        error:
          outcome.reason === "dispatch_unconfigured"
            ? "This Worker cannot hand a review to GitHub: a credential is not configured."
            : "The review could not be handed to GitHub. Try again.",
      },
      502,
    );
  });
}

/**
 * The audit row of a start (`publication_review_started`, as `pr_review_started` is for a pull
 * request): who, which request and review, why, and which commit. Best effort: a run that is going
 * must not be reported as an error because its audit row could not be written, so a failure is
 * logged by ids and fixed words and the start stands.
 */
async function recordStart(
  c: Context,
  datasetId: string,
  requestId: number,
  outcome: StartOutcome,
): Promise<void> {
  const reviewId = outcome.reviewId;
  try {
    // The commit the review is of is on its row, not in the answer.
    const row = reviewId === null ? null : await readReview(c.env.DB, reviewId);
    await auditLogStatement(c.env.DB, {
      userId: c.get("user").id,
      action: "publication_review_started",
      resourceType: "dataset",
      resourceId: datasetId,
      details: JSON.stringify({
        request_id: requestId,
        review_id: reviewId,
        reason: outcome.reason,
        head_sha: row?.headSha ?? null,
      }),
    }).run();
  } catch (err) {
    console.error(
      `[admin/publication-review] ${datasetId}: review ${reviewId} started, audit row not written (${errClass(err)})`,
    );
  }
}
