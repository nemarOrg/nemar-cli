/**
 * Authentication commands for NEMAR CLI
 *
 * Commands:
 * - nemar auth login     - Authenticate with API key
 * - nemar auth signup    - Register new account
 * - nemar auth status    - Check authentication status
 * - nemar auth whoami    - Alias for status (common pattern)
 * - nemar auth logout    - Clear stored credentials
 * - nemar auth setup-ssh - Configure SSH for GitHub access
 *
 * Note: The two-prong structure (nemar auth <cmd>) follows CLI best practices
 * for discoverability and organization. Root-level shortcuts (nemar login,
 * nemar whoami, etc.) are provided as convenience aliases in index.ts.
 */

import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import { ApiError, getCurrentUser, login, resendVerification, signup } from "../lib/api.js";
import {
  clearConfig,
  getConfig,
  getConfigPath,
  isAuthenticated,
  setConfig,
} from "../lib/config.js";
import {
  configureSSHForGitHub,
  generateSSHKey,
  getSSHKeyPaths,
  nemarSSHKeyExists,
  readPublicKey,
  testGitHubSSH,
} from "../lib/ssh.js";

export const authCommand = new Command("auth").description("Authentication management").addHelpText(
  "after",
  `
Description:
  Manage your NEMAR account authentication. New users must register, verify
  their email, and be approved by an admin before they can upload datasets.

Workflow:
  1. nemar auth signup     - Register a new account
  2. Verify your email     - Click the link in the verification email
  3. Wait for approval     - Admin will review your request
  4. nemar auth login      - Log in with your API key (sent after approval)

Examples:
  $ nemar auth signup                    # Start registration
  $ nemar auth login                     # Interactive login
  $ nemar auth login -k <api-key>        # Login with API key
  $ nemar auth status --refresh          # Check authentication status
  $ nemar auth whoami                    # Alias for status
  $ nemar auth logout                    # Clear credentials`,
);

// ============================================================================
// Login
// ============================================================================

/** Exported login action handler for use in root-level shortcuts */
export async function loginAction(options: { key?: string; force?: boolean }): Promise<void> {
  // Check for existing authentication
  if (isAuthenticated() && !options.force) {
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
  if (!apiKey) {
    console.log(chalk.red("No API key provided"));
    return;
  }

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
    setConfig("sandboxCompleted", result.user.sandbox_completed);
    if (result.user.sandbox_dataset_id) {
      setConfig("sandboxDatasetId", result.user.sandbox_dataset_id);
    }

    spinner.succeed("Login successful");
    console.log();
    console.log(`  Welcome back, ${chalk.cyan(result.user.username)}!`);
    if (result.user.is_admin) {
      console.log(`  ${chalk.magenta("Admin access enabled")}`);
    }

    // Show sandbox training status
    if (!result.user.sandbox_completed) {
      console.log();
      console.log(chalk.yellow("  Note: Sandbox training required before uploading datasets"));
      console.log(chalk.gray("  Run 'nemar sandbox' to complete training"));
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
}

authCommand
  .command("login")
  .description("Authenticate with your NEMAR API key")
  .option("-k, --key <key>", "API key (alternative: set NEMAR_API_KEY env var)")
  .option("-f, --force", "Skip confirmation if already logged in")
  .addHelpText(
    "after",
    `
Environment Variables:
  NEMAR_API_KEY    Your API key (alternative to -k flag)

Examples:
  $ nemar auth login                     # Interactive prompt
  $ nemar auth login -k nemar_abc123...  # Provide key directly
  $ NEMAR_API_KEY=nemar_abc... nemar auth login`,
  )
  .action(loginAction);

// ============================================================================
// Signup
// ============================================================================

/** Exported signup action handler for use in root-level shortcuts */
export async function signupAction(): Promise<void> {
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
    {
      type: "editor",
      name: "description",
      message: "Why do you need access to NEMAR? (Opens editor, min 20 chars):",
      default: "I am requesting NEMAR access because:\n\n",
      validate: (input) => {
        const trimmed = input?.trim();
        if (!trimmed || trimmed.length < 20) {
          return "Please provide at least 20 characters describing why you need NEMAR access";
        }
        if (trimmed.length > 500) {
          return "Description must be at most 500 characters";
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
      description: answers.description.trim(),
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
      // Provide helpful hints for common errors
      if (error.message.includes("already taken")) {
        console.log(chalk.gray("  Try a different username"));
      } else if (error.message.includes("already registered")) {
        console.log(
          chalk.gray("  Use 'nemar auth resend-verification' if you need a new verification link"),
        );
      }
    } else {
      spinner.fail("Registration failed");
      console.log(chalk.gray(`  ${error instanceof Error ? error.message : "Unknown error"}`));
    }
  }
}

authCommand.command("signup").description("Register for a new NEMAR account").action(signupAction);

// ============================================================================
// Status / Whoami
// ============================================================================

/** Exported status action handler for use in root-level shortcuts (whoami) */
export async function statusAction(options: { refresh?: boolean }): Promise<void> {
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
}

authCommand
  .command("status")
  .description("Check current authentication status")
  .option("--refresh", "Refresh user info from server")
  .action(statusAction);

// whoami is an alias for status (common CLI pattern)
authCommand
  .command("whoami")
  .description("Show current user (alias for status)")
  .option("--refresh", "Refresh user info from server")
  .action(statusAction);

// ============================================================================
// Logout
// ============================================================================

/** Exported logout action handler for use in root-level shortcuts */
export async function logoutAction(options: { force?: boolean }): Promise<void> {
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
}

authCommand
  .command("logout")
  .description("Clear stored credentials")
  .option("-f, --force", "Skip confirmation prompt")
  .action(logoutAction);

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
        if (error.statusCode === 0) {
          console.log(chalk.gray("  Check your internet connection"));
        }
      } else {
        spinner.fail(
          `Failed to send verification email: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
        console.log(chalk.gray("  Check your internet connection"));
      }
    }
  });

// ============================================================================
// Setup SSH
// ============================================================================

/** Exported setup-ssh action handler for use in root-level shortcuts */
export async function setupSSHAction(options: { force?: boolean }): Promise<void> {
  // Check authentication
  if (!isAuthenticated()) {
    console.log(chalk.yellow("Not authenticated"));
    console.log();
    console.log("  Run 'nemar auth login' first to authenticate");
    return;
  }

  const config = getConfig();

  // Test if SSH already works
  if (!options.force) {
    const spinner = ora("Checking existing SSH access...").start();
    const sshTest = await testGitHubSSH();

    if (sshTest.success) {
      spinner.succeed("SSH access to GitHub already configured");
      if (sshTest.username) {
        console.log(`  GitHub user: ${chalk.cyan(sshTest.username)}`);
      }
      console.log();
      console.log(chalk.gray("Use --force to regenerate SSH key anyway"));
      return;
    }
    spinner.info("SSH access to GitHub not configured");
  }

  console.log();
  console.log(chalk.cyan("Setting up SSH access for GitHub"));
  console.log(chalk.gray("This will generate a dedicated SSH key for NEMAR uploads\n"));

  // Step 1: Generate SSH key
  let publicKey: string | null = null;
  const paths = getSSHKeyPaths();

  if (nemarSSHKeyExists() && !options.force) {
    console.log(chalk.gray(`  Using existing key: ${paths.privateKey}`));
    publicKey = readPublicKey();
  } else {
    const spinner = ora("Generating SSH key...").start();
    const keyResult = await generateSSHKey(config.email || "nemar-user");

    if (!keyResult.success) {
      spinner.fail("Failed to generate SSH key");
      console.log(chalk.gray(`  ${keyResult.error}`));
      return;
    }

    spinner.succeed("SSH key generated");
    console.log(chalk.gray(`  Private key: ${paths.privateKey}`));
    console.log(chalk.gray(`  Public key: ${paths.publicKey}`));
    publicKey = keyResult.publicKey || null;
  }

  if (!publicKey) {
    console.log(chalk.red("Could not read public key"));
    return;
  }

  // Step 2: Configure SSH
  const configSpinner = ora("Configuring SSH...").start();
  const configResult = configureSSHForGitHub();

  if (!configResult.success) {
    configSpinner.fail("Failed to configure SSH");
    console.log(chalk.gray(`  ${configResult.error}`));
    return;
  }
  configSpinner.succeed("SSH configured for GitHub");

  // Step 3: Check if key is already registered with GitHub
  console.log();
  const verifySpinner = ora("Testing SSH connection to GitHub...").start();

  const verifyResult = await testGitHubSSH();

  if (verifyResult.success) {
    verifySpinner.succeed("SSH connection verified");
    if (verifyResult.username) {
      console.log(`  GitHub user: ${chalk.cyan(verifyResult.username)}`);
    }
    console.log();
    console.log(chalk.green("SSH setup complete! You can now upload datasets."));
    return;
  }

  verifySpinner.info("SSH key generated but not yet added to GitHub");

  // Step 4: Show instructions to add key to GitHub
  console.log();
  console.log(chalk.yellow("To complete setup, add this SSH key to your GitHub account:"));
  console.log();
  console.log(chalk.cyan(`  ${publicKey}`));
  console.log();
  console.log("Steps:");
  console.log("  1. Copy the key above");
  console.log(`  2. Go to: ${chalk.underline("https://github.com/settings/ssh/new")}`);
  console.log(`  3. Title: ${chalk.gray("NEMAR CLI")}`);
  console.log("  4. Paste the key and click 'Add SSH key'");
  console.log();
  console.log(chalk.gray("After adding the key, run 'nemar auth setup-ssh' again to verify."));
}

authCommand
  .command("setup-ssh")
  .description("Configure SSH access for GitHub (auto-generates key)")
  .option("-f, --force", "Regenerate SSH key even if one exists")
  .addHelpText(
    "after",
    `
Description:
  Automatically configures SSH access for GitHub, which is required
  for uploading datasets. This command will:

  1. Generate a dedicated Ed25519 SSH key for NEMAR (~/.ssh/nemar_ed25519)
  2. Configure SSH to use this key for GitHub
  3. Register the key with your GitHub account (via NEMAR backend)

  This is a one-time setup. After running this command, you can upload
  datasets without any manual SSH configuration.

Examples:
  $ nemar auth setup-ssh          # Set up SSH access
  $ nemar auth setup-ssh --force  # Regenerate key even if exists`,
  )
  .action(setupSSHAction);
