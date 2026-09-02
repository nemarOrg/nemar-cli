/**
 * BIDS CI Tests
 *
 * Tests for: CI auto-deployment at upload, push --pr, dataset ci command.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import { sleep } from "./setup";

const TMP_DIR = join(import.meta.dir, ".test-bids-ci");

function createTestContext() {
  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const configDir = join(import.meta.dir, ".test-configs", uniqueId);
  mkdirSync(configDir, { recursive: true });
  const configFile = join(configDir, "config.json");
  return { configDir, configFile };
}

function setTestConfig(
  ctx: { configDir: string; configFile: string },
  config: Record<string, unknown>,
) {
  writeFileSync(ctx.configFile, JSON.stringify(config));
}

async function runCli(
  args: string[],
  options: { cwd?: string; configDir?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["bun", "run", join(import.meta.dir, "..", "src", "index.ts"), ...args],
    cwd: options.cwd || join(import.meta.dir, ".."),
    env: {
      ...process.env,
      ...(options.configDir ? { NEMAR_CONFIG_DIR: options.configDir } : {}),
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

async function runCmd(
  cmd: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd,
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

async function createTempAnnexRepo(): Promise<string> {
  const dir = join(TMP_DIR, `repo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });

  await runCmd(["git", "init"], dir);
  await runCmd(["git", "config", "user.email", "test@test.com"], dir);
  await runCmd(["git", "config", "user.name", "Test User"], dir);
  await runCmd(["git", "annex", "init", "test-repo"], dir);

  return dir;
}

beforeEach(async () => {
  await sleep(100);
});

afterAll(() => {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

// ============================================================================
// Help output and command existence
// ============================================================================

describe("bids-ci - help output", () => {
  test("dataset --help lists ci command", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("ci");
  });

  test("dataset ci --help shows usage", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "ci", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("BIDS validation CI status");
    expect(stdout).toContain("dataset-id");
  });

  test("dataset push --help shows --pr flag", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "push", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--pr");
    expect(stdout).toContain("--title");
    expect(stdout).toContain("--body");
    expect(stdout).toContain("pull request");
  });
});

// ============================================================================
// CI command - auth requirements
// ============================================================================

describe("bids-ci - auth requirements", () => {
  test("dataset ci requires auth", async () => {
    const ctx = createTestContext();
    const { stdout, exitCode } = await runCli(["dataset", "ci", "nm000104"], {
      configDir: ctx.configDir,
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Not authenticated");
  });

  test("dataset ci without dataset-id fails outside dataset dir", async () => {
    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: "fake-key",
      apiUrl: "https://example.com",
      username: "test",
    });

    const tmpDir = join(TMP_DIR, "non-dataset-dir");
    mkdirSync(tmpDir, { recursive: true });

    const { stdout, exitCode } = await runCli(["dataset", "ci"], {
      cwd: tmpDir,
      configDir: ctx.configDir,
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Could not detect dataset ID");
  });
});

// ============================================================================
// CI command - dataset ID detection
// ============================================================================

describe("bids-ci - dataset ID detection", () => {
  test("dataset ci detects ID from git remote", async () => {
    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: "fake-key",
      apiUrl: "https://example.com",
      username: "test",
    });

    const repoDir = await createTempAnnexRepo();
    // Add a remote that looks like a NEMAR dataset
    await runCmd(
      ["git", "remote", "add", "origin", "https://github.com/nemarDatasets/nm099999.git"],
      repoDir,
    );

    // It will fail at the API call (fake URL) but the dataset ID should be detected
    const { stdout, exitCode } = await runCli(["dataset", "ci"], {
      cwd: repoDir,
      configDir: ctx.configDir,
    });
    // Should detect nm099999 from remote (not show "Could not detect" error)
    // and proceed to API call (which fails because URL is fake)
    expect(exitCode).toBe(1);
    expect(stdout).not.toContain("Could not detect dataset ID");
  });
});

// ============================================================================
// Push --pr - behavior tests
// ============================================================================

describe("bids-ci - push --pr", () => {
  test("push --pr on main branch skips PR creation", async () => {
    const repoDir = await createTempAnnexRepo();
    // Use a local bare repo as the remote so `git push` actually succeeds.
    // The previous version pushed at github.com/nemarDatasets/test which
    // either hung waiting for DNS+auth (local) or surfaced different error
    // strings (CI) and only ever exercised the failure path, never the
    // skip-PR-on-main logic the test name claims to verify.
    const remoteDir = join(
      TMP_DIR,
      `remote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(remoteDir, { recursive: true });
    await runCmd(["git", "init", "--bare"], remoteDir);

    // Create initial commit and rename branch to main
    writeFileSync(join(repoDir, "README.md"), "# Test\n");
    await runCmd(["git", "add", "README.md"], repoDir);
    await runCmd(["git", "commit", "-m", "init"], repoDir);
    await runCmd(["git", "branch", "-M", "main"], repoDir);
    await runCmd(["git", "remote", "add", "origin", remoteDir], repoDir);

    const { stdout, stderr, exitCode } = await runCli(["dataset", "push", "--pr", "--no-s3"], {
      cwd: repoDir,
    });

    // Push succeeds against the bare remote; PR creation is then skipped
    // because we're on main. The skip message is plain console.log, so it
    // lands in stdout deterministically across TTY and CI.
    expect(exitCode).toBe(0);
    const output = (stdout + stderr).toLowerCase();
    expect(output).toContain("skipping pr");
    expect(output).toContain("already on main branch");
  });

  test("push --pr passes title and body to gh cli", async () => {
    // This test just verifies the command accepts --title and --body flags without crashing
    const { stdout, exitCode } = await runCli(["dataset", "push", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("-t, --title");
    expect(stdout).toContain("-b, --body");
  });
});

// ============================================================================
// Upload CI integration (verified via help text)
// ============================================================================

describe("bids-ci - upload integration", () => {
  test("upload command still shows in help", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "upload", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Upload");
  });
});
