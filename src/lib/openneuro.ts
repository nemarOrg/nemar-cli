/**
 * OpenNeuro dataset download support
 *
 * Downloads datasets directly from OpenNeuro's public S3 bucket (openneuro.org)
 * using AWS CLI (primary) or direct HTTPS (fallback). No authentication required.
 */

import { spawn } from "bun";
import { isAwsCliAvailable } from "./aws-cli.js";
import { type RemoteFile, downloadFiles } from "./file-download.js";

const OPENNEURO_S3_BUCKET = "openneuro.org";
const OPENNEURO_S3_REGION = "us-east-1";
const OPENNEURO_S3_BASE_URL = `https://s3.amazonaws.com/${OPENNEURO_S3_BUCKET}`;
const OPENNEURO_DATASET_REGEX = /^ds\d{6}$/;

export function isOpenNeuroDatasetId(id: string): boolean {
  return OPENNEURO_DATASET_REGEX.test(id);
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
    totalBytes: result.bytesDownloaded,
    method: "https",
    error:
      errors.length > 0
        ? `${errors.length} file(s) failed:\n${errors.slice(0, 10).join("\n")}${errors.length > 10 ? `\n  ... and ${errors.length - 10} more` : ""}`
        : undefined,
  };
}
