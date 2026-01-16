#!/usr/bin/env node
/**
 * NEMAR CLI - Command-line interface for NEMAR dataset management
 *
 * NEMAR: Neuroelectromagnetic Data Archive and Tools Resource
 * https://github.com/nemarDatasets
 *
 * Note: The canonical commands use a two-prong structure (e.g., nemar auth login)
 * following CLI best practices for discoverability. Root-level shortcuts
 * (nemar login, nemar whoami, etc.) are provided as convenience aliases.
 */

import { Command } from "commander";
import { adminCommand } from "./commands/admin.js";
import {
  authCommand,
  loginAction,
  logoutAction,
  signupAction,
  statusAction,
} from "./commands/auth.js";
import { datasetCommand } from "./commands/dataset.js";
import { sandboxCommand } from "./commands/sandbox.js";
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
  https://github.com/nemarDatasets/nemar-cli/issues`,
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
  .option("-f, --force", "Skip confirmation if already logged in")
  .action(loginAction);

program
  .command("logout")
  .description("Clear stored credentials (shortcut for 'auth logout')")
  .option("-f, --force", "Skip confirmation prompt")
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

// Parse arguments
program.parse();
