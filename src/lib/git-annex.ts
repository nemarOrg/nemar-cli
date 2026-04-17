/**
 * Git-Annex Service
 *
 * Manages git-annex operations for dataset upload and download.
 * Requires git-annex >= 10.0 to be installed.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import chalk from "chalk";

/**
 * Version info for a tool
 */
export interface ToolVersion {
  installed: boolean;
  version?: string;
  minVersion?: string;
  compatible?: boolean;
  error?: string;
}

/**
 * Prerequisites check result
 * Note: AWS credentials are provided by the backend API (not from local ~/.aws/config)
 * and passed to git-annex operations during upload
 */
export interface PrerequisitesResult {
  gitAnnex: ToolVersion;
  githubSSH: { accessible: boolean; username?: string };
  allPassed: boolean;
  errors: string[];
}

/**
 * S3 remote configuration
 */
export interface S3RemoteConfig {
  name: string;
  bucket: string;
  prefix: string;
  region: string;
  publicUrl?: string;
}

/**
 * Dataset upload progress
 */
export interface UploadProgress {
  phase: "metadata" | "data" | "finalize";
  current: number;
  total: number;
  currentFile?: string;
  bytesTransferred?: number;
  bytesTotal?: number;
}

/**
 * Run a command and return stdout, stderr, and exit code.
 *
 * Sets GIT_TERMINAL_PROMPT=0 to prevent git from blocking on credential
 * prompts (which causes the CLI to appear hung). Callers can override
 * via options.env.
 *
 * An optional `timeout` (ms) kills the subprocess if exceeded; the returned
 * stderr will contain a timeout message and exitCode defaults to 1.
 */
export async function runCommand(
  cmd: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    /** Kill the process after this many milliseconds */
    timeout?: number;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd,
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...options.env,
    },
  });

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeout) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, options.timeout);
  }

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (timer) clearTimeout(timer);

  if (timedOut) {
    return {
      stdout,
      stderr: stderr || `Command timed out after ${Math.round(options.timeout! / 1000)}s`,
      exitCode: exitCode ?? 1,
    };
  }

  return { stdout, stderr, exitCode };
}

/**
 * Parse version string like "10.20241202" or "0.19.6"
 */
function parseVersion(versionStr: string): number[] {
  return versionStr.split(".").map((part) => {
    const num = Number.parseInt(part.replace(/[^0-9]/g, ""), 10);
    return Number.isNaN(num) ? 0 : num;
  });
}

/**
 * Compare versions: returns true if actual >= required
 */
function isVersionCompatible(actual: string, required: string): boolean {
  const actualParts = parseVersion(actual);
  const requiredParts = parseVersion(required);

  for (let i = 0; i < Math.max(actualParts.length, requiredParts.length); i++) {
    const a = actualParts[i] || 0;
    const r = requiredParts[i] || 0;
    if (a > r) return true;
    if (a < r) return false;
  }
  return true;
}

/**
 * Check if git-annex is installed and compatible
 */
export async function checkGitAnnexInstalled(): Promise<ToolVersion> {
  const minVersion = "10.0";

  try {
    const { stdout, exitCode, stderr } = await runCommand(["git-annex", "version"]);

    if (exitCode !== 0) {
      console.warn("git-annex version returned non-zero exit code:", exitCode);
      console.warn("stderr:", stderr);
      return { installed: false, minVersion, error: `Version check failed: ${stderr.trim()}` };
    }

    // Output is like "git-annex version: 10.20241202"
    const match = stdout.match(/version:\s*(\d+\.\d+)/);
    const version = match ? match[1] : undefined;

    if (!version) {
      console.warn("Could not parse git-annex version from output:", stdout);
    }

    return {
      installed: true,
      version,
      minVersion,
      compatible: version ? isVersionCompatible(version, minVersion) : undefined,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Differentiate between "not installed" and other errors
    if (errorMsg.includes("ENOENT") || errorMsg.includes("not found")) {
      console.info("git-annex not found in PATH");
      return { installed: false, minVersion };
    }

    // Other errors are concerning - log them
    console.error("Error checking git-annex installation:", errorMsg);
    return { installed: false, minVersion, error: errorMsg };
  }
}

/**
 * Check SSH access to GitHub
 */
export async function checkGitHubSSH(): Promise<{
  accessible: boolean;
  username?: string;
  useHttps?: boolean;
}> {
  // If GH_TOKEN is set, we can use HTTPS instead of SSH (for CI)
  if (process.env.GH_TOKEN) {
    return { accessible: true, username: "token-auth", useHttps: true };
  }

  try {
    const { stdout, stderr } = await runCommand([
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=10",
      "git@github.com",
    ]);

    // GitHub returns exit code 1 even on success, but message indicates auth
    const output = stdout + stderr;
    const match = output.match(/Hi ([^!]+)!/);

    if (match) {
      return { accessible: true, username: match[1] };
    }

    // Check for permission denied
    if (output.includes("Permission denied")) {
      return { accessible: false };
    }

    // Exit code 1 with "Hi" message is success
    return { accessible: output.includes("successfully authenticated") };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Differentiate between SSH not installed vs other errors
    if (errorMsg.includes("ENOENT") || errorMsg.includes("not found")) {
      console.info("SSH command not found");
    } else {
      console.error("Error checking GitHub SSH access:", errorMsg);
    }

    return { accessible: false };
  }
}

/**
 * Check if AWS credentials are configured
 */
export async function checkAWSCredentials(): Promise<{ configured: boolean; source?: string }> {
  // Check environment variables first
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return { configured: true, source: "environment" };
  }

  // Check AWS CLI configuration
  try {
    const { stdout, exitCode } = await runCommand(["aws", "configure", "get", "aws_access_key_id"]);

    if (exitCode === 0 && stdout.trim()) {
      return { configured: true, source: "aws-cli" };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Differentiate between AWS CLI not installed vs other errors
    if (errorMsg.includes("ENOENT") || errorMsg.includes("not found")) {
      console.info("AWS CLI not found in PATH");
    } else {
      console.error("Error checking AWS credentials:", errorMsg);
    }
  }

  return { configured: false };
}

/**
 * Get platform-specific installation command for git-annex
 */
function getGitAnnexInstallCommand(): string {
  const platform = process.platform;
  if (platform === "darwin") return "brew install git-annex";
  if (platform === "linux") return "apt install git-annex (Debian/Ubuntu)";
  return "See https://git-annex.branchable.com/install/";
}

/**
 * Check all prerequisites for dataset upload
 * Note: AWS credentials are provided by the backend after dataset creation
 */
export async function checkPrerequisites(): Promise<PrerequisitesResult> {
  const [gitAnnex, githubSSH] = await Promise.all([checkGitAnnexInstalled(), checkGitHubSSH()]);

  const errors: string[] = [];

  if (!gitAnnex.installed) {
    errors.push(`git-annex is not installed. Install: ${getGitAnnexInstallCommand()}`);
  } else if (gitAnnex.compatible === false) {
    errors.push(
      `git-annex version ${gitAnnex.version} is too old. Required: >= ${gitAnnex.minVersion}`,
    );
  }

  if (!githubSSH.accessible) {
    // HTTPS-first: try gh CLI token before failing on SSH
    const ghToken = await getGitHubToken();
    if (!ghToken.token) {
      errors.push("GitHub authentication not configured. Run 'gh auth login' to authenticate.");
    }
  }

  return {
    gitAnnex,
    githubSSH,
    allPassed: errors.length === 0,
    errors,
  };
}

/**
 * Check if a directory is already a git-annex dataset
 */
export async function isGitAnnexDataset(path: string): Promise<boolean> {
  // Check for .git directory first
  if (!existsSync(join(path, ".git"))) {
    return false;
  }

  // Check if git-annex is initialized
  try {
    const { exitCode } = await runCommand(["git", "annex", "info"], { cwd: path });
    return exitCode === 0;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Log unexpected errors
    if (!errorMsg.includes("ENOENT") && !errorMsg.includes("not found")) {
      console.error(`Error checking if ${path} is a git-annex dataset:`, errorMsg);
    }

    return false;
  }
}

/**
 * Initialize a git-annex dataset
 *
 * If author info is provided, sets GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL
 * to ensure the initial commit is attributed to the correct NEMAR user.
 */
export async function initDataset(
  path: string,
  options: { force?: boolean; author?: { name: string; email: string } } = {},
): Promise<{ success: boolean; error?: string }> {
  // Check if already a dataset
  if (!options.force && (await isGitAnnexDataset(path))) {
    return { success: true }; // Already initialized
  }

  try {
    // Build environment with optional author override
    const env: Record<string, string> = {};
    if (options.author) {
      env.GIT_AUTHOR_NAME = options.author.name;
      env.GIT_AUTHOR_EMAIL = options.author.email;
      env.GIT_COMMITTER_NAME = options.author.name;
      env.GIT_COMMITTER_EMAIL = options.author.email;
    }

    // Initialize git repository with explicit "main" branch name
    const { stderr: gitStderr, exitCode: gitExitCode } = await runCommand(
      ["git", "init", "-b", "main", path],
      {
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
    );

    if (gitExitCode !== 0) {
      return { success: false, error: gitStderr.trim() || "Failed to initialize git repository" };
    }

    // Initialize git-annex
    const envOpts = Object.keys(env).length > 0 ? { env } : {};
    const { stderr: initStderr, exitCode: initExitCode } = await runCommand(
      ["git", "annex", "init"],
      {
        cwd: path,
        ...envOpts,
      },
    );

    if (initExitCode !== 0) {
      return { success: false, error: initStderr.trim() || "Failed to initialize git-annex" };
    }

    // Create initial commit so git-annex adjust and branch detection work.
    // git-annex adjust --unlock requires at least one commit on the working branch,
    // and git rev-parse --abbrev-ref HEAD fails with no commits.
    const { stderr: commitStderr, exitCode: commitExitCode } = await runCommand(
      ["git", "commit", "--allow-empty", "-m", "Initialize dataset"],
      {
        cwd: path,
        ...envOpts,
      },
    );

    if (commitExitCode !== 0) {
      return { success: false, error: commitStderr.trim() || "Failed to create initial commit" };
    }

    // Use unlocked mode so data files remain as regular files (not symlinks)
    const { stderr: adjustStderr, exitCode: adjustExitCode } = await runCommand(
      ["git", "annex", "adjust", "--unlock"],
      {
        cwd: path,
        ...envOpts,
      },
    );

    if (adjustExitCode !== 0) {
      return {
        success: false,
        error: adjustStderr.trim() || "Failed to switch to unlocked mode",
      };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Ensure git-annex is initialized in the dataset
 * Safe to call multiple times - will not fail if already initialized
 */
export async function ensureGitAnnexInitialized(
  path: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Check if git-annex is initialized by trying to run a git-annex command
    const { exitCode: infoExitCode, stderr: infoStderr } = await runCommand(
      ["git", "annex", "info"],
      { cwd: path },
    );

    // If info works, git-annex is already initialized
    if (infoExitCode === 0) {
      return { success: true };
    }

    // If info fails with "First run" error, need to initialize
    if (infoStderr.includes("First run: git-annex init")) {
      const { stderr: initStderr, exitCode: initExitCode } = await runCommand(
        ["git", "annex", "init"],
        { cwd: path },
      );

      if (initExitCode !== 0) {
        return { success: false, error: initStderr.trim() || "Failed to initialize git-annex" };
      }

      return { success: true };
    }

    // Some other error
    return { success: false, error: infoStderr.trim() || "Failed to check git-annex status" };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Configure largefiles pattern for git-annex
 * Must be called BEFORE adding files to the dataset
 */
export async function configureLargefiles(
  path: string,
  pattern?: string,
): Promise<{ success: boolean; error?: string }> {
  // Annex large data files, but NEVER annex metadata files regardless of size.
  // Metadata must stay in git for BIDS validation and GitHub readability.
  // Note: exclude=*.tsv does not match *.tsv.gz (glob is exact), so compressed
  // data is correctly annexed.
  // Keep in sync with: scripts/nemar-restore-dataset.sh ANNEX_LARGEFILES
  const DATA_EXTENSIONS = ["*.edf", "*.bdf", "*.set", "*.fif", "*.vhdr", "*.eeg", "*.cnt", "*.fdt"];
  const METADATA_EXCLUSIONS = [
    "*.tsv",
    "*.json",
    "*.md",
    "*.txt",
    "*.yml",
    "*.yaml",
    "README*",
    "LICENSE*",
    "CHANGES*",
    ".bidsignore",
    ".gitignore",
  ];

  const includes = DATA_EXTENSIONS.map((ext) => `include=${ext}`).join(" or ");
  const excludes = METADATA_EXCLUSIONS.map((pat) => `exclude=${pat}`).join(" and ");
  const defaultPattern = `(${includes} or largerthan=100kb) and ${excludes}`;

  const largefilesPattern = pattern || defaultPattern;

  try {
    const { stderr, exitCode } = await runCommand(
      ["git", "annex", "config", "--set", "annex.largefiles", largefilesPattern],
      { cwd: path },
    );

    if (exitCode !== 0) {
      return { success: false, error: stderr.trim() || "Failed to configure largefiles" };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Stage files with git-annex. Data files matching the largefiles pattern
 * are added to the annex; other files are added to git normally.
 */
export async function gitAnnexAdd(
  path: string,
  target = ".",
): Promise<{ success: boolean; error?: string }> {
  try {
    const { stderr, exitCode } = await runCommand(["git", "annex", "add", target], { cwd: path });
    if (exitCode !== 0) {
      return { success: false, error: stderr.trim() || "Failed to add files to git-annex" };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * S3 credentials for git-annex operations.
 * Supports both long-lived IAM credentials and temporary STS credentials.
 */
export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Map API credential response to S3Credentials for git-annex operations.
 */
export function toS3Credentials(creds: {
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
}): S3Credentials {
  return {
    accessKeyId: creds.access_key_id,
    secretAccessKey: creds.secret_access_key,
    sessionToken: creds.session_token,
  };
}

/**
 * Filter informational git-annex messages from stderr.
 * These warnings are harmless side effects, not actual errors.
 */
function filterAnnexInfoMessages(stderr: string): string {
  // Known safe patterns: git-annex progress/bookkeeping messages
  const safePatterns = [
    /^\(merging .* into .*\.\.\.\)$/,
    /^\(recording state in git\.\.\.\)$/,
    /^\(scanning for /,
    /^\(checking /,
  ];
  return stderr
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      // "Remote origin not usable by git-annex; setting annex-ignore"
      if (trimmed.includes("setting annex-ignore")) return false;
      if (safePatterns.some((p) => p.test(trimmed))) return false;
      return true;
    })
    .join("\n")
    .trim();
}

/**
 * Build git-annex S3 special remote key=value config arguments,
 * shared by initremote and enableremote. Normalizes the prefix to
 * always end with exactly one slash. Conditionally includes publicurl.
 */
function buildS3RemoteArgs(config: S3RemoteConfig): string[] {
  const params = [
    "type=S3",
    "encryption=none",
    `bucket=${config.bucket}`,
    `fileprefix=${config.prefix.replace(/\/$/, "")}/`,
    `datacenter=${config.region}`,
    "signature=v4",
    "autoenable=true",
    "protocol=https",
  ];
  if (config.publicUrl) {
    params.push(`publicurl=${config.publicUrl}`);
  }
  return params;
}

/**
 * Check whether a named special remote is registered in git-annex.
 * Searches repository descriptions in `git annex info --json` for either
 * `[name]` (standard description format for special remotes) or an exact
 * name match. Returns false on any error (caller falls back to initremote).
 */
async function annexRemoteExists(path: string, name: string): Promise<boolean> {
  const { stdout, stderr, exitCode } = await runCommand(["git", "annex", "info", "--json"], {
    cwd: path,
  });
  if (exitCode !== 0) {
    console.warn(
      `Warning: could not check for existing remote (git annex info exited ${exitCode}): ${stderr.trim()}`,
    );
    return false;
  }
  try {
    const info = JSON.parse(stdout);
    const repos = [
      ...(info["semitrusted repositories"] ?? []),
      ...(info["trusted repositories"] ?? []),
      ...(info["untrusted repositories"] ?? []),
    ];
    return repos.some(
      (r: { description?: string }) =>
        r.description?.includes(`[${name}]`) || r.description === name,
    );
  } catch (e) {
    console.warn(`Warning: could not parse git annex info output: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Run `git annex enableremote` with full S3 config params and credentials.
 * Returns success/error result.
 */
async function enableS3RemoteWithConfig(
  path: string,
  name: string,
  s3Params: string[],
  env: Record<string, string>,
): Promise<{ success: boolean; error?: string }> {
  const args = ["git", "annex", "enableremote", name, ...s3Params];
  const result = await runCommand(args, { cwd: path, env });
  if (result.exitCode !== 0) {
    const realStderr = filterAnnexInfoMessages(result.stderr);
    return {
      success: false,
      error:
        realStderr || result.stderr.trim() || `enableremote exited with code ${result.exitCode}`,
    };
  }
  return { success: true };
}

/**
 * Configure S3 special remote for git-annex.
 *
 * Handles resume: if the remote already exists (from a previous failed upload),
 * uses `enableremote` with full S3 config to reconnect. Pre-suppresses the
 * annex-ignore warning on origin so it does not pollute stderr error reporting.
 * The remote is configured with publicurl for credential-free downloads and
 * autoenable=true so clones automatically enable it.
 */
export async function configureS3Remote(
  path: string,
  config: S3RemoteConfig,
  credentials: S3Credentials,
): Promise<{ success: boolean; error?: string }> {
  const env: Record<string, string> = {
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
  };
  if (credentials.sessionToken) {
    env.AWS_SESSION_TOKEN = credentials.sessionToken;
  }

  // Pre-suppress "Remote origin not usable by git-annex; setting annex-ignore"
  // warning. While harmless, this message pollutes stderr and can obscure real errors.
  // filterAnnexInfoMessages provides a backup if this config fails to apply.
  const configResult = await runCommand(["git", "config", "remote.origin.annex-ignore", "true"], {
    cwd: path,
  });
  if (configResult.exitCode !== 0) {
    console.warn(
      `Warning: could not set remote.origin.annex-ignore: ${configResult.stderr.trim()}`,
    );
  }

  const s3Params = buildS3RemoteArgs(config);

  try {
    // Check if the remote already exists from a previous attempt
    const exists = await annexRemoteExists(path, config.name);

    if (exists) {
      return enableS3RemoteWithConfig(path, config.name, s3Params, env);
    }

    const initArgs = ["git", "annex", "initremote", config.name, ...s3Params];
    const { stderr, exitCode } = await runCommand(initArgs, { cwd: path, env });

    if (exitCode !== 0) {
      // Fallback: initremote reported remote already exists (e.g., our
      // pre-check missed it or the description format was unexpected)
      if (stderr.includes("already exists")) {
        return enableS3RemoteWithConfig(path, config.name, s3Params, env);
      }

      const realStderr = filterAnnexInfoMessages(stderr);
      return { success: false, error: realStderr || "Failed to configure S3 remote" };
    }

    // Log any surviving warnings even on success
    const residualStderr = filterAnnexInfoMessages(stderr);
    if (residualStderr) {
      console.warn(`  Warning during S3 remote setup: ${residualStderr}`);
    }

    return { success: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { success: false, error: `S3 remote configuration failed: ${message}` };
  }
}

/**
 * Clear cached S3 credentials from git-annex's local credential store.
 *
 * git-annex caches AWS credentials in .git/annex/creds/ during initremote.
 * When using STS temporary credentials, these expire and cause 403 errors
 * on subsequent downloads instead of falling back to publicurl.
 * Call this after upload completes so downloads use publicurl.
 */
export async function clearAnnexCredentials(path: string): Promise<void> {
  const { join } = await import("node:path");
  const { readdirSync, unlinkSync } = await import("node:fs");
  const credsDir = join(path, ".git", "annex", "creds");
  let files: string[];
  try {
    files = readdirSync(credsDir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn(`Warning: Could not read ${credsDir}: ${(e as Error).message}`);
    return;
  }
  for (const file of files) {
    try {
      unlinkSync(join(credsDir, file));
    } catch (e: unknown) {
      console.warn(`Warning: Could not delete ${file}: ${(e as Error).message}`);
    }
  }
}

/**
 * Enable an existing S3 special remote in a cloned repository.
 *
 * After `git clone` + `git annex init`, the remote config exists in the git-annex
 * branch but is not active locally. This function enables it so `git annex get`
 * can fetch from the S3 publicurl without write credentials.
 *
 * Returns success even if the remote doesn't exist (old datasets without S3 remote),
 * so callers don't need to handle backward compatibility.
 */
export async function enableS3Remote(
  path: string,
  remoteName = "nemar-s3",
  credentials?: S3Credentials,
): Promise<{ success: boolean; enabled: boolean; error?: string }> {
  try {
    const env: Record<string, string> = {};
    if (credentials) {
      env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
      env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
      if (credentials.sessionToken) {
        env.AWS_SESSION_TOKEN = credentials.sessionToken;
      }
    }

    const { stderr, exitCode } = await runCommand(["git", "annex", "enableremote", remoteName], {
      cwd: path,
      ...(Object.keys(env).length > 0 && {
        env: Object.fromEntries(
          Object.entries({ ...process.env, ...env }).filter(
            (e): e is [string, string] => e[1] != null,
          ),
        ),
      }),
    });

    if (exitCode === 0) {
      return { success: true, enabled: true };
    }

    // Remote not found in git-annex branch (old dataset) - not an error
    if (
      stderr.includes("there is no special remote named") ||
      stderr.includes("not a special remote") ||
      stderr.includes("Unknown remote") ||
      stderr.includes("not found")
    ) {
      return { success: true, enabled: false };
    }

    return { success: false, enabled: false, error: stderr.trim() };
  } catch (e) {
    return { success: false, enabled: false, error: (e as Error).message };
  }
}

/**
 * Test if GitHub SSH access is configured and working
 *
 * Note: SSH test to GitHub returns exit code 1 even on success (GitHub's PTY restriction)
 * We check stderr for "successfully authenticated" message to confirm it works
 */
async function testGitHubSsh(): Promise<{ works: boolean; error?: string }> {
  try {
    const { exitCode, stderr } = await runCommand([
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      "git@github.com",
    ]);

    const works = stderr.includes("successfully authenticated");
    if (!works) {
      console.warn("SSH test to github.com failed:", {
        exitCode,
        stderr: stderr.trim().slice(0, 500),
      });
    }
    return { works, error: works ? undefined : stderr.trim().slice(0, 500) };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn("SSH test exception:", errorMsg);
    return { works: false, error: errorMsg };
  }
}

/**
 * Get GitHub token from gh CLI
 */
async function getGitHubToken(): Promise<{ token: string | null; error?: string }> {
  try {
    const { stdout, exitCode, stderr } = await runCommand(["gh", "auth", "token"]);

    if (exitCode !== 0) {
      console.warn("gh CLI returned non-zero exit code:", exitCode);
      console.warn("stderr:", stderr);
      return { token: null, error: `gh auth token failed: ${stderr.trim() || "unknown error"}` };
    }

    if (!stdout.trim()) {
      console.warn("gh auth token returned empty output");
      return { token: null, error: "gh CLI returned empty token" };
    }

    return { token: stdout.trim() };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Failed to get GitHub token from gh CLI:", errorMsg);

    // Provide specific guidance based on error
    if (errorMsg.includes("ENOENT") || errorMsg.includes("not found")) {
      return { token: null, error: "gh CLI not installed (command not found)" };
    }

    return { token: null, error: `gh CLI error: ${errorMsg}` };
  }
}

/**
 * Verify that the gh CLI is authenticated as the expected GitHub user.
 * This is important because GitHub operations (accepting invitations, pushing)
 * must be done as the correct user.
 *
 * @param expectedUsername - The GitHub username the user should be authenticated as
 * @returns Verification result with the actual authenticated username if available
 */
export async function verifyGitHubAuth(expectedUsername?: string): Promise<{
  authenticated: boolean;
  username?: string;
  matches?: boolean;
  error?: string;
}> {
  try {
    // Check if gh CLI is authenticated and get the current user
    const { stdout, exitCode, stderr } = await runCommand(["gh", "api", "user", "--jq", ".login"]);

    if (exitCode !== 0) {
      // Check for specific error cases
      if (stderr.includes("not logged in") || stderr.includes("auth login")) {
        return {
          authenticated: false,
          error: "gh CLI not authenticated. Run 'gh auth login' to authenticate.",
        };
      }
      return {
        authenticated: false,
        error: `gh CLI error: ${stderr.trim() || "unknown error"}`,
      };
    }

    const actualUsername = stdout.trim();
    if (!actualUsername) {
      return {
        authenticated: false,
        error: "gh CLI returned empty username",
      };
    }

    // If expected username provided, check if it matches
    if (expectedUsername) {
      const matches = actualUsername.toLowerCase() === expectedUsername.toLowerCase();
      return {
        authenticated: true,
        username: actualUsername,
        matches,
        error: matches
          ? undefined
          : `gh CLI authenticated as '${actualUsername}', expected '${expectedUsername}'`,
      };
    }

    return {
      authenticated: true,
      username: actualUsername,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    if (errorMsg.includes("ENOENT") || errorMsg.includes("not found")) {
      return {
        authenticated: false,
        error: "gh CLI not installed. Install from https://cli.github.com/",
      };
    }

    return {
      authenticated: false,
      error: `Failed to verify gh CLI: ${errorMsg}`,
    };
  }
}

/**
 * Accept a pending GitHub repository invitation.
 *
 * After a dataset is created, the backend invites the user as a collaborator.
 * This function finds and accepts that invitation so the user can push without
 * manually accepting in the browser.
 *
 * @param repoFullName - The full repository name (e.g., "nemarDatasets/nm000123")
 * @returns Result indicating whether invitation was accepted
 */
export async function acceptGitHubInvitation(repoFullName: string): Promise<{
  accepted: boolean;
  error?: string;
  alreadyCollaborator?: boolean;
}> {
  // Validate repository name format to prevent injection
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repoFullName)) {
    return {
      accepted: false,
      error: `Invalid repository format: ${repoFullName}`,
    };
  }

  // List pending invitations for the current user
  // Note: We fetch all invitations and filter in JS to avoid jq injection
  const { stdout, exitCode, stderr } = await runCommand([
    "gh",
    "api",
    "/user/repository_invitations",
  ]);

  if (exitCode !== 0) {
    // Check for specific error cases
    if (stderr.includes("not logged in") || stderr.includes("auth login")) {
      return {
        accepted: false,
        error: "gh CLI not authenticated. Run 'gh auth login' to authenticate.",
      };
    }
    if (stderr.includes("API rate limit") || stderr.includes("403")) {
      return {
        accepted: false,
        error: "GitHub API rate limit exceeded. Please try again in a few minutes.",
      };
    }
    if (stderr.includes("ENOENT") || stderr.includes("not found")) {
      return {
        accepted: false,
        error: "gh CLI not installed. Install from https://cli.github.com/",
      };
    }
    return {
      accepted: false,
      error: `Failed to list invitations: ${stderr.trim() || "unknown error"}`,
    };
  }

  // Parse invitations and find the one for our repo
  let invitationId: number | null = null;
  try {
    const invitations = JSON.parse(stdout || "[]") as Array<{
      id: number;
      repository: { full_name: string };
    }>;
    const invitation = invitations.find((inv) => inv.repository.full_name === repoFullName);
    invitationId = invitation?.id ?? null;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Failed to parse GitHub invitations response:", errorMsg);
    console.error("  Raw response (first 500 chars):", (stdout || "").slice(0, 500));
    return {
      accepted: false,
      error: `Failed to parse GitHub API response: ${errorMsg}`,
    };
  }

  // No invitation found - user might already be a collaborator
  if (!invitationId) {
    // Check if user already has access to the repo
    const { exitCode: checkExitCode } = await runCommand([
      "gh",
      "api",
      `/repos/${repoFullName}`,
      "--silent",
    ]);

    if (checkExitCode === 0) {
      return {
        accepted: true,
        alreadyCollaborator: true,
      };
    }

    return {
      accepted: false,
      error: `No pending invitation found for ${repoFullName}. You may need to accept it manually via GitHub.`,
    };
  }

  // Accept the invitation
  const { exitCode: acceptExitCode, stderr: acceptStderr } = await runCommand([
    "gh",
    "api",
    "--method",
    "PATCH",
    `/user/repository_invitations/${invitationId}`,
  ]);

  if (acceptExitCode !== 0) {
    return {
      accepted: false,
      error: `Failed to accept invitation: ${acceptStderr.trim() || "unknown error"}`,
    };
  }

  return { accepted: true };
}

export async function configureGitHubRemote(
  path: string,
  repoUrl: string,
  remoteName = "origin",
): Promise<{ success: boolean; error?: string }> {
  // Transform GitHub SSH URL based on environment and configuration
  // Priority: CI token > SSH > HTTPS with gh token
  let finalUrl = repoUrl;

  // CI/CD: Use HTTPS with GH_TOKEN
  if (process.env.GH_TOKEN && repoUrl.startsWith("git@github.com:")) {
    const token = process.env.GH_TOKEN.trim();
    if (!token || /\s/.test(token)) {
      return {
        success: false,
        error:
          "GH_TOKEN environment variable is set but appears malformed (empty or contains whitespace)",
      };
    }
    const repoPath = repoUrl.replace("git@github.com:", "");
    finalUrl = `https://github.com/${repoPath}`;
    // Set token via credential helper instead of embedding in URL
    await runCommand(
      [
        "git",
        "config",
        "credential.https://github.com.helper",
        `!printf 'username=x-access-token\\npassword=${token}'`,
      ],
      { cwd: path },
    );
  }
  // Local: Try HTTPS via gh CLI token first (preferred), then SSH as fallback
  else if (repoUrl.startsWith("git@github.com:")) {
    const repoPath = repoUrl.replace("git@github.com:", "");

    const ghTokenResult = await getGitHubToken();

    if (ghTokenResult.token) {
      finalUrl = `https://github.com/${repoPath}`;
      // Set token via credential helper instead of embedding in URL
      await runCommand(
        [
          "git",
          "config",
          "credential.https://github.com.helper",
          `!printf 'username=x-access-token\\npassword=${ghTokenResult.token}'`,
        ],
        { cwd: path },
      );
    } else {
      // HTTPS not available, try SSH as last resort
      const sshResult = await testGitHubSsh();

      if (sshResult.works) {
        finalUrl = repoUrl;
      } else {
        return {
          success: false,
          error: `GitHub authentication not configured.

gh CLI failed: ${ghTokenResult.error || "could not get token"}
SSH failed: ${sshResult.error || "could not connect"}

Fix one of these:
  1. Install and authenticate gh CLI (recommended):
     brew install gh && gh auth login

  2. Configure SSH for GitHub:
     ssh-keygen -t ed25519 -C "your@email.com"
     Add the public key to https://github.com/settings/keys
     Test with: ssh -T git@github.com`,
        };
      }
    }
  }

  try {
    // Check if remote already exists
    const { stdout } = await runCommand(["git", "remote", "get-url", remoteName], { cwd: path });

    if (stdout.trim()) {
      // Remote exists, update it
      const { stderr, exitCode } = await runCommand(
        ["git", "remote", "set-url", remoteName, finalUrl],
        { cwd: path },
      );

      if (exitCode !== 0) {
        return { success: false, error: stderr.trim() };
      }
    } else {
      // Remote doesn't exist, add it
      const { stderr, exitCode } = await runCommand(
        ["git", "remote", "add", remoteName, finalUrl],
        { cwd: path },
      );

      if (exitCode !== 0) {
        return { success: false, error: stderr.trim() };
      }
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Save all changes to the dataset
 *
 * If author info is provided, sets GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL
 * to ensure commits are attributed to the correct NEMAR user.
 */
export async function saveDataset(
  path: string,
  message: string,
  author?: { name: string; email: string },
): Promise<{ success: boolean; error?: string }> {
  try {
    // Build environment with optional author override
    const env: Record<string, string> = {};
    if (author) {
      env.GIT_AUTHOR_NAME = author.name;
      env.GIT_AUTHOR_EMAIL = author.email;
      env.GIT_COMMITTER_NAME = author.name;
      env.GIT_COMMITTER_EMAIL = author.email;
    }

    // Stage all changes with git add
    const { stderr: addStderr, exitCode: addExitCode } = await runCommand(["git", "add", "-A"], {
      cwd: path,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    });

    if (addExitCode !== 0) {
      return { success: false, error: addStderr.trim() || "Failed to stage changes" };
    }

    // Check if there are changes to commit
    const {
      stdout: statusOut,
      exitCode: statusExitCode,
      stderr: statusStderr,
    } = await runCommand(["git", "status", "--porcelain"], {
      cwd: path,
    });

    if (statusExitCode !== 0) {
      return { success: false, error: statusStderr.trim() || "Failed to check git status" };
    }

    if (!statusOut.trim()) {
      // Nothing to commit
      return { success: true };
    }

    // Commit the changes
    const { stderr: commitStderr, exitCode: commitExitCode } = await runCommand(
      ["git", "commit", "-m", message],
      {
        cwd: path,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
    );

    if (commitExitCode !== 0) {
      // Check if there's nothing to commit
      if (commitStderr.includes("nothing to commit")) {
        return { success: true };
      }
      return { success: false, error: commitStderr.trim() || "Failed to commit changes" };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Push data to S3 remote with parallel uploads
 */
/**
 * Push metadata to GitHub
 */
export async function pushToGitHub(
  path: string,
  remoteName = "origin",
  branch?: string,
): Promise<{ success: boolean; error?: string; warning?: string }> {
  try {
    // Detect current branch if not specified
    let branchToPush = branch;
    if (!branchToPush) {
      const currentBranch = await getCurrentBranch(path);
      if (!currentBranch || currentBranch === "HEAD") {
        // Check if there are any commits
        const { exitCode: logExitCode } = await runCommand(["git", "log", "-1", "--oneline"], {
          cwd: path,
        });

        if (logExitCode !== 0) {
          return {
            success: false,
            error:
              "No commits found. The repository may not have been initialized correctly, " +
              "or no changes were saved before pushing.",
          };
        }

        // In detached HEAD state with commits, we can push using HEAD:main
        if (currentBranch === "HEAD") {
          branchToPush = "HEAD:main";
        } else {
          return { success: false, error: "Could not detect current branch" };
        }
      } else if (currentBranch.startsWith("adjusted/")) {
        // git-annex adjusted branches (e.g. "adjusted/main(unlocked)") track a base branch.
        // Extract the base branch name and push with the correct refspec.
        const baseBranch = currentBranch.replace(/^adjusted\//, "").replace(/\(.*\)$/, "");
        branchToPush = `${currentBranch}:${baseBranch}`;
      } else {
        branchToPush = currentBranch;
      }
    }

    // Push current branch
    const { stderr: mainStderr, exitCode: mainExitCode } = await runCommand(
      ["git", "push", "-u", remoteName, branchToPush],
      { cwd: path },
    );

    if (mainExitCode !== 0) {
      return { success: false, error: mainStderr.trim() || "Failed to push to GitHub" };
    }

    // Push git-annex branch (critical for cloning)
    const { stderr: annexStderr, exitCode: annexExitCode } = await runCommand(
      ["git", "push", remoteName, "git-annex"],
      { cwd: path },
    );

    if (annexExitCode !== 0) {
      // Not a fatal error, but return warning so callers can inform users
      return {
        success: true,
        warning: `Main branch pushed, but git-annex branch failed: ${annexStderr.trim()}. Clone operations may have issues.`,
      };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Get dataset file statistics
 */
export async function getDatasetStats(path: string): Promise<{
  totalFiles: number;
  totalSize: number;
  annexedFiles: number;
  annexedSize: number;
}> {
  try {
    // Use git annex info for statistics
    const { stdout, exitCode } = await runCommand(["git", "annex", "info", "--json"], {
      cwd: path,
    });

    if (exitCode === 0) {
      const info = JSON.parse(stdout);
      return {
        totalFiles: info["local annex keys"] || 0,
        totalSize: info["local annex size"] || 0,
        annexedFiles: info["local annex keys"] || 0,
        annexedSize: info["local annex size"] || 0,
      };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Log the error before falling back
    console.warn("git annex info failed, falling back to manual counting:", errorMsg);
  }

  // Fallback: count files manually
  const { stdout: findOutput } = await runCommand(["find", path, "-type", "f"], { cwd: path });
  const files = findOutput.trim().split("\n").filter(Boolean);

  return {
    totalFiles: files.length,
    totalSize: 0,
    annexedFiles: 0,
    annexedSize: 0,
  };
}

// Re-export formatBytes from progress.ts (canonical implementation)
export { formatBytes } from "./progress.js";

// =============================================================================
// Presigned URL Upload Functions
// =============================================================================

export interface PresignedUploadProgress {
  file: string;
  uploaded: number;
  total: number;
  status: "pending" | "uploading" | "completed" | "failed";
  error?: string;
}

/**
 * Upload a single file to S3 using a presigned URL
 *
 * Includes retry logic for transient errors:
 * - 403 AccessDenied: IAM eventual consistency delays after policy updates
 * - 503 SlowDown: S3 rate limiting when too many concurrent requests hit the bucket
 */
export async function uploadFileWithPresignedUrl(
  filePath: string,
  presignedUrl: string,
  onProgress?: (uploaded: number, total: number) => void,
  options?: { maxRetries?: number; initialDelayMs?: number },
): Promise<{ success: boolean; error?: string }> {
  const maxRetries = options?.maxRetries ?? 4;
  const initialDelayMs = options?.initialDelayMs ?? 10000; // 10 seconds

  try {
    const file = Bun.file(filePath);
    const fileSize = file.size;

    let lastError = "";

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Stream file directly from disk to avoid buffering entire file in memory
      const response = await fetch(presignedUrl, {
        method: "PUT",
        body: file,
        headers: {
          "Content-Length": fileSize.toString(),
        },
      });

      if (response.ok) {
        onProgress?.(fileSize, fileSize);
        return { success: true };
      }

      const errorText = await response.text();
      lastError = `Upload failed: ${response.status} ${errorText}`;

      // Retry on 403 AccessDenied (IAM propagation delay) or 503 SlowDown (rate limiting)
      const isIamError = response.status === 403 && errorText.includes("AccessDenied");
      const isRateLimited = response.status === 503 && errorText.includes("SlowDown");
      const isRetryable = isIamError || isRateLimited;

      if (!isRetryable || attempt === maxRetries) {
        if (isRetryable && attempt === maxRetries) {
          console.warn(`Upload failed after ${maxRetries} retries: ${filePath}`);
        }
        return { success: false, error: lastError };
      }

      // Exponential backoff for rate limiting (4s, 8s, 16s, 30s cap); linear for IAM (10s, 15s, 20s, 25s)
      const delayMs = isRateLimited
        ? Math.min(4000 * 2 ** attempt, 30000)
        : initialDelayMs + attempt * 5000;

      if (isRateLimited) {
        console.warn(
          `S3 rate limit hit, retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${maxRetries})...`,
        );
      } else if (isIamError) {
        console.warn(
          `Waiting for S3 permissions to propagate, retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${maxRetries})...`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    return { success: false, error: lastError };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Failed to upload ${filePath}: ${errorMsg}` };
  }
}

/**
 * Upload multiple files using presigned URLs with a concurrent pool.
 *
 * Uses a semaphore pattern to keep exactly `jobs` uploads running at all
 * times, starting the next file as soon as any slot frees up. This avoids
 * the idle-slot problem of fixed Promise.all batches.
 *
 * `onBatchComplete` fires every `jobs` completions to persist progress.
 */
export async function uploadFilesWithPresignedUrls(
  basePath: string,
  uploadUrls: Record<string, string>,
  options: {
    jobs?: number;
    onProgress?: (progress: PresignedUploadProgress) => void;
    onBatchComplete?: () => void;
  } = {},
): Promise<{ success: boolean; uploaded: number; failed: string[]; error?: string }> {
  const jobs = options.jobs || 4;
  const files = Object.entries(uploadUrls);
  const failed: string[] = [];
  let uploaded = 0;
  let completed = 0;
  let sinceLastSave = 0;

  // Semaphore: resolve functions for waiting workers
  let running = 0;
  let releaseSlot: (() => void) | null = null;

  function acquireSlot(): Promise<void> {
    if (running < jobs) {
      running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      releaseSlot = () => {
        releaseSlot = null;
        resolve();
      };
    });
  }

  function freeSlot(): void {
    running--;
    if (releaseSlot) {
      running++;
      releaseSlot();
    }
  }

  const uploadFile = async (relativePath: string, presignedUrl: string) => {
    const fullPath = join(basePath, relativePath);

    options.onProgress?.({
      file: relativePath,
      uploaded: 0,
      total: 0,
      status: "uploading",
    });

    const result = await uploadFileWithPresignedUrl(fullPath, presignedUrl);

    if (result.success) {
      uploaded++;
      options.onProgress?.({
        file: relativePath,
        uploaded: 1,
        total: 1,
        status: "completed",
      });
    } else {
      failed.push(`${relativePath}: ${result.error || "Unknown error"}`);
      options.onProgress?.({
        file: relativePath,
        uploaded: 0,
        total: 1,
        status: "failed",
        error: result.error,
      });
    }

    completed++;
    sinceLastSave++;
    if (sinceLastSave >= jobs) {
      sinceLastSave = 0;
      options.onBatchComplete?.();
    }

    freeSlot();
  };

  // Launch all uploads, gated by the semaphore
  const promises: Promise<void>[] = [];
  for (const [relativePath, presignedUrl] of files) {
    await acquireSlot();
    promises.push(uploadFile(relativePath, presignedUrl));
  }

  // Wait for all in-flight uploads to finish
  await Promise.all(promises);

  // Final save for any remaining completions
  if (sinceLastSave > 0) {
    options.onBatchComplete?.();
  }

  return {
    success: failed.length === 0,
    uploaded,
    failed,
    error: failed.length > 0 ? `${failed.length} files failed to upload` : undefined,
  };
}

/**
 * Register a URL with git-annex for a file
 * This allows git-annex to track files uploaded via presigned URLs
 */
export async function registerUrlWithGitAnnex(
  repoPath: string,
  relativePath: string,
  url: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    // First, add the file to git-annex if not already tracked
    const addResult = await runCommand(["git", "annex", "add", relativePath], {
      cwd: repoPath,
    });

    if (addResult.exitCode !== 0) {
      // File might already be tracked, that's OK
    }

    // Get the key for the file
    const keyResult = await runCommand(["git", "annex", "lookupkey", relativePath], {
      cwd: repoPath,
    });

    if (keyResult.exitCode !== 0 || !keyResult.stdout.trim()) {
      return { success: false, error: `Could not get git-annex key for ${relativePath}` };
    }

    const key = keyResult.stdout.trim();

    // Register the URL with the key
    const registerResult = await runCommand(["git", "annex", "registerurl", key, url], {
      cwd: repoPath,
    });

    if (registerResult.exitCode !== 0) {
      return { success: false, error: `Failed to register URL: ${registerResult.stderr}` };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Register multiple URLs with git-annex
 */
export async function registerUrlsWithGitAnnex(
  repoPath: string,
  fileUrls: Record<string, string>,
  onProgress?: (file: string, success: boolean) => void,
): Promise<{ success: boolean; registered: number; failed: string[] }> {
  let registered = 0;
  const failed: string[] = [];

  for (const [relativePath, url] of Object.entries(fileUrls)) {
    const result = await registerUrlWithGitAnnex(repoPath, relativePath, url);
    if (result.success) {
      registered++;
      onProgress?.(relativePath, true);
    } else {
      failed.push(relativePath);
      onProgress?.(relativePath, false);
    }
  }

  return {
    success: failed.length === 0,
    registered,
    failed,
  };
}

/**
 * Configure git-annex web remote for tracking S3 URLs
 * This allows git-annex to use the registered URLs for downloads
 */
export async function configureWebRemote(
  repoPath: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Check if web remote already exists
    const checkResult = await runCommand(["git", "annex", "enableremote", "web"], {
      cwd: repoPath,
    });

    // Web remote is built-in to git-annex, should always work
    if (checkResult.exitCode !== 0 && !checkResult.stderr.includes("already exists")) {
      return { success: false, error: `Failed to enable web remote: ${checkResult.stderr}` };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

// =============================================================================
// Download Functions
// =============================================================================

/**
 * Prerequisites check result for download (simpler than upload)
 */
export interface DownloadPrerequisitesResult {
  gitAnnex: ToolVersion;
  allPassed: boolean;
  errors: string[];
}

/**
 * Check prerequisites for dataset download
 * Simpler than upload - no AWS credentials or GitHub SSH needed
 */
export async function checkDownloadPrerequisites(): Promise<DownloadPrerequisitesResult> {
  const gitAnnex = await checkGitAnnexInstalled();

  const errors: string[] = [];

  if (!gitAnnex.installed) {
    errors.push(`git-annex is not installed. Install: ${getGitAnnexInstallCommand()}`);
  } else if (gitAnnex.compatible === false) {
    errors.push(
      `git-annex version ${gitAnnex.version} is too old. Required: >= ${gitAnnex.minVersion}`,
    );
  }

  return {
    gitAnnex,
    allPassed: errors.length === 0,
    errors,
  };
}

/**
 * Clone a dataset from GitHub
 */
export async function cloneDataset(
  repoUrl: string,
  outputPath: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Clone with git
    const { stderr: cloneStderr, exitCode: cloneExitCode } = await runCommand([
      "git",
      "clone",
      repoUrl,
      outputPath,
    ]);

    if (cloneExitCode !== 0) {
      return { success: false, error: cloneStderr.trim() || "Failed to clone dataset" };
    }

    // Initialize git-annex in the cloned repo
    const { stderr: initStderr, exitCode: initExitCode } = await runCommand(
      ["git", "annex", "init"],
      { cwd: outputPath },
    );

    if (initExitCode !== 0) {
      // Verify git-annex is actually initialized despite the error
      const { exitCode: checkCode } = await runCommand(["git", "annex", "info"], {
        cwd: outputPath,
      });

      if (checkCode !== 0) {
        return {
          success: false,
          error: `Cloned repository but git-annex initialization failed: ${initStderr.trim()}`,
        };
      }
      // Already initialized, non-fatal
      console.warn("git annex init returned non-zero but annex is initialized");
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * git-annex JSON progress line (from --json-progress output)
 */
interface GitAnnexProgressLine {
  action?: string;
  file?: string;
  "byte-progress"?: number;
  "total-size"?: number;
  "percent-progress"?: string;
  key?: string;
  ok?: boolean;
  success?: boolean;
  note?: string;
  error?: string;
}

/**
 * Progress callback for getDatasetData streaming mode
 */
export type DownloadProgressCallback = (line: GitAnnexProgressLine) => void;

/**
 * Get data files from remote (S3) for a cloned dataset.
 *
 * When onProgress is provided, uses --json-progress to stream progress
 * events. Falls back to regular output if --json-progress is not supported.
 */
export async function getDatasetData(
  datasetPath: string,
  options: {
    jobs?: number;
    paths?: string[]; // Specific paths to get, or all if empty
    credentials?: S3Credentials;
    onProgress?: DownloadProgressCallback;
  } = {},
): Promise<{ success: boolean; error?: string; filesDownloaded?: number }> {
  const jobs = options.jobs || 4;
  const paths = options.paths && options.paths.length > 0 ? options.paths : ["."];
  const useProgress = Boolean(options.onProgress);

  const env: Record<string, string> = {};
  if (options.credentials) {
    env.AWS_ACCESS_KEY_ID = options.credentials.accessKeyId;
    env.AWS_SECRET_ACCESS_KEY = options.credentials.secretAccessKey;
    if (options.credentials.sessionToken) {
      env.AWS_SESSION_TOKEN = options.credentials.sessionToken;
    }
  }

  const mergedEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter((e): e is [string, string] => e[1] != null),
  );

  try {
    if (useProgress) {
      // Streaming mode: parse --json-progress lines as they arrive
      const args = [
        "git",
        "annex",
        "get",
        "--json",
        "--json-progress",
        "-J",
        jobs.toString(),
        ...paths,
      ];

      const proc = spawn({
        cmd: args,
        cwd: datasetPath,
        stdout: "pipe",
        stderr: "pipe",
        env: mergedEnv,
      });

      let filesDownloaded = 0;
      let stderrOutput = "";
      const stderrChunks: Uint8Array[] = [];

      // Collect stderr in background
      const stderrPromise = (async () => {
        const reader = proc.stderr.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          stderrChunks.push(value);
        }
        stderrOutput = decoder.decode(
          stderrChunks.reduce((acc, chunk) => {
            const merged = new Uint8Array(acc.length + chunk.length);
            merged.set(acc);
            merged.set(chunk, acc.length);
            return merged;
          }, new Uint8Array()),
        );
      })();

      // Stream and parse stdout JSON lines
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // Keep partial last line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("{")) continue;
          try {
            const parsed = JSON.parse(trimmed) as GitAnnexProgressLine;
            options.onProgress?.(parsed);
            if (parsed.ok === true || parsed.success === true) {
              filesDownloaded++;
            }
          } catch {
            // Non-JSON lines are ignored
          }
        }
      }

      // Process any remaining buffer content
      if (buffer.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(buffer.trim()) as GitAnnexProgressLine;
          options.onProgress?.(parsed);
          if (parsed.ok === true || parsed.success === true) {
            filesDownloaded++;
          }
        } catch {
          // Ignore partial lines
        }
      }

      await stderrPromise;
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        return { success: false, error: stderrOutput.trim() || "Failed to get dataset data" };
      }

      return { success: true, filesDownloaded };
    }

    // Non-streaming fallback (no onProgress callback)
    const args = ["git", "annex", "get", "-J", jobs.toString(), ...paths];
    const { stdout, stderr, exitCode } = await runCommand(args, {
      cwd: datasetPath,
      ...(Object.keys(env).length > 0 && { env: mergedEnv }),
    });

    if (exitCode !== 0) {
      return { success: false, error: stderr.trim() || "Failed to get dataset data" };
    }

    // Count files downloaded from output (git annex get outputs lines like "get file ok")
    const getMatches = stdout.match(/^get .+ ok$/gm);
    const filesDownloaded = getMatches ? getMatches.length : 0;

    return { success: true, filesDownloaded };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Drop local copies of annexed files (keeps remote copies intact).
 * Git-annex verifies remote copies exist before dropping.
 */
export async function dropFiles(
  datasetPath: string,
  paths?: string[],
): Promise<{ success: boolean; error?: string; dropped: number; kept: string[] }> {
  const targets = paths && paths.length > 0 ? paths : ["."];

  try {
    const args = ["git", "annex", "drop", ...targets];
    const { stdout, stderr, exitCode } = await runCommand(args, { cwd: datasetPath });

    if (exitCode !== 0) {
      // git-annex drop returns non-zero if some files couldn't be dropped
      // (e.g., no remote copies). Parse output for details.
      const kept: string[] = [];
      for (const line of stderr.split("\n")) {
        const match = line.match(/^drop (.+) \(unsafe\)/);
        if (match) kept.push(match[1]);
      }
      const dropMatches = stdout.match(/^drop .+ ok$/gm);
      const dropped = dropMatches ? dropMatches.length : 0;
      return { success: false, error: stderr.trim(), dropped, kept };
    }

    const dropMatches = stdout.match(/^drop .+ ok$/gm);
    const dropped = dropMatches ? dropMatches.length : 0;
    return { success: true, dropped, kept: [] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg || "Unknown error during drop", dropped: 0, kept: [] };
  }
}

/**
 * Valid remote name pattern (alphanumeric, dash, underscore, dot).
 */
const VALID_REMOTE_NAME = /^[a-zA-Z0-9._-]+$/;

/**
 * Get names of S3-type git-annex special remotes configured in a dataset.
 * Uses git config to detect remotes with S3-related configuration.
 * Returns empty array if no S3 remotes found or detection fails.
 */
export async function getAnnexS3Remotes(datasetPath: string): Promise<string[]> {
  const remotes: string[] = [];

  // Primary: check git config for S3-configured remotes
  const { stdout: remoteList, exitCode: listCode } = await runCommand(
    ["git", "config", "--get-regexp", "^remote\\..*\\.annex-s3"],
    {
      cwd: datasetPath,
    },
  );

  if (listCode === 0 && remoteList.trim()) {
    for (const line of remoteList.trim().split("\n")) {
      const match = line.match(/^remote\.(.+?)\.annex-/);
      if (match && VALID_REMOTE_NAME.test(match[1])) {
        remotes.push(match[1]);
      }
    }
  }

  if (remotes.length > 0) return [...new Set(remotes)];

  // Fallback: parse git-annex info --json for remote descriptions
  const {
    stdout: infoJson,
    exitCode: jsonCode,
    stderr: infoStderr,
  } = await runCommand(["git", "annex", "info", "--json"], { cwd: datasetPath });

  if (jsonCode !== 0) {
    if (infoStderr.trim()) {
      console.error(`git annex info failed: ${infoStderr.trim()}`);
    }
    return [];
  }

  if (!infoJson.trim()) return [];

  let info: Record<string, unknown>;
  try {
    info = JSON.parse(infoJson);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Failed to parse git-annex info JSON: ${msg}`);
    return [];
  }

  const repos = [
    ...(Array.isArray(info["trusted repositories"]) ? info["trusted repositories"] : []),
    ...(Array.isArray(info["semitrusted repositories"]) ? info["semitrusted repositories"] : []),
    ...(Array.isArray(info["untrusted repositories"]) ? info["untrusted repositories"] : []),
  ];

  for (const repo of repos) {
    if (!repo?.description?.includes("[")) continue;
    const nameMatch = repo.description.match(/\[(.+?)\]/);
    if (!nameMatch) continue;

    const name = nameMatch[1];
    if (!VALID_REMOTE_NAME.test(name)) continue;

    const { stdout: typeOut } = await runCommand(["git", "config", `remote.${name}.annex-s3`], {
      cwd: datasetPath,
    });
    if (typeOut.trim()) remotes.push(name);
  }

  return [...new Set(remotes)];
}

/**
 * Copy annexed content to a remote.
 *
 * When credentials are provided, they are passed as env vars to the subprocess.
 * Otherwise inherits environment credentials (AWS_ACCESS_KEY_ID, etc.).
 */
export async function copyToAnnexRemote(
  datasetPath: string,
  remoteName: string,
  jobs = 4,
  credentials?: S3Credentials,
): Promise<{ success: boolean; error?: string; filesCopied: number }> {
  try {
    const args = ["git", "annex", "copy", "--to", remoteName, "-J", jobs.toString(), "."];

    const env: Record<string, string> | undefined = credentials
      ? {
          AWS_ACCESS_KEY_ID: credentials.accessKeyId,
          AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
          ...(credentials.sessionToken ? { AWS_SESSION_TOKEN: credentials.sessionToken } : {}),
        }
      : undefined;

    const { stdout, stderr, exitCode } = await runCommand(args, { cwd: datasetPath, env });

    if (exitCode !== 0) {
      return { success: false, error: stderr.trim() || "Failed to copy to remote", filesCopied: 0 };
    }

    const copyMatches = stdout.match(/^copy .+ ok$/gm);
    const filesCopied = copyMatches ? copyMatches.length : 0;
    return { success: true, filesCopied };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg || "Unknown error during copy", filesCopied: 0 };
  }
}

/**
 * Local dataset info returned by getLocalDatasetInfo
 */
export interface LocalDatasetInfo {
  files: number;
  size: string;
  sizeBytes: number;
  annexedFiles: number;
  presentFiles: number;
  missingFiles: number;
}

/**
 * Get information about a locally cloned dataset
 */
export async function getLocalDatasetInfo(datasetPath: string): Promise<LocalDatasetInfo | null> {
  if (!existsSync(datasetPath)) {
    return null;
  }

  try {
    const { stdout, exitCode } = await runCommand(["git", "annex", "info", "--json"], {
      cwd: datasetPath,
    });

    if (exitCode === 0) {
      const info = JSON.parse(stdout);

      // Parse size string like "1.5 GB" to bytes
      let sizeBytes = 0;
      const sizeStr = info["local annex size"] || "0 bytes";
      const sizeMatch = sizeStr.match(/([\d.]+)\s*(bytes?|KB|MB|GB|TB)/i);
      if (sizeMatch) {
        const num = Number.parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2].toLowerCase();
        const multipliers: Record<string, number> = {
          byte: 1,
          bytes: 1,
          kb: 1024,
          mb: 1024 * 1024,
          gb: 1024 * 1024 * 1024,
          tb: 1024 * 1024 * 1024 * 1024,
        };
        sizeBytes = num * (multipliers[unit] || 1);
      }

      const annexedFiles = info["annexed files in working tree"] || 0;
      const presentFiles = info["local annex keys"] || 0;

      return {
        files: annexedFiles,
        size: sizeStr,
        sizeBytes,
        annexedFiles,
        presentFiles,
        missingFiles: annexedFiles - presentFiles,
      };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to get git-annex info for ${datasetPath}: ${errorMsg}`);
  }

  // Fallback: just count files
  try {
    const { stdout } = await runCommand(["find", ".", "-type", "f", "-not", "-path", "./.git/*"], {
      cwd: datasetPath,
    });
    const files = stdout.trim().split("\n").filter(Boolean).length;
    return {
      files,
      size: "unknown",
      sizeBytes: 0,
      annexedFiles: 0,
      presentFiles: files,
      missingFiles: 0,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to count files in ${datasetPath}: ${errorMsg}`);
    return null;
  }
}

// =============================================================================
// Revert Functions (Admin Only)
// =============================================================================

/**
 * List available versions (tags) for a dataset
 */
export async function listDatasetVersions(
  datasetPath: string,
): Promise<{ version: string; date: string; commit: string }[]> {
  try {
    const { stdout, exitCode } = await runCommand(
      [
        "git",
        "tag",
        "-l",
        "--sort=-version:refname",
        "--format=%(refname:short)|%(creatordate:short)|%(objectname:short)",
      ],
      { cwd: datasetPath },
    );

    if (exitCode !== 0 || !stdout.trim()) {
      return [];
    }

    return stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [version, date, commit] = line.split("|");
        return { version, date, commit };
      });
  } catch {
    return [];
  }
}

/**
 * Get the commit hash for a version tag
 */
export async function getVersionCommit(
  datasetPath: string,
  version: string,
): Promise<string | null> {
  try {
    const tag = version.startsWith("v") ? version : `v${version}`;
    const { stdout, exitCode } = await runCommand(["git", "rev-parse", tag], { cwd: datasetPath });

    if (exitCode !== 0) {
      return null;
    }

    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Create a revert branch from the current state to a target version
 */
export async function createRevertBranch(
  datasetPath: string,
  targetVersion: string,
  branchName: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Create and checkout the revert branch
    const { stderr: branchErr, exitCode: branchCode } = await runCommand(
      ["git", "checkout", "-b", branchName],
      { cwd: datasetPath },
    );

    if (branchCode !== 0) {
      return { success: false, error: branchErr.trim() || "Failed to create branch" };
    }

    // Get the tag name
    const tag = targetVersion.startsWith("v") ? targetVersion : `v${targetVersion}`;

    // Checkout all files from the target version (except .git)
    const { stderr: checkoutErr, exitCode: checkoutCode } = await runCommand(
      ["git", "checkout", tag, "--", "."],
      { cwd: datasetPath },
    );

    if (checkoutCode !== 0) {
      return {
        success: false,
        error: checkoutErr.trim() || "Failed to checkout files from target version",
      };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Commit the revert changes
 */
export async function commitRevert(
  datasetPath: string,
  targetVersion: string,
  message?: string,
): Promise<{ success: boolean; error?: string }> {
  const commitMessage = message || `Revert to ${targetVersion}`;

  try {
    // Stage all changes
    const { exitCode: addCode } = await runCommand(["git", "add", "-A"], { cwd: datasetPath });

    if (addCode !== 0) {
      return { success: false, error: "Failed to stage changes" };
    }

    // Check if there are changes to commit
    const { stdout: statusOut } = await runCommand(["git", "status", "--porcelain"], {
      cwd: datasetPath,
    });

    if (!statusOut.trim()) {
      return { success: false, error: "No changes to revert (already at target version)" };
    }

    // Commit
    const { stderr: commitErr, exitCode: commitCode } = await runCommand(
      ["git", "commit", "-m", commitMessage],
      { cwd: datasetPath },
    );

    if (commitCode !== 0) {
      return { success: false, error: commitErr.trim() || "Failed to commit" };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Push a branch to remote
 */
export async function pushBranch(
  datasetPath: string,
  branchName: string,
  remoteName = "origin",
): Promise<{ success: boolean; error?: string }> {
  try {
    const { stderr, exitCode } = await runCommand(["git", "push", "-u", remoteName, branchName], {
      cwd: datasetPath,
    });

    if (exitCode !== 0) {
      return { success: false, error: stderr.trim() || "Failed to push branch" };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Get current branch name
 */
export async function getCurrentBranch(datasetPath: string): Promise<string | null> {
  try {
    const { stdout, exitCode } = await runCommand(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: datasetPath,
    });

    if (exitCode !== 0) {
      return null;
    }

    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Ensure the local branch is named "main". NEMAR requires "main" as the default branch
 * for CI, branch protection, and metadata pipelines to work.
 *
 * If the branch is not "main", warns the user and offers to rename it.
 * Respects --yes flag for non-interactive mode (auto-renames).
 *
 * @returns true if branch is (now) "main", false if user declined or rename failed
 */
export async function ensureLocalMainBranch(
  datasetPath: string,
  options: { yes?: boolean } = {},
): Promise<boolean> {
  const currentBranch = await getCurrentBranch(datasetPath);

  if (!currentBranch) {
    console.log(chalk.yellow("\n  Warning: Could not determine current branch name."));
    console.log(chalk.yellow("  Proceeding with upload; ensure your branch is named 'main'."));
    return true;
  }

  // Accept "main" or git-annex adjusted branches that track main (e.g. "adjusted/main(unlocked)").
  // Adjusted branches are working copies that track "main" under the hood; renaming them would break git-annex.
  if (currentBranch === "main" || currentBranch.startsWith("adjusted/main")) {
    return true;
  }

  console.log(
    chalk.yellow(
      `\n  Warning: Your current branch is "${currentBranch}", but NEMAR requires "main".`,
    ),
  );
  console.log(
    chalk.yellow(
      "  Without renaming, CI validation, branch protection, and metadata pipelines will not work.",
    ),
  );

  if (!options.yes) {
    const shouldRename = await promptForRename(currentBranch);
    if (!shouldRename) {
      return false;
    }
  }

  const { exitCode, stderr } = await runCommand(["git", "branch", "-m", currentBranch, "main"], {
    cwd: datasetPath,
  });
  if (exitCode !== 0) {
    console.log(chalk.red(`  Failed to rename branch "${currentBranch}" to "main".`));
    if (stderr.trim()) {
      console.log(chalk.red(`  Git error: ${stderr.trim()}`));
    }
    return false;
  }
  console.log(chalk.green(`  Renamed branch "${currentBranch}" to "main".`));
  return true;
}

async function promptForRename(currentBranch: string): Promise<boolean> {
  const inquirer = (await import("inquirer")).default;
  try {
    const { rename } = await inquirer.prompt([
      {
        type: "confirm",
        name: "rename",
        message: `Rename branch "${currentBranch}" to "main"?`,
        default: true,
      },
    ]);

    if (!rename) {
      console.log(chalk.red("  Upload cancelled. Rename your branch to main before uploading:"));
      console.log(chalk.dim(`    git branch -m '${currentBranch}' main`));
    }
    return rename;
  } catch (error) {
    console.log(
      chalk.red(`  Failed to prompt: ${error instanceof Error ? error.message : String(error)}`),
    );
    console.log(chalk.dim(`    You can manually rename: git branch -m '${currentBranch}' main`));
    return false;
  }
}

/**
 * Detect the dataset ID from the git remote URL of the current directory.
 * Parses the origin remote URL to extract the repository name (e.g., nm000104).
 */
export async function getDatasetIdFromRemote(datasetPath: string): Promise<string | null> {
  try {
    const { stdout, exitCode } = await runCommand(["git", "remote", "get-url", "origin"], {
      cwd: datasetPath,
    });

    if (exitCode !== 0 || !stdout.trim()) return null;

    const url = stdout.trim();
    // Match patterns: https://github.com/org/repo.git, git@github.com:org/repo.git
    const match = url.match(/[/:]([^/]+?)(?:\.git)?$/);
    if (!match) return null;

    return match[1];
  } catch {
    return null;
  }
}

/**
 * Switch to a branch
 */
export async function switchBranch(
  datasetPath: string,
  branchName: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { stderr, exitCode } = await runCommand(["git", "checkout", branchName], {
      cwd: datasetPath,
    });

    if (exitCode !== 0) {
      return { success: false, error: stderr.trim() || "Failed to switch branch" };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

// =============================================================================
// File Manifest Collection
// =============================================================================

/**
 * File info for upload manifest
 */
export interface DatasetFileInfo {
  path: string;
  size: number;
  type: "metadata" | "data";
}

/**
 * Threshold for classifying files as data (100KB)
 */
const DATA_FILE_THRESHOLD = 100 * 1024;

/**
 * File extensions that are always classified as data files
 */
const DATA_FILE_EXTENSIONS = new Set([
  ".edf",
  ".bdf",
  ".eeg",
  ".vhdr",
  ".vmrk",
  ".set",
  ".fdt",
  ".cnt",
  ".mff",
  ".fif",
  ".nii",
  ".nii.gz",
  ".mat",
  ".bin",
]);

/**
 * Collect file manifest for a dataset
 * Classifies files as "data" (large binary files) or "metadata" (JSON, TSV, small files)
 */
export async function collectFileManifest(datasetPath: string): Promise<{
  files: DatasetFileInfo[];
  totalSize: number;
  dataFiles: number;
  metadataFiles: number;
}> {
  const files: DatasetFileInfo[] = [];
  let totalSize = 0;
  let dataFiles = 0;
  let metadataFiles = 0;

  // Use find to get all files and symlinks (excluding .git, .nemar, and .gitattributes)
  // Git-annex replaces data files with symlinks to .git/annex/objects/
  const { stdout, exitCode } = await runCommand(
    [
      "find",
      ".",
      "(",
      "-type",
      "f",
      "-o",
      "-type",
      "l",
      ")",
      "-not",
      "-path",
      "./.git/*",
      "-not",
      "-path",
      "./.nemar/*",
      "-not",
      "-name",
      ".gitattributes",
    ],
    { cwd: datasetPath },
  );

  if (exitCode !== 0) {
    return { files, totalSize, dataFiles, metadataFiles };
  }

  const filePaths = stdout.trim().split("\n").filter(Boolean);

  for (const filePath of filePaths) {
    // Clean up path (remove leading ./)
    const relativePath = filePath.startsWith("./") ? filePath.slice(2) : filePath;
    const absolutePath = join(datasetPath, relativePath);

    try {
      const stats = statSync(absolutePath);
      const size = stats.size;
      totalSize += size;

      // Classify file type
      const ext = relativePath.toLowerCase().match(/\.[^.]+$/)?.[0] || "";
      const isDataFile = DATA_FILE_EXTENSIONS.has(ext) || size > DATA_FILE_THRESHOLD;
      const fileType: "metadata" | "data" = isDataFile ? "data" : "metadata";

      if (isDataFile) {
        dataFiles++;
      } else {
        metadataFiles++;
      }

      files.push({
        path: relativePath,
        size,
        type: fileType,
      });
    } catch {
      // Skip files we can't stat
    }
  }

  return { files, totalSize, dataFiles, metadataFiles };
}

// =============================================================================
// S3-to-S3 copy helpers (OpenNeuro import)
// =============================================================================

/**
 * Get git-annex keys and their known URLs for files in the current tree.
 * Returns a Map of key -> source S3 URL (first HTTP/S3 URL found).
 */
export async function getAnnexWhereisAll(datasetPath: string): Promise<Map<string, string>> {
  // Use "-- ." instead of "--all" to only process files in the current tree.
  // "--all" includes orphaned keys from old git history that may have no location
  // info, causing spurious failures (e.g., ds000117 had 718 orphan key failures).
  const result = await runCommand(["git", "annex", "whereis", "--json", "--", "."], {
    cwd: datasetPath,
  });
  if (result.exitCode !== 0 && !result.stdout.trim()) {
    throw new Error(`git annex whereis failed: ${result.stderr.trim()}`);
  }
  if (result.exitCode !== 0) {
    // Only tolerate the expected "whereis: N failed" pattern (files with no
    // known location). Any other non-zero exit is an unexpected error.
    const failMatch = result.stderr.match(/whereis:\s*(\d+)\s*failed/);
    if (failMatch) {
      console.warn(
        `  Warning: ${failMatch[1]} files had no location info (continuing with available files)`,
      );
    } else {
      throw new Error(
        `git annex whereis failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  const keyUrlMap = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const key = entry.key;
      if (!key) continue;

      // Collect URLs from all whereis entries
      const whereis = [...(entry.whereis || []), ...(entry.untrusted || [])];
      for (const remote of whereis) {
        if (!Array.isArray(remote.urls)) continue;
        for (const url of remote.urls) {
          if (typeof url === "string" && (url.startsWith("http") || url.startsWith("s3://"))) {
            keyUrlMap.set(key, url);
            break;
          }
        }
        if (keyUrlMap.has(key)) break;
      }
    } catch (err) {
      if (err instanceof SyntaxError) continue;
      console.error(
        `Warning: failed to process whereis entry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return keyUrlMap;
}

/**
 * Get the hash directory path for a git-annex key.
 * Used to construct the S3 destination path.
 */
export async function getKeyHashDir(datasetPath: string, key: string): Promise<string> {
  const result = await runCommand(["git", "annex", "examinekey", "--format=${hashdirlower}", key], {
    cwd: datasetPath,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git annex examinekey failed for ${key}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/**
 * Batch get hash directories for multiple keys.
 * More efficient than calling getKeyHashDir one at a time.
 */
export async function getKeyHashDirs(
  datasetPath: string,
  keys: string[],
): Promise<Map<string, string>> {
  const hashDirMap = new Map<string, string>();
  // Limit concurrency to avoid overwhelming the system with subprocesses
  const batchSize = 50;
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (key) => {
        const hashDir = await getKeyHashDir(datasetPath, key);
        return { key, hashDir };
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        hashDirMap.set(r.value.key, r.value.hashDir);
      } else {
        console.error(`Warning: failed to resolve hash dir: ${r.reason?.message || "unknown"}`);
      }
    }
  }
  return hashDirMap;
}

/**
 * Get the UUID of a configured git-annex remote.
 */
export async function getRemoteUuid(
  datasetPath: string,
  remoteName: string,
): Promise<string | null> {
  const result = await runCommand(["git", "config", `remote.${remoteName}.annex-uuid`], {
    cwd: datasetPath,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * Mark a git-annex key as present in a remote.
 */
export async function setKeyPresent(
  datasetPath: string,
  key: string,
  remoteUuid: string,
): Promise<boolean> {
  const result = await runCommand(["git", "annex", "setpresentkey", key, remoteUuid, "1"], {
    cwd: datasetPath,
  });
  return result.exitCode === 0;
}

/**
 * Batch mark keys as present in a remote.
 * Returns count of successful and failed registrations.
 */
export async function batchSetKeysPresent(
  datasetPath: string,
  keys: string[],
  remoteUuid: string,
): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;
  // Process in parallel batches
  const batchSize = 50;
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map((key) => setKeyPresent(datasetPath, key, remoteUuid)),
    );
    for (const ok of results) {
      if (ok) success++;
      else failed++;
    }
  }
  return { success, failed };
}

// =============================================================================
// Backward-compatible aliases (to be removed in future versions)
// =============================================================================

/**
 * @deprecated Use initDataset instead. Will be removed in v1.0.0.
 */
export const createDataladDataset = initDataset;

/**
 * @deprecated Use isGitAnnexDataset instead. Will be removed in v1.0.0.
 */
export const isDataladDataset = isGitAnnexDataset;
