/**
 * The administrator's decision card for a publication request (ADR 0142, decision 4): one
 * structure, built once by the Worker (`backend/src/services/decision-card.ts`) and attached to
 * `GET /admin/publish/:id/review` as `decision_card`. `nemar admin dataset publish show` prints it
 * at the top, and the website's approval page prints it as it arrives; no surface computes its own.
 *
 * Every sentence in the card is the Worker's and is web-safe (ADR 0102, Phase 4 amendment): it names
 * no terminal command, flag or placeholder. The one exception is `next_action.command`, which is a
 * terminal's text and which a page never prints, as `ReasonView.command`.
 *
 * Two kinds of text are not NEMAR's words and are carried under a label that says whose they are:
 * the dataset's own fields (`DEPOSITOR_TEXT_LABEL`) and a model's finding note
 * (`MODEL_TEXT_LABEL`), and the license texts a registry declares (`REGISTRY_TEXT_LABEL`). The
 * Worker removes control and format characters from them; a terminal still passes each through
 * `plain()`, and a page prints each as text, never as markup.
 *
 * Types and closed vocabularies only. This file has no Node or Worker imports.
 */

import type { LicenseFileFact } from "../license-file.js";
import type { LineageOutcome } from "../license-lineage.js";
import type { NameUpstreamResult } from "../name-follows-upstream.js";
import type { Answer, Question } from "../publication-review.js";

/** The card's own version: a field is added, never changed in meaning, within one version. */
export const DECISION_CARD_VERSION = 1;

/** The license panel's cue. */
export const LICENSE_CUES = ["green", "amber", "red"] as const;
export type LicenseCue = (typeof LICENSE_CUES)[number];

/**
 * The suggested next action, one closed word (ADR 0142, decision 4). `approve` only when the
 * approval gate would accept the approval with no override and no acknowledgment still owed; no
 * action suggests an override, which is the administrator's own act (ADR 0102, section 8).
 * `administrator_reads` (ADR 0142, amendment of 2026-11-27) is for a reason no rule settles and
 * the depositor cannot be asked to cure: the administrator reads the review and decides.
 */
export const DECISION_ACTIONS = [
  "approve",
  "acknowledge_screen",
  "rerun_screen",
  "wait",
  "start_review",
  "review_again",
  "record_license_permission",
  "ask_depositor",
  "administrator_reads",
  "deny",
] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

/** The label on the dataset's own fields: the depositor wrote them, NEMAR did not. */
export const DEPOSITOR_TEXT_LABEL = "written by the depositor";
/** The label on a model's finding note, as the review's findings carry it. */
export const MODEL_TEXT_LABEL = "written by the model; the depositor's text can steer it";
/** The label on a license a source's registry declares. */
export const REGISTRY_TEXT_LABEL = "as the source's registry declares it";

/** The enrichment's description is cut to this many characters on the card. */
export const CARD_DESCRIPTION_MAX = 1_500;

/** The main fields of the enrichment (`.nemar/metadata.json`), as the card shows them. */
export interface CardEnrichment {
  title: string | null;
  /** The dataset's aim, cut to {@link CARD_DESCRIPTION_MAX} characters. */
  description: string | null;
  /** The description was longer than {@link CARD_DESCRIPTION_MAX} and was cut. */
  description_cut: boolean;
  license: string | null;
  /** Names only; empty for an anonymous release, whose creators the review is never shown. */
  creators: string[];
  keywords: string[];
  /** Each funder, with its award number when the field names one. */
  funding: string[];
}

/** `dataset_description.json`'s `Name`, `License` and `Authors`, as the card shows them. */
export interface CardDescription {
  name: string | null;
  license: string | null;
  /** Empty for an anonymous release, whose Authors the review is never shown. */
  authors: string[];
}

/** The dataset's own words, side by side (ADR 0142, decision 4). */
export interface CardMetadata {
  /**
   * True when these are the fields as the review read them (the snapshot taken when the Worker
   * served the review's inputs). False for a review from before the snapshot existed, or a request
   * with no review served: the fields are then the ones NEMAR holds now, and `note` says so.
   */
  as_reviewed: boolean;
  /** Null when `as_reviewed`; else the sentence that says these are not the reviewed fields. */
  note: string | null;
  /** The label on every field below: {@link DEPOSITOR_TEXT_LABEL}. */
  label: string;
  /** When D1 stored the enrichment that was read, when known. */
  enrichment_source: string | null;
  /** Null when there is no enrichment on record. */
  enrichment: CardEnrichment | null;
  /** Null when the description could not be read. */
  dataset_description: CardDescription | null;
  /** The version an approval publishes, from the review's facts; null without a review. */
  version: string | null;
  /** True for an anonymous release: creators and Authors are withheld from the card. */
  anonymous: boolean;
}

/** Text that is not NEMAR's, carried with the label that says whose it is. */
export interface LabeledText {
  label: string;
  text: string;
}

/** One lineage as the card shows it: the review's own, or the card's fresher one. */
export interface CardLineage {
  outcome: LineageOutcome;
  /** `SourceDatasets` declares an upstream source. */
  credited: boolean;
  resolved_at: string | null;
  /** Each license a source's registry declares, `id: text`, under {@link REGISTRY_TEXT_LABEL}. */
  declared_licenses: { label: string; licenses: string[] };
  /** README DOIs the resolver dropped as cut short, when any; why a lineage may show no source. */
  dropped_doi_candidates?: number;
  /**
   * Enrichment relations (IsDerivedFrom or IsIdenticalTo) skipped as stale publications, when any;
   * why a lineage may show no source.
   */
  skipped_stale_relations?: number;
  /** A recorded license permission covers this lineage's outcome and sources. */
  permission_covers: boolean;
}

/**
 * Whether the dataset's Name follows its upstream dataset's title (the owner's rule of 2026-11-27,
 * `shared/name-follows-upstream.ts`): the review's closed word, the cue, NEMAR's line for it, and
 * the upstream dataset titles under {@link REGISTRY_TEXT_LABEL}.
 */
export interface CardUpstreamName {
  /** The review's word, or null when no review on record compared them (one made before the rule). */
  result: NameUpstreamResult | null;
  /** `red` for `differs`, `amber` for `unknown` or no word, `green` otherwise. */
  cue: LicenseCue;
  /** Web-safe. */
  line: string;
  /** The titles of the upstream dataset sources as their registries give them; empty when none was read. */
  titles: { label: string; titles: string[] };
}

/** The license panel (ADR 0142, decision 4). */
export interface CardLicensePanel {
  cue: LicenseCue;
  /** The one-line reason for the cue: the first of `reasons`, or the green sentence. */
  reason: string;
  /** Every reason that stands, red first, in the cue table's order; empty when green. */
  reasons: string[];
  /** `dataset_description.json`'s `License` under {@link DEPOSITOR_TEXT_LABEL}, or null when there is none or it could not be read. */
  field: LabeledText | null;
  /** The review's LICENSE identification (a version-3 review), or null. */
  license_file: LicenseFileFact | null;
  /** The license matcher the review recorded, or null. */
  matcher: string | null;
  /** The lineage the review read, or null without one. */
  lineage: CardLineage | null;
  /**
   * The lineage resolved again for the card, when the review's own was unresolved (ADR 0142,
   * decision 3), or null. Shown beside the review's with both times; it never raises the verdict.
   */
  fresh_lineage: CardLineage | null;
  /** A recorded license permission covers the review's lineage. */
  permission_recorded: boolean;
}

/** One author of the description, with whether the entry names nobody. */
export interface CardAuthor {
  name: string;
  placeholder: boolean;
}

export interface CardAuthors {
  /** Empty for an anonymous release, or when the names were not read. */
  names: CardAuthor[];
  /** From the review's facts when there is one, else the names counted. */
  count: number | null;
  placeholders: number | null;
}

/** The strongest finding of a question: a platform fact first, then blocker, concern, note. */
export interface CardFinding {
  /** `platform`: NEMAR's own fact or finding; `model`: the reviewer's. */
  source: "platform" | "model";
  /** `fact` for a platform fact that lowered the answer, else the finding's severity. */
  severity: "fact" | "blocker" | "concern" | "note";
  /** NEMAR's words for it. */
  label: string;
  /** The model's note, or null; labeled `note_label`. */
  note: string | null;
  note_label: string | null;
}

export interface CardQuestion {
  question: Question;
  label: string;
  answer: Answer;
  strongest: CardFinding | null;
}

export interface CardAutoDeny {
  /** The stored closed word (`AUTO_DENY_STATES`), never `none`. */
  state: string;
  line: string;
}

export interface CardNextAction {
  action: DecisionAction;
  /** Web-safe. */
  sentence: string;
  /** The terminal's command for it; a page never prints this. */
  command: string;
}

/** Whether the screened commit is still the repository's `main`. */
export const HEAD_CHECKS = ["current", "stale", "unverified", "exempt"] as const;
export type HeadCheck = (typeof HEAD_CHECKS)[number];

/** The decision card. */
export interface DecisionCard {
  v: typeof DECISION_CARD_VERSION;
  metadata: CardMetadata;
  license: CardLicensePanel;
  authors: CardAuthors;
  /** The four questions, in the vocabulary's order; empty without a readable report. */
  questions: CardQuestion[];
  /**
   * The identifier screen's headline and tone, as `describeScreen` words them, and whether the
   * screened commit is still `main` (`verifyScreenHead`, the approval's own check): `current`,
   * `stale`, `unverified` (the check could not be made) or `exempt`; `head_line` says the last
   * three in words and is null for `current`.
   */
  identifier_screen: {
    headline: string;
    tone: "ok" | "note" | "warn" | "stop";
    head: HeadCheck;
    head_line: string | null;
  };
  /** The name rule's panel. */
  upstream_name: CardUpstreamName;
  /** Null when the automatic denial has not acted on the review in force. */
  auto_deny: CardAutoDeny | null;
  next_action: CardNextAction;
}
