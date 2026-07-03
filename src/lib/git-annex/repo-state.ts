/**
 * git-annex service: repository state queries (branches, versions, upstream,
 * working tree).
 *
 * Split from lib/git-annex.ts by concern (#908, epic #902); bodies moved
 * verbatim.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { runCommand } from "./run-command.js";

/**
 * Get dataset file statistics
 */
export async function getDatasetStats(path: string): Promise<{
  totalFiles: number;
  totalSize: number;
  annexedFiles: number;
  annexedSize: number;
}> {
  try {
    // Use git annex info for statistics
    const { stdout, exitCode } = await runCommand(["git", "annex", "info", "--json"], {
      cwd: path,
    });

    if (exitCode === 0) {
      const info = JSON.parse(stdout);
      return {
        totalFiles: info["local annex keys"] || 0,
        totalSize: info["local annex size"] || 0,
        annexedFiles: info["local annex keys"] || 0,
        annexedSize: info["local annex size"] || 0,
      };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Log the error before falling back
    console.warn("git annex info failed, falling back to manual counting:", errorMsg);
  }

  // Fallback: count files manually
  const { stdout: findOutput } = await runCommand(["find", path, "-type", "f"], { cwd: path });
  const files = findOutput.trim().split("\n").filter(Boolean);

  return {
    totalFiles: files.length,
    totalSize: 0,
    annexedFiles: 0,
    annexedSize: 0,
  };
}

/**
 * Check whether the local clone has the NEMAR metadata commit that
 * `import-openneuro` emits as its final step before pushing
 * (`Add NEMAR metadata (imported from OpenNeuro ds######)`).
 *
 * Used to detect "porting still in progress" on `nemar dataset get` /
 * `download` against OpenNeuro-sourced datasets: if a user pulls before
 * that commit lands (because the matrix import workflow is still running),
 * the git-annex S3 objects may also not be fully copied. Emitting a clear
 * warning is more useful than letting `git annex get` fail with the
 * "remote not available" / "no known location" gibberish.
 *
 * Returns:
 *   - `present` when the most recent commit touching `.nemar/metadata.json`
 *     is found in local history (non-empty `git log -1` output)
 *   - `absent` when the file has never been committed (porting incomplete
 *     or this isn't an OpenNeuro-imported dataset)
 *   - `unknown` when git fails to run (not a repo, etc.)
 *
 * Forward-compatibility note: this marker is specific to the convention used
 * by `import-openneuro.ts` (committing `.nemar/metadata.json` as the final
 * import step). Any future mechanism that sets `source="openneuro"` in D1
 * without following this commit convention will produce a false `absent`
 * result. If that happens, add a `--skip-port-check` bypass or adjust the
 * detection logic.
 *
 * See nemarOrg/nemar-cli#460 for the user-reported failure mode.
 */
export async function detectImportMarker(
  datasetPath: string,
): Promise<"present" | "absent" | "unknown"> {
  try {
    // `git log -1 -- <pathspec>` returns the most recent commit that touched
    // `.nemar/metadata.json`. Non-empty output means the file exists in
    // history (import completed). An empty result means the file has never
    // been committed (porting did not finish). `git log` exits 0 in both
    // cases, so check stdout length rather than exit code.
    const { stdout, exitCode } = await runCommand(
      ["git", "log", "-1", "--format=%H", "--", ".nemar/metadata.json"],
      { cwd: datasetPath },
    );
    if (exitCode !== 0) return "unknown";
    return stdout.trim().length > 0 ? "present" : "absent";
  } catch {
    return "unknown";
  }
}

/**
 * Local dataset info returned by getLocalDatasetInfo
 */
export interface LocalDatasetInfo {
  files: number;
  size: string;
  sizeBytes: number;
  annexedFiles: number;
  presentFiles: number;
  missingFiles: number;
}

/**
 * Get information about a locally cloned dataset
 */
export async function getLocalDatasetInfo(datasetPath: string): Promise<LocalDatasetInfo | null> {
  if (!existsSync(datasetPath)) {
    return null;
  }

  try {
    const { stdout, exitCode } = await runCommand(["git", "annex", "info", "--json"], {
      cwd: datasetPath,
    });

    if (exitCode === 0) {
      const info = JSON.parse(stdout);

      // Parse size string like "1.5 GB" to bytes
      let sizeBytes = 0;
      const sizeStr = info["local annex size"] || "0 bytes";
      const sizeMatch = sizeStr.match(/([\d.]+)\s*(bytes?|KB|MB|GB|TB)/i);
      if (sizeMatch) {
        const num = Number.parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2].toLowerCase();
        const multipliers: Record<string, number> = {
          byte: 1,
          bytes: 1,
          kb: 1024,
          mb: 1024 * 1024,
          gb: 1024 * 1024 * 1024,
          tb: 1024 * 1024 * 1024 * 1024,
        };
        sizeBytes = num * (multipliers[unit] || 1);
      }

      const annexedFiles = info["annexed files in working tree"] || 0;
      const presentFiles = info["local annex keys"] || 0;

      return {
        files: annexedFiles,
        size: sizeStr,
        sizeBytes,
        annexedFiles,
        presentFiles,
        missingFiles: annexedFiles - presentFiles,
      };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to get git-annex info for ${datasetPath}: ${errorMsg}`);
  }

  // Fallback: just count files
  try {
    const { stdout } = await runCommand(["find", ".", "-type", "f", "-not", "-path", "./.git/*"], {
      cwd: datasetPath,
    });
    const files = stdout.trim().split("\n").filter(Boolean).length;
    return {
      files,
      size: "unknown",
      sizeBytes: 0,
      annexedFiles: 0,
      presentFiles: files,
      missingFiles: 0,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to count files in ${datasetPath}: ${errorMsg}`);
    return null;
  }
}

// =============================================================================
// Revert Functions (Admin Only)
// =============================================================================

/**
 * List available versions (tags) for a dataset
 */
export async function listDatasetVersions(
  datasetPath: string,
): Promise<{ version: string; date: string; commit: string }[]> {
  try {
    const { stdout, exitCode } = await runCommand(
      [
        "git",
        "tag",
        "-l",
        "--sort=-version:refname",
        "--format=%(refname:short)|%(creatordate:short)|%(objectname:short)",
      ],
      { cwd: datasetPath },
    );

    if (exitCode !== 0 || !stdout.trim()) {
      return [];
    }

    return stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [version, date, commit] = line.split("|");
        return { version, date, commit };
      });
  } catch {
    return [];
  }
}

/**
 * Get the commit hash for a version tag
 */
export async function getVersionCommit(
  datasetPath: string,
  version: string,
): Promise<string | null> {
  try {
    const tag = version.startsWith("v") ? version : `v${version}`;
    const { stdout, exitCode } = await runCommand(["git", "rev-parse", tag], { cwd: datasetPath });

    if (exitCode !== 0) {
      return null;
    }

    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Get current branch name
 */
export async function getCurrentBranch(datasetPath: string): Promise<string | null> {
  try {
    const { stdout, exitCode } = await runCommand(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: datasetPath,
    });

    if (exitCode !== 0) {
      return null;
    }

    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Ensure the local branch is named "main". NEMAR requires "main" as the default branch
 * for CI, branch protection, and metadata pipelines to work.
 *
 * If the branch is not "main", warns the user and offers to rename it.
 * Respects --yes flag for non-interactive mode (auto-renames).
 *
 * @returns true if branch is (now) "main", false if user declined or rename failed
 */
export async function ensureLocalMainBranch(
  datasetPath: string,
  options: { yes?: boolean } = {},
): Promise<boolean> {
  const currentBranch = await getCurrentBranch(datasetPath);

  if (!currentBranch) {
    console.log(chalk.yellow("\n  Warning: Could not determine current branch name."));
    console.log(chalk.yellow("  Proceeding with upload; ensure your branch is named 'main'."));
    return true;
  }

  // Accept "main" or git-annex adjusted branches that track main (e.g. "adjusted/main(unlocked)").
  // Adjusted branches are working copies that track "main" under the hood; renaming them would break git-annex.
  if (currentBranch === "main" || currentBranch.startsWith("adjusted/main")) {
    return true;
  }

  console.log(
    chalk.yellow(
      `\n  Warning: Your current branch is "${currentBranch}", but NEMAR requires "main".`,
    ),
  );
  console.log(
    chalk.yellow(
      "  Without renaming, CI validation, branch protection, and metadata pipelines will not work.",
    ),
  );

  if (!options.yes) {
    const shouldRename = await promptForRename(currentBranch);
    if (!shouldRename) {
      return false;
    }
  }

  const { exitCode, stderr } = await runCommand(["git", "branch", "-m", currentBranch, "main"], {
    cwd: datasetPath,
  });
  if (exitCode !== 0) {
    console.log(chalk.red(`  Failed to rename branch "${currentBranch}" to "main".`));
    if (stderr.trim()) {
      console.log(chalk.red(`  Git error: ${stderr.trim()}`));
    }
    return false;
  }
  console.log(chalk.green(`  Renamed branch "${currentBranch}" to "main".`));
  return true;
}

async function promptForRename(currentBranch: string): Promise<boolean> {
  const inquirer = (await import("inquirer")).default;
  try {
    const { rename } = await inquirer.prompt([
      {
        type: "confirm",
        name: "rename",
        message: `Rename branch "${currentBranch}" to "main"?`,
        default: true,
      },
    ]);

    if (!rename) {
      console.log(chalk.red("  Upload cancelled. Rename your branch to main before uploading:"));
      console.log(chalk.dim(`    git branch -m '${currentBranch}' main`));
    }
    return rename;
  } catch (error) {
    console.log(
      chalk.red(`  Failed to prompt: ${error instanceof Error ? error.message : String(error)}`),
    );
    console.log(chalk.dim(`    You can manually rename: git branch -m '${currentBranch}' main`));
    return false;
  }
}

/**
 * Detect the dataset ID from the git remote URL of the current directory.
 * Parses the origin remote URL to extract the repository name (e.g., nm000104).
 */
export async function getDatasetIdFromRemote(datasetPath: string): Promise<string | null> {
  try {
    const { stdout, exitCode } = await runCommand(["git", "remote", "get-url", "origin"], {
      cwd: datasetPath,
    });

    if (exitCode !== 0 || !stdout.trim()) return null;

    const url = stdout.trim();
    // Match patterns: https://github.com/org/repo.git, git@github.com:org/repo.git
    const match = url.match(/[/:]([^/]+?)(?:\.git)?$/);
    if (!match) return null;

    return match[1];
  } catch {
    return null;
  }
}

/**
 * Distinguishes "no DatasetVersion field" (version=null, no error) from
 * "file unreadable / malformed JSON" (version=null with error message).
 */
export interface DatasetVersionRead {
  version: string | null;
  error?: string;
}

export function readLocalDatasetVersion(datasetPath: string): DatasetVersionRead {
  const descPath = join(datasetPath, "dataset_description.json");
  if (!existsSync(descPath)) return { version: null };
  try {
    const desc = JSON.parse(readFileSync(descPath, "utf-8")) as { DatasetVersion?: unknown };
    return {
      version: typeof desc.DatasetVersion === "string" ? desc.DatasetVersion : null,
    };
  } catch (err) {
    return {
      version: null,
      error: `dataset_description.json is unreadable: ${(err as Error).message}`,
    };
  }
}

/** Requires `git fetch` to have populated the remote ref. */
export async function readRemoteHeadDatasetVersion(
  datasetPath: string,
): Promise<{ version: string | null; warnings: string[] }> {
  const warnings: string[] = [];
  for (const ref of ["origin/HEAD", "origin/main", "origin/master"]) {
    const { stdout, stderr, exitCode } = await runCommand(
      ["git", "show", `${ref}:dataset_description.json`],
      { cwd: datasetPath },
    );
    if (exitCode !== 0) {
      // "ref does not exist" is expected for the fallback chain; only
      // report git failures that look like real problems.
      if (stderr && !/unknown revision|bad revision|does not exist/i.test(stderr)) {
        warnings.push(`git show ${ref} failed: ${stderr.trim()}`);
      }
      continue;
    }
    if (!stdout.trim()) continue;
    try {
      const desc = JSON.parse(stdout) as { DatasetVersion?: unknown };
      if (typeof desc.DatasetVersion === "string") {
        return { version: desc.DatasetVersion, warnings };
      }
    } catch (err) {
      warnings.push(`${ref}:dataset_description.json is malformed: ${(err as Error).message}`);
    }
  }
  return { version: null, warnings };
}

/**
 * Resolve the remote ref a `git merge --ff-only` should target. Prefers the
 * configured upstream of the current branch; falls back to origin/HEAD,
 * origin/main, then origin/master for older datasets that pre-date the main
 * default-branch convention.
 */
export async function resolveUpstreamRef(
  datasetPath: string,
): Promise<{ ref: string | null; error?: string }> {
  // Fast path: the current branch's configured upstream tracking ref.
  const { stdout: upstream, exitCode: upCode } = await runCommand(
    ["git", "rev-parse", "--abbrev-ref", "@{upstream}"],
    { cwd: datasetPath },
  );
  if (upCode === 0 && upstream.trim()) {
    return { ref: upstream.trim() };
  }

  // Fallback: probe common remote-default refs in order.
  for (const ref of ["origin/HEAD", "origin/main", "origin/master"]) {
    const { exitCode } = await runCommand(["git", "rev-parse", "--verify", "--quiet", ref], {
      cwd: datasetPath,
    });
    if (exitCode === 0) return { ref };
  }

  return {
    ref: null,
    error:
      "Could not resolve a remote tracking branch (origin/HEAD, origin/main, origin/master all missing)",
  };
}

export async function isWorkingTreeDirty(
  datasetPath: string,
): Promise<{ dirty: boolean; error?: string }> {
  const { stdout, stderr, exitCode } = await runCommand(["git", "status", "--porcelain"], {
    cwd: datasetPath,
  });
  if (exitCode !== 0) {
    return { dirty: false, error: stderr.trim() || "git status failed" };
  }
  return { dirty: stdout.trim().length > 0 };
}

export async function gitFetchOrigin(
  datasetPath: string,
): Promise<{ success: boolean; error?: string }> {
  const { stderr, exitCode } = await runCommand(["git", "fetch", "--tags", "origin"], {
    cwd: datasetPath,
  });
  if (exitCode !== 0) {
    return { success: false, error: stderr.trim() || "git fetch failed" };
  }
  return { success: true };
}

export async function gitMergeFastForward(
  datasetPath: string,
  ref: string,
): Promise<{ success: boolean; error?: string }> {
  const { stderr, exitCode } = await runCommand(["git", "merge", "--ff-only", ref], {
    cwd: datasetPath,
  });
  if (exitCode !== 0) {
    return { success: false, error: stderr.trim() || `Cannot fast-forward to ${ref}` };
  }
  return { success: true };
}

/**
 * Switch to a branch
 */
export async function switchBranch(
  datasetPath: string,
  branchName: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { stderr, exitCode } = await runCommand(["git", "checkout", branchName], {
      cwd: datasetPath,
    });

    if (exitCode !== 0) {
      return { success: false, error: stderr.trim() || "Failed to switch branch" };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}
