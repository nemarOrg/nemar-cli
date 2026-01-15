/**
 * DataLad Service
 *
 * Manages DataLad/git-annex operations for dataset upload.
 * Requires DataLad >= 0.19.0 and git-annex >= 10.0 to be installed.
 */

import { spawn } from "bun";
import { existsSync } from "fs";
import { join, basename } from "path";

/**
 * Version info for a tool
 */
export interface ToolVersion {
  installed: boolean;
  version?: string;
  minVersion?: string;
  compatible?: boolean;
}

/**
 * Prerequisites check result
 */
export interface PrerequisitesResult {
  datalad: ToolVersion;
  gitAnnex: ToolVersion;
  githubSSH: { accessible: boolean; username?: string };
  awsCredentials: { configured: boolean; source?: string };
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
    timeout?: number;
  } = {}
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
  return versionStr
    .split(".")
    .map((part) => {
      const num = parseInt(part.replace(/[^0-9]/g, ""), 10);
      return isNaN(num) ? 0 : num;
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
 * Check if DataLad is installed and compatible
 */
export async function checkDataladInstalled(): Promise<ToolVersion> {
  const minVersion = "0.19.0";

  try {
    const { stdout, exitCode } = await runCommand(["datalad", "--version"]);

    if (exitCode !== 0) {
      return { installed: false, minVersion };
    }

    // Output is like "datalad 0.19.6" or just version number
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    const version = match ? match[1] : undefined;

    return {
      installed: true,
      version,
      minVersion,
      compatible: version ? isVersionCompatible(version, minVersion) : undefined,
    };
  } catch {
    return { installed: false, minVersion };
  }
}

/**
 * Check if git-annex is installed and compatible
 */
export async function checkGitAnnexInstalled(): Promise<ToolVersion> {
  const minVersion = "10.0";

  try {
    const { stdout, exitCode } = await runCommand(["git-annex", "version"]);

    if (exitCode !== 0) {
      return { installed: false, minVersion };
    }

    // Output is like "git-annex version: 10.20241202"
    const match = stdout.match(/version:\s*(\d+\.\d+)/);
    const version = match ? match[1] : undefined;

    return {
      installed: true,
      version,
      minVersion,
      compatible: version ? isVersionCompatible(version, minVersion) : undefined,
    };
  } catch {
    return { installed: false, minVersion };
  }
}

/**
 * Check SSH access to GitHub
 */
export async function checkGitHubSSH(): Promise<{ accessible: boolean; username?: string; useHttps?: boolean }> {
  // If GH_TOKEN is set, we can use HTTPS instead of SSH (for CI)
  if (process.env.GH_TOKEN) {
    return { accessible: true, username: "token-auth", useHttps: true };
  }

  try {
    const { stdout, stderr, exitCode } = await runCommand(
      ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "git@github.com"],
      { timeout: 10000 }
    );

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
  } catch {
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
  } catch {
    // AWS CLI not installed or not configured
  }

  return { configured: false };
}

/**
 * Check all prerequisites for dataset upload
 */
export async function checkPrerequisites(): Promise<PrerequisitesResult> {
  const [datalad, gitAnnex, githubSSH, awsCredentials] = await Promise.all([
    checkDataladInstalled(),
    checkGitAnnexInstalled(),
    checkGitHubSSH(),
    checkAWSCredentials(),
  ]);

  const errors: string[] = [];

  if (!datalad.installed) {
    errors.push("DataLad is not installed. Install: pip install datalad");
  } else if (datalad.compatible === false) {
    errors.push(`DataLad version ${datalad.version} is too old. Required: >= ${datalad.minVersion}`);
  }

  if (!gitAnnex.installed) {
    errors.push("git-annex is not installed. Install: brew install git-annex (macOS) or apt install git-annex (Linux)");
  } else if (gitAnnex.compatible === false) {
    errors.push(`git-annex version ${gitAnnex.version} is too old. Required: >= ${gitAnnex.minVersion}`);
  }

  if (!githubSSH.accessible) {
    errors.push("GitHub SSH access not configured. Add your SSH key to GitHub: https://github.com/settings/keys");
  }

  if (!awsCredentials.configured) {
    errors.push("AWS credentials not found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables");
  }

  return {
    datalad,
    gitAnnex,
    githubSSH,
    awsCredentials,
    allPassed: errors.length === 0,
    errors,
  };
}

/**
 * Check if a directory is already a DataLad dataset
 */
export async function isDataladDataset(path: string): Promise<boolean> {
  // Check for .datalad directory
  if (existsSync(join(path, ".datalad"))) {
    return true;
  }

  // Also check with datalad status
  try {
    const { exitCode } = await runCommand(["datalad", "status"], { cwd: path });
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Initialize a DataLad dataset
 */
export async function createDataladDataset(
  path: string,
  options: { force?: boolean } = {}
): Promise<{ success: boolean; error?: string }> {
  // Check if already a dataset
  if (!options.force && (await isDataladDataset(path))) {
    return { success: true }; // Already initialized
  }

  try {
    const { stderr, exitCode } = await runCommand(["datalad", "create", "--force", path]);

    if (exitCode !== 0) {
      return { success: false, error: stderr.trim() || "Failed to create DataLad dataset" };
    }

    return { success: true };
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
  pattern?: string
): Promise<{ success: boolean; error?: string }> {
  // Default pattern for EEG/MEG data files
  const defaultPattern =
    "include=*.edf or include=*.bdf or include=*.set or include=*.fif or include=*.vhdr or include=*.eeg or include=*.cnt or include=*.fdt or largerthan=100kb";

  const largefilesPattern = pattern || defaultPattern;

  try {
    const { stderr, exitCode } = await runCommand(
      ["git", "annex", "config", "--set", "annex.largefiles", largefilesPattern],
      { cwd: path }
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
  credentials: { accessKeyId: string; secretAccessKey: string }
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
 * Configure GitHub remote using SSH or HTTPS (with token)
 */
export async function configureGitHubRemote(
  path: string,
  repoUrl: string,
  remoteName = "origin"
): Promise<{ success: boolean; error?: string }> {
  // Convert SSH URL to HTTPS with token if GH_TOKEN is available
  let finalUrl = repoUrl;
  if (process.env.GH_TOKEN && repoUrl.startsWith("git@github.com:")) {
    // Convert git@github.com:org/repo.git to https://token@github.com/org/repo.git
    const match = repoUrl.match(/git@github\.com:(.+)/);
    if (match) {
      finalUrl = `https://${process.env.GH_TOKEN}@github.com/${match[1]}`;
    }
  }

  try {
    // Check if remote already exists
    const { stdout } = await runCommand(["git", "remote", "get-url", remoteName], { cwd: path });

    if (stdout.trim()) {
      // Remote exists, update it
      const { stderr, exitCode } = await runCommand(
        ["git", "remote", "set-url", remoteName, finalUrl],
        { cwd: path }
      );

      if (exitCode !== 0) {
        return { success: false, error: stderr.trim() };
      }
    } else {
      // Remote doesn't exist, add it
      const { stderr, exitCode } = await runCommand(
        ["git", "remote", "add", remoteName, finalUrl],
        { cwd: path }
      );

      if (exitCode !== 0) {
        return { success: false, error: stderr.trim() };
      }
    }

    return { success: true };
  } catch {
    // Remote doesn't exist, add it
    const { stderr, exitCode } = await runCommand(
      ["git", "remote", "add", remoteName, finalUrl],
      { cwd: path }
    );

    if (exitCode !== 0) {
      return { success: false, error: stderr.trim() };
    }

    return { success: true };
  }
}

/**
 * Save all changes to the DataLad dataset
 */
export async function saveDataset(
  path: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { stderr, exitCode } = await runCommand(
      ["datalad", "save", "-m", message],
      { cwd: path }
    );

    if (exitCode !== 0) {
      // Check if there's nothing to save
      if (stderr.includes("nothing to save") || stderr.includes("no changes")) {
        return { success: true };
      }
      return { success: false, error: stderr.trim() || "Failed to save dataset" };
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
  }
): Promise<{ success: boolean; error?: string; filesUploaded?: number }> {
  const jobs = options.jobs || 8;

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
      }
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
  branch = "main"
): Promise<{ success: boolean; error?: string }> {
  try {
    // Push main branch
    const { stderr: mainStderr, exitCode: mainExitCode } = await runCommand(
      ["git", "push", "-u", remoteName, branch],
      { cwd: path }
    );

    if (mainExitCode !== 0) {
      return { success: false, error: mainStderr.trim() || "Failed to push to GitHub" };
    }

    // Push git-annex branch (critical for cloning)
    const { stderr: annexStderr, exitCode: annexExitCode } = await runCommand(
      ["git", "push", remoteName, "git-annex"],
      { cwd: path }
    );

    if (annexExitCode !== 0) {
      // Not a fatal error, but log it
      console.warn("Warning: Could not push git-annex branch:", annexStderr.trim());
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Get dataset file statistics
 */
export async function getDatasetStats(
  path: string
): Promise<{
  totalFiles: number;
  totalSize: number;
  annexedFiles: number;
  annexedSize: number;
}> {
  try {
    // Use git annex info for statistics
    const { stdout, exitCode } = await runCommand(["git", "annex", "info", "--json"], { cwd: path });

    if (exitCode === 0) {
      const info = JSON.parse(stdout);
      return {
        totalFiles: info["local annex keys"] || 0,
        totalSize: info["local annex size"] || 0,
        annexedFiles: info["local annex keys"] || 0,
        annexedSize: info["local annex size"] || 0,
      };
    }
  } catch {
    // Fall back to manual counting
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
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

// =============================================================================
// Download Functions
// =============================================================================

/**
 * Prerequisites check result for download (simpler than upload)
 */
export interface DownloadPrerequisitesResult {
  datalad: ToolVersion;
  gitAnnex: ToolVersion;
  allPassed: boolean;
  errors: string[];
}

/**
 * Check prerequisites for dataset download
 * Simpler than upload - no AWS credentials or GitHub SSH needed
 */
export async function checkDownloadPrerequisites(): Promise<DownloadPrerequisitesResult> {
  const [datalad, gitAnnex] = await Promise.all([
    checkDataladInstalled(),
    checkGitAnnexInstalled(),
  ]);

  const errors: string[] = [];

  if (!datalad.installed) {
    errors.push("DataLad is not installed. Install: pip install datalad");
  } else if (datalad.compatible === false) {
    errors.push(`DataLad version ${datalad.version} is too old. Required: >= ${datalad.minVersion}`);
  }

  if (!gitAnnex.installed) {
    errors.push("git-annex is not installed. Install: brew install git-annex (macOS) or apt install git-annex (Linux)");
  } else if (gitAnnex.compatible === false) {
    errors.push(`git-annex version ${gitAnnex.version} is too old. Required: >= ${gitAnnex.minVersion}`);
  }

  return {
    datalad,
    gitAnnex,
    allPassed: errors.length === 0,
    errors,
  };
}

/**
 * Clone a DataLad dataset from GitHub
 */
export async function cloneDataset(
  repoUrl: string,
  outputPath: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { stderr, exitCode } = await runCommand(
      ["datalad", "clone", repoUrl, outputPath]
    );

    if (exitCode !== 0) {
      return { success: false, error: stderr.trim() || "Failed to clone dataset" };
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
  } = {}
): Promise<{ success: boolean; error?: string; filesDownloaded?: number }> {
  const jobs = options.jobs || 4;
  const paths = options.paths && options.paths.length > 0 ? options.paths : ["."];

  try {
    const args = ["datalad", "get", "-J", jobs.toString(), ...paths];
    const { stdout, stderr, exitCode } = await runCommand(args, { cwd: datasetPath });

    if (exitCode !== 0) {
      return { success: false, error: stderr.trim() || "Failed to get dataset data" };
    }

    // Count files downloaded from output
    const getMatches = stdout.match(/get\(ok\):/g);
    const filesDownloaded = getMatches ? getMatches.length : 0;

    return { success: true, filesDownloaded };
  } catch (e) {
    return { success: false, error: (e as Error).message };
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
export async function getLocalDatasetInfo(
  datasetPath: string
): Promise<LocalDatasetInfo | null> {
  if (!existsSync(datasetPath)) {
    return null;
  }

  try {
    const { stdout, exitCode } = await runCommand(
      ["git", "annex", "info", "--json"],
      { cwd: datasetPath }
    );

    if (exitCode === 0) {
      const info = JSON.parse(stdout);

      // Parse size string like "1.5 GB" to bytes
      let sizeBytes = 0;
      const sizeStr = info["local annex size"] || "0 bytes";
      const sizeMatch = sizeStr.match(/([\d.]+)\s*(bytes?|KB|MB|GB|TB)/i);
      if (sizeMatch) {
        const num = parseFloat(sizeMatch[1]);
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
  } catch {
    // Not a git-annex repo or error parsing
  }

  // Fallback: just count files
  try {
    const { stdout } = await runCommand(
      ["find", ".", "-type", "f", "-not", "-path", "./.git/*"],
      { cwd: datasetPath }
    );
    const files = stdout.trim().split("\n").filter(Boolean).length;
    return {
      files,
      size: "unknown",
      sizeBytes: 0,
      annexedFiles: 0,
      presentFiles: files,
      missingFiles: 0,
    };
  } catch {
    return null;
  }
}
