/**
 * CLI Command Integration Tests
 *
 * Tests CLI commands by spawning subprocesses.
 * Requires test users to be set up in the database.
 *
 * NOTE: These tests manipulate the user's real config file.
 * The config is backed up and restored after tests.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { spawn } from "bun";
import { TEST_CONFIG, sleep } from "./setup";
import { existsSync, unlinkSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "fs";
import { join } from "path";

// Real config path (macOS)
const CONFIG_DIR = join(process.env.HOME || "", "Library/Preferences/nemar-nodejs");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const CONFIG_BACKUP = join(CONFIG_DIR, "config.json.backup");

// Helper to run CLI commands
async function runCli(
  args: string[],
  options: { env?: Record<string, string>; input?: string } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["bun", "run", "src/index.ts", ...args],
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      ...options.env,
    },
    stdin: options.input ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (options.input) {
    proc.stdin?.write(options.input);
    proc.stdin?.end();
  }

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

// Helper to set config
function setTestConfig(config: Record<string, unknown>) {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config));
}

// Helper to clear config
function clearTestConfig() {
  if (existsSync(CONFIG_FILE)) {
    unlinkSync(CONFIG_FILE);
  }
}

// Add delay between tests to avoid rate limiting
beforeEach(async () => {
  await sleep(300);
});

// Backup real config before all tests
beforeAll(() => {
  if (existsSync(CONFIG_FILE)) {
    copyFileSync(CONFIG_FILE, CONFIG_BACKUP);
  }
});

// Restore real config after all tests
afterAll(() => {
  if (existsSync(CONFIG_BACKUP)) {
    copyFileSync(CONFIG_BACKUP, CONFIG_FILE);
    unlinkSync(CONFIG_BACKUP);
  }
});

describe("CLI Help", () => {
  test("nemar --help shows usage", async () => {
    const { stdout, exitCode } = await runCli(["--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: nemar");
    expect(stdout).toContain("auth");
    expect(stdout).toContain("dataset");
    expect(stdout).toContain("admin");
  });

  test("nemar --version shows version", async () => {
    const { stdout, exitCode } = await runCli(["--version"]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  test("nemar auth --help shows auth commands", async () => {
    const { stdout, exitCode } = await runCli(["auth", "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("login");
    expect(stdout).toContain("signup");
    expect(stdout).toContain("status");
    expect(stdout).toContain("logout");
  });

  test("nemar admin --help shows admin commands", async () => {
    const { stdout, exitCode } = await runCli(["admin", "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("users");
    expect(stdout).toContain("approve");
    expect(stdout).toContain("revoke");
  });

  test("nemar dataset --help shows dataset commands", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("validate");
    expect(stdout).toContain("upload");
    expect(stdout).toContain("download");
  });
});

describe("CLI Auth Commands", () => {
  describe("nemar auth status", () => {
    test("shows not authenticated when no credentials", async () => {
      clearTestConfig();

      const { stdout, exitCode } = await runCli(["auth", "status"]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Not authenticated");
    });

    test("shows authenticated when credentials exist", async () => {
      setTestConfig({
        apiKey: TEST_CONFIG.adminApiKey,
        apiUrl: TEST_CONFIG.apiUrl,
        username: "test-admin",
        email: "test-admin@nemar.test",
        githubUsername: "test-admin-gh",
      });

      const { stdout, exitCode } = await runCli(["auth", "status"]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Authenticated");
      expect(stdout).toContain("test-admin");
    });
  });

  describe("nemar auth login", () => {
    test("login with valid API key via -k flag", async () => {
      clearTestConfig();

      const { stdout, exitCode } = await runCli([
        "auth",
        "login",
        "-k",
        TEST_CONFIG.adminApiKey,
        "-f", // Force login even if already authenticated
      ]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Welcome back");
      expect(stdout).toContain("test-admin");
    });

    test("login with invalid API key shows error", async () => {
      clearTestConfig();

      const { stdout, exitCode } = await runCli([
        "auth",
        "login",
        "-k",
        "invalid_key_that_is_definitely_wrong_12345",
        "-f",
      ]);

      expect(stdout).toContain("Check that your API key is correct");
    });
  });

  describe("nemar auth logout", () => {
    test("logout when not authenticated shows message", async () => {
      clearTestConfig();

      const { stdout, exitCode } = await runCli(["auth", "logout", "-f"]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Not currently authenticated");
    });

    test("logout when authenticated clears credentials", async () => {
      setTestConfig({
        apiKey: TEST_CONFIG.userApiKey,
        apiUrl: TEST_CONFIG.apiUrl,
        username: "test-user",
      });

      const { stdout, exitCode } = await runCli(["auth", "logout", "-f"]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Logged out successfully");

      // Verify credentials are cleared
      const { stdout: statusOut } = await runCli(["auth", "status"]);
      expect(statusOut).toContain("Not authenticated");
    });
  });
});

describe("CLI Admin Commands", () => {
  describe("nemar admin users", () => {
    test("requires authentication", async () => {
      clearTestConfig();

      const { stdout, exitCode } = await runCli(["admin", "users"]);

      expect(stdout).toContain("Not authenticated");
    });

    test("lists users when authenticated as admin", async () => {
      setTestConfig({
        apiKey: TEST_CONFIG.adminApiKey,
        apiUrl: TEST_CONFIG.apiUrl,
        username: "test-admin",
      });

      const { stdout, exitCode } = await runCli(["admin", "users"]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("NEMAR Users");
      expect(stdout).toContain("test-admin");
    });

    test("non-admin cannot list users", async () => {
      setTestConfig({
        apiKey: TEST_CONFIG.userApiKey,
        apiUrl: TEST_CONFIG.apiUrl,
        username: "test-user",
      });

      const { stdout, exitCode } = await runCli(["admin", "users"]);

      expect(stdout).toContain("requires admin privileges");
    });

    test("lists users with --approved filter", async () => {
      setTestConfig({
        apiKey: TEST_CONFIG.adminApiKey,
        apiUrl: TEST_CONFIG.apiUrl,
        username: "test-admin",
      });

      const { stdout, exitCode } = await runCli(["admin", "users", "--approved"]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("test-admin");
      expect(stdout).toContain("test-user");
    });

    test("lists users with --verified filter", async () => {
      setTestConfig({
        apiKey: TEST_CONFIG.adminApiKey,
        apiUrl: TEST_CONFIG.apiUrl,
        username: "test-admin",
      });

      const { stdout, exitCode } = await runCli(["admin", "users", "--verified"]);

      expect(exitCode).toBe(0);
      // Should show test-verified user
      expect(stdout).toContain("test-verified");
    });
  });
});

describe("CLI Error Handling", () => {
  test("unknown command shows error", async () => {
    const { stderr, exitCode } = await runCli(["unknown-command"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown command");
  });

  test("missing required argument shows error", async () => {
    const { stderr, exitCode } = await runCli(["admin", "approve"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing required argument");
  });
});
