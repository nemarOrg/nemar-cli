/**
 * Help formatting utilities for NEMAR CLI
 *
 * This module patches Commander's Command.prototype.addHelpText at load time
 * so that verbose "after" help text is suppressed unless --help-all is passed.
 * It also exports configureColorHelp() for color-coding the help output.
 *
 * IMPORTANT: This module must be imported before any Commander command modules
 * so that the prototype patch is in place when commands are constructed.
 * In index.ts, place the import of this module first.
 */

import chalk from "chalk";
import { Command, type Argument, type Help, type Option } from "commander";

/**
 * True when the user passed --help-all anywhere on the command line.
 * Evaluated once at module load time; process.argv is stable.
 */
export const HELP_ALL = process.argv.includes("--help-all");

// ============================================================================
// Prototype patch (runs at module load time)
// ============================================================================

const originalAddHelpText = Command.prototype.addHelpText;
const HINT_TEXT = `\n  Run with --help-all for examples and detailed descriptions.\n`;
// Track commands that already have the hint appended (avoid duplicates)
const hintedCmds = new WeakSet<Command>();

/**
 * Patched addHelpText: intercepts "after" help text and either shows the full
 * content (--help-all) or a single hint line (default concise mode).
 */
Command.prototype.addHelpText = function (
  position: "beforeAll" | "before" | "after" | "afterAll",
  text: string | ((context: { error: boolean; command: Command }) => string),
): Command {
  if (position === "after" || position === "afterAll") {
    if (HELP_ALL) {
      return originalAddHelpText.call(this, position, text);
    }
    // In concise mode: show the hint only once per command
    if (!hintedCmds.has(this)) {
      hintedCmds.add(this);
      return originalAddHelpText.call(this, position, HINT_TEXT);
    }
    // Skip subsequent "after" calls on the same command
    return this;
  }
  // "before" and "beforeAll": pass through unchanged
  return originalAddHelpText.call(this, position, text);
};

// ============================================================================
// Color help formatter
// ============================================================================

/**
 * Configure Commander's help formatter to add color coding.
 * Call this once on the root program after creating it.
 *
 * Colors applied:
 *   - Section headers (Commands:, Options:, Arguments:): bold
 *   - Command names in subcommand list: cyan
 *   - Option flags in option list: green
 *   - Argument placeholders in argument list: yellow
 */
export function configureColorHelp(program: Command): void {
  program.configureHelp({
    formatHelp(cmd: Command, helper: Help): string {
      const termWidth = helper.padWidth(cmd, helper);
      const helpWidth = helper.helpWidth ?? 80;
      const itemIndentWidth = 2;
      const itemSeparatorWidth = 2;

      // Format a term+description pair.
      // Uses the plain (uncolored) term for padding calculation, but the
      // colored term for display.
      function formatItem(plainTerm: string, coloredTerm: string, description: string): string {
        if (description) {
          const pad = " ".repeat(Math.max(0, termWidth + itemSeparatorWidth - plainTerm.length));
          const fullText = `${coloredTerm}${pad}${description}`;
          return helper.wrap(fullText, helpWidth - itemIndentWidth, termWidth + itemSeparatorWidth);
        }
        return coloredTerm;
      }

      function formatList(textArray: string[]): string {
        return textArray.join("\n").replace(/^/gm, " ".repeat(itemIndentWidth));
      }

      const output: string[] = [];

      // Usage line
      output.push(`Usage: ${helper.commandUsage(cmd)}`, "");

      // Description
      const commandDescription = helper.commandDescription(cmd);
      if (commandDescription.length > 0) {
        output.push(helper.wrap(commandDescription, helpWidth, 0), "");
      }

      // Arguments
      const argumentList = helper.visibleArguments(cmd).map((arg: Argument) => {
        const plain = helper.argumentTerm(arg);
        return formatItem(plain, chalk.yellow(plain), helper.argumentDescription(arg));
      });
      if (argumentList.length > 0) {
        output.push(chalk.bold("Arguments:"), formatList(argumentList), "");
      }

      // Options
      const optionList = helper.visibleOptions(cmd).map((option: Option) => {
        const plain = helper.optionTerm(option);
        return formatItem(plain, chalk.green(plain), helper.optionDescription(option));
      });
      if (optionList.length > 0) {
        output.push(chalk.bold("Options:"), formatList(optionList), "");
      }

      // Commands (subcommands)
      const commandList = helper.visibleCommands(cmd).map((subCmd: Command) => {
        const plain = helper.subcommandTerm(subCmd);
        return formatItem(plain, chalk.cyan(plain), helper.subcommandDescription(subCmd));
      });
      if (commandList.length > 0) {
        output.push(chalk.bold("Commands:"), formatList(commandList), "");
      }

      return output.join("\n");
    },
  });
}

/**
 * Explicit helper: use this for new "after" help text that should respect
 * the --help-all flag. Functionally equivalent to calling .addHelpText("after", ...)
 * after the prototype patch is active, but more explicit about the intent.
 */
export function addVerboseHelp(cmd: Command, text: string): void {
  if (HELP_ALL) {
    originalAddHelpText.call(cmd, "after", text);
  } else if (!hintedCmds.has(cmd)) {
    hintedCmds.add(cmd);
    originalAddHelpText.call(cmd, "after", HINT_TEXT);
  }
}
