/**
 * The quality view route's paths, words and bounds (ADR 0137 decisions 6 and 7, epic #2324 phase B2): the
 * public data-plane route that serves one recording's quality views and the files they name, from a
 * recipe's current public derivative only. Declared once for the backend and for the website that reads it.
 *
 *   GET /<dataset id>/quality/v1/<recipe>/record/<recording path>
 *       The recording's neuroschema `dataQuality` document (`level: record`), projected from its
 *       signalJourney record in the derivatives store and checked whole, with the derivative it came from
 *       and the `nemar.view-digest.v1` of each view.
 *   GET /<dataset id>/quality/v1/<recipe>/file/<derivative key>/<sha256>/<recording path>
 *       The bytes of one file a view of that recording declares (a `data[]` entry or a file input), named
 *       by its SHA-256, read again from the store and hashed before it is served.
 *   GET /<dataset id>/quality/v1/<recipe>/processing/<recording path>
 *       The recording's neuroschema `processing` entry (`level: record`: each checkpoint's status, code and
 *       step, `stored` last) and its `signalJourney` link (`completed` with its record's location, SHA-256
 *       and signalJourney version, or `failed` when the run wrote no record for it), from the same current
 *       public derivative's recordings table and record (ADR 0134 decision 9 as amended 2026-11-26). It
 *       answers for every recording the run's table lists, a failed one included.
 *
 * `quality` is a reserved segment: it is never a version tag (a data-plane tag starts with `v` or is
 * `latest`), and the route is registered before the version routes.
 *
 * Every refusal is a fixed word in `{ "error": <word> }`. A dataset that is not public, is concealed
 * (ADR 0065), withdrawn or tombstoned answers exactly as a dataset with no quality does
 * (`quality_not_found`), so the answer never says whether a dataset exists. No refusal is cached.
 *
 * Pure: it imports only the recording-name rule (`../compute-naming.js`) and the stamp id pattern
 * (`./compute-stamp.js`), both import-free, so the website's proxy applies the backend's exact checks.
 */

import { matchRecording } from "../compute-naming.js";
import { COMPUTE_PIPELINE_STAMP_ID_RE } from "./compute-stamp.js";

/** The reserved data-plane segment and the route's version. */
export const QUALITY_ROUTE_SEGMENT = "quality";
export const QUALITY_ROUTE_VERSION = "v1";

/** The endpoints, the segment after the recipe. */
export const QUALITY_RECORD_SEGMENT = "record";
export const QUALITY_FILE_SEGMENT = "file";
export const QUALITY_PROCESSING_SEGMENT = "processing";

/** The format word of the record endpoint's answer. */
export const QUALITY_RECORD_FORMAT = "nemar.quality-record.v1";

/** The format word of the processing endpoint's answer. */
export const QUALITY_PROCESSING_FORMAT = "nemar.processing-record.v1";

/** The most bytes of a recording's signalJourney record the route reads (ADR 0137, plan C13). */
export const QUALITY_RECORD_MAX_BYTES = 512 * 1024;

/** The most bytes of one view file (neuroschema `caps.bytes_per_role`, the schema's `size` maximum). */
export const QUALITY_FILE_MAX_BYTES = 4_194_304;

/**
 * The most bytes of a run's recordings table the processing endpoint scans (the bound reconciliation reads a
 * table with), and the longest line it takes. The table is read as a stream and never held whole: the scan
 * keeps one line and stops at the recording's.
 */
export const QUALITY_TABLE_MAX_BYTES = 32 * 1024 * 1024;
export const QUALITY_TABLE_LINE_MAX = 65_536;

/** The longest recording path the route takes (neuroschema `relativeLocation` `maxLength`). */
export const QUALITY_RECORDING_PATH_MAX = 1024;

/**
 * neuroschema 0.6.0's `relativeLocation` pattern, byte for byte (`test/quality-documents-contract.unit.test.ts`
 * compares it with the vendored bundle's): no leading or trailing space, not absolute, no scheme, no `.` or
 * `..` segment, no `//`, no trailing `/`, and none of `\ % ? #`, the C0 and C1 controls or the bidirectional
 * and line-separator code points. Compiled with the `u` flag, as Ajv compiles it.
 */
export const QUALITY_RELATIVE_LOCATION_SOURCE = String.raw`^(?! )(?![\s\S]* $)(?!/)(?![A-Za-z][A-Za-z0-9+.-]*:)(?!(?:[\s\S]*/)?\.\.?(?:/|$))(?![\s\S]*//)(?![\s\S]*/$)[^\\%?#\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]+$(?!\n)`;

const RELATIVE_LOCATION_RE = new RegExp(QUALITY_RELATIVE_LOCATION_SOURCE, "u");

/**
 * Whether a decoded path is a recording path the quality routes take: non-empty, at most
 * `QUALITY_RECORDING_PATH_MAX`, a neuroschema `relativeLocation`, and a recording's name
 * (`matchRecording`). The public route, the admin mount, the run-quality listing and the website's proxy
 * all use this one rule.
 */
export function isQualityRecordingPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= QUALITY_RECORDING_PATH_MAX &&
    RELATIVE_LOCATION_RE.test(path) &&
    matchRecording(path.slice(path.lastIndexOf("/") + 1)) !== null
  );
}

/** How long a browser may keep a public answer, in seconds (ADR 0137 decision 7: at most 300). */
export const QUALITY_PUBLIC_MAX_AGE = 300;

/** The per-dataset cache tag of every public answer: `nemar-dq-<dataset id>`. */
export const qualityCacheTag = (datasetId: string): string => `nemar-dq-${datasetId}`;

/** The route's words, each with its HTTP status. */
export const QUALITY_ROUTE_WORDS = Object.freeze({
  /** The dataset is not public (or concealed, withdrawn or tombstoned), or the recipe has no current public derivative, or the recording no record (no row of the run's recordings table, for the processing endpoint). */
  quality_not_found: 404,
  /** The recording path, the key or the digest is not one this route takes (traversal included). */
  recording_path_invalid: 400,
  /** The derivative named was public and has expired (ADR 0123). */
  views_expired: 410,
  /** No view of the recording's validated declaration names a file of that digest. */
  view_not_declared: 404,
  /** A declared file is not in the store. */
  view_data_missing: 404,
  /** A declared file's bytes are not its declared size or digest. Logged. */
  view_data_corrupt: 502,
  /** The recording's record, or the run's recordings table, could not be read or did not check whole. Logged. */
  record_unreadable: 502,
});

export type QualityRouteWord = keyof typeof QUALITY_ROUTE_WORDS;

/** The neuroschema registry's formats and their media types; any other format is served as a download. */
export const QUALITY_FORMAT_MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  tsv: "text/tab-separated-values; charset=utf-8",
  json: "application/json",
});

const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

/** The record endpoint's path for a recording, under a data-plane origin. */
export function qualityRecordPath(datasetId: string, recipe: string, recording: string): string {
  return `/${datasetId}/${QUALITY_ROUTE_SEGMENT}/${QUALITY_ROUTE_VERSION}/${recipe}/${QUALITY_RECORD_SEGMENT}/${encodePath(recording)}`;
}

/** The processing endpoint's path for a recording, under a data-plane origin. */
export function qualityProcessingPath(
  datasetId: string,
  recipe: string,
  recording: string,
): string {
  return `/${datasetId}/${QUALITY_ROUTE_SEGMENT}/${QUALITY_ROUTE_VERSION}/${recipe}/${QUALITY_PROCESSING_SEGMENT}/${encodePath(recording)}`;
}

/** The file endpoint's path for one declared file of a recording. */
export function qualityFilePath(
  datasetId: string,
  recipe: string,
  key: string,
  sha256: string,
  recording: string,
): string {
  return `/${datasetId}/${QUALITY_ROUTE_SEGMENT}/${QUALITY_ROUTE_VERSION}/${recipe}/${QUALITY_FILE_SEGMENT}/${key}/${sha256}/${encodePath(recording)}`;
}

/**
 * The headers a served view file carries besides caching (RFC 6266 `filename*`, `nosniff`): a format the
 * registry lists is served as its media type, inline; any other is `application/octet-stream`, as an
 * attachment, so a declared `.html` or `.svg` can never be rendered by a browser.
 */
export function qualityFileHeaders(
  location: string,
  format: string | null,
): Record<string, string> {
  const name = location.slice(location.lastIndexOf("/") + 1);
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const media =
    format !== null && Object.hasOwn(QUALITY_FORMAT_MEDIA_TYPES, format)
      ? QUALITY_FORMAT_MEDIA_TYPES[format]
      : undefined;
  return {
    "Content-Type": media ?? "application/octet-stream",
    "Content-Disposition": `${media === undefined ? "attachment" : "inline"}; filename*=UTF-8''${encoded}`,
    "X-Content-Type-Options": "nosniff",
  };
}

// --- The admin mount (ADR 0137 decision 7, epic #2324 phase B3b) ----------------------------------------------
//
//   GET /admin/compute/pipeline/runs/<stamp>/quality/record/<recording path>
//   GET /admin/compute/pipeline/runs/<stamp>/quality/file/<sha256>/<recording path>
//
// The same record and file a public request gets, of the run's own derivative (canary, catalog or
// published, superseded included) while it is stored and in date, for an administrator only. No dataset
// gate and no cache: every answer the mount's handler gives is `no-store` and carries no `Cache-Tag`, since
// an administrator reads concealed deposits (ADR 0065) too. (A refusal from the router's middleware or the
// rate limiter is not the handler's; the proxy makes those `no-store`.) The record's answer is
// `QUALITY_RECORD_FORMAT`'s; refusals are `{ "error": <word> }` of `QUALITY_ADMIN_ROUTE_WORDS`.
//
// THE PATH GRAMMAR, which the website's same-origin proxy enforces on its `rest` before it forwards, and
// which the backend enforces again (`qualityAdminRest`): `rest` is the raw, still percent-encoded path after
// `.../quality/`, and is exactly
//   record/<recording>            or    file/<64 lowercase hexadecimal digits>/<recording>
// where <recording> is one or more `/`-separated segments, each non-empty, not `.` or `..`, made of the
// characters `QUALITY_ADMIN_SEGMENT_RE` allows, with no encoded `/` (`%2F`), `\` (`%5C`) or `.` (`%2E`) and no
// encoded C0 control or DEL, and which decoded is a recording path (`isQualityRecordingPath`: the
// `relativeLocation` rule, so no `%`, `?`, `#`, C1 control or bidirectional code point once decoded, at
// most `QUALITY_RECORDING_PATH_MAX` characters, and a recording's name). No query string, and GET only.
//
// THE PROXY'S OBLIGATIONS (the website's `.../quality/[...rest]` route, W9). It must:
//  1. take `rest` from the raw `url.pathname`, never from decoded route parameters, and refuse a request
//     whose URL holds any `?`, a bare one included;
//  2. build the upstream path with `qualityAdminForwardPath(stamp, rest)` and refuse when it is null;
//  3. answer GET only;
//  4. forward the caller's own session cookie or bearer key, never a service identity, so the backend checks
//     the caller's own role on every request;
//  5. set `Cache-Control: no-store` on every answer it gives, upstream 401, 403 and 429 included;
//  6. stop at 4 MiB (`QUALITY_FILE_MAX_BYTES`) by counting the bytes it streams, not by trusting
//     `Content-Length`;
//  7. strip hop-by-hop headers and `Set-Cookie`, and pass through only `Content-Type`,
//     `Content-Disposition` and `X-Content-Type-Options`.

/** The admin mount's segment after `runs/<stamp>/`. */
export const QUALITY_ADMIN_SEGMENT = "quality";

/** The admin mount's words: the public route's, and where the run's derivative stands when it is not served. */
export const QUALITY_ADMIN_ROUTE_WORDS = Object.freeze({
  ...QUALITY_ROUTE_WORDS,
  /** There is no such stamp, or the stamp in the path is not a stamp id. */
  stamp_not_found: 404,
  /** The run has no derivative: it has not succeeded, is not keyed, or the store has not decided yet. */
  derivative_not_keyed: 404,
  /** The run's derivative is being copied, so its files are partial. */
  derivative_copying: 409,
  /** The run's derivative failed and its copy cannot be trusted. */
  derivative_failed: 409,
  /** A method other than GET. */
  method_not_allowed: 405,
  /** The derivatives store is not bound, or the read failed. Logged. */
  quality_unavailable: 503,
});

export type QualityAdminRouteWord = keyof typeof QUALITY_ADMIN_ROUTE_WORDS;

/** One raw recording segment: unreserved characters, sub-delimiters, `:` `@`, and percent escapes. */
export const QUALITY_ADMIN_SEGMENT_RE = /^(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})+$/;

/** Percent escapes a recording segment may never carry: `/`, `\`, `.` and the control characters. */
const FORBIDDEN_ESCAPE_RE = /%(?:2[Ff]|5[Cc]|2[Ee]|[01][0-9A-Fa-f]|7[Ff])/;

const HEX64_RE = /^[0-9a-f]{64}$/;

/**
 * The admin request a raw `rest` names, or null when it is outside the grammar above, the decoded recording
 * held to `isQualityRecordingPath`.
 */
export function qualityAdminRest(
  rest: string,
):
  | { kind: "record"; recording: string }
  | { kind: "file"; sha256: string; recording: string }
  | null {
  const segments = rest.split("/");
  const kind = segments.shift();
  let sha256: string | undefined;
  if (kind === QUALITY_FILE_SEGMENT) {
    sha256 = segments.shift();
    if (sha256 === undefined || !HEX64_RE.test(sha256)) return null;
  } else if (kind !== QUALITY_RECORD_SEGMENT) {
    return null;
  }
  if (segments.length === 0) return null;
  const decoded: string[] = [];
  for (const segment of segments) {
    if (segment === "." || segment === ".." || !QUALITY_ADMIN_SEGMENT_RE.test(segment)) return null;
    if (FORBIDDEN_ESCAPE_RE.test(segment)) return null;
    let part: string;
    try {
      part = decodeURIComponent(segment);
    } catch {
      return null;
    }
    decoded.push(part);
  }
  const recording = decoded.join("/");
  if (!isQualityRecordingPath(recording)) return null;
  return sha256 === undefined ? { kind: "record", recording } : { kind: "file", sha256, recording };
}

/** The admin record path of a run's recording. */
export function qualityAdminRecordPath(stampId: number, recording: string): string {
  return `/admin/compute/pipeline/runs/${stampId}/${QUALITY_ADMIN_SEGMENT}/${QUALITY_RECORD_SEGMENT}/${encodePath(recording)}`;
}

/** The admin file path of one declared file of a run's recording. */
export function qualityAdminFilePath(stampId: number, sha256: string, recording: string): string {
  return `/admin/compute/pipeline/runs/${stampId}/${QUALITY_ADMIN_SEGMENT}/${QUALITY_FILE_SEGMENT}/${sha256}/${encodePath(recording)}`;
}

/**
 * The upstream path the proxy forwards to, or null when the stamp is not a stamp id or `rawRest` is outside
 * the grammar. It is built from the two raw strings it validated, so what is forwarded is exactly what was
 * checked: no decoding, re-encoding or normalization happens between the check and the request.
 */
export function qualityAdminForwardPath(stamp: string, rawRest: string): string | null {
  if (!COMPUTE_PIPELINE_STAMP_ID_RE.test(stamp) || !Number.isSafeInteger(Number(stamp)))
    return null;
  if (qualityAdminRest(rawRest) === null) return null;
  return `/admin/compute/pipeline/runs/${stamp}/${QUALITY_ADMIN_SEGMENT}/${rawRest}`;
}
