/**
 * Publication wire-shape vocabulary (#1255, epic #1250).
 *
 * The two enums here were each hand-duplicated in a backend module and again
 * in the CLI client, which is how a value gets added on one side only. They
 * follow the same pattern as `zarr_status` / `attestation_*` in dataset.ts:
 * declared once in Zod, consumed as a type by both halves.
 *
 * Zero deps beyond zod (extraction-ready for @nemar/contract).
 */

import { z } from "zod";

/**
 * ORCID iD: four groups of four digits, last character may be X (checksum).
 *
 * ONE definition (#1255 review item 11). It was previously spelled out
 * separately in the CLI, in the signup schema, in the ORCID service, and not
 * at all in the admin test-fixture route, which checked only `max(19)` and so
 * accepted any 19-character string as an iD.
 */
export const ORCID_ID_PATTERN = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

/** Zod form of {@link ORCID_ID_PATTERN}, with the message users see. */
export const orcidIdSchema = z
  .string()
  .regex(ORCID_ID_PATTERN, "ORCID must be in format 0000-0000-0000-000X");

/**
 * What a public ORCID record lookup produced.
 *
 * `no_public_name` and `lookup_failed` are kept apart for the same reason
 * {@link backfillNameOutcomeSchema} keeps them apart: one is a settled fact
 * about the record and the other is a transient failure, and the advice a
 * user needs differs.
 */
export const orcidNameLookupStatusSchema = z.enum(["found", "no_public_name", "lookup_failed"]);
export type OrcidNameLookupStatus = z.infer<typeof orcidNameLookupStatusSchema>;

/**
 * Why a publication request is blocked (`publication_requests.block_reason`).
 *
 * The column itself is free TEXT (migration 0015) and holds legacy values, so
 * this is the vocabulary a CURRENT backend writes, not a database constraint.
 * Readers must therefore degrade gracefully on an unrecognised value rather
 * than narrow to this union and drop the row -- which is exactly what the
 * backend's BLOCK_MESSAGES lookup does (falling back to a generic sentence)
 * and what the website's admin queue does (rendering the raw code).
 */
export const publicationBlockReasonSchema = z.enum([
  "bids_validation_failed",
  "bids_validation_pending",
  "bids_validation_in_progress",
  /** Legacy: the pre-screen stopped blocking in #756. */
  "prescreen_failed",
  "min_requirements_failed",
  /** #1255: the owner has no researcher name, so a DOI cannot cite them. */
  "owner_name_missing",
  /** Epic #1610 phase 4: the identifier screen found a direct identifier. */
  "identifier_screen_findings",
]);
export type PublicationBlockReason = z.infer<typeof publicationBlockReasonSchema>;

/**
 * The two block reasons that only say BIDS validation has not concluded (no run
 * yet, or one going), as opposed to `bids_validation_failed`. A request blocked
 * for either is waiting, not rejected: the sweep releases it when validation
 * passes, and the CLI reports it as a state. Declared once here for the route,
 * the sweep and the CLI.
 */
export const CI_PENDING_BLOCK_REASONS = [
  "bids_validation_pending",
  "bids_validation_in_progress",
] as const satisfies readonly PublicationBlockReason[];

export type CiPendingReason = (typeof CI_PENDING_BLOCK_REASONS)[number];

/** Is this block reason one of the two that only say validation has not concluded? */
export function isCiPendingReason(reason: unknown): reason is CiPendingReason {
  return (
    typeof reason === "string" && (CI_PENDING_BLOCK_REASONS as readonly string[]).includes(reason)
  );
}

/**
 * `error` code of the 503 a publication request gets when NEMAR could not check
 * BIDS validation status at all (token, workflow deploy, GitHub outage), as
 * opposed to checking and finding no run yet. It is not a block reason, so the
 * vocabulary above is unchanged; the sentence is in `message`, and the CLI's
 * client leads with it ({@link PUBLICATION_REFUSAL_ERROR_CODES}).
 */
export const CI_CHECK_UNAVAILABLE_CODE = "ci_check_unavailable";

/**
 * Codes a publication-request refusal carries in `error` with the human
 * sentence in `message`, so the CLI's client prints the sentence and not the
 * bare token.
 */
export const PUBLICATION_REFUSAL_ERROR_CODES: readonly string[] = [CI_CHECK_UNAVAILABLE_CODE];

/**
 * The codes the identifier screen's refusals carry in `error` (epic #1610,
 * phase 4), with the human sentence in `message`. Declared here so the CLI's
 * client knows to lead with the sentence rather than print a bare token.
 */
export const IDENTIFIER_SCREEN_ERROR_CODES: readonly string[] = [
  /** Resend while the screen still runs: the admins are mailed when it finishes. */
  "identifier_screen_pending",
  /** An approval the screen does not allow (stale, unverifiable, not run, findings). */
  "identifier_screen_not_clear",
  /** A sandbox (xx) dataset, which is not screened. */
  "identifier_screen_not_applicable",
];

/**
 * The codes an approval refusal carries in `error` with the human sentence in `message` (ADR
 * 0102; ADR 0080 for the dispatch token, Phase 3): the review gate's 409, the
 * blocked request's, the request that changed while the approval was being checked, an override
 * sent inside a web approval, a run for a request that is no longer the one in force, a dispatch
 * token that was replaced or has lapsed, a decision sent by a run the web started, the two
 * refusals of a denial (a request that is running, and one that has started publishing), and a web
 * approval for an id the executor's workflow would not accept (a 400, before anything is claimed). Declared
 * here, beside the screen's, so the CLI's client leads with the sentence and not the bare token.
 * The first two words are the `error` of the bodies in `publication-review-admin.ts`
 * (`PUBLICATION_REVIEW_NOT_CLEAR_CODE`, `REQUEST_BLOCKED_CODE`); this file stays free of every
 * dependency but zod, and a test holds the spellings together.
 */
export const APPROVAL_REFUSAL_ERROR_CODES: readonly string[] = [
  "publication_review_not_clear",
  "request_blocked",
  "request_changed",
  "override_inside_web_approval",
  /** A run named a request that is not the newest active one: it was denied or filed again. */
  "request_mismatch",
  /** The claim a dispatch token was minted for was released, replaced or taken over. */
  "dispatch_superseded",
  /** The token is genuine, but its run sat idle past the lease. */
  "dispatch_expired",
  /** A run the web started sent an override or an acknowledgment of its own. */
  "decision_with_dispatch_token",
  /** A denial of a request an approval is running for (the deny route's word). */
  "approval_in_flight",
  /** A denial of a request that has started publishing (the deny route's word). */
  "deny_after_publishing",
  /** A web approval for an id the executor workflow would refuse (the dispatch route's 400). */
  "invalid_dataset_id",
];

/**
 * The sentence of the 409 `request_changed`: the request moved (a denial, a re-block) between the
 * gates' read of it and the write that marks it `approving`. Declared here so the Worker, the
 * clients and the tests say the one sentence.
 */
export const REQUEST_CHANGED_MESSAGE =
  "The request changed while the approval was being checked (it was denied or blocked). Read it again before approving.";

/**
 * The sentence of the 409 `request_changed` that an approval answers when its LAST write finds
 * the request closed: the steps had run, and then the request was denied (once its lease had
 * lapsed) or blocked again, so the run did not mark it published. The steps cannot be taken back,
 * so the sentence sends the reader to look at the request and the dataset before anything else.
 */
export const APPROVAL_FINISHED_ON_CLOSED_REQUEST_MESSAGE =
  "The request was closed while this approval was running (it was denied, or blocked again), so the run did not mark it published. Its steps had already run: read the request and the dataset again before doing anything else.";

/**
 * The sentence of the 409 `override_inside_web_approval`: an override sent while a web approval of
 * the request is in progress would be recorded under the administrator who clicked.
 */
export const OVERRIDE_INSIDE_WEB_APPROVAL_MESSAGE =
  "A web approval of this request is in progress, so an override sent now would be recorded under the administrator who clicked. Wait for it to finish or stop, then approve again with --force.";

/**
 * The sentence of the 409 `request_mismatch`: the approval named a request (`request_id`) that is
 * not the newest active request of the dataset, because it was denied or filed again since the
 * administrator read it. Nothing was recorded.
 */
export const REQUEST_MISMATCH_MESSAGE =
  "The request in force for this dataset is not the one this approval was for (it was denied or filed again since). Read the request again before approving.";

/**
 * The sentence of the 409 `dispatch_superseded`: the dispatch token names a claim that is no
 * longer the request's (released, replaced by a newer click, or taken over by an approval at a
 * terminal), or the Worker could not verify it. The refused call changed nothing.
 */
export const DISPATCH_SUPERSEDED_MESSAGE =
  "The web approval this run was started for is no longer current (it was replaced by a newer click, released, or taken over by an approval at a terminal), so this run was refused and changed nothing.";

/**
 * The sentence of the 409 `dispatch_expired`: the token is genuine, but its run sat idle past the
 * approval lease, so a click made then is not honored for work done now.
 */
export const DISPATCH_EXPIRED_MESSAGE =
  "The web approval this run was started for has expired: the run sat idle longer than its lease, so a click made then is not honored now. Nothing was changed. Click Approve again to start a fresh run.";

/**
 * The sentence of the 409 `decision_with_dispatch_token`: a run the web started carries the
 * decision made at the click (the override and the screen acknowledgment were recorded then) and
 * may not send one of its own.
 */
export const DECISION_WITH_DISPATCH_TOKEN_MESSAGE =
  "A run started by a web approval carries the decision made at the click and may not send its own: no override and no identifier-screen acknowledgment. Nothing was recorded.";

/**
 * The sentence of the deny route's 409 `approval_in_flight`: an approval of the request is
 * running, so a denial would overwrite a run that is still writing.
 */
export const APPROVAL_IN_FLIGHT_MESSAGE =
  "An approval of this request is running, so it cannot be denied right now. Wait for it to finish or stall, then deny it.";

/**
 * The sentence of the deny route's 409 `deny_after_publishing`: the approval has begun the
 * irreversible steps, so the dataset may already be public and the depositor must not be told it
 * was denied.
 */
export const DENY_AFTER_PUBLISHING_MESSAGE =
  "An approval of this request has already started publishing, so the dataset may already be public and the request cannot be denied. Resume the approval to finish it.";

/**
 * The sentence of the dispatch route's 400 `invalid_dataset_id`: the id is not one the executor
 * workflow accepts for this environment (`APPROVAL_DISPATCH_ID_RE` in `publication-limits.ts`), so
 * the route refuses it before it reads or claims anything, and no lease is held for a run that
 * could only fail in the workflow's own validation.
 */
export const INVALID_DATASET_ID_MESSAGE =
  "This is not a dataset id an approval can be started for from the web: it is nm or on followed by six digits (a development environment also accepts xx). Nothing was claimed and nothing was sent.";

/**
 * Why an approval executor releases the claim it was dispatched under (ADR 0080, Phase 3): the
 * closed vocabulary of the `reason` a failing executor reports. The Worker stores the sentence of
 * the word (never the word, and never a string the executor wrote) as the request's `last_error`,
 * so a failure the Worker cannot see for itself shows on the page and the claim does not hold its
 * lease for fifteen minutes. A word outside this list is read as `workflow_failed`.
 */
export const APPROVAL_RELEASE_REASONS = [
  "workflow_failed",
  "workflow_cancelled",
  "secret_missing",
  "install_failed",
  "input_rejected",
  "preflight_failed",
] as const;

export type ApprovalReleaseReason = (typeof APPROVAL_RELEASE_REASONS)[number];

/** The one fixed sentence of each {@link APPROVAL_RELEASE_REASONS} word. */
export const APPROVAL_RELEASE_REASON_TEXT: Record<ApprovalReleaseReason, string> = {
  workflow_failed:
    "The approval workflow failed before the approval finished. Click Approve again to resume it.",
  workflow_cancelled:
    "The approval workflow was cancelled before the approval finished. Click Approve again to resume it.",
  secret_missing:
    "The approval workflow could not start because a credential it needs is not configured. Tell the maintainers, then click Approve again.",
  install_failed:
    "The approval workflow could not install the command line tool it runs. Click Approve again to retry.",
  input_rejected:
    "The approval workflow refused the request it was given, so nothing was approved.",
  preflight_failed:
    "The approval workflow's own checks of the request failed before it began, so nothing was approved.",
};

/**
 * The request header an approval executor presents its dispatch token in (ADR 0080, Phase 3 of
 * the publication review). The Worker reads it on `/approve` to decide whether the call belongs
 * to the web claim it was dispatched for, and the CLI sends it when the executor's workflow hands
 * it the token. Declared once so the two cannot spell it differently, and so the `--debug` log's
 * header redaction is held to the same spelling by a test: the token is a credential-shaped value
 * in a header, and that log is what users are told to attach to public issues.
 */
export const APPROVAL_DISPATCH_TOKEN_HEADER = "X-Approval-Dispatch-Token";

/**
 * Per-user outcome of `POST /admin/users/backfill-names` (#1255).
 *
 * `no_public_name` and `lookup_failed` are deliberately distinct: the first is
 * a settled fact about the ORCID record (the owner must act), the second is a
 * transient infrastructure failure (retry the batch). Collapsing them would
 * tell an operator to chase a user over a 503.
 *
 * `write_failed` is the same distinction one step later (#1274). The ORCID
 * read was already wrapped per row, so one unreadable record could not stop
 * the other 600 -- but the UPDATE that followed it was not, so one failed
 * write threw out of the loop, answered a bare 500, and discarded the summary
 * of every row the batch had already filled. The row stays a candidate and the
 * next run retries it, exactly like `lookup_failed`.
 */
export const backfillNameOutcomeSchema = z.enum([
  "filled",
  "would_fill",
  "no_public_name",
  "lookup_failed",
  "write_failed",
]);
export type BackfillNameOutcome = z.infer<typeof backfillNameOutcomeSchema>;
