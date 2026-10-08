/**
 * Upload pipeline: dataset creation and data-transfer steps.
 *
 * Moved verbatim from the upload action in commands/dataset.ts (#907,
 * epic #902); the only intentional changes are import paths, the
 * step-function wrappers (process.exit -> return FAIL), printStepFailure
 * at the resume/create/annex-init/github-remote failure sites, and the
 * uploadProgress -> progress parameter rename in uploadDataToS3. Steps
 * print their own output and never call process.exit (the command
 * sequencer owns exits).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import ora, { type Ora } from "ora";
import type { UploaderPreflight } from "../../../shared/identifier-screen-report.js";
import { requestUploadCredentials } from "../api/data.js";
import {
  type PreflightRecording,
  createDataset,
  getDataset,
  recordDepositAttestation,
} from "../api/datasets.js";
import { ApiError, errorDetail } from "../api/errors.js";
import type { DepositAttestation } from "../attestation.js";
import { printStepFailure } from "../cli-output.js";
import { type LocalDatasetConfig, writeLocalConfig } from "../dataset-config.js";
import { acceptGitHubInvitation, configureGitHubRemote } from "../git-annex/github.js";
import {
  configureLargefiles,
  ensureGitAnnexInitialized,
  gitAnnexAdd,
  initDataset,
  isGitAnnexDataset,
  unstageTrackedPaths,
} from "../git-annex/init.js";
import {
  ANNEX_SIZE_THRESHOLD_BYTES,
  describeAnnexSizeThreshold,
  isCaseVariantData,
} from "../git-annex/policy.js";
import { ensureLocalMainBranch, getCurrentBranch } from "../git-annex/repo-state.js";
import { runCommand } from "../git-annex/run-command.js";
import {
  type S3Credentials,
  clearAnnexCredentials,
  configureS3Remote,
  toS3Credentials,
} from "../git-annex/s3-remote.js";
import { copyPathsToAnnexRemote } from "../git-annex/transfer.js";
import {
  type UploadProgress,
  clearStepCompleted,
  hasFileListChanged,
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
  /** Working-tree mtime; drives upload-progress change detection (#884). */
  mtimeMs?: number;
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

/**
 * Say so when the identifier preflight did not reach the dataset (ADR 0087). It warns and never
 * fails the upload: nothing gates on the record (the publication screen is the check that holds),
 * so stopping an upload over it would invent a refusal. But it is never silent, because an
 * absent record reads, correctly, as "no preflight on record", and the uploader should know.
 */
export function warnUnrecordedPreflight(
  sent: UploaderPreflight | undefined,
  outcome: PreflightRecording | { error: unknown },
): boolean {
  if (sent === undefined) return false;
  if (
    "identifier_preflight_recorded" in outcome &&
    outcome.identifier_preflight_recorded === true
  ) {
    return false;
  }
  // Four different facts, each said as itself: the call failed; the record was refused at the
  // door; the server took it and could not store it; or the server never mentioned it, which is
  // what a backend that predates the preflight does (it drops the field without a word).
  let why: string;
  if ("error" in outcome) why = `the request failed: ${errorDetail(outcome.error)}`;
  else if (outcome.identifier_preflight_refused) {
    why = `the server refused it (${outcome.identifier_preflight_refused})`;
  } else if (outcome.identifier_preflight_recorded === false) {
    why = "the server could not store it; running the upload again records it";
  } else why = "this NEMAR server does not record it";
  console.log(
    chalk.yellow(
      `  Warning: the identifier preflight was not recorded with your attestation (${why}).`,
    ),
  );
  console.log(
    chalk.dim("  The upload continues; NEMAR screens the dataset again before publication."),
  );
  return true;
}

/** Step 6: Create a new dataset in the backend, or resume an existing one. */
export async function createOrResumeDataset(
  absolutePath: string,
  options: { description?: string; datasetId?: string },
  datasetName: string,
  dataFiles: UploadFileEntry[],
  existingConfig: LocalDatasetConfig | null,
  attestation?: DepositAttestation,
  identifierPreflight?: UploaderPreflight,
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

    // A resume from a local config never reaches the create call, so the attestation answered
    // at the prompt, and the preflight of the files about to be sent, are recorded here instead
    // (ADR 0087). The server's own resume path (a dedup hit on create) records both the same way.
    if (attestation) {
      try {
        const recorded = await recordDepositAttestation(datasetInfo.dataset_id, {
          attestation,
          identifier_preflight: identifierPreflight,
        });
        warnUnrecordedPreflight(identifierPreflight, recorded);
      } catch (error) {
        console.log(
          chalk.yellow(
            `  Warning: the deposit attestation could not be recorded on resume: ${errorDetail(error)}`,
          ),
        );
        warnUnrecordedPreflight(identifierPreflight, { error });
      }
    } else {
      // The preflight is recorded WITH the attestation; without one it has nowhere to go.
      warnUnrecordedPreflight(identifierPreflight, {
        identifier_preflight_recorded: false,
        identifier_preflight_refused: "preflight-without-attestation",
      });
    }
  } else {
    // Step 6: Create new dataset in backend with file manifest
    spinner = ora("Creating dataset in NEMAR...").start();

    try {
      const response = await createDataset({
        name: datasetName,
        description: options.description,
        files: dataFiles.map((f) => ({ path: f.path, size: f.size, type: f.type })),
        attestation,
        // Undefined on a call with no preflight, and `JSON.stringify` drops it then.
        identifier_preflight: identifierPreflight,
        // Undefined unless `--dataset-id` was given, and `JSON.stringify` drops
        // an undefined value, so an ordinary upload's body is unchanged by this
        // option existing. Never defaulted: a dataset id is allocated, and the
        // one reserved-band exception is something an operator asks for by name.
        dataset_id: options.datasetId,
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

      spinner.succeed(
        response.resumed
          ? `Resumed existing dataset: ${datasetInfo.dataset_id}`
          : `Dataset created: ${datasetInfo.dataset_id}`,
      );
      // One call for both answers, so the warning cannot be dropped from either.
      warnUnrecordedPreflight(identifierPreflight, response);
      if (!response.resumed) {
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
 * Paths currently tracked by git, read from the index (`git ls-files -z`).
 * No content access, so this is cheap at any dataset size. Throws on git
 * failure so callers fail loudly instead of deciding from an empty set.
 */
export async function listTrackedPaths(absolutePath: string): Promise<Set<string>> {
  const { stdout, stderr, exitCode } = await runCommand(["git", "ls-files", "-z"], {
    cwd: absolutePath,
  });
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "git ls-files failed");
  }
  return new Set(stdout.split("\0").filter(Boolean));
}

/**
 * Annexed working-tree files; with `remote`, only those whose content the
 * location log records as present at that remote. Log/index reads only --
 * no content access and no network.
 */
export async function listAnnexedPaths(
  absolutePath: string,
  remote?: string,
): Promise<Set<string>> {
  const args = remote
    ? ["git", "annex", "find", "--in", remote]
    : ["git", "annex", "find", "--include", "*"];
  const { stdout, stderr, exitCode } = await runCommand(args, { cwd: absolutePath });
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "git annex find failed");
  }
  return new Set(stdout.split("\n").filter(Boolean));
}

/**
 * Annexed working-tree files the location log does NOT record at `remote`: the
 * complement of `listAnnexedPaths(path, remote)` within `listAnnexedPaths(path)`,
 * in one walk. `--include '*'` is what makes git-annex consider every annexed file
 * rather than only those whose content is present, and `--not --in` is then read
 * against the log; no content access and no network.
 */
export async function listAnnexedPathsNotAt(
  absolutePath: string,
  remote: string,
): Promise<Set<string>> {
  const { stdout, stderr, exitCode } = await runCommand(
    ["git", "annex", "find", "--include", "*", "--not", "--in", remote],
    { cwd: absolutePath },
  );
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "git annex find failed");
  }
  return new Set(stdout.split("\n").filter(Boolean));
}

/**
 * The files the git-annex add must cover: everything still needing upload
 * PLUS any data file git does not currently track, regardless of what the
 * progress file claims (#884 review). A progress file can outlive the git
 * state it describes (deleted .git, partial rsync of the dataset to another
 * node); a file marked "uploaded" but untracked would otherwise be skipped
 * by the targeted add AND silently omitted by `git annex copy` (which exits
 * 0 for files it does not consider annexed), leaving content with no
 * location-log record anywhere while the upload reports success.
 * Re-adding such files is content-addressed, so a re-put is harmless; the
 * point is re-establishing the location log.
 */
export function computeAddTargets<T extends { path: string }>(
  filesToUpload: T[],
  dataFiles: T[],
  trackedPaths: Set<string>,
): T[] {
  const targets = [...filesToUpload];
  const seen = new Set(filesToUpload.map((f) => f.path));
  for (const file of dataFiles) {
    if (!trackedPaths.has(file.path) && !seen.has(file.path)) {
      targets.push(file);
      seen.add(file.path);
    }
  }
  return targets;
}

/**
 * Hand the data files to git-annex, with the CLI's reading of the policy
 * authoritative for the files where git-annex cannot read it.
 *
 * git-annex's `include=` and `exclude=` globs are case-sensitive, so `UPPER.EDF`,
 * `Mixed.Edf` and `X_MOTION.tsv` are not data to it by name, while the upload plan
 * (`shouldAnnex`, which folds case) has promised them to S3. Measured with the
 * production expression: `UPPER.EDF` under the size threshold stays in git, and
 * `X_MOTION.tsv` stays in git at ANY size because `exclude=*.tsv` matches it and
 * `include=*_motion.tsv` does not. Those files are added with `--force-large`;
 * everything else is added under the repository's own `annex.largefiles`, so an
 * override of the policy (an inherited `.gitattributes`) is still seen by the
 * not-annexed check rather than papered over. Re-running is a no-op for a file
 * already annexed and unmodified. See ADR 0031, amendment of 2026-10-07.
 */
export async function trackDataFiles(
  absolutePath: string,
  paths: string[],
): Promise<{ success: boolean; error?: string }> {
  const forced = paths.filter(isCaseVariantData);
  const regular = paths.filter((p) => !isCaseVariantData(p));
  const added = await gitAnnexAdd(absolutePath, regular);
  if (!added.success || forced.length === 0) return added;
  return gitAnnexAdd(absolutePath, forced, {}, { forceLarge: true });
}

/**
 * Data files from this run's add targets that git-annex did not annex, split by
 * whether that matters. The targets are data by NEMAR's annex policy
 * (`shouldAnnex`), so a file larger than the policy's size threshold that is
 * NOT annexed was routed into git by something overriding the policy (an
 * inherited `.gitattributes`, ADR 0060): it would be pushed to GitHub instead
 * of reaching S3, which is a hard failure. A small one can differ for a benign
 * reason (the CLI matches data extensions case-insensitively, git-annex's
 * `include=` globs do not), and committing a file at or under the size threshold
 * to git is harmless, so it is only reported. Pure; exported for unit tests.
 */
export function findDataFilesNotAnnexed<T extends { path: string; size: number; type?: string }>(
  addTargets: T[],
  annexedPaths: Set<string>,
): { blocking: T[]; small: T[] } {
  const missing = addTargets.filter(
    (f) => (f.type ?? "data") === "data" && !annexedPaths.has(f.path),
  );
  return {
    blocking: missing.filter((f) => f.size > ANNEX_SIZE_THRESHOLD_BYTES),
    small: missing.filter((f) => f.size <= ANNEX_SIZE_THRESHOLD_BYTES),
  };
}

/** "1 data file" / "165 data files". */
function countDataFiles(n: number): string {
  return `${n} data ${n === 1 ? "file" : "files"}`;
}

/**
 * The success line of the S3 step, stated from the location log rather than
 * from a count of copy records: `total` annexed files are now recorded at the
 * remote, of which `attempted` were sent in this run and `confirmed` were
 * reported as successful copies by git-annex. "Recorded", not "verified": the
 * evidence is git-annex's location log, which S3's acknowledged, MD5-checked PUT
 * makes trustworthy but which is not a bucket HEAD. Pure; exported for unit tests.
 */
export function formatUploadSummary(total: number, attempted: number, confirmed: number): string {
  if (total === 0) return "No annexed data files, so nothing was copied to S3";
  if (attempted === 0) {
    return `All ${countDataFiles(total)} ${total === 1 ? "was" : "were"} already recorded at the S3 remote (nothing to copy)`;
  }
  const already = total - attempted;
  const tail = already > 0 ? `; ${already} already there` : "";
  let confirmation = "";
  if (confirmed < attempted) {
    confirmation = ` (git-annex confirmed ${confirmed} of ${attempted}; the rest are recorded in the location log)`;
  } else if (confirmed > attempted) {
    confirmation = ` (git-annex reported ${confirmed} successful copies for ${attempted} files)`;
  }
  return `Uploaded ${countDataFiles(attempted)} to S3${confirmation}${tail}; all ${total} recorded at the remote`;
}

/** What the S3 step decided before copying, for the caller's progress line. */
export interface S3CopyPlan {
  /** Annexed data files in the dataset. */
  total: number;
  /** Of those, the ones the location log does not yet record at the remote. */
  pending: number;
  /** Data files this run added that git-annex put in git, at or under the size threshold. */
  smallNotAnnexed: string[];
}

/**
 * Everything the S3 step concluded, as data; the caller prints it. `ok` carries
 * the annexed set so the save step does not walk the tree for it again.
 */
export type S3CopyOutcome =
  | {
      status: "ok";
      total: number;
      attempted: number;
      confirmed: number;
      annexedPaths: Set<string>;
      smallNotAnnexed: string[];
    }
  | { status: "unreadable"; error: string }
  | { status: "blocked"; blocking: Array<{ path: string; size: number }> }
  | { status: "copy_failed"; error: string }
  | { status: "unverifiable"; error: string }
  | { status: "incomplete"; missing: string[]; total: number };

/**
 * The decisions of upload step 9, in order, against git-annex's own records:
 *
 *  1. Read what is annexed and what the location log does not yet record at
 *     `remote`. On a resume that is exactly the remainder; on a fresh upload it
 *     is every annexed data file.
 *  2. Refuse, BEFORE copying anything, a data file over the size threshold that
 *     git-annex did not annex: it would be committed to git and never reach S3.
 *     (A small one is only reported; see {@link findDataFilesNotAnnexed}.)
 *  3. Copy exactly the pending paths.
 *  4. Require EVERY annexed file to be recorded at the remote, not only this run's
 *     targets. A zero exit from `git annex copy` is not proof of availability: it
 *     skips working-tree files it does not consider annexed and still exits 0
 *     (#884 review), and an annexed file left behind by an earlier interrupted run
 *     is as missing from S3 as one added today.
 *
 * The caller owns the spinner, the credentials and the words; `onPlan` fires once,
 * after step 2 and before the copy, so the progress line can say how much is left.
 */
export async function copyAnnexedToRemote(args: {
  absolutePath: string;
  remote: string;
  addTargets: Array<{ path: string; size: number; type?: string }>;
  jobs: number;
  credentials?: S3Credentials;
  onPlan?: (plan: S3CopyPlan) => void | Promise<void>;
}): Promise<S3CopyOutcome> {
  const { absolutePath, remote, addTargets } = args;

  let annexedBefore: Set<string>;
  let pending: string[];
  try {
    annexedBefore = await listAnnexedPaths(absolutePath);
    pending = [...(await listAnnexedPathsNotAt(absolutePath, remote))].sort();
  } catch (listError) {
    return { status: "unreadable", error: errorDetail(listError) };
  }

  const notAnnexed = findDataFilesNotAnnexed(addTargets, annexedBefore);
  if (notAnnexed.blocking.length > 0) {
    return {
      status: "blocked",
      blocking: notAnnexed.blocking.map((f) => ({ path: f.path, size: f.size })),
    };
  }
  const smallNotAnnexed = notAnnexed.small.map((f) => f.path);

  await args.onPlan?.({ total: annexedBefore.size, pending: pending.length, smallNotAnnexed });

  const copy = await copyPathsToAnnexRemote(
    absolutePath,
    remote,
    pending,
    args.jobs,
    args.credentials,
  );
  if (!copy.success) {
    return { status: "copy_failed", error: copy.error ?? "Failed to copy to remote" };
  }

  let missing: string[];
  try {
    missing = [...(await listAnnexedPathsNotAt(absolutePath, remote))].sort();
  } catch (verifyError) {
    return { status: "unverifiable", error: errorDetail(verifyError) };
  }
  if (missing.length > 0) {
    const total = annexedBefore.size + missing.filter((p) => !annexedBefore.has(p)).length;
    return { status: "incomplete", missing, total };
  }

  return {
    status: "ok",
    total: annexedBefore.size,
    attempted: pending.length,
    confirmed: copy.filesCopied,
    annexedPaths: annexedBefore,
    smallNotAnnexed,
  };
}

/**
 * Make a blocked upload re-runnable, and say what to do.
 *
 * A data file git-annex refused is left staged as a plain git blob, and the
 * tracking step is stamped complete. Re-running after fixing the cause would then
 * do nothing: `git annex add` only considers files git sees as new or modified, so
 * on a staged, unmodified file it exits 0 and changes nothing (ADR 0060, verified
 * against git-annex 10.20260901). So the blob is dropped from the index (the file
 * stays on disk, untouched) and the stamp is cleared; the next run finds the file
 * untracked, adds it afresh, and annexes it if the cause is gone.
 *
 * A file that was never staged because `.gitignore` matches it (git-annex skips an
 * ignored file silently, while the upload plan is `find`-based and lists it) has
 * nothing to unstage; the stamp alone is what the re-run needs once the pattern is
 * fixed. Returns the number of files unstaged. Throws when git refuses to unstage.
 */
export async function recoverBlockedTracking(
  absolutePath: string,
  progress: UploadProgress,
  blockedPaths: string[],
): Promise<number> {
  const tracked = await listTrackedPaths(absolutePath);
  const staged = blockedPaths.filter((p) => tracked.has(p));
  await unstageTrackedPaths(absolutePath, staged);
  clearStepCompleted(progress, "tracking");
  writeUploadProgress(absolutePath, progress);
  return staged.length;
}

/** First few paths, then a count of the rest; shared by the step's failure messages. */
function previewPaths(paths: string[], limit = 5): string[] {
  const lines = paths.slice(0, limit).map((p) => `  - ${p}`);
  if (paths.length > limit) lines.push(`  ... and ${paths.length - limit} more`);
  return lines;
}

/**
 * The lines printed when large data files were not annexed. `unstaged` is how many
 * `recoverBlockedTracking` took out of the index, or null when it could not, in
 * which case the exact manual command is printed instead. Pure; exported for tests.
 */
export function describeBlockedTracking(
  blocking: Array<{ path: string; size: number }>,
  unstaged: number | null,
): string[] {
  const paths = blocking.map((f) => f.path);
  const lines = [
    `${countDataFiles(blocking.length)} over ${describeAnnexSizeThreshold()} ${blocking.length === 1 ? "was" : "were"} not added to git-annex and would be committed to git instead of uploaded to S3:`,
    ...previewPaths(paths),
  ];
  if (unstaged !== null) {
    lines.push(
      unstaged > 0
        ? `  ${unstaged} of them were unstaged so the next run can annex them; the files themselves are untouched.`
        : "  None of them was staged, so nothing needed unstaging.",
    );
  } else {
    const more = paths.length > 5 ? " (and the rest)" : "";
    lines.push(
      `  Could not unstage them. Run: git rm --cached -- ${paths.slice(0, 5).join(" ")}${more}`,
    );
  }
  lines.push(
    "  Find out why git-annex declined them, fix that, then re-run `nemar dataset upload`:",
    "    - a .gitattributes `annex.largefiles` setting overrides NEMAR's annex policy",
    "    - a .gitignore pattern matches the file: git-annex skips an ignored file without saying so, while the upload plan lists every file on disk",
  );
  return lines;
}

/** What step 9 hands to the steps after it. */
export interface S3StepState {
  progress: UploadProgress;
  /**
   * Every annexed path step 9 listed before it copied, or null when it did not copy
   * (nothing to upload, or already complete). Optional input to the save step.
   */
  annexedPaths: Set<string> | null;
}

/**
 * Step 9: Upload data files to S3 via the git-annex S3 special remote,
 * gated by the persisted "s3_upload" step. Returns the (possibly newly
 * initialized) progress so the finalize steps share one instance.
 * (`uploadProgress` is copied to a local `progress` binding — the one
 * mechanical rename in this move.)
 *
 * git-annex tracking (#884) is its own persisted "tracking" step, adds only
 * the files that need it (not the whole tree), and runs BEFORE the
 * credential request so a multi-hour add on a multi-TB dataset cannot burn
 * the 2h STS window. On resume with an unchanged file list the add is
 * skipped entirely; a changed list clears the step (see the merge loop
 * below). The skip decision never trusts the progress file alone: the git
 * index is consulted first (computeAddTargets) and the post-copy location
 * log is verified before anything is marked uploaded, so a progress file
 * that outlived its .git state cannot fake availability.
 */
export async function uploadDataToS3(
  absolutePath: string,
  options: { jobs: string },
  dataFiles: UploadFileEntry[],
  filesToUpload: Array<{ path: string; size: number; mtimeMs?: number }>,
  uploadProgress: UploadProgress | null,
  datasetInfo: DatasetInfo,
): Promise<Step<S3StepState>> {
  let progress = uploadProgress;
  let spinner: Ora;
  // The annexed paths step 9 listed, handed on so the save step need not walk the
  // tree for them again. Stays null when step 9 did not run its copy.
  let annexedPaths: Set<string> | null = null;
  // Initialize progress tracking if not already present
  if (!progress) {
    progress = initUploadProgress(absolutePath, datasetInfo.dataset_id, dataFiles);
  } else {
    // A completed git-annex tracking pass only covers the file list it saw;
    // new or size-changed files invalidate it so the add re-runs (#884).
    if (isStepCompleted(progress, "tracking") && hasFileListChanged(progress, dataFiles)) {
      clearStepCompleted(progress, "tracking");
      console.log(chalk.dim("  Data files changed since the last run; re-running git-annex add"));
    }
    // Add any new files to progress tracking
    for (const file of dataFiles) {
      if (!progress.files[file.path]) {
        progress.files[file.path] = {
          status: "pending",
          size: file.size,
          mtimeMs: file.mtimeMs,
          updated_at: new Date().toISOString(),
        };
      }
    }
    writeUploadProgress(absolutePath, progress);
  }

  // Reconcile against ACTUAL git state, not just the progress file: the
  // progress file can survive while .git does not match it (#884 review).
  // Cheap index read; no content access -- runs even when "s3_upload" is
  // already marked complete (#1070). A prior run's completion stamp must
  // not hide data files added to the dataset since then: filesToUpload
  // (computed by the caller from the current file list) can be non-empty
  // even though "s3_upload" is stamped, and computeAddTargets can also
  // surface git-untracked files the stamp knows nothing about. Either way,
  // reopening the gate below is what lets a resumed upload actually pick
  // those files up instead of silently skipping them forever.
  let trackedPaths: Set<string>;
  try {
    trackedPaths = await listTrackedPaths(absolutePath);
  } catch (indexError) {
    console.log(chalk.red(`Failed to read the git index: ${errorDetail(indexError)}`));
    console.log(chalk.dim("  Re-run the command to retry."));
    return FAIL;
  }
  const addTargets = computeAddTargets(filesToUpload, dataFiles, trackedPaths);
  const untrackedCount = addTargets.length - filesToUpload.length;
  const reopenTracking = untrackedCount > 0 && isStepCompleted(progress, "tracking");
  const reopenUpload = addTargets.length > 0 && isStepCompleted(progress, "s3_upload");
  if (reopenTracking) {
    clearStepCompleted(progress, "tracking");
  }
  if (reopenUpload) {
    clearStepCompleted(progress, "s3_upload");
    // Reopening s3_upload for new content must also reopen the finalize
    // steps that depend on it (Step 11 saveDatasetStep / Step 12
    // pushMetadata in commands/dataset.ts, upload/finalize.ts). Both are
    // gated by their own persisted step and stay stamped complete from
    // the PRIOR run, so without this a new file's git-annex pointer would
    // reach S3 here but never be committed or pushed -- and
    // printUploadSuccess still clears progress and reports "Upload
    // complete!" with that pointer sitting only in the working tree
    // (review finding, critical: a run interrupted between pushMetadata
    // and printUploadSuccess -- e.g. mid deployCiStep -- leaves both
    // stamped true on disk with progress never cleared).
    clearStepCompleted(progress, "dataset_save");
    clearStepCompleted(progress, "github_push");
  }
  // One combined write instead of one per reopened step.
  if (reopenTracking || reopenUpload) {
    writeUploadProgress(absolutePath, progress);
  }
  if (reopenTracking) {
    console.log(
      chalk.yellow(
        `  ${untrackedCount} data files are missing from git despite recorded progress; re-tracking them`,
      ),
    );
  }
  if (reopenUpload) {
    console.log(
      chalk.yellow(
        `  ${addTargets.length} data file(s) still need upload despite a completed s3_upload step; resuming`,
      ),
    );
  }

  if (!isStepCompleted(progress, "s3_upload")) {
    if (addTargets.length > 0) {
      // Track data files with git-annex before anything else: the add can
      // take hours on multi-TB datasets, so it must not eat into the 2h STS
      // credential window, and its own persisted step lets a resume skip it.
      // Only files still needing upload (plus any untracked stragglers found
      // above) are added -- already-copied files are annexed already, and a
      // whole-tree add re-reads every unlocked file's content (#884).
      if (!isStepCompleted(progress, "tracking")) {
        spinner = ora(`Tracking ${addTargets.length} data files with git-annex...`).start();
        const addResult = await trackDataFiles(
          absolutePath,
          addTargets.map((f) => f.path),
        );
        if (!addResult.success) {
          spinner.fail(`Failed to track data files: ${addResult.error}`);
          console.log(chalk.yellow("Re-run the same command to resume tracking."));
          return FAIL;
        }
        spinner.succeed("Data files tracked by git-annex");
        markStepCompleted(progress, "tracking");
        writeUploadProgress(absolutePath, progress);
      } else {
        console.log(chalk.dim("  Data files already tracked by git-annex (skipping)"));
      }

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

      // The step's decisions live in copyAnnexedToRemote (what to copy comes
      // from the location log, a large data file git-annex refused fails before
      // any byte moves, and EVERY annexed file must end up recorded at the
      // remote); this block only says what happened. Cached STS credentials are
      // cleared whatever the outcome, so downloads use the public URL.
      let outcome: S3CopyOutcome;
      try {
        outcome = await copyAnnexedToRemote({
          absolutePath,
          remote: "nemar-s3",
          addTargets,
          jobs: Number.parseInt(options.jobs, 10),
          credentials: toS3Credentials(creds.credentials),
          onPlan: (plan) => {
            if (plan.smallNotAnnexed.length > 0) {
              console.log(
                chalk.dim(
                  `  ${plan.smallNotAnnexed.length} small data file(s) (<= ${describeAnnexSizeThreshold()}) were stored in git rather than the annex:`,
                ),
              );
              for (const line of previewPaths(plan.smallNotAnnexed, 3)) {
                console.log(chalk.dim(line));
              }
            }
            const already = plan.total - plan.pending;
            spinner = ora(
              already === 0
                ? `Uploading ${countDataFiles(plan.pending)} to S3...`
                : `Uploading ${countDataFiles(plan.pending)} to S3 (${already} already recorded there)...`,
            ).start();
          },
        });
      } finally {
        await clearAnnexCredentials(absolutePath);
      }

      switch (outcome.status) {
        case "unreadable":
          console.log(chalk.red(`Could not read the annex location log: ${outcome.error}`));
          console.log(chalk.yellow("Re-run the same command to retry."));
          return FAIL;
        case "blocked": {
          let unstaged: number | null = null;
          try {
            unstaged = await recoverBlockedTracking(
              absolutePath,
              progress,
              outcome.blocking.map((f) => f.path),
            );
          } catch (recoverError) {
            console.log(chalk.dim(`  ${errorDetail(recoverError)}`));
          }
          for (const line of describeBlockedTracking(outcome.blocking, unstaged)) {
            console.log(line.startsWith("    ") ? chalk.yellow(line) : chalk.red(line));
          }
          return FAIL;
        }
        case "copy_failed":
          spinner.fail(`S3 upload failed: ${outcome.error}`);
          console.log(chalk.yellow("Re-run the same command to resume uploading."));
          return FAIL;
        case "unverifiable":
          spinner.fail(`Could not verify the S3 upload: ${outcome.error}`);
          console.log(chalk.yellow("Re-run the same command to retry."));
          return FAIL;
        case "incomplete":
          spinner.fail(
            `S3 upload incomplete: ${outcome.missing.length} of ${outcome.total} annexed data files are not recorded at the S3 remote`,
          );
          for (const line of previewPaths(outcome.missing)) console.log(chalk.red(line));
          console.log(chalk.yellow("Re-run the same command to resume uploading."));
          return FAIL;
        case "ok":
          break;
      }
      annexedPaths = outcome.annexedPaths;

      for (const file of addTargets) {
        // Refresh the recorded size/mtime so a re-uploaded changed file
        // stops registering as changed on the next run (#884).
        markFileUploaded(progress, file.path, { size: file.size, mtimeMs: file.mtimeMs });
      }
      writeUploadProgress(absolutePath, progress);
      spinner.succeed(formatUploadSummary(outcome.total, outcome.attempted, outcome.confirmed));
    } else {
      console.log(chalk.dim("No data files to upload to S3"));
    }

    markStepCompleted(progress, "s3_upload");
    writeUploadProgress(absolutePath, progress);
  } else {
    console.log(chalk.dim("  S3 upload already completed (skipping)"));
  }

  return ok({ progress, annexedPaths });
}
