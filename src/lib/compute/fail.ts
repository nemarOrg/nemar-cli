/**
 * How the person-side compute commands fail (epic #2021 phase D3b, #2024). The exit codes are the issue's:
 * 0 done, 1 failed or refused by NEMAR, 2 refused LOCALLY (before anything was sent), 3 the wait ended
 * with the job still live. Every failure sentence goes to STANDARD ERROR, in human and in `--json` mode
 * alike, so standard output carries only an answer; every network string passes `plain()`.
 *
 * `failWith` of `admin-command.ts` is not used here because it prints a human-mode error on standard
 * output and, for any 403, advises "This command requires admin privileges", which is the wrong advice
 * for `no_compute_access`.
 */

import chalk from "chalk";
import { ACCOUNT_COPY } from "../../../shared/contract/account-copy.js";
import { isAnswered } from "../admin-command.js";
import { computeRefusalCode } from "../api/compute.js";
import { ApiError, errorDetail } from "../api/errors.js";
import { markReportedExit, unmarkReportedExit } from "../debug-log.js";
import { plain } from "../terminal-text.js";

export const EXIT_LOCAL_REFUSAL = 2;
export const EXIT_STILL_LIVE = 3;

/** What to do next, by the word of the refusal; undefined when the sentence says it all. */
export function computeHint(error: unknown): string | undefined {
  const word = computeRefusalCode(error)?.code;
  switch (word) {
    case "no_compute_access":
      return ACCOUNT_COPY["cli.compute_access.cta"];
    case "suspended":
      return ACCOUNT_COPY["compute_access.suspended.body"];
    case "job_not_found":
      return "List your jobs with `nemar compute list`.";
    case "results_expired":
      return "Results are kept for a limited time after a job ends; run the job again to make them.";
    case "bad_state":
      return "Look at the job with `nemar compute status <job>`.";
    default:
      return undefined;
  }
}

/** Print a failed request on standard error and exit 1. */
export function failCompute(error: unknown, defaultMessage: string): void {
  if (error instanceof ApiError) {
    console.error(chalk.red(plain(error.message)));
    const hint = computeHint(error);
    if (hint) console.error(chalk.dim(`  ${plain(hint)}`));
  } else {
    console.error(chalk.red(defaultMessage));
    console.error(chalk.dim(`  Error details: ${plain(errorDetail(error))}`));
  }
  process.exitCode = 1;
  if (isAnswered(error)) markReportedExit();
  else unmarkReportedExit();
}

/** Print a failure that has a sentence of its own and exit 1. `answered` suppresses the bug-report hint. */
export function failText(message: string, opts: { answered: boolean; hint?: string }): void {
  console.error(chalk.red(plain(message)));
  if (opts.hint) console.error(chalk.dim(`  ${plain(opts.hint)}`));
  process.exitCode = 1;
  if (opts.answered) markReportedExit();
  else unmarkReportedExit();
}

/** A refusal before anything was sent: the lines on standard error, exit 2. Never a bug. */
export function refuseLocally(lines: readonly string[], detail: readonly string[] = []): void {
  const [first, ...rest] = lines;
  if (first !== undefined) console.error(chalk.red(plain(first)));
  for (const line of [...rest, ...detail])
    console.error(line.startsWith("  ") ? line : `  ${line}`);
  process.exitCode = EXIT_LOCAL_REFUSAL;
  markReportedExit();
}
