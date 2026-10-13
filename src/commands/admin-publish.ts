/**
 * `nemar admin publish`: the publication workflow, from the administrator's side.
 *
 *   nemar admin publish list [--status <s>]    the publication requests, with the identifier screen
 *   nemar admin publish deny <ds> [-r <why>]   deny one, mailing the depositor the reason
 *   nemar admin publish screen <ds>            run the identifier screen of a request again
 *   nemar admin publish approve <ds>           approve and publish (admin-publish-approve.ts)
 *
 * Split out of `admin.ts` (epic #1726, phase 2) so the publication review's commands do not grow
 * a file of ten thousand lines. The group is registered on `adminCommand` at the position it
 * always had, so `nemar admin --help` is unchanged; `approve` has its own file and is registered
 * on this group at the end, so the subcommands keep their order.
 */

import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import { handleCommandError, requireAuth } from "../lib/admin-command.js";
import { denyPublication, listPublishRequests, rerunIdentifierScreen } from "../lib/api/publish.js";
import {
  type ConfirmOptions,
  NO_DESCRIPTION,
  NO_OPTION,
  YES_DESCRIPTION,
  YES_OPTION,
  confirm,
} from "../lib/confirm.js";
import { identifierScreenLines } from "../lib/identifier-screen-display.js";
import { registerApproveCommand } from "./admin-publish-approve.js";

export const publishCommand = new Command("publish").description("Publication workflow management");

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
        // #1408: an anonymous release and a publication reach this list
        // looking identical, and approving the wrong one is not reversible in
        // either direction -- publishing names a depositor who asked to be
        // concealed; releasing anonymously withholds a DOI someone needs.
        if (req.anonymous === 1) {
          console.log(
            `    ${chalk.yellow("! anonymous release:")} ${chalk.dim(
              "repository stays private, DOI stays reserved, depositor is not named",
            )}`,
          );
        }
        // Epic #1610 phase 4: the identifier screen, in the backend's words.
        for (const line of identifierScreenLines(req.identifier_screen, 4)) console.log(line);
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
  .command("screen")
  .description("Re-run the identifier screen of a publication request")
  .argument("<dataset-id>", "Dataset ID")
  .addHelpText(
    "after",
    `
Description:
  Dispatch the identifier screen again for the dataset's active publication
  request (requested or blocked). Use it when the screen did not run, did not
  report, or read a commit that is no longer the repository's main. The admins
  are mailed when it reports, as for a new request.

  Refused while a screen is already running and recent, and for sandbox (xx)
  datasets, which are not screened.

Examples:
  $ nemar admin publish screen nm000104`,
  )
  .action(async (datasetId: string) => {
    if (!requireAuth()) return;
    const spinner = ora(`Re-running the identifier screen for ${datasetId}...`).start();
    try {
      const result = await rerunIdentifierScreen(datasetId);
      if (result.status === "pending") {
        spinner.succeed(`Identifier screen dispatched for ${datasetId}`);
        console.log(chalk.dim("  The admins are mailed when it reports."));
      } else {
        spinner.warn(`The identifier screen for ${datasetId} could not be started`);
        for (const line of identifierScreenLines(result.identifier_screen)) console.log(line);
        console.log(chalk.dim("  The admins have been mailed this result."));
      }
    } catch (error) {
      handleCommandError(error, spinner, "Failed to re-run the identifier screen");
      process.exitCode = 1;
    }
  });

registerApproveCommand(publishCommand);
