/**
 * Publication-review callbacks, called by the `run-publication-review` workflow (ADR 0102).
 *
 *   POST /publication-review-claim    the workflow's first real step, before it mints an identity or
 *                                     reads anything: take the review. A dispatch that cannot
 *                                     present the token gets 401 and buys nothing; a request that
 *                                     changed since the dispatch, a review switched off, or an
 *                                     unsettled claim is refused with 409 before the workflow reads
 *                                     anything or calls a model.
 *   POST /publication-review-inputs   after the claim, before the job examines anything: the
 *                                     widened inputs of ADR 0139 (decision 6) for this one review,
 *                                     the enrichment, the lineage, the resubmission note and the
 *                                     screen's coverage counts. Read-only. Only a claimed review
 *                                     that has not reported is answered (409 otherwise); a read the
 *                                     inputs need that fails answers 502, and the job then reports
 *                                     `inputs_unavailable` rather than review on part of them.
 *   POST /publication-review-result   the report (or the word for why there is none).
 *
 * All three are authed like the pull-request review's callbacks: a per-review HMAC token in
 * X-Webhook-Token, signed over {dataset_id, review_id, nonce} with PRESCREEN_CALLBACK_SECRET under
 * the `publication-review` domain tag, whose nonce is recovered from the row the token was issued
 * for. The token is spent by the RESULT: the row is found only while it waits for its report
 * (`dispatched`, or `unreported` after the watchdog gave up), and storing a result clears the
 * nonce, so a replayed or late result finds nothing to verify and gets 401. The CLAIM is one-shot
 * by `claimed_at` instead: a replayed claim still finds the row and gets 409 `already_claimed`.
 *
 * Body: `{ review_id, dataset_id, outcome: "reported" | "error", report?, error? }`. Every field is
 * untrusted. `dataset_id` and `review_id` are validated against their exact shapes BEFORE they are
 * used or logged, and `report` reaches nothing except through `parsePublicationReviewReport` (via
 * `parsePublicationCallbackOutcome`). The parser refuses unknown keys and values outside the closed
 * sets, which is stored as `report_invalid`; free text (`summary`, a finding's `note`) is not
 * refused but reduced to plain words by `sanitizeNote`, so what a workflow changed to put there is
 * shown as text and never as markup, a link or a mention.
 *
 * Every log line is ids and fixed words: the route never prints a token, a nonce, a secret or a
 * byte of the body. A database fault is no exception: the nonce read, the claim and the store each
 * catch it, answer a fixed 500 the job may retry, and log the error's words (`errorWords`), because
 * the global handler would print the whole error, whose text can carry SQL.
 */

import { CONFIRMING_MODELS } from "../../../../shared/publication-auto-deny.js";
import { parsePublicationCallbackOutcome } from "../../../../shared/publication-review.js";
import { isValidDatasetId } from "../../services/datasetId.js";
import { verifyPublicationReviewCallbackToken } from "../../services/github/callback-tokens.js";
import { afterPublicationReviewStored } from "../../services/publication-auto-deny.js";
import { publicationReviewInputs } from "../../services/publication-review-inputs.js";
import { errorWords } from "../../services/publication-review-log.js";
import { readReview } from "../../services/publication-review-rows.js";
import {
  claimPublicationReview,
  pendingPublicationReviewNonce,
  storePublicationReviewResult,
} from "../../services/publication-review.js";
import type { WebhookContext, WebhookRouter } from "../webhooks/shared.js";
import { readBoundedJsonObject } from "./bounded-json.js";
import { deferAfterAnswer } from "./defer.js";

/** Every refusal says the same bytes, so the answer does not tell a caller which reviews are running. */
const UNAUTHORIZED = { error: "Invalid or expired callback token" } as const;

interface Verified {
  reviewId: number;
  datasetId: string;
  nonce: string;
  body: Record<string, unknown>;
}

/** The shared door: token present, body bounded and shaped, secret set, nonce found, HMAC good. */
async function verify(c: WebhookContext, route: string): Promise<Verified | Response> {
  const token = c.req.header("X-Webhook-Token");
  if (!token) return c.json(UNAUTHORIZED, 401);

  const read = await readBoundedJsonObject(c);
  if (!read.ok) return c.json({ error: read.error }, read.status);
  const b = read.body;
  if (typeof b.dataset_id !== "string" || !isValidDatasetId(b.dataset_id)) {
    return c.json({ error: "dataset_id must be a dataset id" }, 400);
  }
  if (typeof b.review_id !== "number" || !Number.isSafeInteger(b.review_id) || b.review_id < 1) {
    return c.json({ error: "review_id must be a positive integer" }, 400);
  }
  const datasetId = b.dataset_id;
  const reviewId = b.review_id;

  const secret = c.env.PRESCREEN_CALLBACK_SECRET;
  if (!secret) {
    console.error(`[${route}] PRESCREEN_CALLBACK_SECRET is unset; rejecting`);
    return c.json({ error: "Server misconfigured: callback secret unset" }, 500);
  }

  let pending: Awaited<ReturnType<typeof pendingPublicationReviewNonce>>;
  try {
    pending = await pendingPublicationReviewNonce(c.env.DB, reviewId, datasetId);
  } catch (err) {
    // Nothing was read or written, so the job may try again. The words of the error are logged,
    // never the error: left to the global handler, its text (which can carry SQL) is printed.
    console.error(
      `[${route}] review ${reviewId} (${datasetId}): nonce read failed (${errorWords(err)})`,
    );
    return c.json({ error: "The callback could not be checked; try again" }, 500);
  }
  if (!pending) {
    console.warn(`[${route}] no waiting review ${reviewId} (${datasetId})`);
    return c.json(UNAUTHORIZED, 401);
  }
  const ok = await verifyPublicationReviewCallbackToken(
    token,
    { datasetId, reviewId, nonce: pending.nonce },
    secret,
  );
  if (!ok) {
    console.warn(`[${route}] token mismatch for review ${reviewId} (${datasetId})`);
    return c.json(UNAUTHORIZED, 401);
  }
  return { reviewId, datasetId, nonce: pending.nonce, body: b };
}

export function registerPublicationReviewRoutes(webhooks: WebhookRouter): void {
  webhooks.post("/publication-review-claim", async (c) => {
    const v = await verify(c, "publication-review-claim");
    if (v instanceof Response) return v;
    let claim: Awaited<ReturnType<typeof claimPublicationReview>>;
    try {
      claim = await claimPublicationReview(
        c.env,
        v.reviewId,
        v.datasetId,
        v.nonce,
        deferAfterAnswer(c),
      );
    } catch (err) {
      // Every write on the claim's path is one conditional statement, so the job may try again
      // (a claim that did land answers `already_claimed`, which never buys a second model call).
      // The words of the error are logged, never the error (see `verify`).
      console.error(
        `[publication-review-claim] review ${v.reviewId} (${v.datasetId}): claim failed (${errorWords(err)})`,
      );
      return c.json({ error: "The claim could not be taken; try again" }, 500);
    }
    console.log(`[publication-review-claim] review ${v.reviewId} (${v.datasetId}): ${claim}`);
    if (claim === "claimed") return c.json({ ok: true, claimed: true });
    return c.json({ ok: false, claimed: false, reason: claim }, 409);
  });

  webhooks.post("/publication-review-inputs", async (c) => {
    const v = await verify(c, "publication-review-inputs");
    if (v instanceof Response) return v;
    let answer: Awaited<ReturnType<typeof publicationReviewInputs>>;
    try {
      answer = await publicationReviewInputs(c.env, v.reviewId, v.datasetId);
    } catch (err) {
      // Nothing was written, so the job may try again. The words of the error, never the error.
      console.error(
        `[publication-review-inputs] review ${v.reviewId} (${v.datasetId}): read failed (${errorWords(err)})`,
      );
      return c.json({ error: "The review's inputs could not be read; try again" }, 500);
    }
    // Fixed words only: the body is the dataset's metadata and is never logged.
    console.log(
      `[publication-review-inputs] review ${v.reviewId} (${v.datasetId}): ${answer.kind}`,
    );
    if (answer.kind === "not_claimed") {
      return c.json({ ok: false, reason: "not_claimed" }, 409);
    }
    if (answer.kind === "unavailable") {
      return c.json({ error: "The review's inputs could not be read" }, 502);
    }
    return c.json(answer.body);
  });

  webhooks.post("/publication-review-result", async (c) => {
    const v = await verify(c, "publication-review-result");
    if (v instanceof Response) return v;

    // A confirming row (ADR 0139, decision 1) is answered on the confirming model, which no other
    // row may name; the store then checks the model and effort against the row once more.
    let confirming = false;
    try {
      confirming = (await readReview(c.env.DB, v.reviewId))?.confirmOf != null;
    } catch (err) {
      console.error(
        `[publication-review-result] review ${v.reviewId} (${v.datasetId}): read failed (${errorWords(err)})`,
      );
      return c.json({ error: "The result could not be stored; try again" }, 500);
    }
    const outcome = parsePublicationCallbackOutcome(
      { outcome: v.body.outcome, report: v.body.report, error: v.body.error },
      // The parser's reason is a fixed word, so it is safe to log, and without it a contract that
      // drifted between the script (deployed from main) and the Worker looks like a silent
      // "report_invalid" for every review.
      (code) =>
        console.warn(
          `[publication-review-result] review ${v.reviewId} (${v.datasetId}): report refused (${code})`,
        ),
      confirming ? { models: CONFIRMING_MODELS } : {},
    );
    let stored: Awaited<ReturnType<typeof storePublicationReviewResult>>;
    try {
      stored = await storePublicationReviewResult(
        c.env,
        v.reviewId,
        v.datasetId,
        v.nonce,
        outcome,
        deferAfterAnswer(c),
        afterPublicationReviewStored,
      );
    } catch (err) {
      // Nothing was stored and the token is not spent (the store is one transaction), so the job
      // may try again. The class of the error is logged, never its message.
      console.error(
        `[publication-review-result] review ${v.reviewId} (${v.datasetId}): store failed (${errorWords(err)})`,
      );
      return c.json({ error: "The result could not be stored; try again" }, 500);
    }
    if (stored.refusal === "unclaimed") {
      // A report implies a model call, and a call is only made by a run that took its claim.
      // Answered as a row that is not waiting is, so the answer says nothing more than that.
      console.warn(
        `[publication-review-result] review ${v.reviewId} (${v.datasetId}): report refused (not_claimed)`,
      );
      return c.json(UNAUTHORIZED, 401);
    }
    if (!stored.stored) {
      // Verified, but another writer (a duplicate callback) won the one conditional UPDATE
      // between the read and the write. Harmless.
      return c.json({ ok: true, dataset_id: v.datasetId, duplicate: true });
    }
    // Fixed words only: the state, and for an error the closed word for it.
    console.log(
      `[publication-review-result] review ${v.reviewId} (${v.datasetId}): ${stored.state}${
        outcome.kind === "error" ? ` (${outcome.error})` : ""
      }`,
    );
    return c.json({ ok: true, dataset_id: v.datasetId });
  });
}
