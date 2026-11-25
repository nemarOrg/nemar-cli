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

/** The most requests one call of the route reads or records. */
export const ACK_BATCH_MAX = 100;

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

/** The image-name classes of D2's measurement that keep a request out of every batch. */
export const EXCLUDED_NAME_CLASSES = ["photo-face", "questionnaire"] as const;

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
  "excluded",
  "not_measured",
  "lineage_unreadable",
  "lineage_outcome",
  "lineage_no_own_record",
] as const;
export type NotEligibleReason = (typeof NOT_ELIGIBLE_REASONS)[number];

/** Every per-request outcome the route reports. */
export type AckOutcome =
  | "eligible"
  | "acknowledged"
  | "state_moved"
  | `not_eligible:${NotEligibleReason}`;

/** Every entry of the copy table: the policy section, then each outcome. */
export type UpstreamAckEntry = typeof UPSTREAM_ACK_ANCHOR | AckOutcome;

const ack = (statement: string, read: string, remedy: string): Copy => ({
  statement,
  read,
  remedy,
  anchor: POLICY_URL,
});

const READ_SCREEN =
  "The request's status, its stored identifier screen (state, finding kinds, unread formats, completeness and screened commit) and its recorded acknowledgment.";
const READ_HEAD = "The screened commit against the dataset repository's current main branch.";
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
    "An administrator may acknowledge many identifier screens in one act when each request is a conversion of a public, redistributable upstream dataset whose license NEMAR read from the source's own record (DataCite, OpenNeuro or PhysioNet). Such an acknowledgment covers only formats the scanner does not read and image, document or tooling files. A content finding, a direct identifier, an unchecked, incomplete or stale screen, or a request holding a photo, face or questionnaire file is never acknowledged this way. Each acknowledgment records a reason naming the upstream, its license and the unread formats, and is the calling administrator's own act: it satisfies that administrator's approval and no other's. The weekly re-screen reads these datasets again as readers are added.",
    `${READ_SCREEN} ${READ_HEAD} ${READ_D2} ${READ_LINEAGE}`,
    "Nothing to do for an acknowledged request: approve it as usual. A request this does not cover is reviewed individually.",
  ),
  eligible: ack(
    "The request meets every condition of a batch acknowledgment; a run with --apply records one.",
    `${READ_SCREEN} ${READ_HEAD} ${READ_D2} ${READ_LINEAGE}`,
    "Run the same selection again with --apply to record the acknowledgment as your own act.",
  ),
  acknowledged: ack(
    "The acknowledgment was recorded as your own act, with the reason shown, and written to the audit log with the lineage it rests on.",
    `${READ_SCREEN} ${READ_HEAD} ${READ_D2} ${READ_LINEAGE}`,
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
  "not_eligible:excluded": ack(
    "The request holds a file named as a photo, a face or a questionnaire, which a batch acknowledgment never covers.",
    READ_D2,
    INDIVIDUAL,
  ),
  "not_eligible:not_measured": ack(
    "The request was not part of the publication-queue measurement, so whether it holds a photo, face or questionnaire file is unknown.",
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
    measured.add(id);
    for (const cls of EXCLUDED_NAME_CLASSES) {
      const n = (byName as Record<string, unknown>)[cls];
      if (typeof n === "number" && n > 0) excluded.add(id);
    }
  }
  return { measured, excluded };
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
  if (kindsOf(f.report).some((k) => !ACK_ELIGIBLE_KINDS.has(k))) {
    return { eligible: false, reason: "finding_kind" };
  }
  if (f.report.scan.incomplete !== false) return { eligible: false, reason: "screen_incomplete" };
  if (f.exclusions.excluded.has(f.datasetId)) return { eligible: false, reason: "excluded" };
  if (!f.exclusions.measured.has(f.datasetId)) return { eligible: false, reason: "not_measured" };
  return { eligible: true };
}

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

function licenseText(s: LineageSource): string {
  return `${s.license}${s.license_version ? ` ${s.license_version}` : ""}`;
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
  // With no format named, the text is at most about 450 characters: the source id is capped.
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
  return `${r.dataset_id}  ${r.outcome}  ${UPSTREAM_ACK_COPY[r.outcome].statement}`;
}
