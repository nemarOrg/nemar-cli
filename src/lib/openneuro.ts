/**
 * OpenNeuro dataset download support
 *
 * Downloads datasets directly from OpenNeuro's public S3 bucket (openneuro.org)
 * using AWS CLI (primary) or direct HTTPS (fallback). No authentication required.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "bun";
import { isAwsCliAvailable } from "./aws-cli.js";

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

function decodeXmlEntities(s: string): string {
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
      const exitCode = await proc.exited;
      if (exitCode !== 0) return false;
      const output = await new Response(proc.stdout).text();
      return output.trim().length > 0;
    } catch {
      // Fall through to HTTPS check
    }
  }

  const url = `${OPENNEURO_S3_BASE_URL}?list-type=2&prefix=${datasetId}/&max-keys=1`;
  try {
    const response = await fetch(url);
    if (!response.ok) return false;
    const text = await response.text();
    return text.includes("<Key>");
  } catch {
    return false;
  }
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
      continuationToken = tokenMatch ? decodeXmlEntities(tokenMatch[1]) : undefined;
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

  const proc = spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
  });

  let filesDownloaded = 0;
  const stderrLines: string[] = [];
  const downloadLineRegex = /^download:\s+s3:\/\/[^\s]+\/(.*?)\s+to\s+/;

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
          if (!trimmed) continue;
          if (trimmed.startsWith("download:")) {
            filesDownloaded++;
            const match = trimmed.match(downloadLineRegex);
            onFileDownloaded?.(filesDownloaded, match?.[1] || "");
          } else if (isStderr) {
            stderrLines.push(trimmed);
          }
        }
      }
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("download:")) {
          filesDownloaded++;
          const match = trimmed.match(downloadLineRegex);
          onFileDownloaded?.(filesDownloaded, match?.[1] || "");
        } else if (isStderr) {
          stderrLines.push(trimmed);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  await Promise.all([readStream(proc.stdout, false), readStream(proc.stderr, true)]);

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
 * Download a single file from OpenNeuro S3 via HTTPS.
 * Skips if file already exists with correct size (resume support).
 */
async function downloadSingleFile(
  key: string,
  expectedSize: number,
  outputDir: string,
  datasetId: string,
): Promise<number> {
  const relativePath = key.substring(datasetId.length + 1);
  const filePath = join(outputDir, relativePath);

  // Guard against path traversal from malicious S3 keys
  const resolved = resolve(filePath);
  if (!resolved.startsWith(`${resolve(outputDir)}/`)) {
    throw new Error(`Path traversal detected in key: ${key}`);
  }

  // Skip already-downloaded files with correct size
  if (existsSync(filePath)) {
    try {
      const stat = statSync(filePath);
      if (stat.size === expectedSize) return expectedSize;
    } catch {
      // stat failed, re-download
    }
  }

  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const encodedKey = key
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
  const url = `${OPENNEURO_S3_BASE_URL}/${encodedKey}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${relativePath}: HTTP ${response.status}`);
  }

  // Stream to disk (avoids loading large files into memory)
  await Bun.write(filePath, response);
  return expectedSize;
}

/**
 * Download an OpenNeuro dataset via direct HTTPS (fallback, slower).
 * Downloads files in parallel with a concurrency limit.
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
  const totalFiles = objects.length;
  const totalBytes = objects.reduce((sum, o) => sum + o.size, 0);

  let filesDownloaded = 0;
  let bytesDownloaded = 0;
  const errors: string[] = [];

  if (!existsSync(outputPath)) {
    mkdirSync(outputPath, { recursive: true });
  }

  // Worker pool for parallel downloads
  const queue = [...objects];
  const poolSize = Math.min(concurrency, totalFiles);
  const workers = Array.from({ length: poolSize }, async () => {
    while (queue.length > 0) {
      const obj = queue.shift();
      if (!obj) break;
      try {
        const bytes = await downloadSingleFile(obj.key, obj.size, outputPath, datasetId);
        filesDownloaded++;
        bytesDownloaded += bytes;
        onProgress?.(filesDownloaded, totalFiles, bytesDownloaded, totalBytes);
      } catch (err) {
        errors.push((err as Error).message);
        filesDownloaded++;
        onProgress?.(filesDownloaded, totalFiles, bytesDownloaded, totalBytes);
      }
    }
  });

  await Promise.all(workers);

  return {
    success: errors.length === 0,
    filesDownloaded: filesDownloaded - errors.length,
    totalBytes: bytesDownloaded,
    method: "https",
    error: errors.length > 0 ? `${errors.length} file(s) failed to download` : undefined,
  };
}
