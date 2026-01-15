/**
 * Admin commands for NEMAR CLI
 *
 * These commands require admin privileges.
 *
 * Commands:
 * - nemar admin users      - List users (pending, approved, all)
 * - nemar admin approve    - Approve a pending user
 * - nemar admin revoke     - Revoke user access
 * - nemar admin doi create - Create concept DOI for dataset (not yet implemented)
 */

import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import { isAuthenticated, getConfig } from "../lib/config.js";
import { ApiError, approveUser, listUsers, revokeUser } from "../lib/api.js";

export const adminCommand = new Command("admin").description(
  "Admin commands (requires admin privileges)"
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
        const statusColor = {
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
    console.log("  2. Add them as a collaborator to dataset repos");
    console.log("  3. Send them an email with their API key");
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
      console.log();
      console.log(chalk.yellow("API Key (shown once):"));
      console.log(chalk.gray(`  ${result.api_key}`));
      console.log();
      console.log(chalk.gray("The user has also been emailed their API key"));
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
    console.log("  2. Remove them as a collaborator from repos");
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
// DOI (placeholder for future implementation)
// ============================================================================

const doiCommand = new Command("doi").description("DOI management");

doiCommand
  .command("create")
  .description("Create concept DOI for a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option("--title <title>", "DOI title (defaults to dataset name)")
  .option("--description <desc>", "DOI description")
  .action(async (datasetId, options) => {
    if (!requireAuth()) return;

    console.log(chalk.yellow("DOI creation not yet implemented"));
    console.log();
    console.log(`Dataset: ${datasetId}`);
    console.log(chalk.red("WARNING: DOIs are PERMANENT and cannot be deleted"));
    console.log();
    console.log("This feature will:");
    console.log("  1. Validate dataset passes BIDS");
    console.log("  2. Pre-reserve DOI on Zenodo");
    console.log("  3. Update dataset_description.json");
    console.log("  4. Create initial release");
    console.log("  5. Publish DOI");
  });

adminCommand.addCommand(doiCommand);
