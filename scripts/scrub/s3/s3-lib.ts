/**
 * The S3 half of an in-place privacy scrub: an `aws` CLI runner, the handful of S3 operations
 * the stages need, and the pure rules (part layout, sampled ranges, retention) the stages and
 * their tests share.
 *
 * Everything here shells out to the real `aws` CLI, asynchronously and with a timeout on every
 * spawn. Tests point the CLI at a local stand-in through `AWS_ENDPOINT_URL_S3`
 * (`test/scrub/helpers/s3-standin.ts`), so the production code path is the one that runs.
 *
 * **No participant value is ever held anywhere it could be printed.** A header read from S3
 * exists only in memory and in a temp file that is deleted in a `finally`, or by the signal
 * handler ({@link installSignalCleanup}) when a signal ends the process; errors are classes
 * with fixed words (`AwsCliError`, `StageError`), never the CLI's own stderr, which can carry a
 * key, a URL or a header. The only strings that leave this module are annex keys, sizes, version
 * ids, counts and fixed words.
 */

import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "bun";
import { EDF_HEADER_BYTES } from "../../../shared/identifier-scan";

export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;

/** At or below this size the new object is one put-object; above it, a multipart upload. */
export const SINGLE_PUT_MAX = 5 * MIB;
/** Part 1 of a multipart upload is uploaded (it carries the patched header). */
export const FIRST_PART_BYTES = 8 * MIB;
/** S3 refuses a non-final part smaller than this. */
export const MIN_PART_BYTES = 5 * MIB;
/** Largest range one `upload-part-copy` is asked for. S3's own ceiling is 5 GiB. */
export const MAX_COPY_PART_BYTES = 4 * GIB;
/** S3 allows at most this many parts. */
export const MAX_PARTS = 10_000;

/** What the planner reads from each object: far more than the 256-byte header the scrub uses. */
export const PLAN_READ_BYTES = 8192;
/** One sampled comparison window in the verify stage. */
export const SAMPLE_BYTES = 64 * 1024;
export const DEFAULT_SAMPLES = 8;

/** Retention a new object gets, and the shortest a verified one may have left. */
export const RETAIN_YEARS = 100;
export const MIN_RETAIN_YEARS = 99;

// ---------------------------------------------------------------------------
// Errors: fixed words, never values.
// ---------------------------------------------------------------------------

/** Process exit codes. 0 is success; each other code names one kind of stop. */
export const EXIT = {
  failed: 1,
  usage: 2,
  refused: 3,
  unreadable: 4,
  remainder: 5,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A stage stopped on purpose. `word` is a fixed reason; `exitCode` says what kind of stop. */
export class StageError extends Error {
  constructor(
    readonly word: string,
    readonly exitCode: ExitCode = EXIT.failed,
  ) {
    super(word);
    this.name = "StageError";
  }
}

export type AwsErrorCode =
  | "timeout"
  | "access-denied"
  | "not-found"
  | "precondition-failed"
  | "invalid-range"
  | "no-such-upload"
  | "throttled"
  | "credentials"
  | "long-lived-credentials"
  | "unreachable"
  | "spawn-failed"
  | "bad-output"
  | "short-read"
  | "failed";

/** An `aws` call failed. `op` is the S3 operation name and `code` a fixed class. */
export class AwsCliError extends Error {
  constructor(
    readonly code: AwsErrorCode,
    readonly op: string,
  ) {
    super(`${op}:${code}`);
    this.name = "AwsCliError";
  }
}

const CODE_BY_S3: Record<string, AwsErrorCode> = {
  AccessDenied: "access-denied",
  "403": "access-denied",
  NoSuchKey: "not-found",
  NoSuchVersion: "not-found",
  NoSuchObjectLockConfiguration: "not-found",
  NotFound: "not-found",
  "404": "not-found",
  NoSuchUpload: "no-such-upload",
  // A conditional request whose condition did not hold (412), and one S3 refused because a
  // conflicting write was in flight on the same key (409, documented for conditional writes).
  // Both mean the write did not happen, and both stop the caller: one fixed word, never success.
  PreconditionFailed: "precondition-failed",
  "412": "precondition-failed",
  ConditionalRequestConflict: "precondition-failed",
  InvalidRange: "invalid-range",
  "416": "invalid-range",
  SlowDown: "throttled",
  Throttling: "throttled",
  ThrottlingException: "throttled",
  RequestLimitExceeded: "throttled",
  "503": "throttled",
  ExpiredToken: "credentials",
  InvalidAccessKeyId: "credentials",
  InvalidToken: "credentials",
  SignatureDoesNotMatch: "credentials",
  "401": "credentials",
};

/** An S3 error code (the CLI's, or one entry of a DeleteObjects `Errors` list) as a fixed class. */
export function classifyS3Code(code: string, op: string): AwsCliError {
  return new AwsCliError(CODE_BY_S3[code] ?? "failed", op);
}

/**
 * Classify a FAILED `aws` invocation from its stderr into a fixed class.
 *
 * The match is anchored on the CLI's own error line, `An error occurred (<code>) when calling
 * the <Op> operation`: a bare `404` elsewhere in stderr is NOT a not-found signal, because
 * connection errors embed the request URL and the URL embeds the key. A 403 is never read as
 * absence: this bucket denies anonymous listing, so 403 also covers a missing key.
 */
export function classifyAwsError(stderr: string, fallbackOp: string): AwsCliError {
  const m = /An error occurred \(([A-Za-z0-9]+)\) when calling the (\w+) operation/.exec(stderr);
  if (m) return classifyS3Code(m[1] as string, m[2] as string);
  if (/Could not connect to the endpoint URL|Connection was closed|Read timeout/.test(stderr)) {
    return new AwsCliError("unreachable", fallbackOp);
  }
  if (/Unable to locate credentials|SSO session|token has expired/i.test(stderr)) {
    return new AwsCliError("credentials", fallbackOp);
  }
  return new AwsCliError("failed", fallbackOp);
}

/** The fixed word a failure is counted under. Never includes a message from the CLI. */
export function failureWord(err: unknown): string {
  if (err instanceof StageError) return err.word;
  if (err instanceof AwsCliError) return `${err.op}:${err.code}`;
  return "unexpected";
}

// ---------------------------------------------------------------------------
// What a signal must clean up.
// ---------------------------------------------------------------------------

/**
 * Every temp directory that exists and every `aws` child that runs, so a signal can remove the
 * one and kill the other. Bun does not run a `finally` when a signal ends the process, and a temp
 * file can hold raw original bytes for as long as a get-object takes (8 KiB of a recording in
 * plan, its 256-byte header in verify, up to the first 8 MiB of it in assemble, a whole zarr.json
 * in zarr).
 */
const liveDirs = new Set<string>();
const liveChildren = new Set<ReturnType<typeof spawn>>();

/** Kill every running `aws` child and remove every temp directory, synchronously. */
export function cleanupNow(): void {
  for (const child of liveChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const dir of liveDirs) rmSync(dir, { recursive: true, force: true });
}

/** The exit status of a process ended by each signal it cleans up after: 128 + the number. */
export const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

/**
 * On SIGINT, SIGTERM or SIGHUP: kill the `aws` children, remove the temp directories, say which
 * signal it was, and exit with 128 plus its number. Installed once by the CLI entry point.
 */
export function installSignalCleanup(name: string): void {
  for (const [signal, code] of Object.entries(SIGNAL_EXIT)) {
    process.once(signal as NodeJS.Signals, () => {
      cleanupNow();
      console.error(`${name}: interrupted by ${signal}; temp files removed`);
      process.exit(code);
    });
  }
}

// ---------------------------------------------------------------------------
// The runner.
// ---------------------------------------------------------------------------

export interface AwsConfig {
  region: string;
  /** Sets `AWS_ENDPOINT_URL_S3` for the child. Tests use it; production leaves it unset. */
  endpointUrl?: string;
  /** Per-call limit. Transfers get {@link SLOW_FACTOR} times as long. */
  timeoutMs: number;
  /** The whole environment of the child, replacing `process.env`. Tests use it to stay hermetic. */
  env?: Record<string, string>;
  /** Fresh short-lived credentials for every call; see {@link cliCredentialSource}. */
  credentials?: CredentialSource;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
export const SLOW_FACTOR = 5;

export interface ApiOptions {
  /** A transfer or a completion: allowed {@link SLOW_FACTOR} times the base timeout. */
  slow?: boolean;
}

export interface AwsRunner {
  /** `aws s3api <op> ...args --region R --output json`; parsed JSON ({} for empty output). */
  api(op: string, args: string[], opts?: ApiOptions): Promise<Record<string, unknown>>;
}

/** Short-lived credentials as the environment variables the CLI reads. */
export interface CredentialSource {
  env(): Promise<Record<string, string>>;
}

export interface CliCredentialOptions {
  /** The command that prints `{AccessKeyId, SecretAccessKey, SessionToken, Expiration}` as JSON. */
  command?: string[];
  /** The environment that command runs in; the process environment when absent. */
  commandEnv?: Record<string, string>;
  /** Refresh this long before the credentials expire. */
  skewMs?: number;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Credentials for every `aws` child, from ONE serialized `aws configure export-credentials`.
 *
 * An `aws login` session rotates a single-use refresh token, so many `aws` processes that each
 * resolve the session themselves race on the refresh and one of them fails
 * (`CreateOAuth2Token`, seen on the first real plan of nm000348 at concurrency 8). Resolving once,
 * sharing the result with every child through the environment, and refreshing under one in-flight
 * call removes the race. Only short-lived (`ASIA`) credentials are accepted, as in the CLI's own
 * refusal of a long-lived key. Nothing from the command's output is ever put in an error.
 */
export function cliCredentialSource(options: CliCredentialOptions = {}): CredentialSource {
  const command = options.command ?? [
    "aws",
    "configure",
    "export-credentials",
    "--format",
    "process",
  ];
  const skewMs = options.skewMs ?? 120_000;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 60_000;
  let cached: { env: Record<string, string>; expiresAt: number } | undefined;
  let inflight: Promise<Record<string, string>> | undefined;

  async function exportOnce(): Promise<Record<string, string>> {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn({
        cmd: command,
        ...(options.commandEnv ? { env: options.commandEnv } : {}),
        stdout: "pipe",
        stderr: "ignore",
      });
    } catch {
      throw new AwsCliError("credentials", "ExportCredentials");
    }
    liveChildren.add(proc);
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    let text: string;
    let code: number;
    try {
      [text, code] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        proc.exited,
      ]);
    } finally {
      clearTimeout(timer);
      liveChildren.delete(proc);
    }
    if (code !== 0) throw new AwsCliError("credentials", "ExportCredentials");
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new AwsCliError("bad-output", "ExportCredentials");
    }
    const id = typeof doc.AccessKeyId === "string" ? doc.AccessKeyId : "";
    const secret = typeof doc.SecretAccessKey === "string" ? doc.SecretAccessKey : "";
    const token = typeof doc.SessionToken === "string" ? doc.SessionToken : "";
    if (!id || !secret) throw new AwsCliError("bad-output", "ExportCredentials");
    // A long-lived key has no session token and an AKIA id; refuse it here as the CLI does.
    if (!id.startsWith("ASIA") || !token)
      throw new AwsCliError("long-lived-credentials", "ExportCredentials");
    const expires = typeof doc.Expiration === "string" ? Date.parse(doc.Expiration) : Number.NaN;
    const env = {
      AWS_ACCESS_KEY_ID: id,
      AWS_SECRET_ACCESS_KEY: secret,
      AWS_SESSION_TOKEN: token,
    };
    // No usable expiry: trust it for one skew window only, so it is re-read soon.
    cached = { env, expiresAt: Number.isFinite(expires) ? expires : now() + skewMs * 2 };
    return env;
  }

  return {
    async env() {
      if (cached && cached.expiresAt - skewMs > now()) return cached.env;
      inflight ??= exportOnce().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}

/**
 * Real S3 refuses an UploadPart on a multipart upload created with Object Lock parameters unless
 * the request carries `Content-MD5` or an `x-amz-checksum-*` header ("Content-MD5 OR
 * x-amz-checksum- HTTP header is required for Put Part requests with Object Lock parameters",
 * measured against the real bucket on 2026-10-04 with aws-cli 2.36.47). The CLI's default,
 * `when_supported`, sends a CRC64NVME header and is accepted even though the upload was created
 * with no checksum type. S3 documents the same requirement for a put-object with lock parameters
 * (not measured here), and `when_required` would turn the header off for both.
 */
export const CHECKSUM_CALCULATION = "when_supported";

/**
 * The oldest `aws` CLI the tools run with. `AWS_REQUEST_CHECKSUM_CALCULATION`, which every call
 * pins (see {@link CHECKSUM_CALCULATION}), does not exist before 2.23.0: an older CLI ignores the
 * variable, sends no checksum, and real S3 refuses the locked writes. The conditional writes the
 * zarr stage and the ledger rely on (`--if-match`, `--if-none-match` on put-object) need a recent
 * CLI too.
 */
export const MIN_AWS_CLI_VERSION: readonly [number, number, number] = [2, 23, 0];

/** `aws-cli/2.37.9 Python/3.14.8 Darwin/27.0.0 source/arm64` -> [2, 37, 9]; null when not one. */
export function parseAwsCliVersion(text: string): [number, number, number] | null {
  const m = /(?:^|\s)aws-cli\/(\d+)\.(\d+)\.(\d+)(?=\s|$)/.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when `version` is {@link MIN_AWS_CLI_VERSION} or later. */
export function awsCliVersionOk(version: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    const have = version[i] as number;
    const need = MIN_AWS_CLI_VERSION[i] as number;
    if (have !== need) return have > need;
  }
  return true;
}

/**
 * Refuse to start unless the `aws` on PATH is {@link MIN_AWS_CLI_VERSION} or later:
 * `aws-cli-too-old` for an older one, `aws-cli-version-unknown` when `aws --version` cannot be
 * run or read. Both are refusals (exit 3): nothing was attempted.
 */
export async function requireAwsCliVersion(timeoutMs = 30_000): Promise<void> {
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn({ cmd: ["aws", "--version"], stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new StageError("aws-cli-version-unknown", EXIT.refused);
  }
  liveChildren.add(proc);
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  let out: string;
  let code: number;
  try {
    // Version 1 printed it on stderr, version 2 prints it on stdout: read both.
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    out = `${stdout}\n${stderr}`;
    code = exit;
  } finally {
    clearTimeout(timer);
    liveChildren.delete(proc);
  }
  const version = code === 0 ? parseAwsCliVersion(out) : null;
  if (!version) throw new StageError("aws-cli-version-unknown", EXIT.refused);
  if (!awsCliVersionOk(version)) throw new StageError("aws-cli-too-old", EXIT.refused);
}

export function createAwsRunner(cfg: AwsConfig): AwsRunner {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.env ?? process.env)) if (v !== undefined) base[k] = v;
  base.AWS_PAGER = "";
  // Pinned for EVERY call, over whatever the operator's environment says: real S3 refuses a
  // put-object, or a part of an upload, that carries Object Lock parameters unless the request has
  // `Content-MD5` or an `x-amz-checksum-*` header (see {@link CHECKSUM_CALCULATION}). Only the CLI
  // default sends one, and `when_required`, which is what some operators set, does not.
  base.AWS_REQUEST_CHECKSUM_CALCULATION = CHECKSUM_CALCULATION;
  if (cfg.endpointUrl) base.AWS_ENDPOINT_URL_S3 = cfg.endpointUrl;

  return {
    async api(op, args, opts = {}) {
      // The S3 operation name, as the CLI's own errors spell it: `head-object` is `HeadObject`.
      const name = op
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join("");
      const cmd = ["aws", "s3api", op, ...args, "--region", cfg.region, "--output", "json"];
      const creds = cfg.credentials ? await cfg.credentials.env() : {};
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn({
          cmd,
          env: { ...base, ...creds },
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch {
        throw new AwsCliError("spawn-failed", name);
      }
      liveChildren.add(proc);
      const limit = cfg.timeoutMs * (opts.slow ? SLOW_FACTOR : 1);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, limit);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout as ReadableStream).text(),
          new Response(proc.stderr as ReadableStream).text(),
          proc.exited,
        ]);
        if (timedOut) throw new AwsCliError("timeout", name);
        if (code !== 0) throw classifyAwsError(stderr, name);
        const text = stdout.trim();
        if (text === "") return {};
        try {
          const parsed = JSON.parse(text) as unknown;
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new AwsCliError("bad-output", name);
          }
          return parsed as Record<string, unknown>;
        } catch (err) {
          if (err instanceof AwsCliError) throw err;
          throw new AwsCliError("bad-output", name);
        }
      } finally {
        clearTimeout(timer);
        liveChildren.delete(proc);
      }
    },
  };
}

/**
 * A private directory for the one kind of file the CLI needs on disk (an object body or a part).
 * Created 0700 by `mkdtemp`, and every file is removed as soon as its bytes are read, because a
 * header read from S3 holds the very values being scrubbed.
 */
export class TempArea {
  private n = 0;
  private constructor(readonly dir: string) {}

  static async create(): Promise<TempArea> {
    const dir = await mkdtemp(path.join(tmpdir(), "scrub-s3-"));
    liveDirs.add(dir);
    return new TempArea(dir);
  }

  file(): string {
    this.n += 1;
    return path.join(this.dir, `f${this.n}-${randomBytes(4).toString("hex")}`);
  }

  async remove(file: string): Promise<void> {
    await rm(file, { force: true });
  }

  async dispose(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
    liveDirs.delete(this.dir);
  }
}

export interface S3Ctx {
  aws: AwsRunner;
  bucket: string;
  tmp: TempArea;
}

// ---------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(a, b) === 0;
}

/** The `YYYY-MM-DDTHH:MM:SSZ` form `--object-lock-retain-until-date` takes. */
export function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `now` plus `years`, in the form {@link isoSeconds} gives. */
export function retainUntilFrom(now: Date, years: number): string {
  const d = new Date(now.getTime());
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return isoSeconds(d);
}

/** True when the lock is GOVERNANCE and runs at least {@link MIN_RETAIN_YEARS} years out. */
export function retentionOk(
  mode: string | undefined,
  until: string | undefined,
  now: Date = new Date(),
): boolean {
  if (mode !== "GOVERNANCE" || !until) return false;
  const t = Date.parse(until);
  if (Number.isNaN(t)) return false;
  return t >= Date.parse(retainUntilFrom(now, MIN_RETAIN_YEARS));
}

/** An ISO timestamp from whatever the CLI printed, or undefined when it is not a date. */
export function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

export const objectKey = (dataset: string, annexKey: string) => `${dataset}/objects/${annexKey}`;

export const DATASET_ID = /^[a-z]{2}\d{6}$/;

/**
 * Append every item of `items` to `target` in order. `target.push(...items)` is not a substitute:
 * a call spreads its arguments onto the stack, and Bun throws a RangeError once there are somewhere
 * between 500,000 and 1,000,000 of them. A Zarr copy's history can be larger than that (nm000246 held
 * 1.85 million versions and markers under `zarr/`), and so can a list of failures from deleting it,
 * so both are appended in a loop.
 */
export function appendAll<T>(target: T[], items: readonly T[]): void {
  for (const item of items) target.push(item);
}

/** Run `fn` over `items` with at most `concurrency` in flight; stop starting new ones on `stop()`. */
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  stop: () => boolean = () => false,
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length).fill(undefined);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return results;
}

export function countWords(words: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of words) out[w] = (out[w] ?? 0) + 1;
  return out;
}

export function formatWordCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([w, n]) => `${w}=${n}`).join(", ");
}

// ---------------------------------------------------------------------------
// Pure layout rules.
// ---------------------------------------------------------------------------

export interface PartSpec {
  number: number;
  /** "upload": bytes read from the old object, patched, and uploaded. "copy": copied server side. */
  kind: "upload" | "copy";
  start: number;
  /** Inclusive. */
  end: number;
}

export interface AssemblyLayout {
  mode: "put" | "multipart";
  parts: PartSpec[];
  uploadedBytes: number;
  copiedBytes: number;
}

/**
 * How one new object is built from an old one of `size` bytes.
 *
 * Up to {@link SINGLE_PUT_MAX} it is one put-object of the patched content. Above it, part 1
 * is the first {@link FIRST_PART_BYTES} (the whole object when it is under that plus the 5 MiB
 * minimum, so the remainder is never a runt non-final part) and is uploaded patched; the rest
 * is `upload-part-copy` in ranges of at most `maxCopyPart`. Every non-final part is at least
 * {@link MIN_PART_BYTES}, which S3 enforces at completion.
 */
export function planAssembly(
  size: number,
  maxCopyPart: number = MAX_COPY_PART_BYTES,
): AssemblyLayout {
  if (!Number.isInteger(size) || size < EDF_HEADER_BYTES) throw new StageError("size-too-small");
  if (maxCopyPart < MIN_PART_BYTES || maxCopyPart > MAX_COPY_PART_BYTES) {
    throw new StageError("bad-part-size", EXIT.usage);
  }
  if (size <= SINGLE_PUT_MAX) {
    return { mode: "put", parts: [], uploadedBytes: size, copiedBytes: 0 };
  }
  const first = size < FIRST_PART_BYTES + MIN_PART_BYTES ? size : FIRST_PART_BYTES;
  const parts: PartSpec[] = [{ number: 1, kind: "upload", start: 0, end: first - 1 }];
  let start = first;
  while (start < size) {
    const end = Math.min(start + maxCopyPart, size) - 1;
    parts.push({ number: parts.length + 1, kind: "copy", start, end });
    start = end + 1;
  }
  if (parts.length > MAX_PARTS) throw new StageError("too-many-parts");
  return { mode: "multipart", parts, uploadedBytes: first, copiedBytes: size - first };
}

/** S3 calls one new object costs at most (a skipped, already-assembled object costs fewer). */
export function callsFor(layout: AssemblyLayout): Record<string, number> {
  const calls: Record<string, number> = { "head-object": 3 };
  if (layout.mode === "put") {
    calls["get-object"] = 1;
    calls["put-object"] = 1;
    return calls;
  }
  calls["create-multipart-upload"] = 1;
  calls["complete-multipart-upload"] = 1;
  for (const p of layout.parts) {
    if (p.kind === "upload") {
      calls["get-object"] = (calls["get-object"] ?? 0) + 1;
      calls["upload-part"] = (calls["upload-part"] ?? 0) + 1;
    } else {
      calls["upload-part-copy"] = (calls["upload-part-copy"] ?? 0) + 1;
    }
  }
  return calls;
}

/**
 * The byte windows the verify stage compares between an old and a new object: `n` evenly
 * spaced windows of `len` bytes plus the final `len` bytes. Windows start at or after the
 * header, because the first 256 bytes differ by design and are checked on their own.
 */
export function sampleRanges(
  size: number,
  n: number = DEFAULT_SAMPLES,
  len: number = SAMPLE_BYTES,
): Array<[number, number]> {
  if (size <= EDF_HEADER_BYTES) return [];
  const usable = size - EDF_HEADER_BYTES;
  const starts = new Set<number>();
  if (usable <= len) {
    starts.add(EDF_HEADER_BYTES);
  } else {
    const span = usable - len;
    for (let i = 0; i < n; i++) starts.add(EDF_HEADER_BYTES + Math.floor((i * span) / n));
    starts.add(EDF_HEADER_BYTES + span);
  }
  return [...starts]
    .sort((a, b) => a - b)
    .map((s): [number, number] => [s, Math.min(s + len, size) - 1]);
}

// ---------------------------------------------------------------------------
// S3 operations.
// ---------------------------------------------------------------------------

export interface HeadInfo {
  size: number;
  etag: string;
  versionId?: string;
  contentType?: string;
  sse?: string;
  kmsKeyId?: string;
  lockMode?: string;
  /** ISO 8601. */
  retainUntil?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** head-object. `null` only for a genuine 404; every other failure throws. */
export async function headObject(
  ctx: S3Ctx,
  key: string,
  versionId?: string,
): Promise<HeadInfo | null> {
  const args = ["--bucket", ctx.bucket, "--key", key];
  if (versionId) args.push("--version-id", versionId);
  let out: Record<string, unknown>;
  try {
    out = await ctx.aws.api("head-object", args);
  } catch (err) {
    if (err instanceof AwsCliError && err.code === "not-found") return null;
    throw err;
  }
  const size = out.ContentLength;
  const etag = str(out.ETag);
  if (typeof size !== "number" || etag === undefined)
    throw new AwsCliError("bad-output", "HeadObject");
  return {
    size,
    etag,
    versionId: str(out.VersionId),
    contentType: str(out.ContentType),
    sse: str(out.ServerSideEncryption),
    kmsKeyId: str(out.SSEKMSKeyId),
    lockMode: str(out.ObjectLockMode),
    retainUntil: isoOrUndefined(out.ObjectLockRetainUntilDate),
  };
}

export interface VersionEntry {
  versionId: string;
  isLatest: boolean;
  /** Bytes, for a version; absent for a delete marker. */
  size?: number;
}

export interface VersionListing {
  versions: VersionEntry[];
  markers: VersionEntry[];
}

function entriesOf(raw: unknown, key: string): VersionEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AwsCliError("bad-output", "ListObjectVersions");
  const out: VersionEntry[] = [];
  for (const e of raw as Array<Record<string, unknown>>) {
    // list-object-versions is a PREFIX match: only the exact key counts.
    if (e.Key !== key) continue;
    const id = str(e.VersionId);
    if (id === undefined) throw new AwsCliError("bad-output", "ListObjectVersions");
    const size = typeof e.Size === "number" ? e.Size : undefined;
    out.push({
      versionId: id,
      isLatest: e.IsLatest === true,
      ...(size === undefined ? {} : { size }),
    });
  }
  return out;
}

/**
 * Items per `aws` call of a listing, which is one S3 request. A listing is many calls, each one
 * S3 page, so each call's time is bounded by one page and the per-call timeout applies to a page,
 * not to the whole prefix: a dataset with a large Zarr copy (tens of thousands of chunks and
 * their versions) would otherwise have to list in ONE call inside the timeout, buffered as one
 * JSON document. 1000 is S3's own page limit.
 */
export const LIST_PAGE_ITEMS = 1000;

/**
 * A listing's pages, ONE S3 request per `aws` call (`--no-paginate`), following S3's own markers
 * (`NextContinuationToken`, or `NextKeyMarker` and `NextVersionIdMarker`) until a page says it is
 * the last. Not the CLI's `--max-items`/`--starting-token`: for list-object-versions it counts only
 * `Versions`, and a page it truncates hands its delete markers out twice.
 */
async function listPages(
  ctx: S3Ctx,
  op: "list-objects-v2" | "list-object-versions",
  prefix: string,
  pageItems: number,
): Promise<Array<Record<string, unknown>>> {
  const name = op === "list-objects-v2" ? "ListObjectsV2" : "ListObjectVersions";
  const bad = () => new AwsCliError("bad-output", name);
  const pages: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let next: string[] = [];
  for (;;) {
    const args = ["--bucket", ctx.bucket, "--prefix", prefix, "--max-keys", String(pageItems)];
    const out = await ctx.aws.api(op, [...args, "--no-paginate", ...next]);
    pages.push(out);
    if (out.IsTruncated !== true) {
      if (out.IsTruncated !== false && out.IsTruncated !== undefined) throw bad();
      return pages;
    }
    if (op === "list-objects-v2") {
      const token = str(out.NextContinuationToken);
      if (!token) throw bad();
      next = ["--continuation-token", token];
    } else {
      const key = str(out.NextKeyMarker);
      const id = str(out.NextVersionIdMarker);
      if (!key) throw bad();
      next = ["--key-marker", key, ...(id ? ["--version-id-marker", id] : [])];
    }
    // A marker that does not move on would list forever.
    const at = next.join("\u0000");
    if (seen.has(at)) throw bad();
    seen.add(at);
  }
}

/** Every Version and DeleteMarker of EXACTLY `key`, page by page. */
export async function listKeyVersions(
  ctx: S3Ctx,
  key: string,
  pageItems: number = LIST_PAGE_ITEMS,
): Promise<VersionListing> {
  const pages = await listPages(ctx, "list-object-versions", key, pageItems);
  return {
    versions: pages.flatMap((p) => entriesOf(p.Versions, key)),
    markers: pages.flatMap((p) => entriesOf(p.DeleteMarkers, key)),
  };
}

export interface PrefixEntry extends VersionEntry {
  key: string;
  kind: "version" | "marker";
}

/** Every Version and DeleteMarker under a PREFIX, with its key, page by page. */
export async function listPrefixVersions(
  ctx: S3Ctx,
  prefix: string,
  pageItems: number = LIST_PAGE_ITEMS,
): Promise<PrefixEntry[]> {
  const pages = await listPages(ctx, "list-object-versions", prefix, pageItems);
  const collect = (raw: unknown, kind: "version" | "marker"): PrefixEntry[] => {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new AwsCliError("bad-output", "ListObjectVersions");
    return (raw as Array<Record<string, unknown>>).map((e) => {
      const key = str(e.Key);
      const id = str(e.VersionId);
      if (key === undefined || id === undefined) {
        throw new AwsCliError("bad-output", "ListObjectVersions");
      }
      const size = typeof e.Size === "number" ? e.Size : undefined;
      return {
        key,
        versionId: id,
        isLatest: e.IsLatest === true,
        kind,
        ...(size === undefined ? {} : { size }),
      };
    });
  };
  return pages.flatMap((p) => [
    ...collect(p.Versions, "version"),
    ...collect(p.DeleteMarkers, "marker"),
  ]);
}

/** Current object keys under a prefix (list-objects-v2), page by page. */
export async function listCurrentKeys(
  ctx: S3Ctx,
  prefix: string,
  pageItems: number = LIST_PAGE_ITEMS,
): Promise<string[]> {
  const pages = await listPages(ctx, "list-objects-v2", prefix, pageItems);
  return pages.flatMap((p) => {
    const raw = p.Contents;
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new AwsCliError("bad-output", "ListObjectsV2");
    return (raw as Array<Record<string, unknown>>).map((e) => {
      const k = str(e.Key);
      if (k === undefined) throw new AwsCliError("bad-output", "ListObjectsV2");
      return k;
    });
  });
}

/** True when at least one CURRENT object lies under the prefix. Reads one entry, not the listing. */
export async function hasCurrentKey(ctx: S3Ctx, prefix: string): Promise<boolean> {
  const out = await ctx.aws.api("list-objects-v2", [
    "--bucket",
    ctx.bucket,
    "--prefix",
    prefix,
    "--max-items",
    "1",
    "--page-size",
    "1",
  ]);
  const raw = out.Contents;
  if (raw === undefined || raw === null) return false;
  if (!Array.isArray(raw)) throw new AwsCliError("bad-output", "ListObjectsV2");
  return raw.length > 0;
}

export interface RangeOptions {
  versionId?: string;
  ifMatch?: string;
}

/** Bytes [start, end] (inclusive) of an object, through a temp file that is removed at once. */
export async function readRange(
  ctx: S3Ctx,
  key: string,
  start: number,
  end: number,
  opts: RangeOptions = {},
): Promise<Uint8Array> {
  const file = ctx.tmp.file();
  try {
    const args = ["--bucket", ctx.bucket, "--key", key, "--range", `bytes=${start}-${end}`];
    if (opts.versionId) args.push("--version-id", opts.versionId);
    if (opts.ifMatch) args.push("--if-match", opts.ifMatch);
    args.push(file);
    await ctx.aws.api("get-object", args, { slow: true });
    const bytes = new Uint8Array(await readFile(file));
    if (bytes.length !== end - start + 1) throw new AwsCliError("short-read", "GetObject");
    return bytes;
  } finally {
    await ctx.tmp.remove(file);
  }
}

/** A whole object's bytes (no Range header). For small files such as a manifest. */
export async function readWhole(ctx: S3Ctx, key: string): Promise<Uint8Array> {
  const file = ctx.tmp.file();
  try {
    await ctx.aws.api("get-object", ["--bucket", ctx.bucket, "--key", key, file], { slow: true });
    return new Uint8Array(await readFile(file));
  } finally {
    await ctx.tmp.remove(file);
  }
}

export interface WholeObject extends ObjectMeta {
  bytes: Uint8Array;
  /** The ETag the bytes belong to, quoted as S3 sends it; what a conditional write names. */
  etag: string;
}

/**
 * A whole object and the metadata a rewrite must carry, in ONE get-object, so the bytes and the
 * ETag are the same version. `ifMatch` pins the read to an ETag seen earlier.
 */
export async function readWholeWithMeta(
  ctx: S3Ctx,
  key: string,
  ifMatch?: string,
): Promise<WholeObject> {
  const file = ctx.tmp.file();
  try {
    const args = ["--bucket", ctx.bucket, "--key", key];
    if (ifMatch) args.push("--if-match", ifMatch);
    args.push(file);
    const out = await ctx.aws.api("get-object", args, { slow: true });
    const etag = str(out.ETag);
    if (etag === undefined) throw new AwsCliError("bad-output", "GetObject");
    return {
      bytes: new Uint8Array(await readFile(file)),
      etag,
      contentType: str(out.ContentType),
      sse: str(out.ServerSideEncryption),
      kmsKeyId: str(out.SSEKMSKeyId),
      cacheControl: str(out.CacheControl),
    };
  } finally {
    await ctx.tmp.remove(file);
  }
}

export interface Retention {
  mode: string;
  /** ISO 8601. */
  retainUntil: string;
}

/** get-object-retention of one version. `null` when the version carries no retention. */
export async function getRetention(
  ctx: S3Ctx,
  key: string,
  versionId: string,
): Promise<Retention | null> {
  let out: Record<string, unknown>;
  try {
    out = await ctx.aws.api("get-object-retention", [
      "--bucket",
      ctx.bucket,
      "--key",
      key,
      "--version-id",
      versionId,
    ]);
  } catch (err) {
    if (err instanceof AwsCliError && err.code === "not-found") return null;
    throw err;
  }
  const r = out.Retention as Record<string, unknown> | undefined;
  const mode = r ? str(r.Mode) : undefined;
  const until = r ? isoOrUndefined(r.RetainUntilDate) : undefined;
  if (!mode || !until) return null;
  return { mode, retainUntil: until };
}

export interface ObjectMeta {
  contentType?: string;
  sse?: string;
  kmsKeyId?: string;
  cacheControl?: string;
}

function metaArgs(meta: ObjectMeta): string[] {
  const a: string[] = [];
  if (meta.contentType) a.push("--content-type", meta.contentType);
  if (meta.cacheControl) a.push("--cache-control", meta.cacheControl);
  if (meta.sse) a.push("--server-side-encryption", meta.sse);
  if (meta.kmsKeyId) a.push("--ssekms-key-id", meta.kmsKeyId);
  return a;
}

const lockArgs = (retainUntil: string) => [
  "--object-lock-mode",
  "GOVERNANCE",
  "--object-lock-retain-until-date",
  retainUntil,
];

/** put-object with the lock set at put time. Returns the new version id. */
export async function putObjectLocked(
  ctx: S3Ctx,
  key: string,
  bodyFile: string,
  meta: ObjectMeta,
  retainUntil: string,
): Promise<string> {
  const out = await ctx.aws.api(
    "put-object",
    [
      "--bucket",
      ctx.bucket,
      "--key",
      key,
      "--body",
      bodyFile,
      ...lockArgs(retainUntil),
      ...metaArgs(meta),
    ],
    { slow: true },
  );
  const id = str(out.VersionId);
  if (!id) throw new AwsCliError("bad-output", "PutObject");
  return id;
}

/** put-object with no lock and no condition (the canary's unlocked object). Returns the version id. */
export async function putObjectPlain(
  ctx: S3Ctx,
  key: string,
  bodyFile: string,
  meta: ObjectMeta,
): Promise<string> {
  const out = await ctx.aws.api(
    "put-object",
    ["--bucket", ctx.bucket, "--key", key, "--body", bodyFile, ...metaArgs(meta)],
    { slow: true },
  );
  const id = str(out.VersionId);
  if (!id) throw new AwsCliError("bad-output", "PutObject");
  return id;
}

/**
 * put-object that replaces the object ONLY if its current ETag is `ifMatch`: a writer that got
 * in since the read makes this fail (`precondition-failed`) rather than be overwritten. No lock
 * is set; this is for objects that carry none. Returns the new version id.
 */
export async function putObjectIfMatch(
  ctx: S3Ctx,
  key: string,
  bodyFile: string,
  meta: ObjectMeta,
  ifMatch: string,
): Promise<string> {
  const out = await ctx.aws.api(
    "put-object",
    [
      "--bucket",
      ctx.bucket,
      "--key",
      key,
      "--body",
      bodyFile,
      "--if-match",
      ifMatch,
      ...metaArgs(meta),
    ],
    { slow: true },
  );
  const id = str(out.VersionId);
  if (!id) throw new AwsCliError("bad-output", "PutObject");
  return id;
}

/**
 * put-object that creates the object ONLY if the key has no current version (`If-None-Match: *`):
 * a writer that created it since it was found absent makes this fail (`precondition-failed`)
 * rather than be overwritten. No lock is set. Returns the new version id.
 */
export async function putObjectIfAbsent(
  ctx: S3Ctx,
  key: string,
  bodyFile: string,
  meta: ObjectMeta,
): Promise<string> {
  const out = await ctx.aws.api(
    "put-object",
    [
      "--bucket",
      ctx.bucket,
      "--key",
      key,
      "--body",
      bodyFile,
      "--if-none-match",
      "*",
      ...metaArgs(meta),
    ],
    { slow: true },
  );
  const id = str(out.VersionId);
  if (!id) throw new AwsCliError("bad-output", "PutObject");
  return id;
}

export async function createMultipart(
  ctx: S3Ctx,
  key: string,
  meta: ObjectMeta,
  retainUntil: string,
): Promise<string> {
  const out = await ctx.aws.api("create-multipart-upload", [
    "--bucket",
    ctx.bucket,
    "--key",
    key,
    ...lockArgs(retainUntil),
    ...metaArgs(meta),
  ]);
  const id = str(out.UploadId);
  if (!id) throw new AwsCliError("bad-output", "CreateMultipartUpload");
  return id;
}

export async function uploadPart(
  ctx: S3Ctx,
  key: string,
  uploadId: string,
  partNumber: number,
  bodyFile: string,
): Promise<string> {
  const out = await ctx.aws.api(
    "upload-part",
    [
      "--bucket",
      ctx.bucket,
      "--key",
      key,
      "--upload-id",
      uploadId,
      "--part-number",
      String(partNumber),
      "--body",
      bodyFile,
    ],
    { slow: true },
  );
  const etag = str(out.ETag);
  if (!etag) throw new AwsCliError("bad-output", "UploadPart");
  return etag;
}

export async function uploadPartCopy(
  ctx: S3Ctx,
  key: string,
  uploadId: string,
  partNumber: number,
  source: { key: string; etag: string; start: number; end: number },
): Promise<string> {
  const out = await ctx.aws.api(
    "upload-part-copy",
    [
      "--bucket",
      ctx.bucket,
      "--key",
      key,
      "--upload-id",
      uploadId,
      "--part-number",
      String(partNumber),
      "--copy-source",
      `${ctx.bucket}/${source.key}`,
      "--copy-source-range",
      `bytes=${source.start}-${source.end}`,
      "--copy-source-if-match",
      source.etag,
    ],
    { slow: true },
  );
  const result = out.CopyPartResult as Record<string, unknown> | undefined;
  const etag = result ? str(result.ETag) : undefined;
  if (!etag) throw new AwsCliError("bad-output", "UploadPartCopy");
  return etag;
}

export async function completeMultipart(
  ctx: S3Ctx,
  key: string,
  uploadId: string,
  parts: Array<{ ETag: string; PartNumber: number }>,
): Promise<void> {
  await ctx.aws.api(
    "complete-multipart-upload",
    [
      "--bucket",
      ctx.bucket,
      "--key",
      key,
      "--upload-id",
      uploadId,
      "--multipart-upload",
      JSON.stringify({ Parts: parts }),
    ],
    { slow: true },
  );
}

/**
 * The multipart uploads open on EXACTLY `key` (one page: an upload left by a failed create is
 * one or two, never a thousand). Used to find an upload a create left behind when its answer was
 * lost, so it can be reported by key and upload id.
 */
export async function listOpenUploads(ctx: S3Ctx, key: string): Promise<string[]> {
  const out = await ctx.aws.api("list-multipart-uploads", [
    "--bucket",
    ctx.bucket,
    "--prefix",
    key,
    "--no-paginate",
  ]);
  const raw = out.Uploads;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AwsCliError("bad-output", "ListMultipartUploads");
  return (raw as Array<Record<string, unknown>>)
    .filter((u) => u.Key === key)
    .map((u) => {
      const id = str(u.UploadId);
      if (!id) throw new AwsCliError("bad-output", "ListMultipartUploads");
      return id;
    });
}

export async function abortMultipart(ctx: S3Ctx, key: string, uploadId: string): Promise<void> {
  await ctx.aws.api("abort-multipart-upload", [
    "--bucket",
    ctx.bucket,
    "--key",
    key,
    "--upload-id",
    uploadId,
  ]);
}

/**
 * Delete ONE version (or delete marker) by id. `bypass` adds the governance bypass; without it
 * a locked version is refused. The canary proves the lock this way, one version at a time; the
 * stages that delete many (`delete-old`, `drop-archives`) use {@link deleteVersions}.
 */
export async function deleteVersion(
  ctx: S3Ctx,
  key: string,
  versionId: string,
  bypass: boolean,
): Promise<void> {
  const args = ["--bucket", ctx.bucket, "--key", key, "--version-id", versionId];
  if (bypass) args.push("--bypass-governance-retention");
  await ctx.aws.api("delete-object", args);
}

/** The most versions one DeleteObjects request may name (S3's own limit). */
export const DELETE_BATCH_MAX = 1000;

/**
 * How many requests one batch gets in all (the first and the resends), and the pause before the
 * next, which grows with the attempt. A busy S3 answers a thousand-version request with `SlowDown`
 * on some of its items; the pauses (jittered) add up to about ten seconds, then the item is reported
 * and a re-run resumes.
 */
export const DELETE_BATCH_ATTEMPTS = 5;
export const DELETE_BATCH_BACKOFF_MS = 1000;

/** One version, or one delete marker, of one key. */
export interface VersionRef {
  key: string;
  versionId: string;
}

/**
 * Per-item codes of a DeleteObjects `Errors` list that mean "ask again", not "refused": the
 * request was throttled or S3 failed on its side. Anything else (AccessDenied above all, which is
 * a lock) is final for that item.
 */
const RETRYABLE_S3_CODES = new Set([
  "SlowDown",
  "InternalError",
  "ServiceUnavailable",
  "RequestTimeout",
  "Throttling",
  "ThrottlingException",
  "RequestLimitExceeded",
]);

/** Whole-request failures worth another try: the request may not have reached S3, or S3 was busy. */
const RETRYABLE_REQUEST_CODES = new Set<AwsErrorCode>(["throttled", "unreachable", "timeout"]);

const versionRefId = (key: string, versionId: string) => `${key}\0${versionId}`;

/**
 * Refuse, before any request, an item that could do harm: no version id (the request would add a
 * delete marker instead of removing a version; `JSON.stringify` drops an undefined one) or no
 * key. The literal version id `"null"` is real (an object put before versioning) and passes.
 */
function checkVersionRefs(items: readonly VersionRef[]): void {
  for (const it of items) {
    if (typeof it.versionId !== "string" || it.versionId === "") {
      throw new StageError("delete-without-version-id");
    }
    if (typeof it.key !== "string" || it.key === "") throw new StageError("delete-without-key");
  }
}

/** The pause before a resend: grows with the attempt, and is jittered so workers do not move in step. */
const pauseBeforeResend = (backoffMs: number, attempt: number) =>
  new Promise((r) => setTimeout(r, backoffMs * attempt * (0.5 + Math.random())));

/**
 * Delete up to {@link DELETE_BATCH_MAX} versions (or delete markers) in ONE `DeleteObjects`
 * request, each by its version id, and say which were not deleted.
 *
 * Returns one fixed word (`DeleteObjects:access-denied`, ...) for every item that is NOT known to
 * be gone, and `[]` when all are (or none were given). It throws only for input that could do
 * harm, before any request: an item with no version id (the request would then add a delete
 * marker instead of removing a version) and more items than S3 takes.
 *
 * Why the answer is read item by item: `DeleteObjects` answers 200 even when an item was
 * refused (a locked object without the bypass is a per-item `AccessDenied` in `Errors`), so a
 * 200 proves nothing about any one version. Every requested item must appear in `Deleted`, or
 * its refusal in `Errors`; one that appears in neither is reported as `bad-output`, never
 * assumed deleted. The caller's own listing afterwards stays the authority.
 *
 * `bypass` sends the governance bypass for the whole request, as the single-delete does. Items
 * that were throttled or failed on S3's side are sent again, only those, up to `attempts`
 * requests in all. Deleting a version that is already gone is not an error on S3, so a resend is
 * safe.
 *
 * The request body goes in a private temp file (`--delete file://...`), not on the command line:
 * a thousand versions would pass the per-argument limit of some systems and sit in `ps`.
 */
export async function deleteVersionBatch(
  ctx: S3Ctx,
  items: readonly VersionRef[],
  bypass: boolean,
  opts: { attempts?: number; backoffMs?: number } = {},
): Promise<string[]> {
  if (items.length === 0) return [];
  if (items.length > DELETE_BATCH_MAX) throw new StageError("delete-batch-too-large");
  checkVersionRefs(items);
  const attempts = opts.attempts ?? DELETE_BATCH_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? DELETE_BATCH_BACKOFF_MS;
  const failed: string[] = [];
  let pending = [...items];
  for (let attempt = 1; pending.length > 0; attempt++) {
    const last = attempt >= attempts;
    const file = ctx.tmp.file();
    let answer: Record<string, unknown> | undefined;
    try {
      await writeFile(
        file,
        JSON.stringify({
          Objects: pending.map((it) => ({ Key: it.key, VersionId: it.versionId })),
          Quiet: false,
        }),
        { mode: 0o600 },
      );
      const args = ["--bucket", ctx.bucket, "--delete", `file://${file}`];
      if (bypass) args.push("--bypass-governance-retention");
      answer = await ctx.aws.api("delete-objects", args, { slow: true });
    } catch (err) {
      // `answer` stays undefined: a request worth another try is resent below, after the body
      // file is gone and the pause is over; any other failure is every item's word.
      if (last || !(err instanceof AwsCliError) || !RETRYABLE_REQUEST_CODES.has(err.code)) {
        const word = failureWord(err);
        for (let i = 0; i < pending.length; i++) failed.push(word);
        return failed;
      }
    } finally {
      await ctx.tmp.remove(file);
    }
    if (answer === undefined) {
      await pauseBeforeResend(backoffMs, attempt);
      continue;
    }
    const deleted = new Set<string>();
    for (const d of Array.isArray(answer.Deleted) ? answer.Deleted : []) {
      const e = d as Record<string, unknown>;
      const id = e.VersionId ?? e.DeleteMarkerVersionId;
      if (typeof e.Key === "string" && typeof id === "string") {
        deleted.add(versionRefId(e.Key, id));
      }
    }
    const refused = new Map<string, string>();
    for (const r of Array.isArray(answer.Errors) ? answer.Errors : []) {
      const e = r as Record<string, unknown>;
      if (typeof e.Key === "string" && typeof e.VersionId === "string") {
        refused.set(versionRefId(e.Key, e.VersionId), typeof e.Code === "string" ? e.Code : "");
      }
    }
    const again: VersionRef[] = [];
    for (const it of pending) {
      const id = versionRefId(it.key, it.versionId);
      if (deleted.has(id)) continue;
      const code = refused.get(id);
      if (code === undefined) {
        failed.push(failureWord(new AwsCliError("bad-output", "DeleteObjects")));
      } else if (!last && RETRYABLE_S3_CODES.has(code)) {
        again.push(it);
      } else {
        failed.push(failureWord(classifyS3Code(code, "DeleteObjects")));
      }
    }
    pending = again;
    if (pending.length > 0) await pauseBeforeResend(backoffMs, attempt);
  }
  return failed;
}

/**
 * Delete every version in `items` (duplicates sent once), {@link DELETE_BATCH_MAX} per request,
 * with at most `concurrency` requests in flight. Returns the fixed word of every item that was
 * not deleted. `onBatch` hears the running totals after each request, for a progress line.
 */
export async function deleteVersions(
  ctx: S3Ctx,
  items: readonly VersionRef[],
  bypass: boolean,
  concurrency: number,
  onBatch?: (progress: { done: number; total: number; failed: number }) => void,
): Promise<string[]> {
  // Every item is checked before the first request, so a bad one in the last batch cannot leave
  // the earlier batches already sent.
  checkVersionRefs(items);
  const seen = new Set<string>();
  const unique: VersionRef[] = [];
  for (const it of items) {
    const id = versionRefId(it.key, it.versionId);
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(it);
  }
  const batches: VersionRef[][] = [];
  for (let i = 0; i < unique.length; i += DELETE_BATCH_MAX) {
    batches.push(unique.slice(i, i + DELETE_BATCH_MAX));
  }
  const failed: string[] = [];
  let done = 0;
  await runPool(batches, concurrency, async (batch) => {
    failed.push(...(await deleteVersionBatch(ctx, batch, bypass)));
    done += batch.length;
    onBatch?.({ done, total: unique.length, failed: failed.length });
  });
  return failed;
}
