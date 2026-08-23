/**
 * Admin commands for NEMAR CLI
 *
 * These commands require admin privileges.
 *
 * Commands:
 * - nemar admin users              - List users (pending, approved, all)
 * - nemar admin approve            - Approve a pending user
 * - nemar admin revoke             - Revoke user access
 * - nemar admin role               - Change a user's role (owner only)
 * - nemar admin s3 regenerate-iam  - Regenerate AWS credentials for a user
 * - nemar admin repo public/private - Change repository visibility
 * - nemar admin ci check/add       - Manage CI workflows
 * - nemar admin doi create/info/update/enrich - DOI management
 * - nemar admin publish list/deny/approve - Publication workflow
 * - nemar admin revert             - Revert dataset to a previous version
 * - nemar admin withdraw/restore   - Withdraw/restore a published dataset (visibility + EZID DOIs)
 * - nemar admin recover [status]   - Re-copy epic #967 imports whose upstream is accessible
 * - nemar admin email-preferences show/update - Email notification opt-out
 * - nemar admin notice list/set/clear - System notice management
 * - nemar admin notify              - Send broadcast email to users
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import {
  type AvailabilityReport,
  type AvailabilityReportResult,
  type AvailabilityReportSweepBatchResponse,
  type DataIntegritySweepBatchResponse,
  type DatasetTransitionResponse,
  type DoctorFixLiveResponse,
  type DoctorFixResult,
  type DoctorScanResponse,
  type EmailPreferences,
  type HedSweepBatchResponse,
  type ReindexBulkOptions,
  type ReindexBulkResponse,
  type ReindexFilter,
  type ReindexOptions,
  type ReindexResponse,
  type SummaryVersionCoverage,
  addCi,
  approveUser,
  approveUserById,
  availabilityReport,
  availabilityReportSweep,
  availabilityReportSweepReset,
  bulkDeleteDatasets,
  changeUserRole,
  changeVisibility,
  createConceptDoi,
  createExemplar,
  dataIntegritySweep,
  dataIntegritySweepReset,
  deleteDataset,
  dispatchCooldown,
  dispatchManifest,
  doctorFix,
  doctorScan,
  enforceBulk,
  enforceDataset,
  getCiStatus,
  getDoiInfo,
  getEmailPreferences,
  getFleetDrift,
  getImportStatus,
  getSummaryCoverage,
  hedSweep,
  hedSweepReset,
  listUsers,
  publishDataset,
  reindexBulk,
  reindexDataset,
  remintExemplarDois,
  restoreDataset,
  retryImport,
  revalidateDataset,
  revokeUser,
  rollbackImport,
  sendBroadcast,
  syncCi,
  updateDoi,
  updateEmailPreferences,
  validateCi,
  verifyImport,
  withdrawDataset,
} from "../lib/api/admin.js";
import { applyS3Lock, getDatasetFiles } from "../lib/api/data.js";
import {
  type Dataset,
  type NemarMetadataPayload,
  ORCID_REGEX,
  finalizeDataset,
  getDataset,
  listDatasets,
  submitEnrichment,
} from "../lib/api/datasets.js";
import { ApiError, errorDetail } from "../lib/api/errors.js";
import {
  NOTICE_LEVELS,
  type NoticeLevel,
  createNotice,
  deleteNotice,
  listAdminNotices,
} from "../lib/api/notices.js";
import {
  type PublishProgressInfo,
  type StepResult,
  approvePublication,
  denyPublication,
  listPublishRequests,
} from "../lib/api/publish.js";
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
import { CLI_LIVE_DATASETS, selectRevalidateTargets } from "../lib/fleet.js";
import {
  cloneDataset,
  commitRevert,
  createRevertBranch,
  pushBranch,
} from "../lib/git-annex/clone-push.js";
import { checkDownloadPrerequisites } from "../lib/git-annex/prereq.js";
import { getVersionCommit, listDatasetVersions } from "../lib/git-annex/repo-state.js";
import { formatBytes } from "../lib/progress.js";
import {
  type RecoverDatasetEntry,
  loadRecoverDatasets,
  resolveImportSources,
  resolveRecoverTargets,
} from "../lib/recover-datasets.js";
import {
  type WithdrawnDatasetEntry,
  loadWithdrawnDatasets,
  resolveWithdrawTargets,
} from "../lib/withdrawn-datasets.js";

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
      console.log(chalk.dim(`  ${hint}`));
    } else if (error.statusCode === 403) {
      console.log(chalk.dim("  This command requires admin privileges"));
    }
  } else {
    spinner.fail(defaultMsg);
    console.log(chalk.dim(`  Error details: ${errorDetail(error)}`));
  }
}

/**
 * Fetch a file from a GitHub repo via the gh CLI, returning its decoded content.
 * Uses the /readme endpoint for READMEs, /contents/{path} for other files.
 * Returns null if the file does not exist or the command fails.
 */
async function fetchGitHubFileContent(repoName: string, path: string): Promise<string | null> {
  const { spawn: bunSpawn } = await import("bun");
  const endpoint =
    path === "README" ? `repos/${repoName}/readme` : `repos/${repoName}/contents/${path}`;
  const proc = bunSpawn({
    cmd: ["gh", "api", endpoint, "--jq", ".content"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const base64Content = await new Response(proc.stdout).text();
  const stderrContent = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    // Log non-404 errors so we can distinguish "not found" from real failures
    if (stderrContent.trim() && !stderrContent.includes("404")) {
      console.warn(`[fetchGitHubFileContent] Error fetching ${path}: ${stderrContent.trim()}`);
    }
    return null;
  }
  if (!base64Content.trim()) return null;
  return Buffer.from(base64Content.trim(), "base64").toString("utf-8");
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
  role           - Change a user's role (owner only: owner > admin > member)

Dataset Management:
  repo            - Manage repository visibility (public/private)
  ci              - Manage CI workflows (check status, deploy)
  s3              - S3/IAM credential management
  doi             - Create and manage DOIs for datasets
  publish         - Publication workflow management
  revert          - Revert dataset to previous version (via PR)
  make-public     - Publish a dataset (permanent, irreversible)
  delete-dataset    - Delete a dataset and all associated resources
  import-openneuro  - Import an OpenNeuro dataset into NEMAR
  withdraw          - Withdraw a broken published dataset (private + DOI tombstone), reversible
  restore           - Reverse a withdrawal (public + DOI restore)

Examples:
  $ nemar admin users --verified           # List users awaiting approval
  $ nemar admin users --role admin         # List all admins
  $ nemar admin approve john_doe           # Approve a user
  $ nemar admin approve --id 123           # Approve a web/ORCID user (no username)
  $ nemar admin role john_doe admin        # Promote user to admin (owner only)
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
    console.log(chalk.dim("  Run 'nemar auth login' first"));
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
  .option("--role <role>", "Filter by role: owner, admin, or member")
  .addHelpText(
    "after",
    `
Examples:
  $ nemar admin users                    # List all users
  $ nemar admin users --verified         # Users awaiting approval
  $ nemar admin users --role admin       # List all admins
  $ nemar admin users --role owner       # List all owners
  $ nemar admin users --approved --role member  # Approved regular users`,
  )
  .action(async (options) => {
    if (!requireAuth()) return;

    // Determine status filter
    let status: string | undefined;
    if (options.pending) status = "pending";
    else if (options.verified) status = "verified";
    else if (options.approved) status = "approved";
    else if (options.revoked) status = "revoked";

    // Validate role filter
    const role: string | undefined = options.role;
    if (role && !["owner", "admin", "member"].includes(role)) {
      console.error(chalk.red(`Invalid role '${role}'. Must be: owner, admin, or member`));
      process.exit(1);
    }

    const spinner = ora("Fetching users...").start();

    try {
      const result = await listUsers(status, role);
      spinner.stop();

      if (result.users.length === 0) {
        const filters = [status, role].filter(Boolean).join(", ");
        console.log(chalk.yellow(`No users found${filters ? ` (filter: ${filters})` : ""}`));
        return;
      }

      const filterLabel = [status, role ? `role=${role}` : ""].filter(Boolean).join(", ");
      console.log(
        `\n${chalk.cyan("NEMAR Users")} (${result.count} total${filterLabel ? `, filter: ${filterLabel}` : ""})\n`,
      );

      // Display users in a clean format
      for (const user of result.users) {
        const statusColor =
          {
            pending: chalk.dim,
            verified: chalk.yellow,
            approved: chalk.green,
            revoked: chalk.red,
          }[user.status] || chalk.white;

        const userRole = user.role || "member";
        const roleBadge =
          userRole === "owner"
            ? chalk.red(" [owner]")
            : userRole === "admin"
              ? chalk.magenta(" [admin]")
              : chalk.dim(" [member]");
        const verifiedBadge = user.email_verified ? "" : chalk.dim(" (unverified)");

        console.log(`  ${chalk.cyan(user.username)}${roleBadge}`);
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
  .argument("[username]", "Username to approve (CLI accounts)")
  .option("--id <id>", "Approve by numeric user id (web/ORCID accounts have no username)")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(async (username: string | undefined, options: ConfirmOptions & { id?: string }) => {
    // Exactly one addressing key: username (CLI accounts) or --id
    // (web/ORCID accounts, whose username is NULL by design — #1012).
    // Validated before the auth gate: argv errors should surface (exit 1)
    // even when the caller is not logged in.
    const byId = options.id !== undefined;
    if (!byId && !username) {
      console.error(chalk.red("Error: provide a username or --id <id>"));
      console.error(chalk.dim("Web/ORCID accounts have no username; find their id with:"));
      console.error(chalk.dim("  nemar admin users --pending"));
      process.exit(1);
    }
    if (byId && username) {
      console.error(chalk.red("Error: username and --id are mutually exclusive; provide one"));
      process.exit(1);
    }
    let userId = 0;
    if (byId) {
      userId = Number.parseInt(options.id ?? "", 10);
      if (!Number.isInteger(userId) || userId <= 0) {
        console.error(chalk.red(`Error: invalid user id: ${options.id}`));
        process.exit(1);
      }
    }

    if (!requireAuth()) return;

    const label = username ?? `user id ${userId}`;

    // Confirmation
    console.log(chalk.cyan(`\nApproving user: ${label}\n`));
    console.log("This will:");
    console.log("  1. Mark the account approved");
    if (username) {
      console.log("  2. Notify them to retrieve their API key via CLI");
    } else {
      console.log("  2. Notify them to sign in to the dashboard");
    }
    console.log();

    const result = await confirm(`Approve ${label}?`, options, true);
    if (result !== "confirmed") {
      console.log(chalk.dim(result === "declined" ? "Skipped" : "Cancelled"));
      return;
    }

    const spinner = ora(`Approving ${label}...`).start();

    try {
      const result = username ? await approveUser(username) : await approveUserById(userId);
      spinner.succeed(`Approved ${result.user.username ?? label}`);
      console.log();
      console.log(`  Email: ${result.user.email}`);
      console.log(`  Status: ${chalk.green(result.user.status)}`);

      console.log();
      if (result.email_sent) {
        console.log(
          result.user.username
            ? chalk.green("User notified to retrieve their API key via 'nemar auth retrieve-key'")
            : chalk.green("User notified to sign in at https://nemar.org/login"),
        );
      } else {
        console.log(chalk.yellow("Warning: Notification email failed to send."));
        console.log(
          result.user.username
            ? chalk.yellow("Please notify the user manually to run 'nemar auth retrieve-key'")
            : chalk.yellow("Please notify the user manually that their account is approved"),
        );
      }
    } catch (error) {
      handleCommandError(error, spinner, "Failed to approve user", {
        404: "User not found or not eligible for approval",
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
      console.log(chalk.dim(result === "declined" ? "Skipped" : "Cancelled"));
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
// Role Management (Owner Only)
// ============================================================================

adminCommand
  .command("role")
  .description("Change a user's role (owner only)")
  .argument("<username>", "Username to change role for")
  .argument("<role>", "New role: owner, admin, or member")
  .option("-y, --yes", "Skip confirmation prompt")
  .addHelpText(
    "after",
    `
Permission Model:
  owner  - Full access: can manage users, roles, datasets, DOIs, and system settings
  admin  - Can approve/revoke users, manage datasets and DOIs
  member - Can upload and manage their own datasets only

Rules:
  - Only owners can change roles
  - You cannot change your own role (prevents self-lockout)
  - The last owner cannot be demoted (prevents total lockout)
  - Demoting a user revokes their tokens (they must re-login)

Examples:
  $ nemar admin role john_doe admin        # Promote to admin
  $ nemar admin role john_doe member       # Demote to member
  $ nemar admin role jane_doe owner -y     # Promote to owner (skip confirm)`,
  )
  .action(async (username: string, role: string, options: { yes?: boolean }) => {
    if (!requireAuth()) return;

    if (!["owner", "admin", "member"].includes(role)) {
      console.error(chalk.red(`Invalid role '${role}'. Must be: owner, admin, or member`));
      process.exit(1);
    }

    if (!options.yes) {
      const { confirmed } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirmed",
          message: `Change ${username}'s role to '${role}'?`,
          default: false,
        },
      ]);
      if (!confirmed) {
        console.log(chalk.dim("Cancelled"));
        return;
      }
    }

    const spinner = ora(`Changing ${username}'s role to '${role}'...`).start();

    try {
      const result = await changeUserRole(username, role as "owner" | "admin" | "member");
      spinner.succeed(result.message);
      if (result.tokens_revoked !== undefined && result.tokens_revoked > 0) {
        console.log(
          chalk.yellow(`  ${result.tokens_revoked} token(s) revoked (user must re-login)`),
        );
      }
    } catch (error) {
      handleCommandError(error, spinner, "Failed to change role", {
        400: "Invalid request (check if you are an owner)",
        403: "Owner access required",
        404: "User not found",
        409: "User already has that role",
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
      console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
      return;
    }

    const spinner = ora("Applying S3 Object Lock...").start();

    try {
      const result = await applyS3Lock(datasetId);
      if (result.failed.length > 0) {
        spinner.fail(`Partial lock: ${result.locked} locked, ${result.failed.length} failed`);
        console.log(chalk.yellow("\nFailed objects:"));
        for (const f of result.failed.slice(0, 10)) {
          console.log(`  • ${f.key}: ${chalk.dim(f.error)}`);
        }
        if (result.failed.length > 10) {
          console.log(`  ... and ${result.failed.length - 10} more`);
        }
      } else {
        spinner.succeed(`All ${result.locked} objects locked successfully`);
      }
    } catch (error) {
      spinner.fail("S3 lock failed");
      console.log(chalk.dim(`  ${errorDetail(error)}`));
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

async function regenerateIamAction(_username: string, _options: ConfirmOptions) {
  if (!requireAuth()) return;

  console.log(chalk.yellow("\nThis command is deprecated.\n"));
  console.log("S3 access is now managed through backend-scoped credentials.");
  console.log("Per-user IAM credentials are no longer needed.");
  console.log();
  console.log(chalk.dim("Users can upload datasets without any IAM setup."));
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
      console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
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
      console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
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
          console.log(`      URL:    ${chalk.dim(result.bids_validation.url)}`);
        }
      } else {
        console.log(`      ${chalk.dim("Not deployed. Use 'nemar admin ci add' to deploy.")}`);
      }

      // Version Check
      const versionPresent = result.version_check.present;
      const versionIcon = versionPresent ? chalk.green("[x]") : chalk.red("[ ]");
      console.log(`  ${versionIcon} Version Check`);
      if (!versionPresent) {
        console.log(`      ${chalk.dim("Not deployed. Use 'nemar admin ci add' to deploy.")}`);
      }

      console.log();
    } catch (error) {
      handleCommandError(error, spinner, "Failed to check CI status", {
        404: "Dataset not found",
      });
    }
  });

/** Probe shape — see pollCiValidation. Exported for the unit test. */
export type ValidationProbe = () => Promise<{
  valid: string[];
  missing: string[];
  errors: string[];
}>;

/**
 * Poll the validate endpoint after a CI deploy. GitHub's workflow index lags
 * the commit by a few seconds; the previous design slept inside the Worker,
 * which burned wall-clock budget. This runs the sleep + retry on the user's
 * machine instead (issue #472).
 *
 * Default backoff: 2.5 s, then 5 s if anything is still missing. Returns the
 * final validation result (or null if the poll itself errored out — also
 * treated as a best-effort warning by the caller). `probe` and `delaysMs`
 * are dependency-injected so the unit test can pass a fake probe and zero
 * delays without spinning up a real backend.
 */
export async function pollCiValidation(
  datasetId: string,
  probe: ValidationProbe = async () => {
    const r = await validateCi(datasetId);
    return { valid: r.valid, missing: r.missing, errors: r.errors };
  },
  delaysMs: readonly number[] = [2500, 5000],
): Promise<{ valid: string[]; missing: string[]; errors: string[] } | null> {
  let last: { valid: string[]; missing: string[]; errors: string[] } | null = null;
  for (const delay of delaysMs) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      last = await probe();
      // Stop early when everything is parseable or the call itself failed
      // (retrying a 500 just adds latency without new information).
      if (last.missing.length === 0 || last.errors.length > 0) return last;
    } catch {
      // Network/API hiccup. Don't retry — the deploy succeeded, just skip
      // the inline parseability warning.
      return null;
    }
  }
  return last;
}

function printValidationWarning(result: { missing: string[]; errors: string[] }): void {
  console.log();
  console.log(chalk.yellow("Validation warnings (best-effort; deploy succeeded):"));
  if (result.missing.length > 0) {
    console.log(
      `  ${chalk.yellow("!")} Not listed by GitHub Actions (parse error or indexing lag): ${result.missing.join(", ")}`,
    );
  }
  for (const e of result.errors) {
    console.log(`  ${chalk.yellow("!")} ${e}`);
  }
}

ciCommand
  .command("add")
  .description("Deploy CI workflows to a dataset repository (or all with --all)")
  .argument("[dataset-id]", "Dataset ID (e.g., nm000104)")
  .option("--all", "Deploy to all dataset repositories")
  .option(
    "--no-validate",
    "Skip the post-deploy parseability poll on the single-dataset path. No-op for --all (fleet deploys always skip the poll).",
  )
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(async (datasetId, options: { all?: boolean; validate?: boolean } & ConfirmOptions) => {
    if (!requireAuth()) return;

    // Commander sets `validate: false` when the user passes `--no-validate`.
    const skipValidate = options.validate === false;

    if (options.all) {
      const spinner = ora("Fetching dataset list...").start();
      let datasets: { dataset_id: string }[];
      try {
        const result = await listDatasets({ limit: 1000 });
        datasets = result.datasets;
        spinner.succeed(`Found ${datasets.length} datasets`);
        if (datasets.length >= 1000) {
          console.log(
            chalk.yellow("Warning: reached 1000 dataset limit; some datasets may be skipped"),
          );
        }
      } catch (error) {
        handleCommandError(error, spinner, "Failed to fetch datasets");
        return;
      }

      console.log(chalk.cyan(`\nDeploy CI workflows to ${datasets.length} datasets\n`));
      console.log("This will add/update the following workflows on each:");
      console.log("  1. BIDS Validation (runs on PRs)");
      console.log("  2. Version Check (ensures version bump on PRs)");
      console.log("  3. PR Merge Handler (creates releases, publishes DOIs)");
      console.log(
        chalk.dim(
          "  (post-deploy parseability poll skipped for --all; run 'nemar admin ci validate <id>' per dataset)",
        ),
      );
      console.log();

      const confirmResult = await confirm(
        `Deploy CI workflows to all ${datasets.length} datasets?`,
        options,
      );
      if (confirmResult !== "confirmed") {
        console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
        return;
      }

      // Fleet deploys always skip the parseability poll. With many datasets
      // the per-dataset 2.5–7.5 s wait adds up; users running --all typically
      // just want fast confirmation of commits. Admins can run
      // `nemar admin ci validate <id>` on individual datasets afterward.
      // skipValidate is intentionally unused here — --no-validate accepts but
      // is a no-op on the fleet path (consistent with what the help text
      // says).
      let succeeded = 0;
      let failed = 0;
      for (const ds of datasets) {
        const dsSpinner = ora(`Deploying to ${ds.dataset_id}...`).start();
        try {
          await addCi(ds.dataset_id);
          dsSpinner.succeed(`${ds.dataset_id}: deployed`);
          succeeded++;
        } catch (error) {
          const msg = error instanceof ApiError ? error.message : String(error);
          dsSpinner.fail(`${ds.dataset_id}: ${msg}`);
          failed++;
        }
      }

      console.log();
      console.log(
        chalk.cyan(`Done: ${succeeded} succeeded, ${failed} failed out of ${datasets.length}`),
      );
      return;
    }

    if (!datasetId) {
      console.error(chalk.red("Error: dataset-id is required (or use --all)"));
      return;
    }

    console.log(chalk.cyan(`\nDeploy CI workflows to: ${datasetId}\n`));
    console.log("This will add the following workflows:");
    console.log("  1. BIDS Validation (runs on PRs)");
    console.log("  2. Version Check (ensures version bump on PRs)");
    console.log("  3. PR Merge Handler (creates releases, publishes DOIs)");
    if (skipValidate) {
      console.log(chalk.dim("  (post-deploy parseability poll disabled via --no-validate)"));
    }
    console.log();

    const confirmResult = await confirm(`Deploy CI workflows to ${datasetId}?`, options);
    if (confirmResult !== "confirmed") {
      console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
      return;
    }

    const spinner = ora(`Deploying CI workflows to ${datasetId}...`).start();

    let result: Awaited<ReturnType<typeof addCi>>;
    try {
      result = await addCi(datasetId);
    } catch (error) {
      handleCommandError(error, spinner, "Failed to deploy CI workflows", {
        404: "Dataset not found",
      });
      return;
    }
    spinner.succeed("CI workflows deployed");
    console.log();
    for (const workflow of result.workflows_deployed) {
      console.log(`  ${chalk.green("[x]")} ${workflow}`);
    }

    if (!skipValidate) {
      const validateSpinner = ora("Verifying GitHub Actions can parse the workflows...").start();
      const validation = await pollCiValidation(datasetId);
      if (!validation) {
        validateSpinner.warn("Could not verify workflow parseability (deploy succeeded)");
      } else if (validation.missing.length === 0 && validation.errors.length === 0) {
        validateSpinner.succeed("All workflows parseable by GitHub Actions");
      } else {
        // missing.length > 0 and errors.length > 0 are independent: a 5xx on
        // the listing call (errors) doesn't necessarily mean any workflow
        // is missing. Be precise about which case is firing.
        const warnMsg =
          validation.missing.length > 0
            ? "Some workflows missing from GitHub Actions listing"
            : "Could not fully verify workflow parseability (GitHub API error)";
        validateSpinner.warn(warnMsg);
        printValidationWarning(validation);
      }
    }
    console.log();
  });

ciCommand
  .command("validate")
  .description("Check whether GitHub Actions can parse the deployed CI workflows")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .action(async (datasetId: string) => {
    if (!requireAuth()) return;
    const spinner = ora(`Validating CI workflows for ${datasetId}...`).start();
    try {
      const r = await validateCi(datasetId);
      if (r.missing.length === 0 && r.errors.length === 0) {
        spinner.succeed(`All ${r.valid.length} workflows parseable by GitHub Actions`);
      } else {
        spinner.warn("Some workflows missing or unreadable");
        printValidationWarning({ missing: r.missing, errors: r.errors });
      }
    } catch (error) {
      handleCommandError(error, spinner, "Failed to validate CI workflows", {
        404: "Dataset not found",
      });
    }
  });

ciCommand
  .command("sync")
  .description(
    "Sync deployed CI workflows to current templates (only writes drifted/missing files)",
  )
  .argument("[dataset-id]", "Dataset ID (e.g., nm000104)")
  .option("--all", "Sync across all dataset repositories")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(async (datasetId, options: { all?: boolean } & ConfirmOptions) => {
    if (!requireAuth()) return;

    if (options.all) {
      const spinner = ora("Fetching dataset list...").start();
      let datasets: { dataset_id: string }[];
      try {
        const result = await listDatasets({ limit: 1000 });
        datasets = result.datasets;
        spinner.succeed(`Found ${datasets.length} datasets`);
        if (datasets.length >= 1000) {
          console.log(
            chalk.yellow("Warning: reached 1000 dataset limit; some datasets may be skipped"),
          );
        }
      } catch (error) {
        handleCommandError(error, spinner, "Failed to fetch datasets");
        return;
      }

      console.log(
        chalk.cyan(`\nSync CI templates across ${datasets.length} datasets (writes only diffs)\n`),
      );

      const confirmResult = await confirm(
        `Sync templates on all ${datasets.length} datasets?`,
        options,
      );
      if (confirmResult !== "confirmed") {
        console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
        return;
      }

      let upToDate = 0;
      let updated = 0;
      let withErrors = 0;
      for (const ds of datasets) {
        const dsSpinner = ora(`Syncing ${ds.dataset_id}...`).start();
        try {
          const result = await syncCi(ds.dataset_id);
          const changes = result.changed.length + result.added.length;
          if (result.errors.length > 0) {
            dsSpinner.warn(
              `${ds.dataset_id}: ${changes} updated, ${result.errors.length} error(s)`,
            );
            withErrors++;
          } else if (changes === 0) {
            dsSpinner.succeed(`${ds.dataset_id}: up to date`);
            upToDate++;
          } else {
            const parts: string[] = [];
            if (result.added.length > 0) parts.push(`+${result.added.length} added`);
            if (result.changed.length > 0) parts.push(`~${result.changed.length} updated`);
            dsSpinner.succeed(`${ds.dataset_id}: ${parts.join(", ")}`);
            updated++;
          }
        } catch (error) {
          const msg = error instanceof ApiError ? error.message : String(error);
          dsSpinner.fail(`${ds.dataset_id}: ${msg}`);
          withErrors++;
        }
      }

      console.log();
      console.log(
        chalk.cyan(`Done: ${upToDate} up-to-date, ${updated} updated, ${withErrors} with errors`),
      );
      return;
    }

    if (!datasetId) {
      console.error(chalk.red("Error: dataset-id is required (or use --all)"));
      return;
    }

    const spinner = ora(`Syncing CI templates for ${datasetId}...`).start();
    try {
      const result = await syncCi(datasetId);
      const changes = result.changed.length + result.added.length;
      if (result.errors.length > 0) {
        spinner.warn(`${datasetId}: ${result.errors.length} error(s)`);
      } else if (changes === 0) {
        spinner.succeed(`${datasetId}: already up to date`);
      } else {
        spinner.succeed(`${datasetId}: synced`);
      }
      console.log();
      console.log(`  ${chalk.dim("Checked:")} ${result.checked.join(", ")}`);
      if (result.added.length > 0) {
        console.log(`  ${chalk.green("Added:")}   ${result.added.join(", ")}`);
      }
      if (result.changed.length > 0) {
        console.log(`  ${chalk.yellow("Updated:")} ${result.changed.join(", ")}`);
      }
      if (!result.committed && changes > 0 && result.errors.length === 0) {
        // Defensive: the intended changes were computed but no commit
        // was made. Should never happen in practice (the helper sets
        // `committed: true` whenever it tries to write).
        console.log(`  ${chalk.yellow("Note:")}    listed changes were not committed`);
      }
      if (result.list_failed) {
        console.log(
          `  ${chalk.red("Warning:")} workflow directory listing failed; presence is unknown`,
        );
      }
      if (result.errors.length > 0) {
        console.log(`  ${chalk.red("Errors:")}`);
        for (const err of result.errors) console.log(`    - ${err}`);
      }
      console.log();
    } catch (error) {
      handleCommandError(error, spinner, "Failed to sync CI templates", {
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
            console.log(chalk.dim("  Dataset not found"));
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
      } catch (err) {
        // DOI info unavailable (e.g., dataset has no DOI yet); continue to creation
        if (process.env.DEBUG) console.error("[debug] DOI info fetch:", err);
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
        chalk.dim(
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
        console.log(chalk.dim(result === "declined" ? "Skipped" : "Cancelled"));
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
            console.log(chalk.dim(`  ${protectionError.message}`));
            if (protectionError.statusCode === 403) {
              console.log(chalk.dim("  Check admin credentials and permissions"));
            }
          } else {
            console.log(
              chalk.dim(
                `  ${protectionError instanceof Error ? protectionError.message : "Unknown error"}`,
              ),
            );
          }
          console.log(
            chalk.dim("  Manual setup: Go to GitHub repo Settings > Branches > Add rule"),
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
        console.log("  1. Update dataset_description.json with DatasetDOI field");
        console.log("  2. Create a PR and merge it to trigger version DOI publication");
        console.log();
        if (options.sandbox) {
          console.log(chalk.dim("Note: This is a sandbox DOI and will not resolve in production."));
        }
      } catch (error) {
        if (error instanceof ApiError) {
          createSpinner.fail(error.message);
          if (error.statusCode === 403) {
            console.log(chalk.dim("  This command requires admin privileges"));
          }
        } else {
          createSpinner.fail("Failed to create concept DOI");
          console.log(chalk.dim(`  ${errorDetail(error)}`));
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
        console.log(chalk.dim("  Use 'nemar admin doi create' to create one"));
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
        console.log(chalk.dim("  Version DOIs are created automatically on PR merge"));
      }
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
        if (error.statusCode === 404) {
          console.log(chalk.dim("  Dataset not found"));
        } else if (error.statusCode === 403) {
          console.log(chalk.dim("  This command requires admin privileges"));
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
  .option(
    "--unavailable",
    "Tombstone the concept DOI (EZID _status=unavailable); concept-only, reversible via --make-public. For a full withdrawal (visibility + every version DOI) use 'nemar admin withdraw' instead.",
  )
  .option("--refresh", "Refresh metadata from dataset_description.json and .nemar/metadata.json")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(
    async (
      datasetId: string,
      options: { makePublic?: boolean; unavailable?: boolean; refresh?: boolean } & ConfirmOptions,
    ) => {
      if (!requireAuth()) return;

      if (options.makePublic && options.unavailable) {
        console.log(chalk.red("Use --make-public or --unavailable, not both."));
        return;
      }

      if (!options.makePublic && !options.unavailable && !options.refresh) {
        console.log(
          chalk.yellow("No action specified. Use --make-public, --unavailable, and/or --refresh."),
        );
        return;
      }

      if (options.makePublic) {
        console.log(chalk.red("WARNING: Making a DOI public is PERMANENT!"));
        console.log(chalk.dim("  The DOI will be findable in DataCite and cannot be reverted."));
        console.log();

        const confirmResult = await confirm(
          `Make DOI for ${datasetId} PUBLIC and permanent?`,
          options,
        );
        if (confirmResult !== "confirmed") {
          console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
          return;
        }
      }

      if (options.unavailable) {
        console.log(chalk.yellow("This tombstones the concept DOI (EZID _status=unavailable)."));
        console.log(chalk.dim("  Reversible with --make-public. Version DOIs are untouched."));
        console.log();

        const confirmResult = await confirm(
          `Mark DOI for ${datasetId} unavailable (tombstone)?`,
          options,
        );
        if (confirmResult !== "confirmed") {
          console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
          return;
        }
      }

      const spinner = ora("Updating DOI...").start();

      try {
        const result = await updateDoi(datasetId, {
          status: options.makePublic ? "public" : options.unavailable ? "unavailable" : undefined,
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
            console.log(chalk.dim("  DOI update is only supported for EZID-managed DOIs"));
          }
        } else {
          spinner.fail("Failed to update DOI");
          console.log(chalk.dim(`  ${errorDetail(error)}`));
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
    async (datasetId: string, options: { llm?: boolean; sandbox?: boolean } & ConfirmOptions) => {
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
      let doiInfo: Awaited<ReturnType<typeof getDoiInfo>> | undefined;
      let doiFetchFailed = false;
      try {
        doiInfo = await getDoiInfo(datasetId);
      } catch (doiErr) {
        if (doiErr instanceof ApiError && doiErr.statusCode === 404) {
          // No DOI exists yet
        } else {
          doiFetchFailed = true;
          console.log(chalk.yellow(`  Warning: Could not fetch DOI info: ${errorDetail(doiErr)}`));
        }
      }

      if (doiInfo?.concept_doi) {
        console.log(`  DOI: ${chalk.cyan(doiInfo.concept_doi)}`);
      }

      // Fetch existing .nemar/metadata.json to merge with (never overwrite)
      let enrichment: NemarMetadataPayload = { version: "2.0" };
      if (dataset.github_repo) {
        const metaSpinner = ora("Reading existing metadata...").start();
        const existingContent = await fetchGitHubFileContent(
          dataset.github_repo,
          ".nemar/metadata.json",
        );
        if (existingContent) {
          try {
            const parsed = JSON.parse(existingContent);
            if (parsed && typeof parsed === "object" && parsed.version === "2.0") {
              enrichment = parsed as NemarMetadataPayload;
              metaSpinner.succeed(
                `Loaded existing metadata (stage: ${(parsed as Record<string, unknown>).pipeline_stage || "unknown"})`,
              );
            } else {
              metaSpinner.warn("Existing metadata has unsupported version, starting fresh");
            }
          } catch (parseErr) {
            metaSpinner.warn(
              `Could not parse existing metadata (${parseErr instanceof Error ? parseErr.message : String(parseErr)}), starting fresh`,
            );
          }
        } else {
          metaSpinner.info("No existing .nemar/metadata.json found, starting fresh");
        }
      }

      // --- LLM Enrichment (triggers CI workflow on GitHub Actions) ---
      // Run BEFORE manual author entry so discovered ORCIDs are shown for confirmation
      if (options.llm !== false && dataset.github_repo) {
        console.log();
        console.log(chalk.cyan("--- Running LLM enrichment pipeline (CI workflow) ---"));

        const llmSpinner = ora("Triggering run-enrichment workflow...").start();
        try {
          const { spawn: bunSpawn } = await import("bun");
          const repo = dataset.github_repo;
          // Phase 1 of centralization (#602): the enrichment workflow now
          // lives at nemarDatasets/.github/.github/workflows/run-enrichment.yml.
          // We trigger it with the target dataset_id in the workflow_dispatch
          // inputs; the central workflow mints a per-repo App token, checks
          // out the dataset repo, and hands off to /webhooks/llm-enrich the
          // same way the legacy per-repo workflow did.
          const CENTRAL_WORKFLOW_REPO = "nemarDatasets/.github";
          const CENTRAL_WORKFLOW_FILE = "run-enrichment.yml";

          // Trigger the workflow
          const trigger = bunSpawn({
            cmd: [
              "gh",
              "workflow",
              "run",
              CENTRAL_WORKFLOW_FILE,
              "--repo",
              CENTRAL_WORKFLOW_REPO,
              "--ref",
              "main",
              "-f",
              `dataset_id=${datasetId}`,
              "-f",
              "ref=main",
              "-f",
              "force=true",
            ],
            stdout: "pipe",
            stderr: "pipe",
          });
          const triggerErr = await new Response(trigger.stderr).text();
          const triggerExit = await trigger.exited;
          if (triggerExit !== 0) {
            throw new Error(`Failed to trigger workflow: ${triggerErr.trim()}`);
          }

          llmSpinner.text = "Waiting for workflow to register...";
          await new Promise((r) => setTimeout(r, 3000));

          // Poll for completion. Filter runs by the dataset_id we just
          // dispatched against — multiple datasets share the central
          // workflow so we can't just look at the latest run.
          llmSpinner.text = "Polling workflow status...";
          const maxAttempts = 60; // 5 minutes at 5s intervals
          let conclusion = "";
          let consecutiveFailures = 0;
          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const poll = bunSpawn({
              cmd: [
                "gh",
                "run",
                "list",
                "--repo",
                CENTRAL_WORKFLOW_REPO,
                "--workflow",
                CENTRAL_WORKFLOW_FILE,
                "-L",
                "10",
                "--json",
                "databaseId,status,conclusion,displayTitle,event",
              ],
              stdout: "pipe",
              stderr: "pipe",
            });
            const pollOut = await new Response(poll.stdout).text();
            const pollErr = await new Response(poll.stderr).text();
            const pollExit = await poll.exited;

            if (pollExit !== 0) {
              consecutiveFailures++;
              if (consecutiveFailures >= 3) {
                llmSpinner.warn(`gh CLI error: ${pollErr.trim()}`);
                break;
              }
              await new Promise((r) => setTimeout(r, 5000));
              continue;
            }

            try {
              const runs = JSON.parse(pollOut.trim()) as Array<{
                databaseId: number;
                status: string;
                conclusion: string | null;
                displayTitle?: string;
                event?: string;
              }>;
              consecutiveFailures = 0;
              // Multiple datasets can share the central workflow, so picking
              // runs[0] outright is unsafe — a concurrent push-triggered
              // dispatch would shadow ours. Filter to the most recent
              // workflow_dispatch (which is how this CLI dispatches) and
              // accept the small race where two operators run `nemar admin
              // enrich` within seconds of each other. Centralization
              // followup: include a correlation ID once GitHub exposes
              // dispatch->run_id linkage.
              const ours = runs.find((r) => r.event === "workflow_dispatch");
              if (ours) {
                if (ours.status === "completed") {
                  conclusion = ours.conclusion || "unknown";
                  break;
                }
                llmSpinner.text = `Workflow ${ours.status}... (${attempt * 5}s)`;
              }
            } catch (parseErr) {
              consecutiveFailures++;
              if (consecutiveFailures >= 3) {
                llmSpinner.warn(
                  `Unable to parse workflow status: ${parseErr instanceof Error ? parseErr.message : String(parseErr)} (raw: ${pollOut.trim().slice(0, 200)})`,
                );
                break;
              }
            }

            await new Promise((r) => setTimeout(r, 5000));
          }

          let discoveryRan = false;
          if (!conclusion) {
            llmSpinner.warn("Workflow timed out after 5 minutes (may still be running)");
          } else if (conclusion === "success") {
            llmSpinner.succeed("LLM enrichment workflow completed successfully");

            // Re-read metadata from repo since CI committed it
            const updatedContent = await fetchGitHubFileContent(repo, ".nemar/metadata.json");
            if (updatedContent) {
              try {
                const parsed = JSON.parse(updatedContent);
                if (parsed && typeof parsed === "object" && parsed.version === "2.0") {
                  // Merge LLM results into enrichment (preserves any fields set by earlier steps)
                  Object.assign(enrichment, parsed);
                  discoveryRan = true;
                  const stage = parsed.pipeline_stage || "unknown";
                  console.log(chalk.dim(`  Pipeline stage: ${stage}`));
                  if (enrichment.authors) {
                    const authorCount = Object.keys(enrichment.authors).length;
                    console.log(chalk.dim(`  Authors: ${authorCount}`));
                  }
                }
              } catch (parseErr) {
                console.log(
                  chalk.yellow(
                    `  Warning: Could not parse updated metadata: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
                  ),
                );
                console.log(chalk.dim("  Using pre-workflow enrichment data"));
              }
            } else {
              console.log(
                chalk.yellow(
                  "  Warning: Could not fetch updated metadata after successful workflow.",
                ),
              );
              console.log(chalk.dim("  Author data below may be from a previous run."));
            }
          } else {
            llmSpinner.fail(`LLM enrichment workflow failed (conclusion: ${conclusion})`);
          }

          if (!discoveryRan) {
            console.log(
              chalk.yellow(
                "  ORCID discovery did not complete. Authors below may be from previous metadata.",
              ),
            );
          }
        } catch (error) {
          llmSpinner.fail("LLM enrichment pipeline failed");
          console.log(chalk.dim(`  ${errorDetail(error)}`));
          console.log(
            chalk.yellow("  ORCID discovery did not run. You will need to enter ORCIDs manually."),
          );
        }
      }

      // --- Author ORCIDs (confirm discovered + supplement missing) ---
      console.log();
      console.log(chalk.cyan("--- Author ORCIDs ---"));

      // Show authors discovered by the pipeline
      const existingAuthors = enrichment.authors || {};
      const authorNames = Object.keys(existingAuthors);
      if (authorNames.length > 0) {
        const withOrcid = authorNames.filter((n) => existingAuthors[n]?.orcid);
        const withoutOrcid = authorNames.filter((n) => !existingAuthors[n]?.orcid);
        console.log(chalk.dim(`  Discovered ${authorNames.length} authors from pipeline:`));
        for (const name of withOrcid) {
          console.log(chalk.green(`    [x] ${name}: ${existingAuthors[name]?.orcid}`));
        }
        for (const name of withoutOrcid) {
          console.log(chalk.yellow(`    [ ] ${name}: no ORCID found`));
        }
        if (withoutOrcid.length > 0) {
          console.log(chalk.dim(`  ${withoutOrcid.length} author(s) missing ORCIDs.`));
        }
      }

      const { updateAuthors } = await inquirer.prompt([
        {
          type: "confirm",
          name: "updateAuthors",
          message:
            authorNames.length > 0
              ? "Add or correct author ORCIDs?"
              : "Add author ORCIDs manually?",
          default: false,
        },
      ]);

      if (updateAuthors) {
        const authors: Record<string, { orcid?: string; affiliations?: Array<{ name: string }> }> =
          {};

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

          // Show current ORCID if one was discovered
          const current = existingAuthors[authorName];
          if (current?.orcid) {
            console.log(chalk.dim(`  Current ORCID: ${current.orcid}`));
          }

          const { orcid } = await inquirer.prompt([
            {
              type: "input",
              name: "orcid",
              message: `ORCID for "${authorName}" (Enter to ${current?.orcid ? "keep current" : "skip"}):`,
              validate: (input: string) => {
                if (!input) return true;
                return ORCID_REGEX.test(input) || "Invalid ORCID format (XXXX-XXXX-XXXX-XXXX)";
              },
            },
          ]);

          const entry: { orcid?: string; affiliations?: Array<{ name: string }> } = {};
          if (orcid) entry.orcid = orcid;

          const { affiliation } = await inquirer.prompt([
            {
              type: "input",
              name: "affiliation",
              message: `Affiliation for "${authorName}" (optional):`,
            },
          ]);
          if (affiliation) entry.affiliations = [{ name: affiliation }];

          if (entry.orcid || entry.affiliations) {
            authors[authorName] = entry;
          }

          const { more } = await inquirer.prompt([
            { type: "confirm", name: "more", message: "Add another author?", default: true },
          ]);
          addMore = more;
        }

        if (Object.keys(authors).length > 0) {
          // Deep-merge: preserve discovered fields (e.g., ORCID) when user only adds affiliation
          const merged = { ...(enrichment.authors || {}) };
          for (const [name, manualEntry] of Object.entries(authors)) {
            const existing = merged[name] || {};
            merged[name] = {
              ...existing,
              ...manualEntry,
              orcid: manualEntry.orcid || existing.orcid,
            };
          }
          enrichment.authors = merged;
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
        console.log(chalk.dim(`  ${errorDetail(error)}`));
      }

      // --- Review ---
      console.log();
      console.log(chalk.cyan("--- Review ---"));
      console.log(JSON.stringify(enrichment, null, 2));
      console.log();

      const confirmResult = await confirm("Commit to repo and refresh DOI?", options, true);
      if (confirmResult !== "confirmed") {
        console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
        return;
      }

      // Submit enrichment
      const submitSpinner = ora("Saving enrichment...").start();
      try {
        const result = await submitEnrichment(datasetId, enrichment);
        submitSpinner.succeed(result.message);

        if (result.bidsignore_updated) {
          console.log(chalk.dim("  .bidsignore updated to include .nemar/"));
        }

        // Refresh DOI metadata if the dataset has an EZID DOI
        // Re-attempt DOI info fetch if it failed earlier (transient error)
        if (!doiInfo && doiFetchFailed) {
          try {
            doiInfo = await getDoiInfo(datasetId);
          } catch (err) {
            if (process.env.DEBUG) console.error("[debug] DOI info re-fetch:", err);
          }
        }
        if (doiInfo?.ezid_identifier) {
          const refreshSpinner = ora("Refreshing DOI metadata...").start();
          try {
            await updateDoi(datasetId, { refresh_metadata: true });
            refreshSpinner.succeed("DOI metadata refreshed");
          } catch (error) {
            refreshSpinner.warn("Could not refresh DOI metadata");
            console.log(chalk.dim(`  ${errorDetail(error)}`));
          }
        } else if (doiFetchFailed) {
          console.log(
            chalk.yellow(
              "  DOI refresh skipped: could not verify DOI exists. Run 'nemar admin doi update --refresh' manually.",
            ),
          );
        }
      } catch (error) {
        if (error instanceof ApiError) {
          submitSpinner.fail(error.message);
        } else {
          submitSpinner.fail("Failed to save enrichment");
          console.log(chalk.dim(`  ${errorDetail(error)}`));
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
        console.log(chalk.dim("\n  No publication requests found.\n"));
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
          `  ${chalk.bold(req.dataset_id)}  ${statusColor(req.status)}  by ${req.requested_by_username}  ${chalk.dim(req.requested_at)}`,
        );
        if (req.current_step && req.status === "approving") {
          console.log(
            `    ${chalk.yellow(">")} ${req.current_step.replace(/_/g, " ")}${req.last_error ? chalk.red(` (${req.last_error})`) : ""}`,
          );
        }
        // Non-blocking pre-screen advisory (#756): a concern for the admin to
        // weigh before approving, NOT a block.
        if (req.prescreen_status === "concern") {
          let reasons: string[] = [];
          try {
            const parsed = JSON.parse(req.prescreen_reasons || "[]");
            if (Array.isArray(parsed)) reasons = parsed.filter((x) => typeof x === "string");
          } catch {
            // malformed -> show the flag without inline reasons
          }
          const summary = reasons.length ? reasons.join("; ") : "see pre-screen";
          console.log(`    ${chalk.yellow("! pre-screen advisory:")} ${chalk.dim(summary)}`);
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
      console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
      return;
    }

    const spinner = ora(`Denying publication for ${datasetId}...`).start();

    try {
      await denyPublication(datasetId, reason);
      spinner.succeed(`Publication denied for ${datasetId}`);
      console.log(chalk.dim("  User has been notified."));
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
  .option("--skip-ci-check", "Skip BIDS validation CI check (admin override)")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .addHelpText(
    "after",
    `
Description:
  Approve a publication request and run the automated 16-step orchestrator
  to make the dataset publicly accessible with a permanent DOI.

  WARNING: This action is PERMANENT. Published datasets cannot be unpublished.
  Once a DOI is assigned, it is permanent and cannot be deleted.

Orchestrator Steps (execution order; shared/publication-steps.ts):
   1. CI Check          - Verify BIDS validation passes, deploy workflows if missing
   2. Enrichment Check  - Verify metadata pipeline has run (warn-only, non-blocking)
   3. S3 Public Read    - Grant public read access to S3 data
   4. Make Public       - Change GitHub repository visibility to public
   5. Tag Protection    - Enable tag protection rules
   6. Create DOI        - Create concept DOI via EZID (or Zenodo if configured)
   7. Update Metadata   - Update dataset metadata from BIDS description
   8. Update README     - Add DOI badge and citation info to README
   9. Create Tag        - Create version tag (e.g., v1.0.0)
  10. Create Release    - Create GitHub release from tag
  11. Upload to Zenodo  - Legacy Zenodo upload (disabled; kept for step history)
  12. Publish DOI       - Make DOI public and findable (permanent, irreversible)
  13. Version DOI       - Mint the version DOI for this release
  14. S3 Lock           - Enable S3 Object Lock (prevents data deletion)
  15. Sync NEMAR        - Legacy nemar.org sync (no-op, retired)
  16. Notify User       - Send publication confirmation email

  (Archive zip generation is not an orchestrator step; the version-DOI
  workflow dispatches it separately.)

Resume Capability:
  If a step fails, the orchestrator saves progress. Use --resume to retry
  from the failed step without re-running successful steps.

  The orchestrator is idempotent - safe to run multiple times. Completed
  steps are automatically skipped.

Examples:
  $ nemar admin publish approve nm000104                    # Run full orchestrator
  $ nemar admin publish approve nm000104 --resume           # Resume from failed step
  $ nemar admin publish approve nm000104 --skip-ci-check    # Override BIDS validation
  $ nemar admin publish approve nm000104 --yes              # Skip confirmation

After Approval:
  - User receives email with DOI and public dataset link
  - Dataset is publicly visible on GitHub
  - Tags are protected (prevents version manipulation)
  - Data is protected by S3 Object Lock`,
  )
  .action(
    async (
      datasetId,
      options: ConfirmOptions & { resume?: boolean; sandbox?: boolean; skipCiCheck?: boolean },
    ) => {
      if (!requireAuth()) return;

      const action = options.resume
        ? `Resume publication of ${datasetId}`
        : `Approve and publish ${datasetId}`;
      console.log(chalk.cyan(`\n${action}\n`));
      console.log("This will run the following 16-step orchestrator:");
      console.log("   1. Check CI              9. Create version tag");
      console.log("   2. Enrichment check     10. Create GitHub release");
      console.log("   3. S3 public read       11. Upload to Zenodo (no-op)");
      console.log("   4. Make repo public     12. Publish DOI (irreversible)");
      console.log("   5. Tag protection       13. Mint version DOI");
      console.log(
        options.sandbox
          ? "   6. Create DOI (SANDBOX) 14. S3 Object Lock"
          : "   6. Create DOI           14. S3 Object Lock",
      );
      console.log("   7. Update metadata      15. Sync NEMAR (no-op)");
      console.log("   8. Update README        16. Notify user");
      console.log();

      // Sandbox warning
      if (options.sandbox) {
        console.log(chalk.yellow("━".repeat(60)));
        console.log(chalk.yellow.bold("                 SANDBOX MODE ENABLED"));
        console.log(chalk.yellow("━".repeat(60)));
        console.log(chalk.yellow("  • DOI will be created in sandbox mode (EZID test shoulder)"));
        console.log(chalk.yellow("  • DOI will NOT be indexed by DataCite"));
        console.log(chalk.yellow("  • DOI will NOT resolve in production"));
        console.log(chalk.yellow("  • Use this for testing workflows only"));
        console.log(chalk.yellow("━".repeat(60)));
        console.log();
      }

      const confirmResult = await confirm(`${action}?`, options);
      if (confirmResult !== "confirmed") {
        console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
        return;
      }

      const initialSpinnerText = "Running publication workflow (this may take a few minutes)...";
      const spinner = ora(initialSpinnerText).start();

      // Most recent step label rendered into the spinner; kept on the
      // outer scope so onRetry can restore the same line after the
      // retry notice instead of falling back to the generic text.
      let currentSpinnerText = initialSpinnerText;

      /**
       * Render the spinner line for a progress event. Shows the step
       * position and, for s3_lock, a running locked/total ratio so the
       * admin can see thousands-of-objects datasets making progress
       * instead of staring at a static spinner for minutes. See #284.
       */
      function renderProgress(info: PublishProgressInfo): string {
        const stepLabel = info.step.replace(/_/g, " ");
        const head = `Step ${info.stepIndex}/${info.stepTotal}: ${stepLabel}`;
        if (
          info.step === "s3_lock" &&
          info.s3LockLocked !== undefined &&
          info.s3LockTotal !== undefined &&
          info.s3LockTotal > 0
        ) {
          const pct = ((info.s3LockLocked / info.s3LockTotal) * 100).toFixed(1);
          const resumeSuffix = info.s3LockResumed ? " (resumed)" : "";
          return `${head} | Locking S3 objects: ${info.s3LockLocked}/${info.s3LockTotal} (${pct}%)${resumeSuffix}`;
        }
        if (info.step === "s3_lock" && info.s3LockLocked !== undefined) {
          // Total not yet known (rare; first response before server has
          // counted). Show running count without the denominator so the
          // line still advances.
          const resumeSuffix = info.s3LockResumed ? " (resumed)" : "";
          return `${head} | Locking S3 objects: ${info.s3LockLocked}${resumeSuffix}`;
        }
        return head;
      }

      try {
        const result = await approvePublication(
          datasetId,
          !!options.resume,
          !!options.sandbox,
          !!options.skipCiCheck,
          (info) => {
            // Surface transient failures the CLI is about to retry. We pause
            // the spinner so the message isn't overwritten, then resume it.
            spinner.stop();
            const stepLabel = info.step ? info.step.replace(/_/g, " ") : "step";
            console.log(chalk.yellow(`  [!] ${stepLabel} failed: ${info.error}`));
            console.log(
              chalk.dim(
                `  Retrying in ${Math.round(info.delayMs / 1000)}s (attempt ${info.attempt + 1}/${info.maxAttempts})...`,
              ),
            );
            spinner.start(currentSpinnerText);
          },
          (info) => {
            currentSpinnerText = renderProgress(info);
            spinner.text = currentSpinnerText;
          },
        );
        spinner.succeed(result.message);

        // Display step-by-step results if available
        if (result.step_results && result.step_results.length > 0) {
          console.log();
          const allSteps = result.step_results;
          const totalSteps = allSteps.length;
          allSteps.forEach((sr: StepResult, idx: number) => {
            const stepNum = `[${String(idx + 1).padStart(2, " ")}/${totalSteps}]`;
            const stepName = sr.step.replace(/_/g, " ");
            if (sr.status === "completed") {
              const durationSec = (sr.duration_ms / 1000).toFixed(1);
              const retryNote = sr.attempts > 1 ? ` (attempt ${sr.attempts})` : "";
              console.log(
                `  ${chalk.green("[x]")} ${chalk.dim(stepNum)} ${stepName} ${chalk.dim(`(${durationSec}s${retryNote})`)}`,
              );
            } else if (sr.status === "failed") {
              console.log(
                `  ${chalk.red("[!]")} ${chalk.dim(stepNum)} ${stepName}${sr.error ? `: ${chalk.red(sr.error)}` : ""}`,
              );
            } else {
              console.log(
                `  ${chalk.dim("[-]")} ${chalk.dim(stepNum)} ${chalk.dim(stepName)} ${chalk.dim("(skipped)")}`,
              );
            }
          });
          console.log();
        } else if (result.steps_completed) {
          // Fallback for responses without step_results
          console.log();
          for (const step of result.steps_completed) {
            console.log(`  ${chalk.green("[x]")} ${step.replace(/_/g, " ")}`);
          }
          console.log();
        }

        // Surface non-fatal orchestrator warnings (e.g. notify_user email
        // failure) so operators know to follow up without re-running.
        if (result.warning) {
          console.log(chalk.yellow(`  Warning: ${result.warning}`));
        }
      } catch (error) {
        handleCommandError(error, spinner, "Failed to approve publication", {
          422: "Fix the CI issues and retry with --resume",
        });

        // After all retries fail, surface the per-attempt step timeline the
        // retry loop attached to the error so the admin sees which step
        // failed when, instead of just the final 500 message.
        const stepResults = (error as { stepResults?: StepResult[] }).stepResults;
        if (stepResults && stepResults.length > 0) {
          console.log();
          console.log(chalk.dim("Step timeline (last attempt):"));
          const totalSteps = stepResults.length;
          stepResults.forEach((sr, idx) => {
            const stepNum = `[${String(idx + 1).padStart(2, " ")}/${totalSteps}]`;
            const stepName = sr.step.replace(/_/g, " ");
            const durationSec = (sr.duration_ms / 1000).toFixed(1);
            const retryNote = sr.attempts > 1 ? ` (attempt ${sr.attempts})` : "";
            if (sr.status === "completed") {
              console.log(
                `  ${chalk.green("[x]")} ${chalk.dim(stepNum)} ${stepName} ${chalk.dim(`(${durationSec}s${retryNote})`)}`,
              );
            } else if (sr.status === "failed") {
              console.log(
                `  ${chalk.red("[!]")} ${chalk.dim(stepNum)} ${stepName}${sr.error ? `: ${chalk.red(sr.error)}` : ""}`,
              );
            } else {
              console.log(
                `  ${chalk.dim("[-]")} ${chalk.dim(stepNum)} ${chalk.dim(stepName)} ${chalk.dim("(skipped)")}`,
              );
            }
          });
          console.log();
        }
      }
    },
  );

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
          console.log(chalk.dim(`  - ${error}`));
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
        // Echo a plain stdout error after the spinner line (which goes to stderr)
        // so callers grepping stdout can detect the failure reliably. Treat
        // 400 (invalid id format) and 404 alike as "dataset not found" from
        // the user's perspective: both mean we cannot load this dataset.
        if (error instanceof ApiError) {
          spinner.fail(error.message);
          if (error.statusCode === 404 || error.statusCode === 400) {
            console.log(chalk.red(`Error: Dataset ${datasetId} not found`));
            console.log(chalk.dim(`  ${error.message}`));
          } else {
            console.log(chalk.red(`Error: ${error.message}`));
          }
        } else {
          spinner.fail("Failed to fetch dataset");
          const msg = error instanceof Error ? error.message : String(error);
          console.log(chalk.red(`Error: Could not load dataset ${datasetId}: ${msg}`));
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
        console.log(chalk.dim("  Dataset may not have any tagged releases yet"));
        return;
      }

      // If --list flag, just show versions and exit
      if (options.list) {
        console.log(`\n${chalk.cyan("Available Versions:")}\n`);
        for (const v of versions) {
          console.log(`  ${chalk.green(v.version)}  ${chalk.dim(v.date)}  ${chalk.dim(v.commit)}`);
        }
        return;
      }

      // If no version specified, prompt for selection
      let selectedVersion = targetVersion;
      if (!selectedVersion) {
        console.log(`\n${chalk.cyan("Available Versions:")}\n`);
        for (const v of versions) {
          console.log(`  ${chalk.green(v.version)}  ${chalk.dim(v.date)}`);
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
        console.log(chalk.dim("  Use --list to see available versions"));
        return;
      }

      // Confirm revert action
      console.log();
      console.log(chalk.yellow("Revert Summary:"));
      console.log(`  Dataset:        ${chalk.cyan(datasetId)}`);
      console.log(`  Target version: ${chalk.green(selectedVersion)}`);
      console.log(`  Commit:         ${chalk.dim(commitHash)}`);
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
        console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
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
            chalk.dim("The PR will go through validation checks before it can be merged."),
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

          console.log(chalk.dim("  You may need to create the PR manually on GitHub"));
          console.log(chalk.dim(`  Branch: ${branchName}`));
        }
      } else {
        // Force mode: merge directly (emergency only)
        console.log(chalk.yellow("Force mode: Merging directly to main..."));
        // Note: We'd need to checkout main, merge, and push. For safety, just inform user.
        console.log(chalk.red("Direct merge not implemented for safety."));
        console.log(chalk.dim("To force-merge, manually merge the branch on GitHub:"));
        console.log(chalk.dim(`  git checkout main && git merge ${branchName} && git push`));
      }

      // Cleanup info
      if (needsClone) {
        console.log();
        console.log(chalk.dim(`Working directory: ${workDir}`));
        console.log(chalk.dim("You can delete this directory after the PR is merged."));
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

  ${chalk.yellow("WARNING: This operation is PERMANENT and IRREVERSIBLE")}

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
    console.log(chalk.yellow("\nWARNING: Publishing is PERMANENT and IRREVERSIBLE\n"));
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
      console.log(chalk.dim("Cancelled."));
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
          console.error(chalk.dim(JSON.stringify(error.details, null, 2)));
        }
        if (error.statusCode === 403) {
          console.log(chalk.dim("  You must be the dataset owner or an admin to publish"));
        } else if (error.statusCode === 400 && error.message.includes("sandbox")) {
          console.log(chalk.dim("  Sandbox datasets cannot be published"));
        }
      } else {
        console.error(chalk.red(`\n${error instanceof Error ? error.message : String(error)}`));
      }
      process.exit(1);
    }
  });

// ============================================================================
// Delete Dataset (Admin/Owner Only)
// ============================================================================

adminCommand
  .command("delete-dataset")
  .description("Delete a dataset and all associated resources (GitHub, S3, D1)")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000108)")
  .option("--force", "Force deletion of published datasets with DOIs (owner only)")
  .action(async (datasetId: string, options: { force?: boolean }) => {
    if (!requireAuth()) return;

    const spinner = ora("Looking up dataset...").start();

    try {
      const dataset = await getDataset(datasetId);
      spinner.stop();

      console.log(chalk.bold(`\nDataset: ${dataset.dataset_id}`));
      console.log(`  Name: ${dataset.name || "(unnamed)"}`);
      console.log(`  Visibility: ${dataset.visibility}`);
      if (dataset.concept_doi) {
        console.log(`  DOI: ${dataset.concept_doi}`);
        console.log(
          chalk.yellow("\n  WARNING: This dataset has a DOI. Only the NEMAR owner can delete it."),
        );
        if (!options.force) {
          console.log(chalk.dim("  Use --force to confirm deletion of published datasets."));
          process.exit(1);
        }
      }

      const { proceed } = await inquirer.prompt([
        {
          type: "confirm",
          name: "proceed",
          message: chalk.red(
            `Delete dataset ${datasetId}? This will remove the GitHub repo, S3 data, and all database records. This cannot be undone.`,
          ),
          default: false,
        },
      ]);

      if (!proceed) {
        console.log(chalk.dim("Cancelled."));
        return;
      }

      spinner.start("Deleting dataset...");
      const result = await deleteDataset(datasetId, options.force ?? false);
      if (!result.deleted) {
        spinner.fail("Dataset deletion incomplete");
      } else if (result.warnings.length > 0) {
        spinner.warn("Dataset deleted with warnings");
      } else {
        spinner.succeed("Dataset deleted");
      }

      // Summary
      console.log(chalk.bold("\nDeletion summary:"));
      console.log(
        `  GitHub repo: ${result.steps.github.success ? chalk.green("deleted") : chalk.red("failed")}`,
      );
      if (result.steps.s3.skipped) {
        console.log(`  S3 objects: ${chalk.yellow("skipped (published dataset)")}`);
      } else {
        let s3Summary = chalk.green(`${result.steps.s3.deleted} deleted`);
        if (result.steps.s3.failed.length > 0) {
          s3Summary += chalk.red(`, ${result.steps.s3.failed.length} failed`);
        }
        console.log(`  S3 objects: ${s3Summary}`);
      }
      console.log(
        `  Database: ${result.steps.d1.success ? chalk.green("cleaned up") : chalk.red("failed")}`,
      );
      if (result.steps.d1.versionsDeleted > 0) {
        console.log(chalk.dim(`    ${result.steps.d1.versionsDeleted} version records removed`));
      }
      if (result.steps.d1.pubRequestsDeleted > 0) {
        console.log(
          chalk.dim(`    ${result.steps.d1.pubRequestsDeleted} publication requests removed`),
        );
      }

      if (result.warnings.length > 0) {
        console.log(chalk.yellow("\nWarnings:"));
        for (const w of result.warnings) {
          console.log(chalk.yellow(`  - ${w}`));
        }
      }
    } catch (error) {
      handleCommandError(error, spinner, "Failed to delete dataset", {
        403: "Published datasets can only be deleted by the NEMAR owner",
        404: "Dataset not found",
        409: "Cannot delete dataset with active publication requests",
      });
      process.exit(1);
    }
  });

// ============================================================================
// Bulk Delete
// ============================================================================

adminCommand
  .command("bulk-delete")
  .description("Delete multiple phantom/orphaned datasets at once (owner only)")
  .argument("<dataset-ids>", "Comma-separated dataset IDs (e.g., nm000153,nm000154,nm000155)")
  .option("--yes", "Skip confirmation prompt")
  .action(async (datasetIdsArg: string, options: { yes?: boolean }) => {
    if (!requireAuth()) return;

    const datasetIds = datasetIdsArg
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    if (datasetIds.length === 0) {
      console.log(chalk.red("No dataset IDs provided."));
      process.exit(1);
    }

    console.log(chalk.bold(`\nBulk delete: ${datasetIds.length} datasets`));
    console.log(
      chalk.dim(
        `  IDs: ${datasetIds.slice(0, 10).join(", ")}${datasetIds.length > 10 ? ` ... +${datasetIds.length - 10} more` : ""}`,
      ),
    );
    console.log(chalk.yellow("\n  Only private datasets without DOIs will be deleted."));

    if (!options.yes) {
      const { proceed } = await inquirer.prompt([
        {
          type: "confirm",
          name: "proceed",
          message: chalk.red(`Delete ${datasetIds.length} datasets? This cannot be undone.`),
          default: false,
        },
      ]);
      if (!proceed) {
        console.log(chalk.dim("Cancelled."));
        return;
      }
    }

    const spinner = ora(`Deleting ${datasetIds.length} datasets...`).start();

    try {
      const result = await bulkDeleteDatasets(datasetIds);
      spinner.succeed(`Bulk delete complete: ${result.deleted} deleted, ${result.failed} failed`);

      if (result.failed > 0) {
        console.log(chalk.yellow("\nFailed deletions:"));
        for (const r of result.results.filter((r) => !r.deleted)) {
          console.log(chalk.yellow(`  ${r.dataset_id}: ${r.error || "unknown error"}`));
        }
      }
    } catch (error) {
      handleCommandError(error, spinner, "Bulk delete failed", {
        403: "Only the NEMAR owner can bulk-delete datasets",
      });
      process.exit(1);
    }
  });

// ============================================================================
// Dataset withdrawal / restore (epic #967 phase 4, #971)
// ============================================================================

/** Default location of the checked-in withdrawal target list, resolved
 *  relative to this source file rather than cwd (mirrors
 *  defaultExemplarFleetPath below). */
function defaultWithdrawnDatasetsPath(): string {
  return join(import.meta.dir, "..", "..", "scripts", "withdrawn-datasets.json");
}

function printTransitionResult(
  tag: string,
  datasetId: string,
  result: DatasetTransitionResponse | undefined,
  error: string | undefined,
): void {
  if (error) {
    console.log(`  ${chalk.red("error".padEnd(8))} ${datasetId}: ${error}`);
    return;
  }
  if (!result) return;
  if ("skipped" in result) {
    console.log(`  ${chalk.yellow("skipped".padEnd(8))} ${datasetId}: ${result.skipped}`);
    return;
  }

  const resumeTag = result.resumed ? chalk.yellow(" (resumed)") : "";
  console.log(chalk.bold(`  ${tag}${datasetId}${resumeTag}`));

  const vColor = result.visibility.status === "failed" ? chalk.red : chalk.green;
  console.log(`    visibility: ${vColor(result.visibility.status)}`);
  if (result.visibility.status === "failed") {
    console.log(chalk.red(`      stage=${result.visibility.stage}: ${result.visibility.error}`));
    if ("githubReverted" in result.visibility) {
      const s3Bit =
        "s3Reverted" in result.visibility ? ` s3Reverted=${result.visibility.s3Reverted}` : "";
      const revertBit = result.visibility.revertError
        ? ` revertError=${result.visibility.revertError}`
        : "";
      console.log(
        chalk.dim(`      githubReverted=${result.visibility.githubReverted}${s3Bit}${revertBit}`),
      );
    }
  }

  for (const d of result.dois) {
    const color =
      d.status === "failed" ? chalk.red : d.status === "planned" ? chalk.yellow : chalk.green;
    const label = d.kind === "version" ? `version ${d.version}` : "concept";
    console.log(`    ${color(d.status.padEnd(8))} ${label} -> ${d.action}  ${chalk.dim(d.doi)}`);
    if (d.error) console.log(chalk.red(`      ${d.error}`));
  }

  if (result.warning) {
    console.log(chalk.yellow(`    warning: ${result.warning}`));
  }
}

adminCommand
  .command("withdraw")
  .description(
    "Withdraw a broken published dataset: make it private and tombstone its EZID DOIs (concept + every version). Dry-run by default.",
  )
  .argument("[ids...]", "Dataset id(s) to withdraw (omit when using --all)")
  .option("--all", "Target every entry in the checked-in withdrawn-datasets list")
  .option("--reason <reason>", "Withdrawal reason (default: the list entry's own reason)")
  .option("--execute", "Actually apply the withdrawal (default is a dry run)")
  .option("--force", "Allow a dataset id that is not on the checked-in withdrawn-datasets list")
  .option(
    "--withdrawn-file <path>",
    "Path to the withdrawn-datasets JSON (default: scripts/withdrawn-datasets.json)",
  )
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .option("--json", "Output raw JSON")
  .action(
    async (
      ids: string[],
      options: {
        all?: boolean;
        reason?: string;
        execute?: boolean;
        force?: boolean;
        withdrawnFile?: string;
        json?: boolean;
      } & ConfirmOptions,
    ) => {
      if (!requireAuth()) return;

      if (ids.length === 0 && !options.all) {
        console.log(chalk.red("Error: provide dataset id(s) or use --all"));
        process.exit(1);
      }
      if (ids.length > 0 && options.all) {
        console.log(chalk.red("Error: provide dataset id(s) OR --all, not both"));
        process.exit(1);
      }

      const listPath = options.withdrawnFile || defaultWithdrawnDatasetsPath();
      let entries: WithdrawnDatasetEntry[];
      try {
        entries = loadWithdrawnDatasets(listPath);
      } catch (err) {
        console.error(chalk.red(`Failed to load withdrawn-datasets file: ${errorDetail(err)}`));
        process.exit(1);
      }

      const resolved = options.all
        ? {
            targets: entries.map((e) => ({
              datasetId: e.dataset_id,
              reason: options.reason || e.reason,
            })),
          }
        : resolveWithdrawTargets(ids, entries, { reason: options.reason, force: options.force });

      if ("error" in resolved) {
        console.error(chalk.red(resolved.error));
        process.exit(1);
      }
      const targets = resolved.targets;

      const dryRun = !options.execute;
      const tag = dryRun ? "[dry-run] " : "";

      if (!dryRun) {
        console.log(
          chalk.red(
            `\nWARNING: this makes ${targets.length} dataset(s) private and tombstones their EZID DOIs (concept + every version).`,
          ),
        );
        const confirmResult = await confirm(
          `Execute withdrawal for ${targets.length} dataset(s)?`,
          options,
        );
        if (confirmResult !== "confirmed") {
          console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
          return;
        }
      }

      const results: Array<{
        dataset_id: string;
        result?: DatasetTransitionResponse;
        error?: string;
      }> = [];
      for (const t of targets) {
        try {
          const result = await withdrawDataset(t.datasetId, { reason: t.reason, dryRun });
          results.push({ dataset_id: t.datasetId, result });
        } catch (error) {
          results.push({ dataset_id: t.datasetId, error: errorDetail(error) });
        }
      }

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      console.log();
      for (const r of results) {
        printTransitionResult(tag, r.dataset_id, r.result, r.error);
      }
    },
  );

adminCommand
  .command("restore")
  .description(
    "Reverse a withdrawal: make a dataset public again and restore its EZID DOIs (concept + every version). Dry-run by default.",
  )
  .argument("[ids...]", "Dataset id(s) to restore (omit when using --all)")
  .option("--all", "Target every entry in the checked-in withdrawn-datasets list")
  .option("--execute", "Actually apply the restore (default is a dry run)")
  .option(
    "--withdrawn-file <path>",
    "Path to the withdrawn-datasets JSON (default: scripts/withdrawn-datasets.json)",
  )
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .option("--json", "Output raw JSON")
  .action(
    async (
      ids: string[],
      options: {
        all?: boolean;
        execute?: boolean;
        withdrawnFile?: string;
        json?: boolean;
      } & ConfirmOptions,
    ) => {
      if (!requireAuth()) return;

      if (ids.length === 0 && !options.all) {
        console.log(chalk.red("Error: provide dataset id(s) or use --all"));
        process.exit(1);
      }
      if (ids.length > 0 && options.all) {
        console.log(chalk.red("Error: provide dataset id(s) OR --all, not both"));
        process.exit(1);
      }

      let targets: string[];
      if (options.all) {
        const listPath = options.withdrawnFile || defaultWithdrawnDatasetsPath();
        try {
          targets = loadWithdrawnDatasets(listPath).map((e) => e.dataset_id);
        } catch (err) {
          console.error(chalk.red(`Failed to load withdrawn-datasets file: ${errorDetail(err)}`));
          process.exit(1);
        }
      } else {
        targets = ids;
      }

      const dryRun = !options.execute;
      const tag = dryRun ? "[dry-run] " : "";

      if (!dryRun) {
        console.log(
          chalk.yellow(
            `\nThis makes ${targets.length} dataset(s) public again and restores their EZID DOIs.`,
          ),
        );
        const confirmResult = await confirm(
          `Execute restore for ${targets.length} dataset(s)?`,
          options,
        );
        if (confirmResult !== "confirmed") {
          console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
          return;
        }
      }

      const results: Array<{
        dataset_id: string;
        result?: DatasetTransitionResponse;
        error?: string;
      }> = [];
      for (const datasetId of targets) {
        try {
          const result = await restoreDataset(datasetId, { dryRun });
          results.push({ dataset_id: datasetId, result });
        } catch (error) {
          results.push({ dataset_id: datasetId, error: errorDetail(error) });
        }
      }

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      console.log();
      for (const r of results) {
        printTransitionResult(tag, r.dataset_id, r.result, r.error);
      }
    },
  );

// ============================================================================
// Import OpenNeuro
// ============================================================================

/**
 * The onboard-openneuro.yml copy phase fans each dataset out into 8 shard
 * jobs, and GitHub caps a workflow's job matrix at 256 entries. Above 32
 * datasets in one dispatch, the matrix silently instantiates 0 copy jobs
 * instead of erroring, so a batch must be split before it reaches that cap.
 * 256 / 8 = 32; this stays a bit under that for headroom.
 */
export const MAX_DATASETS_PER_DISPATCH = 30;

/**
 * Split `ids` into chunks of at most `size`, preserving order. Pure so the
 * batching logic is unit-testable without a live `gh` call.
 */
export function chunkDatasetIds(
  ids: string[],
  size: number = MAX_DATASETS_PER_DISPATCH,
): string[][] {
  if (ids.length === 0) return [];
  if (ids.length <= size) return [ids];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

/**
 * Dispatch the onboard-openneuro.yml workflow (nemarDatasets/.github) for a
 * batch of OpenNeuro `ds######` ids -- the prepare/copy/finalize matrix
 * hardened in epic #967 Phases 1-3. Shared by `import-openneuro`'s default
 * (non---local) branch, a brand-new import, and `recover --execute` (Phase
 * 5, #972), a re-copy of an existing import whose S3 content was found
 * empty; both dispatch the SAME workflow, one gh run per batch.
 *
 * Chunks `dsIds` to stay under the 256-job matrix cap (see
 * MAX_DATASETS_PER_DISPATCH), issuing one `gh workflow run` per chunk. Fails
 * fast on the first chunk that doesn't dispatch, naming which chunk so the
 * operator can resume from there instead of re-running the whole batch.
 */
async function dispatchOpenNeuroImportWorkflow(
  dsIds: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { runCommand } = await import("../lib/git-annex/run-command.js");
  const chunks = chunkDatasetIds(dsIds);
  if (chunks.length > 1) {
    console.log(
      chalk.dim(
        `  Splitting ${dsIds.length} datasets into ${chunks.length} dispatches (matrix job cap).`,
      ),
    );
  }
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const result = await runCommand([
      "gh",
      "workflow",
      "run",
      "onboard-openneuro.yml",
      "--repo",
      "nemarDatasets/.github",
      "--field",
      `openneuro_ids=${chunk.join(",")}`,
    ]);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: `chunk ${i + 1}/${chunks.length} (${chunk.join(",")}): ${result.stderr.trim()}`,
      };
    }
  }
  return { ok: true };
}

adminCommand
  .command("import-openneuro")
  .description("Import an OpenNeuro dataset into NEMAR")
  .argument("<openneuro-ids>", "OpenNeuro dataset ID(s), comma-separated (e.g., ds007262,ds007263)")
  .option("--local", "Run import locally instead of dispatching GitHub Actions workflow")
  .option("--dir <path>", "Working directory for local clone (requires --local)")
  .option("--skip-data", "Skip S3 data copy, metadata only (requires --local)")
  .option(
    "--trust-upstream",
    "If BIDS validation does not register within the bounded poll, fall back to skip_ci_check=true at approval. OpenNeuro data is pre-validated upstream so this is the recommended setting for OpenNeuro imports (#431).",
  )
  .option(
    "--phase <phase>",
    "Run a single import phase in-process (prepare|copy|finalize) for the sharded CI workflow. State passes between phases via S3 staging. Implies in-process execution.",
  )
  .option(
    "--shard <i/N>",
    "Copy-phase only: process shard i of N (0-indexed), e.g. 0/8. Required with --phase copy.",
  )
  .action(
    async (
      openneuroIds: string,
      options: {
        local?: boolean;
        dir?: string;
        skipData?: boolean;
        trustUpstream?: boolean;
        phase?: string;
        shard?: string;
      },
    ) => {
      if (!requireAuth()) return;

      const ids = openneuroIds
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);

      // Validate all IDs
      for (const id of ids) {
        if (!/^ds\d{6}$/.test(id)) {
          console.error(
            chalk.red(`Invalid OpenNeuro ID "${id}". Expected format: ds###### (e.g., ds007262)`),
          );
          process.exit(1);
        }
      }

      if ((options.dir || options.skipData) && !options.local && !options.phase) {
        console.error(chalk.red("--dir and --skip-data require --local or --phase"));
        process.exit(1);
      }

      // Single-phase execution for the sharded CI workflow (prepare/copy/finalize).
      if (options.phase) {
        const validPhases = ["prepare", "copy", "finalize"];
        if (!validPhases.includes(options.phase)) {
          console.error(
            chalk.red(`Invalid --phase "${options.phase}". Expected prepare|copy|finalize.`),
          );
          process.exit(1);
        }
        if (ids.length > 1) {
          console.error(chalk.red("--phase only supports a single dataset ID"));
          process.exit(1);
        }
        if (options.shard && options.phase !== "copy") {
          console.error(chalk.red("--shard is only valid with --phase copy"));
          process.exit(1);
        }
        if (options.phase === "copy" && !options.shard) {
          console.error(chalk.red("--phase copy requires --shard i/N (e.g. --shard 0/8)"));
          process.exit(1);
        }

        const { prepareImport, copyShard, finalizeImport } = await import(
          "../lib/import-openneuro.js"
        );
        const { parseShardArg } = await import("../lib/s3-server-copy.js");
        const opts = {
          workDir: options.dir,
          skipData: options.skipData,
          trustUpstream: options.trustUpstream,
          persistStaging: true,
        };
        try {
          if (options.phase === "prepare") {
            await prepareImport(ids[0], opts);
          } else if (options.phase === "copy") {
            // biome-ignore lint/style/noNonNullAssertion: guarded above (copy requires --shard)
            await copyShard(ids[0], parseShardArg(options.shard!), opts);
          } else {
            await finalizeImport(ids[0], opts);
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(chalk.red(`\n[${options.phase}] failed: ${msg}`));
          process.exit(1);
        }
        return;
      }

      if (options.local) {
        if (ids.length > 1) {
          console.error(chalk.red("--local only supports a single dataset ID"));
          process.exit(1);
        }
        const { importOpenNeuro } = await import("../lib/import-openneuro.js");
        try {
          await importOpenNeuro(ids[0], {
            workDir: options.dir,
            skipData: options.skipData,
            trustUpstream: options.trustUpstream,
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(chalk.red(`\nImport failed: ${msg}`));
          process.exit(1);
        }
        return;
      }

      // Default: dispatch GitHub Actions workflow on nemarDatasets/.github
      const idsStr = ids.join(",");
      console.log(chalk.cyan(`\nDispatching OpenNeuro import workflow for: ${idsStr}\n`));

      const dispatch = await dispatchOpenNeuroImportWorkflow(ids);
      if (!dispatch.ok) {
        console.error(chalk.red(`Failed to dispatch workflow: ${dispatch.error}`));
        console.error(
          chalk.dim("Make sure gh CLI is authenticated with access to nemarDatasets org"),
        );
        process.exit(1);
      }
      console.log(chalk.green("Workflow dispatched successfully"));
      console.log(
        chalk.dim(
          "  Monitor at: https://github.com/nemarDatasets/.github/actions/workflows/onboard-openneuro.yml",
        ),
      );
      console.log(chalk.dim("  Or run: gh run list --repo nemarDatasets/.github --limit 5"));
    },
  );

// ============================================================================
// E2E Test
// ============================================================================

adminCommand
  .command("e2e-test")
  .description("Run end-to-end test against nm099999 (admin only)")
  .option("--verbose", "Show detailed output for each step")
  .option("--skip-reset", "Use existing nm099999 state (skip reset)")
  .option("--skip-cleanup", "Keep temp directories after test")
  .addHelpText(
    "after",
    `
Description:
  Runs a full upload/download/update cycle against the test dataset nm099999.
  Tests the complete git-annex S3 remote workflow with real infrastructure.

Steps:
   1. Reset nm099999          6. Push to GitHub
   2. Prepare upload           7. Clone fresh
   3. Init git + annex         8. Download + verify
   4. Configure remotes        9. Update cycle
   5. Upload to S3            10. Cleanup

Requirements:
  - Admin privileges (API role check)
  - git-annex installed
  - GitHub CLI authenticated (gh auth login)
  - Active nemar auth session

Examples:
  $ nemar admin e2e-test                    # Full test
  $ nemar admin e2e-test --verbose          # With detailed output
  $ nemar admin e2e-test --skip-cleanup     # Keep temp dirs for inspection
  $ nemar admin e2e-test --skip-reset       # Reuse existing nm099999 state`,
  )
  .action(async (options: { verbose?: boolean; skipReset?: boolean; skipCleanup?: boolean }) => {
    if (!requireAuth()) return;

    console.log(chalk.cyan("\nNEMAR E2E Test (nm099999)\n"));

    // Lazy import to avoid loading e2e-test module on every CLI invocation
    const { runE2ETest } = await import("../lib/e2e-test.js");

    const result = await runE2ETest({
      verbose: options.verbose,
      skipReset: options.skipReset,
      skipCleanup: options.skipCleanup,
    });

    // Print results table
    console.log();
    for (const step of result.steps) {
      const icon = step.passed ? chalk.green("[x]") : chalk.red("[ ]");
      const time = chalk.dim(`(${step.duration_ms}ms)`);
      console.log(`  ${icon} ${step.name} ${time}`);
      if (step.error) {
        console.log(chalk.red(`      ${step.error}`));
      }
    }

    console.log();
    const totalSec = (result.total_duration_ms / 1000).toFixed(1);
    if (result.passed) {
      console.log(chalk.green(`All ${result.steps.length} steps passed (${totalSec}s)`));
    } else {
      const failed = result.steps.filter((s) => !s.passed).length;
      console.log(chalk.red(`${failed}/${result.steps.length} steps failed (${totalSec}s)`));
    }

    if (result.upload_dir) {
      console.log(chalk.dim(`\nUpload dir: ${result.upload_dir}`));
      console.log(chalk.dim(`Clone dir:  ${result.clone_dir}`));
    }

    process.exit(result.passed ? 0 : 1);
  });

// ============================================================================
// Import jobs (issue #754)
// ============================================================================

const importCommand = new Command("import").description("View and recover OpenNeuro import jobs");

importCommand
  .command("status")
  .description("Show OpenNeuro import job state (failed/quarantined first)")
  .argument("[dataset-id]", "Filter to one dataset id (e.g., on007523)")
  .option("-s, --status <status>", "Filter by status (failed, quarantined, incomplete, ...)")
  .option("-b, --blocklisted", "Only show retry-engine blocklisted rows")
  .action(
    async (datasetId: string | undefined, options: { status?: string; blocklisted?: boolean }) => {
      if (!requireAuth()) return;

      const spinner = ora("Fetching import status...").start();
      try {
        const result = await getImportStatus(options.status, options.blocklisted);
        spinner.stop();

        let rows = result.imports;
        if (datasetId) rows = rows.filter((r) => r.dataset_id === datasetId);

        const counts = result.by_status;
        console.log(chalk.bold(`\nImport Jobs (${result.total})\n`));
        console.log(
          `  ${chalk.yellow(`in-flight ${(counts.preparing ?? 0) + (counts.copying ?? 0) + (counts.finalizing ?? 0)}`)}  ${chalk.green(`complete ${counts.complete ?? 0}`)}  ${chalk.magenta(`incomplete ${counts.incomplete ?? 0}`)}  ${chalk.red(`failed ${counts.failed ?? 0}`)}  ${chalk.red(`quarantined ${counts.quarantined ?? 0}`)}  ${chalk.dim(`rolled_back ${counts.rolled_back ?? 0}`)}\n`,
        );

        if (rows.length === 0) {
          console.log(chalk.dim("  No import jobs match."));
          return;
        }

        console.log(
          chalk.dim(
            `  ${"ID".padEnd(12)} ${"Source".padEnd(12)} ${"Stage".padEnd(10)} ${"Status".padEnd(12)} ${"Updated".padEnd(20)}`,
          ),
        );
        console.log(chalk.dim(`  ${"─".repeat(70)}`));
        for (const r of rows) {
          const color =
            r.status === "complete"
              ? chalk.green
              : r.status === "failed" || r.status === "quarantined"
                ? chalk.red
                : r.status === "rolled_back"
                  ? chalk.dim
                  : r.status === "incomplete"
                    ? chalk.magenta
                    : chalk.yellow;
          const updated = r.updated_at ? new Date(r.updated_at).toLocaleString() : "-";
          console.log(
            `  ${r.dataset_id.padEnd(12)} ${(r.source_id || "-").padEnd(12)} ${r.stage.padEnd(10)} ${color(r.status.padEnd(12))} ${updated}`,
          );
          if (r.last_error) console.log(chalk.red(`    ${r.last_error}`));
          if (r.workflow_run_url) console.log(chalk.dim(`    run: ${r.workflow_run_url}`));
          if (r.blocklisted) {
            console.log(
              chalk.magenta(
                `    blocklisted (${r.blocklist_reason ?? "unknown"}); recovery_attempts=${r.recovery_attempts}; next_retry=${r.next_retry_at ?? "-"}${r.maintainer_notified_at ? `; maintainer notified ${r.maintainer_notified_at}` : ""}`,
              ),
            );
          } else if (r.status === "incomplete" || r.status === "failed") {
            console.log(
              chalk.dim(
                `    recovery_attempts=${r.recovery_attempts}; next_retry=${r.next_retry_at ?? "-"}`,
              ),
            );
          }
        }
      } catch (err) {
        spinner.fail("Failed to fetch import status");
        console.error(chalk.red(errorDetail(err)));
      }
    },
  );

importCommand
  .command("rollback")
  .description("Roll back a failed/quarantined import (deletes repo + S3 + D1)")
  .argument("<dataset-id>", "NEMAR dataset id (e.g., on007523)")
  .action(async (datasetId: string) => {
    if (!requireAuth()) return;

    const { proceed } = await inquirer.prompt([
      {
        type: "confirm",
        name: "proceed",
        message: chalk.red(
          `Roll back import ${datasetId}? This deletes the GitHub repo, S3 objects, and D1 records. This cannot be undone.`,
        ),
        default: false,
      },
    ]);
    if (!proceed) {
      console.log(chalk.dim("Cancelled."));
      return;
    }

    const spinner = ora(`Rolling back ${datasetId}...`).start();
    try {
      const result = await rollbackImport(datasetId);
      if (!result.rolled_back) {
        spinner.fail(
          `Rollback incomplete for ${datasetId} (kept quarantined); retry after fixing:`,
        );
        for (const w of result.warnings) console.log(chalk.red(`  - ${w}`));
      } else if (result.warnings.length > 0) {
        spinner.warn(`Rolled back ${datasetId} with warnings`);
        for (const w of result.warnings) console.log(chalk.yellow(`  - ${w}`));
      } else {
        spinner.succeed(`Rolled back ${datasetId}`);
      }
    } catch (err) {
      spinner.fail(`Failed to roll back ${datasetId}`);
      console.error(chalk.red(errorDetail(err)));
    }
  });

importCommand
  .command("retry")
  .description("Reset a failed/quarantined import to 'preparing' for re-dispatch")
  .argument("<dataset-id>", "NEMAR dataset id (e.g., on007523)")
  .action(async (datasetId: string) => {
    if (!requireAuth()) return;

    const spinner = ora(`Resetting ${datasetId}...`).start();
    try {
      await retryImport(datasetId);
      spinner.succeed(
        `${datasetId} reset to 'preparing'. Re-run the onboard-openneuro workflow to retry.`,
      );
    } catch (err) {
      spinner.fail(`Failed to reset ${datasetId}`);
      console.error(chalk.red(errorDetail(err)));
    }
  });

importCommand
  .command("verify")
  .description("Force a per-key S3 integrity check now (seeds the retry lane or confirms health)")
  .argument("<dataset-id>", "NEMAR dataset id (e.g., on007523)")
  .action(async (datasetId: string) => {
    if (!requireAuth()) return;

    const spinner = ora(`Verifying ${datasetId} against S3...`).start();
    try {
      const result = await verifyImport(datasetId);
      if (result.complete) {
        spinner.succeed(
          `${datasetId} verified complete (${result.presentCount}/${result.expectedCount} objects present)`,
        );
      } else {
        spinner.warn(
          `${datasetId} incomplete: ${result.missingKeys.length}/${result.expectedCount} object(s) missing${result.zeroByteKeys.length > 0 ? ` (${result.zeroByteKeys.length} zero-byte)` : ""}`,
        );
        for (const key of result.missingKeys.slice(0, 20)) {
          console.log(chalk.dim(`    ${key}`));
        }
        if (result.missingKeys.length > 20) {
          console.log(chalk.dim(`    ... and ${result.missingKeys.length - 20} more`));
        }
      }
    } catch (err) {
      spinner.fail(`Failed to verify ${datasetId}`);
      console.error(chalk.red(errorDetail(err)));
    }
  });

adminCommand.addCommand(importCommand);

// ============================================================================
// Dataset recovery (epic #967 phase 5, #972)
// ============================================================================

/** Default location of the checked-in recovery target list, resolved
 *  relative to this source file rather than cwd (mirrors
 *  defaultWithdrawnDatasetsPath). */
function defaultRecoverDatasetsPath(): string {
  return join(import.meta.dir, "..", "..", "scripts", "recover-datasets.json");
}

const recoverCommand = new Command("recover").description(
  "Re-copy epic #967 OpenNeuro imports published with 0-byte content, whose upstream is accessible (Phase 5, #972). Dry-run by default.",
);

recoverCommand
  .argument("[ids...]", "Dataset id(s) to recover (omit when using --all)")
  .option("--all", "Target every entry in the checked-in recover-datasets list")
  .option("--execute", "Actually verify + dispatch the re-copy (default is a dry run)")
  .option("--force", "Allow a dataset id that is not on the checked-in recover-datasets list")
  .option(
    "--recover-file <path>",
    "Path to the recover-datasets JSON (default: scripts/recover-datasets.json)",
  )
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .option("--json", "Output raw JSON")
  .addHelpText(
    "after",
    `
Description:
  Re-dispatches the hardened OpenNeuro copy path (epic #967 Phases 1-3) for
  datasets published with 0-byte content whose OpenNeuro upstream is still
  accessible today. A direct re-dispatch onto a still-'complete' import_jobs
  row silently no-ops the status callback (only a non-terminal row accepts
  an update), so --execute FIRST forces a per-key S3 verify on every target
  (reclassifying a stale 'complete' row to 'incomplete'), THEN dispatches
  ONE batch 'gh workflow run onboard-openneuro.yml' for the whole set.
  Afterward, treat 'nemar admin recover status' (datasets.data_complete) as
  the completion oracle, not import_jobs.status.

  The actual re-copy is production-only IN PRACTICE: outside production the
  target on###### ids have no import_jobs row (dev D1 is exemplars-only), so
  source-id resolution fails loudly before any dispatch. But verifyImport
  itself is NOT environment-gated -- --execute's reclassify step ('complete'
  -> 'incomplete') runs against whatever backend the CLI is pointed at, so
  only ever run --execute against production. A target already
  quarantined/blocklisted by the Phase 2 retry engine is not un-stuck by
  this reclassify (which only flips complete -> incomplete); trust
  datasets.data_complete, not import_jobs.status. Acceptance audit: run
  'nemar admin data-integrity-sweep --reaudit' after the batch lands
  (--older-than 0 does NOT converge here -- its cutoff is relative to an
  ever-advancing now(), so a just-stamped row re-qualifies on the very next
  batch; --reaudit anchors the cutoff once so remaining reaches 0, #980).`,
  )
  .action(
    async (
      ids: string[],
      options: {
        all?: boolean;
        execute?: boolean;
        force?: boolean;
        recoverFile?: string;
        json?: boolean;
      } & ConfirmOptions,
    ) => {
      if (!requireAuth()) return;

      if (ids.length === 0 && !options.all) {
        console.log(chalk.red("Error: provide dataset id(s) or use --all"));
        process.exit(1);
      }
      if (ids.length > 0 && options.all) {
        console.log(chalk.red("Error: provide dataset id(s) OR --all, not both"));
        process.exit(1);
      }

      const listPath = options.recoverFile || defaultRecoverDatasetsPath();
      let entries: RecoverDatasetEntry[];
      try {
        entries = loadRecoverDatasets(listPath);
      } catch (err) {
        console.error(chalk.red(`Failed to load recover-datasets file: ${errorDetail(err)}`));
        process.exit(1);
      }

      const resolved = options.all
        ? { targets: entries.map((e) => e.dataset_id) }
        : resolveRecoverTargets(ids, entries, { force: options.force });

      if ("error" in resolved) {
        console.error(chalk.red(resolved.error));
        process.exit(1);
      }
      const targets = resolved.targets;

      if (!options.execute) {
        // JSON first and exclusive: `recover --all --json | jq` must see pure
        // JSON on stdout, nothing else.
        if (options.json) {
          console.log(JSON.stringify({ dry_run: true, targets }, null, 2));
          return;
        }
        console.log(chalk.cyan(`\n[dry-run] Would recover ${targets.length} dataset(s):\n`));
        for (const id of targets) {
          const note = entries.find((e) => e.dataset_id === id)?.note;
          console.log(`  ${id}${note ? chalk.dim(` - ${note}`) : ""}`);
        }
        console.log(
          chalk.dim(
            "\nEach target: POST /admin/imports/:id/verify (reclassify), then one batch " +
              "gh workflow run onboard-openneuro.yml for the whole set. Pass --execute to run.",
          ),
        );
        return;
      }

      // Every human-readable console.log below is gated behind `!options.json`
      // so `recover --execute --json | jq` sees pure JSON on stdout; the JSON
      // result is assembled as the flow proceeds and printed once at the end
      // (it needs the dispatch/verify results, so it can't print up front the
      // way the dry-run branch above does). ora spinners write to stderr by
      // default, so they're left unguarded.
      if (!options.json) {
        console.log(
          chalk.yellow(
            `\nThis verifies (reclassifies) and re-dispatches the OpenNeuro copy for ${targets.length} dataset(s).`,
          ),
        );
      }
      const confirmResult = await confirm(
        `Execute recovery for ${targets.length} dataset(s)?`,
        options,
      );
      if (confirmResult !== "confirmed") {
        if (!options.json) {
          console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
        }
        return;
      }

      // Resolve each target's OpenNeuro ds###### source id from import_jobs
      // BEFORE any mutating call, so a target with no row fails loudly up
      // front rather than after some targets have already been reclassified.
      const resolveSpinner = ora("Resolving import sources...").start();
      let sourceByTarget: Map<string, string>;
      let missingSource: string[];
      try {
        const status = await getImportStatus();
        ({ sourceByTarget, missingSource } = resolveImportSources(targets, status.imports));
      } catch (err) {
        resolveSpinner.fail("Failed to fetch import job state");
        console.error(chalk.red(errorDetail(err)));
        process.exit(1);
      }
      if (missingSource.length > 0) {
        resolveSpinner.fail("Some targets have no import_jobs source to recover from");
        for (const id of missingSource) {
          console.error(chalk.red(`  ${id}: no import_jobs row (or empty source_id)`));
        }
        process.exit(1);
      }
      resolveSpinner.succeed(`Resolved ${targets.length} OpenNeuro source id(s)`);

      const verifyResults: Array<{ dataset_id: string; ok: boolean; error?: string }> = [];
      for (const id of targets) {
        const verifySpinner = ora(`Verifying ${id}...`).start();
        try {
          const result = await verifyImport(id);
          verifyResults.push({ dataset_id: id, ok: true });
          verifySpinner.succeed(
            `${id} reclassified: ${
              result.complete
                ? "already complete"
                : `incomplete (${result.missingKeys.length}/${result.expectedCount} missing)`
            }`,
          );
        } catch (err) {
          verifyResults.push({ dataset_id: id, ok: false, error: errorDetail(err) });
          verifySpinner.fail(`${id}: verify failed - ${errorDetail(err)}`);
        }
      }

      const verifiedTargets = verifyResults.filter((r) => r.ok).map((r) => r.dataset_id);
      const failedTargets = verifyResults.filter((r) => !r.ok);
      if (verifiedTargets.length === 0) {
        console.error(chalk.red("\nNo targets verified successfully; not dispatching."));
        process.exit(1);
      }

      // biome-ignore lint/style/noNonNullAssertion: sourceByTarget covers every id in verifiedTargets (checked above)
      const dsIds = verifiedTargets.map((id) => sourceByTarget.get(id)!);
      if (!options.json) {
        console.log(
          chalk.cyan(
            `\nDispatching onboard-openneuro.yml for ${dsIds.length} dataset(s): ${dsIds.join(", ")}\n`,
          ),
        );
      }
      const dispatch = await dispatchOpenNeuroImportWorkflow(dsIds);

      // Best-effort: push next_retry_at forward for the just-dispatched
      // targets so the Phase-2 retry cron (sweepImportRetries) doesn't
      // independently re-dispatch the same onboard-openneuro.yml run on its
      // next tick (#981). A failure here is non-corrupting -- worst case the
      // cron redundantly re-dispatches once -- so it must not fail the
      // recovery itself, only warn.
      //
      // Runs BEFORE the dispatch.ok check below, and unconditionally on
      // verifiedTargets (not just the ids of chunks that actually fired):
      // verifyImport already reclassified every one of verifiedTargets to
      // 'incomplete' with next_retry_at=now before we got here, so if a LATER
      // chunk fails after an EARLIER chunk already ran `gh workflow run`, the
      // already-dispatched datasets still need cooling down -- otherwise the
      // cron re-dispatches exactly the datasets this whole mechanism exists to
      // protect (the #981 bug, in the partial-failure case). Cooling down the
      // ids whose dispatch never fired is harmless: the operator resumes the
      // failed chunk manually, and any re-run of `recover` re-verifies first
      // (resetting next_retry_at=now again), so this is overwritten either way.
      let cooldown: { updated: number } | { error: string };
      try {
        cooldown = await dispatchCooldown(verifiedTargets);
        if (!options.json && cooldown.updated < verifiedTargets.length) {
          console.log(
            chalk.dim(
              `  (${verifiedTargets.length - cooldown.updated} of ${verifiedTargets.length} target(s) needed no cooldown: already complete, nothing for the cron to re-dispatch)`,
            ),
          );
        }
      } catch (err) {
        cooldown = { error: errorDetail(err) };
        console.warn(
          chalk.yellow(
            `\nWarning: failed to set dispatch cooldown (${errorDetail(err)}); the retry cron may briefly re-dispatch these datasets (non-corrupting).`,
          ),
        );
      }

      if (!dispatch.ok) {
        console.error(chalk.red(`Failed to dispatch workflow: ${dispatch.error}`));
        console.error(
          chalk.dim("Make sure gh CLI is authenticated with access to nemarDatasets org"),
        );
        process.exit(1);
      }

      if (!options.json) {
        console.log(chalk.green("Workflow dispatched successfully"));
        console.log(
          chalk.dim(
            "  Monitor at: https://github.com/nemarDatasets/.github/actions/workflows/onboard-openneuro.yml",
          ),
        );
        console.log(chalk.dim("  Or run: gh run list --repo nemarDatasets/.github --limit 5"));
        console.log(
          chalk.dim(
            "  Watch progress with: nemar admin recover status  /  nemar admin data-integrity-sweep --reaudit",
          ),
        );

        if (failedTargets.length > 0) {
          console.log(chalk.yellow(`\n${failedTargets.length} target(s) skipped (verify failed):`));
          for (const f of failedTargets) console.log(chalk.red(`  ${f.dataset_id}: ${f.error}`));
        }
      }

      if (options.json) {
        console.log(
          JSON.stringify(
            { dispatched: verifiedTargets, skipped: failedTargets, dispatch, cooldown },
            null,
            2,
          ),
        );
      }

      // Non-zero exit on partial verify failure so shell scripts can chain
      // safely (mirrors reindex/hed-sweep's convention); the JSON/human
      // output above still prints either way, this only affects the exit
      // code.
      if (failedTargets.length > 0) process.exit(1);
    },
  );

// `status` shares --all/--recover-file/--json with recoverCommand's own
// action above. Commander does not merge parent+child option VALUES when a
// flag of the same name is declared on both (the parent's parseOptions
// consumes it first, regardless of whether it appears before or after
// "status" on the command line -- the child then sees an empty value for
// that key), so the options are redeclared here ONLY for --help visibility
// and read back via optsWithGlobals(), which merges this command's own
// (empty) values with its ancestors' (the parent's real, captured values).
const recoverStatusCommand = recoverCommand
  .command("status")
  .description("Report data_complete/bytes_present progress for recover targets")
  .argument("[ids...]", "Dataset id(s) to check (omit when using --all)")
  .option("--all", "Check every entry in the checked-in recover-datasets list")
  .option(
    "--recover-file <path>",
    "Path to the recover-datasets JSON (default: scripts/recover-datasets.json)",
  )
  .option("--json", "Output raw JSON");

recoverStatusCommand.action(async (ids: string[]) => {
  const options = recoverStatusCommand.optsWithGlobals() as {
    all?: boolean;
    recoverFile?: string;
    json?: boolean;
  };
  if (!requireAuth()) return;

  if (ids.length === 0 && !options.all) {
    console.log(chalk.red("Error: provide dataset id(s) or use --all"));
    process.exit(1);
  }
  if (ids.length > 0 && options.all) {
    console.log(chalk.red("Error: provide dataset id(s) OR --all, not both"));
    process.exit(1);
  }

  const listPath = options.recoverFile || defaultRecoverDatasetsPath();
  let entries: RecoverDatasetEntry[];
  try {
    entries = loadRecoverDatasets(listPath);
  } catch (err) {
    console.error(chalk.red(`Failed to load recover-datasets file: ${errorDetail(err)}`));
    process.exit(1);
  }
  const targets = options.all ? entries.map((e) => e.dataset_id) : ids;

  const results: Array<{
    dataset_id: string;
    data_complete: number | null;
    bytes_present: number | null;
    file_size: number | null;
    error?: string;
  }> = [];
  for (const id of targets) {
    try {
      const dataset = await getDataset(id);
      results.push({
        dataset_id: id,
        data_complete: dataset.data_complete ?? null,
        bytes_present: dataset.bytes_present ?? null,
        file_size: dataset.file_size ?? null,
      });
    } catch (err) {
      results.push({
        dataset_id: id,
        data_complete: null,
        bytes_present: null,
        file_size: null,
        error: errorDetail(err),
      });
    }
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log(chalk.bold(`\nRecover status (${results.length})\n`));
  let completeCount = 0;
  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.dataset_id.padEnd(10)} ${chalk.red(`error: ${r.error}`)}`);
      continue;
    }
    if (r.data_complete === 1) completeCount++;
    const label =
      r.data_complete === 1
        ? chalk.green("complete")
        : r.data_complete === 0
          ? chalk.red("incomplete")
          : chalk.dim("unaudited");
    const bytes =
      r.bytes_present != null && r.file_size != null
        ? ` ${formatBytes(r.bytes_present)}/${formatBytes(r.file_size)}`
        : "";
    console.log(`  ${r.dataset_id.padEnd(10)} ${label}${bytes}`);
  }
  console.log(chalk.bold(`\n${completeCount}/${results.length} data_complete`));
});

adminCommand.addCommand(recoverCommand);

// ============================================================================
// Exemplar staging fleet (epic #923, Phase 5)
// ============================================================================

const EXEMPLAR_ID_RE = /^xx0999\d{2}$/;
const EXEMPLAR_SOURCE_ID_RE = /^(nm|on)\d{6}$/;

/** Default location of the curated fleet spec, resolved relative to this
 *  source file rather than cwd. Only present in a repo checkout (not
 *  published to npm) — `--all` is a maintainer/CI tool, not an end-user one. */
function defaultExemplarFleetPath(): string {
  return join(import.meta.dir, "..", "..", "scripts", "exemplar-fleet.json");
}

const exemplarCommand = new Command("exemplar").description(
  "Clone public nm/on datasets into staging exemplars (xx099900-xx099999)",
);

exemplarCommand
  .command("create")
  .description("Clone a public NEMAR dataset into a staging exemplar")
  .argument("[xx-id]", "Exemplar dataset id (e.g., xx099900); omit with --all")
  .option("--source <id>", "Source nm/on dataset id to clone (overrides the fleet file)")
  .option("--all", "Clone every entry in the fleet file")
  .option("--fleet-file <path>", "Path to the fleet JSON (default: scripts/exemplar-fleet.json)")
  .option("--publish", "Request and approve publication after data lands (mints a sandbox DOI)")
  .option("--include-derived", "Also copy zarr/, archives/, and records.json derived artifacts")
  .action(
    async (
      xxId: string | undefined,
      options: {
        source?: string;
        all?: boolean;
        fleetFile?: string;
        publish?: boolean;
        includeDerived?: boolean;
      },
    ) => {
      if (!requireAuth()) return;

      const { cloneExemplar, loadExemplarFleet } = await import("../lib/exemplar-clone.js");
      const fleetPath = options.fleetFile || defaultExemplarFleetPath();
      const cloneOpts = { publish: options.publish, includeDerived: options.includeDerived };

      if (options.all) {
        if (xxId || options.source) {
          console.error(chalk.red("--all cannot be combined with an xx-id or --source"));
          process.exit(1);
        }
        let entries: Awaited<ReturnType<typeof loadExemplarFleet>>;
        try {
          entries = loadExemplarFleet(fleetPath);
        } catch (err) {
          console.error(chalk.red(`Failed to load fleet file: ${errorDetail(err)}`));
          process.exit(1);
        }

        let failures = 0;
        for (const entry of entries) {
          if (entry.source_id === "nm000000") {
            console.log(
              chalk.yellow(`Skipping ${entry.xx_id}: placeholder source_id not yet finalized`),
            );
            continue;
          }
          try {
            await cloneExemplar({ xxId: entry.xx_id, sourceId: entry.source_id, ...cloneOpts });
          } catch (err) {
            failures++;
            console.error(chalk.red(`${entry.xx_id} failed: ${errorDetail(err)}`));
          }
        }
        if (failures > 0) {
          console.error(chalk.red(`\n${failures} of ${entries.length} fleet entries failed`));
          process.exit(1);
        }
        return;
      }

      if (!xxId) {
        console.error(chalk.red("An xx-id argument is required unless --all is passed"));
        process.exit(1);
      }
      if (!EXEMPLAR_ID_RE.test(xxId)) {
        console.error(chalk.red(`Invalid exemplar id "${xxId}". Expected xx099900-xx099999.`));
        process.exit(1);
      }

      let sourceId = options.source;
      if (!sourceId) {
        try {
          const entries = loadExemplarFleet(fleetPath);
          sourceId = entries.find((e) => e.xx_id === xxId)?.source_id;
        } catch (err) {
          console.error(chalk.red(`Failed to load fleet file: ${errorDetail(err)}`));
          process.exit(1);
        }
      }
      if (!sourceId) {
        console.error(
          chalk.red(
            `No source dataset for ${xxId}. Pass --source <nm/on id> or add it to the fleet file.`,
          ),
        );
        process.exit(1);
      }
      if (!EXEMPLAR_SOURCE_ID_RE.test(sourceId)) {
        console.error(chalk.red(`Invalid source id "${sourceId}". Expected an nm/on dataset id.`));
        process.exit(1);
      }

      try {
        await cloneExemplar({ xxId, sourceId, ...cloneOpts });
      } catch (error) {
        console.error(chalk.red(`\nExemplar clone failed: ${errorDetail(error)}`));
        process.exit(1);
      }
    },
  );

exemplarCommand
  .command("status")
  .description("Show which fleet entries have been cloned and their current state")
  .option("--fleet-file <path>", "Path to the fleet JSON (default: scripts/exemplar-fleet.json)")
  .action(async (options: { fleetFile?: string }) => {
    if (!requireAuth()) return;

    const { loadExemplarFleet } = await import("../lib/exemplar-clone.js");
    const fleetPath = options.fleetFile || defaultExemplarFleetPath();
    let entries: Awaited<ReturnType<typeof loadExemplarFleet>>;
    try {
      entries = loadExemplarFleet(fleetPath);
    } catch (err) {
      console.error(chalk.red(`Failed to load fleet file: ${errorDetail(err)}`));
      process.exit(1);
    }

    console.log(chalk.bold(`\nExemplar Fleet (${entries.length})\n`));
    for (const entry of entries) {
      try {
        const dataset = await getDataset(entry.xx_id);
        console.log(
          `  ${entry.xx_id.padEnd(10)} ${entry.modality.padEnd(6)} <- ${entry.source_id.padEnd(10)} ${chalk.green(dataset.visibility)}  doi=${dataset.concept_doi ?? "none"}`,
        );
      } catch (err) {
        if (err instanceof ApiError && err.statusCode === 404) {
          console.log(
            `  ${entry.xx_id.padEnd(10)} ${entry.modality.padEnd(6)} <- ${entry.source_id.padEnd(10)} ${chalk.dim("not created")}`,
          );
        } else {
          console.log(
            `  ${entry.xx_id.padEnd(10)} ${entry.modality.padEnd(6)} <- ${entry.source_id.padEnd(10)} ${chalk.red(`status check failed (${errorDetail(err)})`)}`,
          );
        }
      }
    }
  });

exemplarCommand
  .command("remint-dois")
  .description("Re-mint an exemplar's sandbox concept DOI (idempotent)")
  .argument("<xx-id>", "Exemplar dataset id (e.g., xx099900)")
  .action(async (xxId: string) => {
    if (!requireAuth()) return;

    const spinner = ora(`Re-minting DOIs for ${xxId}...`).start();
    try {
      const result = await remintExemplarDois(xxId);
      spinner.succeed(`Re-minted ${result.concept_doi} (status: ${result.status})`);
      for (const w of result.warnings ?? []) {
        console.log(chalk.yellow(`  ${w}`));
      }
    } catch (err) {
      handleCommandError(err, spinner, "Failed to re-mint exemplar DOIs", {
        400: "Not an exemplar dataset",
        403: "Exemplar DOI re-mint is disabled in production",
        404: "Dataset not found",
      });
      process.exit(1);
    }
  });

adminCommand.addCommand(exemplarCommand);

// ============================================================================
// Reindex (epic #417 phase 3): refresh enrichment +
// Phase 2 metadata columns for one or many datasets.
// ============================================================================

function printReindexLine(r: ReindexResponse, opts?: { showRef?: boolean }): void {
  const enrLabel = r.enrichment.status;
  const enr =
    enrLabel === "ok"
      ? chalk.green("enrich:ok")
      : enrLabel === "failed"
        ? chalk.red("enrich:failed")
        : chalk.dim("enrich:skipped");
  const syncLabel = r.sync.status;
  const sync =
    syncLabel === "ok"
      ? chalk.green("sync:ok")
      : syncLabel === "failed"
        ? chalk.red("sync:failed")
        : chalk.dim("sync:skipped");
  const cols =
    r.sync.metadata_columns_written === true
      ? chalk.green("cols:written")
      : r.sync.metadata_columns_error
        ? chalk.red("cols:failed")
        : "";
  const ref = opts?.showRef && r.enrichment.ref ? chalk.dim(`@${r.enrichment.ref}`) : "";
  console.log(`  ${r.dataset_id.padEnd(12)} ${enr}${ref}  ${sync}  ${cols}`);
  if (r.enrichment.error) console.log(chalk.red(`    enrichment: ${r.enrichment.error}`));
  if (r.sync.metadata_columns_error) {
    console.log(chalk.red(`    metadata columns: ${r.sync.metadata_columns_error}`));
  }
}

// ============================================================================
// Fleet governance (epic #713)
// ============================================================================

const fleetCommand = new Command("fleet").description(
  "Governance drift reporting and enforcement (epic #713)",
);

fleetCommand
  .command("drift")
  .description("Report dataset repos that are off the governance spec")
  .option("--prefix <prefix>", "Filter datasets by id prefix (e.g. nm, on)")
  .option("--visibility <vis>", "Filter by visibility: public or private")
  .option("--limit <n>", "Max repos to scan (default 25, max 50)", "25")
  .option("--json", "Output raw JSON")
  .action(async (options) => {
    if (!isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      process.exit(1);
    }
    if (options.visibility && !["public", "private"].includes(options.visibility)) {
      console.log(chalk.red("Error: --visibility must be public or private"));
      process.exit(1);
    }
    const spinner = ora("Scanning fleet for drift...").start();
    try {
      const r = await getFleetDrift({
        prefix: options.prefix,
        visibility: options.visibility,
        limit: Number.parseInt(options.limit, 10) || 25,
      });
      spinner.stop();
      if (options.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      console.log();
      console.log(chalk.bold(`Fleet drift (scanned ${r.scanned}):`));
      const order = [
        "PUBLIC_UNPROTECTED",
        "RED_REQUIRED_CHECK",
        "CONTEXT_NAME_MISMATCH",
        "MISSING_REQUIRED_WORKFLOW",
        "PRIVATE_WITH_STRAY_READ",
        "DEFAULT_BRANCH_OUTLIER",
        "DEPRECATED_WORKFLOW_PRESENT",
        "COMPLIANT",
      ];
      for (const b of order) {
        const ids = r.buckets[b];
        if (!ids || ids.length === 0) continue;
        const color = b === "COMPLIANT" ? chalk.green : chalk.yellow;
        console.log(`  ${color(b.padEnd(28))} ${ids.length}`);
        if (b !== "COMPLIANT") {
          const shown = ids.slice(0, 20).join(", ");
          console.log(
            chalk.dim(`    ${shown}${ids.length > 20 ? ` ... +${ids.length - 20}` : ""}`),
          );
        }
      }
      console.log();
    } catch (error) {
      if (error instanceof ApiError) spinner.fail(error.message);
      else {
        spinner.fail("Failed to scan fleet");
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }
  });

fleetCommand
  .command("enforce")
  .description("Bring dataset repos to the governance spec (single or --all). Dry-run by default.")
  .argument("[dataset-id]", "Dataset to enforce (omit when using --all)")
  .option("--all", "Bulk enforce across a filtered set (owner-only)")
  .option("--apply", "Actually apply changes (default is a dry run)")
  .option("--prefix <prefix>", "Bulk: filter by id prefix")
  .option("--visibility <vis>", "Bulk: filter by visibility (public|private)")
  .option("--limit <n>", "Bulk: max repos (default 25, max 50)", "25")
  .option("--json", "Output raw JSON")
  .action(async (datasetId, options) => {
    if (!isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      process.exit(1);
    }
    if (!datasetId && !options.all) {
      console.log(chalk.red("Error: provide a dataset-id or use --all"));
      process.exit(1);
    }
    if (datasetId && options.all) {
      console.log(chalk.red("Error: provide a dataset-id OR --all, not both"));
      process.exit(1);
    }
    const dryRun = !options.apply;
    const tag = dryRun ? "[dry-run] " : "";
    const spinner = ora(`${tag}Enforcing spec...`).start();
    try {
      if (datasetId) {
        const r = await enforceDataset(datasetId, dryRun);
        spinner.succeed(`${tag}${datasetId} (${r.result.visibility})`);
        if (options.json) {
          console.log(JSON.stringify(r, null, 2));
          return;
        }
        for (const [step, s] of Object.entries(r.result.steps)) {
          const color =
            s.status === "ok" ? chalk.green : s.status === "skipped" ? chalk.yellow : chalk.red;
          console.log(
            `  ${color(s.status.padEnd(8))} ${step}${s.detail ? chalk.dim(` (${s.detail})`) : ""}`,
          );
        }
      } else {
        const r = await enforceBulk({
          prefix: options.prefix,
          visibility: options.visibility,
          limit: Number.parseInt(options.limit, 10) || 25,
          dryRun,
        });
        spinner.succeed(`${tag}processed ${r.count} repo(s)`);
        if (options.json) {
          console.log(JSON.stringify(r, null, 2));
          return;
        }
        for (const res of r.results) {
          if (res.error) {
            console.log(`  ${chalk.red("error")}  ${res.dataset_id}: ${res.error}`);
            continue;
          }
          const off = Object.entries(res.steps ?? {})
            .filter(([, s]) => s.status !== "ok")
            .map(([k, s]) => `${k}=${s.status}`);
          const label = off.length ? chalk.yellow("drift") : chalk.green("ok");
          console.log(
            `  ${label}    ${res.dataset_id}${off.length ? chalk.dim(` (${off.join(", ")})`) : ""}`,
          );
        }
      }
    } catch (error) {
      if (error instanceof ApiError) spinner.fail(error.message);
      else {
        spinner.fail("Enforcement failed");
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }
  });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll the green-gated enforce dry-run until the required BIDS check is green on
 * main HEAD (`branch_ruleset.status === "ok"`) or the timeout elapses. Used by
 * single-dataset revalidate to wait out the in-flight central validation.
 * Returns "green" or "timeout" (timeout == still red or still running).
 */
async function pollEnforceGreen(
  datasetId: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<{ status: "green" } | { status: "timeout"; detail: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "no probe completed";
  while (Date.now() < deadline) {
    try {
      const br = (await enforceDataset(datasetId, true)).result?.steps?.branch_ruleset;
      if (br?.status === "ok") return { status: "green" };
      if (br?.detail) lastDetail = br.detail; // e.g. RED_REQUIRED_CHECK / FETCH_ERROR
    } catch (e) {
      lastDetail = e instanceof ApiError ? e.message : String(e);
    }
    await sleep(intervalMs);
  }
  return { status: "timeout", detail: lastDetail };
}

fleetCommand
  .command("revalidate")
  .description(
    "Re-run BIDS validation on main HEAD for unprotected datasets, then optionally enforce (epic #713)",
  )
  .argument("[dataset-id]", "Dataset to revalidate (omit when using --all/--prefix)")
  .option("--all", "Revalidate across unprotected public datasets")
  .option("--prefix <prefix>", "Filter by id prefix (with --all), e.g. nm000 / on")
  .option("--enforce", "After a dataset goes green, run enforce (dry-run unless --apply)")
  .option("--apply", "With --enforce, actually apply the ruleset (default is a dry run)")
  .option("--force", "Override the live-dataset guard (nm000103-107)")
  .option("--limit <n>", "Max repos for --all/--prefix (default 25)", "25")
  .option("--json", "Output raw JSON")
  .action(async (datasetId, options) => {
    if (!isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      process.exit(1);
    }
    const isBulk = Boolean(options.all || (!datasetId && options.prefix));
    if (!datasetId && !isBulk) {
      console.log(chalk.red("Error: provide a dataset-id, or --all/--prefix"));
      process.exit(1);
    }

    // Resolve targets.
    let targets: string[];
    if (datasetId) {
      targets = [datasetId];
    } else {
      const spinner = ora("Fetching dataset list...").start();
      try {
        // The /datasets endpoint caps a page at 200, so paginate to cover the
        // whole fleet (a higher nm/on prefix would otherwise be silently missed).
        const all: { dataset_id: string; visibility?: string }[] = [];
        for (let offset = 0; ; offset += 200) {
          const res = await listDatasets({ limit: 200, offset });
          all.push(...res.datasets);
          if (res.datasets.length < 200 || all.length >= res.total_count) break;
        }
        const cap = Number.parseInt(options.limit, 10) || 25;
        targets = selectRevalidateTargets(all, { prefix: options.prefix }).slice(0, cap);
        spinner.succeed(`${targets.length} target(s) (from ${all.length} datasets)`);
      } catch (error) {
        handleCommandError(error, spinner, "Failed to fetch datasets");
        return;
      }
    }

    const doEnforce = Boolean(options.enforce);
    const doApply = Boolean(options.apply);
    const tally = { revalidated: 0, green: 0, locked: 0, stillRed: 0, skipped: 0, errors: 0 };
    const raw: unknown[] = [];

    // Bulk: trigger all first (sequential dispatch is self-pacing), drain, then
    // a single enforce pass — mirrors the manual rollout sweep, far faster than
    // polling each repo for minutes. Single: trigger + poll for the live result.
    const triggered: string[] = [];
    let i = 0;
    for (const id of targets) {
      i++;
      if (CLI_LIVE_DATASETS.has(id) && !options.force) {
        console.log(`  [${i}/${targets.length}] ${chalk.dim(`${id}: skip (live; use --force)`)}`);
        tally.skipped++;
        continue;
      }
      try {
        const rv = await revalidateDataset(id, options.force);
        raw.push(rv);
        if (rv.skipped) {
          console.log(`  [${i}/${targets.length}] ${id}: ${chalk.dim(`skipped (${rv.skipped})`)}`);
          tally.skipped++;
        } else {
          tally.revalidated++;
          triggered.push(id);
          console.log(
            `  [${i}/${targets.length}] ${id}: ${chalk.cyan(`revalidating (${rv.triggered_by})`)}`,
          );
        }
      } catch (error) {
        tally.errors++;
        console.log(
          `  [${i}/${targets.length}] ${id}: ${chalk.red(error instanceof ApiError ? error.message : String(error))}`,
        );
      }
      if (i < targets.length) await sleep(4000); // pace the App dispatch limit
    }

    if (doEnforce && triggered.length > 0) {
      if (datasetId) {
        // Single: poll until green (or 5 min), then optionally lock.
        const id = triggered[0];
        const sp = ora(`Waiting for ${id} validation to land...`).start();
        const g = await pollEnforceGreen(id, 5 * 60_000, 15_000);
        if (g.status !== "green") {
          sp.warn(`${id}: not green within 5m — last: ${g.detail} (real errors or still running)`);
          tally.stillRed++;
        } else {
          tally.green++;
          if (!doApply) {
            sp.succeed(`${id}: green (would lock; pass --apply)`);
          } else {
            const en = await enforceDataset(id, false);
            if (en.result?.steps?.branch_ruleset?.status === "ok") {
              sp.succeed(`${id}: LOCKED`);
              tally.locked++;
            } else {
              sp.warn(`${id}: enforce ${en.result?.steps?.branch_ruleset?.status ?? "?"}`);
            }
          }
        }
      } else {
        // Bulk: drain, then one enforce pass over the triggered set.
        const sp = ora("Waiting ~90s for validations to drain...").start();
        await sleep(90_000);
        sp.text = "Enforcing green datasets...";
        for (const id of triggered) {
          try {
            const probe = await enforceDataset(id, true);
            if (probe.result?.steps?.branch_ruleset?.status !== "ok") {
              tally.stillRed++;
              continue;
            }
            tally.green++;
            if (doApply) {
              const en = await enforceDataset(id, false);
              if (en.result?.steps?.branch_ruleset?.status === "ok") tally.locked++;
            }
          } catch {
            tally.errors++;
          }
        }
        sp.stop();
      }
    }

    if (options.json) {
      console.log(JSON.stringify({ tally, raw }, null, 2));
      return;
    }
    console.log();
    console.log(
      chalk.cyan(
        `Done: revalidated=${tally.revalidated} green=${tally.green} locked=${tally.locked} still-red=${tally.stillRed} skipped=${tally.skipped} errors=${tally.errors}`,
      ),
    );
  });

adminCommand.addCommand(fleetCommand);

const reindexCommand = new Command("reindex").description(
  "Refresh dataset metadata: enrichment + first-class D1 columns",
);

reindexCommand
  .argument("[dataset-id]", "Dataset ID to reindex (e.g., nm000103)")
  .option("--all", "Reindex every dataset with a GitHub repo")
  .option("--missing-metadata", "Reindex only datasets with NULL metadata columns")
  .option("--stale", "Reindex only datasets whose metadata is older than --older-than days")
  .option(
    "--older-than <days>",
    "Threshold in days. Default 30 for --stale, 1 (24h) for --missing-metadata recency guard.",
  )
  .option("--skip-enrichment", "Skip the LLM enrichment step")
  .option("--skip-sync", "Skip the D1 metadata-column refresh step")
  .option("--ref <ref>", "Ref to enrich from (single-dataset only; default: main)")
  .option("--dry-run", "List matched datasets without firing the reindex (bulk only)")
  .action(
    async (
      datasetIdArg: string | undefined,
      options: {
        all?: boolean;
        missingMetadata?: boolean;
        stale?: boolean;
        olderThan?: string;
        skipEnrichment?: boolean;
        skipSync?: boolean;
        ref?: string;
        dryRun?: boolean;
      },
    ) => {
      if (!requireAuth()) return;

      const bulkFlags = [options.all, options.missingMetadata, options.stale].filter(
        Boolean,
      ).length;
      if (datasetIdArg && bulkFlags > 0) {
        console.error(
          chalk.red(
            "Provide either a dataset-id OR a bulk flag (--all/--missing-metadata/--stale), not both",
          ),
        );
        process.exit(1);
      }
      if (!datasetIdArg && bulkFlags === 0) {
        console.error(
          chalk.red("Provide a dataset-id or one of: --all, --missing-metadata, --stale"),
        );
        process.exit(1);
      }
      if (bulkFlags > 1) {
        console.error(chalk.red("Use only one of --all, --missing-metadata, --stale"));
        process.exit(1);
      }
      if (options.skipEnrichment && options.skipSync) {
        console.error(chalk.red("--skip-enrichment and --skip-sync cannot both be set"));
        process.exit(1);
      }

      // Single-dataset path
      if (datasetIdArg) {
        const spinner = ora(`Reindexing ${datasetIdArg}...`).start();
        try {
          const reindexOpts: ReindexOptions = {
            skip_enrichment: options.skipEnrichment === true,
            skip_sync: options.skipSync === true,
            ...(options.ref && { ref: options.ref }),
          };
          const result = await reindexDataset(datasetIdArg, reindexOpts);
          const ok = result.enrichment.status !== "failed" && result.sync.status !== "failed";
          if (ok) {
            spinner.succeed(`${datasetIdArg} reindexed`);
          } else {
            spinner.warn(`${datasetIdArg} reindexed with errors`);
          }
          console.log();
          printReindexLine(result, { showRef: true });
          if (!ok) process.exit(1);
        } catch (err) {
          spinner.fail(`Failed to reindex ${datasetIdArg}`);
          console.error(chalk.red(errorDetail(err)));
          process.exit(1);
        }
        return;
      }

      // Bulk path
      const filter: ReindexFilter = options.all
        ? "all"
        : options.missingMetadata
          ? "missing-metadata"
          : "stale";
      const bulkOpts: ReindexBulkOptions = {
        skip_enrichment: options.skipEnrichment === true,
        skip_sync: options.skipSync === true,
        dry_run: options.dryRun === true,
      };
      // --older-than default depends on the filter chosen.  Without an
      // explicit value, --stale uses 30 days (the historical default)
      // and --missing-metadata uses 1 day (the 24h recency guard added
      // in #579).  Pinning a Commander-level default would always
      // override the server-side branch defaults and hide the
      // missing-metadata recency guard, so the default is resolved
      // here based on filter.
      if (options.olderThan !== undefined) {
        const parsed = Number.parseInt(options.olderThan, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          console.error(chalk.red(`Invalid --older-than: "${options.olderThan}"`));
          process.exit(1);
        }
        bulkOpts.older_than_days = parsed;
      } else if (filter === "missing-metadata") {
        bulkOpts.older_than_days = 1;
      } else if (filter === "stale") {
        bulkOpts.older_than_days = 30;
      }

      const label = options.dryRun
        ? `Listing ${filter} datasets...`
        : `Reindexing ${filter} datasets...`;
      const spinner = ora(label).start();
      let response: ReindexBulkResponse;
      try {
        response = await reindexBulk(filter, bulkOpts);
      } catch (err) {
        spinner.fail("Bulk reindex failed");
        console.error(chalk.red(errorDetail(err)));
        process.exit(1);
      }

      if (response.dry_run) {
        spinner.succeed(`${response.total} datasets match filter=${filter} (dry run, no changes)`);
        if (response.datasets) {
          for (const id of response.datasets) {
            console.log(chalk.dim(`  - ${id}`));
          }
        }
        return;
      }

      const results = response.results ?? [];
      const okCount = results.filter(
        (r) => r.enrichment.status !== "failed" && r.sync.status !== "failed",
      ).length;
      const failed = results.length - okCount;
      if (failed === 0) {
        spinner.succeed(
          `${results.length}/${results.length} datasets reindexed in ${(response.elapsed_ms / 1000).toFixed(1)}s`,
        );
      } else {
        spinner.warn(
          `${okCount}/${results.length} ok; ${failed} failed in ${(response.elapsed_ms / 1000).toFixed(1)}s`,
        );
      }
      console.log();
      for (const r of results) {
        printReindexLine(r);
      }
      // Non-zero exit on partial bulk failure so shell scripts can chain
      // safely (`nemar admin reindex --missing-metadata && do_next_step`).
      if (failed > 0) process.exit(1);
    },
  );

adminCommand.addCommand(reindexCommand);

const availabilityReportCommand = new Command("availability-report")
  .description(
    "Report how much of a dataset's declared data is present in S3, and exactly which files are missing + why (#1000). Dry-run by default. --all backfills every managed dataset (#1001).",
  )
  .argument("[dataset-id]", "Dataset ID (e.g., nm000103)")
  .option(
    "--write",
    "Commit the report to .nemar/availability-report.json on main (default: preview only)",
  )
  .option("--all", "Backfill every managed dataset instead of a single one (#1001)")
  .option(
    "--missing-only",
    "With --all, sweep only datasets already known incomplete (data_complete=0)",
  )
  .option("--limit <n>", "With --all, datasets per batch (server clamps to [1,10])", "10")
  .option("--reset", "With --all, clear every stamped sweep row so it re-sweeps from scratch")
  .option("--verbose", "With --all, print per-batch progress")
  .option("--json", "Output raw JSON")
  .action(
    async (
      datasetId: string | undefined,
      options: {
        write?: boolean;
        all?: boolean;
        missingOnly?: boolean;
        limit?: string;
        reset?: boolean;
        verbose?: boolean;
        json?: boolean;
      },
    ) => {
      if (!requireAuth()) return;

      if (!datasetId && !options.all) {
        console.error(chalk.red("Provide a dataset-id or --all"));
        process.exit(1);
      }
      if (datasetId && (options.all || options.reset || options.missingOnly)) {
        console.error(
          chalk.red("--all/--reset/--missing-only cannot be combined with a dataset id"),
        );
        process.exit(1);
      }

      // Single-dataset path (Phase 1, #1000)
      if (datasetId) {
        const spinner = ora(
          options.write
            ? `Generating and writing availability report for ${datasetId}...`
            : `Previewing availability report for ${datasetId}...`,
        ).start();
        let result: AvailabilityReportResult;
        try {
          result = await availabilityReport(datasetId, { write: options.write === true });
        } catch (err) {
          spinner.fail(`Failed to generate availability report for ${datasetId}`);
          console.error(chalk.red(errorDetail(err)));
          process.exit(1);
        }

        const report: AvailabilityReport = "report" in result ? result.report : result;
        const written = "report" in result;
        spinner.succeed(
          written
            ? `${datasetId}: availability report written to .nemar/availability-report.json`
            : `${datasetId}: availability report (dry run, not written)`,
        );

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log();
        if (report.version === null) {
          console.log(
            chalk.yellow(
              "  No published version manifest to compare against; completeness unknown.",
            ),
          );
        } else {
          console.log(`  Version:   ${report.version}`);
        }
        console.log(`  Complete:  ${report.complete ? chalk.green("yes") : chalk.red("no")}`);
        console.log(
          `  Files:     ${report.completeness.files_present}/${report.completeness.files_declared} present`,
        );
        const bytesLine = `${formatBytes(report.completeness.bytes_present)}/${formatBytes(report.completeness.bytes_declared)}`;
        const pct =
          report.completeness.pct_bytes != null
            ? ` (${(report.completeness.pct_bytes * 100).toFixed(1)}%)`
            : "";
        console.log(`  Bytes:     ${bytesLine}${pct}`);
        if (report.blocklist_reason) {
          console.log(chalk.yellow(`  Blocklisted: ${report.blocklist_reason}`));
        }
        if (report.missing.length > 0) {
          console.log();
          console.log(chalk.dim(`  Missing (${report.missing.length}):`));
          for (const m of report.missing) {
            console.log(chalk.dim(`    - ${m.path} [${m.reason}]`));
          }
        }
        return;
      }

      // Bulk path (--all, Phase 2, #1001)
      if (options.reset) {
        const spinner = ora("Resetting availability-report sweep state...").start();
        try {
          const r = await availabilityReportSweepReset();
          spinner.succeed(
            `Cleared ${r.reset} stamped row(s); eligible datasets are candidates again`,
          );
          if (options.json) console.log(JSON.stringify(r, null, 2));
        } catch (err) {
          spinner.fail("Reset failed");
          console.error(chalk.red(errorDetail(err)));
          process.exit(1);
        }
        return;
      }

      const limit = Number.parseInt(options.limit ?? "10", 10) || 10;
      const missingOnly = options.missingOnly === true;
      const totals = { processed: 0, written: 0, errors: 0 };
      const spinner = ora("Sweeping datasets for availability reports...").start();

      let batch = 0;
      let remaining: number | null = null;
      let prevRemaining: number | null = null;
      try {
        let res: AvailabilityReportSweepBatchResponse;
        do {
          res = await availabilityReportSweep({ limit, missingOnly });
          batch++;
          totals.processed += res.processed;
          totals.written += res.written;
          totals.errors += res.errors.length;
          remaining = res.remaining;

          if (options.verbose) {
            spinner.stop();
            console.log(
              `  [batch ${batch}] processed=${res.processed} written=${res.written} errors=${res.errors.length} remaining=${remaining ?? "?"}`,
            );
            for (const e of res.errors) console.log(`    ${chalk.red(e.dataset_id)}: ${e.error}`);
            spinner.start("Sweeping datasets for availability reports...");
          } else {
            spinner.text = `Sweeping datasets for availability reports... ${totals.processed} processed, ${remaining ?? "?"} remaining`;
          }

          // Progress guard: availability_report_at is stamped only after a
          // successful write, so a persistently failing batch never advances --
          // bail instead of looping forever.
          if (remaining != null && prevRemaining != null && remaining >= prevRemaining) {
            spinner.warn(`No progress (remaining stuck at ${remaining}); stopping - see errors`);
            break;
          }
          prevRemaining = remaining;

          if ((remaining ?? 0) > 0) await sleep(1000); // pace the GitHub-heavy batches
        } while ((remaining ?? 0) > 0);

        spinner.stop();
      } catch (err) {
        spinner.fail("Availability-report sweep failed");
        console.error(chalk.red(errorDetail(err)));
        process.exit(1);
      }

      if (options.json) {
        console.log(JSON.stringify({ ...totals, batches: batch, remaining }, null, 2));
      } else {
        console.log();
        if (remaining === null) {
          console.log(
            chalk.yellow(
              "Warning: backend returned a null remaining count; the sweep may be incomplete - check server logs.",
            ),
          );
        }
        console.log(
          chalk.cyan(
            `Done in ${batch} batch(es): processed=${totals.processed} written=${totals.written} errors=${totals.errors} remaining=${remaining ?? "unknown"}`,
          ),
        );
      }
      // Non-zero exit on errors OR an indeterminate (null) remaining, so a caller
      // never reads a partial/uncertain sweep as success.
      if (totals.errors > 0 || remaining === null) process.exit(1);
    },
  );

adminCommand.addCommand(availabilityReportCommand);

const hedSweepCommand = new Command("hed-sweep").description(
  "Backfill HED detection (has_hed / hed_version) for existing datasets (#869)",
);

hedSweepCommand
  .option("--limit <n>", "Datasets per batch (server clamps to [1,30])", "15")
  .option("--reset", "Clear every probed HED row so a corrected detector can re-sweep")
  .option("--verbose", "Print per-batch progress")
  .option("--json", "Output raw JSON instead of the human summary")
  .action(
    async (options: { limit?: string; reset?: boolean; verbose?: boolean; json?: boolean }) => {
      if (!requireAuth()) return;

      if (options.reset) {
        const spinner = ora("Resetting HED sweep state...").start();
        try {
          const r = await hedSweepReset();
          spinner.succeed(
            `Cleared ${r.reset} probed HED row(s); eligible datasets are candidates again`,
          );
          if (options.json) console.log(JSON.stringify(r, null, 2));
        } catch (err) {
          spinner.fail("Reset failed");
          console.error(chalk.red(errorDetail(err)));
          process.exit(1);
        }
        return;
      }

      const limit = Number.parseInt(options.limit ?? "15", 10) || 15;
      const totals = { processed: 0, withHed: 0, withoutHed: 0, unknown: 0, errors: 0 };
      const spinner = ora("Sweeping datasets for HED...").start();

      let batch = 0;
      let remaining: number | null = null;
      let prevRemaining: number | null = null;
      try {
        let res: HedSweepBatchResponse;
        do {
          res = await hedSweep({ limit });
          batch++;
          totals.processed += res.processed;
          totals.withHed += res.withHed;
          totals.withoutHed += res.withoutHed;
          totals.unknown += res.unknown;
          totals.errors += res.errors.length;
          remaining = res.remaining;

          if (options.verbose) {
            spinner.stop();
            console.log(
              `  [batch ${batch}] processed=${res.processed} hed=${res.withHed} no-hed=${res.withoutHed} unknown=${res.unknown} errors=${res.errors.length} remaining=${remaining ?? "?"}`,
            );
            for (const e of res.errors) console.log(`    ${chalk.red(e.dataset_id)}: ${e.error}`);
            spinner.start("Sweeping datasets for HED...");
          } else {
            spinner.text = `Sweeping datasets for HED... ${totals.processed} processed, ${remaining ?? "?"} remaining`;
          }

          // Progress guard: hed_checked_at is stamped for every processed row, so
          // `remaining` must strictly decrease. If it doesn't (e.g. persistent D1
          // write errors leave rows unstamped), bail instead of looping forever.
          if (remaining != null && prevRemaining != null && remaining >= prevRemaining) {
            spinner.warn(`No progress (remaining stuck at ${remaining}); stopping - see errors`);
            break;
          }
          prevRemaining = remaining;

          if ((remaining ?? 0) > 0) await sleep(1000); // pace the GitHub-heavy batches
        } while ((remaining ?? 0) > 0);

        spinner.stop();
      } catch (err) {
        spinner.fail("HED sweep failed");
        console.error(chalk.red(errorDetail(err)));
        process.exit(1);
      }

      if (options.json) {
        console.log(JSON.stringify({ ...totals, batches: batch, remaining }, null, 2));
      } else {
        console.log();
        if (remaining === null) {
          console.log(
            chalk.yellow(
              "Warning: backend returned a null remaining count; the sweep may be incomplete - check server logs.",
            ),
          );
        }
        console.log(
          chalk.cyan(
            `Done in ${batch} batch(es): processed=${totals.processed} hed=${totals.withHed} no-hed=${totals.withoutHed} unknown=${totals.unknown} errors=${totals.errors} remaining=${remaining ?? "unknown"}`,
          ),
        );
      }
      // Non-zero exit on errors OR an indeterminate (null) remaining, so a caller
      // never reads a partial/uncertain sweep as success.
      if (totals.errors > 0 || remaining === null) process.exit(1);
    },
  );

adminCommand.addCommand(hedSweepCommand);

/** One data-integrity-sweep batch, as consumed by {@link runReauditLoop}. */
export interface ReauditBatchResult {
  processed: number;
  complete: number;
  incomplete: number;
  unknown: number;
  errors: { dataset_id: string; error: string }[];
  remaining: number | null;
}

export interface ReauditLoopResult {
  batches: number;
  totals: {
    processed: number;
    complete: number;
    incomplete: number;
    unknown: number;
    errors: number;
  };
  remaining: number | null;
  /** Hit the no-progress guard (remaining didn't strictly decrease) and stopped early. */
  stalled: boolean;
}

/**
 * Pure convergence loop driving `nemar admin data-integrity-sweep --reaudit`
 * (#980 review fix). `getBefore()` is called EXACTLY ONCE, before the first
 * `fetchBatch` call, and that single captured value is threaded UNCHANGED
 * into every subsequent `fetchBatch(before)` call -- this is the convergence
 * property itself (an anchored cutoff, not a moving `now()`-relative one; see
 * the `?before=` doc comment on the sweep endpoint in datasets-lifecycle.ts).
 *
 * No Date/network dependency of its own, so both the anchoring property (one
 * capture, reused every call) and the termination property (stop at
 * remaining=0, or on a stalled/non-decreasing `remaining`) are directly
 * unit-testable with a plain callback -- a future regression that re-derives
 * `before` inside the loop (the exact "moving cutoff never converges" bug
 * this whole flag exists to fix) would surface as differing `before` values
 * across `fetchBatch` calls in the test, not just as a slow production
 * incident that's hard to reproduce.
 *
 * `onBatch`/`sleepBetweenBatches` are optional hooks for the CLI's own
 * per-batch UI (spinner text, verbose printing, pacing sleep) -- kept out of
 * the aggregation/termination logic itself so a test can omit them entirely.
 */
export async function runReauditLoop(
  getBefore: () => string | undefined,
  fetchBatch: (before: string | undefined) => Promise<ReauditBatchResult>,
  hooks?: {
    onBatch?: (
      res: ReauditBatchResult,
      totals: ReauditLoopResult["totals"],
      batchNumber: number,
    ) => void;
    sleepBetweenBatches?: () => Promise<void>;
  },
): Promise<ReauditLoopResult> {
  const before = getBefore();
  const totals = { processed: 0, complete: 0, incomplete: 0, unknown: 0, errors: 0 };
  let batches = 0;
  let remaining: number | null = null;
  let prevRemaining: number | null = null;
  let stalled = false;

  do {
    const res = await fetchBatch(before);
    batches++;
    totals.processed += res.processed;
    totals.complete += res.complete;
    totals.incomplete += res.incomplete;
    totals.unknown += res.unknown;
    totals.errors += res.errors.length;
    remaining = res.remaining;
    hooks?.onBatch?.(res, totals, batches);

    // Progress guard: data_checked_at is stamped for every processed row, so
    // `remaining` must strictly decrease. If it doesn't (e.g. persistent D1
    // write errors leave rows unstamped), stop instead of looping forever.
    if (remaining != null && prevRemaining != null && remaining >= prevRemaining) {
      stalled = true;
      break;
    }
    prevRemaining = remaining;

    if ((remaining ?? 0) > 0) await hooks?.sleepBetweenBatches?.();
  } while ((remaining ?? 0) > 0);

  return { batches, totals, remaining, stalled };
}

const dataIntegritySweepCommand = new Command("data-integrity-sweep").description(
  "Audit datasets against their version manifest and backfill data_complete / bytes_present (epic #967 Phase 3, #970)",
);

dataIntegritySweepCommand
  .option("--limit <n>", "Datasets per batch (server clamps to [1,30])", "15")
  .option(
    "--older-than <days>",
    "Also re-audit rows checked more than N days ago (periodic re-audit, not just the one-shot drain)",
  )
  .option(
    "--reaudit",
    "Re-verify every already-checked row using an anchored cutoff so the sweep fully converges to 0 (unlike --older-than's moving now()-relative window, which never reaches 0 on its own)",
  )
  .option("--reset", "Clear every audited row so a corrected verifier can re-sweep")
  .option("--verbose", "Print per-batch progress")
  .option("--json", "Output raw JSON instead of the human summary")
  .action(
    async (options: {
      limit?: string;
      olderThan?: string;
      reaudit?: boolean;
      reset?: boolean;
      verbose?: boolean;
      json?: boolean;
    }) => {
      if (!requireAuth()) return;

      if (options.reset) {
        const spinner = ora("Resetting data-integrity sweep state...").start();
        try {
          const r = await dataIntegritySweepReset();
          spinner.succeed(
            `Cleared ${r.reset} audited row(s); eligible datasets are candidates again`,
          );
          if (options.json) console.log(JSON.stringify(r, null, 2));
        } catch (err) {
          spinner.fail("Reset failed");
          console.error(chalk.red(errorDetail(err)));
          process.exit(1);
        }
        return;
      }

      const limit = Number.parseInt(options.limit ?? "15", 10) || 15;
      const olderThan = options.olderThan ? Number.parseInt(options.olderThan, 10) : undefined;
      const spinner = ora("Sweeping datasets for data integrity...").start();

      let loopResult: ReauditLoopResult | undefined;
      try {
        loopResult = await runReauditLoop(
          // Captured ONCE by runReauditLoop, before the first fetchBatch call --
          // every call in this run passes the SAME anchor, so a row re-checked
          // mid-run is stamped with a data_checked_at strictly AFTER `before`
          // and never re-qualifies -- `remaining` strictly decreases to 0.
          () => (options.reaudit ? new Date().toISOString() : undefined),
          async (before) => {
            const res = await dataIntegritySweep({ limit, olderThan, before });
            return {
              processed: res.processed,
              complete: res.complete,
              incomplete: res.incomplete,
              unknown: res.unknown,
              errors: res.errors,
              remaining: res.remaining,
            };
          },
          {
            onBatch: (res, totals, batchNumber) => {
              if (options.verbose) {
                spinner.stop();
                console.log(
                  `  [batch ${batchNumber}] processed=${res.processed} complete=${res.complete} incomplete=${res.incomplete} unknown=${res.unknown} errors=${res.errors.length} remaining=${res.remaining ?? "?"}`,
                );
                for (const e of res.errors)
                  console.log(`    ${chalk.red(e.dataset_id)}: ${e.error}`);
                spinner.start("Sweeping datasets for data integrity...");
              } else {
                spinner.text = `Sweeping datasets for data integrity... ${totals.processed} processed, ${res.remaining ?? "?"} remaining`;
              }
            },
            sleepBetweenBatches: () => sleep(1000), // pace the S3-heavy batches
          },
        );

        if (loopResult.stalled) {
          spinner.warn(
            `No progress (remaining stuck at ${loopResult.remaining}); stopping - see errors`,
          );
        } else {
          spinner.stop();
        }
      } catch (err) {
        spinner.fail("Data-integrity sweep failed");
        console.error(chalk.red(errorDetail(err)));
        process.exit(1);
      }

      const { batches, totals, remaining } = loopResult;

      if (options.json) {
        console.log(JSON.stringify({ ...totals, batches, remaining }, null, 2));
      } else {
        console.log();
        if (remaining === null) {
          console.log(
            chalk.yellow(
              "Warning: backend returned a null remaining count; the sweep may be incomplete - check server logs.",
            ),
          );
        }
        console.log(
          chalk.cyan(
            `Done in ${batches} batch(es): processed=${totals.processed} complete=${totals.complete} incomplete=${totals.incomplete} unknown=${totals.unknown} errors=${totals.errors} remaining=${remaining ?? "unknown"}`,
          ),
        );
        if (totals.incomplete > 0) {
          console.log(
            chalk.yellow(
              `${totals.incomplete} dataset(s) verified incomplete -- see 'nemar dataset list --json' (data_complete=0) for details.`,
            ),
          );
        }
      }
      // Non-zero exit on errors OR an indeterminate (null) remaining, so a caller
      // never reads a partial/uncertain sweep as success.
      if (totals.errors > 0 || remaining === null) process.exit(1);
    },
  );

adminCommand.addCommand(dataIntegritySweepCommand);

// ============================================================================
// Doctor: diagnostic checks + remediation (#1130)
// ============================================================================

const doctorCommand = new Command("doctor").description(
  "Diagnose and heal stuck-dataset patterns (e.g. missing S3 version manifests)",
);

function printScanResults(res: DoctorScanResponse): number {
  let total = 0;
  for (const [name, r] of Object.entries(res.results)) {
    total += r.count;
    const status = r.count > 0 ? chalk.red(`${r.count} finding(s)`) : chalk.green("clean");
    console.log(`${chalk.bold(name)}: ${status} — ${r.description}`);
    for (const f of r.findings) {
      console.log(`  ${f.dataset_id}${f.version ? `@v${f.version}` : ""}`);
    }
  }
  return total;
}

doctorCommand
  .command("scan")
  .description("Run diagnostic checks (read-only)")
  .argument("[dataset-id]", "Narrow the scan to one dataset")
  .option("--check <name>", "Run a single check (default: all checks)")
  .option("--json", "Output raw JSON instead of the human summary")
  .action(async (datasetId: string | undefined, options: { check?: string; json?: boolean }) => {
    if (!requireAuth()) return;
    const spinner = ora(
      "Running doctor checks (read-only; a full-catalog scan can take ~1 minute)...",
    ).start();
    try {
      const res = await doctorScan({ check: options.check, datasetId });
      spinner.stop();
      if (options.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      const total = printScanResults(res);
      if (total > 0) {
        console.log(
          chalk.yellow(
            `\n${total} finding(s). Preview the remediation with: nemar admin doctor fix <check> --dry-run`,
          ),
        );
      }
    } catch (err) {
      spinner.fail("Doctor scan failed");
      console.error(chalk.red(errorDetail(err)));
      process.exit(1);
    }
  });

doctorCommand
  .command("fix")
  .description("Apply a check's remediation (writes; use --dry-run first)")
  .argument("<check>", "Check name (see: nemar admin doctor scan)")
  .argument("[dataset-id]", "Narrow to one dataset")
  .option("--dry-run", "List what would be fixed without writing")
  .option("--json", "Output raw JSON instead of the human summary")
  .action(
    async (
      check: string,
      datasetId: string | undefined,
      options: { dryRun?: boolean; json?: boolean },
    ) => {
      if (!requireAuth()) return;

      if (options.dryRun) {
        const spinner = ora(`Listing ${check} findings (dry run)...`).start();
        try {
          const res = await doctorFix({ check, datasetId, dryRun: true });
          spinner.stop();
          if (options.json) {
            console.log(JSON.stringify(res, null, 2));
            return;
          }
          console.log(`Would fix ${res.would_fix} finding(s) for ${chalk.bold(check)}:`);
          for (const f of res.findings) {
            console.log(`  ${f.dataset_id}${f.version ? `@v${f.version}` : ""}`);
          }
        } catch (err) {
          spinner.fail("Dry run failed");
          console.error(chalk.red(errorDetail(err)));
          process.exit(1);
        }
        return;
      }

      // Enumerate first, then fix one dataset per request, so the spinner can
      // show which dataset is in flight and a partial failure is visible the
      // moment it happens rather than after one long opaque request. The
      // narrowed fix re-scans its dataset server-side; a finding healed
      // between the scan and its fix turn comes back with zero results and
      // is counted as `resolved` by runDoctorFixLoop, never silently dropped.
      const spinner = ora(`Scanning for ${check} findings...`).start();
      let findings: DoctorScanResponse["results"][string]["findings"];
      try {
        const scan = await doctorScan({ check, datasetId });
        findings = scan.results[check]?.findings ?? [];
      } catch (err) {
        spinner.fail("Doctor scan failed");
        console.error(chalk.red(errorDetail(err)));
        process.exit(1);
        return;
      }
      if (findings.length === 0) {
        spinner.succeed(`${check}: nothing to fix`);
        if (options.json) console.log(JSON.stringify({ check, total: 0, results: [] }, null, 2));
        return;
      }
      spinner.stop();
      console.log(`${chalk.bold(check)}: ${findings.length} finding(s) to fix`);

      const datasetIds = [...new Set(findings.map((f) => f.dataset_id))];
      spinner.start();
      const { totals, results } = await runDoctorFixLoop(
        datasetIds,
        (id, index) => {
          const versions = findings
            .filter((f) => f.dataset_id === id && f.version)
            .map((f) => `v${f.version}`)
            .join(", ");
          spinner.text = `Fixing ${id}${versions ? ` (${versions})` : ""} [${index + 1}/${datasetIds.length}]...`;
          return doctorFix({ check, datasetId: id });
        },
        {
          onDataset: (id, perDataset) => {
            spinner.stop();
            if (perDataset.length === 0) {
              console.log(`  resolved ${id}: healed between the scan and its fix turn`);
            }
            for (const r of perDataset) {
              const label = `${r.dataset_id}${r.version ? `@v${r.version}` : ""}`;
              if (r.status === "fixed") {
                console.log(`  ${chalk.green("fixed")}   ${label}`);
              } else if (r.status === "skipped") {
                console.log(`  skipped ${label}: ${r.message ?? "already healthy"}`);
              } else {
                console.log(`  ${chalk.red("FAILED")}  ${label}: ${r.message ?? "unknown error"}`);
              }
            }
            spinner.start();
          },
        },
      );
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify({ check, total: findings.length, ...totals, results }, null, 2));
      } else {
        const resolvedNote = totals.resolved > 0 ? `, ${totals.resolved} already resolved` : "";
        console.log(
          `\n${chalk.bold(check)}: ${chalk.green(`${totals.fixed} fixed`)}, ${totals.skipped} skipped, ${totals.failed > 0 ? chalk.red(`${totals.failed} failed`) : "0 failed"}${resolvedNote}`,
        );
      }
      // Non-zero exit when any fix failed, so a caller never reads a
      // partial remediation as success.
      if (totals.failed > 0) process.exit(1);
    },
  );

/** Aggregated outcome of {@link runDoctorFixLoop}. `resolved` counts datasets
 *  whose findings were healed between enumeration and their fix turn (the
 *  narrowed server-side re-scan returned zero results). */
export interface DoctorFixLoopOutcome {
  totals: { fixed: number; skipped: number; failed: number; resolved: number };
  results: DoctorFixResult[];
}

/**
 * Per-dataset driver for `nemar admin doctor fix` (#1133 review fix). Pure
 * aggregation over a dependency-injected `fixOne`, mirroring runReauditLoop's
 * extraction convention, so two properties are unit-testable without a server:
 * a dataset healed in the interim is counted as `resolved` (never silently
 * dropped from the tally), and a thrown `fixOne` records a failed result and
 * continues with the remaining datasets instead of aborting the run.
 */
export async function runDoctorFixLoop(
  datasetIds: string[],
  fixOne: (datasetId: string, index: number) => Promise<DoctorFixLiveResponse>,
  hooks?: {
    /** Called after each dataset with its per-dataset results (empty = resolved). */
    onDataset?: (datasetId: string, results: DoctorFixResult[]) => void;
  },
): Promise<DoctorFixLoopOutcome> {
  const totals = { fixed: 0, skipped: 0, failed: 0, resolved: 0 };
  const results: DoctorFixResult[] = [];
  for (const [index, id] of datasetIds.entries()) {
    let perDataset: DoctorFixResult[];
    try {
      const res = await fixOne(id, index);
      perDataset = res.results;
      if (perDataset.length === 0) {
        totals.resolved++;
      } else {
        totals.fixed += res.fixed;
        totals.skipped += res.skipped;
        totals.failed += res.failed;
      }
    } catch (err) {
      totals.failed++;
      perDataset = [{ dataset_id: id, status: "failed", message: errorDetail(err) }];
    }
    results.push(...perDataset);
    hooks?.onDataset?.(id, perDataset);
  }
  return { totals, results };
}

adminCommand.addCommand(doctorCommand);

// ============================================================================
// Email Notification Preferences
// ============================================================================

const emailPrefsCommand = new Command("email-preferences").description(
  "Manage email notification preferences",
);

emailPrefsCommand
  .command("show")
  .description("Show email notification preferences")
  .option("--user <username>", "(owner only) show another user's preferences")
  .action(async (options: { user?: string }) => {
    if (!isAuthenticated()) {
      console.error(chalk.red("Not authenticated. Run: nemar auth login"));
      process.exit(1);
    }

    const spinner = ora("Fetching email preferences...").start();
    try {
      const prefs = await getEmailPreferences(options.user);
      const whose = prefs.username ? `${prefs.username}'s` : "Your";
      spinner.succeed(`${whose} email notification preferences:`);
      console.log();

      const categories: Array<{ key: keyof EmailPreferences; label: string }> = [
        { key: "user_approval", label: "User approval notifications" },
        { key: "publication_request", label: "Publication request notifications" },
        { key: "announcements", label: "Announcement emails" },
      ];

      for (const cat of categories) {
        const enabled = prefs[cat.key];
        const status = enabled ? chalk.green("enabled") : chalk.dim("disabled");
        console.log(`  ${cat.label.padEnd(40)} ${status}`);
      }

      console.log();
      console.log(chalk.dim("  Use 'nemar admin email-preferences update' to change settings."));
    } catch (err) {
      spinner.fail("Failed to fetch preferences");
      console.error(chalk.red(errorDetail(err)));
    }
  });

emailPrefsCommand
  .command("update")
  .description("Update email notification preferences")
  .option("--user-approval <bool>", "Enable/disable user approval notifications")
  .option("--publication-request <bool>", "Enable/disable publication request notifications")
  .option("--announcements <bool>", "Enable/disable announcement emails")
  .option("--all <bool>", "Enable/disable all notifications")
  .option("--user <username>", "(owner only) update another user's preferences")
  .action(
    async (options: {
      userApproval?: string;
      publicationRequest?: string;
      announcements?: string;
      all?: string;
      user?: string;
    }) => {
      if (!isAuthenticated()) {
        console.error(chalk.red("Not authenticated. Run: nemar auth login"));
        process.exit(1);
      }

      function parseBool(val: string | undefined): boolean | undefined {
        if (val === undefined) return undefined;
        const lower = val.toLowerCase();
        if (lower === "true" || lower === "1" || lower === "on" || lower === "yes") return true;
        if (lower === "false" || lower === "0" || lower === "off" || lower === "no") return false;
        console.error(
          chalk.red(`Invalid boolean value: "${val}". Use true/false, on/off, yes/no.`),
        );
        process.exit(1);
      }

      const updates: Partial<EmailPreferences> = {};

      if (options.all !== undefined) {
        const val = parseBool(options.all);
        updates.user_approval = val;
        updates.publication_request = val;
        updates.announcements = val;
      } else {
        const ua = parseBool(options.userApproval);
        const pr = parseBool(options.publicationRequest);
        const ann = parseBool(options.announcements);

        if (ua === undefined && pr === undefined && ann === undefined) {
          console.error(chalk.red("No preferences specified."));
          console.log("  --user-approval <bool>        User approval notifications");
          console.log("  --publication-request <bool>   Publication request notifications");
          console.log("  --announcements <bool>         Announcement emails");
          console.log("  --all <bool>                   All notifications");
          process.exit(1);
        }

        if (ua !== undefined) updates.user_approval = ua;
        if (pr !== undefined) updates.publication_request = pr;
        if (ann !== undefined) updates.announcements = ann;
      }

      const spinner = ora("Updating email preferences...").start();
      try {
        const result = await updateEmailPreferences(updates, options.user);
        const whose = result.username ? `${result.username}'s` : "Your";
        spinner.succeed(`${whose} email preferences updated:`);
        console.log();
        console.log(
          `  User approval:        ${result.user_approval ? chalk.green("enabled") : chalk.dim("disabled")}`,
        );
        console.log(
          `  Publication request:   ${result.publication_request ? chalk.green("enabled") : chalk.dim("disabled")}`,
        );
        console.log(
          `  Announcements:         ${result.announcements ? chalk.green("enabled") : chalk.dim("disabled")}`,
        );
      } catch (err) {
        spinner.fail("Failed to update preferences");
        console.error(chalk.red(errorDetail(err)));
      }
    },
  );

adminCommand.addCommand(emailPrefsCommand);

// ============================================================================
// System Notices
// ============================================================================

const noticeCommand = new Command("notice").description(
  "Manage system notices displayed to CLI users",
);

noticeCommand
  .command("list")
  .description("List all notices (including expired)")
  .action(async () => {
    if (!isAuthenticated()) {
      console.error(chalk.red("Not authenticated. Run: nemar auth login"));
      process.exit(1);
    }

    const spinner = ora("Fetching notices...").start();
    try {
      const { notices } = await listAdminNotices();
      if (notices.length === 0) {
        spinner.succeed("No notices found.");
        return;
      }

      spinner.succeed(`${notices.length} notice(s):`);
      console.log();

      for (const notice of notices) {
        // Mirrors the website's banner tones (#1025) so a level reads the
        // same in the terminal as it does on the site. `info` is retained
        // only so pre-0063 rows in a stale local cache still colourize.
        const levelColors: Record<string, (s: string) => string> = {
          critical: chalk.red.bold,
          warning: chalk.yellow,
          maintenance: chalk.magenta,
          announcement: chalk.green,
          tip: chalk.blue,
          info: chalk.blue,
        };
        const colorFn = levelColors[notice.level] || chalk.white;
        const expired =
          notice.expires_at && new Date(notice.expires_at) < new Date()
            ? chalk.dim(" (expired)")
            : "";

        console.log(
          `  ${chalk.dim(`#${notice.id}`)} ${colorFn(`[${notice.level.toUpperCase()}]`)} ${chalk.dim(`scope:${notice.scope}`)}${expired}`,
        );
        console.log(`     ${notice.message}`);
        console.log(`     ${chalk.dim(`Created: ${notice.created_at}`)}`);
        if (notice.expires_at) {
          console.log(`     ${chalk.dim(`Expires: ${notice.expires_at}`)}`);
        }
        console.log();
      }
    } catch (err) {
      handleCommandError(err, spinner, "Failed to fetch notices");
    }
  });

noticeCommand
  .command("set")
  .description("Create a new system notice")
  .requiredOption("-m, --message <text>", "Notice message text")
  .option(
    "-l, --level <level>",
    "Notice level: tip, announcement, maintenance, warning, critical",
    "tip",
  )
  .option("-s, --scope <scope>", "Target scope: all, admins, members", "all")
  .option("-e, --expires <datetime>", "Expiry datetime (ISO 8601)")
  .action(
    async (options: {
      message: string;
      level: string;
      scope: string;
      expires?: string;
    }) => {
      if (!isAuthenticated()) {
        console.error(chalk.red("Not authenticated. Run: nemar auth login"));
        process.exit(1);
      }

      // `info` stays accepted (the API normalizes it to `tip`, #1025) so
      // existing scripts don't break, but it isn't advertised in --help.
      if (![...NOTICE_LEVELS, "info"].includes(options.level as NoticeLevel)) {
        console.error(
          chalk.red(`Invalid level: ${options.level}. Use ${NOTICE_LEVELS.join(", ")}.`),
        );
        process.exit(1);
      }
      if (!["all", "admins", "members"].includes(options.scope)) {
        console.error(chalk.red(`Invalid scope: ${options.scope}. Use all, admins, or members.`));
        process.exit(1);
      }

      const spinner = ora("Creating notice...").start();
      try {
        const notice = await createNotice({
          message: options.message,
          level: options.level,
          scope: options.scope,
          expires_at: options.expires,
        });
        spinner.succeed(`Notice created (ID: ${notice.id})`);
        console.log(`  Level: ${notice.level}`);
        console.log(`  Scope: ${notice.scope}`);
        console.log(`  Message: ${notice.message}`);
        if (notice.expires_at) {
          console.log(`  Expires: ${notice.expires_at}`);
        }
      } catch (err) {
        handleCommandError(err, spinner, "Failed to create notice");
      }
    },
  );

noticeCommand
  .command("clear <id>")
  .description("Delete a notice by ID")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(async (idStr: string, options: ConfirmOptions) => {
    if (!isAuthenticated()) {
      console.error(chalk.red("Not authenticated. Run: nemar auth login"));
      process.exit(1);
    }

    const id = Number.parseInt(idStr, 10);
    if (Number.isNaN(id)) {
      console.error(chalk.red("Invalid notice ID"));
      process.exit(1);
    }

    const confirmed = await confirm(`Delete notice #${id}?`, options, false);
    if (!confirmed) return;

    const spinner = ora("Deleting notice...").start();
    try {
      await deleteNotice(id);
      spinner.succeed(`Notice #${id} deleted`);
    } catch (err) {
      handleCommandError(err, spinner, "Failed to delete notice");
    }
  });

adminCommand.addCommand(noticeCommand);

// ============================================================================
// Broadcast Notifications
// ============================================================================

adminCommand
  .command("notify")
  .description("Send an email to a group or a single user")
  .option("--to <group>", "Recipient group: all, admins, members")
  .option("--user <username>", "Send to a single user by username")
  .requiredOption("--subject <text>", "Email subject line")
  .option("--body <text>", "Email body (markdown)")
  .option("--body-file <path>", "Read email body from file (markdown)")
  .option("--dry-run", "Preview recipients without sending")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(
    async (options: {
      to?: string;
      user?: string;
      subject: string;
      body?: string;
      bodyFile?: string;
      dryRun?: boolean;
      yes?: boolean;
      no?: boolean;
    }) => {
      if (!isAuthenticated()) {
        console.error(chalk.red("Not authenticated. Run: nemar auth login"));
        process.exit(1);
      }

      // Mutual exclusion: exactly one of --to or --user
      if (options.to && options.user) {
        console.error(chalk.red("--to and --user are mutually exclusive. Provide exactly one."));
        process.exit(1);
      }
      if (!options.to && !options.user) {
        console.error(chalk.red("Provide either --to <group> or --user <username>."));
        process.exit(1);
      }

      if (options.to && !["all", "admins", "members"].includes(options.to)) {
        console.error(chalk.red(`Invalid group: ${options.to}. Use all, admins, or members.`));
        process.exit(1);
      }

      // Resolve body content
      let body: string;
      if (options.bodyFile) {
        if (!existsSync(options.bodyFile)) {
          console.error(chalk.red(`File not found: ${options.bodyFile}`));
          process.exit(1);
        }
        body = readFileSync(options.bodyFile, "utf-8");
      } else if (options.body) {
        body = options.body;
      } else {
        console.error(chalk.red("Email body required. Use --body or --body-file."));
        process.exit(1);
      }

      const target = options.user ? `user:${options.user}` : (options.to as string);
      const requestPayload = options.user
        ? { user: options.user, subject: options.subject, body }
        : { to: options.to as string, subject: options.subject, body };

      if (options.dryRun) {
        const spinner = ora("Checking recipients...").start();
        try {
          const result = await sendBroadcast({ ...requestPayload, dry_run: true });
          if ("dry_run" in result) {
            spinner.succeed(
              `Dry run: ${result.recipient_count} recipient(s) for "${result.recipient_group}"`,
            );
            console.log();
            for (const email of result.recipients) {
              console.log(`  ${email}`);
            }
          }
        } catch (err) {
          handleCommandError(err, spinner, "Failed to check recipients");
        }
        return;
      }

      // Preview and confirm
      console.log(chalk.bold("Email preview:"));
      console.log(`  To: ${chalk.cyan(target)}`);
      console.log(`  Subject: ${options.subject}`);
      console.log(`  Body: ${body.length > 100 ? `${body.substring(0, 100)}...` : body}`);
      console.log();

      const confirmPrompt = options.user
        ? `Send this email to ${options.user}?`
        : "Send this broadcast email?";
      const confirmed = await confirm(confirmPrompt, options, false);
      if (!confirmed) return;

      const spinner = ora(
        options.user ? `Sending to ${options.user}...` : "Sending broadcast...",
      ).start();
      try {
        const result = await sendBroadcast(requestPayload);

        if ("broadcast_id" in result) {
          if (result.failure_count > 0) {
            spinner.warn(
              `Email send: ${result.recipient_count} delivered, ${result.failure_count} failed`,
            );
            for (const email of result.failed_recipients) {
              console.log(chalk.red(`  Failed: ${email}`));
            }
          } else {
            const label = options.user
              ? `Email sent to ${options.user}`
              : `Broadcast sent to ${result.recipient_count} recipient(s)`;
            spinner.succeed(`${label} (ID: ${result.broadcast_id})`);
          }
        }
      } catch (err) {
        handleCommandError(err, spinner, "Failed to send email");
      }
    },
  );

// ============================================================================
// nemar admin summary check  (epic #618 / phase 2 #620)
// ============================================================================

/**
 * The dispatch path runs sequentially with a small delay between calls so a
 * bulk backfill doesn't burst GitHub's `repository_dispatch` rate limit
 * (documented at 500 events/hour per repo — sustained that's ~7.2 s between
 * calls). 1.5 s is well under that ceiling but lets a ~150-version backfill
 * finish in ~4 min instead of ~18 min at the sustained rate. The generator
 * itself runs in the runner pool, so server-side concurrency is bounded by
 * GitHub Actions queueing — we don't need additional throttling for the
 * workflow execution itself.
 */
const DISPATCH_THROTTLE_MS = 1500;

function formatState(state: SummaryVersionCoverage["state"]): string {
  switch (state.kind) {
    case "ok":
      return chalk.green(`ok    ${state.schema_version}`);
    case "stale":
      return chalk.yellow(`stale ${state.schema_version}`);
    case "missing":
      return chalk.red("missing");
    case "error":
      return chalk.red(`error ${state.status || "?"}: ${state.message}`);
  }
}

function isStale(state: SummaryVersionCoverage["state"]): boolean {
  return state.kind === "stale" || state.kind === "missing";
}

/**
 * Convert a shell-style glob to an anchored RegExp.
 *
 *   `*` → `.*`  (any run of any chars)
 *   `?` → `.`   (one of any char)
 *
 * Every other regex metacharacter is escaped, so a literal `.` in a glob
 * (e.g. `on00*.draft`) is treated as a literal `.`, not "any char". We do
 * NOT support character classes (`[abc]`) or brace expansion (`{a,b}`) —
 * if the operator needs that, they can fall back to `--id` per-target.
 *
 * Anchored with `^...$` so `on*` matches `on007315` but not `xon007315`.
 */
export function globToRegExp(glob: string): RegExp {
  // Escape regex metacharacters except `*` and `?`. The character class
  // here is the regex spec's metachar set minus the two we treat specially.
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${pattern}$`);
}

const summaryCommand = new Command("summary").description(
  "summary.json coverage across published dataset versions",
);

summaryCommand
  .command("check")
  .description("Report which (dataset_id, version) pairs have stale or missing summary.json")
  .option("--fix", "Dispatch generate-manifest for every stale/missing version")
  .option("--id <id>", "Limit to a single dataset_id (exact match)")
  .option(
    "--match <glob>",
    "Limit to dataset_ids matching a glob pattern: `*` matches any run of chars, `?` matches one char. Examples: `on*`, `nm00010?`, `*99999`. Can be combined with --id (id wins if both passed).",
  )
  .option("--only-stale", "Print only rows that are not ok (suppresses ok rows)")
  .option("--json", "Emit the full report as JSON instead of a table")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(
    async (
      options: {
        fix?: boolean;
        id?: string;
        match?: string;
        onlyStale?: boolean;
        json?: boolean;
      } & ConfirmOptions,
    ) => {
      if (!requireAuth()) return;

      const spinner = ora("Building coverage report...").start();
      let report: Awaited<ReturnType<typeof getSummaryCoverage>>;
      try {
        report = await getSummaryCoverage();
      } catch (err) {
        handleCommandError(err, spinner, "Failed to fetch coverage report");
        return;
      }
      spinner.succeed(
        `Coverage: target=schema ${report.target_schema}, versions=${report.totals.versions}`,
      );

      let rows = report.versions;
      let filterLabel: string | null = null;
      if (options.id) {
        rows = rows.filter((r) => r.dataset_id === options.id);
        filterLabel = `dataset_id=${options.id}`;
        if (rows.length === 0) {
          console.log(chalk.yellow(`No rows for ${filterLabel}`));
          return;
        }
      } else if (options.match) {
        const re = globToRegExp(options.match);
        rows = rows.filter((r) => re.test(r.dataset_id));
        filterLabel = `--match ${options.match}`;
        if (rows.length === 0) {
          console.log(chalk.yellow(`No rows match ${filterLabel}`));
          return;
        }
        console.log(chalk.dim(`Scoped to ${rows.length} version(s) matching ${options.match}`));
      }

      if (options.json) {
        // Re-emit with the same totals so the JSON consumer (cron workflow)
        // doesn't have to re-aggregate.
        console.log(
          JSON.stringify(
            filterLabel ? { ...report, versions: rows, totals: recomputeTotals(rows) } : report,
            null,
            2,
          ),
        );
        return;
      }

      const printable = options.onlyStale ? rows.filter((r) => r.state.kind !== "ok") : rows;
      if (printable.length === 0) {
        console.log(chalk.green("All versions at target schema — no drift."));
      } else {
        const idWidth = Math.max(...printable.map((r) => r.dataset_id.length), 10);
        const verWidth = Math.max(...printable.map((r) => r.version.length), 7);
        for (const r of printable) {
          console.log(
            `  ${r.dataset_id.padEnd(idWidth)}  ${r.version.padEnd(verWidth)}  ${formatState(r.state)}`,
          );
        }
      }

      // Print the totals after the per-row dump so they're the last thing on
      // screen — the operator's eye lands there for the go/no-go decision.
      const totals = filterLabel ? recomputeTotals(rows) : report.totals;
      console.log();
      console.log(
        `  Total: ${totals.versions}  ${chalk.green(`ok=${totals.ok}`)}  ` +
          `${chalk.yellow(`stale=${totals.stale}`)}  ${chalk.red(`missing=${totals.missing}`)}  ` +
          `${chalk.red(`error=${totals.error}`)}`,
      );

      if (!options.fix) {
        if (totals.stale + totals.missing > 0) {
          console.log(
            chalk.dim(
              `\nRun with --fix to dispatch generate-manifest for the ${totals.stale + totals.missing} drifted version(s).`,
            ),
          );
        }
        return;
      }

      const toDispatch = rows.filter((r) => isStale(r.state));
      if (toDispatch.length === 0) {
        console.log(chalk.green("\nNothing to dispatch."));
        return;
      }

      const scopeHint = filterLabel ? ` (scoped to ${filterLabel})` : "";
      const confirmResult = await confirm(
        `Dispatch generate-manifest for ${toDispatch.length} version(s)${scopeHint}? Each dispatch queues a runner job on nemarDatasets/.github.`,
        options,
      );
      if (confirmResult !== "confirmed") {
        console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
        return;
      }

      let dispatched = 0;
      let failed = 0;
      console.log();
      for (const [idx, r] of toDispatch.entries()) {
        const ds = `${r.dataset_id}@${r.version}`;
        const dSpinner = ora(`[${idx + 1}/${toDispatch.length}] dispatching ${ds}...`).start();
        try {
          await dispatchManifest(r.dataset_id, r.version);
          dSpinner.succeed(`[${idx + 1}/${toDispatch.length}] dispatched ${ds}`);
          dispatched++;
        } catch (err) {
          dSpinner.fail(`[${idx + 1}/${toDispatch.length}] ${ds}: ${errorDetail(err)}`);
          failed++;
        }
        // Throttle so a bulk backfill doesn't burst GitHub's dispatch rate
        // limit. Skipped on the last iteration.
        if (idx < toDispatch.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, DISPATCH_THROTTLE_MS));
        }
      }

      console.log();
      console.log(
        failed === 0
          ? chalk.green(`All ${dispatched} dispatches succeeded.`)
          : chalk.yellow(`${dispatched} succeeded, ${failed} failed.`),
      );
      console.log(
        chalk.dim(
          "Workflow runs will appear on https://github.com/nemarDatasets/.github/actions. Re-run `nemar admin summary check` once they complete to verify drift cleared.",
        ),
      );
      if (failed > 0) process.exitCode = 1;
    },
  );

function recomputeTotals(rows: SummaryVersionCoverage[]) {
  return {
    versions: rows.length,
    ok: rows.filter((r) => r.state.kind === "ok").length,
    stale: rows.filter((r) => r.state.kind === "stale").length,
    missing: rows.filter((r) => r.state.kind === "missing").length,
    error: rows.filter((r) => r.state.kind === "error").length,
  };
}

adminCommand.addCommand(summaryCommand);
