/**
 * OpenNeuro dataset import
 *
 * Clones an OpenNeuro dataset, copies data directly from OpenNeuro S3 to
 * NEMAR S3 (server-side, no local download), and creates the corresponding
 * nemarDatasets repo with 'on' prefix ID.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { addCi, approvePublication, importDataset, requestPublication } from "./api.js";
import {
  type S3Credentials,
  batchSetKeysPresent,
  cloneDataset,
  configureGitHubRemote,
  configureS3Remote,
  getAnnexWhereisAll,
  getRemoteUuid,
  pushToGitHub,
  runCommand,
} from "./git-annex.js";

const OPENNEURO_ORG = "OpenNeuroDatasets";
const S3_BUCKET = "nemar";
const S3_REGION = "us-east-2";

interface ImportOptions {
  workDir?: string;
  skipData?: boolean;
}

/**
 * Map OpenNeuro dataset ID (ds######) to NEMAR ID (on######).
 */
function mapDatasetId(openneuroId: string): string {
  const match = openneuroId.match(/^ds(\d{6})$/);
  if (!match) {
    throw new Error(
      `Invalid OpenNeuro ID "${openneuroId}". Expected format: ds###### (e.g., ds007262)`,
    );
  }
  return `on${match[1]}`;
}

/**
 * Read dataset_description.json from a cloned dataset directory.
 */
function readBidsDescription(datasetPath: string): Record<string, unknown> {
  const descPath = join(datasetPath, "dataset_description.json");
  if (!existsSync(descPath)) {
    throw new Error(`dataset_description.json not found at ${descPath}`);
  }
  try {
    return JSON.parse(readFileSync(descPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to parse dataset_description.json at ${descPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Resolve S3 credentials from environment variables.
 * In CI, these come from GitHub secrets. Locally, from env.
 */
function resolveS3Credentials(): S3Credentials {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set in environment for S3 operations",
    );
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };
}

/**
 * Extract the OpenNeuro DOI from dataset_description.json, stripping the "doi:" prefix.
 */
function extractOpenNeuroDoi(bidsDesc: Record<string, unknown>): string | null {
  return typeof bidsDesc.DatasetDOI === "string" ? bidsDesc.DatasetDOI.replace(/^doi:/, "") : null;
}

/**
 * Seed .nemar/metadata.json with source information and IsIdenticalTo relation.
 */
function seedMetadata(
  datasetPath: string,
  nemarId: string,
  openneuroId: string,
  bidsDesc: Record<string, unknown>,
  openNeuroDoi: string | null,
): void {
  const nemarDir = join(datasetPath, ".nemar");
  if (!existsSync(nemarDir)) {
    mkdirSync(nemarDir, { recursive: true });
  }

  const relatedIdentifiers = openNeuroDoi
    ? [
        {
          identifier: openNeuroDoi,
          identifier_type: "DOI",
          relation_type: "IsIdenticalTo",
        },
      ]
    : [];

  const metadata = {
    version: "2.0",
    dataset_id: nemarId,
    source: "openneuro",
    source_id: openneuroId,
    title: (bidsDesc.Name as string) || nemarId,
    authors: Array.isArray(bidsDesc.Authors)
      ? Object.fromEntries((bidsDesc.Authors as string[]).map((a) => [a, {}]))
      : {},
    license: (bidsDesc.License as string) || "CC0",
    dataset_type: (bidsDesc.DatasetType as string) || "raw",
    related_identifiers: relatedIdentifiers,
    pipeline_stage: "seeded",
  };

  writeFileSync(join(nemarDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
}

/**
 * Copy a single object from a public HTTP URL to NEMAR S3.
 * Uses curl to stream from the public source (no AWS creds needed for read)
 * and pipes to aws s3 cp for the upload (uses NEMAR creds).
 * This avoids the 403 that happens when aws s3 cp tries to use NEMAR creds
 * to read from a different account's bucket.
 */
async function s3Copy(
  sourceUrl: string,
  destUri: string,
  region: string,
): Promise<{ success: boolean; error?: string }> {
  const result = await runCommand(
    ["bash", "-c", `curl -sfL '${sourceUrl}' | aws s3 cp - '${destUri}' --region '${region}'`],
    {},
  );
  if (result.exitCode !== 0) {
    return { success: false, error: result.stderr.trim() };
  }
  return { success: true };
}

/**
 * Copy objects from OpenNeuro S3 to NEMAR S3 in parallel batches.
 */
async function batchS3Copy(
  items: Array<{ key: string; sourceUrl: string; destUri: string }>,
  region: string,
  concurrency: number,
  onProgress?: (copied: number, total: number, currentKey: string) => void,
): Promise<{ copied: number; failed: Array<{ key: string; error: string }> }> {
  let copied = 0;
  const failed: Array<{ key: string; error: string }> = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(async (item) => {
        const result = await s3Copy(item.sourceUrl, item.destUri, region);
        if (!result.success) {
          throw new Error(result.error || "Unknown S3 copy error");
        }
        return item.key;
      }),
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === "fulfilled") {
        copied++;
      } else {
        failed.push({ key: batch[j].key, error: result.reason?.message || "Unknown error" });
      }
    }

    onProgress?.(copied, items.length, batch[batch.length - 1].key);
  }

  return { copied, failed };
}

/**
 * Import an OpenNeuro dataset into NEMAR.
 *
 * Steps:
 * 1. Clone OpenNeuro dataset (maps ds###### -> on######)
 * 2. Create NEMAR dataset record + GitHub repo via API
 * 3. Enable OpenNeuro S3 remote and build key-to-URL map
 * 4. Reconfigure git remote to nemarDatasets
 * 5. Set up NEMAR S3 remote, copy data S3-to-S3, register keys
 * 6. Seed .nemar/metadata.json
 * 7. Push to nemarDatasets
 * 8. Request and approve publication (with retry)
 */
export async function importOpenNeuro(
  openneuroId: string,
  options: ImportOptions = {},
): Promise<void> {
  const nemarId = mapDatasetId(openneuroId);
  const workDir = options.workDir || mkdtempSync(join(tmpdir(), `nemar-import-${nemarId}-`));
  const datasetPath = join(workDir, nemarId);

  console.log(chalk.cyan(`\nImporting OpenNeuro dataset ${openneuroId} -> ${nemarId}\n`));
  console.log(chalk.dim(`Working directory: ${workDir}`));

  // Step 1: Clone OpenNeuro dataset
  const cloneSpinner = ora("Cloning OpenNeuro dataset...").start();
  const openneuroUrl = `https://github.com/${OPENNEURO_ORG}/${openneuroId}.git`;

  const cloneResult = await cloneDataset(openneuroUrl, datasetPath);
  if (!cloneResult.success) {
    cloneSpinner.fail(`Failed to clone: ${cloneResult.error}`);
    process.exit(1);
  }
  cloneSpinner.succeed(`Cloned ${openneuroId}`);

  // Read BIDS metadata and extract OpenNeuro DOI once for reuse
  const bidsDesc = readBidsDescription(datasetPath);
  const datasetName = (bidsDesc.Name as string) || openneuroId;
  const openNeuroDoi = extractOpenNeuroDoi(bidsDesc);
  console.log(chalk.dim(`  Dataset: ${datasetName}`));
  if (openNeuroDoi) {
    console.log(chalk.dim(`  OpenNeuro DOI: ${openNeuroDoi}`));
  }

  // Step 2: Create NEMAR dataset record + GitHub repo
  const createSpinner = ora("Creating NEMAR dataset record...").start();
  try {
    const result = await importDataset({
      dataset_id: nemarId,
      name: datasetName,
      description: `Imported from OpenNeuro ${openneuroId}`,
      source: "openneuro",
      source_id: openneuroId,
    });
    createSpinner.succeed(`Created ${result.dataset_id} (${result.github_repo})`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("already exists") || msg.includes("409")) {
      createSpinner.warn(`Dataset ${nemarId} already exists, continuing...`);
    } else {
      createSpinner.fail(`Failed to create dataset: ${msg}`);
      process.exit(1);
    }
  }

  // Step 2b: Deploy CI workflows (must exist on main before push triggers them)
  const ciSpinner = ora("Deploying CI workflows...").start();
  try {
    await addCi(nemarId);
    ciSpinner.succeed(
      "CI workflows deployed (BIDS validation, LLM enrichment, archive generation)",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ciSpinner.warn(`CI deployment failed (non-fatal): ${msg}`);
    console.log(chalk.dim(`  Workflows can be deployed later with: nemar admin ci add ${nemarId}`));
  }

  // Step 3: Enable OpenNeuro S3 remote and build key-to-URL map
  let keyUrlMap = new Map<string, string>();
  if (!options.skipData) {
    const whereisSpinner = ora("Mapping annexed files from OpenNeuro S3...").start();
    const enableResult = await runCommand(["git", "annex", "enableremote", "s3-PUBLIC"], {
      cwd: datasetPath,
    });
    if (enableResult.exitCode !== 0) {
      whereisSpinner.fail(`Failed to enable s3-PUBLIC remote: ${enableResult.stderr.trim()}`);
      process.exit(1);
    }

    keyUrlMap = await getAnnexWhereisAll(datasetPath);

    if (keyUrlMap.size === 0) {
      whereisSpinner.warn("No annexed files found, skipping data copy");
    } else {
      whereisSpinner.succeed(`Found ${keyUrlMap.size} annexed files`);
    }
  }

  // Step 4: Reconfigure git remote to nemarDatasets
  const remoteSpinner = ora("Configuring NEMAR remote...").start();

  // Remove the OpenNeuro origin
  const removeResult = await runCommand(["git", "remote", "remove", "origin"], {
    cwd: datasetPath,
  });
  if (removeResult.exitCode !== 0 && !removeResult.stderr.includes("No such remote")) {
    remoteSpinner.fail(`Failed to remove OpenNeuro remote: ${removeResult.stderr.trim()}`);
    process.exit(1);
  }

  // Add nemarDatasets origin
  const nemarRepoUrl = `git@github.com:nemarDatasets/${nemarId}.git`;
  const remoteResult = await configureGitHubRemote(datasetPath, nemarRepoUrl, "origin");
  if (!remoteResult.success) {
    remoteSpinner.fail(`Failed to configure remote: ${remoteResult.error}`);
    process.exit(1);
  }
  remoteSpinner.succeed("Configured NEMAR remote");

  // Step 5: Set up NEMAR S3 remote, copy data S3-to-S3, register keys
  if (!options.skipData && keyUrlMap.size > 0) {
    const s3Spinner = ora("Setting up NEMAR S3 remote...").start();
    const s3Creds = resolveS3Credentials();

    const s3Result = await configureS3Remote(
      datasetPath,
      {
        name: "nemar-s3",
        bucket: S3_BUCKET,
        prefix: `${nemarId}/objects`,
        region: S3_REGION,
      },
      s3Creds,
    );
    if (!s3Result.success) {
      s3Spinner.fail(`Failed to configure S3 remote: ${s3Result.error}`);
      process.exit(1);
    }

    // Get NEMAR remote UUID for setpresentkey
    const nemarUuid = await getRemoteUuid(datasetPath, "nemar-s3");
    if (!nemarUuid) {
      s3Spinner.fail("Failed to get NEMAR S3 remote UUID");
      process.exit(1);
    }
    s3Spinner.succeed("Configured NEMAR S3 remote");

    // Build copy items: source HTTP URLs and flat destination paths (no hash dirs)
    const copySpinner = ora("Preparing S3-to-S3 copy...").start();

    const copyItems: Array<{ key: string; sourceUrl: string; destUri: string }> = [];
    const skipped: string[] = [];

    for (const [key, httpUrl] of keyUrlMap) {
      if (!httpUrl.startsWith("http")) {
        skipped.push(key);
        continue;
      }
      const destUri = `s3://${S3_BUCKET}/${nemarId}/objects/${key}`;
      copyItems.push({ key, sourceUrl: httpUrl, destUri });
    }

    if (skipped.length > 0) {
      console.log(chalk.yellow(`  Skipped ${skipped.length} keys (no source URL)`));
    }

    copySpinner.succeed(`Prepared ${copyItems.length} files for S3-to-S3 copy`);

    // Execute S3-to-S3 copy in parallel batches
    const s3CopySpinner = ora(`Copying ${copyItems.length} files to NEMAR S3...`).start();
    const copyResult = await batchS3Copy(copyItems, S3_REGION, 8, (copied, total) => {
      s3CopySpinner.text = `Copying files to NEMAR S3... ${copied}/${total}`;
    });

    if (copyResult.failed.length > 0) {
      console.error(chalk.red(`\n  Failed to copy ${copyResult.failed.length} files:`));
      for (const f of copyResult.failed.slice(0, 5)) {
        console.error(chalk.red(`    ${f.key}: ${f.error}`));
      }
      if (copyResult.failed.length > 5) {
        console.error(chalk.red(`    ... and ${copyResult.failed.length - 5} more`));
      }
      s3CopySpinner.fail(
        `${copyResult.failed.length} of ${copyItems.length} files failed to copy. Re-run to retry.`,
      );
      process.exit(1);
    }
    s3CopySpinner.succeed(`Copied ${copyResult.copied} files to NEMAR S3`);

    // Register all copied keys with git-annex
    const registerSpinner = ora("Registering files in git-annex...").start();
    const failedKeys = new Set(copyResult.failed.map((f) => f.key));
    const copiedKeys = copyItems
      .filter((item) => !failedKeys.has(item.key))
      .map((item) => item.key);

    const regResult = await batchSetKeysPresent(datasetPath, copiedKeys, nemarUuid);
    if (regResult.failed > 0) {
      console.log(chalk.yellow(`  ${regResult.failed} keys failed to register (non-fatal)`));
    }
    registerSpinner.succeed(`Registered ${regResult.success} files in git-annex`);
  }

  // Step 6: Seed .nemar/metadata.json
  const metaSpinner = ora("Seeding metadata...").start();
  try {
    seedMetadata(datasetPath, nemarId, openneuroId, bidsDesc, openNeuroDoi);
  } catch (err) {
    metaSpinner.fail(
      `Failed to seed metadata: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // Stage and commit the metadata
  const addResult = await runCommand(["git", "add", ".nemar/metadata.json"], { cwd: datasetPath });
  if (addResult.exitCode !== 0) {
    metaSpinner.fail(`Failed to stage metadata: ${addResult.stderr.trim()}`);
    process.exit(1);
  }

  const commitResult = await runCommand(
    ["git", "commit", "-m", `Add NEMAR metadata (imported from OpenNeuro ${openneuroId})`],
    { cwd: datasetPath },
  );
  if (commitResult.exitCode !== 0 && !commitResult.stdout.includes("nothing to commit")) {
    metaSpinner.fail(`Failed to commit metadata: ${commitResult.stderr.trim()}`);
    process.exit(1);
  }
  metaSpinner.succeed("Seeded .nemar/metadata.json");

  // Step 7: Push to nemarDatasets
  const pushSpinner = ora("Pushing to nemarDatasets...").start();
  const pushResult = await pushToGitHub(datasetPath, "origin");
  if (!pushResult.success) {
    pushSpinner.fail(`Failed to push: ${pushResult.error}`);
    process.exit(1);
  }
  pushSpinner.succeed("Pushed to nemarDatasets");

  // Step 8: Request and approve publication
  const pubSpinner = ora("Requesting publication...").start();
  try {
    await requestPublication(nemarId);
    pubSpinner.succeed("Publication requested");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pubSpinner.fail(`Failed to request publication: ${msg}`);
    process.exit(1);
  }

  const approveSpinner = ora("Approving publication...").start();
  const maxRetries = 10;
  let approved = false;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // skipCiCheck=false: CI workflows are deployed before push, so checks should run
      await approvePublication(nemarId, attempt > 1, false, false);
      approved = true;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries) {
        approveSpinner.text = `Approving publication... (attempt ${attempt + 1}/${maxRetries})`;
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        approveSpinner.fail(`Failed to approve publication after ${maxRetries} attempts: ${msg}`);
        process.exit(1);
      }
    }
  }
  if (approved) {
    approveSpinner.succeed("Publication approved");
  }

  // Summary
  console.log(chalk.green(`\nImport and publish complete: ${openneuroId} -> ${nemarId}`));
  console.log(chalk.dim(`  GitHub: https://github.com/nemarDatasets/${nemarId}`));
  console.log(chalk.dim(`  Working dir: ${datasetPath}`));
}
