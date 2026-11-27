/**
 * The widened inputs of a publication review, Worker side (ADR 0139, decision 6; epic #2182, card B4).
 *
 * The review job reads the dataset's root documents from git. Everything else it reads, the Worker
 * owns and serves, through `POST /webhooks/publication-review-inputs`, to the job of one claimed
 * review and to nobody else:
 *
 *  - the enrichment, the fields `ENRICHMENT_FIELDS_SHOWN` of `datasets.enrichment_json` (the copy
 *    of `.nemar/metadata.json` that D1 keeps), as it is at review time, with the instant D1 last
 *    stored it, which the review's record keeps (`enrichment_source`). It is the copy current when
 *    the review runs, not one read at the reviewed commit; one that is stored and does not parse
 *    ends the answer (`unavailable`), never reads as no enrichment;
 *  - the license lineage of the reviewed commit, resolved here by the one shared resolver over the
 *    description and README at that commit, the enrichment and the attestation's upstream source,
 *    with the Worker's per-DOI cache;
 *  - the request's resubmission note;
 *  - the identifier screen's coverage counts per format, read from the stored screen report of
 *    version 1 or 2 (version 2 is the evidence lane's; its narrow shape is declared here).
 *
 * So the dispatch payload stays the review's coordinates, and the workflow is unchanged. Nothing
 * here writes anything, and nothing here logs a byte of what it serves.
 *
 * **What the counts are.** Files, read, partial and failed per format: how much the screen read,
 * never what it found. No finding kind and no finding count leaves this module.
 */

import { permissionBasisOf } from "../../../shared/license-permission.js";
import { CONFIRMING_EFFORT, CONFIRMING_MODEL } from "../../../shared/publication-auto-deny.js";
import {
  COVERAGE_KEY,
  type CoverageSource,
  type CoverageTally,
  ENRICHMENT_FIELDS_SHOWN,
  ENRICHMENT_SOURCE_RE,
  type EnrichmentField,
  MAX_COVERAGE_KEYS,
  MAX_INPUT_SOURCES,
  REVIEW_INPUTS_VERSION,
  type ReviewInputsBody,
  previousDenialReasonsOf,
} from "../../../shared/publication-review.js";
import { README_CANDIDATES } from "../../../shared/readme-candidates.js";
import { AUTO_DENY_AUDIT_ACTION, readResubmissionNote } from "../../../shared/resubmission-note.js";
import type { Bindings } from "../types/bindings.js";
import {
  SERVED_METADATA_VERSION,
  cardDescriptionOf,
  cardEnrichmentOf,
  cardLineageOf,
  servedMetadataJson,
} from "./decision-card.js";
import { getDatasetsToken } from "./github-auth.js";
import { getFileContent } from "./github.js";
import { resolveWorkerLineage } from "./license-lineage-cache.js";
import { SHA40, errorWords } from "./publication-review-log.js";
import { readReview } from "./publication-review-rows.js";
import { extractRepoName } from "./repo-metadata.js";

// ---------------------------------------------------------------------------------------------
// The screen report, read narrowly
// ---------------------------------------------------------------------------------------------

/**
 * The part of a stored screen report this module reads, of either version. The shape is narrow
 * on purpose: the review needs counts and reader versions only, and a narrow reading cannot carry
 * a finding kind or a value into the inputs. It is pinned to the report A1's builder writes by a
 * drift test (`backend/test/publication-review-inputs.test.ts`, "the narrow reader agrees with
 * A1's report"), which builds a real version-2 report and reads it back here. Anything that does
 * not match reads as no counts, never as a guess.
 */
interface NarrowScreenReport {
  version: number;
  scanner: string | null;
  head: string | null;
  files: { edf_bdf: number; header_read: number; header_read_failed: number } | null;
  unscreened: Record<string, number>;
  readByFormat: Record<string, CoverageTally> | null;
  readers: Record<string, string> | null;
}

const SCANNER = /^identifier-scan@[0-9a-f]{7,40}$/;
const READER_VERSION = /^[0-9a-z][0-9a-z.+-]{0,31}$/;

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isCount(x: unknown): x is number {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
}

/** The narrow reading of a stored report column, or null when it is not one. */
export function readNarrowScreenReport(raw: unknown): NarrowScreenReport | null {
  if (typeof raw !== "string") return null;
  let x: unknown;
  try {
    x = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(x) || (x.version !== 1 && x.version !== 2)) return null;
  const scanner = typeof x.scanner === "string" && SCANNER.test(x.scanner) ? x.scanner : null;
  const head = typeof x.head === "string" && SHA40.test(x.head) ? x.head : null;
  const scan = isObject(x.scan) ? x.scan : null;

  let files: NarrowScreenReport["files"] = null;
  if (scan && isObject(scan.files)) {
    const f = scan.files;
    if (isCount(f.edf_bdf) && isCount(f.header_read) && isCount(f.header_read_failed)) {
      files = {
        edf_bdf: f.edf_bdf,
        header_read: f.header_read,
        header_read_failed: f.header_read_failed,
      };
    }
  }
  const unscreened: Record<string, number> = {};
  if (scan && isObject(scan.unscreened_formats)) {
    for (const [k, n] of Object.entries(scan.unscreened_formats)) {
      if (COVERAGE_KEY.test(k) && isCount(n) && n > 0) unscreened[k] = n;
    }
  }
  const version = x.version;
  const readByFormat = version === 2 && scan ? tallies(scan.read_by_format) : null;
  let readers: Record<string, string> | null = null;
  if (version === 2 && scan && isObject(scan.readers)) {
    readers = {};
    for (const [k, v] of Object.entries(scan.readers)) {
      if (COVERAGE_KEY.test(k) && typeof v === "string" && READER_VERSION.test(v)) readers[k] = v;
    }
  }
  return { version, scanner, head, files, unscreened, readByFormat, readers };
}

/** Version 2's tallies, each consistent with itself, or null when any one is not. */
function tallies(raw: unknown): Record<string, CoverageTally> | null {
  if (!isObject(raw)) return null;
  const out: Record<string, CoverageTally> = {};
  for (const [k, t] of Object.entries(raw)) {
    if (!COVERAGE_KEY.test(k) || !isObject(t)) return null;
    const { files, read, partial, failed } = t;
    if (!isCount(files) || !isCount(read) || !isCount(partial) || !isCount(failed)) return null;
    if (read + partial + failed > files) return null;
    out[k] = { files, read, partial, failed };
  }
  return out;
}

/**
 * The screen's coverage counts per format for the reviewed commit. Version 2: each reader's files
 * and how their reads ended. Version 1: the EDF and BDF files and their header reads, which is all
 * that version counted as read (under the version-2 reader's id, `edf`, which reads both), and
 * each format it left unscreened, none of whose files was read.
 * A report of another commit, or none, is `none`: no counts are invented for it.
 */
export function coverageOf(
  report: NarrowScreenReport | null,
  head: string,
): ReviewInputsBody["coverage"] {
  const none = { source: "none" as CoverageSource, formats: {} };
  if (report === null || report.head !== head) return none;
  const formats: Record<string, CoverageTally> = {};
  let source: CoverageSource;
  if (report.version === 2 && report.readByFormat !== null) {
    source = "screen_v2";
    Object.assign(formats, report.readByFormat);
  } else if (report.files !== null) {
    source = "screen_v1";
    const f = report.files;
    if (f.edf_bdf > 0) {
      formats.edf = {
        files: f.edf_bdf,
        read: Math.min(f.header_read, f.edf_bdf),
        partial: 0,
        failed: Math.min(f.header_read_failed, f.edf_bdf - Math.min(f.header_read, f.edf_bdf)),
      };
    }
  } else {
    return none;
  }
  for (const [k, n] of Object.entries(report.unscreened)) {
    if (!(k in formats)) formats[k] = { files: n, read: 0, partial: 0, failed: 0 };
  }
  const keys = Object.keys(formats).sort().slice(0, MAX_COVERAGE_KEYS);
  return { source, formats: Object.fromEntries(keys.map((k) => [k, formats[k]])) };
}

/**
 * The screen's part of a review's reproducibility record: the scanner that read the commit and, for
 * a version-2 report, each reader's version. Null fields when the report is not about `head`.
 */
export function screenRecordOf(
  rawReport: unknown,
  head: string,
): { scanner_id: string | null; reader_versions: string | null } {
  const report = readNarrowScreenReport(rawReport);
  if (report === null || report.head !== head) return { scanner_id: null, reader_versions: null };
  const readers = report.readers;
  return {
    scanner_id: report.scanner,
    reader_versions:
      readers === null || Object.keys(readers).length === 0
        ? null
        : JSON.stringify(
            Object.fromEntries(
              Object.keys(readers)
                .sort()
                .map((k) => [k, readers[k]]),
            ),
          ),
  };
}

// ---------------------------------------------------------------------------------------------
// The enrichment
// ---------------------------------------------------------------------------------------------

function parseObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The enrichment fields the review is shown. `creators` is the field's own value when the document
 * has one, or else the version-2 document's `authors` (each name with its ORCID and affiliations),
 * which is where that version keeps them. An anonymous release is shown no creators at all
 * (ADR 0065): the description's Authors are withheld on purpose, and so are these.
 */
export function enrichmentFieldsOf(
  doc: Record<string, unknown>,
  anonymous: boolean,
): Partial<Record<EnrichmentField, unknown>> {
  const out: Partial<Record<EnrichmentField, unknown>> = {};
  const shown = ENRICHMENT_FIELDS_SHOWN.filter((f) => !anonymous || f !== "creators");
  for (const field of shown) {
    if (Object.hasOwn(doc, field) && doc[field] !== undefined) out[field] = doc[field];
  }
  if (!anonymous && out.creators === undefined && isObject(doc.authors)) {
    out.creators = Object.entries(doc.authors).map(([name, a]) => ({
      name,
      ...(isObject(a) ? { orcid: a.orcid ?? null, affiliations: a.affiliations ?? null } : {}),
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The previous denial
// ---------------------------------------------------------------------------------------------

/**
 * The denial a request answers (`previous_request_id`, migration 0151), as codes: whether an
 * automated agent made it (an `auto_deny` audit row names the request, ADR 0139 decision 2) and the
 * closed reason codes its `denied_reason` names. Null when there is no previous request, or it was
 * not a denial (a withdrawal is stored as denied with `withdrawn_at` set, and is not one). An
 * administrator's free-text reason gives no codes; its words are never read into the inputs.
 */
export async function previousDenialOf(
  db: D1Database,
  datasetId: string,
  previousRequestId: number | null,
): Promise<ReviewInputsBody["previous_denial"]> {
  if (previousRequestId === null) return null;
  const previous = await db
    .prepare(
      `SELECT id, status, withdrawn_at, denied_reason FROM publication_requests
        WHERE id = ? AND dataset_id = ?`,
    )
    .bind(previousRequestId, datasetId)
    .first<{
      id: number;
      status: string;
      withdrawn_at: string | null;
      denied_reason: string | null;
    }>();
  if (!previous || previous.status !== "denied" || previous.withdrawn_at !== null) return null;
  // `json_valid` guards `json_extract`, which throws on an audit payload that is not JSON.
  const agent = await db
    .prepare(
      `SELECT 1 AS hit FROM audit_log
        WHERE action = ? AND resource_type = 'dataset' AND resource_id = ?
          AND CASE WHEN json_valid(details) THEN json_extract(details, '$.request_id') END = ?
        LIMIT 1`,
    )
    .bind(AUTO_DENY_AUDIT_ACTION, datasetId, previous.id)
    .first<{ hit: number }>();
  return { automated: agent !== null, reasons: previousDenialReasonsOf(previous.denied_reason) };
}

// ---------------------------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------------------------

export type ReviewInputsAnswer =
  | { kind: "ok"; body: ReviewInputsBody }
  /** The review is not claimed, or no longer waiting for its report: the route answers 409. */
  | { kind: "not_claimed" }
  /** Something the inputs need could not be read: the route answers 502, and the job reviews nothing. */
  | { kind: "unavailable" };

function upstreamSourceOf(attestation: string | null): string | null {
  const parsed = parseObject(attestation);
  const v = parsed?.upstream_source;
  return typeof v === "string" && v.trim() ? v : null;
}

/**
 * The widened inputs of one claimed review. The caller has verified the review's token. Read-only:
 * D1, the repository's description and README at the reviewed commit, and the registries the
 * lineage names (through the Worker's cache).
 */
export async function publicationReviewInputs(
  env: Bindings,
  reviewId: number,
  datasetId: string,
): Promise<ReviewInputsAnswer> {
  const db = env.DB;
  const row = await readReview(db, reviewId);
  if (
    !row ||
    row.datasetId !== datasetId ||
    row.claimedAt === null ||
    (row.state !== "dispatched" && row.state !== "unreported")
  ) {
    return { kind: "not_claimed" };
  }

  const request = await db
    .prepare(
      `SELECT resubmission_note, previous_request_id, identifier_screen_report, anonymous
         FROM publication_requests WHERE id = ? AND dataset_id = ?`,
    )
    .bind(row.requestId, datasetId)
    .first<{
      resubmission_note: string | null;
      previous_request_id: number | null;
      identifier_screen_report: string | null;
      anonymous: number;
    }>();
  const dataset = await db
    .prepare(
      `SELECT github_repo, attestation, enrichment_json,
              json_extract(sweep_stamps, '$.enrichment_updated_at') AS enrichment_updated_at
         FROM datasets WHERE dataset_id = ?`,
    )
    .bind(datasetId)
    .first<{
      github_repo: string | null;
      attestation: string | null;
      enrichment_json: string | null;
      enrichment_updated_at: string | null;
    }>();
  if (!request || !dataset) return { kind: "unavailable" };
  // The note as the Worker keeps it (`readResubmissionNote`, the rule the request route stored it
  // under). One that no longer reads was changed by hand: it is not sent in part, and not dropped
  // silently either; the job reviews nothing.
  const note = readResubmissionNote(request.resubmission_note);
  if (!note.ok) {
    console.warn(
      `[publication-review-inputs] review ${reviewId} (${datasetId}): stored note does not read (${note.refusal})`,
    );
    return { kind: "unavailable" };
  }

  // The enrichment as D1 holds it now, at review time: the copy the review reads and its record
  // names. One that is there and does not parse is not "no enrichment": nothing is reviewed.
  const doc = parseObject(dataset.enrichment_json);
  if (dataset.enrichment_json !== null && doc === null) {
    console.warn(
      `[publication-review-inputs] review ${reviewId} (${datasetId}): stored enrichment does not parse`,
    );
    return { kind: "unavailable" };
  }

  const repo = dataset.github_repo ? extractRepoName(dataset.github_repo) : null;
  if (!repo) return { kind: "unavailable" };

  // The description and README at the reviewed commit, the lineage's own inputs. A read that fails
  // is not a missing file: it ends the answer, and the job reviews nothing.
  let description: string | null;
  let readme: string | null = null;
  try {
    const token = await getDatasetsToken(env);
    description = await getFileContent(repo, "dataset_description.json", token, row.headSha);
    for (const name of README_CANDIDATES) {
      readme = await getFileContent(repo, name, token, row.headSha);
      if (readme !== null) break;
    }
  } catch (err) {
    console.error(
      `[publication-review-inputs] review ${reviewId} (${datasetId}): repository read failed (${errorWords(err)})`,
    );
    return { kind: "unavailable" };
  }

  // Resolved again at review time, failed fetches asked again (ADR 0142 decision 3).
  const lineage = await resolveWorkerLineage({
    datasetDescription: description,
    // D1's copy of `.nemar/metadata.json`: the same document the enrichment section shows, so
    // the two cannot disagree. One that does not parse is the resolver's `metadata_unreadable`.
    nemarMetadata: dataset.enrichment_json,
    attestationUpstreamSource: upstreamSourceOf(dataset.attestation),
    readme,
  });

  const anonymous = request.anonymous === 1;
  const fields = doc === null ? null : enrichmentFieldsOf(doc, anonymous);
  const enrichmentSource =
    typeof dataset.enrichment_updated_at === "string" &&
    ENRICHMENT_SOURCE_RE.test(dataset.enrichment_updated_at)
      ? dataset.enrichment_updated_at
      : null;
  const body: ReviewInputsBody = {
    v: REVIEW_INPUTS_VERSION,
    enrichment: fields === null ? null : { fields, source: enrichmentSource },
    lineage: {
      outcome: lineage.outcome,
      target_license: lineage.target_license,
      sources: lineage.sources.slice(0, MAX_INPUT_SOURCES).map((s) => ({
        id: s.id,
        resolver: s.resolver,
        resource_type: s.resource_type,
        title: s.title,
        creators: s.creators,
        publisher: s.publisher,
        license: s.license,
        license_version: s.license_version,
        evidence_url: s.evidence_url,
        status: s.status,
        origin: s.origin,
        outcome: s.outcome,
      })),
      resolver_version: lineage.resolver_version,
      resolved_at: lineage.resolved_at,
    },
    resubmission_note: note.note,
    previous_denial: await previousDenialOf(db, datasetId, request.previous_request_id),
    coverage: coverageOf(readNarrowScreenReport(request.identifier_screen_report), row.headSha),
    // A confirming run is told its model here (ADR 0139, decision 1), so the dispatch payload and
    // the workflow stay as they are; a first run's body is exactly what it was.
    ...(row.confirmOf === null
      ? {}
      : { confirm: { model: CONFIRMING_MODEL, effort: CONFIRMING_EFFORT } }),
  };
  // The job now holds its inputs and may call the model: stamped once, on the claimed row still
  // waiting, so a later `inputs_unavailable` from it is stored as `workflow_failed` (it counts).
  // A stamp that cannot be written serves nothing, so no run is left able to make a call free.
  // The same statement keeps the lineage just served as the review's permission basis (migration
  // 0154): what a recorded license permission must match to clear the lineage reason. The latest
  // serve is the one the job read, so each serve writes it. So does the decision card's snapshot of
  // the dataset's own words as served (migration 0163; ADR 0142 decision 4): the enrichment's main
  // fields, the description's Name, License and Authors at the reviewed commit, and the lineage with
  // what its sources declare. One too long for its column is left NULL (the card then says "not as
  // reviewed"); the serve is never refused for it.
  const snapshot = servedMetadataJson({
    v: SERVED_METADATA_VERSION,
    enrichment: cardEnrichmentOf(fields),
    enrichment_source: enrichmentSource,
    dataset_description: cardDescriptionOf(description, anonymous),
    lineage: cardLineageOf(lineage),
  });
  try {
    const stamped = await db
      .prepare(
        `UPDATE publication_reviews
            SET inputs_served_at = COALESCE(inputs_served_at, datetime('now')), lineage_basis = ?,
                served_metadata = ?
          WHERE id = ? AND dataset_id = ? AND claimed_at IS NOT NULL
            AND state IN ('dispatched', 'unreported')`,
      )
      .bind(JSON.stringify(permissionBasisOf(lineage)), snapshot, reviewId, datasetId)
      .run();
    if ((stamped.meta.changes ?? 0) !== 1) return { kind: "not_claimed" };
  } catch (err) {
    // The class of the error only: its text can carry SQL.
    console.error(
      `[publication-review-inputs] review ${reviewId} (${datasetId}): stamp failed (${err instanceof Error ? err.constructor.name : "unknown"})`,
    );
    return { kind: "not_claimed" };
  }
  return { kind: "ok", body };
}
