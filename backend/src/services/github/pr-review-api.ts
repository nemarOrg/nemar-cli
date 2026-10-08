/**
 * Where the pull-request review's result is published (ADR 0092): one check-run and one comment
 * on the pull request, both made by the NEMAR GitHub App and both edited in place when a new
 * commit is reviewed.
 *
 * Two surfaces, and each can fail on its own. A check-run needs the App's `checks: write`, which
 * the BIDS and version checks already use. The comment needs `pull_requests: write` or
 * `issues: write`, which an installation may not have been granted; when it has not, the check
 * still lands and the caller logs the comment's refusal. Neither failure is allowed to lose the
 * stored verdict, so these functions throw and the caller decides what each failure costs.
 *
 * A check-run can be created only by a GitHub App installation token. The PAT fallback
 * `getDatasetsToken` can return for an unconfigured environment is refused by GitHub with a 403,
 * which surfaces here as a thrown status.
 */

import { type CheckConclusion, PR_REVIEW_CHECK_NAME } from "../../../../shared/pr-review.js";
import { GITHUB_API, ORG_NAME, ghHeaders } from "./shared";
import { githubFetchWithRetry } from "./transport";

/** GitHub caps a check-run's `summary` and `text` at 65535 characters each. */
const CHECK_TEXT_MAX = 60_000;
/** A comment may hold 65536 characters. */
const COMMENT_MAX = 60_000;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 40).trimEnd()}\n\n(Output shortened.)`;
}

export interface CheckRunInput {
  token: string;
  repo: string;
  headSha: string;
  /** The existing check-run to update, or null to create one. */
  checkRunId: number | null;
  /** `in_progress` for a review that is running; `completed` carries a conclusion. */
  conclusion: CheckConclusion | null;
  title: string;
  summary: string;
  text: string;
}

/**
 * Create or update the review's check-run and return its id. A 404 on update (the run was
 * deleted, or belongs to another installation) falls through to a create, so a stale id in the
 * database never strands a result.
 */
export async function upsertReviewCheckRun(input: CheckRunInput): Promise<number> {
  const output = {
    title: input.title,
    summary: clip(input.summary, CHECK_TEXT_MAX),
    text: clip(input.text, CHECK_TEXT_MAX),
  };
  const done =
    input.conclusion === null
      ? { status: "in_progress" }
      : {
          status: "completed",
          conclusion: input.conclusion,
          completed_at: new Date().toISOString(),
        };

  if (input.checkRunId !== null) {
    const res = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${input.repo}/check-runs/${input.checkRunId}`,
      {
        method: "PATCH",
        headers: { ...ghHeaders(input.token), "Content-Type": "application/json" },
        body: JSON.stringify({ ...done, output }),
      },
      { kind: "background" },
    );
    if (res.ok) return input.checkRunId;
    if (res.status !== 404) throw new Error(`check-run update refused: HTTP ${res.status}`);
  }

  const res = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${input.repo}/check-runs`,
    {
      method: "POST",
      headers: { ...ghHeaders(input.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: PR_REVIEW_CHECK_NAME,
        head_sha: input.headSha,
        started_at: new Date().toISOString(),
        ...done,
        output,
      }),
    },
    { kind: "background" },
  );
  if (!res.ok) throw new Error(`check-run create refused: HTTP ${res.status}`);
  const body = (await res.json()) as { id?: unknown };
  if (typeof body.id !== "number" || !Number.isSafeInteger(body.id)) {
    throw new Error("check-run create returned no id");
  }
  return body.id;
}

export interface ReviewCommentInput {
  token: string;
  repo: string;
  prNumber: number;
  /** The comment this pull request already carries, or null to create one. */
  commentId: number | null;
  body: string;
}

/** Create or edit the pull request's one review comment and return its id. */
export async function upsertReviewComment(input: ReviewCommentInput): Promise<number> {
  const body = clip(input.body, COMMENT_MAX);
  if (input.commentId !== null) {
    const res = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${input.repo}/issues/comments/${input.commentId}`,
      {
        method: "PATCH",
        headers: { ...ghHeaders(input.token), "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
      { kind: "background" },
    );
    if (res.ok) return input.commentId;
    if (res.status !== 404) throw new Error(`comment update refused: HTTP ${res.status}`);
  }
  const res = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${input.repo}/issues/${input.prNumber}/comments`,
    {
      method: "POST",
      headers: { ...ghHeaders(input.token), "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    },
    { kind: "background" },
  );
  if (!res.ok) throw new Error(`comment create refused: HTTP ${res.status}`);
  const created = (await res.json()) as { id?: unknown };
  if (typeof created.id !== "number" || !Number.isSafeInteger(created.id)) {
    throw new Error("comment create returned no id");
  }
  return created.id;
}
