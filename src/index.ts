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
import { datasetCommand } from "./commands/dataset.js";
import { sandboxCommand } from "./commands/sandbox.js";
import { IS_DEV_BUILD } from "./lib/api.js";
import { NO_DESCRIPTION, NO_OPTION, YES_DESCRIPTION, YES_OPTION } from "./lib/confirm.js";
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
  https://nemar-cli.pages.dev

Support:
  https://github.com/nemarOrg/nemar-cli/issues`,
  );

// Register command groups
program.addCommand(authCommand);
program.addCommand(datasetCommand);
program.addCommand(sandboxCommand);
program.addCommand(adminCommand);

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

// Update check (async on cold start, then parse)
async function main() {
  const pendingUpdate = await initUpdateCheck();

  if (pendingUpdate) {
    program.hook("postAction", () => printUpdateBanner(pendingUpdate));
    process.on("exit", () => printUpdateBanner(pendingUpdate));
  }

  await program.parseAsync();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
