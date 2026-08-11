/**
 * git-annex service: repository init and largefiles configuration.
 *
 * Split from lib/git-annex.ts by concern (#908, epic #902); bodies moved
 * verbatim.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
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
  // Annex large data files, but NEVER annex metadata files regardless of size.
  // Metadata must stay in git for BIDS validation and GitHub readability.
  // Note: exclude=*.tsv does not match *.tsv.gz (glob is exact), so compressed
  // data is correctly annexed.
  // Keep in sync with: scripts/nemar-restore-dataset.sh ANNEX_LARGEFILES
  const DATA_EXTENSIONS = ["*.edf", "*.bdf", "*.set", "*.fif", "*.vhdr", "*.eeg", "*.cnt", "*.fdt"];
  const METADATA_EXCLUSIONS = [
    "*.tsv",
    "*.json",
    "*.md",
    "*.txt",
    "*.yml",
    "*.yaml",
    "README*",
    "LICENSE*",
    "CHANGES*",
    ".bidsignore",
    ".gitignore",
  ];

  const includes = DATA_EXTENSIONS.map((ext) => `include=${ext}`).join(" or ");
  const excludes = METADATA_EXCLUSIONS.map((pat) => `exclude=${pat}`).join(" and ");
  const defaultPattern = `(${includes} or largerthan=100kb) and ${excludes}`;

  const largefilesPattern = pattern || defaultPattern;

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
 */
export async function gitAnnexAdd(
  path: string,
  targets: string | string[] = ".",
): Promise<{ success: boolean; error?: string }> {
  const chunks = typeof targets === "string" ? [[targets]] : chunkAddTargets(targets);
  try {
    for (const chunk of chunks) {
      const { stderr, exitCode } = await runCommand(["git", "annex", "add", "--", ...chunk], {
        cwd: path,
      });
      if (exitCode !== 0) {
        return { success: false, error: stderr.trim() || "Failed to add files to git-annex" };
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}
