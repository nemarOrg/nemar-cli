/**
 * Authentication commands for NEMAR CLI
 *
 * Commands:
 * - nemar auth login     - Authenticate with API key
 * - nemar auth signup    - Register new account
 * - nemar auth status    - Check authentication status
 * - nemar auth whoami    - Alias for status (common pattern)
 * - nemar auth logout    - Clear stored credentials
 * - nemar auth request-upload-access - Ask an admin for upload access
 * - nemar auth switch    - Switch between stored accounts
 * - nemar auth setup-ssh - Configure SSH for GitHub (optional, gh CLI preferred)
 *
 * Note: The two-prong structure (nemar auth <cmd>) follows CLI best practices
 * for discoverability and organization. Root-level shortcuts (nemar login,
 * nemar whoami, etc.) are provided as convenience aliases in index.ts.
 */

import chalk from "chalk";
import { Command, InvalidArgumentError } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import {
  UPLOAD_ACCESS_WHY_MAX_CHARS,
  UPLOAD_ACCESS_WHY_MIN_CHARS,
} from "../../shared/contract/user.js";
import {
  type OrcidNameResponse,
  type ProfilePatchRequest,
  type UploadAccessRequestResponse,
  checkGitHubUsername,
  checkOrcidName,
  checkUsername,
  getCurrentUser,
  login,
  requestEmailChange,
  requestKeyRegeneration,
  requestUploadAccess,
  resendVerification,
  retrieveKey,
  signup,
  startOrcidCliLink,
  unlinkOrcid,
  updateProfile,
  verifyEmailChange,
} from "../lib/api/auth.js";
import { ApiError, MaintenanceError, errorDetail } from "../lib/api/errors.js";
import { openInBrowser } from "../lib/browser.js";
import { printStepFailure } from "../lib/cli-output.js";
import {
  DEFAULT_API_URL,
  clearAllConfig,
  clearConfig,
  deleteConfig,
  getAccounts,
  getConfig,
  getConfigPath,
  isAuthenticated,
  renameActiveAccount,
  setConfig,
  storeAccount,
  switchAccount,
} from "../lib/config.js";
import {
  type ConfirmOptions,
  NO_DESCRIPTION,
  NO_OPTION,
  YES_DESCRIPTION,
  YES_OPTION,
  confirm,
} from "../lib/confirm.js";
import { recordStep } from "../lib/debug-log.js";
import { addVerboseHelp } from "../lib/help.js";
import { warnMissingPrerequisites } from "../lib/prerequisites.js";
import {
  configureSSHForGitHub,
  generateSSHKey,
  getSSHKeyPaths,
  nemarSSHKeyExists,
  readPublicKey,
  testGitHubSSH,
} from "../lib/ssh.js";

export const authCommand = new Command("auth").description("Authentication management");

addVerboseHelp(
  authCommand,
  `
Description:
  Manage your NEMAR account authentication. New users register and verify
  their email; that activates the account (browse, download, API key,
  sandbox training). Uploading datasets additionally needs upload access,
  a one-time admin approval you request once your account is active.

Workflow:
  1. nemar auth signup         - Register a new account
  2. Verify your email         - Click the link in the verification email
  3. nemar auth retrieve-key   - Retrieve your API key (requires password)
  4. nemar auth login          - Log in with your API key

Examples:
  $ nemar auth signup                    # Start registration
  $ nemar auth retrieve-key             # Get your API key once verified
  $ nemar auth login                     # Interactive login
  $ nemar auth login -k <api-key>        # Login with API key
  $ nemar auth regenerate-key           # Get a new API key (revokes old)
  $ nemar auth status --refresh          # Check authentication status
  $ nemar auth whoami                    # Alias for status
  $ nemar auth switch                    # Switch between accounts
  $ nemar auth logout                    # Clear active account
  $ nemar auth logout --all              # Clear all accounts`,
);

// ============================================================================
// Login
// ============================================================================

/**
 * Decide how `nemar auth login` should treat a credential already on disk.
 *
 * The gate used to be `isAuthenticated()` alone, which only answers "is *a*
 * key string stored?" — true even when that key was revoked or expired
 * server-side (e.g. after `nemar auth regenerate-key` was run elsewhere).
 * That made the CLI announce "Already logged in" and ask "different account?"
 * when the user actually just needed to re-enter a renewed key for the SAME
 * account (#851). We probe the stored key's liveness and branch on the result.
 *
 * Pure on purpose: all I/O (the liveness probe) happens in the caller so this
 * decision stays unit-testable.
 */
export type LoginPreflight =
  | { kind: "fresh" } // no usable stored credential — prompt for a key
  | { kind: "stale"; username: string } // stored key confirmed dead — re-auth same account
  | { kind: "active"; username: string }; // stored key valid OR unverifiable — multi-account prompt

/** Liveness of a stored key, as determined by probing POST /auth/login. */
export type KeyLivenessState = "valid" | "invalid" | "unknown";

/**
 * Input to {@link decideLoginPreflight}. A discriminated union so the type
 * rejects phantom states: a key's liveness and username only exist when a key
 * is actually stored.
 */
export type LoginPreflightInput =
  | { hasStoredKey: false }
  | { hasStoredKey: true; storedKeyState: KeyLivenessState; username?: string };

export function decideLoginPreflight(input: LoginPreflightInput): LoginPreflight {
  if (!input.hasStoredKey) return { kind: "fresh" };
  const username = input.username || "unknown";
  // Only a definitive "invalid" (the server confirmed the key is revoked or
  // expired) routes to same-account re-auth. "valid" and "unknown" — the
  // latter an offline run or any transient failure where we never reached the
  // server — both keep the original multi-account behavior, so a network
  // hiccup never mislabels a good key as dead (#851).
  return input.storedKeyState === "invalid"
    ? { kind: "stale", username }
    : { kind: "active", username };
}

/** Exported login action handler for use in root-level shortcuts */
export async function loginAction(options: { key?: string } & ConfirmOptions): Promise<void> {
  // Check for existing authentication. isAuthenticated() only proves a key
  // STRING is on disk, not that it still works, so probe the stored key's
  // liveness before deciding how to greet the user (#851).
  if (isAuthenticated()) {
    const cfg = getConfig();
    const storedKey = cfg.apiKey;
    let storedKeyState: KeyLivenessState = "unknown";
    if (storedKey) {
      const probe = ora("Checking your saved credentials...").start();
      try {
        const check = await login(storedKey);
        storedKeyState = check.valid ? "valid" : "invalid";
        probe.stop();
      } catch (error) {
        probe.stop();
        // Maintenance mode (503) already printed its own banner inside the API
        // layer; don't layer a contradictory "add another account?" prompt on
        // top of it — just stop here so the user retries when service is back.
        if (error instanceof MaintenanceError) return;
        // A definitive 401 means the key was revoked or expired server-side, so
        // mark it "invalid"; decideLoginPreflight routes that to same-account
        // re-auth. Anything else (offline network error, 5xx, unexpected) stays
        // "unknown": we keep the original multi-account prompt rather than
        // wrongly telling the user a working key is dead.
        storedKeyState =
          error instanceof ApiError && error.statusCode === 401 ? "invalid" : "unknown";
      }
    }

    const preflight = decideLoginPreflight({
      hasStoredKey: true,
      storedKeyState,
      username: cfg.username,
    });

    if (preflight.kind === "active") {
      console.log(chalk.yellow(`Already logged in as ${preflight.username}`));
      console.log(chalk.dim("  This will add another account (use 'nemar auth switch' to switch)"));
      const result = await confirm("Add a different account?", options);
      if (result !== "confirmed") return;
    } else if (preflight.kind === "stale") {
      // Stale: SAME account, dead key. Guide a straightforward re-auth instead
      // of the misleading "different account?" prompt the bug report hit.
      console.log(chalk.yellow(`Your saved API key for ${preflight.username} is no longer valid.`));
      console.log(
        chalk.dim("  It may have expired or been revoked (e.g. via 'nemar auth regenerate-key')."),
      );
      console.log(chalk.dim("  Enter your new key below to re-authenticate."));
    }
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
    // A failed login is a failed command (#1257 review item 23): this used
    // to `return` with the default exit code (0), so the debug bundle's
    // exit-code line and failure hint both lied about the run having
    // succeeded -- for the very command a brand-new user runs first.
    process.exitCode = 1;
    return;
  }

  const spinner = ora("Validating API key...").start();

  try {
    const result = await login(apiKey);

    if (!result.valid) {
      // Routed through printStepFailure (rather than a bare spinner.fail)
      // so this feeds the debug bundle's "Failing step" line -- see #1257
      // review item 23.
      printStepFailure(spinner, "Invalid API key", "Check that your API key is correct");
      process.exitCode = 1;
      return;
    }

    // Store credentials as a named account and set as active
    storeAccount(result.user.username, {
      apiKey,
      apiUrl: DEFAULT_API_URL,
      username: result.user.username,
      email: result.user.email,
      githubUsername: result.user.github_username,
      sandboxCompleted: result.user.sandbox_completed,
      role: result.user.role,
      ...(result.user.sandbox_dataset_id
        ? { sandboxDatasetId: result.user.sandbox_dataset_id }
        : {}),
    });

    spinner.succeed("Login successful");
    console.log();
    console.log(`  Welcome back, ${chalk.cyan(result.user.username)}!`);
    if (result.user.role === "owner") {
      console.log(`  ${chalk.red("Owner access enabled")}`);
    } else if (result.user.role === "admin") {
      console.log(`  ${chalk.magenta("Admin access enabled")}`);
    }

    // Show sandbox training status
    if (!result.user.sandbox_completed) {
      console.log();
      console.log(chalk.yellow("  Note: Sandbox training required before uploading datasets"));
      console.log(chalk.dim("  Run 'nemar sandbox' to complete training"));
    }
  } catch (error) {
    // Same defect as the two branches above, same fix: this catch has
    // always been reachable on a genuine failure (a real 401/403/5xx, or a
    // network error) and never set an exit code either.
    process.exitCode = 1;
    if (error instanceof ApiError) {
      spinner.fail(error.message);
      recordStep(error.message);
      if (error.statusCode === 401) {
        console.log(chalk.dim("  Check that your API key is correct"));
      } else if (error.statusCode === 403) {
        console.log(chalk.dim("  Your account is not active; verify your email first"));
      }
    } else {
      spinner.fail("Connection failed");
      recordStep("Connection failed");
      console.log(chalk.dim("  Check your internet connection"));
    }
  }
}

const loginCmd = authCommand
  .command("login")
  .description("Authenticate with your NEMAR API key")
  .option("-k, --key <key>", "API key (alternative: set NEMAR_API_KEY env var)")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(loginAction);

addVerboseHelp(
  loginCmd,
  `
Environment Variables:
  NEMAR_API_KEY    Your API key (alternative to -k flag)

Examples:
  $ nemar auth login                     # Interactive prompt
  $ nemar auth login -k nemar_abc123...  # Provide key directly
  $ NEMAR_API_KEY=nemar_abc... nemar auth login`,
);

// ============================================================================
// Signup
// ============================================================================

/**
 * Look up the name on a public ORCID record, treating any failure as "no
 * name" (#1255): the caller's next move -- ask the user to type it -- is the
 * same for a hidden name, an unreachable backend, and a 4xx, and the backend
 * re-reads ORCID itself when the account is created.
 */
async function lookupOrcidName(orcid: string): Promise<OrcidNameResponse> {
  try {
    return await checkOrcidName(orcid);
  } catch {
    // An unreachable backend is a lookup failure, not evidence about the
    // user's record -- same distinction the endpoint itself draws.
    return { status: "lookup_failed", given_name: null, family_name: null };
  }
}

/**
 * Collect the researcher's name, asking for it ONLY when ORCID does not
 * publish one. NEMAR needs a real name because DOIs cite the uploader by name
 * and never by username (#1255); when the record has one, nobody is asked to
 * retype it.
 */
async function collectResearcherName(
  orcid: string,
): Promise<{ given_name?: string; family_name?: string }> {
  const spinner = ora("Reading your name from ORCID...").start();
  const record = await lookupOrcidName(orcid);
  if (record.status === "found") {
    spinner.succeed(`Name from your ORCID record: ${record.given_name} ${record.family_name}`);
    // Deliberately not sent: the backend reads the same record itself, and
    // the record is the authority on how this person is cited.
    return {};
  }

  // Both remaining cases prompt, but they are different situations and the
  // sentence says which (#1255): telling someone their record hides their
  // name when ORCID is simply down sends them to fix nothing.
  if (record.status === "lookup_failed") {
    spinner.warn(
      "ORCID is unreachable right now, so NEMAR could not read your name. Please enter it; " +
        "if your ORCID record publishes a name, that name wins.",
    );
  } else {
    spinner.info("Your ORCID record does not publish a name; NEMAR needs it for DOI citations.");
  }

  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "given_name",
      message: "Given (first) name:",
      validate: (input: string) =>
        input?.trim() ? true : "A given name is required: DOIs cite you by name, not by username",
    },
    {
      type: "input",
      name: "family_name",
      message: "Family (last) name:",
      validate: (input: string) =>
        input?.trim() ? true : "A family name is required: DOIs cite you by name, not by username",
    },
  ]);
  return {
    given_name: answers.given_name.trim(),
    family_name: answers.family_name.trim(),
  };
}

/** Exported signup action handler for use in root-level shortcuts */
export async function signupAction(): Promise<void> {
  console.log(chalk.cyan("NEMAR Account Registration"));
  console.log(chalk.dim("Create an account to upload and manage datasets\n"));

  // Non-fatal heads-up about external tools needed for upload/validation, so
  // users (especially on Windows) learn what to install before they get there.
  await warnMissingPrerequisites();

  // Collect user information
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "username",
      message: "Choose a username:",
      validate: async (input) => {
        if (!input || input.length < 3) {
          return "Username must be at least 3 characters";
        }
        if (input.length > 30) {
          return "Username must be at most 30 characters";
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(input)) {
          return "Username can only contain letters, numbers, underscores, and hyphens";
        }
        // Check availability with backend
        try {
          const result = await checkUsername(input);
          if (!result.available) {
            return result.reason || `Username "${input}" is already taken`;
          }
        } catch (error) {
          // Only allow network errors to pass; report other issues
          if (error instanceof ApiError && error.statusCode === 0) {
            // Network error - will be validated at signup
            return true;
          }
          // Server error or unexpected issue - let user know
          return true; // Don't block signup, backend will validate
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
      validate: async (input) => {
        if (!input || input.length < 1) {
          return "GitHub username is required for PR collaboration";
        }
        if (input.length > 39) {
          return "GitHub username is too long";
        }
        // Validate GitHub username exists via backend
        try {
          const result = await checkGitHubUsername(input);
          if (!result.valid) {
            return `GitHub user "${input}" not found. Please check the username.`;
          }
        } catch (error) {
          // Only allow network errors to pass; report other issues
          if (error instanceof ApiError && error.statusCode === 0) {
            // Network error - will be validated at signup
            return true;
          }
          // Server error or unexpected issue - let user know
          return true; // Don't block signup, backend will validate
        }
        return true;
      },
    },
    {
      type: "input",
      name: "orcid",
      message: "ORCID iD (e.g. 0000-0002-1825-0097):",
      validate: (input) => {
        const v = input?.trim();
        if (!v) return "ORCID iD is required — it's how NEMAR gets your name";
        if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(v)) {
          return "ORCID must be in format 0000-0000-0000-000X";
        }
        return true;
      },
    },
  ]);

  // Right after the ORCID prompt, because ORCID is where the name comes from.
  const researcherName = await collectResearcherName(answers.orcid.trim());

  const rest = await inquirer.prompt([
    {
      type: "input",
      name: "affiliation",
      message: "Affiliation / institution (optional):",
      validate: (input) =>
        !input || input.trim().length <= 200 ? true : "Affiliation must be at most 200 characters",
    },
    {
      type: "input",
      name: "city",
      message: "City (required for export-control screening):",
      validate: (input) => (input?.trim() ? true : "City is required"),
    },
    {
      type: "input",
      name: "country",
      message: "Country (required for export-control screening):",
      validate: (input) => (input?.trim() ? true : "Country is required"),
    },
    {
      type: "input",
      name: "description",
      message: "Why do you need access to NEMAR? (1-2 sentences):",
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
      description: rest.description.trim(),
      orcid: answers.orcid.trim(),
      ...researcherName,
      affiliation: rest.affiliation?.trim() || undefined,
      city: rest.city.trim(),
      country: rest.country.trim(),
    });

    spinner.succeed("Account created");
    console.log();
    console.log(chalk.green("Registration successful!"));
    console.log();
    console.log("Next steps:");
    result.next_steps.forEach((step, i) => {
      console.log(`  ${i + 1}. ${step}`);
    });
    // The server is the only party that knows whether the name actually
    // landed on the row; say so loudly rather than leaving it to publish time.
    if (result.researcher_name === "missing") {
      console.log();
      console.log(
        chalk.yellow(
          "No researcher name is on file for this account. DOIs cite depositors by name, " +
            "never by username, so publishing stays blocked until one is recorded.",
        ),
      );
      console.log(
        chalk.dim(
          "  Make your name public on your ORCID record, then sign in again so NEMAR can read it.",
        ),
      );
    }
  } catch (error) {
    if (error instanceof ApiError) {
      spinner.fail(error.message);
      if (error.details && Array.isArray(error.details)) {
        error.details.forEach((detail) => {
          console.log(chalk.dim(`  - ${detail}`));
        });
      }
      // Provide helpful hints for common errors
      if (error.message.includes("already taken")) {
        console.log(chalk.dim("  Try a different username"));
      } else if (error.message.includes("already registered")) {
        console.log(
          chalk.dim("  Use 'nemar auth resend-verification' if you need a new verification link"),
        );
      }
    } else {
      spinner.fail("Registration failed");
      console.log(chalk.dim(`  ${error instanceof Error ? error.message : "Unknown error"}`));
    }
  }
}

authCommand.command("signup").description("Register for a new NEMAR account").action(signupAction);

// ============================================================================
// Status / Whoami
// ============================================================================

/** Exported status action handler for use in root-level shortcuts (whoami) */
export async function statusAction(options: { refresh?: boolean }): Promise<void> {
  if (!isAuthenticated()) {
    console.log(chalk.yellow("Not authenticated"));
    console.log();
    console.log("  Run 'nemar auth login' to authenticate");
    console.log("  Run 'nemar auth signup' to create an account");
    return;
  }

  // If refresh requested, fetch latest from server
  let userRole: string | undefined;
  // Set when a requested refresh did not complete for a reason that is neither
  // 401 nor 403 (offline, 5xx, a shape drift). Everything printed below then
  // comes from the config cache, and the upload-access line in particular must
  // not present a stale `true` as the current answer (ADR 0040).
  let refreshFailure: string | undefined;
  if (options.refresh) {
    const spinner = ora("Fetching user info...").start();
    try {
      const user = await getCurrentUser();
      // username/github_username are nullable on the wire (web-signup users);
      // config fields are string|undefined, so coerce null -> undefined.
      setConfig("username", user.username ?? undefined);
      setConfig("email", user.email);
      setConfig("githubUsername", user.github_username ?? undefined);
      // Only cache a value the server actually sent: an older backend omits
      // the field, and writing `false` there would report "not granted" to
      // someone who has it (ADR 0040).
      if (user.service_access !== undefined) setConfig("serviceAccess", user.service_access);
      setConfig("role", user.role);
      userRole = user.role;
      spinner.stop();
    } catch (error) {
      // Put the reason ON the failure line. It used to scroll past as a bare
      // "Could not refresh user info" and the cached values below then read as
      // if they had just been fetched.
      const reason = error instanceof Error ? error.message : String(error);
      spinner.fail(`Could not refresh user info: ${reason}`);
      refreshFailure = reason;
      if (error instanceof ApiError && error.statusCode === 401) {
        // The stored key is dead — don't fall through to a green "Authenticated"
        // banner that contradicts the failed refresh (#851).
        console.log(chalk.yellow("  Your saved API key is no longer valid (expired or revoked)."));
        console.log(chalk.dim("  Run 'nemar auth login' with a new key to re-authenticate."));
        return;
      }
      if (error instanceof ApiError && error.statusCode === 403) {
        // The key authenticates but the account is not active: unverified
        // email, or revoked. NOT "awaiting approval" -- approval is the
        // upload grant now (ADR 0040) and never gates the key. Same
        // reasoning as the 401 case: don't print a green "Authenticated"
        // banner that contradicts the failed refresh (#851).
        console.log(chalk.yellow("  Your account is not active (unverified email, or revoked)."));
        console.log(
          chalk.dim(
            "  Verify your email, or contact a NEMAR admin if you believe this is an error.",
          ),
        );
        return;
      }
    }
  }

  // Re-read config after potential refresh to show up-to-date values
  const cfg = getConfig();

  // Display active account status
  console.log(chalk.green("Authenticated"));
  console.log();
  if (cfg.username) {
    console.log(`  Username: ${chalk.cyan(cfg.username)}`);
  }
  if (cfg.email) {
    console.log(`  Email:    ${cfg.email}`);
  }
  if (cfg.githubUsername) {
    console.log(`  GitHub:   @${cfg.githubUsername}`);
  }
  if (userRole) {
    const roleDisplay =
      userRole === "owner"
        ? chalk.red("Owner")
        : userRole === "admin"
          ? chalk.magenta("Admin")
          : chalk.white("Member");
    console.log(`  Role:     ${roleDisplay}`);
  }
  // Upload access is the one-time admin approval (ADR 0040); `status` no
  // longer implies it, which is why it gets its own line. `undefined` means
  // this account has never been refreshed against a backend that reports it.
  //
  // A refresh that was asked for and failed makes the cached value a claim
  // about the past, not the present — the grant may have been revoked in
  // between, and "granted" is the answer that would send someone to attempt an
  // upload that then 403s. Report unknown and say why.
  if (refreshFailure) {
    console.log(
      `  Upload access: ${chalk.dim("unknown (refresh failed; showing cached account)")}`,
    );
  } else if (cfg.serviceAccess === true) {
    console.log(`  Upload access: ${chalk.green("granted")}`);
  } else if (cfg.serviceAccess === false) {
    console.log(
      `  Upload access: ${chalk.yellow("not granted")} ${chalk.dim(
        "(one-time admin approval; see https://nemar.org/support)",
      )}`,
    );
  } else {
    console.log(`  Upload access: ${chalk.dim("unknown (run 'nemar auth status --refresh')")}`);
  }
  console.log(`  Config:   ${chalk.dim(getConfigPath())}`);

  // Show other stored accounts
  const accounts = getAccounts();
  const others = accounts.filter((a) => !a.active);
  if (others.length > 0) {
    console.log();
    console.log(`  Other accounts: ${others.map((a) => chalk.dim(a.username)).join(", ")}`);
    console.log(chalk.dim("  Run 'nemar auth switch' to switch accounts"));
  }
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
// Switch
// ============================================================================

/** Try to switch the gh CLI to the matching GitHub account (best-effort) */
async function switchGitHubAuth(githubUsername: string): Promise<void> {
  try {
    // Use Bun globals directly; dynamic import("bun") gets mangled by bun build --minify
    const ghPath = Bun.which("gh");
    if (!ghPath) {
      console.log(chalk.dim("  GitHub CLI (gh) not found in PATH, skipping"));
      return;
    }
    const proc = Bun.spawn({
      cmd: [ghPath, "auth", "switch", "--user", githubUsername],
      stdout: "pipe",
      stderr: "pipe",
    });
    // Read stderr before awaiting exit to avoid stream race conditions
    const stderrText = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      console.log(`  GitHub CLI switched to ${chalk.cyan(`@${githubUsername}`)}`);
    } else {
      const msg = stderrText.trim();
      if (msg.includes("not found") || msg.includes("no accounts")) {
        console.log(
          chalk.dim(`  GitHub CLI: @${githubUsername} not logged in (run 'gh auth login')`),
        );
      } else {
        console.log(chalk.dim(`  GitHub CLI switch failed: ${msg || `exit code ${exitCode}`}`));
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(chalk.dim(`  GitHub CLI switch skipped: ${msg}`));
  }
}

/** Exported switch action handler for use in root-level shortcuts */
export async function switchAction(identifier?: string): Promise<void> {
  const accounts = getAccounts();

  if (accounts.length === 0) {
    console.log(chalk.yellow("No stored accounts"));
    console.log("  Run 'nemar auth login' to add an account");
    return;
  }

  if (accounts.length === 1) {
    const only = accounts[0];
    if (only.active) {
      console.log(chalk.yellow(`Only one account stored: ${only.username}`));
      console.log("  Run 'nemar auth login' to add another account");
      return;
    }
  }

  let target: string;

  if (identifier) {
    target = identifier;
  } else {
    // Interactive picker
    const choices = accounts.map((a) => ({
      name: `${a.username}${a.githubUsername ? ` (@${a.githubUsername})` : ""}${a.active ? chalk.green(" (active)") : ""}`,
      value: a.username,
      short: a.username,
    }));

    const { selected } = await inquirer.prompt([
      {
        type: "list",
        name: "selected",
        message: "Switch to account:",
        choices,
        default: accounts.find((a) => a.active)?.username,
      },
    ]);
    target = selected;
  }

  // Check if already active
  const current = accounts.find((a) => a.active);
  if (current && current.username === target) {
    console.log(chalk.yellow(`Already using account ${target}`));
    return;
  }

  const switched = switchAccount(target);
  if (!switched) {
    console.log(chalk.red(`Account not found: ${target}`));
    console.log(chalk.dim("  Provide a NEMAR username or GitHub username"));
    console.log(chalk.dim(`  Available: ${accounts.map((a) => a.username).join(", ")}`));
    return;
  }

  console.log(chalk.green(`Switched to ${chalk.cyan(switched.username || target)}`));

  // Switch gh CLI auth if possible
  if (switched.githubUsername) {
    await switchGitHubAuth(switched.githubUsername);
  }
}

const switchCmd = authCommand
  .command("switch [username]")
  .description("Switch between stored accounts")
  .action(switchAction);

addVerboseHelp(
  switchCmd,
  `
Description:
  Switch the active NEMAR account. You can specify a NEMAR username or
  GitHub username. If no username is given, an interactive picker is shown.

  Switching also updates the GitHub CLI (gh) to the matching account.

Examples:
  $ nemar auth switch              # Interactive picker
  $ nemar auth switch yahya        # Switch by NEMAR username
  $ nemar auth switch cool-vibers  # Switch by GitHub username`,
);

// ============================================================================
// Logout
// ============================================================================

/** Exported logout action handler for use in root-level shortcuts */
export async function logoutAction(options: ConfirmOptions & { all?: boolean }): Promise<void> {
  if (!isAuthenticated()) {
    console.log(chalk.yellow("Not currently authenticated"));
    return;
  }

  if (options.all) {
    const accounts = getAccounts();
    const result = await confirm(`Log out all ${accounts.length} stored account(s)?`, options);
    if (result !== "confirmed") return;
    clearAllConfig();
    console.log(chalk.green("All accounts removed"));
    return;
  }

  const cfg = getConfig();
  const result = await confirm(`Log out ${cfg.username || "current user"}?`, options);
  if (result !== "confirmed") return;

  clearConfig();
  console.log(chalk.green("Logged out successfully"));

  // If other accounts remain, inform the user
  const remaining = getAccounts();
  if (remaining.length > 0) {
    const active = remaining.find((a) => a.active);
    if (active) {
      console.log(`  Switched to ${chalk.cyan(active.username)}`);
    }
  }
}

authCommand
  .command("logout")
  .description("Remove the active account (use --all to remove all)")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .option("--all", "Remove all stored accounts")
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
          console.log(chalk.dim("  Check your internet connection"));
        }
      } else {
        spinner.fail(
          `Failed to send verification email: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
        console.log(chalk.dim("  Check your internet connection"));
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
      console.log(chalk.dim("Use --force to regenerate SSH key anyway"));
      return;
    }
    spinner.info("SSH access to GitHub not configured");
  }

  console.log();
  console.log(chalk.cyan("Setting up SSH access for GitHub"));
  console.log(chalk.dim("This will generate a dedicated SSH key for NEMAR uploads\n"));

  // Step 1: Generate SSH key
  let publicKey: string | null = null;
  const paths = getSSHKeyPaths();

  if (nemarSSHKeyExists() && !options.force) {
    console.log(chalk.dim(`  Using existing key: ${paths.privateKey}`));
    publicKey = readPublicKey();
  } else {
    const spinner = ora("Generating SSH key...").start();
    const keyResult = await generateSSHKey(config.email || "nemar-user");

    if (!keyResult.success) {
      spinner.fail("Failed to generate SSH key");
      console.log(chalk.dim(`  ${keyResult.error}`));
      return;
    }

    spinner.succeed("SSH key generated");
    console.log(chalk.dim(`  Private key: ${paths.privateKey}`));
    console.log(chalk.dim(`  Public key: ${paths.publicKey}`));
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
    console.log(chalk.dim(`  ${configResult.error}`));
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
  console.log(`  3. Title: ${chalk.dim("NEMAR CLI")}`);
  console.log("  4. Paste the key and click 'Add SSH key'");
  console.log();
  console.log(chalk.dim("After adding the key, run 'nemar auth setup-ssh' again to verify."));
}

const setupSshCmd = authCommand
  .command("setup-ssh")
  .description("Configure SSH access for GitHub (optional, gh CLI preferred)")
  .option("-f, --force", "Regenerate SSH key even if one exists")
  .action(setupSSHAction);

addVerboseHelp(
  setupSshCmd,
  `
Description:
  Configures SSH access for GitHub as an alternative to gh CLI (HTTPS).
  Most users should use 'gh auth login' instead; SSH is only needed if
  you cannot use the GitHub CLI.

  1. Generate a dedicated Ed25519 SSH key for NEMAR (~/.ssh/nemar_ed25519)
  2. Configure SSH to use this key for GitHub
  3. Verify the connection (prompts you to add the key to GitHub if needed)

Examples:
  $ nemar auth setup-ssh          # Set up SSH access
  $ nemar auth setup-ssh --force  # Regenerate key even if exists`,
);

// ============================================================================
// Retrieve Key (after email verification)
// ============================================================================

const retrieveKeyCmd = authCommand
  .command("retrieve-key")
  .description("Retrieve your API key once your email is verified (requires email and password)")
  .action(async () => {
    const answers = await inquirer.prompt([
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
        message: "Password:",
        mask: "*",
        validate: (input) => {
          if (!input) return "Password is required";
          return true;
        },
      },
    ]);

    const spinner = ora("Retrieving API key...").start();

    try {
      const result = await retrieveKey(answers.email, answers.password);

      spinner.succeed("API key retrieved");
      console.log();
      console.log(chalk.yellow("Your API Key (store this securely):"));
      console.log(chalk.dim(`  ${result.api_key}`));
      console.log();
      console.log("Next step:");
      console.log(`  Run ${chalk.cyan("nemar auth login")} and paste your API key`);
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.statusCode === 409) {
          // Key already issued - extract prefix from error details
          const details = error.details as { api_key_prefix?: string } | undefined;
          spinner.info("API key already issued");
          if (details?.api_key_prefix) {
            console.log();
            console.log(`  Key prefix: ${chalk.dim(details.api_key_prefix)}`);
          }
          console.log();
          console.log("  If you lost your API key, regenerate it:");
          console.log(`  ${chalk.cyan("nemar auth regenerate-key")}`);
        } else {
          spinner.fail(error.message);
          if (error.statusCode === 401) {
            console.log(chalk.dim("  Check your email and password"));
          } else if (error.statusCode === 403) {
            console.log(chalk.dim("  Verify your email address first, then try again"));
          }
        }
      } else {
        const msg = error instanceof Error ? error.message : "Unknown error";
        spinner.fail(`Failed to retrieve API key: ${msg}`);
      }
    }
  });

addVerboseHelp(
  retrieveKeyCmd,
  `
Description:
  Once you have verified your email address, use this command to securely
  retrieve your API key. You will need the email and password you used
  during signup. No admin approval is needed for the key; approval is the
  separate, one-time grant that lets you upload datasets.

  API keys are not sent via email for security. This is the only way
  to obtain your key.

Examples:
  $ nemar auth retrieve-key`,
);

// ============================================================================
// Regenerate Key
// ============================================================================

const regenerateKeyCmd = authCommand
  .command("regenerate-key")
  .description("Request a new API key (revokes current key, requires email verification)")
  .action(async () => {
    console.log(chalk.yellow("API Key Regeneration"));
    console.log(chalk.dim("This will revoke your current key and generate a new one\n"));

    const { email } = await inquirer.prompt([
      {
        type: "input",
        name: "email",
        message: "Email address associated with your account:",
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
      const result = await requestKeyRegeneration(email);
      spinner.succeed("Verification email sent");
      console.log();
      console.log("Next steps:");
      console.log("  1. Check your email for a verification link");
      console.log("  2. Click the link to generate your new API key");
      console.log("  3. Copy the new key and run 'nemar auth login'");
      console.log();
      console.log(chalk.dim("The link expires in 1 hour"));
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
      } else {
        spinner.fail("Failed to send verification email");
        console.log(chalk.dim("  Check your internet connection"));
      }
    }
  });

addVerboseHelp(
  regenerateKeyCmd,
  `
Description:
  If you lost your API key or it was compromised, use this command to
  request a new one. A verification email will be sent to confirm the
  request. Clicking the link will:

  1. Revoke your current API key
  2. Generate a new API key (shown in the browser)
  3. You will need to login again with the new key

Examples:
  $ nemar auth regenerate-key`,
);

// ============================================================================
// Request Upload Access (ADR 0042, #1253, epic #1250)
//
// Verifying your email makes the account usable (browse, API key, sandbox);
// UPLOADING needs a one-time admin grant on top of it, and this is how you ask
// for it. Before #1253 the 403 could only point at the support page.
// ============================================================================

/**
 * Where a user actually fixes each precondition, keyed on the field names the
 * API sends in `missing`.
 *
 * Most of these point at Settings on nemar.org because that is where the field
 * lives: username, name, GitHub handle, city and country are edited on the
 * account settings page (nemarOrg/website#301), and that page is what a user is
 * meant to use whether they arrived from the browser or the CLI. THIS COPY
 * ASSUMES #301 IS DEPLOYED -- releasing epic #1250 is gated on it, because
 * until then these lines name a page with nothing on it, which is the exact
 * failure ADR 0040 spent a year fixing.
 *
 * `email_verified` is the exception and points at a real CLI command, because
 * that step genuinely has one.
 */
const UPLOAD_ACCESS_FIX: Record<string, string> = {
  email_verified: "run 'nemar auth resend-verification' and click the link in your inbox",
  username: "run 'nemar auth profile set-username <name>'",
  given_name:
    "comes from your ORCID record when one is linked; otherwise 'nemar auth profile set-name --given <name>'",
  family_name:
    "comes from your ORCID record when one is linked; otherwise 'nemar auth profile set-name --family <name>'",
  github_username: "run 'nemar auth profile set-github <handle>'",
  city: "run 'nemar auth profile set-location --city <city>'",
  country: "run 'nemar auth profile set-location --country <country>'",
  why: "pass a longer --why, or answer the prompt",
};

/**
 * Say so when the request landed but no admin was reached.
 *
 * The request IS recorded either way, so this is a warning and not a failure;
 * what makes it worth printing is that the fix is in the user's hands (run the
 * command again) and is otherwise invisible -- a silent `ok` here means waiting
 * for a review nobody has been asked for. `undefined` is a backend that
 * predates the notification stamp, and says nothing rather than guessing.
 */
function warnIfAdminsNotNotified(result: UploadAccessRequestResponse): void {
  if (result.email_sent !== false) return;
  console.log();
  console.log(
    chalk.yellow(
      "  Warning: your request is recorded but admins could not be notified;\n" +
        "  it will be retried when you run this command again.",
    ),
  );
}

/**
 * The prompt's own check on the why text, extracted so it can be tested.
 *
 * Returns `true` when the text is acceptable, or the message inquirer should
 * show. It exists to stop a user typing 400 characters and THEN being refused
 * by the server for a reason the terminal already knew -- it is not the rule
 * itself, which lives at the route (services/upload-access.ts). Both read their
 * bounds from shared/contract so the prompt cannot accept something the server
 * will reject, which is the failure mode a local copy of "20" would create.
 */
export function validateUploadAccessWhy(input: string | undefined): true | string {
  const text = (input ?? "").trim();
  if (text.length < UPLOAD_ACCESS_WHY_MIN_CHARS) {
    return `Please write at least ${UPLOAD_ACCESS_WHY_MIN_CHARS} characters`;
  }
  if (text.length > UPLOAD_ACCESS_WHY_MAX_CHARS) {
    return `Please keep it under ${UPLOAD_ACCESS_WHY_MAX_CHARS} characters`;
  }
  return true;
}

const requestUploadAccessCmd = authCommand
  .command("request-upload-access")
  .description("Ask an admin for upload access (one-time)")
  .option("--why <text>", "What you intend to upload (20-500 characters)")
  .action(async (options: { why?: string }) => {
    // Checked before the spinner starts, rather than left to the client's own
    // 401: this is an action, not a query, so it exits non-zero, and a script
    // must not see "Submitting upload access request..." for a request that was
    // never going to be sent.
    if (!isAuthenticated()) {
      console.log(chalk.yellow("Not authenticated"));
      console.log();
      console.log("  Run 'nemar auth login' to authenticate");
      process.exitCode = 1;
      return;
    }

    let why = (options.why ?? "").trim();
    if (!why) {
      const answers = await inquirer.prompt([
        {
          type: "input",
          name: "why",
          message: "What do you intend to upload to NEMAR?",
          validate: validateUploadAccessWhy,
        },
      ]);
      why = String(answers.why).trim();
    }

    const spinner = ora("Submitting upload access request...").start();
    try {
      const result = await requestUploadAccess(why);
      if (result.already_requested) {
        spinner.info("You already have an open upload access request");
        console.log(chalk.dim("  An admin reviews it once; you will get an email when it lands."));
        warnIfAdminsNotNotified(result);
        return;
      }
      spinner.succeed("Upload access requested");
      console.log();
      console.log("  A NEMAR admin reviews the request once.");
      console.log("  You will get an email when upload access is granted.");
      console.log(chalk.dim("  Check any time with 'nemar auth status --refresh'."));
      warnIfAdminsNotNotified(result);
    } catch (error) {
      if (!(error instanceof ApiError)) {
        spinner.fail("Failed to submit upload access request");
        console.log(chalk.dim("  Check your internet connection"));
        process.exitCode = 1;
        return;
      }

      spinner.fail(error.message);
      // The API names the fields it is still missing; print each one with
      // where to fix it rather than making the user map an error sentence back
      // onto a settings form (ADR 0042).
      if (error.missing && error.missing.length > 0) {
        console.log();
        console.log("  Still needed:");
        for (const field of error.missing) {
          const fix = UPLOAD_ACCESS_FIX[field] ?? "update it in Settings on nemar.org";
          console.log(`    ${chalk.yellow(field)} — ${fix}`);
        }
        console.log();
        console.log(chalk.dim("  Settings: https://nemar.org/settings"));
      }
      process.exitCode = 1;
    }
  });

addVerboseHelp(
  requestUploadAccessCmd,
  `
Description:
  Uploading datasets needs upload access: a one-time grant an admin makes
  after reviewing who you are and where you are. Verifying your email is
  not enough on its own, and nothing grants it automatically.

  Before asking, your account needs a username, your given and family name,
  a GitHub username that exists, and your city and country. Set them in
  Settings on nemar.org; the request tells you which ones are missing.

  Asking twice does nothing: while a request is open the command reports
  that and no second message reaches the admins.

Examples:
  $ nemar auth request-upload-access
  $ nemar auth request-upload-access --why "Sharing our lab's 64-channel EEG study of motor imagery"`,
);

// ============================================================================
// Profile (#1254, epic #1250; ADR 0043)
// ============================================================================

/** Rendered for a field the backend sent as null/empty. */
const NOT_SET = "not set";

/**
 * `verified` / `not verified` / `unknown` for a tri-state flag.
 *
 * `undefined` is a backend that predates #1254, and it renders as unknown
 * rather than as "not verified" for the same reason `Upload access` does (ADR
 * 0040): telling someone their confirmed inbox is unconfirmed sends them to
 * redeem a code they do not need.
 */
function verifiedMark(flag: boolean | undefined): string {
  if (flag === undefined) return chalk.dim("verification state unknown");
  return flag ? chalk.green("verified") : chalk.yellow("not verified");
}

/**
 * `nemar auth profile` — what this account's identifiers currently are, and
 * where each one is changed.
 *
 * Separate from `nemar auth status`, which answers "am I logged in and can I
 * upload" from the CONFIG CACHE. This one always fetches: it is the command
 * someone runs because they are about to change an identifier, and a cached
 * answer is exactly the wrong thing to hand them there.
 *
 * The footer is the load-bearing half. Identity uniqueness means a duplicate
 * account is refused rather than created (ADR 0043), so the message a person
 * hits is "that iD already belongs to an account" -- and the only useful next
 * sentence is where to go and change it. Since #1266 every one of them is
 * self-service from here as well as from Settings, so the footer names the
 * command rather than a page the person then has to find.
 */
export async function profileAction(): Promise<void> {
  if (!isAuthenticated()) {
    console.log(chalk.yellow("Not authenticated"));
    console.log();
    console.log("  Run 'nemar auth login' to authenticate");
    return;
  }

  const spinner = ora("Fetching account profile...").start();
  let user: Awaited<ReturnType<typeof getCurrentUser>>;
  try {
    user = await getCurrentUser();
    spinner.stop();
  } catch (error) {
    spinner.fail(`Could not fetch your profile: ${errorDetail(error)}`);
    if (error instanceof ApiError && error.statusCode === 401) {
      console.log(chalk.dim("  Run 'nemar auth login' with a current API key."));
    }
    process.exitCode = 1;
    return;
  }

  const fullName = [user.given_name, user.family_name].filter(Boolean).join(" ");

  console.log();
  console.log(chalk.bold("Account"));
  console.log(`  Username: ${user.username ? chalk.cyan(user.username) : chalk.dim(NOT_SET)}`);
  console.log(`  Name:     ${fullName ? fullName : chalk.dim(NOT_SET)}`);
  console.log(`  Email:    ${user.email}  ${verifiedMark(user.email_verified)}`);
  console.log(
    `  GitHub:   ${user.github_username ? `@${user.github_username}` : chalk.dim(NOT_SET)}`,
  );
  console.log(
    `  ORCID:    ${user.orcid ? `${user.orcid}  ${verifiedMark(user.orcid_verified)}` : chalk.dim(NOT_SET)}`,
  );
  console.log(`  Role:     ${user.role}`);

  console.log();
  console.log(chalk.bold("Access"));
  console.log(`  Tier:          ${user.status ?? chalk.dim("unknown")}`);
  // Same three states as `nemar auth status`, and for the same reason: a
  // backend that predates ADR 0040 sends nothing, and "not granted" is the one
  // wrong answer to give someone who already holds the grant.
  if (user.service_access === true) {
    console.log(`  Upload access: ${chalk.green("granted")}`);
  } else if (user.service_access === false) {
    console.log(
      `  Upload access: ${chalk.yellow("not granted")} ${chalk.dim(
        "(one-time admin approval; see https://nemar.org/support)",
      )}`,
    );
  } else {
    console.log(`  Upload access: ${chalk.dim("unknown (backend did not report it)")}`);
  }

  console.log();
  console.log(chalk.bold("Where to change each"));
  console.log(`  Email       ${chalk.cyan("nemar auth profile set-email <address>")}`);
  console.log(`  Username    ${chalk.cyan("nemar auth profile set-username <name>")}`);
  console.log(
    `  Name        ${chalk.cyan("nemar auth profile set-name --given <g> --family <f>")}`,
  );
  console.log(`  GitHub      ${chalk.cyan("nemar auth profile set-github <handle>")}`);
  console.log(`  ORCID       ${chalk.cyan("nemar auth profile orcid link|relink|unlink")}`);
  console.log(
    `  Location    ${chalk.cyan("nemar auth profile set-location --city <c> --country <k>")}`,
  );
  console.log(
    `  Upload access          ${chalk.dim("one-time admin approval; nemar auth request-upload-access")}`,
  );
  console.log();
  console.log(
    chalk.dim(
      "  Every one of these is also in Settings on https://nemar.org/settings — same rules, same checks.",
    ),
  );
  console.log();
  console.log(
    chalk.dim(
      "An ORCID iD, an email address, and a GitHub username each back at most one NEMAR account. If a sign-up or a link is refused because one is taken, change it on the account that already has it rather than making a second one.",
    ),
  );
}

const profileCmd = authCommand
  .command("profile")
  .description("Show your account identifiers and where to change each")
  .action(profileAction);

addVerboseHelp(
  profileCmd,
  `
Description:
  Prints the identifiers on your account — username, name, email, GitHub
  username, ORCID iD — with the verification state of the email and the
  ORCID link, your access tier, and whether upload access has been granted.

  Always fetched from the server, never from the local config cache: this is
  the command you run before changing something, so a stale answer is worse
  than no answer.

  Each of the ORCID iD, the email address, and the GitHub username backs at
  most one NEMAR account. A second sign-up with any of them is refused rather
  than creating a duplicate; the fix is to change the identifier on the
  account that already holds it.

Subcommands (the same changes Settings on nemar.org makes):
  set-email <address>     mail a code to a new address, then verify-email
  verify-email <code>     finish the change
  set-username <name>     set your NEMAR handle (locked once approved)
  set-name                --given / --family (ORCID wins when a verified iD is linked)
  set-github <handle>     set the GitHub username (checked against GitHub)
  set-location            --city / --country
  orcid link|relink|unlink   opens a browser for ORCID's consent screen

Examples:
  $ nemar auth profile
  $ nemar auth profile set-email ada@lab.example.org
  $ nemar auth profile orcid link`,
);

// ============================================================================
// Profile self-service subcommands (#1266, epic #1250; ADR 0044)
// ============================================================================
//
// The identifiers a person can fix themselves, from the terminal, with the
// same verification the website does: an email change is still proved by a
// code mailed to the NEW address, an ORCID link is still an ORCID consent
// screen in a browser, and every rule and refusal is the backend's, not a
// second copy living here.

/** Where the same change can be made in a browser. Printed by every
 *  subcommand, because the CLI is the second surface, not the only one. */
const SETTINGS_HINT = "Also changeable in Settings on https://nemar.org/settings";

/**
 * Guard every subcommand: an action must not print a spinner for a request
 * that was never going to be sent, and must exit non-zero (`nemar auth
 * profile` itself is a query and exits 0).
 */
function requireAuthenticatedForChange(): boolean {
  if (isAuthenticated()) return true;
  console.log(chalk.yellow("Not authenticated"));
  console.log();
  console.log("  Run 'nemar auth login' to authenticate");
  process.exitCode = 1;
  return false;
}

/**
 * Re-read the account from the server and update the local config cache.
 *
 * Called after every successful change so `nemar auth status` stops showing
 * the value that was just replaced. A failure here is NOT a failure of the
 * change -- the change has landed on the server -- so it is reported as a
 * dim note and the command still exits 0.
 */
async function refreshStoredAccount(): Promise<void> {
  try {
    const user = await getCurrentUser();
    // The accounts map is KEYED by username, so a rename has to move the key
    // as well as the field, or `nemar auth switch <new>` cannot find the
    // account it just renamed (#1266 review). Done first: the writes below
    // target the active account, and this is what decides which one that is.
    if (user.username) renameActiveAccount(user.username);
    setConfig("username", user.username ?? undefined);
    setConfig("email", user.email);
    setConfig("githubUsername", user.github_username ?? undefined);
    if (user.service_access !== undefined) setConfig("serviceAccess", user.service_access);
    setConfig("role", user.role);
  } catch (error) {
    console.log(
      chalk.dim(
        `  (local copy not refreshed: ${errorDetail(error)} — run 'nemar auth status --refresh')`,
      ),
    );
  }
}

/**
 * Apply a local config write that must not be mistaken for the network call
 * that preceded it (#1266 review item 5).
 *
 * The server has already changed something by the time these run -- the email
 * has moved and the code is spent -- so a failed `conf` write is a stale local
 * copy, not a failed change. Inside the request's own try/catch it printed
 * "Could not confirm the new address" for a change that had in fact landed,
 * which is the one sentence that sends a person to re-request a code they no
 * longer need.
 */
function updateLocalConfig(apply: () => void): void {
  try {
    apply();
  } catch (error) {
    console.log(
      chalk.yellow(
        `  The change is live on the server; your local config could not be updated: ${errorDetail(error)}`,
      ),
    );
    console.log(chalk.dim("  Run 'nemar auth status --refresh' once the problem is fixed."));
  }
}

/**
 * Fail a subcommand with the backend's own sentence.
 *
 * Every refusal these routes raise carries a machine code in `error` and the
 * actionable sentence in `message`, and lib/api/client.ts already prefers the
 * sentence for the declared code vocabularies (shared/contract). So there is
 * nothing to map here: printing `error.message` IS printing the backend's
 * wording, which is the point -- a second copy in the CLI is how the two
 * surfaces start telling people different things.
 */
function failWithApiError(spinner: ReturnType<typeof ora>, error: unknown, fallback: string): void {
  if (error instanceof ApiError || error instanceof MaintenanceError) {
    spinner.fail(error.message);
  } else {
    spinner.fail(fallback);
    console.log(chalk.dim(`  ${errorDetail(error)}`));
  }
  process.exitCode = 1;
}

/** Apply a `PATCH /auth/profile` patch and report it uniformly. */
async function applyProfilePatch(
  patch: ProfilePatchRequest,
  pending: string,
  succeeded: string,
): Promise<void> {
  if (!requireAuthenticatedForChange()) return;
  const spinner = ora(pending).start();
  try {
    await updateProfile(patch);
    spinner.succeed(succeeded);
    await refreshStoredAccount();
    console.log(chalk.dim(`  ${SETTINGS_HINT}`));
  } catch (error) {
    failWithApiError(spinner, error, "Could not update your profile");
  }
}

// ---------------------------------------------------------------- set-email

const profileSetEmailCmd = profileCmd
  .command("set-email <address>")
  .description("Start an email change: mails a confirmation code to the new address")
  .action(async (address: string) => {
    if (!requireAuthenticatedForChange()) return;
    const spinner = ora(`Sending a confirmation code to ${address}...`).start();
    let result: Awaited<ReturnType<typeof requestEmailChange>>;
    try {
      result = await requestEmailChange(address);
    } catch (error) {
      failWithApiError(spinner, error, "Could not send the confirmation code");
      return;
    }

    // Past this point the code IS in the person's inbox, so nothing below may
    // report a failure of the request. The local write gets its own guarded
    // step for exactly that reason (#1266 review).
    spinner.succeed(`Code sent to ${result.masked_email}`);
    updateLocalConfig(() => setConfig("pendingEmailChange", address));

    console.log();
    console.log("  The address is not changed until you confirm the code:");
    console.log(`    ${chalk.cyan("nemar auth profile verify-email <code>")}`);
    console.log(chalk.dim("  The code expires in 10 minutes."));
    if (result.dev_code) {
      console.log(chalk.dim(`  (development backend echoed the code: ${result.dev_code})`));
    }
    if (result.dev_skip) {
      console.log(
        chalk.yellow(
          "  This backend is non-production and did not mail anything (delivery allow-list).",
        ),
      );
    }
    console.log(chalk.dim(`  ${SETTINGS_HINT}`));
  });

addVerboseHelp(
  profileSetEmailCmd,
  `
Description:
  Step one of changing the email address your NEMAR account signs in with.
  A 6-digit code goes to the NEW address; nothing changes until you enter it
  with 'nemar auth profile verify-email'. The old address is told once the
  change lands, so a change you did not make is visible to you.

  An address that already belongs to a NEMAR account is refused: one person,
  one account. Change it on the account that holds it instead.

  Your API key keeps working across the change -- it is tied to the account,
  not to the address.

Examples:
  $ nemar auth profile set-email ada@lab.example.org
  $ nemar auth profile verify-email 123456`,
);

// ------------------------------------------------------------- verify-email

const profileVerifyEmailCmd = profileCmd
  .command("verify-email <code>")
  .description("Finish an email change with the code sent to the new address")
  .option("--email <address>", "The address the code was sent to (defaults to the last requested)")
  .action(async (code: string, options: { email?: string }) => {
    if (!requireAuthenticatedForChange()) return;
    const address = (options.email ?? getConfig().pendingEmailChange ?? "").trim();
    if (!address) {
      // No stored request: a code alone cannot say which address it proves.
      console.log(chalk.yellow("No pending email change on this machine"));
      console.log();
      console.log("  Run 'nemar auth profile set-email <address>' first,");
      console.log("  or pass the address with --email <address>.");
      process.exitCode = 1;
      return;
    }

    const spinner = ora(`Confirming ${address}...`).start();
    let result: Awaited<ReturnType<typeof verifyEmailChange>>;
    try {
      result = await verifyEmailChange(address, code);
    } catch (error) {
      failWithApiError(spinner, error, "Could not confirm the new address");
      return;
    }

    // The address HAS moved and the code is spent, so success is reported
    // before anything local is touched: a `conf` write failure here used to
    // print "Could not confirm the new address" for a change that had landed
    // (#1266 review).
    spinner.succeed(`Account email is now ${address}`);
    // Written from the address we just proved rather than from the refresh
    // below: a refresh that fails must not leave the old address cached as if
    // nothing had happened.
    updateLocalConfig(() => {
      setConfig("email", address);
      deleteConfig("pendingEmailChange");
    });
    if (result.old_address_notified === false) {
      console.log(
        chalk.yellow("  The previous address could not be notified; the change still applied."),
      );
    }
    await refreshStoredAccount();
    console.log(chalk.dim("  Sign-in codes and NEMAR mail now go to the new address."));
  });

addVerboseHelp(
  profileVerifyEmailCmd,
  `
Description:
  Step two of an email change. The code is bound to BOTH the new address and
  your account, so a code from someone else's request cannot be redeemed here,
  and five wrong guesses invalidate it -- request a new one with
  'nemar auth profile set-email'.

  The address is remembered from the set-email step; pass --email if you are
  finishing a change started on another machine.

Examples:
  $ nemar auth profile verify-email 123456
  $ nemar auth profile verify-email 123456 --email ada@lab.example.org`,
);

// -------------------------------------------------------------- set-github

const profileSetGithubCmd = profileCmd
  .command("set-github <handle>")
  .description("Set the GitHub username on your account")
  .action(async (handle: string) => {
    await applyProfilePatch(
      { github_username: handle },
      `Checking GitHub for ${handle}...`,
      `GitHub username set to ${handle}`,
    );
  });

addVerboseHelp(
  profileSetGithubCmd,
  `
Description:
  Sets the GitHub username your dataset repositories are shared with. The
  handle must EXIST on GitHub -- it is looked up before it is stored -- and it
  may back only one NEMAR account.

  Ownership is not proved here: what matters for a review is that the account
  an admin will add as a collaborator resolves.

Examples:
  $ nemar auth profile set-github octocat`,
);

// ------------------------------------------------------------ set-username

const profileSetUsernameCmd = profileCmd
  .command("set-username <name>")
  .description("Set your NEMAR username (locked once an admin approves the account)")
  .action(async (name: string) => {
    await applyProfilePatch(
      { username: name },
      `Setting your username to ${name}...`,
      `Username set to ${name}`,
    );
  });

addVerboseHelp(
  profileSetUsernameCmd,
  `
Description:
  Your NEMAR handle: what 'nemar admin approve <username>' addresses and what
  the dataset repositories you own are attributed to.

  It can be set while it is empty at any time, and CHANGED until an admin
  approves your account -- after that a rename needs an admin, because other
  records already point at it.

Examples:
  $ nemar auth profile set-username alovelace`,
);

// ---------------------------------------------------------------- set-name

const profileSetNameCmd = profileCmd
  .command("set-name")
  .description("Set the given and family name your DOIs cite")
  .option("--given <name>", "Given (first) name")
  .option("--family <name>", "Family (last) name")
  .action(async (options: { given?: string; family?: string }) => {
    if (options.given === undefined && options.family === undefined) {
      console.log(chalk.yellow("Nothing to set"));
      console.log();
      console.log("  Pass --given and/or --family, e.g.");
      console.log("    nemar auth profile set-name --given Ada --family Lovelace");
      process.exitCode = 1;
      return;
    }
    const patch: ProfilePatchRequest = {};
    if (options.given !== undefined) patch.given_name = options.given;
    if (options.family !== undefined) patch.family_name = options.family;
    await applyProfilePatch(patch, "Setting your name...", "Name updated");
  });

addVerboseHelp(
  profileSetNameCmd,
  `
Description:
  The name a DOI cites you by. Both halves are required before a dataset can
  be published, which is why this is settable at all.

  It is refused while a VERIFIED ORCID iD is linked: ORCID is canonical there
  and its record is re-read on every sign-in, so an edit here would be
  silently overwritten. Change it at orcid.org and sign in again, or unlink
  the iD first.

Examples:
  $ nemar auth profile set-name --given Ada --family Lovelace`,
);

// ------------------------------------------------------------ set-location

const profileSetLocationCmd = profileCmd
  .command("set-location")
  .description("Set the city and country on your account")
  .option("--city <city>", "City")
  .option("--country <country>", "Country")
  .action(async (options: { city?: string; country?: string }) => {
    if (options.city === undefined && options.country === undefined) {
      console.log(chalk.yellow("Nothing to set"));
      console.log();
      console.log("  Pass --city and/or --country, e.g.");
      console.log("    nemar auth profile set-location --city 'San Diego' --country USA");
      process.exitCode = 1;
      return;
    }
    const patch: ProfilePatchRequest = {};
    if (options.city !== undefined) patch.city = options.city;
    if (options.country !== undefined) patch.country = options.country;
    await applyProfilePatch(patch, "Setting your location...", "Location updated");
  });

addVerboseHelp(
  profileSetLocationCmd,
  `
Description:
  City and country are required for the export-control screening an admin
  does before granting upload access, so an upload-access request is refused
  without them. Neither may be blank.

Examples:
  $ nemar auth profile set-location --city "San Diego" --country USA`,
);

// ------------------------------------------------------------------- orcid

/** How often the link flow re-checks whether the iD has landed. */
const ORCID_POLL_INTERVAL_MS = 3000;

/**
 * Wait for a browser-side ORCID link to finish, or give up.
 *
 * The link is completed by the ORCID callback in the browser, so there is
 * nothing for the CLI to await except the account itself changing. Polling
 * `/users/me` is that: for a link, an iD appearing; for a relink, a DIFFERENT
 * iD appearing, which is why the previous value is passed in rather than
 * re-read (a relink to the same account keeps `orcid` non-null throughout,
 * so "non-null" would report success the instant it started).
 *
 * A transient failure mid-wait is ignored on purpose -- the browser flow is
 * unaffected by our polling, and the timeout is the only thing that ends the
 * wait unhappily.
 */
/**
 * Consecutive unreachable polls before the wait is abandoned. Three at the
 * three-second interval is roughly ten seconds of silence -- long enough to
 * ride out one dropped request, short enough not to spend five minutes
 * pretending to wait for a browser flow that cannot report back.
 */
const ORCID_POLL_MAX_NETWORK_FAILURES = 3;

/**
 * Why a wait ended. `timeout` is the ordinary "they walked away" case; the
 * other two are conditions that will not improve by waiting longer, and each
 * has a different thing for the person to do (#1266 review item 7).
 */
type OrcidWaitOutcome =
  | { kind: "linked"; orcid: string }
  | { kind: "timeout" }
  | { kind: "unauthenticated" }
  | { kind: "unreachable"; detail: string };

async function waitForOrcidLink(
  previousOrcid: string | null,
  timeoutMs: number,
): Promise<OrcidWaitOutcome> {
  const deadline = Date.now() + timeoutMs;
  let networkFailures = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, ORCID_POLL_INTERVAL_MS));
    try {
      const user = await getCurrentUser();
      networkFailures = 0;
      const current = user.orcid ?? null;
      if (current && current !== previousOrcid) return { kind: "linked", orcid: current };
    } catch (error) {
      // A 401 is not a transient poll failure: the key this command is holding
      // has been revoked or regenerated, and no amount of waiting fixes it.
      // Burning the full timeout on it ends in "gave up waiting", which sends
      // the person to look at their browser rather than at their credentials.
      if (error instanceof ApiError && error.statusCode === 401) {
        return { kind: "unauthenticated" };
      }
      // statusCode 0 is this codebase's convention for a network-layer
      // failure (lib/api/client.ts). One is noise; several in a row means the
      // API is not reachable from here, and the browser flow's result is
      // unknowable until it is.
      if (error instanceof ApiError && error.statusCode === 0) {
        networkFailures += 1;
        if (networkFailures >= ORCID_POLL_MAX_NETWORK_FAILURES) {
          return { kind: "unreachable", detail: errorDetail(error) };
        }
      } else {
        // Anything else (a 5xx, a contract drift) is treated as transient:
        // it says nothing about the browser flow, which is what we are
        // actually waiting on.
        networkFailures = 0;
      }
    }
  }
  return { kind: "timeout" };
}

/**
 * Parse `--timeout` at the ARGUMENT boundary, so a bad value is a usage error
 * (#1266 review item 9).
 *
 * It used to fall back to 300 silently, which is the worst of both: a typo
 * (`--timeout 5m`) was accepted and then ignored, and the person watched a
 * five-minute wait they thought they had shortened. Commander turns an
 * InvalidArgumentError into its own usage failure with a non-zero exit.
 */
export function parseOrcidTimeout(raw: string): number {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds <= 0) {
    throw new InvalidArgumentError("--timeout must be a whole number of seconds greater than 0");
  }
  return seconds;
}

const profileOrcidCmd = profileCmd
  .command("orcid <action>")
  .description("Link, re-link, or unlink your ORCID iD (link opens a browser)")
  .option("--no-open", "Print the URL instead of opening a browser")
  .option(
    "--timeout <seconds>",
    "How long to wait for the browser flow to finish",
    parseOrcidTimeout,
    300,
  )
  .option("-y, --yes", "Skip the confirmation prompt (unlink)")
  .option("-n, --no", "Decline the confirmation prompt (unlink)")
  .action(
    async (
      action: string,
      options: { open?: boolean; timeout?: number; yes?: boolean; no?: boolean },
    ) => {
      if (action !== "link" && action !== "relink" && action !== "unlink") {
        console.log(chalk.yellow(`Unknown action '${action}'`));
        console.log();
        console.log("  Use one of: link, relink, unlink");
        process.exitCode = 1;
        return;
      }
      if (!requireAuthenticatedForChange()) return;

      if (action === "unlink") {
        const result = await confirm(
          "Unlink your ORCID iD from this NEMAR account?",
          { yes: options.yes, no: options.no },
          false,
        );
        if (result !== "confirmed") {
          console.log(result === "declined" ? "Declined" : "Cancelled");
          return;
        }
        const spinner = ora("Unlinking your ORCID iD...").start();
        try {
          await unlinkOrcid();
          spinner.succeed("ORCID iD unlinked");
          console.log(
            chalk.dim(
              "  Your account no longer claims that iD. Link it again any time with 'nemar auth profile orcid link'.",
            ),
          );
          await refreshStoredAccount();
        } catch (error) {
          failWithApiError(spinner, error, "Could not unlink your ORCID iD");
        }
        return;
      }

      // link / relink: ORCID's consent screen is a browser page, so the CLI's
      // job is to get the person in front of it and then wait for the account
      // to change.
      const spinner = ora("Preparing the ORCID sign-in link...").start();
      let authorizeUrl: string;
      let previousOrcid: string | null = null;
      try {
        // Read the current iD FIRST: a relink is only observable as a change
        // from this value.
        previousOrcid = (await getCurrentUser()).orcid ?? null;
        const started = await startOrcidCliLink(action);
        authorizeUrl = started.authorize_url;
        spinner.stop();
      } catch (error) {
        failWithApiError(spinner, error, "Could not start the ORCID flow");
        return;
      }

      console.log();
      console.log("  Open this link and sign in with ORCID:");
      console.log(`    ${chalk.cyan(authorizeUrl)}`);
      console.log(chalk.dim("  The link is good for 10 minutes and works only for this account."));
      if (options.open !== false && openInBrowser(authorizeUrl)) {
        // "Trying", not "opened": the spawn returns before the child can fail,
        // so this is a claim about what was attempted (#1266 review item 8).
        console.log(chalk.dim("  (trying to open your browser; use the link above if it doesn't)"));
      }
      console.log();

      // Already validated by parseOrcidTimeout at the argument boundary.
      const timeoutSeconds = options.timeout ?? 300;
      const waitSpinner = ora("Waiting for you to finish in the browser...").start();
      const outcome = await waitForOrcidLink(previousOrcid, timeoutSeconds * 1000);
      if (outcome.kind === "linked") {
        waitSpinner.succeed(`ORCID iD ${outcome.orcid} is linked to your account`);
        await refreshStoredAccount();
        console.log(chalk.dim(`  ${SETTINGS_HINT}`));
        return;
      }
      if (outcome.kind === "unauthenticated") {
        waitSpinner.fail("Your credentials no longer authenticate");
        console.log();
        console.log("  Run 'nemar auth login' with a current API key, then try again.");
        console.log(
          chalk.dim("  If you finished the browser step, the link may still have been made."),
        );
        process.exitCode = 1;
        return;
      }
      if (outcome.kind === "unreachable") {
        waitSpinner.fail(`Cannot reach the API: ${outcome.detail}`);
        console.log();
        console.log("  The browser step may still have worked; check with 'nemar auth profile'.");
        process.exitCode = 1;
        return;
      }
      waitSpinner.warn("Gave up waiting for the browser flow");
      console.log();
      console.log("  If you finished it, check with 'nemar auth profile'.");
      console.log("  If the browser showed an error, run this command again.");
      process.exitCode = 1;
    },
  );

addVerboseHelp(
  profileOrcidCmd,
  `
Description:
  ORCID stays a browser flow: the consent screen is ORCID's, and no NEMAR
  command should ever ask for an ORCID password. This mints a short-lived link
  for THIS account, opens it if it can, and then waits for the iD to appear.

  link     attach an ORCID iD to an account that has none
  relink   replace the linked iD with a different one
  unlink   remove the link (and the iD this account claims)

  An iD backs at most one NEMAR account. If it is already linked elsewhere,
  unlink it there first.

  The link URL is printed whether or not a browser opens, so a headless or
  remote machine is a copy-and-paste rather than a dead end. Pass --no-open,
  or set NEMAR_NO_BROWSER=1, to stop the CLI reaching for a browser at all.

  Opening the link shows a NEMAR page naming the account it will link to
  before it sends you to ORCID. If that account is not yours, close the tab:
  the link was made by somebody else and would attach YOUR iD to THEIR
  account. A link can only be used once.

  --timeout is a whole number of seconds (default 300); the wait stops early
  if your credentials stop working or the API becomes unreachable.

Examples:
  $ nemar auth profile orcid link
  $ nemar auth profile orcid relink --no-open
  $ nemar auth profile orcid unlink --yes`,
);
