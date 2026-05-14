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
import { generatePresignedGetUrl } from "./s3";

interface S3Options {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export const VERSION_TAG_RE = /^v\d+\.\d+\.\d+$/;

export type ResolvedVersion =
  | { ok: true; version: string }
  | { ok: false; reason: "no_published_versions" | "invalid_version" };

export interface DirectoryEntry {
  name: string;
  isDir: boolean;
  size?: number;
}

export type ResolvedFile =
  | { kind: "file"; path: string; file: ManifestFile }
  | { kind: "directory"; path: string; children: DirectoryEntry[] }
  | { kind: "not_found" };

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

function normalizePath(rawPath: string): string | null {
  const stripped = rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (stripped === "") return "";
  const parts = stripped.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === ".." || part.startsWith("/")) return null;
  }
  return parts.join("/");
}

/**
 * Map a bids-path inside a manifest to: a file (exact match), a directory
 * (any manifest entry has this as a prefix), or not_found.
 */
export function resolveFile(manifest: VersionManifest, rawPath: string): ResolvedFile {
  const normalized = normalizePath(rawPath);
  if (normalized === null) return { kind: "not_found" };

  if (normalized !== "" && manifest.files[normalized]) {
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
      seen.set(rest, { name: rest, isDir: false, size: file.size });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) seen.set(name, { name, isDir: true });
    }
  }

  if (seen.size === 0) return { kind: "not_found" };
  const children = [...seen.values()].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { kind: "directory", path: normalized, children };
}

const ANNEX_KEY_RE = /^[A-Z0-9]+-s\d+--/;

/**
 * Build the URL the Worker 302s to for a resolved file.
 *
 * Annex-backed files (key like `SHA256E-s12345--...edf`) -> presigned S3
 * GET against `<datasetId>/objects/<key>`. git-backed files
 * (`key: "git:<blob-sha>"`, used for small in-tree files like
 * dataset_description.json) -> raw.githubusercontent.com URL pinned to
 * the version tag.
 */
export async function buildRedirectUrl(args: {
  datasetId: string;
  version: string;
  bidsPath: string;
  file: ManifestFile;
  s3Options: S3Options;
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
  if (bytes < 1024) return `${bytes}`;
  const units = ["K", "M", "G", "T"];
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
    const href = `${encodeURIComponent(e.name)}${e.isDir ? "/" : ""}`;
    const label = `${escapeHtml(e.name)}${e.isDir ? "/" : ""}`;
    const size = e.isDir ? "-" : humanSize(e.size ?? 0);
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
