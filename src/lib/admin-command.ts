/**
 * Plumbing shared by the admin command groups that live in their own files (`commands/admin-*.ts`).
 *
 * A command file may not import `admin.ts`: it imports the command files, and the cycle would run
 * `adminCommand.addCommand` before the group existed. So what a group needs from it lives here.
 * `handleCommandError` is `admin.ts`'s own, moved, and `admin.ts` imports it back. `failWith` and
 * `requireSignedIn` are for a group that exits non-zero on every failure (#1581); the commands that
 * are still in `admin.ts` print and exit 0 for the same failures, which is left to a follow-up.
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
 * `handleCommandError`, then the exit code of a failure. The one way a command of a group that
 * exits non-zero reports an error, so no failure path can print without failing (#1581).
 */
export function failWith(
  error: unknown,
  spinner: Ora,
  defaultMsg: string,
  hints?: Record<number, string>,
): void {
  handleCommandError(error, spinner, defaultMsg, hints);
  process.exitCode = 1;
}

/**
 * Check authentication: when nobody is signed in, say so, set the exit code to 1 and return false
 * so the caller can `return`. A command that is not signed in has done nothing, and a script has to
 * be able to tell.
 */
export function requireSignedIn(): boolean {
  if (!isAuthenticated()) {
    console.log(chalk.red("Error: Not authenticated"));
    console.log(chalk.dim("  Run 'nemar auth login' first"));
    process.exitCode = 1;
    return false;
  }
  return true;
}
