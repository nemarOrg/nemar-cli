/**
 * Upload pipeline: dataset creation and data-transfer steps.
 *
 * Moved verbatim from the upload action in commands/dataset.ts (#907,
 * epic #902); the only intentional changes are import paths and the
 * step-function wrappers. Steps print their own output and never call
 * process.exit (the command sequencer owns exits).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import ora, { type Ora } from "ora";
import {
  ApiError,
  createDataset,
  errorDetail,
  getDataset,
  requestUploadCredentials,
} from "../api.js";
import { printStepFailure } from "../cli-output.js";
import { type LocalDatasetConfig, writeLocalConfig } from "../dataset-config.js";
import {
  acceptGitHubInvitation,
  clearAnnexCredentials,
  configureGitHubRemote,
  configureLargefiles,
  configureS3Remote,
  copyToAnnexRemote,
  ensureGitAnnexInitialized,
  ensureLocalMainBranch,
  getCurrentBranch,
  gitAnnexAdd,
  initDataset,
  isGitAnnexDataset,
  toS3Credentials,
} from "../git-annex.js";
import {
  type UploadProgress,
  initUploadProgress,
  isStepCompleted,
  markFileUploaded,
  markStepCompleted,
  writeUploadProgress,
} from "../upload-progress.js";
import { type DatasetInfo, FAIL, type Step, ok } from "./types.js";

export interface UploadFileEntry {
  path: string;
  size: number;
  type: "metadata" | "data";
}

/**
 * Extract repo full name from github_url (e.g., "https://github.com/nemarDatasets/nm000123").
 * Validate URL format: must be a valid GitHub URL with owner/repo pattern.
 * Returns null when the URL doesn't match (caller prints the failure).
 */
export function parseRepoFullName(githubUrl: string | undefined): string | null {
  const repoMatch = githubUrl?.match(/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/);
  return repoMatch ? repoMatch[1].replace(/\.git$/, "") : null;
}

/** Ensure .nemar/ is gitignored (internal config, not dataset content). Warn-and-continue. */
export function ensureGitignoreHasNemar(absolutePath: string): void {
  try {
    const gitignorePath = resolve(absolutePath, ".gitignore");
    let gitignoreContent = "";
    if (existsSync(gitignorePath)) {
      gitignoreContent = readFileSync(gitignorePath, "utf-8");
    }
    if (!gitignoreContent.includes(".nemar/")) {
      const newContent = gitignoreContent
        ? `${gitignoreContent.trimEnd()}\n.nemar/\n`
        : ".nemar/\n";
      writeFileSync(gitignorePath, newContent);
    }
  } catch (gitignoreErr) {
    console.log(
      chalk.yellow(`  Warning: Could not update .gitignore: ${errorDetail(gitignoreErr)}`),
    );
  }
}

/** Step 6: Create a new dataset in the backend, or resume an existing one. */
export async function createOrResumeDataset(
  absolutePath: string,
  options: { description?: string },
  datasetName: string,
  dataFiles: UploadFileEntry[],
  existingConfig: LocalDatasetConfig | null,
): Promise<Step<DatasetInfo>> {
  let datasetInfo: DatasetInfo;

  // Check if this is a resume (existing local config was read by showUploadPlan)
  const isResume = existingConfig !== null;

  let spinner: Ora;

  if (isResume) {
    // Step 6: Resume existing dataset upload
    spinner = ora(`Resuming upload for ${existingConfig.dataset_id}...`).start();

    try {
      // Verify dataset still exists on backend (throws ApiError if not found)
      await getDataset(existingConfig.dataset_id);

      // Presigned URLs are requested adaptively in Step 9 (not upfront)
      datasetInfo = {
        dataset_id: existingConfig.dataset_id,
        ssh_url: existingConfig.ssh_url,
        s3_prefix: existingConfig.s3_prefix,
        github_url: existingConfig.github_url,
        upload_urls: {},
        s3_config: existingConfig.s3_config,
      };

      spinner.succeed(`Resuming upload: ${datasetInfo.dataset_id}`);
    } catch (error) {
      printStepFailure(spinner, "Failed to resume upload", error);
      if (error instanceof ApiError && error.statusCode === 404) {
        console.log(
          chalk.yellow("  The dataset may have been deleted. Try uploading as a new dataset."),
        );
        console.log(chalk.dim(`  Remove ${absolutePath}/.nemar to start fresh.`));
      }
      return FAIL;
    }
  } else {
    // Step 6: Create new dataset in backend with file manifest
    spinner = ora("Creating dataset in NEMAR...").start();

    try {
      const response = await createDataset({
        name: datasetName,
        description: options.description,
        files: dataFiles.map((f) => ({ path: f.path, size: f.size, type: f.type })),
      });

      datasetInfo = {
        dataset_id: response.dataset.dataset_id,
        ssh_url: response.dataset.ssh_url,
        s3_prefix: response.dataset.s3_prefix,
        github_url: response.dataset.github_url,
        upload_urls: response.upload_urls || {},
        s3_config: response.s3_config,
      };

      // Save local config for potential resume
      const localConfig: LocalDatasetConfig = {
        dataset_id: datasetInfo.dataset_id,
        github_url: datasetInfo.github_url,
        ssh_url: datasetInfo.ssh_url,
        s3_prefix: datasetInfo.s3_prefix,
        s3_config: datasetInfo.s3_config,
        created_at: new Date().toISOString(),
      };
      writeLocalConfig(absolutePath, localConfig);

      if (response.resumed) {
        spinner.succeed(`Resumed existing dataset: ${datasetInfo.dataset_id}`);
      } else {
        spinner.succeed(`Dataset created: ${datasetInfo.dataset_id}`);

        // Wait for IAM policy propagation (AWS is eventually consistent)
        // This initial wait helps reduce retry attempts during upload
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }
    } catch (error) {
      printStepFailure(spinner, "Failed to create dataset", error);
      return FAIL;
    }
  }

  return ok(datasetInfo);
}

/** Step 6b: Accept the GitHub repository invitation (warns and continues on failure). */
export async function acceptRepoInvitation(datasetInfo: DatasetInfo): Promise<Step> {
  const spinner = ora("Accepting GitHub repository invitation...").start();

  const repoFullName = parseRepoFullName(datasetInfo.github_url);

  if (!repoFullName) {
    spinner.fail("Invalid GitHub repository URL from backend");
    console.log(chalk.red(`  Received: ${datasetInfo.github_url || "(empty)"}`));
    console.log(chalk.red("  Expected format: https://github.com/owner/repo"));
    console.log();
    console.log("This may indicate a backend issue. Please contact support.");
    return FAIL;
  }

  const inviteResult = await acceptGitHubInvitation(repoFullName);
  if (inviteResult.accepted) {
    if (inviteResult.alreadyCollaborator) {
      spinner.succeed("Already a collaborator on this repository");
    } else {
      spinner.succeed("GitHub invitation accepted");
    }
  } else {
    spinner.warn("Could not auto-accept invitation");
    console.log(chalk.yellow(`  ${inviteResult.error}`));
    console.log();
    console.log("You may need to accept the invitation manually:");
    console.log(chalk.cyan(`  https://github.com/${repoFullName}/invitations`));
    console.log();
    // Continue anyway - user can accept manually
  }
  return ok();
}

/** Step 7: Initialize git-annex (init, largefiles, adjusted-branch note, .gitignore). */
export async function initializeAnnexDataset(
  absolutePath: string,
  author: { name: string; email: string } | undefined,
): Promise<Step> {
  const spinner = ora("Initializing git-annex dataset...").start();

  const isExistingDataset = await isGitAnnexDataset(absolutePath);
  if (!isExistingDataset) {
    const createResult = await initDataset(absolutePath, { author });
    if (!createResult.success) {
      printStepFailure(spinner, "Failed to initialize git-annex dataset", createResult.error);
      return FAIL;
    }
  }

  // Ensure git-annex is initialized (handles both new and existing datasets)
  const gitAnnexResult = await ensureGitAnnexInitialized(absolutePath);
  if (!gitAnnexResult.success) {
    printStepFailure(spinner, "Failed to initialize git-annex", gitAnnexResult.error);
    return FAIL;
  }

  // Configure largefiles pattern
  const largefilesResult = await configureLargefiles(absolutePath);
  if (!largefilesResult.success) {
    spinner.warn("Could not configure largefiles pattern");
    console.log(chalk.dim(`  ${largefilesResult.error}`));
  }

  spinner.succeed("git-annex dataset initialized");

  // Inform user that the adjusted branch name is normal
  const postInitBranch = await getCurrentBranch(absolutePath);
  if (postInitBranch?.startsWith("adjusted/")) {
    console.log(chalk.dim(`  Note: Your local branch is "${postInitBranch}".`));
    console.log(
      chalk.dim("  This is normal; it keeps files unlocked so you can work with them directly."),
    );
    console.log(chalk.dim('  Pushes will go to the "main" branch on GitHub automatically.'));
  }

  ensureGitignoreHasNemar(absolutePath);
  return ok();
}

/** Step 8: Configure the GitHub remote and ensure the local branch is "main". */
export async function configureRemotes(
  absolutePath: string,
  datasetInfo: DatasetInfo,
  options: { yes?: boolean },
): Promise<Step> {
  const spinner = ora("Configuring GitHub remote...").start();

  const githubResult = await configureGitHubRemote(absolutePath, datasetInfo.ssh_url);
  if (!githubResult.success) {
    printStepFailure(spinner, "Failed to configure GitHub remote", githubResult.error);
    return FAIL;
  }

  spinner.succeed("GitHub remote configured");

  // Step 8b: Ensure local branch is named "main"
  const branchOk = await ensureLocalMainBranch(absolutePath, { yes: options.yes });
  if (!branchOk) {
    return FAIL;
  }
  return ok();
}

/**
 * Step 9: Upload data files to S3 via the git-annex S3 special remote,
 * gated by the persisted "s3_upload" step. Returns the (possibly newly
 * initialized) progress so the finalize steps share one instance.
 * (`uploadProgress` is copied to a local `progress` binding — the one
 * mechanical rename in this move.)
 */
export async function uploadDataToS3(
  absolutePath: string,
  options: { jobs: string },
  dataFiles: UploadFileEntry[],
  filesToUpload: Array<{ path: string; size: number }>,
  uploadProgress: UploadProgress | null,
  datasetInfo: DatasetInfo,
): Promise<Step<UploadProgress>> {
  let progress = uploadProgress;
  let spinner: Ora;
  // Initialize progress tracking if not already present
  if (!progress) {
    progress = initUploadProgress(absolutePath, datasetInfo.dataset_id, dataFiles);
  } else {
    // Add any new files to progress tracking
    for (const file of dataFiles) {
      if (!progress.files[file.path]) {
        progress.files[file.path] = {
          status: "pending",
          size: file.size,
          updated_at: new Date().toISOString(),
        };
      }
    }
    writeUploadProgress(absolutePath, progress);
  }

  if (!isStepCompleted(progress, "s3_upload")) {
    if (filesToUpload.length > 0) {
      // Get STS credentials for S3 access
      spinner = ora("Requesting upload credentials...").start();
      let creds: Awaited<ReturnType<typeof requestUploadCredentials>>;
      try {
        creds = await requestUploadCredentials(datasetInfo.dataset_id);
        spinner.succeed("Upload credentials received (2h expiry)");
      } catch (credError) {
        spinner.fail(`Could not get upload credentials: ${errorDetail(credError)}`);
        console.log(chalk.red("  Upload credentials are required for S3 access."));
        console.log(chalk.dim("  Re-run the command to retry."));
        return FAIL;
      }

      // Configure S3 special remote (idempotent: enables existing if already created)
      spinner = ora("Configuring S3 remote...").start();
      const s3Result = await configureS3Remote(
        absolutePath,
        {
          name: "nemar-s3",
          bucket: creds.s3.bucket,
          prefix: `${datasetInfo.dataset_id}/objects`,
          region: creds.s3.region,
          publicUrl: datasetInfo.s3_config.public_url,
        },
        toS3Credentials(creds.credentials),
      );

      if (!s3Result.success) {
        spinner.fail(`Failed to configure S3 remote: ${s3Result.error}`);
        console.log(chalk.dim("  Re-run the command to retry."));
        return FAIL;
      }
      spinner.succeed("S3 remote configured");

      // Track data files with git-annex before uploading
      spinner = ora("Tracking data files with git-annex...").start();
      const addResult = await gitAnnexAdd(absolutePath);
      if (!addResult.success) {
        spinner.fail(`Failed to track data files: ${addResult.error}`);
        return FAIL;
      }
      spinner.succeed("Data files tracked by git-annex");

      // Upload via git-annex S3 remote (handles key-based layout + tracking)
      spinner = ora(`Uploading ${filesToUpload.length} data files to S3...`).start();
      const uploadResult = await copyToAnnexRemote(
        absolutePath,
        "nemar-s3",
        Number.parseInt(options.jobs, 10),
        toS3Credentials(creds.credentials),
      );

      // Always clear cached STS creds so downloads use publicurl
      await clearAnnexCredentials(absolutePath);

      if (!uploadResult.success) {
        spinner.fail(`S3 upload failed: ${uploadResult.error}`);
        console.log(chalk.yellow("Re-run the same command to resume uploading."));
        return FAIL;
      }

      for (const file of filesToUpload) {
        markFileUploaded(progress, file.path);
      }
      writeUploadProgress(absolutePath, progress);
      spinner.succeed(`Uploaded ${uploadResult.filesCopied} data files to S3`);
    } else {
      console.log(chalk.dim("No data files to upload to S3"));
    }

    markStepCompleted(progress, "s3_upload");
    writeUploadProgress(absolutePath, progress);
  } else {
    console.log(chalk.dim("  S3 upload already completed (skipping)"));
  }

  return ok(progress);
}
