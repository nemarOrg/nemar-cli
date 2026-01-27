/**
 * Dataset management commands for NEMAR CLI
 *
 * Commands:
 * - nemar dataset validate        - Validate BIDS dataset locally
 * - nemar dataset upload          - Upload dataset to NEMAR
 * - nemar dataset download        - Download dataset from NEMAR
 * - nemar dataset status          - Check dataset status
 * - nemar dataset list            - List user's datasets
 * - nemar dataset version         - Create new version with DOI
 * - nemar dataset request-access  - Request access to a dataset
 * - nemar dataset invite          - Invite user as collaborator
 * - nemar dataset collaborators   - List dataset collaborators
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawn } from "bun";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import {
  ApiError,
  type Dataset,
  type DatasetsListResponse,
  addCi,
  createDataset,
  getDataset,
  getManifest,
  getPublishStatus,
  getUserCiStatus,
  inviteCollaborator,
  listCollaborators,
  listDatasets,
  listManifestVersions,
  requestDatasetAccess,
  requestPublication,
  requestUploadUrls,
  resendPublishNotification,
} from "../lib/api.js";
import {
  type BidsValidationResult,
  checkDenoInstalled,
  formatValidationResult,
  getValidatorVersion,
  validateBidsDataset,
} from "../lib/bids-validator.js";
import { getConfig, isAuthenticated, isSandboxCompleted } from "../lib/config.js";
import { type ConfirmOptions, YES_DESCRIPTION, YES_OPTION, confirm } from "../lib/confirm.js";
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
  cloneDataset,
  collectFileManifest,
  configureGitHubRemote,
  configureLargefiles,
  copyToAnnexRemote,
  dropFiles,
  ensureGitAnnexInitialized,
  formatBytes,
  getAnnexS3Remotes,
  getCurrentBranch,
  getDatasetData,
  getDatasetIdFromRemote,
  getLocalDatasetInfo,
  initDataset,
  isGitAnnexDataset,
  pushToGitHub,
  registerUrlsWithGitAnnex,
  saveDataset,
  uploadFilesWithPresignedUrls,
  verifyGitHubAuth,
} from "../lib/git-annex.js";

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
  .description("Validate a BIDS dataset locally using the official BIDS validator")
  .argument("[path]", "Path to BIDS dataset directory", ".")
  .option("--ignore-warnings", "Only report errors, not warnings")
  .option("-c, --config <file>", "Validation config file (.bidsvalidatorrc)")
  .option("-r, --recursive", "Validate derivatives subdirectories")
  .option("--prune", "Skip sourcedata and derivatives for faster validation")
  .option("-v, --verbose", "Show verbose output")
  .option("--json", "Output results as JSON (for scripting)")
  .option("--version-info", "Show BIDS validator version info")
  .addHelpText(
    "after",
    `
Description:
  Validates a BIDS dataset using the official BIDS validator (via Deno).
  The validator checks dataset structure, file naming, and metadata.

Requirements:
  Deno runtime must be installed: https://deno.com

Exit Codes:
  0 - Dataset is valid
  1 - Dataset has errors or validation failed

Examples:
  $ nemar dataset validate                       # Validate current directory
  $ nemar dataset validate ./my-dataset          # Validate specific path
  $ nemar dataset validate ./ds --prune          # Fast validation (skip derivatives)
  $ nemar dataset validate ./ds --json > out.json`,
  )
  .action(async (datasetPath, options) => {
    // Show version info if requested
    if (options.versionInfo) {
      const deno = await checkDenoInstalled();
      if (!deno.installed) {
        console.log(chalk.red("Deno is not installed"));
        console.log("Install Deno: https://deno.com");
        process.exit(1);
      }

      const version = await getValidatorVersion();
      console.log(`BIDS Validator: ${version || "unknown"}`);
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

    // Run validation
    const spinner = ora("Validating BIDS dataset...").start();

    let result: BidsValidationResult;
    try {
      result = await validateBidsDataset(absolutePath, {
        config: options.config,
        ignoreWarnings: options.ignoreWarnings,
        recursive: options.recursive,
        prune: options.prune,
        verbose: options.verbose,
      });
      spinner.succeed("Validation complete");
      console.log();
    } catch (error) {
      spinner.fail("Validation failed");
      console.log(chalk.red((error as Error).message));
      process.exit(1);
    }

    // Output results
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatValidationResult(result));
    }

    // Exit with error code if invalid
    if (!result.valid) {
      process.exit(1);
    }
  });

// Upload command
datasetCommand
  .command("upload")
  .description("Upload a BIDS dataset to NEMAR")
  .argument("<path>", "Path to BIDS dataset directory")
  .option("-n, --name <name>", "Dataset name (defaults to directory name)")
  .option("-d, --description <desc>", "Dataset description")
  .option("--skip-validation", "Skip BIDS validation (not recommended)")
  .option("--dry-run", "Show what would be uploaded without doing it")
  .option("-j, --jobs <number>", "Parallel upload streams (default: 4)", "4")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option("--no", "Skip confirmation and decline")
  .addHelpText(
    "after",
    `
Description:
  Upload a BIDS dataset to NEMAR. The dataset will be validated, assigned
  a unique ID (nm000XXX), and stored on GitHub (metadata) and S3 (data files).

Requirements:
  - NEMAR account (nemar auth login)
  - git-annex installed
  - GitHub SSH access configured

Process:
  1. Validates BIDS format (unless --skip-validation)
  2. Creates GitHub repository for metadata
  3. Uploads large files to S3 in parallel
  4. Enables PR-based versioning workflow

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
    console.log(chalk.gray(`  git-annex ${prereqs.gitAnnex.version}`));
    if (prereqs.githubSSH.username) {
      console.log(chalk.gray(`  GitHub SSH: ${prereqs.githubSSH.username}`));
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
          chalk.gray(
            "To skip validation (not recommended): nemar dataset upload --skip-validation",
          ),
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
          console.log(chalk.gray("Or use --skip-validation to upload anyway (not recommended)."));
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
    const datasetName = options.name || basename(absolutePath);
    const manifest = await collectFileManifest(absolutePath);
    spinner.succeed(
      `Found ${manifest.files.length} files (${manifest.dataFiles} data, ${manifest.metadataFiles} metadata)`,
    );

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

        // Request fresh presigned URLs for data files
        const uploadResponse = await requestUploadUrls(
          existingConfig.dataset_id,
          dataFiles.map((f) => f.path),
        );

        datasetInfo = {
          dataset_id: existingConfig.dataset_id,
          ssh_url: existingConfig.ssh_url,
          s3_prefix: existingConfig.s3_prefix,
          github_url: existingConfig.github_url,
          upload_urls: uploadResponse.upload_urls,
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
            console.log(chalk.gray(`  Remove ${absolutePath}/.nemar to start fresh.`));
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

        spinner.succeed(`Dataset created: ${datasetInfo.dataset_id}`);

        // Wait for IAM policy propagation (AWS is eventually consistent)
        // This initial wait helps reduce retry attempts during upload
        await new Promise((resolve) => setTimeout(resolve, 10000));
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
      console.log(chalk.gray(`  ${largefilesResult.error}`));
    }

    spinner.succeed("git-annex dataset initialized");

    // Step 8: Configure GitHub remote (auto-detects best auth method)
    spinner = ora("Configuring GitHub remote...").start();

    const githubResult = await configureGitHubRemote(absolutePath, datasetInfo.ssh_url);
    if (!githubResult.success) {
      spinner.fail("Failed to configure GitHub remote");
      console.log(chalk.red(`  ${githubResult.error}`));
      process.exit(1);
    }

    spinner.succeed("GitHub remote configured");

    // Step 9: Upload data files to S3 using presigned URLs
    const uploadUrlCount = Object.keys(datasetInfo.upload_urls).length;
    if (uploadUrlCount > 0) {
      spinner = ora(`Uploading ${uploadUrlCount} data files to S3...`).start();

      let uploadedCount = 0;
      const totalFiles = uploadUrlCount;
      const uploadResult = await uploadFilesWithPresignedUrls(
        absolutePath,
        datasetInfo.upload_urls,
        {
          jobs: Number.parseInt(options.jobs, 10),
          onProgress: (progress) => {
            if (progress.status === "completed") {
              uploadedCount++;
              spinner.text = `Uploading data files to S3... (${uploadedCount}/${totalFiles})`;
            }
          },
        },
      );

      if (!uploadResult.success) {
        spinner.fail(`Failed to upload some files (${uploadResult.failed.length} failed)`);
        for (const failed of uploadResult.failed.slice(0, 5)) {
          console.log(chalk.red(`  - ${failed}`));
        }
        if (uploadResult.failed.length > 5) {
          console.log(chalk.red(`  ... and ${uploadResult.failed.length - 5} more`));
        }
        process.exit(1);
      }

      spinner.succeed(`Uploaded ${uploadResult.uploaded} data files to S3`);

      // Step 10: Register S3 URLs with git-annex
      spinner = ora("Registering file URLs with git-annex...").start();

      // Build public URLs for each uploaded file
      const { s3_config, s3_prefix } = {
        s3_config: datasetInfo.s3_config,
        s3_prefix: datasetInfo.s3_prefix,
      };
      const fileUrls: Record<string, string> = {};
      for (const filePath of Object.keys(datasetInfo.upload_urls)) {
        fileUrls[filePath] = `${s3_config.public_url}/${s3_prefix}/${filePath}`;
      }

      const registerResult = await registerUrlsWithGitAnnex(absolutePath, fileUrls);
      if (!registerResult.success) {
        spinner.warn(`Some URLs could not be registered (${registerResult.failed.length} failed)`);
      } else {
        spinner.succeed(`Registered ${registerResult.registered} file URLs with git-annex`);
      }
    } else {
      console.log(chalk.gray("No data files to upload to S3"));
    }

    // Step 11: Save dataset changes
    spinner = ora("Saving dataset changes...").start();

    const saveResult = await saveDataset(absolutePath, "Initial NEMAR dataset upload", author);
    if (!saveResult.success) {
      spinner.fail("Failed to save dataset");
      console.log(chalk.red(`  ${saveResult.error}`));
      process.exit(1);
    }

    spinner.succeed("Dataset changes saved");

    // Step 12: Push metadata to GitHub
    spinner = ora("Pushing metadata to GitHub...").start();

    const githubPushResult = await pushToGitHub(absolutePath);
    if (!githubPushResult.success) {
      spinner.fail("Failed to push to GitHub");
      console.log(chalk.red(`  ${githubPushResult.error}`));
      process.exit(1);
    }

    spinner.succeed("Metadata pushed to GitHub");

    // Step 12b: Deploy BIDS validation CI
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
          chalk.gray(
            `  An admin can add it later with: nemar admin ci add ${datasetInfo.dataset_id}`,
          ),
        );
      }
    }

    // Note: Branch protection is NOT applied here for private datasets.
    // Protection is applied when creating a DOI (admin doi create) or making public.

    // Step 13: Success!
    // Update last upload timestamp in local config
    updateLastUpload(absolutePath);

    console.log();
    console.log(chalk.green.bold("Upload complete!"));
    console.log();
    console.log(`  Dataset ID: ${chalk.cyan(datasetInfo.dataset_id)}`);
    console.log(`  GitHub: ${chalk.cyan(datasetInfo.github_url)}`);
    console.log();
    console.log(chalk.gray("To clone this dataset:"));
    console.log(chalk.gray(`  git clone ${datasetInfo.ssh_url}`));
  });

// Download command
datasetCommand
  .command("download")
  .description("Download a dataset from NEMAR")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option("-o, --output <path>", "Output directory (default: ./<dataset-id>)")
  .option("-j, --jobs <number>", "Parallel download streams (default: 4)", "4")
  .option("--no-data", "Download metadata only (skip large data files)")
  .addHelpText(
    "after",
    `
Description:
  Download a BIDS dataset from NEMAR. Uses git-annex for efficient
  data transfer with parallel streams.

Requirements:
  - git-annex installed (no account needed)

Examples:
  $ nemar dataset download nm000104              # Download to ./nm000104
  $ nemar dataset download nm000104 -o ./data    # Custom output directory
  $ nemar dataset download nm000104 --no-data    # Metadata only (fast)
  $ nemar dataset download nm000104 -j 8         # More parallel streams`,
  )
  .action(async (datasetId, options) => {
    // Step 1: Check prerequisites
    let spinner = ora("Checking prerequisites...").start();
    const prereqs = await checkDownloadPrerequisites();

    if (!prereqs.allPassed) {
      spinner.fail("Prerequisites check failed");
      console.log();
      for (const error of prereqs.errors) {
        console.log(chalk.red(`  - ${error}`));
      }
      process.exit(1);
    }

    spinner.succeed("Prerequisites check passed");
    console.log(chalk.gray(`  git-annex ${prereqs.gitAnnex.version}`));
    console.log();

    // Step 2: Get dataset info from backend
    spinner = ora(`Fetching dataset info for ${datasetId}...`).start();

    let datasetInfo: Dataset;
    try {
      datasetInfo = await getDataset(datasetId);
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
    const outputPath = options.output || datasetId;
    const absoluteOutput = resolve(outputPath);

    // Check if output already exists
    if (existsSync(absoluteOutput)) {
      console.log(chalk.red(`Error: Output path already exists: ${absoluteOutput}`));
      console.log("Remove or rename the existing directory and try again.");
      process.exit(1);
    }

    console.log();
    console.log(chalk.bold("Download Plan:"));
    console.log(`  Dataset: ${datasetInfo.name} (${datasetId})`);
    console.log(`  Output: ${absoluteOutput}`);
    console.log(`  Data files: ${options.data === false ? "metadata only" : "included"}`);
    if (options.data !== false) {
      console.log(`  Parallel jobs: ${options.jobs}`);
    }
    console.log();

    // Step 4: Clone the dataset
    const repoUrl = `https://github.com/${datasetInfo.github_repo}.git`;
    spinner = ora("Cloning dataset from GitHub...").start();

    const cloneResult = await cloneDataset(repoUrl, absoluteOutput);
    if (!cloneResult.success) {
      spinner.fail("Failed to clone dataset");
      console.log(chalk.red(`  ${cloneResult.error}`));
      process.exit(1);
    }

    spinner.succeed("Dataset cloned");

    // Step 5: Get data files (unless --no-data)
    if (options.data !== false) {
      spinner = ora(`Downloading data files (${options.jobs} parallel streams)...`).start();

      const getResult = await getDatasetData(absoluteOutput, {
        jobs: Number.parseInt(options.jobs, 10),
      });

      if (!getResult.success) {
        spinner.fail("Failed to download data files");
        console.log(chalk.red(`  ${getResult.error}`));
        console.log(chalk.gray("The dataset was cloned but data files are not available locally."));
        console.log(chalk.gray(`You can try again with: cd ${absoluteOutput} && git annex get .`));
        process.exit(1);
      }

      spinner.succeed(`Data downloaded (${getResult.filesDownloaded || 0} files)`);
    } else {
      console.log(chalk.gray("Skipping data files (--no-data flag)"));
    }

    // Step 6: Show completion info
    const localInfo = await getLocalDatasetInfo(absoluteOutput);

    console.log();
    console.log(chalk.green.bold("Download complete!"));
    console.log();
    console.log(`  Location: ${chalk.cyan(absoluteOutput)}`);
    if (localInfo) {
      console.log(`  Files: ${localInfo.files}`);
      if (localInfo.size !== "unknown") {
        console.log(`  Size: ${localInfo.size}`);
      }
      if (localInfo.missingFiles > 0) {
        console.log(
          chalk.gray(
            `  Missing files: ${localInfo.missingFiles} (use 'git annex get' to download)`,
          ),
        );
      }
    }
    console.log();
    console.log(chalk.gray("To get additional data:"));
    console.log(chalk.gray(`  cd ${absoluteOutput} && git annex get <path>`));
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
    console.log(chalk.gray("To download this dataset:"));
    console.log(chalk.gray(`  nemar dataset download ${datasetId}`));
  });

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
      return chalk.gray(status);
    case "pending":
      return chalk.yellow(status);
    default:
      return status;
  }
}

// List command
datasetCommand
  .command("list")
  .description("List available datasets on NEMAR")
  .option("--mine", "List only your datasets (requires authentication)")
  .option("--json", "Output as JSON for scripting")
  .option("--limit <n>", "Limit number of results (default: 50)", "50")
  .addHelpText(
    "after",
    `
Description:
  List BIDS datasets available on NEMAR. Use --mine to see only your
  own datasets (requires authentication).

Examples:
  $ nemar dataset list                   # List all public datasets
  $ nemar dataset list --mine            # List your datasets
  $ nemar dataset list --json            # JSON output for scripting
  $ nemar dataset list --limit 10        # Show only 10 datasets`,
  )
  .action(async (options) => {
    // If --mine, require authentication
    if (options.mine && !isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      console.log("Run 'nemar auth login' to see your datasets");
      process.exit(1);
    }

    const spinner = ora("Fetching datasets...").start();

    let response: DatasetsListResponse;
    try {
      response = await listDatasets();
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

    let datasets = response.datasets;

    // Filter by owner if --mine
    if (options.mine) {
      const config = getConfig();
      const username = config.username;
      datasets = datasets.filter((d) => d.owner_username === username);
    }

    // Limit results
    const limit = Number.parseInt(options.limit, 10);
    if (datasets.length > limit) {
      datasets = datasets.slice(0, limit);
    }

    // JSON output
    if (options.json) {
      console.log(JSON.stringify(datasets, null, 2));
      return;
    }

    // No datasets found
    if (datasets.length === 0) {
      console.log();
      if (options.mine) {
        console.log(chalk.yellow("You don't have any datasets yet."));
        console.log(chalk.gray("Create one with: nemar dataset upload <path>"));
      } else {
        console.log(chalk.yellow("No datasets found."));
      }
      return;
    }

    // Table output
    console.log();
    console.log(
      chalk.bold(
        `Datasets (${datasets.length}${response.count > datasets.length ? ` of ${response.count}` : ""}):`,
      ),
    );
    console.log();

    // Calculate column widths
    const idWidth = Math.max(10, ...datasets.map((d) => d.dataset_id.length));
    const nameWidth = Math.min(30, Math.max(10, ...datasets.map((d) => d.name.length)));
    const ownerWidth = Math.max(8, ...datasets.map((d) => d.owner_username.length));

    // Header
    const header = [
      "ID".padEnd(idWidth),
      "Name".padEnd(nameWidth),
      "Owner".padEnd(ownerWidth),
      "Status",
    ].join("  ");
    console.log(chalk.gray(header));
    console.log(chalk.gray("-".repeat(header.length)));

    // Rows
    for (const dataset of datasets) {
      const name =
        dataset.name.length > nameWidth
          ? `${dataset.name.substring(0, nameWidth - 3)}...`
          : dataset.name;

      const row = [
        chalk.cyan(dataset.dataset_id.padEnd(idWidth)),
        name.padEnd(nameWidth),
        dataset.owner_username.padEnd(ownerWidth),
        colorizeStatus(dataset.status),
      ].join("  ");
      console.log(row);
    }

    console.log();
    console.log(chalk.gray("For details: nemar dataset status <dataset-id>"));
  });

// Version command
datasetCommand
  .command("version")
  .description("Create a new version of a dataset with DOI")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .argument("<version>", "Version tag (e.g., v1.1.0)")
  .option("-m, --message <msg>", "Version description")
  .action(async (datasetId, version, options) => {
    if (!isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      console.log("Run 'nemar auth login' first");
      process.exit(1);
    }

    console.log(chalk.yellow("Version command not yet implemented"));
    console.log(`Would create version ${version} for dataset ${datasetId}`);
    console.log("Requires existing concept DOI (created by admin)");
    // TODO: Implement versioning
    // 1. Check dataset has concept DOI
    // 2. Validate dataset passes BIDS
    // 3. Create new version DOI on Zenodo
    // 4. Update dataset_description.json
    // 5. Create git tag and release
  });

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
      console.log(chalk.gray("You can now push data to this dataset via git-annex."));
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
        console.log(chalk.gray("  No collaborators yet."));
        console.log();
        console.log(chalk.gray(`Invite users with: nemar dataset invite <username> ${datasetId}`));
        return;
      }

      // Table header
      const header = ["Username", "GitHub", "Access", "Granted"].join("  ");
      console.log(chalk.gray(`  ${header}`));
      console.log(chalk.gray(`  ${"-".repeat(header.length)}`));

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
  - Be protected by branch protection (all changes require PRs)
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
        chalk.gray(
          "\n  Admins have been notified. Use 'nemar dataset publish status' to check progress.",
        ),
      );
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
        console.log(chalk.gray(`  ${error.message}`));
        if (error.statusCode === 409) {
          console.log(chalk.gray("  Use 'nemar dataset publish resend' to remind admins."));
        } else if (error.statusCode === 403) {
          console.log(chalk.gray("  Only the dataset owner can request publication."));
        }
      } else {
        spinner.fail("Failed to request publication");
        const msg = error instanceof Error ? error.message : String(error);
        console.log(chalk.gray(`  Error details: ${msg}`));
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
  1. CI check        - Verify BIDS validation passes
  2. Make public     - Change repository visibility
  3. Tag protection  - Prevent version manipulation
  4. Create DOI      - Assign permanent Zenodo DOI
  5. S3 lock         - Enable Object Lock for data preservation

Examples:
  $ nemar dataset publish status nm000104
  $ nemar dataset publish status nm000104 --json`,
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

      const statusColor =
        result.status === "published"
          ? chalk.green
          : result.status === "denied"
            ? chalk.red
            : result.status === "approving"
              ? chalk.yellow
              : chalk.gray;

      console.log(`  Status: ${statusColor(result.status)}`);

      if (result.requested_at) {
        console.log(`  Requested: ${chalk.gray(result.requested_at)}`);
      }
      if (result.requested_by) {
        console.log(`  Requested by: ${chalk.gray(result.requested_by)}`);
      }

      if (result.status === "denied" && result.denied_reason) {
        console.log(`\n  ${chalk.red("Reason:")} ${result.denied_reason}`);
      }

      if (result.status === "approving") {
        const steps = ["ci_check", "repo_public", "doi_create", "s3_lock", "notify_user"];
        const completed = result.steps_completed || [];
        console.log("\n  Steps:");
        for (const step of steps) {
          const done = completed.includes(step);
          const isCurrent = result.current_step === step;
          const icon = done
            ? chalk.green("[x]")
            : isCurrent
              ? chalk.yellow("[>]")
              : chalk.gray("[ ]");
          const label = step.replace(/_/g, " ");
          console.log(
            `    ${icon} ${label}${isCurrent && result.last_error ? chalk.red(` (error: ${result.last_error})`) : ""}`,
          );
        }
      }

      if (result.status === "published" && result.approved_at) {
        console.log(`  Published: ${chalk.gray(result.approved_at)}`);
      }

      console.log();
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
        console.log(chalk.gray(`  ${error.message}`));
      } else {
        spinner.fail("Failed to check publication status");
        const msg = error instanceof Error ? error.message : String(error);
        console.log(chalk.gray(`  Error details: ${msg}`));
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
        console.log(chalk.gray(`  ${error.message}`));
        if (error.statusCode === 404) {
          console.log(chalk.gray("  Publication request not found for this dataset."));
        }
      } else {
        spinner.fail("Failed to resend notification");
        const msg = error instanceof Error ? error.message : String(error);
        console.log(chalk.gray(`  Error details: ${msg}`));
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

Requirements:
  - git-annex installed

Examples:
  $ nemar dataset clone nm000104
  $ nemar dataset clone nm000104 -o ./my-dataset`,
  )
  .action(async (datasetId, options) => {
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
    try {
      const dataset = await getDataset(datasetId);
      if (!dataset.github_repo || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(dataset.github_repo)) {
        spinner.fail("Dataset has no valid GitHub repository");
        console.log(chalk.red(`  Received: ${dataset.github_repo || "(empty)"}`));
        process.exit(1);
      }
      repoUrl = `https://github.com/${dataset.github_repo}.git`;
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

    spinner = ora("Cloning dataset...").start();
    const result = await cloneDataset(repoUrl, outputPath);
    if (!result.success) {
      spinner.fail("Clone failed");
      console.log(chalk.red(`  ${result.error}`));
      process.exit(1);
    }

    spinner.succeed("Dataset cloned");
    console.log();
    console.log(`  Location: ${chalk.cyan(outputPath)}`);
    console.log();
    console.log(chalk.gray("Data files are not downloaded yet. To get them:"));
    console.log(chalk.gray(`  cd ${outputPath}`));
    console.log(chalk.gray("  nemar dataset get"));
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

Examples:
  $ nemar dataset get                    # Get all files
  $ nemar dataset get sub-01/eeg/        # Get specific directory
  $ nemar dataset get *.edf -j 8         # Get EDF files with 8 streams`,
  )
  .action(async (files, options) => {
    const cwd = process.cwd();

    if (!(await isGitAnnexDataset(cwd))) {
      console.log(chalk.red("Error: Not inside a git-annex dataset directory"));
      console.log(chalk.gray("Use 'nemar dataset clone <id>' first, then cd into the dataset."));
      process.exit(1);
    }

    const jobs = Number.parseInt(options.jobs, 10);
    if (Number.isNaN(jobs) || jobs < 1) {
      console.log(chalk.red("Error: --jobs must be a positive integer"));
      process.exit(1);
    }

    const paths = files.length > 0 ? files : undefined;
    const desc = paths ? `Getting ${paths.length} path(s)...` : "Getting all data files...";
    const spinner = ora(desc).start();

    const result = await getDatasetData(cwd, { jobs, paths });
    if (!result.success) {
      spinner.fail("Failed to get data");
      console.log(chalk.red(`  ${result.error}`));
      process.exit(1);
    }

    if (result.filesDownloaded === 0) {
      spinner.succeed("All data files already present");
    } else {
      spinner.succeed(`Downloaded ${result.filesDownloaded} file(s)`);
    }
  });

// Save command
datasetCommand
  .command("save")
  .description("Stage and commit changes in the current dataset")
  .option("-m, --message <msg>", "Commit message", "Save changes")
  .addHelpText(
    "after",
    `
Description:
  Stage all changes (git add -A) and commit them. Large files are
  automatically handled by git-annex based on the dataset's largefiles config.

Examples:
  $ nemar dataset save
  $ nemar dataset save -m "Add new EEG recordings"`,
  )
  .action(async (options) => {
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
  });

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

  S3 push requires AWS credentials in environment (AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY).

Examples:
  $ nemar dataset push
  $ nemar dataset push --no-s3      # Git only, skip S3
  $ nemar dataset push -j 8         # More parallel S3 streams
  $ nemar dataset push --pr -t "Add new recordings"`,
  )
  .action(async (options) => {
    const cwd = process.cwd();

    if (!(await isGitAnnexDataset(cwd))) {
      console.log(chalk.red("Error: Not inside a git-annex dataset directory"));
      process.exit(1);
    }

    // Push git to GitHub
    let spinner = ora("Pushing to GitHub...").start();
    const gitResult = await pushToGitHub(cwd);

    if (!gitResult.success) {
      spinner.fail("Git push failed");
      console.log(chalk.red(`  ${gitResult.error}`));
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
            chalk.gray(`  Multiple S3 remotes: ${s3Remotes.join(", ")}. Using: ${remoteName}`),
          );
        }
        const jobs = Number.parseInt(options.jobs, 10);
        if (Number.isNaN(jobs) || jobs < 1) {
          console.log(chalk.red("Error: --jobs must be a positive integer"));
          process.exit(1);
        }
        spinner = ora(`Copying data to S3 (${remoteName})...`).start();

        const s3Result = await copyToAnnexRemote(cwd, remoteName, jobs);
        if (!s3Result.success) {
          spinner.fail("S3 push failed");
          console.log(chalk.red(`  ${s3Result.error}`));
          console.log(chalk.gray("  Ensure AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set."));
          console.log(chalk.gray("  Git changes were pushed successfully."));
          process.exit(1);
        }
        spinner.succeed(`Copied ${s3Result.filesCopied} file(s) to S3`);
      } else {
        console.log(chalk.gray("  No S3 remote configured; skipping data push."));
      }
    }

    // Create PR if --pr flag is set
    if (options.pr) {
      const branch = await getCurrentBranch(cwd);
      if (!branch) {
        console.log(chalk.red("  Could not determine current branch"));
        console.log(chalk.gray("  Ensure you are inside a valid git repository."));
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
            console.log(chalk.gray("  Install it: https://cli.github.com/"));
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
        console.log(chalk.gray(`  ${result.error}`));
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
        console.log(chalk.gray("Provide dataset ID explicitly: nemar dataset ci <id>"));
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
        console.log(`  BIDS Validation: ${chalk.gray("not configured")}`);
        console.log(chalk.gray(`  Ask an admin to run: nemar admin ci add ${resolvedId}`));
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
        console.log(chalk.gray(`  ${msg}`));
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
        console.log(chalk.gray("Provide dataset ID: nemar dataset manifest -d <id>"));
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
          console.log(chalk.gray("  No manifests available yet."));
          console.log(chalk.gray("  Manifests are generated when a version DOI is published."));
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
            console.log(`  Concept DOI: ${chalk.gray(manifest.concept_doi)}`);
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
              console.log(`    ${path} ${chalk.gray(`(${sizeStr})`)}`);
            }
          }

          if (gitFiles.length > 0) {
            console.log();
            console.log(chalk.bold(`  Metadata files (${gitFiles.length}):`));
            for (const [path, file] of gitFiles) {
              const sizeStr = formatSize(file.size);
              console.log(`    ${path} ${chalk.gray(`(${sizeStr})`)}`);
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
        console.log(chalk.gray(`  ${msg}`));
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
