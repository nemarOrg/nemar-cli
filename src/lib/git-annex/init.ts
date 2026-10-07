/**
 * git-annex service: repository init and largefiles configuration.
 *
 * Split from lib/git-annex.ts by concern (#908, epic #902); bodies moved
 * verbatim.
 */

import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { buildLargefilesExpression } from "./policy.js";
import { runCommand } from "./run-command.js";

/**
 * Check if a directory is already a git-annex dataset
 */
export async function isGitAnnexDataset(path: string): Promise<boolean> {
  // Check for .git directory first
  if (!existsSync(join(path, ".git"))) {
    return false;
  }

  // Check if git-annex is initialized
  try {
    const { exitCode } = await runCommand(["git", "annex", "info"], { cwd: path });
    return exitCode === 0;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Log unexpected errors
    if (!errorMsg.includes("ENOENT") && !errorMsg.includes("not found")) {
      console.error(`Error checking if ${path} is a git-annex dataset:`, errorMsg);
    }

    return false;
  }
}

/**
 * Initialize a git-annex dataset
 *
 * If author info is provided, sets GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL
 * to ensure the initial commit is attributed to the correct NEMAR user.
 */
export async function initDataset(
  path: string,
  options: { force?: boolean; author?: { name: string; email: string } } = {},
): Promise<{ success: boolean; error?: string }> {
  // Check if already a dataset
  if (!options.force && (await isGitAnnexDataset(path))) {
    return { success: true }; // Already initialized
  }

  try {
    // Build environment with optional author override
    const env: Record<string, string> = {};
    if (options.author) {
      env.GIT_AUTHOR_NAME = options.author.name;
      env.GIT_AUTHOR_EMAIL = options.author.email;
      env.GIT_COMMITTER_NAME = options.author.name;
      env.GIT_COMMITTER_EMAIL = options.author.email;
    }

    // Initialize git repository with explicit "main" branch name
    const { stderr: gitStderr, exitCode: gitExitCode } = await runCommand(
      ["git", "init", "-b", "main", path],
      {
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
    );

    if (gitExitCode !== 0) {
      return { success: false, error: gitStderr.trim() || "Failed to initialize git repository" };
    }

    // Initialize git-annex
    const envOpts = Object.keys(env).length > 0 ? { env } : {};
    const { stderr: initStderr, exitCode: initExitCode } = await runCommand(
      ["git", "annex", "init"],
      {
        cwd: path,
        ...envOpts,
      },
    );

    if (initExitCode !== 0) {
      return { success: false, error: initStderr.trim() || "Failed to initialize git-annex" };
    }

    // Create initial commit so git-annex adjust and branch detection work.
    // git-annex adjust --unlock requires at least one commit on the working branch,
    // and git rev-parse --abbrev-ref HEAD fails with no commits.
    const { stderr: commitStderr, exitCode: commitExitCode } = await runCommand(
      ["git", "commit", "--allow-empty", "-m", "Initialize dataset"],
      {
        cwd: path,
        ...envOpts,
      },
    );

    if (commitExitCode !== 0) {
      return { success: false, error: commitStderr.trim() || "Failed to create initial commit" };
    }

    // Use unlocked mode so data files remain as regular files (not symlinks)
    const { stderr: adjustStderr, exitCode: adjustExitCode } = await runCommand(
      ["git", "annex", "adjust", "--unlock"],
      {
        cwd: path,
        ...envOpts,
      },
    );

    if (adjustExitCode !== 0) {
      return {
        success: false,
        error: adjustStderr.trim() || "Failed to switch to unlocked mode",
      };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Ensure git-annex is initialized in the dataset
 * Safe to call multiple times - will not fail if already initialized
 */
export async function ensureGitAnnexInitialized(
  path: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Check if git-annex is initialized by trying to run a git-annex command
    const { exitCode: infoExitCode, stderr: infoStderr } = await runCommand(
      ["git", "annex", "info"],
      { cwd: path },
    );

    // If info works, git-annex is already initialized
    if (infoExitCode === 0) {
      return { success: true };
    }

    // If info fails with "First run" error, need to initialize
    if (infoStderr.includes("First run: git-annex init")) {
      const { stderr: initStderr, exitCode: initExitCode } = await runCommand(
        ["git", "annex", "init"],
        { cwd: path },
      );

      if (initExitCode !== 0) {
        return { success: false, error: initStderr.trim() || "Failed to initialize git-annex" };
      }

      return { success: true };
    }

    // Some other error
    return { success: false, error: infoStderr.trim() || "Failed to check git-annex status" };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Configure largefiles pattern for git-annex
 * Must be called BEFORE adding files to the dataset
 */
export async function configureLargefiles(
  path: string,
  pattern?: string,
): Promise<{ success: boolean; error?: string }> {
  // The policy itself lives in policy.ts -- one spelling, shared with the upload
  // manifest classifier and enforced against real git-annex by
  // test/annex-policy.test.ts.
  // Keep in sync with: scripts/nemar-restore-dataset.sh ANNEX_LARGEFILES
  // (test/annex-policy.test.ts asserts the shell copy matches this one).
  const largefilesPattern = pattern || buildLargefilesExpression();

  try {
    const { stderr, exitCode } = await runCommand(
      ["git", "annex", "config", "--set", "annex.largefiles", largefilesPattern],
      { cwd: path },
    );

    if (exitCode !== 0) {
      return { success: false, error: stderr.trim() || "Failed to configure largefiles" };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/** Default chunk bounds for targeted gitAnnexAdd (exported for unit tests). */
export const ADD_CHUNK_MAX_PATHS = 500;
export const ADD_CHUNK_MAX_BYTES = 128 * 1024;

/**
 * Split a path list into argv-safe chunks for `git annex add -- <paths...>`.
 *
 * Multi-TB BIDS datasets can carry thousands of data files; a single argv
 * would blow past the OS argument-length limit (256 KB on macOS). Chunks are
 * bounded both by path count and by total byte length (with a per-path +1
 * for the argv NUL separator). A single path longer than maxBytes still
 * forms its own chunk -- paths cannot be split.
 */
export function chunkAddTargets(
  paths: string[],
  maxPaths = ADD_CHUNK_MAX_PATHS,
  maxBytes = ADD_CHUNK_MAX_BYTES,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const path of paths) {
    const size = Buffer.byteLength(path, "utf8") + 1;
    if (current.length > 0 && (current.length >= maxPaths || currentBytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(path);
    currentBytes += size;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * Stage files with git-annex. Data files matching the largefiles pattern
 * are added to the annex; other files are added to git normally.
 *
 * `targets` is either a single pathspec (default "." = whole tree) or a
 * list of relative paths. A list is added in argv-safe chunks so multi-TB
 * datasets with thousands of files never exceed the OS arg limit, and each
 * completed chunk persists its annexed state (index + inode cache), so an
 * interrupted add resumes at O(remaining files) instead of restarting
 * (#884). An empty list is a successful no-op.
 *
 * `chunking` overrides the argv chunk bounds; production callers use the
 * defaults. Exposed so tests can drive the multi-chunk loop through this
 * entry point without thousands of fixture files.
 *
 * `forceLarge` passes `--force-large`, which annexes every named path whatever
 * any configuration says. It exists for the import path (#1159), where the
 * clone carries UPSTREAM's `annex.largefiles` -- and an inherited
 * `.gitattributes` setting beats both `git annex config` and git config, so
 * neither `configureLargefiles` nor a `-c annex.largefiles=anything` override
 * would move the file (verified against git-annex 10.20260901, ADR 0060).
 * Only ever pass paths the policy in `policy.ts` already called data. Note that
 * it decides which plane a CONSIDERED file goes to, not whether the file is
 * considered: an unmodified tracked file is skipped either way.
 *
 * `checkGitignore: false` passes `--no-check-gitignore`, for paths that are
 * already tracked (gitignore never applied to them) but are momentarily
 * untracked because the caller uncached them to make the add look again.
 * Without it such a path is skipped silently and ends up in neither plane.
 *
 * `jobs` is the number of local hashing workers, passed explicitly as `-J`
 * (default 4, clamped to 1..32) so a machine-wide `annex.jobs` never decides
 * it (#1455). A path list is fed through `--batch -z` on stdin rather than
 * argv: on network filesystems the argv form stalled in filter-process while
 * the batch form completed the same manifest (#1455 evidence on NFS and on
 * Ceph), and stdin has no argument-length limit. Chunks are kept so each one
 * still persists its annexed state before the next starts.
 */
export async function gitAnnexAdd(
  path: string,
  targets: string | string[] = ".",
  chunking: { maxPaths?: number; maxBytes?: number } = {},
  options: { forceLarge?: boolean; checkGitignore?: boolean; jobs?: number } = {},
): Promise<{ success: boolean; error?: string }> {
  const jobs = normalizeAddJobs(options.jobs);
  const addFlags = [
    ...(options.forceLarge ? ["--force-large"] : []),
    ...(options.checkGitignore === false ? ["--no-check-gitignore"] : []),
    `-J${jobs}`,
  ];
  try {
    if (typeof targets === "string") {
      const { stderr, exitCode } = await runCommand(
        ["git", "annex", "add", ...addFlags, "--", targets],
        { cwd: path },
      );
      if (exitCode !== 0) {
        return { success: false, error: stderr.trim() || "Failed to add files to git-annex" };
      }
      return { success: true };
    }

    const chunks = chunkAddTargets(
      targets,
      chunking.maxPaths ?? ADD_CHUNK_MAX_PATHS,
      chunking.maxBytes ?? ADD_CHUNK_MAX_BYTES,
    );
    for (const chunk of chunks) {
      // A named path that does not exist would be skipped by --batch without
      // a word (one empty output line); fail this chunk instead, as the argv
      // form did. Checked per chunk so earlier chunks still persist.
      const missing = chunk.filter((t) => !pathExists(join(path, t)));
      if (missing.length > 0) {
        const shown = missing.slice(0, 5).join(", ");
        const more = missing.length > 5 ? ` and ${missing.length - 5} more` : "";
        return { success: false, error: `File(s) to add not found: ${shown}${more}` };
      }
      const { stdout, stderr, exitCode } = await runCommand(
        ["git", "annex", "add", ...addFlags, "--batch", "-z", "--json", "--json-error-messages"],
        { cwd: path, stdin: chunk.map((p) => `${p}\0`).join("") },
      );
      const failed = parseAddFailures(stdout);
      if (exitCode !== 0 || failed.length > 0) {
        const detail = failed
          .slice(0, 5)
          .map((f) => `${f.file}: ${f.error}`)
          .join("; ");
        return {
          success: false,
          error: detail || stderr.trim() || "Failed to add files to git-annex",
        };
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/** lstat-based existence: a dangling annex symlink still counts as present. */
function pathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Local git-annex add workers when the caller names none (#1455). */
export const ADD_DEFAULT_JOBS = 4;
/** Upper bound for the local add workers: hashing is disk-bound, not CPU-bound. */
export const ADD_MAX_JOBS = 32;

/**
 * Clamp a requested add-worker count to 1..ADD_MAX_JOBS, defaulting to
 * ADD_DEFAULT_JOBS. Always explicit, so a machine-wide `annex.jobs` (or
 * `annex.jobs=cpus` on a 100-core node) never decides how many hashers hit a
 * network filesystem at once. Exported for unit tests.
 */
export function normalizeAddJobs(jobs: number | undefined): number {
  if (jobs === undefined || !Number.isFinite(jobs)) return ADD_DEFAULT_JOBS;
  return Math.min(ADD_MAX_JOBS, Math.max(1, Math.trunc(jobs)));
}

/**
 * Failed records from `git annex add --batch --json --json-error-messages`.
 * Empty lines (paths add had nothing to do for, e.g. already annexed and
 * unchanged) and non-JSON lines are ignored. Exported for unit tests.
 */
export function parseAddFailures(stdout: string): Array<{ file: string; error: string }> {
  const failures: Array<{ file: string; error: string }> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.success !== false) continue;
    const messages = Array.isArray(rec["error-messages"])
      ? (rec["error-messages"] as unknown[]).filter((m): m is string => typeof m === "string")
      : [];
    failures.push({
      file: typeof rec.file === "string" ? rec.file : "(unknown file)",
      error: messages.join("; ").trim() || "failed",
    });
  }
  return failures;
}
