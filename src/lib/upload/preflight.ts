/**
 * Upload pipeline: preflight steps (prerequisites, GitHub CLI auth, BIDS
 * validation).
 *
 * Moved verbatim from the upload action in commands/dataset.ts (#907,
 * epic #902); the only intentional changes are import paths, the
 * step-function wrappers (process.exit -> return FAIL; the command
 * sequencer owns exits), and printStepFailure at the gh-auth failure site.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { formatBytesCli } from "../../../shared/bytes.js";
import {
  checkDenoInstalled,
  formatValidationResult,
  validateBidsDataset,
} from "../bids-validator.js";
import { printStepFailure } from "../cli-output.js";
import type { Config } from "../config.js";
import { verifyGitHubAuth } from "../git-annex/github.js";
import { checkPrerequisites } from "../git-annex/prereq.js";
import { runCommand } from "../git-annex/run-command.js";
import { FAIL, type Step, ok } from "./types.js";

/**
 * Warn below 16 GiB of virtual address space: git-annex's runtime failed to
 * reserve its heap under an 8 GiB `ulimit -v` on an HPC login node (#884,
 * "Failed to track data files: Out of memory"), and the same command ran
 * fine unrestricted on a compute node.
 */
export const LOW_VMEM_WARN_BYTES = 16 * 1024 ** 3;

/**
 * Parse `ulimit -v` output. The shell reports 1024-byte blocks or the word
 * "unlimited"; returns bytes, "unlimited", or null when unparseable.
 */
export function parseUlimitVirtualMemory(output: string): number | "unlimited" | null {
  const trimmed = output.trim();
  if (trimmed === "unlimited") return "unlimited";
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed) * 1024;
}

/**
 * Read the current process's virtual-memory (address space) limit via the
 * shell builtin. Returns null when it cannot be determined (e.g. no `sh`);
 * the caller treats that as "nothing to warn about".
 */
export async function detectVirtualMemoryLimit(): Promise<number | "unlimited" | null> {
  try {
    const { stdout, exitCode } = await runCommand(["sh", "-c", "ulimit -v"]);
    if (exitCode !== 0) return null;
    return parseUlimitVirtualMemory(stdout);
  } catch {
    return null;
  }
}

/** Step 2: Check prerequisites (git-annex, GitHub SSH). */
export async function checkUploadPrerequisites(): Promise<Step> {
  const spinner = ora("Checking prerequisites...").start();
  const prereqs = await checkPrerequisites();

  if (!prereqs.allPassed) {
    spinner.fail("Prerequisites check failed");
    console.log();
    for (const error of prereqs.errors) {
      console.log(chalk.red(`  - ${error}`));
    }
    return FAIL;
  }

  spinner.succeed("Prerequisites check passed");
  console.log(chalk.dim(`  git-annex ${prereqs.gitAnnex.version}`));
  if (prereqs.githubSSH.username) {
    console.log(chalk.dim(`  GitHub: ${prereqs.githubSSH.username}`));
  }

  // Warn (never block) when the virtual-memory ulimit is low enough to
  // OOM-kill git-annex while it tracks large datasets (#884). Common on
  // HPC login nodes, which often cap address space per process.
  const vmemLimit = await detectVirtualMemoryLimit();
  if (typeof vmemLimit === "number" && vmemLimit < LOW_VMEM_WARN_BYTES) {
    console.log(
      chalk.yellow(`  Warning: virtual memory limit is ${formatBytesCli(vmemLimit)} (ulimit -v).`),
    );
    console.log(
      chalk.yellow(
        "  git-annex may be killed with out-of-memory errors while tracking data files.",
      ),
    );
    console.log(
      chalk.yellow(
        "  On HPC systems, run the upload from a compute node or raise the limit (ulimit -v unlimited).",
      ),
    );
  }
  console.log();
  return ok();
}

/** Step 2b: Verify gh CLI authentication (username mismatch warns, continues). */
export async function verifyGhCli(config: Config): Promise<Step> {
  const spinner = ora("Verifying GitHub CLI authentication...").start();
  const ghAuth = await verifyGitHubAuth(config.githubUsername);

  if (!ghAuth.authenticated) {
    printStepFailure(spinner, "GitHub CLI not authenticated", ghAuth.error);
    console.log();
    console.log("GitHub CLI is required for dataset uploads. Install and authenticate:");
    console.log(chalk.cyan("  brew install gh       # or visit https://cli.github.com/"));
    console.log(chalk.cyan("  gh auth login"));
    return FAIL;
  }

  if (config.githubUsername && !ghAuth.matches) {
    spinner.warn("GitHub CLI user mismatch");
    console.log(chalk.yellow(`  ${ghAuth.error}`));
    console.log();
    console.log(
      "Your gh CLI is authenticated as a different GitHub account than your NEMAR account.",
    );
    console.log("This may cause issues with repository access. To fix:");
    console.log(chalk.cyan(`  gh auth login    # Login as ${config.githubUsername}`));
    console.log();
    console.log(
      chalk.yellow(
        "WARNING: If upload fails with permission errors, this mismatch is the likely cause.",
      ),
    );
    console.log();
    // Continue with warning; don't block (user may have valid reason)
  } else {
    spinner.succeed(`GitHub CLI authenticated as ${ghAuth.username}`);
  }
  return ok();
}

/** Step 3: BIDS Validation (no-op when options.skipValidation). */
export async function validateBidsStep(
  absolutePath: string,
  options: { skipValidation?: boolean },
): Promise<Step> {
  if (!options.skipValidation) {
    const spinner = ora("Validating BIDS dataset...").start();

    // Check for dataset_description.json
    const descPath = resolve(absolutePath, "dataset_description.json");
    if (!existsSync(descPath)) {
      spinner.fail("Not a valid BIDS dataset");
      console.log(chalk.red("Missing required file: dataset_description.json"));
      return FAIL;
    }

    // Check Deno for validation
    const deno = await checkDenoInstalled();
    if (!deno.installed) {
      spinner.fail("Deno is required for BIDS validation");
      console.log();
      console.log(chalk.red("Error: Deno is not installed"));
      console.log();
      console.log("The BIDS validator requires Deno runtime to run.");
      console.log("Install Deno with one of these commands:");
      console.log();
      console.log(chalk.cyan("  # macOS/Linux (curl)"));
      console.log("  curl -fsSL https://deno.land/install.sh | sh");
      console.log();
      console.log(chalk.cyan("  # macOS (Homebrew)"));
      console.log("  brew install deno");
      console.log();
      console.log(chalk.cyan("  # Windows (PowerShell)"));
      console.log("  irm https://deno.land/install.ps1 | iex");
      console.log();
      console.log("Learn more: https://docs.deno.com/runtime/getting_started/installation/");
      console.log();
      console.log(
        chalk.dim("To skip validation (not recommended): nemar dataset upload --skip-validation"),
      );
      return FAIL;
    }
    try {
      const result = await validateBidsDataset(absolutePath, { prune: true });
      if (!result.valid) {
        spinner.fail("Dataset has validation errors");
        console.log();
        console.log(formatValidationResult(result));
        console.log();
        console.log(chalk.yellow("Fix the errors above before uploading."));
        console.log(chalk.dim("Or use --skip-validation to upload anyway (not recommended)."));
        return FAIL;
      }
      spinner.succeed(`Dataset is valid BIDS (${result.warningCount} warnings)`);
    } catch (error) {
      spinner.fail("Validation failed");
      console.log(chalk.red((error as Error).message));
      return FAIL;
    }
    console.log();
  }
  return ok();
}
