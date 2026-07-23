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
import {
  checkDenoInstalled,
  formatValidationResult,
  validateBidsDataset,
} from "../bids-validator.js";
import { printStepFailure } from "../cli-output.js";
import type { Config } from "../config.js";
import { verifyGitHubAuth } from "../git-annex/github.js";
import { checkPrerequisites } from "../git-annex/prereq.js";
import { FAIL, type Step, ok } from "./types.js";

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
