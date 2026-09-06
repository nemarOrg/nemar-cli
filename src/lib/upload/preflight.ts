/**
 * Upload pipeline: preflight steps (upload access, prerequisites, GitHub CLI
 * auth, BIDS validation).
 *
 * Moved verbatim from the upload action in commands/dataset.ts (#907,
 * epic #902); the only intentional changes are import paths, the
 * step-function wrappers (process.exit -> return FAIL; the command
 * sequencer owns exits), and printStepFailure at the gh-auth failure site.
 *
 * `checkUploadAccessStep` is the one that was not moved from anywhere: it is
 * new in #1268 (ADR 0045) and runs FIRST, because an account without the
 * upload grant cannot finish this command however good the dataset is.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { formatBytesCli } from "../../../shared/bytes.js";
import { accountCopy, fillCopy } from "../../../shared/contract/account-copy.js";
import { resolveWireProfileGaps } from "../../../shared/contract/profile-gaps.js";
import { printGapList } from "../account-gaps.js";
import { getCurrentUser } from "../api/auth.js";
import { errorDetail } from "../api/errors.js";
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

/**
 * Step 1d: is this account allowed to upload at all, and if not, what is in the
 * way (#1268, ADR 0045)?
 *
 * WHY IT RUNS FIRST, before prerequisites and before validation. Uploading
 * needs a one-time admin grant (ADR 0040), and an account that does not hold it
 * cannot finish this command no matter how good the dataset is. Discovering
 * that after a ten-minute BIDS validation is how someone concludes NEMAR is
 * broken; discovering it in the first second, next to the exact commands that
 * unblock it, is the same fact delivered usefully.
 *
 * WHAT IT PRINTS is the backend's own `profile_gaps`, rendered through the
 * shared sentences — the same list, in the same words, that the website's
 * Settings card and `nemar auth request-upload-access` show. The CLI does not
 * decide which fields are missing; asking is what a request costs, and the
 * answer comes from the one function that also refuses the request.
 *
 * THREE OUTCOMES, and the middle one is the reason this is not simply a gate:
 *   granted        nothing is printed; the upload proceeds.
 *   not granted    a hard stop, unless `--dry-run` (which uploads nothing, so
 *                  refusing a preview would withhold the plan a user is trying
 *                  to read).
 *   not readable   offline, a 5xx, or a backend that predates the field. It
 *                  WARNS and continues: this check is a courtesy in front of a
 *                  gate the server enforces regardless, and failing an upload
 *                  because a status endpoint was briefly unavailable would
 *                  invent a refusal the backend never made.
 */
export async function checkUploadAccessStep(options: { dryRun?: boolean } = {}): Promise<Step> {
  const spinner = ora("Checking upload access...").start();

  let user: Awaited<ReturnType<typeof getCurrentUser>>;
  try {
    user = await getCurrentUser();
  } catch (error) {
    spinner.warn(
      fillCopy(accountCopy("cli.upload.preflight.unchecked"), { reason: errorDetail(error) }),
    );
    console.log();
    return ok();
  }

  if (user.service_access === true) {
    spinner.succeed("Upload access granted");
    console.log();
    return ok();
  }
  if (user.service_access === undefined) {
    // Absent is not "no" (ADR 0040): telling someone who holds the grant that
    // they do not is the one answer worth avoiding at any cost.
    spinner.warn(
      fillCopy(accountCopy("cli.upload.preflight.unchecked"), {
        reason: "this backend does not report it",
      }),
    );
    console.log();
    return ok();
  }

  spinner.warn(accountCopy("cli.upload.preflight.title"));
  console.log();
  console.log(`  ${accountCopy("cli.upload.preflight.body")}`);

  if (user.profile_gaps === undefined) {
    // Absent is not empty, the same three-state honesty `service_access` gets
    // above: a backend that predates #1268 sends no list, and silence under a
    // refusal reads as "nothing is missing". Say which it is, and where the
    // list can still be had.
    console.log();
    console.log(`  ${chalk.dim(accountCopy("cli.upload.preflight.gaps_unknown"))}`);
  } else {
    // Only the gaps that stop the REQUEST. A gap that blocks publication and
    // nothing else is real, and is not what this page is about; listing it here
    // would make the shortest path to an upload look longer than it is.
    const blocking = resolveWireProfileGaps(user.profile_gaps, {
      orcidVerified: user.orcid_verified === true,
    }).filter((gap) => gap.blocks.includes("upload_access"));
    if (blocking.length > 0) {
      printGapList(accountCopy("gaps.upload.title"), blocking);
    }
  }
  console.log();
  console.log(`  ${chalk.cyan(accountCopy("cli.upload_access.cta"))}`);

  if (options.dryRun) {
    console.log(`  ${chalk.dim(accountCopy("cli.upload.preflight.dry_run"))}`);
    console.log();
    return ok();
  }
  console.log();
  return FAIL;
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
