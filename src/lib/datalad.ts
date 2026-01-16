/**
 * DataLad Service
 *
 * Manages DataLad/git-annex operations for dataset upload.
 * Requires DataLad >= 0.19.0 and git-annex >= 10.0 to be installed.
 */

import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { spawn } from "bun";

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
 * Note: AWS credentials are now provided by the backend, not required locally
 */
export interface PrerequisitesResult {
  datalad: ToolVersion;
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
    const { stdout, stderr, exitCode } = await runCommand(
      [
        "ssh",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "git@github.com",
      ],
      { timeout: 10000 },
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
 * Note: AWS credentials are provided by the backend after dataset creation
 */
export async function checkPrerequisites(): Promise<PrerequisitesResult> {
  const [datalad, gitAnnex, githubSSH] = await Promise.all([
    checkDataladInstalled(),
    checkGitAnnexInstalled(),
    checkGitHubSSH(),
  ]);

  const errors: string[] = [];

  if (!datalad.installed) {
    errors.push("DataLad is not installed. Install: pip install datalad");
  } else if (datalad.compatible === false) {
    errors.push(
      `DataLad version ${datalad.version} is too old. Required: >= ${datalad.minVersion}`,
    );
  }

  if (!gitAnnex.installed) {
    errors.push(
      "git-annex is not installed. Install: brew install git-annex (macOS) or apt install git-annex (Linux)",
    );
  } else if (gitAnnex.compatible === false) {
    errors.push(
      `git-annex version ${gitAnnex.version} is too old. Required: >= ${gitAnnex.minVersion}`,
    );
  }

  if (!githubSSH.accessible) {
    errors.push(
      "GitHub SSH access not configured. Add your SSH key to GitHub: https://github.com/settings/keys",
    );
  }

  return {
    datalad,
    gitAnnex,
    githubSSH,
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
  options: { force?: boolean } = {},
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
 * Configure GitHub remote using SSH or HTTPS (with token)
 */
export async function configureGitHubRemote(
  path: string,
  repoUrl: string,
  remoteName = "origin",
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
  } catch {
    // Remote doesn't exist, add it
    const { stderr, exitCode } = await runCommand(["git", "remote", "add", remoteName, finalUrl], {
      cwd: path,
    });

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
  message: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { stderr, exitCode } = await runCommand(["datalad", "save", "-m", message], {
      cwd: path,
    });

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
  },
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
  branch = "main",
): Promise<{ success: boolean; error?: string }> {
  try {
    // Push main branch
    const { stderr: mainStderr, exitCode: mainExitCode } = await runCommand(
      ["git", "push", "-u", remoteName, branch],
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
 */
export async function uploadFileWithPresignedUrl(
  filePath: string,
  presignedUrl: string,
  onProgress?: (uploaded: number, total: number) => void,
): Promise<{ success: boolean; error?: string }> {
  try {
    const fileContent = await Bun.file(filePath).arrayBuffer();
    const fileSize = fileContent.byteLength;

    // Use fetch to upload - presigned URLs use simple PUT
    const response = await fetch(presignedUrl, {
      method: "PUT",
      body: fileContent,
      headers: {
        "Content-Length": fileSize.toString(),
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
    }

    onProgress?.(fileSize, fileSize);
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
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
    const results = await Promise.all(
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
          failed.push(relativePath);
          options.onProgress?.({
            file: relativePath,
            uploaded: 0,
            total: 1,
            status: "failed",
            error: result.error,
          });
        }

        return { path: relativePath, ...result };
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
    errors.push(
      `DataLad version ${datalad.version} is too old. Required: >= ${datalad.minVersion}`,
    );
  }

  if (!gitAnnex.installed) {
    errors.push(
      "git-annex is not installed. Install: brew install git-annex (macOS) or apt install git-annex (Linux)",
    );
  } else if (gitAnnex.compatible === false) {
    errors.push(
      `git-annex version ${gitAnnex.version} is too old. Required: >= ${gitAnnex.minVersion}`,
    );
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
  outputPath: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { stderr, exitCode } = await runCommand(["datalad", "clone", repoUrl, outputPath]);

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
  } = {},
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
  } catch {
    // Not a git-annex repo or error parsing
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
  } catch {
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

  // Use find to get all files (excluding .git and .datalad)
  const { stdout, exitCode } = await runCommand(
    [
      "find",
      ".",
      "-type",
      "f",
      "-not",
      "-path",
      "./.git/*",
      "-not",
      "-path",
      "./.datalad/*",
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
