/**
 * Authentication commands for NEMAR CLI
 *
 * Commands:
 * - nemar auth login    - Interactive login with API key
 * - nemar auth signup   - Register new account
 * - nemar auth status   - Check authentication status
 * - nemar auth logout   - Clear stored credentials
 */

import chalk from "chalk";
import { Command } from "commander";
import { clearConfig, getConfig, getConfigPath, isAuthenticated } from "../lib/config.js";

export const authCommand = new Command("auth").description("Authentication management");

// Login command
authCommand
  .command("login")
  .description("Login with API key (obtain from admin after approval)")
  .option("-k, --key <key>", "API key (or set NEMAR_API_KEY environment variable)")
  .action(async (options) => {
    console.log(chalk.yellow("Login command not yet implemented"));
    console.log("Will prompt for API key and validate with backend");
    // TODO: Implement login flow
    // 1. Check for API key in options or environment
    // 2. Validate key with backend
    // 3. Store credentials
  });

// Signup command
authCommand
  .command("signup")
  .description("Register for a new NEMAR account")
  .action(async () => {
    console.log(chalk.yellow("Signup command not yet implemented"));
    console.log("Will prompt for:");
    console.log("  - NEMAR username");
    console.log("  - Email address");
    console.log("  - Password");
    console.log("  - GitHub username (required for PR collaboration)");
    console.log("");
    console.log("Then send verification email and await admin approval");
    // TODO: Implement signup flow
    // 1. Prompt for NEMAR username, email, password
    // 2. Prompt for GitHub username (validate it exists via GitHub API)
    // 3. Send registration request to backend
    // 4. Instruct user to verify email
    // 5. Inform about admin approval process
    // 6. After approval, user can merge PRs via GitHub with their own account
  });

// Status command
authCommand
  .command("status")
  .description("Check current authentication status")
  .action(() => {
    const authenticated = isAuthenticated();
    const config = getConfig();

    if (authenticated) {
      console.log(chalk.green("Authenticated"));
      if (config.username) {
        console.log(`  NEMAR Username: ${config.username}`);
      }
      if (config.email) {
        console.log(`  Email: ${config.email}`);
      }
      if (config.githubUsername) {
        console.log(`  GitHub: @${config.githubUsername}`);
      }
      console.log(`  Config: ${getConfigPath()}`);
    } else {
      console.log(chalk.yellow("Not authenticated"));
      console.log("Run 'nemar auth login' to authenticate");
      console.log("Or 'nemar auth signup' to create an account");
    }
  });

// Logout command
authCommand
  .command("logout")
  .description("Clear stored credentials")
  .action(() => {
    if (!isAuthenticated()) {
      console.log(chalk.yellow("Not currently authenticated"));
      return;
    }

    clearConfig();
    console.log(chalk.green("Successfully logged out"));
    console.log("Credentials have been cleared");
  });
