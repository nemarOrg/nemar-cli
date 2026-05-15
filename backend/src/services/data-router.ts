/**
 * Pure functions backing the `data.nemar.org` route (epic #449).
 *
 * Resolves a (datasetId, version, path) tuple against an in-memory
 * VersionManifest into either a file 302 target or a directory listing.
 * D1 / S3 / network access lives in the Hono handlers; everything here
 * is synchronous and unit-testable, except resolveVersion which needs D1
 * for the "latest" lookup.
 */

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
import type { ManifestFile, VersionManifest } from "./manifest";
import { type PresignedUrlOptions, generatePresignedGetUrl } from "./s3";

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

function normalizePath(rawPath: string): string | null {
  const stripped = rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (stripped === "") return "";
  const parts = stripped.split("/");
  for (const part of parts) {
    if (FORBIDDEN_SEGMENTS.has(part)) return null;
    if (part.startsWith("/")) return null;
  }
  return parts.join("/");
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
 * Build the URL the Worker 302s to for a resolved file.
 *
 * Annex-backed files (key like `SHA256E-s12345--...edf`, also `MD5E-`,
 * `SHA1E-`, etc.) -> presigned S3 GET against `<datasetId>/objects/<key>`.
 *
 * git-backed files (`key: "git:<blob-sha>"`, used for small in-tree files
 * like dataset_description.json) -> raw.githubusercontent.com URL pinned
 * to the version tag.
 *
 * Implicit invariant for the git: branch: the dataset's GitHub repo must
 * be public AND the version tag must exist on it. Both are guaranteed by
 * the publication workflow today (publish-approve flips the repo to
 * public before writing the D1 version row, which only happens after a
 * successful tag push). If that invariant ever breaks, the 302 target
 * itself returns 404 to the user with no Worker-side signal. Tracked as
 * a Phase 3 follow-up on epic #449.
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
  return generatePresignedGetUrl(s3Options, `${datasetId}/objects/${file.key}`, expiresIn ?? 3600);
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

// ===========================================================================
// metadata.json builders (epic #449 phase 2)
//
// Composes a neuroschema v0.3.0 `dataset` document from the catalog row in
// D1, the parsed nemar_metadata.json enrichment payload, the dataset_versions
// list, and (optionally) the latest version's S3 manifest. All pure: no D1,
// S3, or network access happens here; callers in routes/data.ts wire the I/O.
//
// The wire format mirrors `~/Documents/git/nemar/neuroschema/schema/core/dataset.schema.json`
// (v0.3.0). NEMAR-specific aggregates that aren't part of the FAIR core
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

export interface DatasetDataSummary {
  total_files: number | null;
  size_bytes: number | null;
  size_human: string | null;
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
}

export interface NeuroschemaDataset {
  schema_version: "0.3.0";
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
 * Format bytes as a neuroschema-style `size_human` string (e.g. "1.15 GB",
 * "450 MB", "120 KB"). Distinct from `humanSize` which is a compact form
 * used by the HTML directory index. Null in, null out.
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
  return `${value.toFixed(value >= 100 ? 0 : 2)} ${units[unit]}`;
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
    if (parts.length < 3) continue;
    const subject = parts[0];
    if (!BIDS_SUB_RE.test(subject)) continue;

    let modalityIdx = 1;
    let sessionLabel: string | null = null;
    if (BIDS_SES_RE.test(parts[1])) {
      sessionLabel = parts[1].slice("ses-".length);
      modalityIdx = 2;
    }
    if (modalityIdx >= parts.length - 1) continue;
    const modality = parts[modalityIdx];
    const filename = parts[parts.length - 1];
    const taskMatch = filename.match(BIDS_TASK_TOKEN_RE);
    if (!taskMatch) continue;
    const task = taskMatch[1];
    const runMatch = filename.match(BIDS_RUN_TOKEN_RE);

    if (!acc[subject]) {
      acc[subject] = { sessions: new Set(), modalities: new Map() };
    }
    if (sessionLabel !== null) acc[subject].sessions.add(sessionLabel);
    if (!acc[subject].modalities.has(modality)) {
      acc[subject].modalities.set(modality, new Map());
    }
    const tasksMap = acc[subject].modalities.get(modality);
    if (!tasksMap) continue;
    if (!tasksMap.has(task)) tasksMap.set(task, new Set());
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

  const description = row.description ?? v2?.description ?? v1?.description ?? null;
  const license = v2?.license ?? null;
  const keywords: StructuredKeyword[] = v2?.keywords ?? [];
  const related: RelatedIdentifierEntry[] = v2?.related_identifiers ?? [];
  const contributors: ContributorEntry[] = v2?.contributors ?? [];
  const dates: StructuredDate[] = v2?.dates ?? [];
  const funding: DatasetFunding[] = (v2?.funding_references ?? []).map(toDatasetFunding);

  const sessionsList = latestManifest ? deriveSessions(latestManifest.files) : [];
  const bidsIndex: BidsIndex | null = latestManifest
    ? {
        version: latestManifest.version,
        subjects: buildBidsIndex(latestManifest.files),
      }
    : null;

  const latestVersionRow = versions[0] ?? null;

  return {
    schema_version: "0.3.0",
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
      row.total_files !== null || row.file_size !== null
        ? {
            total_files: row.total_files,
            size_bytes: row.file_size,
            size_human: formatBytes(row.file_size),
          }
        : null,
    provenance: {
      latest_snapshot: latestVersionRow?.version ?? null,
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
        versions: versions.map((v) => ({
          version: v.version,
          doi: v.doi,
          created_at: v.created_at,
          manifest_url: `/${row.dataset_id}/v${v.version.replace(/^v/, "")}/manifest.json`,
        })),
        bids_index: bidsIndex,
        pipeline_stage: v2?.pipeline_stage ?? null,
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

export function renderIndexHtml(args: {
  datasetId: string;
  version: string;
  path: string;
  entries: DirectoryEntry[];
}): string {
  const { datasetId, version, path, entries } = args;
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
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:ui-monospace,Menlo,Consolas,monospace;margin:1.5em;max-width:80em}
h1{font-size:1.05em;margin-bottom:.8em}
table{border-collapse:collapse;width:100%}
td{padding:.15em .8em;vertical-align:top}
td.size{text-align:right;color:#555;white-space:nowrap}
a{color:#06c;text-decoration:none}
a:hover{text-decoration:underline}
hr{margin-top:2em;border:0;border-top:1px solid #ccc}
.foot{color:#888;font-size:.9em}
</style>
</head><body>
<h1>${escapeHtml(title)}</h1>
<table>${rows.join("")}</table>
<hr>
<div class="foot">data.nemar.org &middot; <a href="manifest.json">manifest.json</a></div>
</body></html>
`;
}
