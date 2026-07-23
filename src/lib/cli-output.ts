/**
 * Shared CLI output helpers (#907, epic #902).
 *
 * requireAuth is the standard command-entry auth guard. It is a deliberate
 * exception to "lib code never calls process.exit" (import-openneuro.ts
 * predates that rule; new step modules must follow it): it exists
 * precisely to own the guard-and-exit so command actions don't repeat it
 * (it replaced 14 byte-identical inline copies in commands/dataset.ts).
 * Step functions and other lib code must NOT call process.exit — they
 * return discriminated results and the command action owns the exit.
 */

import chalk from "chalk";
import type { Ora } from "ora";
import { errorDetail } from "./api/errors.js";
import { isAuthenticated } from "./config.js";

/**
 * Exit with the standard two-line not-authenticated error unless the active
 * account has an API key. Output and exit code are byte-compatible with the
 * inline guards this replaced.
 */
export function requireAuth(): void {
  if (!isAuthenticated()) {
    console.log(chalk.red("Error: Not authenticated"));
    console.log("Run 'nemar auth login' first");
    process.exit(1);
  }
}

/**
 * Standard step-failure print: fail the spinner with a short title, then the
 * indented red detail line. Byte-compatible with the inline
 * `spinner.fail(title); console.log(chalk.red(\`  \${...}\`))` pattern it
 * replaces (errorDetail yields .message for Errors, String() otherwise).
 * Callers keep any extra remediation lines after this call.
 */
export function printStepFailure(spinner: Ora, title: string, detail: unknown): void {
  spinner.fail(title);
  console.log(chalk.red(`  ${errorDetail(detail)}`));
}
