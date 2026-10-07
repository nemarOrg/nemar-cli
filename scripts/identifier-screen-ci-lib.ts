/**
 * Library behind `scripts/identifier-screen-ci.ts`: the identifier screen a publication request
 * triggers (ADR 0086), run by `run-identifier-screen.yml` in `nemarDatasets/.github`.
 *
 * It screens the dataset's `main` for identifying information and posts a report to the Worker.
 * The decisions live here so a test can drive the real script against real git repositories and
 * HTTP stand-ins; the script is a thin CLI over this file.
 *
 * **What it reads.** A metadata-only clone (full history of commits and trees, no checkout,
 * blobs over the `--filter=blob:limit` bound fetched in one batch, never one at a time). Inline
 * files come from their git blob. An annexed file (a symlink into `.git/annex/objects`, or an
 * unlocked pointer file) is read by a ranged GET of `<id>/objects/<annex key>` on a presigned
 * URL minted here, so it works for a private dataset (the bucket denies anonymous reads for
 * those). The scanner and the fleet scan's `scanDatasetFromManifest` do the reading and the
 * verdict; this file only supplies the bytes. Every EDF/BDF header, scans table and candidate
 * JSON and text file is read: a local read is cheap and a sampling cap would make the verdict
 * `unchecked`.
 *
 * **What it does not read.** The content of earlier commits, except recordings. Every path that
 * ever existed on any ref (the `git-annex` branch excluded) is run through the path rules, so a
 * removed `photo.jpg` still counts. Every EDF/BDF that was in an earlier commit and is not in the
 * tree (its annex key, or its blob when committed to git directly, is in no file of the tree) has
 * its header read like a current one, because a header fixed in a later commit is still public in
 * history and in S3; an old object that S3 says is gone (404) leaks nothing and is counted as
 * `edf/superseded-absent` without making the record incomplete. But an old sidecar, table or text
 * file that was changed or deleted in a later commit is NOT opened: its earlier content is
 * history's concern (ADR 0085). The screen is of `main` as it is now, bound to its commit. Formats
 * the scanner cannot parse are counted, never read, and so is a submodule (`submodule-unread`).
 *
 * **Unknown is never healthy.** A read that failed, a header past the deadline and a symlink
 * that does not point into the annex are each counted as unread, and the record's
 * `incomplete` and verdict come from those counts, never from the absence of a recorded
 * failure. A run that cannot produce a verdict says so with one of the contract's fixed words.
 *
 * **The log is public.** `nemarDatasets/.github` Actions logs are readable by anyone, so this
 * file prints counts and fixed words only: no path, header, finding, error message, token,
 * presigned URL or clone URL, and not the verdict (which dataset has findings is not for a public
 * log). Child process output is captured and discarded, never forwarded.
 *
 * **The token never enters argv.** The clone authenticates through `http.extraheader` supplied in
 * `GIT_CONFIG_*` environment variables, scoped to the origin's host.
 *
 * Time on a 36,000-EDF dataset, estimated (not measured against real S3): the clone and tree walk
 * are tens of seconds to a few minutes; pointer reads and header parsing are CPU-bound at a few
 * seconds per ten thousand files; the 36,000 ranged GETs dominate at 32 in flight and about
 * 40 to 100 ms each from a GitHub runner to us-east-2, so one to three minutes. Well inside the
 * 35 minute default deadline.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client, type Subprocess } from "bun";
import {
  type DatasetRecord,
  INTERNAL_FAILURE,
  OTHER_FORMAT,
  REPORT_VERSION,
  ReportError,
  type ScreenError,
  type ScreenReport,
  foldOddFailures,
  foldOddFormats,
  parseScreenReport,
} from "../shared/identifier-screen-report";
import {
  type EntryReadOptions,
  LOCAL_SCAN_LIMITS,
  type ManifestEntry,
  ReadFailure,
  RunAborted,
  type ScanExtras,
  USER_AGENT,
  createContext,
  readCandidates,
  readHead,
  scanDatasetFromManifest,
} from "./identifier-fleet-lib";

// ---------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------

export const DEFAULT_DEADLINE_MS = 35 * 60 * 1000;
export const DEFAULT_BLOB_LIMIT = "64k";
export const GITHUB_DATASETS = "https://github.com/nemarDatasets";

/** Pointer files and symlink targets are tiny; anything bigger is content. */
const POINTER_MAX_BYTES = 1024;
const SYMLINK_MAX_BYTES = 4096;
/** Bytes of git blobs the screen will fetch beyond the clone's bound, in total. */
const PREFETCH_BUDGET_BYTES = 2 * 1024 ** 3;
/** Inline recordings are large, so they are fetched in small batches the budget can stop between. */
const PREFETCH_CHUNK = 5000;
const PREFETCH_EDF_CHUNK = 25;
/** A URL is minted for each read, so it only has to outlive one request and its retries. */
const PRESIGN_SECONDS = 900;
/** Six attempts over about two minutes: a Worker deploy or a cold start outlasts three quick tries. */
const CALLBACK_ATTEMPTS = 6;
/** Waits between attempts in units of the configured backoff (5 s in the workflow): 5, 10, 20, 30, 45 s. */
const CALLBACK_BACKOFF_STEPS = [1, 2, 4, 6, 9];

/** A bad environment or command line. The code is a fixed word; it never quotes the input. */
export class ScreenUsageError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ScreenUsageError";
    this.code = code;
  }
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface ScreenConfig {
  datasetId: string;
  ref: string;
  requestId: number;
  callbackUrl: string | null;
  callbackToken: string | null;
  githubToken: string | null;
  bucket: string;
  region: string;
  aws: AwsCredentials | null;
  workflowRunId: string;
  deadlineMs: number;
  /** Where the report is written, or null. */
  out: string | null;
  noCallback: boolean;
  /** Test seam: a local path or `file://` URL to clone instead of the GitHub repository. */
  cloneOrigin: string | null;
  /** Test seam: an S3-compatible endpoint (path style) instead of AWS. */
  s3Endpoint: string | null;
  /** Concurrent header reads. */
  concurrency: number;
  /** Test seam: the callback's retry backoff unit, 5 s in the workflow. */
  callbackBackoffMs: number;
  /** The clone's `--filter=blob:limit` bound. */
  blobLimit: string;
}

const DATASET_ID = /^(nm|on)\d{6}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{2,62}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const TOKEN = /^[\x21-\x7e]{1,512}$/;
const RUN_ID = /^\d{1,20}$/;
const BLOB_LIMIT = /^\d{1,9}[kmg]?$/;

const VALUE_FLAGS = new Set([
  "out",
  "clone-origin",
  "s3-endpoint",
  "concurrency",
  "callback-backoff-ms",
  "blob-limit",
]);

function positive(code: string, raw: string): number {
  if (!/^\d{1,12}$/.test(raw) || Number(raw) < 1) throw new ScreenUsageError(code);
  return Number(raw);
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

/** The callback may be https anywhere, or http to this machine (the tests), nothing else. */
function checkCallbackUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ScreenUsageError("callback-url");
  }
  const ok = url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
  if (!ok || url.username || url.password) throw new ScreenUsageError("callback-url");
  return url.toString();
}

export function parseScreenConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ScreenConfig {
  const flags = new Map<string, string>();
  let noCallback = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--no-callback") {
      noCallback = true;
    } else if (token.startsWith("--") && VALUE_FLAGS.has(token.slice(2))) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new ScreenUsageError("flag");
      flags.set(token.slice(2), value);
      i++;
    } else {
      throw new ScreenUsageError("flag");
    }
  }
  const text = (name: string): string => (env[name] ?? "").trim();

  const datasetId = text("DATASET_ID");
  if (datasetId.startsWith("xx")) throw new ScreenUsageError("dataset-id-sandbox");
  if (!DATASET_ID.test(datasetId)) throw new ScreenUsageError("dataset-id");

  const ref = text("REF") || "main";
  if (
    !REF.test(ref) ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.endsWith("/") ||
    ref.endsWith(".lock")
  ) {
    throw new ScreenUsageError("ref");
  }

  const requestRaw = text("REQUEST_ID") || "0";
  if (!/^\d{1,15}$/.test(requestRaw)) throw new ScreenUsageError("request-id");

  const callbackRaw = text("CALLBACK_URL");
  const callbackToken = text("CALLBACK_TOKEN") || null;
  if (callbackToken !== null && !TOKEN.test(callbackToken)) {
    throw new ScreenUsageError("callback-token");
  }
  const callbackUrl = callbackRaw === "" ? null : checkCallbackUrl(callbackRaw);
  if (callbackUrl !== null && callbackToken === null && !noCallback) {
    throw new ScreenUsageError("callback-token");
  }

  const githubToken = text("GH_TOKEN") || null;
  if (githubToken !== null && !TOKEN.test(githubToken)) throw new ScreenUsageError("gh-token");

  const bucket = text("S3_BUCKET") || "nemar";
  if (!BUCKET.test(bucket)) throw new ScreenUsageError("bucket");
  const region = text("AWS_REGION") || text("AWS_DEFAULT_REGION") || "us-east-2";
  if (!REGION.test(region)) throw new ScreenUsageError("region");

  const accessKeyId = text("AWS_ACCESS_KEY_ID");
  const secretAccessKey = text("AWS_SECRET_ACCESS_KEY");
  const sessionToken = text("AWS_SESSION_TOKEN");
  const aws: AwsCredentials | null =
    accessKeyId && secretAccessKey
      ? { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }
      : null;

  const workflowRunId = text("WORKFLOW_RUN_ID") || text("GITHUB_RUN_ID") || "0";
  if (!RUN_ID.test(workflowRunId)) throw new ScreenUsageError("workflow-run-id");

  const deadlineRaw = text("SCREEN_DEADLINE_MS");
  const deadlineMs = deadlineRaw ? positive("deadline", deadlineRaw) : DEFAULT_DEADLINE_MS;

  const blobLimit = flags.get("blob-limit") ?? DEFAULT_BLOB_LIMIT;
  if (!BLOB_LIMIT.test(blobLimit)) throw new ScreenUsageError("blob-limit");

  const s3Endpoint = flags.get("s3-endpoint") ?? null;
  if (s3Endpoint !== null) {
    try {
      new URL(s3Endpoint);
    } catch {
      throw new ScreenUsageError("s3-endpoint");
    }
  }

  return {
    datasetId,
    ref,
    requestId: Number(requestRaw),
    callbackUrl,
    callbackToken,
    githubToken,
    bucket,
    region,
    aws,
    workflowRunId,
    deadlineMs,
    out: flags.get("out") ?? null,
    noCallback,
    cloneOrigin: flags.get("clone-origin") ?? null,
    s3Endpoint,
    concurrency: positive("concurrency", flags.get("concurrency") ?? "32"),
    callbackBackoffMs: flags.has("callback-backoff-ms")
      ? positive("callback-backoff-ms", flags.get("callback-backoff-ms") as string)
      : 5000,
    blobLimit,
  };
}

// ---------------------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------------------

export function errorReport(
  error: ScreenError,
  scanner: string | null,
  head: string | null,
): ScreenReport {
  return { version: REPORT_VERSION, scanner, head, error };
}

// The folds that bring a scan into the contract's vocabulary live with the contract, so the
// uploader preflight (ADR 0087) folds exactly as this screen does.
export { INTERNAL_FAILURE, OTHER_FORMAT, foldOddFailures, foldOddFormats };

/**
 * The one door a scan passes through on its way to the Worker: the contract's own parser. What it
 * returns is the parser's rebuilt object, never the input, so a field the contract does not
 * declare cannot ride along. A ReportError here is a bug in the screen, not a property of the
 * dataset, so it becomes an error report and not a malformed one.
 */
export function finalizeScanReport(record: unknown, scanner: string, head: string): ScreenReport {
  try {
    // `finding_fields` is the fleet scan's own output; the report carries kinds and counts only.
    const { finding_fields: _omitted, ...scan } = (record ?? {}) as Record<string, unknown>;
    return parseScreenReport({
      version: REPORT_VERSION,
      scanner,
      head,
      scan,
    });
  } catch (error) {
    if (error instanceof ReportError) return errorReport("workflow-failed", scanner, head);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------
// Running git
// ---------------------------------------------------------------------------------------

interface RunResult {
  code: number | null;
  stdout: Uint8Array;
  timedOut: boolean;
}

interface RunOptions {
  env: Record<string, string>;
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
}

/** Run a command; stderr is discarded (it can quote a path), stdout is returned whole. */
async function run(cmd: string[], options: RunOptions): Promise<RunResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn(cmd, {
      env: options.env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
      stdout: "pipe",
      stderr: "ignore",
    });
    let timedOut = false;
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(
        () => {
          timedOut = true;
          proc.kill("SIGKILL");
        },
        Math.max(1, options.timeoutMs),
      );
    }
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer().then((b) => new Uint8Array(b)),
      proc.exited,
    ]);
    return { code, stdout, timedOut };
  } catch {
    return { code: null, stdout: new Uint8Array(), timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The environment of every git command: no prompt, no user or system config. Unless `lazy` is
 * set, a missing object answers "missing" instead of a hidden network round trip per blob.
 */
function gitEnv(lazy = false): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? tmpdir(),
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    ...(lazy ? {} : { GIT_NO_LAZY_FETCH: "1" }),
  };
}

/**
 * The environment of the commands that talk to the origin: the same, with the GitHub token as an
 * `http.extraheader` scoped to the origin's host. Environment variables, not argv, so the token
 * is in no process listing and no log line.
 */
function networkEnv(origin: string, token: string | null): Record<string, string> {
  const env = gitEnv(true);
  if (!token) return env;
  let scope: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return env;
    scope = `${url.protocol}//${url.host}/`;
  } catch {
    return env;
  }
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = `http.${scope}.extraheader`;
  env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${btoa(`x-access-token:${token}`)}`;
  return env;
}

export function originOf(config: Pick<ScreenConfig, "cloneOrigin" | "datasetId">): string {
  return config.cloneOrigin ?? `${GITHUB_DATASETS}/${config.datasetId}.git`;
}

export async function scannerRevision(): Promise<string | null> {
  const root = join(import.meta.dir, "..");
  const result = await run(["git", "-C", root, "rev-parse", "--short=7", "HEAD"], {
    env: gitEnv(),
    timeoutMs: 15_000,
  });
  const text = new TextDecoder().decode(result.stdout).trim();
  return result.code === 0 && /^[0-9a-f]{7,40}$/.test(text) ? text : null;
}

export type CloneResult = { ok: true } | { ok: false; error: "clone-failed" | "deadline" };

/** A metadata-only clone: every commit and tree, small blobs in the pack, large blobs left behind. */
export async function cloneMetadata(
  config: ScreenConfig,
  dir: string,
  timeoutMs: number,
): Promise<CloneResult> {
  const origin = originOf(config);
  const result = await run(
    [
      "git",
      "-c",
      "protocol.version=2",
      "clone",
      "--quiet",
      "--no-checkout",
      `--filter=blob:limit=${config.blobLimit}`,
      origin,
      dir,
    ],
    { env: networkEnv(origin, config.githubToken), timeoutMs },
  );
  if (result.timedOut) return { ok: false, error: "deadline" };
  return result.code === 0 ? { ok: true } : { ok: false, error: "clone-failed" };
}

/** The commit `ref` names in the clone, as 40 hex characters, or null. */
export async function resolveHead(dir: string, ref: string): Promise<string | null> {
  const candidates = [`refs/remotes/origin/${ref}`, `refs/tags/${ref}`, `refs/heads/${ref}`];
  if (/^[0-9a-f]{40}$/.test(ref)) candidates.push(ref);
  for (const name of candidates) {
    const result = await run(
      ["git", "-C", dir, "rev-parse", "--verify", "--quiet", `${name}^{commit}`],
      {
        env: gitEnv(),
        timeoutMs: 30_000,
      },
    );
    const text = new TextDecoder().decode(result.stdout).trim();
    if (result.code === 0 && /^[0-9a-f]{40}$/.test(text)) return text;
  }
  return null;
}

export interface TreeEntry {
  mode: string;
  oid: string;
  path: string;
}

export interface Tree {
  /** Every regular file and symlink. */
  entries: TreeEntry[];
  /** Submodule entries (mode 160000): a path whose content is another repository, never read. */
  gitlinks: number;
}

/** Every file of a commit's tree, and how many submodule entries it holds. */
export async function listTree(dir: string, head: string): Promise<Tree | null> {
  const result = await run(["git", "-C", dir, "ls-tree", "-r", "-z", "--full-tree", head], {
    env: gitEnv(),
    timeoutMs: 10 * 60_000,
  });
  if (result.code !== 0) return null;
  const decoder = new TextDecoder();
  const entries: TreeEntry[] = [];
  let gitlinks = 0;
  for (const record of decoder.decode(result.stdout).split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab < 0) return null;
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    if (type === "commit" && mode === "160000") {
      gitlinks++;
      continue;
    }
    if (type !== "blob" || !mode || !oid || !/^[0-9a-f]{40,64}$/.test(oid)) continue;
    entries.push({ mode, oid, path: record.slice(tab + 1) });
  }
  return { entries, gitlinks };
}

/** The size of each object in `oids` that is present, null for one that is not. Null on failure. */
export async function objectSizes(
  dir: string,
  oids: readonly string[],
): Promise<Map<string, number | null> | null> {
  const sizes = new Map<string, number | null>();
  if (oids.length === 0) return sizes;
  const result = await run(["git", "-C", dir, "cat-file", "--batch-check"], {
    env: gitEnv(),
    stdin: `${oids.join("\n")}\n`,
    timeoutMs: 10 * 60_000,
  });
  if (result.code !== 0) return null;
  for (const line of new TextDecoder().decode(result.stdout).split("\n")) {
    if (line === "") continue;
    const parts = line.split(" ");
    const oid = parts[0] as string;
    if (parts[1] === "missing") sizes.set(oid, null);
    else if (parts[1] === "blob" && /^\d+$/.test(parts[2] ?? "")) sizes.set(oid, Number(parts[2]));
    else return null;
  }
  return sizes;
}

/**
 * Fetch blobs the clone left behind, by object id, `chunk` at a time. After each chunk the bytes
 * that arrived are counted against `budgetBytes`; over it, the rest is not fetched and the
 * result is false. False means some blob the scan wants is not here, so that read fails and the
 * record is `unchecked`.
 */
export async function prefetchBlobs(
  config: ScreenConfig,
  dir: string,
  oids: readonly string[],
  options: { deadlineAt: number; chunk: number; budgetBytes: number },
): Promise<boolean> {
  const env = networkEnv(originOf(config), config.githubToken);
  let spent = 0;
  for (let i = 0; i < oids.length; i += options.chunk) {
    const left = options.deadlineAt - Date.now();
    if (left <= 0 || spent > options.budgetBytes) return false;
    const batch = oids.slice(i, i + options.chunk);
    const result = await run(
      [
        "git",
        "-C",
        dir,
        "-c",
        "fetch.negotiationAlgorithm=noop",
        "fetch",
        "origin",
        "--no-tags",
        "--no-write-fetch-head",
        "--recurse-submodules=no",
        "--filter=blob:none",
        "--stdin",
      ],
      { env, stdin: `${batch.join("\n")}\n`, timeoutMs: left },
    );
    if (result.code !== 0) return false;
    const sizes = await objectSizes(dir, batch);
    if (!sizes) return false;
    for (const size of sizes.values()) spent += size ?? 0;
  }
  return spent <= options.budgetBytes;
}

export interface HistoryWalk {
  /** Every path that appeared in any commit of any ref. */
  paths: Set<string>;
  /** Every blob a path held after some commit: object id to the first path and mode it was seen with. */
  blobs: Map<string, { path: string; mode: string }>;
}

/**
 * Every path that ever existed on any ref, and every blob it held, de-duplicated. The `git-annex`
 * branch is excluded: its "paths" are location logs named by annex key, not files of the dataset.
 * Null when git could not say, which the caller records as incomplete rather than as "no history".
 *
 * `--raw -z` is `:<old mode> <new mode> <old oid> <new oid> <status>` then the path, each NUL
 * ended, so one walk gives both the paths and the blobs without reading any content.
 */
export async function walkHistory(dir: string, deadlineAt: number): Promise<HistoryWalk | null> {
  const left = deadlineAt - Date.now();
  if (left <= 0) return null;
  const result = await run(
    [
      "git",
      "-C",
      dir,
      "log",
      "--exclude=refs/heads/git-annex",
      "--exclude=refs/remotes/origin/git-annex",
      "--all",
      "--raw",
      "--no-abbrev",
      "-m",
      "--no-renames",
      "--no-ext-diff",
      "--format=",
      "-z",
    ],
    { env: gitEnv(), timeoutMs: left },
  );
  if (result.code !== 0 || result.timedOut) return null;
  const tokens = new TextDecoder().decode(result.stdout).split("\0");
  const paths = new Set<string>();
  const blobs = new Map<string, { path: string; mode: string }>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (!token.startsWith(":")) continue;
    const meta = token.slice(1).split(" ");
    const path = tokens[i + 1];
    if (meta.length < 5 || path === undefined || path === "") return null;
    i++;
    paths.add(path);
    const [, mode, , oid, status] = meta as [string, string, string, string, string];
    if (status === "D" || /^0+$/.test(oid)) continue;
    if ((mode === "100644" || mode === "100755" || mode === "120000") && !blobs.has(oid)) {
      blobs.set(oid, { path, mode });
    }
  }
  return { paths, blobs };
}

// ---------------------------------------------------------------------------------------
// Git blobs through one `git cat-file --batch`
// ---------------------------------------------------------------------------------------

/** Bytes waiting to be parsed, as a list of chunks so a large blob is never re-copied. */
class ByteQueue {
  private chunks: Uint8Array[] = [];
  private offset = 0;
  length = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  indexOf(byte: number): number {
    let before = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i] as Uint8Array;
      const from = i === 0 ? this.offset : 0;
      const at = chunk.indexOf(byte, from);
      if (at >= 0) return before + (at - from);
      before += chunk.length - from;
    }
    return -1;
  }

  /** Remove the first `n` bytes and return the first `keep` of them. */
  take(n: number, keep: number): Uint8Array {
    const out = new Uint8Array(Math.min(n, keep));
    let copied = 0;
    let left = n;
    while (left > 0) {
      const chunk = this.chunks[0] as Uint8Array;
      const available = chunk.length - this.offset;
      const used = Math.min(available, left);
      const wanted = Math.min(used, out.length - copied);
      if (wanted > 0) {
        out.set(chunk.subarray(this.offset, this.offset + wanted), copied);
        copied += wanted;
      }
      left -= used;
      this.length -= used;
      if (used === available) {
        this.chunks.shift();
        this.offset = 0;
      } else {
        this.offset += used;
      }
    }
    return out;
  }
}

export type BlobRead =
  | { ok: true; bytes: Uint8Array; size: number }
  | { ok: false; reason: "missing" | "closed" };

interface PendingRead {
  keep: number;
  resolve: (result: BlobRead) => void;
}

/**
 * One long-lived `git cat-file --batch`. Requests are written as they arrive and answered in
 * order, so thousands of reads cost one process and no round trip each. Only the first `keep`
 * bytes of a blob are retained; the rest is consumed and dropped to keep the stream in step.
 */
export class GitBlobReader {
  private readonly proc: Subprocess<"pipe", "pipe", "ignore">;
  private readonly pending: PendingRead[] = [];
  private readonly done: Promise<void>;
  private closed = false;
  private flushScheduled = false;

  constructor(dir: string) {
    this.proc = Bun.spawn(["git", "-C", dir, "cat-file", "--batch"], {
      env: gitEnv(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    this.done = this.pump();
  }

  read(oid: string, keep: number): Promise<BlobRead> {
    if (this.closed || !/^[0-9a-f]{40,64}$/.test(oid)) {
      return Promise.resolve({ ok: false, reason: "closed" });
    }
    return new Promise((resolve) => {
      const request: PendingRead = { keep, resolve };
      this.pending.push(request);
      try {
        this.proc.stdin.write(`${oid}\n`);
        this.scheduleFlush();
      } catch {
        // The process is gone; this request never reached it.
        this.closed = true;
        this.pending.splice(this.pending.indexOf(request), 1);
        resolve({ ok: false, reason: "closed" });
      }
    });
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      try {
        this.proc.stdin.flush();
      } catch {
        // Requests already written will never be answered: end the process so they are reported.
        this.closed = true;
        this.proc.kill("SIGKILL");
      }
    });
  }

  private async pump(): Promise<void> {
    const reader = this.proc.stdout.getReader();
    const queue = new ByteQueue();
    const fill = async (): Promise<boolean> => {
      const { done, value } = await reader.read();
      if (done || !value) return false;
      queue.push(value);
      return true;
    };
    const decoder = new TextDecoder();
    try {
      for (;;) {
        let newline = queue.indexOf(0x0a);
        while (newline < 0) {
          if (!(await fill())) return;
          newline = queue.indexOf(0x0a);
        }
        const header = decoder.decode(queue.take(newline + 1, newline));
        const request = this.pending.shift();
        if (!request) return;
        const parts = header.split(" ");
        if (parts[1] === "missing") {
          request.resolve({ ok: false, reason: "missing" });
          continue;
        }
        const size = Number(parts[2]);
        if (parts.length < 3 || !Number.isSafeInteger(size) || size < 0) {
          this.pending.unshift(request);
          return;
        }
        // The blob, then the newline that ends the record; only the first `keep` bytes are kept.
        const keep = Math.min(size, request.keep);
        let remaining = size + 1;
        const out = new Uint8Array(keep);
        let copied = 0;
        while (remaining > 0) {
          if (queue.length === 0 && !(await fill())) {
            this.pending.unshift(request);
            return;
          }
          const n = Math.min(queue.length, remaining);
          const wanted = Math.max(0, Math.min(n, keep - copied));
          const piece = queue.take(n, wanted);
          out.set(piece, copied);
          copied += piece.length;
          remaining -= n;
        }
        request.resolve({ ok: true, bytes: out, size });
      }
    } catch {
      // Fall through: every outstanding read is reported closed.
    } finally {
      this.closed = true;
      for (const request of this.pending.splice(0)) {
        request.resolve({ ok: false, reason: "closed" });
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      this.proc.stdin.end();
    } catch {
      // Already closed.
    }
    const killer = setTimeout(() => this.proc.kill("SIGKILL"), 5000);
    await this.done;
    clearTimeout(killer);
  }
}

// ---------------------------------------------------------------------------------------
// From a git tree to manifest entries
// ---------------------------------------------------------------------------------------

/** `SHA256E-s1234--<hex>.edf`: backend, size, digest, extension. No path separator can occur. */
const ANNEX_KEY = /^([A-Z][A-Z0-9]*)-s(\d{1,15})--([0-9a-f]{8,128})((?:\.[A-Za-z0-9]{1,16}){0,3})$/;
const EDF_KEY_EXTENSION = /\.(edf|bdf)$/i;

export interface AnnexKey {
  key: string;
  size: number;
}

/**
 * The size an annex key declares, for the scan to trust, or null. The key comes from whoever
 * wrote the pointer, and a size of 0 would make the scan skip the file as empty, so a zero is
 * not believed: the file is read, and what the store says is what counts.
 */
export const declaredSize = (key: AnnexKey): number | null => (key.size === 0 ? null : key.size);

/**
 * The annex key a symlink target or a pointer file names, or null when it names none. A symlink
 * ends `.../annex/objects/<xx>/<yy>/<key>/<key>`; an unlocked pointer file holds one line,
 * `/annex/objects/<key>`.
 */
export function parseAnnexPointer(text: string, symlink: boolean): AnnexKey | null {
  const match = symlink
    ? /(?:^|\/)annex\/objects\/(?:[^/]+\/)*([^/]+)$/.exec(text.trim())
    : /^\/annex\/objects\/([^/\s]+)\s*$/.exec(text);
  const key = match?.[1];
  const parts = key ? ANNEX_KEY.exec(key) : null;
  return key && parts ? { key, size: Number(parts[2]) } : null;
}

export interface ResolvedTree {
  entries: ManifestEntry[];
  /** Files stored in the annex, files stored in git, and symlinks that point nowhere readable. */
  annexed: number;
  inline: number;
  unresolved: number;
  /** EDF/BDF files whose bytes are in S3. */
  annexedEdf: number;
}

const decoder = new TextDecoder();

/**
 * Turn a tree into manifest entries. A symlink, or a regular file small enough to be a pointer,
 * is read to see whether it names an annex key; everything else is inline content read from its
 * blob. `sizes` maps an object id to its byte size, or null when the clone left it behind.
 */
export async function resolveEntries(
  tree: readonly TreeEntry[],
  sizes: ReadonlyMap<string, number | null>,
  blobs: GitBlobReader,
): Promise<ResolvedTree> {
  const isSymlink = (t: TreeEntry) => t.mode === "120000";
  const mayPoint = (t: TreeEntry) =>
    isSymlink(t) || (sizes.get(t.oid) ?? Number.POSITIVE_INFINITY) <= POINTER_MAX_BYTES;

  const unique = [...new Set(tree.filter(mayPoint).map((t) => t.oid))];
  const pointers = new Map<string, { text: string } | null>();
  for (let i = 0; i < unique.length; i += 20_000) {
    await Promise.all(
      unique.slice(i, i + 20_000).map(async (oid) => {
        const read = await blobs.read(oid, SYMLINK_MAX_BYTES);
        pointers.set(oid, read.ok ? { text: decoder.decode(read.bytes) } : null);
      }),
    );
  }

  const entries: ManifestEntry[] = [];
  let annexed = 0;
  let inline = 0;
  let unresolved = 0;
  let annexedEdf = 0;
  const keys = new Map<string, AnnexKey | null>();
  for (const t of tree) {
    const symlink = isSymlink(t);
    let pointed: AnnexKey | null = null;
    if (mayPoint(t)) {
      const cacheKey = `${symlink ? "l" : "f"}${t.oid}`;
      if (!keys.has(cacheKey)) {
        const text = pointers.get(t.oid)?.text;
        keys.set(cacheKey, text === undefined ? null : parseAnnexPointer(text, symlink));
      }
      pointed = keys.get(cacheKey) ?? null;
    }
    if (pointed) {
      const edf = EDF_KEY_EXTENSION.test(pointed.key);
      annexed++;
      if (edf || /\.(edf|bdf)$/i.test(t.path)) annexedEdf++;
      entries.push({
        path: t.path,
        size: declaredSize(pointed),
        url: `annex:${pointed.key}`,
        ...(edf ? { edf: true } : {}),
      });
    } else if (symlink) {
      unresolved++;
      entries.push({ path: t.path, size: null, url: "unreadable:symlink" });
    } else {
      inline++;
      entries.push({ path: t.path, size: sizes.get(t.oid) ?? null, url: `git:${t.oid}` });
    }
  }
  return { entries, annexed, inline, unresolved, annexedEdf };
}

export interface Superseded {
  /** Recordings in an earlier commit and not in the tree, one per annex key or blob. */
  entries: ManifestEntry[];
  /** Historic blobs that could not be examined, so a recording among them may be unseen. */
  unreadable: number;
  /** Sizes of the historic objects examined, for the prefetch of any that the clone left behind. */
  sizes: Map<string, number | null>;
}

const EDF_PATH = /\.(edf|bdf)$/i;

/**
 * The recordings that are in git history but not in the tree. A header that was fixed in a later
 * commit is still in the earlier commit's annex key (and in S3), and both become public with the
 * repository, so a screen of the tree alone would call a dataset clean while the old header is one
 * `git log` away. A recording is superseded when its annex key is in no file of the tree (a file
 * that was only renamed or moved keeps its key), or, for a recording committed to git directly,
 * when its blob is in no file of the tree. Only pointers and recordings are read; the content of
 * other old files stays unread.
 */
export async function findSuperseded(
  dir: string,
  walk: HistoryWalk,
  tree: ResolvedTree,
  treeOids: ReadonlySet<string>,
  blobs: GitBlobReader,
): Promise<Superseded> {
  const treeKeys = new Set(
    tree.entries.filter((e) => e.url.startsWith("annex:")).map((e) => e.url.slice(6)),
  );
  const candidates = [...walk.blobs].filter(([oid]) => !treeOids.has(oid));
  const sizes = await objectSizes(
    dir,
    candidates.map(([oid]) => oid),
  );
  if (!sizes) return { entries: [], unreadable: candidates.length, sizes: new Map() };
  const found = new Map<string, ManifestEntry>();
  let unreadable = 0;
  const examine = async ([oid, { path, mode }]: [string, { path: string; mode: string }]) => {
    const symlink = mode === "120000";
    const size = sizes.get(oid) ?? null;
    const small = size !== null && size <= POINTER_MAX_BYTES;
    if (symlink || small) {
      const read = await blobs.read(oid, SYMLINK_MAX_BYTES);
      if (!read.ok) {
        unreadable++;
        return;
      }
      const pointed = parseAnnexPointer(decoder.decode(read.bytes), symlink);
      if (pointed) {
        if (
          !treeKeys.has(pointed.key) &&
          (EDF_KEY_EXTENSION.test(pointed.key) || EDF_PATH.test(path))
        ) {
          found.set(`annex:${pointed.key}`, {
            path,
            size: declaredSize(pointed),
            url: `annex:${pointed.key}`,
            edf: true,
          });
        }
        return;
      }
      if (symlink) return;
    }
    // Not a pointer: a recording committed to git directly is read from its blob.
    if (EDF_PATH.test(path)) found.set(`git:${oid}`, { path, size, url: `git:${oid}`, edf: true });
  };
  for (let i = 0; i < candidates.length; i += 20_000) {
    await Promise.all(candidates.slice(i, i + 20_000).map(examine));
  }
  return { entries: [...found.values()], unreadable, sizes };
}

/**
 * The inline blobs the scan will read that the clone left behind. The fleet scan's own candidate
 * rules decide what is read, so this names exactly that and no more. Recordings are listed apart
 * from the small files because their blobs are large and are fetched in smaller batches.
 */
export function blobsToFetch(
  entries: readonly ManifestEntry[],
  sizes: ReadonlyMap<string, number | null>,
  superseded: readonly ManifestEntry[] = [],
): { small: string[]; recordings: string[] } {
  const candidates = readCandidates(entries);
  const missing = (entry: ManifestEntry): string | null => {
    if (!entry.url.startsWith("git:")) return null;
    const oid = entry.url.slice(4);
    return sizes.get(oid) === null ? oid : null;
  };
  const collect = (list: readonly ManifestEntry[]): string[] => [
    ...new Set(list.map(missing).filter((oid): oid is string => oid !== null)),
  ];
  return {
    small: collect([
      ...candidates.scans,
      ...candidates.json,
      ...candidates.text,
      ...(candidates.participants ? [candidates.participants] : []),
    ]),
    recordings: collect([...candidates.edf, ...superseded]),
  };
}

// ---------------------------------------------------------------------------------------
// Reading an entry
// ---------------------------------------------------------------------------------------

/** Presigned GET URLs for `<dataset>/objects/<key>`, minted when asked and never stored or logged. */
export function createPresigner(config: ScreenConfig): ((key: string) => string) | null {
  if (!config.aws) return null;
  const client = new S3Client({
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
    ...(config.aws.sessionToken ? { sessionToken: config.aws.sessionToken } : {}),
    region: config.region,
    bucket: config.bucket,
    ...(config.s3Endpoint ? { endpoint: config.s3Endpoint } : { virtualHostedStyle: true }),
  });
  return (key) =>
    client.presign(`${config.datasetId}/objects/${key}`, {
      method: "GET",
      expiresIn: PRESIGN_SECONDS,
    });
}

export interface EntryReaderDeps {
  blobs: GitBlobReader;
  presign: ((key: string) => string) | null;
  deadlineAt: number;
}

/**
 * The reader the fleet scan calls in place of an HTTP read. Past the deadline it starts nothing:
 * the read fails with the fixed class `deadline`, so the header counts as unread and the record
 * is `unchecked`. It always throws a {@link ReadFailure} with a fixed class; the scan records
 * the class, never a message.
 */
export function createEntryReader(deps: EntryReaderDeps) {
  return async (
    entry: ManifestEntry,
    n: number,
    options: EntryReadOptions,
  ): Promise<Uint8Array> => {
    if (Date.now() >= deps.deadlineAt) throw new ReadFailure("deadline");
    if (entry.url.startsWith("git:")) {
      const read = await deps.blobs.read(entry.url.slice(4), n);
      if (!read.ok) throw new ReadFailure(`blob-${read.reason}`);
      if (read.bytes.length < options.minBytes) throw new ReadFailure("short-body");
      return read.bytes;
    }
    if (entry.url.startsWith("annex:")) {
      if (!deps.presign) throw new ReadFailure("credentials-missing");
      return readHead(deps.presign(entry.url.slice(6)), n, options);
    }
    throw new ReadFailure("unreadable-entry");
  };
}

// ---------------------------------------------------------------------------------------
// The callback
// ---------------------------------------------------------------------------------------

export interface DeliverOptions {
  url: string;
  token: string;
  body: unknown;
  backoffMs: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  timeoutMs?: number;
}

/**
 * POST the report. A 2xx delivers. A redirect is final (it is not followed, so the token header
 * goes to the URL it was given and no further). A 4xx is final too, since a bad token, no request
 * in flight or a refused body will not improve, except 401 (a token-rotation race across Worker
 * instances), 408 and 429, which are the server asking for another try. Everything else (5xx, a
 * dropped connection, a timeout) waits and tries again, up to six attempts in all. Nothing from the
 * response is printed.
 */
export async function deliverReport(options: DeliverOptions): Promise<boolean> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = options.log ?? (() => undefined);
  const body = JSON.stringify(options.body);
  for (let attempt = 1; attempt <= CALLBACK_ATTEMPTS; attempt++) {
    let status = 0;
    try {
      const res = await fetch(options.url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Token": options.token,
          "User-Agent": USER_AGENT,
        },
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
      status = res.status;
      await res.body?.cancel().catch(() => undefined);
    } catch {
      status = 0;
    }
    log(`callback attempt ${attempt}: HTTP ${status}`);
    if (status >= 200 && status < 300) return true;
    if (status >= 300 && status < 400) return false;
    if (status >= 400 && status < 500 && ![401, 408, 429].includes(status)) return false;
    if (attempt < CALLBACK_ATTEMPTS) {
      await sleep((CALLBACK_BACKOFF_STEPS[attempt - 1] as number) * options.backoffMs);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------------------

export interface ScreenDeps {
  /** The scan itself; only a test replaces it, to prove a hostile result cannot be posted. */
  scan?: typeof scanDatasetFromManifest;
  /** The history walk; only a test replaces it, because git cannot be made to fail on a valid clone. */
  history?: typeof walkHistory;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** The scanner revision; defaults to the HEAD of the checkout this file runs from. */
  scannerRevision?: string | null;
}

export interface ScreenOutcome {
  report: ScreenReport;
  /** True when the Worker accepted it, false when it did not, null when none was sent. */
  delivered: boolean | null;
}

/** Make the report for one dataset. Never throws: an unexpected failure is a `workflow-failed` report. */
export async function screenDataset(
  config: ScreenConfig,
  deps: ScreenDeps = {},
  startedAt: number = Date.now(),
): Promise<ScreenReport> {
  const log = deps.log ?? (() => undefined);
  const scanner =
    deps.scannerRevision === undefined ? await scannerRevision() : deps.scannerRevision;
  const scannerId = scanner ? `identifier-scan@${scanner}` : null;
  const deadlineAt = startedAt + config.deadlineMs;
  let head: string | null = null;
  // Made inside the try: a scratch directory that cannot be made throws an error whose message
  // names its path, and an uncaught one would print that to the public log.
  let dir: string | null = null;
  let blobs: GitBlobReader | null = null;
  try {
    if (!scannerId) return errorReport("workflow-failed", null, null);

    dir = mkdtempSync(join(tmpdir(), "identifier-screen-"));
    const cloned = await cloneMetadata(config, join(dir, "repo"), deadlineAt - Date.now());
    if (!cloned.ok) {
      log(`screen: error=${cloned.error}`);
      return errorReport(cloned.error, scannerId, null);
    }
    const repo = join(dir, "repo");
    head = await resolveHead(repo, config.ref);
    if (!head) {
      log("screen: error=clone-failed");
      return errorReport("clone-failed", scannerId, null);
    }
    log(`screen: head ${head.slice(0, 7)}`);

    const tree = await listTree(repo, head);
    if (!tree) return errorReport("workflow-failed", scannerId, head);
    const treeOids = new Set(tree.entries.map((t) => t.oid));
    let sizes = await objectSizes(repo, [...treeOids]);
    if (!sizes) return errorReport("workflow-failed", scannerId, head);

    blobs = new GitBlobReader(repo);
    const resolved = await resolveEntries(tree.entries, sizes, blobs);
    log(
      `screen: tree files=${resolved.entries.length} annexed=${resolved.annexed} ` +
        `inline=${resolved.inline} unresolved=${resolved.unresolved} submodules=${tree.gitlinks}`,
    );

    // Every path that ever existed, and the recordings an earlier commit held that the tree no
    // longer does: they are as public as the tree's, so they are read with it.
    const walk = await (deps.history ?? walkHistory)(repo, deadlineAt);
    const superseded: Superseded = walk
      ? await findSuperseded(repo, walk, resolved, treeOids, blobs)
      : { entries: [], unreadable: 0, sizes: new Map() };
    sizes = new Map([...sizes, ...superseded.sizes]);
    const headPaths = new Set(resolved.entries.map((e) => e.path));
    const extras: ScanExtras = {
      extraPaths: walk ? [...walk.paths].filter((p) => !headPaths.has(p)) : [],
      extraIncompleteReasons: [
        ...(walk && superseded.unreadable === 0 ? [] : ["history-unread"]),
        ...(tree.gitlinks > 0 ? ["submodule-unread"] : []),
      ],
      supersededEdf: superseded.entries,
    };
    log(
      `screen: history ${walk ? `paths=${walk.paths.size} superseded=${superseded.entries.length}` : "unread"}`,
    );

    // Annexed recordings are read in S3. Without credentials that is every one of them
    // unread, so say so with its own word instead of a record full of failures.
    const needsStorage =
      resolved.annexedEdf + superseded.entries.filter((e) => e.url.startsWith("annex:")).length;
    if (!config.aws && needsStorage > 0) {
      log("screen: error=credentials-missing");
      return errorReport("credentials-missing", scannerId, head);
    }

    // Blobs over the clone's bound, fetched in batches for exactly the files the scan reads.
    const missing = blobsToFetch(resolved.entries, sizes, superseded.entries);
    const fetchedAll = [
      await prefetchBlobs(config, repo, missing.small, {
        deadlineAt,
        chunk: PREFETCH_CHUNK,
        budgetBytes: PREFETCH_BUDGET_BYTES,
      }),
      await prefetchBlobs(config, repo, missing.recordings, {
        deadlineAt,
        chunk: PREFETCH_EDF_CHUNK,
        budgetBytes: PREFETCH_BUDGET_BYTES,
      }),
    ].every(Boolean);
    const fetchedOids = [...missing.small, ...missing.recordings];
    if (fetchedOids.length > 0) {
      log(`screen: prefetch blobs=${fetchedOids.length} ${fetchedAll ? "ok" : "incomplete"}`);
      const refreshed = await objectSizes(repo, fetchedOids);
      if (refreshed) {
        sizes = new Map([...sizes, ...refreshed]);
        for (const entry of [...resolved.entries, ...superseded.entries]) {
          if (entry.url.startsWith("git:")) entry.size = sizes.get(entry.url.slice(4)) ?? null;
        }
      }
    }

    const ctx = createContext({
      fileConcurrency: config.concurrency,
      workerConcurrency: 1,
      githubToken: async () => null,
      limits: { ...LOCAL_SCAN_LIMITS },
      readEntryHead: createEntryReader({ blobs, presign: createPresigner(config), deadlineAt }),
    });
    const scan = deps.scan ?? scanDatasetFromManifest;
    let record: DatasetRecord;
    try {
      record = await scan(ctx, config.datasetId, null, resolved.entries, "clone", extras);
    } catch (error) {
      // A tripped breaker means the storage was failing in a streak; there is no verdict to give.
      if (error instanceof RunAborted) {
        log("screen: error=workflow-failed (read streak)");
        return errorReport("workflow-failed", scannerId, head);
      }
      throw error;
    }
    const report = finalizeScanReport(foldOddFailures(foldOddFormats(record)), scannerId, head);
    if (report.scan) {
      const f = report.scan.files;
      log(
        `screen: done files=${f?.total ?? 0} edf_bdf=${f?.edf_bdf ?? 0} ` +
          `header_read=${f?.header_read ?? 0} header_unread=${(f?.edf_bdf ?? 0) - (f?.header_read ?? 0)}`,
      );
    } else {
      log("screen: error=workflow-failed (report refused)");
    }
    return report;
  } catch (error) {
    log(`screen: unexpected failure (${error instanceof Error ? error.name : "unknown"})`);
    return errorReport("workflow-failed", scannerId, head);
  } finally {
    await blobs?.close().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** Screen one dataset, write the report if asked, and deliver it. */
export async function runScreen(
  config: ScreenConfig,
  deps: ScreenDeps = {},
): Promise<ScreenOutcome> {
  const log = deps.log ?? (() => undefined);
  const report = await screenDataset(config, deps);
  if (config.out) {
    try {
      writeFileSync(config.out, `${JSON.stringify(report, null, 1)}\n`);
    } catch {
      log("out: write failed");
    }
  }
  if (config.noCallback || !config.callbackUrl || !config.callbackToken) {
    log("callback: skipped");
    return { report, delivered: null };
  }
  const delivered = await deliverReport({
    url: config.callbackUrl,
    token: config.callbackToken,
    body: {
      dataset_id: config.datasetId,
      request_id: config.requestId,
      workflow_run_id: config.workflowRunId,
      report,
    },
    backoffMs: config.callbackBackoffMs,
    log,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  return { report, delivered };
}
