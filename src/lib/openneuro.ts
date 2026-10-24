/**
 * OpenNeuro dataset download support
 *
 * Downloads datasets directly from OpenNeuro's public S3 bucket (openneuro.org)
 * using AWS CLI (primary) or direct HTTPS (fallback). No authentication required.
 */

import { spawn } from "bun";
import { isOpenNeuroTag } from "../../shared/openneuro-tag.js";
import type { SnapshotFile } from "../../shared/upstream-staleness.js";
import { isAwsCliAvailable } from "./aws-cli.js";
import { type RemoteFile, downloadFiles } from "./file-download.js";

const OPENNEURO_S3_BUCKET = "openneuro.org";
const OPENNEURO_S3_REGION = "us-east-1";
const OPENNEURO_S3_BASE_URL = `https://s3.amazonaws.com/${OPENNEURO_S3_BUCKET}`;
const OPENNEURO_DATASET_REGEX = /^ds\d{6}$/;

export function isOpenNeuroDatasetId(id: string): boolean {
  return OPENNEURO_DATASET_REGEX.test(id);
}

/** OpenNeuro's GraphQL endpoint: the same one the Worker's discovery reads. */
export const OPENNEURO_GRAPHQL_URL = "https://openneuro.org/crn/graphql";

/** The latest snapshot tag OpenNeuro names for a dataset, or why there is none. */
export type LatestTagLookup = { tag: string } | { tag: null; reason: string };

/**
 * Ask OpenNeuro which snapshot tag is a dataset's latest (`latestSnapshot.tag`), the tag an import
 * with no `--tag` is pinned to (ADR 0111 decision 10). Never throws: every way of not knowing --
 * the API unreachable, an error answer, a dataset with no snapshot, a tag of an unexpected shape --
 * comes back as `{ tag: null, reason }`, which prepare refuses as a mirror lag, so the retry engine
 * tries again later rather than an import guessing at HEAD.
 *
 * `graphqlUrl` moves the endpoint for a test of the refusal paths; `attempts` bounds the retries
 * of a transient failure (an HTTP error or a network error, not an answer that says "no snapshot").
 */
export async function fetchOpenNeuroLatestTag(
  datasetId: string,
  options: {
    graphqlUrl?: string;
    attempts?: number;
    timeoutMs?: number;
    retryDelayMs?: number;
  } = {},
): Promise<LatestTagLookup> {
  const url = options.graphqlUrl ?? OPENNEURO_GRAPHQL_URL;
  const attempts = Math.max(1, options.attempts ?? 3);
  let reason = "no attempt was made";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let json: unknown;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "nemar-cli" },
        body: JSON.stringify({
          query: "query LatestTag($id: ID!) { dataset(id: $id) { latestSnapshot { tag } } }",
          variables: { id: datasetId },
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
      if (!res.ok) {
        reason = `OpenNeuro GraphQL answered HTTP ${res.status}`;
        if (attempt < attempts) await delay(options.retryDelayMs ?? 2_000 * attempt);
        continue;
      }
      json = await res.json();
    } catch (err) {
      reason = `OpenNeuro GraphQL unreachable (${err instanceof Error ? err.message : String(err)})`;
      if (attempt < attempts) await delay(options.retryDelayMs ?? 2_000 * attempt);
      continue;
    }
    // An answer: whatever it says is final for this run, so no retry.
    const root = isRecord(json) ? json : {};
    const data = isRecord(root.data) ? root.data : {};
    const dataset = isRecord(data.dataset) ? data.dataset : null;
    const snapshot = dataset && isRecord(dataset.latestSnapshot) ? dataset.latestSnapshot : null;
    const tag = snapshot?.tag;
    if (isOpenNeuroTag(tag)) return { tag };
    if (typeof tag === "string") {
      return { tag: null, reason: "OpenNeuro named a latest tag of an unexpected shape" };
    }
    const errors = Array.isArray(root.errors) ? root.errors : [];
    const message = errors
      .map((e) => (isRecord(e) && typeof e.message === "string" ? e.message : null))
      .filter((m): m is string => m !== null)
      .join("; ")
      .slice(0, 200);
    if (dataset === null) {
      return {
        tag: null,
        reason: message ? `OpenNeuro: ${message}` : "OpenNeuro knows no such dataset",
      };
    }
    return { tag: null, reason: "OpenNeuro names no snapshot for this dataset yet" };
  }
  return { tag: null, reason };
}

/** Two snapshots' file listings, or why they could not be read. */
export type SnapshotFilePairLookup =
  | { ok: true; from: SnapshotFile[]; to: SnapshotFile[] }
  | { ok: false; error: string };

const SNAPSHOT_FILE_PAIR_QUERY = `query SnapshotFilePair($ds: ID!, $from: String!, $to: String!) {
  a: snapshot(datasetId: $ds, tag: $from) { files(recursive: true) { id filename size annexed directory } }
  b: snapshot(datasetId: $ds, tag: $to) { files(recursive: true) { id filename size annexed directory } }
}`;

/**
 * A listing as OpenNeuro sends it, or the reason it is not one. A listing that cannot be a BIDS
 * snapshot is a failure, never a delta: no non-directory entry (an empty tree would make every
 * file of the other snapshot look added or deleted), no root `dataset_description.json`, a size
 * that is not a non-negative integer, or two entries with one filename.
 */
function readFileList(node: unknown, which: string): SnapshotFile[] | string {
  const files = isRecord(node) ? node.files : undefined;
  if (!Array.isArray(files)) return `OpenNeuro sent no file list for the ${which} snapshot`;
  const out: SnapshotFile[] = [];
  const seen = new Set<string>();
  for (const [i, f] of files.entries()) {
    const ok =
      isRecord(f) &&
      typeof f.filename === "string" &&
      typeof f.id === "string" &&
      typeof f.annexed === "boolean" &&
      (f.size === null || (Number.isSafeInteger(f.size) && (f.size as number) >= 0)) &&
      (f.directory === undefined || f.directory === null || typeof f.directory === "boolean");
    if (!ok) return `OpenNeuro sent a malformed file entry (${which} snapshot, entry ${i})`;
    const entry = f as Record<string, unknown>;
    if (seen.has(entry.filename as string)) {
      return `OpenNeuro listed ${entry.filename} twice (${which} snapshot, entry ${i})`;
    }
    seen.add(entry.filename as string);
    out.push({
      filename: entry.filename as string,
      id: entry.id as string,
      size: entry.size as number | null,
      annexed: entry.annexed as boolean,
      directory: entry.directory === true,
    });
  }
  if (!out.some((f) => !f.directory)) {
    return `OpenNeuro sent an empty file list for the ${which} snapshot`;
  }
  if (!out.some((f) => !f.directory && f.filename === "dataset_description.json")) {
    return `OpenNeuro sent a file list with no root dataset_description.json for the ${which} snapshot`;
  }
  return out;
}

/**
 * Read the recursive file listings of two snapshots of one dataset in ONE request (`nemar admin
 * upstream-status --measure`, ADR 0111 Phase 4c). Listings are large (a few MB for a dataset of
 * thousands of files), so this runs on the administrator's machine and never in the Worker.
 *
 * Never throws, and NEVER turns a failure into an empty list: an empty list would claim that a
 * snapshot has no files, and the delta computed from it would be a confident wrong number. A
 * non-2xx, a network error, a timeout, a body that is not JSON, a snapshot OpenNeuro could not
 * serve, a `files` that is not a list, or a malformed entry each come back as `{ ok: false }`.
 * The dataset and tags travel only as variables.
 */
export async function fetchSnapshotFilePair(
  ds: string,
  fromTag: string,
  toTag: string,
  options: { graphqlUrl?: string; timeoutMs?: number } = {},
): Promise<SnapshotFilePairLookup> {
  let json: unknown;
  try {
    const res = await fetch(options.graphqlUrl ?? OPENNEURO_GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "nemar-cli" },
      body: JSON.stringify({
        query: SNAPSHOT_FILE_PAIR_QUERY,
        variables: { ds, from: fromTag, to: toTag },
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });
    if (!res.ok) return { ok: false, error: `OpenNeuro GraphQL answered HTTP ${res.status}` };
    json = await res.json();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `OpenNeuro GraphQL unreadable (${why})` };
  }
  const root = isRecord(json) ? json : {};
  const data = isRecord(root.data) ? root.data : {};
  const errors = Array.isArray(root.errors) ? root.errors : [];
  const message = errors
    .map((e) => (isRecord(e) && typeof e.message === "string" ? e.message : null))
    .filter((m): m is string => m !== null)
    .join("; ")
    .slice(0, 200);
  // Data beside errors is a partial answer: nothing in it can be trusted as the whole listing.
  if (errors.length > 0) {
    return { ok: false, error: `OpenNeuro reported an error${message ? `: ${message}` : ""}` };
  }
  const from = readFileList(data.a, fromTag);
  const to = readFileList(data.b, toTag);
  if (typeof from !== "string" && typeof to !== "string") return { ok: true, from, to };
  const why = typeof from === "string" ? from : (to as string);
  return { ok: false, error: why };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface S3Object {
  key: string;
  size: number;
}

export interface OpenNeuroDownloadResult {
  success: boolean;
  filesDownloaded: number;
  totalBytes: number;
  method: "aws-cli" | "https";
  error?: string;
}

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

/**
 * Check if an OpenNeuro dataset exists on S3.
 * Accepts an optional pre-computed AWS CLI availability flag to avoid
 * spawning `aws --version` twice in the same flow.
 *
 * Throws on network errors so callers can distinguish "not found" from
 * "could not reach S3".
 */
export async function openNeuroDatasetExists(
  datasetId: string,
  hasAwsCli?: boolean,
): Promise<boolean> {
  const awsAvailable = hasAwsCli ?? (await isAwsCliAvailable());

  if (awsAvailable) {
    try {
      const proc = spawn({
        cmd: [
          "aws",
          "s3",
          "ls",
          "--no-sign-request",
          "--region",
          OPENNEURO_S3_REGION,
          `s3://${OPENNEURO_S3_BUCKET}/${datasetId}/`,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      // Read stdout before awaiting exit to avoid pipe buffer deadlock
      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) return false;
      return output.trim().length > 0;
    } catch {
      // AWS CLI spawn failed unexpectedly; fall through to HTTPS check
    }
  }

  const url = `${OPENNEURO_S3_BASE_URL}?list-type=2&prefix=${datasetId}/&max-keys=1`;
  const response = await fetch(url);
  if (!response.ok) return false;
  const text = await response.text();
  return text.includes("<Key>");
}

/**
 * List all objects in an OpenNeuro dataset on S3.
 * Handles pagination for datasets with >1000 files.
 */
export async function listOpenNeuroObjects(datasetId: string): Promise<S3Object[]> {
  const objects: S3Object[] = [];
  let continuationToken: string | undefined;

  do {
    let url = `${OPENNEURO_S3_BASE_URL}?list-type=2&prefix=${datasetId}/`;
    if (continuationToken) {
      url += `&continuation-token=${encodeURIComponent(continuationToken)}`;
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to list OpenNeuro dataset: HTTP ${response.status}`);
    }

    const xml = await response.text();

    // Parse each <Contents> block for key and size
    const contentBlocks = xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || [];
    for (const block of contentBlocks) {
      const keyMatch = block.match(/<Key>([^<]+)<\/Key>/);
      const sizeMatch = block.match(/<Size>(\d+)<\/Size>/);
      if (keyMatch && sizeMatch) {
        const key = decodeXmlEntities(keyMatch[1]);
        const size = Number.parseInt(sizeMatch[1], 10);
        if (key.endsWith("/") && size === 0) continue;
        objects.push({ key, size });
      }
    }

    const truncated = xml.includes("<IsTruncated>true</IsTruncated>");
    if (truncated) {
      const tokenMatch = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
      if (!tokenMatch) {
        throw new Error(
          `S3 listing indicated more results but no continuation token was provided. Got ${objects.length} objects so far.`,
        );
      }
      continuationToken = decodeXmlEntities(tokenMatch[1]);
    } else {
      continuationToken = undefined;
    }
  } while (continuationToken);

  return objects;
}

/**
 * Download an OpenNeuro dataset using AWS CLI (primary, faster method).
 */
export async function downloadWithAwsCli(
  datasetId: string,
  outputPath: string,
  onFileDownloaded?: (count: number, file: string) => void,
): Promise<OpenNeuroDownloadResult> {
  const s3Source = `s3://${OPENNEURO_S3_BUCKET}/${datasetId}/`;

  const cmd = [
    "aws",
    "s3",
    "sync",
    "--no-sign-request",
    "--region",
    OPENNEURO_S3_REGION,
    s3Source,
    outputPath,
  ];

  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn({
      cmd,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return {
      success: false,
      filesDownloaded: 0,
      totalBytes: 0,
      method: "aws-cli",
      error: `Failed to start AWS CLI: ${(err as Error).message}`,
    };
  }

  let filesDownloaded = 0;
  const stderrLines: string[] = [];
  const downloadLineRegex = /^download:\s+s3:\/\/[^\s]+\/(.*?)\s+to\s+/;

  function processLine(trimmed: string, isStderr: boolean): void {
    if (trimmed.startsWith("download:")) {
      filesDownloaded++;
      const match = trimmed.match(downloadLineRegex);
      onFileDownloaded?.(filesDownloaded, match?.[1] || "");
    } else if (isStderr) {
      stderrLines.push(trimmed);
    }
  }

  async function readStream(stream: ReadableStream<Uint8Array>, isStderr: boolean): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) processLine(trimmed, isStderr);
        }
      }
      const remaining = buffer.trim();
      if (remaining) processLine(remaining, isStderr);
    } finally {
      reader.releaseLock();
    }
  }

  await Promise.all([
    readStream(proc.stdout as ReadableStream<Uint8Array>, false),
    readStream(proc.stderr as ReadableStream<Uint8Array>, true),
  ]);

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    return {
      success: false,
      filesDownloaded,
      totalBytes: 0,
      method: "aws-cli",
      error: stderrLines.join("\n") || `aws s3 sync exited with code ${exitCode}`,
    };
  }

  return { success: true, filesDownloaded, totalBytes: 0, method: "aws-cli" };
}

/**
 * Download an OpenNeuro dataset over direct HTTPS: the fallback used when the
 * AWS CLI is not installed.
 *
 * Only the URL mapping is OpenNeuro's own. An S3 key is absolute
 * (`ds000248/sub-01/...`) while the file lands at a path relative to the
 * output directory, and each segment has to be percent-encoded for the REST
 * endpoint. Everything after that -- the bounded pool, resume, size
 * verification, retries -- is `downloadFiles` in `lib/file-download.ts`,
 * shared with the NEMAR data-plane path.
 *
 * A file already present at its declared size is counted as downloaded rather
 * than reported separately, because this result type has no third state and
 * the caller's question is "is the dataset on disk".
 */
export async function downloadWithHttps(
  datasetId: string,
  outputPath: string,
  objects: S3Object[],
  options: {
    concurrency?: number;
    onProgress?: (
      filesDown: number,
      filesTotal: number,
      bytesDown: number,
      bytesTotal: number,
    ) => void;
  } = {},
): Promise<OpenNeuroDownloadResult> {
  const { concurrency = 8, onProgress } = options;
  const totalBytes = objects.reduce((sum, o) => sum + o.size, 0);

  const files: RemoteFile[] = objects.map((obj) => ({
    path: obj.key.substring(datasetId.length + 1),
    url: `${OPENNEURO_S3_BASE_URL}/${obj.key
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`,
    size: obj.size,
  }));

  const result = await downloadFiles(files, outputPath, {
    concurrency,
    onProgress: (filesDone, filesTotal, bytesDone) =>
      onProgress?.(filesDone, filesTotal, bytesDone, totalBytes),
  });

  const errors = result.errors;
  return {
    success: errors.length === 0,
    filesDownloaded: result.filesDownloaded + result.filesSkipped,
    // What is on disk, not what this run fetched: the file count above says
    // the same, and a resumed download reporting 0 B beside 1,200 files reads
    // as a bug.
    totalBytes: result.bytesDownloaded + result.bytesSkipped,
    method: "https",
    error:
      errors.length > 0
        ? `${errors.length} file(s) failed:\n${errors.slice(0, 10).join("\n")}${errors.length > 10 ? `\n  ... and ${errors.length - 10} more` : ""}`
        : undefined,
  };
}
