/**
 * Upload pipeline: finalize steps (metadata write, save, push, CI deploy,
 * success output). All gated by the persisted upload-progress steps.
 *
 * Moved verbatim from the upload action in commands/dataset.ts (#907,
 * epic #902); the only intentional changes are import paths, the
 * step-function wrappers (process.exit -> return FAIL; the command
 * sequencer owns exits), printStepFailure at the save/push failure sites,
 * and the `uploadProgress` -> `progress` parameter rename.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { addCi } from "../api/admin.js";
import type { NemarMetadataPayload } from "../api/datasets.js";
import { ApiError, errorDetail } from "../api/errors.js";
import { printStepFailure } from "../cli-output.js";
import { updateLastUpload } from "../dataset-config.js";
import { type SkipContentCheckEntry, pushToGitHub, saveDataset } from "../git-annex/clone-push.js";
import {
  type UploadProgress,
  clearUploadProgress,
  isStepCompleted,
  markStepCompleted,
  writeUploadProgress,
} from "../upload-progress.js";
import { listAnnexedPaths } from "./transfer.js";
import { type DatasetInfo, FAIL, type Step, ok } from "./types.js";

/** Step 10b: Write .nemar/metadata.json if missing and update .bidsignore (gated, warn-only). */
export function writeNemarMetadata(
  absolutePath: string,
  coAuthorEnrichment: NemarMetadataPayload | undefined,
  progress: UploadProgress,
): void {
  // (.nemar/metadata.json is already written at Step 4b; this just updates bidsignore)
  if (!isStepCompleted(progress, "metadata_write")) {
    if (coAuthorEnrichment) {
      try {
        // Write .nemar/metadata.json if not already on disk (e.g. old CLI resume)
        const nemarMetaDir = resolve(absolutePath, ".nemar");
        const nemarMetaPath = resolve(nemarMetaDir, "metadata.json");
        if (!existsSync(nemarMetaPath)) {
          if (!existsSync(nemarMetaDir)) {
            mkdirSync(nemarMetaDir, { recursive: true });
          }
          writeFileSync(nemarMetaPath, JSON.stringify(coAuthorEnrichment, null, 2));
        }

        // Ensure .bidsignore includes .nemar/ directory
        const bidsignorePath = resolve(absolutePath, ".bidsignore");
        let bidsignoreContent = "";
        if (existsSync(bidsignorePath)) {
          bidsignoreContent = readFileSync(bidsignorePath, "utf-8");
        }
        if (!bidsignoreContent.includes(".nemar/")) {
          const newContent = bidsignoreContent
            ? `${bidsignoreContent.trimEnd()}\n.nemar/\n`
            : ".nemar/\n";
          writeFileSync(bidsignorePath, newContent);
        }
        console.log(chalk.dim("  Updated .bidsignore for NEMAR metadata"));
      } catch (writeErr) {
        console.log(
          chalk.yellow(`  Warning: Could not update .bidsignore: ${errorDetail(writeErr)}`),
        );
        console.log(chalk.dim("  Upload will continue without author enrichment."));
      }
    }

    markStepCompleted(progress, "metadata_write");
    writeUploadProgress(absolutePath, progress);
  } else {
    console.log(chalk.dim("  Metadata write already completed (skipping)"));
  }
}

/**
 * Annexed bytes below which the save step reads every file as it always has.
 *
 * Skipping the re-read (see `saveDataset`) costs a pass over the annexed files to
 * compare their stat and two index rewrites to mark and unmark them, plus, when the
 * S3 step did not hand the annexed set on, a walk of the tree to list them. What it
 * saves is the content of those files streamed through git-annex filter-process.
 * On a tree of a few hundred megabytes the first outweighs the second: a
 * contributor's benchmark on a Ceph filesystem (600 annexed 120 KB files plus 600
 * JSON files) saved SLOWER with the skip, 33.5 s against 6.6 s. So the skip is taken
 * only when there is real content to avoid reading, and a small tree behaves exactly
 * as it did before the skip existed.
 *
 * 1 GiB is a deliberately conservative starting point, not a measured crossover:
 * nm000358 (1.6 TB) is three orders of magnitude above it and the Ceph benchmark
 * (72 MB of annexed data) more than one order below. Re-measure on the target host
 * before moving it.
 */
export const SAVE_SKIP_MIN_BYTES = 1024 ** 3;

/**
 * The annexed files whose content the save may skip re-reading, with the size and
 * mtime recorded for each when it was tracked, or null when the tree is too small
 * to be worth it ({@link SAVE_SKIP_MIN_BYTES}). A path with no recorded mtime (a
 * progress file from before mtimes were kept) cannot be vouched for and is left
 * out, so it is read as before. Pure; exported for unit tests.
 */
export function planSaveSkip(
  progress: UploadProgress,
  annexedPaths: ReadonlySet<string>,
  minBytes: number = SAVE_SKIP_MIN_BYTES,
): SkipContentCheckEntry[] | null {
  const entries: SkipContentCheckEntry[] = [];
  let bytes = 0;
  for (const path of annexedPaths) {
    const recorded = progress.files[path];
    if (!recorded || recorded.mtimeMs === undefined) continue;
    entries.push({ path, size: recorded.size, mtimeMs: recorded.mtimeMs });
    bytes += recorded.size;
  }
  return bytes >= minBytes ? entries : null;
}

/** Every data file's recorded size: an upper bound on the annexed bytes, free to compute. */
function recordedDataBytes(progress: UploadProgress): number {
  let bytes = 0;
  for (const file of Object.values(progress.files)) bytes += file.size;
  return bytes;
}

/**
 * Step 11: Save dataset changes (gated).
 *
 * `annexedPaths` is the set the S3 step already listed (null when it did not run
 * its copy). It is used only to decide what the save may skip re-reading, and only
 * when the data is large enough for that to matter; below the threshold this step
 * does no listing, no stat pass and no index rewrite. `skipMinBytes` exists so a
 * test can reach the large-tree branch without a gigabyte of fixtures.
 */
export async function saveDatasetStep(
  absolutePath: string,
  author: { name: string; email: string } | undefined,
  progress: UploadProgress,
  options: { annexedPaths?: ReadonlySet<string> | null; skipMinBytes?: number } = {},
): Promise<Step> {
  if (!isStepCompleted(progress, "dataset_save")) {
    const spinner = ora("Saving dataset changes...").start();

    // Annexed files are already staged (by the tracking step) and recorded at the
    // S3 remote; on a large tree `git add -A` must not stream their content through
    // git-annex filter-process again (#1455). A failure to list them only costs
    // speed, so it falls back to the plain add.
    const minBytes = options.skipMinBytes ?? SAVE_SKIP_MIN_BYTES;
    let skipContentCheck: SkipContentCheckEntry[] = [];
    if (recordedDataBytes(progress) >= minBytes) {
      let annexed: ReadonlySet<string> | null = options.annexedPaths ?? null;
      if (annexed === null) {
        try {
          annexed = await listAnnexedPaths(absolutePath);
        } catch (listError) {
          console.log(
            chalk.dim(
              `  Could not list annexed files (${errorDetail(listError)}); staging will re-read them`,
            ),
          );
        }
      }
      if (annexed !== null) skipContentCheck = planSaveSkip(progress, annexed, minBytes) ?? [];
    }
    const saveResult = await saveDataset(absolutePath, "Initial NEMAR dataset upload", author, {
      skipContentCheck,
    });
    if (!saveResult.success) {
      writeUploadProgress(absolutePath, progress);
      printStepFailure(spinner, "Failed to save dataset", saveResult.error);
      console.log();
      console.log(chalk.yellow("Re-run the same command to resume from this step."));
      return FAIL;
    }

    spinner.succeed("Dataset changes saved");
    markStepCompleted(progress, "dataset_save");
    writeUploadProgress(absolutePath, progress);
  } else {
    console.log(chalk.dim("  Dataset save already completed (skipping)"));
  }
  return ok();
}

/** Step 12: Push metadata to GitHub (gated; partial-success warns). */
export async function pushMetadata(absolutePath: string, progress: UploadProgress): Promise<Step> {
  if (!isStepCompleted(progress, "github_push")) {
    const spinner = ora("Pushing metadata to GitHub...").start();

    const githubPushResult = await pushToGitHub(absolutePath);
    if (!githubPushResult.success) {
      writeUploadProgress(absolutePath, progress);
      printStepFailure(spinner, "Failed to push to GitHub", githubPushResult.error);
      console.log();
      console.log(chalk.yellow("Re-run the same command to resume from this step."));
      return FAIL;
    }

    if (githubPushResult.warning) {
      spinner.warn("Metadata pushed to GitHub (with warning)");
      console.log(chalk.yellow(`  ${githubPushResult.warning}`));
    } else {
      spinner.succeed("Metadata pushed to GitHub");
    }

    markStepCompleted(progress, "github_push");
    writeUploadProgress(absolutePath, progress);
  } else {
    console.log(chalk.dim("  GitHub push already completed (skipping)"));
  }
  return ok();
}

/** Step 12b: Deploy BIDS validation CI (gated; 403 means an admin will configure it). */
export async function deployCiStep(
  absolutePath: string,
  datasetId: string,
  progress: UploadProgress,
): Promise<void> {
  if (!isStepCompleted(progress, "ci_deploy")) {
    const spinner = ora("Setting up BIDS validation CI...").start();
    try {
      await addCi(datasetId);
      spinner.succeed("BIDS validation CI configured");
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 403) {
        spinner.info("CI workflow will be configured by an admin");
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        spinner.warn(`Could not configure CI: ${msg}`);
        console.log(chalk.dim(`  An admin can add it later with: nemar admin ci add ${datasetId}`));
      }
    }

    markStepCompleted(progress, "ci_deploy");
    writeUploadProgress(absolutePath, progress);
  } else {
    console.log(chalk.dim("  CI deploy already completed (skipping)"));
  }
}

/** Step 13: Clear progress, stamp last upload, and print the success summary. */
export function printUploadSuccess(absolutePath: string, datasetInfo: DatasetInfo): void {
  // Note: Branch protection is NOT applied here for private datasets.
  // Protection is applied when creating a DOI (admin doi create) or making public.

  // Step 13: Success!
  // Clear progress file and update last upload timestamp
  clearUploadProgress(absolutePath);
  updateLastUpload(absolutePath);

  console.log();
  console.log(chalk.green.bold("Upload complete!"));
  console.log();
  console.log(`  Dataset ID: ${chalk.cyan(datasetInfo.dataset_id)}`);
  console.log(`  GitHub: ${chalk.cyan(datasetInfo.github_url)}`);
  console.log();
  console.log(chalk.dim("To download this dataset:"));
  console.log(chalk.dim(`  nemar dataset download ${datasetInfo.dataset_id}`));
  console.log();
  console.log(
    chalk.yellow("Note: This dataset is private. Only the owner and designated collaborators can"),
  );
  console.log(
    chalk.yellow("download it, and only through the NEMAR CLI (not direct git-annex commands)."),
  );
  console.log(chalk.yellow("After publishing, the data will be publicly available for everyone."));
}
