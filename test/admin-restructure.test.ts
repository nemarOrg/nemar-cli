/**
 * Admin Command Restructure Tests
 *
 * Tests the `dataset` group (alias `repo`, ADR 0135) and what moved under it:
 * the lifecycle commands, s3, ci, doi, and the retired regenerate-iam stubs.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import { TEST_CONFIG, sleep } from "./setup";

interface TestContext {
  configDir: string;
  configFile: string;
}

function createTestContext(): TestContext {
  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const configDir = join(import.meta.dir, ".test-configs", uniqueId);
  mkdirSync(configDir, { recursive: true });
  const configFile = join(configDir, "config.json");
  return { configDir, configFile };
}

async function runCli(
  args: string[],
  ctx?: TestContext,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["bun", "run", "src/index.ts", ...args],
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      ...(ctx ? { NEMAR_CONFIG_DIR: ctx.configDir } : {}),
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

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape byte is the point
const stripAnsi = (text: string): string => text.replace(/\u001B\[[0-9;]*m/g, "");

function setTestConfig(ctx: TestContext, config: Record<string, unknown>) {
  writeFileSync(ctx.configFile, JSON.stringify(config));
}

beforeEach(async () => {
  await sleep(300);
});

// ============================================================================
// Help output and command routing
// ============================================================================

describe("admin command restructure - help output", () => {
  test("admin --help shows the dataset group with its repo alias", async () => {
    const { stdout, exitCode } = await runCli(["admin", "--help"]);
    expect(exitCode).toBe(0);
    expect(stripAnsi(stdout)).toContain("dataset|repo");
  });

  test("admin dataset --help lists every command gathered under it", async () => {
    const { stdout, exitCode } = await runCli(["admin", "dataset", "--help"]);
    expect(exitCode).toBe(0);
    const commands = stripAnsi(stdout)
      .split("\n")
      .map((l) => /^ {2}(\S+)/.exec(l)?.[1])
      .filter(Boolean);
    for (const name of [
      "publish",
      "unpublish",
      "withdraw",
      "restore",
      "delete",
      "bulk-delete",
      "reindex",
      "doi",
      "ci",
      "s3",
      "exemplar",
      "doctor",
    ]) {
      expect(commands).toContain(name);
    }
  });

  test("admin dataset s3 --help shows lock and credential-check, not regenerate-iam", async () => {
    const { stdout, exitCode } = await runCli(["admin", "dataset", "s3", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("lock");
    expect(stdout).toContain("credential-check");
    expect(stdout).not.toContain("regenerate-iam");
  });

  test("admin repo --help lists the lifecycle commands and no visibility flips", async () => {
    const { stdout, exitCode } = await runCli(["admin", "repo", "--help"]);
    expect(exitCode).toBe(0);
    const commands = stripAnsi(stdout)
      .split("\n")
      .map((l) => /^ {2}(\S+)/.exec(l)?.[1])
      .filter(Boolean);
    expect(commands).toContain("publish");
    expect(commands).toContain("unpublish");
    expect(commands).toContain("withdraw");
    expect(commands).toContain("restore");
    // A bare visibility flip made half states (published but private, public but unpublished).
    expect(commands).not.toContain("public");
    expect(commands).not.toContain("private");
    expect(stdout).toContain("publication lifecycle");
  });

  test("admin dataset unpublish --help says how it differs from withdraw", async () => {
    const { stdout, exitCode } = await runCli(["admin", "dataset", "unpublish", "--help"]);
    expect(exitCode).toBe(0);
    const text = stripAnsi(stdout).replace(/\s+/g, " ");
    expect(text).toContain("DOIs untouched");
    expect(text).toContain("'withdraw'");
    expect(text).toContain("--apply");
    expect(text).not.toContain("--execute");
    expect(text).toContain("--reason");
    const all = await runCli(["admin", "dataset", "unpublish", "--help-all"]);
    expect(stripAnsi(all.stdout).replace(/\s+/g, " ")).toContain("every DOI is tombstoned");
  });

  test.each(["public", "private"])("`admin repo %s` no longer exists", async (name) => {
    const { stderr, exitCode } = await runCli(["admin", "repo", name, "nm000104", "-y"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unknown command");
  });

  test.each([
    ["withdraw", "nemar admin dataset withdraw"],
    ["restore", "nemar admin dataset restore"],
  ])("the old `admin %s` fails loudly and points at its new home", async (name, replacement) => {
    const { stderr, exitCode } = await runCli(["admin", name, "nm000104", "--execute"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(replacement);
  });

  test("the old `admin withdraw` and `admin restore` are not listed in admin --help", async () => {
    const { stdout } = await runCli(["admin", "--help"]);
    const commandLines = stdout.split("\n").filter((l) => /^\s+(withdraw|restore)\s/.test(l));
    expect(commandLines).toEqual([]);
  });

  test("admin dataset ci --help shows check, add, sync, and validate", async () => {
    const { stdout, exitCode } = await runCli(["admin", "dataset", "ci", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("check");
    expect(stdout).toContain("add");
    expect(stdout).toContain("sync");
    // validate was added in #472 — guard against silent removal in refactors.
    expect(stdout).toContain("validate");
    expect(stdout).toContain("CI workflow management");
  });

  test("admin --help does not show regenerate-iam at top level", async () => {
    const { stdout } = await runCli(["admin", "--help"]);
    // The hidden alias should not appear in help output
    const lines = stdout.split("\n");
    const commandLines = lines.filter((l) => l.trim().startsWith("regenerate-iam"));
    expect(commandLines.length).toBe(0);
  });
});

// ============================================================================
// Authentication requirements
// ============================================================================

describe("admin commands - auth requirements", () => {
  test("admin dataset unpublish requires auth", async () => {
    const ctx = createTestContext();
    const { stdout } = await runCli(["admin", "dataset", "unpublish", "nm000104", "-y"], ctx);
    expect(stdout).toContain("Not authenticated");
  });

  test("admin repo unpublish (the alias) requires auth the same way", async () => {
    const ctx = createTestContext();
    const { stdout } = await runCli(["admin", "repo", "unpublish", "nm000104", "-y"], ctx);
    expect(stdout).toContain("Not authenticated");
  });

  test("admin dataset ci check requires auth", async () => {
    const ctx = createTestContext();
    const { stdout } = await runCli(["admin", "dataset", "ci", "check", "nm000104"], ctx);
    expect(stdout).toContain("Not authenticated");
  });

  test("admin dataset ci add requires auth", async () => {
    const ctx = createTestContext();
    const { stdout } = await runCli(["admin", "dataset", "ci", "add", "nm000104", "-y"], ctx);
    expect(stdout).toContain("Not authenticated");
  });
});

// ============================================================================
// Backward compatibility
// ============================================================================

describe("admin commands - retired regenerate-iam", () => {
  test.each([
    [["regenerate-iam"], "nemar admin regenerate-iam"],
    [["s3", "regenerate-iam"], "nemar admin s3 regenerate-iam"],
  ])("admin %p fails at once and says it was retired", async (path, full) => {
    const ctx = createTestContext();
    const { stderr, exitCode } = await runCli(["admin", ...path, "testuser", "-y"], ctx);
    expect(exitCode).toBe(1);
    expect(stripAnsi(stderr)).toContain(`'${full}' was retired`);
  });
});

// ============================================================================
// Non-admin access (requires API key setup)
// ============================================================================

describe("admin commands - non-admin rejection", () => {
  test("non-admin user cannot use admin dataset ci check", async () => {
    if (!TEST_CONFIG.userApiKey) return;

    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: TEST_CONFIG.userApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-user",
    });

    const { stdout } = await runCli(["admin", "dataset", "ci", "check", "nm000104"], ctx);
    // Should not show success output (CI Status section)
    expect(stdout).not.toContain("CI Status:");
  });
});

// ============================================================================
// Admin operations (requires admin API key)
// ============================================================================

describe("admin commands - dataset ci check with admin", () => {
  test("admin dataset ci check on non-existent dataset returns 404", async () => {
    if (!TEST_CONFIG.adminApiKey) return;

    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: TEST_CONFIG.adminApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-admin",
    });

    const { stdout } = await runCli(["admin", "dataset", "ci", "check", "nm999999"], ctx);
    expect(stdout).toContain("Dataset not found");
  });
});
