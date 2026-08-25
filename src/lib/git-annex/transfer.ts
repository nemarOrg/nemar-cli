/**
 * git-annex service: annexed-data transfer (get/copy/drop) and key/location
 * queries.
 *
 * Split from lib/git-annex.ts by concern (#908, epic #902); bodies moved
 * verbatim.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import { shouldAnnex } from "./policy.js";
import { runCommand } from "./run-command.js";
import { type S3Credentials, awsCredentialEnv } from "./s3-remote.js";

/**
 * Dataset upload progress
 */
export interface UploadProgress {
  phase: "metadata" | "data" | "finalize";
  current: number;
  total: number;
  currentFile?: string;
  bytesTransferred?: number;
  bytesTotal?: number;
}

/**
 * git-annex JSON progress line (from --json-progress output).
 *
 * For byte-progress events, git-annex nests file/key/command under `action`:
 *   {"action":{"command":"get","file":"x.bin","key":"..."},
 *    "byte-progress":1024,"total-size":2048}
 *
 * For completion events, file/key/command are top-level (no `action`):
 *   {"command":"get","file":"x.bin","key":"...","success":true}
 *
 * Consumers should read the file path from `line.file ?? line.action?.file`.
 */
interface GitAnnexAction {
  command?: string;
  file?: string;
  key?: string;
}

interface GitAnnexProgressLine {
  action?: GitAnnexAction;
  file?: string;
  "byte-progress"?: number;
  "total-size"?: number;
  "percent-progress"?: string;
  key?: string;
  ok?: boolean;
  success?: boolean;
  note?: string;
  "error-messages"?: string[];
  error?: string;
}

/**
 * Progress callback for getDatasetData streaming mode
 */
export type DownloadProgressCallback = (line: GitAnnexProgressLine) => void;

/**
 * Count files and bytes pending download from remote(s).
 *
 * Wraps `git annex find --not --in=here --json` and sums the `bytesize`
 * field. Used to seed progress totals before calling `git annex get` so the
 * progress bar has an authoritative denominator.
 *
 * Returns {fileCount: 0, totalBytes: 0} when nothing is pending.
 * Returns null when the command fails (e.g., git-annex too old) so callers
 * can degrade gracefully rather than aborting.
 */
export async function countPendingDownload(
  datasetPath: string,
  paths?: string[],
  extraArgs?: string[],
): Promise<{ fileCount: number; totalBytes: number } | null> {
  const targets = paths && paths.length > 0 ? paths : ["."];
  const matchArgs = extraArgs && extraArgs.length > 0 ? extraArgs : [];
  try {
    const { stdout, stderr, exitCode } = await runCommand(
      ["git", "annex", "find", "--not", "--in=here", ...matchArgs, "--json", ...targets],
      { cwd: datasetPath },
    );
    if (exitCode !== 0) {
      if (process.env.VERBOSE && stderr.trim()) {
        console.warn(`countPendingDownload: git annex find failed: ${stderr.trim()}`);
      }
      return null;
    }

    let fileCount = 0;
    let totalBytes = 0;
    let sawNonJson = false;
    let sawAnyContent = false;
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      sawAnyContent = true;
      if (!trimmed.startsWith("{")) {
        sawNonJson = true;
        continue;
      }
      try {
        const entry = JSON.parse(trimmed) as { bytesize?: string };
        fileCount++;
        if (entry.bytesize) {
          const n = Number.parseInt(entry.bytesize, 10);
          if (Number.isFinite(n)) totalBytes += n;
        }
      } catch {
        sawNonJson = true;
      }
    }

    // Distinguish "annex find succeeded with truly empty output" (zero pending)
    // from "annex emitted only warnings/non-JSON" (unknown). The former is
    // authoritative; the latter must degrade so the caller does not
    // misreport "All data files already present".
    if (fileCount === 0 && sawAnyContent && sawNonJson) return null;

    return { fileCount, totalBytes };
  } catch (err) {
    if (process.env.VERBOSE) {
      console.warn(`countPendingDownload: ${(err as Error).message}`);
    }
    return null;
  }
}

/** Outcome of a `git annex get` run. See {@link classifyGetOutcome}. */
export type GetOutcome = "complete" | "partial" | "failed";

/** Most unavailable paths to retain for reporting; the rest are counted only. */
export const MAX_UNAVAILABLE_SAMPLE = 10;

interface GetDataCounts {
  filesDownloaded: number;
  /** Files whose content no configured remote could supply. */
  filesUnavailable: number;
  /** Bounded sample of unavailable paths, for user-facing reporting. */
  unavailablePaths: string[];
}

/**
 * Result of a retrieval. Discriminated on `success` so callers narrow to a
 * guaranteed `error` on the failure arm -- a step up from the flat
 * `{ success: boolean; error?: string }` shape used elsewhere in lib/git-annex,
 * where `error` is optional on both arms. Keeping the counts required on BOTH
 * arms means callers never need `?? 0` defaults, and `success` can never
 * disagree with `outcome`.
 */
export type GetDataResult =
  | ({ success: true; outcome: "complete" | "partial"; error?: undefined } & GetDataCounts)
  | ({ success: false; outcome: "failed"; error: string } & GetDataCounts);

/**
 * Build the result for a run that reached classification, keeping `success` and
 * `outcome` in lockstep. The two pre-classification failure returns (whole-run
 * non-zero exit, thrown exception) build the failed shape directly; every
 * classified outcome must route through here.
 * `errorText` is git-annex's own output, which carries the actionable detail
 * (no remotes configured, credentials rejected, host unreachable) that a bare
 * count throws away; the generic fallback fires only when it produced nothing.
 */
function toGetDataResult(
  outcome: GetOutcome,
  counts: GetDataCounts,
  errorText: string,
): GetDataResult {
  if (outcome === "failed") {
    return {
      success: false,
      outcome,
      error:
        errorText.trim() ||
        `${counts.filesUnavailable} file(s) unavailable from every configured remote`,
      ...counts,
    };
  }
  return { success: true, outcome, ...counts };
}

/**
 * Signals that the object is genuinely absent from the remote: the request was
 * answered, and the answer was "no such object".
 */
const CONTENT_ABSENT_RE = /not found|nosuchkey|no such key|does not exist/i;

/**
 * Signals that point at credentials, permissions, or connectivity rather than
 * missing content.
 *
 * Deliberately matches only TEXTUAL signals, never bare HTTP status numbers.
 * `\b40[13]\b` looked equivalent but matches BIDS subject directories: a run
 * over `sub-403/eeg/...` or `sub-501/anat/...` would be read as a permissions
 * or server failure purely because of a participant label. git-annex spells the
 * real causes out in words ("download failed: AccessDenied"), so the words are
 * both safer and sufficient.
 *
 * Note that git-annex's generic "Unable to access these remotes: <name>"
 * summary is intentionally NOT here: it is printed for plain 404s too (it
 * appears verbatim in the on003574 capture), so treating it as a transport
 * signal would misread every legitimately-absent file as a transport fault.
 */
const TRANSPORT_FAIL_RE =
  /access ?denied|forbidden|unauthori[sz]ed|invalid[^\n]*(key|token|credential)|expired|signaturedoesnotmatch|requesttimetooskewed|slow ?down|serviceunavailable|internalerror|throttl|could ?n[o']?t connect|connection (refused|reset|timed ?out)|network is unreachable|(?:could not |unable to )?resolve host|timed ?out/i;

/**
 * Decide the outcome of a `git annex get` run.
 *
 * git-annex retrieves every key it can and reports the rest as individual file
 * failures, so a non-zero exit means "something was unavailable", not "the
 * download did not happen". Availability is a property NEMAR reports, not a
 * precondition for serving (#1038): a dataset that is 99.998% present -- one
 * stray upstream temp file out of 65,063 -- must still download.
 *
 *   - Nothing unavailable         -> `complete`. Zero retrieved just means every
 *                                    requested file was already local.
 *   - Transport fault in output   -> `failed`, whatever the tallies. Checked
 *                                    BEFORE the retrieved count, because a
 *                                    fault can develop mid-run: STS credentials
 *                                    are short-lived (see s3-remote.ts), so a
 *                                    parallel `-J` run over a large dataset can
 *                                    easily land a few files and then 403 on
 *                                    every remaining one. Reading that as
 *                                    `partial` would exit 0 and tell the user
 *                                    the data is missing upstream when in fact
 *                                    a retry would fetch all of it.
 *   - Some retrieved, some not    -> `partial`.
 *   - Nothing retrieved, some not -> `failureText` breaks the tie. This is the
 *                                    ordinary re-run case: on a partially
 *                                    downloaded dataset git-annex silently skips
 *                                    the files already present, so a second
 *                                    `get` retrieves nothing and re-reports the
 *                                    same absent files. Treating that as fatal
 *                                    would make every repeat run exit 1.
 *
 * The tie-break reads git-annex's failure output because that is the only place
 * the distinction survives: "not found" means the archive answered and does not
 * have the object, while denied/expired/connection errors mean we never got a
 * usable answer. An unrecognised failure stays `failed`, so the ambiguous path
 * only ever downgrades to `partial` on positive evidence of absence.
 *
 * `requireComplete` (the CLI's --require-complete) collapses `partial` into
 * `failed` for pipelines that need all-or-nothing semantics.
 *
 * Pure -- no I/O; unit-tested without git-annex.
 */
export function classifyGetOutcome(input: {
  retrieved: number;
  unavailable: number;
  requireComplete?: boolean;
  /** git-annex stderr plus any per-file failure notes, for the tie-break. */
  failureText?: string;
}): GetOutcome {
  const { retrieved, unavailable, requireComplete = false, failureText = "" } = input;
  if (unavailable <= 0) return "complete";
  if (requireComplete) return "failed";
  if (TRANSPORT_FAIL_RE.test(failureText)) return "failed";
  if (retrieved > 0) return "partial";
  return CONTENT_ABSENT_RE.test(failureText) ? "partial" : "failed";
}

/**
 * Get data files from remote (S3) for a cloned dataset.
 *
 * Always runs with `--json --json-progress` and tallies the per-file completion
 * events; `onProgress`, when supplied, just observes the same stream. There is
 * deliberately no plain-text path: under `-J` git-annex's human output is not
 * stable enough to parse. On 10.20240129 (what Ubuntu, and therefore CI, ships)
 * a parallel run interleaves the per-file headers onto one line and emits bare
 * `ok` lines afterwards, so a `get <file> ok` scan matches nothing; on
 * 10.20260717 the same run emits one clean line per file. The stream a line
 * lands on also shifts with whether stdout is a TTY. `--json` is identical on
 * both versions -- verified by running each in turn.
 *
 * Partial retrieval is reported, not treated as failure -- see
 * {@link classifyGetOutcome}.
 */
export async function getDatasetData(
  datasetPath: string,
  options: {
    jobs?: number;
    paths?: string[]; // Specific paths to get, or all if empty
    /**
     * Extra arguments inserted before the path arguments. Used by callers to
     * pass git-annex matching options like --include/--exclude/--and/--or
     * (and the literal "-(" / "-)" group delimiters).
     */
    extraArgs?: string[];
    credentials?: S3Credentials;
    onProgress?: DownloadProgressCallback;
    /** Treat any unavailable file as a failure (CLI --require-complete). */
    requireComplete?: boolean;
  } = {},
): Promise<GetDataResult> {
  const jobs = options.jobs || 4;
  const paths = options.paths && options.paths.length > 0 ? options.paths : ["."];
  const extraArgs = options.extraArgs ?? [];

  const env = awsCredentialEnv(options.credentials) ?? {};

  const mergedEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter((e): e is [string, string] => e[1] != null),
  );

  try {
    // Streaming mode: parse --json-progress lines as they arrive
    const args = [
      "git",
      "annex",
      "get",
      "--json",
      "--json-progress",
      "-J",
      jobs.toString(),
      ...extraArgs,
      ...paths,
    ];

    const proc = spawn({
      cmd: args,
      cwd: datasetPath,
      stdout: "pipe",
      stderr: "pipe",
      env: mergedEnv,
    });

    let filesDownloaded = 0;
    let filesUnavailable = 0;
    const unavailablePaths: string[] = [];
    // Per-file failure notes, joined with stderr for the classifier tie-break.
    const failureNotes: string[] = [];
    let stderrOutput = "";
    const stderrChunks: Uint8Array[] = [];

    // Tally a completion line. Byte-progress lines carry neither `ok` nor
    // `success`, so they fall through both branches and are only forwarded to
    // onProgress. A per-file failure (`success:false`) is content git-annex
    // could not source from any remote -- recorded, not fatal (#1038).
    const recordLine = (parsed: GitAnnexProgressLine): void => {
      options.onProgress?.(parsed);
      if (parsed.ok === true || parsed.success === true) {
        filesDownloaded++;
      } else if (parsed.ok === false || parsed.success === false) {
        filesUnavailable++;
        const file = parsed.file ?? parsed.action?.file;
        if (file && unavailablePaths.length < MAX_UNAVAILABLE_SAMPLE) {
          unavailablePaths.push(file);
        }
        // Real `-J --json-progress` failure events carry the cause in `note`
        // ("from s3-PUBLIC...\nUnable to access these remotes: ...") alongside
        // an `error-messages` array; the scalar `error` is belt-and-braces.
        if (parsed.note) failureNotes.push(parsed.note);
        if (parsed["error-messages"]?.length) failureNotes.push(...parsed["error-messages"]);
        if (parsed.error) failureNotes.push(parsed.error);
      }
    };

    // Collect stderr in background
    const stderrPromise = (async () => {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrChunks.push(value);
      }
      stderrOutput = decoder.decode(
        stderrChunks.reduce((acc, chunk) => {
          const merged = new Uint8Array(acc.length + chunk.length);
          merged.set(acc);
          merged.set(chunk, acc.length);
          return merged;
        }, new Uint8Array()),
      );
    })();

    // Stream and parse stdout JSON lines
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep partial last line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("{")) continue;
        try {
          recordLine(JSON.parse(trimmed) as GitAnnexProgressLine);
        } catch {
          // Non-JSON lines are ignored
        }
      }
    }

    // Process any remaining buffer content
    if (buffer.trim().startsWith("{")) {
      try {
        recordLine(JSON.parse(buffer.trim()) as GitAnnexProgressLine);
      } catch {
        // Ignore partial lines
      }
    }

    await stderrPromise;
    const exitCode = await proc.exited;

    // A non-zero exit with no per-file failure lines is a whole-run error
    // (bad repo, unusable remote, git-annex itself failed) rather than
    // missing content -- keep those fatal and surface stderr.
    if (exitCode !== 0 && filesUnavailable === 0) {
      return {
        success: false,
        outcome: "failed",
        error: stderrOutput.trim() || "Failed to get dataset data",
        filesDownloaded,
        filesUnavailable,
        unavailablePaths,
      };
    }

    const failureText = `${stderrOutput}\n${failureNotes.join("\n")}`;
    const outcome = classifyGetOutcome({
      retrieved: filesDownloaded,
      unavailable: filesUnavailable,
      requireComplete: options.requireComplete,
      failureText,
    });
    return toGetDataResult(
      outcome,
      { filesDownloaded, filesUnavailable, unavailablePaths },
      stderrOutput,
    );
  } catch (e) {
    return {
      success: false,
      outcome: "failed",
      error: (e as Error).message,
      filesDownloaded: 0,
      filesUnavailable: 0,
      unavailablePaths: [],
    };
  }
}

/**
 * Drop local copies of annexed files (keeps remote copies intact).
 * Git-annex verifies remote copies exist before dropping.
 */
export async function dropFiles(
  datasetPath: string,
  paths?: string[],
): Promise<{ success: boolean; error?: string; dropped: number; kept: string[] }> {
  const targets = paths && paths.length > 0 ? paths : ["."];

  try {
    const args = ["git", "annex", "drop", ...targets];
    const { stdout, stderr, exitCode } = await runCommand(args, { cwd: datasetPath });

    if (exitCode !== 0) {
      // git-annex drop returns non-zero if some files couldn't be dropped
      // (e.g., no remote copies). Parse output for details.
      const kept: string[] = [];
      for (const line of stderr.split("\n")) {
        const match = line.match(/^drop (.+) \(unsafe\)/);
        if (match) kept.push(match[1]);
      }
      const dropMatches = stdout.match(/^drop .+ ok$/gm);
      const dropped = dropMatches ? dropMatches.length : 0;
      return { success: false, error: stderr.trim(), dropped, kept };
    }

    const dropMatches = stdout.match(/^drop .+ ok$/gm);
    const dropped = dropMatches ? dropMatches.length : 0;
    return { success: true, dropped, kept: [] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg || "Unknown error during drop", dropped: 0, kept: [] };
  }
}

/** Lines from git-annex copy output worth surfacing as the failure cause. */
const COPY_ERROR_RE =
  /fail|error|denied|forbidden|entitytoolarge|too large|multipart|exceed|timed?\s*out|not\s+enough|no\s+space|access\s+key/i;

/**
 * Extract a useful error message from a failed `git annex copy`.
 *
 * git-annex writes the real S3 failure (e.g. 400 EntityTooLarge on a >5 GB
 * single-part PUT) to STDOUT, not stderr, so surfacing only `stderr.trim()`
 * left users with the generic "Failed to copy to remote" and no diagnosable
 * cause (#886). Prefer stderr; otherwise pull the informative lines from stdout
 * (falling back to its tail), so the actual reason reaches the CLI.
 *
 * Exported for unit testing; not part of the CLI-facing surface.
 */
const MAX_COPY_ERROR_LINES = 20;

export function extractCopyError(stdout: string, stderr: string): string {
  const err = stderr.trim();
  if (err) return err;
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const relevant = lines.filter((l) => COPY_ERROR_RE.test(l));
  // Cap the output: `git annex copy -J . ` fails per-file, and COPY_ERROR_RE
  // matches generic words (fail/error), so a many-file failure could otherwise
  // surface hundreds of lines into the CLI. Keep the last N (the tail carries
  // git-annex's summary line), noting how many were dropped. Matches the bounded
  // subprocess-error convention in github.ts / import-openneuro.ts.
  let chosen: string[];
  if (relevant.length > MAX_COPY_ERROR_LINES) {
    const omitted = relevant.length - MAX_COPY_ERROR_LINES;
    chosen = [
      `...(${omitted} earlier error lines omitted)`,
      ...relevant.slice(-MAX_COPY_ERROR_LINES),
    ];
  } else if (relevant.length) {
    chosen = relevant;
  } else {
    chosen = lines.slice(-8);
  }
  const picked = chosen.join("\n").trim();
  return picked || "Failed to copy to remote";
}

/**
 * Copy annexed content to a remote.
 *
 * When credentials are provided, they are passed as env vars to the subprocess.
 * Otherwise inherits environment credentials (AWS_ACCESS_KEY_ID, etc.).
 */
export async function copyToAnnexRemote(
  datasetPath: string,
  remoteName: string,
  jobs = 4,
  credentials?: S3Credentials,
): Promise<{ success: boolean; error?: string; filesCopied: number }> {
  try {
    const args = ["git", "annex", "copy", "--to", remoteName, "-J", jobs.toString(), "."];

    const env = awsCredentialEnv(credentials);

    const { stdout, stderr, exitCode } = await runCommand(args, { cwd: datasetPath, env });

    if (exitCode !== 0) {
      return { success: false, error: extractCopyError(stdout, stderr), filesCopied: 0 };
    }

    const copyMatches = stdout.match(/^copy .+ ok$/gm);
    const filesCopied = copyMatches ? copyMatches.length : 0;
    return { success: true, filesCopied };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg || "Unknown error during copy", filesCopied: 0 };
  }
}

/** Drop orphan annex keys (no longer referenced by any branch). */
export async function dropUnusedAnnexObjects(
  datasetPath: string,
): Promise<{ success: boolean; error?: string; dropped?: number }> {
  // Without --prune-tags here, stale local tags would keep their content
  // 'reachable' and `git annex unused` would skip those keys.
  const { stderr: pruneStderr, exitCode: pruneCode } = await runCommand(
    ["git", "fetch", "--prune", "--prune-tags", "origin"],
    { cwd: datasetPath },
  );
  if (pruneCode !== 0) {
    return {
      success: false,
      error: pruneStderr.trim() || "git fetch --prune-tags failed",
    };
  }

  const { exitCode: unusedCode, stderr: unusedStderr } = await runCommand(
    ["git", "annex", "unused"],
    { cwd: datasetPath },
  );
  if (unusedCode !== 0) {
    return { success: false, error: unusedStderr.trim() || "git annex unused failed" };
  }

  const { stdout, stderr, exitCode } = await runCommand(
    ["git", "annex", "dropunused", "--force", "all"],
    { cwd: datasetPath },
  );
  if (exitCode !== 0) {
    return { success: false, error: stderr.trim() || "git annex dropunused failed" };
  }

  const dropMatches = stdout.match(/^dropunused .+ ok$/gm);
  return { success: true, dropped: dropMatches ? dropMatches.length : 0 };
}

// =============================================================================
// File Manifest Collection
// =============================================================================

/**
 * File info for upload manifest
 */
export interface DatasetFileInfo {
  path: string;
  size: number;
  type: "metadata" | "data";
  /** Working-tree mtime; drives upload-progress change detection (#884). */
  mtimeMs?: number;
}

/**
 * Collect file manifest for a dataset.
 *
 * "data" means git-annex will take it (S3); "metadata" means it stays in plain
 * git (GitHub). The split is decided by the shared policy in `policy.ts` -- the
 * same rule that renders `annex.largefiles` -- so the plan shown to the user and
 * the files actually uploaded cannot disagree.
 */
export async function collectFileManifest(datasetPath: string): Promise<{
  files: DatasetFileInfo[];
  totalSize: number;
  dataFiles: number;
  metadataFiles: number;
}> {
  const files: DatasetFileInfo[] = [];
  let totalSize = 0;
  let dataFiles = 0;
  let metadataFiles = 0;

  // Use find to get all files and symlinks (excluding .git, .nemar, and .gitattributes)
  // Git-annex replaces data files with symlinks to .git/annex/objects/
  const { stdout, exitCode } = await runCommand(
    [
      "find",
      ".",
      "(",
      "-type",
      "f",
      "-o",
      "-type",
      "l",
      ")",
      "-not",
      "-path",
      "./.git/*",
      "-not",
      "-path",
      "./.nemar/*",
      "-not",
      "-name",
      ".gitattributes",
    ],
    { cwd: datasetPath },
  );

  if (exitCode !== 0) {
    return { files, totalSize, dataFiles, metadataFiles };
  }

  const filePaths = stdout.trim().split("\n").filter(Boolean);

  for (const filePath of filePaths) {
    // Clean up path (remove leading ./)
    const relativePath = filePath.startsWith("./") ? filePath.slice(2) : filePath;
    const absolutePath = join(datasetPath, relativePath);

    try {
      const stats = statSync(absolutePath);
      const size = stats.size;
      totalSize += size;

      // "data" means exactly "git-annex will take this", so the caller's
      // addTargets are the files that genuinely end up in S3. This used to be a
      // second, looser rule (any extension in a local list, or >100 kB), and the
      // disagreement was the #1158 bug: a `_motion.tsv` counted as data here,
      // was handed to `git annex add`, and annex then routed it into plain git
      // because the largefiles expression excluded every `*.tsv`. Worse, a file
      // this rule calls metadata never reaches `git annex add` at all -- the
      // later `git add -A` in commitChanges does NOT honour annex.largefiles --
      // so the two rules have to be the same rule.
      const isDataFile = shouldAnnex(relativePath, size);
      const fileType: "metadata" | "data" = isDataFile ? "data" : "metadata";

      if (isDataFile) {
        dataFiles++;
      } else {
        metadataFiles++;
      }

      files.push({
        path: relativePath,
        size,
        type: fileType,
        mtimeMs: stats.mtimeMs,
      });
    } catch {
      // Skip files we can't stat
    }
  }

  return { files, totalSize, dataFiles, metadataFiles };
}

// =============================================================================
// S3-to-S3 copy helpers (OpenNeuro import)
// =============================================================================

/**
 * Get git-annex keys and their known URLs for files in the current tree.
 * Returns a Map of key -> source S3 URL (first HTTP/S3 URL found).
 */
/**
 * Parse one `git annex whereis --json` line and record its key -> first usable
 * (http/s3) source URL into `keyUrlMap`. Pure + exported so the streaming reader
 * and tests share the exact extraction. Malformed JSON is skipped silently.
 */
export function extractWhereisKeyUrl(line: string, keyUrlMap: Map<string, string>): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const entry = JSON.parse(trimmed);
    const key = entry.key;
    if (!key) return;
    // Collect URLs from all whereis entries (trusted + untrusted).
    const whereis = [...(entry.whereis || []), ...(entry.untrusted || [])];
    for (const remote of whereis) {
      if (!Array.isArray(remote.urls)) continue;
      for (const url of remote.urls) {
        if (typeof url === "string" && (url.startsWith("http") || url.startsWith("s3://"))) {
          keyUrlMap.set(key, url);
          break;
        }
      }
      if (keyUrlMap.has(key)) break;
    }
  } catch (err) {
    if (err instanceof SyntaxError) return;
    console.error(
      `Warning: failed to process whereis entry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function getAnnexWhereisAll(
  datasetPath: string,
): Promise<{ urlMap: Map<string, string>; fileCount: number }> {
  // STREAM the output, never buffering it whole. A large dataset (e.g. ds006110
  // = 66k annexed files) emits ~100MB+ of JSON; collecting that into one string
  // (the old runCommand path) spiked memory and got the 2-core import runner
  // OOM-killed mid-"Mapping annexed files" ("operation canceled"), file-count-
  // bound (#808). Reading line-by-line keeps only the compact key->URL map in
  // memory. "-- ." (not "--all") skips orphaned keys from old history (ds000117
  // had 718 such spurious failures).
  const proc = spawn({
    cmd: ["git", "annex", "whereis", "--json", "--", "."],
    cwd: datasetPath,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

  // Drain stderr CONCURRENTLY with stdout. git-annex can emit a stderr line per
  // file (offline remote, URL check) -- on a 66k-file dataset that exceeds the
  // ~64KB OS pipe buffer, and if we only read stderr AFTER the stdout loop the
  // child blocks writing stderr while we block reading stdout (deadlock). The
  // promise reads stderr in the background; we await it after the loop.
  const stderrPromise = new Response(proc.stderr).text();

  const keyUrlMap = new Map<string, string>();
  const decoder = new TextDecoder();
  let pending = "";
  let sawOutput = false;
  // One whereis --json line == one annexed file (with or without a usable URL).
  // fileCount counts them so the import can tell "no annexed data at all" from
  // "annexed data exists but none mapped to a copyable URL" (#828): the latter
  // must not publish an empty dataset.
  let fileCount = 0;
  for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    let nl = pending.indexOf("\n");
    while (nl !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line.trim()) {
        sawOutput = true;
        fileCount++;
        extractWhereisKeyUrl(line, keyUrlMap);
      }
      nl = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  if (pending.trim()) {
    sawOutput = true;
    fileCount++;
    extractWhereisKeyUrl(pending, keyUrlMap);
  }

  const stderr = (await stderrPromise).trim();
  const exitCode = await proc.exited;
  if (exitCode !== 0 && !sawOutput) {
    throw new Error(`git annex whereis failed: ${stderr}`);
  }
  if (exitCode !== 0) {
    // Only tolerate the expected "whereis: N failed" pattern (files with no
    // known location). Any other non-zero exit is an unexpected error.
    const failMatch = stderr.match(/whereis:\s*(\d+)\s*failed/);
    if (failMatch) {
      console.warn(
        `  Warning: ${failMatch[1]} files had no location info (continuing with available files)`,
      );
    } else {
      throw new Error(`git annex whereis failed (exit ${exitCode}): ${stderr}`);
    }
  }

  return { urlMap: keyUrlMap, fileCount };
}

/**
 * Get the hash directory path for a git-annex key.
 * Used to construct the S3 destination path.
 */
export async function getKeyHashDir(datasetPath: string, key: string): Promise<string> {
  const result = await runCommand(["git", "annex", "examinekey", "--format=${hashdirlower}", key], {
    cwd: datasetPath,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git annex examinekey failed for ${key}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/**
 * Batch get hash directories for multiple keys.
 * More efficient than calling getKeyHashDir one at a time.
 */
export async function getKeyHashDirs(
  datasetPath: string,
  keys: string[],
): Promise<Map<string, string>> {
  const hashDirMap = new Map<string, string>();
  // Limit concurrency to avoid overwhelming the system with subprocesses
  const batchSize = 50;
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (key) => {
        const hashDir = await getKeyHashDir(datasetPath, key);
        return { key, hashDir };
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        hashDirMap.set(r.value.key, r.value.hashDir);
      } else {
        console.error(`Warning: failed to resolve hash dir: ${r.reason?.message || "unknown"}`);
      }
    }
  }
  return hashDirMap;
}

/**
 * Get the UUID of a configured git-annex remote.
 */
export async function getRemoteUuid(
  datasetPath: string,
  remoteName: string,
): Promise<string | null> {
  const result = await runCommand(["git", "config", `remote.${remoteName}.annex-uuid`], {
    cwd: datasetPath,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * Mark a git-annex key as present in a remote.
 */
export async function setKeyPresent(
  datasetPath: string,
  key: string,
  remoteUuid: string,
): Promise<boolean> {
  const result = await runCommand(["git", "annex", "setpresentkey", key, remoteUuid, "1"], {
    cwd: datasetPath,
  });
  return result.exitCode === 0;
}

/**
 * Batch mark keys as present in a remote.
 * Returns count of successful and failed registrations.
 */
export async function batchSetKeysPresent(
  datasetPath: string,
  keys: string[],
  remoteUuid: string,
): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;
  // Process in parallel batches
  const batchSize = 50;
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map((key) => setKeyPresent(datasetPath, key, remoteUuid)),
    );
    for (const ok of results) {
      if (ok) success++;
      else failed++;
    }
  }
  return { success, failed };
}
