/**
 * The publication review's contract (ADR 0102): the report a review run posts, the evidence it
 * carries, the reasons a request is not a pass, the verdict derived from them, and the words every
 * surface shows.
 *
 * One module, several readers. The review job builds its evidence and report with it, the Worker
 * parses what comes back with it before storing a byte, and the admin list, the detail view, the
 * email, the command-line interface and (through a transcription) the web page all render from it,
 * so no two of them can disagree about what a review said or what it takes to clear it.
 *
 * **The depositor wrote every document the model reads, and the model wrote every word it returns.**
 * Four rules keep either from steering the outcome:
 *
 *  1. **The verdict is derived, never reported.** The model answers four questions and files
 *     findings from a closed list. {@link reasonsOf} turns those answers, the job's facts and the
 *     request's live facts into reasons, and {@link verdictOf} turns reasons into an outcome. No
 *     field of the report is "the verdict".
 *  2. **Facts only lower an answer** ({@link answersOf}). A missing README, a missing license, a
 *     short name, a placeholder author or text the model did not see in full can turn a pass into
 *     a fail or an unknown; nothing turns an unknown into a pass.
 *  3. **The model sees only cleared text.** The prompt builder accepts {@link ClearedText}, a brand
 *     that only the pre-send module of the job (`scripts/ci/publication-review-presend.ts`) may
 *     mint, after the shared mechanical rules examined exactly the bytes it is about to send. A
 *     test keeps every other file from minting one.
 *  4. **Free text is a note, never markup** (`sanitizeNote`), and the evidence is counts and closed
 *     words: no path, file name, subject or task label, header value or identifier finding.
 *
 * **Unknown is never green** (ADR 0053, ADR 0054). A review that is running, did not run, did not
 * report, could not read what it needed or could not decide is `action_required`, and every
 * outcome other than `pass` carries at least one reason. A review row that has not reported always
 * yields a reason, whatever the screen and the request say, and a test walks every combination.
 *
 * The parsers throw a fixed-word {@link PublicationReviewReportError}; they never quote their input.
 */

import type { FindingKind } from "./identifier-scan.js";
import { FINDING_KINDS, KNOWN_FORMATS, type ScreenGate } from "./identifier-screen-report.js";
import { LICENSE_FILE_STATES, type LicenseFileFact } from "./license-file.js";
import {
  ACTION_REQUIRED_OUTCOMES,
  LICENSE_EVIDENCE_ADDRESS,
  LINEAGE_OUTCOMES,
  type LineageOutcome,
  MAX_CREATORS,
} from "./license-lineage.js";
import { SEMVER, isOneOf } from "./pr-review.js";
import { PUBLICATION_DATASET_ID_RE } from "./publication-limits.js";
import { MINIMUM_FAILURES, MIN_NAME_LENGTH, type MinimumFailure } from "./submission-minimums.js";
import { sanitizeNote } from "./untrusted-text.js";

// ---------------------------------------------------------------------------------------------
// Versions, models, timing and caps
// ---------------------------------------------------------------------------------------------

/**
 * The version a review job writes. Version 2 (ADR 0139, decisions 5, 6 and 9) adds the widened
 * inputs to the evidence (`inputs`, `lineage`), the fifth answer (`note_answer`) and the
 * reproducibility record (`record`). A stored version-1 report still parses, as it was written.
 *
 * Version 3 (ADR 0142, decision 2) adds the LICENSE identification (`evidence.license_file`), the
 * closed names of the description keys not shown (`evidence.description_keys_not_shown_names`),
 * when the lineage was resolved (`evidence.lineage.resolved_at`) and the license matcher
 * (`record.license_matcher`). The Worker reads it from the first of ADR 0142's three deploys; the
 * job still writes version 2 until the second, so this constant stays at 2 until then.
 */
export const PUBLICATION_REPORT_VERSION = 2;
/** Every version the parser reads. */
export const PUBLICATION_REPORT_VERSIONS = [1, 2, 3] as const;
export type PublicationReportVersion = (typeof PUBLICATION_REPORT_VERSIONS)[number];

/**
 * The version of the prompt the job sends (`scripts/ci/publication-review-prompt.ts`): raised with
 * every change to the system prompt, the output schema or the shape of the user message, so two
 * reviews with the same prompt version, models and input digest were asked the same thing
 * (ADR 0139, decision 9). Reviews before this constant existed are version 1 and record none.
 */
export const PUBLICATION_PROMPT_VERSION = "publication-review-prompt/2";

/**
 * The effort every call of the review is made at. One word, recorded with the model. `max` since
 * 2026-11-27 (owner): on 37 queue requests it gave the same verdicts as Opus 5.5 at medium.
 */
export const PUBLICATION_REVIEW_EFFORT = "max";

/**
 * Every effort a record may name: the review's, and the others a call can be made at (the
 * confirming run of ADR 0139 decision 1 is made at `max`). A closed list, so a record keeps the
 * effort it was made at whatever the review's effort is now.
 */
export const RECORDED_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type RecordedEffort = (typeof RECORDED_EFFORTS)[number];

/**
 * The models a production report may name. A closed set, so a model change is a reviewed code change.
 * The first is the one the review calls; the others are accepted so the owner can compare models on
 * the real queue (2026-11-27) by changing which model the workflow's script calls, and so a record
 * made on any of them still reads back.
 */
export const PUBLICATION_REVIEW_MODELS = [
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
] as const;
export type PublicationReviewModel = (typeof PUBLICATION_REVIEW_MODELS)[number];

/**
 * The models the offline calibration may compare (ADR 0102's call 6). Since 2026-11-27 it names the
 * same three models as {@link PUBLICATION_REVIEW_MODELS}; the parser still requires a report's model
 * to be on both, so a model added to only one list is refused.
 */
export const CALIBRATION_MODELS = [
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
] as const;
export type CalibrationModel = (typeof CALIBRATION_MODELS)[number];

/** Any model a parsed report may name: the production list, or the calibration's. */
export type ReviewerModel = PublicationReviewModel | CalibrationModel;

/** How long a dispatched review may take before the watchdog gives up. The workflow's own limit is 20. */
export const PUBLICATION_REVIEW_DEADLINE_MINUTES = 30;

/**
 * How old a dispatched row is before a surface reads it as "did not report": the deadline plus one
 * 30-minute tick. The dev Worker runs no watchdog, so this is how a row ages there (ADR 0093's rule).
 */
export const REVIEW_OVERDUE_VIEW_MINUTES = 60;

/** Model calls one depositor's requests may cost in any 24 hours. */
export const DEPOSITOR_DAILY_CAP = 5;

/**
 * Model calls the whole platform may spend in any 24 hours: 500 from 2026-11-27 (owner, to clear the
 * queue of more than 360 requests), 150 from 2026-11-25 (epic #2182); ADR 0102 decided 50.
 */
export const PLATFORM_DAILY_CAP = 500;

/**
 * The line every rendering of a review ends with. ADR 0065 leaves README, Funding,
 * Acknowledgements and EthicsApprovals to the depositor to scrub, and the model is not asked.
 */
export const NOT_ASSESSED_LINE = "Not assessed: whether the text names the depositors.";

// ---------------------------------------------------------------------------------------------
// Questions, answers and findings
// ---------------------------------------------------------------------------------------------

/** The four questions of the review (ADR 0102, section 4). */
export const QUESTIONS = [
  "complete_and_honest",
  "meets_standards",
  "authors_and_license",
  "name_adequate",
] as const;
export type Question = (typeof QUESTIONS)[number];

export const ANSWERS = ["pass", "fail", "unknown"] as const;
export type Answer = (typeof ANSWERS)[number];

export const PUBLICATION_SEVERITIES = ["blocker", "concern", "note"] as const;
export type PublicationSeverity = (typeof PUBLICATION_SEVERITIES)[number];

/**
 * Why a finding exists. Closed, so a surface can say it without quoting anyone. There is no code
 * about privacy, identifiers or the depositors: the model is not asked about them (section 2).
 */
export const PUBLICATION_FINDING_CODES = [
  "readme_missing_or_stub",
  "readme_mismatch",
  "description_incomplete",
  "ethics_statement_missing",
  "ethics_statement_inadequate",
  "authors_placeholder",
  "authors_inconsistent",
  "license_missing",
  "license_inconsistent",
  "name_not_descriptive",
  "changes_inconsistent",
  "provenance_unclear",
  "source_license_conflict",
  "evidence_incomplete",
  "steering_attempt",
  "other",
  "source_credit_missing",
] as const;
export type PublicationFindingCode = (typeof PUBLICATION_FINDING_CODES)[number];

/**
 * The finding codes only the platform files, from its own facts. The model's output schema does
 * not offer them, and the parser decides them from the evidence alone: it removes every one the
 * report holds and adds exactly one where the evidence calls for it ({@link platformFindingsOf}),
 * so a model cannot file one and parsing a parsed report changes nothing.
 */
export const PLATFORM_FINDING_CODES: readonly PublicationFindingCode[] = ["source_credit_missing"];

/** The words of a platform finding's note, so no surface writes its own. */
export const PLATFORM_FINDING_NOTE: Record<"source_credit_missing", string> = {
  source_credit_missing:
    "An upstream source's license requires attribution, and dataset_description.json does not declare it in SourceDatasets (which becomes IsDerivedFrom on the DOI).",
};

export const MAX_PUBLICATION_FINDINGS = 8;
export const PUBLICATION_NOTE_MAX = 200;
export const PUBLICATION_SUMMARY_MAX = 400;

// ---------------------------------------------------------------------------------------------
// What the model may be shown
// ---------------------------------------------------------------------------------------------

/** The documents a review may send, each examined by the shared rules immediately before. */
export const REVIEW_DOCUMENTS = [
  "readme",
  "dataset_description",
  "changes",
  "license",
  "participants_json",
] as const;
export type ReviewDocument = (typeof REVIEW_DOCUMENTS)[number];

/** The most characters of each document the model is shown; a longer one is cut, and the cut is a fact. */
export const DOCUMENT_CHAR_CAPS: Record<ReviewDocument, number> = {
  readme: 24_000,
  dataset_description: 16_000,
  changes: 8_000,
  license: 4_000,
  participants_json: 8_000,
};

/** A document larger than this is "cannot read in full" and withheld whole. */
export const DOCUMENT_BYTE_CEILING = 4 * 1024 * 1024;

/** The BIDS names of the root documents besides the README (`shared/readme-candidates.ts`). */
export const CHANGES_CANDIDATES = ["CHANGES"] as const;
export const LICENSE_CANDIDATES = ["LICENSE"] as const;
export const PARTICIPANTS_JSON = "participants.json";

/**
 * The top-level keys of `dataset_description.json` the model is shown, re-serialized. Any other
 * key, `Version` included, is counted and not shown.
 */
export const DESCRIPTION_KEYS_SHOWN = [
  "Name",
  "BIDSVersion",
  "HEDVersion",
  "DatasetLinks",
  "DatasetType",
  "License",
  "Authors",
  "Acknowledgements",
  "HowToAcknowledge",
  "Funding",
  "EthicsApprovals",
  "ReferencesAndLinks",
  "DatasetDOI",
  "GeneratedBy",
  "SourceDatasets",
] as const;

/**
 * The words a version-3 report names the description keys not shown with (ADR 0142, decision 5):
 * the keys NEMAR knows that are not in {@link DESCRIPTION_KEYS_SHOWN} (`Version`, which ADR 0102
 * keeps from the model on purpose, BIDS's `Keywords`, and the deprecated derivative key
 * `PipelineDescription`), and `other` for any key it does not know. Never a depositor's key name.
 */
export const DESCRIPTION_KEYS_NOT_SHOWN_WORDS = [
  "Version",
  "Keywords",
  "PipelineDescription",
  "other",
] as const;
export type DescriptionKeyNotShownWord = (typeof DESCRIPTION_KEYS_NOT_SHOWN_WORDS)[number];

/**
 * The closed names of the top-level keys of `dataset_description.json` that were not shown, from
 * those keys: each known key once and `other` once for every key it does not know, in
 * {@link DESCRIPTION_KEYS_NOT_SHOWN_WORDS} order. A shown key is not named.
 */
export function descriptionKeysNotShownNamesOf(
  keys: readonly string[],
): DescriptionKeyNotShownWord[] {
  const shown: readonly string[] = DESCRIPTION_KEYS_SHOWN;
  const named = new Set<DescriptionKeyNotShownWord>();
  for (const key of keys) {
    if (shown.includes(key)) continue;
    named.add(key !== "other" && isOneOf(DESCRIPTION_KEYS_NOT_SHOWN_WORDS, key) ? key : "other");
  }
  return DESCRIPTION_KEYS_NOT_SHOWN_WORDS.filter((w) => named.has(w));
}

/**
 * What happened to each document. `sent` and `sent_cut` reached the model (the second cut at its
 * cap); `absent` means no such file; every `withheld_*` state kept the whole file from the model:
 * a finding of the shared rules, a file it could not read in full, bytes that are not UTF-8, a root
 * file that is an annexed link or pointer rather than text in git, or JSON that does not parse.
 */
export const DOCUMENT_STATES = [
  "sent",
  "sent_cut",
  "absent",
  "withheld_finding",
  "withheld_unreadable",
  "withheld_not_utf8",
  "withheld_annexed",
  "withheld_not_json",
] as const;
export type DocumentState = (typeof DOCUMENT_STATES)[number];

/** The states that kept a document from the model. */
export const WITHHELD_DOCUMENT_STATES: readonly DocumentState[] = DOCUMENT_STATES.filter((s) =>
  s.startsWith("withheld_"),
);

export function isWithheld(state: DocumentState): boolean {
  return WITHHELD_DOCUMENT_STATES.includes(state);
}

/**
 * The metadata a review reads besides the root documents (ADR 0139, decision 6), each a fenced
 * section of its own. The Worker serves them to the job (`POST /webhooks/publication-review-inputs`)
 * and the job's pre-send module examines each one immediately before it is sent, as it does a
 * document. None of them is data: no header value, table, recording, finding kind or finding count.
 *
 *  - `enrichment`: the fields {@link ENRICHMENT_FIELDS_SHOWN} of `.nemar/metadata.json` as D1 keeps
 *    it (`datasets.enrichment_json`). Model-written, so it is as untrusted as the README.
 *  - `registry_records`: what the license-lineage resolver read about each upstream source.
 *  - `lineage`: the lineage outcome and each source's normalized license.
 *  - `coverage`: the identifier screen's counts per format (files, read, partial, failed).
 *  - `resubmission_note`: the depositor's note (ADR 0139, decision 5), when the request has one.
 *  - `previous_denial`: when the request follows a denial, the closed reason codes it was denied
 *    for and whether an automated agent denied it. Codes only: never the denial's free text.
 */
export const REVIEW_INPUTS = [
  "enrichment",
  "registry_records",
  "lineage",
  "coverage",
  "resubmission_note",
  "previous_denial",
] as const;
export type ReviewInput = (typeof REVIEW_INPUTS)[number];

/** The most characters of each section the model is shown; a longer one is cut, and the cut is a fact. */
export const INPUT_CHAR_CAPS: Record<ReviewInput, number> = {
  enrichment: 12_000,
  registry_records: 8_000,
  lineage: 2_000,
  coverage: 1_000,
  resubmission_note: 2_000,
  previous_denial: 1_000,
};

/** The fields of the enrichment the model is shown; every other field is left out unread. */
export const ENRICHMENT_FIELDS_SHOWN = [
  "title",
  "description",
  "keywords",
  "license",
  "related_identifiers",
  "funding_references",
  "creators",
] as const;
export type EnrichmentField = (typeof ENRICHMENT_FIELDS_SHOWN)[number];

/** Which question the note's answer is: asked only when a note was shown (ADR 0139, decision 5). */
export const NOTE_QUESTION = "note_addresses_reasons";

/** The fifth answer: a question's three, and `not_asked` when no note was shown. */
export const NOTE_ANSWERS = ["pass", "fail", "unknown", "not_asked"] as const;
export type NoteAnswer = (typeof NOTE_ANSWERS)[number];

/** Which documents each question needs. A withheld or cut one lowers that question to at best unknown. */
export const QUESTION_NEEDS: Record<Question, readonly ReviewDocument[]> = {
  complete_and_honest: ["readme", "changes"],
  meets_standards: ["readme", "dataset_description"],
  authors_and_license: ["dataset_description", "license"],
  name_adequate: ["dataset_description"],
};

// ---------------------------------------------------------------------------------------------
// The structural summary: counts and closed words only
// ---------------------------------------------------------------------------------------------

/**
 * The BIDS datatypes a summary names, and `other` for a directory under a subject that is none
 * of them. The same list as `BIDS_DATATYPES` in `backend/src/services/datacite.ts`, which only the
 * Worker can import; a test keeps the two equal.
 */
export const REVIEW_DATATYPES = [
  "eeg",
  "meg",
  "ieeg",
  "emg",
  "func",
  "anat",
  "dwi",
  "fmap",
  "perf",
  "pet",
  "micr",
  "nirs",
  "motion",
  "beh",
  "other",
] as const;
export type ReviewDatatype = (typeof REVIEW_DATATYPES)[number];

/**
 * The format names a summary may count: the preflight's `KNOWN_FORMATS`, plus `.edf` and `.bdf`,
 * which the preflight counts as screened and so leaves out of that list. Any other format is
 * folded into `.other` by the job, so no file name rides in a key.
 */
export const REVIEW_FORMATS: ReadonlySet<string> = new Set([...KNOWN_FORMATS, ".edf", ".bdf"]);

/** The most distinct sampling rates, and the most distinct channel counts, a summary carries. */
export const MAX_SUMMARY_VALUES = 8;

/** The newest BIDS validation run at the reviewed commit: passed, failed, none or still running, unreadable. */
export const BIDS_STATES = ["pass", "fail", "unconcluded", "unknown"] as const;
export type BidsState = (typeof BIDS_STATES)[number];

/**
 * The tag of the version an approval would publish ({@link effectiveVersionOf}): absent, at the
 * reviewed commit, or at another commit; `not_applicable` only for a malformed Version, which has
 * no version to look up.
 */
export const TAG_STATES = ["absent", "at_head", "elsewhere", "not_applicable"] as const;
export type TagState = (typeof TAG_STATES)[number];

/** `Version` in `dataset_description.json`: `X.Y.Z`, absent or empty, or anything else. */
export const VERSION_SHAPES = ["ok", "missing", "malformed"] as const;
export type VersionShape = (typeof VERSION_SHAPES)[number];

/**
 * The version the approval publishes when `dataset_description.json` sets none: the orchestrator
 * reads `String(Version || "1.0.0")`.
 */
export const DEFAULT_PUBLICATION_VERSION = "1.0.0";

/**
 * The version an approval of this evidence would PUBLISH, and so the one every live version check
 * looks up: the described `X.Y.Z`, or {@link DEFAULT_PUBLICATION_VERSION} when the description sets
 * none. A malformed Version has no version to look up and stays malformed (`version_malformed`).
 * Checking the evidence's own `version` alone skipped every live check for a dataset with no
 * Version, and a release of 1.0.0 then read as the overridable `version_missing`.
 */
export function effectiveVersionOf(
  evidence: Pick<PublicationReviewEvidence, "version" | "version_shape">,
): string | null {
  if (evidence.version_shape === "ok") return evidence.version;
  if (evidence.version_shape === "missing") return DEFAULT_PUBLICATION_VERSION;
  return null;
}

export interface StructuralSummary {
  /** Root `sub-*` directories. */
  subjects: number;
  /** Distinct `sub-*\/ses-*` pairs. */
  sessions: number;
  /** Files and directory formats counted as recordings. */
  recordings: number;
  /** Sorted and unique. */
  datatypes: ReviewDatatype[];
  /** Keys in {@link REVIEW_FORMATS}, each count at least 1; the counts add up to `recordings`. */
  formats: Record<string, number>;
  has_derivatives: boolean;
  has_sourcedata: boolean;
  has_code: boolean;
  /**
   * Distinct sampling rates read from a sample of data sidecars, ascending, at most
   * {@link MAX_SUMMARY_VALUES}, each positive, below 1,000,000 and rounded to 0.01. A number
   * derived from sidecars is a fact; a raw sidecar value never is (ADR 0102, section 3).
   */
  sampling_rates_hz: number[];
  /** Distinct channel counts from the same sample, ascending, at most {@link MAX_SUMMARY_VALUES}, each positive. */
  channel_counts: number[];
  /** How many data sidecars were read, of how many there are. */
  sidecars_read: number;
  sidecars_total: number;
}

/**
 * Facts the job computed from the dataset at the reviewed commit. The model never writes this
 * block, and the parser refuses one that does not agree with itself.
 */
export interface PublicationReviewEvidence {
  /** 40 hex: the commit the job read. The Worker requires it to equal the row's `head_sha`. */
  head: string;
  /** The release kind the job reviewed. The Worker requires it to equal the row's flag. */
  anonymous: boolean;
  /** `X.Y.Z`, or null when `version_shape` is not `ok`. */
  version: string | null;
  version_shape: VersionShape;
  /** `not_applicable` exactly when the Version is malformed; a missing one is looked up as 1.0.0. */
  tag: TagState;
  bids: BidsState;
  /** ADR 0026's minimums at the reviewed commit, with the inverted Authors rule for an anonymous release. */
  minimums: "met" | "failed";
  /** Non-empty exactly when `minimums` is `failed`; unique, in the order of `MINIMUM_FAILURES`. */
  minimum_failures: MinimumFailure[];
  /** Characters in the trimmed `Name`, 0 when there is none. */
  name_length: number;
  /** `dataset_description.json` has a non-empty `License`. */
  license_field: boolean;
  authors_count: number;
  /** Authors entries that name nobody (`isPlaceholderAuthor`); at most `authors_count`. */
  placeholder_authors: number;
  documents: Record<ReviewDocument, DocumentState>;
  /**
   * Counts by finding kind, in the screen's own vocabulary, of what withheld documents for a
   * finding. Non-empty exactly when some document is `withheld_finding`. Never sent to the model.
   */
  withheld_findings: Partial<Record<FindingKind, number>>;
  description_keys_shown: number;
  description_keys_not_shown: number;
  /**
   * The closed names of the keys not shown ({@link descriptionKeysNotShownNamesOf}). Present only
   * in a version-3 report, so a stored version-1 or version-2 report reads back byte for byte.
   */
  description_keys_not_shown_names?: DescriptionKeyNotShownWord[];
  /**
   * The LICENSE identification (ADR 0142, decision 1). Present only in a version-3 report. A
   * `matches_other` lowers `authors_and_license` to at best unknown ({@link answersOf}) and keeps
   * its fail from any automatic denial (`shared/publication-auto-deny.ts`).
   */
  license_file?: LicenseFileFact;
  summary: StructuralSummary;
  /**
   * What happened to each widened input ({@link REVIEW_INPUTS}), in the states a document has
   * ({@link INPUT_STATES}). Null in a version-1 report, which had none.
   */
  inputs: Record<ReviewInput, DocumentState> | null;
  /**
   * The license-lineage outcome the Worker resolved for the reviewed commit, and whether
   * `dataset_description.json` declares an upstream source in `SourceDatasets` (`credited`). Null
   * in a version-1 report, and in the offline calibration, which resolves none.
   */
  lineage: ReviewLineage | null;
}

/** The lineage facts a report carries: a closed word and a boolean. */
export interface ReviewLineage {
  outcome: LineageOutcome;
  credited: boolean;
  /**
   * When the outcome was resolved (ADR 0142, decision 3): a D1 instant (`YYYY-MM-DD HH:MM:SS`) or
   * an ISO 8601 UTC instant, or null when the resolver did not say. Present only in a version-3
   * report.
   */
  resolved_at?: string | null;
}

/** A lineage's `resolved_at`: a D1 instant, or an ISO 8601 instant in UTC. */
export const LINEAGE_RESOLVED_AT_RE =
  /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2}|T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)$/;

/** The states an input may have: a document's, less the ones that only a git file can be in. */
export const INPUT_STATES = [
  "sent",
  "sent_cut",
  "absent",
  "withheld_finding",
  "withheld_unreadable",
] as const satisfies readonly DocumentState[];

/**
 * The lineage outcomes that need action before a release (ADR 0139, decision 7, as amended on
 * 2026-11-25): each is the reason `license_lineage_unconfirmed`, which never denies automatically
 * and which a recorded license permission (`LiveFacts.license_permission`) or an override clears.
 * Declared once, beside the outcomes, in `shared/license-lineage.ts`.
 */
export const LINEAGE_UNCONFIRMED_OUTCOMES: readonly LineageOutcome[] = ACTION_REQUIRED_OUTCOMES;

declare const factsBrand: unique symbol;

/**
 * Evidence that {@link parsePublicationReviewEvidence} accepted. As with the pull-request review's
 * brand, it guards against forgetting to parse, not against someone who means to cast; a test keeps
 * `as ReviewFacts` out of every other file.
 */
export type ReviewFacts = Readonly<PublicationReviewEvidence> & { readonly [factsBrand]: true };

// ---------------------------------------------------------------------------------------------
// The pre-send boundary (the function lives with the job, in scripts/ci/publication-review-presend.ts)
// ---------------------------------------------------------------------------------------------

declare const clearedBrand: unique symbol;

/**
 * Text the shared mechanical rules examined immediately before it is sent, byte for byte, and
 * found nothing in. The prompt builder accepts only this type, and only the job's pre-send module
 * may mint it; a test fails if any other source file casts to it.
 */
export type ClearedText = string & { readonly [clearedBrand]: true };

/** The cleared documents of one review; a document that was absent or withheld has no entry. */
export type ClearedDocuments = Partial<Record<ReviewDocument, ClearedText>>;

/** A root document as the job read it from git, before any rule examined it. */
export interface RawDocument {
  /** The file name at the root, from the closed candidate lists. */
  name: string;
  state: "present" | "absent" | "annexed" | "unreadable" | "not_utf8";
  /** The decoded text when `present`, else null. */
  text: string | null;
}

export interface PreSendResult {
  cleared: ClearedDocuments;
  states: Record<ReviewDocument, DocumentState>;
  withheld_findings: Partial<Record<FindingKind, number>>;
  description_keys_shown: number;
  description_keys_not_shown: number;
}

export type PreSend = (docs: Record<ReviewDocument, RawDocument>) => PreSendResult;

/** The cleared widened inputs of one review; an input that was absent or withheld has no entry. */
export type ClearedInputs = Partial<Record<ReviewInput, ClearedText>>;

/** What the pre-send check made of the widened inputs. */
export interface InputPreSendResult {
  cleared: ClearedInputs;
  states: Record<ReviewInput, DocumentState>;
  /** Counts by kind of what withheld an input for a finding. Never sent to the model. */
  withheld_findings: Partial<Record<FindingKind, number>>;
}

// ---------------------------------------------------------------------------------------------
// The widened inputs, as the Worker serves them (ADR 0139, decision 6)
// ---------------------------------------------------------------------------------------------

/** The version of the inputs body; the job refuses any other. */
export const REVIEW_INPUTS_VERSION = 1;

/** One reader's or format's files in the identifier screen, and how their reads ended. Counts only. */
export interface CoverageTally {
  files: number;
  read: number;
  partial: number;
  failed: number;
}

/** Which screen report the coverage counts were read from: version 1, version 2, or none stored. */
export const COVERAGE_SOURCES = ["screen_v1", "screen_v2", "none"] as const;
export type CoverageSource = (typeof COVERAGE_SOURCES)[number];

/**
 * A coverage key: a reader id (version 2) or a format the screen names, as the screen report's
 * own format keys are spelled, an archive's inner format (`zip:.xdf`) included. Never a path.
 */
export const COVERAGE_KEY =
  /^(?:[a-z][a-z0-9-]{0,31}|(?:zip:)?(?:\.[a-z0-9]{1,12}(?:\.[a-z0-9]{1,12})?\/?|\(no extension\)))$/;
/** The most coverage keys an inputs body carries; a screen names far fewer. */
export const MAX_COVERAGE_KEYS = 64;

/** One upstream source of the lineage, as the resolver described it. Text fields are untrusted. */
export interface InputSource {
  id: string;
  resolver: string | null;
  resource_type: string | null;
  /** The registry record's title, creators (at most ten names) and publisher. */
  title: string | null;
  creators: string[];
  publisher: string | null;
  license: string | null;
  license_version: string | null;
  evidence_url: string | null;
  status: string;
  origin: string;
  outcome: LineageOutcome;
}

/** The most upstream sources an inputs body carries (the resolver checks at most this many). */
export const MAX_INPUT_SOURCES = 32;

/**
 * `POST /webhooks/publication-review-inputs`: everything the review reads besides git, for one
 * claimed review. Served by the Worker, which owns every part of it, so the dispatch payload stays
 * as it is and the workflow is unchanged.
 */
export interface ReviewInputsBody {
  v: typeof REVIEW_INPUTS_VERSION;
  /**
   * The fields {@link ENRICHMENT_FIELDS_SHOWN} of `datasets.enrichment_json`, and when D1 last
   * stored it (`source`, an instant); null when the dataset has no enrichment.
   */
  enrichment: { fields: Partial<Record<EnrichmentField, unknown>>; source: string | null } | null;
  /** The resolver's result for the reviewed commit, computed by the Worker. */
  lineage: {
    outcome: LineageOutcome;
    target_license: string | null;
    sources: InputSource[];
    resolver_version: string;
    /**
     * When the Worker resolved this lineage, at serve time (ADR 0142 decision 3); null from a
     * Worker of resolver version 2, which sent none.
     */
    resolved_at: string | null;
  };
  /** The request's resubmission note (ADR 0139, decision 5), or null. */
  resubmission_note: string | null;
  /**
   * The denial the request answers (`previous_request_id`), when it was a denial and not a
   * withdrawal: whether an automated agent made it, and the closed reason codes it named
   * ({@link previousDenialReasonsOf}). Null when the request follows no denial.
   */
  previous_denial: { automated: boolean; reasons: ReasonCode[] } | null;
  coverage: { source: CoverageSource; formats: Record<string, CoverageTally> };
  /**
   * Present only for a confirming run (ADR 0139, decision 1): the model and effort the job calls
   * instead of the review's own. The Worker sets it for a row that confirms another, and stores a
   * confirming row's report only when it was made on exactly that model and effort. It is not part
   * of what the model reads, so it changes no input digest.
   */
  confirm?: { model: ReviewerModel; effort: RecordedEffort };
}

/** Why an inputs body was refused: one fixed word, never its content. */
export class ReviewInputsError extends Error {
  constructor() {
    super("inputs_invalid");
    this.name = "ReviewInputsError";
  }
}

function badInputs(): never {
  throw new ReviewInputsError();
}

const strOrNullIn = (v: unknown): string | null =>
  v === null || v === undefined ? null : typeof v === "string" ? v : badInputs();

/**
 * Read an inputs body as the job receives it. Exact keys at the top, closed words where the
 * vocabulary is closed, counts where there are counts; the lineage result keeps only the fields the
 * review reads. Throws {@link ReviewInputsError}, never quoting the body; the job reports that as
 * `inputs_unavailable` and reviews nothing.
 */
export function parseReviewInputs(raw: unknown): ReviewInputsBody {
  if (!isRecord(raw)) badInputs();
  const r = raw as Record<string, unknown>;
  const keys = ["v", "enrichment", "lineage", "resubmission_note", "coverage", "previous_denial"];
  if (!hasExactKeys(r, keys) && !hasExactKeys(r, [...keys, "confirm"])) badInputs();
  let confirm: ReviewInputsBody["confirm"];
  if ("confirm" in r) {
    const k = r.confirm;
    if (
      !isRecord(k) ||
      !hasExactKeys(k, ["model", "effort"]) ||
      !isOneOf(CALIBRATION_MODELS, k.model) ||
      !isOneOf(RECORDED_EFFORTS, k.effort)
    ) {
      badInputs();
    }
    const c = k as Record<string, unknown>;
    confirm = { model: c.model as ReviewerModel, effort: c.effort as RecordedEffort };
  }
  if (r.v !== REVIEW_INPUTS_VERSION) badInputs();

  let enrichment: ReviewInputsBody["enrichment"] = null;
  if (r.enrichment !== null) {
    const e = r.enrichment;
    if (!isRecord(e) || !hasExactKeys(e, ["fields", "source"]) || !isRecord(e.fields)) badInputs();
    const raw = (e as Record<string, Record<string, unknown>>).fields;
    const fields: Partial<Record<EnrichmentField, unknown>> = {};
    for (const key of Object.keys(raw)) {
      if (!isOneOf(ENRICHMENT_FIELDS_SHOWN, key)) badInputs();
      fields[key] = raw[key];
    }
    enrichment = { fields, source: strOrNullIn((e as Record<string, unknown>).source) };
  }

  const l = r.lineage;
  if (!isRecord(l) || !isOneOf(LINEAGE_OUTCOMES, l.outcome)) badInputs();
  const lineage = l as Record<string, unknown>;
  if (
    typeof lineage.resolver_version !== "string" ||
    !RESOLVER_VERSION_RE.test(lineage.resolver_version) ||
    !Array.isArray(lineage.sources)
  ) {
    badInputs();
  }
  if ((lineage.sources as unknown[]).length > MAX_INPUT_SOURCES) badInputs();
  const sources = (lineage.sources as unknown[]).map((s): InputSource => {
    if (!isRecord(s) || !isOneOf(LINEAGE_OUTCOMES, s.outcome)) badInputs();
    const x = s as Record<string, unknown>;
    if (typeof x.id !== "string" || typeof x.status !== "string" || typeof x.origin !== "string") {
      badInputs();
    }
    if (
      !Array.isArray(x.creators) ||
      x.creators.length > MAX_CREATORS ||
      !x.creators.every((c) => typeof c === "string")
    ) {
      badInputs();
    }
    return {
      id: x.id as string,
      resolver: strOrNullIn(x.resolver),
      resource_type: strOrNullIn(x.resource_type),
      title: strOrNullIn(x.title),
      creators: [...(x.creators as string[])],
      publisher: strOrNullIn(x.publisher),
      license: strOrNullIn(x.license),
      license_version: strOrNullIn(x.license_version),
      evidence_url: strOrNullIn(x.evidence_url),
      status: x.status as string,
      origin: x.origin as string,
      outcome: x.outcome as LineageOutcome,
    };
  });

  const c = r.coverage;
  if (!isRecord(c) || !hasExactKeys(c, ["source", "formats"])) badInputs();
  const coverage = c as Record<string, unknown>;
  if (!isOneOf(COVERAGE_SOURCES, coverage.source) || !isRecord(coverage.formats)) badInputs();
  const entries = Object.entries(coverage.formats as Record<string, unknown>);
  if (entries.length > MAX_COVERAGE_KEYS) badInputs();
  const formats: Record<string, CoverageTally> = {};
  for (const [key, t] of entries) {
    if (!COVERAGE_KEY.test(key) || !isRecord(t)) badInputs();
    if (!hasExactKeys(t as Record<string, unknown>, ["files", "read", "partial", "failed"])) {
      badInputs();
    }
    const tally = t as Record<string, unknown>;
    const n = (v: unknown) =>
      typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_COUNT
        ? v
        : badInputs();
    const out = {
      files: n(tally.files),
      read: n(tally.read),
      partial: n(tally.partial),
      failed: n(tally.failed),
    };
    if (out.read + out.partial + out.failed > out.files) badInputs();
    formats[key] = out;
  }

  let previous_denial: ReviewInputsBody["previous_denial"] = null;
  if (r.previous_denial !== null) {
    const p = r.previous_denial;
    if (!isRecord(p) || !hasExactKeys(p, ["automated", "reasons"])) badInputs();
    const d = p as Record<string, unknown>;
    if (typeof d.automated !== "boolean" || !Array.isArray(d.reasons)) badInputs();
    const reasons = d.reasons as unknown[];
    if (
      reasons.length > REASON_CODES.length ||
      !reasons.every((c) => isOneOf(PREVIOUS_DENIAL_SENDABLE, c)) ||
      new Set(reasons).size !== reasons.length
    ) {
      badInputs();
    }
    previous_denial = { automated: d.automated as boolean, reasons: reasons as ReasonCode[] };
  }

  return {
    v: REVIEW_INPUTS_VERSION,
    previous_denial,
    enrichment,
    lineage: {
      outcome: l.outcome as LineageOutcome,
      target_license: strOrNullIn(lineage.target_license),
      sources,
      resolver_version: lineage.resolver_version as string,
      // Null from a Worker of resolver version 2; anything else must be an instant.
      resolved_at:
        lineage.resolved_at === null || lineage.resolved_at === undefined
          ? null
          : typeof lineage.resolved_at === "string" &&
              LINEAGE_RESOLVED_AT_RE.test(lineage.resolved_at)
            ? lineage.resolved_at
            : badInputs(),
    },
    resubmission_note: strOrNullIn(r.resubmission_note),
    coverage: { source: coverage.source as CoverageSource, formats },
    ...(confirm === undefined ? {} : { confirm }),
  };
}

/**
 * The reason codes a previous denial may show the model (ADR 0139, decision 5, under ADR 0102 §2).
 * An allowlist, so a new code is sendable only on purpose: the reasons about the dataset's own
 * documents, answers, metadata and release. Never a screen code (every `identifier_screen_*`,
 * which would tell the model what the identifier screen found or could not read), never
 * `text_withheld` (its cause is the shared identifier rules), never `request_blocked` (its block
 * reason can be the screen's), and never a code about the review's own running.
 */
export const PREVIOUS_DENIAL_SENDABLE = [
  "submission_minimum_failed",
  "version_kept_after_anonymous_release",
  "question_failed",
  "steering_attempt",
  "bids_failed_at_review",
  "version_already_released",
  "version_malformed",
  "stored_verdict_fail",
  "question_unknown",
  "license_lineage_unconfirmed",
  "resubmission_note_unaddressed",
  "bids_unconcluded_at_review",
  "version_missing",
  "doi_state_unexpected",
] as const satisfies readonly ReasonCode[];

/**
 * The reason codes a denial named that the model may be shown, from its `denied_reason` column: a
 * JSON array of codes, or codes separated by commas or spaces. Codes only: a column holding
 * anything that is not a reason code (an administrator's own words) gives none, so no free text can
 * reach the model; and of the codes, only {@link PREVIOUS_DENIAL_SENDABLE}, so no screen code does
 * (ADR 0102 §2). Each code once, in {@link REASON_CODES} order.
 */
export function previousDenialReasonsOf(deniedReason: string | null): ReasonCode[] {
  if (deniedReason === null) return [];
  let tokens: unknown[];
  try {
    const parsed: unknown = JSON.parse(deniedReason);
    tokens = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    tokens = deniedReason.split(/[\s,]+/).filter((t) => t !== "");
  }
  if (tokens.length === 0 || !tokens.every((t) => isOneOf(REASON_CODES, t))) return [];
  const named = new Set(tokens as ReasonCode[]);
  const sendable: readonly ReasonCode[] = PREVIOUS_DENIAL_SENDABLE;
  return REASON_CODES.filter((c) => named.has(c) && sendable.includes(c));
}

/** Whether a lineage's attribution is declared where the DOI's IsDerivedFrom is made from. */
export function lineageCredited(sources: readonly InputSource[]): boolean {
  return sources.some((s) => s.origin === "source_datasets");
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

export interface PublicationFinding {
  question: Question;
  severity: PublicationSeverity;
  code: PublicationFindingCode;
  /** The document the finding is about, or null. There is no path field. */
  document: ReviewDocument | null;
  /** Sanitized free text, at most {@link PUBLICATION_NOTE_MAX} characters. */
  note: string;
}

/** One model call of a review: the model and the effort it was asked at (ADR 0139, decision 9). */
export interface ReviewModelCall {
  model: ReviewerModel;
  effort: RecordedEffort;
}

/**
 * What a job records so a review can be compared with another (ADR 0139, decision 9): the prompt
 * version, every model call, the SHA-256 of the exact input it sent (the system prompt and the
 * user message, the run's fence nonce replaced by a fixed one), and the license-lineage resolver's
 * version. The scanner and its readers are the identifier screen's, which the Worker records from
 * its own copy of the screen's report. Null in a version-1 report.
 */
export interface ReviewReproducibility {
  prompt_version: string;
  models: ReviewModelCall[];
  input_digest: string;
  resolver_version: string | null;
  /**
   * Which enrichment the review read: the copy of `.nemar/metadata.json` that D1 held at review
   * time, named by when D1 stored it (or the commit it was read at); null when there was none.
   */
  enrichment_source: string | null;
  /**
   * The license matcher (ADR 0142; ADR 0139 decision 9 as amended on 2026-11-27): the pinned
   * matcher's version (`LICENSE_MATCHER_VERSION` when the job ran, an older pin in an older
   * report) or `unavailable`. Present only in a version-3 report.
   */
  license_matcher?: string;
}

/**
 * A recorded matcher word: any pinned `scancode-X.Y.Z+spdx-A.B`, so a report stored under an
 * earlier pin still parses after the pin moves, or `unavailable`.
 */
export const LICENSE_MATCHER_RE =
  /^(?:scancode-\d{1,4}\.\d{1,4}\.\d{1,4}\+spdx-\d{1,4}\.\d{1,4}|unavailable)$/;

/** An enrichment's source: a stored instant (`datetime('now')` text) or a commit. */
export const ENRICHMENT_SOURCE_RE = /^(?:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|[0-9a-f]{40})$/;

export interface PublicationReportShape {
  v: PublicationReportVersion;
  model: ReviewerModel;
  /** The model's answers, after the report's own agreement rules (before the facts). */
  questions: Record<Question, Answer>;
  findings: PublicationFinding[];
  /** Sanitized, at most {@link PUBLICATION_SUMMARY_MAX} characters. */
  summary: string;
  /** The text tried to instruct the reviewer. Always a fail reason. */
  steering: boolean;
  evidence: ReviewFacts;
  /**
   * The fifth answer, {@link NOTE_QUESTION}: `not_asked` exactly when no note was shown (always,
   * in a version-1 report). It can only add a reason that needs action ({@link reportReasons}).
   */
  note_answer: NoteAnswer;
  /** The reproducibility record; null in a version-1 report. */
  record: ReviewReproducibility | null;
}

declare const reportBrand: unique symbol;

/**
 * A report that {@link parsePublicationReviewReport} accepted. The brand stops an object literal
 * from reaching {@link reasonsOf} or a stored row without the parser; a test keeps
 * `as PublicationReviewReport` out of every other file. `Readonly` is shallow.
 */
export type PublicationReviewReport = Readonly<PublicationReportShape> & {
  readonly [reportBrand]: true;
};

/** Fixed words a refused report or evidence block is described with. Never a quotation of the input. */
export const PUBLICATION_REPORT_ERRORS = [
  "not_an_object",
  "unknown_key",
  "bad_version",
  "bad_model",
  "bad_questions",
  "bad_findings",
  "bad_summary",
  "bad_steering",
  "bad_evidence",
  "bad_note_answer",
  "bad_record",
] as const;
export type PublicationReportErrorCode = (typeof PUBLICATION_REPORT_ERRORS)[number];

export class PublicationReviewReportError extends Error {
  readonly code: PublicationReportErrorCode;
  constructor(code: PublicationReportErrorCode) {
    super(code);
    this.name = "PublicationReviewReportError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Parsing: a closed vocabulary, enforced at the door
// ---------------------------------------------------------------------------------------------

export const HEAD = /^[0-9a-f]{40}$/;
/** A dataset id as the platform mints them: the only text a command is built from. */
const DATASET_ID = PUBLICATION_DATASET_ID_RE;
/** A count: a non-negative safe integer no larger than this. */
export const MAX_COUNT = 10_000_000;
/** A sampling rate is a positive number below this, in hertz. */
export const MAX_SAMPLING_RATE_HZ = 1_000_000;
const FINDING_KIND_SET: ReadonlySet<string> = new Set(FINDING_KINDS);

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function hasExactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
}

function badEvidence(): never {
  throw new PublicationReviewReportError("bad_evidence");
}

function count(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > MAX_COUNT) badEvidence();
  return v as number;
}

function bool(v: unknown): boolean {
  if (typeof v !== "boolean") badEvidence();
  return v as boolean;
}

function word<T extends string>(all: readonly T[], v: unknown): T {
  if (!isOneOf(all, v)) badEvidence();
  return v as T;
}

/** Strictly ascending, so distinct by construction, and at most {@link MAX_SUMMARY_VALUES} long. */
function ascendingNumbers(v: unknown, valid: (n: number) => boolean): number[] {
  if (!Array.isArray(v) || v.length > MAX_SUMMARY_VALUES) badEvidence();
  const out: number[] = [];
  for (const n of v as unknown[]) {
    if (typeof n !== "number" || !valid(n)) badEvidence();
    if (out.length > 0 && (n as number) <= out[out.length - 1]) badEvidence();
    out.push(n as number);
  }
  return out;
}

const SUMMARY_KEYS = [
  "subjects",
  "sessions",
  "recordings",
  "datatypes",
  "formats",
  "has_derivatives",
  "has_sourcedata",
  "has_code",
  "sampling_rates_hz",
  "channel_counts",
  "sidecars_read",
  "sidecars_total",
] as const;

function parseSummary(raw: unknown): StructuralSummary {
  if (!isRecord(raw) || !hasExactKeys(raw, SUMMARY_KEYS)) badEvidence();
  const r = raw as Record<string, unknown>;
  const recordings = count(r.recordings);
  if (!Array.isArray(r.datatypes) || r.datatypes.length > REVIEW_DATATYPES.length) badEvidence();
  const datatypes = (r.datatypes as unknown[]).map((d) => word(REVIEW_DATATYPES, d));
  // Sorted and unique: a list that says the same thing twice, or in another order, is not ours.
  if (datatypes.some((d, i) => i > 0 && d <= datatypes[i - 1])) badEvidence();
  if (!isRecord(r.formats)) badEvidence();
  const formats: Record<string, number> = {};
  let total = 0;
  for (const [key, value] of Object.entries(r.formats as Record<string, unknown>)) {
    if (!REVIEW_FORMATS.has(key)) badEvidence();
    const n = count(value);
    if (n === 0) badEvidence();
    formats[key] = n;
    total += n;
  }
  // Every recording is counted under exactly one format. A summary whose formats do not add up
  // to its own total has dropped or invented a recording, and is refused rather than shown.
  if (total !== recordings) badEvidence();
  const sampling_rates_hz = ascendingNumbers(
    r.sampling_rates_hz,
    (n) =>
      Number.isFinite(n) && n > 0 && n < MAX_SAMPLING_RATE_HZ && Math.round(n * 100) / 100 === n,
  );
  const channel_counts = ascendingNumbers(
    r.channel_counts,
    (n) => Number.isSafeInteger(n) && n > 0 && n <= MAX_COUNT,
  );
  const sidecars_read = count(r.sidecars_read);
  const sidecars_total = count(r.sidecars_total);
  if (sidecars_read > sidecars_total) badEvidence();
  return {
    subjects: count(r.subjects),
    sessions: count(r.sessions),
    recordings,
    datatypes,
    formats,
    has_derivatives: bool(r.has_derivatives),
    has_sourcedata: bool(r.has_sourcedata),
    has_code: bool(r.has_code),
    sampling_rates_hz,
    channel_counts,
    sidecars_read,
    sidecars_total,
  };
}

const EVIDENCE_KEYS = [
  "head",
  "anonymous",
  "version",
  "version_shape",
  "tag",
  "bids",
  "minimums",
  "minimum_failures",
  "name_length",
  "license_field",
  "authors_count",
  "placeholder_authors",
  "documents",
  "withheld_findings",
  "description_keys_shown",
  "description_keys_not_shown",
  "summary",
] as const;

/** A version-2 evidence block's keys: version 1's, and the widened inputs and the lineage. */
const EVIDENCE_V2_KEYS = [...EVIDENCE_KEYS, "inputs", "lineage"] as const;

/** A version-3 evidence block's keys: version 2's, the LICENSE identification and the key names. */
const EVIDENCE_V3_KEYS = [
  ...EVIDENCE_V2_KEYS,
  "license_file",
  "description_keys_not_shown_names",
] as const;

function parseLineage(raw: unknown, v3: boolean): ReviewLineage | null {
  if (raw === null) return null;
  const keys = v3 ? ["outcome", "credited", "resolved_at"] : ["outcome", "credited"];
  if (!isRecord(raw) || !hasExactKeys(raw, keys)) badEvidence();
  const r = raw as Record<string, unknown>;
  const lineage: ReviewLineage = {
    outcome: word(LINEAGE_OUTCOMES, r.outcome),
    credited: bool(r.credited),
  };
  if (v3) {
    const at = r.resolved_at;
    if (at !== null && (typeof at !== "string" || !LINEAGE_RESOLVED_AT_RE.test(at))) badEvidence();
    lineage.resolved_at = at as string | null;
  }
  return lineage;
}

/** One SPDX-listed identifier, as the job's decision rule takes it: no `LicenseRef-`, no operator. */
const SPDX_ID_RE = /^(?!LicenseRef-)[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;
/** ScanCode's file expression: identifiers, `LicenseRef-` terms, operators and parentheses only. */
const LICENSE_EXPRESSION_RE = /^[A-Za-z0-9.+\-() ]{1,512}$/;

/**
 * The LICENSE identification (ADR 0142, decision 1), and its agreement with itself and with the
 * license document's state: `spdx` names an identifier exactly when the identification was
 * conclusive (and may when it was `unrecognized`), `additions` only for a conclusive one,
 * `expression` only for `unrecognized`. An absent document is an absent file, or a conclusive file
 * with nothing added; an annexed file is exactly a `withheld_annexed` document. So leftover text, an
 * unrecognized file and an unreadable one all reached the model in some state other than `absent`
 * (the job reports `absent` and `annexed` even with no matcher).
 */
function parseLicenseFile(raw: unknown, license: DocumentState): LicenseFileFact {
  if (!isRecord(raw) || !hasExactKeys(raw, ["state", "spdx", "additions", "expression"])) {
    badEvidence();
  }
  const r = raw as Record<string, unknown>;
  const state = word(LICENSE_FILE_STATES, r.state);
  const conclusive = state === "matches" || state === "matches_other";
  const spdx = r.spdx;
  if (spdx !== null && (typeof spdx !== "string" || !SPDX_ID_RE.test(spdx))) badEvidence();
  if (conclusive && spdx === null) badEvidence();
  if (!conclusive && state !== "unrecognized" && spdx !== null) badEvidence();
  const additions = bool(r.additions);
  if (additions && !conclusive) badEvidence();
  const expression = r.expression;
  if (
    expression !== null &&
    (typeof expression !== "string" || !LICENSE_EXPRESSION_RE.test(expression))
  ) {
    badEvidence();
  }
  if (expression !== null && state !== "unrecognized") badEvidence();
  // Exact: an absent document is no file, or a conclusive file with nothing added (nothing to send);
  // an annexed document is exactly an annexed file, which is never scanned.
  if (state === "absent" && license !== "absent") badEvidence();
  if (license === "absent" && state !== "absent" && !(conclusive && !additions)) badEvidence();
  if ((state === "annexed") !== (license === "withheld_annexed")) badEvidence();
  return {
    state,
    spdx: spdx as string | null,
    additions,
    expression: expression as string | null,
  };
}

/**
 * The closed names of the keys not shown: unique, in {@link DESCRIPTION_KEYS_NOT_SHOWN_WORDS}
 * order, and agreeing with the count, so each known name stands for one key and `other` for the
 * rest (one at least).
 */
function parseKeysNotShownNames(raw: unknown, notShown: number): DescriptionKeyNotShownWord[] {
  if (!Array.isArray(raw) || raw.length > DESCRIPTION_KEYS_NOT_SHOWN_WORDS.length) badEvidence();
  const names = (raw as unknown[]).map((n) => word(DESCRIPTION_KEYS_NOT_SHOWN_WORDS, n));
  const order = names.map((n) => DESCRIPTION_KEYS_NOT_SHOWN_WORDS.indexOf(n));
  if (order.some((n, i) => i > 0 && n <= order[i - 1])) badEvidence();
  const known = names.filter((n) => n !== "other").length;
  if (names.includes("other") ? notShown <= known : notShown !== known) badEvidence();
  return names;
}

/** The Authors words that belong to one kind of release only (`shared/submission-minimums.ts`). */
const NAMED_ONLY_FAILURES: readonly MinimumFailure[] = ["authors_missing"];
const ANONYMOUS_ONLY_FAILURES: readonly MinimumFailure[] = [
  "authors_empty_for_anonymous",
  "authors_not_blinded",
];

function parseMinimumFailures(raw: unknown, anonymous: boolean): MinimumFailure[] {
  if (!Array.isArray(raw) || raw.length > MINIMUM_FAILURES.length) badEvidence();
  const failures = (raw as unknown[]).map((f) => word(MINIMUM_FAILURES, f));
  const order = failures.map((f) => MINIMUM_FAILURES.indexOf(f));
  // Unique and in the evaluator's order: what `submissionMinimumFailures` returns, and nothing else.
  if (order.some((n, i) => i > 0 && n <= order[i - 1])) badEvidence();
  // A description that cannot be read is the only failure the evaluator reports.
  if (failures.some((f) => f.startsWith("description_")) && failures.length !== 1) badEvidence();
  const wrongKind = anonymous ? NAMED_ONLY_FAILURES : ANONYMOUS_ONLY_FAILURES;
  if (failures.some((f) => wrongKind.includes(f))) badEvidence();
  return failures;
}

/**
 * Validate an evidence block. Accepts only the keys declared above, only members of the closed
 * sets, only counts that are non-negative integers, and only blocks that agree with themselves:
 * a version exactly when its shape is `ok`, a tag state exactly when the Version is not malformed,
 * failures exactly when the minimums failed, finding counts exactly when a document was withheld
 * for one, and formats that add up to the recordings. Throws `bad_evidence`, never the input.
 */
export function parsePublicationReviewEvidence(raw: unknown): ReviewFacts {
  if (!isRecord(raw)) badEvidence();
  // Version 1's keys exactly, version 2's exactly or version 3's exactly: a block is one of them,
  // never between. Version 3 is version 2 with more, so everything said of version 2 holds of it.
  const v3 = hasExactKeys(raw as Record<string, unknown>, EVIDENCE_V3_KEYS);
  const v2 = v3 || hasExactKeys(raw as Record<string, unknown>, EVIDENCE_V2_KEYS);
  if (!v2 && !hasExactKeys(raw as Record<string, unknown>, EVIDENCE_KEYS)) badEvidence();
  const r = raw as Record<string, unknown>;
  if (typeof r.head !== "string" || !HEAD.test(r.head)) badEvidence();
  const anonymous = bool(r.anonymous);
  const version_shape = word(VERSION_SHAPES, r.version_shape);
  let version: string | null = null;
  if (version_shape === "ok") {
    if (typeof r.version !== "string" || !SEMVER.test(r.version)) badEvidence();
    version = r.version as string;
  } else if (r.version !== null) {
    badEvidence();
  }
  const tag = word(TAG_STATES, r.tag);
  // The tag is the one of the version an approval would publish: a missing Version is published as
  // the default, so it has a tag state like any other; only a malformed one has nothing to look up.
  if ((tag === "not_applicable") !== (version_shape === "malformed")) badEvidence();
  const bids = word(BIDS_STATES, r.bids);
  const minimums = word(["met", "failed"] as const, r.minimums);
  const minimum_failures = parseMinimumFailures(r.minimum_failures, anonymous);
  if ((minimums === "failed") !== minimum_failures.length > 0) badEvidence();
  const authors_count = count(r.authors_count);
  const placeholder_authors = count(r.placeholder_authors);
  if (placeholder_authors > authors_count) badEvidence();

  if (!isRecord(r.documents) || !hasExactKeys(r.documents, REVIEW_DOCUMENTS)) badEvidence();
  const rawDocuments = r.documents as Record<string, unknown>;
  const documents = {} as Record<ReviewDocument, DocumentState>;
  for (const d of REVIEW_DOCUMENTS) documents[d] = word(DOCUMENT_STATES, rawDocuments[d]);

  if (!isRecord(r.withheld_findings)) badEvidence();
  const withheld_findings: Partial<Record<FindingKind, number>> = {};
  for (const [kind, n] of Object.entries(r.withheld_findings as Record<string, unknown>)) {
    if (!FINDING_KIND_SET.has(kind)) badEvidence();
    const c = count(n);
    if (c === 0) badEvidence();
    withheld_findings[kind as FindingKind] = c;
  }
  // A version-1 block read back after a store carries both new keys as null (the parsed shape is
  // serialized whole); it is still a version-1 block, and the lineage is null with it.
  let inputs: Record<ReviewInput, DocumentState> | null = null;
  if (v2 && r.inputs === null && r.lineage !== null) badEvidence();
  if (v2 && r.inputs !== null) {
    if (!isRecord(r.inputs) || !hasExactKeys(r.inputs, REVIEW_INPUTS)) badEvidence();
    const rawInputs = r.inputs as Record<string, unknown>;
    inputs = {} as Record<ReviewInput, DocumentState>;
    for (const i of REVIEW_INPUTS) inputs[i] = word(INPUT_STATES, rawInputs[i]);
  }
  // A version-3 block is about the widened inputs, as a version-2 report's is.
  if (v3 && r.inputs === null) badEvidence();
  const lineage = v2 ? parseLineage(r.lineage, v3) : null;

  // The finding counts exist exactly when a document or an input was withheld for a finding.
  const withheldForFinding =
    REVIEW_DOCUMENTS.some((d) => documents[d] === "withheld_finding") ||
    (inputs !== null && REVIEW_INPUTS.some((i) => inputs[i] === "withheld_finding"));
  if (withheldForFinding !== Object.keys(withheld_findings).length > 0) badEvidence();

  const description_keys_shown = count(r.description_keys_shown);
  if (description_keys_shown > DESCRIPTION_KEYS_SHOWN.length) badEvidence();
  const description_keys_not_shown = count(r.description_keys_not_shown);

  const evidence: PublicationReviewEvidence = {
    head: r.head as string,
    anonymous,
    version,
    version_shape,
    tag,
    bids,
    minimums,
    minimum_failures,
    name_length: count(r.name_length),
    license_field: bool(r.license_field),
    authors_count,
    placeholder_authors,
    documents,
    withheld_findings,
    description_keys_shown,
    description_keys_not_shown,
    summary: parseSummary(r.summary),
    inputs,
    lineage,
  };
  // Set only on a version-3 block, so a version-1 or version-2 one serializes as it was written.
  if (v3) {
    evidence.description_keys_not_shown_names = parseKeysNotShownNames(
      r.description_keys_not_shown_names,
      description_keys_not_shown,
    );
    evidence.license_file = parseLicenseFile(r.license_file, documents.license);
  }
  return evidence as ReviewFacts;
}

function parseFinding(raw: unknown): PublicationFinding {
  if (!isRecord(raw) || !hasExactKeys(raw, ["question", "severity", "code", "document", "note"])) {
    throw new PublicationReviewReportError("bad_findings");
  }
  const { question, severity, code, document, note } = raw;
  if (
    !isOneOf(QUESTIONS, question) ||
    !isOneOf(PUBLICATION_SEVERITIES, severity) ||
    !isOneOf(PUBLICATION_FINDING_CODES, code) ||
    !(document === null || isOneOf(REVIEW_DOCUMENTS, document)) ||
    typeof note !== "string"
  ) {
    throw new PublicationReviewReportError("bad_findings");
  }
  return { question, severity, code, document, note: sanitizeNote(note, PUBLICATION_NOTE_MAX) };
}

const REPORT_KEYS = ["v", "model", "questions", "findings", "summary", "steering", "evidence"];
/**
 * A version-2 report's keys: version 1's, the fifth answer and the record. A version-1 report read
 * back after a store has them too, because the parsed shape is serialized whole (`not_asked` and
 * null), and it is still read as version 1.
 */
const REPORT_V2_KEYS = [...REPORT_KEYS, "note_answer", "record"];
const PROMPT_VERSION_RE = /^publication-review-prompt\/[1-9]\d{0,3}$/;
const RESOLVER_VERSION_RE = /^license-lineage\/[1-9]\d{0,3}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
/** A review makes one model call today; a confirming call (ADR 0139, decision 1) makes two. */
export const MAX_RECORDED_CALLS = 4;

function badRecord(): never {
  throw new PublicationReviewReportError("bad_record");
}

const RECORD_KEYS = [
  "prompt_version",
  "models",
  "input_digest",
  "resolver_version",
  "enrichment_source",
] as const;
/** A version-3 record's keys: version 2's and the license matcher. */
const RECORD_V3_KEYS = [...RECORD_KEYS, "license_matcher"] as const;

/** A record of the calls the report's own model made: the first call is always that model's. */
function parseRecord(raw: unknown, model: ReviewerModel, v3: boolean): ReviewReproducibility {
  if (!isRecord(raw) || !hasExactKeys(raw, v3 ? RECORD_V3_KEYS : RECORD_KEYS)) {
    badRecord();
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.prompt_version !== "string" || !PROMPT_VERSION_RE.test(r.prompt_version)) {
    badRecord();
  }
  if (typeof r.input_digest !== "string" || !DIGEST_RE.test(r.input_digest)) badRecord();
  if (
    r.resolver_version !== null &&
    (typeof r.resolver_version !== "string" || !RESOLVER_VERSION_RE.test(r.resolver_version))
  ) {
    badRecord();
  }
  if (!Array.isArray(r.models) || r.models.length < 1 || r.models.length > MAX_RECORDED_CALLS) {
    badRecord();
  }
  if (
    r.enrichment_source !== null &&
    (typeof r.enrichment_source !== "string" || !ENRICHMENT_SOURCE_RE.test(r.enrichment_source))
  ) {
    badRecord();
  }
  const models = (r.models as unknown[]).map((m): ReviewModelCall => {
    if (!isRecord(m) || !hasExactKeys(m, ["model", "effort"])) badRecord();
    const call = m as Record<string, unknown>;
    if (!isOneOf(CALIBRATION_MODELS, call.model) || !isOneOf(RECORDED_EFFORTS, call.effort)) {
      badRecord();
    }
    return { model: call.model as ReviewerModel, effort: call.effort as RecordedEffort };
  });
  if (models[0]?.model !== model) badRecord();
  const record: ReviewReproducibility = {
    prompt_version: r.prompt_version as string,
    models,
    input_digest: r.input_digest as string,
    resolver_version: r.resolver_version as string | null,
    enrichment_source: r.enrichment_source as string | null,
  };
  if (v3) {
    if (typeof r.license_matcher !== "string" || !LICENSE_MATCHER_RE.test(r.license_matcher)) {
      badRecord();
    }
    record.license_matcher = r.license_matcher as string;
  }
  return record;
}

/**
 * The findings only the platform files, decided from the evidence: `source_credit_missing` when an
 * upstream source's license asks for attribution and `dataset_description.json` declares no source
 * in `SourceDatasets`.
 */
export function platformFindingsOf(evidence: PublicationReviewEvidence): PublicationFinding[] {
  const l = evidence.lineage;
  if (l === null || l.outcome !== "compatible_attribution" || l.credited) return [];
  return [
    {
      question: "authors_and_license",
      severity: "concern",
      code: "source_credit_missing",
      document: "dataset_description",
      note: PLATFORM_FINDING_NOTE.source_credit_missing,
    },
  ];
}

/** Whether the note was shown to the model, so that its question was asked. */
function noteShown(evidence: PublicationReviewEvidence): boolean {
  const s = evidence.inputs?.resubmission_note;
  return s === "sent" || s === "sent_cut";
}

/**
 * Validate a report. Accepts only the keys declared above, only members of the closed sets, and
 * only an evidence block {@link parsePublicationReviewEvidence} accepts. Free text (`note`,
 * `summary`) is not refused for its content, it is sanitized: a model's wording is not a reason to
 * lose the review.
 *
 * The report must agree with itself, in the safe direction only (as ADR 0092's report does): a
 * finding coded `steering_attempt` sets `steering`; a question passed with a blocker against it
 * becomes `unknown`; a failed question with no finding gets one `other` finding, made room for by
 * dropping the model's LAST findings (never the first finding of another failed question), so a
 * fail always has something for a person to read, and parsing a parsed report changes nothing.
 *
 * `options.models` is for the offline calibration only, and is still limited to
 * {@link CALIBRATION_MODELS}; the Worker passes nothing.
 */
export function parsePublicationReviewReport(
  raw: unknown,
  options: { models?: readonly ReviewerModel[] } = {},
): PublicationReviewReport {
  if (!isRecord(raw)) throw new PublicationReviewReportError("not_an_object");
  const v1Keys = hasExactKeys(raw, REPORT_KEYS);
  if (!v1Keys && !hasExactKeys(raw, REPORT_V2_KEYS)) {
    throw new PublicationReviewReportError("unknown_key");
  }
  const versions: readonly unknown[] = PUBLICATION_REPORT_VERSIONS;
  if (!versions.includes(raw.v)) throw new PublicationReviewReportError("bad_version");
  const v = raw.v as PublicationReportVersion;
  // A version-2 or version-3 report carries the fifth answer and the record; a version-1 one
  // carries neither, or (read back after a store) carries them as `not_asked` and null.
  if (v !== 1 && v1Keys) throw new PublicationReviewReportError("unknown_key");
  const models = options.models ?? PUBLICATION_REVIEW_MODELS;
  if (!isOneOf(models, raw.model) || !isOneOf(CALIBRATION_MODELS, raw.model)) {
    throw new PublicationReviewReportError("bad_model");
  }
  const rawQuestions = raw.questions;
  if (!isRecord(rawQuestions) || !hasExactKeys(rawQuestions, QUESTIONS)) {
    throw new PublicationReviewReportError("bad_questions");
  }
  const questions = {} as Record<Question, Answer>;
  for (const q of QUESTIONS) {
    const a = rawQuestions[q];
    if (!isOneOf(ANSWERS, a)) throw new PublicationReviewReportError("bad_questions");
    questions[q] = a;
  }
  if (!Array.isArray(raw.findings) || raw.findings.length > MAX_PUBLICATION_FINDINGS) {
    throw new PublicationReviewReportError("bad_findings");
  }
  // The platform's findings are decided below from the evidence; whatever the report held under
  // their codes, the model's or a stored copy of the platform's own, is set aside here.
  const findings = raw.findings
    .map(parseFinding)
    .filter((f) => !PLATFORM_FINDING_CODES.includes(f.code));
  if (typeof raw.summary !== "string") throw new PublicationReviewReportError("bad_summary");
  if (typeof raw.steering !== "boolean") throw new PublicationReviewReportError("bad_steering");
  const evidence = parsePublicationReviewEvidence(raw.evidence);
  // A version-2 or version-3 report is about the widened inputs, and a version-1 report never saw
  // them; only a version-3 report carries the LICENSE identification, and it always does.
  if ((v !== 1) !== (evidence.inputs !== null)) badEvidence();
  if ((v === 3) !== (evidence.license_file !== undefined)) badEvidence();

  let note_answer: NoteAnswer = "not_asked";
  let record: ReviewReproducibility | null = null;
  if (v !== 1) {
    if (!isOneOf(NOTE_ANSWERS, raw.note_answer)) {
      throw new PublicationReviewReportError("bad_note_answer");
    }
    // Asked exactly when a note was shown. An answer about a note that was not shown is dropped
    // (nothing was asked); a note that was shown and not answered is unknown, never a pass.
    note_answer = !noteShown(evidence)
      ? "not_asked"
      : raw.note_answer === "not_asked"
        ? "unknown"
        : raw.note_answer;
    record = parseRecord(raw.record, raw.model, v === 3);
    // A file the matcher identified, or failed to, was scanned, so the matcher ran (ADR 0142):
    // `unavailable` is only ever beside `unreadable`, `absent` or `annexed`.
    const scanned = evidence.license_file?.state;
    if (
      record.license_matcher === "unavailable" &&
      (scanned === "matches" || scanned === "matches_other" || scanned === "unrecognized")
    ) {
      badRecord();
    }
  } else if (!v1Keys && (raw.note_answer !== "not_asked" || raw.record !== null)) {
    throw new PublicationReviewReportError("unknown_key");
  }

  // Both coerce toward "needs a person"; neither can raise anything.
  const steering = raw.steering || findings.some((f) => f.code === "steering_attempt");
  for (const f of findings) {
    if (f.severity === "blocker" && questions[f.question] === "pass") {
      questions[f.question] = "unknown";
    }
  }
  const unexplained = QUESTIONS.filter(
    (q) => questions[q] === "fail" && !findings.some((f) => f.question === q),
  );
  const platform = platformFindingsOf(evidence);
  // Make room for one filler per unexplained question, and for the platform's own findings, by
  // dropping the model's LAST findings, but never the one finding that explains another failed
  // question: the first of each stays. Cutting blindly from the end could take it, leaving that
  // question failed with nothing to read, and then a re-parse (every read of a stored report) would
  // move the same hole to another question. At most four questions fail, the platform files at most
  // one finding, and the list holds eight, so there is always room.
  const explains = new Set<PublicationFinding>();
  for (const q of QUESTIONS) {
    const first = findings.find((f) => f.question === q);
    if (questions[q] === "fail" && first !== undefined) explains.add(first);
  }
  for (
    let i = findings.length - 1;
    i >= 0 && findings.length + unexplained.length + platform.length > MAX_PUBLICATION_FINDINGS;
    i--
  ) {
    if (!explains.has(findings[i])) findings.splice(i, 1);
  }
  for (const q of unexplained) {
    findings.push({
      question: q,
      severity: "blocker",
      code: "other",
      document: null,
      note: "No detail given.",
    });
  }
  findings.push(...platform);

  const report: PublicationReportShape = {
    v,
    model: raw.model,
    questions,
    findings,
    summary: sanitizeNote(raw.summary, PUBLICATION_SUMMARY_MAX),
    steering,
    evidence,
    note_answer,
    record,
  };
  return report as PublicationReviewReport;
}

// ---------------------------------------------------------------------------------------------
// Facts lower answers, never raise them
// ---------------------------------------------------------------------------------------------

/**
 * The facts that can lower an answer, each a closed word (two of them share the finding code
 * `evidence_incomplete`, which is why the finding code alone does not say which fact it was).
 */
export const QUESTION_FACTS = [
  "readme_absent",
  "text_not_seen_in_full",
  "no_recordings",
  "license_field_missing",
  "name_too_short",
  "placeholder_author",
  "license_file_differs",
] as const;
export type QuestionFactWord = (typeof QUESTION_FACTS)[number];

/**
 * What each fact says, in the words every surface shows beside the question it lowered. Written
 * so that it reads after the name of a question and never claims the reviewer said anything: a
 * fact is the platform's, and the model may have passed the question.
 */
export const QUESTION_FACT_TEXT: Record<QuestionFactWord, string> = {
  readme_absent: "no README was found at the dataset root",
  text_not_seen_in_full: "the reviewer was not shown all of the text this question needs",
  no_recordings: "the dataset's structure shows no recordings",
  license_field_missing: "dataset_description.json sets no License",
  name_too_short: `the Name in dataset_description.json is shorter than ${MIN_NAME_LENGTH} characters`,
  placeholder_author: "Authors names a placeholder instead of a person",
  license_file_differs:
    "the LICENSE file identifies a different license from the License in dataset_description.json",
};

/** A fact from the evidence that moved a question away from what the model said. */
export interface QuestionFact {
  question: Question;
  /** The finding code a fact of this kind would carry. */
  code: PublicationFindingCode;
  /** Which fact it was. */
  fact: QuestionFactWord;
  /** What the fact made of the question. */
  result: "fail" | "unknown";
}

const ANSWER_RANK: Record<Answer, number> = { pass: 2, unknown: 1, fail: 0 };

/**
 * The answers after the evidence has had its say, and the facts that moved them.
 *
 *  - No README of any form: `complete_and_honest` fails. An annexed README is
 *    `withheld_annexed`, never `absent`, so it is never judged a stub.
 *  - A document a question needs ({@link QUESTION_NEEDS}) was cut or withheld: that question is at
 *    best unknown, because the model did not see what it was asked about.
 *  - The summary counts no recordings: `complete_and_honest` is at best unknown.
 *  - No `License` in the description: `authors_and_license` fails.
 *  - A `Name` shorter than ADR 0026's floor: `name_adequate` fails.
 *  - A placeholder author on a NAMED release: `authors_and_license` fails. For an anonymous
 *    release the Authors half is answered by ADR 0065's inverted rule, which is a minimum.
 *  - A version-3 LICENSE identified as another license than the `License` field
 *    (`license_file.state` `matches_other`): `authors_and_license` is at best unknown, never a
 *    fail (ADR 0142). A `matches` LICENSE is seen when its leftover was: the license document is
 *    the leftover then, so the rule for a cut or withheld document above is the whole rule, and
 *    the parser refuses additions beside an absent document. Every other identification
 *    keeps ADR 0102's rule through the document's state.
 *
 * `notes` lists only the facts that moved an answer, so a question the model itself failed has no
 * note. Every surface that explains a failed or unknown question reads them
 * ({@link factNotesOf}, and the detail of {@link reasonLine}).
 */
export function answersOf(report: PublicationReviewReport): {
  answers: Record<Question, Answer>;
  notes: QuestionFact[];
} {
  const answers = { ...report.questions };
  const notes: QuestionFact[] = [];
  const lower = (
    question: Question,
    fact: QuestionFactWord,
    code: PublicationFindingCode,
    to: "fail" | "unknown",
  ) => {
    // Only ever lower: a fail stays a fail, and unknown never replaces a fail.
    if (ANSWER_RANK[to] < ANSWER_RANK[answers[question]]) {
      answers[question] = to;
      notes.push({ question, code, fact, result: to });
    }
  };
  const e = report.evidence;
  if (e.documents.readme === "absent") {
    lower("complete_and_honest", "readme_absent", "readme_missing_or_stub", "fail");
  }
  for (const q of QUESTIONS) {
    const s = QUESTION_NEEDS[q].map((d) => e.documents[d]);
    if (s.some((state) => state === "sent_cut" || isWithheld(state))) {
      lower(q, "text_not_seen_in_full", "evidence_incomplete", "unknown");
    }
  }
  if (e.summary.recordings === 0) {
    lower("complete_and_honest", "no_recordings", "evidence_incomplete", "unknown");
  }
  if (!e.license_field) {
    lower("authors_and_license", "license_field_missing", "license_missing", "fail");
  }
  if (e.name_length < MIN_NAME_LENGTH) {
    lower("name_adequate", "name_too_short", "name_not_descriptive", "fail");
  }
  if (!e.anonymous && e.placeholder_authors > 0) {
    lower("authors_and_license", "placeholder_author", "authors_placeholder", "fail");
  }
  if (e.license_file?.state === "matches_other") {
    lower("authors_and_license", "license_file_differs", "license_inconsistent", "unknown");
  }
  return { answers, notes };
}

/** One fact that lowered an answer, with its sentence, as the detail view shows it. */
export interface QuestionFactNote {
  question: Question;
  fact: QuestionFactWord;
  result: "fail" | "unknown";
  text: string;
}

/** The facts that lowered an answer, each with the shared sentence for it. */
export function factNotesOf(report: PublicationReviewReport): QuestionFactNote[] {
  return answersOf(report).notes.map(({ question, fact, result }) => ({
    question,
    fact,
    result,
    text: QUESTION_FACT_TEXT[fact],
  }));
}

// ---------------------------------------------------------------------------------------------
// Rows, run errors and outcomes
// ---------------------------------------------------------------------------------------------

/** A stored review's lifecycle. Kept equal to the CHECK in migration 0098 by a test. */
export const PUBLICATION_REVIEW_STATES = [
  "dispatched",
  "reported",
  "declined",
  "errored",
  "unreported",
] as const;
export type PublicationReviewState = (typeof PUBLICATION_REVIEW_STATES)[number];

/** Which cap declined a review. Both read as `review_limit_reached`; the word says whether a start can help. */
export const PUBLICATION_DECLINE_DETAILS = ["depositor_limit", "platform_limit"] as const;
export type PublicationDeclineDetail = (typeof PUBLICATION_DECLINE_DETAILS)[number];

/** Why a review ended without a report. Some are the Worker's own words ({@link WORKER_ONLY_RUN_ERRORS}). */
export const PUBLICATION_RUN_ERRORS = [
  "evidence_unavailable",
  "stale_head",
  "auth_failed",
  "model_unavailable",
  "model_refused",
  "model_truncated",
  "model_invalid",
  "report_invalid",
  "dispatch_failed",
  "dispatch_unconfigured",
  "review_disabled",
  "workflow_failed",
  "inputs_unavailable",
] as const;
export type PublicationRunError = (typeof PUBLICATION_RUN_ERRORS)[number];

/** Words only the Worker writes; a job that posts one is recorded as `workflow_failed`. */
export const WORKER_ONLY_RUN_ERRORS = [
  "dispatch_failed",
  "dispatch_unconfigured",
  "review_disabled",
] as const satisfies readonly PublicationRunError[];

/** Attempts that never reached a model: not counted against a cap, restarted by a new screen result. */
export const NEVER_REACHED_MODEL = [
  "stale_head",
  // The job could not read its inputs; it calls the model only after they are read.
  "inputs_unavailable",
  "dispatch_failed",
  "dispatch_unconfigured",
  "review_disabled",
] as const satisfies readonly PublicationRunError[];

/** What a request's review comes to. There is no neutral outcome. */
export const PUBLICATION_OUTCOMES = ["pass", "fail", "action_required"] as const;
export type PublicationOutcome = (typeof PUBLICATION_OUTCOMES)[number];

export function isPublicationReviewState(x: unknown): x is PublicationReviewState {
  return isOneOf(PUBLICATION_REVIEW_STATES, x);
}
export function isPublicationRunError(x: unknown): x is PublicationRunError {
  return isOneOf(PUBLICATION_RUN_ERRORS, x);
}
export function isPublicationDeclineDetail(x: unknown): x is PublicationDeclineDetail {
  return isOneOf(PUBLICATION_DECLINE_DETAILS, x);
}
export function isPublicationOutcome(x: unknown): x is PublicationOutcome {
  return isOneOf(PUBLICATION_OUTCOMES, x);
}

// ---------------------------------------------------------------------------------------------
// Reasons: one table, the words every surface shows
// ---------------------------------------------------------------------------------------------

/**
 * Every reason a request is not a pass, in the order surfaces list them. Three groups, in this order:
 *
 *  1. What nothing clears (the hard reasons): `request_blocked`, `submission_minimum_failed` and
 *     `identifier_screen_blocks` (fail), then the screen's own gaps (`identifier_screen_not_run`,
 *     `identifier_screen_pending`, `identifier_screen_stale`, unknown), then
 *     `version_kept_after_anonymous_release` (fail). The last one is hard but sits after the
 *     screen's gaps because it is about the release, not the request or the screen.
 *  2. The screen's acknowledgment reason, which a recorded acknowledgment clears.
 *  3. What an administrator's override clears, fail class before unknown class.
 *
 * A test pins the exact order, so a new code is placed on purpose.
 */
export const REASON_CODES = [
  "request_blocked",
  "submission_minimum_failed",
  "identifier_screen_blocks",
  "identifier_screen_not_run",
  "identifier_screen_pending",
  "identifier_screen_stale",
  "version_kept_after_anonymous_release",
  "identifier_screen_needs_acknowledgment",
  "question_failed",
  "steering_attempt",
  "bids_failed_at_review",
  "version_already_released",
  "version_malformed",
  "stored_verdict_fail",
  "review_not_started",
  "review_running",
  "review_did_not_report",
  "review_limit_reached",
  "review_could_not_run",
  "text_withheld",
  "question_unknown",
  "license_lineage_unconfirmed",
  "resubmission_note_unaddressed",
  "bids_unconcluded_at_review",
  "version_missing",
  "doi_state_unexpected",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface ReasonRule {
  /** `fail` makes the outcome fail; `unknown` makes it action_required. */
  class: "fail" | "unknown";
  /**
   * What clears it. `nothing`: the approval is refused and the cure names who acts (hard).
   * `screen_acknowledgment`: ADR 0086's recorded acknowledgment. `override`: the administrator's
   * recorded override.
   */
  clearedBy: "nothing" | "screen_acknowledgment" | "override";
  /** What is wrong, in fixed words. */
  sentence: string;
  /**
   * What clears it, as a terminal prints it: the CLI's lines, the email and the gate's refusal
   * message. A web page never prints this ({@link neutralCureOf} is its text). May contain
   * `<dataset>`, which {@link describePublicationReview} fills.
   */
  cure: string;
  /**
   * The command the cure names, `<dataset>` for the id; absent when it names none. It sits in
   * `cure` as `: <command>` right after the first clause, and {@link neutralCureOf} removes exactly
   * that. The `(--force)` of the override sentence is the other terminal-only part and needs no
   * field: `clearedBy: "override"` says it.
   */
  command?: string;
  /**
   * What is true instead of `cure` when an administrator's `start` would be refused, because the
   * request is not waiting for its decision (`POST .../review/start` answers 409
   * `request_not_requested`). Present exactly on the reasons whose cure is "start it", so a
   * request that is being approved or is blocked is never sent to a command that cannot work.
   */
  cureNotStartable?: string;
}

const FORCE_FLAG = " (--force)";
const OVERRIDE = `An administrator may approve over it; the approval records the override${FORCE_FLAG}.`;
/** The override sentence for a reader with no terminal: the flag is a terminal's alone. */
const OVERRIDE_NEUTRAL = OVERRIDE.replace(FORCE_FLAG, "");

/** What a start cure says for a request no start can reach (see {@link ReasonRule.cureNotStartable}). */
const NOT_STARTABLE = `A review starts only for a request that is waiting for its decision. ${OVERRIDE}`;

// The commands the cures, the gate's refusal sentences, the stopped-approval line and `next`
// (nextCommand) name. One spelling each, `<dataset>` for the id, filled by `fill`. What stays
// spelled where it is used: the `--resume` and `--force` that `nextCommand` appends because the
// state asks for them, and the `--force` of the gate's own sentences, which are prose about a flag
// rather than a command to run. `COMMAND_ACKNOWLEDGE` is `next` only when neither of those two is
// appended, so the one is not a prefix check of the other.
const COMMAND_SCREEN = "nemar admin dataset publish screen <dataset>";
const COMMAND_START = "nemar admin dataset publish start <dataset>";
const COMMAND_SHOW = "nemar admin dataset publish show <dataset>";
const COMMAND_APPROVE = "nemar admin dataset publish approve <dataset>";
const COMMAND_DENY = "nemar admin dataset publish deny <dataset>";
const COMMAND_LINEAGE = "nemar admin dataset publish license-lineage <dataset>";
const ACKNOWLEDGE_FLAG = '--acknowledge-identifier-screen "<reason>"';
const COMMAND_ACKNOWLEDGE = `${COMMAND_APPROVE} ${ACKNOWLEDGE_FLAG}`;

/** A command or sentence with its `<dataset>` filled; the caller passes an id already validated. */
function fill(template: string, datasetId: string): string {
  return template.replaceAll("<dataset>", datasetId);
}

/** The reasons table (ADR 0102, section 5). A `Record`, so a code without a rule fails the build. */
export const REASONS: Record<ReasonCode, ReasonRule> = {
  request_blocked: {
    class: "fail",
    clearedBy: "nothing",
    sentence: "The request is blocked.",
    cure: "The depositor fixes what blocked it and requests publication again.",
  },
  submission_minimum_failed: {
    class: "fail",
    clearedBy: "nothing",
    sentence: "A submission minimum failed at the reviewed commit.",
    cure: "The depositor fixes the dataset and requests publication again; a request still waiting for its decision is moved to blocked.",
  },
  identifier_screen_blocks: {
    class: "fail",
    clearedBy: "nothing",
    sentence: "The identifier screen found a direct identifier.",
    cure: "The depositor removes it and requests publication again, which runs the screen again.",
  },
  identifier_screen_not_run: {
    class: "unknown",
    clearedBy: "nothing",
    sentence: "The identifier screen has no verdict about the current commit.",
    cure: `An administrator runs the screen again: ${COMMAND_SCREEN}.`,
    command: COMMAND_SCREEN,
  },
  identifier_screen_pending: {
    class: "unknown",
    clearedBy: "nothing",
    sentence: "The identifier screen is still running.",
    cure: "Wait for it to report; the review starts when it does.",
  },
  identifier_screen_stale: {
    class: "unknown",
    clearedBy: "nothing",
    sentence: "The identifier screen read a commit that is no longer the head of main.",
    cure: `An administrator runs the screen again: ${COMMAND_SCREEN}.`,
    command: COMMAND_SCREEN,
  },
  version_kept_after_anonymous_release: {
    class: "fail",
    clearedBy: "nothing",
    sentence:
      "This named publication keeps the version that an earlier anonymous release of the dataset used.",
    cure: "The depositor raises Version in dataset_description.json and requests publication again.",
  },
  identifier_screen_needs_acknowledgment: {
    class: "unknown",
    clearedBy: "screen_acknowledgment",
    sentence:
      "The identifier screen found something a person must look at, or could not read everything.",
    cure: `An administrator reads what the screen reported and approves with a recorded reason: ${COMMAND_ACKNOWLEDGE}.`,
    command: COMMAND_ACKNOWLEDGE,
  },
  question_failed: {
    class: "fail",
    clearedBy: "override",
    // Neutral about who failed it: the reviewer's own answer, or a fact of the dataset that lowered
    // the reviewer's answer (`answersOf`). The detail in parentheses says which.
    sentence: "A question of the review failed.",
    cure: `Read any findings and the dataset's text. ${OVERRIDE}`,
  },
  steering_attempt: {
    class: "fail",
    clearedBy: "override",
    sentence: "Text in the dataset tried to instruct the reviewer.",
    cure: `Read the dataset's text yourself; the review's answers cannot be relied on. ${OVERRIDE}`,
  },
  bids_failed_at_review: {
    class: "fail",
    clearedBy: "override",
    sentence: "BIDS validation failed at the reviewed commit.",
    cure: `The depositor fixes the validation errors and requests publication again. ${OVERRIDE}`,
  },
  version_already_released: {
    class: "fail",
    clearedBy: "override",
    sentence:
      "This version was already released: NEMAR has a release of it, or its tag names another commit.",
    cure: `The depositor raises Version in dataset_description.json. ${OVERRIDE}`,
  },
  version_malformed: {
    class: "fail",
    clearedBy: "override",
    sentence: "Version in dataset_description.json is not of the form X.Y.Z.",
    cure: `The depositor corrects Version. ${OVERRIDE}`,
  },
  stored_verdict_fail: {
    class: "fail",
    clearedBy: "override",
    sentence: "The stored review concluded fail, and its report no longer shows why.",
    cure: `Read the review's record: ${COMMAND_SHOW}. ${OVERRIDE}`,
    command: COMMAND_SHOW,
  },
  review_not_started: {
    class: "unknown",
    clearedBy: "override",
    sentence: "No review of the screened commit has started.",
    cure: `Start it: ${COMMAND_START}. ${OVERRIDE}`,
    command: COMMAND_START,
    cureNotStartable: NOT_STARTABLE,
  },
  review_running: {
    class: "unknown",
    clearedBy: "override",
    sentence: "The review is running.",
    cure: `Wait for it to report; it usually takes minutes. ${OVERRIDE}`,
  },
  review_did_not_report: {
    class: "unknown",
    clearedBy: "override",
    sentence: "The review did not report in time.",
    cure: `Start it again: ${COMMAND_START}. ${OVERRIDE}`,
    command: COMMAND_START,
    cureNotStartable: NOT_STARTABLE,
  },
  review_limit_reached: {
    class: "unknown",
    clearedBy: "override",
    sentence: "The daily limit of automated reviews was reached.",
    cure: `Start it later: ${COMMAND_START}; an administrator's start is held by the platform's limit only. ${OVERRIDE}`,
    command: COMMAND_START,
    cureNotStartable: NOT_STARTABLE,
  },
  review_could_not_run: {
    class: "unknown",
    clearedBy: "override",
    sentence: "The review could not run.",
    cure: `Once the cause is fixed, start it again: ${COMMAND_START}. ${OVERRIDE}`,
    command: COMMAND_START,
    cureNotStartable: NOT_STARTABLE,
  },
  text_withheld: {
    class: "unknown",
    clearedBy: "override",
    sentence: "Some of the dataset's text was withheld from the reviewer.",
    cure: `Read the withheld documents yourself. ${OVERRIDE}`,
  },
  question_unknown: {
    class: "unknown",
    clearedBy: "override",
    sentence: "A question of the review could not be answered.",
    cure: `Answer it yourself from the dataset. ${OVERRIDE}`,
  },
  // ADR 0139, decision 7 (amended 2026-11-25): every lineage outcome that needs action is this one
  // reason, of the unknown class, so it never fails a request and never denies one automatically.
  license_lineage_unconfirmed: {
    class: "unknown",
    clearedBy: "override",
    sentence:
      "The license of an upstream source of this dataset could not be confirmed as allowing this release.",
    cure: `Read the license lineage: ${COMMAND_LINEAGE}. The depositor sends the original authors' evidence to ${LICENSE_EVIDENCE_ADDRESS} and an administrator records it against the request, which clears this reason; or the depositor corrects License in dataset_description.json. ${OVERRIDE}`,
    command: COMMAND_LINEAGE,
  },
  // ADR 0139, decision 5: the note's answer can only ask for a person, never fail or pass a request.
  resubmission_note_unaddressed: {
    class: "unknown",
    clearedBy: "override",
    sentence:
      "The reviewer could not confirm that the depositor's resubmission note addresses why the previous request was denied.",
    cure: `Read the note and the previous denial yourself. ${OVERRIDE}`,
  },
  bids_unconcluded_at_review: {
    class: "unknown",
    clearedBy: "override",
    sentence: "BIDS validation had not concluded at the reviewed commit.",
    cure: `Check the validation run of that commit. ${OVERRIDE}`,
  },
  version_missing: {
    class: "unknown",
    clearedBy: "override",
    sentence: "dataset_description.json sets no Version, so the publication would be 1.0.0.",
    cure: `Confirm that 1.0.0 is right, or have the depositor set Version. ${OVERRIDE}`,
  },
  doi_state_unexpected: {
    class: "unknown",
    clearedBy: "override",
    sentence: "The dataset already has a concept DOI that no earlier anonymous release reserved.",
    cure: `Check the DOI record before approving. ${OVERRIDE}`,
  },
};

/** The reasons nothing clears: the approval is refused and the cure names who acts. */
export const HARD_REASONS: readonly ReasonCode[] = REASON_CODES.filter(
  (c) => REASONS[c].clearedBy === "nothing",
);

/**
 * The reasons an administrator's override clears (`clearedBy: "override"`), in {@link REASON_CODES}
 * order. Every reason is exactly one of three: hard (nothing clears it), the screen's own
 * acknowledgment reason (the screen's recorded acknowledgment clears it, and the screen gate, not
 * the override, enforces that), or one of these.
 */
export const OVERRIDE_REASONS: readonly ReasonCode[] = REASON_CODES.filter(
  (c) => REASONS[c].clearedBy === "override",
);

/** The hard reasons among `reasons` (`clearedBy: "nothing"`), as given and in their order. */
export function hardReasonsOf<T extends { code: ReasonCode }>(reasons: readonly T[]): T[] {
  return reasons.filter((r) => REASONS[r.code].clearedBy === "nothing");
}

/**
 * The override-class reasons among `reasons` (`clearedBy: "override"`), as given and in their
 * order: the reasons an administrator's override has to name. The one predicate behind
 * {@link uncoveredByOverride}, `nextCommand`'s `--force` and the approval gate.
 */
export function overrideClassReasonsOf<T extends { code: ReasonCode }>(reasons: readonly T[]): T[] {
  return reasons.filter((r) => REASONS[r.code].clearedBy === "override");
}

/**
 * The override-class codes among `reasons` that `given` does not name, each once, in
 * {@link REASON_CODES} order whatever the order of either argument. Hard and acknowledgment
 * reasons are never in the result: an override cannot clear them, so they are not its to cover
 * (whether one stands is {@link hardReasonsOf}'s question, and the screen gate's). Words in `given`
 * that are not reason codes are ignored. One function for the Worker's gate and the command-line
 * interface's early refusal, so the two cannot disagree about what an override covers.
 */
export function uncoveredByOverride(
  reasons: readonly { code: ReasonCode }[],
  given: readonly string[],
): ReasonCode[] {
  const named = new Set<string>(given);
  const needed = new Set<ReasonCode>(overrideClassReasonsOf(reasons).map((r) => r.code));
  return REASON_CODES.filter((c) => needed.has(c) && !named.has(c));
}

/** The reasons whose cure is an administrator's `start`: the ones with a {@link ReasonRule.cureNotStartable}. */
export const START_CURE_REASONS: readonly ReasonCode[] = REASON_CODES.filter(
  (c) => REASONS[c].cureNotStartable !== undefined,
);

/**
 * The cure template in force: what is true for a request no `start` can reach when `startable` is
 * false and the rule has one, the rule's own cure otherwise. `alternative` says which.
 */
function cureTemplate(
  rule: ReasonRule,
  startable: boolean,
): { text: string; alternative: boolean } {
  const alternative = !startable && rule.cureNotStartable !== undefined;
  return { text: alternative ? (rule.cureNotStartable as string) : rule.cure, alternative };
}

/** The id a cure quotes: a malformed id is never quoted, `<dataset>` stays. */
function quotedId(datasetId: string): string {
  return DATASET_ID.test(datasetId) ? datasetId : "<dataset>";
}

/**
 * The cure of a reason for this dataset, as a terminal prints it: `<dataset>` filled (a malformed
 * id is never quoted), and, when `startable` is false, what is true for a request no `start` can
 * reach. One function for the lines every surface prints, so they cannot differ. A web page prints
 * {@link neutralCureOf} instead.
 */
export function cureOf(code: ReasonCode, datasetId: string, startable: boolean): string {
  return fill(cureTemplate(REASONS[code], startable).text, quotedId(datasetId));
}

/**
 * The cure for a reader with no terminal: {@link cureOf} without its command and without the
 * override flag. A complete sentence, or two.
 *
 * The choice of "start it" is made from `startable` alone, the request waiting for its decision,
 * never from the detail's `start_offered`. That is intended: the cure is a pure function of the
 * reason and the request's standing, and `start_offered` (which also needs a restartable row, no
 * hard reason standing, and a screen that is clear or acknowledged with a head) is the one
 * authoritative answer a page uses to draw the Start control. So a detail can say "start it" while
 * `start_offered` is false: beside any standing hard reason (the commonest case, for example
 * `review_not_started` beside `submission_minimum_failed` or `identifier_screen_pending`), for a
 * request whose stored report no longer parses, a sandbox request, or a screen with no head.
 */
export function neutralCureOf(code: ReasonCode, datasetId: string, startable: boolean): string {
  const rule = REASONS[code];
  const { text, alternative } = cureTemplate(rule, startable);
  const withoutCommand =
    !alternative && rule.command !== undefined ? text.replace(`: ${rule.command}`, "") : text;
  return fill(withoutCommand.replace(OVERRIDE, OVERRIDE_NEUTRAL), quotedId(datasetId));
}

/**
 * The command the terminal's cure names, the id filled; null when the cure in force names none
 * (the alternative a start cannot reach names none).
 * Like {@link neutralCureOf}, it decides from `startable` alone (see there).
 */
export function commandOf(code: ReasonCode, datasetId: string, startable: boolean): string | null {
  const rule = REASONS[code];
  if (rule.command === undefined || cureTemplate(rule, startable).alternative) return null;
  return fill(rule.command, quotedId(datasetId));
}

export interface Reason {
  code: ReasonCode;
  /**
   * One closed word, or a list of them joined by ",": a {@link Question}, a {@link PublicationRunError},
   * a {@link PublicationDeclineDetail}, the {@link ReviewDocument}s withheld, the
   * `MinimumFailure`s, or the request's block reason. Null when the code says it all.
   */
  detail: string | null;
}

/** De-duplicate, and order by {@link REASON_CODES}; within one code, the order they were found. */
function normalize(reasons: readonly Reason[]): Reason[] {
  const seen = new Set<string>();
  const unique = reasons.filter((r) => {
    const key = `${r.code}\u0000${r.detail ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique
    .map((r, i) => ({ r, i, rank: REASON_CODES.indexOf(r.code) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ r }) => r);
}

/**
 * The reasons a report gives by itself, with no live fact. The stored verdict is derived from
 * these alone ({@link verdictOf}), so the stored column never depends on a fact that can change.
 */
export function reportReasons(report: PublicationReviewReport): Reason[] {
  const out: Reason[] = [];
  const add = (code: ReasonCode, detail: string | null = null) => out.push({ code, detail });
  const { answers } = answersOf(report);
  const e = report.evidence;
  if (e.minimums === "failed") add("submission_minimum_failed", e.minimum_failures.join(","));
  for (const q of QUESTIONS) if (answers[q] === "fail") add("question_failed", q);
  if (report.steering) add("steering_attempt");
  if (e.bids === "fail") add("bids_failed_at_review");
  if (e.tag === "elsewhere") add("version_already_released");
  if (e.version_shape === "malformed") add("version_malformed");
  const withheld: string[] = REVIEW_DOCUMENTS.filter((d) => isWithheld(e.documents[d]));
  const inputs = e.inputs;
  if (inputs !== null) withheld.push(...REVIEW_INPUTS.filter((i) => isWithheld(inputs[i])));
  if (withheld.length > 0) add("text_withheld", withheld.join(","));
  for (const q of QUESTIONS) if (answers[q] === "unknown") add("question_unknown", q);
  if (e.lineage !== null && LINEAGE_UNCONFIRMED_OUTCOMES.includes(e.lineage.outcome)) {
    add("license_lineage_unconfirmed", e.lineage.outcome);
  }
  // Fail and unknown alike ask for a person; a pass adds nothing, so a note never raises a verdict.
  if (report.note_answer === "fail" || report.note_answer === "unknown") {
    add("resubmission_note_unaddressed", report.note_answer);
  }
  if (e.bids === "unconcluded" || e.bids === "unknown") add("bids_unconcluded_at_review");
  if (e.version_shape === "missing") add("version_missing");
  return normalize(out);
}

/** The live facts of a request, read now by the Worker; never from the report. */
export interface LiveFacts {
  request: {
    status: string;
    /** The request's block reason when it is blocked. Shown only when it is a plain lowercase word. */
    block_reason: string | null;
    anonymous: boolean;
  };
  screen: {
    /** `screenGate` of the stored state, or `exempt` for a dataset the screen does not apply to. */
    gate: ScreenGate | "exempt";
    /** The screened commit (`readStoredReport(...)?.head`), or null when there is none. */
    head: string | null;
    acknowledged_by: number | null;
    /**
     * Whether the screened commit is still `main`. Null for every caller of the derivation (the
     * detail, the list, the mail and the review's gate read no GitHub), so `identifier_screen_stale`
     * is not derived there; the stale refusal comes from the identifier screen's own gate.
     */
    head_current: boolean | null;
  };
  versions: {
    /**
     * A `dataset_versions` row exists for the version an approval would publish
     * ({@link effectiveVersionOf}: the review in force's Version, or 1.0.0 when it sets none).
     * False when that review has no version to look up (none read, or a malformed one). A boolean,
     * never "unknown": a caller that could not read the table refuses rather than guess.
     */
    version_row_exists: boolean;
    /** An earlier request of this dataset asked for an anonymous release. */
    prior_anonymous_request: boolean;
    /** The dataset has been published under a name (`first_published_at` is set). */
    first_published: boolean;
  };
  doi: {
    concept_doi_present: boolean;
    /** The concept DOI's EZID status (`datasets.ezid_status`). */
    concept_ezid_status: string | null;
  };
  /**
   * A recorded license permission that covers the lineage of the review in force
   * (`permissionCovers`, `shared/license-permission.ts`; ADR 0139 decision 7, amendment of
   * 2026-11-25), or null when none does. It clears `license_lineage_unconfirmed` and no other
   * reason. Who and when only; the evidence text is never part of the facts.
   */
  license_permission: { recorded_at: string; recorded_by: string | null; ticket_id: number } | null;
}

/** The review in force as the reasons need it. `none`: no row of the screened head and flag. */
export type ReviewRowView =
  | { kind: "none" }
  | { kind: "dispatched"; overdue: boolean }
  | { kind: "unreported" }
  | { kind: "declined"; detail: PublicationDeclineDetail }
  | { kind: "errored"; detail: PublicationRunError }
  | {
      kind: "reported";
      /** The stored report re-parsed now; null when it no longer parses. */
      report: PublicationReviewReport | null;
      /** The verdict column. */
      stored: PublicationOutcome;
    };

const BLOCK_REASON_WORD = /^[a-z][a-z_]{0,63}$/;

/**
 * The block reason a surface may show: a blocked request's, and only when it is a plain lowercase
 * word, so a column a person edited by hand is never printed. Null for a request that is not
 * blocked, whatever its column holds. One rule for {@link reasonsOf}'s detail and for the detail
 * view's `block_reason`, so the two cannot show different words.
 */
export function shownBlockReason(request: {
  status: string;
  block_reason: string | null;
}): string | null {
  if (request.status !== "blocked") return null;
  const why = request.block_reason;
  return why !== null && BLOCK_REASON_WORD.test(why) ? why : null;
}

/**
 * Every reason the request is not a pass, re-derived from the live facts and the review in force:
 * de-duplicated, and ordered as {@link REASON_CODES}. It lists everything, and decides nothing about
 * what is cleared: whether a recorded acknowledgment or override satisfies an approval is the gate's.
 *
 * A review that has not reported always yields at least one reason, whatever the request and the
 * screen say, so it is never green. A stored report that no longer parses reads as
 * `review_could_not_run`; when the stored verdict is stricter than its report now shows (a fail
 * with no fail reason, or a non-pass with no reason at all), a reason says so, so the outcome and
 * its reasons cannot disagree.
 */
export function reasonsOf(input: { live: LiveFacts; row: ReviewRowView }): Reason[] {
  const { live, row } = input;
  const out: Reason[] = [];
  const add = (code: ReasonCode, detail: string | null = null) => out.push({ code, detail });

  if (live.request.status === "blocked") add("request_blocked", shownBlockReason(live.request));

  const gate = live.screen.gate;
  if (gate === "blocks") add("identifier_screen_blocks");
  if (gate === "rerun") add("identifier_screen_not_run");
  if (gate === "wait") add("identifier_screen_pending");
  // A verdict about no commit cannot be matched to the content it describes; the approval gate
  // refuses it the same way (`verifyScreenHead`).
  if ((gate === "clear" || gate === "acknowledge") && !HEAD.test(live.screen.head ?? "")) {
    add("identifier_screen_not_run");
  }
  if (live.screen.head_current === false) add("identifier_screen_stale");
  if (gate === "acknowledge") add("identifier_screen_needs_acknowledgment");

  const v = live.versions;
  if (v.version_row_exists) {
    if (!live.request.anonymous && v.prior_anonymous_request && !v.first_published) {
      add("version_kept_after_anonymous_release");
    } else {
      add("version_already_released");
    }
  }
  const reservedByAnonymousRelease =
    v.prior_anonymous_request && live.doi.concept_ezid_status === "reserved";
  if (live.doi.concept_doi_present && !reservedByAnonymousRelease) add("doi_state_unexpected");

  switch (row.kind) {
    case "none":
      // No review exists to wait for. A screen that blocks, waits or has no verdict already
      // gave its reason; otherwise the missing review is the reason.
      if (gate === "clear" || gate === "acknowledge" || gate === "exempt") {
        add("review_not_started");
      }
      break;
    case "dispatched":
      add(row.overdue ? "review_did_not_report" : "review_running");
      break;
    case "unreported":
      add("review_did_not_report");
      break;
    case "declined":
      add("review_limit_reached", row.detail);
      break;
    case "errored":
      add("review_could_not_run", row.detail);
      break;
    case "reported": {
      if (row.report === null) {
        add("review_could_not_run", "report_invalid");
        if (row.stored === "fail") add("stored_verdict_fail");
        break;
      }
      const own = reportReasons(row.report);
      // A recorded license permission clears the lineage reason, and only that one; the checks
      // below still read the report's own reasons, so a stored verdict is explained as before.
      out.push(...(live.license_permission === null ? own : withoutPermittedLineage(own)));
      if (row.stored === "fail" && !own.some((r) => REASONS[r.code].class === "fail")) {
        add("stored_verdict_fail");
      }
      if (row.stored === "action_required" && own.length === 0) {
        add("review_could_not_run", "report_invalid");
      }
      break;
    }
  }
  return normalize(out);
}

/** The one reason a recorded license permission clears (ADR 0139, decision 7, amendment of 2026-11-25). */
export const PERMISSION_CLEARED_REASON: ReasonCode = "license_lineage_unconfirmed";

/** A report's reasons without the one a recorded license permission clears. */
export function withoutPermittedLineage(reasons: readonly Reason[]): Reason[] {
  return reasons.filter((r) => r.code !== PERMISSION_CLEARED_REASON);
}

/**
 * The stored verdict as a recorded license permission leaves it. The stored column was derived
 * from the report's reasons alone (`verdictOf(reportReasons(report))`); when it still equals that,
 * the column says nothing the reasons do not, so a covering permission derives it again without
 * the lineage reason. A column that disagrees with its report (an older rule, a hand edit) is kept
 * as stored, so a permission never raises what it cannot explain.
 */
export function storedVerdictWithPermission(
  stored: PublicationOutcome,
  report: PublicationReviewReport | null,
  permitted: boolean,
): PublicationOutcome {
  if (!permitted || report === null) return stored;
  const own = reportReasons(report);
  if (verdictOf(own) !== stored) return stored;
  return verdictOf(withoutPermittedLineage(own));
}

/** No reason is a pass; any reason of the fail class is a fail; anything else needs a person. */
export function verdictOf(reasons: readonly Reason[]): PublicationOutcome {
  if (reasons.length === 0) return "pass";
  if (reasons.some((r) => REASONS[r.code]?.class === "fail")) return "fail";
  return "action_required";
}

const OUTCOME_RANK: Record<PublicationOutcome, number> = {
  fail: 0,
  action_required: 1,
  pass: 2,
};

/** The stricter of two outcomes (fail before action_required before pass): either can lower, neither can raise. */
export function stricterOf(a: PublicationOutcome, b: PublicationOutcome): PublicationOutcome {
  return OUTCOME_RANK[a] <= OUTCOME_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

export const QUESTION_LABEL: Record<Question, string> = {
  complete_and_honest: "the README is complete and agrees with the dataset",
  meets_standards: "the submission standards and the ethics and provenance statements are met",
  authors_and_license: "the authors and the license are real and consistent",
  name_adequate: "the name describes the dataset",
};

export const PUBLICATION_FINDING_LABEL: Record<PublicationFindingCode, string> = {
  readme_missing_or_stub: "README missing or a stub",
  readme_mismatch: "README does not match the dataset",
  description_incomplete: "Description incomplete",
  ethics_statement_missing: "Ethics statement missing",
  ethics_statement_inadequate: "Ethics statement inadequate",
  authors_placeholder: "Placeholder authors",
  authors_inconsistent: "Authors inconsistent",
  license_missing: "License missing",
  license_inconsistent: "License inconsistent",
  name_not_descriptive: "Name not descriptive",
  changes_inconsistent: "CHANGES inconsistent",
  provenance_unclear: "Provenance unclear",
  source_license_conflict: "License conflicts with a source",
  evidence_incomplete: "Evidence incomplete",
  steering_attempt: "Text tried to instruct the reviewer",
  other: "Other",
  source_credit_missing: "Upstream source not credited",
};

export const DOCUMENT_LABEL: Record<ReviewDocument, string> = {
  readme: "README",
  dataset_description: "dataset_description.json",
  changes: "CHANGES",
  license: "LICENSE",
  participants_json: "participants.json",
};

/** The widened inputs as every surface names them. */
export const INPUT_LABEL: Record<ReviewInput, string> = {
  enrichment: "the enrichment (.nemar/metadata.json)",
  registry_records: "the upstream registry records",
  lineage: "the license lineage",
  coverage: "the identifier screen's coverage counts",
  resubmission_note: "the resubmission note",
  previous_denial: "the previous denial's reasons",
};

/** A lineage outcome that needs action, as the detail of `license_lineage_unconfirmed` says it. */
export const LINEAGE_OUTCOME_WORDS: Record<LineageOutcome, string> = {
  compatible: "compatible",
  compatible_attribution: "compatible, with attribution",
  compatible_nc: "compatible, non-commercial",
  share_alike_mismatch: "a share-alike source under a different license",
  needs_permission: "a source whose license needs the rights holder's permission",
  redistribution_prohibited: "a source whose license prohibits redistribution",
  source_is_publication: "a source that is a publication, not a dataset",
  no_upstream_declared: "no upstream source declared",
  unresolved: "a source whose license could not be resolved",
};

export const PUBLICATION_RUN_ERROR_TEXT: Record<PublicationRunError, string> = {
  evidence_unavailable: "the dataset could not be read at the reviewed commit",
  stale_head: "the request or its screened commit changed before the review started",
  auth_failed: "the review job could not sign in to the model",
  model_unavailable: "the reviewing model was unavailable",
  model_refused: "the reviewing model declined to review",
  model_truncated: "the reviewing model ran out of room before it finished",
  model_invalid: "the reviewing model did not return a usable answer",
  report_invalid: "the review's report could not be read back",
  dispatch_failed: "GitHub did not start the review job",
  dispatch_unconfigured:
    "the Worker had no GitHub credential or callback secret to start the review",
  review_disabled: "the automated review was off when the job tried to start",
  workflow_failed: "the review job failed before it finished",
  inputs_unavailable:
    "the review job could not read the dataset's metadata inputs from NEMAR, so it reviewed nothing",
};

export const PUBLICATION_DECLINE_TEXT: Record<PublicationDeclineDetail, string> = {
  depositor_limit: "this depositor's daily limit",
  platform_limit: "the platform's daily limit",
};

const OUTCOME_WORD: Record<PublicationOutcome, string> = {
  pass: "pass",
  action_required: "action required",
  fail: "FAIL",
};

const OUTCOME_TONE: Record<PublicationOutcome, "ok" | "warn" | "stop"> = {
  pass: "ok",
  action_required: "warn",
  fail: "stop",
};

/**
 * A detail word as a person reads it; anything unexpected is shown as the closed word it is. A
 * failed or unknown question names the question, then the fact that lowered the answer when a fact
 * did (the model may have passed it), then the model's findings against it.
 */
function detailText(reason: Reason, report: PublicationReviewReport | null): string | null {
  const d = reason.detail;
  if (d === null) return null;
  switch (reason.code) {
    case "question_failed":
    case "question_unknown": {
      if (!isOneOf(QUESTIONS, d)) return d;
      const result = reason.code === "question_failed" ? "fail" : "unknown";
      const parts: string[] = [QUESTION_LABEL[d]];
      if (report !== null) {
        for (const note of factNotesOf(report)) {
          if (note.question === d && note.result === result) parts.push(note.text);
        }
      }
      const codes = (report?.findings ?? [])
        .filter((f) => f.question === d)
        .map((f) => PUBLICATION_FINDING_LABEL[f.code]);
      const unique = [...new Set(codes)];
      if (unique.length > 0) parts.push(`findings: ${unique.join(", ")}`);
      return parts.join("; ");
    }
    case "text_withheld":
      return d
        .split(",")
        .map((doc) =>
          isOneOf(REVIEW_DOCUMENTS, doc)
            ? DOCUMENT_LABEL[doc]
            : isOneOf(REVIEW_INPUTS, doc)
              ? INPUT_LABEL[doc]
              : doc,
        )
        .join(", ");
    case "license_lineage_unconfirmed":
      return isOneOf(LINEAGE_OUTCOMES, d) ? LINEAGE_OUTCOME_WORDS[d] : d;
    case "resubmission_note_unaddressed":
      return d === "fail" ? "the reviewer found it does not" : "the reviewer could not tell";
    case "review_could_not_run":
      return isPublicationRunError(d) ? PUBLICATION_RUN_ERROR_TEXT[d] : d;
    case "review_limit_reached":
      return isPublicationDeclineDetail(d) ? PUBLICATION_DECLINE_TEXT[d] : d;
    default:
      return d.replaceAll(",", ", ");
  }
}

/** What is wrong, with the detail in words: a reason without its cure, so a page can print it. */
export function reasonStatement(reason: Reason, report: PublicationReviewReport | null): string {
  const rule = REASONS[reason.code];
  const detail = detailText(reason, report);
  return detail === null ? rule.sentence : `${rule.sentence.replace(/\.$/, "")} (${detail}).`;
}

/** One line per reason, as a terminal prints it: what is wrong, the detail, and what clears it. */
export function reasonLine(
  reason: Reason,
  datasetId: string,
  report: PublicationReviewReport | null,
  startable: boolean,
): string {
  return `${reasonStatement(reason, report)} ${cureOf(reason.code, datasetId, startable)}`;
}

export interface PublicationReviewDescription {
  /** One line, safe for a table cell. */
  headline: string;
  tone: "ok" | "note" | "warn" | "stop";
  /**
   * Fixed words and closed words, one per line; {@link NOT_ASSESSED_LINE} is last. Never a word the
   * model wrote: the email is built from these lines alone, so what a depositor could influence
   * cannot reach an inbox through them.
   */
  lines: string[];
  /**
   * The model's own summary, sanitized by the parser, or null when there is none to show. The one
   * sentence of a description that is not the platform's: a surface that shows the model's words
   * (the detail view) prints it under a label of its own, and the email never receives it.
   */
  summary: string | null;
  /** The command an administrator runs next, or null when it is not theirs to run. */
  next: string | null;
}

/** Can an administrator's `start` create or restart this row? Never a running or reported one. */
function rowRestartable(row: ReviewRowView): boolean {
  return (
    row.kind === "none" ||
    row.kind === "declined" ||
    row.kind === "errored" ||
    row.kind === "unreported" ||
    (row.kind === "dispatched" && row.overdue)
  );
}

/**
 * Whether an administrator's `start` is offered for this review: the request is waiting for its
 * decision (`startable`), the row is one a start can create or restart, a reason's cure is "start
 * it", and no hard reason stands (with one standing the approval is refused whatever a review says,
 * so the only command left is the screen's own cure, or none).
 *
 * The one rule behind `next` ({@link describePublicationReview}) and the list's `start_offered`, so
 * a client that decides from the list (`start --all`) cannot offer what the detail would not. It
 * knows only what these inputs say: a request whose screen has no clear result, one this Worker
 * does not own and the platform's allowance are the route's to refuse (HTTP 409), and the view that
 * carries this to the list adds the screen's part.
 */
export function startOffered(input: {
  reasons: readonly Reason[];
  row: ReviewRowView;
  startable: boolean;
}): boolean {
  const { reasons, row, startable } = input;
  if (!startable || !rowRestartable(row)) return false;
  if (hardReasonsOf(reasons).length > 0) return false;
  const codes = new Set(reasons.map((r) => r.code));
  return START_CURE_REASONS.some((c) => codes.has(c));
}

/** Where an approval of the request stands (see {@link describePublicationReview}). */
export type ApprovalStanding = "none" | "stopped" | "publishing";

/** What the description says about a run that has started publishing: why no gate applies to it. */
export const APPROVAL_PUBLISHING_LINE =
  "This approval has started publishing; it passed the gates when it started and is continued without them.";

/**
 * What the description says about an approval that stopped before it started publishing while a
 * reason nothing clears stands: a resume would be refused, and the move to blocked that the table's
 * cure for a failed minimum names takes only a request still waiting for its decision, so this one
 * stays `approving`. The way out is a denial. `<dataset>` is filled like a cure's.
 */
export const APPROVAL_STOPPED_HARD_LINE = `This approval stopped before it started publishing, and a reason that nothing clears now stands, so it cannot be resumed. Deny it with a reason (${COMMAND_DENY}); the depositor can request again.`;

/**
 * The hard reasons an administrator's own `screen` (or the wait for it) clears. They are left out of
 * {@link APPROVAL_STOPPED_HARD_LINE}: the request is not stuck behind them, and `next` says so.
 */
const SCREEN_GAP_REASONS: readonly ReasonCode[] = [
  "identifier_screen_not_run",
  "identifier_screen_pending",
  "identifier_screen_stale",
];

function nextCommand(
  id: string,
  reasons: readonly Reason[],
  row: ReviewRowView,
  startable: boolean,
  approval: ApprovalStanding,
): string | null {
  const codes = new Set(reasons.map((r) => r.code));
  // A run that has started publishing is continued, not gated again, whatever the reasons say.
  if (approval === "publishing") return `${fill(COMMAND_APPROVE, id)} --resume`;
  // A stopped run that has not started publishing is gated like a fresh one when it resumes.
  const resume = approval === "stopped" ? " --resume" : "";
  if (reasons.length === 0) return `${fill(COMMAND_APPROVE, id)}${resume}`;
  if (hardReasonsOf(reasons).length > 0) {
    // Only the screen's own hard reasons are an administrator's to act on.
    return codes.has("identifier_screen_not_run") || codes.has("identifier_screen_stale")
      ? fill(COMMAND_SCREEN, id)
      : null;
  }
  if (startOffered({ reasons, row, startable })) return fill(COMMAND_START, id);
  if (codes.has("review_running")) return fill(COMMAND_SHOW, id);
  const ack = codes.has("identifier_screen_needs_acknowledgment") ? ` ${ACKNOWLEDGE_FLAG}` : "";
  const force = overrideClassReasonsOf(reasons).length > 0 ? " --force" : "";
  return `${fill(COMMAND_APPROVE, id)}${resume}${ack}${force}`;
}

/**
 * The words in front of a person, for the email, the command-line interface and the web page, so
 * the three cannot disagree about what a review means. Every rendering ends with
 * {@link NOT_ASSESSED_LINE}.
 *
 * Not applicable (a mirror or an exemplar), the flag being off and a closed request with no review
 * are not reasons; they are their own renderings, and a caller gives them no outcome. With the
 * flag off a stored review is still shown, as advice that gates nothing.
 * The outcome shown is never milder than the reasons: a caller's `outcome` is combined with
 * {@link verdictOf} of the reasons by {@link stricterOf}, and a missing one is `action_required`.
 */
export function describePublicationReview(input: {
  datasetId: string;
  applies: boolean;
  enabled: boolean;
  outcome: PublicationOutcome | null;
  reasons: readonly Reason[];
  row: ReviewRowView;
  model: string | null;
  head: string | null;
  version: string | null;
  /**
   * An administrator's `start` can reach this request: it is waiting for its decision
   * (`requested`). The route refuses any other status, so a request that is blocked or being
   * approved is never told to start a review, in a cure or in `next`. Required, so that a caller
   * cannot forget it and offer a command that cannot work. It counts as false whenever `approval`
   * is not `none`, whatever is passed.
   */
  startable: boolean;
  /**
   * The request is over (published or denied), so no review is waiting for or gating it. With no
   * review on record it reads as not reviewed, never as "action required". Default false.
   */
  closed?: boolean;
  /**
   * Where an approval of this request stands. `stopped`: the request is `approving` and has not
   * started publishing, so a resume is gated like a fresh run and its command carries `--resume`.
   * `publishing`: it has started publishing, so a resume passes no gate: its command is the resume
   * whatever the reasons say, and a line says why. Default `none`.
   */
  approval?: ApprovalStanding;
}): PublicationReviewDescription {
  const { applies, enabled, reasons, row } = input;
  const approval = input.approval ?? "none";
  // Both inputs derive from the request's status (`requested`, or `approving` and `blocked`), so
  // `startable` with an approval that is not `none` describes no request: the start route refuses
  // one that is not `requested`, and `nextCommand` would offer a start with no `--resume`.
  const startable = input.startable && approval === "none";
  const id = quotedId(input.datasetId);
  if (!applies) {
    return {
      headline: "Publication review: not applicable",
      tone: "note",
      lines: [
        "OpenNeuro mirrors and exemplars passed an upstream review, so the automated review does not apply.",
        NOT_ASSESSED_LINE,
      ],
      summary: null,
      next: null,
    };
  }
  if (!enabled && row.kind === "none") {
    return {
      headline: "Publication review: not reviewed (the automated review is off)",
      tone: "note",
      lines: [
        "The automated review is off, so this request was not reviewed and no review gates its approval.",
        NOT_ASSESSED_LINE,
      ],
      summary: null,
      next: null,
    };
  }

  if (input.closed === true && row.kind === "none") {
    return {
      headline: "Publication review: not reviewed (the request is closed)",
      tone: "note",
      lines: [
        "This request is no longer waiting for a decision, and no review of it is on record.",
        NOT_ASSESSED_LINE,
      ],
      summary: null,
      next: null,
    };
  }

  const outcome = stricterOf(input.outcome ?? "action_required", verdictOf(reasons));
  const report = row.kind === "reported" ? row.report : null;
  const lines = reasons.map((r) => reasonLine(r, id, report, startable));
  const summary = report !== null && report.summary !== "" ? report.summary : null;
  if (row.kind === "reported") {
    const parts: string[] = [];
    if (input.model !== null && isOneOf(CALIBRATION_MODELS, input.model)) {
      parts.push(`Reviewed by ${input.model}`);
    }
    if (input.head !== null && HEAD.test(input.head))
      parts.push(`at commit ${input.head.slice(0, 12)}`);
    if (input.version !== null && SEMVER.test(input.version))
      parts.push(`version ${input.version}`);
    if (parts.length > 0) lines.push(`${parts.join(", ")}.`);
  }
  if (!enabled) {
    lines.push("The automated review is off, so this review is advice and gates nothing.");
    lines.push(NOT_ASSESSED_LINE);
    return {
      headline: `Publication review (advice only, the automated review is off): ${OUTCOME_WORD[outcome]}`,
      tone: "note",
      lines,
      summary,
      next: null,
    };
  }
  if (approval === "publishing") lines.push(APPROVAL_PUBLISHING_LINE);
  if (
    approval === "stopped" &&
    hardReasonsOf(reasons).some((r) => !SCREEN_GAP_REASONS.includes(r.code))
  ) {
    lines.push(fill(APPROVAL_STOPPED_HARD_LINE, id));
  }
  lines.push(NOT_ASSESSED_LINE);
  return {
    headline: `Publication review: ${OUTCOME_WORD[outcome]}`,
    tone: OUTCOME_TONE[outcome],
    lines,
    summary,
    next: nextCommand(id, reasons, row, startable, approval),
  };
}

/**
 * What every surface says when the review could not be read just now (a fault of the Worker's own
 * reads, not a state of the request): a fixed headline, never a pass. The sentences live here, with
 * the others, so the email, the list and the detail say the same words.
 */
export const REVIEW_UNREADABLE_HEADLINE = "Publication review: could not be read";
export const REVIEW_UNREADABLE_LINE =
  "The review's state could not be read just now, so it is not known. This is not a pass.";

/**
 * The description of a review that could not be read. Not an outcome and not a reason: the cure for
 * a read fault is not to start the review again, so it has no reason code, and its one command
 * shows the request, which reads the review again.
 */
export function describeUnreadableReview(datasetId: string): PublicationReviewDescription {
  return {
    headline: REVIEW_UNREADABLE_HEADLINE,
    tone: "warn",
    lines: [REVIEW_UNREADABLE_LINE, NOT_ASSESSED_LINE],
    summary: null,
    next: DATASET_ID.test(datasetId) ? fill(COMMAND_SHOW, datasetId) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// The approval gate's words
// ---------------------------------------------------------------------------------------------

/**
 * Why the approval gate refused (ADR 0102, section 8), in a closed word: the `refusal` of the 409
 * `publication_review_not_clear` the approval routes answer with. Listed in declaration order, which
 * is not the order the gate tries them: it tries `unverified` first (at its read of the request),
 * then `hard_reason`, `review_changed`, `override_not_covering` and `no_review_row`, and arrives at
 * `needs_override` only when the approver sent no override.
 *
 *  - `hard_reason`: a reason nothing clears stands, so no override changes the answer.
 *  - `needs_override`: an override-class reason stands and the approver gave none (and has none on
 *    record for the review in force).
 *  - `override_not_covering`: the override does not name every live override-class reason, for
 *    instance one that came up after the administrator read the review.
 *  - `review_changed`: the override names another review than the one in force, or the row moved
 *    between the read and the write that records the override.
 *  - `no_review_row`: the web executor's dispatch needs an override and there is no review row to
 *    record it on.
 *  - `unverified`: the gate could not check the request or the review, so it refuses rather than
 *    guess (ADR 0053, ADR 0054). A read that failed, or a record of the override that could not be
 *    written: an override that is recorded nowhere approves nothing.
 */
export const REVIEW_GATE_REFUSALS = [
  "hard_reason",
  "needs_override",
  "override_not_covering",
  "review_changed",
  "no_review_row",
  "unverified",
] as const;
export type ReviewGateRefusal = (typeof REVIEW_GATE_REFUSALS)[number];

/** The sentence of each refusal. `<dataset>` is filled by {@link reviewGateRefusalText}. */
export const REVIEW_GATE_REFUSAL_TEXT: Record<ReviewGateRefusal, string> = {
  hard_reason:
    "The publication review gives a reason that no override clears, so the approval is refused.",
  needs_override: `The publication review is not a pass. Read it (${COMMAND_SHOW}), then approve over it with --force, which records the override with your account.`,
  override_not_covering: `The review now gives a reason the override was not given for. Read it again (${COMMAND_SHOW}) before approving.`,
  review_changed: `The review the override was given for is no longer the review of this request, or it changed while the approval was being checked. Read it again (${COMMAND_SHOW}) before approving.`,
  no_review_row: `No review of this commit is on record to attach the override to. Start it (${COMMAND_START}), or approve from a terminal with --force.`,
  unverified:
    "The publication review could not be checked just now, so the approval is refused. Try again.",
};

/**
 * The sentence of a refusal for this dataset: `<dataset>` filled, and a malformed id never quoted
 * (as {@link cureOf} does), so the one place the gate speaks cannot echo what a caller sent.
 */
export function reviewGateRefusalText(refusal: ReviewGateRefusal, datasetId: string): string {
  return fill(REVIEW_GATE_REFUSAL_TEXT[refusal], quotedId(datasetId));
}

// ---------------------------------------------------------------------------------------------
// The callback body
// ---------------------------------------------------------------------------------------------

/** What a callback can say: a parsed report, or the word for why there is none. */
export type PublicationCallbackOutcome =
  | { kind: "reported"; report: PublicationReviewReport }
  | { kind: "error"; error: PublicationRunError };

/**
 * Turn a callback's untrusted `outcome`, `report` and `error` fields into an outcome. A report goes
 * through {@link parsePublicationReviewReport}; one it refuses is `report_invalid`, and `onRefused`
 * is told the parser's fixed word. An error word outside the vocabulary, or one only the Worker may
 * write ({@link WORKER_ONLY_RUN_ERRORS}), is `workflow_failed`, and so is anything else (a missing
 * or unknown `outcome`, `"pass"` included): it can never become a verdict. `options.models` is the
 * confirming run's model list, which the route passes for a row that confirms another (ADR 0139);
 * every other report is held to the production list.
 */
export function parsePublicationCallbackOutcome(
  body: { outcome: unknown; report: unknown; error: unknown },
  onRefused?: (code: PublicationReportErrorCode) => void,
  options: { models?: readonly ReviewerModel[] } = {},
): PublicationCallbackOutcome {
  if (body.outcome === "reported") {
    try {
      return { kind: "reported", report: parsePublicationReviewReport(body.report, options) };
    } catch (err) {
      if (!(err instanceof PublicationReviewReportError)) throw err;
      onRefused?.(err.code);
      return { kind: "error", error: "report_invalid" };
    }
  }
  const error = body.error;
  return {
    kind: "error",
    error:
      body.outcome === "error" &&
      isPublicationRunError(error) &&
      !(WORKER_ONLY_RUN_ERRORS as readonly string[]).includes(error)
        ? error
        : "workflow_failed",
  };
}

// ---------------------------------------------------------------------------------------------
// The reproducibility record, as every surface shows it (ADR 0139, decision 9)
// ---------------------------------------------------------------------------------------------

/**
 * A review's reproducibility record, read back from its row. Every field is checked against its
 * own shape on the way out, so a column edited by hand is shown as absent, never printed.
 */
export interface PublicationReviewReproducibility {
  head_sha: string;
  scanner_id: string | null;
  reader_versions: Record<string, string> | null;
  resolver_version: string | null;
  models: { model: string; effort: string }[] | null;
  prompt_version: string | null;
  input_digest: string | null;
  /** The enrichment the review read, as D1 held it at review time (see {@link ReviewReproducibility}). */
  enrichment_source: string | null;
  /**
   * The license matcher of a version-3 report (migration 0162), or null. Optional so an older
   * Worker's answer reads.
   */
  license_matcher?: string | null;
}

const RECORD_SCANNER_RE = /^identifier-scan@[0-9a-f]{7,40}$/;
const RECORD_READER_KEY = /^[a-z][a-z0-9-]{0,31}$/;
const RECORD_READER_VERSION = /^[0-9a-z][0-9a-z.+-]{0,31}$/;

function parseJsonOrNull(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The record of a stored row, each column checked: null when the row has no record at all (a
 * review that did not report, or one reported before the record existed).
 */
export function reproducibilityOf(row: {
  headSha: string;
  scannerId: string | null;
  readerVersions: string | null;
  resolverVersion: string | null;
  models: string | null;
  promptVersion: string | null;
  inputDigest: string | null;
  enrichmentSource: string | null;
  /** Migration 0162's column; a caller that predates it reads as unrecorded. */
  licenseMatcher?: string | null;
}): PublicationReviewReproducibility | null {
  const models = parseJsonOrNull(row.models);
  const shownModels =
    Array.isArray(models) &&
    models.length > 0 &&
    models.length <= MAX_RECORDED_CALLS &&
    models.every(
      (m) =>
        isRecord(m) && isOneOf(CALIBRATION_MODELS, m.model) && isOneOf(RECORDED_EFFORTS, m.effort),
    )
      ? (models as { model: string; effort: string }[]).map((m) => ({
          model: m.model,
          effort: m.effort,
        }))
      : null;
  const readers = parseJsonOrNull(row.readerVersions);
  const shownReaders =
    isRecord(readers) &&
    Object.entries(readers).every(
      ([k, v]) =>
        RECORD_READER_KEY.test(k) && typeof v === "string" && RECORD_READER_VERSION.test(v),
    )
      ? (readers as Record<string, string>)
      : null;
  const record: PublicationReviewReproducibility = {
    head_sha: row.headSha,
    scanner_id:
      row.scannerId !== null && RECORD_SCANNER_RE.test(row.scannerId) ? row.scannerId : null,
    reader_versions: shownReaders,
    resolver_version:
      row.resolverVersion !== null && RESOLVER_VERSION_RE.test(row.resolverVersion)
        ? row.resolverVersion
        : null,
    models: shownModels,
    prompt_version:
      row.promptVersion !== null && PROMPT_VERSION_RE.test(row.promptVersion)
        ? row.promptVersion
        : null,
    input_digest:
      row.inputDigest !== null && DIGEST_RE.test(row.inputDigest) ? row.inputDigest : null,
    enrichment_source:
      row.enrichmentSource !== null && ENRICHMENT_SOURCE_RE.test(row.enrichmentSource)
        ? row.enrichmentSource
        : null,
    license_matcher:
      typeof row.licenseMatcher === "string" && LICENSE_MATCHER_RE.test(row.licenseMatcher)
        ? row.licenseMatcher
        : null,
  };
  const empty =
    record.scanner_id === null &&
    record.reader_versions === null &&
    record.resolver_version === null &&
    record.models === null &&
    record.prompt_version === null &&
    record.input_digest === null &&
    record.enrichment_source === null &&
    record.license_matcher === null;
  return empty ? null : record;
}

/** What a reproducible review is and is not, in the words every surface uses (ADR 0139, decision 9). */
export const REPRODUCIBILITY_LINE =
  "Reproducible means the evidence can be recomputed (nemar dataset screen --committed, nemar dataset license-check) and the inputs, prompt version and models are recorded; a model may still answer differently when asked again.";

/**
 * The record as lines of fixed words and checked values, for the terminal and the status answer.
 * A field that is not recorded says so; nothing here is model or depositor text.
 */
export function reproducibilityLines(record: PublicationReviewReproducibility): string[] {
  const unrecorded = "not recorded";
  const readers =
    record.reader_versions === null
      ? unrecorded
      : Object.entries(record.reader_versions)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ");
  const models =
    record.models === null
      ? unrecorded
      : record.models.map((m) => `${m.model} (effort ${m.effort})`).join(", ");
  return [
    `Reviewed commit: ${record.head_sha}`,
    `Identifier scanner: ${record.scanner_id ?? unrecorded}`,
    `Format readers: ${readers}`,
    `License-lineage resolver: ${record.resolver_version ?? unrecorded}`,
    `Models: ${models}`,
    `Prompt version: ${record.prompt_version ?? unrecorded}`,
    `Input digest (SHA-256): ${record.input_digest ?? unrecorded}`,
    `Enrichment read: ${record.enrichment_source === null ? "none, or not recorded" : `the copy stored at ${record.enrichment_source}`}`,
    `License matcher: ${record.license_matcher ?? unrecorded}`,
    REPRODUCIBILITY_LINE,
  ];
}
