/**
 * The wire shapes of the publication review's admin surfaces (ADR 0101, section 8):
 *
 *   GET  /admin/publish/requests              each row gains `publication_review`
 *   GET  /admin/publish/:id/review            the review of the active request, with its history
 *   POST /admin/publish/:id/review/start      start the review of the current screened commit
 *
 * Types and closed vocabularies only, so the Worker that answers and the CLI that prints read ONE
 * definition. Every sentence comes from `describePublicationReview` and the reasons table in
 * `shared/publication-review.ts`; a client renders the server's words and decides nothing itself.
 * No shape here carries a nonce, a token, a path, a file name or a screen finding.
 */

import type {
  Answer,
  PublicationDeclineDetail,
  PublicationOutcome,
  PublicationReviewDescription,
  PublicationReviewEvidence,
  PublicationReviewState,
  PublicationRunError,
  Question,
  ReasonCode,
} from "../publication-review.js";

// The review's own vocabulary is declared once, in `shared/publication-review.ts`.
export type {
  Answer,
  PublicationDeclineDetail,
  PublicationOutcome,
  PublicationReviewDescription,
  PublicationReviewState,
  PublicationRunError,
  Question,
  ReasonCode,
};

/** Which Worker answered: its own D1, its own reviews. */
export type PublicationReviewEnvironment = "production" | "non-production";

/**
 * What a surface shows for one request, before the outcome:
 *
 *  - `not_applicable`: an OpenNeuro mirror or an exemplar; no row, no gate, no outcome.
 *  - `off`: `PUBLICATION_REVIEW_ENABLED` is not `1`. A stored review is still derived and shown,
 *    as advice that gates nothing.
 *  - `not_reviewed`: no review of the screened commit and flag is on record, or the request is
 *    over and none ever was.
 *  - `running`: the review in force was handed to GitHub and has not reported or aged out.
 *  - `decided`: the review in force reached a terminal state (reported, declined, errored or
 *    unreported); the outcome and its reasons say what that means.
 */
export const PUBLICATION_REVIEW_VIEW_KINDS = [
  "not_applicable",
  "off",
  "not_reviewed",
  "running",
  "decided",
] as const;
export type PublicationReviewViewKind = (typeof PUBLICATION_REVIEW_VIEW_KINDS)[number];

/** What the approval gate (Phase 2) does with this request: enforces the review, is off, or does not apply. */
export type PublicationReviewGateState = "enforced" | "off" | "n/a";

/** One reason, with the shared words for it. */
export interface ReasonView {
  code: ReasonCode;
  class: "fail" | "unknown";
  cleared_by: "nothing" | "screen_acknowledgment" | "override";
  /** The closed word or words behind the reason, or null. */
  detail: string | null;
  sentence: string;
  cure: string;
}

/** The review of one row of `GET /admin/publish/requests`. */
export interface PublicationReviewSummary {
  kind: PublicationReviewViewKind;
  /** `PUBLICATION_REVIEW_ENABLED` is exactly `"1"`. */
  enabled: boolean;
  gate: PublicationReviewGateState;
  /**
   * Null when the request is not assessed: `not_applicable`, or no review is on record and none
   * gates the request (`off`, or a `not_reviewed` request that is over). Such a row has no reasons
   * either. An open request with the review on and no review on record is assessed, and reads
   * `action_required` with `review_not_started`.
   */
  outcome: PublicationOutcome | null;
  headline: string;
  tone: "ok" | "note" | "warn" | "stop";
  reasons: ReasonCode[];
  /** The review in force, when there is one. */
  review_id: number | null;
  head_sha: string | null;
}

/** The review in force, as `GET /admin/publish/:id/review` shows it. Counts and closed words only. */
export interface PublicationReviewRecord {
  id: number;
  head_sha: string;
  anonymous: boolean;
  state: PublicationReviewState;
  /** The closed word of a declined or errored row. */
  detail: PublicationDeclineDetail | PublicationRunError | null;
  /** The verdict column, as stored when the review reported. */
  stored_verdict: PublicationOutcome | null;
  model: string | null;
  version: string | null;
  created_at: string;
  decided_at: string | null;
  started_by: number | null;
  /** The administrator's recorded override (written by Phase 2), and the reasons it was given for. */
  override: { by: number; at: string; reasons: ReasonCode[] } | null;
  /** After the facts (`answersOf`); null when there is no readable report. */
  questions: Record<Question, Answer> | null;
  /** Severity and code are plain strings so a newer server's word does not break an older client. */
  findings: Array<{
    question: Question;
    severity: string;
    code: string;
    document: string | null;
    note: string;
  }>;
  /** The model's summary, sanitized. */
  summary: string | null;
  evidence: PublicationReviewEvidence | null;
}

/** One past review of the request, newest first: never the outcome. */
export interface PublicationReviewHistoryEntry {
  id: number;
  head_sha: string;
  anonymous: boolean;
  state: PublicationReviewState;
  verdict: PublicationOutcome | null;
  created_at: string;
  decided_at: string | null;
}

/** `GET /admin/publish/:id/review`. */
export interface PublicationReviewDetail {
  environment: PublicationReviewEnvironment;
  enabled: boolean;
  dataset_id: string;
  request_id: number;
  request_status: string;
  anonymous: boolean;
  applies: boolean;
  gate: PublicationReviewGateState;
  /** Null when the request is not assessed; see {@link PublicationReviewSummary.outcome}. */
  outcome: PublicationOutcome | null;
  reasons: ReasonView[];
  /** Headline, tone, lines (the standing line last) and the next command. */
  description: PublicationReviewDescription;
  review: PublicationReviewRecord | null;
  history: PublicationReviewHistoryEntry[];
  history_truncated: boolean;
}

/**
 * What a start did, or why it did not. `dispatched` and `redispatched` started a run;
 * `dispatch_claimed` means a failed dispatch found its run already claimed, so the run stands.
 */
export const START_REASONS = [
  "dispatched",
  "redispatched",
  "dispatch_claimed",
  "running",
  "has_result",
  "review_disabled",
  "not_applicable",
  "not_owned_here",
  "request_not_requested",
  "screen_not_ready",
  "depositor_limit",
  "platform_limit",
  "dispatch_failed",
  "dispatch_unconfigured",
] as const;
export type StartReason = (typeof START_REASONS)[number];

/** `POST /admin/publish/:id/review/start`. */
export interface StartPublicationReviewResponse {
  environment: PublicationReviewEnvironment;
  started: boolean;
  reason: StartReason;
  review_id: number | null;
}

/** Every error word these routes answer with, in the body's `code` field. */
export const PUBLICATION_REVIEW_ERROR_CODES = [
  "bad_dataset",
  "not_found",
  "origin_not_allowed",
  "review_disabled",
  "not_applicable",
  "not_owned_here",
  "request_not_requested",
  "screen_not_ready",
  "running",
  "has_result",
  "platform_limit",
  "internal",
] as const;
export type PublicationReviewErrorCode = (typeof PUBLICATION_REVIEW_ERROR_CODES)[number];
