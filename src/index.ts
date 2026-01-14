#!/usr/bin/env node
/**
 * NEMAR CLI - Command-line interface for NEMAR dataset management
 *
 * NEMAR: Neuroelectromagnetic Data Archive and Tools Resource
 * https://github.com/nemarDatasets
 */

import { Command } from "commander";
import { adminCommand } from "./commands/admin.js";
import { authCommand } from "./commands/auth.js";
import { datasetCommand } from "./commands/dataset.js";
import { version } from "./lib/version.js";

const program = new Command();

program
  .name("nemar")
  .description("CLI for NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)")
  .version(version, "-v, --version", "Output the current version")
  .option("--no-color", "Disable colored output")
  .option("--verbose", "Enable verbose output");

// Register command groups
program.addCommand(authCommand);
program.addCommand(datasetCommand);
program.addCommand(adminCommand);

// Parse arguments
program.parse();
