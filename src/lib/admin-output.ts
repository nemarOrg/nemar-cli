/**
 * Where a command of `nemar admin publish` writes what is not its answer, and how it fails.
 *
 * With `--json` the command's answer is one document on standard output, and everything else (an
 * error, a refusal, a prompt's notice) goes to standard error, so `nemar ... --json | jq` never
 * reads a sentence. Without it everything goes to the terminal as before. The failure path is
 * `failWith`'s (`admin-command.ts`) with the two differences the review's commands need: the Worker's
 * sentence passes `plain()` before it is printed, and there is no spinner to fail under `--json`.
 */

import chalk from "chalk";
import type { Ora } from "ora";
import { ApiError, errorDetail } from "./api/errors.js";
import { isAuthenticated } from "./config.js";
import { markReportedExit } from "./debug-log.js";
import { plain } from "./terminal-text.js";

/** A line sink: standard error under `--json`, standard output otherwise. */
export function say(json: boolean | undefined): (line: string) => void {
  return json ? (line) => console.error(line) : (line) => console.log(line);
}

/**
 * Check authentication: when nobody is signed in, say so (on standard error under `--json`), set
 * the exit code to 1 and return false so the caller can `return`. The message already says what to
 * do, so the bug-report hint is suppressed.
 */
export function signedIn(json?: boolean): boolean {
  if (isAuthenticated()) return true;
  const out = say(json);
  out(chalk.red("Error: Not authenticated"));
  out(chalk.dim("  Run 'nemar auth login' first"));
  process.exitCode = 1;
  markReportedExit();
  return false;
}

/**
 * Report a failure and exit 1. A refusal or a not-found (a 4xx) is the Worker's answer and not a
 * crash, so the "attach the log to a new issue" hint is suppressed; a 5xx, a network failure and
 * anything that is not an `ApiError` may be a bug and keep it.
 */
export function reportFailure(
  error: unknown,
  spinner: Ora | null,
  fallback: string,
  json?: boolean,
): void {
  const out = say(json);
  const message = error instanceof ApiError ? plain(error.message) : fallback;
  if (spinner) spinner.fail(message);
  else out(chalk.red(message));
  if (error instanceof ApiError) {
    if (error.statusCode === 403) out(chalk.dim("  This command requires admin privileges"));
  } else {
    out(chalk.dim(`  Error details: ${plain(errorDetail(error))}`));
  }
  process.exitCode = 1;
  if (error instanceof ApiError && error.statusCode >= 400 && error.statusCode < 500) {
    markReportedExit();
  }
}
