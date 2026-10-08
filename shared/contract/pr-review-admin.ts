/**
 * The wire shapes of the pull-request review queue's admin routes (ADR 0093, following ADR 0092):
 *
 *   GET    /admin/pr-reviews                      every open pull request to `main`, with its review
 *   GET    /admin/pr-reviews/:dataset/:pr         one pull request: the stored report, its history
 *   GET    /admin/pr-review-authors/:login        a contributor's tally, override and standing
 *   PUT    /admin/pr-review-authors/:login        allow or block a contributor outright
 *   DELETE /admin/pr-review-authors/:login        remove that decision, so the tally decides again
 *
 * Types, the closed verdict vocabulary, and nothing else, so the Worker that answers and the CLI
 * that prints read ONE definition. Every string a pull request's author controls (title, branch)
 * arrives here already reduced to plain words by `sanitizeNote`; the CLI strips control characters
 * again on the way to the terminal, because it should not rely on a server's hygiene alone.
 */

import type {
  AuthorOverride,
  AuthorTally,
  DeclineReason,
  ReviewOutcome,
  RunError,
  Standing,
} from "../pr-review.js";

/**
 * What the queue shows for one pull request, in the words an administrator uses.
 *
 *  - `pass`, `fail`, `uncertain`: the derived verdict of a review OF THE CURRENT COMMIT.
 *  - `not_reviewed`: no review of the current commit exists. That is also the answer when the
 *    review is off, when the contributor was paused or rate limited (`detail` says which), and
 *    when only an EARLIER commit was reviewed (`review_current` is false and `stale_verdict`
 *    says what that one got). A verdict is never carried over to a commit it did not read.
 *  - `in_progress`: the review was handed to GitHub and has not reported.
 *  - `could_not_decide`: the review ran and ended without a verdict (an error, or it never
 *    reported). `detail` says why.
 */
export const QUEUE_VERDICTS = [
  "pass",
  "fail",
  "uncertain",
  "not_reviewed",
  "in_progress",
  "could_not_decide",
] as const;
export type QueueVerdict = (typeof QUEUE_VERDICTS)[number];

/** The state of one required check on the pull request's head commit. */
export const CHECK_STATES = ["pass", "fail", "pending", "missing", "unknown"] as const;
export type CheckState = (typeof CHECK_STATES)[number];

export interface QueueEntry {
  dataset_id: string;
  pr_number: number;
  url: string;
  /** Plain words only (`sanitizeNote`). */
  title: string;
  author_login: string;
  /** GitHub's numeric id, the key of the contributor tally. Null for an account GitHub no longer has. */
  author_id: number | null;
  from_fork: boolean;
  /** `branch`, or `owner:branch` for a fork. Plain words only. */
  head_label: string;
  head_sha: string;
  draft: boolean;
  created_at: string;
  updated_at: string;
  verdict: QueueVerdict;
  /** The closed word behind `not_reviewed` (a decline) or `could_not_decide` (a run error). */
  detail: DeclineReason | RunError | "unreported" | null;
  /** The commit the stored review read, or null when there is no review at all. */
  reviewed_sha: string | null;
  /** True when the stored review is of this pull request's current head; null with no review. */
  review_current: boolean | null;
  /** What an EARLIER commit's review concluded, when `review_current` is false. */
  stale_verdict: QueueVerdict | null;
  /** The BIDS validation check (`Run BIDS Validation`, or `bids-validation` on a legacy repo). */
  bids: CheckState;
  /** The `version-check` check. */
  version: CheckState;
  /** An administrator can act on this one now: approve it, or review it by hand. */
  needs_you: boolean;
}

export interface QueueSkipped {
  /** Open pull requests in repositories whose name is not a dataset id. */
  not_a_dataset: number;
  /** Datasets the other environment's Worker answers for (the dev/production ownership fence). */
  not_owned_here: number;
}

export interface QueueResponse {
  environment: "production" | "non-production";
  /** The review itself is switched on in this environment (`PR_REVIEW_ENABLED`). */
  review_enabled: boolean;
  /** Pull requests after the filters, ordered with the ones an administrator can act on first. */
  entries: QueueEntry[];
  /** Open pull requests found before the filters were applied. */
  total_open: number;
  /** GitHub search returned fewer pull requests than exist (its 1000-result cap, or a page limit). */
  truncated: boolean;
  skipped: QueueSkipped;
  filters: {
    verdicts: QueueVerdict[];
    dataset: string | null;
    author: string | null;
    needs_me: boolean;
  };
}

export interface ReviewHistoryItem {
  id: number;
  head_sha: string;
  state: "dispatched" | "reported" | "declined" | "errored" | "unreported";
  verdict: QueueVerdict;
  created_at: string;
  decided_at: string | null;
}

export interface ReviewRecord {
  id: number;
  head_sha: string;
  verdict: QueueVerdict;
  detail: QueueEntry["detail"];
  author_login: string;
  author_id: number;
  from_fork: boolean;
  created_at: string;
  decided_at: string | null;
  /** The stored outcome, re-validated on the way out; null while the review is in progress. */
  outcome: ReviewOutcome | null;
}

/** What GitHub says about the pull request right now. Best effort: null when GitHub could not be read. */
export interface LivePullRequest {
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  head_sha: string;
  base_ref: string;
  url: string;
  title: string;
  author_login: string;
  author_id: number | null;
  from_fork: boolean;
  head_label: string;
}

export interface ContributorStanding {
  login: string;
  author_id: number;
  tally: AuthorTally;
  override: null | {
    mode: Exclude<AuthorOverride, null>;
    reason: string | null;
    set_at: string;
    set_by: string | null;
  };
  standing: Standing;
  /** The tally rule, so a reader can see how far from a pause a contributor is. */
  thresholds: { rejected_more_than: number; percent_more_than: number };
  /** The latest decided review of each of the contributor's most recent pull requests. */
  recent: Array<{
    dataset_id: string;
    pr_number: number;
    head_sha: string;
    verdict: "pass" | "fail";
    decided_at: string | null;
  }>;
  /** Where the login came from: GitHub now, or the review history when GitHub could not answer. */
  resolved_from: "github" | "history";
}

export interface PrReviewDetail {
  environment: QueueResponse["environment"];
  review_enabled: boolean;
  dataset_id: string;
  pr_number: number;
  /**
   * What the queue would call this pull request: the stored verdict only when the review read the
   * commit GitHub says is the head (`not_reviewed` for an earlier commit's). When GitHub could not
   * be read, `live` is null and this is the stored verdict as it stands, with `review_current` null.
   */
  verdict: QueueVerdict;
  detail: QueueEntry["detail"];
  /** The latest stored review of this pull request, or null (not reviewed). */
  review: ReviewRecord | null;
  /** Every stored review of this pull request, newest first. */
  history: ReviewHistoryItem[];
  live: LivePullRequest | null;
  /** True when `review` is of `live.head_sha`; null when either side is unknown. */
  review_current: boolean | null;
  /** The pull request's author, with the standing the review gate would apply today. */
  author: ContributorStanding | null;
}

/** The body of `PUT /admin/pr-review-authors/:login`. */
export interface SetOverrideRequest {
  mode: "allow" | "block";
  reason?: string;
}

export interface SetOverrideResponse {
  environment: QueueResponse["environment"];
  /** What the contributor had before this call. */
  previous: "allow" | "block" | null;
  standing: ContributorStanding;
}

export interface ClearOverrideResponse {
  environment: QueueResponse["environment"];
  /** What was removed; null when there was nothing to remove. */
  removed: "allow" | "block" | null;
  standing: ContributorStanding;
}
