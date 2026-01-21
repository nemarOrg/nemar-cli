/**
 * Confirmation utility for CLI commands
 *
 * Provides consistent --yes/-y and --no/-n flag handling across all commands.
 * Supports both simple confirmations and type-to-confirm patterns.
 */

import inquirer from "inquirer";

/**
 * Options for confirmation prompts
 */
export interface ConfirmOptions {
  /** Skip prompt and auto-confirm (--yes flag) */
  yes?: boolean;
  /** Skip prompt and auto-decline (--no flag) */
  no?: boolean;
}

/**
 * Result of a confirmation check
 */
export type ConfirmResult = "confirmed" | "declined" | "cancelled";

/**
 * Ask for confirmation with --yes/--no flag support
 *
 * @param message - The confirmation message to display
 * @param options - Options containing yes/no flags
 * @param defaultValue - Default value for interactive prompt (default: false)
 * @returns Promise<ConfirmResult> - "confirmed", "declined", or "cancelled"
 *
 * @example
 * ```typescript
 * const result = await confirm("Delete this file?", options);
 * if (result !== "confirmed") {
 *   console.log(result === "declined" ? "Skipped" : "Cancelled");
 *   return;
 * }
 * // proceed with deletion
 * ```
 */
export async function confirm(
  message: string,
  options: ConfirmOptions,
  defaultValue = false,
): Promise<ConfirmResult> {
  // --no flag takes precedence (explicit decline)
  if (options.no) {
    return "declined";
  }

  // --yes flag auto-confirms
  if (options.yes) {
    return "confirmed";
  }

  // Interactive prompt
  const { confirmed } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirmed",
      message,
      default: defaultValue,
    },
  ]);

  return confirmed ? "confirmed" : "cancelled";
}

/**
 * Ask for type-to-confirm with --yes/--no flag support
 *
 * For destructive operations where user must type a specific value to confirm.
 *
 * @param message - The confirmation message to display
 * @param expectedValue - The value user must type to confirm
 * @param options - Options containing yes/no flags
 * @returns Promise<ConfirmResult> - "confirmed", "declined", or "cancelled"
 *
 * @example
 * ```typescript
 * const result = await confirmWithInput(
 *   `Type '${username}' to confirm deletion:`,
 *   username,
 *   options
 * );
 * if (result !== "confirmed") {
 *   console.log("Cancelled");
 *   return;
 * }
 * ```
 */
export async function confirmWithInput(
  message: string,
  expectedValue: string,
  options: ConfirmOptions,
): Promise<ConfirmResult> {
  // --no flag takes precedence (explicit decline)
  if (options.no) {
    return "declined";
  }

  // --yes flag auto-confirms
  if (options.yes) {
    return "confirmed";
  }

  // Interactive prompt with validation
  const { input } = await inquirer.prompt([
    {
      type: "input",
      name: "input",
      message,
      validate: (value) => {
        if (value !== expectedValue) {
          return `Input does not match. Expected: ${expectedValue}`;
        }
        return true;
      },
    },
  ]);

  return input === expectedValue ? "confirmed" : "cancelled";
}

/**
 * Commander.js option string for --yes/-y flag
 */
export const YES_OPTION = "-y, --yes";

/**
 * Commander.js option string for --no/-n flag
 */
export const NO_OPTION = "-n, --no";

/**
 * Description for --yes flag
 */
export const YES_DESCRIPTION = "Skip confirmation and proceed";

/**
 * Description for --no flag
 */
export const NO_DESCRIPTION = "Skip confirmation and decline";
