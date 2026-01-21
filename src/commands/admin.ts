/**
 * Admin commands for NEMAR CLI
 *
 * These commands require admin privileges.
 *
 * Commands:
 * - nemar admin users          - List users (pending, approved, all)
 * - nemar admin approve        - Approve a pending user
 * - nemar admin revoke         - Revoke user access
 * - nemar admin regenerate-iam - Regenerate AWS credentials for a user
 * - nemar admin revert         - Revert dataset to a previous version
 * - nemar admin doi create     - Create concept DOI for dataset
 * - nemar admin doi info       - Get DOI info for dataset
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import {
  ApiError,
  type Dataset,
  approveUser,
  createConceptDoi,
  finalizeDataset,
  getDataset,
  getDoiInfo,
  listUsers,
  regenerateUserIam,
  revokeUser,
} from "../lib/api.js";
import { getConfig, isAuthenticated } from "../lib/config.js";
import {
  checkDownloadPrerequisites,
  cloneDataset,
  commitRevert,
  createRevertBranch,
  getVersionCommit,
  listDatasetVersions,
  pushBranch,
} from "../lib/datalad.js";

export const adminCommand = new Command("admin")
  .description("Admin commands (requires admin privileges)")
  .addHelpText(
    "after",
    `
Description:
  Administrative commands for managing NEMAR users and datasets.
  These commands require admin privileges.

User Management:
  users          - List users and their status
  approve        - Approve a pending user registration
  revoke         - Revoke user access
  regenerate-iam - Regenerate AWS credentials for a user

Dataset Management:
  doi      - Create and manage DOIs for datasets
  revert   - Revert dataset to previous version (via PR)

Examples:
  $ nemar admin users --verified           # List users awaiting approval
  $ nemar admin approve john_doe           # Approve a user
  $ nemar admin regenerate-iam john_doe    # Regenerate AWS credentials
  $ nemar admin doi create nm000104        # Create concept DOI`,
  );

/**
 * Check authentication and show error if not authenticated
 */
function requireAuth(): boolean {
  if (!isAuthenticated()) {
    console.log(chalk.red("Error: Not authenticated"));
    console.log(chalk.gray("  Run 'nemar auth login' first"));
    return false;
  }
  return true;
}

// ============================================================================
// Users
// ============================================================================

adminCommand
  .command("users")
  .description("List NEMAR users")
  .option("--pending", "Show only pending approval")
  .option("--verified", "Show only verified (awaiting approval)")
  .option("--approved", "Show only approved users")
  .option("--revoked", "Show only revoked users")
  .action(async (options) => {
    if (!requireAuth()) return;

    // Determine status filter
    let status: string | undefined;
    if (options.pending) status = "pending";
    else if (options.verified) status = "verified";
    else if (options.approved) status = "approved";
    else if (options.revoked) status = "revoked";

    const spinner = ora("Fetching users...").start();

    try {
      const result = await listUsers(status);
      spinner.stop();

      if (result.users.length === 0) {
        console.log(chalk.yellow("No users found"));
        return;
      }

      console.log(`\n${chalk.cyan("NEMAR Users")} (${result.count} total)\n`);

      // Display users in a clean format
      for (const user of result.users) {
        const statusColor =
          {
            pending: chalk.gray,
            verified: chalk.yellow,
            approved: chalk.green,
            revoked: chalk.red,
          }[user.status] || chalk.white;

        const adminBadge = user.is_admin ? chalk.magenta(" [admin]") : "";
        const verifiedBadge = user.email_verified ? "" : chalk.gray(" (unverified)");

        console.log(`  ${chalk.cyan(user.username)}${adminBadge}`);
        console.log(`    Email:   ${user.email}${verifiedBadge}`);
        console.log(`    GitHub:  @${user.github_username}`);
        console.log(`    Status:  ${statusColor(user.status)}`);
        console.log(`    Created: ${new Date(user.created_at).toLocaleDateString()}`);
        console.log();
      }
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
        if (error.statusCode === 403) {
          console.log(chalk.gray("  This command requires admin privileges"));
        }
      } else {
        spinner.fail("Failed to fetch users");
      }
    }
  });

// ============================================================================
// Approve
// ============================================================================

adminCommand
  .command("approve")
  .description("Approve a pending user")
  .argument("<username>", "Username to approve")
  .action(async (username) => {
    if (!requireAuth()) return;

    // Confirmation
    console.log(chalk.cyan(`\nApproving user: ${username}\n`));
    console.log("This will:");
    console.log("  1. Generate an API key for the user");
    console.log("  2. Send them an email with their API key");
    console.log();

    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: `Approve ${username}?`,
        default: true,
      },
    ]);

    if (!confirm) {
      console.log(chalk.gray("Cancelled"));
      return;
    }

    const spinner = ora(`Approving ${username}...`).start();

    try {
      const result = await approveUser(username);
      spinner.succeed(`Approved ${username}`);
      console.log();
      console.log(`  Email: ${result.user.email}`);
      console.log(`  Status: ${chalk.green(result.user.status)}`);

      // Show IAM setup status
      if (result.iam_setup === true) {
        console.log(`  S3 Access: ${chalk.green("configured")}`);
      } else if (result.iam_setup === false) {
        console.log(`  S3 Access: ${chalk.red("NOT configured")}`);
      }

      console.log();
      console.log(chalk.yellow("API Key (shown once):"));
      console.log(chalk.gray(`  ${result.api_key}`));
      console.log();
      console.log(chalk.gray("The user has also been emailed their API key"));

      // Show warning if IAM setup failed
      if (result.warning) {
        console.log();
        console.log(chalk.yellow(`Warning: ${result.warning}`));
      }
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
        if (error.statusCode === 403) {
          console.log(chalk.gray("  This command requires admin privileges"));
        } else if (error.statusCode === 404) {
          console.log(chalk.gray("  User not found or not in 'verified' status"));
        }
      } else {
        spinner.fail("Failed to approve user");
      }
    }
  });

// ============================================================================
// Revoke
// ============================================================================

adminCommand
  .command("revoke")
  .description("Revoke user access")
  .argument("<username>", "Username to revoke")
  .action(async (username) => {
    if (!requireAuth()) return;

    // Prevent self-revocation
    const config = getConfig();
    if (config.username === username) {
      console.log(chalk.red("Error: Cannot revoke your own access"));
      return;
    }

    // Confirmation with warning
    console.log(chalk.red(`\nRevoking access for: ${username}\n`));
    console.log(chalk.yellow("This will:"));
    console.log("  1. Invalidate all API keys for this user");
    console.log("  2. Remove them from datasets they have access to");
    console.log("  3. Send them a notification email");
    console.log();

    const { confirm } = await inquirer.prompt([
      {
        type: "input",
        name: "confirm",
        message: `Type '${username}' to confirm revocation:`,
        validate: (input) => {
          if (input !== username) {
            return "Username does not match";
          }
          return true;
        },
      },
    ]);

    const spinner = ora(`Revoking ${username}...`).start();

    try {
      await revokeUser(username);
      spinner.succeed(`Revoked access for ${username}`);
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
        if (error.statusCode === 403) {
          console.log(chalk.gray("  This command requires admin privileges"));
        } else if (error.statusCode === 404) {
          console.log(chalk.gray("  User not found"));
        }
      } else {
        spinner.fail("Failed to revoke user");
      }
    }
  });

// ============================================================================
// Regenerate IAM
// ============================================================================

adminCommand
  .command("regenerate-iam")
  .description("Regenerate AWS IAM credentials for a user")
  .argument("<username>", "Username to regenerate credentials for")
  .option("--yes", "Skip confirmation prompt")
  .action(async (username, options) => {
    if (!requireAuth()) return;

    // Confirmation with warning
    console.log(chalk.yellow(`\nRegenerate IAM credentials for: ${username}\n`));
    console.log("This will:");
    console.log("  1. Create new AWS IAM access keys for the user");
    console.log("  2. Invalidate any existing access keys");
    console.log("  3. Restore S3 access to their datasets");
    console.log();
    console.log(chalk.gray("Use this if a user's credentials were compromised or lost."));
    console.log();

    let confirm = options.yes;
    if (!confirm) {
      const answers = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirm",
          message: `Regenerate IAM credentials for ${username}?`,
          default: false,
        },
      ]);
      confirm = answers.confirm;
    }

    if (!confirm) {
      console.log(chalk.gray("Cancelled"));
      return;
    }

    const spinner = ora(`Regenerating IAM credentials for ${username}...`).start();

    try {
      const result = await regenerateUserIam(username);
      spinner.succeed(`Regenerated IAM credentials for ${username}`);
      console.log();
      console.log(`  IAM Username: ${chalk.cyan(result.user.iam_username)}`);
      if (result.user.is_admin) {
        console.log(`  Admin: ${chalk.magenta("yes (full bucket access)")}`);
      }
      console.log(`  Datasets restored: ${chalk.green(result.datasets_restored)}`);

      // Show warning if old key revocation failed (security concern)
      if (result.warning) {
        console.log();
        console.log(chalk.yellow(`  Warning: ${result.warning}`));
        console.log(chalk.gray("  Please verify old credentials are revoked in AWS console."));
      }

      console.log();
      console.log(chalk.gray("The user can now upload to their datasets again."));
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
        if (error.statusCode === 403) {
          console.log(chalk.gray("  This command requires admin privileges"));
        } else if (error.statusCode === 404) {
          console.log(chalk.gray("  User not found or not approved"));
        }
      } else {
        spinner.fail("Failed to regenerate IAM credentials");
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log(chalk.gray(`  Error details: ${errorMessage}`));
      }
    }
  });

// ============================================================================
// DOI (placeholder for future implementation)
// ============================================================================

const doiCommand = new Command("doi").description("DOI management");

doiCommand
  .command("create")
  .description("Create concept DOI for a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option("--title <title>", "DOI title (defaults to dataset name)")
  .option("--description <desc>", "DOI description")
  .option("--sandbox", "Use Zenodo sandbox for testing")
  .action(async (datasetId, options) => {
    if (!requireAuth()) return;

    // Get dataset info
    const spinner = ora("Fetching dataset info...").start();
    let dataset: Dataset;
    try {
      dataset = await getDataset(datasetId);
      spinner.succeed(`Found dataset: ${dataset.name}`);
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
        if (error.statusCode === 404) {
          console.log(chalk.gray("  Dataset not found"));
        }
      } else {
        spinner.fail("Failed to fetch dataset");
      }
      return;
    }

    // Check if already has concept DOI
    try {
      const doiInfo = await getDoiInfo(datasetId);
      if (doiInfo.concept_doi) {
        console.log(chalk.yellow("\nDataset already has a concept DOI:"));
        console.log(`  Concept DOI: ${chalk.cyan(doiInfo.concept_doi)}`);
        if (doiInfo.zenodo_concept_url) {
          console.log(`  Zenodo URL:  ${doiInfo.zenodo_concept_url}`);
        }
        return;
      }
    } catch {
      // No DOI info yet, continue
    }

    // Display summary
    console.log();
    console.log(chalk.cyan("Dataset Information:"));
    console.log(`  ID:          ${dataset.dataset_id}`);
    console.log(`  Name:        ${dataset.name}`);
    if (dataset.github_repo) {
      console.log(`  GitHub:      ${dataset.github_repo}`);
    }
    if (options.sandbox) {
      console.log(`  Mode:        ${chalk.yellow("SANDBOX (test DOI)")}`);
    }
    console.log();

    // Confirmation
    console.log(chalk.red("WARNING: DOIs are PERMANENT and cannot be deleted!"));
    console.log(
      chalk.gray("The DOI will be pre-reserved but not published until the first version release."),
    );
    console.log();

    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: options.sandbox
          ? "Create test concept DOI on Zenodo sandbox?"
          : "Create concept DOI on Zenodo?",
        default: false,
      },
    ]);

    if (!confirm) {
      console.log(chalk.gray("Cancelled"));
      return;
    }

    // Create concept DOI
    const createSpinner = ora("Creating concept DOI on Zenodo...").start();

    try {
      const result = await createConceptDoi(datasetId, {
        title: options.title,
        description: options.description,
        sandbox: options.sandbox,
      });

      createSpinner.succeed("Concept DOI created successfully");

      // Apply branch protection now that dataset has a DOI (permanent record)
      const protectionSpinner = ora("Applying branch protection...").start();
      try {
        await finalizeDataset(datasetId);
        protectionSpinner.succeed("Branch protection applied");
      } catch (protectionError) {
        protectionSpinner.warn("Could not apply branch protection");
        console.log(
          chalk.gray(
            `  ${protectionError instanceof Error ? protectionError.message : "Unknown error"}`,
          ),
        );
        console.log(chalk.gray("  You may need to configure this manually on GitHub."));
      }

      console.log();
      console.log(chalk.green("DOI Information:"));
      console.log(`  Concept DOI: ${chalk.cyan(result.concept_doi)}`);
      console.log(`  Zenodo URL:  ${result.zenodo_url}`);
      console.log();

      console.log(chalk.yellow("Next steps:"));
      console.log("  1. Set up automatic DOI publishing by running:");
      console.log(chalk.gray(`     ${result.setup_command}`));
      console.log("     (paste the webhook token when prompted)");
      console.log();
      console.log("  2. Update dataset_description.json with DatasetDOI field");
      console.log("  3. Create a PR and merge it to trigger version DOI publication");
      console.log();
      if (options.sandbox) {
        console.log(chalk.gray("Note: This is a sandbox DOI and will not resolve in production."));
      }
    } catch (error) {
      if (error instanceof ApiError) {
        createSpinner.fail(error.message);
        if (error.statusCode === 403) {
          console.log(chalk.gray("  This command requires admin privileges"));
        }
      } else {
        createSpinner.fail("Failed to create concept DOI");
        console.log(chalk.gray(`  ${error instanceof Error ? error.message : "Unknown error"}`));
      }
    }
  });

doiCommand
  .command("info")
  .description("Get DOI info for a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .action(async (datasetId) => {
    if (!requireAuth()) return;

    const spinner = ora("Fetching DOI info...").start();

    try {
      const doiInfo = await getDoiInfo(datasetId);
      spinner.stop();

      console.log();
      console.log(chalk.cyan(`DOI Information for ${datasetId}:`));
      console.log(`  Dataset Name:    ${doiInfo.name}`);
      console.log();

      if (doiInfo.concept_doi) {
        console.log(chalk.green("Concept DOI:"));
        console.log(`  DOI:  ${doiInfo.concept_doi}`);
        console.log(`  URL:  https://doi.org/${doiInfo.concept_doi}`);
        if (doiInfo.zenodo_concept_url) {
          console.log(`  Zenodo: ${doiInfo.zenodo_concept_url}`);
        }
      } else {
        console.log(chalk.yellow("No concept DOI created yet"));
        console.log(chalk.gray("  Use 'nemar admin doi create' to create one"));
      }

      console.log();

      if (doiInfo.latest_version_doi) {
        console.log(chalk.green("Latest Version DOI:"));
        console.log(`  DOI:  ${doiInfo.latest_version_doi}`);
        console.log(`  URL:  https://doi.org/${doiInfo.latest_version_doi}`);
        if (doiInfo.zenodo_latest_version_url) {
          console.log(`  Zenodo: ${doiInfo.zenodo_latest_version_url}`);
        }
      } else if (doiInfo.concept_doi) {
        console.log(chalk.yellow("No version DOI published yet"));
        console.log(chalk.gray("  Version DOIs are created automatically on PR merge"));
      }
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
        if (error.statusCode === 404) {
          console.log(chalk.gray("  Dataset not found"));
        } else if (error.statusCode === 403) {
          console.log(chalk.gray("  This command requires admin privileges"));
        }
      } else {
        spinner.fail("Failed to fetch DOI info");
      }
    }
  });

adminCommand.addCommand(doiCommand);

// ============================================================================
// Revert (Admin Only)
// ============================================================================

adminCommand
  .command("revert")
  .description("Revert a dataset to a previous version (creates PR for review)")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .argument("[version]", "Target version to revert to (e.g., 1.0.0)")
  .option("--list", "List available versions without reverting")
  .option("--force", "Direct push to main without PR (emergency only)")
  .option("--message <msg>", "Custom revert commit message")
  .option("--dir <path>", "Use existing local clone instead of cloning fresh")
  .action(async (datasetId, targetVersion, options) => {
    if (!requireAuth()) return;

    // Verify prerequisites
    const prereqs = await checkDownloadPrerequisites();
    if (!prereqs.allPassed) {
      console.log(chalk.red("Error: Missing prerequisites"));
      for (const error of prereqs.errors) {
        console.log(chalk.gray(`  - ${error}`));
      }
      return;
    }

    // Determine working directory
    let workDir: string;
    let needsClone = true;

    if (options.dir) {
      if (!existsSync(options.dir)) {
        console.log(chalk.red(`Error: Directory not found: ${options.dir}`));
        return;
      }
      workDir = options.dir;
      needsClone = false;
    } else {
      workDir = join(process.cwd(), `${datasetId}-revert-${Date.now()}`);
    }

    // Get dataset info from API
    const spinner = ora("Fetching dataset info...").start();
    let dataset: Dataset;
    try {
      dataset = await getDataset(datasetId);
      spinner.succeed(`Found dataset: ${dataset.name}`);
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
        if (error.statusCode === 404) {
          console.log(chalk.gray("  Dataset not found"));
        }
      } else {
        spinner.fail("Failed to fetch dataset");
      }
      return;
    }

    // Check if dataset has GitHub repo
    if (!dataset.github_repo) {
      console.log(chalk.red("Error: Dataset has no GitHub repository"));
      return;
    }

    // Clone if needed
    if (needsClone) {
      const cloneSpinner = ora(`Cloning ${datasetId}...`).start();
      const cloneUrl = `https://github.com/${dataset.github_repo}.git`;
      const cloneResult = await cloneDataset(cloneUrl, workDir);
      if (!cloneResult.success) {
        cloneSpinner.fail(`Clone failed: ${cloneResult.error}`);
        return;
      }
      cloneSpinner.succeed(`Cloned to ${workDir}`);
    }

    // List available versions
    const versions = await listDatasetVersions(workDir);

    if (versions.length === 0) {
      console.log(chalk.yellow("No versions found for this dataset"));
      console.log(chalk.gray("  Dataset may not have any tagged releases yet"));
      return;
    }

    // If --list flag, just show versions and exit
    if (options.list) {
      console.log(`\n${chalk.cyan("Available Versions:")}\n`);
      for (const v of versions) {
        console.log(`  ${chalk.green(v.version)}  ${chalk.gray(v.date)}  ${chalk.gray(v.commit)}`);
      }
      return;
    }

    // If no version specified, prompt for selection
    let selectedVersion = targetVersion;
    if (!selectedVersion) {
      console.log(`\n${chalk.cyan("Available Versions:")}\n`);
      for (const v of versions) {
        console.log(`  ${chalk.green(v.version)}  ${chalk.gray(v.date)}`);
      }
      console.log();

      const { version } = await inquirer.prompt([
        {
          type: "list",
          name: "version",
          message: "Select version to revert to:",
          choices: versions.map((v) => ({
            name: `${v.version} (${v.date})`,
            value: v.version,
          })),
        },
      ]);
      selectedVersion = version;
    }

    // Verify version exists
    const commitHash = await getVersionCommit(workDir, selectedVersion);
    if (!commitHash) {
      console.log(chalk.red(`Error: Version ${selectedVersion} not found`));
      console.log(chalk.gray("  Use --list to see available versions"));
      return;
    }

    // Confirm revert action
    console.log();
    console.log(chalk.yellow("Revert Summary:"));
    console.log(`  Dataset:        ${chalk.cyan(datasetId)}`);
    console.log(`  Target version: ${chalk.green(selectedVersion)}`);
    console.log(`  Commit:         ${chalk.gray(commitHash)}`);
    if (options.force) {
      console.log(`  Mode:           ${chalk.red("DIRECT PUSH (--force)")}`);
    } else {
      console.log(`  Mode:           ${chalk.green("Pull Request")}`);
    }
    console.log();

    if (options.force) {
      console.log(chalk.red("WARNING: --force will push directly to main without PR review!"));
      console.log(chalk.red("This should only be used in emergencies."));
      console.log();
    }

    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: options.force
          ? `Directly push revert to ${selectedVersion}?`
          : `Create PR to revert to ${selectedVersion}?`,
        default: false,
      },
    ]);

    if (!confirm) {
      console.log(chalk.gray("Cancelled"));
      return;
    }

    // Create revert branch
    const branchName = `revert-to-${selectedVersion.replace(/\./g, "-")}-${Date.now()}`;
    const branchSpinner = ora("Creating revert branch...").start();

    const branchResult = await createRevertBranch(workDir, selectedVersion, branchName);
    if (!branchResult.success) {
      branchSpinner.fail(`Failed to create branch: ${branchResult.error}`);
      return;
    }
    branchSpinner.succeed(`Created branch: ${branchName}`);

    // Commit the revert
    const commitSpinner = ora("Committing revert...").start();
    const commitMessage = options.message || `Revert to version ${selectedVersion}`;

    const commitResult = await commitRevert(workDir, selectedVersion, commitMessage);
    if (!commitResult.success) {
      commitSpinner.fail(`Failed to commit: ${commitResult.error}`);
      return;
    }
    commitSpinner.succeed("Committed revert changes");

    // Push branch
    const pushSpinner = ora("Pushing branch...").start();
    const pushResult = await pushBranch(workDir, branchName);
    if (!pushResult.success) {
      pushSpinner.fail(`Failed to push: ${pushResult.error}`);
      return;
    }
    pushSpinner.succeed("Pushed branch to GitHub");

    // Create PR (using gh CLI)
    if (!options.force) {
      const prSpinner = ora("Creating pull request...").start();
      try {
        const { spawn } = await import("node:child_process");
        const prTitle = `Revert to version ${selectedVersion}`;
        const prBody = `## Revert Request\n\nThis PR reverts the dataset to version ${selectedVersion}.\n\n**Reason:** Admin-initiated revert\n**Target version:** ${selectedVersion}\n**Original commit:** ${commitHash}`;

        const pr = spawn(
          "gh",
          [
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
          { cwd: workDir },
        );

        let prUrl = "";
        pr.stdout.on("data", (data) => {
          prUrl += data.toString();
        });

        await new Promise<void>((resolve, reject) => {
          pr.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`gh pr create failed with code ${code}`));
          });
        });

        prSpinner.succeed("Created pull request");
        console.log();
        console.log(`  ${chalk.cyan("PR URL:")} ${prUrl.trim()}`);
        console.log();
        console.log(chalk.green("Revert PR created successfully."));
        console.log(
          chalk.gray("The PR will go through validation checks before it can be merged."),
        );
      } catch (prError) {
        prSpinner.fail("Failed to create PR via gh CLI");
        console.log(chalk.gray("  You may need to create the PR manually on GitHub"));
        console.log(chalk.gray(`  Branch: ${branchName}`));
      }
    } else {
      // Force mode: merge directly (emergency only)
      console.log(chalk.yellow("Force mode: Merging directly to main..."));
      // Note: We'd need to checkout main, merge, and push. For safety, just inform user.
      console.log(chalk.red("Direct merge not implemented for safety."));
      console.log(chalk.gray("To force-merge, manually merge the branch on GitHub:"));
      console.log(chalk.gray(`  git checkout main && git merge ${branchName} && git push`));
    }

    // Cleanup info
    if (needsClone) {
      console.log();
      console.log(chalk.gray(`Working directory: ${workDir}`));
      console.log(chalk.gray("You can delete this directory after the PR is merged."));
    }
  });
