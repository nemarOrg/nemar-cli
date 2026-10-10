/**
 * Start the review of a pull request that is already open (ADR 0092, ADR 0093).
 *
 * The Worker reviews on events, and a pull request that was open before the review was switched
 * on produced none. An administrator asks for one by dataset and number. Nothing about the pull
 * request comes from the caller: the Worker reads it from GitHub with the datasets token, shapes it
 * as the `pull_request` delivery it would have been, and hands it to the one gate every delivery
 * goes through (`handlePullRequestEvent`). So the flag, the "public, named, first-published"
 * test, the per-commit dedupe, the contributor pause and the platform's daily pool all apply
 * exactly as they would to a delivery. Two things differ, and both are the administrator's choice
 * made by name: the per-contributor allowances do not hold the review back, and a commit whose
 * review ended without a verdict (declined, errored, never reported) is started again.
 *
 * Nothing here approves, merges or comments on a pull request itself; the review's own check and
 * comment are published by the same code that publishes them for a delivery.
 */

import type { StartReviewResponse } from "../../../shared/contract/pr-review-admin.js";
import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { getDatasetsTokenWithRefresher } from "./github-auth.js";
import { GITHUB_API, ORG_NAME, ghHeaders } from "./github/shared.js";
import { githubFetchWithRetry } from "./github/transport.js";
import { QueueError, environmentName, ownedHere } from "./pr-review-queue.js";
import { handlePullRequestEvent } from "./pr-review.js";

/** A GitHub login's shape; anything else is not echoed back. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const READ_TIMEOUT_MS = 10_000;
const MAX_THROTTLE_MS = 15_000;

/** GitHub's REST record of one pull request, or why there is none. */
async function readPullRequest(
  env: Bindings,
  datasetId: string,
  prNumber: number,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    const { token, refresh } = await getDatasetsTokenWithRefresher(env);
    res = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${datasetId}/pulls/${prNumber}`,
      { headers: ghHeaders(token), signal: AbortSignal.timeout(READ_TIMEOUT_MS) },
      {
        kind: "interactive",
        maxAttempts: 2,
        maxThrottleMs: MAX_THROTTLE_MS,
        refreshTokenOn401: refresh,
      },
    );
  } catch (err) {
    console.error(
      `[pr-review-start] ${datasetId}#${prNumber}: GitHub read failed (${err instanceof Error ? err.name : "error"})`,
    );
    throw new QueueError(
      502,
      "github_unavailable",
      "GitHub did not answer, so nothing was started.",
    );
  }
  if (res.status === 404) {
    throw new QueueError(404, "no_such_pull_request", "That pull request does not exist.");
  }
  if (!res.ok) {
    console.warn(`[pr-review-start] ${datasetId}#${prNumber}: GitHub answered HTTP ${res.status}`);
    throw new QueueError(
      502,
      "github_unavailable",
      "GitHub did not answer, so nothing was started.",
    );
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new QueueError(502, "github_bad_response", "GitHub's answer could not be read.");
  }
  return body as Record<string, unknown>;
}

/**
 * Review `datasetId#prNumber` now. The answer is the gate's own: `dispatched`, or the fixed word for
 * why not. A pull request that cannot be reviewed (a draft, closed, not aimed at `main`, a bot's) is
 * an answer, not an error; a dataset this Worker does not own, a pull request GitHub does not have
 * and a GitHub that does not answer are errors.
 */
export async function startPullRequestReview(
  env: Bindings,
  adminUserId: number,
  datasetId: string,
  prNumber: number,
): Promise<StartReviewResponse> {
  const environment = environmentName(env);
  if (!ownedHere(env, datasetId)) {
    throw new QueueError(
      404,
      "not_owned_here",
      "The other environment's Worker answers for that dataset.",
    );
  }
  if (env.PR_REVIEW_ENABLED !== "1") {
    return {
      environment,
      dispatched: false,
      reason: "pr_review_disabled",
      review_id: null,
      author_login: null,
    };
  }

  const pull = await readPullRequest(env, datasetId, prNumber);
  const base = pull.base as { repo?: unknown } | null | undefined;
  const result = await handlePullRequestEvent(
    env,
    // The shape a `pull_request` delivery has: GitHub's own record of the pull request, and the
    // repository it targets. `synchronize` is only the delivery's name for "take it up".
    { action: "synchronize", pull_request: pull, repository: base?.repo },
    { adminStart: true },
  );

  const login = (pull.user as { login?: unknown } | null | undefined)?.login;
  const answer: StartReviewResponse = {
    environment,
    dispatched: result.dispatched,
    reason: result.reason,
    review_id: result.review_id ?? null,
    author_login: typeof login === "string" && LOGIN.test(login) ? login : null,
  };
  const head = (pull.head as { sha?: unknown } | null | undefined)?.sha;
  await auditLogStatement(env.DB, {
    userId: adminUserId,
    action: "pr_review_started",
    resourceType: "pr_review",
    resourceId: `${datasetId}#${prNumber}`,
    details: JSON.stringify({
      head_sha: typeof head === "string" ? head : null,
      reason: answer.reason,
      review_id: answer.review_id,
    }),
  }).run();
  return answer;
}
