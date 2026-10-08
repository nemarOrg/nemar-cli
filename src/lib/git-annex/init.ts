/**
 * git-annex service: repository init and largefiles configuration.
 *
 * Split from lib/git-annex.ts by concern (#908, epic #902); bodies moved
 * verbatim, except that initDataset's `git init` gained a fallback for a git
 * without `-b` (#1645).
 */

import { existsSync } from "node:fs";
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
 * The exit status git uses for a usage error: a switch it does not know. A git
 * older than 2.28 (for example Ubuntu 20.04's 2.25) rejects `git init -b` this way.
 *
 * The fallback keys on the status and never on stderr: git localizes its
 * messages ("Unbekannter Schalter", "bascule inconnue"), so any text match
 * would miss the fallback on a non-English LANG. Apart from the path, which is
 * passed after `--`, the arguments are fixed, so 129 means git rejected `-b`;
 * fatal errors (a path that cannot be created) exit 128. A SIGHUP also reads as
 * 129, and the cost of that misreading is a redundant fallback attempt.
 */
const GIT_USAGE_ERROR_EXIT = 129;

/** What a failed git call said, or its exit status when it said nothing. */
function said(r: { stderr: string; exitCode: number }): string {
  return r.stderr.trim() || `exit ${r.exitCode}`;
}

type HeadState = { kind: "resolves" } | { kind: "unborn" } | { kind: "unreadable"; reason: string };

/**
 * Is HEAD of the repository at `path` resolvable, unborn, or neither?
 *
 * Unborn means HEAD names a branch whose ref does not exist yet, which is the
 * state of a fresh `git init`. A bare "does not resolve" is not enough: `git
 * rev-parse` also exits 1 quietly for a branch ref that exists but is corrupt,
 * and 128 for an unreadable repository. Re-pointing HEAD in either case would
 * strand whatever the old branch held and report success. Only exit statuses
 * are read here, never text, because git localizes its messages.
 */
async function readHeadState(path: string, env: Record<string, string>): Promise<HeadState> {
  const opts = { cwd: path, env };
  const resolved = await runCommand(["git", "rev-parse", "-q", "--verify", "HEAD"], opts);
  if (resolved.exitCode === 0) {
    return { kind: "resolves" };
  }
  if (resolved.exitCode !== 1) {
    return { kind: "unreadable", reason: `cannot read HEAD: ${said(resolved)}` };
  }
  // Exit 1: HEAD does not resolve. Find the branch it names...
  const target = await runCommand(["git", "symbolic-ref", "-q", "HEAD"], opts);
  const ref = target.stdout.trim();
  if (target.exitCode !== 0 || ref === "") {
    return {
      kind: "unreadable",
      reason: `HEAD does not resolve and its branch cannot be read: ${said(target)}`,
    };
  }
  // ...and confirm that ref is absent (exit 1) rather than present or broken.
  const exists = await runCommand(["git", "show-ref", "--verify", "-q", ref], opts);
  if (exists.exitCode === 1) {
    return { kind: "unborn" };
  }
  if (exists.exitCode === 0) {
    return { kind: "unreadable", reason: `HEAD does not resolve although ${ref} exists` };
  }
  return {
    kind: "unreadable",
    reason: `HEAD does not resolve and ${ref} cannot be checked: ${said(exists)}`,
  };
}

/**
 * `git init` with `main` as the branch of a new repository, on any git version.
 *
 * Tries `git init -b main` first. When git answers with a usage error (exit
 * 129, see GIT_USAGE_ERROR_EXIT) it falls back to a plain `git init` and names
 * the branch by pointing an unborn HEAD at `refs/heads/main`, which is what
 * `-b` does.
 *
 * An existing repository keeps its branch, as under a modern git, which ignores
 * `-b` there; the upload's later branch check deals with it. One measured
 * difference: an existing repository whose HEAD names an unborn branch (a
 * master with no commits) is named main at once, where a modern git commits on
 * that branch and the branch check then renames the adjusted branch to main,
 * leaving a stray master behind. The fallback's result, `adjusted/main(unlocked)`
 * with no stray branch, is the tidier of the two.
 */
async function initGitRepoOnMain(
  path: string,
  env: Record<string, string>,
): Promise<{ success: boolean; error?: string }> {
  const withBranch = await runCommand(["git", "init", "-b", "main", "--", path], { env });
  if (withBranch.exitCode === 0) {
    return { success: true };
  }
  if (withBranch.exitCode !== GIT_USAGE_ERROR_EXIT) {
    return {
      success: false,
      error:
        withBranch.stderr.trim() ||
        `Failed to initialize git repository (exit ${withBranch.exitCode})`,
    };
  }
  // From here on a failure came after the fallback began. Say so: callers print
  // the text under "Failed to initialize git-annex dataset", where a bare git
  // error such as "cannot lock ref 'HEAD'" reads like a git-annex problem.
  const fallback = `git init -b main was rejected (exit ${GIT_USAGE_ERROR_EXIT}); `;
  const plain = await runCommand(["git", "init", "--", path], { env });
  if (plain.exitCode !== 0) {
    return {
      success: false,
      error: `${fallback}plain git init failed: ${said(plain)}`,
    };
  }
  // `-b` only names the branch of a repository that is being created. Modern git
  // ignores it for an existing one ("re-init: ignored --initial-branch=main") and
  // HEAD stays where it was: `git annex adjust --unlock` builds
  // `adjusted/<branch>(unlocked)` on it, and the later branch check renames that
  // adjusted branch to main, carrying its history. Re-pointing a HEAD that
  // resolves would instead strand the history on the old branch and make main a
  // one-commit root. Only an unborn HEAD is ours to name, and a HEAD that cannot
  // be read is neither ours to rename nor safe to guess about.
  const state = await readHeadState(path, env);
  if (state.kind === "unreadable") {
    return { success: false, error: `${fallback}${state.reason}` };
  }
  if (state.kind === "resolves") {
    return { success: true };
  }
  const head = await runCommand(["git", "symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: path,
    env,
  });
  if (head.exitCode !== 0) {
    return {
      success: false,
      error: `${fallback}could not point HEAD at main: ${said(head)}`,
    };
  }
  return { success: true };
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

    // Create the repository on main; an existing repository keeps the branch it has
    const gitInit = await initGitRepoOnMain(path, env);
    if (!gitInit.success) {
      return gitInit;
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
 * `backend` passes `--backend`, which outranks an inherited `annex.backend`
 * attribute. The import's identifier scrub (ADR 0089) names `SHA256E` so the key
 * that replaces a scrubbed recording is one ADR 0085's tools can follow.
 */
export async function gitAnnexAdd(
  path: string,
  targets: string | string[] = ".",
  chunking: { maxPaths?: number; maxBytes?: number } = {},
  options: { forceLarge?: boolean; checkGitignore?: boolean; backend?: "SHA256E" } = {},
): Promise<{ success: boolean; error?: string }> {
  const chunks =
    typeof targets === "string"
      ? [[targets]]
      : chunkAddTargets(
          targets,
          chunking.maxPaths ?? ADD_CHUNK_MAX_PATHS,
          chunking.maxBytes ?? ADD_CHUNK_MAX_BYTES,
        );
  const addFlags = [
    ...(options.forceLarge ? ["--force-large"] : []),
    ...(options.checkGitignore === false ? ["--no-check-gitignore"] : []),
    ...(options.backend ? [`--backend=${options.backend}`] : []),
  ];
  try {
    for (const chunk of chunks) {
      const { stderr, exitCode } = await runCommand(
        ["git", "annex", "add", ...addFlags, "--", ...chunk],
        { cwd: path },
      );
      if (exitCode !== 0) {
        return { success: false, error: stderr.trim() || "Failed to add files to git-annex" };
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}
