/**
 * Authentication commands for NEMAR CLI
 *
 * Commands:
 * - nemar auth login    - Authenticate with API key
 * - nemar auth signup   - Register new account
 * - nemar auth status   - Check authentication status
 * - nemar auth logout   - Clear stored credentials
 */

import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import { clearConfig, getConfig, getConfigPath, isAuthenticated, setConfig } from "../lib/config.js";
import { ApiError, getCurrentUser, login, resendVerification, signup } from "../lib/api.js";

export const authCommand = new Command("auth").description("Authentication management");

// ============================================================================
// Login
// ============================================================================

authCommand
  .command("login")
  .description("Authenticate with your API key")
  .option("-k, --key <key>", "API key (or set NEMAR_API_KEY env variable)")
  .action(async (options) => {
    // Check for existing authentication
    if (isAuthenticated()) {
      const config = getConfig();
      console.log(chalk.yellow(`Already logged in as ${config.username || "unknown"}`));
      const { confirm } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirm",
          message: "Do you want to log in with a different account?",
          default: false,
        },
      ]);
      if (!confirm) return;
    }

    // Get API key from options, environment, or prompt
    let apiKey = options.key || process.env.NEMAR_API_KEY;

    if (!apiKey) {
      const answers = await inquirer.prompt([
        {
          type: "password",
          name: "apiKey",
          message: "Enter your API key:",
          mask: "*",
          validate: (input) => {
            if (!input || input.length < 32) {
              return "Please enter a valid API key";
            }
            return true;
          },
        },
      ]);
      apiKey = answers.apiKey;
    }

    // Validate with backend
    const spinner = ora("Validating API key...").start();

    try {
      const result = await login(apiKey);

      if (!result.valid) {
        spinner.fail("Invalid API key");
        return;
      }

      // Store credentials
      setConfig("apiKey", apiKey);
      setConfig("username", result.user.username);
      setConfig("email", result.user.email);
      setConfig("githubUsername", result.user.github_username);

      spinner.succeed("Login successful");
      console.log();
      console.log(`  Welcome back, ${chalk.cyan(result.user.username)}!`);
      if (result.user.is_admin) {
        console.log(`  ${chalk.magenta("Admin access enabled")}`);
      }
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
        if (error.statusCode === 401) {
          console.log(chalk.gray("  Check that your API key is correct"));
        } else if (error.statusCode === 403) {
          console.log(chalk.gray("  Your account may not be approved yet"));
        }
      } else {
        spinner.fail("Connection failed");
        console.log(chalk.gray("  Check your internet connection"));
      }
    }
  });

// ============================================================================
// Signup
// ============================================================================

authCommand
  .command("signup")
  .description("Register for a new NEMAR account")
  .action(async () => {
    console.log(chalk.cyan("NEMAR Account Registration"));
    console.log(chalk.gray("Create an account to upload and manage datasets\n"));

    // Collect user information
    const answers = await inquirer.prompt([
      {
        type: "input",
        name: "username",
        message: "Choose a username:",
        validate: (input) => {
          if (!input || input.length < 3) {
            return "Username must be at least 3 characters";
          }
          if (input.length > 30) {
            return "Username must be at most 30 characters";
          }
          if (!/^[a-zA-Z0-9_-]+$/.test(input)) {
            return "Username can only contain letters, numbers, underscores, and hyphens";
          }
          return true;
        },
      },
      {
        type: "input",
        name: "email",
        message: "Email address:",
        validate: (input) => {
          if (!input || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) {
            return "Please enter a valid email address";
          }
          return true;
        },
      },
      {
        type: "password",
        name: "password",
        message: "Password (min 12 characters):",
        mask: "*",
        validate: (input) => {
          if (!input || input.length < 12) {
            return "Password must be at least 12 characters";
          }
          if (input.length > 128) {
            return "Password must be at most 128 characters";
          }
          return true;
        },
      },
      {
        type: "password",
        name: "confirmPassword",
        message: "Confirm password:",
        mask: "*",
        validate: (input, answers) => {
          if (input !== answers?.password) {
            return "Passwords do not match";
          }
          return true;
        },
      },
      {
        type: "input",
        name: "github_username",
        message: "GitHub username (for PR collaboration):",
        validate: (input) => {
          if (!input || input.length < 1) {
            return "GitHub username is required for PR collaboration";
          }
          if (input.length > 39) {
            return "GitHub username is too long";
          }
          return true;
        },
      },
    ]);

    // Register with backend
    const spinner = ora("Creating account...").start();

    try {
      const result = await signup({
        username: answers.username,
        email: answers.email,
        password: answers.password,
        github_username: answers.github_username,
      });

      spinner.succeed("Account created");
      console.log();
      console.log(chalk.green("Registration successful!"));
      console.log();
      console.log("Next steps:");
      result.next_steps.forEach((step, i) => {
        console.log(`  ${i + 1}. ${step}`);
      });
      console.log();
      console.log(chalk.gray("Once approved, use 'nemar auth login' with your API key"));
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
        if (error.details && Array.isArray(error.details)) {
          error.details.forEach((detail) => {
            console.log(chalk.gray(`  - ${detail}`));
          });
        }
      } else {
        spinner.fail("Registration failed");
        console.log(chalk.gray("  Check your internet connection and try again"));
      }
    }
  });

// ============================================================================
// Status
// ============================================================================

authCommand
  .command("status")
  .description("Check current authentication status")
  .option("--refresh", "Refresh user info from server")
  .action(async (options) => {
    const authenticated = isAuthenticated();
    const config = getConfig();

    if (!authenticated) {
      console.log(chalk.yellow("Not authenticated"));
      console.log();
      console.log("  Run 'nemar auth login' to authenticate");
      console.log("  Run 'nemar auth signup' to create an account");
      return;
    }

    // If refresh requested, fetch latest from server
    if (options.refresh) {
      const spinner = ora("Fetching user info...").start();
      try {
        const user = await getCurrentUser();
        setConfig("username", user.username);
        setConfig("email", user.email);
        setConfig("githubUsername", user.github_username);
        spinner.stop();
      } catch (error) {
        spinner.fail("Could not refresh user info");
        if (error instanceof ApiError && error.statusCode === 401) {
          console.log(chalk.gray("  Your session may have expired. Try logging in again."));
        }
      }
    }

    // Display status
    console.log(chalk.green("Authenticated"));
    console.log();
    if (config.username) {
      console.log(`  Username: ${chalk.cyan(config.username)}`);
    }
    if (config.email) {
      console.log(`  Email:    ${config.email}`);
    }
    if (config.githubUsername) {
      console.log(`  GitHub:   @${config.githubUsername}`);
    }
    console.log(`  Config:   ${chalk.gray(getConfigPath())}`);
  });

// ============================================================================
// Logout
// ============================================================================

authCommand
  .command("logout")
  .description("Clear stored credentials")
  .option("-f, --force", "Skip confirmation prompt")
  .action(async (options) => {
    if (!isAuthenticated()) {
      console.log(chalk.yellow("Not currently authenticated"));
      return;
    }

    const config = getConfig();

    if (!options.force) {
      const { confirm } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirm",
          message: `Log out ${config.username || "current user"}?`,
          default: false,
        },
      ]);
      if (!confirm) return;
    }

    clearConfig();
    console.log(chalk.green("Logged out successfully"));
  });

// ============================================================================
// Resend Verification
// ============================================================================

authCommand
  .command("resend-verification")
  .description("Resend email verification link")
  .action(async () => {
    const { email } = await inquirer.prompt([
      {
        type: "input",
        name: "email",
        message: "Enter your email address:",
        validate: (input) => {
          if (!input || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) {
            return "Please enter a valid email address";
          }
          return true;
        },
      },
    ]);

    const spinner = ora("Sending verification email...").start();

    try {
      const result = await resendVerification(email);
      spinner.succeed(result.message);
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
      } else {
        spinner.fail("Failed to send verification email");
      }
    }
  });
