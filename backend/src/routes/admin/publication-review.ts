/**
 * Admin routes for the publication review (ADR 0101, section 8):
 *
 *   GET /admin/publish/:id/review   the review of the dataset's active request: the outcome and its
 *                                   reasons in the shared words, the review in force with its
 *                                   findings and summary, and the history of earlier reviews
 *
 * Admin-only through the router's `authMiddleware` and `adminMiddleware`. A read needs no switch:
 * `PUBLICATION_REVIEW_ENABLED` gates the REVIEW, not the view of it, so with the review off a
 * request reads as not reviewed (and one that has a stored review shows it as advice). The route
 * decides nothing and writes nothing: no approval, no start, no audit row. `POST
 * /publish/:id/review/start` joins this file with the code that starts a review.
 *
 * The route is a thin adapter over `services/publication-review-view.ts`, which owns every word of
 * it. The model's summary and the notes of its findings appear in this response and in no other.
 */

import type { Context } from "hono";
import type { PublicationReviewErrorCode } from "../../../../shared/contract/publication-review-admin";
import { isValidDatasetId } from "../../services/datasetId";
import { publicationReviewDetail, readFailureWords } from "../../services/publication-review-view";
import type { AdminRouter } from "./shared";

/** Answer with a fixed sentence and a code from the contract's closed list. */
function refuse(
  c: Context,
  status: 400 | 404 | 500,
  code: PublicationReviewErrorCode,
  error: string,
) {
  return c.json({ error, code }, status);
}

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
}
