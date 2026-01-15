/**
 * Dataset management commands for NEMAR CLI
 *
 * Commands:
 * - nemar dataset validate   - Validate BIDS dataset locally
 * - nemar dataset upload     - Upload dataset to NEMAR
 * - nemar dataset download   - Download dataset from NEMAR
 * - nemar dataset status     - Check dataset status
 * - nemar dataset list       - List user's datasets
 * - nemar dataset version    - Create new version with DOI
 */

import chalk from "chalk";
import { Command } from "commander";
import ora from "ora";
import inquirer from "inquirer";
import { existsSync, readFileSync } from "fs";
import { resolve, basename } from "path";
import { isAuthenticated, getConfig } from "../lib/config.js";
import {
  checkDenoInstalled,
  getValidatorVersion,
  validateBidsDataset,
  formatValidationResult,
  type BidsValidationResult,
} from "../lib/bids-validator.js";
import {
  checkPrerequisites,
  isDataladDataset,
  createDataladDataset,
  configureLargefiles,
  configureS3Remote,
  configureGitHubRemote,
  saveDataset,
  pushToS3,
  pushToGitHub,
  getDatasetStats,
  formatBytes,
} from "../lib/datalad.js";
import { createDataset, finalizeDataset, ApiError } from "../lib/api.js";

export const datasetCommand = new Command("dataset").description("Dataset management");

// Validate command
datasetCommand
  .command("validate")
  .description("Validate a BIDS dataset locally")
  .argument("[path]", "Path to BIDS dataset directory")
  .option("--ignore-warnings", "Only report errors, not warnings")
  .option("-c, --config <file>", "Validation config file (.bidsvalidatorrc)")
  .option("-r, --recursive", "Validate derivatives subdirectories")
  .option("--prune", "Skip sourcedata and derivatives for faster validation")
  .option("-v, --verbose", "Show verbose output")
  .option("--json", "Output results as JSON")
  .option("--version-info", "Show BIDS validator version")
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
      console.log(`Missing required file: dataset_description.json`);
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
  .option("-j, --jobs <number>", "Parallel upload streams", "8")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (datasetPath, options) => {
    // Step 1: Check authentication
    if (!isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      console.log("Run 'nemar auth login' first");
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
    console.log(chalk.gray(`  DataLad ${prereqs.datalad.version}, git-annex ${prereqs.gitAnnex.version}`));
    if (prereqs.githubSSH.username) {
      console.log(chalk.gray(`  GitHub SSH: ${prereqs.githubSSH.username}`));
    }
    console.log();

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
        spinner.warn("Skipping validation (Deno not installed)");
        console.log(chalk.gray("Install Deno to enable BIDS validation: https://deno.com"));
      } else {
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
      }
      console.log();
    }

    // Step 4: Get dataset info and show upload plan
    const datasetName = options.name || basename(absolutePath);
    const stats = await getDatasetStats(absolutePath);

    console.log(chalk.bold("Upload Plan:"));
    console.log(`  Name: ${datasetName}`);
    console.log(`  Path: ${absolutePath}`);
    console.log(`  Files: ${stats.totalFiles}`);
    if (stats.totalSize > 0) {
      console.log(`  Size: ${formatBytes(stats.totalSize)}`);
    }
    console.log(`  Parallel jobs: ${options.jobs}`);
    console.log();

    // Dry run mode
    if (options.dryRun) {
      console.log(chalk.yellow("Dry run mode - no changes made"));
      return;
    }

    // Step 5: Confirm with user
    if (!options.yes) {
      const { confirmed } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirmed",
          message: "Proceed with upload?",
          default: true,
        },
      ]);

      if (!confirmed) {
        console.log("Upload cancelled.");
        return;
      }
    }

    console.log();

    // Step 6: Create dataset in backend
    spinner = ora("Creating dataset in NEMAR...").start();

    let datasetInfo: {
      dataset_id: string;
      ssh_url: string;
      s3_prefix: string;
      github_url: string;
    };

    try {
      const response = await createDataset({
        name: datasetName,
        description: options.description,
      });

      datasetInfo = {
        dataset_id: response.dataset.dataset_id,
        ssh_url: response.dataset.ssh_url,
        s3_prefix: response.dataset.s3_prefix,
        github_url: response.dataset.github_url,
      };

      spinner.succeed(`Dataset created: ${datasetInfo.dataset_id}`);
    } catch (error) {
      spinner.fail("Failed to create dataset");
      if (error instanceof ApiError) {
        console.log(chalk.red(`  ${error.message}`));
      } else {
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }

    // Step 7: Initialize DataLad dataset
    spinner = ora("Initializing DataLad dataset...").start();

    const isExistingDataset = await isDataladDataset(absolutePath);
    if (!isExistingDataset) {
      const createResult = await createDataladDataset(absolutePath);
      if (!createResult.success) {
        spinner.fail("Failed to initialize DataLad dataset");
        console.log(chalk.red(`  ${createResult.error}`));
        process.exit(1);
      }
    }

    // Configure largefiles pattern
    const largefilesResult = await configureLargefiles(absolutePath);
    if (!largefilesResult.success) {
      spinner.warn("Could not configure largefiles pattern");
      console.log(chalk.gray(`  ${largefilesResult.error}`));
    }

    spinner.succeed("DataLad dataset initialized");

    // Step 8: Configure S3 remote
    spinner = ora("Configuring S3 remote...").start();

    // Get AWS credentials from environment or aws configure
    const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

    if (!awsAccessKeyId || !awsSecretAccessKey) {
      spinner.fail("AWS credentials not found in environment");
      console.log(chalk.red("Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables"));
      process.exit(1);
    }

    const s3Result = await configureS3Remote(
      absolutePath,
      {
        name: "nemar-s3",
        bucket: "nemar",
        prefix: datasetInfo.s3_prefix,
        region: "us-east-2",
        publicUrl: "https://nemar.s3.us-east-2.amazonaws.com",
      },
      {
        accessKeyId: awsAccessKeyId,
        secretAccessKey: awsSecretAccessKey,
      }
    );

    if (!s3Result.success) {
      spinner.fail("Failed to configure S3 remote");
      console.log(chalk.red(`  ${s3Result.error}`));
      process.exit(1);
    }

    spinner.succeed("S3 remote configured");

    // Step 9: Configure GitHub remote
    spinner = ora("Configuring GitHub remote...").start();

    const githubResult = await configureGitHubRemote(absolutePath, datasetInfo.ssh_url);
    if (!githubResult.success) {
      spinner.fail("Failed to configure GitHub remote");
      console.log(chalk.red(`  ${githubResult.error}`));
      process.exit(1);
    }

    spinner.succeed("GitHub remote configured");

    // Step 10: Save dataset changes
    spinner = ora("Saving dataset changes...").start();

    const saveResult = await saveDataset(absolutePath, "Initial NEMAR dataset upload");
    if (!saveResult.success) {
      spinner.fail("Failed to save dataset");
      console.log(chalk.red(`  ${saveResult.error}`));
      process.exit(1);
    }

    spinner.succeed("Dataset changes saved");

    // Step 11: Push metadata to GitHub
    spinner = ora("Pushing metadata to GitHub...").start();

    const githubPushResult = await pushToGitHub(absolutePath);
    if (!githubPushResult.success) {
      spinner.fail("Failed to push to GitHub");
      console.log(chalk.red(`  ${githubPushResult.error}`));
      process.exit(1);
    }

    spinner.succeed("Metadata pushed to GitHub");

    // Step 12: Push data to S3
    spinner = ora(`Uploading data to S3 (${options.jobs} parallel streams)...`).start();

    const s3PushResult = await pushToS3(absolutePath, "nemar-s3", {
      jobs: parseInt(options.jobs, 10),
      credentials: {
        accessKeyId: awsAccessKeyId,
        secretAccessKey: awsSecretAccessKey,
      },
    });

    if (!s3PushResult.success) {
      spinner.fail("Failed to upload data to S3");
      console.log(chalk.red(`  ${s3PushResult.error}`));
      process.exit(1);
    }

    spinner.succeed(`Data uploaded to S3 (${s3PushResult.filesUploaded || 0} files)`);

    // Step 13: Finalize dataset
    spinner = ora("Finalizing dataset...").start();

    try {
      await finalizeDataset(datasetInfo.dataset_id);
      spinner.succeed("Dataset finalized");
    } catch (error) {
      spinner.warn("Could not finalize dataset (branch protection may need manual setup)");
      console.log(chalk.gray(`  ${(error as Error).message}`));
    }

    // Step 14: Success!
    console.log();
    console.log(chalk.green.bold("Upload complete!"));
    console.log();
    console.log(`  Dataset ID: ${chalk.cyan(datasetInfo.dataset_id)}`);
    console.log(`  GitHub: ${chalk.cyan(datasetInfo.github_url)}`);
    console.log();
    console.log(chalk.gray("To clone this dataset:"));
    console.log(chalk.gray(`  datalad clone ${datasetInfo.ssh_url}`));
  });

// Download command
datasetCommand
  .command("download")
  .description("Download a dataset from NEMAR")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option("-o, --output <path>", "Output directory", ".")
  .option("--version <version>", "Specific version to download")
  .option("--no-data", "Download metadata only (no large files)")
  .action(async (datasetId, options) => {
    console.log(chalk.yellow("Download command not yet implemented"));
    console.log(`Would download dataset: ${datasetId}`);
    console.log("Will use datalad clone and get");
    // TODO: Implement download
    // 1. Clone DataLad dataset from GitHub
    // 2. Get data files from S3 (unless --no-data)
    // 3. Report success
  });

// Status command
datasetCommand
  .command("status")
  .description("Check status of a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .action(async (datasetId) => {
    console.log(chalk.yellow("Status command not yet implemented"));
    console.log(`Would check status of: ${datasetId}`);
    // TODO: Implement status check
    // 1. Query backend for dataset info
    // 2. Show: name, description, versions, DOI, size, etc.
  });

// List command
datasetCommand
  .command("list")
  .description("List your datasets")
  .option("--all", "List all NEMAR datasets (not just yours)")
  .action(async (options) => {
    if (!options.all && !isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      console.log("Run 'nemar auth login' to see your datasets");
      console.log("Or use --all to see all public datasets");
      process.exit(1);
    }

    console.log(chalk.yellow("List command not yet implemented"));
    console.log("Will query backend for datasets");
    // TODO: Implement list
    // 1. Query backend for user's datasets (or all)
    // 2. Display in table format
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
