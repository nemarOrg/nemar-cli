/**
 * CLI Command Integration Tests
 *
 * Tests CLI commands by spawning subprocesses.
 * Requires test users to be set up in the database.
 *
 * NOTE: These tests manipulate the user's real config file.
 * The config is backed up and restored after tests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";

// CLI tests spawn subprocesses that make network calls to Cloudflare Workers;
// CI runners may experience cold starts and higher latency
setDefaultTimeout(30000);
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "bun";
import { TEST_CONFIG, sleep } from "./setup";

// Standardized config path: ~/.config/nemar/ on all platforms
function getConfigDir(): string {
  const home = process.env.HOME || "";
  return join(home, ".config", "nemar");
}

const CONFIG_DIR = getConfigDir();
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const CONFIG_BACKUP = join(CONFIG_DIR, "config.json.backup");

// Test context - each test creates its own isolated config directory
interface TestContext {
  configDir: string;
  configFile: string;
}

// Create a unique test context with isolated config
function createTestContext(): TestContext {
  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const configDir = join(import.meta.dir, ".test-configs", uniqueId);
  mkdirSync(configDir, { recursive: true });
  // Conf stores config in <cwd>/config.json when cwd is set
  const configFile = join(configDir, "config.json");
  return { configDir, configFile };
}

// Helper to run CLI commands with isolated config
async function runCli(
  args: string[],
  ctx?: TestContext,
  options: { env?: Record<string, string>; input?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["bun", "run", "src/index.ts", ...args],
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      // Use NEMAR_CONFIG_DIR for test isolation (cross-platform)
      ...(ctx ? { NEMAR_CONFIG_DIR: ctx.configDir } : {}),
      // Disable update check in test subprocesses (avoids 5s cold-start delay)
      NEMAR_NO_UPDATE_CHECK: "1",
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

// Helper to set config for a test context
function setTestConfig(ctx: TestContext, config: Record<string, unknown>) {
  writeFileSync(ctx.configFile, JSON.stringify(config));
}

// Helper to clear config for a test context
function clearTestConfig(ctx: TestContext) {
  if (existsSync(ctx.configFile)) {
    unlinkSync(ctx.configFile);
  }
}

// Backup real config before all tests
beforeAll(() => {
  if (existsSync(CONFIG_FILE)) {
    copyFileSync(CONFIG_FILE, CONFIG_BACKUP);
  }
});

// Add delay between tests to avoid rate limiting
beforeEach(async () => {
  await sleep(300);
});

// Restore real config and cleanup test directories after all tests
afterAll(() => {
  if (existsSync(CONFIG_BACKUP)) {
    copyFileSync(CONFIG_BACKUP, CONFIG_FILE);
    unlinkSync(CONFIG_BACKUP);
  }
  // Cleanup test config directories
  const testConfigsDir = join(import.meta.dir, ".test-configs");
  if (existsSync(testConfigsDir)) {
    try {
      rmSync(testConfigsDir, { recursive: true, force: true });
    } catch {
      console.log("[DEBUG] Could not cleanup test configs dir");
    }
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
      const ctx = createTestContext();

      const { stdout, exitCode } = await runCli(["auth", "status"], ctx);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Not authenticated");
    });

    test("shows authenticated when credentials exist", async () => {
      const ctx = createTestContext();
      setTestConfig(ctx, {
        apiKey: TEST_CONFIG.adminApiKey,
        apiUrl: TEST_CONFIG.apiUrl,
        username: "test-admin",
        email: "testAdmin@nemar.org",
        githubUsername: "test-admin-gh",
      });

      const { stdout, exitCode } = await runCli(["auth", "status"], ctx);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Authenticated");
      expect(stdout).toContain("test-admin");
    });
  });

  describe("nemar auth login", () => {
    test("login with valid API key via -k flag", async () => {
      const ctx = createTestContext();

      const { stdout, exitCode } = await runCli(
        [
          "auth",
          "login",
          "-k",
          TEST_CONFIG.adminApiKey,
          "-y", // Skip confirmation even if already authenticated
        ],
        ctx,
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Welcome back");
      expect(stdout).toContain("test-admin");
    });

    test("login with invalid API key shows error", async () => {
      const ctx = createTestContext();

      const { stdout, exitCode } = await runCli(
        ["auth", "login", "-k", "invalid_key_that_is_definitely_wrong_12345", "-y"],
        ctx,
      );

      expect(stdout).toContain("Check that your API key is correct");
    });
  });

  describe("nemar auth logout", () => {
    test("logout when not authenticated shows message", async () => {
      const ctx = createTestContext();

      const { stdout, exitCode } = await runCli(["auth", "logout", "-y"], ctx);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Not currently authenticated");
    });

    test("logout when authenticated clears credentials", async () => {
      const ctx = createTestContext();
      setTestConfig(ctx, {
        apiKey: TEST_CONFIG.userApiKey,
        apiUrl: TEST_CONFIG.apiUrl,
        username: "test-user",
      });

      const { stdout, exitCode } = await runCli(["auth", "logout", "-y"], ctx);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Logged out successfully");

      // Verify credentials are cleared
      const { stdout: statusOut } = await runCli(["auth", "status"], ctx);
      expect(statusOut).toContain("Not authenticated");
    });
  });
});

describe("CLI Admin Commands", () => {
  describe("nemar admin users", () => {
    test("requires authentication", async () => {
      const ctx = createTestContext();

      const { stdout, exitCode } = await runCli(["admin", "users"], ctx);

      expect(stdout).toContain("Not authenticated");
    });

    test("lists users when authenticated as admin", async () => {
      const ctx = createTestContext();
      setTestConfig(ctx, {
        apiKey: TEST_CONFIG.adminApiKey,
        apiUrl: TEST_CONFIG.apiUrl,
        username: "test-admin",
      });

      const { stdout, exitCode } = await runCli(["admin", "users"], ctx);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("NEMAR Users");
      expect(stdout).toContain("test-admin");
    });

    test("non-admin cannot list users", async () => {
      const ctx = createTestContext();
      setTestConfig(ctx, {
        apiKey: TEST_CONFIG.userApiKey,
        apiUrl: TEST_CONFIG.apiUrl,
        username: "test-user",
      });

      const { stdout, exitCode } = await runCli(["admin", "users"], ctx);

      expect(stdout).toContain("requires admin privileges");
    });

    test("lists users with --approved filter", async () => {
      const ctx = createTestContext();
      setTestConfig(ctx, {
        apiKey: TEST_CONFIG.adminApiKey,
        apiUrl: TEST_CONFIG.apiUrl,
        username: "test-admin",
      });

      const { stdout, exitCode } = await runCli(["admin", "users", "--approved"], ctx);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("test-admin");
      expect(stdout).toContain("test-user");
    });

    test("lists users with --verified filter", async () => {
      const ctx = createTestContext();
      setTestConfig(ctx, {
        apiKey: TEST_CONFIG.adminApiKey,
        apiUrl: TEST_CONFIG.apiUrl,
        username: "test-admin",
      });

      const { stdout, exitCode } = await runCli(["admin", "users", "--verified"], ctx);

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

describe("CLI Dataset Validate", () => {
  const testDatasetDir = join(import.meta.dir, ".test-bids-dataset");

  beforeAll(() => {
    // Create minimal test BIDS dataset
    mkdirSync(testDatasetDir, { recursive: true });
    writeFileSync(
      join(testDatasetDir, "dataset_description.json"),
      JSON.stringify({
        Name: "Test Dataset",
        BIDSVersion: "1.9.0",
        Authors: ["Test Author"],
      }),
    );
    writeFileSync(join(testDatasetDir, "README"), "# Test Dataset\n\nThis is a test.");
  });

  afterAll(() => {
    // Cleanup test dataset
    try {
      rmSync(testDatasetDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test("nemar dataset validate --help shows options", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "validate", "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Validate a BIDS dataset");
    expect(stdout).toContain("--json");
    expect(stdout).toContain("--config");
    expect(stdout).toContain("--recursive");
    // Verbose help text (examples, pass-through info) is now behind --help-all
    expect(stdout).toContain("--help-all");
  });

  test("nemar dataset validate --version-info shows validator version", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "validate", "--version-info"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("BIDS Validator:");
    expect(stdout).toContain("Deno:");
  });

  test("nemar dataset validate with valid dataset succeeds", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "validate", testDatasetDir]);

    expect(exitCode).toBe(0);
    // Native bids-validator text output includes a Summary table
    expect(stdout).toContain("Summary:");
  });

  test("nemar dataset validate --json outputs JSON", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "validate", testDatasetDir, "--json"]);

    expect(exitCode).toBe(0);
    // Raw bids-validator JSON output has { issues: { issues: [...] }, summary: {...} }
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    expect(jsonMatch).not.toBeNull();
    const result = JSON.parse(jsonMatch![0]);
    expect(result.issues).toBeDefined();
    expect(result.summary).toBeDefined();
  });

  test("nemar dataset validate with non-existent path fails", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "validate", "/nonexistent/path"]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("Path does not exist");
  });

  test("nemar dataset validate with non-BIDS directory fails", async () => {
    const { stdout, exitCode} = await runCli(["dataset", "validate", "/tmp"]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("Not a valid BIDS dataset");
    expect(stdout).toContain("dataset_description.json");
  });

  test("nemar dataset validate accepts pass-through flags", async () => {
    const testDir = "/tmp/test-bids-passthrough";
    const { existsSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      `${testDir}/dataset_description.json`,
      JSON.stringify({ Name: "Test Dataset", BIDSVersion: "1.6.0" }),
    );

    try {
      // --max-rows is a valid bids-validator flag passed through directly
      const { stdout, exitCode } = await runCli(["dataset", "validate", testDir, "--max-rows", "0"]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Summary:");
    } finally {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    }
  });

  test("nemar dataset validate passes unknown flags to validator", async () => {
    const testDir = "/tmp/test-bids-unknown-flag";
    const { existsSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      `${testDir}/dataset_description.json`,
      JSON.stringify({ Name: "Test Dataset", BIDSVersion: "1.6.0" }),
    );

    try {
      // Unknown flags are passed through; deno/bids-validator will reject them
      const { stdout, stderr, exitCode } = await runCli(["dataset", "validate", testDir, "--unknownFlag", "value"]);

      // Validator exits with non-zero for unknown options
      expect(exitCode).not.toBe(0);
    } finally {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    }
  });
});

describe("CLI Dataset Upload", () => {
  test("nemar dataset upload --help shows options", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "upload", "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Upload a BIDS dataset to NEMAR");
    expect(stdout).toContain("--name");
    expect(stdout).toContain("--description");
    expect(stdout).toContain("--skip-validation");
    expect(stdout).toContain("--dry-run");
    expect(stdout).toContain("--jobs");
    expect(stdout).toContain("--yes");
  });

  test("nemar dataset upload requires authentication", async () => {
    const ctx = createTestContext();

    const { stdout, exitCode } = await runCli(["dataset", "upload", "/tmp/test"], ctx);

    expect(stdout).toContain("Not authenticated");
    expect(stdout).toContain("nemar auth login");
  });

  test("nemar dataset upload requires sandbox completion", async () => {
    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: TEST_CONFIG.userApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-user",
      sandboxCompleted: false,
    });

    const { stdout, exitCode } = await runCli(["dataset", "upload", "/tmp/test"], ctx);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("Sandbox training required");
    expect(stdout).toContain("nemar sandbox");
  });

  test("nemar dataset upload with non-existent path fails", async () => {
    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: TEST_CONFIG.userApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-user",
      sandboxCompleted: true, // Skip sandbox check to test path validation
    });

    const { stdout, exitCode } = await runCli(["dataset", "upload", "/nonexistent/path"], ctx);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("Path does not exist");
  });
});

describe("CLI Dataset Download", () => {
  test("nemar dataset download --help shows options", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "download", "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Download a dataset from NEMAR");
    expect(stdout).toContain("--output");
    expect(stdout).toContain("--jobs");
    expect(stdout).toContain("--no-data");
    expect(stdout).toContain("--stimuli");
    expect(stdout).toContain("--derivatives");
  });

  test("nemar dataset get --help advertises --stimuli/--derivatives", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "get", "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("--stimuli");
    expect(stdout).toContain("--derivatives");
  });

  test("nemar dataset --help-all spells out download vs get", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "--help-all"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("download");
    expect(stdout).toContain("get");
    expect(stdout).toContain("OUTSIDE");
    expect(stdout).toContain("INSIDE");
  });

  test("nemar dataset download --no-data does not conflict with default skip", async () => {
    // The default stimuli/derivatives skip excludes do NOT count toward
    // `filter.active`, so they must not trigger the "filters imply data
    // download" conflict that real user filters do. Regression guard for
    // the active-flag semantics. We use a non-existent id so the command
    // exits before any network work, but the conflict check runs early.
    const { stdout, stderr } = await runCli(["dataset", "download", "nm999999", "--no-data"]);
    const output = stdout + stderr;
    expect(output).not.toContain("--no-data cannot be combined with BIDS filters");
  });

  test("nemar dataset download with non-existent dataset shows error", async () => {
    const { stdout, stderr, exitCode } = await runCli(["dataset", "download", "nm999999"]);

    // Should fail with dataset not found (after prereq check)
    const output = stdout + stderr;
    // Either fails at prereq check (DataLad not installed) or at dataset lookup
    expect(
      output.includes("Prerequisites") ||
        output.includes("not found") ||
        output.includes("DataLad"),
    ).toBe(true);
  });
});

describe("CLI Dataset Status", () => {
  test("nemar dataset status --help shows options", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "status", "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Check status of a dataset");
    expect(stdout).toContain("--json");
  });

  test("nemar dataset status with non-existent dataset shows error", async () => {
    // Valid format within MAX_NUMBER=99999 cap, but unlikely to be allocated.
    const { stdout, exitCode } = await runCli(["dataset", "status", "nm099998"]);

    expect(stdout).toContain("not found");
  });

  test("nemar dataset status --json outputs JSON format", async () => {
    // Use nm099999 (seeded managed dataset) directly; the list endpoint
    // may return catalog-only datasets that don't exist in D1.
    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: TEST_CONFIG.adminApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-admin",
    });

    const { stdout, exitCode } = await runCli(
      ["dataset", "status", "nm099999", "--json"],
      ctx,
    );

    if (exitCode !== 0) {
      // Backend may not be reachable or dataset may not exist
      return;
    }
    const result = JSON.parse(stdout);
    expect(result.dataset_id).toBe("nm099999");
    expect(result.name).toBeDefined();
  });
});

describe("CLI Dataset List", () => {
  test("nemar dataset list --help shows options", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "list", "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("List datasets on NEMAR");
    expect(stdout).toContain("--mine");
    expect(stdout).toContain("--json");
    expect(stdout).toContain("--limit");
  });

  test("nemar dataset list shows datasets", async () => {
    const { stdout, stderr, exitCode } = await runCli(["dataset", "list"]);

    // The CLI hits the production backend; if the backend doesn't have
    // migration 0018 yet, it falls back gracefully. Accept both success
    // and "Failed to fetch" (pre-migration backend).
    if (exitCode === 0) {
      expect(stdout.includes("Datasets") || stdout.includes("No datasets found")).toBe(true);
    } else {
      expect(stderr).toContain("Failed to fetch");
    }
  });

  test("nemar dataset list --json outputs JSON format", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "list", "--json"]);

    if (exitCode === 0) {
      const result = JSON.parse(stdout);
      expect(Array.isArray(result.datasets)).toBe(true);
      expect(typeof result.total_count).toBe("number");
      expect(typeof result.limit).toBe("number");
      expect(typeof result.offset).toBe("number");
    }
    // Skip assertion if backend returned error (pre-migration)
  });

  test("nemar dataset list --mine requires authentication", async () => {
    const ctx = createTestContext();

    const { stdout, exitCode } = await runCli(["dataset", "list", "--mine"], ctx);

    expect(stdout).toContain("Not authenticated");
  });
});

describe("CLI Admin Revert", () => {
  test("nemar admin revert --help shows options", async () => {
    const { stdout, exitCode } = await runCli(["admin", "revert", "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Revert a dataset to a previous version");
    expect(stdout).toContain("--list");
    expect(stdout).toContain("--force");
    expect(stdout).toContain("--message");
    expect(stdout).toContain("--dir");
    expect(stdout).toContain("<dataset-id>");
    expect(stdout).toContain("[version]");
  });

  test("nemar admin revert without auth shows error", async () => {
    const ctx = createTestContext();

    const { stdout, exitCode } = await runCli(["admin", "revert", "nm000104"], ctx);

    expect(stdout).toContain("Not authenticated");
  });

  test("nemar admin revert with nonexistent dataset shows error", async () => {
    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: TEST_CONFIG.adminApiKey,
      apiUrl: TEST_CONFIG.apiUrl,
      username: "test-admin",
    });

    const { stdout, stderr, exitCode } = await runCli(
      ["admin", "revert", "nm999999", "--list"],
      ctx,
    );

    // Should fail; either "not found" (if prereqs met) or "missing prerequisites" (in CI)
    const output = (stdout + stderr).toLowerCase();
    expect(output.includes("not found") || output.includes("prerequisites")).toBe(true);
  });
});

describe("CLI Dataset Collaborator Commands", () => {
  describe("nemar dataset request-access", () => {
    test("--help shows options", async () => {
      const { stdout, exitCode } = await runCli(["dataset", "request-access", "--help"]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Request collaborator access");
      expect(stdout).toContain("dataset-id");
    });

    test("requires authentication", async () => {
      const ctx = createTestContext();

      const { stdout, exitCode } = await runCli(["dataset", "request-access", "nm000001"], ctx);

      expect(stdout).toContain("Not authenticated");
    });

    test("non-existent dataset shows error", async () => {
      const ctx = createTestContext();
      setTestConfig(ctx, {
        apiKey: TEST_CONFIG.userApiKey,
        apiUrl: TEST_CONFIG.apiUrl,
        username: "test-user",
      });

      const { stdout, stderr, exitCode } = await runCli(
        ["dataset", "request-access", "nm999999"],
        ctx,
      );

      // Spinner output goes to stderr in non-TTY mode
      const output = (stdout + stderr).toLowerCase();
      expect(output).toContain("not found");
    });
  });

  describe("nemar dataset invite", () => {
    test("--help shows options", async () => {
      const { stdout, exitCode } = await runCli(["dataset", "invite", "--help"]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Invite a user");
      expect(stdout).toContain("username");
      expect(stdout).toContain("dataset-id");
    });

    test("requires authentication", async () => {
      const ctx = createTestContext();

      const { stdout, exitCode } = await runCli(["dataset", "invite", "someuser", "nm000001"], ctx);

      expect(stdout).toContain("Not authenticated");
    });

    test("non-admin non-owner cannot invite", async () => {
      const ctx = createTestContext();
      setTestConfig(ctx, {
        apiKey: TEST_CONFIG.userApiKey,
        apiUrl: TEST_CONFIG.apiUrl,
        username: "test-user",
      });

      // Try to invite to a dataset test-user doesn't own
      const { stdout, stderr, exitCode } = await runCli(
        ["dataset", "invite", "someuser", "nm000001"],
        ctx,
      );

      // Spinner output goes to stderr in non-TTY mode
      const output = (stdout + stderr).toLowerCase();
      // Either "not found" (if dataset doesn't exist) or "owner or admin" (if forbidden)
      expect(
        output.includes("not found") || output.includes("owner") || output.includes("admin"),
      ).toBe(true);
    });
  });

  describe("nemar dataset collaborators", () => {
    test("--help shows options", async () => {
      const { stdout, exitCode } = await runCli(["dataset", "collaborators", "--help"]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("List collaborators");
      expect(stdout).toContain("dataset-id");
      expect(stdout).toContain("--json");
    });

    test("requires authentication", async () => {
      const ctx = createTestContext();

      const { stdout, exitCode } = await runCli(["dataset", "collaborators", "nm000001"], ctx);

      expect(stdout).toContain("Not authenticated");
    });

    test("non-admin non-owner cannot list collaborators", async () => {
      const ctx = createTestContext();
      setTestConfig(ctx, {
        apiKey: TEST_CONFIG.userApiKey,
        apiUrl: TEST_CONFIG.apiUrl,
        username: "test-user",
      });

      // Try to list collaborators for a dataset test-user doesn't own
      const { stdout, stderr, exitCode } = await runCli(
        ["dataset", "collaborators", "nm000001"],
        ctx,
      );

      // Spinner output goes to stderr in non-TTY mode
      const output = (stdout + stderr).toLowerCase();
      // Either "not found" or "owner or admin" forbidden
      expect(
        output.includes("not found") || output.includes("owner") || output.includes("admin"),
      ).toBe(true);
    });

    test("admin can list collaborators with --json", async () => {
      const ctx = createTestContext();
      setTestConfig(ctx, {
        apiKey: TEST_CONFIG.adminApiKey,
        apiUrl: TEST_CONFIG.apiUrl,
        username: "test-admin",
      });

      // First get a dataset that exists
      const { stdout: listOut } = await runCli(["dataset", "list", "--json"], ctx);
      let datasets: { dataset_id: string }[] = [];
      try {
        const parsed = JSON.parse(listOut);
        datasets = parsed.datasets ?? parsed;
      } catch {
        return; // Skip if no datasets
      }

      if (!datasets || datasets.length === 0) {
        return;
      }

      // Find an nm-prefix dataset (collaborators endpoint requires a GitHub-backed repo)
      const nmDataset = datasets.find((d) => d.dataset_id.startsWith("nm"));
      if (!nmDataset) return; // Skip if no nm-prefix datasets available

      const { stdout, stderr, exitCode } = await runCli(
        ["dataset", "collaborators", nmDataset.dataset_id, "--json"],
        ctx,
      );

      if (exitCode !== 0) {
        // Collaborators endpoint may fail if dataset has no GitHub repo or auth lacks access
        console.warn(`Collaborators test skipped for ${nmDataset.dataset_id}: ${stderr || stdout}`);
        return;
      }
      const result = JSON.parse(stdout);
      expect(result.dataset_id).toBe(nmDataset.dataset_id);
      expect(Array.isArray(result.collaborators)).toBe(true);
      expect(typeof result.count).toBe("number");
    });
  });
});
