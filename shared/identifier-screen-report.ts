/**
 * The identifier screen's report: one shape, written by the workflow that screens a dataset at
 * publication time, validated by the Worker before it stores a byte, and read back by the admin
 * email, the status views and the approval gate.
 *
 * **A report carries no value.** It holds closed-set kinds, counts, field names the scanner draws
 * from a closed set, and a few fixed words. The parser is the enforcement: it accepts only keys it
 * knows, only kinds in {@link FINDING_KINDS}, only numbers that are non-negative integers, and
 * only strings that match a narrow pattern, so a workflow that was changed to print a header's
 * text into its report is refused at the door rather than stored, mailed and shown. The parser
 * throws a fixed-word {@link ReportError}; it never quotes the input.
 *
 * **Unknown is never healthy** (ADR 0053). {@link screenGate} maps every state to what the
 * publication may do next, and a screen that did not run, did not finish or did not report is its
 * own state with its own answer, never "clean" and never "no findings".
 */

import type { FindingKind } from "./identifier-scan";

export const REPORT_VERSION = 1;

/** Every finding kind. A `Record` over the union, so adding a kind to the scanner fails the build here. */
const KIND_TABLE: Record<FindingKind, true> = {
  "edf-unreadable": true,
  "edf-patient-nonascii": true,
  "edf-recording-nonascii": true,
  "path-subject-label": true,
  "edf-patient-name": true,
  "edf-patient-code": true,
  "edf-patient-recordnumber": true,
  "edf-patient-age": true,
  "edf-patient-freetext": true,
  "edf-patient-birthdate": true,
  "edf-recording-startdate": true,
  "edf-recording-freetext": true,
  "edf-recording-technician": true,
  "edf-startdate": true,
  "edf-startdate-unparsed": true,
  "participants-identifier-column": true,
  "json-identifier-key": true,
  "acq-time-dated": true,
  "image-or-document-file": true,
  "tooling-debris": true,
  "local-user-path": true,
};
export const FINDING_KINDS: readonly FindingKind[] = Object.keys(KIND_TABLE) as FindingKind[];
const KIND_SET: ReadonlySet<string> = new Set(FINDING_KINDS);

/** What the scanner concluded about a dataset. */
export const DATASET_STATUSES = [
  "direct-identifiers",
  "dates-only",
  "review",
  "clean",
  "clean-edf-only-others-unscreened",
  "not-screened",
  "no-recordings",
  "unchecked",
] as const;
export type DatasetStatus = (typeof DATASET_STATUSES)[number];

export type ManifestSource = "manifest.json" | "s3-version-manifest" | "git-tree" | "clone";
const MANIFEST_SOURCES: ReadonlySet<string> = new Set([
  "manifest.json",
  "s3-version-manifest",
  "git-tree",
  "clone",
]);

export interface SamplingStat {
  candidates: number;
  oversize: number;
  selected: number;
  scanned: number;
}

/** One dataset's scan: what the fleet scan writes per dataset and the publication screen sends. */
export interface DatasetRecord {
  id: string;
  version: string | null;
  scanned_at: string;
  status: DatasetStatus;
  incomplete: boolean;
  incomplete_reasons: string[];
  manifest_source?: ManifestSource;
  files?: { total: number; edf_bdf: number; header_read: number; header_read_failed: number };
  sampling?: Record<"edf_headers" | "scans_tables" | "json_files" | "text_files", SamplingStat>;
  read_failures?: Record<string, number>;
  edf_bdf_files_flagged?: number;
  distinct_patient_field_values?: number;
  distinct_subjects_with_edf_bdf?: number;
  distinct_patient_code_subfield?: number;
  distinct_patient_name_subfield?: number;
  distinct_patient_birth_subfield?: number;
  distinct_patient_field_values_in_flagged_files?: number;
  findings_by_kind?: Partial<Record<FindingKind, number>>;
  edf_bdf_files_by_kind?: Partial<Record<FindingKind, number>>;
  unscreened_formats?: Record<string, number>;
  side_reads_failed?: number;
  finding_fields?: string[];
}

/** Why a screen produced no scan. Fixed words; the first four are set by the Worker, the rest by the workflow. */
export const SCREEN_ERRORS = [
  "dispatch-unconfigured",
  "dispatch-failed",
  "no-report-in-time",
  "workflow-failed",
  "clone-failed",
  "credentials-missing",
  "deadline",
] as const;
export type ScreenError = (typeof SCREEN_ERRORS)[number];
const ERROR_SET: ReadonlySet<string> = new Set(SCREEN_ERRORS);

/** What the workflow posts. Exactly one of `scan` and `error`. */
export interface ScreenReport {
  version: typeof REPORT_VERSION;
  /**
   * `identifier-scan@<revision>` of the scanner that ran; null only on an error report, where
   * the workflow failed before (or without) knowing which scanner it had.
   */
  scanner: string | null;
  /** The commit of the dataset's `main` that was screened; null when the screen never got that far. */
  head: string | null;
  scan?: DatasetRecord;
  error?: ScreenError;
}

/** The state a publication request is in with respect to its screen. */
export type ScreenState = "pending" | DatasetStatus | "error" | "unreported";

export class ReportError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "ReportError";
  }
}

function bad(code: string): never {
  throw new ReportError(code);
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const isCount = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 0;

function onlyKeys(x: Record<string, unknown>, allowed: readonly string[], code: string): void {
  for (const key of Object.keys(x)) if (!allowed.includes(key)) bad(code);
}

/** A map of closed words to counts. */
function countMap(x: unknown, accepts: (key: string) => boolean, max: number, code: string) {
  if (!isObject(x) || Object.keys(x).length > max) bad(code);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(x as Record<string, unknown>)) {
    if (!accepts(key) || !isCount(value)) bad(code);
    out[key] = value as number;
  }
  return out;
}

const FORMAT_KEY = /^(\.[a-z0-9]{1,12}(\.[a-z0-9]{1,12})?\/?|\(no extension\))$/;
const REASON = /^[a-z][a-z0-9-]{0,47}$/;
const FAILURE_KEY = /^[a-z_]{1,16}\/[a-z0-9-]{1,48}$/;
const SCANNER = /^identifier-scan@[0-9a-f]{7,40}$/;
const HEAD = /^[0-9a-f]{40}$/;
const DATASET_ID = /^(nm|on|xx)\d{6}$/;
const FIELD = /^[a-z][a-z0-9-]*:[A-Za-z0-9_. ()-]{1,48}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function parseRecord(x: unknown): DatasetRecord {
  if (!isObject(x)) return bad("scan-shape");
  onlyKeys(
    x,
    [
      "id",
      "version",
      "scanned_at",
      "status",
      "incomplete",
      "incomplete_reasons",
      "manifest_source",
      "files",
      "sampling",
      "read_failures",
      "edf_bdf_files_flagged",
      "distinct_patient_field_values",
      "distinct_subjects_with_edf_bdf",
      "distinct_patient_code_subfield",
      "distinct_patient_name_subfield",
      "distinct_patient_birth_subfield",
      "distinct_patient_field_values_in_flagged_files",
      "findings_by_kind",
      "edf_bdf_files_by_kind",
      "unscreened_formats",
      "side_reads_failed",
      "finding_fields",
    ],
    "scan-key",
  );
  if (typeof x.id !== "string" || !DATASET_ID.test(x.id)) bad("scan-id");
  if (
    x.version !== null &&
    !(typeof x.version === "string" && /^v?\d+\.\d+\.\d+$/.test(x.version))
  ) {
    bad("scan-version");
  }
  if (typeof x.scanned_at !== "string" || !ISO_TIME.test(x.scanned_at)) bad("scan-time");
  if (!(DATASET_STATUSES as readonly string[]).includes(x.status as string)) bad("scan-status");
  if (typeof x.incomplete !== "boolean") bad("scan-incomplete");
  if (
    !Array.isArray(x.incomplete_reasons) ||
    x.incomplete_reasons.length > 40 ||
    !x.incomplete_reasons.every((r) => typeof r === "string" && REASON.test(r))
  ) {
    bad("scan-reasons");
  }
  const out: Record<string, unknown> = {
    id: x.id,
    version: x.version,
    scanned_at: x.scanned_at,
    status: x.status,
    incomplete: x.incomplete,
    incomplete_reasons: x.incomplete_reasons,
  };
  if (x.manifest_source !== undefined) {
    if (typeof x.manifest_source !== "string" || !MANIFEST_SOURCES.has(x.manifest_source)) {
      bad("scan-source");
    }
    out.manifest_source = x.manifest_source;
  }
  if (x.files !== undefined) {
    const f = x.files;
    if (!isObject(f)) bad("scan-files");
    const files = f as Record<string, unknown>;
    onlyKeys(files, ["total", "edf_bdf", "header_read", "header_read_failed"], "scan-files");
    for (const k of ["total", "edf_bdf", "header_read", "header_read_failed"]) {
      if (!isCount(files[k])) bad("scan-files");
    }
    out.files = files;
  }
  if (x.sampling !== undefined) {
    const s = x.sampling;
    if (!isObject(s)) bad("scan-sampling");
    const sampling = s as Record<string, unknown>;
    const names = ["edf_headers", "scans_tables", "json_files", "text_files"];
    onlyKeys(sampling, names, "scan-sampling");
    for (const name of names) {
      const stat = sampling[name];
      if (!isObject(stat)) bad("scan-sampling");
      const st = stat as Record<string, unknown>;
      onlyKeys(st, ["candidates", "oversize", "selected", "scanned"], "scan-sampling");
      for (const k of ["candidates", "oversize", "selected", "scanned"]) {
        if (!isCount(st[k])) bad("scan-sampling");
      }
    }
    out.sampling = sampling;
  }
  if (x.read_failures !== undefined) {
    out.read_failures = countMap(x.read_failures, (k) => FAILURE_KEY.test(k), 60, "scan-failures");
  }
  for (const k of [
    "edf_bdf_files_flagged",
    "distinct_patient_field_values",
    "distinct_subjects_with_edf_bdf",
    "distinct_patient_code_subfield",
    "distinct_patient_name_subfield",
    "distinct_patient_birth_subfield",
    "distinct_patient_field_values_in_flagged_files",
    "side_reads_failed",
  ]) {
    if (x[k] !== undefined) {
      if (!isCount(x[k])) bad("scan-count");
      out[k] = x[k];
    }
  }
  for (const k of ["findings_by_kind", "edf_bdf_files_by_kind"]) {
    if (x[k] !== undefined) out[k] = countMap(x[k], (key) => KIND_SET.has(key), 40, "scan-kinds");
  }
  if (x.unscreened_formats !== undefined) {
    out.unscreened_formats = countMap(
      x.unscreened_formats,
      (k) => FORMAT_KEY.test(k),
      60,
      "scan-formats",
    );
  }
  if (x.finding_fields !== undefined) {
    if (
      !Array.isArray(x.finding_fields) ||
      x.finding_fields.length > 60 ||
      !x.finding_fields.every((f) => typeof f === "string" && FIELD.test(f))
    ) {
      bad("scan-fields");
    }
    out.finding_fields = x.finding_fields;
  }
  return out as unknown as DatasetRecord;
}

/** Validate a report from the wire. Throws {@link ReportError} with a fixed word, never the input. */
export function parseScreenReport(x: unknown): ScreenReport {
  if (!isObject(x)) return bad("report-shape");
  onlyKeys(x, ["version", "scanner", "head", "scan", "error"], "report-key");
  if (x.version !== REPORT_VERSION) bad("report-version");
  if (x.scanner !== null && !(typeof x.scanner === "string" && SCANNER.test(x.scanner))) {
    bad("report-scanner");
  }
  if (x.head !== null && !(typeof x.head === "string" && HEAD.test(x.head))) bad("report-head");
  const hasScan = x.scan !== undefined;
  const hasError = x.error !== undefined;
  if (hasScan === hasError) bad("report-outcome");
  const report: ScreenReport = {
    version: REPORT_VERSION,
    scanner: x.scanner as string | null,
    head: x.head as string | null,
  };
  if (hasScan) {
    // A scan is a scan OF a commit: a report that claims findings about no commit cannot be
    // matched to the content it describes, so the approval gate could never tell it was stale.
    if (x.head === null) bad("report-head");
    if (x.scanner === null) bad("report-scanner");
    report.scan = parseRecord(x.scan);
  } else {
    if (typeof x.error !== "string" || !ERROR_SET.has(x.error)) bad("report-error");
    report.error = x.error as ScreenError;
  }
  return report;
}

/** The state a stored report puts a request in. */
export function stateOf(report: ScreenReport): ScreenState {
  return report.scan ? report.scan.status : "error";
}

/**
 * What a screen state allows the publication to do.
 *
 * - `clear`: nothing to act on; the request goes to the admin as it is.
 * - `blocks`: a direct identifier. The request is blocked; there is no acknowledgment, the data is
 *   fixed and the screen run again.
 * - `acknowledge`: the screen found something a person must look at, or could not look at
 *   everything. An admin may approve with a recorded reason.
 * - `rerun`: the screen did not produce a verdict (did not run, did not finish, did not report, or
 *   was never started for this request). Approval waits for a run that does.
 * - `wait`: a run is in flight.
 */
export type ScreenGate = "clear" | "blocks" | "acknowledge" | "rerun" | "wait";

export function screenGate(state: ScreenState | null): ScreenGate {
  switch (state) {
    case "clean":
    case "dates-only":
    case "no-recordings":
      return "clear";
    case "direct-identifiers":
      return "blocks";
    case "review":
    case "unchecked":
    case "not-screened":
    case "clean-edf-only-others-unscreened":
      return "acknowledge";
    case "pending":
      return "wait";
    default:
      // "error", "unreported" and null (a request that predates the screen). Unknown is not
      // healthy, so none of them is clear.
      return "rerun";
  }
}

/** Is this stored value a state at all? The column is TEXT, so a read must not trust it. */
export function isScreenState(x: unknown): x is ScreenState {
  return (
    x === "pending" ||
    x === "error" ||
    x === "unreported" ||
    (DATASET_STATUSES as readonly string[]).includes(x as string)
  );
}

export interface ScreenDescription {
  /** One line, safe for a subject line or a table cell. */
  headline: string;
  /** How loudly to say it. */
  tone: "ok" | "note" | "warn" | "stop";
  /** Counts and fixed words, one per line. Never a value. */
  lines: string[];
}

const ERROR_TEXT: Record<ScreenError, string> = {
  "dispatch-unconfigured":
    "the Worker had no GitHub credential or callback secret, so the screen was never started",
  "dispatch-failed": "GitHub refused to start the screen workflow",
  "no-report-in-time": "the screen workflow started but never reported back",
  "workflow-failed": "the screen workflow failed before it produced a result",
  "clone-failed": "the screen workflow could not read the dataset repository",
  "credentials-missing":
    "the screen workflow had no storage credentials, so it could not read headers",
  deadline: "the screen workflow ran out of time before it finished reading",
};

const HEADLINES: Record<ScreenState, { headline: string; tone: ScreenDescription["tone"] }> = {
  pending: { headline: "Identifier screen: running", tone: "note" },
  clean: { headline: "Identifier screen: clean", tone: "ok" },
  "dates-only": { headline: "Identifier screen: clean (acquisition dates only)", tone: "ok" },
  "no-recordings": { headline: "Identifier screen: clean (no recordings)", tone: "ok" },
  review: { headline: "Identifier screen: needs review", tone: "warn" },
  "direct-identifiers": { headline: "Identifier screen: FOUND IDENTIFIERS", tone: "stop" },
  unchecked: { headline: "Identifier screen: INCOMPLETE", tone: "warn" },
  "not-screened": { headline: "Identifier screen: recordings NOT screened", tone: "warn" },
  "clean-edf-only-others-unscreened": {
    headline: "Identifier screen: EDF/BDF clean, other recordings NOT screened",
    tone: "warn",
  },
  error: { headline: "Identifier screen: DID NOT RUN", tone: "stop" },
  unreported: { headline: "Identifier screen: DID NOT REPORT", tone: "stop" },
};

/**
 * The words that go in front of a person. One function for the admin email, the status view and
 * the CLI, so the three cannot disagree about what a state means.
 */
export function describeScreen(
  state: ScreenState | null,
  report: ScreenReport | null,
): ScreenDescription {
  if (state === null) {
    return {
      headline: "Identifier screen: NOT RUN for this request",
      tone: "stop",
      lines: ["This request predates the screen, or the screen was never started for it."],
    };
  }
  const base = HEADLINES[state];
  const lines: string[] = [];
  // The Worker stores an 'unreported' screen WITH the error report that says so
  // (`no-report-in-time`), so the cause is stated once, from the report, when
  // there is one; the state's own cause is only for a caller with no report.
  if (state === "unreported" && !report?.error) {
    lines.push(`Cause: ${ERROR_TEXT["no-report-in-time"]}.`);
  }
  if (report?.error) lines.push(`Cause: ${ERROR_TEXT[report.error]}.`);
  const scan = report?.scan;
  if (scan) {
    if (scan.files) {
      const unreadable =
        scan.files.header_read_failed > 0 ? ` (${scan.files.header_read_failed} unreadable)` : "";
      lines.push(
        `Files: ${scan.files.total}; EDF/BDF headers read: ${scan.files.header_read} of ${scan.files.edf_bdf}${unreadable}.`,
      );
    }
    const kinds = Object.entries(scan.findings_by_kind ?? {});
    if (kinds.length > 0) {
      lines.push(`Findings by kind: ${kinds.map(([k, n]) => `${k} x${n}`).join(", ")}.`);
    }
    if (scan.edf_bdf_files_flagged) {
      lines.push(`EDF/BDF files with an identifier finding: ${scan.edf_bdf_files_flagged}.`);
    }
    const formats = Object.entries(scan.unscreened_formats ?? {});
    if (formats.length > 0) {
      lines.push(
        `Not screened (format x files): ${formats.map(([f, n]) => `${f} x${n}`).join(", ")}.`,
      );
    }
    if (scan.incomplete_reasons.length > 0) {
      lines.push(`Incomplete: ${scan.incomplete_reasons.join(", ")}.`);
    }
    lines.push(`Scanner ${report.scanner}; commit ${report.head?.slice(0, 12)}.`);
  }
  return { headline: base.headline, tone: base.tone, lines };
}
