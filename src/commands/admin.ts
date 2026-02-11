/**
 * Admin commands for NEMAR CLI
 *
 * These commands require admin privileges.
 *
 * Commands:
 * - nemar admin users              - List users (pending, approved, all)
 * - nemar admin approve            - Approve a pending user
 * - nemar admin revoke             - Revoke user access
 * - nemar admin s3 regenerate-iam  - Regenerate AWS credentials for a user
 * - nemar admin repo public/private - Change repository visibility
 * - nemar admin ci check/add       - Manage CI workflows
 * - nemar admin doi create/info    - DOI management
 * - nemar admin publish list/deny/approve - Publication workflow
 * - nemar admin revert             - Revert dataset to a previous version
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
  type NemarMetadataPayload,
  addCi,
  applyS3Lock,
  approvePublication,
  approveUser,
  changeVisibility,
  createConceptDoi,
  denyPublication,
  finalizeDataset,
  getCiStatus,
  getDataset,
  getDatasetFiles,
  getDoiInfo,
  listPublishRequests,
  listUsers,
  publishDataset,
  regenerateUserIam,
  revokeUser,
  submitEnrichment,
  updateDoi,
} from "../lib/api.js";
import { getConfig, isAuthenticated } from "../lib/config.js";
import {
  type ConfirmOptions,
  NO_DESCRIPTION,
  NO_OPTION,
  YES_DESCRIPTION,
  YES_OPTION,
  confirm,
  confirmWithInput,
} from "../lib/confirm.js";
import {
  checkDownloadPrerequisites,
  cloneDataset,
  commitRevert,
  createRevertBranch,
  formatBytes,
  getVersionCommit,
  listDatasetVersions,
  pushBranch,
} from "../lib/git-annex.js";

/** Handle common error patterns in admin CLI commands */
function handleCommandError(
  error: unknown,
  spinner: ReturnType<typeof ora>,
  defaultMsg: string,
  hints?: Record<number, string>,
): void {
  if (error instanceof ApiError) {
    spinner.fail(error.message);
    const hint = hints?.[error.statusCode];
    if (hint) {
      console.log(chalk.gray(`  ${hint}`));
    } else if (error.statusCode === 403) {
      console.log(chalk.gray("  This command requires admin privileges"));
    }
  } else {
    spinner.fail(defaultMsg);
    const msg = error instanceof Error ? error.message : String(error);
    console.log(chalk.gray(`  Error details: ${msg}`));
  }
}

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

Dataset Management:
  repo     - Manage repository visibility (public/private)
  ci       - Manage CI workflows (check status, deploy)
  s3       - S3/IAM credential management
  doi      - Create and manage DOIs for datasets
  revert   - Revert dataset to previous version (via PR)

Examples:
  $ nemar admin users --verified           # List users awaiting approval
  $ nemar admin approve john_doe           # Approve a user
  $ nemar admin repo public nm000104       # Make dataset repo public
  $ nemar admin ci check nm000104          # Check CI status
  $ nemar admin s3 regenerate-iam john_doe # Regenerate AWS credentials
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
      handleCommandError(error, spinner, "Failed to fetch users");
    }
  });

// ============================================================================
// Approve
// ============================================================================

adminCommand
  .command("approve")
  .description("Approve a pending user")
  .argument("<username>", "Username to approve")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(async (username, options: ConfirmOptions) => {
    if (!requireAuth()) return;

    // Confirmation
    console.log(chalk.cyan(`\nApproving user: ${username}\n`));
    console.log("This will:");
    console.log("  1. Generate an API key for the user");
    console.log("  2. Send them an email with their API key");
    console.log();

    const result = await confirm(`Approve ${username}?`, options, true);
    if (result !== "confirmed") {
      console.log(chalk.gray(result === "declined" ? "Skipped" : "Cancelled"));
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
      handleCommandError(error, spinner, "Failed to approve user", {
        404: "User not found or not in 'verified' status",
      });
    }
  });

// ============================================================================
// Revoke
// ============================================================================

adminCommand
  .command("revoke")
  .description("Revoke user access")
  .argument("<username>", "Username to revoke")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(async (username, options: ConfirmOptions) => {
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

    const result = await confirmWithInput(
      `Type '${username}' to confirm revocation:`,
      username,
      options,
    );
    if (result !== "confirmed") {
      console.log(chalk.gray(result === "declined" ? "Skipped" : "Cancelled"));
      return;
    }

    const spinner = ora(`Revoking ${username}...`).start();

    try {
      await revokeUser(username);
      spinner.succeed(`Revoked access for ${username}`);
    } catch (error) {
      handleCommandError(error, spinner, "Failed to revoke user", {
        404: "User not found",
      });
    }
  });

// ============================================================================
// S3 / IAM Management
// ============================================================================

const s3Command = new Command("s3").description("S3 and IAM credential management");

s3Command
  .command("regenerate-iam")
  .description("Regenerate AWS IAM credentials for a user")
  .argument("<username>", "Username to regenerate credentials for")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(regenerateIamAction);

s3Command
  .command("lock")
  .description("Apply S3 Object Lock (Governance mode) to a dataset")
  .argument("<dataset-id>", "Dataset ID to lock")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(async (datasetId: string, options: ConfirmOptions) => {
    if (!requireAuth()) return;

    console.log(chalk.cyan(`\nApply S3 Object Lock to ${datasetId}\n`));
    console.log("This will:");
    console.log("  • Set GOVERNANCE mode Object Lock on all objects");
    console.log("  • Retention period: 100 years");
    console.log("  • Objects cannot be deleted or modified without bypass");
    console.log();

    const confirmResult = await confirm(`Apply S3 Object Lock to ${datasetId}?`, options);
    if (confirmResult !== "confirmed") {
      console.log(chalk.gray(confirmResult === "declined" ? "Skipped" : "Cancelled"));
      return;
    }

    const spinner = ora("Applying S3 Object Lock...").start();

    try {
      const result = await applyS3Lock(datasetId);
      if (result.failed.length > 0) {
        spinner.fail(
          `Partial lock: ${result.locked}/${result.total} locked, ${result.failed.length} failed`,
        );
        console.log(chalk.yellow("\nFailed objects:"));
        for (const key of result.failed.slice(0, 10)) {
          console.log(`  • ${key}`);
        }
        if (result.failed.length > 10) {
          console.log(`  ... and ${result.failed.length - 10} more`);
        }
      } else {
        spinner.succeed(`All ${result.locked} objects locked successfully`);
      }
    } catch (error) {
      spinner.fail("S3 lock failed");
      const msg = error instanceof Error ? error.message : String(error);
      console.log(chalk.gray(`  ${msg}`));
    }
  });

adminCommand.addCommand(s3Command);

// Hidden alias for backward compatibility
adminCommand
  .command("regenerate-iam", { hidden: true })
  .argument("<username>")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(regenerateIamAction);

async function regenerateIamAction(username: string, options: ConfirmOptions) {
  if (!requireAuth()) return;

  console.log(chalk.yellow(`\nRegenerate IAM credentials for: ${username}\n`));
  console.log("This will:");
  console.log("  1. Create new AWS IAM access keys for the user");
  console.log("  2. Invalidate any existing access keys");
  console.log("  3. Restore S3 access to their datasets");
  console.log();
  console.log(chalk.gray("Use this if a user's credentials were compromised or lost."));
  console.log();

  const confirmResult = await confirm(`Regenerate IAM credentials for ${username}?`, options);
  if (confirmResult !== "confirmed") {
    console.log(chalk.gray(confirmResult === "declined" ? "Skipped" : "Cancelled"));
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

    if (result.warning) {
      console.log();
      console.log(chalk.yellow(`  Warning: ${result.warning}`));
      console.log(chalk.gray("  Please verify old credentials are revoked in AWS console."));
    }

    console.log();
    console.log(chalk.gray("The user can now upload to their datasets again."));
  } catch (error) {
    handleCommandError(error, spinner, "Failed to regenerate IAM credentials", {
      404: "User not found or not approved",
    });
  }
}

// ============================================================================
// Repository Management
// ============================================================================

const repoCommand = new Command("repo").description("Repository visibility management");

repoCommand
  .command("public")
  .description("Make a dataset repository public")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(async (datasetId, options: ConfirmOptions) => {
    if (!requireAuth()) return;

    console.log(chalk.cyan(`\nMaking repository public: ${datasetId}\n`));
    console.log(chalk.yellow("Warning: This will make the dataset visible to everyone."));
    console.log();

    const confirmResult = await confirm(`Make ${datasetId} public?`, options);
    if (confirmResult !== "confirmed") {
      console.log(chalk.gray(confirmResult === "declined" ? "Skipped" : "Cancelled"));
      return;
    }

    const spinner = ora(`Setting ${datasetId} to public...`).start();
    try {
      await changeVisibility(datasetId, "public");
      spinner.succeed(`Repository ${datasetId} is now public`);
    } catch (error) {
      handleCommandError(error, spinner, "Failed to change visibility", {
        404: "Dataset not found",
      });
    }
  });

repoCommand
  .command("private")
  .description("Make a dataset repository private")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(async (datasetId, options: ConfirmOptions) => {
    if (!requireAuth()) return;

    console.log(chalk.yellow(`\nMaking repository private: ${datasetId}\n`));
    console.log("This will restrict access to collaborators only.");
    console.log();

    const confirmResult = await confirm(`Make ${datasetId} private?`, options);
    if (confirmResult !== "confirmed") {
      console.log(chalk.gray(confirmResult === "declined" ? "Skipped" : "Cancelled"));
      return;
    }

    const spinner = ora(`Setting ${datasetId} to private...`).start();
    try {
      await changeVisibility(datasetId, "private");
      spinner.succeed(`Repository ${datasetId} is now private`);
    } catch (error) {
      handleCommandError(error, spinner, "Failed to change visibility", {
        404: "Dataset not found",
      });
    }
  });

adminCommand.addCommand(repoCommand);

// ============================================================================
// CI Management
// ============================================================================

const ciCommand = new Command("ci").description("CI workflow management");

ciCommand
  .command("check")
  .description("Check CI workflow status for a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .action(async (datasetId) => {
    if (!requireAuth()) return;

    const spinner = ora(`Checking CI status for ${datasetId}...`).start();

    try {
      const result = await getCiStatus(datasetId);
      spinner.stop();

      console.log(`\n${chalk.cyan("CI Status:")} ${datasetId}\n`);

      // BIDS Validation
      const bidsPresent = result.bids_validation.present;
      const bidsIcon = bidsPresent ? chalk.green("[x]") : chalk.red("[ ]");
      console.log(`  ${bidsIcon} BIDS Validation`);
      if (bidsPresent) {
        const statusColor =
          result.bids_validation.status === "success"
            ? chalk.green
            : result.bids_validation.status === "failure"
              ? chalk.red
              : chalk.yellow;
        console.log(`      Status: ${statusColor(result.bids_validation.status)}`);
        if (result.bids_validation.url) {
          console.log(`      URL:    ${chalk.gray(result.bids_validation.url)}`);
        }
      } else {
        console.log(`      ${chalk.gray("Not deployed. Use 'nemar admin ci add' to deploy.")}`);
      }

      // Version Check
      const versionPresent = result.version_check.present;
      const versionIcon = versionPresent ? chalk.green("[x]") : chalk.red("[ ]");
      console.log(`  ${versionIcon} Version Check`);
      if (!versionPresent) {
        console.log(`      ${chalk.gray("Not deployed. Use 'nemar admin ci add' to deploy.")}`);
      }

      console.log();
    } catch (error) {
      handleCommandError(error, spinner, "Failed to check CI status", {
        404: "Dataset not found",
      });
    }
  });

ciCommand
  .command("add")
  .description("Deploy CI workflows to a dataset repository")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(async (datasetId, options: ConfirmOptions) => {
    if (!requireAuth()) return;

    console.log(chalk.cyan(`\nDeploy CI workflows to: ${datasetId}\n`));
    console.log("This will add the following workflows:");
    console.log("  1. BIDS Validation (runs on PRs)");
    console.log("  2. Version Check (ensures version bump on PRs)");
    console.log("  3. PR Merge Handler (creates releases, publishes DOIs)");
    console.log();

    const confirmResult = await confirm(`Deploy CI workflows to ${datasetId}?`, options);
    if (confirmResult !== "confirmed") {
      console.log(chalk.gray(confirmResult === "declined" ? "Skipped" : "Cancelled"));
      return;
    }

    const spinner = ora(`Deploying CI workflows to ${datasetId}...`).start();

    try {
      const result = await addCi(datasetId);
      spinner.succeed("CI workflows deployed");
      console.log();
      for (const workflow of result.workflows_deployed) {
        console.log(`  ${chalk.green("[x]")} ${workflow}`);
      }
      console.log();
    } catch (error) {
      handleCommandError(error, spinner, "Failed to deploy CI workflows", {
        404: "Dataset not found",
      });
    }
  });

adminCommand.addCommand(ciCommand);

// ============================================================================
// DOI Management
// ============================================================================

const doiCommand = new Command("doi").description("DOI management");

doiCommand
  .command("create")
  .description("Create concept DOI for a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option("--title <title>", "DOI title (defaults to dataset name)")
  .option("--description <desc>", "DOI description")
  .option("--provider <provider>", "DOI provider: ezid (default) or zenodo", "ezid")
  .option("--sandbox", "Use sandbox/test DOI")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(
    async (
      datasetId,
      options: {
        title?: string;
        description?: string;
        provider?: string;
        sandbox?: boolean;
      } & ConfirmOptions,
    ) => {
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

      // Enhanced sandbox warning
      const provider = (options.provider === "zenodo" ? "zenodo" : "ezid") as "ezid" | "zenodo";

      if (options.sandbox) {
        console.log(chalk.yellow("━".repeat(60)));
        console.log(chalk.yellow.bold("                 SANDBOX MODE ENABLED"));
        console.log(chalk.yellow("━".repeat(60)));
        if (provider === "zenodo") {
          console.log(chalk.yellow("  • Using Zenodo sandbox (sandbox.zenodo.org)"));
        } else {
          console.log(chalk.yellow("  • Using EZID test shoulder (doi:10.5072/FK2)"));
          console.log(chalk.yellow("  • Test DOIs auto-delete after 2 weeks"));
        }
        console.log(chalk.yellow("  • DOI will NOT be indexed by DataCite"));
        console.log(chalk.yellow("  • DOI will NOT resolve in production"));
        console.log(chalk.yellow("  • Use this for testing workflows only"));
        console.log(chalk.yellow("━".repeat(60)));
        console.log();
      }

      // Confirmation
      console.log(chalk.red("WARNING: DOIs are PERMANENT and cannot be deleted!"));
      console.log(
        chalk.gray(
          "The DOI will be pre-reserved but not published until the first version release.",
        ),
      );
      console.log(`  Provider: ${chalk.cyan(provider.toUpperCase())}`);
      console.log();

      const confirmMessage = options.sandbox
        ? `Create TEST concept DOI via ${provider.toUpperCase()} SANDBOX?`
        : `Create PERMANENT concept DOI via ${provider.toUpperCase()} PRODUCTION?`;
      const result = await confirm(confirmMessage, options);
      if (result !== "confirmed") {
        console.log(chalk.gray(result === "declined" ? "Skipped" : "Cancelled"));
        return;
      }

      // Create concept DOI
      const createSpinner = ora(`Creating concept DOI via ${provider.toUpperCase()}...`).start();

      try {
        const result = await createConceptDoi(datasetId, {
          title: options.title,
          description: options.description,
          sandbox: options.sandbox,
          provider,
        });

        createSpinner.succeed("Concept DOI created successfully");

        // Apply branch protection now that dataset has a DOI (permanent record)
        const protectionSpinner = ora("Applying branch protection...").start();
        try {
          const finalizeResult = await finalizeDataset(datasetId);
          if (finalizeResult.warnings && finalizeResult.warnings.length > 0) {
            protectionSpinner.warn("Branch protection applied with warnings");
            for (const warning of finalizeResult.warnings) {
              console.log(chalk.yellow(`  Warning: ${warning}`));
            }
          } else {
            protectionSpinner.succeed("Branch protection applied");
          }
        } catch (protectionError) {
          protectionSpinner.warn("Could not apply branch protection");
          if (protectionError instanceof ApiError) {
            console.log(chalk.gray(`  ${protectionError.message}`));
            if (protectionError.statusCode === 403) {
              console.log(chalk.gray("  Check admin credentials and permissions"));
            }
          } else {
            console.log(
              chalk.gray(
                `  ${protectionError instanceof Error ? protectionError.message : "Unknown error"}`,
              ),
            );
          }
          console.log(
            chalk.gray("  Manual setup: Go to GitHub repo Settings > Branches > Add rule"),
          );
        }

        console.log();
        console.log(chalk.green("DOI Information:"));
        console.log(`  Concept DOI: ${chalk.cyan(result.concept_doi)}`);
        console.log(`  Provider:    ${result.provider.toUpperCase()}`);
        if (result.provider === "ezid") {
          console.log(`  DOI URL:     ${result.doi_url}`);
          console.log(`  EZID ID:     ${result.ezid_identifier}`);
        } else {
          console.log(`  Zenodo URL:  ${result.zenodo_url}`);
        }
        if (result.metadata_warning) {
          console.log(chalk.yellow(`  Warning:     ${result.metadata_warning}`));
        }
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
          console.log(
            chalk.gray("Note: This is a sandbox DOI and will not resolve in production."),
          );
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
    },
  );

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
        console.log(`  DOI:      ${doiInfo.concept_doi}`);
        console.log(`  URL:      https://doi.org/${doiInfo.concept_doi}`);
        console.log(`  Provider: ${(doiInfo.doi_provider || "zenodo").toUpperCase()}`);

        if (doiInfo.doi_provider === "ezid") {
          if (doiInfo.ezid_identifier) {
            console.log(`  EZID ID:  ${doiInfo.ezid_identifier}`);
          }
          if (doiInfo.ezid_status) {
            const statusColor = doiInfo.ezid_status === "public" ? chalk.green : chalk.yellow;
            console.log(`  Status:   ${statusColor(doiInfo.ezid_status)}`);
          }
        }

        if (doiInfo.zenodo_concept_url) {
          console.log(`  Zenodo:   ${doiInfo.zenodo_concept_url}`);

          // Detect and warn about sandbox DOIs
          if (doiInfo.zenodo_concept_url.includes("sandbox.zenodo.org")) {
            console.log();
            console.log(chalk.yellow("Mode: SANDBOX (test DOI)"));
            console.log(
              chalk.yellow(
                "  This DOI is not indexed by DataCite and will not resolve in production",
              ),
            );
          }
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

doiCommand
  .command("update")
  .description("Update EZID DOI metadata or status")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option("--make-public", "Transition DOI from reserved to public (permanent)")
  .option("--refresh", "Refresh metadata from BIDS dataset_description.json")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(
    async (
      datasetId: string,
      options: { makePublic?: boolean; refresh?: boolean } & ConfirmOptions,
    ) => {
      if (!requireAuth()) return;

      if (!options.makePublic && !options.refresh) {
        console.log(chalk.yellow("No action specified. Use --make-public and/or --refresh."));
        return;
      }

      if (options.makePublic) {
        console.log(chalk.red("WARNING: Making a DOI public is PERMANENT!"));
        console.log(chalk.gray("  The DOI will be findable in DataCite and cannot be reverted."));
        console.log();

        const confirmResult = await confirm(
          `Make DOI for ${datasetId} PUBLIC and permanent?`,
          options,
        );
        if (confirmResult !== "confirmed") {
          console.log(chalk.gray(confirmResult === "declined" ? "Skipped" : "Cancelled"));
          return;
        }
      }

      const spinner = ora("Updating DOI...").start();

      try {
        const result = await updateDoi(datasetId, {
          status: options.makePublic ? "public" : undefined,
          refresh_metadata: options.refresh,
        });

        spinner.succeed("DOI updated successfully");
        console.log();
        console.log(`  EZID ID: ${chalk.cyan(result.ezid_identifier)}`);
        console.log(
          `  Status:  ${result.status === "public" ? chalk.green(result.status) : chalk.yellow(result.status)}`,
        );
        console.log(`  URL:     ${result.doi_url}`);
      } catch (error) {
        if (error instanceof ApiError) {
          spinner.fail(error.message);
          if (error.statusCode === 400) {
            console.log(chalk.gray("  DOI update is only supported for EZID-managed DOIs"));
          }
        } else {
          spinner.fail("Failed to update DOI");
          console.log(chalk.gray(`  ${error instanceof Error ? error.message : "Unknown error"}`));
        }
      }
    },
  );

doiCommand
  .command("enrich")
  .description("Enrich DOI metadata with ORCIDs, descriptions, funding, and more")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option("--no-llm", "Skip LLM-based enrichment from README")
  .option("--sandbox", "Use sandbox DOI")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(
    async (
      datasetId: string,
      options: { llm?: boolean; sandbox?: boolean } & ConfirmOptions,
    ) => {
      if (!requireAuth()) return;

      const spinner = ora("Fetching dataset and existing enrichment...").start();

      // Get dataset info
      let dataset: Dataset;
      try {
        dataset = await getDataset(datasetId);
        spinner.succeed(`Dataset: ${dataset.name}`);
      } catch (error) {
        if (error instanceof ApiError) {
          spinner.fail(error.message);
        } else {
          spinner.fail("Failed to fetch dataset");
        }
        return;
      }

      // Get DOI info
      let doiInfo;
      try {
        doiInfo = await getDoiInfo(datasetId);
      } catch (doiErr) {
        if (doiErr instanceof ApiError && doiErr.statusCode === 404) {
          // No DOI exists yet
        } else {
          console.log(
            chalk.yellow(
              `  Warning: Could not fetch DOI info: ${doiErr instanceof Error ? doiErr.message : String(doiErr)}`,
            ),
          );
        }
      }

      if (doiInfo?.concept_doi) {
        console.log(`  DOI: ${chalk.cyan(doiInfo.concept_doi)}`);
      }

      // Get existing BIDS metadata (from the backend, we use the files endpoint to detect authors)
      // For now we'll build enrichment interactively
      const enrichment: NemarMetadataPayload = { version: "1.0" };

      // --- Author ORCIDs ---
      console.log();
      console.log(chalk.cyan("--- Author ORCIDs ---"));

      // We need author list from BIDS; fetch via dataset files endpoint to find dataset_description.json
      // For simplicity, we ask admin to provide/confirm author info
      const { updateAuthors } = await inquirer.prompt([
        {
          type: "confirm",
          name: "updateAuthors",
          message: "Update author ORCIDs?",
          default: false,
        },
      ]);

      if (updateAuthors) {
        const orcidRegex = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;
        const authors: Record<string, { orcid?: string; affiliation?: string }> = {};

        let addMore = true;
        while (addMore) {
          const { authorName } = await inquirer.prompt([
            {
              type: "input",
              name: "authorName",
              message: 'Author name (as in BIDS, e.g., "Shirazi, Yahya"):',
            },
          ]);
          if (!authorName) break;

          const { orcid } = await inquirer.prompt([
            {
              type: "input",
              name: "orcid",
              message: `ORCID for "${authorName}" (Enter to skip):`,
              validate: (input: string) => {
                if (!input) return true;
                return orcidRegex.test(input) || "Invalid ORCID format (XXXX-XXXX-XXXX-XXXX)";
              },
            },
          ]);

          const entry: { orcid?: string; affiliation?: string } = {};
          if (orcid) entry.orcid = orcid;

          const { affiliation } = await inquirer.prompt([
            {
              type: "input",
              name: "affiliation",
              message: `Affiliation for "${authorName}" (optional):`,
            },
          ]);
          if (affiliation) entry.affiliation = affiliation;

          if (entry.orcid || entry.affiliation) {
            authors[authorName] = entry;
          }

          const { more } = await inquirer.prompt([
            { type: "confirm", name: "more", message: "Add another author?", default: true },
          ]);
          addMore = more;
        }

        if (Object.keys(authors).length > 0) {
          enrichment.authors = authors;
        }
      }

      // --- LLM Enrichment ---
      if (options.llm !== false) {
        console.log();
        console.log(chalk.cyan("--- Generating enrichment from README ---"));

        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
          console.log(chalk.yellow("  OPENROUTER_API_KEY not set; skipping LLM enrichment"));
          console.log(chalk.gray("  Set it in your environment to enable LLM-based enrichment"));
        } else {
          const llmSpinner = ora("Analyzing README and dataset metadata...").start();
          try {
            // Dynamic import to avoid loading on backend (CLI-side only)
            const { enrichFromReadme } = await import("../lib/llm-enrich.js");

            // We don't have direct README access here, so fetch via gh CLI
            const repoName = dataset.github_repo;
            if (repoName) {
              const { spawn: bunSpawn } = await import("bun");
              const proc = bunSpawn({
                cmd: ["gh", "api", `repos/${repoName}/readme`, "--jq", ".content"],
                stdout: "pipe",
                stderr: "pipe",
              });
              const readmeBase64 = await new Response(proc.stdout).text();
              const exitCode = await proc.exited;

              if (exitCode === 0 && readmeBase64.trim()) {
                const readmeContent = Buffer.from(readmeBase64.trim(), "base64").toString("utf-8");

                // Also get BIDS description
                const descProc = bunSpawn({
                  cmd: [
                    "gh",
                    "api",
                    `repos/${repoName}/contents/dataset_description.json`,
                    "--jq",
                    ".content",
                  ],
                  stdout: "pipe",
                  stderr: "pipe",
                });
                const descBase64 = await new Response(descProc.stdout).text();
                const descExitCode = await descProc.exited;
                let bidsDesc: Record<string, unknown> = {};
                if (descExitCode === 0 && descBase64.trim()) {
                  try {
                    bidsDesc = JSON.parse(
                      Buffer.from(descBase64.trim(), "base64").toString("utf-8"),
                    ) as Record<string, unknown>;
                  } catch {
                    // ignore parse error
                  }
                }

                const llmResult = await enrichFromReadme(readmeContent, bidsDesc, apiKey);
                llmSpinner.succeed("LLM enrichment complete");

                if (llmResult.description) {
                  console.log(`  Description: ${llmResult.description.slice(0, 100)}...`);
                  enrichment.description = llmResult.description;
                }
                if (llmResult.methodsDescription) {
                  enrichment.methodsDescription = llmResult.methodsDescription;
                }
                if (llmResult.keywords && llmResult.keywords.length > 0) {
                  console.log(`  Keywords: ${llmResult.keywords.join(", ")}`);
                  enrichment.keywords = llmResult.keywords;
                }
                if (llmResult.fundingReferences && llmResult.fundingReferences.length > 0) {
                  console.log(
                    `  Funding: ${llmResult.fundingReferences.map((f) => `${f.funderName} ${f.awardNumber || ""}`).join(", ")}`,
                  );
                  enrichment.fundingReferences = llmResult.fundingReferences;
                }
                if (llmResult.relatedDois && llmResult.relatedDois.length > 0) {
                  console.log(
                    `  Related DOIs: ${llmResult.relatedDois.map((r) => `${r.doi} (${r.relationType})`).join(", ")}`,
                  );
                  enrichment.relatedDois = llmResult.relatedDois;
                }
              } else {
                llmSpinner.warn("Could not fetch README from repository");
              }
            } else {
              llmSpinner.warn("No GitHub repository configured for this dataset");
            }
          } catch (error) {
            llmSpinner.fail("LLM enrichment failed");
            console.log(
              chalk.gray(`  ${error instanceof Error ? error.message : "Unknown error"}`),
            );
          }
        }
      }

      // --- Dataset stats (sizes/formats) ---
      console.log();
      console.log(chalk.cyan("--- Dataset stats ---"));
      const statsSpinner = ora("Computing dataset sizes and formats...").start();
      try {
        const filesInfo = await getDatasetFiles(datasetId);
        const totalSizeStr = formatBytes(filesInfo.total_size);
        enrichment.sizes = [`${totalSizeStr} (${filesInfo.file_count} files)`];
        enrichment.formats = filesInfo.extensions;
        statsSpinner.succeed(
          `Sizes: ${totalSizeStr} (${filesInfo.file_count} files), Formats: ${filesInfo.extensions.join(", ")}`,
        );
      } catch (error) {
        statsSpinner.warn("Could not compute dataset stats");
        console.log(
          chalk.gray(`  ${error instanceof Error ? error.message : "Unknown error"}`),
        );
      }

      // --- Review ---
      console.log();
      console.log(chalk.cyan("--- Review ---"));
      console.log(JSON.stringify(enrichment, null, 2));
      console.log();

      const confirmResult = await confirm(
        "Commit to repo and refresh DOI?",
        options,
        true,
      );
      if (confirmResult !== "confirmed") {
        console.log(chalk.gray(confirmResult === "declined" ? "Skipped" : "Cancelled"));
        return;
      }

      // Submit enrichment
      const submitSpinner = ora("Saving enrichment...").start();
      try {
        const result = await submitEnrichment(datasetId, enrichment);
        submitSpinner.succeed(result.message);

        if (result.bidsignore_updated) {
          console.log(chalk.gray("  .bidsignore updated to include nemar_metadata.json"));
        }

        // Refresh DOI metadata if the dataset has an EZID DOI
        if (doiInfo?.ezid_identifier) {
          const refreshSpinner = ora("Refreshing DOI metadata...").start();
          try {
            await updateDoi(datasetId, { refresh_metadata: true });
            refreshSpinner.succeed("DOI metadata refreshed");
          } catch (error) {
            refreshSpinner.warn("Could not refresh DOI metadata");
            console.log(
              chalk.gray(
                `  ${error instanceof Error ? error.message : "Unknown error"}`,
              ),
            );
          }
        }
      } catch (error) {
        if (error instanceof ApiError) {
          submitSpinner.fail(error.message);
        } else {
          submitSpinner.fail("Failed to save enrichment");
          console.log(
            chalk.gray(`  ${error instanceof Error ? error.message : "Unknown error"}`),
          );
        }
      }
    },
  );

adminCommand.addCommand(doiCommand);

// ============================================================================
// Publication Workflow (Admin)
// ============================================================================

const publishCommand = new Command("publish").description("Publication workflow management");

publishCommand
  .command("list")
  .description("List publication requests")
  .option("-s, --status <status>", "Filter by status (requested, approving, published, denied)")
  .addHelpText(
    "after",
    `
Description:
  List all publication requests from users, with optional filtering by status.
  Shows dataset ID, status, requesting user, and current progress.

Filter Options:
  requested  - Pending requests awaiting admin action
  approving  - Currently being processed by orchestrator
  published  - Successfully published datasets
  denied     - Denied requests with reasons

Examples:
  $ nemar admin publish list                # All requests
  $ nemar admin publish list --status requested   # Pending only
  $ nemar admin publish list --status approving   # In progress
  $ nemar admin publish list --status denied      # View denied`,
  )
  .action(async (options: { status?: string }) => {
    if (!requireAuth()) return;

    const spinner = ora("Fetching publication requests...").start();

    try {
      const result = await listPublishRequests(options.status);
      spinner.stop();

      if (result.requests.length === 0) {
        console.log(chalk.gray("\n  No publication requests found.\n"));
        return;
      }

      console.log(`\n${chalk.cyan("Publication Requests")} (${result.count})\n`);

      for (const req of result.requests) {
        const statusColor =
          req.status === "published"
            ? chalk.green
            : req.status === "denied"
              ? chalk.red
              : req.status === "approving"
                ? chalk.yellow
                : chalk.white;

        console.log(
          `  ${chalk.bold(req.dataset_id)}  ${statusColor(req.status)}  by ${req.requested_by_username}  ${chalk.gray(req.requested_at)}`,
        );
        if (req.current_step && req.status === "approving") {
          console.log(
            `    ${chalk.yellow(">")} ${req.current_step.replace(/_/g, " ")}${req.last_error ? chalk.red(` (${req.last_error})`) : ""}`,
          );
        }
      }
      console.log();
    } catch (error) {
      handleCommandError(error, spinner, "Failed to list publication requests");
    }
  });

publishCommand
  .command("deny")
  .description("Deny a publication request")
  .argument("<dataset-id>", "Dataset ID")
  .option("-r, --reason <reason>", "Reason for denial")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .addHelpText(
    "after",
    `
Description:
  Deny a user's publication request with a specific reason.
  The user will receive an email notification with your reason.

  A clear, actionable reason helps users understand what to fix
  before resubmitting their publication request.

Requirements:
  - Must provide a reason for denial
  - Reason will be sent to the user via email
  - User can fix issues and submit a new request

Examples:
  $ nemar admin publish deny nm000104 --reason "BIDS validation failing"
  $ nemar admin publish deny nm000104 -r "Dataset incomplete - missing subjects"
  $ nemar admin publish deny nm000104    # Prompts for reason interactively`,
  )
  .action(async (datasetId, options: ConfirmOptions & { reason?: string }) => {
    if (!requireAuth()) return;

    let reason = options.reason;
    if (!reason) {
      const { inputReason } = await inquirer.prompt([
        { type: "input", name: "inputReason", message: "Reason for denial:" },
      ]);
      reason = inputReason;
    }

    if (!reason) {
      console.log(chalk.red("Reason is required"));
      return;
    }

    const confirmResult = await confirm(`Deny publication of ${datasetId}?`, options);
    if (confirmResult !== "confirmed") {
      console.log(chalk.gray(confirmResult === "declined" ? "Skipped" : "Cancelled"));
      return;
    }

    const spinner = ora(`Denying publication for ${datasetId}...`).start();

    try {
      await denyPublication(datasetId, reason);
      spinner.succeed(`Publication denied for ${datasetId}`);
      console.log(chalk.gray("  User has been notified."));
    } catch (error) {
      handleCommandError(error, spinner, "Failed to deny publication");
    }
  });

publishCommand
  .command("approve")
  .description("Approve and publish a dataset (runs orchestrator)")
  .argument("<dataset-id>", "Dataset ID")
  .option("--resume", "Resume from last failed step")
  .option("--sandbox", "Use Zenodo sandbox for testing")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .addHelpText(
    "after",
    `
Description:
  Approve a publication request and run the automated 14-step orchestrator
  to make the dataset publicly accessible with a permanent DOI.

  WARNING: This action is PERMANENT. Published datasets cannot be unpublished.
  Once a DOI is assigned, it is permanent and cannot be deleted.

Orchestrator Steps:
   1. CI Check          - Verify BIDS validation passes, deploy workflows if missing
   2. Make Public       - Change GitHub repository visibility to public
   3. S3 Public Read    - Grant public read access to S3 data
   4. Tag Protection    - Enable tag protection rules
   5. Create DOI        - Create concept DOI via EZID (or Zenodo if configured)
   6. Update Metadata   - Update dataset metadata from BIDS description
   7. Update README     - Add DOI badge and citation info to README
   8. Create Tag        - Create version tag (e.g., v1.0.0)
   9. Create Release    - Create GitHub release from tag
  10. Upload to Zenodo  - Upload dataset archive to Zenodo (if Zenodo provider)
  11. Publish DOI       - Make DOI public and findable (permanent, irreversible)
  12. S3 Lock           - Enable S3 Object Lock (prevents data deletion)
  13. Generate Archive  - Create downloadable zip archive
  14. Notify User       - Send publication confirmation email

Resume Capability:
  If a step fails, the orchestrator saves progress. Use --resume to retry
  from the failed step without re-running successful steps.

  The orchestrator is idempotent - safe to run multiple times. Completed
  steps are automatically skipped.

Examples:
  $ nemar admin publish approve nm000104         # Run full orchestrator
  $ nemar admin publish approve nm000104 --resume  # Resume from failed step
  $ nemar admin publish approve nm000104 --yes   # Skip confirmation

After Approval:
  - User receives email with DOI and public dataset link
  - Dataset is publicly visible on GitHub
  - Tags are protected (prevents version manipulation)
  - Data is protected by S3 Object Lock`,
  )
  .action(async (datasetId, options: ConfirmOptions & { resume?: boolean; sandbox?: boolean }) => {
    if (!requireAuth()) return;

    const action = options.resume
      ? `Resume publication of ${datasetId}`
      : `Approve and publish ${datasetId}`;
    console.log(chalk.cyan(`\n${action}\n`));
    console.log("This will run the following 14-step orchestrator:");
    console.log("   1. Check CI             7. Update README");
    console.log("   2. Make repo public      8. Create version tag");
    console.log("   3. S3 public read        9. Create GitHub release");
    console.log("   4. Tag protection       10. Upload to Zenodo");
    console.log(
      options.sandbox
        ? "   5. Create DOI (SANDBOX) 11. Publish DOI (irreversible)"
        : "   5. Create DOI           11. Publish DOI (irreversible)",
    );
    console.log("   6. Update metadata      12. S3 Object Lock");
    console.log("                           13. Generate archive");
    console.log("                           14. Notify user");
    console.log();

    // Sandbox warning
    if (options.sandbox) {
      console.log(chalk.yellow("━".repeat(60)));
      console.log(chalk.yellow.bold("                 SANDBOX MODE ENABLED"));
      console.log(chalk.yellow("━".repeat(60)));
      console.log(chalk.yellow("  • DOI will be created on sandbox.zenodo.org"));
      console.log(chalk.yellow("  • DOI will NOT be indexed by DataCite"));
      console.log(chalk.yellow("  • DOI will NOT resolve in production"));
      console.log(chalk.yellow("  • Use this for testing workflows only"));
      console.log(chalk.yellow("━".repeat(60)));
      console.log();
    }

    const confirmResult = await confirm(`${action}?`, options);
    if (confirmResult !== "confirmed") {
      console.log(chalk.gray(confirmResult === "declined" ? "Skipped" : "Cancelled"));
      return;
    }

    const spinner = ora("Running publication workflow...").start();

    try {
      const result = await approvePublication(datasetId, !!options.resume, !!options.sandbox);
      spinner.succeed(result.message);

      if (result.steps_completed) {
        console.log();
        for (const step of result.steps_completed) {
          console.log(`  ${chalk.green("[x]")} ${step.replace(/_/g, " ")}`);
        }
        console.log();
      }
    } catch (error) {
      handleCommandError(error, spinner, "Failed to approve publication", {
        422: "Fix the CI issues and retry with --resume",
      });
    }
  });

adminCommand.addCommand(publishCommand);

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
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(
    async (
      datasetId,
      targetVersion,
      options: { list?: boolean; force?: boolean; message?: string; dir?: string } & ConfirmOptions,
    ) => {
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
          console.log(
            `  ${chalk.green(v.version)}  ${chalk.gray(v.date)}  ${chalk.gray(v.commit)}`,
          );
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

      const confirmMessage = options.force
        ? `Directly push revert to ${selectedVersion}?`
        : `Create PR to revert to ${selectedVersion}?`;
      const confirmResult = await confirm(confirmMessage, options);
      if (confirmResult !== "confirmed") {
        console.log(chalk.gray(confirmResult === "declined" ? "Skipped" : "Cancelled"));
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
        } catch (_prError) {
          prSpinner.fail("Failed to create PR via gh CLI");
          const errorMsg = _prError instanceof Error ? _prError.message : String(_prError);
          console.error(chalk.red(`  Error: ${errorMsg}`));

          if (errorMsg.includes("not found") || errorMsg.includes("command not found")) {
            console.log(chalk.yellow("  Possible causes:"));
            console.log("    • GitHub CLI (gh) not installed or not in PATH");
            console.log("    • Run: brew install gh  (or see https://cli.github.com)");
          } else if (errorMsg.includes("auth") || errorMsg.includes("401")) {
            console.log(chalk.yellow("  GitHub authentication failed."));
            console.log("    • Run: gh auth login");
          }

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
    },
  );

// ============================================================================
// Make Public (One-Way Publish)
// ============================================================================

adminCommand
  .command("make-public")
  .description("Publish a dataset (make repository and data public) - PERMANENT")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .addHelpText(
    "after",
    `
Description:
  Publish a dataset by making both the GitHub repository and S3 data publicly accessible.

  ${chalk.yellow("⚠️  WARNING: This operation is PERMANENT and IRREVERSIBLE")}

  Once published:
  - GitHub repository will be publicly visible
  - S3 data files will be publicly downloadable
  - git-annex will use public URLs for downloads

  Publishing cannot be undone because:
  - Data may be cached, indexed, or linked externally
  - Unpublishing would create broken links
  - Aligns with DOI permanence principles

  Use this when:
  - Dataset has been reviewed and validated
  - Ready for public release and citation
  - Associated with a DOI (concept or version)

Requirements:
  - Dataset must not be a sandbox dataset
  - Dataset must have a GitHub repository
  - Must be dataset owner or admin

Examples:
  $ nemar admin make-public nm000104

  This will prompt for confirmation by requiring you to type
  the dataset ID to confirm the permanent action.
`,
  )
  .action(async (datasetIdArg: string) => {
    if (!requireAuth()) return;

    const datasetId = datasetIdArg.trim();

    // Fetch dataset details first
    let dataset: Dataset;
    try {
      dataset = await getDataset(datasetId);
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 404) {
        console.error(chalk.red(`Dataset '${datasetId}' not found`));
      } else {
        console.error(
          chalk.red(
            `Failed to fetch dataset: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
      process.exit(1);
    }

    // Show warning and dataset info
    console.log(chalk.yellow("\n⚠️  WARNING: Publishing is PERMANENT and IRREVERSIBLE\n"));
    console.log("This will:");
    console.log("  1. Make the GitHub repository PUBLIC");
    console.log("  2. Allow public S3 access to all dataset files");
    console.log("  3. Update git-annex configuration for web access\n");
    console.log(`Dataset: ${chalk.cyan(dataset.dataset_id)} - ${dataset.name}`);
    if (dataset.owner_username) {
      console.log(`Owner: ${dataset.owner_username}`);
    }
    if (dataset.github_repo) {
      console.log(`Repository: ${dataset.github_repo}`);
    }
    console.log();

    // Require typing dataset ID to confirm
    const confirmation = await inquirer.prompt([
      {
        type: "input",
        name: "datasetId",
        message: `Type '${datasetId}' to confirm:`,
        validate: (input: string) => {
          if (input.trim() === datasetId) {
            return true;
          }
          return `Please type exactly '${datasetId}' to confirm`;
        },
      },
    ]);

    if (confirmation.datasetId !== datasetId) {
      console.log(chalk.gray("Cancelled."));
      process.exit(0);
    }

    const spinner = ora("Publishing dataset...").start();

    try {
      const result = await publishDataset(datasetId);
      spinner.succeed(chalk.green("Dataset published successfully"));
      console.log(`\nGitHub: ${chalk.cyan(result.github_url)}`);
      console.log(`S3: ${chalk.cyan(result.s3_url)}`);
    } catch (error) {
      spinner.fail(chalk.red("Failed to publish dataset"));
      if (error instanceof ApiError) {
        console.error(chalk.red(`\n${error.message}`));
        if (error.details) {
          console.error(chalk.gray(JSON.stringify(error.details, null, 2)));
        }
        if (error.statusCode === 403) {
          console.log(chalk.gray("  You must be the dataset owner or an admin to publish"));
        } else if (error.statusCode === 400 && error.message.includes("sandbox")) {
          console.log(chalk.gray("  Sandbox datasets cannot be published"));
        }
      } else {
        console.error(chalk.red(`\n${error instanceof Error ? error.message : String(error)}`));
      }
      process.exit(1);
    }
  });
