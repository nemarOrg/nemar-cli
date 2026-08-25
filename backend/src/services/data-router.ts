/**
 * Pure functions backing the `data.nemar.org` route (epic #449).
 *
 * Resolves a (datasetId, version, path) tuple against an in-memory
 * VersionManifest into either a file 302 target or a directory listing.
 * D1 / S3 / network access lives in the Hono handlers; everything here
 * is synchronous and unit-testable, except resolveVersion which needs D1
 * for the "latest" lookup.
 */

// Single source of truth for the version canonicalizer + neuroschema version
// (epic #896, #898). toVersionTag is re-exported below so existing importers
// (routes/data.ts) keep working.
import { NEUROSCHEMA_VERSION, toVersionTag } from "../../../shared/contract/index.js";
import type {
  ContributorEntry,
  FundingReferenceEntry,
  NemarMetadata,
  NemarMetadataV1,
  NemarMetadataV2,
  PipelineStage,
  RelatedIdentifierEntry,
  StructuredDate,
  StructuredKeyword,
} from "../../../shared/datacite-constants.js";
import { isValidDatasetId } from "./datasetId";
import type { ManifestFile, VersionManifest } from "./manifest";
import {
  type PresignedUrlOptions,
  type S3ListResult,
  generatePresignedGetUrl,
  listObjectsWithDelimiter,
} from "./s3";

export const VERSION_TAG_RE = /^v\d+\.\d+\.\d+$/;

export type ResolvedVersion =
  | { ok: true; version: string }
  | { ok: false; reason: "no_published_versions" | "invalid_version" };

export type DirectoryEntry =
  | { kind: "file"; name: string; size: number }
  | { kind: "dir"; name: string };

export type ResolvedFile =
  | { kind: "file"; path: string; file: ManifestFile }
  | { kind: "directory"; path: string; children: DirectoryEntry[] }
  | { kind: "not_found" };

/**
 * Shape of one row in the public `manifest.json` response. Pinned as a
 * named type because external clients (the eegdash viewer, third-party
 * downloaders, future SDKs) depend on it; inline shapes are easy to drift
 * silently in Phase 2/3 refactors.
 */
export interface PublicManifestEntry {
  path: string;
  size: number;
  checksum_algorithm: string;
  checksum: string;
  url: string | null;
  // Stable, same-origin contract URL for the bytes (#615). Unlike `url`
  // (a 1h-presigned S3 GET for annex files), `bytes_url` is durable: a
  // consumer can persist it and re-fetch later. annex -> the per-file
  // data-plane route (302s to freshly-presigned bytes); git -> the same
  // raw.githubusercontent URL as `url`. Always present; never expires.
  bytes_url: string;
  // Populated when url could not be built for this row; lets clients
  // download the rest of the dataset instead of failing the whole listing.
  error?: string;
}

/**
 * Map a version param ("latest" or "vX.Y.Z") to a concrete vX.Y.Z.
 * Latest = most recent row in dataset_versions for that dataset.
 */
export async function resolveVersion(
  db: D1Database,
  datasetId: string,
  versionParam: string,
): Promise<ResolvedVersion> {
  if (versionParam === "latest") {
    const row = await db
      .prepare(
        "SELECT version FROM dataset_versions WHERE dataset_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .bind(datasetId)
      .first<{ version: string }>();
    if (!row) return { ok: false, reason: "no_published_versions" };
    const v = row.version.startsWith("v") ? row.version : `v${row.version}`;
    return { ok: true, version: v };
  }
  if (!VERSION_TAG_RE.test(versionParam)) return { ok: false, reason: "invalid_version" };
  return { ok: true, version: versionParam };
}

// Reject literal `..` segments, empty segments, and absolute paths.
// URL-encoded variants like `%2E%2E` reach the manifest lookup unchanged
// and miss every key (the manifest is keyed by raw paths), so they fall
// through to not_found by construction -- the URL-encoded traversal test
// in test/data-route.unit.test.ts pins that contract.
const FORBIDDEN_SEGMENTS = new Set(["", ".", "..", "__proto__", "constructor", "prototype"]);

// Exported so the QA route can use the same traversal-rejection contract.
export function normalizeBidsPath(rawPath: string): string | null {
  const stripped = rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (stripped === "") return "";
  const parts = stripped.split("/");
  for (const part of parts) {
    if (FORBIDDEN_SEGMENTS.has(part)) return null;
    if (part.startsWith("/")) return null;
  }
  return parts.join("/");
}

function normalizePath(rawPath: string): string | null {
  return normalizeBidsPath(rawPath);
}

/**
 * Map a bids-path inside a manifest to: a file (exact match), a directory
 * (any manifest entry has this as a prefix), or not_found.
 *
 * The root path of an empty manifest returns an empty directory rather
 * than not_found, so the renderer can show a valid (empty) listing for a
 * dataset that has a manifest but zero files.
 */
export function resolveFile(manifest: VersionManifest, rawPath: string): ResolvedFile {
  const normalized = normalizePath(rawPath);
  if (normalized === null) return { kind: "not_found" };

  if (normalized !== "" && Object.hasOwn(manifest.files, normalized)) {
    return { kind: "file", path: normalized, file: manifest.files[normalized] };
  }

  const prefix = normalized === "" ? "" : `${normalized}/`;
  const seen = new Map<string, DirectoryEntry>();

  for (const [path, file] of Object.entries(manifest.files)) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest === "") continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      seen.set(rest, { kind: "file", name: rest, size: file.size });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) seen.set(name, { kind: "dir", name });
    }
  }

  // Empty root of an empty manifest -> directory with no children, not 404.
  if (seen.size === 0 && normalized !== "") return { kind: "not_found" };

  const children = [...seen.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { kind: "directory", path: normalized, children };
}

const ANNEX_KEY_RE = /^[A-Z0-9]+-s\d+--/;

/**
 * Build an RFC 6266 `Content-Disposition: attachment` value with both a plain
 * ASCII `filename=` (for older clients like wget < 1.16, IE) and an RFC 5987
 * `filename*=UTF-8''...` extension so Unicode filenames survive across
 * browsers, rclone, aria2c, and curl. Both forms describe the same name; RFC
 * 6266 mandates the extended form wins where both are present.
 *
 * The disposition string is deliberately built with NO whitespace between
 * tokens (RFC 6266 OWS is optional). The downstream S3 presigner sends this
 * value through `URLSearchParams`, which form-encodes spaces as `+` rather
 * than `%20`; that survives the SigV4 signature (it's stored on
 * `this.url.searchParams`) but means a literal `+` could surface in the
 * response header on some S3 paths. Omitting whitespace dodges the question.
 *
 * The plain form sanitises non-printable, non-ASCII, quote, backslash, and
 * space to `_` so the quoted-string is well-formed AND has no characters
 * that need form-encoding inside the query parameter. The extended form
 * percent-encodes per RFC 5987 attr-char (encodeURIComponent leaves
 * `! ' ( ) *` unescaped, which RFC 5987 forbids, so we fix those up).
 */
export function buildContentDisposition(filename: string): string {
  const asciiSafe = filename.replace(/[^\x20-\x7E]/g, "_").replace(/[ "\\]/g, "_");
  const utf8 = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment;filename="${asciiSafe}";filename*=UTF-8''${utf8}`;
}

/**
 * Build the URL the Worker 302s to for a resolved file.
 *
 * Annex-backed files (key like `SHA256E-s12345--...edf`, also `MD5E-`,
 * `SHA1E-`, etc.) -> presigned S3 GET against `<datasetId>/objects/<key>`.
 * The presigned URL carries `response-content-disposition=attachment;
 * filename="<bidsBasename>"` so S3 returns the BIDS-shaped filename on
 * download instead of the content-addressed object name. See #513.
 *
 * git-backed files (`key: "git:<blob-sha>"`, used for small in-tree files
 * like dataset_description.json) -> raw.githubusercontent.com URL pinned
 * to the version tag. raw.githubusercontent.com responds with the BIDS
 * basename naturally because the URL path ends with it.
 *
 * Implicit invariant for the git: branch: the dataset's GitHub repo must
 * be public AND the version tag must exist on it. Both are guaranteed by
 * the publication workflow today (publish-approve flips the repo to
 * public before writing the D1 version row, which only happens after a
 * successful tag push). If that invariant ever breaks, the 302 target
 * itself returns 404 to the user with no Worker-side signal. Tracked as
 * a publisher canary in #503.
 */
export async function buildRedirectUrl(args: {
  datasetId: string;
  version: string;
  bidsPath: string;
  file: ManifestFile;
  s3Options: PresignedUrlOptions;
  githubOrg: string;
  expiresIn?: number;
}): Promise<string> {
  const { datasetId, version, bidsPath, file, s3Options, githubOrg, expiresIn } = args;
  if (file.key.startsWith("git:")) {
    const encoded = bidsPath.split("/").map(encodeURIComponent).join("/");
    return `https://raw.githubusercontent.com/${githubOrg}/${datasetId}/${version}/${encoded}`;
  }
  if (!ANNEX_KEY_RE.test(file.key)) {
    throw new Error(`Unrecognized manifest key format: ${file.key}`);
  }
  // filter(Boolean) tolerates a trailing-slash bidsPath (which the manifest
  // resolver strips today but a future caller might not). Without it, a path
  // like "sub-01/eeg/" would land the full path as the filename.
  const basename = bidsPath.split("/").filter(Boolean).pop() ?? bidsPath;
  return generatePresignedGetUrl(
    s3Options,
    `${datasetId}/objects/${file.key}`,
    expiresIn ?? 3600,
    buildContentDisposition(basename),
  );
}

// Canonical public data origin for bytes_url (#615). bytes_url is a STABLE,
// storable contract URL, so it is host-invariant: always the canonical
// data.nemar.org regardless of which host (data.nemar.org, api.nemar.org/data,
// or a *.workers.dev dev fallback) actually served the manifest. data.nemar.org
// is the public data host and is always reachable, so the URL resolves from
// anywhere. This also keeps the served manifest in lockstep with the build-time
// raw S3 manifest, which hardcodes the same host (emit_manifest.py:bytes_url_for
// on nemarDatasets/.github). Per-host fetchability is irrelevant: the presigned
// `url` field is what dev/CLI flows fetch; bytes_url is the durable reference.
// NOTE (epic #923): this lockstep is prod-only. buildBytesUrl now takes an
// `origin` override; on staging it becomes data-test.nemar.org while
// emit_manifest.py still emits data.nemar.org, so the two disagree for exemplars
// (Phase 5 follow-up parameterizes emit_manifest.py).
const DATA_NEMAR_ORIGIN = "https://data.nemar.org";

/**
 * Build the STABLE, host-invariant `bytes_url` for a manifest entry (#615).
 *
 * Unlike `url` (for annex files a presigned S3 GET that expires in ~1h),
 * `bytes_url` is durable — a consumer can persist it and re-fetch later from
 * anywhere:
 *  - annex-backed files -> the canonical per-file data-plane route
 *    `https://data.nemar.org/<id>/<version>/<bids_relpath>`, which 302s to
 *    bytes that are re-presigned on each request (no expiry).
 *  - git-backed files -> the raw.githubusercontent.com URL pinned to the tag,
 *    identical to `url` (already stable).
 */
export function buildBytesUrl(args: {
  githubOrg: string;
  datasetId: string;
  version: string;
  bidsPath: string;
  key: string;
  /** Data-plane origin for annex-backed files (epic #923). Defaults to the prod
   *  data host, so prod output stays byte-identical and in lockstep with the
   *  build-time raw S3 manifest. On staging, passing resolveDataBaseOrigin(env) =
   *  data-test.nemar.org makes dev-bucket-only datasets embed reachable links, but
   *  it BREAKS that lockstep for exemplars: emit_manifest.py (nemarDatasets/.github)
   *  still hardcodes data.nemar.org, so the git-committed raw manifest disagrees
   *  with the served manifest.json (the served copy is authoritative on staging).
   *  Parameterizing emit_manifest.py is a Phase 5 follow-up. */
  origin?: string;
}): string {
  const { githubOrg, datasetId, version, bidsPath, key, origin = DATA_NEMAR_ORIGIN } = args;
  const encoded = bidsPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  if (key.startsWith("git:")) {
    return `https://raw.githubusercontent.com/${githubOrg}/${datasetId}/${version}/${encoded}`;
  }
  return `${origin}/${datasetId}/${version}/${encoded}`;
}

// ===========================================================================
// QA artifact resolver (data.nemar.org/<id>/qa/*, see #511)
// ===========================================================================

/**
 * Result of resolving a `/<id>/qa/<path>` request against the S3-mirrored
 * QA tree. The shape mirrors `ResolvedFile` (manifest-backed resolver) so
 * callers can render directory listings with the same `DirectoryEntry`
 * helper that the version route uses.
 */
export type ResolvedQaPath =
  | { kind: "file"; key: string; size: number; lastModified: string }
  | { kind: "directory"; path: string; children: DirectoryEntry[]; truncated: boolean }
  | { kind: "not_found" };

/**
 * Map a per-dataset QA path to either a file (302 target) or a directory
 * listing. The QA tree is not version-locked — it reflects whichever pipeline
 * run last published to `s3://nemar/<id>/qa/*`, which is fine for Phase 3:
 * the website expects `/<id>/qa/...` not `/<id>/<v>/qa/...`.
 *
 * Detection uses a single ListObjectsV2 with `delimiter=/` at the requested
 * prefix:
 *   - if the parent listing contains a Contents entry whose key matches
 *     `<id>/qa/<path>` exactly → file
 *   - else if it contains a CommonPrefix `<id>/qa/<path>/` → directory
 *     (a second ListObjectsV2 enumerates one level of children)
 *   - else → not_found
 *
 * Path normalisation reuses the BIDS-route rules so `..`, `__proto__`, etc.
 * are rejected uniformly. The Worker passes the URL path through Hono's
 * raw-path mode which keeps `%2E%2E` literal — these miss every S3 key by
 * construction.
 */
export async function resolveQaPath(args: {
  s3Options: PresignedUrlOptions;
  datasetId: string;
  rawPath: string;
}): Promise<ResolvedQaPath> {
  const { s3Options, datasetId, rawPath } = args;
  const normalized = normalizeBidsPath(rawPath);
  if (normalized === null) return { kind: "not_found" };

  const rootPrefix = `${datasetId}/qa/`;

  // Empty path -> directly list the root of the QA tree.
  if (normalized === "") {
    let listing: S3ListResult;
    try {
      listing = await listObjectsWithDelimiter(s3Options, rootPrefix);
    } catch (err) {
      console.error(`[data] QA root listing failed dataset=${datasetId}:`, err);
      return { kind: "not_found" };
    }
    return qaListingToDirectory({ listing, path: "", absolutePrefix: rootPrefix });
  }

  const fullKey = `${rootPrefix}${normalized}`;

  // First probe: list the parent prefix and check for an exact key match
  // OR a CommonPrefix that adds a trailing slash (directory case).
  const parentSlash = fullKey.lastIndexOf("/");
  const parentPrefix = parentSlash === -1 ? rootPrefix : `${fullKey.slice(0, parentSlash)}/`;
  let probe: S3ListResult;
  try {
    probe = await listObjectsWithDelimiter(s3Options, parentPrefix);
  } catch (err) {
    console.error(`[data] QA probe failed dataset=${datasetId} path=${normalized}:`, err);
    return { kind: "not_found" };
  }

  // File: exact-key match in Contents.
  for (const entry of probe.contents) {
    if (entry.key === fullKey) {
      return {
        kind: "file",
        key: entry.key,
        size: entry.size,
        lastModified: entry.lastModified,
      };
    }
  }

  // Directory: CommonPrefix matches `<fullKey>/`.
  const dirPrefix = `${fullKey}/`;
  if (probe.commonPrefixes.includes(dirPrefix)) {
    let dirListing: S3ListResult;
    try {
      dirListing = await listObjectsWithDelimiter(s3Options, dirPrefix);
    } catch (err) {
      console.error(`[data] QA dir listing failed dataset=${datasetId} prefix=${dirPrefix}:`, err);
      return { kind: "not_found" };
    }
    return qaListingToDirectory({
      listing: dirListing,
      path: normalized,
      absolutePrefix: dirPrefix,
    });
  }

  return { kind: "not_found" };
}

/**
 * Pure: shape a one-level S3 listing into a `ResolvedQaPath` directory entry.
 * Exported so the directory-rendering decision matrix (sort order, file vs
 * dir partitioning, placeholder-object suppression, empty-root semantics)
 * can be unit-tested without an S3 round-trip.
 */
export function qaListingToDirectory(args: {
  listing: S3ListResult;
  path: string;
  absolutePrefix: string;
}): ResolvedQaPath {
  const { listing, path, absolutePrefix } = args;
  const children: DirectoryEntry[] = [];

  // Subdirectories first (sorted alphabetically), then files.
  const seen = new Set<string>();
  const dirs: DirectoryEntry[] = [];
  for (const p of listing.commonPrefixes) {
    if (!p.startsWith(absolutePrefix)) continue;
    const rest = p.slice(absolutePrefix.length);
    // S3 CommonPrefix always ends in the delimiter; strip the trailing `/`.
    const name = rest.endsWith("/") ? rest.slice(0, -1) : rest;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    dirs.push({ kind: "dir", name });
  }
  const files: DirectoryEntry[] = [];
  for (const entry of listing.contents) {
    if (!entry.key.startsWith(absolutePrefix)) continue;
    const name = entry.key.slice(absolutePrefix.length);
    // Edge case: a Contents entry whose key IS the prefix (i.e. a "directory
    // placeholder" object). Skip; it has no useful name.
    if (!name || name.includes("/") || seen.has(name)) continue;
    seen.add(name);
    files.push({ kind: "file", name, size: entry.size });
  }

  children.push(
    ...dirs.sort((a, b) => a.name.localeCompare(b.name)),
    ...files.sort((a, b) => a.name.localeCompare(b.name)),
  );

  // An empty root listing is still a valid directory (the dataset may not
  // have QA artifacts yet); only non-root empty listings are not_found.
  if (path !== "" && children.length === 0) return { kind: "not_found" };

  return {
    kind: "directory",
    path,
    children,
    truncated: listing.truncated,
  };
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes}`;
  const units = ["K", "M", "G", "T", "P"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)}${units[unit]}`;
}

/**
 * Format an ISO 8601 timestamp as an RFC 1123 / RFC 7231 HTTP-date.
 *
 * Used for the `Last-Modified` header on file responses so HTTP
 * clients (rclone HTTP backend, browsers, CDN caches) can do
 * size+mtime delta detection without re-fetching the file body.
 *
 * `new Date(iso).toUTCString()` produces exactly the RFC 1123 shape
 * (`"Fri, 15 May 2026 17:30:21 GMT"`) when the input parses. Malformed
 * input falls through unchanged -- emitting a busted Last-Modified is
 * harmless to the client (RFC 7231 says clients ignore unparseable
 * values) and lets the file route stay 200 over a manifest with a
 * malformed `created` field instead of crashing. The corrupt value
 * is logged via `console.warn` so it shows up in `wrangler tail` --
 * silent passthrough would hide manifest corruption from operators.
 * Already-HTTP-date input passes through (defensive against a caller
 * that did the conversion once already).
 */
export function toHttpDate(value: string): string {
  if (value.endsWith(" GMT")) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    console.warn(`[data-router] toHttpDate: unparseable value="${value}"`);
    return value;
  }
  return d.toUTCString();
}

// ===========================================================================
// metadata.json builders
//
// Composes a neuroschema v0.4.0 `dataset` document from the catalog row in
// D1, the parsed nemar_metadata.json enrichment payload, the dataset_versions
// list, and (optionally) the latest version's S3 manifest. All pure: no D1,
// S3, or network access happens here; callers in routes/data.ts wire the I/O.
//
// The wire format mirrors `~/Documents/git/nemar/neuroschema/schema/core/dataset.schema.json`
// (v0.4.0). NEMAR-specific aggregates that aren't part of the FAIR core
// (version DOI list, derived BIDS subjects/sessions/tasks/runs tree) sit in
// `extensions.nemar` per `schema/extensions/nemar.schema.json` which already
// declares `additionalProperties: true`.
// ===========================================================================

export type DatasetSource = "openneuro" | "nemar" | "gin" | "other";

export interface PersonAffiliation {
  name: string;
  identifier?: string | null;
  scheme?: string | null;
}

export interface Person {
  name: string;
  name_type?: "Personal" | "Organizational" | null;
  given_name?: string | null;
  family_name?: string | null;
  orcid?: string | null;
  affiliations?: PersonAffiliation[];
}

export interface DatasetDemographics {
  subjects_count: number;
  age_min?: number | null;
  age_max?: number | null;
}

/** A `{min, max}` range object, per neuroschema's channel_count_range /
 *  recording_duration_range shape (`additionalProperties: false` -- no other
 *  keys). Omitted entirely from DatasetDataSummary when both bounds are
 *  null, rather than emitted as `{min: null, max: null}`. */
export interface DatasetStatRange {
  min: number | null;
  max: number | null;
}

export interface DatasetDataSummary {
  total_files: number | null;
  size_bytes: number | null;
  size_human: string | null;
  /** store_count + failure_count from the zarr index -- every raw recording
   *  discovery found for a dataset converted since ADR 0027's raw-only
   *  cutover; a legacy dataset with unpurged derivative/sourcedata stores
   *  (AGENTS.md's Zarr section) can still include a non-raw entry (epic
   *  #1144 Phase 2). */
  recording_count: number | null;
  /** failure_count from the zarr index: recordings that could not be
   *  summarised (truncated, corrupt, unsupported). */
  recordings_unavailable: number | null;
  /** Sum of per-store duration (seconds); a store's duration is the max
   *  across its channel groups, never their sum. NULL (not 0) whenever
   *  nothing has been measured yet -- see migration 0070. A lower bound on
   *  the dataset's true total whenever recordings_unavailable is non-zero. */
  total_recording_duration: number | null;
  /** Present only when at least one bound is known. */
  recording_duration_range?: DatasetStatRange;
  /** Present only when at least one bound is known. The existing scalar
   *  `n_channels` elsewhere in the row is a single sampled value, not this
   *  range -- see the Phase 2 plan for why the scalar alone is misleading. */
  channel_count_range?: DatasetStatRange;
}

/**
 * neuroschema `signal_defaults` block (dataset.schema.json:133, backed by
 * definitions/inheritable.schema.json) -- epic #1144 Phase 2b, issue #1153.
 * Every field is independently nullable per the vendored schema; the whole
 * block is omitted (set to null) by the builder when every field is null,
 * matching `data_summary`'s gating. Every field below is one exemplar
 * sidecar's declared value, not a verified per-dataset aggregate -- see
 * migration 0071's caveat.
 */
export interface DatasetSignalDefaults {
  sampling_frequency: number | null;
  power_line_frequency: number | null;
  reference: string | null;
  /** Not derivable from anything NEMAR probes today; always null. */
  recording_type: string | null;
  channel_system: string | null;
  placement_scheme: string | null;
}

export interface DatasetProvenance {
  latest_snapshot: string | null;
  publish_date: string | null;
}

export interface DatasetExternalLinks {
  dataset_doi: string | null;
  github_url: string | null;
}

export interface DatasetFunding {
  funder_name: string;
  award_number?: string | null;
  award_title?: string | null;
  funder_identifier?: string | null;
  funder_identifier_type?: string | null;
  award_uri?: string | null;
}

export interface VersionEntry {
  version: string;
  doi: string;
  created_at: string;
  manifest_url: string;
}

export interface BidsIndexTaskNode {
  runs: string[];
}

export interface BidsIndexModalityNode {
  tasks: Record<string, BidsIndexTaskNode>;
}

export interface BidsIndexSubjectNode {
  sessions: string[];
  modalities: Record<string, BidsIndexModalityNode>;
}

export interface BidsIndex {
  version: string;
  subjects: Record<string, BidsIndexSubjectNode>;
}

export interface NemarExtensionBlock {
  versions: VersionEntry[];
  bids_index: BidsIndex | null;
  pipeline_stage: PipelineStage | null;
  /**
   * Data completeness (#970, epic #967 Phase 3): 1 = every annex-keyed manifest
   * entry verified present at its declared size, 0 = at least one missing/
   * truncated (the #967 signature), null = not audited yet. Lives in the
   * `nemar` extension namespace rather than the canonical `data_summary` block
   * because neuroschema's dataSummary.schema.json is `additionalProperties:
   * false` -- this is a NEMAR-specific integrity fact, not part of the
   * universal core schema.
   */
  data_complete: number | null;
  /** Actual bytes present in S3 (#970) -- distinct from `data_summary.size_bytes`
   *  (the honest declared total) when data_complete=0. Same namespace rationale
   *  as data_complete. */
  bytes_present: number | null;
  /**
   * Recording-stats measurement completeness (epic #1144 Phase 2): how many
   * of `data_summary.recording_count` actually yielded a duration. Lives
   * here rather than in `data_summary` because it is a NEMAR-specific
   * measurement-progress fact, not part of neuroschema's FAIR core --
   * `recording_count` and `recordings_unavailable` already say how many
   * recordings exist and how many failed; this says how many of the
   * remainder have been measured so far (recording_stats_at IS NULL means
   * "not yet swept" rather than "zero recordings measured", and this field
   * distinguishes that from a genuinely all-unmeasured dataset). null before
   * the sweep first runs a dataset.
   */
  recordings_measured: number | null;
}

export interface NeuroschemaDataset {
  schema_version: typeof NEUROSCHEMA_VERSION;
  doc_type: "dataset";
  dataset_id: string;
  name: string;
  description: string | null;
  source: DatasetSource;
  recording_modality: string[];
  bids_version: string | null;
  license: string | null;
  authors: Person[];
  keywords: StructuredKeyword[];
  related_identifiers: RelatedIdentifierEntry[];
  contributors: ContributorEntry[];
  dates: StructuredDate[];
  rights: Array<{
    rights: string;
    rights_uri?: string | null;
    rights_identifier?: string | null;
    rights_identifier_scheme?: string | null;
  }>;
  language: string | null;
  funding: DatasetFunding[];
  tasks: string[];
  datatypes: string[];
  sessions: string[];
  sessions_count: number | null;
  demographics: DatasetDemographics | null;
  data_summary: DatasetDataSummary | null;
  signal_defaults: DatasetSignalDefaults | null;
  provenance: DatasetProvenance;
  external_links: DatasetExternalLinks;
  extensions: { nemar: NemarExtensionBlock };
}

/**
 * D1 row shape consumed by the builder. Mirrors the SELECT in
 * routes/data.ts metadataJsonHandler.
 */
export interface DatasetRowForMetadata {
  dataset_id: string;
  name: string;
  description: string | null;
  github_repo: string | null;
  concept_doi: string | null;
  modalities: string | null;
  subject_count: number | null;
  age_min: number | null;
  age_max: number | null;
  file_size: number | null;
  total_files: number | null;
  tasks: string | null;
  /** Data completeness of the latest version (#970), or null if not audited. */
  data_complete: number | null;
  /** Actual bytes present in S3 for the latest version (#970), or null. */
  bytes_present: number | null;
  /** Recording-stats columns from migration 0070 (epic #1144 Phase 2), all
   *  null until the recording-stats-sweep first computes them for this
   *  dataset. See DatasetDataSummary / NemarExtensionBlock for what each
   *  serves. */
  total_recording_duration: number | null;
  recording_duration_min: number | null;
  recording_duration_max: number | null;
  recording_count: number | null;
  recordings_unavailable: number | null;
  recordings_measured: number | null;
  channel_count_min: number | null;
  channel_count_max: number | null;
  /** signal_defaults columns from migration 0071 (epic #1144 Phase 2b,
   *  #1153), all null until the signal-defaults-sweep or a live reindex
   *  first computes them for this dataset. See DatasetSignalDefaults for
   *  what each serves. `electrode_system` predates this phase (migration
   *  0054) but is selected here for the first time -- it was never served
   *  on this endpoint until signal_defaults.channel_system needed it. */
  sampling_frequency: number | null;
  power_line_frequency: number | null;
  eeg_reference: string | null;
  placement_scheme: string | null;
  electrode_system: string | null;
}

/**
 * dataset_versions row shape (subset).
 */
export interface DatasetVersionRow {
  version: string;
  doi: string;
  created_at: string;
}

/**
 * Format bytes as a neuroschema-style `size_human` string. Distinct from
 * `humanSize` which is a compact form used by the HTML directory index.
 * Precision tiers, chosen to keep the human-readable string short while
 * preserving useful resolution in the small-number tier:
 *
 *   value < 10   -> 2 decimals  ("1.15 GB",  "9.87 MB")
 *   value < 100  -> 1 decimal   ("99.5 GB",  "12.3 MB")
 *   value >= 100 -> 0 decimals  ("450 MB",   "150 GB")
 *
 * Null in, null out. Negative or non-finite input also returns null --
 * callers receive an absent field rather than a noisy "0 B" placeholder.
 */
export function formatBytes(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

function splitCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Flatten `NemarMetadata.authors` (a `Record<name, AuthorEnrichment*>`) into
 * the neuroschema Person array. The map key is the author's display name.
 * v1 enrichment's singular `affiliation: string` lifts to `affiliations: [{ name }]`.
 *
 * Returns [] when no enrichment is present, matching the contract that
 * partial-enrichment cases never throw and never coerce missing data to
 * placeholder values.
 */
export function buildPersonList(meta: NemarMetadata | null): Person[] {
  if (!meta || !meta.authors) return [];
  if (meta.version === "2.0") return buildPersonListV2(meta);
  return buildPersonListV1(meta);
}

function buildPersonListV1(meta: NemarMetadataV1): Person[] {
  if (!meta.authors) return [];
  return Object.entries(meta.authors).map(([name, value]) => {
    const person: Person = { name, name_type: "Personal" };
    if (value.orcid) person.orcid = value.orcid;
    if (value.affiliation) person.affiliations = [{ name: value.affiliation }];
    return person;
  });
}

function buildPersonListV2(meta: NemarMetadataV2): Person[] {
  if (!meta.authors) return [];
  return Object.entries(meta.authors).map(([name, value]) => {
    const person: Person = { name, name_type: "Personal" };
    if (value.orcid) person.orcid = value.orcid;
    if (value.affiliations && value.affiliations.length > 0) {
      person.affiliations = value.affiliations.map((a) => ({
        name: a.name,
        identifier: a.identifier ?? null,
        scheme: a.scheme ?? null,
      }));
    }
    return person;
  });
}

const BIDS_SUB_RE = /^sub-[A-Za-z0-9]+$/;
const BIDS_SES_RE = /^ses-[A-Za-z0-9]+$/;
const BIDS_TASK_TOKEN_RE = /_task-([A-Za-z0-9]+)/;
const BIDS_RUN_TOKEN_RE = /_run-([A-Za-z0-9]+)/;

/**
 * Derive a `subjects -> sessions -> modalities -> tasks -> runs` tree from a
 * BIDS-shaped manifest by parsing every file path.
 *
 * Only paths rooted at the top level under `sub-<label>/` count. Derivatives,
 * code directories, README/etc., and any non-conforming path are skipped
 * silently so the tree reflects the BIDS raw view.
 *
 * Session labels in the tree omit the `ses-` prefix to match how BIDS
 * tooling typically refers to sessions (the directory keeps the prefix; the
 * label does not).
 *
 * Sets are converted to deterministically sorted arrays at the end so the
 * response is byte-stable for cache-friendly clients.
 */
export function buildBidsIndex(
  files: Record<string, ManifestFile>,
): Record<string, BidsIndexSubjectNode> {
  type Accum = {
    sessions: Set<string>;
    modalities: Map<string, Map<string, Set<string>>>;
  };
  const acc: Record<string, Accum> = {};

  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    if (parts.length < 2) continue;
    const subject = parts[0];
    if (!BIDS_SUB_RE.test(subject)) continue;

    let modalityIdx = 1;
    let sessionLabel: string | null = null;
    if (parts.length >= 3 && BIDS_SES_RE.test(parts[1])) {
      sessionLabel = parts[1].slice("ses-".length);
      modalityIdx = 2;
    }

    // Register the subject before considering modality/task. Task-less
    // datatypes (anat, dwi, fmap) and session-level sidecars (sub-01_scans.tsv)
    // are valid BIDS and the subject should still appear in the index even
    // when the filename has no `_task-` token. The modalities map for such
    // a subject can legitimately be empty.
    if (!acc[subject]) {
      acc[subject] = { sessions: new Set(), modalities: new Map() };
    }
    if (sessionLabel !== null) acc[subject].sessions.add(sessionLabel);

    // No modality directory after the subject (or session) prefix -> the
    // subject is registered but this path doesn't add a modality entry.
    if (modalityIdx >= parts.length - 1) continue;
    const modality = parts[modalityIdx];
    const filename = parts[parts.length - 1];

    if (!acc[subject].modalities.has(modality)) {
      acc[subject].modalities.set(modality, new Map());
    }
    const tasksMap = acc[subject].modalities.get(modality);
    if (!tasksMap) continue;

    const taskMatch = filename.match(BIDS_TASK_TOKEN_RE);
    if (!taskMatch) continue;
    const task = taskMatch[1];
    if (!tasksMap.has(task)) tasksMap.set(task, new Set());
    const runMatch = filename.match(BIDS_RUN_TOKEN_RE);
    if (runMatch) tasksMap.get(task)?.add(runMatch[1]);
  }

  const out: Record<string, BidsIndexSubjectNode> = {};
  for (const subject of Object.keys(acc).sort()) {
    const node = acc[subject];
    const modalities: Record<string, BidsIndexModalityNode> = {};
    for (const mod of [...node.modalities.keys()].sort()) {
      const tasksMap = node.modalities.get(mod);
      if (!tasksMap) continue;
      const tasks: Record<string, BidsIndexTaskNode> = {};
      for (const task of [...tasksMap.keys()].sort()) {
        tasks[task] = { runs: [...(tasksMap.get(task) ?? [])].sort() };
      }
      modalities[mod] = { tasks };
    }
    out[subject] = {
      sessions: [...node.sessions].sort(),
      modalities,
    };
  }
  return out;
}

/**
 * Collect unique top-level session labels across all subjects (without the
 * `ses-` prefix). Returns sorted output for byte stability.
 */
export function deriveSessions(files: Record<string, ManifestFile>): string[] {
  const sessions = new Set<string>();
  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    if (parts.length < 3) continue;
    if (!BIDS_SUB_RE.test(parts[0])) continue;
    if (BIDS_SES_RE.test(parts[1])) sessions.add(parts[1].slice("ses-".length));
  }
  return [...sessions].sort();
}

/**
 * Compose the full neuroschema dataset document. Pure: caller hands in the
 * parsed enrichment, version rows, and (optional) latest manifest. Any
 * missing input degrades to a null/empty field rather than aborting.
 */
export function buildDatasetMetadata(input: {
  row: DatasetRowForMetadata;
  parsedEnrichment: NemarMetadata | null;
  versions: DatasetVersionRow[];
  latestManifest: VersionManifest | null;
  githubOrg: string;
}): NeuroschemaDataset {
  const { row, parsedEnrichment, versions, latestManifest, githubOrg } = input;

  const modalitiesCsv = splitCsv(row.modalities);
  const recordingModality = modalitiesCsv.map((m) => m.toUpperCase());
  const datatypes = modalitiesCsv.map((m) => m.toLowerCase());

  const v2 = parsedEnrichment && parsedEnrichment.version === "2.0" ? parsedEnrichment : null;
  const v1 = parsedEnrichment && parsedEnrichment.version === "1.0" ? parsedEnrichment : null;

  // Prefer the LLM-enriched description over the catalog row's stored value.
  // On-import we seed `datasets.description` with a placeholder string (e.g.
  // "Imported from OpenNeuro ds000117"); without this priority the placeholder
  // would survive a successful enrichment cycle and the metadata.json endpoint
  // would keep returning the placeholder forever (#535). Fall back to the row
  // when no enrichment is present yet (newly-imported datasets).
  const description = v2?.description ?? v1?.description ?? row.description ?? null;
  const license = v2?.license ?? null;
  const keywords: StructuredKeyword[] = v2?.keywords ?? [];
  const related: RelatedIdentifierEntry[] = v2?.related_identifiers ?? [];
  const contributors: ContributorEntry[] = v2?.contributors ?? [];
  const dates: StructuredDate[] = v2?.dates ?? [];
  const funding: DatasetFunding[] = (v2?.funding_references ?? []).map(toDatasetFunding);

  // Honest size (#970, epic #967 Phase 3): when the caller supplied a manifest,
  // sum ITS declared sizes live rather than trust the D1 row -- the manifest is
  // fetched fresh from S3 (loadManifest), so it can't be stale between
  // reindex/sweep runs the way row.file_size briefly can. `latestManifest` is
  // null, and this falls back to the (possibly stale) D1 row, in THREE cases,
  // not just "pre-manifest": (1) a genuinely pre-manifest dataset (no
  // version/v<X>.json yet); (2) page-bundle.ts deliberately passes null to skip
  // the multi-MB manifest fetch on every page-bundle response (perf), even for
  // a fully-manifested dataset; (3) routes/data.ts's loadManifest call failed
  // (S3 error, corrupt JSON) for a dataset that DOES have a manifest. Cases 2
  // and 3 mean a healthy manifested dataset can still surface a stale D1 size
  // here -- this is a deliberate perf/availability tradeoff, not a bug.
  const manifestTotals = latestManifest
    ? Object.values(latestManifest.files).reduce(
        (acc, f) => ({ bytes: acc.bytes + f.size, files: acc.files + 1 }),
        { bytes: 0, files: 0 },
      )
    : null;
  const sizeBytes = manifestTotals ? manifestTotals.bytes : row.file_size;
  const totalFiles = manifestTotals ? manifestTotals.files : row.total_files;

  const sessionsList = latestManifest ? deriveSessions(latestManifest.files) : [];
  // S3 version manifests store the version field bare (e.g. "1.0.0").
  // Coerce to tag form for wire consistency with every other version
  // field in the response and with the rest of the data.nemar.org
  // contract (`/<id>/v1.0.0/...`).
  const bidsIndex: BidsIndex | null = latestManifest
    ? {
        version: toVersionTag(latestManifest.version),
        subjects: buildBidsIndex(latestManifest.files),
      }
    : null;

  const latestVersionRow = versions[0] ?? null;

  // Range objects (epic #1144 Phase 2): present only when at least one bound
  // is known, per neuroschema convention -- {min: null, max: null} would be
  // indistinguishable from "not yet computed" on the wire, so the key is
  // omitted entirely rather than emitted with both bounds null.
  const recordingDurationRange: DatasetStatRange | undefined =
    row.recording_duration_min !== null || row.recording_duration_max !== null
      ? { min: row.recording_duration_min, max: row.recording_duration_max }
      : undefined;
  const channelCountRange: DatasetStatRange | undefined =
    row.channel_count_min !== null || row.channel_count_max !== null
      ? { min: row.channel_count_min, max: row.channel_count_max }
      : undefined;
  // Gate on ALL 8 recording-stat columns, not just two of them: migration
  // 0070 documents that channel_count_min/max can be populated independently
  // of recording_count/total_recording_duration (they move together under
  // today's sweep, which always writes all 8 in one UPDATE, but nothing
  // enforces that at the type level -- a future asymmetric write, a partial
  // reset bug, or manual DB surgery must not cause a real, non-null range
  // value to be silently dropped from the response because the other two
  // columns happened to be null).
  const hasRecordingStats =
    row.recording_count !== null ||
    row.recordings_unavailable !== null ||
    row.total_recording_duration !== null ||
    row.recording_duration_min !== null ||
    row.recording_duration_max !== null ||
    row.recordings_measured !== null ||
    row.channel_count_min !== null ||
    row.channel_count_max !== null;

  // signal_defaults (epic #1144 Phase 2b, #1153): omitted (null) unless at
  // least one of the five source columns is populated -- recording_type has
  // no source column and is never part of this gate (it would otherwise
  // never contribute a true condition, which is fine, but it also must
  // never be read as "populated" on its own since it's always null).
  const hasSignalDefaults =
    row.sampling_frequency !== null ||
    row.power_line_frequency !== null ||
    row.eeg_reference !== null ||
    row.placement_scheme !== null ||
    row.electrode_system !== null;

  return {
    schema_version: NEUROSCHEMA_VERSION,
    doc_type: "dataset",
    dataset_id: row.dataset_id,
    name: row.name,
    description,
    source: "nemar",
    recording_modality: recordingModality,
    bids_version: null,
    license,
    authors: buildPersonList(parsedEnrichment),
    keywords,
    related_identifiers: related,
    contributors,
    dates,
    rights: license
      ? [
          {
            rights: license,
            rights_uri: null,
            rights_identifier: license,
            rights_identifier_scheme: "SPDX",
          },
        ]
      : [],
    language: null,
    funding,
    tasks: splitCsv(row.tasks),
    datatypes,
    sessions: sessionsList,
    sessions_count: sessionsList.length > 0 ? sessionsList.length : null,
    demographics:
      row.subject_count !== null
        ? {
            subjects_count: row.subject_count,
            age_min: row.age_min,
            age_max: row.age_max,
          }
        : null,
    data_summary:
      totalFiles !== null || sizeBytes !== null || hasRecordingStats
        ? {
            total_files: totalFiles,
            size_bytes: sizeBytes,
            size_human: formatBytes(sizeBytes),
            recording_count: row.recording_count,
            recordings_unavailable: row.recordings_unavailable,
            total_recording_duration: row.total_recording_duration,
            ...(recordingDurationRange ? { recording_duration_range: recordingDurationRange } : {}),
            ...(channelCountRange ? { channel_count_range: channelCountRange } : {}),
          }
        : null,
    signal_defaults: hasSignalDefaults
      ? {
          sampling_frequency: row.sampling_frequency,
          power_line_frequency: row.power_line_frequency,
          reference: row.eeg_reference,
          recording_type: null,
          channel_system: row.electrode_system,
          placement_scheme: row.placement_scheme,
        }
      : null,
    provenance: {
      // Coerce to tag form to match every other version field on the
      // wire (`extensions.nemar.versions[].version`,
      // `bids_index.version`, the URL grammar). Legacy D1 rows store
      // bare `1.0.0`; toVersionTag is a no-op for already-tagged rows.
      latest_snapshot: latestVersionRow ? toVersionTag(latestVersionRow.version) : null,
      publish_date: latestVersionRow?.created_at ?? null,
    },
    external_links: {
      dataset_doi: row.concept_doi,
      github_url: row.github_repo
        ? row.github_repo.startsWith("http")
          ? row.github_repo
          : `https://github.com/${githubOrg}/${row.dataset_id}`
        : null,
    },
    extensions: {
      nemar: {
        versions: versions.map((v) => {
          const tag = toVersionTag(v.version);
          return {
            version: tag,
            doi: v.doi,
            created_at: v.created_at,
            manifest_url: `/${row.dataset_id}/${tag}/manifest.json`,
          };
        }),
        bids_index: bidsIndex,
        pipeline_stage: v2?.pipeline_stage ?? null,
        data_complete: row.data_complete,
        bytes_present: row.bytes_present,
        recordings_measured: row.recordings_measured,
      },
    },
  };
}

function toDatasetFunding(entry: FundingReferenceEntry): DatasetFunding {
  return {
    funder_name: entry.funder_name,
    award_number: entry.award_number ?? null,
    award_title: entry.award_title ?? null,
    funder_identifier: entry.funder_identifier ?? null,
    funder_identifier_type: entry.funder_identifier_type ?? null,
    award_uri: entry.award_uri ?? null,
  };
}

/**
 * Removed-file note rendered both in the directory-index footer ("files
 * removed since vN-1") and inline in a tombstone 404 page ("last seen in
 * vN-1 at this URL"). Same shape works for both because both answer the
 * same question: "where did this file go?".
 */
export interface RemovedSinceNote {
  lastSeenVersion: string;
  // Names that disappeared at this directory between lastSeenVersion and
  // the rendered version. Each name is rendered with a link to the same
  // path under lastSeenVersion. Empty array suppresses the footer.
  names: string[];
}

export interface VersionPickerEntry {
  version: string;
  isCurrent: boolean;
}

/**
 * Re-export the canonical version canonicalizer so existing importers
 * (routes/data.ts) keep their `from "../services/data-router"` import. The
 * implementation now lives in shared/contract/version.ts, shared by both the
 * catalog and data planes (epic #896, #898).
 */
export { toVersionTag };

export function renderIndexHtml(args: {
  datasetId: string;
  version: string;
  path: string;
  entries: DirectoryEntry[];
  availableVersions?: VersionPickerEntry[];
  removedSinceNote?: RemovedSinceNote | null;
}): string {
  const { datasetId, version, path, entries, availableVersions, removedSinceNote } = args;
  const display = path === "" ? "/" : `/${path}/`;
  const title = `Index of /${datasetId}/${version}${display}`;
  const rows: string[] = [];
  if (path !== "") {
    rows.push('<tr><td><a href="../">../</a></td><td class="size">-</td></tr>');
  }
  for (const e of entries) {
    const href = `${encodeURIComponent(e.name)}${e.kind === "dir" ? "/" : ""}`;
    const label = `${escapeHtml(e.name)}${e.kind === "dir" ? "/" : ""}`;
    const size = e.kind === "dir" ? "-" : humanSize(e.size);
    rows.push(`<tr><td><a href="${href}">${label}</a></td><td class="size">${size}</td></tr>`);
  }

  const idHref = encodeURIComponent(datasetId);
  const versionPicker =
    availableVersions && availableVersions.length > 1
      ? renderVersionPicker(idHref, path, availableVersions)
      : "";

  const removedFooter =
    removedSinceNote && removedSinceNote.names.length > 0
      ? renderRemovedSinceFooter(idHref, path, removedSinceNote)
      : "";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:ui-monospace,Menlo,Consolas,monospace;margin:1.5em;max-width:80em}
h1{font-size:1.05em;margin-bottom:.8em}
nav.versions{font-size:.9em;color:#555;margin-bottom:.8em}
nav.versions a{margin-right:.6em}
nav.versions .current{font-weight:bold;color:#000;margin-right:.6em}
table{border-collapse:collapse;width:100%}
td{padding:.15em .8em;vertical-align:top}
td.size{text-align:right;color:#555;white-space:nowrap}
a{color:#06c;text-decoration:none}
a:hover{text-decoration:underline}
hr{margin-top:2em;border:0;border-top:1px solid #ccc}
.foot{color:#888;font-size:.9em}
details.removed{margin-top:1em;color:#555;font-size:.9em}
details.removed summary{cursor:pointer}
details.removed ul{margin:.4em 0 0;padding-left:1.2em}
</style>
</head><body>
<h1>${escapeHtml(title)}</h1>
${versionPicker}<table>${rows.join("")}</table>
${removedFooter}<hr>
<div class="foot">data.nemar.org &middot; <a href="manifest.json">manifest.json</a> &middot; <a href="records.json">records.json</a> &middot; <a href="/${idHref}/">all versions</a></div>
</body></html>
`;
}

/**
 * Sibling-link version picker rendered above the directory table.
 *
 * Sibling links (not a <select>) keep the picker readable without
 * JS and match the Apache-style table the rest of the page uses.
 * Each link rewrites the version segment while preserving the
 * current sub-path, so switching versions on a deeply-nested
 * directory lands the user on the same directory in the chosen
 * version (or a 404 with a tombstone if that path doesn't exist
 * there -- which is exactly the signal the user wants).
 */
function renderVersionPicker(idHref: string, path: string, versions: VersionPickerEntry[]): string {
  // path is already a normalized BIDS path (no leading/trailing slashes).
  // encodeURI preserves slashes between segments; the segments themselves
  // come from manifest keys which are tightly constrained by BIDS naming.
  const subPath = path === "" ? "" : `${encodeURI(path)}/`;
  const items = versions
    .map((v) => {
      const label = escapeHtml(v.version);
      if (v.isCurrent) return `<span class="current">${label}</span>`;
      const href = `/${idHref}/${encodeURIComponent(v.version)}/${subPath}`;
      return `<a href="${href}">${label}</a>`;
    })
    .join("");
  return `<nav class="versions"><span>version:</span> ${items}</nav>\n`;
}

/**
 * "Files removed since vN-1" footer rendered below the directory table.
 *
 * Each removed name links to the same name under the prior version, so
 * the user can immediately fetch the file from the version where it
 * still exists. Names are HTML-escaped and the href segments are
 * percent-encoded for the same reason as the directory table.
 */
function renderRemovedSinceFooter(idHref: string, path: string, note: RemovedSinceNote): string {
  const prevVersion = encodeURIComponent(note.lastSeenVersion);
  const subPath = path === "" ? "" : `${encodeURI(path)}/`;
  const items = note.names
    .map((name) => {
      const href = `/${idHref}/${prevVersion}/${subPath}${encodeURIComponent(name)}`;
      return `<li><a href="${href}">${escapeHtml(name)}</a></li>`;
    })
    .join("");
  return `<details class="removed"><summary>Files removed since ${escapeHtml(note.lastSeenVersion)} (${note.names.length})</summary><ul>${items}</ul></details>\n`;
}

/**
 * Maximum number of older versions to consult when searching for the
 * last version where a removed path existed. Bounds the worst-case
 * fan-out of a 404: one D1 + S3 manifest fetch per version walked.
 *
 * The cap exists because tombstone responses are UX hinting, not
 * exhaustive provenance -- if a file hasn't existed in the most recent
 * 10 versions, telling the user "we don't know" (`reason: "not_found"`)
 * is a better answer than "we burned 30 manifest fetches to find your
 * answer". The /<id>/ landing page lists every version anyway, so a
 * determined user can still find an old file by browsing.
 */
export const TOMBSTONE_LOOKBACK = 10;

/**
 * Walk older published versions newest-first looking for the first
 * version that contains `path` (exact match). Returns the version tag
 * (with leading `v`) on first hit, or null after the lookback cap.
 *
 * `loadManifest` is injected so the unit tests can hand in a Map-backed
 * stub (per repo policy: no mocked S3 clients). At runtime it's the
 * same `loadManifest` from routes/data.ts.
 *
 * `olderVersions` MUST be ordered newest-first. The caller is responsible
 * for filtering out the current version and only passing what's older.
 */
export async function findLastSeenVersion(args: {
  path: string;
  olderVersions: string[];
  loadManifest: (version: string) => Promise<VersionManifest | null>;
  lookback?: number;
}): Promise<{ version: string } | null> {
  const cap = args.lookback ?? TOMBSTONE_LOOKBACK;
  const walk = args.olderVersions.slice(0, cap);
  for (const v of walk) {
    const manifest = await args.loadManifest(v);
    if (!manifest) continue;
    if (Object.hasOwn(manifest.files, args.path)) return { version: v };
  }
  return null;
}

/**
 * Compare the directory listing at `path` under the rendered version
 * against the same listing under `priorVersion`. Returns the names that
 * existed in the prior version but are absent now. Used to populate the
 * "Files removed since vN-1" footer on directory index pages.
 *
 * Only direct children are compared. Subdirectories that disappeared
 * appear as `dir` names; files that disappeared appear as `file` names.
 * That distinction is intentionally lost in the rendered footer (both
 * are just names with hrefs) -- it doesn't add value to say "directory
 * sub-99/ was removed" when the user can click through and see.
 */
export function diffRemovedSince(
  currentEntries: DirectoryEntry[],
  priorManifest: VersionManifest,
  path: string,
): string[] {
  const prior = resolveFile(priorManifest, path);
  if (prior.kind !== "directory") return [];
  const currentNames = new Set(currentEntries.map((e) => e.name));
  const removed: string[] = [];
  for (const child of prior.children) {
    if (!currentNames.has(child.name)) removed.push(child.name);
  }
  return removed.sort();
}

/**
 * Decide JSON vs HTML for the response based on Accept header and
 * optional ?format= override. Defaults to JSON: API consumers (curl
 * piped to jq, eegdash-viewer's fetch) are the primary audience for
 * 404 bodies and the dataset landing page; browsers explicitly
 * request text/html so they get the HTML page.
 *
 * The `?format=` query parameter is the explicit override -- useful
 * when a user wants the JSON shape from a browser tab.
 */
export function pickResponseFormat(args: {
  accept: string | null;
  formatParam: string | null;
}): "html" | "json" {
  if (args.formatParam === "json") return "json";
  if (args.formatParam === "html") return "html";
  // text/html in the Accept header (with any q-value) -> HTML. This
  // matches what every browser sends. Anything else (application/json,
  // */*, no header) -> JSON.
  if (args.accept && /\btext\/html\b/.test(args.accept)) return "html";
  return "json";
}

export interface LandingVersion {
  version: string;
  doi: string | null;
  created_at: string | null;
  manifest_url: string;
  browse_url: string;
}

/** Latest-only downloadable-archive state (#752). `status` is 'ready'/'failed'/
 *  null; a non-null `skip_reason` means the zip was intentionally skipped by the
 *  size policy (status stays null) and the consumer should render the direct
 *  per-file download recipe instead of a zip button. */
export interface LandingArchive {
  status: string | null;
  size: number | null;
  skip_reason: string | null;
}

export interface LandingPayload {
  dataset_id: string;
  latest: string | null;
  metadata_url: string;
  versions: LandingVersion[];
  archive: LandingArchive;
}

/**
 * Build the JSON-form payload returned by `/<id>/` when the client
 * asks for JSON. The HTML page renders the same data; keeping both
 * paths fed by one builder means the two response shapes can't drift.
 */
export function buildLandingPayload(args: {
  datasetId: string;
  versionRows: DatasetVersionRow[];
  archive?: { status?: string | null; size?: number | null; skip_reason?: string | null };
}): LandingPayload {
  const { datasetId, versionRows } = args;
  const versions: LandingVersion[] = versionRows.map((row) => {
    const tag = row.version.startsWith("v") ? row.version : `v${row.version}`;
    return {
      version: tag,
      doi: row.doi ?? null,
      created_at: row.created_at ?? null,
      manifest_url: `/${datasetId}/${tag}/manifest.json`,
      browse_url: `/${datasetId}/${tag}/`,
    };
  });
  return {
    dataset_id: datasetId,
    latest: versions.length > 0 ? versions[0].version : null,
    metadata_url: `/${datasetId}/metadata.json`,
    versions,
    archive: {
      status: args.archive?.status ?? null,
      size: args.archive?.size ?? null,
      skip_reason: args.archive?.skip_reason ?? null,
    },
  };
}

/**
 * Render the HTML form of the dataset landing page (`/<id>/`). Lists
 * every published version with its DOI and creation date, plus links
 * to the per-version browse page, manifest, and sibling metadata.json.
 *
 * The "no published versions yet" branch keeps the same chrome so a
 * machine consumer that happens to fetch HTML still gets a well-formed
 * page with the dataset id and the metadata.json pointer.
 */
export function renderDatasetLandingHtml(payload: LandingPayload): string {
  const id = escapeHtml(payload.dataset_id);
  const idHref = encodeURIComponent(payload.dataset_id);
  const metaHref = escapeHtml(payload.metadata_url);
  const rows = payload.versions
    .map((v, i) => {
      const tag = escapeHtml(v.version);
      const tagHref = encodeURIComponent(v.version);
      const browseHref = `/${idHref}/${tagHref}/`;
      const manifestHref = `/${idHref}/${tagHref}/manifest.json`;
      const recordsHref = `/${idHref}/${tagHref}/records.json`;
      const created = v.created_at ? escapeHtml(v.created_at.slice(0, 10)) : "-";
      const doiCell = v.doi
        ? `<a href="https://doi.org/${escapeHtml(v.doi)}">${escapeHtml(v.doi)}</a>`
        : "-";
      const latestMark = i === 0 ? ' <span class="latest">(latest)</span>' : "";
      return `<tr><td><a href="${browseHref}">${tag}/</a>${latestMark}</td><td>${created}</td><td>${doiCell}</td><td><a href="${manifestHref}">manifest.json</a> &middot; <a href="${recordsHref}">records.json</a></td></tr>`;
    })
    .join("");
  const emptyNotice =
    payload.versions.length === 0
      ? `<p class="empty">No published versions yet. <a href="${metaHref}">metadata.json</a> may still be populated from the catalog row.</p>`
      : "";
  const table =
    payload.versions.length === 0
      ? ""
      : `<table><thead><tr><th>version</th><th>published</th><th>DOI</th><th>files</th></tr></thead><tbody>${rows}</tbody></table>`;
  const latestShortcut =
    payload.latest !== null
      ? `<p class="shortcut">Latest: <a href="/${idHref}/latest/">/${id}/latest/</a> &middot; <a href="/${idHref}/latest/manifest.json">latest manifest.json</a> &middot; <a href="/${idHref}/latest/records.json">latest records.json</a></p>`
      : "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${id}</title>
<style>
body{font-family:ui-monospace,Menlo,Consolas,monospace;margin:1.5em;max-width:80em}
h1{font-size:1.2em;margin-bottom:.4em}
table{border-collapse:collapse;width:100%;margin-top:.6em}
th,td{padding:.25em .8em;text-align:left;vertical-align:top;border-bottom:1px solid #eee}
th{color:#555;font-weight:normal}
a{color:#06c;text-decoration:none}
a:hover{text-decoration:underline}
.latest{color:#070;font-weight:bold}
.shortcut{color:#333;font-size:.95em}
.empty{color:#888}
hr{margin-top:2em;border:0;border-top:1px solid #ccc}
.foot{color:#888;font-size:.9em}
</style>
</head><body>
<h1>${id}</h1>
${latestShortcut}${emptyNotice}${table}
<hr>
<div class="foot">data.nemar.org &middot; <a href="${metaHref}">metadata.json</a></div>
</body></html>
`;
}

/**
 * Catalog index types — the public JSON shape served by `GET /` on
 * data.nemar.org. One row per dataset; per-version expansion lives on
 * the per-id landing page that each row links to.
 *
 * Invariant maintained by `buildCatalogIndexPayload`: `count` always
 * equals `datasets.length`. `count` is on the wire so JSON consumers
 * can read it without parsing the array; do not construct payloads
 * outside the builder.
 */
export interface CatalogIndexRow {
  dataset_id: string;
  name: string | null;
  concept_doi: string | null;
  latest_version: string | null;
  latest_published_at: string | null;
  /** Staging exemplar flag (epic #923). Admits an xx-prefixed id through the
   *  public-catalog gate; never 1 in production. */
  is_exemplar?: number | null;
}

export interface CatalogIndexEntry {
  id: string;
  title: string | null;
  latest: string | null;
  doi: string | null;
  published: string | null;
  browse_url: string;
}

export interface CatalogIndexPayload {
  count: number;
  datasets: CatalogIndexEntry[];
}

export interface CatalogIndexBuildResult {
  payload: CatalogIndexPayload;
  droppedIds: string[];
}

/**
 * Per-id gate used by the catalog index. The route's SQL already
 * filters at the query layer; this is the same predicate expressed in
 * TS so the pure payload builder can re-assert it without a D1 binding,
 * and tests can exercise the filter directly. Defense in depth: a
 * future schema change that loosens the SQL won't silently leak
 * sandbox, test-only, or malformed ids into the public index.
 *
 * The `isValidDatasetId` call enforces the canonical id shape (e.g.
 * `nm000132`), which the route handler relies on when concatenating
 * the id into URL paths and `href=` attributes — a malformed id
 * slipping through here would produce a broken link or, in theory,
 * a markup injection vector.
 *
 * `opts.isExemplar` (epic #923) admits a staging exemplar xx id (is_exemplar=1,
 * never present in production) through the xx block; all other guards still
 * apply, including the shape check and the nm099999 test-dataset exclusion.
 */
export function isPublicCatalogId(id: string, opts?: { isExemplar?: boolean }): boolean {
  if (!isValidDatasetId(id)) return false;
  if (id === "nm099999") return false;
  if (id.startsWith("xx") && !opts?.isExemplar) return false;
  return true;
}

/**
 * Build the JSON-form payload returned by `GET /` when the client asks
 * for JSON. Mirrors the relationship between `buildLandingPayload` and
 * `renderDatasetLandingHtml`: a single builder feeds both the HTML and
 * the JSON response so the two shapes can't drift.
 *
 * `latest` is normalized to a `vX.Y.Z` tag via `toVersionTag` so it
 * matches the on-disk version directory name (`/<id>/<tag>/`). The
 * ascending sort by id is asserted here so the page is stable even if
 * the SQL ORDER BY is later changed or dropped.
 *
 * `droppedIds` lets the caller log a warning when the SQL filter and
 * the TS filter disagree — that's a signal of schema drift, not a
 * routine case, and silently dropping rows would hide the bug.
 */
export function buildCatalogIndexPayload(args: {
  rows: CatalogIndexRow[];
}): CatalogIndexBuildResult {
  const droppedIds: string[] = [];
  const datasets: CatalogIndexEntry[] = args.rows
    .filter((r) => {
      if (isPublicCatalogId(r.dataset_id, { isExemplar: r.is_exemplar === 1 })) return true;
      droppedIds.push(r.dataset_id);
      return false;
    })
    .map((r) => ({
      id: r.dataset_id,
      title: r.name && r.name.trim() !== "" ? r.name : null,
      latest: r.latest_version ? toVersionTag(r.latest_version) : null,
      doi: r.concept_doi,
      published: r.latest_published_at,
      browse_url: `/${r.dataset_id}/`,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    payload: { count: datasets.length, datasets },
    droppedIds,
  };
}

/**
 * Render the HTML form of the catalog index served at `data.nemar.org/`.
 * Shares the CSS baseline of `renderDatasetLandingHtml` (monospace,
 * narrow chrome, footer with "data.nemar.org"); the per-id landing
 * additionally styles a `.latest` highlight that doesn't apply here.
 * Each row links to `/<id>/` which is the existing per-dataset landing.
 *
 * Empty-catalog branch keeps the same chrome so a machine consumer that
 * fetches HTML still gets a well-formed page with a stable structure
 * (no surprise 404 or blank body).
 */
export function renderCatalogIndexHtml(payload: CatalogIndexPayload): string {
  const rows = payload.datasets
    .map((d) => {
      const id = escapeHtml(d.id);
      const idHref = encodeURIComponent(d.id);
      const title = d.title ? escapeHtml(d.title) : "-";
      const latest = d.latest ? escapeHtml(d.latest) : "-";
      const doiCell = d.doi
        ? `<a href="https://doi.org/${escapeHtml(d.doi)}">${escapeHtml(d.doi)}</a>`
        : "-";
      // Slice yields "" for an empty input string and a malformed
      // (non-ISO) value also degrades cleanly; either way fall back
      // to "-" rather than rendering an empty cell.
      const publishedSlice = d.published ? d.published.slice(0, 10) : "";
      const published = publishedSlice ? escapeHtml(publishedSlice) : "-";
      return `<tr><td><a href="/${idHref}/">${id}/</a></td><td>${title}</td><td>${latest}</td><td>${doiCell}</td><td>${published}</td></tr>`;
    })
    .join("");
  const table =
    payload.datasets.length === 0
      ? `<p class="empty">No publicly-hosted datasets yet.</p>`
      : `<table><thead><tr><th>dataset</th><th>title</th><th>latest</th><th>DOI</th><th>published</th></tr></thead><tbody>${rows}</tbody></table>`;
  const summary = `<p class="shortcut">${payload.count} dataset${payload.count === 1 ? "" : "s"} hosted. Click an id to see all versions, or jump straight to <code>/&lt;id&gt;/latest/</code>.</p>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>data.nemar.org</title>
<style>
body{font-family:ui-monospace,Menlo,Consolas,monospace;margin:1.5em;max-width:80em}
h1{font-size:1.2em;margin-bottom:.4em}
table{border-collapse:collapse;width:100%;margin-top:.6em}
th,td{padding:.25em .8em;text-align:left;vertical-align:top;border-bottom:1px solid #eee}
th{color:#555;font-weight:normal}
a{color:#06c;text-decoration:none}
a:hover{text-decoration:underline}
.shortcut{color:#333;font-size:.95em}
.empty{color:#888}
code{font-size:.95em}
hr{margin-top:2em;border:0;border-top:1px solid #ccc}
.foot{color:#888;font-size:.9em}
</style>
</head><body>
<h1>data.nemar.org</h1>
${summary}${table}
<hr>
<div class="foot">data.nemar.org &middot; <a href="/?format=json">json</a></div>
</body></html>
`;
}

/**
 * Render an HTML 404 page for a file path. When `lastSeen` is provided
 * the page tells the user the version where the file last existed and
 * links to that URL. Without `lastSeen` it's a generic friendly 404.
 *
 * Mirrors the visual style of renderIndexHtml so a user clicking
 * around the directory tree experiences a coherent UI.
 */
export function renderTombstone404Html(args: {
  datasetId: string;
  version: string;
  path: string;
  lastSeen: { version: string; href: string } | null;
}): string {
  const { datasetId, version, path, lastSeen } = args;
  const id = escapeHtml(datasetId);
  const idHref = encodeURIComponent(datasetId);
  const v = escapeHtml(version);
  const p = escapeHtml(path);
  const body = lastSeen
    ? `<p>This file was removed between versions. It was last present in <strong>${escapeHtml(lastSeen.version)}</strong>:</p>
<p><a href="${escapeHtml(lastSeen.href)}">${escapeHtml(lastSeen.href)}</a></p>`
    : `<p>No file at this path in <strong>${v}</strong>, and no record of it in any recent version.</p>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>404 - ${id}/${v}/${p}</title>
<style>
body{font-family:ui-monospace,Menlo,Consolas,monospace;margin:1.5em;max-width:80em}
h1{font-size:1.05em;margin-bottom:.8em}
a{color:#06c;text-decoration:none}
a:hover{text-decoration:underline}
hr{margin-top:2em;border:0;border-top:1px solid #ccc}
.foot{color:#888;font-size:.9em}
</style>
</head><body>
<h1>404 &middot; ${id}/${v}/${p}</h1>
${body}
<p><a href="/${idHref}/">all versions of ${id}</a></p>
<hr>
<div class="foot">data.nemar.org</div>
</body></html>
`;
}
