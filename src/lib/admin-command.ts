/**
 * Plumbing shared by the admin command groups that live in their own files (`commands/admin-*.ts`).
 *
 * `commands/admin.ts` keeps its own copies of these for the commands that are still in it. A group
 * split out of that file imports them from here instead, because a command file may not import
 * `admin.ts` (it imports the command files, and the cycle would run `adminCommand.addCommand`
 * before the group existed).
 */

import chalk from "chalk";
import type { Ora } from "ora";
import { ApiError, errorDetail } from "./api/errors.js";
import { isAuthenticated } from "./config.js";

/**
 * Hints keyed on a publication `block_reason`, which outrank the status-code
 * hint: a 422 from the publish paths is not always a CI problem, and telling
 * an admin to "fix the CI issues" when the real problem is a missing
 * researcher name sends them to the wrong place entirely (#1255).
 */
export const BLOCK_REASON_HINTS: Record<string, string> = {
  owner_name_missing:
    "Run `nemar admin backfill-names --apply` if the owner's ORCID record publishes their name; an ORCID-linked owner must otherwise make it public on ORCID and sign in again, and an owner with no linked ORCID can now type it into Settings on nemar.org (ADR 0042).",
};

/** Handle common error patterns in admin CLI commands */
export function handleCommandError(
  error: unknown,
  spinner: Ora,
  defaultMsg: string,
  hints?: Record<number, string>,
): void {
  if (error instanceof ApiError) {
    spinner.fail(error.message);
    const reasonHint = error.blockReason ? BLOCK_REASON_HINTS[error.blockReason] : undefined;
    const hint = reasonHint ?? hints?.[error.statusCode];
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
 * Check authentication and show error if not authenticated
 */
export function requireAuth(): boolean {
  if (!isAuthenticated()) {
    console.log(chalk.red("Error: Not authenticated"));
    console.log(chalk.dim("  Run 'nemar auth login' first"));
    return false;
  }
  return true;
}
