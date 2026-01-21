/**
 * Sandbox training commands for NEMAR CLI
 *
 * Commands:
 * - nemar sandbox         - Run sandbox training (main entry point)
 * - nemar sandbox status  - Check if sandbox training is completed
 * - nemar sandbox reset   - Reset sandbox status for re-training
 */

import chalk from "chalk";
import { Command } from "commander";
import ora from "ora";
import {
  ApiError,
  completeSandbox,
  createDataset,
  finalizeDataset,
  getCurrentUser,
  getSandboxStatus,
  resetSandbox,
} from "../lib/api.js";
import { getConfig, isAuthenticated, isSandboxCompleted, setConfig } from "../lib/config.js";
import {
  checkPrerequisites,
  configureGitHubRemote,
  configureLargefiles,
  createDataladDataset,
  formatBytes,
  pushToGitHub,
  registerUrlsWithGitAnnex,
  saveDataset,
  uploadFilesWithPresignedUrls,
  verifyGitHubAuth,
} from "../lib/datalad.js";
import {
  cleanupSandboxDataset,
  generateSandboxDataset,
  getSandboxDatasetSize,
} from "../lib/sandbox.js";

export const sandboxCommand = new Command("sandbox")
  .description("Complete sandbox training before uploading datasets")
  .addHelpText(
    "after",
    `
Description:
  Sandbox training verifies your setup and familiarizes you with the upload
  workflow. You must complete sandbox training before uploading real datasets.

  The training creates a placeholder BIDS dataset (~500KB) and uploads it to
  the sandbox environment, testing your DataLad, git-annex, and SSH setup.

Examples:
  $ nemar sandbox           # Run sandbox training
  $ nemar sandbox status    # Check if training is completed
  $ nemar sandbox reset     # Reset for re-training
`,
  )
  .action(sandboxAction);

// ============================================================================
// Main sandbox training action
// ============================================================================

async function sandboxAction(): Promise<void> {
  console.log();
  console.log(chalk.bold("NEMAR Sandbox Training"));
  console.log(chalk.gray("Verify your setup and learn the upload workflow"));
  console.log();

  // Step 1: Check authentication
  if (!isAuthenticated()) {
    console.log(chalk.red("Not authenticated"));
    console.log(chalk.gray("Run 'nemar auth login' first"));
    return;
  }

  // Step 2: Check if already completed
  const config = getConfig();
  if (config.sandboxCompleted) {
    console.log(chalk.green("Sandbox training already completed!"));
    console.log(chalk.gray(`Dataset ID: ${config.sandboxDatasetId}`));
    console.log();
    console.log("You can upload real datasets with:");
    console.log(chalk.cyan("  nemar dataset upload ./your-dataset"));
    console.log();
    console.log(chalk.gray("To re-run training, use: nemar sandbox reset"));
    return;
  }

  // Step 3: Check prerequisites
  console.log(chalk.bold("Step 1/6: Checking prerequisites..."));
  const prereqSpinner = ora("Checking DataLad, git-annex, and SSH...").start();

  const prereqs = await checkPrerequisites();
  if (!prereqs.allPassed) {
    prereqSpinner.fail("Prerequisites check failed");
    console.log();
    console.log(chalk.red("Missing requirements:"));
    for (const error of prereqs.errors) {
      console.log(chalk.yellow(`  - ${error}`));
    }
    if (!prereqs.githubSSH.accessible) {
      console.log(chalk.gray("    Run 'nemar auth setup-ssh' to configure SSH"));
    }
    return;
  }
  prereqSpinner.succeed("All prerequisites met");

  // Step 3b: Verify gh CLI authentication
  const ghSpinner = ora("Verifying GitHub CLI authentication...").start();
  const ghAuth = await verifyGitHubAuth(config.githubUsername);

  if (!ghAuth.authenticated) {
    ghSpinner.fail("GitHub CLI not authenticated");
    console.log(chalk.red(`  ${ghAuth.error}`));
    console.log();
    console.log("GitHub CLI is required for sandbox training. Install and authenticate:");
    console.log(chalk.cyan("  brew install gh       # or visit https://cli.github.com/"));
    console.log(chalk.cyan("  gh auth login"));
    return;
  }

  if (config.githubUsername && !ghAuth.matches) {
    ghSpinner.warn("GitHub CLI user mismatch");
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
    // Continue with warning; don't block
  } else {
    ghSpinner.succeed(`GitHub CLI authenticated as ${ghAuth.username}`);
  }

  // Step 4: Generate sandbox dataset
  console.log();
  console.log(chalk.bold("Step 2/6: Generating test dataset..."));
  const genSpinner = ora("Creating minimal BIDS structure...").start();

  let datasetPath: string;
  try {
    const paths = generateSandboxDataset();
    datasetPath = paths.root;
    const size = getSandboxDatasetSize(paths);
    genSpinner.succeed(`Test dataset created (${formatBytes(size)})`);
    console.log(chalk.gray(`  Location: ${datasetPath}`));
  } catch (error) {
    genSpinner.fail("Failed to generate test dataset");
    console.log(chalk.red(`  ${error instanceof Error ? error.message : "Unknown error"}`));
    return;
  }

  // Step 5: Create dataset via API
  console.log();
  console.log(chalk.bold("Step 3/6: Registering sandbox dataset..."));
  const apiSpinner = ora("Creating dataset on NEMAR...").start();

  let datasetId: string;
  let sshUrl: string;
  let s3Config: { bucket: string; region: string; public_url: string };
  let s3Prefix: string;
  let uploadUrls: Record<string, string>;

  try {
    const response = await createDataset({
      name: "Sandbox Training Dataset",
      description: "Placeholder dataset for sandbox training",
      files: [
        { path: "sub-01/eeg/sub-01_task-rest_eeg.edf", size: 512000, type: "data" },
        { path: "dataset_description.json", size: 200, type: "metadata" },
        { path: "participants.tsv", size: 50, type: "metadata" },
        { path: "README", size: 500, type: "metadata" },
        { path: "sub-01/eeg/sub-01_task-rest_eeg.json", size: 300, type: "metadata" },
      ],
      sandbox: true,
    });

    datasetId = response.dataset.dataset_id;
    sshUrl = response.dataset.ssh_url;
    s3Config = response.s3_config;
    s3Prefix = response.dataset.s3_prefix;
    uploadUrls = response.upload_urls || {};

    apiSpinner.succeed(`Sandbox dataset created: ${chalk.cyan(datasetId)}`);
    console.log(chalk.gray(`  GitHub: ${response.dataset.github_url}`));

    // Wait for IAM policy propagation (AWS is eventually consistent)
    // This initial wait helps reduce retry attempts during upload
    await new Promise((resolve) => setTimeout(resolve, 10000));
  } catch (error) {
    apiSpinner.fail("Failed to create sandbox dataset");
    if (error instanceof ApiError) {
      console.log(chalk.red(`  ${error.message}`));
    } else {
      console.log(chalk.red(`  ${error instanceof Error ? error.message : "Unknown error"}`));
    }
    cleanupSandboxDataset(datasetPath);
    return;
  }

  // Step 6: Initialize DataLad and configure remotes
  console.log();
  console.log(chalk.bold("Step 4/6: Initializing repository..."));
  const initSpinner = ora("Setting up DataLad and git-annex...").start();

  try {
    await createDataladDataset(datasetPath);
    await configureLargefiles(datasetPath);
    await configureGitHubRemote(datasetPath, sshUrl);
    initSpinner.succeed("Repository initialized");
  } catch (error) {
    initSpinner.fail("Failed to initialize repository");
    console.log(chalk.red(`  ${error instanceof Error ? error.message : "Unknown error"}`));
    cleanupSandboxDataset(datasetPath);
    return;
  }

  // Step 7: Upload files to S3
  console.log();
  console.log(chalk.bold("Step 5/6: Uploading to S3..."));

  if (Object.keys(uploadUrls).length === 0) {
    console.log(chalk.yellow("  No data files to upload (metadata only)"));
  } else {
    const uploadSpinner = ora("Uploading test data...").start();

    try {
      let completedFiles = 0;
      const totalFiles = Object.keys(uploadUrls).length;

      const result = await uploadFilesWithPresignedUrls(datasetPath, uploadUrls, {
        jobs: 4,
        onProgress: (progress) => {
          if (progress.status === "completed" || progress.status === "failed") {
            completedFiles++;
            uploadSpinner.text = `Uploading... ${completedFiles}/${totalFiles} files`;
          }
        },
      });

      if (result.failed.length > 0) {
        uploadSpinner.fail(`Upload failed for ${result.failed.length} file(s)`);
        for (const failedFile of result.failed) {
          console.log(chalk.red(`    Failed: ${failedFile}`));
        }
        if (result.error) {
          console.log(chalk.red(`    Error: ${result.error}`));
        }
        console.log();
        console.log(chalk.yellow("Sandbox training aborted due to upload failures."));
        console.log(chalk.gray("Please check your network connection and try again."));
        cleanupSandboxDataset(datasetPath);
        return;
      }
      uploadSpinner.succeed(`Uploaded ${result.uploaded} file(s)`);
    } catch (error) {
      uploadSpinner.fail("Upload failed");
      console.log(chalk.red(`  ${error instanceof Error ? error.message : "Unknown error"}`));
      cleanupSandboxDataset(datasetPath);
      return;
    }

    // Register URLs with git-annex
    const registerSpinner = ora("Registering file URLs...").start();
    try {
      // Construct full S3 URLs for each file
      const fileUrls: Record<string, string> = {};
      for (const filePath of Object.keys(uploadUrls)) {
        fileUrls[filePath] = `${s3Config.public_url}/${s3Prefix}/${filePath}`;
      }

      const registerResult = await registerUrlsWithGitAnnex(datasetPath, fileUrls);
      if (!registerResult.success) {
        registerSpinner.fail(`URL registration failed for ${registerResult.failed.length} file(s)`);
        for (const failedFile of registerResult.failed) {
          console.log(chalk.red(`    Failed: ${failedFile}`));
        }
        console.log();
        console.log(chalk.yellow("Sandbox training aborted due to URL registration failures."));
        console.log(chalk.gray("This may indicate a git-annex configuration issue."));
        cleanupSandboxDataset(datasetPath);
        return;
      }
      registerSpinner.succeed(`Registered ${registerResult.registered} file URLs`);
    } catch (error) {
      registerSpinner.fail("Failed to register URLs");
      console.log(chalk.red(`  ${error instanceof Error ? error.message : "Unknown error"}`));
      cleanupSandboxDataset(datasetPath);
      return;
    }
  }

  // Step 8: Save and push to GitHub
  console.log();
  console.log(chalk.bold("Step 6/6: Pushing to GitHub..."));
  const pushSpinner = ora("Saving and pushing...").start();

  try {
    // Use NEMAR user identity for commit authorship
    const author =
      config.username && config.email ? { name: config.username, email: config.email } : undefined;
    await saveDataset(datasetPath, "Initial sandbox training upload", author);
    await pushToGitHub(datasetPath);
    pushSpinner.succeed("Pushed to GitHub");
  } catch (error) {
    pushSpinner.fail("Failed to push to GitHub");
    console.log(chalk.red(`  ${error instanceof Error ? error.message : "Unknown error"}`));
    cleanupSandboxDataset(datasetPath);
    return;
  }

  // Step 9: Finalize and mark complete
  const finalizeSpinner = ora("Finalizing...").start();

  try {
    await finalizeDataset(datasetId);
    await completeSandbox(datasetId);

    // Update local config
    setConfig("sandboxCompleted", true);
    setConfig("sandboxDatasetId", datasetId);

    finalizeSpinner.succeed("Sandbox training complete!");
  } catch (error) {
    finalizeSpinner.fail("Failed to finalize");
    console.log(chalk.red(`  ${error instanceof Error ? error.message : "Unknown error"}`));
    cleanupSandboxDataset(datasetPath);
    return;
  }

  // Cleanup temp directory
  cleanupSandboxDataset(datasetPath);

  // Success message
  console.log();
  console.log(chalk.green.bold("Congratulations! Sandbox training completed successfully."));
  console.log();
  console.log("Your setup is verified and you're ready to upload real datasets:");
  console.log(chalk.cyan("  nemar dataset upload ./your-dataset"));
  console.log();
  console.log(chalk.gray(`Sandbox dataset: ${datasetId}`));
}

// ============================================================================
// Status command
// ============================================================================

sandboxCommand
  .command("status")
  .description("Check sandbox training completion status")
  .option("--refresh", "Fetch latest status from server")
  .action(async (options: { refresh?: boolean }) => {
    if (!isAuthenticated()) {
      console.log(chalk.red("Not authenticated"));
      console.log(chalk.gray("Run 'nemar auth login' first"));
      return;
    }

    if (options.refresh) {
      // Fetch from server
      const spinner = ora("Checking status...").start();
      try {
        const status = await getSandboxStatus();
        setConfig("sandboxCompleted", status.sandbox_completed);
        if (status.sandbox_dataset_id) {
          setConfig("sandboxDatasetId", status.sandbox_dataset_id);
        }
        spinner.stop();

        if (status.sandbox_completed) {
          console.log(chalk.green("Sandbox training: Completed"));
          console.log(chalk.gray(`  Dataset ID: ${status.sandbox_dataset_id}`));
          if (status.sandbox_completed_at) {
            console.log(chalk.gray(`  Completed: ${status.sandbox_completed_at}`));
          }
        } else {
          console.log(chalk.yellow("Sandbox training: Not completed"));
          console.log();
          console.log("Run sandbox training with:");
          console.log(chalk.cyan("  nemar sandbox"));
        }
      } catch (error) {
        spinner.fail("Failed to check status");
        if (error instanceof ApiError) {
          console.log(chalk.red(`  ${error.message}`));
        }
      }
    } else {
      // Check local config
      const config = getConfig();
      if (config.sandboxCompleted) {
        console.log(chalk.green("Sandbox training: Completed"));
        console.log(chalk.gray(`  Dataset ID: ${config.sandboxDatasetId}`));
      } else {
        console.log(chalk.yellow("Sandbox training: Not completed"));
        console.log();
        console.log("Run sandbox training with:");
        console.log(chalk.cyan("  nemar sandbox"));
      }
    }
  });

// ============================================================================
// Reset command
// ============================================================================

sandboxCommand
  .command("reset")
  .description("Reset sandbox training status for re-training")
  .option("-f, --force", "Skip confirmation prompt")
  .action(async (options: { force?: boolean }) => {
    if (!isAuthenticated()) {
      console.log(chalk.red("Not authenticated"));
      console.log(chalk.gray("Run 'nemar auth login' first"));
      return;
    }

    const config = getConfig();
    if (!config.sandboxCompleted) {
      console.log(chalk.yellow("Sandbox training not yet completed"));
      console.log(chalk.gray("Nothing to reset"));
      return;
    }

    if (!options.force) {
      const inquirer = (await import("inquirer")).default;
      const { confirm } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirm",
          message: "Reset sandbox training status? You will need to complete training again.",
          default: false,
        },
      ]);

      if (!confirm) {
        console.log(chalk.gray("Cancelled"));
        return;
      }
    }

    const spinner = ora("Resetting sandbox status...").start();

    try {
      await resetSandbox();

      // Clear local config
      setConfig("sandboxCompleted", false);
      setConfig("sandboxDatasetId", undefined);

      spinner.succeed("Sandbox status reset");
      console.log();
      console.log("Run sandbox training again with:");
      console.log(chalk.cyan("  nemar sandbox"));
    } catch (error) {
      spinner.fail("Failed to reset");
      if (error instanceof ApiError) {
        console.log(chalk.red(`  ${error.message}`));
      } else {
        console.log(chalk.red(`  ${error instanceof Error ? error.message : "Unknown error"}`));
      }
    }
  });
