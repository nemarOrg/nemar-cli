/**
 * Dataset management commands for NEMAR CLI
 *
 * Commands:
 * - nemar dataset validate        - Validate BIDS dataset locally
 * - nemar dataset upload          - Upload dataset to NEMAR
 * - nemar dataset download        - Download dataset from NEMAR
 * - nemar dataset status          - Check dataset status
 * - nemar dataset list            - List user's datasets
 * - nemar dataset release         - Create version bump PR
 * - nemar dataset update          - Update dataset via PR
 * - nemar dataset request-access  - Request access to a dataset
 * - nemar dataset invite          - Invite user as collaborator
 * - nemar dataset collaborators   - List dataset collaborators
 * - nemar dataset commit          - Stage and commit changes
 * - nemar dataset save            - Stage and commit changes (alias for commit)
 * - nemar dataset push            - Push commits and data to remotes
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "bun";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import {
  ApiError,
  type Dataset,
  type DatasetsListResponse,
  type NemarMetadataPayload,
  ORCID_REGEX,
  addCi,
  createDataset,
  errorDetail,
  getCurrentUser,
  getDataset,
  getManifest,
  getPublishStatus,
  getUserCiStatus,
  getVersionHistory,
  inviteCollaborator,
  listCollaborators,
  listDatasets,
  listManifestVersions,
  requestDatasetAccess,
  requestDownloadCredentials,
  requestPublication,
  requestUploadCredentials,
  resendPublishNotification,
  resolveSourceId,
  searchDatasets,
} from "../lib/api.js";
import { isAwsCliAvailable } from "../lib/aws-cli.js";
import { buildBidsFilterArgs } from "../lib/bids-filter.js";
import {
  type BidsValidationResult,
  checkDenoInstalled,
  formatValidationResult,
  getValidatorVersion,
  isValidatorCacheStale,
  runBidsValidatorDirect,
  updateValidatorCache,
  validateBidsDataset,
} from "../lib/bids-validator.js";
import { getConfig, isAuthenticated, isSandboxCompleted } from "../lib/config.js";
import { NO_DESCRIPTION, YES_DESCRIPTION, YES_OPTION, confirm } from "../lib/confirm.js";
import {
  type LocalDatasetConfig,
  readLocalConfig,
  updateLastUpload,
  writeLocalConfig,
} from "../lib/dataset-config.js";
import {
  acceptGitHubInvitation,
  checkDownloadPrerequisites,
  checkPrerequisites,
  clearAnnexCredentials,
  cloneDataset,
  collectFileManifest,
  configureGitHubRemote,
  configureLargefiles,
  configureS3Remote,
  copyToAnnexRemote,
  dropFiles,
  dropUnusedAnnexObjects,
  enableS3Remote,
  ensureGitAnnexInitialized,
  ensureLocalMainBranch,
  formatBytes,
  getAnnexS3Remotes,
  getCurrentBranch,
  getDatasetData,
  getDatasetIdFromRemote,
  getLocalDatasetInfo,
  gitAnnexAdd,
  gitFetchOrigin,
  gitMergeFastForward,
  initDataset,
  isGitAnnexDataset,
  isWorkingTreeDirty,
  pushBranch,
  pushToGitHub,
  readLocalDatasetVersion,
  readRemoteHeadDatasetVersion,
  resolveUpstreamRef,
  saveDataset,
  toS3Credentials,
  verifyGitHubAuth,
} from "../lib/git-annex.js";
import {
  detectLicense,
  ensureLicenseFile,
  isResearchCompatible,
  promptForLicense,
  updateLicenseInDescription,
} from "../lib/license.js";
import { diffManifests } from "../lib/manifest-diff.js";
import {
  downloadWithAwsCli,
  downloadWithHttps,
  isOpenNeuroDatasetId,
  listOpenNeuroObjects,
  openNeuroDatasetExists,
} from "../lib/openneuro.js";
import { checkPrerequisitesForCommand } from "../lib/prerequisites.js";
import { DownloadProgressTracker } from "../lib/progress.js";
import { promptForProvenance } from "../lib/provenance.js";
import { bumpVersion, isValidStableVersion, parseVersion } from "../lib/semver.js";
import type { UploadProgress } from "../lib/upload-progress.js";
import {
  clearUploadProgress,
  getFilesNeedingUpload,
  getProgressSummary,
  initUploadProgress,
  isStepCompleted,
  markFileUploaded,
  markStepCompleted,
  readUploadProgress,
  writeUploadProgress,
} from "../lib/upload-progress.js";

export const datasetCommand = new Command("dataset").description("Dataset management").addHelpText(
  "after",
  `
Description:
  Manage BIDS datasets on NEMAR. Upload, download, validate, and version
  neurophysiology datasets in Brain Imaging Data Structure (BIDS) format.

Prerequisites:
  - git-annex (for upload/download)
  - Deno runtime (for BIDS validation)
  - NEMAR account (for upload)

Workflows:
  New dataset:          nemar dataset upload <path>
  Edit (private):       nemar dataset commit -> nemar dataset push
  Edit (public):        nemar dataset update
  New version:          nemar dataset release
  Download:             nemar dataset clone <id> -> nemar dataset get
  Request publication:  nemar dataset publish request <id>

Examples:
  $ nemar dataset validate ./my-dataset          # Validate locally
  $ nemar dataset upload ./my-dataset            # Upload to NEMAR
  $ nemar dataset download nm000104              # Download a dataset
  $ nemar dataset list --mine                    # List your datasets
  $ nemar dataset status nm000104                # Check dataset status
  $ nemar dataset request-access nm000104        # Request collaborator access
  $ nemar dataset invite johndoe nm000104        # Invite user as collaborator

Learn More:
  https://nemar-cli.pages.dev/commands/dataset/`,
);

// Validate command
datasetCommand
  .command("validate")
  .description("Validate a BIDS dataset using the official BIDS validator (requires Deno)")
  .argument("[path]", "Path to BIDS dataset directory", ".")
  .option("--ignore-warnings", "Only report errors, not warnings")
  .option("-c, --config <file>", "Validation config file (.bidsvalidatorrc)")
  .option("-r, --recursive", "Validate derivatives subdirectories")
  .option("--prune", "Skip sourcedata and derivatives for faster validation")
  .option("-v, --verbose", "Show verbose output")
  .option("--json", "Output results as JSON (for scripting)")
  .option("--version-info", "Show BIDS validator version info")
  .option("--update", "Force update the BIDS validator to the latest version")
  .allowUnknownOption()
  .addHelpText(
    "after",
    `
  Extra flags after known options are passed through to the BIDS validator.
  See all validator flags: deno run jsr:@bids/validator --help

  Examples:
    $ nemar dataset validate                            # Validate current directory
    $ nemar dataset validate ./ds --prune               # Skip derivatives
    $ nemar dataset validate ./ds --json > out.json     # JSON for scripting
    $ nemar dataset validate ./ds --ignoreNiftiHeaders  # Pass-through flag
    $ nemar dataset validate ./ds --max-rows 0           # Headers only`,
  )
  .action(async (datasetPath, options) => {
    // Handle --update: force-refresh the validator cache
    if (options.update) {
      const deno = await checkDenoInstalled();
      if (!deno.installed) {
        console.log(chalk.red("Deno is not installed"));
        console.log("Install Deno: https://deno.com");
        process.exit(1);
      }

      const oldVersion = await getValidatorVersion();
      const spinner = ora("Updating BIDS validator to latest version...").start();
      const newVersion = await updateValidatorCache();

      if (!newVersion) {
        spinner.fail("Failed to update BIDS validator");
        process.exit(1);
      }

      if (oldVersion && oldVersion !== newVersion) {
        spinner.succeed(`BIDS validator updated: ${oldVersion} -> ${newVersion}`);
      } else {
        spinner.succeed(`BIDS validator is up to date (v${newVersion})`);
      }

      // If no dataset path given, just update and exit
      if (!datasetPath || datasetPath === ".") {
        const cwd = process.cwd();
        if (!existsSync(resolve(cwd, "dataset_description.json"))) {
          return;
        }
      }
    }

    // Show version info if requested
    if (options.versionInfo) {
      const deno = await checkDenoInstalled();
      if (!deno.installed) {
        console.log(chalk.red("Deno is not installed"));
        console.log("Install Deno: https://deno.com");
        process.exit(1);
      }

      const stale = isValidatorCacheStale();
      const version = await getValidatorVersion();
      console.log(
        `BIDS Validator: ${version || "unknown"}${stale ? chalk.yellow(" (cache may be stale, run --update to refresh)") : ""}`,
      );
      console.log(`Deno: ${deno.version || "unknown"}`);
      return;
    }

    // Path is required unless --version-info
    if (!datasetPath) {
      console.log(chalk.red("Error: Missing required argument: path"));
      console.log("Usage: nemar dataset validate <path>");
      process.exit(1);
    }

    // Check Deno is installed
    const deno = await checkDenoInstalled();
    if (!deno.installed) {
      console.log(chalk.red("Error: Deno is required for BIDS validation"));
      console.log();
      console.log("The BIDS validator runs on Deno runtime.");
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
      process.exit(1);
    }

    // Auto-refresh stale cache (>7 days old)
    const forceReload = !!options.update;
    if (!forceReload && isValidatorCacheStale()) {
      const refreshSpinner = ora("Checking for BIDS validator updates...").start();
      const newVersion = await updateValidatorCache();
      if (newVersion) {
        refreshSpinner.succeed(`BIDS validator updated to v${newVersion}`);
      } else {
        refreshSpinner.info("Could not check for validator updates, using cached version");
      }
    }

    // Resolve and check path
    const absolutePath = resolve(datasetPath);
    if (!existsSync(absolutePath)) {
      console.log(chalk.red(`Error: Path does not exist: ${absolutePath}`));
      process.exit(1);
    }

    // Check for dataset_description.json
    const descPath = resolve(absolutePath, "dataset_description.json");
    if (!existsSync(descPath)) {
      console.log(chalk.red("Error: Not a valid BIDS dataset"));
      console.log("Missing required file: dataset_description.json");
      console.log(`Path: ${absolutePath}`);
      process.exit(1);
    }

    // Collect extra args (unknown flags passed through to bids-validator)
    const extraArgs = collectPassthroughArgs();

    // Run validation with spinner, then show native output
    const spinner = ora("Validating BIDS dataset...").start();

    try {
      const { stdout, stderr, exitCode } = await runBidsValidatorDirect(absolutePath, {
        config: options.config,
        ignoreWarnings: options.ignoreWarnings,
        recursive: options.recursive,
        prune: options.prune,
        verbose: options.verbose,
        json: options.json,
        extraArgs,
        forceReload,
      });

      // No output + non-zero exit = real failure (e.g. deno error)
      if (!stdout.trim() && exitCode !== 0) {
        spinner.fail("Validation failed");
        if (stderr.trim()) {
          const relevantStderr = stderr
            .split("\n")
            .filter((l) => !l.includes("Ignored build scripts"))
            .join("\n")
            .trim();
          if (relevantStderr) {
            console.error(relevantStderr);
          }
        }
        process.exit(1);
      }

      // Has output: validation ran (exit 0 = valid, exit 1 = errors found)
      spinner.succeed("Validation complete");

      if (stdout.trim()) {
        console.log(stdout);
      }

      process.exit(exitCode);
    } catch (error) {
      spinner.fail("Validation failed");
      console.log(chalk.red((error as Error).message));
      process.exit(1);
    }
  });

/**
 * Extract unknown/passthrough args from process.argv for the validate command.
 * Commander.js's .allowUnknownOption() prevents errors but doesn't parse them.
 */
function collectPassthroughArgs(): string[] {
  const knownFlags = new Set([
    "--ignore-warnings",
    "--config",
    "-c",
    "--recursive",
    "-r",
    "--prune",
    "--verbose",
    "-v",
    "--json",
    "--version-info",
    "--help",
    "-h",
  ]);

  const extra: string[] = [];
  const commandIndex = process.argv.indexOf("validate");
  if (commandIndex < 0) return extra;

  const rawArgs = process.argv.slice(commandIndex + 1);
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    // Skip the dataset path argument (first non-flag arg)
    if (!arg.startsWith("-")) continue;

    // Skip known flags
    if (knownFlags.has(arg)) {
      // If it's --config / -c, skip the next arg too (its value)
      if (arg === "--config" || arg === "-c") i++;
      continue;
    }

    // Pass through unknown flags and their values
    extra.push(arg);
    // If next arg looks like a value (not a flag), include it
    if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith("-")) {
      extra.push(rawArgs[i + 1]);
      i++;
    }
  }

  return extra;
}

// Upload command
datasetCommand
  .command("upload")
  .description("Upload a BIDS dataset to NEMAR")
  .argument("<path>", "Path to BIDS dataset directory")
  .option("-n, --name <name>", "Dataset name (defaults to BIDS Name, then directory name)")
  .option("-d, --description <desc>", "Dataset description")
  .option("--skip-validation", "Skip BIDS validation (not recommended)")
  .option("--skip-orcid", "Skip co-author ORCID collection")
  .option("--dry-run", "Show what would be uploaded without doing it")
  .option("-j, --jobs <number>", "Parallel upload streams (default: 4)", "4")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option("--restart", "Clear upload progress and re-upload all files")
  .option("--no", NO_DESCRIPTION) // Long form only; -n conflicts with --name
  .addHelpText(
    "after",
    `
Description:
  Upload a BIDS dataset to NEMAR. The dataset will be validated, assigned
  a unique ID (nm000XXX), and stored on GitHub (metadata) and S3 (data files).

Requirements:
  - NEMAR account (nemar auth login)
  - git-annex installed
  - GitHub CLI authenticated (gh auth login)

Process:
  1. Validates BIDS format (unless --skip-validation)
  2. Creates GitHub repository for metadata
  3. Uploads large files to S3 in parallel
  4. Enables PR-based versioning workflow

Note:
  This command is for initial dataset creation only. To update an
  existing dataset, use 'nemar dataset commit' + 'nemar dataset push'
  (private) or 'nemar dataset update' (public).

Examples:
  $ nemar dataset upload ./my-eeg-dataset
  $ nemar dataset upload ./ds -n "My EEG Study" -d "64-channel EEG data"
  $ nemar dataset upload ./ds --dry-run        # Preview without uploading
  $ nemar dataset upload ./ds -j 16            # More parallel streams`,
  )
  .action(async (datasetPath, options) => {
    // Get config for GitHub username
    const config = getConfig();

    // Step 1: Check authentication
    if (!isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      console.log("Run 'nemar auth login' first");
      process.exit(1);
    }

    // Step 1b: Check sandbox training
    if (!isSandboxCompleted()) {
      console.log(chalk.yellow("Sandbox training required"));
      console.log();
      console.log("You must complete sandbox training before uploading real datasets.");
      console.log("This verifies your setup and familiarizes you with the workflow.");
      console.log();
      console.log("Run sandbox training with:");
      console.log(chalk.cyan("  nemar sandbox"));
      process.exit(1);
    }

    // Resolve path
    const absolutePath = resolve(datasetPath);
    if (!existsSync(absolutePath)) {
      console.log(chalk.red(`Error: Path does not exist: ${absolutePath}`));
      process.exit(1);
    }

    // Step 1c: Check required tools
    await checkPrerequisitesForCommand("upload");

    // Step 2: Check prerequisites
    let spinner = ora("Checking prerequisites...").start();
    const prereqs = await checkPrerequisites();

    if (!prereqs.allPassed) {
      spinner.fail("Prerequisites check failed");
      console.log();
      for (const error of prereqs.errors) {
        console.log(chalk.red(`  - ${error}`));
      }
      process.exit(1);
    }

    spinner.succeed("Prerequisites check passed");
    console.log(chalk.dim(`  git-annex ${prereqs.gitAnnex.version}`));
    if (prereqs.githubSSH.username) {
      console.log(chalk.dim(`  GitHub: ${prereqs.githubSSH.username}`));
    }
    console.log();

    // Step 2b: Verify gh CLI authentication
    spinner = ora("Verifying GitHub CLI authentication...").start();
    const ghAuth = await verifyGitHubAuth(config.githubUsername);

    if (!ghAuth.authenticated) {
      spinner.fail("GitHub CLI not authenticated");
      console.log(chalk.red(`  ${ghAuth.error}`));
      console.log();
      console.log("GitHub CLI is required for dataset uploads. Install and authenticate:");
      console.log(chalk.cyan("  brew install gh       # or visit https://cli.github.com/"));
      console.log(chalk.cyan("  gh auth login"));
      process.exit(1);
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

    // Step 3: BIDS Validation (unless skipped)
    if (!options.skipValidation) {
      spinner = ora("Validating BIDS dataset...").start();

      // Check for dataset_description.json
      const descPath = resolve(absolutePath, "dataset_description.json");
      if (!existsSync(descPath)) {
        spinner.fail("Not a valid BIDS dataset");
        console.log(chalk.red("Missing required file: dataset_description.json"));
        process.exit(1);
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
        process.exit(1);
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
          process.exit(1);
        }
        spinner.succeed(`Dataset is valid BIDS (${result.warningCount} warnings)`);
      } catch (error) {
        spinner.fail("Validation failed");
        console.log(chalk.red((error as Error).message));
        process.exit(1);
      }
      console.log();
    }

    // Step 4: Collect file manifest and show upload plan
    spinner = ora("Analyzing dataset files...").start();

    // Read dataset_description.json once (used for Name fallback and co-author ORCIDs)
    let bidsDescription: Record<string, unknown> = {};
    try {
      const descPath = resolve(absolutePath, "dataset_description.json");
      bidsDescription = JSON.parse(readFileSync(descPath, "utf-8")) as Record<string, unknown>;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.log(
          chalk.yellow(
            `Warning: Could not read dataset_description.json: ${(err as Error).message}`,
          ),
        );
      }
    }

    // Use explicit --name flag, then BIDS Name from dataset_description.json, then directory name
    const datasetName =
      options.name ||
      (typeof bidsDescription.Name === "string" ? bidsDescription.Name : null) ||
      basename(absolutePath);
    const manifest = await collectFileManifest(absolutePath);
    spinner.succeed(
      `Found ${manifest.files.length} files (${manifest.dataFiles} data, ${manifest.metadataFiles} metadata)`,
    );

    // Step 4b: Collect co-author ORCIDs (skip if metadata already exists from prior run)
    // Check v2 first (.nemar/metadata.json), fall back to v1 (nemar_metadata.json)
    let coAuthorEnrichment: NemarMetadataPayload | undefined;
    const existingNemarMetaV2 = resolve(absolutePath, ".nemar", "metadata.json");
    const existingNemarMetaV1 = resolve(absolutePath, "nemar_metadata.json");
    if (existsSync(existingNemarMetaV2)) {
      try {
        coAuthorEnrichment = JSON.parse(readFileSync(existingNemarMetaV2, "utf-8"));
        console.log(
          chalk.dim("  Using existing .nemar/metadata.json (author ORCIDs from prior run)"),
        );
      } catch (err) {
        console.log(
          chalk.yellow(
            `  Warning: Could not read .nemar/metadata.json: ${err instanceof Error ? err.message : err}. Will re-collect author information.`,
          ),
        );
      }
    } else if (existsSync(existingNemarMetaV1)) {
      try {
        coAuthorEnrichment = JSON.parse(readFileSync(existingNemarMetaV1, "utf-8"));
        console.log(
          chalk.dim("  Using existing nemar_metadata.json (author ORCIDs from prior run)"),
        );
      } catch (err) {
        console.log(
          chalk.yellow(
            `  Warning: Could not read nemar_metadata.json: ${err instanceof Error ? err.message : err}. Will re-collect author information.`,
          ),
        );
      }
    }

    if (!coAuthorEnrichment && !options.skipOrcid && process.stdin.isTTY) {
      const rawAuthors = bidsDescription.Authors;
      const authorList = Array.isArray(rawAuthors)
        ? rawAuthors.filter((a): a is string => typeof a === "string")
        : [];

      if (authorList.length > 0) {
        try {
          // Get uploader's ORCID from profile
          let uploaderOrcid: string | undefined;
          let uploaderUsername: string | undefined;
          try {
            const user = await getCurrentUser();
            uploaderOrcid = user.orcid || undefined;
            uploaderUsername = user.username;
          } catch (userErr) {
            console.log(chalk.dim(`  Could not fetch profile: ${errorDetail(userErr)}`));
          }

          console.log();
          console.log(chalk.cyan("Authors found:"), authorList.join(" | "));

          // Auto-match uploader ORCID (v2 format with affiliations array)
          const authors: Record<
            string,
            { orcid?: string; affiliations?: Array<{ name: string }> }
          > = {};
          let uploaderMatchedAuthor: string | undefined;
          if (uploaderOrcid && uploaderUsername) {
            const lowerName = uploaderUsername.toLowerCase();
            const match = authorList.find((a) => a.toLowerCase().includes(lowerName));
            if (match) {
              authors[match] = { orcid: uploaderOrcid };
              uploaderMatchedAuthor = match;
              console.log(
                `  Your ORCID (from profile): ${chalk.green(uploaderOrcid)} (matched to "${match}")`,
              );
            }
          }

          // Auto-discover ORCIDs from referenced DOIs
          try {
            const { discoverOrcidsFromReferencedDois } = await import(
              "../../backend/src/services/doi-orcid-discovery.js"
            );
            const spinner = ora("Looking up author ORCIDs from referenced publications...").start();
            const orcidResult = await discoverOrcidsFromReferencedDois(bidsDescription, authors);
            const count = Object.keys(orcidResult.discoveries).length;
            if (count > 0) {
              spinner.succeed(`Found ${count} ORCID(s) from referenced DOIs`);
              for (const [name, d] of Object.entries(orcidResult.discoveries)) {
                console.log(
                  `  ${chalk.green(d.orcid)} -> "${name}" (from ${d.sourceDoi}, ${d.confidence} match)`,
                );
              }
              const { confirmOrcids } = await inquirer.prompt([
                {
                  type: "confirm",
                  name: "confirmOrcids",
                  message: "Accept these auto-discovered ORCIDs?",
                  default: true,
                },
              ]);
              if (confirmOrcids) {
                for (const [name, d] of Object.entries(orcidResult.discoveries)) {
                  authors[name] = {
                    ...authors[name],
                    orcid: d.orcid,
                    ...(d.affiliations && { affiliations: d.affiliations }),
                  };
                }
              }
            } else {
              spinner.info("No ORCIDs found from referenced DOIs");
            }
          } catch (discoverErr) {
            console.log(
              chalk.yellow(`  Could not auto-discover ORCIDs: ${errorDetail(discoverErr)}`),
            );
          }

          // Prompt for each co-author's ORCID
          for (const author of authorList) {
            if (author === uploaderMatchedAuthor) continue;
            if (authors[author]?.orcid) continue; // skip auto-discovered

            const { orcid } = await inquirer.prompt([
              {
                type: "input",
                name: "orcid",
                message: `ORCID for "${author}" (Enter to skip):`,
                validate: (input: string) => {
                  if (!input) return true;
                  return ORCID_REGEX.test(input) || "Invalid ORCID format (XXXX-XXXX-XXXX-XXXX)";
                },
              },
            ]);

            if (orcid) {
              const entry: { orcid: string; affiliations?: Array<{ name: string }> } = { orcid };
              const { affiliation } = await inquirer.prompt([
                {
                  type: "input",
                  name: "affiliation",
                  message: `  Affiliation for "${author}" (optional):`,
                },
              ]);
              if (affiliation) entry.affiliations = [{ name: affiliation }];
              authors[author] = entry;
            }
          }

          if (Object.keys(authors).length > 0) {
            coAuthorEnrichment = { version: "2.0", authors };

            // Write immediately so resumed uploads don't re-prompt
            try {
              const nemarMetaDir = resolve(absolutePath, ".nemar");
              if (!existsSync(nemarMetaDir)) {
                mkdirSync(nemarMetaDir, { recursive: true });
              }
              const nemarMetaPath = resolve(nemarMetaDir, "metadata.json");
              writeFileSync(nemarMetaPath, JSON.stringify(coAuthorEnrichment, null, 2));
              console.log(chalk.dim("  Saved .nemar/metadata.json with author ORCIDs"));
            } catch (writeErr) {
              console.log(
                chalk.yellow(
                  `  Warning: Could not save .nemar/metadata.json: ${errorDetail(writeErr)}`,
                ),
              );
            }
          }
          console.log();
        } catch (orcidErr) {
          if (orcidErr instanceof ApiError) {
            console.log(chalk.yellow(`  Could not fetch profile: ${orcidErr.message}`));
          } else {
            console.log(chalk.yellow(`  Could not collect ORCIDs: ${errorDetail(orcidErr)}`));
          }
          console.log(chalk.dim("  Continuing without author enrichment."));
        }
      }
    }

    // Step 4c: License detection and enforcement
    let resolvedLicense: string | undefined;
    if (process.stdin.isTTY && !options.skipValidation /* non-interactive guard */) {
      const detected = detectLicense(absolutePath);

      if (detected.spdxId) {
        console.log();
        console.log(
          chalk.cyan("License detected:"),
          chalk.bold(detected.spdxId),
          chalk.dim(
            `(from ${detected.source === "dataset_description" ? "dataset_description.json" : "LICENSE file"})`,
          ),
        );

        if (!isResearchCompatible(detected.spdxId)) {
          console.log(
            chalk.yellow(
              `  Warning: "${detected.spdxId}" is not in the list of known research-compatible licenses.`,
            ),
          );
        }

        const { keepLicense } = await inquirer.prompt<{ keepLicense: boolean }>([
          {
            type: "confirm",
            name: "keepLicense",
            message: `Use "${detected.spdxId}" as the dataset license?`,
            default: true,
          },
        ]);

        if (keepLicense) {
          resolvedLicense = detected.spdxId;
        } else {
          resolvedLicense = await promptForLicense(detected.spdxId);
        }
      } else {
        console.log();
        if (detected.source === "license_file") {
          console.log(
            chalk.yellow(
              "A LICENSE file was found but the license could not be identified automatically.",
            ),
          );
        } else {
          console.log(chalk.yellow("No license found in this dataset."));
        }
        console.log(chalk.dim("A license is required to publish on NEMAR."));
        resolvedLicense = await promptForLicense();
      }

      // Apply the resolved license back to dataset_description.json if it differs
      try {
        const descPath = resolve(absolutePath, "dataset_description.json");
        if (existsSync(descPath)) {
          const desc = JSON.parse(readFileSync(descPath, "utf-8")) as Record<string, unknown>;
          if (desc.License !== resolvedLicense) {
            updateLicenseInDescription(absolutePath, resolvedLicense);
            console.log(
              chalk.dim(`  Updated dataset_description.json License -> ${resolvedLicense}`),
            );
          }
        }
      } catch (licErr) {
        console.log(
          chalk.yellow(
            `  Warning: Could not update license in dataset_description.json: ${errorDetail(licErr)}`,
          ),
        );
      }

      // Ensure LICENSE file exists
      const created = ensureLicenseFile(absolutePath, resolvedLicense);
      if (created) {
        console.log(chalk.dim(`  Created LICENSE file (${resolvedLicense})`));
      }
      console.log();
    }

    // Step 4d: Data provenance
    if (process.stdin.isTTY && !options.skipValidation && resolvedLicense) {
      const provenance = await promptForProvenance(resolvedLicense);

      // Update dataset_description.json SourceDatasets field for derived data
      if (
        provenance.isDerived &&
        provenance.sourceDatasets &&
        provenance.sourceDatasets.length > 0
      ) {
        try {
          const descPath = resolve(absolutePath, "dataset_description.json");
          if (existsSync(descPath)) {
            const desc = JSON.parse(readFileSync(descPath, "utf-8")) as Record<string, unknown>;
            const existingSources = Array.isArray(desc.SourceDatasets) ? desc.SourceDatasets : [];
            const newSources = provenance.sourceDatasets.map((s) => s.identifier);
            // Merge without duplicates
            const merged = Array.from(new Set([...(existingSources as string[]), ...newSources]));
            desc.SourceDatasets = merged;
            writeFileSync(descPath, `${JSON.stringify(desc, null, 2)}\n`);
            console.log(
              chalk.dim(
                `  Updated dataset_description.json SourceDatasets (${merged.length} source(s))`,
              ),
            );
          }
        } catch (srcErr) {
          console.log(
            chalk.yellow(`  Warning: Could not update SourceDatasets: ${errorDetail(srcErr)}`),
          );
        }
        console.log();
      }
    }

    // Check for existing local config (resume scenario)
    const existingConfig = readLocalConfig(absolutePath);

    console.log();
    if (existingConfig) {
      console.log(chalk.bold.yellow("Resume Upload:"));
      console.log(`  Dataset ID: ${chalk.cyan(existingConfig.dataset_id)}`);
      console.log(`  Last attempt: ${existingConfig.last_upload_at || existingConfig.created_at}`);
    } else {
      console.log(chalk.bold("Upload Plan:"));
    }
    console.log(`  Name: ${datasetName}`);
    console.log(`  Path: ${absolutePath}`);
    console.log(`  Files: ${manifest.files.length}`);
    console.log(`  Size: ${formatBytes(manifest.totalSize)}`);
    console.log(`  Data files: ${manifest.dataFiles} (will be uploaded to S3)`);
    console.log(`  Metadata files: ${manifest.metadataFiles} (will be stored in git)`);
    console.log(`  Parallel jobs: ${options.jobs}`);
    console.log();

    // Dry run mode
    if (options.dryRun) {
      console.log(chalk.yellow("Dry run mode - no changes made"));
      return;
    }

    // Step 5: Confirm with user
    const confirmResult = await confirm(
      "Proceed with upload?",
      { yes: options.yes, no: options.no },
      true,
    );
    if (confirmResult !== "confirmed") {
      console.log(confirmResult === "declined" ? "Upload skipped." : "Upload cancelled.");
      return;
    }

    console.log();

    // Only request presigned URLs for data files
    const dataFiles = manifest.files.filter((f) => f.type === "data");

    // Handle --restart: clear any existing progress
    if (options.restart) {
      clearUploadProgress(absolutePath);
      console.log(chalk.dim("  Upload progress cleared (--restart)"));
      console.log();
    }

    // Load existing upload progress (if any)
    let uploadProgress: UploadProgress | null = options.restart
      ? null
      : readUploadProgress(absolutePath);

    if (uploadProgress) {
      const summary = getProgressSummary(uploadProgress);
      console.log(chalk.bold.cyan("Upload Progress:"));
      console.log(
        `  Files: ${summary.uploaded}/${summary.total} uploaded, ${summary.failed} failed, ${summary.pending} pending`,
      );
      if (summary.completedSteps.length > 0) {
        console.log(`  Completed steps: ${summary.completedSteps.join(", ")}`);
      }
      console.log();
    }

    // Determine which files need uploading
    const filesToUpload = uploadProgress
      ? getFilesNeedingUpload(uploadProgress, dataFiles)
      : dataFiles;

    let datasetInfo: {
      dataset_id: string;
      ssh_url: string;
      s3_prefix: string;
      github_url: string;
      upload_urls: Record<string, string>;
      s3_config: {
        bucket: string;
        region: string;
        public_url: string;
      };
    };

    // Check if this is a resume (existing local config was read above)
    const isResume = existingConfig !== null;

    if (isResume) {
      // Step 6: Resume existing dataset upload
      spinner = ora(`Resuming upload for ${existingConfig.dataset_id}...`).start();

      try {
        // Verify dataset still exists on backend (throws ApiError if not found)
        await getDataset(existingConfig.dataset_id);

        // Presigned URLs are requested adaptively in Step 9 (not upfront)
        datasetInfo = {
          dataset_id: existingConfig.dataset_id,
          ssh_url: existingConfig.ssh_url,
          s3_prefix: existingConfig.s3_prefix,
          github_url: existingConfig.github_url,
          upload_urls: {},
          s3_config: existingConfig.s3_config,
        };

        spinner.succeed(`Resuming upload: ${datasetInfo.dataset_id}`);
      } catch (error) {
        spinner.fail("Failed to resume upload");
        if (error instanceof ApiError) {
          console.log(chalk.red(`  ${error.message}`));
          if (error.statusCode === 404) {
            console.log(
              chalk.yellow("  The dataset may have been deleted. Try uploading as a new dataset."),
            );
            console.log(chalk.dim(`  Remove ${absolutePath}/.nemar to start fresh.`));
          }
        } else {
          console.log(chalk.red(`  ${(error as Error).message}`));
        }
        process.exit(1);
      }
    } else {
      // Step 6: Create new dataset in backend with file manifest
      spinner = ora("Creating dataset in NEMAR...").start();

      try {
        const response = await createDataset({
          name: datasetName,
          description: options.description,
          files: dataFiles.map((f) => ({ path: f.path, size: f.size, type: f.type })),
        });

        datasetInfo = {
          dataset_id: response.dataset.dataset_id,
          ssh_url: response.dataset.ssh_url,
          s3_prefix: response.dataset.s3_prefix,
          github_url: response.dataset.github_url,
          upload_urls: response.upload_urls || {},
          s3_config: response.s3_config,
        };

        // Save local config for potential resume
        const localConfig: LocalDatasetConfig = {
          dataset_id: datasetInfo.dataset_id,
          github_url: datasetInfo.github_url,
          ssh_url: datasetInfo.ssh_url,
          s3_prefix: datasetInfo.s3_prefix,
          s3_config: datasetInfo.s3_config,
          created_at: new Date().toISOString(),
        };
        writeLocalConfig(absolutePath, localConfig);

        if (response.resumed) {
          spinner.succeed(`Resumed existing dataset: ${datasetInfo.dataset_id}`);
        } else {
          spinner.succeed(`Dataset created: ${datasetInfo.dataset_id}`);

          // Wait for IAM policy propagation (AWS is eventually consistent)
          // This initial wait helps reduce retry attempts during upload
          await new Promise((resolve) => setTimeout(resolve, 10000));
        }
      } catch (error) {
        spinner.fail("Failed to create dataset");
        if (error instanceof ApiError) {
          console.log(chalk.red(`  ${error.message}`));
        } else {
          console.log(chalk.red(`  ${(error as Error).message}`));
        }
        process.exit(1);
      }
    }

    // Validate progress file matches current dataset (discard stale progress)
    if (uploadProgress && uploadProgress.dataset_id !== datasetInfo.dataset_id) {
      console.log(chalk.yellow("  Progress file is for a different dataset; starting fresh."));
      clearUploadProgress(absolutePath);
      uploadProgress = null;
    }

    // Step 6b: Accept GitHub invitation
    spinner = ora("Accepting GitHub repository invitation...").start();

    // Extract repo full name from github_url (e.g., "https://github.com/nemarDatasets/nm000123")
    // Validate URL format: must be a valid GitHub URL with owner/repo pattern
    const repoMatch = datasetInfo.github_url?.match(
      /github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/,
    );
    const repoFullName = repoMatch ? repoMatch[1].replace(/\.git$/, "") : null;

    if (!repoFullName) {
      spinner.fail("Invalid GitHub repository URL from backend");
      console.log(chalk.red(`  Received: ${datasetInfo.github_url || "(empty)"}`));
      console.log(chalk.red("  Expected format: https://github.com/owner/repo"));
      console.log();
      console.log("This may indicate a backend issue. Please contact support.");
      process.exit(1);
    }

    const inviteResult = await acceptGitHubInvitation(repoFullName);
    if (inviteResult.accepted) {
      if (inviteResult.alreadyCollaborator) {
        spinner.succeed("Already a collaborator on this repository");
      } else {
        spinner.succeed("GitHub invitation accepted");
      }
    } else {
      spinner.warn("Could not auto-accept invitation");
      console.log(chalk.yellow(`  ${inviteResult.error}`));
      console.log();
      console.log("You may need to accept the invitation manually:");
      console.log(chalk.cyan(`  https://github.com/${repoFullName}/invitations`));
      console.log();
      // Continue anyway - user can accept manually
    }

    // Step 7: Initialize git-annex dataset
    spinner = ora("Initializing git-annex dataset...").start();

    // Use NEMAR user identity for all commits (including initial dataset creation)
    const author =
      config.username && config.email ? { name: config.username, email: config.email } : undefined;

    const isExistingDataset = await isGitAnnexDataset(absolutePath);
    if (!isExistingDataset) {
      const createResult = await initDataset(absolutePath, { author });
      if (!createResult.success) {
        spinner.fail("Failed to initialize git-annex dataset");
        console.log(chalk.red(`  ${createResult.error}`));
        process.exit(1);
      }
    }

    // Ensure git-annex is initialized (handles both new and existing datasets)
    const gitAnnexResult = await ensureGitAnnexInitialized(absolutePath);
    if (!gitAnnexResult.success) {
      spinner.fail("Failed to initialize git-annex");
      console.log(chalk.red(`  ${gitAnnexResult.error}`));
      process.exit(1);
    }

    // Configure largefiles pattern
    const largefilesResult = await configureLargefiles(absolutePath);
    if (!largefilesResult.success) {
      spinner.warn("Could not configure largefiles pattern");
      console.log(chalk.dim(`  ${largefilesResult.error}`));
    }

    spinner.succeed("git-annex dataset initialized");

    // Inform user that the adjusted branch name is normal
    const postInitBranch = await getCurrentBranch(absolutePath);
    if (postInitBranch?.startsWith("adjusted/")) {
      console.log(chalk.dim(`  Note: Your local branch is "${postInitBranch}".`));
      console.log(
        chalk.dim("  This is normal; it keeps files unlocked so you can work with them directly."),
      );
      console.log(chalk.dim('  Pushes will go to the "main" branch on GitHub automatically.'));
    }

    // Ensure .nemar/ is gitignored (internal config, not dataset content)
    try {
      const gitignorePath = resolve(absolutePath, ".gitignore");
      let gitignoreContent = "";
      if (existsSync(gitignorePath)) {
        gitignoreContent = readFileSync(gitignorePath, "utf-8");
      }
      if (!gitignoreContent.includes(".nemar/")) {
        const newContent = gitignoreContent
          ? `${gitignoreContent.trimEnd()}\n.nemar/\n`
          : ".nemar/\n";
        writeFileSync(gitignorePath, newContent);
      }
    } catch (gitignoreErr) {
      console.log(
        chalk.yellow(`  Warning: Could not update .gitignore: ${errorDetail(gitignoreErr)}`),
      );
    }

    // Step 8: Configure GitHub remote (auto-detects best auth method)
    spinner = ora("Configuring GitHub remote...").start();

    const githubResult = await configureGitHubRemote(absolutePath, datasetInfo.ssh_url);
    if (!githubResult.success) {
      spinner.fail("Failed to configure GitHub remote");
      console.log(chalk.red(`  ${githubResult.error}`));
      process.exit(1);
    }

    spinner.succeed("GitHub remote configured");

    // Step 8b: Ensure local branch is named "main"
    const branchOk = await ensureLocalMainBranch(absolutePath, { yes: options.yes });
    if (!branchOk) {
      process.exit(1);
    }

    // Step 9: Upload data files to S3 via git-annex S3 special remote
    // Initialize progress tracking if not already present
    if (!uploadProgress) {
      uploadProgress = initUploadProgress(absolutePath, datasetInfo.dataset_id, dataFiles);
    } else {
      // Add any new files to progress tracking
      for (const file of dataFiles) {
        if (!uploadProgress.files[file.path]) {
          uploadProgress.files[file.path] = {
            status: "pending",
            size: file.size,
            updated_at: new Date().toISOString(),
          };
        }
      }
      writeUploadProgress(absolutePath, uploadProgress);
    }

    if (!isStepCompleted(uploadProgress, "s3_upload")) {
      if (filesToUpload.length > 0) {
        // Get STS credentials for S3 access
        spinner = ora("Requesting upload credentials...").start();
        let creds: Awaited<ReturnType<typeof requestUploadCredentials>>;
        try {
          creds = await requestUploadCredentials(datasetInfo.dataset_id);
          spinner.succeed("Upload credentials received (2h expiry)");
        } catch (credError) {
          spinner.fail(`Could not get upload credentials: ${errorDetail(credError)}`);
          console.log(chalk.red("  Upload credentials are required for S3 access."));
          console.log(chalk.dim("  Re-run the command to retry."));
          process.exit(1);
        }

        // Configure S3 special remote (idempotent: enables existing if already created)
        spinner = ora("Configuring S3 remote...").start();
        const s3Result = await configureS3Remote(
          absolutePath,
          {
            name: "nemar-s3",
            bucket: creds.s3.bucket,
            prefix: `${datasetInfo.dataset_id}/objects`,
            region: creds.s3.region,
            publicUrl: datasetInfo.s3_config.public_url,
          },
          toS3Credentials(creds.credentials),
        );

        if (!s3Result.success) {
          spinner.fail(`Failed to configure S3 remote: ${s3Result.error}`);
          console.log(chalk.dim("  Re-run the command to retry."));
          process.exit(1);
        }
        spinner.succeed("S3 remote configured");

        // Track data files with git-annex before uploading
        spinner = ora("Tracking data files with git-annex...").start();
        const addResult = await gitAnnexAdd(absolutePath);
        if (!addResult.success) {
          spinner.fail(`Failed to track data files: ${addResult.error}`);
          process.exit(1);
        }
        spinner.succeed("Data files tracked by git-annex");

        // Upload via git-annex S3 remote (handles key-based layout + tracking)
        spinner = ora(`Uploading ${filesToUpload.length} data files to S3...`).start();
        const uploadResult = await copyToAnnexRemote(
          absolutePath,
          "nemar-s3",
          Number.parseInt(options.jobs, 10),
          toS3Credentials(creds.credentials),
        );

        // Always clear cached STS creds so downloads use publicurl
        await clearAnnexCredentials(absolutePath);

        if (!uploadResult.success) {
          spinner.fail(`S3 upload failed: ${uploadResult.error}`);
          console.log(chalk.yellow("Re-run the same command to resume uploading."));
          process.exit(1);
        }

        for (const file of filesToUpload) {
          markFileUploaded(uploadProgress, file.path);
        }
        writeUploadProgress(absolutePath, uploadProgress);
        spinner.succeed(`Uploaded ${uploadResult.filesCopied} data files to S3`);
      } else {
        console.log(chalk.dim("No data files to upload to S3"));
      }

      markStepCompleted(uploadProgress, "s3_upload");
      writeUploadProgress(absolutePath, uploadProgress);
    } else {
      console.log(chalk.dim("  S3 upload already completed (skipping)"));
    }

    // Step 10b: Ensure .bidsignore includes NEMAR-specific paths
    // (.nemar/metadata.json is already written at Step 4b; this just updates bidsignore)
    if (!isStepCompleted(uploadProgress, "metadata_write")) {
      if (coAuthorEnrichment) {
        try {
          // Write .nemar/metadata.json if not already on disk (e.g. old CLI resume)
          const nemarMetaDir = resolve(absolutePath, ".nemar");
          const nemarMetaPath = resolve(nemarMetaDir, "metadata.json");
          if (!existsSync(nemarMetaPath)) {
            if (!existsSync(nemarMetaDir)) {
              mkdirSync(nemarMetaDir, { recursive: true });
            }
            writeFileSync(nemarMetaPath, JSON.stringify(coAuthorEnrichment, null, 2));
          }

          // Ensure .bidsignore includes .nemar/ directory
          const bidsignorePath = resolve(absolutePath, ".bidsignore");
          let bidsignoreContent = "";
          if (existsSync(bidsignorePath)) {
            bidsignoreContent = readFileSync(bidsignorePath, "utf-8");
          }
          if (!bidsignoreContent.includes(".nemar/")) {
            const newContent = bidsignoreContent
              ? `${bidsignoreContent.trimEnd()}\n.nemar/\n`
              : ".nemar/\n";
            writeFileSync(bidsignorePath, newContent);
          }
          console.log(chalk.dim("  Updated .bidsignore for NEMAR metadata"));
        } catch (writeErr) {
          console.log(
            chalk.yellow(`  Warning: Could not update .bidsignore: ${errorDetail(writeErr)}`),
          );
          console.log(chalk.dim("  Upload will continue without author enrichment."));
        }
      }

      markStepCompleted(uploadProgress, "metadata_write");
      writeUploadProgress(absolutePath, uploadProgress);
    } else {
      console.log(chalk.dim("  Metadata write already completed (skipping)"));
    }

    // Step 11: Save dataset changes
    if (!isStepCompleted(uploadProgress, "dataset_save")) {
      spinner = ora("Saving dataset changes...").start();

      const saveResult = await saveDataset(absolutePath, "Initial NEMAR dataset upload", author);
      if (!saveResult.success) {
        writeUploadProgress(absolutePath, uploadProgress);
        spinner.fail("Failed to save dataset");
        console.log(chalk.red(`  ${saveResult.error}`));
        console.log();
        console.log(chalk.yellow("Re-run the same command to resume from this step."));
        process.exit(1);
      }

      spinner.succeed("Dataset changes saved");
      markStepCompleted(uploadProgress, "dataset_save");
      writeUploadProgress(absolutePath, uploadProgress);
    } else {
      console.log(chalk.dim("  Dataset save already completed (skipping)"));
    }

    // Step 12: Push metadata to GitHub
    if (!isStepCompleted(uploadProgress, "github_push")) {
      spinner = ora("Pushing metadata to GitHub...").start();

      const githubPushResult = await pushToGitHub(absolutePath);
      if (!githubPushResult.success) {
        writeUploadProgress(absolutePath, uploadProgress);
        spinner.fail("Failed to push to GitHub");
        console.log(chalk.red(`  ${githubPushResult.error}`));
        console.log();
        console.log(chalk.yellow("Re-run the same command to resume from this step."));
        process.exit(1);
      }

      if (githubPushResult.warning) {
        spinner.warn("Metadata pushed to GitHub (with warning)");
        console.log(chalk.yellow(`  ${githubPushResult.warning}`));
      } else {
        spinner.succeed("Metadata pushed to GitHub");
      }

      markStepCompleted(uploadProgress, "github_push");
      writeUploadProgress(absolutePath, uploadProgress);
    } else {
      console.log(chalk.dim("  GitHub push already completed (skipping)"));
    }

    // Step 12b: Deploy BIDS validation CI
    if (!isStepCompleted(uploadProgress, "ci_deploy")) {
      spinner = ora("Setting up BIDS validation CI...").start();
      try {
        await addCi(datasetInfo.dataset_id);
        spinner.succeed("BIDS validation CI configured");
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 403) {
          spinner.info("CI workflow will be configured by an admin");
        } else {
          const msg = error instanceof Error ? error.message : String(error);
          spinner.warn(`Could not configure CI: ${msg}`);
          console.log(
            chalk.dim(
              `  An admin can add it later with: nemar admin ci add ${datasetInfo.dataset_id}`,
            ),
          );
        }
      }

      markStepCompleted(uploadProgress, "ci_deploy");
      writeUploadProgress(absolutePath, uploadProgress);
    } else {
      console.log(chalk.dim("  CI deploy already completed (skipping)"));
    }

    // Note: Branch protection is NOT applied here for private datasets.
    // Protection is applied when creating a DOI (admin doi create) or making public.

    // Step 13: Success!
    // Clear progress file and update last upload timestamp
    clearUploadProgress(absolutePath);
    updateLastUpload(absolutePath);

    console.log();
    console.log(chalk.green.bold("Upload complete!"));
    console.log();
    console.log(`  Dataset ID: ${chalk.cyan(datasetInfo.dataset_id)}`);
    console.log(`  GitHub: ${chalk.cyan(datasetInfo.github_url)}`);
    console.log();
    console.log(chalk.dim("To download this dataset:"));
    console.log(chalk.dim(`  nemar dataset download ${datasetInfo.dataset_id}`));
    console.log();
    console.log(
      chalk.yellow(
        "Note: This dataset is private. Only the owner and designated collaborators can",
      ),
    );
    console.log(
      chalk.yellow("download it, and only through the NEMAR CLI (not direct git-annex commands)."),
    );
    console.log(
      chalk.yellow("After publishing, the data will be publicly available for everyone."),
    );
  });

function formatProgressBar(
  filesDown: number,
  filesTotal: number,
  bytesDown: number,
  bytesTotal: number,
): string {
  const percent = Math.round((filesDown / filesTotal) * 100);
  const width = 20;
  const filled = Math.round((percent / 100) * width);
  const bar = `[${"=".repeat(filled)}${" ".repeat(width - filled)}]`;
  return `${bar} ${percent}% | ${filesDown}/${filesTotal} files | ${formatBytes(bytesDown)} / ${formatBytes(bytesTotal)}`;
}

/**
 * Handle download of an OpenNeuro dataset (ds######).
 * Downloads directly from OpenNeuro's public S3 bucket.
 * Primary: AWS CLI (fast). Fallback: direct HTTPS (slower, no extra deps).
 */
async function handleOpenNeuroDownload(
  datasetId: string,
  options: { output?: string; jobs?: string; data?: boolean },
): Promise<void> {
  // Warning: no version control
  console.log();
  console.log(chalk.yellow("OpenNeuro Dataset"));
  console.log(
    chalk.yellow(
      "This dataset will be downloaded as plain files from OpenNeuro's public S3 bucket.",
    ),
  );
  console.log(
    chalk.yellow(
      "Unlike NEMAR datasets, there is no git-annex version tracking or selective file download.",
    ),
  );
  console.log(chalk.dim("For full version control, use DataLad directly:"));
  console.log(chalk.dim(`  datalad install https://github.com/OpenNeuroDatasets/${datasetId}`));
  console.log();

  if (options.data === false) {
    console.log(
      chalk.yellow(
        "Note: --no-data is not supported for OpenNeuro downloads. Downloading all files.",
      ),
    );
    console.log();
  }

  const outputPath = options.output || datasetId;
  const absoluteOutput = resolve(outputPath);

  if (existsSync(absoluteOutput)) {
    console.log(chalk.red(`Error: Output path already exists: ${absoluteOutput}`));
    console.log("Remove or rename the existing directory and try again.");
    process.exit(1);
  }

  // Check AWS CLI once and pass the result through to avoid spawning twice
  const hasAwsCli = await isAwsCliAvailable();

  const checkSpinner = ora(`Checking OpenNeuro for ${datasetId}...`).start();
  let exists: boolean;
  try {
    exists = await openNeuroDatasetExists(datasetId, hasAwsCli);
  } catch (err) {
    checkSpinner.fail(`Could not reach OpenNeuro: ${(err as Error).message}`);
    process.exit(1);
  }
  if (!exists) {
    checkSpinner.fail(`Dataset ${datasetId} not found on OpenNeuro`);
    process.exit(1);
  }
  checkSpinner.succeed(`Found ${datasetId} on OpenNeuro`);

  if (hasAwsCli) {
    // Primary path: AWS CLI
    console.log();
    console.log(chalk.bold("Download Plan:"));
    console.log(`  Dataset: ${datasetId} (OpenNeuro)`);
    console.log(`  Output:  ${absoluteOutput}`);
    console.log("  Method:  AWS CLI (aws s3 sync)");
    console.log();

    console.log(chalk.bold("Downloading data files..."));

    const result = await downloadWithAwsCli(datasetId, absoluteOutput, (count) => {
      process.stderr.write(`\r${chalk.cyan(`  ${count} files downloaded`)}`);
    });

    process.stderr.write(`\r${" ".repeat(40)}\r`);

    if (!result.success) {
      console.log(chalk.red(`Download failed: ${result.error}`));
      process.exit(1);
    }

    console.log(chalk.green(`Downloaded ${result.filesDownloaded} files`));
  } else {
    // Fallback path: direct HTTPS
    console.log();
    console.log(chalk.yellow("AWS CLI not found. Using direct HTTPS download."));
    console.log(chalk.yellow("This will be slower than AWS CLI. To install it:"));
    console.log(
      chalk.dim("  https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"),
    );
    console.log();

    const listSpinner = ora("Listing dataset files...").start();
    let objects: Awaited<ReturnType<typeof listOpenNeuroObjects>>;
    try {
      objects = await listOpenNeuroObjects(datasetId);
    } catch (err) {
      listSpinner.fail(`Failed to list files: ${(err as Error).message}`);
      process.exit(1);
    }

    if (objects.length === 0) {
      listSpinner.fail("No files found in dataset");
      process.exit(1);
    }

    const totalBytes = objects.reduce((sum, o) => sum + o.size, 0);
    listSpinner.succeed(`${objects.length} files (${formatBytes(totalBytes)})`);

    console.log(chalk.bold("Download Plan:"));
    console.log(`  Dataset: ${datasetId} (OpenNeuro)`);
    console.log(`  Output:  ${absoluteOutput}`);
    console.log("  Method:  HTTPS (direct download)");
    console.log(`  Files:   ${objects.length} (${formatBytes(totalBytes)})`);
    console.log();

    console.log(chalk.bold("Downloading data files..."));

    const concurrency = Number.parseInt(options.jobs || "8", 10);
    const result = await downloadWithHttps(datasetId, absoluteOutput, objects, {
      concurrency,
      onProgress: (filesDown, filesTotal, bytesDown, bytesTotal) => {
        process.stderr.write(
          `\r${chalk.cyan(formatProgressBar(filesDown, filesTotal, bytesDown, bytesTotal))}`,
        );
      },
    });

    process.stderr.write(`\r${" ".repeat(80)}\r`);

    if (!result.success) {
      console.log(chalk.red(`\nDownload incomplete: ${result.error}`));
      if (result.filesDownloaded > 0) {
        console.log(
          chalk.yellow(
            `${result.filesDownloaded} files succeeded. Re-run to retry failed files (resume support).`,
          ),
        );
      }
      console.log(`\n  Location: ${chalk.cyan(absoluteOutput)}`);
      process.exit(1);
    }

    console.log(
      chalk.green(`Downloaded ${result.filesDownloaded} files (${formatBytes(result.totalBytes)})`),
    );
  }

  console.log();
  console.log(chalk.green.bold("Download complete!"));
  console.log();
  console.log(`  Location: ${chalk.cyan(absoluteOutput)}`);
  console.log();
}

// Download command
datasetCommand
  .command("download")
  .description("Download a dataset from NEMAR or OpenNeuro")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104 or OpenNeuro ds000248)")
  .option("-o, --output <path>", "Output directory (default: ./<dataset-id>)")
  .option("-j, --jobs <number>", "Parallel download streams (default: 4)", "4")
  .option("--no-data", "Download metadata only (skip large data files)")
  .option("--resume", "Resume a partial download into an existing clone")
  .option("--update", "Pull only the version diff into an existing clone")
  .option("--prune", "With --update, drop annex objects that no longer exist upstream")
  .option("--subjects <list>", "Comma-separated subjects (e.g. sub-01,02)")
  .option("--sessions <list>", "Comma-separated sessions (e.g. ses-pre,post)")
  .option("--tasks <list>", "Comma-separated tasks (e.g. rest,nback)")
  .option("--runs <list>", "Comma-separated runs (e.g. 1,2 — matches run-1 and run-01)")
  .option("--datatypes <list>", "Comma-separated BIDS datatypes (e.g. eeg,emg)")
  .option("--include <globs>", "Comma-separated extra include globs")
  .option("--exclude <globs>", "Comma-separated exclude globs (e.g. derivatives/**)")
  .addHelpText(
    "after",
    `
Description:
  Download a BIDS dataset from NEMAR or OpenNeuro.

  NEMAR datasets (nm/on prefix) use git-annex for efficient data transfer
  with parallel streams and version tracking.

  OpenNeuro datasets (ds prefix) are downloaded as plain files from
  OpenNeuro's public S3 bucket. No account or git-annex required.

Requirements:
  - git-annex installed (NEMAR datasets only)
  - NEMAR account (for private datasets)
  - AWS CLI recommended for OpenNeuro downloads (falls back to HTTPS)

Examples:
  $ nemar dataset download nm000104              # Download NEMAR dataset
  $ nemar dataset download nm000104 -o ./data    # Custom output directory
  $ nemar dataset download nm000104 --no-data    # Metadata only (fast)
  $ nemar dataset download nm000104 -j 8         # More parallel streams
  $ nemar dataset download nm000104 --resume     # Resume partial download
  $ nemar dataset download nm000104 --update     # Pull only the version diff
  $ nemar dataset download nm000104 --update --prune  # Plus drop orphan objects
  $ nemar dataset download nm000104 --subjects sub-01,02      # Only these subjects
  $ nemar dataset download nm000104 --tasks rest --datatypes eeg  # Subset
  $ nemar dataset download nm000104 --exclude 'derivatives/**'    # Skip derivatives
  $ nemar dataset download ds000248              # Download from OpenNeuro`,
  )
  .action(async (datasetId, options) => {
    // OpenNeuro datasets (ds######) - check for NEMAR counterpart first
    const effectiveId = await resolveOpenNeuroId(datasetId);
    if (!effectiveId) {
      await handleOpenNeuroDownload(datasetId, options);
      return;
    }

    // Mutex / dependency checks for the new download flags.
    if (options.resume && options.update) {
      console.log(chalk.red("Error: --resume and --update are mutually exclusive."));
      process.exit(1);
    }
    if (options.prune && !options.update) {
      console.log(chalk.red("Error: --prune requires --update."));
      process.exit(1);
    }

    const filter = buildBidsFilterArgs({
      subjects: options.subjects,
      sessions: options.sessions,
      tasks: options.tasks,
      runs: options.runs,
      datatypes: options.datatypes,
      include: options.include,
      exclude: options.exclude,
    });

    if (filter.active && options.data === false) {
      console.log(
        chalk.red(
          "Error: --no-data cannot be combined with BIDS filters (--subjects, --tasks, etc.). Filters imply data download.",
        ),
      );
      process.exit(1);
    }

    // Step 1: Check prerequisites (fast, parallel checks)
    await checkPrerequisitesForCommand("download");

    let spinner = ora("Checking git-annex...").start();
    const prereqs = await checkDownloadPrerequisites();

    if (!prereqs.allPassed) {
      spinner.fail("Prerequisites check failed");
      console.log();
      for (const error of prereqs.errors) {
        console.log(chalk.red(`  - ${error}`));
      }
      process.exit(1);
    }

    spinner.succeed(`git-annex ${prereqs.gitAnnex.version}`);

    // Step 2: Get dataset info from backend
    spinner = ora(`Fetching dataset info for ${effectiveId}...`).start();

    let datasetInfo: Dataset;
    try {
      datasetInfo = await getDataset(effectiveId);
      spinner.succeed(`Found dataset: ${datasetInfo.name}`);
    } catch (error) {
      spinner.fail("Dataset not found");
      if (error instanceof ApiError) {
        console.log(chalk.red(`  ${error.message}`));
      } else {
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }

    // Step 3: Check if dataset is accessible
    if (!datasetInfo.github_repo) {
      console.log(chalk.red("Error: Dataset repository not available"));
      process.exit(1);
    }

    // Determine output path
    const outputPath = options.output || effectiveId;
    const absoluteOutput = resolve(outputPath);

    // Paths to fetch with `git annex get`. Undefined → full retrieval. Used by
    // --update to limit the get to changed annex keys.
    let updatePaths: string[] | undefined;

    // Resume / update modes share validation: target must exist, be a git-annex
    // clone of the requested dataset, with a clean working tree.
    const reuseMode = options.resume ? "resume" : options.update ? "update" : null;

    if (reuseMode) {
      if (!existsSync(absoluteOutput)) {
        console.log(chalk.red(`Error: --${reuseMode} target does not exist: ${absoluteOutput}`));
        console.log(chalk.dim(`Drop --${reuseMode} to perform a fresh clone.`));
        process.exit(1);
      }

      spinner = ora(`Validating ${reuseMode} target...`).start();

      if (!(await isGitAnnexDataset(absoluteOutput))) {
        spinner.fail("Not a git-annex dataset");
        console.log(chalk.red(`  ${absoluteOutput} is not a git-annex repository.`));
        console.log(chalk.dim(`--${reuseMode} requires a previous clone of the same dataset.`));
        process.exit(1);
      }

      const existingId = await getDatasetIdFromRemote(absoluteOutput);
      if (existingId !== effectiveId) {
        spinner.fail("Dataset ID mismatch");
        console.log(
          chalk.red(
            `  Expected ${effectiveId}, but ${absoluteOutput} is a clone of ${existingId ?? "an unknown repo"}.`,
          ),
        );
        process.exit(1);
      }

      const dirtyCheck = await isWorkingTreeDirty(absoluteOutput);
      if (dirtyCheck.error) {
        spinner.fail("Could not check working tree status");
        console.log(chalk.red(`  ${dirtyCheck.error}`));
        process.exit(1);
      }
      if (dirtyCheck.dirty) {
        spinner.fail("Working tree is dirty");
        console.log(chalk.red(`  Refusing to ${reuseMode} with uncommitted local changes.`));
        console.log(chalk.dim("  Commit, stash, or discard them first."));
        process.exit(1);
      }

      // Refresh remote refs so we can compare versions and (for update) merge.
      const fetchResult = await gitFetchOrigin(absoluteOutput);
      if (!fetchResult.success) {
        spinner.fail("Failed to fetch remote refs");
        console.log(chalk.red(`  ${fetchResult.error}`));
        process.exit(1);
      }

      const localRead = readLocalDatasetVersion(absoluteOutput);
      if (localRead.error) {
        console.log(chalk.yellow(`  Warning: ${localRead.error}`));
      }
      const remoteRead = await readRemoteHeadDatasetVersion(absoluteOutput);
      for (const w of remoteRead.warnings) {
        console.log(chalk.yellow(`  Warning: ${w}`));
      }
      const localVersion = localRead.version;
      const remoteVersion = remoteRead.version;

      if (options.resume) {
        if (localVersion && remoteVersion && localVersion !== remoteVersion) {
          spinner.fail("Local clone is behind upstream");
          console.log(
            chalk.red(`  Local version: ${localVersion} | Remote HEAD: ${remoteVersion}`),
          );
          console.log(
            chalk.dim("  Run `nemar dataset download <id> --update` to pull the version diff."),
          );
          process.exit(1);
        }
        spinner.succeed(`Resume target verified: ${effectiveId}`);
      } else {
        // --update path
        if (localVersion && remoteVersion && localVersion === remoteVersion) {
          spinner.succeed(`Already up to date (${localVersion})`);
          process.exit(0);
        }
        spinner.succeed(`Update plan: ${localVersion ?? "unknown"} → ${remoteVersion ?? "HEAD"}`);

        if (localVersion && remoteVersion) {
          spinner = ora("Computing version diff from manifests...").start();
          try {
            const [fromManifest, toManifest] = await Promise.all([
              getManifest(effectiveId, localVersion),
              getManifest(effectiveId, remoteVersion),
            ]);
            const diff = diffManifests(fromManifest, toManifest);
            spinner.succeed(
              `Diff: +${diff.added.length} added, ~${diff.changed.length} changed, -${diff.removed.length} removed`,
            );
            updatePaths = [...diff.added, ...diff.changed];
            if (updatePaths.length === 0) {
              console.log(
                chalk.dim("  No annex content changes between versions; metadata-only update."),
              );
            }
          } catch (err) {
            const message = (err as Error).message;
            spinner.warn(`Manifest diff unavailable: ${message}`);
            if (/401|403|unauthor/i.test(message)) {
              console.log(
                chalk.yellow("  Looks like an auth issue. Run `nemar auth status` to verify."),
              );
            } else if (!/404|not found/i.test(message)) {
              console.log(
                chalk.yellow("  Unexpected manifest error. Please report if this recurs."),
              );
            }
            console.log(
              chalk.dim("  Falling back to full git annex get (skips already-present files)."),
            );
            updatePaths = undefined;
          }
        }

        // Refuse on git-annex adjusted branches: a normal git merge corrupts
        // the adjusted view. Users on adjusted clones should run `git annex
        // sync` (or rename their default branch) before --update.
        const localBranch = await getCurrentBranch(absoluteOutput);
        if (localBranch?.startsWith("adjusted/")) {
          console.log(
            chalk.red(
              `  --update is not supported on git-annex adjusted branches (${localBranch}).`,
            ),
          );
          console.log(
            chalk.dim(
              "  Run `git -C <clone> annex sync` to bring the clone onto a normal branch first.",
            ),
          );
          process.exit(1);
        }

        spinner = ora("Resolving remote tracking branch...").start();
        const upstreamRef = await resolveUpstreamRef(absoluteOutput);
        if (!upstreamRef.ref) {
          spinner.fail("Cannot resolve remote tracking branch");
          console.log(chalk.red(`  ${upstreamRef.error ?? "no upstream ref found"}`));
          process.exit(1);
        }
        spinner.text = `Fast-forwarding to ${upstreamRef.ref}...`;
        const mergeResult = await gitMergeFastForward(absoluteOutput, upstreamRef.ref);
        if (!mergeResult.success) {
          spinner.fail("Cannot fast-forward (local has diverging commits)");
          console.log(chalk.red(`  ${mergeResult.error}`));
          console.log(
            chalk.dim("  Use `nemar dataset update` (PR workflow) to push local changes first."),
          );
          process.exit(1);
        }
        spinner.succeed(`Merged ${upstreamRef.ref}`);
      }
    } else if (existsSync(absoluteOutput)) {
      console.log(chalk.red(`Error: Output path already exists: ${absoluteOutput}`));
      console.log(
        "Remove or rename the existing directory, or pass --resume / --update to reuse it.",
      );
      process.exit(1);
    }

    console.log();
    const planLabel = options.update
      ? "Update Plan:"
      : options.resume
        ? "Resume Plan:"
        : "Download Plan:";
    console.log(chalk.bold(planLabel));
    console.log(`  Dataset: ${datasetInfo.name} (${effectiveId})`);
    console.log(`  Output: ${absoluteOutput}`);
    console.log(`  Data files: ${options.data === false ? "metadata only" : "included"}`);
    if (options.data !== false) {
      console.log(`  Parallel jobs: ${options.jobs}`);
    }
    if (options.update && updatePaths && updatePaths.length > 0) {
      console.log(`  Files to fetch: ${updatePaths.length}`);
    }
    if (filter.active) {
      for (const line of filter.summary) {
        console.log(`  Filter ${line}`);
      }
    }
    console.log();

    // Step 4: Clone the dataset (metadata) — skipped on resume / update.
    if (!reuseMode) {
      const repoUrl = `https://github.com/${datasetInfo.github_repo}.git`;
      spinner = ora("Cloning metadata from GitHub...").start();

      const cloneResult = await cloneDataset(repoUrl, absoluteOutput);
      if (!cloneResult.success) {
        spinner.fail("Failed to clone dataset");
        console.log(chalk.red(`  ${cloneResult.error}`));
        process.exit(1);
      }

      spinner.succeed("Metadata cloned");
    }

    // For private datasets, fetch temporary S3 download credentials
    let downloadCreds: Awaited<ReturnType<typeof requestDownloadCredentials>> | null = null;
    if (datasetInfo.visibility !== "public") {
      spinner = ora("Requesting download credentials...").start();
      try {
        downloadCreds = await requestDownloadCredentials(effectiveId);
        spinner.succeed("Download credentials received (2h expiry)");
      } catch (error) {
        spinner.fail("Failed to get download credentials");
        console.log(chalk.red(`  ${(error as Error).message}`));
        console.log(
          chalk.dim("Private datasets require authentication. Run 'nemar auth login' first."),
        );
        process.exit(1);
      }
    }

    const s3Creds = downloadCreds ? toS3Credentials(downloadCreds.credentials) : undefined;

    // Enable S3 remote if available (new datasets have it; old ones use web URLs)
    const s3Enable = await enableS3Remote(absoluteOutput, "nemar-s3", s3Creds);
    if (s3Enable.enabled) {
      console.log(chalk.dim("  S3 remote enabled for data downloads"));
    } else if (!s3Enable.success) {
      console.log(chalk.yellow(`  Warning: Could not enable S3 remote: ${s3Enable.error}`));
    }

    // Step 5: Get data files with progress (unless --no-data)
    const skipGet =
      options.data === false || (options.update && updatePaths && updatePaths.length === 0);
    if (skipGet) {
      if (options.data === false) {
        console.log(chalk.dim("Skipping data files (--no-data flag)"));
      }
    } else {
      console.log(chalk.bold(`Downloading data files (${options.jobs} parallel streams)...`));

      const tracker = new DownloadProgressTracker();

      const getResult = await getDatasetData(absoluteOutput, {
        jobs: Number.parseInt(options.jobs, 10),
        credentials: s3Creds,
        paths: updatePaths,
        extraArgs: filter.active ? filter.args : undefined,
        onProgress: (line) => tracker.processLine(line),
      });

      if (!getResult.success) {
        tracker.finish(0);
        console.log(chalk.red(`Failed to download data files: ${getResult.error}`));
        console.log(chalk.dim("The dataset was cloned but data files are not available locally."));
        console.log(chalk.dim(`You can try again with: cd ${absoluteOutput} && nemar dataset get`));
        if (downloadCreds) {
          await clearAnnexCredentials(absoluteOutput);
        }
        process.exit(1);
      }

      tracker.finish(getResult.filesDownloaded || 0);
      console.log(chalk.green(`Data downloaded (${getResult.filesDownloaded || 0} files)`));
    }

    // --prune: drop annex objects that are no longer referenced by any branch
    // (typically files removed in the upstream version).
    if (options.update && options.prune) {
      spinner = ora("Pruning orphan annex objects...").start();
      const pruneResult = await dropUnusedAnnexObjects(absoluteOutput);
      if (pruneResult.success) {
        spinner.succeed(`Pruned ${pruneResult.dropped ?? 0} unused annex objects`);
      } else {
        spinner.warn(`Prune skipped: ${pruneResult.error}`);
      }
    }

    // Clear cached S3 credentials so future operations request fresh tokens
    if (downloadCreds) {
      await clearAnnexCredentials(absoluteOutput);
    }

    // Step 6: Show completion info
    const localInfo = await getLocalDatasetInfo(absoluteOutput);

    console.log();
    const completionLabel = options.update
      ? "Update complete!"
      : options.resume
        ? "Resume complete!"
        : "Download complete!";
    console.log(chalk.green.bold(completionLabel));
    console.log();
    console.log(`  Location: ${chalk.cyan(absoluteOutput)}`);
    if (localInfo) {
      console.log(`  Files: ${localInfo.files}`);
      if (localInfo.size !== "unknown") {
        console.log(`  Size: ${localInfo.size}`);
      }
      if (localInfo.missingFiles > 0) {
        console.log(
          chalk.dim(`  Missing files: ${localInfo.missingFiles} (use 'git annex get' to download)`),
        );
      }
    }
    console.log();
    console.log(chalk.dim("To get additional data:"));
    console.log(chalk.dim(`  cd ${absoluteOutput} && git annex get <path>`));
  });

// Status command
datasetCommand
  .command("status")
  .description("Check status of a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option("--json", "Output as JSON for scripting")
  .addHelpText(
    "after",
    `
Description:
  Show detailed information about a NEMAR dataset including owner,
  creation date, GitHub repository, and DOI information.

Examples:
  $ nemar dataset status nm000104
  $ nemar dataset status nm000104 --json | jq '.concept_doi'`,
  )
  .action(async (datasetId, options) => {
    const spinner = ora(`Fetching dataset info for ${datasetId}...`).start();

    let datasetInfo: Dataset;
    try {
      datasetInfo = await getDataset(datasetId);
      spinner.stop();
    } catch (error) {
      spinner.fail("Dataset not found");
      if (error instanceof ApiError) {
        console.log(chalk.red(`  ${error.message}`));
      } else {
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }

    // JSON output
    if (options.json) {
      console.log(JSON.stringify(datasetInfo, null, 2));
      return;
    }

    // Human-readable output
    console.log();
    console.log(chalk.bold(`Dataset: ${datasetInfo.dataset_id}`));
    console.log();
    console.log(`  Name:        ${datasetInfo.name}`);
    console.log(`  Owner:       ${datasetInfo.owner_username}`);
    console.log(`  Status:      ${colorizeStatus(datasetInfo.status)}`);
    console.log(`  Created:     ${new Date(datasetInfo.created_at).toLocaleDateString()}`);

    if (datasetInfo.description) {
      console.log(`  Description: ${datasetInfo.description}`);
    }

    if (datasetInfo.github_repo) {
      console.log(`  GitHub:      https://github.com/${datasetInfo.github_repo}`);
    }

    if (datasetInfo.concept_doi) {
      console.log(`  DOI:         https://doi.org/${datasetInfo.concept_doi}`);
    }

    console.log();
    console.log(chalk.dim("To download this dataset:"));
    console.log(chalk.dim(`  nemar dataset download ${datasetId}`));
  });

/**
 * If datasetId is an OpenNeuro ds ID, check whether NEMAR has a copy and
 * prompt the user to use it. Returns the NEMAR dataset_id if accepted,
 * the original datasetId for non-OpenNeuro IDs, or null if the user
 * declined (meaning the caller should fall back to OpenNeuro download).
 */
async function resolveOpenNeuroId(datasetId: string): Promise<string | null> {
  if (!isOpenNeuroDatasetId(datasetId)) {
    return datasetId;
  }

  // Only catch network/API errors; let prompt errors (Ctrl+C) propagate
  let resolved: Awaited<ReturnType<typeof resolveSourceId>> | null = null;
  try {
    resolved = await resolveSourceId(datasetId);
  } catch (err) {
    console.log(chalk.dim(`Could not check NEMAR availability: ${(err as Error).message}`));
    return null;
  }

  if (!resolved?.found || !resolved.dataset_id) {
    return null;
  }

  console.log();
  console.log(
    chalk.green(`This dataset is available on NEMAR as ${chalk.bold(resolved.dataset_id)}`),
  );
  console.log(chalk.dim("NEMAR provides git-annex version tracking and selective file download."));

  const { useNemarBackend } = await inquirer.prompt([
    {
      type: "confirm",
      name: "useNemarBackend",
      message: `Download from NEMAR (${resolved.dataset_id}) instead of OpenNeuro?`,
      default: true,
    },
  ]);

  return useNemarBackend ? resolved.dataset_id : null;
}

/**
 * Colorize dataset status for display
 */
function colorizeStatus(status: string): string {
  switch (status.toLowerCase()) {
    case "published":
      return chalk.green(status);
    case "active":
      return chalk.blue(status);
    case "archived":
      return chalk.dim(status);
    case "pending":
      return chalk.yellow(status);
    default:
      return status;
  }
}

// Shared logic for rendering dataset tables
function renderDatasetTable(
  datasets: Dataset[],
  pagination: { limit: number; offset: number; totalCount: number },
) {
  const { offset, totalCount } = pagination;
  const pageStart = offset + 1;
  const pageEnd = offset + datasets.length;
  const pageInfo =
    totalCount > datasets.length ? `${pageStart}-${pageEnd} of ${totalCount}` : `${totalCount}`;

  console.log();
  console.log(chalk.bold(`Datasets (${pageInfo}):`));
  console.log();

  const getId = (d: Dataset) => d.dataset_id || (d as unknown as { id?: string }).id || "";
  const idWidth = Math.max(10, ...datasets.map((d) => getId(d).length));
  const nameWidth = Math.min(30, Math.max(10, ...datasets.map((d) => d.name.length)));
  const modWidth = 10;
  const subjWidth = 8;
  const ownerWidth = Math.max(8, ...datasets.map((d) => (d.owner_username || "-").length));

  const header = [
    "ID".padEnd(idWidth),
    "Name".padEnd(nameWidth),
    "Modality".padEnd(modWidth),
    "Subj".padEnd(subjWidth),
    "Owner".padEnd(ownerWidth),
    "Status",
  ].join("  ");
  console.log(chalk.dim(header));
  console.log(chalk.dim("-".repeat(header.length)));

  for (const dataset of datasets) {
    const id = getId(dataset);
    const name =
      dataset.name.length > nameWidth
        ? `${dataset.name.substring(0, nameWidth - 3)}...`
        : dataset.name;
    const modality = (dataset.modalities || "").substring(0, modWidth);
    const subjects = dataset.participants ? String(dataset.participants) : "-";
    const owner = dataset.owner_username || "-";

    // Discrepancy indicators:
    // * = managed (on GitHub) but not synced to nemar.org
    // italic/dim = catalog-only (on nemar.org but not on GitHub)
    let statusIndicator = "";
    if (dataset.source_type === "managed" && !dataset.nemar_sync_status) {
      statusIndicator = chalk.yellow("*"); // On GitHub, not synced
    } else if (dataset.source_type === "managed" && dataset.nemar_sync_status === "failed") {
      statusIndicator = chalk.red("!"); // Sync failed
    }

    const visLabel = dataset.visibility === "public" ? chalk.green("pub") : chalk.yellow("prv");

    let idDisplay: string;
    if (dataset.source_type === "catalog") {
      // Catalog-only: dim to indicate not on GitHub
      idDisplay = chalk.dim(id.padEnd(idWidth));
    } else {
      idDisplay = chalk.cyan(id.padEnd(idWidth));
    }

    const nameDisplay = dataset.source_type === "catalog" ? chalk.dim(name) : name;

    const row = [
      idDisplay,
      nameDisplay.padEnd(
        nameWidth + (dataset.source_type === "catalog" ? chalk.dim("").length : 0),
      ),
      modality.padEnd(modWidth),
      subjects.padEnd(subjWidth),
      owner.padEnd(ownerWidth),
      `${visLabel} ${statusIndicator}`.trim(),
    ].join("  ");
    console.log(row);
  }

  console.log();
  // Pagination footer
  if (totalCount > pageEnd) {
    const currentPage = Math.floor(offset / pagination.limit) + 1;
    const totalPages = Math.ceil(totalCount / pagination.limit);
    console.log(
      chalk.dim(
        `Page ${currentPage}/${totalPages}. Next: nemar dataset list --page ${currentPage + 1}`,
      ),
    );
  }
  console.log(
    chalk.dim(
      `  * = not synced to nemar.org    ${chalk.dim("dim")} = catalog-only (not on GitHub)`,
    ),
  );
  console.log(chalk.dim("For details: nemar dataset status <dataset-id>"));
  console.log(chalk.dim("Search: nemar dataset search <query>"));
}

// List command
datasetCommand
  .command("list")
  .description("List datasets on NEMAR (full catalog)")
  .option("--mine", "List only your datasets (both private and public)")
  .option("--owner <username>", "List datasets owned by a specific user")
  .option("--search <query>", "Search by name, description, authors, or tasks")
  .option("--modality <type>", "Filter by modality (eeg, emg, meg, etc.)")
  .option("--author <name>", "Filter by author name")
  .option("--task <name>", "Filter by task name")
  .option("--doi", "Show only datasets with DOIs")
  .option("--recent [days]", "Show recently published datasets")
  .option("--sort <order>", "Sort: newest, oldest, name, participants, size", "newest")
  .option("--json", "Output as JSON for scripting")
  .option("-n, --limit <n>", "Results per page (default: 20, max: 200)", "20")
  .option("--page <n>", "Page number (starts at 1)")
  .option("--offset <n>", "Skip this many results (alternative to --page)")
  .option("--all", "Show all results (up to 200)")
  .addHelpText(
    "after",
    `
Description:
  Lists the full NEMAR catalog, including legacy datasets from nemar.org
  and datasets managed via nemar-cli. Shows 20 results per page by default.

  With --mine: shows only YOUR datasets (requires authentication).
  With --owner <username>: shows datasets owned by a specific user.

Pagination:
  -n, --limit <n>    Results per page (default: 20, max: 200)
  --page <n>         Page number (e.g., --page 2 for results 21-40)
  --offset <n>       Skip N results (e.g., --offset 40 for results 41+)
  --all              Show all results (up to 200)

Display Indicators:
  ${chalk.cyan("cyan ID")}     Managed dataset (on GitHub)
  ${chalk.dim("dim ID")}      Catalog-only (nemar.org, not on GitHub)
  ${chalk.yellow("*")}           On GitHub but not synced to nemar.org
  ${chalk.red("!")}           Sync to nemar.org failed

Examples:
  $ nemar dataset list                         # First 20 datasets
  $ nemar dataset list --page 2                # Next 20 datasets
  $ nemar dataset list -n 50                   # 50 per page
  $ nemar dataset list --all                   # All results (up to 200)
  $ nemar dataset list --mine                  # Your datasets
  $ nemar dataset list --owner yahya           # Datasets by 'yahya'
  $ nemar dataset list --modality eeg          # EEG datasets only
  $ nemar dataset list --search "motor"        # Search by keyword
  $ nemar dataset list --doi --sort size       # Published, by size
  $ nemar dataset search "resting state EEG"   # Semantic search`,
  )
  .action(async (options) => {
    if (options.mine && options.owner) {
      console.log(chalk.red("Error: --mine and --owner cannot be used together"));
      console.log("Use --mine for your datasets, or --owner <username> for another user's.");
      process.exit(1);
    }

    if (options.mine && !isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      console.log("Run 'nemar auth login' to see your datasets");
      process.exit(1);
    }

    // Parse pagination
    const limit = options.all ? 200 : Math.min(Number.parseInt(options.limit, 10) || 20, 200);
    let offset = 0;
    if (options.page) {
      const page = Math.max(Number.parseInt(options.page, 10) || 1, 1);
      offset = (page - 1) * limit;
    } else if (options.offset) {
      offset = Math.max(Number.parseInt(options.offset, 10) || 0, 0);
    }

    const spinner = ora("Fetching datasets...").start();

    let response: DatasetsListResponse;
    try {
      response = await listDatasets({
        mine: !!options.mine,
        search: options.search,
        modality: options.modality,
        author: options.author,
        task: options.task,
        hasDoi: !!options.doi,
        recent: options.recent ? Number.parseInt(options.recent, 10) || 30 : undefined,
        sort: options.sort,
        limit,
        offset,
        owner: options.owner,
      });
      spinner.stop();
    } catch (error) {
      spinner.fail("Failed to fetch datasets");
      if (error instanceof ApiError) {
        console.log(chalk.red(`  ${error.message}`));
      } else {
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }

    const datasets = response.datasets;
    const totalCount = response.total_count ?? response.count;

    if (options.json) {
      console.log(JSON.stringify({ datasets, total_count: totalCount, limit, offset }, null, 2));
      return;
    }

    if (datasets.length === 0) {
      console.log();
      if (options.mine) {
        console.log(chalk.yellow("You don't have any datasets yet."));
        console.log(chalk.dim("Create one with: nemar dataset upload <path>"));
      } else if (options.owner) {
        console.log(chalk.yellow(`No datasets found for user '${options.owner}'.`));
      } else if (options.search || options.modality || options.author) {
        console.log(chalk.yellow("No datasets match your filters."));
        console.log(chalk.dim("Try broader search terms or remove filters."));
      } else {
        console.log(chalk.yellow("No datasets found."));
      }
      return;
    }

    renderDatasetTable(datasets, { limit, offset, totalCount });
  });

// Search command (semantic search via Vectorize)
datasetCommand
  .command("search <query>")
  .description("Search datasets using semantic matching")
  .option("--modality <type>", "Filter by modality (eeg, emg, meg, etc.)")
  .option("--json", "Output as JSON for scripting")
  .option("--limit <n>", "Limit results (default: 20)", "20")
  .addHelpText(
    "after",
    `
Description:
  Performs semantic search across the NEMAR dataset catalog. Unlike
  --search on the list command (which uses exact text matching), this
  uses AI embeddings to find conceptually similar datasets.

  For example, "brain signals during sleep" will match datasets about
  "EEG recordings in sleep studies" even if those exact words don't appear.

Examples:
  $ nemar dataset search "motor imagery EEG"
  $ nemar dataset search "resting state" --modality eeg
  $ nemar dataset search "sleep spindles" --json`,
  )
  .action(async (query: string, options) => {
    const spinner = ora("Searching datasets...").start();

    try {
      const response = await searchDatasets(query, {
        modality: options.modality,
        limit: Number.parseInt(options.limit, 10),
      });
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }

      if (response.results.length === 0) {
        console.log();
        console.log(chalk.yellow("No datasets match your search."));
        console.log(
          chalk.dim("Try different search terms or use 'nemar dataset list' for browsing."),
        );
        return;
      }

      console.log();
      console.log(
        chalk.bold(
          `Search results for "${query}" (${response.results.length} found, ${response.method}):`,
        ),
      );
      console.log();

      const idWidth = Math.max(10, ...response.results.map((r) => r.id.length));
      const nameWidth = Math.min(35, Math.max(10, ...response.results.map((r) => r.name.length)));
      const modWidth = 10;
      const subjWidth = 6;

      const header = [
        "Score".padEnd(5),
        "ID".padEnd(idWidth),
        "Name".padEnd(nameWidth),
        "Modality".padEnd(modWidth),
        "Subj".padEnd(subjWidth),
      ].join("  ");
      console.log(chalk.dim(header));
      console.log(chalk.dim("-".repeat(header.length)));

      for (const result of response.results) {
        const name =
          result.name.length > nameWidth
            ? `${result.name.substring(0, nameWidth - 3)}...`
            : result.name;
        const scoreColor =
          result.score >= 0.8 ? chalk.green : result.score >= 0.5 ? chalk.yellow : chalk.dim;

        const row = [
          scoreColor(String(result.score).padEnd(5)),
          chalk.cyan(result.id.padEnd(idWidth)),
          name.padEnd(nameWidth),
          (result.modalities || "-").substring(0, modWidth).padEnd(modWidth),
          (result.participants ? String(result.participants) : "-").padEnd(subjWidth),
        ].join("  ");
        console.log(row);
      }

      console.log();
      console.log(chalk.dim("For details: nemar dataset status <dataset-id>"));
    } catch (error) {
      spinner.fail("Search failed");
      if (error instanceof ApiError) {
        console.log(chalk.red(`  ${error.message}`));
      } else {
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }
  });

// Release command - create a version bump PR
datasetCommand
  .command("release")
  .description("Create a version bump PR for a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option("--type <type>", "Bump type: patch, minor, or major")
  .option("--version <version>", "Explicit version (e.g., 2.0.0)")
  .option("--dir <path>", "Use existing local clone instead of cloning")
  .option("--monitor", "Watch CI checks and offer to merge")
  .option(YES_OPTION, YES_DESCRIPTION)
  .addHelpText(
    "after",
    `
Description:
  Create a pull request that bumps the dataset version in
  dataset_description.json. The PR triggers CI checks (BIDS validation,
  version check). On merge, GitHub Actions tags the release and
  publishes a version DOI (if a concept DOI exists).

Examples:
  $ nemar dataset release nm000104 --type patch
  $ nemar dataset release nm000104 --version 2.0.0
  $ nemar dataset release nm000104                   # interactive prompt`,
  )
  .action(
    async (
      datasetId: string,
      options: {
        type?: string;
        version?: string;
        dir?: string;
        monitor?: boolean;
        yes?: boolean;
      },
    ) => {
      if (!isAuthenticated()) {
        console.log(chalk.red("Error: Not authenticated"));
        console.log("Run 'nemar auth login' first");
        process.exit(1);
      }

      await checkPrerequisitesForCommand("release");

      // Fetch dataset info
      const infoSpinner = ora("Fetching dataset info...").start();
      let dataset: Dataset;
      try {
        dataset = await getDataset(datasetId);
        infoSpinner.succeed(`Dataset: ${dataset.name || datasetId}`);
      } catch (error) {
        if (error instanceof ApiError) {
          infoSpinner.fail(error.message);
        } else {
          infoSpinner.fail("Failed to fetch dataset");
        }
        process.exit(1);
      }

      if (!dataset.github_repo) {
        console.log(chalk.red("Error: Dataset has no GitHub repository"));
        process.exit(1);
      }

      // Fetch version history (required for correct version bumping)
      let currentVersion: string;
      try {
        const history = await getVersionHistory(datasetId);
        currentVersion = history.current_version;
        console.log(`  Current version: ${chalk.cyan(currentVersion)}`);
        if (history.versions.length > 0) {
          console.log(`  Version DOIs: ${history.versions.length}`);
          for (const v of history.versions.slice(0, 3)) {
            console.log(`    ${v.version} - ${chalk.dim(v.doi)}`);
          }
          if (history.versions.length > 3) {
            console.log(chalk.dim(`    ... and ${history.versions.length - 3} more`));
          }
        }
      } catch (err) {
        const detail = err instanceof ApiError ? `${err.statusCode}: ${err.message}` : String(err);
        console.log(chalk.red(`Error: Could not fetch version history (${detail})`));
        console.log("  Cannot determine current version. Ensure the backend is reachable.");
        process.exit(1);
      }

      // Determine new version
      let newVersion: string;
      if (options.version) {
        if (!isValidStableVersion(options.version)) {
          console.log(chalk.red(`Error: Invalid version: ${options.version}`));
          console.log("  Expected format: X.Y.Z (e.g., 2.0.0)");
          process.exit(1);
        }
        newVersion = options.version.replace(/^v/, "");
      } else if (options.type) {
        const bumpType = options.type as "patch" | "minor" | "major";
        if (!["patch", "minor", "major"].includes(bumpType)) {
          console.log(chalk.red(`Error: Invalid bump type: ${options.type}`));
          console.log("  Expected: patch, minor, or major");
          process.exit(1);
        }
        newVersion = bumpVersion(currentVersion, bumpType);
      } else {
        // Interactive prompt
        const parsed = parseVersion(currentVersion);
        if (!parsed) {
          console.log(chalk.red(`Error: Cannot parse current version: ${currentVersion}`));
          process.exit(1);
        }

        const choices = [
          {
            name: `patch  ${currentVersion} -> ${bumpVersion(currentVersion, "patch")}`,
            value: "patch",
          },
          {
            name: `minor  ${currentVersion} -> ${bumpVersion(currentVersion, "minor")}`,
            value: "minor",
          },
          {
            name: `major  ${currentVersion} -> ${bumpVersion(currentVersion, "major")}`,
            value: "major",
          },
          { name: "custom version", value: "custom" },
        ];

        const { bumpType } = await inquirer.prompt([
          {
            type: "list",
            name: "bumpType",
            message: "Select version bump type:",
            choices,
          },
        ]);

        if (bumpType === "custom") {
          const { customVersion } = await inquirer.prompt([
            {
              type: "input",
              name: "customVersion",
              message: "Enter version (X.Y.Z):",
              validate: (v: string) =>
                isValidStableVersion(v) || "Invalid format. Use X.Y.Z (e.g., 2.0.0)",
            },
          ]);
          newVersion = customVersion.replace(/^v/, "");
        } else {
          newVersion = bumpVersion(currentVersion, bumpType);
        }
      }

      console.log();
      console.log(
        `  ${chalk.bold("Version bump:")} ${currentVersion} -> ${chalk.green(newVersion)}`,
      );

      // Confirm
      const result = await confirm(`Create release PR for ${datasetId} v${newVersion}?`, {
        yes: options.yes,
      });
      if (result !== "confirmed") {
        console.log("Cancelled.");
        return;
      }

      // Determine working directory
      let workDir: string;
      let needsClone = true;

      if (options.dir) {
        if (!existsSync(options.dir)) {
          console.log(chalk.red(`Error: Directory not found: ${options.dir}`));
          process.exit(1);
        }
        workDir = resolve(options.dir);
        needsClone = false;
      } else {
        workDir = mkdtempSync(join(tmpdir(), `nemar-release-${datasetId}-`));
      }

      // Clone if needed
      if (needsClone) {
        const cloneUrl = `https://github.com/${dataset.github_repo}.git`;
        const cloneSpinner = ora("Cloning dataset...").start();
        const cloneResult = await cloneDataset(cloneUrl, workDir);
        if (!cloneResult.success) {
          cloneSpinner.fail(`Clone failed: ${cloneResult.error}`);
          process.exit(1);
        }
        cloneSpinner.succeed("Cloned dataset");
      }

      // Create release branch
      const branchName = `release/v${newVersion}`;
      const branchSpinner = ora("Creating release branch...").start();

      const branchProc = spawn({
        cmd: ["git", "checkout", "-b", branchName],
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await branchProc.exited) !== 0) {
        const stderr = await new Response(branchProc.stderr).text();
        branchSpinner.fail(`Failed to create branch: ${stderr.trim()}`);
        process.exit(1);
      }
      branchSpinner.succeed(`Created branch: ${branchName}`);

      // Update dataset_description.json
      const descPath = join(workDir, "dataset_description.json");
      if (!existsSync(descPath)) {
        console.log(chalk.red("Error: dataset_description.json not found in repo"));
        process.exit(1);
      }

      let descContent: Record<string, unknown>;
      try {
        descContent = JSON.parse(readFileSync(descPath, "utf-8"));
      } catch (err) {
        if (err instanceof SyntaxError) {
          console.log(chalk.red("Error: dataset_description.json contains invalid JSON"));
        } else {
          console.log(chalk.red(`Error: Could not read dataset_description.json: ${err}`));
        }
        process.exit(1);
      }
      descContent.Version = newVersion;
      writeFileSync(descPath, `${JSON.stringify(descContent, null, 2)}\n`);

      // Commit
      const commitSpinner = ora("Committing version bump...").start();
      const addProc = spawn({
        cmd: ["git", "add", "dataset_description.json"],
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await addProc.exited) !== 0) {
        const stderr = await new Response(addProc.stderr).text();
        commitSpinner.fail(`Failed to stage changes: ${stderr.trim()}`);
        process.exit(1);
      }

      const commitProc = spawn({
        cmd: ["git", "commit", "-m", `Bump version to ${newVersion}`],
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await commitProc.exited) !== 0) {
        const stderr = await new Response(commitProc.stderr).text();
        commitSpinner.fail(`Commit failed: ${stderr.trim()}`);
        process.exit(1);
      }
      commitSpinner.succeed("Committed version bump");

      // Push branch
      const pushSpinner = ora("Pushing branch...").start();
      const pushResult = await pushBranch(workDir, branchName);
      if (!pushResult.success) {
        pushSpinner.fail(`Push failed: ${pushResult.error}`);
        process.exit(1);
      }
      pushSpinner.succeed("Pushed branch");

      // Create PR via gh CLI
      let prCreated = false;
      const prSpinner = ora("Creating pull request...").start();
      try {
        const prTitle = `Release v${newVersion}`;
        const prBody = `## Version Bump\n\nBumps ${datasetId} from ${currentVersion} to ${newVersion}.\n\nOn merge, CI will:\n- Tag the release (v${newVersion})\n- Publish a version DOI (if concept DOI exists)`;

        const prProc = spawn({
          cmd: [
            "gh",
            "pr",
            "create",
            "--repo",
            dataset.github_repo,
            "--head",
            branchName,
            "--base",
            "main",
            "--title",
            prTitle,
            "--body",
            prBody,
          ],
          cwd: workDir,
          stdout: "pipe",
          stderr: "pipe",
        });

        const prUrl = (await new Response(prProc.stdout).text()).trim();
        if ((await prProc.exited) !== 0) {
          const stderr = await new Response(prProc.stderr).text();
          throw new Error(stderr.trim() || "gh pr create failed");
        }

        prCreated = true;
        prSpinner.succeed("Created pull request");
        console.log();
        console.log(`  ${chalk.cyan("PR:")} ${prUrl}`);
      } catch (prError) {
        prSpinner.fail("Failed to create PR");
        const errorMsg = prError instanceof Error ? prError.message : String(prError);
        console.log(chalk.red(`  ${errorMsg}`));
        if (errorMsg.includes("not found") || errorMsg.includes("command not found")) {
          console.log(chalk.yellow("  Install: brew install gh"));
        } else if (errorMsg.includes("auth") || errorMsg.includes("401")) {
          console.log(chalk.yellow("  Run: gh auth login"));
        }
        console.log(chalk.dim(`  Branch ${branchName} has been pushed. Create the PR manually.`));
      }

      // Monitor mode (only if PR was created successfully)
      if (options.monitor && prCreated) {
        console.log();
        console.log(chalk.dim("Monitoring CI checks..."));
        console.log(chalk.dim("  Press Ctrl+C to stop monitoring"));

        let attempts = 0;
        const maxAttempts = 60; // 10 minutes at 10s intervals

        while (attempts < maxAttempts) {
          await new Promise((r) => setTimeout(r, 10000));
          attempts++;

          const checkProc = spawn({
            cmd: ["gh", "pr", "checks", "--repo", dataset.github_repo, branchName],
            cwd: workDir,
            stdout: "pipe",
            stderr: "pipe",
          });
          const checkOutput = await new Response(checkProc.stdout).text();
          const checkExit = await checkProc.exited;

          if (checkExit === 0) {
            console.log(chalk.green("  All checks passed!"));

            const mergeResult = await confirm("Merge the PR?", { yes: options.yes });
            if (mergeResult === "confirmed") {
              const mergeProc = spawn({
                cmd: [
                  "gh",
                  "pr",
                  "merge",
                  "--repo",
                  dataset.github_repo,
                  branchName,
                  "--squash",
                  "--delete-branch",
                ],
                cwd: workDir,
                stdout: "pipe",
                stderr: "pipe",
              });
              const mergeExit = await mergeProc.exited;
              if (mergeExit === 0) {
                console.log(chalk.green("  PR merged successfully!"));
              } else {
                const mergeErr = await new Response(mergeProc.stderr).text();
                console.log(chalk.red(`  Merge failed: ${mergeErr.trim()}`));
              }
            }
            break;
          }

          // Check if any failed
          if (checkOutput.includes("fail") || checkOutput.includes("X")) {
            console.log(chalk.red("  Some checks failed:"));
            console.log(checkOutput);
            break;
          }

          process.stdout.write(chalk.dim("."));
        }

        if (attempts >= maxAttempts) {
          console.log(chalk.yellow("\n  Timed out waiting for checks."));
        }
      }

      if (needsClone) {
        console.log();
        console.log(chalk.dim(`Working directory: ${workDir}`));
        console.log(chalk.dim("You can delete this directory after the PR is merged."));
      }
    },
  );

// Update command - push data/metadata changes via PR
datasetCommand
  .command("update")
  .description("Push local changes to a dataset via PR")
  .argument("[path]", "Path to local dataset clone (default: current directory)")
  .option("--bump <type>", "Version bump type: patch, minor, or major", "patch")
  .option("--branch <name>", "Custom branch name")
  .option("-m, --message <msg>", "Commit message")
  .option("--monitor", "Watch CI checks and offer to merge")
  .option(YES_OPTION, YES_DESCRIPTION)
  .addHelpText(
    "after",
    `
Description:
  Push local changes (metadata or data files) to a dataset via a pull
  request. Automatically bumps the version, commits, pushes, and creates
  a PR. For data files (annexed), copies them to S3 via git-annex.

  Run this from inside a dataset clone, or pass the path as an argument.

Note:
  This is the recommended way to update public datasets. It creates a
  PR that must be reviewed before merging. For private datasets, you
  can also use 'nemar dataset push' for direct updates.

Examples:
  $ cd nm000104 && nemar dataset update
  $ nemar dataset update ./nm000104 --bump minor -m "Add new subjects"
  $ nemar dataset update --branch fix/metadata -m "Fix participant ages"`,
  )
  .action(
    async (
      path: string | undefined,
      options: {
        bump: string;
        branch?: string;
        message?: string;
        monitor?: boolean;
        yes?: boolean;
      },
    ) => {
      if (!isAuthenticated()) {
        console.log(chalk.red("Error: Not authenticated"));
        console.log("Run 'nemar auth login' first");
        process.exit(1);
      }

      await checkPrerequisitesForCommand("update");

      const workDir = resolve(path || ".");

      if (!existsSync(join(workDir, ".git"))) {
        console.log(chalk.red("Error: Not a git repository"));
        console.log("  Run this from inside a dataset clone, or pass the path.");
        process.exit(1);
      }

      // Detect dataset ID from remote
      const datasetId = await getDatasetIdFromRemote(workDir);
      if (!datasetId) {
        console.log(chalk.red("Error: Could not detect dataset ID from git remote"));
        process.exit(1);
      }

      console.log(`  Dataset: ${chalk.cyan(datasetId)}`);

      // Check we're on main branch
      const currentBranchName = await getCurrentBranch(workDir);
      if (currentBranchName !== "main") {
        console.log(
          chalk.yellow(`Warning: Currently on branch '${currentBranchName}', expected 'main'`),
        );
        const result = await confirm("Continue anyway?", { yes: options.yes });
        if (result !== "confirmed") {
          console.log("Cancelled.");
          return;
        }
      }

      // Check for changes
      const statusProc = spawn({
        cmd: ["git", "status", "--porcelain"],
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const statusOutput = (await new Response(statusProc.stdout).text()).trim();
      if ((await statusProc.exited) !== 0) {
        console.log(chalk.red("Error: Failed to check git status"));
        process.exit(1);
      }

      if (!statusOutput) {
        console.log(chalk.yellow("No changes detected."));
        console.log("  Make changes to the dataset files, then run this command again.");
        return;
      }

      // Categorize changes
      const lines = statusOutput.split("\n");
      const dataFiles: string[] = [];
      const metadataFiles: string[] = [];
      for (const line of lines) {
        const filePath = line.substring(3).trim();
        // Common neuroimaging data file extensions (typically git-annex managed)
        if (/\.(edf|bdf|set|fdt|nwb|eeg|vhdr|vmrk|cnt|mff|gz)$/i.test(filePath)) {
          dataFiles.push(filePath);
        } else {
          metadataFiles.push(filePath);
        }
      }

      console.log();
      if (metadataFiles.length > 0) {
        console.log(`  ${chalk.bold("Metadata files:")} ${metadataFiles.length}`);
        for (const f of metadataFiles.slice(0, 5)) {
          console.log(`    ${f}`);
        }
        if (metadataFiles.length > 5) {
          console.log(chalk.dim(`    ... and ${metadataFiles.length - 5} more`));
        }
      }
      if (dataFiles.length > 0) {
        console.log(`  ${chalk.bold("Data files:")} ${dataFiles.length}`);
        for (const f of dataFiles.slice(0, 5)) {
          console.log(`    ${f}`);
        }
        if (dataFiles.length > 5) {
          console.log(chalk.dim(`    ... and ${dataFiles.length - 5} more`));
        }
      }

      // Get dataset info for github_repo
      const infoSpinner = ora("Fetching dataset info...").start();
      let dataset: Dataset;
      try {
        dataset = await getDataset(datasetId);
        infoSpinner.succeed();
      } catch (error) {
        if (error instanceof ApiError) {
          infoSpinner.fail(error.message);
        } else {
          infoSpinner.fail("Failed to fetch dataset");
        }
        process.exit(1);
      }

      if (!dataset.github_repo) {
        console.log(chalk.red("Error: Dataset has no GitHub repository"));
        process.exit(1);
      }

      // Get current version (required for correct version bumping)
      let currentVersion: string;
      const versionDescPath = join(workDir, "dataset_description.json");
      if (!existsSync(versionDescPath)) {
        console.log(chalk.red("Error: dataset_description.json not found"));
        console.log("  This file is required for BIDS datasets.");
        process.exit(1);
      }
      try {
        const desc = JSON.parse(readFileSync(versionDescPath, "utf-8"));
        if (typeof desc.Version !== "string" || !desc.Version) {
          console.log(chalk.red("Error: No Version field in dataset_description.json"));
          console.log('  Set the Version field before updating (e.g., "Version": "1.0.0").');
          process.exit(1);
        }
        currentVersion = desc.Version;
      } catch (err) {
        if (err instanceof SyntaxError) {
          console.log(chalk.red("Error: dataset_description.json contains invalid JSON"));
        } else {
          console.log(chalk.red(`Error: Could not read dataset_description.json: ${err}`));
        }
        process.exit(1);
      }

      const bumpType = options.bump as "patch" | "minor" | "major";
      if (!["patch", "minor", "major"].includes(bumpType)) {
        console.log(chalk.red(`Error: Invalid bump type: ${options.bump}`));
        process.exit(1);
      }
      const newVersion = bumpVersion(currentVersion, bumpType);

      console.log(
        `  ${chalk.bold("Version bump:")} ${currentVersion} -> ${chalk.green(newVersion)}`,
      );

      // Confirm
      const confirmResult = await confirm(`Create update PR for ${datasetId}?`, {
        yes: options.yes,
      });
      if (confirmResult !== "confirmed") {
        console.log("Cancelled.");
        return;
      }

      // Create branch
      const timestamp = Date.now().toString(36);
      const branchName = options.branch || `update/${datasetId}-${timestamp}`;

      const branchSpinner = ora("Creating update branch...").start();
      const branchProc = spawn({
        cmd: ["git", "checkout", "-b", branchName],
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await branchProc.exited) !== 0) {
        const stderr = await new Response(branchProc.stderr).text();
        branchSpinner.fail(`Failed to create branch: ${stderr.trim()}`);
        process.exit(1);
      }
      branchSpinner.succeed(`Created branch: ${branchName}`);

      // Bump version in dataset_description.json (already validated above)
      const descPath = join(workDir, "dataset_description.json");
      let descContent: Record<string, unknown>;
      try {
        descContent = JSON.parse(readFileSync(descPath, "utf-8"));
      } catch (err) {
        if (err instanceof SyntaxError) {
          console.log(chalk.red("Error: dataset_description.json contains invalid JSON"));
        } else {
          console.log(chalk.red(`Error: Could not read dataset_description.json: ${err}`));
        }
        process.exit(1);
      }
      descContent.Version = newVersion;
      writeFileSync(descPath, `${JSON.stringify(descContent, null, 2)}\n`);

      // Stage all changes and commit
      const commitSpinner = ora("Committing changes...").start();
      const addProc = spawn({
        cmd: ["git", "add", "-A"],
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await addProc.exited) !== 0) {
        const stderr = await new Response(addProc.stderr).text();
        commitSpinner.fail(`Failed to stage changes: ${stderr.trim()}`);
        process.exit(1);
      }

      const commitMsg = options.message || `Update ${datasetId} to ${newVersion}`;
      const commitProc = spawn({
        cmd: ["git", "commit", "-m", commitMsg],
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await commitProc.exited) !== 0) {
        const stderr = await new Response(commitProc.stderr).text();
        commitSpinner.fail(`Commit failed: ${stderr.trim()}`);
        process.exit(1);
      }
      commitSpinner.succeed("Committed changes");

      // If data files exist and git-annex is available, copy to S3
      if (dataFiles.length > 0) {
        const annexCheck = spawn({
          cmd: ["git", "annex", "version"],
          cwd: workDir,
          stdout: "pipe",
          stderr: "pipe",
        });
        if ((await annexCheck.exited) === 0) {
          // Get STS credentials for S3 upload
          let s3Spinner = ora("Requesting upload credentials...").start();
          let updateCreds: Awaited<ReturnType<typeof requestUploadCredentials>> | null = null;
          try {
            updateCreds = await requestUploadCredentials(datasetId);
            s3Spinner.succeed("Upload credentials received");
          } catch (credError) {
            s3Spinner.fail(`Could not get upload credentials: ${errorDetail(credError)}`);
            console.log(chalk.yellow("  Data files will not be uploaded. Push manually after PR."));
          }

          if (updateCreds) {
            // Ensure S3 remote is configured (may not exist for pre-fix datasets)
            const s3Remotes = await getAnnexS3Remotes(workDir);
            if (s3Remotes.length === 0) {
              s3Spinner = ora("Configuring S3 remote...").start();
              const s3Config = await configureS3Remote(
                workDir,
                {
                  name: "nemar-s3",
                  bucket: updateCreds.s3.bucket,
                  prefix: `${datasetId}/objects`,
                  region: updateCreds.s3.region,
                  publicUrl: `https://${updateCreds.s3.bucket}.s3.${updateCreds.s3.region}.amazonaws.com`,
                },
                toS3Credentials(updateCreds.credentials),
              );
              if (!s3Config.success) {
                s3Spinner.warn(`Failed to configure S3 remote: ${s3Config.error}`);
                console.log(
                  chalk.yellow("  Data files will not be uploaded. Push manually after PR."),
                );
              } else {
                s3Spinner.succeed("S3 remote configured");
              }
            }

            // Only attempt upload if S3 remote is configured
            const s3RemotesAfterConfig = await getAnnexS3Remotes(workDir);
            if (s3RemotesAfterConfig.includes("nemar-s3")) {
              s3Spinner = ora("Uploading data files to S3...").start();
              const copyResult = await copyToAnnexRemote(
                workDir,
                "nemar-s3",
                4,
                toS3Credentials(updateCreds.credentials),
              );
              await clearAnnexCredentials(workDir);
              if (!copyResult.success) {
                s3Spinner.warn(`S3 upload issue: ${copyResult.error}`);
                console.log(chalk.yellow("  Data files may need manual upload after PR creation."));
              } else {
                s3Spinner.succeed(`Uploaded ${copyResult.filesCopied} data files to S3`);
              }
            }
          }
        } else {
          console.log(
            chalk.yellow("  git-annex not available; data files will be committed to git."),
          );
        }
      }

      // Push branch (and git-annex branch if it exists)
      const pushSpinner = ora("Pushing branch...").start();
      const pushResult = await pushBranch(workDir, branchName);
      if (!pushResult.success) {
        pushSpinner.fail(`Push failed: ${pushResult.error}`);
        process.exit(1);
      }

      // Also push git-annex branch if data files were uploaded
      if (dataFiles.length > 0) {
        const annexPush = spawn({
          cmd: ["git", "push", "origin", "git-annex"],
          cwd: workDir,
          stdout: "pipe",
          stderr: "pipe",
        });
        if ((await annexPush.exited) !== 0) {
          console.log(chalk.yellow("  Warning: Failed to push git-annex branch"));
        }
      }
      pushSpinner.succeed("Pushed branch");

      // Create PR via gh CLI
      let prCreated = false;
      const prSpinner = ora("Creating pull request...").start();
      try {
        const prTitle = options.message
          ? `${options.message} (v${newVersion})`
          : `Update ${datasetId} to v${newVersion}`;
        const fileList = [...metadataFiles, ...dataFiles].slice(0, 10).join("\n- ");
        const prBody = `## Dataset Update\n\nBumps ${datasetId} from ${currentVersion} to ${newVersion}.\n\n### Changed files\n- ${fileList}${lines.length > 10 ? `\n- ... and ${lines.length - 10} more` : ""}`;

        const prProc = spawn({
          cmd: [
            "gh",
            "pr",
            "create",
            "--repo",
            dataset.github_repo,
            "--head",
            branchName,
            "--base",
            "main",
            "--title",
            prTitle,
            "--body",
            prBody,
          ],
          cwd: workDir,
          stdout: "pipe",
          stderr: "pipe",
        });

        const prUrl = (await new Response(prProc.stdout).text()).trim();
        if ((await prProc.exited) !== 0) {
          const stderr = await new Response(prProc.stderr).text();
          throw new Error(stderr.trim() || "gh pr create failed");
        }

        prCreated = true;
        prSpinner.succeed("Created pull request");
        console.log();
        console.log(`  ${chalk.cyan("PR:")} ${prUrl}`);
      } catch (prError) {
        prSpinner.fail("Failed to create PR");
        const errorMsg = prError instanceof Error ? prError.message : String(prError);
        console.log(chalk.red(`  ${errorMsg}`));
        console.log(chalk.dim(`  Branch ${branchName} has been pushed. Create the PR manually.`));
      }

      // Monitor mode (only if PR was created successfully)
      if (options.monitor && prCreated) {
        console.log();
        console.log(chalk.dim("Monitoring CI checks..."));

        let attempts = 0;
        const maxAttempts = 60; // 10 minutes at 10s intervals

        while (attempts < maxAttempts) {
          await new Promise((r) => setTimeout(r, 10000));
          attempts++;

          const checkProc = spawn({
            cmd: ["gh", "pr", "checks", "--repo", dataset.github_repo, branchName],
            cwd: workDir,
            stdout: "pipe",
            stderr: "pipe",
          });
          const checkOutput = await new Response(checkProc.stdout).text();
          const checkExit = await checkProc.exited;

          if (checkExit === 0) {
            console.log(chalk.green("  All checks passed!"));
            const mergeResult = await confirm("Merge the PR?", { yes: options.yes });
            if (mergeResult === "confirmed") {
              const mergeProc = spawn({
                cmd: [
                  "gh",
                  "pr",
                  "merge",
                  "--repo",
                  dataset.github_repo,
                  branchName,
                  "--squash",
                  "--delete-branch",
                ],
                cwd: workDir,
                stdout: "pipe",
                stderr: "pipe",
              });
              if ((await mergeProc.exited) === 0) {
                console.log(chalk.green("  PR merged successfully!"));
              } else {
                const mergeErr = await new Response(mergeProc.stderr).text();
                console.log(chalk.red(`  Merge failed: ${mergeErr.trim()}`));
              }
            }
            break;
          }

          if (checkOutput.includes("fail") || checkOutput.includes("X")) {
            console.log(chalk.red("  Some checks failed:"));
            console.log(checkOutput);
            break;
          }

          process.stdout.write(chalk.dim("."));
        }

        if (attempts >= maxAttempts) {
          console.log(chalk.yellow("\n  Timed out waiting for checks."));
        }
      }
    },
  );

// Request access command
datasetCommand
  .command("request-access")
  .description("Request collaborator access to a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .addHelpText(
    "after",
    `
Description:
  Request access to a NEMAR dataset to push data via git-annex.
  Access is automatically granted for public repositories.

  For metadata-only changes, you can fork and submit a PR without
  requesting access.

Requirements:
  - NEMAR account (nemar auth login)
  - Approved user status

Examples:
  $ nemar dataset request-access nm000104`,
  )
  .action(async (datasetId) => {
    if (!isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      console.log("Run 'nemar auth login' first");
      process.exit(1);
    }

    const spinner = ora(`Requesting access to ${datasetId}...`).start();

    try {
      const result = await requestDatasetAccess(datasetId);
      spinner.succeed(result.message);
      console.log();
      console.log(`  GitHub: https://github.com/${result.github_repo}`);
      console.log();
      console.log(chalk.dim("You can now push data to this dataset via git-annex."));
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
      } else {
        spinner.fail("Failed to request access");
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }
  });

// Invite collaborator command
datasetCommand
  .command("invite")
  .description("Invite a user as collaborator to your dataset")
  .argument("<username>", "Username to invite")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .addHelpText(
    "after",
    `
Description:
  Invite a NEMAR user as a collaborator to your dataset.
  Only dataset owners and admins can invite collaborators.

  Works for both public and private repositories.

Requirements:
  - NEMAR account (nemar auth login)
  - Dataset ownership or admin status

Examples:
  $ nemar dataset invite johndoe nm000104`,
  )
  .action(async (username, datasetId) => {
    if (!isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      console.log("Run 'nemar auth login' first");
      process.exit(1);
    }

    const spinner = ora(`Inviting ${username} to ${datasetId}...`).start();

    try {
      const result = await inviteCollaborator(datasetId, username);
      spinner.succeed(result.message);
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
      } else {
        spinner.fail("Failed to invite user");
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }
  });

// List collaborators command
datasetCommand
  .command("collaborators")
  .description("List collaborators for a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option("--json", "Output as JSON for scripting")
  .addHelpText(
    "after",
    `
Description:
  List all collaborators who have access to a dataset.
  Only dataset owners and admins can view collaborators.

Examples:
  $ nemar dataset collaborators nm000104
  $ nemar dataset collaborators nm000104 --json`,
  )
  .action(async (datasetId, options) => {
    if (!isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      console.log("Run 'nemar auth login' first");
      process.exit(1);
    }

    const spinner = ora(`Fetching collaborators for ${datasetId}...`).start();

    try {
      const result = await listCollaborators(datasetId);
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log();
      console.log(chalk.bold(`Collaborators for ${datasetId} (${result.count}):`));
      console.log();

      if (result.collaborators.length === 0) {
        console.log(chalk.dim("  No collaborators yet."));
        console.log();
        console.log(chalk.dim(`Invite users with: nemar dataset invite <username> ${datasetId}`));
        return;
      }

      // Table header
      const header = ["Username", "GitHub", "Access", "Granted"].join("  ");
      console.log(chalk.dim(`  ${header}`));
      console.log(chalk.dim(`  ${"-".repeat(header.length)}`));

      for (const collab of result.collaborators) {
        const grantedDate = new Date(collab.granted_at).toLocaleDateString();
        const accessType = collab.access_type === "invited" ? "invited" : "requested";
        const row = [
          collab.username.padEnd(10),
          `@${collab.github_username}`.padEnd(15),
          accessType.padEnd(10),
          grantedDate,
        ].join("  ");
        console.log(`  ${row}`);
      }
      console.log();
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
      } else {
        spinner.fail("Failed to fetch collaborators");
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }
  });

// ============================================================================
// Publication Workflow
// ============================================================================

const publishCommand = new Command("publish").description("Publication workflow management");

publishCommand
  .command("request")
  .description("Request publication of a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .addHelpText(
    "after",
    `
Description:
  Submit a publication request to make your private dataset publicly accessible.
  NEMAR admins will be notified and can approve or deny your request.

  Once approved, your dataset will:
  - Become publicly visible on GitHub
  - Receive a permanent DOI via Zenodo
  - Have tag protection enabled (prevents version manipulation)
  - Have S3 Object Lock enabled (prevents data deletion)

  You can only have one active publication request per dataset.

Status Flow:
  requested → approving → published (or denied)

Examples:
  $ nemar dataset publish request nm000104
  $ nemar dataset publish status nm000104     # Check request status`,
  )
  .action(async (datasetId) => {
    if (!isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      console.log("Run 'nemar auth login' first");
      process.exit(1);
    }

    const spinner = ora(`Requesting publication for ${datasetId}...`).start();

    try {
      const result = await requestPublication(datasetId);
      spinner.succeed(result.message);
      console.log(
        chalk.dim(
          "\n  Admins have been notified. Use 'nemar dataset publish status' to check progress.",
        ),
      );
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
        console.log(chalk.dim(`  ${error.message}`));
        if (error.statusCode === 409) {
          console.log(chalk.dim("  Use 'nemar dataset publish resend' to remind admins."));
        } else if (error.statusCode === 403) {
          console.log(chalk.dim("  Only the dataset owner can request publication."));
        }
      } else {
        spinner.fail("Failed to request publication");
        const msg = error instanceof Error ? error.message : String(error);
        console.log(chalk.dim(`  Error details: ${msg}`));
      }
    }
  });

publishCommand
  .command("status")
  .description("Check publication status of a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .addHelpText(
    "after",
    `
Description:
  Check the status of your publication request and see progress through
  the approval workflow.

Possible Statuses:
  requested  - Waiting for admin review
  approving  - Admin is running the publication process
  published  - Dataset is now public with DOI
  denied     - Request was denied (includes reason)

Steps in Approval Process:
   1. CI check          - Verify BIDS validation passes
   2. Make public       - Change repository visibility
   3. S3 public read    - Grant public read access to S3 data
   4. Tag protection    - Prevent version manipulation
   5. Create DOI        - Create concept DOI (EZID/Zenodo)
   6. Update metadata   - Update from BIDS description
   7. Update README     - Add DOI badge and citation
   8. Create tag        - Create version tag
   9. Create release    - Create GitHub release
  10. Upload to Zenodo  - Upload archive (if Zenodo provider)
  11. Publish DOI       - Make DOI public (permanent)
  12. S3 lock           - Enable Object Lock for data preservation
  13. Generate archive  - Create downloadable zip
  14. Notify user       - Send publication confirmation email

Examples:
  $ nemar dataset publish status nm000104`,
  )
  .action(async (datasetId) => {
    if (!isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      console.log("Run 'nemar auth login' first");
      process.exit(1);
    }

    const spinner = ora(`Checking publication status for ${datasetId}...`).start();

    try {
      const result = await getPublishStatus(datasetId);
      spinner.stop();

      console.log(`\n${chalk.cyan("Publication Status:")} ${datasetId}\n`);

      const statusColors: Record<string, typeof chalk.green> = {
        published: chalk.green,
        denied: chalk.red,
        approving: chalk.yellow,
      };
      const statusColor = statusColors[result.status] || chalk.dim;

      console.log(`  Status: ${statusColor(result.status)}`);

      if (result.requested_at) {
        console.log(`  Requested: ${chalk.dim(result.requested_at)}`);
      }
      if (result.requested_by) {
        console.log(`  Requested by: ${chalk.dim(result.requested_by)}`);
      }

      if (result.status === "denied" && result.denied_reason) {
        console.log(`\n  ${chalk.red("Reason:")} ${result.denied_reason}`);
      }

      if (result.status === "approving") {
        const steps = [
          "ci_check",
          "repo_public",
          "s3_public_read",
          "tag_protect",
          "doi_create",
          "update_metadata",
          "update_readme",
          "create_tag",
          "create_release",
          "upload_to_zenodo",
          "publish_doi",
          "s3_lock",
          "generate_archive",
          "notify_user",
        ];
        const completed = result.steps_completed || [];
        console.log("\n  Steps:");
        for (const step of steps) {
          const done = completed.includes(step);
          const isCurrent = result.current_step === step;
          const icon = done
            ? chalk.green("[x]")
            : isCurrent
              ? chalk.yellow("[>]")
              : chalk.dim("[ ]");
          const label = step.replace(/_/g, " ");
          console.log(
            `    ${icon} ${label}${isCurrent && result.last_error ? chalk.red(` (error: ${result.last_error})`) : ""}`,
          );
        }
      }

      if (result.status === "published" && result.approved_at) {
        console.log(`  Published: ${chalk.dim(result.approved_at)}`);
      }

      console.log();
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
        console.log(chalk.dim(`  ${error.message}`));
      } else {
        spinner.fail("Failed to check publication status");
        const msg = error instanceof Error ? error.message : String(error);
        console.log(chalk.dim(`  Error details: ${msg}`));
      }
    }
  });

publishCommand
  .command("resend")
  .description("Resend publication request notification to admins")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .addHelpText(
    "after",
    `
Description:
  Resend the publication request notification email to all NEMAR admins.
  Use this if admins haven't responded to your original request.

  This does NOT create a duplicate request - it only sends a reminder
  email for your existing publication request.

When to Use:
  - Admins haven't responded after several days
  - You want to remind admins about your pending request
  - Your request status is still "requested"

Examples:
  $ nemar dataset publish resend nm000104`,
  )
  .action(async (datasetId) => {
    if (!isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      console.log("Run 'nemar auth login' first");
      process.exit(1);
    }

    const spinner = ora(`Resending notification for ${datasetId}...`).start();

    try {
      const result = await resendPublishNotification(datasetId);
      spinner.succeed(result.message);
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
        console.log(chalk.dim(`  ${error.message}`));
        if (error.statusCode === 404) {
          console.log(chalk.dim("  Publication request not found for this dataset."));
        }
      } else {
        spinner.fail("Failed to resend notification");
        const msg = error instanceof Error ? error.message : String(error);
        console.log(chalk.dim(`  Error details: ${msg}`));
      }
    }
  });

datasetCommand.addCommand(publishCommand);

// Clone command
datasetCommand
  .command("clone")
  .description("Clone a dataset from NEMAR")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option("-o, --output <path>", "Output directory (default: ./<dataset-id>)")
  .addHelpText(
    "after",
    `
Description:
  Clone a NEMAR dataset repository with git-annex initialized.
  Data files are not downloaded; use 'nemar dataset get' afterward.

  Private datasets require authentication (nemar auth login) and are
  only accessible to the owner or designated collaborators.

Requirements:
  - git-annex installed
  - NEMAR account (for private datasets)

Examples:
  $ nemar dataset clone nm000104
  $ nemar dataset clone nm000104 -o ./my-dataset`,
  )
  .action(async (datasetId, options) => {
    // Check required tools first
    await checkPrerequisitesForCommand("clone");

    let spinner = ora("Checking prerequisites...").start();
    const prereqs = await checkDownloadPrerequisites();

    if (!prereqs.allPassed) {
      spinner.fail("Prerequisites check failed");
      for (const error of prereqs.errors) {
        console.log(chalk.red(`  - ${error}`));
      }
      process.exit(1);
    }
    spinner.succeed("Prerequisites OK");

    // Resolve dataset ID to repo URL
    spinner = ora(`Resolving dataset ${datasetId}...`).start();
    let repoUrl: string;
    let datasetVisibility: string;
    try {
      const dataset = await getDataset(datasetId);
      if (!dataset.github_repo || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(dataset.github_repo)) {
        spinner.fail("Dataset has no valid GitHub repository");
        console.log(chalk.red(`  Received: ${dataset.github_repo || "(empty)"}`));
        process.exit(1);
      }
      repoUrl = `https://github.com/${dataset.github_repo}.git`;
      datasetVisibility = dataset.visibility;
      spinner.succeed(`Found: ${dataset.name}`);
    } catch (error) {
      spinner.fail("Dataset not found");
      const msg = error instanceof Error ? error.message : String(error);
      console.log(chalk.red(`  ${msg}`));
      process.exit(1);
    }

    const outputPath = resolve(options.output || datasetId);
    if (existsSync(outputPath)) {
      console.log(chalk.red(`Error: Path already exists: ${outputPath}`));
      process.exit(1);
    }

    // For private datasets, fetch temporary S3 download credentials
    let cloneDownloadCreds: Awaited<ReturnType<typeof requestDownloadCredentials>> | null = null;
    if (datasetVisibility !== "public") {
      spinner = ora("Requesting download credentials...").start();
      try {
        cloneDownloadCreds = await requestDownloadCredentials(datasetId);
        spinner.succeed("Download credentials received (2h expiry)");
      } catch (error) {
        spinner.fail("Failed to get download credentials");
        console.log(chalk.red(`  ${(error as Error).message}`));
        console.log(
          chalk.dim("Private datasets require authentication. Run 'nemar auth login' first."),
        );
        process.exit(1);
      }
    }

    const cloneS3Creds = cloneDownloadCreds
      ? toS3Credentials(cloneDownloadCreds.credentials)
      : undefined;

    spinner = ora("Cloning dataset...").start();
    const result = await cloneDataset(repoUrl, outputPath);
    if (!result.success) {
      spinner.fail("Clone failed");
      console.log(chalk.red(`  ${result.error}`));
      process.exit(1);
    }

    spinner.succeed("Dataset cloned");

    // Enable S3 remote if available (new datasets have it; old ones use web URLs)
    const s3Enable = await enableS3Remote(outputPath, "nemar-s3", cloneS3Creds);
    if (s3Enable.enabled) {
      console.log(chalk.dim("  S3 remote enabled for data downloads"));
    } else if (!s3Enable.success) {
      console.log(chalk.yellow(`  Warning: Could not enable S3 remote: ${s3Enable.error}`));
    }

    // Clear cached credentials to prevent stale STS tokens
    if (cloneDownloadCreds) {
      await clearAnnexCredentials(outputPath);
    }

    console.log();
    console.log(`  Location: ${chalk.cyan(outputPath)}`);
    console.log();
    console.log(chalk.dim("Data files are not downloaded yet. To get them:"));
    console.log(chalk.dim(`  cd ${outputPath}`));
    console.log(chalk.dim("  nemar dataset get"));
  });

// Get command
datasetCommand
  .command("get")
  .description("Download annexed data files for the current dataset")
  .argument("[files...]", "Specific files/paths to get (default: all)")
  .option("-j, --jobs <number>", "Parallel download streams", "4")
  .addHelpText(
    "after",
    `
Description:
  Download data files from the remote for a cloned dataset.
  Must be run inside a git-annex dataset directory.

  For private datasets, credentials are fetched automatically
  if you are logged in (nemar auth login).

Examples:
  $ nemar dataset get                    # Get all files
  $ nemar dataset get sub-01/eeg/        # Get specific directory
  $ nemar dataset get *.edf -j 8         # Get EDF files with 8 streams`,
  )
  .action(async (files, options) => {
    const cwd = process.cwd();

    if (!(await isGitAnnexDataset(cwd))) {
      console.log(chalk.red("Error: Not inside a git-annex dataset directory"));
      console.log(chalk.dim("Use 'nemar dataset clone <id>' first, then cd into the dataset."));
      process.exit(1);
    }

    const jobs = Number.parseInt(options.jobs, 10);
    if (Number.isNaN(jobs) || jobs < 1) {
      console.log(chalk.red("Error: --jobs must be a positive integer"));
      process.exit(1);
    }

    // Detect dataset ID and check if private (needs authenticated S3 creds)
    let getCreds: Awaited<ReturnType<typeof requestDownloadCredentials>> | null = null;
    const getDatasetId = await getDatasetIdFromRemote(cwd);
    if (getDatasetId) {
      let dsInfo: Awaited<ReturnType<typeof getDataset>> | null = null;
      try {
        dsInfo = await getDataset(getDatasetId);
      } catch {
        // Dataset info fetch failed; proceed without creds (will use publicurl if public)
      }

      if (dsInfo && dsInfo.visibility !== "public") {
        if (!isAuthenticated()) {
          console.log(chalk.red("Error: This is a private dataset. Authentication required."));
          console.log(chalk.dim("Run 'nemar auth login' first."));
          process.exit(1);
        }
        const credSpinner = ora("Requesting download credentials...").start();
        try {
          getCreds = await requestDownloadCredentials(getDatasetId);
          credSpinner.succeed("Download credentials received (2h expiry)");
        } catch (error) {
          credSpinner.fail("Failed to get download credentials");
          console.log(chalk.red(`  ${(error as Error).message}`));
          console.log(
            chalk.dim("Private datasets require authentication. Run 'nemar auth login' first."),
          );
          process.exit(1);
        }
      }
    }

    const getS3Creds = getCreds ? toS3Credentials(getCreds.credentials) : undefined;

    // Enable S3 remote if available (idempotent)
    const s3Enable = await enableS3Remote(cwd, "nemar-s3", getS3Creds);
    if (!s3Enable.success && !s3Enable.enabled) {
      console.log(chalk.yellow(`  Warning: Could not enable S3 remote: ${s3Enable.error}`));
    }

    const paths = files.length > 0 ? files : undefined;
    const desc = paths ? `Getting ${paths.length} path(s)...` : "Getting all data files...";
    const spinner = ora(desc).start();

    const result = await getDatasetData(cwd, { jobs, paths, credentials: getS3Creds });
    if (!result.success) {
      spinner.fail("Failed to get data");
      console.log(chalk.red(`  ${result.error}`));
      if (getCreds) {
        await clearAnnexCredentials(cwd);
      }
      process.exit(1);
    }

    // Clear cached S3 credentials so future operations request fresh tokens
    if (getCreds) {
      await clearAnnexCredentials(cwd);
    }

    if (result.filesDownloaded === 0) {
      spinner.succeed("All data files already present");
    } else {
      spinner.succeed(`Downloaded ${result.filesDownloaded} file(s)`);
    }
  });

// Shared action handler for commit/save
async function commitAction(options: { message: string }) {
  const cwd = process.cwd();

  if (!(await isGitAnnexDataset(cwd))) {
    console.log(chalk.red("Error: Not inside a git-annex dataset directory"));
    process.exit(1);
  }

  const spinner = ora("Saving changes...").start();
  const result = await saveDataset(cwd, options.message);

  if (!result.success) {
    spinner.fail("Save failed");
    console.log(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  spinner.succeed("Changes saved");
}

// Commit command
datasetCommand
  .command("commit")
  .description("Stage and commit changes in the current dataset")
  .option("-m, --message <msg>", "Commit message", "Save changes")
  .addHelpText(
    "after",
    `
Description:
  Stage all changes (git add -A) and commit them. Large files are
  automatically handled by git-annex based on the dataset's largefiles config.

Tip:
  After committing, use 'nemar dataset push' for private datasets
  or 'nemar dataset update' for public datasets.

Examples:
  $ nemar dataset commit
  $ nemar dataset commit -m "Add new EEG recordings"`,
  )
  .action(commitAction);

// Save command (alias for commit)
datasetCommand
  .command("save")
  .description("Stage and commit changes (alias for commit)")
  .option("-m, --message <msg>", "Commit message", "Save changes")
  .addHelpText(
    "after",
    `
Description:
  Stage all changes (git add -A) and commit them. Large files are
  automatically handled by git-annex based on the dataset's largefiles config.

  This command is an alias for 'nemar dataset commit'.

Tip:
  After committing, use 'nemar dataset push' for private datasets
  or 'nemar dataset update' for public datasets.

Examples:
  $ nemar dataset save
  $ nemar dataset save -m "Add new EEG recordings"`,
  )
  .action(commitAction);

function printBranchProtectionSuggestions(): void {
  console.log("  Options:");
  console.log(`    ${chalk.cyan("nemar dataset update")}          Update via PR (recommended)`);
  console.log(`    ${chalk.cyan("nemar dataset push --pr")}       Push branch + create PR`);
}

// Push command
datasetCommand
  .command("push")
  .description("Push commits and data to remotes")
  .option("-j, --jobs <number>", "Parallel upload streams for S3", "4")
  .option("--no-s3", "Skip pushing data to S3 remote")
  .option("--pr", "Create a pull request after pushing")
  .option("-t, --title <title>", "Pull request title (with --pr)")
  .option("-b, --body <body>", "Pull request body (with --pr)")
  .addHelpText(
    "after",
    `
Description:
  Push git commits to GitHub (main + git-annex branches) and optionally
  copy annexed data to the S3 remote.

  With --pr, creates a pull request after pushing the current branch.

  S3 push uses temporary credentials from the NEMAR API. Falls back to
  environment AWS credentials if not logged in.

Note:
  Direct push to main works for private datasets only. For public
  datasets with branch protection, use 'nemar dataset update' instead,
  or use 'push --pr' to push to a branch and create a PR.

Examples:
  $ nemar dataset push
  $ nemar dataset push --no-s3      # Git only, skip S3
  $ nemar dataset push -j 8         # More parallel S3 streams
  $ nemar dataset push --pr -t "Add new recordings"`,
  )
  .action(async (options) => {
    const cwd = process.cwd();

    await checkPrerequisitesForCommand("push");

    if (!(await isGitAnnexDataset(cwd))) {
      console.log(chalk.red("Error: Not inside a git-annex dataset directory"));
      process.exit(1);
    }

    // Public datasets have branch protection enabled; warn early instead of a cryptic git error
    const currentBranchName = await getCurrentBranch(cwd);
    const isOnMain =
      currentBranchName === "main" ||
      currentBranchName === "master" ||
      (currentBranchName?.startsWith("adjusted/main") ?? false);
    if (isOnMain && !options.pr) {
      const pushDatasetIdCheck = await getDatasetIdFromRemote(cwd);
      if (pushDatasetIdCheck && isAuthenticated()) {
        try {
          const dsInfo = await getDataset(pushDatasetIdCheck);
          if (dsInfo.visibility === "public") {
            console.log(chalk.red("Error: This dataset is public with branch protection."));
            console.log(chalk.red("  Direct push to main is not allowed."));
            printBranchProtectionSuggestions();
            process.exit(1);
          }
        } catch {
          // API call failed (network, 404, etc.); fall through and let git report errors
        }
      }
    }

    // Push git to GitHub
    let spinner = ora("Pushing to GitHub...").start();
    const gitResult = await pushToGitHub(cwd);

    if (!gitResult.success) {
      const err = gitResult.error || "";
      if (err.includes("protected branch") || err.includes("GH006")) {
        spinner.fail("Push rejected: branch protection is enabled");
        console.log();
        console.log("  Public datasets require changes via pull request.");
        printBranchProtectionSuggestions();
      } else if (err.includes("terminal prompts disabled")) {
        spinner.fail("Git push failed: authentication required");
        console.log();
        console.log("  Run 'nemar auth setup-ssh' to configure SSH authentication.");
      } else {
        spinner.fail("Git push failed");
        console.log(chalk.red(`  ${err}`));
      }
      process.exit(1);
    }

    if (gitResult.warning) {
      spinner.warn("Git pushed with warning");
      console.log(chalk.yellow(`  ${gitResult.warning}`));
    } else {
      spinner.succeed("Pushed to GitHub");
    }

    // Push annex content to S3 (if enabled and remote exists)
    if (options.s3 !== false) {
      const s3Remotes = await getAnnexS3Remotes(cwd);
      if (s3Remotes.length > 0) {
        const remoteName = s3Remotes[0];
        if (s3Remotes.length > 1) {
          console.log(
            chalk.dim(`  Multiple S3 remotes: ${s3Remotes.join(", ")}. Using: ${remoteName}`),
          );
        }
        const jobs = Number.parseInt(options.jobs, 10);
        if (Number.isNaN(jobs) || jobs < 1) {
          console.log(chalk.red("Error: --jobs must be a positive integer"));
          process.exit(1);
        }

        // Get STS credentials for S3 upload
        const pushDatasetId = await getDatasetIdFromRemote(cwd);
        let pushCreds: Awaited<ReturnType<typeof requestUploadCredentials>> | null = null;
        if (pushDatasetId && isAuthenticated()) {
          spinner = ora("Requesting upload credentials...").start();
          try {
            pushCreds = await requestUploadCredentials(pushDatasetId);
            spinner.succeed("Upload credentials received");
          } catch (credError) {
            spinner.warn(
              `Could not get upload credentials: ${errorDetail(credError)}. Trying environment credentials.`,
            );
          }
        }

        spinner = ora(`Copying data to S3 (${remoteName})...`).start();

        const s3Creds = pushCreds ? toS3Credentials(pushCreds.credentials) : undefined;

        const s3Result = await copyToAnnexRemote(cwd, remoteName, jobs, s3Creds);
        if (!s3Result.success) {
          spinner.fail("S3 push failed");
          console.log(chalk.red(`  ${s3Result.error}`));
          if (!pushCreds) {
            console.log(chalk.dim("  Ensure AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set,"));
            console.log(
              chalk.dim("  or log in with 'nemar auth login' for automatic credentials."),
            );
          }
          console.log(chalk.dim("  Git changes were pushed successfully."));
          process.exit(1);
        }
        await clearAnnexCredentials(cwd);
        spinner.succeed(`Copied ${s3Result.filesCopied} file(s) to S3`);
      } else {
        console.log(chalk.dim("  No S3 remote configured; skipping data push."));
      }
    }

    // Create PR if --pr flag is set
    if (options.pr) {
      const branch = await getCurrentBranch(cwd);
      if (!branch) {
        console.log(chalk.red("  Could not determine current branch"));
        console.log(chalk.dim("  Ensure you are inside a valid git repository."));
        process.exit(1);
      }
      if (branch === "main" || branch === "master") {
        console.log(chalk.yellow("  Skipping PR: already on main branch"));
      } else {
        spinner = ora("Creating pull request...").start();
        const prArgs = ["gh", "pr", "create"];
        if (options.title) {
          prArgs.push("--title", options.title);
        } else {
          prArgs.push("--title", `Update from branch ${branch}`);
        }
        if (options.body) {
          prArgs.push("--body", options.body);
        } else {
          prArgs.push("--body", "");
        }

        try {
          const proc = spawn({
            cmd: prArgs,
            cwd,
            env: process.env,
            stdout: "pipe",
            stderr: "pipe",
          });
          const prStdout = await new Response(proc.stdout).text();
          const prStderr = await new Response(proc.stderr).text();
          const prExit = await proc.exited;

          if (prExit !== 0) {
            spinner.fail("Failed to create pull request");
            console.log(chalk.red(`  ${prStderr.trim() || prStdout.trim()}`));
            process.exit(1);
          }

          const prUrl = prStdout.trim();
          spinner.succeed("Pull request created");
          console.log(`  ${chalk.cyan(prUrl)}`);
        } catch (spawnError) {
          spinner.fail("Failed to create pull request");
          const msg = spawnError instanceof Error ? spawnError.message : String(spawnError);
          if (msg.includes("ENOENT") || msg.includes("not found")) {
            console.log(chalk.red("  'gh' CLI is not installed or not in PATH"));
            console.log(chalk.dim("  Install it: https://cli.github.com/"));
          } else {
            console.log(chalk.red(`  ${msg}`));
          }
          process.exit(1);
        }
      }
    }
  });

// Drop command
datasetCommand
  .command("drop")
  .description("Free local copies of annexed files (keeps remote copies)")
  .argument("[files...]", "Specific files to drop (default: all)")
  .addHelpText(
    "after",
    `
Description:
  Remove local copies of annexed data files. Git-annex verifies that
  remote copies exist before dropping. Use 'nemar dataset get' to
  re-download later.

Examples:
  $ nemar dataset drop                   # Drop all local data
  $ nemar dataset drop sub-01/eeg/       # Drop specific directory
  $ nemar dataset drop *.edf             # Drop EDF files`,
  )
  .action(async (files) => {
    const cwd = process.cwd();

    if (!(await isGitAnnexDataset(cwd))) {
      console.log(chalk.red("Error: Not inside a git-annex dataset directory"));
      process.exit(1);
    }

    const paths = files.length > 0 ? files : undefined;
    const desc = paths ? `Dropping ${paths.length} path(s)...` : "Dropping all local data...";
    const spinner = ora(desc).start();

    const result = await dropFiles(cwd, paths);
    if (!result.success && result.dropped === 0) {
      spinner.fail("Drop failed");
      console.log(chalk.red(`  ${result.error}`));
      process.exit(1);
    }

    if (result.kept.length > 0) {
      spinner.warn(
        `Dropped ${result.dropped} file(s), ${result.kept.length} kept (no remote copy)`,
      );
      for (const f of result.kept.slice(0, 5)) {
        console.log(chalk.yellow(`  kept: ${f}`));
      }
      if (result.kept.length > 5) {
        console.log(chalk.yellow(`  ... and ${result.kept.length - 5} more`));
      }
      if (result.error) {
        console.log(chalk.dim(`  ${result.error}`));
      }
      process.exit(1);
    } else {
      spinner.succeed(`Dropped ${result.dropped} file(s)`);
    }
  });

// CI command
datasetCommand
  .command("ci")
  .description("Check BIDS validation CI status for the current dataset")
  .argument("[dataset-id]", "Dataset ID (auto-detected from git remote if omitted)")
  .addHelpText(
    "after",
    `
Description:
  Show the status of the BIDS validation CI workflow for a dataset.
  When run inside a cloned dataset, the dataset ID is auto-detected
  from the git remote URL.

Examples:
  $ nemar dataset ci              # Auto-detect from CWD
  $ nemar dataset ci nm000104     # Explicit dataset ID`,
  )
  .action(async (datasetId) => {
    if (!isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      console.log("Run 'nemar auth login' first");
      process.exit(1);
    }

    // Resolve dataset ID
    let resolvedId = datasetId;
    if (!resolvedId) {
      const cwd = process.cwd();
      if (await isGitAnnexDataset(cwd)) {
        resolvedId = await getDatasetIdFromRemote(cwd);
      }
      if (!resolvedId) {
        console.log(chalk.red("Error: Could not detect dataset ID from current directory"));
        console.log(chalk.dim("Provide dataset ID explicitly: nemar dataset ci <id>"));
        process.exit(1);
      }
    }

    const spinner = ora(`Checking CI status for ${resolvedId}...`).start();

    try {
      const result = await getUserCiStatus(resolvedId);
      spinner.stop();

      console.log(chalk.bold(`CI Status: ${resolvedId}`));
      console.log();

      const { bids_validation } = result;
      if (!bids_validation.present) {
        console.log(`  BIDS Validation: ${chalk.dim("not configured")}`);
        console.log(chalk.dim(`  Ask an admin to run: nemar admin ci add ${resolvedId}`));
      } else {
        const statusColor =
          bids_validation.status === "success"
            ? chalk.green
            : bids_validation.status === "failure"
              ? chalk.red
              : chalk.yellow;
        console.log(`  BIDS Validation: ${statusColor(bids_validation.status)}`);
        if (bids_validation.url) {
          console.log(`  Latest run: ${chalk.cyan(bids_validation.url)}`);
        }
      }
      console.log();
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
      } else {
        spinner.fail("Failed to check CI status");
        const msg = error instanceof Error ? error.message : String(error);
        console.log(chalk.dim(`  ${msg}`));
      }
      process.exit(1);
    }
  });

// Manifest command
datasetCommand
  .command("manifest")
  .description("View version manifests for a dataset")
  .argument("[version]", "Version to view (lists available if omitted)")
  .option("-d, --dataset <id>", "Dataset ID (auto-detected from git remote if omitted)")
  .option("--json", "Output raw JSON")
  .addHelpText(
    "after",
    `
Description:
  View version manifests that map file paths to S3 annex keys.
  Manifests are generated when a version DOI is published.

  When run inside a dataset directory, the dataset ID is auto-detected.

Examples:
  $ nemar dataset manifest                    # List available versions
  $ nemar dataset manifest v1.0.0             # View specific version
  $ nemar dataset manifest v1.0.0 --json      # Raw JSON output
  $ nemar dataset manifest -d nm000104        # Explicit dataset ID`,
  )
  .action(async (version, options) => {
    if (!isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      console.log("Run 'nemar auth login' first");
      process.exit(1);
    }

    // Resolve dataset ID
    let datasetId = options.dataset;
    if (!datasetId) {
      const cwd = process.cwd();
      if (await isGitAnnexDataset(cwd)) {
        datasetId = await getDatasetIdFromRemote(cwd);
      }
      if (!datasetId) {
        console.log(chalk.red("Error: Could not detect dataset ID"));
        console.log(chalk.dim("Provide dataset ID: nemar dataset manifest -d <id>"));
        process.exit(1);
      }
    }

    const spinner = ora("Fetching manifest info...").start();

    try {
      if (!version) {
        // List available versions
        const result = await listManifestVersions(datasetId);
        spinner.stop();

        console.log(chalk.bold(`Manifests: ${datasetId}`));
        console.log();

        if (result.versions.length === 0) {
          console.log(chalk.dim("  No manifests available yet."));
          console.log(chalk.dim("  Manifests are generated when a version DOI is published."));
        } else {
          for (const v of result.versions) {
            console.log(`  ${chalk.cyan(v)}`);
          }
        }
        console.log();
      } else {
        // Get specific manifest
        const manifest = await getManifest(datasetId, version);
        spinner.stop();

        if (options.json) {
          console.log(JSON.stringify(manifest, null, 2));
        } else {
          console.log(chalk.bold(`Manifest: ${datasetId} ${manifest.version}`));
          if (manifest.doi) {
            console.log(`  DOI: ${chalk.cyan(manifest.doi)}`);
          }
          if (manifest.concept_doi) {
            console.log(`  Concept DOI: ${chalk.dim(manifest.concept_doi)}`);
          }
          console.log(`  Created: ${manifest.created}`);
          console.log();

          const fileEntries = Object.entries(manifest.files);
          const annexed = fileEntries.filter(([, f]) => !f.key.startsWith("git:"));
          const gitFiles = fileEntries.filter(([, f]) => f.key.startsWith("git:"));

          if (annexed.length > 0) {
            console.log(chalk.bold(`  Annexed files (${annexed.length}):`));
            for (const [path, file] of annexed) {
              const sizeStr = formatSize(file.size);
              console.log(`    ${path} ${chalk.dim(`(${sizeStr})`)}`);
            }
          }

          if (gitFiles.length > 0) {
            console.log();
            console.log(chalk.bold(`  Metadata files (${gitFiles.length}):`));
            for (const [path, file] of gitFiles) {
              const sizeStr = formatSize(file.size);
              console.log(`    ${path} ${chalk.dim(`(${sizeStr})`)}`);
            }
          }
          console.log();
        }
      }
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
      } else {
        spinner.fail("Failed to fetch manifest");
        const msg = error instanceof Error ? error.message : String(error);
        console.log(chalk.dim(`  ${msg}`));
      }
      process.exit(1);
    }
  });

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / 1024 ** i;
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
