/**
 * The dataset pull-request review's contract (ADR 0092): the report a review run posts, the
 * verdict derived from it, the check-run words shown to people, and the rule that stops
 * reviewing a contributor whose pull requests keep being rejected.
 *
 * One module, three readers. The workflow script builds a report with it, the Worker parses
 * what comes back with it before storing a byte, and the check-run is rendered from it, so
 * the check, the stored row and the tally cannot disagree about what a review said.
 *
 * **Every field of a pull request is attacker-controlled text**: title, body, commit messages,
 * file names, file contents. That text reaches a language model, and the model's output reaches
 * a public-facing check-run. Three rules keep the model from steering the outcome:
 *
 *  1. **The verdict is derived, never reported.** The model supplies a result per criterion and
 *     some findings. {@link verdictOf} decides pass, fail or uncertain from those and from
 *     facts the script computed from git, and no field of the report is "the verdict".
 *  2. **Facts override the model.** A criterion the git facts contradict cannot pass, whatever
 *     the model said ({@link effectiveCriteria}).
 *  3. **Free text is a note, never markup.** The one place a model's words reach a person,
 *     {@link sanitizeNote}, removes links, mentions, cross-references, HTML and emphasis, so a
 *     note cannot ping someone, link anywhere or hide the verdict.
 *
 * **Unknown is never green** (ADR 0053, ADR 0086). Anything that is not a clear pass maps to a
 * conclusion that does not satisfy a required check: `neutral` and `skipped` DO satisfy one on
 * GitHub, which is why neither appears in {@link conclusionOf}.
 *
 * The parser throws a fixed-word {@link PrReviewReportError}; it never quotes its input.
 */

export const REPORT_VERSION = 1;

/** The check-run's name. Stable: a ruleset that requires the check names it. */
export const PR_REVIEW_CHECK_NAME = "NEMAR PR Review";

/** The models a report may name. A closed set, so a model change is a reviewed code change. */
export const REVIEW_MODELS = ["claude-haiku-5-5"] as const;
export type ReviewModel = (typeof REVIEW_MODELS)[number];

/** What a pull request to a dataset is asked to be: the three questions of the review. */
export const CRITERIA = ["no_degradation", "advances_revision", "material_improvement"] as const;
export type Criterion = (typeof CRITERIA)[number];

export const CRITERION_RESULTS = ["pass", "fail", "unknown"] as const;
export type CriterionResult = (typeof CRITERION_RESULTS)[number];

export const SEVERITIES = ["blocker", "concern", "note"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Why a finding exists. Closed, so the tally and the check can say it without quoting anyone. */
export const FINDING_CODES = [
  "data_removed",
  "metadata_removed",
  "structure_broken",
  "validation_regressed",
  "version_not_advanced",
  "changes_log_missing",
  "changes_log_mismatch",
  "description_mismatch",
  "churn_only",
  "no_substantive_change",
  "improvement_unclear",
  "evidence_incomplete",
  "steering_attempt",
  "other",
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

export const MAX_FINDINGS = 8;
export const NOTE_MAX = 200;
export const SUMMARY_MAX = 400;

export interface ReviewFinding {
  criterion: Criterion;
  severity: Severity;
  code: FindingCode;
  /** A repository path the finding is about, or null. Pattern-checked, never trusted. */
  path: string | null;
  /** Sanitised free text, at most {@link NOTE_MAX} characters. */
  note: string;
}

/**
 * Where in a dataset a changed file sits. Closed, so a change summary can be counted, shown and
 * compared without quoting a path. The script that fills it is `classifyPath` in
 * `shared/pr-review-evidence.ts`; this list is what the Worker will accept.
 */
export const AREAS = [
  "dataset_description",
  "readme_and_changes",
  "participants",
  "sidecars",
  "recordings",
  "derivatives",
  "sourcedata",
  "code",
  "other",
] as const;
export type Area = (typeof AREAS)[number];

export interface AreaCounts {
  added: number;
  modified: number;
  removed: number;
}

export const CHANGE_STATUSES = ["added", "modified", "removed"] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

/** The most changed files a report lists for a person to open. The counts above are exact. */
export const MAX_LISTED = 50;

export interface ChangedFile {
  status: ChangeStatus;
  /** Null when the name is not path-shaped; the file is still counted. */
  path: string | null;
}

/**
 * Facts the script computed from git. The model never writes this block, so the account of what
 * changed cannot be shaded by it: the counts come from the whole change list, and they must add
 * up to `files_changed` ({@link parsePrReviewReport} refuses a report where they do not).
 */
export interface ReviewEvidence {
  files_changed: number;
  /** How many changed files had their content (a diff) given to the model. The rest were judged by name and type. */
  files_read: number;
  /** The change list or a patch given to the model was cut short, so a pass about absence cannot be trusted. */
  truncated: boolean;
  version_before: string | null;
  version_after: string | null;
  subjects_before: number | null;
  subjects_after: number | null;
  areas: Record<Area, AreaCounts>;
  /** Up to {@link MAX_LISTED} changed files, the ones a reviewer is most likely to open first. */
  listed: ChangedFile[];
}

export interface PrReviewReport {
  v: typeof REPORT_VERSION;
  model: ReviewModel;
  criteria: Record<Criterion, CriterionResult>;
  findings: ReviewFinding[];
  summary: string;
  /** The model says the pull request tried to instruct it. Always fails the review. */
  steering: boolean;
  evidence: ReviewEvidence;
}

// ---------------------------------------------------------------------------------------------
// Parsing: a closed vocabulary, enforced at the door.
// ---------------------------------------------------------------------------------------------

/** Fixed words a refused report is described with. Never a quotation of the input. */
export const REPORT_ERRORS = [
  "not_an_object",
  "unknown_key",
  "bad_version",
  "bad_model",
  "bad_criteria",
  "bad_findings",
  "bad_summary",
  "bad_steering",
  "bad_evidence",
] as const;
export type ReportErrorCode = (typeof REPORT_ERRORS)[number];

export class PrReviewReportError extends Error {
  readonly code: ReportErrorCode;
  constructor(code: ReportErrorCode) {
    super(code);
    this.name = "PrReviewReportError";
    this.code = code;
  }
}

const SEMVER = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
/** A BIDS-shaped path. Anything else is dropped from a finding, not trusted into a check-run. */
const SAFE_PATH = /^[A-Za-z0-9._\-/]{1,200}$/;
const MAX_FILES = 10_000_000;

const CRITERION_SET: ReadonlySet<string> = new Set(CRITERIA);
const RESULT_SET: ReadonlySet<string> = new Set(CRITERION_RESULTS);
const SEVERITY_SET: ReadonlySet<string> = new Set(SEVERITIES);
const CODE_SET: ReadonlySet<string> = new Set(FINDING_CODES);
const MODEL_SET: ReadonlySet<string> = new Set(REVIEW_MODELS);

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function hasExactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
}

/**
 * Free text from a model or a pull request, made safe to put in a check-run.
 *
 * Removes what could notify a person (`@name`), cross-reference an issue (`#12`), link
 * somewhere (URLs, `[text](url)`, images), inject markup (HTML tags, emphasis, table pipes,
 * backslash escapes), or hide itself (control, zero-width and bidirectional-override
 * characters). What is left is plain words, cut to `max` characters.
 */
export function sanitizeNote(input: unknown, max: number = NOTE_MAX): string {
  if (typeof input !== "string") return "";
  let s = input.normalize("NFKC");
  s = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/<[^>]*>/g, " ");
  s = s.replace(/\b(?:https?|ftp|file|data|javascript):\/*\S*/gi, "[link removed]");
  s = s.replace(/\bwww\.\S+/gi, "[link removed]");
  s = s.replace(/[@#`*_~|\\<>[\]{}]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function parseFinding(raw: unknown): ReviewFinding {
  if (!isRecord(raw) || !hasExactKeys(raw, ["criterion", "severity", "code", "path", "note"])) {
    throw new PrReviewReportError("bad_findings");
  }
  const { criterion, severity, code, path, note } = raw;
  if (
    typeof criterion !== "string" ||
    !CRITERION_SET.has(criterion) ||
    typeof severity !== "string" ||
    !SEVERITY_SET.has(severity) ||
    typeof code !== "string" ||
    !CODE_SET.has(code)
  ) {
    throw new PrReviewReportError("bad_findings");
  }
  if (path !== null && typeof path !== "string") throw new PrReviewReportError("bad_findings");
  if (typeof note !== "string") throw new PrReviewReportError("bad_findings");
  return {
    criterion: criterion as Criterion,
    severity: severity as Severity,
    code: code as FindingCode,
    path: typeof path === "string" && SAFE_PATH.test(path) && !path.includes("..") ? path : null,
    note: sanitizeNote(note),
  };
}

const AREA_SET: ReadonlySet<string> = new Set(AREAS);
const STATUS_SET: ReadonlySet<string> = new Set(CHANGE_STATUSES);
const MAX_SUBJECTS = 10_000_000;

function count(v: unknown, max: number = MAX_FILES): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > max) {
    throw new PrReviewReportError("bad_evidence");
  }
  return v;
}

function nullableCount(v: unknown, max: number): number | null {
  return v === null ? null : count(v, max);
}

function nullableVersion(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v === "string" && SEMVER.test(v)) return v;
  throw new PrReviewReportError("bad_evidence");
}

function parseAreaCounts(raw: unknown): AreaCounts {
  if (!isRecord(raw) || !hasExactKeys(raw, ["added", "modified", "removed"])) {
    throw new PrReviewReportError("bad_evidence");
  }
  return { added: count(raw.added), modified: count(raw.modified), removed: count(raw.removed) };
}

function parseListed(raw: unknown): ChangedFile {
  if (!isRecord(raw) || !hasExactKeys(raw, ["status", "path"])) {
    throw new PrReviewReportError("bad_evidence");
  }
  const { status, path } = raw;
  if (typeof status !== "string" || !STATUS_SET.has(status)) {
    throw new PrReviewReportError("bad_evidence");
  }
  if (path !== null && typeof path !== "string") throw new PrReviewReportError("bad_evidence");
  return {
    status: status as ChangeStatus,
    path: typeof path === "string" && SAFE_PATH.test(path) && !path.includes("..") ? path : null,
  };
}

function parseEvidence(raw: unknown): ReviewEvidence {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "files_changed",
      "files_read",
      "truncated",
      "version_before",
      "version_after",
      "subjects_before",
      "subjects_after",
      "areas",
      "listed",
    ])
  ) {
    throw new PrReviewReportError("bad_evidence");
  }
  const files_changed = count(raw.files_changed);
  const files_read = count(raw.files_read);
  if (files_read > files_changed || typeof raw.truncated !== "boolean") {
    throw new PrReviewReportError("bad_evidence");
  }
  const rawAreas = raw.areas;
  if (!isRecord(rawAreas) || !hasExactKeys(rawAreas, AREAS)) {
    throw new PrReviewReportError("bad_evidence");
  }
  const areas = {} as Record<Area, AreaCounts>;
  let total = 0;
  for (const a of AREAS) {
    areas[a] = parseAreaCounts(rawAreas[a]);
    total += areas[a].added + areas[a].modified + areas[a].removed;
  }
  // Every changed file is in exactly one area. A report whose areas do not add up to its own
  // total has dropped or invented a change, and is refused rather than shown.
  if (total !== files_changed) throw new PrReviewReportError("bad_evidence");
  if (!Array.isArray(raw.listed) || raw.listed.length > MAX_LISTED) {
    throw new PrReviewReportError("bad_evidence");
  }
  return {
    files_changed,
    files_read,
    truncated: raw.truncated,
    version_before: nullableVersion(raw.version_before),
    version_after: nullableVersion(raw.version_after),
    subjects_before: nullableCount(raw.subjects_before, MAX_SUBJECTS),
    subjects_after: nullableCount(raw.subjects_after, MAX_SUBJECTS),
    areas,
    listed: raw.listed.map(parseListed),
  };
}

/**
 * Validate a report. Accepts only the keys declared above, only members of the closed sets,
 * only counts that are non-negative integers, and only versions that are `X.Y.Z`. Free text
 * (`note`, `summary`) is not rejected for its content, it is sanitised: a model's wording is
 * not a reason to lose the review.
 *
 * A criterion that fails with no blocking finding gets one added (`other`, "No detail given."),
 * so a red check always has something for a person to read.
 */
export function parsePrReviewReport(raw: unknown): PrReviewReport {
  if (!isRecord(raw)) throw new PrReviewReportError("not_an_object");
  const keys = ["v", "model", "criteria", "findings", "summary", "steering", "evidence"];
  if (!hasExactKeys(raw, keys)) throw new PrReviewReportError("unknown_key");
  if (raw.v !== REPORT_VERSION) throw new PrReviewReportError("bad_version");
  if (typeof raw.model !== "string" || !MODEL_SET.has(raw.model)) {
    throw new PrReviewReportError("bad_model");
  }
  const rawCriteria = raw.criteria;
  if (!isRecord(rawCriteria) || !hasExactKeys(rawCriteria, CRITERIA)) {
    throw new PrReviewReportError("bad_criteria");
  }
  const criteria = {} as Record<Criterion, CriterionResult>;
  for (const c of CRITERIA) {
    const r = rawCriteria[c];
    if (typeof r !== "string" || !RESULT_SET.has(r)) throw new PrReviewReportError("bad_criteria");
    criteria[c] = r as CriterionResult;
  }
  if (!Array.isArray(raw.findings) || raw.findings.length > MAX_FINDINGS) {
    throw new PrReviewReportError("bad_findings");
  }
  const findings = raw.findings.map(parseFinding);
  if (typeof raw.summary !== "string") throw new PrReviewReportError("bad_summary");
  if (typeof raw.steering !== "boolean") throw new PrReviewReportError("bad_steering");
  const evidence = parseEvidence(raw.evidence);

  for (const c of CRITERIA) {
    if (criteria[c] === "fail" && !findings.some((f) => f.criterion === c)) {
      if (findings.length >= MAX_FINDINGS) findings.pop();
      findings.push({
        criterion: c,
        severity: "blocker",
        code: "other",
        path: null,
        note: "No detail given.",
      });
    }
  }

  return {
    v: REPORT_VERSION,
    model: raw.model as ReviewModel,
    criteria,
    findings,
    summary: sanitizeNote(raw.summary, SUMMARY_MAX),
    steering: raw.steering,
    evidence,
  };
}

// ---------------------------------------------------------------------------------------------
// Verdict: derived from the report and the git facts, never read from it.
// ---------------------------------------------------------------------------------------------

export type Verdict = "pass" | "fail" | "uncertain";

/**
 * The criteria after the git facts have had their say.
 *
 *  - No file changed: the pull request improves nothing, so `material_improvement` fails.
 *  - Both versions are known and equal: the revision did not advance, so `advances_revision`
 *    fails. (The required `version-check` already refuses this for a merge; the review says it
 *    in its own words so the two never read as contradicting each other.)
 *  - The new version is unknown (the field is absent or unreadable): `advances_revision`
 *    cannot be better than unknown.
 *  - The change list or a patch was cut short: a pass about nothing being lost
 *    (`no_degradation`) rests on evidence nobody saw, so it is unknown.
 */
export function effectiveCriteria(report: PrReviewReport): Record<Criterion, CriterionResult> {
  const out = { ...report.criteria };
  const e = report.evidence;
  if (e.files_changed === 0) out.material_improvement = "fail";
  if (e.version_before !== null && e.version_before === e.version_after) {
    out.advances_revision = "fail";
  } else if (e.version_after === null && out.advances_revision === "pass") {
    out.advances_revision = "unknown";
  }
  if (e.truncated && out.no_degradation === "pass") out.no_degradation = "unknown";
  return out;
}

export function verdictOf(report: PrReviewReport): Verdict {
  if (report.steering) return "fail";
  const c = effectiveCriteria(report);
  const results = CRITERIA.map((k) => c[k]);
  if (results.includes("fail")) return "fail";
  if (results.every((r) => r === "pass")) return "pass";
  return "uncertain";
}

// ---------------------------------------------------------------------------------------------
// Outcome -> check-run
// ---------------------------------------------------------------------------------------------

/** Why a pull request was not sent to the model. */
export const DECLINE_REASONS = ["contributor_paused", "rate_limited", "daily_limit"] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

/** Why a run that started produced no report. */
export const RUN_ERRORS = [
  "evidence_unavailable",
  "stale_head",
  "too_large",
  "auth_failed",
  "model_unavailable",
  "model_refused",
  "model_truncated",
  "model_invalid",
  "report_invalid",
  "workflow_failed",
] as const;
export type RunError = (typeof RUN_ERRORS)[number];

export type ReviewOutcome =
  | { kind: "reported"; report: PrReviewReport }
  | { kind: "declined"; reason: DeclineReason }
  | { kind: "error"; error: RunError }
  | { kind: "unreported" };

export type CheckConclusion = "success" | "failure" | "action_required";

/**
 * The check-run conclusion for an outcome.
 *
 * `success` and `failure` are the two answers a review can give. Everything else, a review that
 * could not decide, did not run, or never reported, is `action_required`: GitHub does not count
 * it as passing for a required check, and it tells a person to look. `neutral` is deliberately
 * unused, because a required check accepts it as a pass.
 */
export function conclusionOf(outcome: ReviewOutcome): CheckConclusion {
  if (outcome.kind !== "reported") return "action_required";
  const v = verdictOf(outcome.report);
  return v === "pass" ? "success" : v === "fail" ? "failure" : "action_required";
}

const CRITERION_LABEL: Record<Criterion, string> = {
  no_degradation: "Nothing is lost or broken",
  advances_revision: "The revision advances",
  material_improvement: "The dataset is materially better",
};

const RESULT_WORD: Record<CriterionResult, string> = {
  pass: "Yes",
  fail: "No",
  unknown: "Could not tell",
};

const DECLINE_COPY: Record<DeclineReason, string> = {
  contributor_paused:
    "Automated review is paused for this contributor because too many of their earlier pull requests were rejected. A maintainer needs to review this one by hand.",
  rate_limited:
    "Automated review is rate limited for this contributor right now. Push again later, or ask a maintainer to review it by hand.",
  daily_limit:
    "The daily limit of automated reviews was reached. A maintainer needs to review this one by hand.",
};

const ERROR_COPY: Record<RunError, string> = {
  evidence_unavailable: "The changes could not be read.",
  stale_head: "The pull request changed while the review was starting. Push again to re-run it.",
  too_large: "The change is too large for automated review. A maintainer needs to review it.",
  auth_failed:
    "The review service could not sign in. A maintainer has been notified by this check.",
  model_unavailable: "The reviewing model was unavailable.",
  model_refused: "The reviewing model declined to review this change.",
  model_truncated: "The reviewing model ran out of room before it finished.",
  model_invalid: "The reviewing model did not return a usable review.",
  report_invalid: "The review could not be read back.",
  workflow_failed: "The review job failed before it finished.",
};

const CODE_LABEL: Record<FindingCode, string> = {
  data_removed: "Data removed",
  metadata_removed: "Metadata removed",
  structure_broken: "Dataset structure broken",
  validation_regressed: "Validation regressed",
  version_not_advanced: "Version not advanced",
  changes_log_missing: "CHANGES entry missing",
  changes_log_mismatch: "CHANGES entry does not match the change",
  description_mismatch: "Description does not match the change",
  churn_only: "Formatting or churn only",
  no_substantive_change: "No substantive change",
  improvement_unclear: "Improvement unclear",
  evidence_incomplete: "Evidence incomplete",
  steering_attempt: "Text in the pull request tried to instruct the reviewer",
  other: "Other",
};

export interface RenderedCheck {
  title: string;
  summary: string;
  text: string;
}

const FOOTER =
  "An automated review of the changes in this pull request. It does not replace a maintainer, " +
  "and a maintainer's approval is what merges it.";

const AREA_LABEL: Record<Area, string> = {
  dataset_description: "Dataset description",
  readme_and_changes: "README and CHANGES",
  participants: "Participants",
  sidecars: "Sidecars and tables",
  recordings: "Recordings and data files",
  derivatives: "Derivatives",
  sourcedata: "Source data",
  code: "Code",
  other: "Other files",
};

const STATUS_WORD: Record<ChangeStatus, string> = {
  added: "added",
  modified: "changed",
  removed: "removed",
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The account of what changed: a table of counts per area, the version and subject change, and
 * how much of it the model actually read. Computed from git, so it is the same whatever the model
 * said, and it accounts for every changed file.
 */
export function describeChanges(e: ReviewEvidence): string[] {
  const out: string[] = ["**What changed**", ""];
  if (e.files_changed === 0) {
    out.push("No files changed.", "");
    return out;
  }
  out.push("| Area | Added | Changed | Removed |", "| --- | ---: | ---: | ---: |");
  for (const a of AREAS) {
    const c = e.areas[a];
    if (c.added + c.modified + c.removed === 0) continue;
    out.push(`| ${AREA_LABEL[a]} | ${c.added} | ${c.modified} | ${c.removed} |`);
  }
  out.push("");
  const facts: string[] = [];
  if (e.version_before !== null || e.version_after !== null) {
    facts.push(`Version ${e.version_before ?? "unknown"} to ${e.version_after ?? "unknown"}.`);
  }
  if (e.subjects_before !== null || e.subjects_after !== null) {
    facts.push(`Subjects ${e.subjects_before ?? "unknown"} to ${e.subjects_after ?? "unknown"}.`);
  }
  facts.push(
    e.files_read === e.files_changed
      ? `The content of all ${plural(e.files_changed, "changed file", "changed files")} was read.`
      : `The content of ${e.files_read} of ${plural(e.files_changed, "changed file", "changed files")} was read. The rest were judged by name and type only, because recordings and other data files are stored outside git.`,
  );
  out.push(facts.join(" "), "");
  return out;
}

function listChangedFiles(e: ReviewEvidence): string {
  if (e.listed.length === 0) return "";
  const rows = e.listed.map((f) =>
    f.path
      ? `- ${STATUS_WORD[f.status]} \`${f.path}\``
      : `- ${STATUS_WORD[f.status]} (name not shown)`,
  );
  const hidden = e.files_changed - e.listed.length;
  const more =
    hidden > 0 ? `\n- and ${plural(hidden, "more file", "more files")}, counted above` : "";
  return `<details><summary>Changed files (${e.listed.length} of ${e.files_changed})</summary>\n\n${rows.join("\n")}${more}\n\n</details>`;
}

/** Render the check-run's title, summary and detail from an outcome. Pure; no input is quoted raw. */
export function renderCheck(outcome: ReviewOutcome): RenderedCheck {
  if (outcome.kind === "declined") {
    return {
      title: "Not reviewed",
      summary: DECLINE_COPY[outcome.reason],
      text: FOOTER,
    };
  }
  if (outcome.kind === "error") {
    return {
      title: "Could not decide",
      summary: ERROR_COPY[outcome.error],
      text: `${FOOTER}\n\nNo verdict was reached, so this check does not pass.`,
    };
  }
  if (outcome.kind === "unreported") {
    return {
      title: "Could not decide",
      summary: "The review did not finish in time. Push again to re-run it.",
      text: `${FOOTER}\n\nNo verdict was reached, so this check does not pass.`,
    };
  }

  const { report } = outcome;
  const verdict = verdictOf(report);
  const criteria = effectiveCriteria(report);
  const title =
    verdict === "pass"
      ? "Passes: nothing lost, revision advances, materially better"
      : verdict === "fail"
        ? "Needs changes"
        : "Could not decide";
  const lines: string[] = [];
  if (report.summary) lines.push(report.summary, "");
  lines.push(...describeChanges(report.evidence));
  lines.push("| Question | Answer |", "| --- | --- |");
  for (const c of CRITERIA) lines.push(`| ${CRITERION_LABEL[c]} | ${RESULT_WORD[criteria[c]]} |`);
  const details: string[] = [];
  if (report.steering) {
    details.push(`- **${CODE_LABEL.steering_attempt}.** The review fails for that alone.`);
  }
  for (const f of report.findings) {
    const where = f.path ? ` (\`${f.path}\`)` : "";
    const note = f.note ? `: ${f.note}` : "";
    details.push(`- **${CODE_LABEL[f.code]}**${where}, ${f.severity}${note}`);
  }
  if (report.evidence.truncated) {
    details.push("- Part of the change was too large to read, so a clean result is not claimed.");
  }
  const text = [
    details.length ? `### Findings\n\n${details.join("\n")}` : "No findings.",
    listChangedFiles(report.evidence),
    FOOTER,
    `Reviewed with ${report.model}.`,
  ]
    .filter((x) => x !== "")
    .join("\n\n");
  return { title, summary: lines.join("\n"), text };
}

/**
 * The hidden marker on the review's pull-request comment. The Worker finds its own comment by it
 * and edits it in place on every new commit, so a pull request carries one review comment, not
 * one per push.
 */
export const PR_REVIEW_COMMENT_MARKER = "<!-- nemar-pr-review:v1 -->";

const SHA7 = /^[0-9a-f]{7,40}$/;

/**
 * The pull-request comment: the same words as the check-run, led by the marker and the commit it
 * is about. `headSha` is validated here (a malformed value is left out rather than quoted).
 */
export function renderComment(outcome: ReviewOutcome, headSha: string): string {
  const { title, summary, text } = renderCheck(outcome);
  const conclusion = conclusionOf(outcome);
  const badge =
    conclusion === "success"
      ? "PASS"
      : conclusion === "failure"
        ? "NEEDS CHANGES"
        : "NEEDS A PERSON";
  const commit = SHA7.test(headSha) ? ` on commit \`${headSha.slice(0, 7)}\`` : "";
  return [
    PR_REVIEW_COMMENT_MARKER,
    `## NEMAR PR review: ${badge}`,
    `**${title}**${commit}`,
    summary,
    text,
  ].join("\n\n");
}

// ---------------------------------------------------------------------------------------------
// Who gets reviewed: the contributor tally and the rate caps.
// ---------------------------------------------------------------------------------------------

/**
 * Automated review is paused for a contributor once MORE THAN this many of their pull requests
 * were rejected AND those rejections are MORE THAN {@link REJECTION_PERCENT} percent of the pull
 * requests that got a decision. Both must hold, so the later of the two thresholds decides: a
 * newcomer's first failure never pauses anyone, and a prolific contributor with a few failures
 * among hundreds of accepted pull requests is not paused either.
 */
export const REJECTION_COUNT = 5;
export const REJECTION_PERCENT = 10;

export interface AuthorTally {
  /** Distinct pull requests whose latest decided review was a fail. */
  rejected: number;
  /** Distinct pull requests that have at least one decided (pass or fail) review. */
  decided: number;
}

/** A maintainer's standing decision about one contributor. Wins over the tally in both directions. */
export type AuthorOverride = "allow" | "block" | null;

export type Standing = { paused: false } | { paused: true; because: "maintainer" | "tally" };

export function standingOf(tally: AuthorTally, override: AuthorOverride): Standing {
  if (override === "allow") return { paused: false };
  if (override === "block") return { paused: true, because: "maintainer" };
  // Integer arithmetic: rejected / decided > 10 / 100  <=>  rejected * 100 > decided * 10.
  if (
    tally.decided > 0 &&
    tally.rejected > REJECTION_COUNT &&
    tally.rejected * 100 > tally.decided * REJECTION_PERCENT
  ) {
    return { paused: true, because: "tally" };
  }
  return { paused: false };
}

/** GitHub's `author_association` values that mark someone with a standing relationship to the repository. */
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * Reviews one contributor may start per hour. Strangers (a fork from an account with no
 * relationship to the dataset) get a small allowance: any GitHub user can open a pull request
 * on a public dataset, and each review costs money.
 */
export const HOURLY_REVIEW_CAP = { trusted: 20, other: 3 } as const;

/** Reviews the whole platform starts per day, a ceiling on spend whatever else is true. */
export const DAILY_REVIEW_CAP = 400;

export function hourlyCapFor(authorAssociation: string | null | undefined): number {
  return authorAssociation && TRUSTED_ASSOCIATIONS.has(authorAssociation)
    ? HOURLY_REVIEW_CAP.trusted
    : HOURLY_REVIEW_CAP.other;
}
