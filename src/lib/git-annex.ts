/**
 * Git-Annex Service
 *
 * Manages git-annex operations for dataset upload and download.
 * Requires git-annex >= 10.0 to be installed.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";

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
 * Run a command and return stdout, stderr, and exit code
 */
async function runCommand(
  cmd: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd,
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...options.env,
    },
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

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
    errors.push(
      "GitHub SSH access not configured. Run 'nemar auth setup-ssh' to configure automatically.",
    );
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

    // Initialize git repository
    const { stderr: gitStderr, exitCode: gitExitCode } = await runCommand(["git", "init", path], {
      ...(Object.keys(env).length > 0 ? { env } : {}),
    });

    if (gitExitCode !== 0) {
      return { success: false, error: gitStderr.trim() || "Failed to initialize git repository" };
    }

    // Initialize git-annex
    const { stderr: initStderr, exitCode: initExitCode } = await runCommand(
      ["git", "annex", "init"],
      {
        cwd: path,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
    );

    if (initExitCode !== 0) {
      return { success: false, error: initStderr.trim() || "Failed to initialize git-annex" };
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
  // Default pattern for EEG/MEG data files
  const defaultPattern =
    "include=*.edf or include=*.bdf or include=*.set or include=*.fif or include=*.vhdr or include=*.eeg or include=*.cnt or include=*.fdt or largerthan=100kb";

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
 * Configure S3 special remote for git-annex
 */
export async function configureS3Remote(
  path: string,
  config: S3RemoteConfig,
  credentials: { accessKeyId: string; secretAccessKey: string },
): Promise<{ success: boolean; error?: string }> {
  const args = [
    "git",
    "annex",
    "initremote",
    config.name,
    "type=S3",
    "encryption=none",
    `bucket=${config.bucket}`,
    `fileprefix=${config.prefix}/`,
    `datacenter=${config.region}`,
    "signature=v4",
  ];

  if (config.publicUrl) {
    args.push(`publicurl=${config.publicUrl}`);
  }

  try {
    const { stderr, exitCode } = await runCommand(args, {
      cwd: path,
      env: {
        AWS_ACCESS_KEY_ID: credentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      },
    });

    if (exitCode !== 0) {
      // Check if remote already exists
      if (stderr.includes("already exists")) {
        // Enable existing remote instead
        const enableResult = await runCommand(["git", "annex", "enableremote", config.name], {
          cwd: path,
          env: {
            AWS_ACCESS_KEY_ID: credentials.accessKeyId,
            AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
          },
        });

        if (enableResult.exitCode === 0) {
          return { success: true };
        }
        return { success: false, error: enableResult.stderr.trim() };
      }

      return { success: false, error: stderr.trim() || "Failed to configure S3 remote" };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
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
    finalUrl = `https://${token}@github.com/${repoPath}`;
  }
  // Local: Try standard SSH first, then fallback to HTTPS with gh token
  else if (repoUrl.startsWith("git@github.com:")) {
    const repoPath = repoUrl.replace("git@github.com:", "");
    const sshResult = await testGitHubSsh();

    if (sshResult.works) {
      finalUrl = repoUrl;
    } else {
      console.warn("GitHub SSH not available, falling back to HTTPS with gh CLI token...");

      const ghTokenResult = await getGitHubToken();

      if (ghTokenResult.token) {
        finalUrl = `https://${ghTokenResult.token}@github.com/${repoPath}`;
        console.warn(
          "Note: using HTTPS with gh CLI token. If the token expires, re-run 'gh auth login'.",
        );
      } else {
        return {
          success: false,
          error: `GitHub authentication not configured.

SSH failed: ${sshResult.error || "could not connect"}
gh CLI failed: ${ghTokenResult.error || "could not get token"}

Fix one of these:
  1. Configure SSH for GitHub:
     ssh-keygen -t ed25519 -C "your@email.com"
     Add the public key to https://github.com/settings/keys
     Test with: ssh -T git@github.com

  2. Install and authenticate gh CLI:
     gh auth login`,
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
export async function pushToS3(
  path: string,
  remoteName: string,
  options: {
    jobs?: number;
    credentials: { accessKeyId: string; secretAccessKey: string };
    onProgress?: (progress: UploadProgress) => void;
  },
): Promise<{ success: boolean; error?: string; filesUploaded?: number }> {
  const jobs = options.jobs || 4;

  try {
    // Use git annex copy for data transfer
    const { stdout, stderr, exitCode } = await runCommand(
      ["git", "annex", "copy", "--to", remoteName, "-J", jobs.toString(), "."],
      {
        cwd: path,
        env: {
          AWS_ACCESS_KEY_ID: options.credentials.accessKeyId,
          AWS_SECRET_ACCESS_KEY: options.credentials.secretAccessKey,
        },
      },
    );

    if (exitCode !== 0) {
      return { success: false, error: stderr.trim() || "Failed to push data to S3" };
    }

    // Count files uploaded from output
    const copyMatches = stdout.match(/copy .+ ok/g);
    const filesUploaded = copyMatches ? copyMatches.length : 0;

    return { success: true, filesUploaded };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

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

/**
 * Format bytes to human readable
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}

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
    const fileContent = await Bun.file(filePath).arrayBuffer();
    const fileSize = fileContent.byteLength;

    let lastError = "";

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Use fetch to upload - presigned URLs use simple PUT
      const response = await fetch(presignedUrl, {
        method: "PUT",
        body: fileContent,
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
 * Upload multiple files using presigned URLs with parallel execution
 */
export async function uploadFilesWithPresignedUrls(
  basePath: string,
  uploadUrls: Record<string, string>,
  options: {
    jobs?: number;
    onProgress?: (progress: PresignedUploadProgress) => void;
  } = {},
): Promise<{ success: boolean; uploaded: number; failed: string[]; error?: string }> {
  const jobs = options.jobs || 4;
  const files = Object.entries(uploadUrls);
  const failed: string[] = [];
  let uploaded = 0;

  // Process files in batches
  for (let i = 0; i < files.length; i += jobs) {
    const batch = files.slice(i, i + jobs);
    await Promise.all(
      batch.map(async ([relativePath, presignedUrl]) => {
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
      }),
    );
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
 * Get data files from remote (S3) for a cloned dataset
 */
export async function getDatasetData(
  datasetPath: string,
  options: {
    jobs?: number;
    paths?: string[]; // Specific paths to get, or all if empty
  } = {},
): Promise<{ success: boolean; error?: string; filesDownloaded?: number }> {
  const jobs = options.jobs || 4;
  const paths = options.paths && options.paths.length > 0 ? options.paths : ["."];

  try {
    const args = ["git", "annex", "get", "-J", jobs.toString(), ...paths];
    const { stdout, stderr, exitCode } = await runCommand(args, { cwd: datasetPath });

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
 * Copy annexed content to a remote. Inherits environment credentials (AWS_ACCESS_KEY_ID, etc.).
 * Suitable for push operations where the user has configured their own credentials.
 */
export async function copyToAnnexRemote(
  datasetPath: string,
  remoteName: string,
  jobs = 4,
): Promise<{ success: boolean; error?: string; filesCopied: number }> {
  try {
    const args = ["git", "annex", "copy", "--to", remoteName, "-J", jobs.toString(), "."];
    const { stdout, stderr, exitCode } = await runCommand(args, { cwd: datasetPath });

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

  // Use find to get all files (excluding .git)
  const { stdout, exitCode } = await runCommand(
    ["find", ".", "-type", "f", "-not", "-path", "./.git/*", "-not", "-name", ".gitattributes"],
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
