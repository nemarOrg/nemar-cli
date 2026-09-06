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
import { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import {
  UPLOAD_ACCESS_WHY_MAX_CHARS,
  UPLOAD_ACCESS_WHY_MIN_CHARS,
} from "../../shared/contract/user.js";
import {
  type OrcidNameResponse,
  type UploadAccessRequestResponse,
  checkGitHubUsername,
  checkOrcidName,
  checkUsername,
  getCurrentUser,
  login,
  requestKeyRegeneration,
  requestUploadAccess,
  resendVerification,
  retrieveKey,
  signup,
} from "../lib/api/auth.js";
import { ApiError, MaintenanceError } from "../lib/api/errors.js";
import { printStepFailure } from "../lib/cli-output.js";
import {
  DEFAULT_API_URL,
  clearAllConfig,
  clearConfig,
  getAccounts,
  getConfig,
  getConfigPath,
  isAuthenticated,
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
  username: "set it in Settings on nemar.org",
  given_name: "comes from your ORCID record; make it public at orcid.org, or set it in Settings",
  family_name: "comes from your ORCID record; make it public at orcid.org, or set it in Settings",
  github_username: "set it in Settings on nemar.org",
  city: "set it in Settings on nemar.org",
  country: "set it in Settings on nemar.org",
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
