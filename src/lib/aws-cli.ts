/**
 * AWS CLI integration for fast S3 uploads
 *
 * Uses `aws s3 sync` with STS temporary credentials for higher throughput
 * than presigned URL uploads. Provides AWS CLI detection so callers can
 * choose an upload strategy.
 */

import { existsSync } from "node:fs";
import { spawn } from "bun";

/**
 * Check if the AWS CLI is installed and accessible.
 */
export async function isAwsCliAvailable(): Promise<boolean> {
  try {
    const proc = spawn({
      cmd: ["aws", "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

export interface AwsCliUploadOptions {
  credentials: {
    access_key_id: string;
    secret_access_key: string;
    session_token: string;
  };
  bucket: string;
  region: string;
  prefix: string;
  datasetPath: string;
  /** Relative paths of data files to upload. Only these files will be synced. */
  dataFiles: string[];
  onProgress?: (uploaded: number, currentFile: string) => void;
}

export interface AwsCliUploadResult {
  success: boolean;
  uploaded: number;
  failed: string[];
  error?: string;
}

const UPLOAD_LINE_REGEX = /^upload:\s+(.+?)\s+to\s+s3:\/\//;

function processUploadLine(
  raw: string,
  increment: () => number,
  onProgress?: (uploaded: number, currentFile: string) => void,
): void {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("upload:")) return;

  const count = increment();
  const match = trimmed.match(UPLOAD_LINE_REGEX);
  onProgress?.(count, match ? match[1] : "");
}

/**
 * Upload dataset files to S3 using `aws s3 sync`.
 *
 * Leverages the AWS CLI's built-in transfer manager for connection pooling
 * and multipart uploads to saturate available bandwidth.
 */
export async function uploadWithAwsCli(opts: AwsCliUploadOptions): Promise<AwsCliUploadResult> {
  const { credentials, bucket, region, prefix, datasetPath, dataFiles, onProgress } = opts;

  if (!existsSync(datasetPath)) {
    return {
      success: false,
      uploaded: 0,
      failed: [],
      error: `Dataset path does not exist: ${datasetPath}`,
    };
  }

  const s3Dest = `s3://${bucket}/${prefix}/`;

  // For small file lists, use per-file --include patterns for precision.
  // For large lists, per-file patterns cause aws s3 sync to stall during
  // pattern compilation, so exclude internal directories instead.
  const filterArgs =
    dataFiles.length <= 100
      ? ["--exclude", "*", ...dataFiles.flatMap((f) => ["--include", f])]
      : ["--exclude", ".git/*", "--exclude", ".datalad/*", "--exclude", ".nemar/*"];

  const cmd = [
    "aws",
    "s3",
    "sync",
    datasetPath,
    s3Dest,
    "--region",
    region,
    // Skip files that already exist with matching size (enables resume)
    "--size-only",
    ...filterArgs,
  ];

  const proc = spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      AWS_ACCESS_KEY_ID: credentials.access_key_id,
      AWS_SECRET_ACCESS_KEY: credentials.secret_access_key,
      AWS_SESSION_TOKEN: credentials.session_token,
      AWS_DEFAULT_REGION: region,
    },
  });

  let uploaded = 0;
  const failed: string[] = [];
  const stderrLines: string[] = [];

  // Read a stream, parsing upload progress lines and collecting the rest
  async function readStream(
    stream: ReadableStream<Uint8Array>,
    collectNonProgress?: string[],
  ): Promise<void> {
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
          if (trimmed.startsWith("upload:")) {
            processUploadLine(trimmed, () => ++uploaded, onProgress);
          } else if (collectNonProgress && trimmed) {
            collectNonProgress.push(trimmed);
          }
        }
      }
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("upload:")) {
          processUploadLine(trimmed, () => ++uploaded, onProgress);
        } else if (collectNonProgress) {
          collectNonProgress.push(trimmed);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // Read both stdout and stderr concurrently for progress
  await Promise.all([readStream(proc.stdout), readStream(proc.stderr, stderrLines)]);

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    for (const line of stderrLines) {
      const match = line.match(/upload failed:\s+(.+?)\s+to\s+/);
      if (match) failed.push(match[1]);
    }

    return {
      success: false,
      uploaded,
      failed,
      error: stderrLines.join("\n") || `aws s3 sync exited with code ${exitCode}`,
    };
  }

  return { success: true, uploaded, failed: [] };
}
