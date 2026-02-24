/**
 * E2E Test Runner
 *
 * Runs a full upload/download/update cycle against nm099999.
 * Uses real infrastructure (S3, GitHub, API) with admin credentials.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "bun";
import { resetTestDataset, requestUploadCredentials } from "./api.js";
import {
  clearAnnexCredentials,
  cloneDataset,
  configureGitHubRemote,
  configureLargefiles,
  configureS3Remote,
  copyToAnnexRemote,
  enableS3Remote,
  getDatasetData,
  gitAnnexAdd,
  initDataset,
  pushToGitHub,
  saveDataset,
  toS3Credentials,
} from "./git-annex.js";

const TEST_DATASET_ID = "nm099999";

export interface E2EStep {
  name: string;
  passed: boolean;
  duration_ms: number;
  error?: string;
}

export interface E2EResult {
  passed: boolean;
  steps: E2EStep[];
  total_duration_ms: number;
  upload_dir?: string;
  clone_dir?: string;
}

interface E2EContext {
  uploadDir: string;
  cloneDir: string;
  verbose: boolean;
}

function log(ctx: { verbose: boolean }, ...args: unknown[]) {
  if (ctx.verbose) console.log("  ", ...args);
}

async function runStep(
  name: string,
  fn: () => Promise<void>,
): Promise<E2EStep> {
  const start = performance.now();
  try {
    await fn();
    return { name, passed: true, duration_ms: Math.round(performance.now() - start) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, passed: false, duration_ms: Math.round(performance.now() - start), error: msg };
  }
}

/** Run steps in order, stopping after the first failure. */
async function runStepsSequentially(
  defs: Array<{ name: string; fn: () => Promise<void> }>,
): Promise<E2EStep[]> {
  const steps: E2EStep[] = [];
  for (const { name, fn } of defs) {
    const step = await runStep(name, fn);
    steps.push(step);
    if (!step.passed) break;
  }
  return steps;
}

async function runCommand(
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

function assertOk(result: { success: boolean; error?: string }, msg: string) {
  if (!result.success) throw new Error(`${msg}: ${result.error}`);
}

/**
 * Get path to bids-minimal fixture directory.
 * Works both from source (src/) and built (dist/) locations.
 */
function getFixturePath(): string {
  // Try relative to this file's location
  const candidates = [
    resolve(__dirname, "../../test/fixtures/bids-minimal"),
    resolve(__dirname, "../test/fixtures/bids-minimal"),
    resolve(process.cwd(), "test/fixtures/bids-minimal"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `Could not find test/fixtures/bids-minimal. Run from the nemar-cli root directory.`,
  );
}

export async function runE2ETest(options: {
  verbose?: boolean;
  skipReset?: boolean;
  skipCleanup?: boolean;
}): Promise<E2EResult> {
  const verbose = options.verbose ?? false;
  const totalStart = performance.now();

  const uploadDir = mkdtempSync(join(tmpdir(), "nemar-e2e-upload-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "nemar-e2e-clone-"));
  const ctx: E2EContext = { uploadDir, cloneDir, verbose };

  // Build the step pipeline; each step runs only if all previous steps passed.
  const stepDefs: Array<{ name: string; fn: () => Promise<void> }> = [];

  if (!options.skipReset) {
    stepDefs.push({
      name: "Reset nm099999",
      fn: async () => {
        const result = await resetTestDataset(TEST_DATASET_ID);
        log(ctx, `S3 objects deleted: ${result.steps.s3_deleted}`);
        log(ctx, `GitHub recreated: ${result.steps.github_recreated}`);
        log(ctx, `D1 cleaned: ${result.steps.d1_cleaned}`);
        if (!result.steps.github_recreated) {
          throw new Error("GitHub repo was not recreated");
        }
      },
    });
  }

  stepDefs.push(
    {
      name: "Prepare upload",
      fn: async () => {
        const fixturePath = getFixturePath();
        cpSync(fixturePath, uploadDir, { recursive: true });
        log(ctx, `Copied fixtures to ${uploadDir}`);
      },
    },
    {
      name: "Init git + annex",
      fn: async () => {
        assertOk(await initDataset(uploadDir, { force: true }), "initDataset");
        assertOk(await configureLargefiles(uploadDir), "configureLargefiles");
        log(ctx, "Git + git-annex initialized");
      },
    },
    {
      name: "Configure remotes",
      fn: async () => {
        const creds = await requestUploadCredentials(TEST_DATASET_ID);
        log(ctx, `S3 prefix: ${creds.s3.prefix}`);

        assertOk(
          await configureS3Remote(
            uploadDir,
            {
              name: "nemar-s3",
              bucket: creds.s3.bucket,
              prefix: `${TEST_DATASET_ID}/objects`,
              region: creds.s3.region,
              publicUrl: `https://${creds.s3.bucket}.s3.${creds.s3.region}.amazonaws.com/${TEST_DATASET_ID}/objects`,
            },
            toS3Credentials(creds.credentials),
          ),
          "configureS3Remote",
        );

        const sshUrl = `git@github.com:nemarDatasets/${TEST_DATASET_ID}.git`;
        assertOk(await configureGitHubRemote(uploadDir, sshUrl), "configureGitHubRemote");
        log(ctx, "S3 + GitHub remotes configured");
      },
    },
    {
      name: "Upload to S3",
      fn: async () => {
        assertOk(await gitAnnexAdd(uploadDir), "gitAnnexAdd");
        assertOk(await saveDataset(uploadDir, "Initial BIDS dataset"), "saveDataset");

        const creds = await requestUploadCredentials(TEST_DATASET_ID);
        const copyResult = await copyToAnnexRemote(
          uploadDir,
          "nemar-s3",
          4,
          toS3Credentials(creds.credentials),
        );
        assertOk(copyResult, "copyToAnnexRemote");
        log(ctx, `Files copied to S3: ${copyResult.filesCopied}`);

        await clearAnnexCredentials(uploadDir);
      },
    },
    {
      name: "Push to GitHub",
      fn: async () => {
        const pushResult = await pushToGitHub(uploadDir);
        assertOk(pushResult, "pushToGitHub");
        if (pushResult.warning) {
          log(ctx, `Warning: ${pushResult.warning}`);
        }
        log(ctx, "Pushed to GitHub (main + git-annex branches)");
      },
    },
    {
      name: "Clone fresh",
      fn: async () => {
        const cloneUrl = `git@github.com:nemarDatasets/${TEST_DATASET_ID}.git`;
        assertOk(await cloneDataset(cloneUrl, cloneDir), "cloneDataset");

        const enableResult = await enableS3Remote(cloneDir, "nemar-s3");
        if (!enableResult.success) {
          throw new Error(`enableS3Remote: ${enableResult.error}`);
        }
        log(ctx, `Clone at ${cloneDir}, S3 remote enabled: ${enableResult.enabled}`);
      },
    },
    {
      name: "Download + verify",
      fn: async () => {
        const getResult = await getDatasetData(cloneDir);
        assertOk(getResult, "getDatasetData");
        log(ctx, `Files downloaded: ${getResult.filesDownloaded}`);

        const edfPath = join(cloneDir, "sub-01/eeg/sub-01_task-rest_eeg.edf");
        if (!existsSync(edfPath)) {
          throw new Error("EDF file not found after download");
        }
        const { size } = Bun.file(edfPath);
        if (size < 512) {
          throw new Error(`EDF file too small: ${size} bytes`);
        }
        log(ctx, `EDF file verified: ${size} bytes`);
      },
    },
    {
      name: "Update cycle",
      fn: async () => {
        const sub02Dir = join(cloneDir, "sub-02/eeg");
        mkdirSync(sub02Dir, { recursive: true });

        // Create a small EDF for sub-02
        const edfData = Buffer.alloc(1024);
        edfData.write("0".padEnd(8), 0, "ascii"); // version
        writeFileSync(join(sub02Dir, "sub-02_task-rest_eeg.edf"), edfData);
        writeFileSync(
          join(sub02Dir, "sub-02_task-rest_eeg.json"),
          JSON.stringify({ TaskName: "rest", SamplingFrequency: 256 }),
        );

        // Update participants.tsv
        const partTsv = readFileSync(join(cloneDir, "participants.tsv"), "utf-8");
        writeFileSync(
          join(cloneDir, "participants.tsv"),
          partTsv.trimEnd() + "\nsub-02\t30\tF\n",
        );

        // Track + commit
        assertOk(await gitAnnexAdd(cloneDir), "gitAnnexAdd (update)");
        assertOk(await saveDataset(cloneDir, "Add sub-02"), "saveDataset (update)");

        // Upload new data to S3
        const creds = await requestUploadCredentials(TEST_DATASET_ID);
        const copyResult = await copyToAnnexRemote(
          cloneDir,
          "nemar-s3",
          4,
          toS3Credentials(creds.credentials),
        );
        assertOk(copyResult, "copyToAnnexRemote (update)");
        log(ctx, `Update files copied to S3: ${copyResult.filesCopied}`);

        await clearAnnexCredentials(cloneDir);

        // Push to a new branch
        const branchName = `e2e-update-${Date.now()}`;
        const { exitCode: branchCode } = await runCommand(
          ["git", "checkout", "-b", branchName],
          { cwd: cloneDir },
        );
        if (branchCode !== 0) throw new Error("Failed to create update branch");

        const pushResult = await pushToGitHub(cloneDir, "origin", branchName);
        assertOk(pushResult, "pushToGitHub (update branch)");

        await runCommand(["git", "push", "origin", "git-annex"], { cwd: cloneDir });

        log(ctx, `Update pushed to branch: ${branchName}`);
      },
    },
  );

  // Run steps sequentially, stopping on first failure
  const steps = await runStepsSequentially(stepDefs);

  // Cleanup unless skipped or a prior step failed
  if (!options.skipCleanup && steps.every((s) => s.passed)) {
    steps.push(
      await runStep("Cleanup", async () => {
        rmSync(uploadDir, { recursive: true, force: true });
        rmSync(cloneDir, { recursive: true, force: true });
        log(ctx, "Temp directories cleaned up");
      }),
    );
  }

  return finish(steps, totalStart, uploadDir, cloneDir, options.skipCleanup);
}

function finish(
  steps: E2EStep[],
  totalStart: number,
  uploadDir: string,
  cloneDir: string,
  skipCleanup?: boolean,
): E2EResult {
  const result: E2EResult = {
    passed: steps.every((s) => s.passed),
    steps,
    total_duration_ms: Math.round(performance.now() - totalStart),
  };
  if (skipCleanup) {
    result.upload_dir = uploadDir;
    result.clone_dir = cloneDir;
  }
  return result;
}
