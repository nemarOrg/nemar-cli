/**
 * The widened inputs of a publication review, Worker side (ADR 0139, decision 6; epic #2182, card B4).
 *
 * The review job reads the dataset's root documents from git. Everything else it reads, the Worker
 * owns and serves, through `POST /webhooks/publication-review-inputs`, to the job of one claimed
 * review and to nobody else:
 *
 *  - the enrichment, the fields `ENRICHMENT_FIELDS_SHOWN` of `datasets.enrichment_json` (the copy
 *    of `.nemar/metadata.json` that D1 keeps), with the instant D1 last stored it;
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

import { resolveLicenseLineage } from "../../../shared/license-lineage.js";
import {
  COVERAGE_KEY,
  type CoverageSource,
  type CoverageTally,
  ENRICHMENT_FIELDS_SHOWN,
  type EnrichmentField,
  MAX_COVERAGE_KEYS,
  MAX_INPUT_SOURCES,
  REVIEW_INPUTS_VERSION,
  type ReviewInputsBody,
} from "../../../shared/publication-review.js";
import { README_CANDIDATES } from "../../../shared/readme-candidates.js";
import { workerLineageCache } from "../routes/admin/license-lineage.js";
import type { Bindings } from "../types/bindings.js";
import { getDatasetsToken } from "./github-auth.js";
import { getFileContent } from "./github.js";
import { SHA40, errorWords } from "./publication-review-log.js";
import { readReview } from "./publication-review-rows.js";
import { extractRepoName } from "./repo-metadata.js";

// ---------------------------------------------------------------------------------------------
// The screen report, read narrowly
// ---------------------------------------------------------------------------------------------

/**
 * The part of a stored screen report this module reads, of either version. Version 2 (the
 * evidence lane's `read_by_format` and `readers`) is not declared on this branch; this narrow
 * shape is the whole of what is read from it, and the epic's merge replaces it with the shared
 * type. Anything that does not match reads as no counts, never as a guess.
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
 * that version counted as read, and each format it left unscreened, none of whose files was read.
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
      formats.edf_bdf = {
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
      `SELECT resubmission_note, identifier_screen_report, anonymous
         FROM publication_requests WHERE id = ? AND dataset_id = ?`,
    )
    .bind(row.requestId, datasetId)
    .first<{
      resubmission_note: string | null;
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

  const lineage = await resolveLicenseLineage(
    {
      datasetDescription: description,
      // D1's copy of `.nemar/metadata.json`: the same document the enrichment section shows, so
      // the two cannot disagree. One that does not parse is the resolver's `metadata_unreadable`.
      nemarMetadata: dataset.enrichment_json,
      attestationUpstreamSource: upstreamSourceOf(dataset.attestation),
      readme,
    },
    { cache: workerLineageCache() },
  );

  const doc = parseObject(dataset.enrichment_json);
  const anonymous = request.anonymous === 1;
  const body: ReviewInputsBody = {
    v: REVIEW_INPUTS_VERSION,
    enrichment:
      doc === null
        ? null
        : {
            fields: enrichmentFieldsOf(doc, anonymous),
            source:
              typeof dataset.enrichment_updated_at === "string"
                ? dataset.enrichment_updated_at
                : null,
          },
    lineage: {
      outcome: lineage.outcome,
      target_license: lineage.target_license,
      sources: lineage.sources.slice(0, MAX_INPUT_SOURCES).map((s) => ({
        id: s.id,
        resolver: s.resolver,
        resource_type: s.resource_type,
        license: s.license,
        license_version: s.license_version,
        evidence_url: s.evidence_url,
        status: s.status,
        origin: s.origin,
        outcome: s.outcome,
      })),
      resolver_version: lineage.resolver_version,
    },
    resubmission_note:
      typeof request.resubmission_note === "string" && request.resubmission_note.trim() !== ""
        ? request.resubmission_note
        : null,
    coverage: coverageOf(readNarrowScreenReport(request.identifier_screen_report), row.headSha),
  };
  return { kind: "ok", body };
}
