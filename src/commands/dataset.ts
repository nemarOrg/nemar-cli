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
import { existsSync } from "fs";
import { resolve } from "path";
import { isAuthenticated } from "../lib/config.js";
import {
  checkDenoInstalled,
  getValidatorVersion,
  validateBidsDataset,
  formatValidationResult,
  type BidsValidationResult,
} from "../lib/bids-validator.js";

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
  .option("--dataset-id <id>", "Existing dataset ID for updates")
  .option("--skip-validation", "Skip BIDS validation (not recommended)")
  .action(async (path, options) => {
    if (!isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      console.log("Run 'nemar auth login' first");
      process.exit(1);
    }

    console.log(chalk.yellow("Upload command not yet implemented"));
    console.log(`Would upload BIDS dataset from: ${path}`);
    console.log("Will create DataLad dataset, configure S3, push to GitHub");
    // TODO: Implement upload
    // 1. Validate dataset (unless --skip-validation)
    // 2. Create DataLad dataset
    // 3. Configure S3 special remote
    // 4. Create GitHub repository
    // 5. Push to GitHub + S3
    // 6. Report success with URLs
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
