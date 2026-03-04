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
import { importDataset } from "./api.js";
import {
  type S3Credentials,
  batchSetKeysPresent,
  cloneDataset,
  configureGitHubRemote,
  configureS3Remote,
  getAnnexWhereisAll,
  getKeyHashDirs,
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
    ? [{ doi: openNeuroDoi, relationType: "IsIdenticalTo" }]
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
 * Convert an HTTP URL from git-annex whereis to an S3 URI for aws s3 cp.
 *
 * OpenNeuro uses path-style URLs without a region:
 *   "https://s3.amazonaws.com/openneuro.org/ds007262/file.edf?versionId=abc"
 *   -> "s3://openneuro.org/ds007262/file.edf"
 *
 * Also handles virtual-hosted style:
 *   "http://openneuro.org.s3.amazonaws.com/ds007262/file.edf"
 *   -> "s3://openneuro.org/ds007262/file.edf"
 */
function httpToS3Uri(httpUrl: string): string | null {
  // Strip query string (e.g., ?versionId=...) before converting
  const urlWithoutQuery = httpUrl.split("?")[0];

  // Pattern: http(s)://{bucket}.s3[.region].amazonaws.com/{path}
  // Bucket can contain dots (e.g., openneuro.org), so use non-greedy match up to .s3.
  const vhostMatch = urlWithoutQuery.match(
    /^https?:\/\/(.+?)\.s3(?:\.[^.]+)?\.amazonaws\.com\/(.+)$/,
  );
  if (vhostMatch) {
    return `s3://${vhostMatch[1]}/${vhostMatch[2]}`;
  }
  // Pattern: http(s)://s3[.region].amazonaws.com/{bucket}/{path}
  // Region is optional (OpenNeuro uses plain s3.amazonaws.com)
  const pathMatch = urlWithoutQuery.match(
    /^https?:\/\/s3(?:\.[^.]+)?\.amazonaws\.com\/([^/]+)\/(.+)$/,
  );
  if (pathMatch) {
    return `s3://${pathMatch[1]}/${pathMatch[2]}`;
  }
  // Already an S3 URI
  if (httpUrl.startsWith("s3://")) {
    return httpUrl.split("?")[0];
  }
  return null;
}

/**
 * Copy a single object between S3 buckets using aws s3 cp.
 * The source can be a public bucket (no credentials needed to read).
 */
async function s3Copy(
  sourceUri: string,
  destUri: string,
  region: string,
): Promise<{ success: boolean; error?: string }> {
  const result = await runCommand(["aws", "s3", "cp", sourceUri, destUri, "--region", region], {});
  if (result.exitCode !== 0) {
    return { success: false, error: result.stderr.trim() };
  }
  return { success: true };
}

/**
 * Copy objects from OpenNeuro S3 to NEMAR S3 in parallel batches.
 */
async function batchS3Copy(
  items: Array<{ key: string; sourceUri: string; destUri: string }>,
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
        const result = await s3Copy(item.sourceUri, item.destUri, region);
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
 */
export async function importOpenNeuro(
  openneuroId: string,
  options: ImportOptions = {},
): Promise<void> {
  const nemarId = mapDatasetId(openneuroId);
  const workDir = options.workDir || mkdtempSync(join(tmpdir(), `nemar-import-${nemarId}-`));
  const datasetPath = join(workDir, nemarId);

  console.log(chalk.cyan(`\nImporting OpenNeuro dataset ${openneuroId} -> ${nemarId}\n`));
  console.log(chalk.gray(`Working directory: ${workDir}`));

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
  console.log(chalk.gray(`  Dataset: ${datasetName}`));
  if (openNeuroDoi) {
    console.log(chalk.gray(`  OpenNeuro DOI: ${openNeuroDoi}`));
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

    // Build copy items: resolve source URLs and compute destination paths
    const copySpinner = ora("Preparing S3-to-S3 copy...").start();
    const keys = Array.from(keyUrlMap.keys());
    const hashDirs = await getKeyHashDirs(datasetPath, keys);

    const copyItems: Array<{ key: string; sourceUri: string; destUri: string }> = [];
    const skipped: string[] = [];

    for (const [key, httpUrl] of keyUrlMap) {
      const sourceUri = httpToS3Uri(httpUrl);
      if (!sourceUri) {
        skipped.push(key);
        continue;
      }
      const hashDir = hashDirs.get(key);
      if (!hashDir) {
        skipped.push(key);
        continue;
      }
      const destUri = `s3://${S3_BUCKET}/${nemarId}/objects/${hashDir}${key}`;
      copyItems.push({ key, sourceUri, destUri });
    }

    if (skipped.length > 0) {
      console.log(chalk.yellow(`  Skipped ${skipped.length} keys (no S3 URL or hash dir)`));
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

  // Summary
  console.log(chalk.green(`\nImport complete: ${openneuroId} -> ${nemarId}`));
  console.log(chalk.gray(`  GitHub: https://github.com/nemarDatasets/${nemarId}`));
  console.log(chalk.gray(`  Working dir: ${datasetPath}`));

  console.log(chalk.cyan("\nNext steps:"));
  console.log(chalk.gray("  1. Review the imported dataset"));
  console.log(chalk.gray(`  2. Run: nemar admin publish approve ${nemarId}`));
}
