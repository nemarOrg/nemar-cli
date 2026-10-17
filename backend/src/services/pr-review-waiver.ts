/**
 * An administrator's explicit override of the naming rule, for one commit of one pull request
 * opened by a NEMAR owner or administrator (ADR 0107).
 *
 * Owners and administrators are exempt from the automated review, and not from the naming rule:
 * a title that starts with an author and a year, or a change of the dataset's name to such a name,
 * fails their pull request's check like anyone's. The one way past it without a change is this
 * override, asked for by name with `nemar admin pr-reviews allow <dataset> <pr> --admin`:
 *
 *  1. The Worker reads the pull request from GitHub itself (nothing about it comes from the caller)
 *     and holds it to the same gates as a start: the review is on, the dataset is reviewable, the
 *     pull request is open, aimed at `main`, not a draft and not a bot's.
 *  2. Its current commit must not have been reviewed (a review of it stands, whoever acts next),
 *     and its author must be exempt: the override replaces the exemption for this rule, so it is
 *     never a way past a contributor's review. When GitHub does not answer whether the author holds
 *     the repository's admin role, nothing is waived and the answer is an error, not "not exempt".
 *  3. The rule runs again on that commit. When it finds nothing there is nothing to waive, and the
 *     plain `skipped` check is posted. When it could not read the dataset's name there is nothing
 *     definite to waive yet, and nothing is: a waiver covers only what the rule found.
 *  4. Otherwise the waiver is recorded first (`pr_review_naming_waived` in the audit log: who, the
 *     commit, what the rule found as closed words, and the reason given), and then a `skipped`
 *     check that says the rule was waived is posted on the commit. The exempt path reads the same
 *     row, so a later delivery of that commit keeps the waiver for what it recorded; a problem the
 *     rule finds there later that the waiver did not record, and a new commit, are checked again.
 *
 * It never approves or merges anything, and it records no pull request text: the audit row holds
 * the rule's closed words, not the title or the name.
 */

import type { WaiveNamingResponse } from "../../../shared/contract/pr-review-admin.js";
import { sanitizeNote } from "../../../shared/pr-review.js";
import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { reviewExemption } from "./pr-review-exemption.js";
import { NAMING_WAIVED_ACTION, namingResource } from "./pr-review-naming.js";
import { QueueError, environmentName, ownedHere } from "./pr-review-queue.js";
import { readPullRequest } from "./pr-review-start.js";
import {
  ExemptCheckNotPublished,
  exemptOutcomeFor,
  postExemptCheck,
  readPullRequestEvent,
  reviewableDataset,
} from "./pr-review.js";

/** The most of a reason that is kept, as for a contributor's allow or block. */
const MAX_REASON = 200;

/**
 * Waive the naming rule for `datasetId#prNumber`'s current commit. The answer says what happened in
 * a fixed word; a pull request that cannot be waived is an answer, not an error, and a dataset this
 * Worker does not own, a pull request GitHub does not have and a GitHub that does not answer are
 * errors.
 */
export async function waiveNamingRule(
  env: Bindings,
  adminUserId: number,
  datasetId: string,
  prNumber: number,
  reason: string | undefined,
): Promise<WaiveNamingResponse> {
  const environment = environmentName(env);
  const answer = (
    word: WaiveNamingResponse["reason"],
    rest: Partial<WaiveNamingResponse> = {},
  ): WaiveNamingResponse => ({
    environment,
    waived: false,
    reason: word,
    head_sha: null,
    facts: null,
    ...rest,
  });
  if (!ownedHere(env, datasetId)) {
    throw new QueueError(
      404,
      "not_owned_here",
      "The other environment's Worker answers for that dataset.",
    );
  }
  // With the review off nothing posts a check, so there is no check to turn into a waiver.
  if (env.PR_REVIEW_ENABLED !== "1") return answer("pr_review_disabled");
  const reviewable = await reviewableDataset(env.DB, datasetId);
  if (reviewable !== "reviewable") {
    return answer(reviewable === "unknown" ? "unknown_dataset" : "dataset_not_reviewable");
  }

  const pull = await readPullRequest(env, datasetId, prNumber, "nothing was waived");
  const base = pull.base as { repo?: unknown } | null | undefined;
  const intake = readPullRequestEvent({
    action: "synchronize",
    pull_request: pull,
    repository: base?.repo,
  });
  if (!intake.ok) return answer(intake.reason);
  const pr = intake.pr;
  const head = { head_sha: pr.headSha };

  // A commit a review has touched keeps what its review said: the waiver is for the exempt path.
  const reviewed = await env.DB.prepare(
    "SELECT 1 AS reviewed FROM pr_reviews WHERE dataset_id = ? AND pr_number = ? AND head_sha = ?",
  )
    .bind(pr.datasetId, pr.prNumber, pr.headSha)
    .first<{ reviewed: number }>();
  if (reviewed) return answer("reviewed", head);
  const exemption = await reviewExemption(env, { login: pr.authorLogin, repo: pr.datasetId });
  if (exemption === "unknown") {
    throw new QueueError(
      502,
      "github_unavailable",
      "GitHub did not say whether the author holds the repository's admin role, so nothing was waived. Ask again in a moment.",
    );
  }
  if (exemption === "not_exempt") return answer("not_exempt", head);

  const outcome = await exemptOutcomeFor(env, pr);
  const facts = outcome.kind === "naming" ? outcome.facts : null;
  // A waiver is for what the rule found. A name it could not read is not a finding, and waiving it
  // would also cover whatever that name turns out to be.
  if (facts?.name === "unchecked") return answer("naming_unchecked", { ...head, facts });
  try {
    if (outcome.kind === "exempt" && !outcome.waived) {
      // Nothing to waive, now: post the check the commit should carry.
      await postExemptCheck(env, pr, outcome);
      return answer("nothing_to_waive", head);
    }
    if (outcome.kind === "exempt") {
      // Already waived for this commit: say so again on the commit, and record nothing twice.
      await postExemptCheck(env, pr, outcome);
      return answer("already_waived", { ...head, waived: true });
    }

    // The record comes first: a waiver that is posted but not recorded would leave no trace of who
    // decided it, and a recorded one whose check did not land is posted again by asking again.
    await auditLogStatement(env.DB, {
      userId: adminUserId,
      action: NAMING_WAIVED_ACTION,
      resourceType: "pr_review",
      resourceId: namingResource(pr.datasetId, pr.prNumber),
      details: JSON.stringify({
        head_sha: pr.headSha,
        title: facts?.title ?? null,
        name: facts?.name ?? null,
        reason: reason ? sanitizeNote(reason, MAX_REASON) : null,
      }),
    }).run();
    await postExemptCheck(env, pr, { kind: "exempt", waived: true });
  } catch (err) {
    if (err instanceof ExemptCheckNotPublished) {
      throw new QueueError(
        502,
        "github_unavailable",
        "GitHub would not take the check for this pull request. Anything already recorded stands; ask again in a moment to post it.",
      );
    }
    throw err;
  }
  console.info(
    `[pr-review-waiver] ${pr.datasetId}#${pr.prNumber}: naming rule waived for ${pr.headSha.slice(0, 7)} by user ${adminUserId}`,
  );
  return answer("waived", { ...head, waived: true, facts });
}
