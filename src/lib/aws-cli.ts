/**
 * AWS CLI integration for fast S3 uploads
 *
 * Uses `aws s3 sync` with STS temporary credentials for higher throughput
 * than presigned URL uploads. Provides AWS CLI detection so callers can
 * choose an upload strategy.
 */

import { existsSync } from "node:fs";
import { spawn } from "bun";
import { runCommand } from "./git-annex/run-command.js";

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

/**
 * What a credential set can actually do with a dataset's `objects/` prefix.
 *
 * `reachable` means an object under the prefix was listed AND read; `empty-prefix`
 * that the listing worked and there was nothing to read; `refused` that S3 said no;
 * `unavailable` that this machine has no `aws` CLI to ask with.
 */
export interface S3AccessProbe {
  bucket: string;
  prefix: string;
  /** The object the read was attempted on, when the listing found one. */
  object: string | null;
  outcome: "reachable" | "empty-prefix" | "refused" | "unavailable";
  /** The AWS error, trimmed, when the outcome is `refused` or `unavailable`. */
  detail?: string;
}

/** Everything after the last "\n" that is not blank, which is where the AWS CLI puts its error. */
function lastMeaningfulLine(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/**
 * Ask S3 whether these credentials reach this prefix, before a migration spends an
 * hour finding out.
 *
 * Both calls go through the `aws` CLI, which `nemar doctor` already requires, with
 * the credentials passed explicitly and the machine's own profile removed from the
 * child environment -- the point is to test the credentials given, not whatever the
 * host is configured with.
 *
 * A read is the whole probe: there is no harmless write to a live dataset's
 * `objects/` prefix (the upload policy grants no DeleteObject, so a probe object
 * could not be cleaned up with the credentials under test), and PutObject rides the
 * same two policy statements GetObject does.
 */
export async function probeS3PrefixAccess(opts: {
  credentials: { access_key_id: string; secret_access_key: string; session_token: string };
  bucket: string;
  region: string;
  /** Dataset prefix without a trailing slash, e.g. `on007788/objects`. */
  prefix: string;
}): Promise<S3AccessProbe> {
  const { credentials, bucket, region, prefix } = opts;
  const base = { bucket, prefix, object: null } as const;
  if (!(await isAwsCliAvailable())) {
    return { ...base, outcome: "unavailable", detail: "the aws CLI is not on PATH" };
  }

  const env = {
    AWS_ACCESS_KEY_ID: credentials.access_key_id,
    AWS_SECRET_ACCESS_KEY: credentials.secret_access_key,
    AWS_SESSION_TOKEN: credentials.session_token,
    AWS_DEFAULT_REGION: region,
  };
  // A profile in the environment would otherwise decide which credentials the CLI
  // signs with, and the answer would be about the machine rather than the token.
  const unsetEnv = ["AWS_PROFILE", "AWS_DEFAULT_PROFILE"];

  const listed = await runCommand(
    [
      "aws",
      "s3api",
      "list-objects-v2",
      "--bucket",
      bucket,
      "--prefix",
      `${prefix.replace(/\/$/, "")}/`,
      "--max-keys",
      "1",
      "--query",
      "Contents[0].Key",
      "--output",
      "text",
    ],
    { env, unsetEnv, timeout: 60_000 },
  );
  if (listed.exitCode !== 0) {
    return { ...base, outcome: "refused", detail: lastMeaningfulLine(listed.stderr) };
  }

  const key = listed.stdout.trim();
  if (!key || key === "None") return { ...base, outcome: "empty-prefix" };

  const head = await runCommand(["aws", "s3api", "head-object", "--bucket", bucket, "--key", key], {
    env,
    unsetEnv,
    timeout: 60_000,
  });
  if (head.exitCode !== 0) {
    return { ...base, object: key, outcome: "refused", detail: lastMeaningfulLine(head.stderr) };
  }
  return { ...base, object: key, outcome: "reachable" };
}

/**
 * Whether the bucket holds each of these objects, asked with credentials that
 * carry their session token.
 *
 * This exists because `git annex fsck --from <s3 remote>` cannot answer the
 * question when the remote was configured with temporary credentials.
 * `enableremote` caches the key and secret in `.git/annex/creds/<uuid>` and has
 * nowhere to put the session token (#1380), so every later git-annex request
 * signs without one and S3 returns 403 -- the SAME 403 it returns for an object
 * that is not there. A failing fsck therefore does not mean the content is
 * missing, and, worse, a passing one would not mean it is present either.
 *
 * So the three outcomes are kept apart: `present` and `absent` are answers,
 * `unknown` is the honest report of a question that could not be asked.
 */
export interface KeyPresence {
  key: string;
  outcome: "present" | "absent" | "unknown";
  /** The AWS error, trimmed, when the outcome is `unknown`. */
  detail?: string;
}

/** How many HEADs to have in flight; the CLI spawns one process per object. */
const HEAD_CONCURRENCY = 8;

export async function headS3Objects(opts: {
  /**
   * Omit to sign with whatever this machine's `aws` CLI is configured with, which
   * is what `--via-aws-cli` moved the bytes with: verifying a transfer against a
   * different identity than performed it proves nothing about the transfer.
   */
  credentials?: { access_key_id: string; secret_access_key: string; session_token: string };
  bucket: string;
  region: string;
  /** Dataset prefix without a trailing slash, e.g. `on007788/objects`. */
  prefix: string;
  keys: string[];
}): Promise<KeyPresence[]> {
  const { credentials, bucket, region, prefix, keys } = opts;
  if (keys.length === 0) return [];
  if (!(await isAwsCliAvailable())) {
    return keys.map((key) => ({
      key,
      outcome: "unknown" as const,
      detail: "the aws CLI is not on PATH",
    }));
  }

  const env: Record<string, string> = credentials
    ? {
        AWS_ACCESS_KEY_ID: credentials.access_key_id,
        AWS_SECRET_ACCESS_KEY: credentials.secret_access_key,
        AWS_SESSION_TOKEN: credentials.session_token,
        AWS_DEFAULT_REGION: region,
      }
    : { AWS_DEFAULT_REGION: region };
  // Only when credentials were given: with none, the machine's profile IS the
  // identity under test and removing it would leave the CLI unable to sign at all.
  const unsetEnv = credentials ? ["AWS_PROFILE", "AWS_DEFAULT_PROFILE"] : [];
  const base = `${prefix.replace(/\/$/, "")}/`;

  const results: KeyPresence[] = new Array(keys.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= keys.length) return;
      const key = keys[index];
      const head = await runCommand(
        ["aws", "s3api", "head-object", "--bucket", bucket, "--key", `${base}${key}`],
        { env, unsetEnv, timeout: 60_000 },
      );
      if (head.exitCode === 0) {
        results[index] = { key, outcome: "present" };
        continue;
      }
      // The CLI reports a missing object as a 404; everything else -- a 403 from a
      // tokenless signature, a timeout, a DNS failure -- is a question that did not
      // get asked, and must not be recorded as an absent object.
      const detail = lastMeaningfulLine(head.stderr);
      results[index] = /404|Not Found/i.test(detail)
        ? { key, outcome: "absent" }
        : { key, outcome: "unknown", detail };
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(HEAD_CONCURRENCY, keys.length) }, () => worker()),
  );
  return results;
}
