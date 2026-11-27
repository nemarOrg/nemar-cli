/**
 * The automatic denial of a publication request (ADR 0139, decisions 1 to 4 and 8): the rule that
 * says when a review's `fail` may deny a request, the owner's switch and cap as the Worker reads
 * them, and every sentence the denial, the administrators' mail and the digest say.
 *
 * Pure and dependency-light, so the Worker, the tests and any later surface read one definition.
 * No call site words any of this itself (ADR 0045's rule for copy).
 *
 * **What can deny.** Only a first run's `fail` whose reasons include `steering_attempt`, or
 * `question_failed` with a blocker finding of one of {@link AUTO_DENY_FINDING_CODES} against a
 * failed question; confirmed by a second run on {@link CONFIRMING_MODEL} over the same input
 * digest; for a named (not anonymous) request still waiting for its decision, whose review is the
 * one in force; on a dataset with fewer than {@link MAX_EARLIER_AUTO_DENIALS} earlier automatic
 * denials. Nothing about the identifier screen, the license lineage or the infrastructure is ever
 * an eligible reason: those are not in the lists below, and a test pins that.
 */

import {
  LINEAGE_COPY,
  LINEAGE_DOCS_URL,
  LINEAGE_OUTCOMES,
  type LineageOutcome,
} from "./license-lineage.js";
import { isOneOf } from "./pr-review.js";
import {
  type Answer,
  type PublicationFindingCode,
  type PublicationReviewReport,
  QUESTIONS,
  QUESTION_LABEL,
  type Question,
  type RecordedEffort,
  type ReviewerModel,
  answersOf,
  reportReasons,
  verdictOf,
} from "./publication-review.js";

// ---------------------------------------------------------------------------------------------
// The owner's switch and cap
// ---------------------------------------------------------------------------------------------

/** `PUBLICATION_AUTO_DENY_MODE`: the three words the owner may set. */
export const AUTO_DENY_MODES = ["off", "shadow", "on"] as const;
export type AutoDenyMode = (typeof AUTO_DENY_MODES)[number];

/**
 * The mode the Worker runs in. Exactly one of the three words; anything else, unset, empty, a word
 * with spaces or in another case included, is `off`. Only `on` ever denies.
 */
export function autoDenyModeOf(raw: unknown): AutoDenyMode {
  return isOneOf(AUTO_DENY_MODES, raw) ? raw : "off";
}

/** The daily cap when `PUBLICATION_AUTO_DENY_DAILY_CAP` is unset or not a count. */
export const AUTO_DENY_DEFAULT_DAILY_CAP = 25;

/** The largest cap the Worker accepts; a larger value is read as the default. */
export const AUTO_DENY_MAX_DAILY_CAP = 1000;

/**
 * `PUBLICATION_AUTO_DENY_DAILY_CAP` as the Worker reads it: a whole number from 0 to
 * {@link AUTO_DENY_MAX_DAILY_CAP} written in digits, else the default. Zero means every agreed
 * denial is capped, so a person decides each one.
 */
export function autoDenyDailyCapOf(raw: unknown): number {
  if (typeof raw !== "string" || !/^\d{1,4}$/.test(raw)) return AUTO_DENY_DEFAULT_DAILY_CAP;
  const n = Number(raw);
  return n <= AUTO_DENY_MAX_DAILY_CAP ? n : AUTO_DENY_DEFAULT_DAILY_CAP;
}

// ---------------------------------------------------------------------------------------------
// The confirming run
// ---------------------------------------------------------------------------------------------

/** The model of the confirming run (ADR 0139, decision 1). */
export const CONFIRMING_MODEL = "claude-sonnet-5-5" as const satisfies ReviewerModel;

/** The effort of the confirming run. */
export const CONFIRMING_EFFORT = "max" as const satisfies RecordedEffort;

/** The models a confirming row's report may name: the confirming model alone. */
export const CONFIRMING_MODELS = [CONFIRMING_MODEL] as const;

// ---------------------------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------------------------

/**
 * The finding codes that may deny, each about the metadata a depositor wrote. A blocker of one of
 * these against a failed question makes `question_failed` eligible. Never a code about a source's
 * license (`source_license_conflict`), the provenance, the evidence or anything else.
 */
export const AUTO_DENY_FINDING_CODES = [
  "readme_missing_or_stub",
  "description_incomplete",
  "ethics_statement_missing",
  "authors_placeholder",
  "license_missing",
  "license_inconsistent",
  "name_not_descriptive",
] as const satisfies readonly PublicationFindingCode[];
export type AutoDenyFindingCode = (typeof AUTO_DENY_FINDING_CODES)[number];

/** Every code an automatic denial can name: the finding codes above, and a steering attempt. */
export const AUTO_DENY_CODES = [...AUTO_DENY_FINDING_CODES, "steering_attempt"] as const;
export type AutoDenyCode = (typeof AUTO_DENY_CODES)[number];

/**
 * The reason codes (`REASON_CODES`) an automatic denial may rest on. `denied_reason` holds these,
 * so a later request's review is shown them as the previous denial's reasons
 * (`previousDenialReasonsOf`), and ADR 0139 decision 2's "closed reason codes" are exactly these.
 */
export const AUTO_DENY_REASON_CODES = ["question_failed", "steering_attempt"] as const;
export type AutoDenyReasonCode = (typeof AUTO_DENY_REASON_CODES)[number];

/** How many earlier automatic denials of a dataset stop another one (a third goes to a person). */
export const MAX_EARLIER_AUTO_DENIALS = 2;

/** Why a review is not eligible, one closed word each. */
export const INELIGIBLE_WHY = [
  "not_reported",
  "unreadable",
  "not_fail",
  "no_eligible_reason",
  "not_current",
  "not_requested",
  "anonymous",
  "earlier_auto_denials",
] as const;
export type IneligibleWhy = (typeof INELIGIBLE_WHY)[number];

export interface EligibilityInput {
  /** The row's stored state; only `reported` can be eligible. */
  state: string;
  /**
   * The stored report re-parsed, or null when it no longer parses or is not about the row: a run
   * that did not complete and parse is never eligible.
   */
  report: PublicationReviewReport | null;
  /** The review is the one in force: the request's screened head and its anonymous flag. */
  current: boolean;
  /** The request's status now. */
  requestStatus: string;
  /** The request asks for an anonymous release (ADR 0065). */
  anonymous: boolean;
  /** The dataset's EARLIER requests with `auto_denied = 1`. */
  earlierAutoDenials: number;
}

export type Eligibility =
  | {
      eligible: true;
      /** The eligible codes, in {@link AUTO_DENY_CODES} order, each once. */
      codes: AutoDenyCode[];
      /** The reason codes they stand under, in {@link AUTO_DENY_REASON_CODES} order. */
      reasons: AutoDenyReasonCode[];
    }
  | { eligible: false; why: IneligibleWhy };

/**
 * The eligible codes a report gives by itself: `steering_attempt` when it steered, and every
 * blocker finding of {@link AUTO_DENY_FINDING_CODES} against a question it failed. Empty when its
 * derived verdict is not `fail`.
 */
export function eligibleCodesOf(report: PublicationReviewReport): {
  codes: AutoDenyCode[];
  reasons: AutoDenyReasonCode[];
} {
  const reasons = reportReasons(report);
  if (verdictOf(reasons) !== "fail") return { codes: [], reasons: [] };
  const codes = new Set<AutoDenyCode>();
  const under = new Set<AutoDenyReasonCode>();
  if (reasons.some((r) => r.code === "steering_attempt")) {
    codes.add("steering_attempt");
    under.add("steering_attempt");
  }
  const failed = new Set(
    reasons.filter((r) => r.code === "question_failed").map((r) => r.detail ?? ""),
  );
  for (const f of report.findings) {
    if (
      f.severity === "blocker" &&
      failed.has(f.question) &&
      isOneOf(AUTO_DENY_FINDING_CODES, f.code)
    ) {
      codes.add(f.code);
      under.add("question_failed");
    }
  }
  return {
    codes: AUTO_DENY_CODES.filter((c) => codes.has(c)),
    reasons: AUTO_DENY_REASON_CODES.filter((c) => under.has(c)),
  };
}

/** The one rule (ADR 0139, decision 1), checked in this order; the first that fails is the answer. */
export function autoDenyEligibility(input: EligibilityInput): Eligibility {
  if (input.state !== "reported") return { eligible: false, why: "not_reported" };
  if (input.report === null) return { eligible: false, why: "unreadable" };
  if (verdictOf(reportReasons(input.report)) !== "fail")
    return { eligible: false, why: "not_fail" };
  const { codes, reasons } = eligibleCodesOf(input.report);
  if (codes.length === 0) return { eligible: false, why: "no_eligible_reason" };
  if (!input.current) return { eligible: false, why: "not_current" };
  if (input.requestStatus !== "requested") return { eligible: false, why: "not_requested" };
  if (input.anonymous) return { eligible: false, why: "anonymous" };
  if (input.earlierAutoDenials >= MAX_EARLIER_AUTO_DENIALS) {
    return { eligible: false, why: "earlier_auto_denials" };
  }
  return { eligible: true, codes, reasons };
}

/** One review as the confirmation compares it. */
export interface ConfirmationSide {
  eligibility: Eligibility;
  inputDigest: string | null;
  promptVersion: string | null;
}

/**
 * Whether a confirming run confirms a first run: it is eligible by the same rule, it was made over
 * the same input digest and the same prompt version (each recorded on both and equal), and it names
 * at least one eligible code the first run named. The shared codes are what the denial names.
 */
export function confirmationOf(
  first: ConfirmationSide,
  confirm: ConfirmationSide,
): { agrees: true; codes: AutoDenyCode[]; reasons: AutoDenyReasonCode[] } | { agrees: false } {
  const a = first.eligibility;
  const b = confirm.eligibility;
  if (!a.eligible || !b.eligible) return { agrees: false };
  if (first.inputDigest === null || first.inputDigest !== confirm.inputDigest) {
    return { agrees: false };
  }
  if (first.promptVersion === null || first.promptVersion !== confirm.promptVersion) {
    return { agrees: false };
  }
  const shared = a.codes.filter((c) => b.codes.includes(c));
  if (shared.length === 0) return { agrees: false };
  const reasons = AUTO_DENY_REASON_CODES.filter((r) =>
    r === "steering_attempt"
      ? shared.includes("steering_attempt")
      : shared.some((c) => c !== "steering_attempt"),
  );
  return { agrees: true, codes: shared, reasons };
}

/** `denied_reason` of an automatic denial: the reason codes, comma-joined (`previousDenialReasonsOf` reads it). */
export function deniedReasonOf(reasons: readonly AutoDenyReasonCode[]): string {
  return reasons.join(",");
}

// ---------------------------------------------------------------------------------------------
// The states
// ---------------------------------------------------------------------------------------------

/** What the automatic denial made of a first run (migration 0153, `auto_deny_state`). */
export const AUTO_DENY_STATES = [
  "none",
  "would_deny",
  "denied",
  "capped",
  "not_eligible",
  "disagreed",
  "confirm_failed",
  "no_service_account",
  "restored",
] as const;
export type AutoDenyState = (typeof AUTO_DENY_STATES)[number];

/** The states the administrators' daily digest lists, in its order. */
export const DIGEST_STATES = [
  "denied",
  "would_deny",
  "capped",
  "disagreed",
  "confirm_failed",
  "no_service_account",
] as const satisfies readonly AutoDenyState[];

/**
 * The states the daily cap counts: a denial, one that would have been one, and a denial an
 * administrator restored since (its place under the day's cap was taken, and a restore does not give
 * it back, so restoring cannot buy a further denial the same day).
 */
export const CAPPED_STATES = [
  "denied",
  "would_deny",
  "restored",
] as const satisfies readonly AutoDenyState[];

/** What became of a denial mail (migration 0153, `denial_mail_state`). */
export const DENIAL_MAIL_STATES = ["sent", "failed", "fenced"] as const;
export type DenialMailState = (typeof DENIAL_MAIL_STATES)[number];

/** How many times a denial mail is tried: once when the request is denied, once more a day later. */
export const DENIAL_MAIL_MAX_ATTEMPTS = 2;

// ---------------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------------

/** Where the automatic denial is explained: the submission standards, one anchor per entry below. */
export const AUTO_DENY_DOCS_URL = "https://docs.nemar.org/policies/submission-standards/";

/** One entry of a copy table: what is true, what was read, what to do, and where it is explained. */
export interface AutoDenyCopy {
  statement: string;
  read: string;
  remedy: string;
  anchor: string;
}

const anchor = (slug: string) => `${AUTO_DENY_DOCS_URL}#automatic-denial-${slug}`;

const READ_README = "The README at the requested commit, after the platform's pre-send check.";
const READ_DESCRIPTION =
  "dataset_description.json at the requested commit, and the enrichment .nemar/metadata.json NEMAR holds for the dataset.";

/** Each code an automatic denial can name. A `Record`, so a code without an entry fails the build. */
export const AUTO_DENY_CODE_COPY: Record<AutoDenyCode, AutoDenyCopy> = {
  readme_missing_or_stub: {
    statement: "The README is missing, or is a stub that does not describe the dataset.",
    read: READ_README,
    remedy:
      "Write a README that says what was recorded, from whom, how, and how the files are organized.",
    anchor: anchor("readme-missing-or-stub"),
  },
  description_incomplete: {
    statement: "dataset_description.json leaves out what a reader needs to use the dataset.",
    read: READ_DESCRIPTION,
    remedy:
      "Complete dataset_description.json: a descriptive Name, the Authors, the License, and the funding and references that apply.",
    anchor: anchor("description-incomplete"),
  },
  ethics_statement_missing: {
    statement: "No ethics statement covers the recordings of people.",
    read: `${READ_DESCRIPTION} The README too.`,
    remedy:
      "Name the approving ethics board and the approval in EthicsApprovals, or say in the README why none was needed.",
    anchor: anchor("ethics-statement-missing"),
  },
  authors_placeholder: {
    statement: "The authors are placeholders, not the people who made the dataset.",
    read: READ_DESCRIPTION,
    remedy: "List the real authors in Authors in dataset_description.json.",
    anchor: anchor("authors-placeholder"),
  },
  license_missing: {
    statement: "The dataset has no license.",
    read: `${READ_DESCRIPTION} The LICENSE file too.`,
    remedy:
      "Set License in dataset_description.json, and add a LICENSE file with the same license.",
    anchor: anchor("license-missing"),
  },
  license_inconsistent: {
    statement: "The dataset's license is stated differently in different places.",
    read: `${READ_DESCRIPTION} The LICENSE file and the README too.`,
    remedy:
      "Make the License field, the LICENSE file and the README name the same license; nemar dataset license-check shows what NEMAR reads.",
    anchor: anchor("license-inconsistent"),
  },
  name_not_descriptive: {
    statement: "The dataset's name does not describe the dataset.",
    read: "The Name in dataset_description.json at the requested commit.",
    remedy:
      "Give the dataset a Name that says what it holds, for example the task, the modality and the population.",
    anchor: anchor("name-not-descriptive"),
  },
  steering_attempt: {
    statement: "Text in the dataset's documents tried to instruct the automated reviewer.",
    read: "The README, dataset_description.json, CHANGES, LICENSE and participants.json at the requested commit.",
    remedy:
      "Remove any text addressed to a reviewer or to an automated system from the dataset's documents.",
    anchor: anchor("steering-attempt"),
  },
};

/**
 * What each state means to an administrator (the mail about the request and the digest). A
 * `Record`, so a state without an entry fails the build. `none` is never shown.
 */
export const AUTO_DENY_STATE_COPY: Record<AutoDenyState, AutoDenyCopy> = {
  none: {
    statement: "The automatic denial did not act on this review.",
    read: "The review's derived verdict and its reasons.",
    remedy: "Nothing; the request waits for an administrator as before.",
    anchor: anchor("states"),
  },
  would_deny: {
    statement:
      "Would deny (shadow mode): a confirming run agreed that this request fails, but the automatic denial is in shadow mode, so nothing was denied.",
    read: "Both reviews' reasons, their input digests and the request's state.",
    remedy: "Decide the request yourself; the shadow record is for calibration.",
    anchor: anchor("would-deny"),
  },
  denied: {
    statement: "Denied by an automated agent after a confirming run agreed.",
    read: "Both reviews' reasons, their input digests and the request's state.",
    remedy:
      "Nothing, unless the denial was wrong: then restore the request with nemar admin dataset publish restore.",
    anchor: anchor("denied"),
  },
  capped: {
    statement:
      "Recommended: deny. A confirming run agreed that this request fails, but today's automatic-denial cap was reached, so a person decides.",
    read: "Both reviews' reasons, their input digests and the count of today's automatic denials.",
    remedy: "Deny the request with the reasons below, or approve it over them.",
    anchor: anchor("capped"),
  },
  not_eligible: {
    statement:
      "A confirming run agreed, but the request changed before the denial (it was approved, withdrawn, filed again or moved), so nothing was denied.",
    read: "The request's state at the moment of the denial.",
    remedy: "Decide the request yourself.",
    anchor: anchor("not-eligible"),
  },
  disagreed: {
    statement:
      "Automated review disagreed: the confirming run did not confirm the first run's fail, so a person decides.",
    read: "Both reviews' reasons and their input digests.",
    remedy: "Read the review and decide the request yourself.",
    anchor: anchor("disagreed"),
  },
  confirm_failed: {
    statement:
      "The confirming run did not finish (it errored, was refused or was cut off), so nothing confirmed the first run's fail and a person decides.",
    read: "The confirming run's recorded error word.",
    remedy:
      "Read the review and decide the request yourself; nothing was denied, and the confirming run is not retried.",
    anchor: anchor("confirm-failed"),
  },
  no_service_account: {
    statement:
      "Service account missing; nothing was denied. A confirming run agreed and the mode is on, but the nemarAdmin account the denial is made as does not exist.",
    read: "The users table, for the nemarAdmin account.",
    remedy: "Decide the request yourself, and restore the nemarAdmin service account.",
    anchor: anchor("no-service-account"),
  },
  restored: {
    statement:
      "Denied by an automated agent, then restored by an administrator; this commit is never denied automatically again.",
    read: "The restore's audit row (publication_restore).",
    remedy: "Decide the request yourself.",
    anchor: anchor("restored"),
  },
};

/** The administrators' line for a state, or null when the state says nothing (`none`). */
export function autoDenyStateLine(state: AutoDenyState): string | null {
  if (state === "none") return null;
  const c = AUTO_DENY_STATE_COPY[state];
  return `${c.statement} ${c.remedy} (${c.anchor})`;
}

/** The docs anchors this file links to; the docs page creates exactly these. */
export const AUTO_DENY_ANCHORS: readonly string[] = [
  ...new Set(
    [...Object.values(AUTO_DENY_CODE_COPY), ...Object.values(AUTO_DENY_STATE_COPY)].map(
      (c) => c.anchor.split("#")[1] as string,
    ),
  ),
];

// The depositor's mail (ADR 0139, decision 4). Every sentence is here; the mail adds the dataset id,
// closed codes and the review record's checked values, and nothing a model or a depositor wrote.

export function autoDenyMailSubject(datasetId: string): string {
  return `Publication request denied by an automated agent: ${datasetId}`;
}

export const AUTO_DENY_MAIL_HEADLINE = "Publication request denied by an automated agent";

export function autoDenyMailOpening(datasetId: string): string {
  return `An automated agent reviewed this request and denied it. The request was for dataset ${datasetId}.`;
}

export const AUTO_DENY_MAIL_REASONS_HEADING = "Why";

export const AUTO_DENY_MAIL_REASONS_INTRO =
  "Two automated reviews, on two different models, found the following in the dataset's documents:";

export const AUTO_DENY_MAIL_REPRODUCE_HEADING = "Check it yourself";

export const AUTO_DENY_MAIL_REPRODUCE_INTRO =
  "These commands recompute the evidence the review was given, from your own copy of the dataset:";

/** The commands that reproduce the evidence (ADR 0139, decision 4). */
export const AUTO_DENY_REPRODUCE_COMMANDS = [
  "nemar dataset screen --committed",
  "nemar dataset license-check",
] as const;

export const AUTO_DENY_MAIL_RECORD_HEADING = "The review record";

export const AUTO_DENY_MAIL_RECORD_INTRO =
  "What each review was given and which model answered, so the two can be compared:";

/** One review's place in the record. */
export function autoDenyRecordLabel(kind: "first" | "confirming"): string {
  return kind === "first" ? "The review" : "The confirming review";
}

export const AUTO_DENY_MAIL_MAY_DIFFER =
  "A model's verdict may differ on another run; the inputs are what you can check.";

export const AUTO_DENY_MAIL_RESUBMIT_HEADING = "If you believe the agent was wrong";

export function autoDenyMailResubmit(datasetId: string): string {
  return `Fix what is listed above, or explain why it is not a problem, and request publication again with a note to the reviewer: nemar dataset publish request ${datasetId} --note "<what changed, or why the decision was wrong>". The note is shown to the administrators and to the next review.`;
}

export const AUTO_DENY_MAIL_REPLY = "Reply to this mail to reach a person.";

/** A reason as the mail prints it: the statement, the remedy and the link. */
export function autoDenyReasonLine(code: AutoDenyCode): string {
  const c = AUTO_DENY_CODE_COPY[code];
  return `${c.statement} ${c.remedy} More: ${c.anchor}`;
}

// The administrators' daily digest.

export const AUTO_DENY_DIGEST_SUBJECT = "[NEMAR] Automatic denials: daily digest";

export const AUTO_DENY_DIGEST_HEADLINE = "Automatic denials in the last day";

export const AUTO_DENY_DIGEST_INTRO =
  "What the automatic denial did since the last digest. Each line is a dataset, its request and the reason codes; open a request with nemar admin dataset publish show <dataset>.";

/** The digest's heading of each state it lists. */
export const DIGEST_STATE_HEADING: Record<(typeof DIGEST_STATES)[number], string> = {
  denied: "Denied",
  would_deny: "Would deny (shadow mode)",
  capped: "Recommended: deny (cap reached)",
  disagreed: "Automated review disagreed",
  confirm_failed: "Confirming run did not finish",
  no_service_account: "Service account missing; nothing was denied",
};

/** The digest's section of denials whose mail reached nobody after its retry. */
export const DIGEST_MAIL_NOT_DELIVERED_HEADING = "Denial mail not delivered";

export const DIGEST_MAIL_NOT_DELIVERED_INTRO =
  "These requests were denied, and the mail to the depositor failed twice (once at the denial and once a day later). Tell the depositor another way.";

/** The digest's line when it holds back rows past its limit; they come in the next digest. */
export function digestMoreNotShown(n: number): string {
  return `${n} more not shown; they are in the next digest.`;
}

export function autoDenyDigestMode(mode: AutoDenyMode, cap: number): string {
  return `Mode: ${mode}. Daily cap: ${cap}.`;
}

export const AUTO_DENY_DIGEST_RESTORE =
  "An administrator can reverse a denial: nemar admin dataset publish restore <dataset>.";

// The restore.

export const RESTORE_REFUSALS = ["not_found", "not_denied", "withdrawn", "newer_request"] as const;
export type RestoreRefusal = (typeof RESTORE_REFUSALS)[number];

export const RESTORE_REFUSAL_TEXT: Record<RestoreRefusal, string> = {
  not_found: "The dataset has no publication request.",
  not_denied: "The dataset's newest request is not denied, so there is nothing to restore.",
  withdrawn:
    "The dataset's newest request was withdrawn by its depositor, not denied, so it cannot be restored.",
  newer_request:
    "A newer request of the dataset exists, so the denied one cannot be restored; decide the newer one.",
};

export const RESTORE_DONE = "The request is waiting for its decision again.";

// The administrators' mail about a request whose review passed (ADR 0139, decision 8).

export const READY_TO_APPROVE_HEADLINE = "Ready to approve";

export const REVIEW_PASSED_NEEDS_ACK_HEADLINE =
  "Review passed; the identifier screen still needs an acknowledgment";

/** The line that quotes the screen's own status line, for a pass with an `acknowledge` gate. */
export function screenStatusQuote(statusLine: string): string {
  return `The identifier screen says: "${statusLine}"`;
}

export function passGateLine(gate: "clear" | "acknowledge"): string {
  return gate === "clear"
    ? "Identifier screen gate: clear."
    : "Identifier screen gate: needs an acknowledgment.";
}

export const PASS_MINIMUMS_LINE = "The minimum requirements are met at the reviewed commit.";

/**
 * The lineage line: the outcome's statement, whether the sources are credited, and where to list
 * the sources (the review stores the outcome, not the source records). Null outcome: none resolved.
 */
export function passLineageLine(
  outcome: LineageOutcome | null,
  credited: boolean,
  datasetId: string,
): string {
  if (outcome === null || !isOneOf(LINEAGE_OUTCOMES, outcome)) {
    return `License lineage: not recorded for this review. List the sources with nemar admin dataset publish license-lineage ${datasetId} (${LINEAGE_DOCS_URL}#license-lineage).`;
  }
  const c = LINEAGE_COPY[outcome];
  return `License lineage: ${c.statement} Sources ${credited ? "are" : "are not"} credited in SourceDatasets. List them with nemar admin dataset publish license-lineage ${datasetId} (${c.anchor}).`;
}

const ANSWER_WORD: Record<Answer, string> = { pass: "yes", fail: "no", unknown: "unknown" };

/** The model's four answers, one line each, in fixed words. */
export function passAnswerLines(report: PublicationReviewReport): string[] {
  const { answers } = answersOf(report);
  return QUESTIONS.map(
    (q: Question) => `Whether ${QUESTION_LABEL[q]}: ${ANSWER_WORD[answers[q]]}.`,
  );
}
