/**
 * The administrator's decision card (ADR 0142, decision 4): the one structure the Worker builds for
 * a publication request and every surface prints. PURE: no database, no network, no clock. The
 * reads it needs (the review's served snapshot, the enrichment NEMAR holds now, a fresher lineage)
 * are made by `decision-card-inputs.ts` and handed in, beside the request's review detail, which
 * already carries every derived fact (the reasons, the screen's gate, the review in force), so the
 * card cannot disagree with the detail it is attached to.
 *
 * Four rules the card keeps:
 *
 *  1. **The license cue is one table**, {@link LICENSE_CUE_RULES}: red rules, then amber rules, each
 *     with its one-line reason; green only when no rule applies. The lineage rules read the review's
 *     lineage and the card's fresher one together, so a fresher outcome can add a reason and never
 *     remove one (ADR 0142 decision 3: it never raises the stored verdict).
 *  2. **The next action never says approve while a gate withholds approval**:
 *     {@link approvalWouldPass} is the only door to `approve`, and it asks for no reason at all, an
 *     identifier screen that is clear or exempt and read the current `main`, a request that is
 *     `requested` (or a stopped approval), and no red cue.
 *  3. **The words are web-safe** (ADR 0102, Phase 4 amendment): every sentence here names no
 *     terminal; `next_action.command` is a terminal's text and the one field a page never prints.
 *  4. **Whose words are whose**: the dataset's fields, a model's note and a registry's license text
 *     are carried under labels (`shared/contract/decision-card.ts`), with control and format
 *     characters removed, never as NEMAR's words.
 */

import {
  CARD_DESCRIPTION_MAX,
  type CardAuthors,
  type CardDescription,
  type CardEnrichment,
  type CardFinding,
  type CardLicensePanel,
  type CardLineage,
  type CardMetadata,
  type CardNextAction,
  type CardQuestion,
  DECISION_CARD_VERSION,
  DEPOSITOR_TEXT_LABEL,
  type DecisionAction,
  type DecisionCard,
  type HeadCheck,
  type LicenseCue,
  MODEL_TEXT_LABEL,
  REGISTRY_TEXT_LABEL,
} from "../../../shared/contract/decision-card.js";
import type { PublicationReviewDetail } from "../../../shared/contract/publication-review-admin.js";
import { LICENSE_FILE_STATES, type LicenseFileFact } from "../../../shared/license-file.js";
import {
  ACTION_REQUIRED_OUTCOMES,
  LINEAGE_OUTCOMES,
  type LineageOutcome,
  type LineageResult,
  normalizeLicense,
} from "../../../shared/license-lineage.js";
import { AUTO_DENY_STATES, AUTO_DENY_STATE_COPY } from "../../../shared/publication-auto-deny.js";
import {
  COMMAND_ACKNOWLEDGE,
  COMMAND_APPROVE,
  COMMAND_DENY,
  COMMAND_SCREEN,
  COMMAND_SHOW,
  COMMAND_START,
  type EnrichmentField,
  PLATFORM_FINDING_CODES,
  type PublicationFindingCode,
  QUESTIONS,
  QUESTION_LABEL,
  type ReasonCode,
  effectiveVersionOf,
} from "../../../shared/publication-review.js";
import { isPlaceholderAuthor } from "../../../shared/submission-minimums.js";

/** The review detail the card is built beside: every field but the card itself. */
export type CardDetail = Omit<PublicationReviewDetail, "decision_card">;

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

/** The most entries a list on the card keeps, and the longest entry. */
const MAX_ITEMS = 30;
const MAX_ITEM = 150;
const MAX_TITLE = 300;
const MAX_LICENSE = 200;
const MAX_DECLARED = 10;
const MAX_DECLARED_ITEM = 200;

/**
 * Text that is not NEMAR's, made safe to carry: line breaks become spaces, control and format
 * characters (the bidirectional overrides among them) are removed, runs of space collapse, and the
 * result is cut to `max` characters. Null for anything that is not a non-empty string.
 */
export function cleanText(v: unknown, max: number): { text: string; cut: boolean } | null {
  if (typeof v !== "string") return null;
  const flat = v
    .replace(/[\r\n\t\u2028\u2029]+/g, " ")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/ {2,}/g, " ")
    .trim();
  if (flat === "") return null;
  if (flat.length <= max) return { text: flat, cut: false };
  return { text: `${flat.slice(0, max - 1).trimEnd()}…`, cut: true };
}

function clean(v: unknown, max: number): string | null {
  return cleanText(v, max)?.text ?? null;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function list(v: unknown, item: (x: unknown) => string | null, max = MAX_ITEMS): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (out.length >= max) break;
    const s = item(x);
    if (s !== null) out.push(s);
  }
  return out;
}

const firstString = (r: Record<string, unknown>, keys: readonly string[]): unknown =>
  keys.map((k) => r[k]).find((v) => typeof v === "string" && v.trim() !== "");

// ---------------------------------------------------------------------------------------------
// The dataset's own words
// ---------------------------------------------------------------------------------------------

/**
 * The enrichment's main fields as the card shows them, from the fields the review is shown
 * (`enrichmentFieldsOf`, which already withholds an anonymous release's creators). Null when there
 * is no enrichment.
 */
export function cardEnrichmentOf(
  fields: Partial<Record<EnrichmentField, unknown>> | null,
): CardEnrichment | null {
  if (fields === null) return null;
  const description = cleanText(fields.description, CARD_DESCRIPTION_MAX);
  return {
    title: clean(fields.title, MAX_TITLE),
    description: description?.text ?? null,
    description_cut: description?.cut ?? false,
    license: clean(fields.license, MAX_LICENSE),
    creators: list(fields.creators, (c) =>
      clean(isRecord(c) ? firstString(c, ["name", "creator_name", "creatorName"]) : c, MAX_ITEM),
    ),
    keywords: list(fields.keywords, (k) =>
      clean(isRecord(k) ? firstString(k, ["term", "subject"]) : k, MAX_ITEM),
    ),
    funding: list(fields.funding_references, (f) => {
      if (!isRecord(f)) return clean(f, MAX_ITEM);
      const funder = clean(firstString(f, ["funder_name", "funderName"]), MAX_ITEM);
      if (funder === null) return null;
      const award = clean(firstString(f, ["award_number", "awardNumber"]), MAX_ITEM);
      return award === null ? funder : `${funder} (${award})`;
    }),
  };
}

/**
 * `dataset_description.json`'s Name, License and Authors. Null when the text is missing or is not a
 * JSON object. An anonymous release's Authors are withheld, as the review withholds them.
 */
export function cardDescriptionOf(text: string | null, anonymous: boolean): CardDescription | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  return {
    name: clean(parsed.Name, MAX_TITLE),
    license: clean(parsed.License, MAX_LICENSE),
    authors: anonymous ? [] : list(parsed.Authors, (a) => clean(a, MAX_ITEM)),
  };
}

/**
 * A lineage as the snapshot stores it and the card's inputs carry it: the outcome, the credit, the
 * time and what the sources' registries declare (`id: text`).
 */
export interface ServedLineage {
  outcome: LineageOutcome;
  credited: boolean;
  resolved_at: string | null;
  declared_licenses: string[];
}

/** A lineage result as the card keeps it. */
export function cardLineageOf(result: LineageResult): ServedLineage {
  const declared: string[] = [];
  for (const s of result.sources) {
    for (const d of s.declared_licenses ?? []) {
      if (declared.length >= MAX_DECLARED) break;
      const text = clean(d.text ?? d.url, MAX_DECLARED_ITEM);
      const id = clean(s.id, MAX_ITEM);
      if (text !== null && id !== null) declared.push(`${id}: ${text}`);
    }
  }
  return {
    outcome: result.outcome,
    credited: result.sources.some((s) => s.origin === "source_datasets"),
    resolved_at: result.resolved_at,
    declared_licenses: declared,
  };
}

// ---------------------------------------------------------------------------------------------
// The served snapshot (migration 0163)
// ---------------------------------------------------------------------------------------------

/** The snapshot's own version. */
export const SERVED_METADATA_VERSION = 1;

/** The longest snapshot the column holds; the migration's CHECK says the same number. */
export const SERVED_METADATA_MAX = 65_536;

/**
 * What the Worker served a review's job, kept for the card: the enrichment's main fields, the
 * description's three, and the lineage with what its sources declare. Written in the statement that
 * stamps the serve (`publication-review-inputs.ts`), so it is exactly what the job read.
 */
export interface ServedMetadata {
  v: typeof SERVED_METADATA_VERSION;
  enrichment: CardEnrichment | null;
  enrichment_source: string | null;
  dataset_description: CardDescription | null;
  lineage: ServedLineage | null;
}

/** The snapshot as the column stores it, or null when it would not fit (the serve still goes on). */
export function servedMetadataJson(m: ServedMetadata): string | null {
  const text = JSON.stringify(m);
  return text.length <= SERVED_METADATA_MAX ? text : null;
}

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

function readEnrichment(v: unknown): CardEnrichment | null | undefined {
  if (v === null) return null;
  if (!isRecord(v)) return undefined;
  const creators = strings(v.creators);
  const keywords = strings(v.keywords);
  const funding = strings(v.funding);
  if (
    !strOrNull(v.title) ||
    !strOrNull(v.description) ||
    !strOrNull(v.license) ||
    typeof v.description_cut !== "boolean" ||
    creators === null ||
    keywords === null ||
    funding === null
  ) {
    return undefined;
  }
  return {
    title: v.title,
    description: v.description,
    description_cut: v.description_cut,
    license: v.license,
    creators,
    keywords,
    funding,
  };
}

function readDescription(v: unknown): CardDescription | null | undefined {
  if (v === null) return null;
  if (!isRecord(v)) return undefined;
  const authors = strings(v.authors);
  if (!strOrNull(v.name) || !strOrNull(v.license) || authors === null) return undefined;
  return { name: v.name, license: v.license, authors };
}

function readLineage(v: unknown): ServedLineage | null | undefined {
  if (v === null) return null;
  if (!isRecord(v)) return undefined;
  const declared = strings(v.declared_licenses);
  if (
    !(LINEAGE_OUTCOMES as readonly unknown[]).includes(v.outcome) ||
    typeof v.credited !== "boolean" ||
    !strOrNull(v.resolved_at) ||
    declared === null
  ) {
    return undefined;
  }
  return {
    outcome: v.outcome as LineageOutcome,
    credited: v.credited,
    resolved_at: v.resolved_at,
    declared_licenses: declared,
  };
}

/**
 * A stored snapshot, read strictly: null for an empty column and for anything that is not what
 * {@link servedMetadataJson} writes, so a snapshot edited by hand is shown as no snapshot ("not as
 * reviewed"), never as the reviewed fields.
 */
export function parseServedMetadata(raw: unknown): ServedMetadata | null {
  if (typeof raw !== "string") return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(v) || v.v !== SERVED_METADATA_VERSION || !strOrNull(v.enrichment_source)) {
    return null;
  }
  const enrichment = readEnrichment(v.enrichment);
  const description = readDescription(v.dataset_description);
  const lineage = readLineage(v.lineage);
  if (enrichment === undefined || description === undefined || lineage === undefined) return null;
  return {
    v: SERVED_METADATA_VERSION,
    enrichment,
    enrichment_source: v.enrichment_source,
    dataset_description: description,
    lineage,
  };
}

// ---------------------------------------------------------------------------------------------
// The license cue
// ---------------------------------------------------------------------------------------------

/** What the cue table reads. */
export interface CueFacts {
  /** `dataset_description.json` has a License: from the review's facts, else the field read. Null when unknown. */
  fieldPresent: boolean | null;
  /** The License field's text, when read. */
  field: string | null;
  /** The review's LICENSE identification, or null (no version-3 review). */
  file: LicenseFileFact | null;
  matcher: string | null;
  /**
   * The review's lineage and the card's fresher one, when there are, each with whether a recorded
   * license permission covers it (`permissionCovers`, through `coveringPermission`).
   */
  lineages: Array<{ outcome: LineageOutcome; covered: boolean }>;
  credited: boolean;
  enrichmentLicense: string | null;
}

export interface CueRule {
  code: string;
  cue: Exclude<LicenseCue, "green">;
  applies: (f: CueFacts) => boolean;
  reason: string;
}

const recognized = (text: string | null): boolean => {
  const n = normalizeLicense(text).license;
  return n !== "other" && n !== "none";
};

const fileIs = (f: CueFacts, state: LicenseFileFact["state"]) => f.file?.state === state;

/** Some lineage has the outcome (covered or not). */
const hasOutcome = (f: CueFacts, outcome: LineageOutcome) =>
  f.lineages.some((l) => l.outcome === outcome);

/** Some lineage has the outcome and no recorded permission covers it. */
const uncovered = (f: CueFacts, outcome: LineageOutcome) =>
  f.lineages.some((l) => l.outcome === outcome && !l.covered);

/** Two license texts that both normalize and name different licenses (or versions of one). */
function licensesDisagree(a: string | null, b: string | null): boolean {
  if (a === null || b === null || !recognized(a) || !recognized(b)) return false;
  const x = normalizeLicense(a);
  const y = normalizeLicense(b);
  if (x.license !== y.license) return true;
  return x.version !== null && y.version !== null && x.version !== y.version;
}

/**
 * The cue table (ADR 0142, decision 4, with the owner's list of 2026-11-27): red first, then
 * amber, in the order the reasons are listed. Green is what is left.
 */
export const LICENSE_CUE_RULES: readonly CueRule[] = [
  {
    code: "no_license_field",
    cue: "red",
    applies: (f) => f.fieldPresent === false,
    reason: "dataset_description.json has no License field.",
  },
  {
    code: "license_file_differs",
    cue: "red",
    applies: (f) => fileIs(f, "matches_other"),
    reason: "The LICENSE file names another license than the License field.",
  },
  {
    code: "needs_permission",
    cue: "red",
    applies: (f) => uncovered(f, "needs_permission"),
    reason: "The upstream data's license needs its authors' permission for this copy.",
  },
  {
    code: "share_alike_mismatch",
    cue: "red",
    applies: (f) => uncovered(f, "share_alike_mismatch"),
    reason:
      "The upstream data's share-alike license does not permit this copy under the dataset's license.",
  },
  {
    code: "redistribution_prohibited",
    cue: "red",
    // Red even with a recorded permission (lead ruling of 2026-11-27): the repository's data use
    // agreement may bind more than the authors, so a person decides every time.
    applies: (f) => hasOutcome(f, "redistribution_prohibited"),
    reason:
      "The upstream data's license prohibits redistribution; an administrator decides even with a recorded permission.",
  },
  {
    code: "matcher_unavailable",
    cue: "amber",
    applies: (f) => f.matcher === "unavailable",
    reason: "License matcher unavailable.",
  },
  {
    code: "license_file_unrecognized",
    cue: "amber",
    applies: (f) => fileIs(f, "unrecognized"),
    reason:
      "The LICENSE file was not identified conclusively: its text is not one license NEMAR recognizes, or it names more than one.",
  },
  {
    code: "license_file_annexed",
    cue: "amber",
    applies: (f) => fileIs(f, "annexed"),
    reason:
      "The LICENSE file is an annexed file rather than text in git, so it was not identified.",
  },
  {
    code: "license_file_unreadable",
    cue: "amber",
    applies: (f) => fileIs(f, "unreadable"),
    reason: "The LICENSE file could not be read in full, so it was not identified.",
  },
  {
    code: "license_file_absent_recognized",
    cue: "amber",
    applies: (f) =>
      fileIs(f, "absent") && f.fieldPresent !== false && (f.field === null || recognized(f.field)),
    reason: "There is no LICENSE file beside the License field.",
  },
  {
    code: "license_file_absent_unrecognized",
    cue: "amber",
    applies: (f) =>
      fileIs(f, "absent") && f.fieldPresent !== false && f.field !== null && !recognized(f.field),
    reason: "There is no LICENSE file, and the License field is not a license NEMAR recognizes.",
  },
  {
    code: "license_file_not_identified",
    cue: "amber",
    applies: (f) => f.file === null,
    reason: "No review on record has identified the LICENSE file.",
  },
  {
    code: "lineage_unresolved",
    cue: "amber",
    applies: (f) => hasOutcome(f, "unresolved"),
    reason: "The upstream data's license could not be read.",
  },
  {
    code: "source_is_publication",
    cue: "amber",
    applies: (f) => hasOutcome(f, "source_is_publication"),
    reason:
      "The declared upstream source is a publication, not a dataset, so its license does not settle the data's.",
  },
  {
    code: "uncredited_attribution",
    cue: "amber",
    applies: (f) => hasOutcome(f, "compatible_attribution") && !f.credited,
    reason:
      "The upstream data's license requires attribution, and SourceDatasets does not credit the source.",
  },
  {
    code: "enrichment_license_disagrees",
    cue: "amber",
    applies: (f) => licensesDisagree(f.enrichmentLicense, f.field),
    reason: "The enrichment's license disagrees with the License field.",
  },
];

/** The sentence of a green cue. */
export const GREEN_REASON =
  "The License field, the LICENSE file and the upstream data's license agree.";

/** The sentence of a green cue that a recorded license permission made green. */
export const PERMITTED_GREEN_REASON =
  "The License field and the LICENSE file agree, and a recorded license permission covers the upstream data's license.";

/** The cue and its reasons, from the table. */
export function licenseCueOf(f: CueFacts): { cue: LicenseCue; reason: string; reasons: string[] } {
  const standing = LICENSE_CUE_RULES.filter((r) => r.applies(f));
  const red = standing.filter((r) => r.cue === "red");
  const amber = standing.filter((r) => r.cue === "amber");
  const reasons = [...red, ...amber].map((r) => r.reason);
  const cue: LicenseCue = red.length > 0 ? "red" : amber.length > 0 ? "amber" : "green";
  const permitted = f.lineages.some(
    (l) => l.covered && (ACTION_REQUIRED_OUTCOMES as readonly string[]).includes(l.outcome),
  );
  return {
    cue,
    reason: reasons[0] ?? (permitted ? PERMITTED_GREEN_REASON : GREEN_REASON),
    reasons,
  };
}

// ---------------------------------------------------------------------------------------------
// The next action
// ---------------------------------------------------------------------------------------------

/** Web-safe: what each action asks of the administrator. */
export const ACTION_SENTENCE: Record<DecisionAction, string> = {
  approve: "Approve the request: nothing on record withholds its approval.",
  acknowledge_screen:
    "Acknowledge the identifier screen's result with a recorded reason; the approval asks for it.",
  rerun_screen: "Run the identifier screen again: it has no verdict about the current commit.",
  wait: "Wait: the identifier screen or the review is still running, or today's review allowance is spent.",
  start_review: "Start the review of the current screened commit.",
  review_again:
    "Review the request again: the upstream data's license resolves now, and the review read it unresolved.",
  record_license_permission:
    "Record the license permission when the evidence from the original authors arrives at support; until then the request waits.",
  ask_depositor: "Ask the depositor to fix what the reasons name: only the depositor can cure it.",
  administrator_reads:
    "Read the review and the dataset and decide: no rule settles what the reasons leave open, and the depositor cannot cure it alone.",
  deny: "Deny the request with the reasons shown.",
};

const COMMAND_PERMISSION =
  'nemar admin dataset publish license-permission <dataset> --ticket <id> --evidence "<summary>"';
const COMMAND_NEXT = "nemar admin dataset publish next";

/** The terminal's command for each action; `<dataset>` is filled. A page never prints these. */
export const ACTION_COMMAND: Record<DecisionAction, string> = {
  approve: COMMAND_APPROVE,
  acknowledge_screen: COMMAND_ACKNOWLEDGE,
  rerun_screen: COMMAND_SCREEN,
  wait: COMMAND_SHOW,
  start_review: COMMAND_START,
  review_again: `${COMMAND_START} --again`,
  record_license_permission: COMMAND_PERMISSION,
  ask_depositor: COMMAND_NEXT,
  administrator_reads: COMMAND_SHOW,
  deny: COMMAND_DENY,
};

/** Reasons only the depositor cures and that nothing clears. */
const DEPOSITOR_HARD: readonly ReasonCode[] = [
  "request_blocked",
  "submission_minimum_failed",
  "identifier_screen_blocks",
  "version_kept_after_anonymous_release",
];
const SCREEN_WAIT: readonly ReasonCode[] = ["identifier_screen_pending"];
const SCREEN_RERUN: readonly ReasonCode[] = [
  "identifier_screen_not_run",
  "identifier_screen_stale",
];
const REVIEW_WAIT: readonly ReasonCode[] = ["review_running", "review_limit_reached"];
const REVIEW_START: readonly ReasonCode[] = [
  "review_not_started",
  "review_did_not_report",
  "review_could_not_run",
];
const REVIEW_FAIL: readonly ReasonCode[] = [
  "question_failed",
  "steering_attempt",
  "stored_verdict_fail",
  "bids_failed_at_review",
];
/** Reasons an administrator settles by reading: no rule decides them, and no depositor fix alone does. */
const ADMINISTRATOR_READS: readonly ReasonCode[] = [
  "doi_state_unexpected",
  "text_withheld",
  "question_unknown",
  "bids_unconcluded_at_review",
];
/** The automatic-denial states in which a confirming run agreed that the request fails. */
const AUTO_DENY_AGREED: readonly string[] = ["would_deny", "capped"];

/** What the approval's own gates read beyond the detail. */
export interface GateFacts {
  /** `verifyScreenHead`: the screened commit is still `main` (or the dataset is exempt). */
  head: HeadCheck;
  /** An approval run holds the request right now (`approvalInFlightSql`). */
  approvalInFlight: boolean;
}

/**
 * The approval gate would accept an approval with no override and no acknowledgment owed: no
 * reason stands; the identifier screen is clear (or the dataset is exempt) and read the current
 * `main`; the request is `requested`, or `approving` with no run holding it and nothing published
 * yet (a stopped run, which the gates take as a fresh approval); it is not blocked; and the license
 * cue is not red. The one door to `approve`.
 */
export function approvalWouldPass(d: CardDetail, cue: LicenseCue, g: GateFacts): boolean {
  const open =
    d.request_status === "requested" ||
    (d.request_status === "approving" && !g.approvalInFlight && !d.started_publishing);
  return (
    open &&
    d.reasons.length === 0 &&
    (d.screen_gate === "clear" || d.screen_gate === "exempt") &&
    (g.head === "current" || g.head === "exempt") &&
    (d.block_reason === null || d.block_reason === undefined) &&
    cue !== "red"
  );
}

/** The one suggested action, from the closed list, by the first tier that applies. */
export function nextActionOf(
  d: CardDetail,
  o: {
    cue: LicenseCue;
    autoDenyState: string | null;
    freshBetter: boolean;
    unresolved: boolean;
  } & GateFacts,
): DecisionAction {
  const codes = new Set(d.reasons.map((r) => r.code));
  const any = (list: readonly ReasonCode[]) => list.some((c) => codes.has(c));
  if (
    any(DEPOSITOR_HARD) ||
    d.screen_gate === "blocks" ||
    d.request_status === "blocked" ||
    (d.block_reason !== null && d.block_reason !== undefined)
  ) {
    return "ask_depositor";
  }
  if (d.request_status === "approving" && o.approvalInFlight) return "wait";
  if (d.request_status !== "requested" && d.request_status !== "approving") {
    return "administrator_reads";
  }
  if (d.request_status === "approving" && d.started_publishing) return "administrator_reads";
  if (any(SCREEN_WAIT) || d.screen_gate === "wait") return "wait";
  if (
    any(SCREEN_RERUN) ||
    d.screen_gate === "rerun" ||
    o.head === "stale" ||
    o.head === "unverified"
  ) {
    return "rerun_screen";
  }
  if (any(REVIEW_WAIT)) return "wait";
  if (any(REVIEW_START)) return "start_review";
  if (o.freshBetter) return "review_again";
  if (
    any(REVIEW_FAIL) ||
    (o.autoDenyState !== null && AUTO_DENY_AGREED.includes(o.autoDenyState))
  ) {
    return "deny";
  }
  if (codes.has("license_lineage_unconfirmed")) {
    return o.unresolved ? "ask_depositor" : "record_license_permission";
  }
  if (any(ADMINISTRATOR_READS)) return "administrator_reads";
  const left = [...codes].filter((c) => c !== "identifier_screen_needs_acknowledgment");
  if (left.length > 0) return "ask_depositor";
  if (o.cue === "red") return "administrator_reads";
  if (codes.has("identifier_screen_needs_acknowledgment") || d.screen_gate === "acknowledge") {
    return "acknowledge_screen";
  }
  // Every tier above has passed; the door still asks on its own, so a tier removed by mistake
  // never lets `approve` through.
  return approvalWouldPass(d, o.cue, o) ? "approve" : "administrator_reads";
}

// ---------------------------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------------------------

const SEVERITY_RANK: Record<string, number> = { blocker: 1, concern: 2, note: 3 };

type RecordFinding = NonNullable<CardDetail["review"]>["findings"][number];

const isPlatformFinding = (f: RecordFinding) =>
  (PLATFORM_FINDING_CODES as readonly string[]).includes(f.code as PublicationFindingCode);

/** A question's strongest finding: a platform fact, then a platform finding, then by severity. */
export function strongestFindingOf(
  review: NonNullable<CardDetail["review"]>,
  question: string,
): CardFinding | null {
  const fact = review.fact_notes.find((n) => n.question === question);
  if (fact) {
    return {
      source: "platform",
      severity: "fact",
      label: clean(fact.text, 400) ?? "",
      note: null,
      note_label: null,
    };
  }
  const ranked = review.findings
    .filter((f) => f.question === question && f.severity in SEVERITY_RANK)
    .map((f, i) => ({ f, i, rank: (isPlatformFinding(f) ? 0 : 10) + SEVERITY_RANK[f.severity] }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i);
  const top = ranked[0]?.f;
  if (!top) return null;
  const platform = isPlatformFinding(top);
  return {
    source: platform ? "platform" : "model",
    severity: top.severity as CardFinding["severity"],
    label: clean(top.label, 200) ?? clean(top.code, 64) ?? "",
    note: clean(top.note, 400),
    note_label: platform ? null : MODEL_TEXT_LABEL,
  };
}

function questionsOf(review: CardDetail["review"]): CardQuestion[] {
  if (review === null || review.questions === null) return [];
  const answers = review.questions;
  return QUESTIONS.filter((q) => q in answers).map((q) => ({
    question: q,
    label: QUESTION_LABEL[q],
    answer: answers[q],
    strongest: strongestFindingOf(review, q),
  }));
}

// ---------------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------------

/** What the card is built from beside the detail. */
export interface DecisionCardInput {
  detail: CardDetail;
  /** The review in force's `auto_deny_state`, as stored, or null without one. */
  autoDenyState: string | null;
  /** The snapshot the review's serve wrote, or null (none written, or it does not read). */
  snapshot: ServedMetadata | null;
  /** What NEMAR holds now, for a review without a snapshot; null when not read. */
  current: Pick<ServedMetadata, "enrichment" | "enrichment_source" | "dataset_description"> | null;
  /** The lineage resolved again for the card, or null when it was not. */
  freshLineage: ServedLineage | null;
  /** A recorded license permission covers the fresher lineage's basis. */
  freshCovered: boolean;
  /** The approval's own gates beyond the detail. */
  gate: GateFacts;
}

/** Why the fields are not as reviewed: a review that predates the snapshot, or no review served. */
export const NOT_AS_REVIEWED_NOTE =
  "Not as reviewed: this review was made before NEMAR kept a copy of the fields it read, so these are the fields NEMAR holds now.";
export const NOT_REVIEWED_NOTE =
  "Not as reviewed: no review has read these fields yet, so these are the fields NEMAR holds now.";

function metadataOf(input: DecisionCardInput): CardMetadata {
  const { detail, snapshot, current } = input;
  const evidence = detail.review?.evidence ?? null;
  const source = snapshot ?? current;
  return {
    as_reviewed: snapshot !== null,
    note:
      snapshot !== null ? null : detail.review === null ? NOT_REVIEWED_NOTE : NOT_AS_REVIEWED_NOTE,
    label: DEPOSITOR_TEXT_LABEL,
    enrichment_source: source?.enrichment_source ?? null,
    enrichment: source?.enrichment ?? null,
    dataset_description: source?.dataset_description ?? null,
    version: evidence === null ? null : effectiveVersionOf(evidence),
    anonymous: detail.anonymous,
  };
}

/** The review's LICENSE fact, read narrowly: an odd shape is no identification. */
function licenseFileOf(detail: CardDetail): LicenseFileFact | null {
  const f: unknown = detail.review?.evidence?.license_file;
  if (!isRecord(f) || !(LICENSE_FILE_STATES as readonly unknown[]).includes(f.state)) return null;
  return {
    state: f.state as LicenseFileFact["state"],
    spdx: typeof f.spdx === "string" ? f.spdx : null,
    additions: f.additions === true,
    expression: typeof f.expression === "string" ? f.expression : null,
  };
}

/** The review's own lineage: its recorded outcome, with what the served sources declared. */
function reviewLineageOf(
  detail: CardDetail,
  snapshot: ServedMetadata | null,
): ServedLineage | null {
  const recorded = detail.review?.evidence?.lineage ?? null;
  if (recorded === null) return snapshot?.lineage ?? null;
  return {
    outcome: recorded.outcome,
    credited: recorded.credited,
    resolved_at: recorded.resolved_at ?? snapshot?.lineage?.resolved_at ?? null,
    declared_licenses: snapshot?.lineage?.declared_licenses ?? [],
  };
}

/** The fresher lineage resolves what the review read unresolved, and needs no action itself. */
export function freshIsBetter(
  review: Pick<ServedLineage, "outcome"> | null,
  fresh: Pick<ServedLineage, "outcome"> | null,
): boolean {
  if (review === null || fresh === null || review.outcome !== "unresolved") return false;
  return (
    fresh.outcome === "compatible" ||
    fresh.outcome === "compatible_attribution" ||
    fresh.outcome === "compatible_nc" ||
    fresh.outcome === "no_upstream_declared"
  );
}

/** A kept lineage as the card shows it, its registry text under its label. */
function labeledLineage(l: ServedLineage, covered: boolean): CardLineage {
  return {
    outcome: l.outcome,
    credited: l.credited,
    resolved_at: l.resolved_at,
    declared_licenses: { label: REGISTRY_TEXT_LABEL, licenses: l.declared_licenses },
    permission_covers: covered,
  };
}

/** The head check in words; null when the screened commit is current. */
export const HEAD_LINE: Record<HeadCheck, string | null> = {
  current: null,
  exempt: "Sandbox datasets are not screened.",
  stale:
    "The screened commit is no longer the repository's main branch, so the screen must run again before an approval.",
  unverified:
    "Whether the screened commit is still the repository's main branch could not be checked, so an approval would be refused until it can be.",
};

function licensePanelOf(input: DecisionCardInput, metadata: CardMetadata): CardLicensePanel {
  const { detail, snapshot, freshLineage } = input;
  const evidence = detail.review?.evidence ?? null;
  const file = licenseFileOf(detail);
  const matcher = detail.review?.reproducibility?.license_matcher ?? null;
  const lineage = reviewLineageOf(detail, snapshot);
  const field = metadata.dataset_description?.license ?? null;
  // The detail's permission is the one covering the review's own basis (`derivePublicationReview`);
  // the fresher lineage is covered only by a permission that covers its own (decision-card-inputs).
  const permission = detail.license_permission !== null && detail.license_permission !== undefined;
  const lineages = [
    ...(lineage === null ? [] : [{ outcome: lineage.outcome, covered: permission }]),
    ...(freshLineage === null
      ? []
      : [{ outcome: freshLineage.outcome, covered: input.freshCovered }]),
  ];
  const fieldPresent =
    evidence !== null
      ? evidence.license_field
      : metadata.dataset_description === null
        ? null
        : field !== null;
  const cue = licenseCueOf({
    fieldPresent,
    field,
    file,
    matcher,
    lineages,
    credited: (lineage?.credited ?? false) || (freshLineage?.credited ?? false),
    enrichmentLicense: metadata.enrichment?.license ?? null,
  });
  return {
    ...cue,
    field: field === null ? null : { label: DEPOSITOR_TEXT_LABEL, text: field },
    license_file: file,
    matcher,
    lineage: lineage === null ? null : labeledLineage(lineage, permission),
    fresh_lineage: freshLineage === null ? null : labeledLineage(freshLineage, input.freshCovered),
    permission_recorded: permission,
  };
}

function authorsOf(detail: CardDetail, metadata: CardMetadata): CardAuthors {
  const evidence = detail.review?.evidence ?? null;
  const names = (metadata.dataset_description?.authors ?? []).map((name) => ({
    name,
    placeholder: isPlaceholderAuthor(name),
  }));
  const read = metadata.dataset_description !== null && !metadata.anonymous;
  return {
    names,
    count: evidence?.authors_count ?? (read ? names.length : null),
    placeholders:
      evidence?.placeholder_authors ?? (read ? names.filter((n) => n.placeholder).length : null),
  };
}

function autoDenyOf(state: string | null): DecisionCard["auto_deny"] {
  if (state === null || state === "none") return null;
  if (!(AUTO_DENY_STATES as readonly string[]).includes(state)) return null;
  return {
    state,
    line: AUTO_DENY_STATE_COPY[state as keyof typeof AUTO_DENY_STATE_COPY].statement,
  };
}

/** The decision card of one request. Pure. */
export function buildDecisionCard(input: DecisionCardInput): DecisionCard {
  const { detail } = input;
  const metadata = metadataOf(input);
  const license = licensePanelOf(input, metadata);
  const action = nextActionOf(detail, {
    cue: license.cue,
    autoDenyState: input.autoDenyState,
    freshBetter: freshIsBetter(license.lineage, license.fresh_lineage),
    unresolved: license.lineage?.outcome === "unresolved",
    ...input.gate,
  });
  const next: CardNextAction = {
    action,
    sentence: ACTION_SENTENCE[action],
    command: ACTION_COMMAND[action].replaceAll("<dataset>", detail.dataset_id),
  };
  return {
    v: DECISION_CARD_VERSION,
    metadata,
    license,
    authors: authorsOf(detail, metadata),
    questions: questionsOf(detail.review),
    identifier_screen: {
      headline: detail.identifier_screen.headline,
      tone: detail.identifier_screen.tone,
      head: input.gate.head,
      head_line: HEAD_LINE[input.gate.head],
    },
    auto_deny: autoDenyOf(input.autoDenyState),
    next_action: next,
  };
}
