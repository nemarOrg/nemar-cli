#!/usr/bin/env node
/**
 * NEMAR CLI - Command-line interface for NEMAR dataset management
 *
 * NEMAR: Neuroelectromagnetic Data Archive and Tools Resource
 * https://github.com/nemarOrg
 *
 * Note: The canonical commands use a two-prong structure (e.g., nemar auth login)
 * following CLI best practices for discoverability. Root-level shortcuts
 * (nemar login, nemar whoami, etc.) are provided as convenience aliases.
 */

// IMPORTANT: help.ts must be imported first. It patches Commander's
// Command.prototype.addHelpText at module load time so that all subsequent
// command module imports pick up the concise-by-default help behavior.
import { configureColorHelp } from "./lib/help.js";

import chalk from "chalk";
import { Command } from "commander";
import { adminCommand } from "./commands/admin.js";
import {
  authCommand,
  loginAction,
  logoutAction,
  signupAction,
  statusAction,
  switchAction,
} from "./commands/auth.js";
import { completionCommand } from "./commands/completion.js";
import { datasetCommand } from "./commands/dataset.js";
import { doctorCommand } from "./commands/doctor.js";
import { sandboxCommand } from "./commands/sandbox.js";
import { IS_DEV_BUILD } from "./lib/api/client.js";
import { MaintenanceError, errorDetail } from "./lib/api/errors.js";
import { runComplete } from "./lib/completion/run.js";
import { NO_DESCRIPTION, NO_OPTION, YES_DESCRIPTION, YES_OPTION } from "./lib/confirm.js";
import { printMaintenanceBanner } from "./lib/maintenance-banner.js";
import { fetchAndDisplayNotices } from "./lib/notices.js";
import { initUpdateCheck, printUpdateBanner } from "./lib/update-check.js";
import { version } from "./lib/version.js";

const program = new Command();

program
  .name("nemar")
  .description(
    `CLI for NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)

NEMAR is a curated repository for neurophysiology data in BIDS format.
This CLI provides tools for uploading, downloading, and managing datasets.`,
  )
  .version(version, "-v, --version", "Output the current version")
  .option("--no-color", "Disable colored output")
  .option("--verbose", "Enable verbose output")
  .option("--help-all", "Show detailed help with examples and descriptions")
  .addHelpText(
    "after",
    `
Examples:
  $ nemar auth login              # Authenticate with your API key
  $ nemar dataset validate ./my-dataset
  $ nemar dataset upload ./my-dataset -n "My EEG Dataset"
  $ nemar dataset download nm000104

Documentation:
  https://docs.nemar.org

Support:
  https://github.com/nemarOrg/nemar-cli/issues`,
  );

// Register command groups
program.addCommand(authCommand);
program.addCommand(datasetCommand);
program.addCommand(sandboxCommand);
program.addCommand(adminCommand);
program.addCommand(doctorCommand);
program.addCommand(completionCommand);

// ============================================================================
// Root-level shortcuts (convenience aliases)
// Note: The canonical commands are under 'nemar auth <cmd>'. These shortcuts
// are provided for user convenience but are not the primary entry point.
// ============================================================================

program
  .command("login")
  .description("Authenticate with your API key (shortcut for 'auth login')")
  .option("-k, --key <key>", "API key (alternative: set NEMAR_API_KEY env var)")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(loginAction);

program
  .command("logout")
  .description("Remove the active account (shortcut for 'auth logout')")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .option("--all", "Remove all stored accounts")
  .action(logoutAction);

program
  .command("signup")
  .description("Register for a new account (shortcut for 'auth signup')")
  .action(signupAction);

program
  .command("register")
  .description("Register for a new account (alias for signup)")
  .action(signupAction);

program
  .command("whoami")
  .description("Show current user (shortcut for 'auth status')")
  .option("--refresh", "Refresh user info from server")
  .action(statusAction);

program
  .command("switch [username]")
  .description("Switch between accounts (shortcut for 'auth switch')")
  .action(switchAction);

// Apply color formatting to all commands (must be after addCommand calls)
configureColorHelp(program);

// Display system notices before command execution
program.hook("preAction", async () => {
  await fetchAndDisplayNotices();
});

// Warn if running a dev build (injected URL via CI)
if (IS_DEV_BUILD) {
  console.warn(
    chalk.yellow.bold("[DEV BUILD]") +
      chalk.yellow(" Connected to development backend. Not for production use."),
  );
}

/**
 * Index into `argv` (already `process.argv.slice(2)`) of the `__complete`
 * token, or null if this is not a completion invocation. `argv[2]` alone is
 * not reliable: a global flag typed before the subcommand (`nemar --verbose
 * __complete -- ...`) shifts `__complete` to a later position, and checking
 * position 2 positionally missed it entirely (#1173 review) -- the guard
 * below never fired, so the request fell through to `initUpdateCheck()` and
 * paid a real blocking fetch before Commander finally rejected it as an
 * unknown command.
 *
 * Every global option this program declares (`--no-color`, `--verbose`,
 * `--help-all`, `-v`/`--version`) is boolean, so "the first token that is
 * not itself a flag" is unambiguous here: it is either `__complete` or the
 * name of a subcommand. `nemar dataset get __complete` must NOT dispatch --
 * `dataset` is that first non-flag token, and `__complete` there is just an
 * (unusual) positional argument to `dataset get`.
 */
function findCompletionArgsStart(argv: string[]): number | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("-")) continue;
    return argv[i] === "__complete" ? i : null;
  }
  return null;
}

// Initialize update check before parsing (may block up to 5s on first run)
async function main() {
  // Shell completion (epic #1144 phase 5b, #1149, D1). This guard does two
  // separable things; an earlier version of this comment conflated them and
  // asserted something false (#1173 review).
  //
  // 1. It DISPATCHES `__complete`, which is deliberately not a registered
  //    Commander command. Falling through to parseAsync() would not run it
  //    slowly -- it would not run it at all: Commander's _findCommand finds
  //    no match, takes the unknownCommand() branch, and exits 1 with
  //    "error: unknown command '__complete'" BEFORE any preAction hook can
  //    fire. Verified by disabling this guard and running it.
  // 2. Sitting ABOVE initUpdateCheck() is what avoids the one network cost
  //    that is real on this path today: on a cold cache initUpdateCheck()
  //    does a blocking fetch (see update-check.ts), and it runs before
  //    parseAsync() regardless of which command was typed.
  //
  // The preAction hook's unconditional GET /notices is a hazard of the
  // ALTERNATIVE design, not of this one: it is why `__complete` is not
  // registered as a normal command (see commands/completion.ts), not
  // something this early return is currently skipping.
  //
  // The budget is ~100ms and __complete must touch the network zero times --
  // not even with a timeout, since a timeout still pays DNS and connect on
  // exactly the networks where someone is offline pressing TAB.
  const completionArgsStart = findCompletionArgsStart(process.argv.slice(2));
  if (completionArgsStart !== null) {
    await runComplete(program, process.argv.slice(2 + completionArgsStart + 1));
    return;
  }

  const pendingUpdate = await initUpdateCheck();

  if (pendingUpdate) {
    // postAction fires after commands; exit handler covers --help/--version
    // where postAction does not fire. printUpdateBanner is internally
    // idempotent (prints at most once per process).
    program.hook("postAction", () => printUpdateBanner(pendingUpdate));
    process.on("exit", () => printUpdateBanner(pendingUpdate));
  }

  await program.parseAsync();
}

main().catch((err) => {
  if (err instanceof MaintenanceError) {
    printMaintenanceBanner(err);
    process.exit(1);
  }
  console.error(errorDetail(err));
  process.exit(1);
});
