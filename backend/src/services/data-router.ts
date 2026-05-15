/**
 * Pure functions backing the `data.nemar.org` route (epic #449).
 *
 * Resolves a (datasetId, version, path) tuple against an in-memory
 * VersionManifest into either a file 302 target or a directory listing.
 * D1 / S3 / network access lives in the Hono handlers; everything here
 * is synchronous and unit-testable, except resolveVersion which needs D1
 * for the "latest" lookup.
 */

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
