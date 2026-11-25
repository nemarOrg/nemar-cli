/**
 * Batch acknowledgment of identifier screens on a confirmed public upstream (epic #2182, card D3;
 * ADR 0086, amendment 2026-11-25).
 *
 * An administrator acknowledges, in one act, the screens of the queued requests that are
 * conversions of a public, redistributable upstream dataset. The acknowledgment covers only formats
 * the scanner does not read and image, document or tooling files; everything else stays for
 * individual review. This file holds the one eligibility rule, the recorded reason and the copy
 * table every outcome prints from; the route (`POST /admin/publish/acknowledge-batch`) and the
 * command (`nemar admin dataset publish acknowledge-batch`) only call it.
 *
 * Pure: no network, no database. The route reads the facts and passes them in.
 */

import type { FindingKind } from "./identifier-scan";
import type { ScreenReport } from "./identifier-screen-report";
import { EXCLUDED_NAME_CLASSES, excludedImageCount } from "./image-name-class";
import {
  type Copy,
  type LineageOutcome,
  type LineageResult,
  type LineageSource,
  RESOLVER_READ,
  type Resolver,
} from "./license-lineage";
import { ACKNOWLEDGMENT_MAX_LENGTH } from "./publication-limits";

/** The docs page the policy section and every outcome link to (A10 publishes the section). */
export const UPSTREAM_ACK_DOCS_URL = "https://docs.nemar.org/platform/identifier-screening/";

/** The one anchor this file links to, on {@link UPSTREAM_ACK_DOCS_URL}. */
export const UPSTREAM_ACK_ANCHOR = "public-upstream-acknowledgment";

const POLICY_URL = `${UPSTREAM_ACK_DOCS_URL}#${UPSTREAM_ACK_ANCHOR}`;

/**
 * The most requests one call of the route reads or records. Twenty, not the hundred first planned,
 * because of the Worker's per-invocation subrequest budget (1,000): each request that passes the
 * database checks costs about eight GitHub calls (the main ref, the screened tree, the description,
 * up to four README names, the enrichment) plus the registry records its lineage names (up to
 * ten, cached per DOI), so twenty stays well inside the budget and a hundred might not.
 */
export const ACK_BATCH_MAX = 20;

/**
 * The screen states a batch acknowledgment may cover. `partially-screened` is the coverage state
 * card A1 adds; it is listed by name so the rule covers it when A1 lands, and matches nothing
 * before. `review` is eligible only with {@link ACK_ELIGIBLE_KINDS} findings and nothing else.
 */
export const ACK_ELIGIBLE_STATES: ReadonlySet<string> = new Set([
  "not-screened",
  "partially-screened",
  "clean-edf-only-others-unscreened",
  "review",
]);

/** The only finding kinds a batch acknowledgment covers. Any other kind is never acknowledged here. */
export const ACK_ELIGIBLE_KINDS: ReadonlySet<FindingKind> = new Set<FindingKind>([
  "image-or-document-file",
  "tooling-debris",
]);

/**
 * The lineage outcomes that count as a public, redistributable upstream. Written out rather than
 * borrowed from `COMPATIBLE_OUTCOMES`, so a change to the license-check's exit codes cannot widen
 * what is acknowledged.
 */
export const ACK_LINEAGE_OUTCOMES: ReadonlySet<LineageOutcome> = new Set<LineageOutcome>([
  "compatible",
  "compatible_attribution",
  "compatible_nc",
]);

/**
 * The resolvers that read a license from the source's own record (the repository that holds the
 * data), as opposed to an index of publications (Crossref, OpenAlex).
 */
export const OWN_RECORD_RESOLVERS: ReadonlySet<Resolver> = new Set<Resolver>([
  "datacite",
  "openneuro",
  "physionet",
]);

export { EXCLUDED_NAME_CLASSES };

/** Why a request is not eligible. Each has its entry in {@link UPSTREAM_ACK_COPY}. */
export const NOT_ELIGIBLE_REASONS = [
  "no_request",
  "not_requested",
  "exempt",
  "already_acknowledged",
  "no_screen",
  "screen_state",
  "finding_kind",
  "screen_incomplete",
  "screen_stale",
  "head_unverified",
  "tree_unreadable",
  "excluded",
  "photo_file",
  "not_measured",
  "lineage_unreadable",
  "lineage_outcome",
  "lineage_no_own_record",
  "reason_too_long",
  "evaluation_failed",
] as const;
export type NotEligibleReason = (typeof NOT_ELIGIBLE_REASONS)[number];

/** Every per-request outcome the route reports. */
export type AckOutcome =
  | "eligible"
  | "acknowledged"
  | "state_moved"
  | `not_eligible:${NotEligibleReason}`;

/** The route's refusals, the command's own sentences, and the "never" line its help prints. */
export const UPSTREAM_ACK_MESSAGES = [
  "never-acknowledged",
  "error:invalid_body",
  "error:exclusions_unreadable",
  "error:github_unavailable",
  "cli:selection",
  "cli:ids_unreadable",
  "cli:nothing_recorded",
  "cli:failed",
] as const;
export type UpstreamAckMessage = (typeof UPSTREAM_ACK_MESSAGES)[number];

/** Every entry of the copy table: the policy section, each outcome, and each message. */
export type UpstreamAckEntry = typeof UPSTREAM_ACK_ANCHOR | AckOutcome | UpstreamAckMessage;

const ack = (statement: string, read: string, remedy: string): Copy => ({
  statement,
  read,
  remedy,
  anchor: POLICY_URL,
});

const READ_SCREEN =
  "The request's status, its stored identifier screen (state, finding kinds, unread formats, completeness and screened commit) and its recorded acknowledgment.";
const READ_HEAD = "The screened commit against the dataset repository's current main branch.";
const READ_TREE =
  "The full file list of the screened commit (one recursive tree listing), each image or document file's name classed by the same rule as the measurement.";
const READ_D2 =
  "The publication-queue measurement of 2026-11-25 (d2-blockers.json): the name classes of each request's image and document files.";
const READ_LINEAGE = `The dataset's license lineage, by the resolver nemar dataset license-check runs. ${Object.values(
  RESOLVER_READ,
).join(" ")}`;
const INDIVIDUAL =
  "Review the request individually: nemar admin dataset publish show <dataset-id>.";

/**
 * The copy table (ADR 0045's pattern): what each outcome means, what was read, what to do, and the
 * docs anchor. A `Record` over the union, so an outcome without an entry fails the typecheck.
 */
export const UPSTREAM_ACK_COPY: Record<UpstreamAckEntry, Copy> = {
  "public-upstream-acknowledgment": ack(
    "An administrator may acknowledge many identifier screens in one act when each request is a conversion of a public, redistributable upstream dataset whose license NEMAR read from the source's own record (DataCite, OpenNeuro or PhysioNet). Such an acknowledgment covers only formats the scanner does not read and image, document or tooling files. A content finding, a direct identifier, an unchecked, incomplete or stale screen, or a request holding a photo, face or questionnaire file or a BIDS photograph is never acknowledged this way. Each acknowledgment records a reason naming the upstream, its license and the unread formats, and is the calling administrator's own act: it satisfies that administrator's approval and no other's. The weekly re-screen reads these datasets again as readers are added.",
    `${READ_SCREEN} ${READ_HEAD} ${READ_TREE} ${READ_D2} ${READ_LINEAGE}`,
    "Nothing to do for an acknowledged request: approve it as usual. A request this does not cover is reviewed individually.",
  ),
  "never-acknowledged": ack(
    "Never acknowledged in a batch: a direct identifier; any finding other than image, document or tooling files (a content finding, an EDF/BDF header finding, a flagged EDF/BDF file); an unchecked, incomplete or stale screen, or one with a failed side read; a request holding a photo, face or questionnaire file or a BIDS photograph; an upstream whose license was not read from its own record.",
    `${READ_SCREEN} ${READ_TREE} ${READ_D2} ${READ_LINEAGE}`,
    "Review those requests individually: nemar admin dataset publish show <dataset-id>.",
  ),
  "error:invalid_body": ack(
    "The request body is not one this route accepts, so nothing was evaluated.",
    "The request body.",
    "Send a dry run with dataset_ids (1 to 20) or all_requested, or an apply with the expect entries a dry run reported eligible.",
  ),
  "error:exclusions_unreadable": ack(
    "The list of requests excluded by the publication-queue measurement could not be read, so nothing was evaluated.",
    READ_D2,
    "Report it to the maintainers; the generated exclusion module is out of step with its source.",
  ),
  "error:github_unavailable": ack(
    "No GitHub credential was available, so nothing was evaluated.",
    "The Worker's GitHub credential.",
    "Try again later.",
  ),
  "cli:selection": ack(
    "Give one of --all-requested or --ids <file>.",
    "The command's options.",
    "Run it again with exactly one selection.",
  ),
  "cli:ids_unreadable": ack(
    "The --ids file could not be read as dataset ids.",
    "The --ids file: one dataset id per line, blank lines and # comments skipped.",
    "Fix the line named and run again.",
  ),
  "cli:nothing_recorded": ack(
    "Nothing was recorded. Run again with --apply to record.",
    "The dry run only.",
    "Read the dry run, then run the same selection with --apply.",
  ),
  "cli:failed": ack(
    "The batch acknowledgment did not complete.",
    "The API's answer.",
    "Run the dry run again; what was recorded before the failure is reported by the next dry run as already acknowledged.",
  ),
  eligible: ack(
    "The request meets every condition of a batch acknowledgment; a run with --apply records one.",
    `${READ_SCREEN} ${READ_HEAD} ${READ_TREE} ${READ_D2} ${READ_LINEAGE}`,
    "Run the same selection again with --apply to record the acknowledgment as your own act.",
  ),
  acknowledged: ack(
    "The acknowledgment was recorded as your own act, with the reason shown, and written to the audit log with the lineage it rests on.",
    `${READ_SCREEN} ${READ_HEAD} ${READ_TREE} ${READ_D2} ${READ_LINEAGE}`,
    "Approve the request as usual; the acknowledgment counts for your approval only.",
  ),
  state_moved: ack(
    "The request or its screen changed after the dry run read it, so nothing was recorded for it.",
    READ_SCREEN,
    "Run the dry run again and read what it reports before applying.",
  ),
  "not_eligible:no_request": ack(
    "The dataset has no publication request awaiting an administrator.",
    "The dataset's publication requests.",
    "Nothing to acknowledge.",
  ),
  "not_eligible:not_requested": ack(
    "The request is not awaiting an administrator (it is blocked, approving, published or denied).",
    "The request's status.",
    "Nothing to acknowledge until the request is awaiting an administrator again.",
  ),
  "not_eligible:exempt": ack(
    "The dataset is a sandbox dataset, which is not screened.",
    "The dataset id.",
    "Nothing to acknowledge.",
  ),
  "not_eligible:already_acknowledged": ack(
    "An administrator already recorded an acknowledgment of this screen.",
    "The request's recorded acknowledgment.",
    "Nothing to do; an acknowledgment counts only for the administrator who recorded it, so a different approver gives their own reason when approving.",
  ),
  "not_eligible:no_screen": ack(
    "The request has no identifier screen that produced a verdict.",
    READ_SCREEN,
    "Run the screen: nemar admin dataset publish screen <dataset-id>.",
  ),
  "not_eligible:screen_state": ack(
    "The screen's state is not one a batch acknowledgment covers: a direct identifier, an unchecked scan, a failed or unreported run, a running one, or a screen that needs no acknowledgment.",
    READ_SCREEN,
    INDIVIDUAL,
  ),
  "not_eligible:finding_kind": ack(
    "The screen found something other than image, document or tooling files, which a batch acknowledgment never covers.",
    READ_SCREEN,
    INDIVIDUAL,
  ),
  "not_eligible:screen_incomplete": ack(
    "The screen did not read everything it reads (a sampled, oversize or failed read), which a batch acknowledgment never covers.",
    READ_SCREEN,
    "Run the screen again; if it stays incomplete, review the request individually.",
  ),
  "not_eligible:screen_stale": ack(
    "The screen read a commit that is no longer the repository's main branch.",
    READ_HEAD,
    "Run the screen again: nemar admin dataset publish screen <dataset-id>.",
  ),
  "not_eligible:head_unverified": ack(
    "Whether the screen read the current main branch could not be verified.",
    READ_HEAD,
    "Run the dry run again later.",
  ),
  "not_eligible:tree_unreadable": ack(
    "The file list of the screened commit could not be read in full, so whether it holds a photo, face or questionnaire file is unknown.",
    READ_TREE,
    "Run the dry run again later; a repository too large for one tree listing is reviewed individually.",
  ),
  "not_eligible:excluded": ack(
    "The request holds an image or document file named as a photo, a face or a questionnaire, in the screened commit or in its history, which a batch acknowledgment never covers.",
    `${READ_TREE} ${READ_D2}`,
    INDIVIDUAL,
  ),
  "not_eligible:photo_file": ack(
    "The screened commit holds a BIDS photograph (a file ending in _photo), such as an electrode or head photograph, which can show a face. The screen accepts it as a BIDS file; a batch acknowledgment never covers it.",
    READ_TREE,
    INDIVIDUAL,
  ),
  "not_eligible:reason_too_long": ack(
    "The reason this acknowledgment would record does not fit in 500 characters, so nothing was recorded.",
    READ_LINEAGE,
    INDIVIDUAL,
  ),
  "not_eligible:evaluation_failed": ack(
    "The request could not be evaluated in full (an unexpected error while reading it, or an audit record too large to keep whole), so nothing was recorded.",
    READ_SCREEN,
    "Run the dry run again; if it persists, review the request individually.",
  ),
  "not_eligible:not_measured": ack(
    "The request was not part of the publication-queue measurement, so whether its history holds a photo, face or questionnaire file is unknown (the Worker reads only the screened commit's files).",
    READ_D2,
    INDIVIDUAL,
  ),
  "not_eligible:lineage_unreadable": ack(
    "The dataset's repository files could not be read, so its license lineage is unknown.",
    "The dataset's dataset_description.json, README and .nemar/metadata.json at the screened commit, and its deposit attestation.",
    "Run the dry run again later; check the lineage with nemar admin dataset publish license-lineage <dataset-id>.",
  ),
  "not_eligible:lineage_outcome": ack(
    "The dataset's license lineage is not a public, redistributable upstream (it is unresolved, needs permission, prohibits redistribution, is a publication, or declares no upstream).",
    READ_LINEAGE,
    "Read the lineage with nemar admin dataset publish license-lineage <dataset-id>, and review the request individually.",
  ),
  "not_eligible:lineage_no_own_record": ack(
    "No upstream source's license was read from the source's own record (DataCite, OpenNeuro or PhysioNet).",
    READ_LINEAGE,
    "Read the lineage with nemar admin dataset publish license-lineage <dataset-id>, and review the request individually.",
  ),
};

// ---------------------------------------------------------------------------
// D2's measurement: the excluded requests
// ---------------------------------------------------------------------------

/** The datasets D2 measured, and those of them holding a file of an excluded name class. */
export interface D2Exclusions {
  measured: ReadonlySet<string>;
  excluded: ReadonlySet<string>;
}

/**
 * Read D2's measurement (`d2-blockers.json`). Fails closed: a document that does not have the
 * expected shape throws, so an exclusion list is never silently empty. A dataset D2 could not read
 * (no `images`) is not measured.
 */
export function readD2Exclusions(doc: unknown): D2Exclusions {
  const datasets = (doc as { datasets?: unknown } | null)?.datasets;
  if (!Array.isArray(datasets) || datasets.length === 0) {
    throw new Error("d2-blockers: no datasets array");
  }
  const measured = new Set<string>();
  const excluded = new Set<string>();
  for (const d of datasets) {
    const id = (d as { id?: unknown } | null)?.id;
    if (typeof id !== "string") throw new Error("d2-blockers: a dataset has no id");
    const images = (d as { images?: unknown }).images;
    if (images === null || images === undefined) continue;
    const byName = (images as { byName?: unknown }).byName;
    if (typeof byName !== "object" || byName === null) {
      throw new Error("d2-blockers: a dataset's images have no byName");
    }
    for (const n of Object.values(byName as Record<string, unknown>)) {
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
        throw new Error("d2-blockers: a name-class count is not a whole number");
      }
    }
    measured.add(id);
    for (const cls of EXCLUDED_NAME_CLASSES) {
      if (((byName as Record<string, number>)[cls] ?? 0) > 0) excluded.add(id);
    }
  }
  return { measured, excluded };
}

/**
 * The exclusions as the Worker holds them (`shared/upstream-ack-excluded.ts`, generated from the
 * measurement by `readD2Exclusions`). Fails closed: no measured dataset, an id that is not a
 * dataset id, or an excluded id that was not measured throws.
 */
export function exclusionsOf(m: {
  excluded: readonly string[];
  measured: readonly string[];
}): D2Exclusions {
  const ID = /^(nm|on|xx)\d{6}$/;
  if (m.measured.length === 0) throw new Error("upstream-ack exclusions: nothing measured");
  if (![...m.measured, ...m.excluded].every((id) => ID.test(id))) {
    throw new Error("upstream-ack exclusions: an id is not a dataset id");
  }
  const measured = new Set(m.measured);
  if (!m.excluded.every((id) => measured.has(id))) {
    throw new Error("upstream-ack exclusions: an excluded id was not measured");
  }
  return { measured, excluded: new Set(m.excluded) };
}

// ---------------------------------------------------------------------------
// The eligibility rule
// ---------------------------------------------------------------------------

/** What the route read about one request before any network call. */
export interface ScreenFacts {
  datasetId: string;
  exempt: boolean;
  requestStatus: string;
  acknowledged: boolean;
  /** The stored state, read through `readStoredState` (null when none or not a state). */
  screenState: string | null;
  /** The stored report, read through `readStoredReport` (null when none or unreadable). */
  report: ScreenReport | null;
  exclusions: D2Exclusions;
}

export type Eligibility<T extends object = object> =
  | ({ eligible: true } & T)
  | { eligible: false; reason: NotEligibleReason };

/** The finding kinds a report holds (count above zero). */
function kindsOf(report: ScreenReport): FindingKind[] {
  const byKind = report.scan?.findings_by_kind ?? {};
  return (Object.keys(byKind) as FindingKind[]).filter((k) => (byKind[k] ?? 0) > 0);
}

/**
 * The checks that need no network: the request, the screen and D2's exclusion. The head check and
 * the lineage come after, and only for a request that passes this.
 */
export function screenEligibility(f: ScreenFacts): Eligibility {
  if (f.exempt) return { eligible: false, reason: "exempt" };
  if (f.requestStatus !== "requested") return { eligible: false, reason: "not_requested" };
  if (f.acknowledged) return { eligible: false, reason: "already_acknowledged" };
  if (f.screenState === null) return { eligible: false, reason: "no_screen" };
  if (!ACK_ELIGIBLE_STATES.has(f.screenState)) return { eligible: false, reason: "screen_state" };
  if (!f.report?.scan || !f.report.head || f.report.scan.status !== f.screenState) {
    return { eligible: false, reason: "no_screen" };
  }
  const scan = f.report.scan;
  if (kindsOf(f.report).some((k) => !ACK_ELIGIBLE_KINDS.has(k))) {
    return { eligible: false, reason: "finding_kind" };
  }
  // Defense in depth: the header counts are kept apart from the finding counts, and a flagged
  // EDF/BDF file or a header kind outside the set is never acknowledged in a batch.
  if ((scan.edf_bdf_files_flagged ?? 0) > 0) return { eligible: false, reason: "finding_kind" };
  const byFile = scan.edf_bdf_files_by_kind ?? {};
  if (
    (Object.keys(byFile) as FindingKind[]).some(
      (k) => (byFile[k] ?? 0) > 0 && !ACK_ELIGIBLE_KINDS.has(k),
    )
  ) {
    return { eligible: false, reason: "finding_kind" };
  }
  if (scan.incomplete !== false) return { eligible: false, reason: "screen_incomplete" };
  if ((scan.side_reads_failed ?? 0) > 0) return { eligible: false, reason: "screen_incomplete" };
  if (f.exclusions.excluded.has(f.datasetId)) return { eligible: false, reason: "excluded" };
  if (!f.exclusions.measured.has(f.datasetId)) return { eligible: false, reason: "not_measured" };
  return { eligible: true };
}

/**
 * The freshness check on the screened commit's own files: null (the listing failed or was
 * truncated) is `tree_unreadable`; any image or document file of an excluded name class is
 * `excluded`, and any BIDS photograph is `photo_file`. D2's list stays as well, for files only in
 * history.
 */
export function treeEligibility(paths: readonly string[] | null): Eligibility {
  if (paths === null) return { eligible: false, reason: "tree_unreadable" };
  if (excludedImageCount(paths) > 0) return { eligible: false, reason: "excluded" };
  if (paths.some((p) => BIDS_PHOTO_FILE.test(p))) return { eligible: false, reason: "photo_file" };
  return { eligible: true };
}

/**
 * A BIDS photograph (`*_photo.<image>`: electrode or head photographs), which the screen accepts by
 * design and does not flag. It can show a face, so a request holding one is reviewed individually
 * (lead ruling, 2026-11-25); this changes this eligibility rule only, never the screen's own.
 */
export const BIDS_PHOTO_FILE = /_photo\.(jpe?g|png|gif|bmp|tiff?|webp|heic)$/i;

/**
 * The lineage check: a compatible outcome with at least one source read from its own record. The
 * source returned is the one the reason names: the first such source.
 */
export function lineageEligibility(
  lineage: LineageResult,
): Eligibility<{ source: LineageSource; others: number }> {
  if (!ACK_LINEAGE_OUTCOMES.has(lineage.outcome)) {
    return { eligible: false, reason: "lineage_outcome" };
  }
  const own = lineage.sources.filter(
    (s) =>
      s.resolver !== null &&
      OWN_RECORD_RESOLVERS.has(s.resolver) &&
      s.status === "resolved" &&
      s.license !== null &&
      ACK_LINEAGE_OUTCOMES.has(s.outcome),
  );
  if (own.length === 0) return { eligible: false, reason: "lineage_no_own_record" };
  return { eligible: true, source: own[0], others: lineage.sources.length - 1 };
}

// ---------------------------------------------------------------------------
// The recorded reason
// ---------------------------------------------------------------------------

/** The most characters of the source id the reason names; DOIs are far shorter. */
const MAX_SOURCE_ID = 160;

/** The most characters of the license text the reason names. */
const MAX_LICENSE_TEXT = 80;

function licenseText(s: LineageSource): string {
  const text = `${s.license}${s.license_version ? ` ${s.license_version}` : ""}`;
  return text.length > MAX_LICENSE_TEXT ? `${text.slice(0, MAX_LICENSE_TEXT - 3)}...` : text;
}

/** A reason that does not fit is never recorded (nor cut): the request is reviewed individually. */
export function reasonEligibility(reason: string): Eligibility<{ reason: string }> {
  if (reason.length > ACKNOWLEDGMENT_MAX_LENGTH) {
    return { eligible: false, reason: "reason_too_long" };
  }
  return { eligible: true, reason };
}

/**
 * The reason recorded on the request, within {@link ACKNOWLEDGMENT_MAX_LENGTH}:
 * `public-upstream: same recordings as <first source> (+N more) (<license>, read from <resolver>);
 * not read by NEMAR: <formats>; images/documents acknowledged; policy <url>`.
 * Formats that do not fit are counted ("+N more"); the full lineage goes to the audit row.
 */
export function buildAckReason(
  report: ScreenReport,
  source: LineageSource,
  others: number,
): string {
  const kinds = new Set(kindsOf(report));
  const acknowledged: string[] = [];
  if (kinds.has("image-or-document-file")) acknowledged.push("images/documents acknowledged");
  if (kinds.has("tooling-debris")) acknowledged.push("tooling files acknowledged");
  const more = others > 0 ? ` (+${others} more)` : "";
  const id =
    source.id.length > MAX_SOURCE_ID ? `${source.id.slice(0, MAX_SOURCE_ID - 3)}...` : source.id;
  const head = `public-upstream: same recordings as ${id}${more} (${licenseText(source)}, read from ${source.resolver})`;
  const tail = `${acknowledged.map((a) => `; ${a}`).join("")}; policy ${POLICY_URL}`;
  const formats = Object.keys(report.scan?.unscreened_formats ?? {}).sort();
  const build = (shown: string[]) => {
    const rest = formats.length - shown.length;
    const list =
      formats.length === 0
        ? "none"
        : `${shown.join(", ")}${rest > 0 ? `${shown.length > 0 ? ", " : ""}+${rest} more` : ""}`;
    return `${head}; not read by NEMAR: ${list}${tail}`;
  };
  for (let n = formats.length; n > 0; n--) {
    const text = build(formats.slice(0, n));
    if (text.length <= ACKNOWLEDGMENT_MAX_LENGTH) return text;
  }
  // With no format named, the text is at most about 480 characters (the source id and the license
  // are capped); `reasonEligibility` refuses anything longer.
  return build([]);
}

// ---------------------------------------------------------------------------
// The wire shapes of POST /admin/publish/acknowledge-batch
// ---------------------------------------------------------------------------

/** One request's answer. */
export interface AckResult {
  dataset_id: string;
  request_id: number | null;
  outcome: AckOutcome;
  screen_state: string | null;
  screen_head: string | null;
  /** The reason recorded (apply) or that would be recorded (dry run). */
  reason?: string;
  lineage_outcome?: string;
  source?: { id: string; license: string | null; resolver: string | null };
}

/** An entry of an apply: what the dry run showed for one request. */
export interface AckExpected {
  dataset_id: string;
  request_id: number;
  screen_state: string;
  screen_head: string;
}

export type AckBatchRequest =
  | { apply?: false; dataset_ids: string[] }
  | { apply?: false; all_requested: true; after?: string; limit?: number }
  | { apply: true; expect: AckExpected[] };

export interface AckBatchResponse {
  apply: boolean;
  policy: string;
  results: AckResult[];
  /** The `after` of the next page of an `all_requested` dry run; null on the last. */
  next: string | null;
}

/** One request's line, as the command prints it. */
export function ackOutcomeLine(r: { dataset_id: string; outcome: AckOutcome }): string {
  // A newer Worker may send an outcome this CLI has no words for: print the bare outcome.
  const copy = (UPSTREAM_ACK_COPY as Partial<Record<string, Copy>>)[r.outcome];
  return copy
    ? `${r.dataset_id}  ${r.outcome}  ${copy.statement}`
    : `${r.dataset_id}  ${r.outcome}`;
}
