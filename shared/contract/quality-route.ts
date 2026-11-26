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
 *
 * `quality` is a reserved segment: it is never a version tag (a data-plane tag starts with `v` or is
 * `latest`), and the route is registered before the version routes.
 *
 * Every refusal is a fixed word in `{ "error": <word> }`. A dataset that is not public, is concealed
 * (ADR 0065), withdrawn or tombstoned answers exactly as a dataset with no quality does
 * (`quality_not_found`), so the answer never says whether a dataset exists. No refusal is cached.
 *
 * Pure and import-free.
 */

/** The reserved data-plane segment and the route's version. */
export const QUALITY_ROUTE_SEGMENT = "quality";
export const QUALITY_ROUTE_VERSION = "v1";

/** The two endpoints, the segment after the recipe. */
export const QUALITY_RECORD_SEGMENT = "record";
export const QUALITY_FILE_SEGMENT = "file";

/** The format word of the record endpoint's answer. */
export const QUALITY_RECORD_FORMAT = "nemar.quality-record.v1";

/** The most bytes of a recording's signalJourney record the route reads (ADR 0137, plan C13). */
export const QUALITY_RECORD_MAX_BYTES = 512 * 1024;

/** The most bytes of one view file (neuroschema `caps.bytes_per_role`, the schema's `size` maximum). */
export const QUALITY_FILE_MAX_BYTES = 4_194_304;

/** The longest recording path the route takes (neuroschema `relativeLocation` `maxLength`). */
export const QUALITY_RECORDING_PATH_MAX = 1024;

/** How long a browser may keep a public answer, in seconds (ADR 0137 decision 7: at most 300). */
export const QUALITY_PUBLIC_MAX_AGE = 300;

/** The per-dataset cache tag of every public answer: `nemar-dq-<dataset id>`. */
export const qualityCacheTag = (datasetId: string): string => `nemar-dq-${datasetId}`;

/** The route's words, each with its HTTP status. */
export const QUALITY_ROUTE_WORDS = Object.freeze({
  /** The dataset is not public (or concealed, withdrawn or tombstoned), or the recipe has no current public derivative, or the recording no record. */
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
  /** The recording's record could not be read or did not check whole. Logged. */
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
