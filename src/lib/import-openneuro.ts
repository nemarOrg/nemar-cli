/**
 * OpenNeuro dataset import
 *
 * Clones an OpenNeuro dataset, copies data to NEMAR S3, and creates the
 * corresponding nemarDatasets repo with 'on' prefix ID.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import chalk from "chalk";
import ora from "ora";
import { importDataset } from "./api.js";
import {
  cloneDataset,
  configureGitHubRemote,
  configureS3Remote,
  copyToAnnexRemote,
  pushToGitHub,
  type S3Credentials,
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
 * Run a shell command and return result.
 */
async function run(
  cmd: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd,
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/**
 * Read dataset_description.json from a cloned dataset directory.
 */
function readBidsDescription(datasetPath: string): Record<string, unknown> {
  const descPath = join(datasetPath, "dataset_description.json");
  if (!existsSync(descPath)) {
    throw new Error(`dataset_description.json not found at ${descPath}`);
  }
  return JSON.parse(readFileSync(descPath, "utf-8"));
}

/**
 * Read datacite.yml from a cloned dataset if it exists.
 */
function readDataciteYml(datasetPath: string): string | null {
  for (const name of ["datacite.yml", "datacite.yaml"]) {
    const p = join(datasetPath, name);
    if (existsSync(p)) {
      return readFileSync(p, "utf-8");
    }
  }
  return null;
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
 * Seed .nemar/metadata.json with source information and IsIdenticalTo relation.
 */
function seedMetadata(
  datasetPath: string,
  nemarId: string,
  openneuroId: string,
  bidsDesc: Record<string, unknown>,
): void {
  const nemarDir = join(datasetPath, ".nemar");
  if (!existsSync(nemarDir)) {
    mkdirSync(nemarDir, { recursive: true });
  }

  // Extract OpenNeuro DOI from dataset_description.json
  const openNeuroDoi = typeof bidsDesc.DatasetDOI === "string"
    ? bidsDesc.DatasetDOI.replace(/^doi:/, "")
    : null;

  const relatedIdentifiers: Array<{ doi: string; relationType: string }> = [];
  if (openNeuroDoi) {
    relatedIdentifiers.push({
      doi: openNeuroDoi,
      relationType: "IsIdenticalTo",
    });
  }

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

  writeFileSync(join(nemarDir, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
}

/**
 * Import an OpenNeuro dataset into NEMAR.
 *
 * Steps:
 * 1. Map ds###### -> on######
 * 2. Clone OpenNeuro dataset
 * 3. Create NEMAR dataset record + GitHub repo via API
 * 4. Get annexed data from OpenNeuro S3
 * 5. Reconfigure git remote to nemarDatasets
 * 6. Set up NEMAR S3 remote
 * 7. Copy data to NEMAR S3
 * 8. Seed .nemar/metadata.json
 * 9. Push to nemarDatasets
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

  // Read BIDS metadata
  const bidsDesc = readBidsDescription(datasetPath);
  const datasetName = (bidsDesc.Name as string) || openneuroId;
  console.log(chalk.gray(`  Dataset: ${datasetName}`));

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

  // Step 3: Get annexed data from OpenNeuro S3
  if (!options.skipData) {
    const getSpinner = ora("Downloading annexed data from OpenNeuro...").start();
    const { stderr, exitCode } = await run(
      ["git", "annex", "get", "--all", "-J", "4"],
      { cwd: datasetPath },
    );
    if (exitCode !== 0) {
      getSpinner.fail(`Failed to get annexed data: ${stderr.trim()}`);
      console.log(chalk.yellow("Continuing without full data download..."));
    } else {
      getSpinner.succeed("Downloaded annexed data");
    }
  }

  // Step 4: Reconfigure git remote to nemarDatasets
  const remoteSpinner = ora("Configuring NEMAR remote...").start();

  // Remove the OpenNeuro origin
  await run(["git", "remote", "remove", "origin"], { cwd: datasetPath });

  // Add nemarDatasets origin
  const nemarRepoUrl = `git@github.com:nemarDatasets/${nemarId}.git`;
  const remoteResult = await configureGitHubRemote(datasetPath, nemarRepoUrl, "origin");
  if (!remoteResult.success) {
    remoteSpinner.fail(`Failed to configure remote: ${remoteResult.error}`);
    process.exit(1);
  }
  remoteSpinner.succeed("Configured NEMAR remote");

  // Step 5: Set up NEMAR S3 remote and copy data
  if (!options.skipData) {
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
    s3Spinner.succeed("Configured NEMAR S3 remote");

    // Copy data from local (downloaded from OpenNeuro) to NEMAR S3
    const copySpinner = ora("Copying data to NEMAR S3...").start();
    const copyResult = await copyToAnnexRemote(datasetPath, "nemar-s3", 4, s3Creds);
    if (!copyResult.success) {
      copySpinner.fail(`Failed to copy data: ${copyResult.error}`);
      process.exit(1);
    }
    copySpinner.succeed(`Copied ${copyResult.filesCopied} files to NEMAR S3`);
  }

  // Step 6: Seed .nemar/metadata.json
  const metaSpinner = ora("Seeding metadata...").start();
  seedMetadata(datasetPath, nemarId, openneuroId, bidsDesc);

  // Stage and commit the metadata
  await run(["git", "add", ".nemar/metadata.json"], { cwd: datasetPath });
  await run(
    ["git", "commit", "-m", `Add NEMAR metadata (imported from OpenNeuro ${openneuroId})`],
    { cwd: datasetPath },
  );
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

  const openNeuroDoi = typeof bidsDesc.DatasetDOI === "string" ? bidsDesc.DatasetDOI : null;
  if (openNeuroDoi) {
    console.log(chalk.gray(`  OpenNeuro DOI: ${openNeuroDoi}`));
  }

  console.log(chalk.cyan("\nNext steps:"));
  console.log(chalk.gray("  1. Review the imported dataset"));
  console.log(chalk.gray(`  2. Run: nemar admin publish approve ${nemarId}`));
}
