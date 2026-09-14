/**
 * Help formatting utilities for NEMAR CLI
 *
 * This module patches Commander's Command.prototype.addHelpText at load time
 * so that verbose "after" help text is suppressed unless --help-all is passed.
 * It also provides configureColorHelp() for color-coding the help output.
 *
 * IMPORTANT: This module must be imported before any Commander command modules
 * so that the prototype patch is in place when commands are constructed.
 * In index.ts, place the import of this module first.
 *
 * The prototype patch approach handles all existing .addHelpText("after", ...)
 * calls across dataset.ts, admin.ts, sandbox.ts, and auth.ts without requiring
 * individual modifications to each call site.
 */

import chalk from "chalk";
import { type Argument, Command, type Help, type Option } from "commander";
import { COMMON_COMMANDS } from "./help-groups.js";

/**
 * True when the user passed --help-all anywhere on the command line.
 * Evaluated once at module load time; process.argv is stable.
 */
export const HELP_ALL = process.argv.includes("--help-all");

// Disable chalk colors when --no-color is passed
if (process.argv.includes("--no-color")) {
  chalk.level = 0;
}

// Strip --help-all from argv so Commander doesn't reject it as unknown on
// subcommands. The HELP_ALL constant above already captured its presence.
// We replace it with --help so Commander still triggers help output.
const helpAllIdx = process.argv.indexOf("--help-all");
if (helpAllIdx !== -1) {
  process.argv[helpAllIdx] = "--help";
}

// ============================================================================
// Prototype patch (runs at module load time)
// ============================================================================

// Store original before patching. Typed as Function to work around Commander's
// overloaded addHelpText signature which can't be captured in a single variable type.
// biome-ignore lint/complexity/noBannedTypes: overloaded method reference
const originalAddHelpText: Function = Command.prototype.addHelpText;
const HINT_TEXT = "\n  Run with --help-all for examples and detailed descriptions.\n";
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
 * A command's path below the program name, space-separated, as
 * {@link COMMON_COMMANDS} keys it: `""` for the root program, `"dataset"`,
 * `"dataset publish"`. Walks `parent` rather than reading any private field.
 */
export function groupKey(cmd: Command): string {
  const parts: string[] = [];
  for (let node: Command | null = cmd; node?.parent; node = node.parent) {
    parts.unshift(node.name());
  }
  return parts.join(" ");
}

/** The formatHelp override for color-coded help output. */
const colorFormatHelp = {
  formatHelp(cmd: Command, helper: Help): string {
    const termWidth = helper.padWidth(cmd, helper);
    const helpWidth = helper.helpWidth ?? 80;
    const itemIndentWidth = 2;
    const itemSeparatorWidth = 2;

    // Format a term+description pair.
    // Uses the plain (uncolored) term for padding calculation, but the
    // colored term for display.
    //
    // Both the padding AND the wrap run on the plain string: Commander's
    // `wrap` measures with `.length`, which counts the ~19 characters of
    // ANSI escapes a colored term carries as if they occupied columns, so
    // wrapping the colored string broke every description onto a new line
    // about 20 columns early (visible on any colored `nemar dataset
    // --help`). The term is always a prefix of the wrapped result and
    // wrapping never inserts anything ahead of it, so swapping the colored
    // term back in afterwards is a pure substitution.
    function formatItem(plainTerm: string, coloredTerm: string, description: string): string {
      if (description) {
        const pad = " ".repeat(Math.max(0, termWidth + itemSeparatorWidth - plainTerm.length));
        const fullText = `${plainTerm}${pad}${description}`;
        const wrapped = helper.wrap(
          fullText,
          helpWidth - itemIndentWidth,
          termWidth + itemSeparatorWidth,
        );
        return coloredTerm + wrapped.slice(plainTerm.length);
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
      return formatItem(plain, chalk.blue(plain), helper.argumentDescription(arg));
    });
    if (argumentList.length > 0) {
      output.push(chalk.bold("Arguments:"), formatList(argumentList), "");
    }

    // Options
    const optionList = helper.visibleOptions(cmd).map((option: Option) => {
      const plain = helper.optionTerm(option);
      return formatItem(plain, chalk.cyan(plain), helper.optionDescription(option));
    });
    if (optionList.length > 0) {
      output.push(chalk.bold("Options:"), formatList(optionList), "");
    }

    // Commands (subcommands). Groups named in COMMON_COMMANDS lead with the
    // handful of commands people actually type and fold the rest into a
    // names-only line; every other group lists everything, sorted
    // alphabetically for consistent help output.
    const byName = (a: Command, b: Command): number => a.name().localeCompare(b.name());
    const describe = (subCmd: Command): string => {
      const plain = helper.subcommandTerm(subCmd);
      return formatItem(plain, chalk.bold.cyan(plain), helper.subcommandDescription(subCmd));
    };

    const visible = helper.visibleCommands(cmd);
    const common = HELP_ALL ? undefined : COMMON_COMMANDS[groupKey(cmd)];
    if (common) {
      const found = new Map(visible.map((sub: Command) => [sub.name(), sub]));
      const lead = common
        .map((name) => found.get(name))
        .filter((sub): sub is Command => sub !== undefined);
      const leadNames = new Set(lead.map((sub) => sub.name()));
      // Commander's built-in `help [command]` is excluded from the overflow
      // line: it is not a command anyone is hunting for, and `-h` in the
      // Options block above already says the same thing. `--help-all` still
      // lists it, like every other folded command.
      const rest = visible
        .filter((sub: Command) => !leadNames.has(sub.name()) && sub.name() !== "help")
        .sort(byName);

      if (lead.length > 0) {
        output.push(chalk.bold("Commands:"), formatList(lead.map(describe)), "");
      }
      if (rest.length > 0) {
        const names = rest.map((sub: Command) => sub.name()).join(", ");
        output.push(
          chalk.bold("More commands") + chalk.dim(" (--help-all for details):"),
          helper.wrap(names, helpWidth - itemIndentWidth, 0).replace(/^/gm, "  "),
          "",
        );
      }
    } else if (visible.length > 0) {
      output.push(chalk.bold("Commands:"), formatList([...visible].sort(byName).map(describe)), "");
    }

    return output.join("\n");
  },
};

/**
 * Configure Commander's help formatter to add color coding.
 * Applies recursively to the root program and all registered subcommands.
 *
 * Colors applied (Bun-style):
 *   - Section headers (Commands:, Options:, Arguments:): bold
 *   - Command names in subcommand list: bold cyan
 *   - Option flags in option list: cyan
 *   - Argument placeholders in argument list: blue
 */
export function configureColorHelp(program: Command): void {
  applyColorHelp(program);
}

function applyColorHelp(cmd: Command): void {
  cmd.configureHelp(colorFormatHelp);
  for (const sub of cmd.commands) {
    applyColorHelp(sub);
  }
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
