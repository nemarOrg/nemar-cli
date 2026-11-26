/**
 * License permission evidence (epic #2182, card B6; ADR 0139 decision 7 and its amendment of
 * 2026-11-25).
 *
 * When a publication request's license lineage cannot be confirmed, the depositor is told what to
 * send and where ({@link licensePermissionRequest}, from `LINEAGE_PERMISSION_REQUEST`): evidence
 * from the original authors (or, for `redistribution_prohibited`, from the source repository) sent
 * to support@nemar.org, where it becomes a support ticket (ADR 0112). An administrator records that
 * evidence against the request (`license_permissions`, migration 0154), linked to the ticket.
 *
 * **What a permission covers.** The Worker stores, on each review, the lineage it served the job
 * (the review's {@link PermissionBasis}: the combined outcome, the target license and the sources
 * behind the outcome). A permission names the outcome, the target license and the sources it was
 * recorded for. It covers a review's basis ({@link permissionCovers}) exactly when the outcome and
 * the target license are the same and the permission names EVERY source behind the outcome. It then
 * clears `license_lineage_unconfirmed` for that request and for every later request of the dataset
 * whose review has the same basis. It never clears another reason and it never approves.
 *
 * **The evidence text is the administrators' alone.** It is the administrator's summary of what was
 * received; it is stored in the row, shown to no depositor, and given to no model: nothing in this
 * file reads it, and the review's inputs never select it.
 *
 * Pure: no Node or Worker imports; the CLI and the Worker both run it.
 */

import {
  ACTION_REQUIRED_OUTCOMES,
  type ActionRequiredOutcome,
  COMPATIBLE_OUTCOMES,
  LINEAGE_OUTCOMES,
  LINEAGE_PERMISSION_REQUEST,
  type LineageOutcome,
  type LineageResult,
  NORMALIZED_LICENSES,
  type NormalizedLicense,
} from "./license-lineage.js";
import { PUBLICATION_DATASET_ID_RE } from "./publication-limits.js";

/** The longest evidence summary an administrator may record (characters). */
export const LICENSE_PERMISSION_EVIDENCE_MAX = 1000;

/** The audit action written in the same batch as a recorded permission. */
export const LICENSE_PERMISSION_AUDIT_ACTION = "license_permission_recorded";

/** The most sources a basis keeps (the resolver reads at most ten; the review inputs carry 32). */
export const MAX_BASIS_SOURCES = 32;

/** The longest source identifier a basis keeps; a longer one makes the basis unreadable. */
export const MAX_SOURCE_ID_LENGTH = 512;

/**
 * The resolver's entries for the dataset's own files, which it lists as sources when they cannot be
 * read (`description_unreadable`, `metadata_unreadable`). No author's permission fixes the
 * dataset's own files, so a basis that names one is never covered.
 */
export const DATASET_OWN_FILE_IDS: readonly string[] = [
  "dataset_description.json",
  ".nemar/metadata.json",
];

export function isActionRequiredOutcome(o: unknown): o is ActionRequiredOutcome {
  return (ACTION_REQUIRED_OUTCOMES as readonly unknown[]).includes(o);
}

/** One source behind a lineage outcome, as a review's basis keeps it. */
export interface BasisSource {
  id: string;
  license: NormalizedLicense | null;
  license_version: string | null;
  outcome: LineageOutcome;
}

/** What a review's lineage rested on: what a permission must match to cover it. */
export interface PermissionBasis {
  outcome: LineageOutcome;
  target_license: NormalizedLicense | null;
  sources: BasisSource[];
}

/**
 * The basis of a lineage result: its outcome, its target license and the sources behind the
 * outcome. Those are the sources whose own outcome is not compatible; when every source is
 * compatible on its own and the outcome still needs action (two sources' licenses conflict), all of
 * them. A compatible outcome has no source behind it.
 */
export function permissionBasisOf(
  result: Pick<LineageResult, "outcome" | "target_license" | "sources">,
): PermissionBasis {
  const blocking = result.sources.filter((s) => !COMPATIBLE_OUTCOMES.has(s.outcome));
  const behind = isActionRequiredOutcome(result.outcome)
    ? blocking.length > 0
      ? blocking
      : result.sources
    : [];
  return {
    outcome: result.outcome,
    target_license: result.target_license,
    sources: behind.slice(0, MAX_BASIS_SOURCES).map((s) => ({
      id: s.id,
      license: s.license,
      license_version: s.license_version,
      outcome: s.outcome,
    })),
  };
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const isLicenseOrNull = (x: unknown): x is NormalizedLicense | null =>
  x === null || (NORMALIZED_LICENSES as readonly unknown[]).includes(x);

const isOutcome = (x: unknown): x is LineageOutcome =>
  (LINEAGE_OUTCOMES as readonly unknown[]).includes(x);

function exactKeys(r: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(r);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(r, k));
}

/**
 * A stored basis (`publication_reviews.lineage_basis`), read strictly: null when the column is
 * empty or anything in it is not what {@link permissionBasisOf} writes. A basis that does not read
 * is covered by nothing.
 */
export function parsePermissionBasis(raw: unknown): PermissionBasis | null {
  if (typeof raw !== "string") return null;
  let x: unknown;
  try {
    x = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(x) || !exactKeys(x, ["outcome", "target_license", "sources"])) return null;
  if (!isOutcome(x.outcome) || !isLicenseOrNull(x.target_license)) return null;
  if (!Array.isArray(x.sources) || x.sources.length > MAX_BASIS_SOURCES) return null;
  const sources: BasisSource[] = [];
  for (const s of x.sources as unknown[]) {
    if (!isRecord(s) || !exactKeys(s, ["id", "license", "license_version", "outcome"])) return null;
    if (typeof s.id !== "string" || s.id === "" || s.id.length > MAX_SOURCE_ID_LENGTH) return null;
    if (!isLicenseOrNull(s.license) || !isOutcome(s.outcome)) return null;
    if (s.license_version !== null && typeof s.license_version !== "string") return null;
    sources.push({
      id: s.id,
      license: s.license,
      license_version: s.license_version,
      outcome: s.outcome,
    });
  }
  return { outcome: x.outcome, target_license: x.target_license, sources };
}

/** What a recorded permission was recorded for. */
export interface PermissionScope {
  outcome: ActionRequiredOutcome;
  target_license: NormalizedLicense | null;
  source_ids: readonly string[];
}

/** A stored `target_license` column as a closed word, or undefined when it is not one. */
export function storedTargetLicense(raw: unknown): NormalizedLicense | null | undefined {
  return isLicenseOrNull(raw) ? raw : undefined;
}

/**
 * Whether a recorded permission covers a review's basis: the outcome needs action and is the same,
 * the target license is the same, no source is one of the dataset's own files, and the permission
 * names every source behind the outcome. One source it does not name, and it covers nothing.
 */
export function permissionCovers(permission: PermissionScope, basis: PermissionBasis): boolean {
  if (!isActionRequiredOutcome(basis.outcome) || permission.outcome !== basis.outcome) return false;
  if (permission.target_license !== basis.target_license) return false;
  if (basis.sources.length === 0) return false;
  if (basis.sources.some((s) => DATASET_OWN_FILE_IDS.includes(s.id))) return false;
  const named = new Set(permission.source_ids);
  return basis.sources.every((s) => named.has(s.id));
}

/** A stored `source_ids` column (a JSON array of strings), or null when it is not one. */
export function parseSourceIds(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v) || v.length === 0 || v.length > MAX_BASIS_SOURCES) return null;
    return v.every((s) => typeof s === "string" && s !== "") ? (v as string[]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// What the depositor is told
// ---------------------------------------------------------------------------------------------

/**
 * The source identifiers the depositor's message may quote: a DOI, an OpenNeuro accession or a
 * PhysioNet project, in the resolver's own forms. Anything else (a URL, an identifier with spaces
 * or markup) is not quoted, because a declared identifier is text the depositor wrote.
 */
const QUOTABLE_SOURCE_ID =
  /^(?:10\.\d{4,9}\/[a-z0-9._\-/:;()]{1,200}|openneuro:ds\d{6}|physionet:[a-z0-9][a-z0-9-]{0,63}:(?:\d[\w.]{0,31})?)$/;

const LICENSE_VERSION = /^\d{1,2}(?:\.\d{1,2}){0,2}$/;

/** A license, as the depositor's message names it: its closed word, or what is true instead. */
export function licenseWords(license: NormalizedLicense | null, version: string | null): string {
  if (license === null) return "a license NEMAR could not read";
  if (license === "other") return "a license NEMAR does not recognize";
  if (license === "none") return "no license";
  return version !== null && LICENSE_VERSION.test(version) ? `${license} ${version}` : license;
}

/** One source as the message names it: its identifier when quotable, and its license. */
function sourceWords(s: BasisSource): string {
  const id = QUOTABLE_SOURCE_ID.test(s.id) ? s.id : "a source given as a link or text";
  return `${id}, ${licenseWords(s.license, s.license_version)}`;
}

/**
 * The depositor's message for an outcome that needs action, from `LINEAGE_PERMISSION_REQUEST`,
 * filled from the review's basis: each source's identifier (when quotable) and license, the target
 * license and the dataset id. Never a free-text value: identifiers that do not match a known form
 * are named generically, licenses are closed words, and a malformed dataset id is not quoted. With
 * no basis (a review from before bases were stored) the sources are left out.
 */
export function licensePermissionRequest(
  datasetId: string,
  outcome: ActionRequiredOutcome,
  basis: PermissionBasis | null,
): string {
  const usable = basis !== null && basis.outcome === outcome;
  const sources = usable ? basis.sources.map(sourceWords).join("; ") : "";
  const target =
    usable && basis.target_license !== null
      ? licenseWords(basis.target_license, null)
      : "a license NEMAR could not read";
  const dataset = PUBLICATION_DATASET_ID_RE.test(datasetId) ? datasetId : "your dataset's id";
  let text = LINEAGE_PERMISSION_REQUEST[outcome];
  text = sources === "" ? text.replace(" ({sources})", "") : text.replace("{sources}", sources);
  return text.replaceAll("{target}", target).replaceAll("{dataset}", dataset);
}

/** A recorded permission as every surface names it. */
export interface RecordedPermission {
  /** When it was recorded (SQLite `datetime('now')`, UTC). */
  recorded_at: string;
  /** The administrator's username, or null when the account is gone. */
  recorded_by: string | null;
  /** The support ticket the evidence arrived on (ADR 0112). */
  ticket_id: number;
}

const DATE = /^(\d{4}-\d{2}-\d{2})/;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** "License permission recorded on (date) by (administrator), ticket (ticket)": the admin show and mail. */
export function licensePermissionRecordedLine(p: RecordedPermission): string {
  const date = DATE.exec(p.recorded_at)?.[1] ?? "an unrecorded date";
  const by =
    p.recorded_by !== null && USERNAME.test(p.recorded_by)
      ? p.recorded_by
      : "an administrator whose account is gone";
  return `License permission recorded on ${date} by ${by}, ticket ${p.ticket_id}.`;
}

/** What the depositor's status says once a permission covers the request. */
export function licensePermissionRecordedForDepositor(p: RecordedPermission): string {
  const date = DATE.exec(p.recorded_at)?.[1] ?? "an unrecorded date";
  return `License permission recorded on ${date}, ticket ${p.ticket_id}; the review continues without the license lineage reason.`;
}

// ---------------------------------------------------------------------------------------------
// The notice mail and the admin command, in fixed words
// ---------------------------------------------------------------------------------------------

export function licenseNoticeSubject(datasetId: string): string {
  return `Publication request needs license evidence: ${datasetId}`;
}

export const LICENSE_NOTICE_HEADLINE = "License evidence needed";

export function licenseNoticeOpening(datasetId: string): string {
  return `The automated review of the publication request for ${datasetId} could not confirm that the upstream data's license allows this copy.`;
}

export const LICENSE_NOTICE_CLOSING =
  "Send the evidence to support@nemar.org, where it opens a support ticket that an administrator answers.";

/** The closed words a notice's mail can end in (`license_permission_notices.mail_state`). */
export const LICENSE_NOTICE_MAIL_STATES = ["sent", "fenced", "failed", "no_recipient"] as const;
export type LicenseNoticeMailState = (typeof LICENSE_NOTICE_MAIL_STATES)[number];

/** Why `POST /admin/publish/:id/license-permission` refused, one closed word each. */
export const LICENSE_PERMISSION_REFUSALS = [
  "no_active_request",
  "request_mismatch",
  "no_lineage_reason",
  "basis_unrecorded",
  "basis_mismatch",
  "dataset_files_unreadable",
  "ticket_not_found",
  "already_covered",
] as const;
export type LicensePermissionRefusal = (typeof LICENSE_PERMISSION_REFUSALS)[number];

/** Each refusal's sentence: what is true and what to do. A `Record`, so a word without one fails the build. */
export const LICENSE_PERMISSION_REFUSAL_TEXT: Record<LicensePermissionRefusal, string> = {
  no_active_request: "The dataset has no publication request waiting for a decision.",
  request_mismatch:
    "The request named is not the dataset's active request; read it again with nemar admin dataset publish show.",
  no_lineage_reason:
    "The review in force does not report an unconfirmed license lineage, so there is nothing for a permission to clear.",
  basis_unrecorded:
    "The review in force did not record the lineage it was given; start a new review with nemar admin dataset publish start <dataset>, then record the permission.",
  basis_mismatch:
    "The review's lineage outcome and its recorded sources disagree; start a new review, then record the permission.",
  dataset_files_unreadable:
    "The lineage could not read the dataset's own dataset_description.json or .nemar/metadata.json; the depositor fixes those files, and no permission clears that.",
  ticket_not_found:
    "No support ticket with that id is visible to you; the evidence must arrive as a support ticket first.",
  already_covered: "A recorded license permission already covers this request.",
};

/** The depositor's mail once a permission is recorded: its subject and its one sentence. */
export function licenseRecordedSubject(datasetId: string): string {
  return `License evidence recorded: ${datasetId}`;
}

export function licenseRecordedNotice(datasetId: string): string {
  return `Your evidence for ${datasetId} was recorded by an administrator; the review continues.`;
}

export const LICENSE_RECORDED_HEADLINE = "License evidence recorded";

/** What became of the administrators' "Ready to approve" mail after a permission was recorded. */
export const READY_MAIL_OUTCOMES = [
  "sent",
  "not_ready",
  "undelivered",
  "review_unreadable",
] as const;
export type ReadyMailOutcome = (typeof READY_MAIL_OUTCOMES)[number];

/** What a record's mails did, as the route answers it. */
export interface RecordedMail {
  administrators: ReadyMailOutcome;
  depositor: LicenseNoticeMailState;
}

/**
 * The line the CLI prints for each mail of a record that did not go out: the person it was for
 * must be told by hand. A `Record`, so a state without a line fails the build; `sent` and
 * `not_ready` (nothing was due) print nothing.
 */
export const DEPOSITOR_MAIL_NOT_SENT: Record<Exclude<LicenseNoticeMailState, "sent">, string> = {
  fenced:
    "The depositor's mail was held by this Worker's mail fence (not production); tell the depositor by hand that the evidence was recorded.",
  failed:
    "The depositor's mail could not be sent; tell the depositor by hand that the evidence was recorded.",
  no_recipient:
    "The depositor has no address NEMAR can mail; tell the depositor by hand that the evidence was recorded.",
};

export const ADMIN_MAIL_NOT_SENT: Record<
  Exclude<ReadyMailOutcome, "sent" | "not_ready">,
  string
> = {
  undelivered:
    "The administrators' Ready to approve mail reached nobody (the fence, no opted-in administrator, or a failed send); tell the administrators by hand that the request is ready to approve.",
  review_unreadable:
    "The review could not be read after the record, so no Ready to approve mail was sent; read it with nemar admin dataset publish show and tell the administrators by hand.",
};

/** The CLI's lines for a record's mails that were not sent. */
export function mailNotSentLines(mail: RecordedMail): string[] {
  const out: string[] = [];
  if (mail.administrators !== "sent" && mail.administrators !== "not_ready") {
    out.push(ADMIN_MAIL_NOT_SENT[mail.administrators]);
  }
  if (mail.depositor !== "sent") out.push(DEPOSITOR_MAIL_NOT_SENT[mail.depositor]);
  return out;
}

/**
 * The dry run's warning when the ticket's sender is not the depositor's address: forwarded
 * evidence from the authors is fine, and the administrator confirms the ticket holds it.
 */
export const TICKET_SENDER_WARNING =
  "The ticket's sender is not the depositor's address. Evidence forwarded from the original authors is fine, but confirm that this ticket holds the evidence before you apply.";

export const LICENSE_PERMISSION_RECORDED =
  "License permission recorded. The license lineage reason is cleared for this request and for later requests with the same sources; every other reason still stands, and approval is still yours.";

export const LICENSE_PERMISSION_DRY_RUN =
  "Dry run: nothing was recorded. Run again with --apply to record the permission.";
