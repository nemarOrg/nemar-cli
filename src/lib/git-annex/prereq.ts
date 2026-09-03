/**
 * git-annex service: tool prerequisites (git-annex version, GitHub SSH, AWS).
 *
 * Split from lib/git-annex.ts by concern (#908, epic #902); bodies moved
 * verbatim.
 */

import semver from "semver";
import { getGitHubToken } from "./github.js";
import { runCommand } from "./run-command.js";

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
 * Compare a git-annex version against a minimum requirement.
 *
 * git-annex versions are not semver: they're a two-component
 * MAJOR.CalVer scheme (e.g. "10.20241202"), sometimes with a build suffix
 * (e.g. "10.20241202-g1234abc"). semver.coerce() normalizes that into a
 * MAJOR.MINOR.PATCH SemVer (the CalVer component becomes MINOR, PATCH is
 * padded to 0) which semver.gte() can then compare directly.
 *
 * Exported for testing: checkGitAnnexInstalled() below shells out to the
 * git-annex binary, so this comparator (not the full check) is what
 * test/git-annex-prereq.test.ts drives directly in a sandbox with no
 * git-annex installed. That file's table is the migration's equivalence
 * proof against the hand-rolled comparator this replaced (epic #1225
 * phase 6).
 */
export function isVersionCompatible(actual: string, required: string): boolean {
  const actualCoerced = semver.coerce(actual);
  const requiredCoerced = semver.coerce(required);

  // semver.coerce() returns null for a string with no extractable version
  // (e.g. an empty or non-numeric string). The old hand-rolled parser never
  // returned null -- it silently fell back to [0] (i.e. "0.0.0") and let
  // that compare as incompatible with any positive minimum. An uncoercible
  // version, on either side, is treated the same way here: not compatible,
  // explicitly, rather than letting a null flow into semver.gte() and throw.
  if (!actualCoerced || !requiredCoerced) return false;

  return semver.gte(actualCoerced, requiredCoerced);
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
