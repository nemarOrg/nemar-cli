/**
 * E2E Upload Tests
 *
 * These tests require real infrastructure:
 * - DataLad and git-annex installed
 * - GitHub SSH access configured
 * - Valid NEMAR API key
 *
 * Note: AWS credentials are now provided by the backend, not required locally.
 *
 * Tests will skip gracefully if prerequisites are not met.
 *
 * Run with: bun test test/e2e-upload.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "bun";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { TEST_CONFIG } from "./setup";

// Test dataset directory
const TEST_DIR = "/tmp/test-bids-upload";
const TEST_CONFIG_DIR = join(import.meta.dir, ".e2e-config");

interface Prerequisites {
  datalad: boolean;
  gitAnnex: boolean;
  githubSSH: boolean;
  apiKey: boolean;
}

async function checkPrerequisites(): Promise<Prerequisites> {
  const results: Prerequisites = {
    datalad: false,
    gitAnnex: false,
    githubSSH: false,
    apiKey: false,
  };

  // Check DataLad
  try {
    const proc = spawn({ cmd: ["datalad", "--version"], stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    results.datalad = true;
  } catch {}

  // Check git-annex
  try {
    const proc = spawn({ cmd: ["git-annex", "version"], stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    results.gitAnnex = true;
  } catch {}

  // Check GitHub SSH or token (GH_TOKEN for CI)
  if (process.env.GH_TOKEN) {
    results.githubSSH = true;
  } else {
    try {
      const proc = spawn({
        cmd: ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "git@github.com"],
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;
      results.githubSSH = stderr.includes("successfully authenticated");
    } catch {}
  }

  // Check API key
  results.apiKey = !!TEST_CONFIG.userApiKey;

  return results;
}

function createTestBidsDataset(path: string) {
  // Create directory structure
  mkdirSync(path, { recursive: true });
  mkdirSync(join(path, "sub-01", "eeg"), { recursive: true });

  // dataset_description.json (required)
  writeFileSync(
    join(path, "dataset_description.json"),
    JSON.stringify(
      {
        Name: "E2E Test Dataset",
        BIDSVersion: "1.9.0",
        Authors: ["Test Author"],
        License: "CC0",
      },
      null,
      2
    )
  );

  // README (required)
  writeFileSync(join(path, "README"), "# E2E Test Dataset\n\nThis is a test dataset for E2E testing.\n");

  // participants.tsv
  writeFileSync(join(path, "participants.tsv"), "participant_id\tage\tsex\nsub-01\t25\tM\n");

  // participants.json
  writeFileSync(
    join(path, "participants.json"),
    JSON.stringify(
      {
        participant_id: { Description: "Participant ID" },
        age: { Description: "Age in years" },
        sex: { Description: "Sex" },
      },
      null,
      2
    )
  );

  // Create a small test EEG file (just some bytes for testing)
  const testData = Buffer.alloc(1024, 0x42); // 1KB of test data
  writeFileSync(join(path, "sub-01", "eeg", "sub-01_task-rest_eeg.edf"), testData);

  // EEG sidecar JSON
  writeFileSync(
    join(path, "sub-01", "eeg", "sub-01_task-rest_eeg.json"),
    JSON.stringify(
      {
        TaskName: "rest",
        SamplingFrequency: 256,
        EEGReference: "average",
      },
      null,
      2
    )
  );

  // Channels TSV
  writeFileSync(
    join(path, "sub-01", "eeg", "sub-01_task-rest_channels.tsv"),
    "name\ttype\tunits\nFp1\tEEG\tuV\nFp2\tEEG\tuV\n"
  );
}

async function runCli(
  args: string[],
  options: { env?: Record<string, string> } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["bun", "run", "src/index.ts", ...args],
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      NEMAR_CONFIG_DIR: TEST_CONFIG_DIR,
      ...options.env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

function setTestConfig(config: Record<string, unknown>) {
  mkdirSync(TEST_CONFIG_DIR, { recursive: true });
  writeFileSync(join(TEST_CONFIG_DIR, "config.json"), JSON.stringify(config));
}

function cleanup() {
  try {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  } catch {}
  try {
    if (existsSync(TEST_CONFIG_DIR)) {
      rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
    }
  } catch {}
}

describe("E2E Upload Tests", () => {
  let prereqs: Prerequisites;
  let allPrereqsMet: boolean;

  beforeAll(async () => {
    prereqs = await checkPrerequisites();
    allPrereqsMet = prereqs.datalad && prereqs.gitAnnex && prereqs.githubSSH && prereqs.apiKey;

    if (!allPrereqsMet) {
      console.log("\n⚠️  E2E Upload tests will be skipped due to missing prerequisites:");
      if (!prereqs.datalad) console.log("   - DataLad not installed");
      if (!prereqs.gitAnnex) console.log("   - git-annex not installed");
      if (!prereqs.githubSSH) console.log("   - GitHub SSH not configured");
      if (!prereqs.apiKey) console.log("   - API key not configured");
      console.log("");
    }

    // Clean up any previous test artifacts
    cleanup();
  });

  afterAll(() => {
    cleanup();
  });

  test("prerequisites check reports correct status", async () => {
    // This test always runs to verify our prereq checking works
    expect(typeof prereqs.datalad).toBe("boolean");
    expect(typeof prereqs.gitAnnex).toBe("boolean");
    expect(typeof prereqs.githubSSH).toBe("boolean");
    expect(typeof prereqs.apiKey).toBe("boolean");
  });

  test("upload --dry-run shows plan without making changes", async () => {
    if (!allPrereqsMet) {
      console.log("   Skipping: Not all prerequisites met for dry-run test");
      return;
    }

    // Create test dataset
    createTestBidsDataset(TEST_DIR);

    // Set up auth config
    setTestConfig({
      apiKey: TEST_CONFIG.userApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-user",
    });

    // Run upload with --dry-run
    const { stdout, stderr, exitCode } = await runCli([
      "dataset",
      "upload",
      TEST_DIR,
      "--dry-run",
      "--skip-validation", // Skip validation to speed up test
    ]);

    // Check both stdout and stderr (ora spinner outputs to stderr)
    const output = stdout + stderr;
    expect(output).toContain("Upload Plan:");
    expect(output).toContain("Dry run mode");
  });

  test("upload with missing prerequisites shows helpful errors", async () => {
    // This test only runs if SOME prereqs are missing
    if (allPrereqsMet) {
      console.log("   Skipping: All prerequisites met (test needs missing prereqs)");
      return;
    }

    // Need at least datalad and gitannex for the prereqs check to run
    if (!prereqs.datalad || !prereqs.gitAnnex) {
      console.log("   Skipping: Need DataLad/git-annex to test prereq error messages");
      return;
    }

    // Create test dataset
    createTestBidsDataset(TEST_DIR);

    // Set up auth config
    setTestConfig({
      apiKey: TEST_CONFIG.userApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-user",
    });

    // Run upload - should show prereq errors for missing items
    const { stdout, exitCode } = await runCli([
      "dataset",
      "upload",
      TEST_DIR,
      "--skip-validation",
      "-y", // Skip confirmation
    ]);

    // Should fail with prereq errors
    expect(exitCode).toBe(1);
    // Check for any of the known prereq error messages
    const hasPrereqError =
      stdout.includes("GitHub SSH") ||
      stdout.includes("AWS") ||
      stdout.includes("DataLad") ||
      stdout.includes("git-annex") ||
      stdout.includes("Prerequisites");
    expect(hasPrereqError).toBe(true);
  });

  test("full upload flow with dry-run (requires all prerequisites)", async () => {
    if (!allPrereqsMet) {
      console.log("   Skipping: Not all prerequisites met");
      return;
    }

    // Create fresh test dataset
    cleanup();
    createTestBidsDataset(TEST_DIR);

    // Set up auth config with real credentials
    setTestConfig({
      apiKey: TEST_CONFIG.userApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-user",
    });

    // Run upload with --dry-run to avoid creating real datasets
    // This tests the full flow except the actual upload
    const { stdout, stderr, exitCode } = await runCli([
      "dataset",
      "upload",
      TEST_DIR,
      "--name",
      "E2E-Test-Dataset",
      "--description",
      "Automated E2E test dataset",
      "--skip-validation",
      "--dry-run",
      "-j",
      "4",
    ]);

    console.log("Upload stdout:", stdout);
    if (stderr) console.log("Upload stderr:", stderr);

    // Verify dry-run success (stops before creating dataset)
    const output = stdout + stderr;
    expect(output).toContain("Prerequisites check passed");
    expect(output).toContain("Upload Plan:");
    expect(output).toContain("E2E-Test-Dataset");
    expect(output).toContain("Dry run mode");
    expect(exitCode).toBe(0);
  });
});
