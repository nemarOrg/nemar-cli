/**
 * CLI-level tests for the --debug diagnostic bundle (issue #1256, epic
 * #1250 phase 6): the failure hint (and its --json / usage-error
 * suppression), the debug log's redacted content, and log rotation.
 *
 * All driven through the real `nemar` entry point via Bun.spawn, following
 * the pattern already used across test/ (e.g. test/manifest.test.ts,
 * test/search-color.unit.test.ts): NEMAR_CONFIG_DIR isolates config/logs
 * per test, TEST_API_URL points network calls at either a deliberately
 * unreachable address (127.0.0.1:1, reserved+unused -- test/rate-limit-retry.test.ts's
 * precedent) or a real local Bun.serve stub. Subprocess isolation also
 * sidesteps the shared-module-state risk that would come from touching
 * src/lib/debug-log.ts's or src/lib/config.ts's module-level state
 * in-process (see MEMORY: bun-test-shared-process-root-and-backend).
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const UNREACHABLE = "http://127.0.0.1:1";
const HINT_URL = "https://github.com/nemarOrg/nemar-cli/issues/new?template=bug_report.yml";

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function makeConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "nemar-debug-cli-"));
}

function writeConfig(configDir: string, config: Record<string, unknown>): void {
  writeFileSync(join(configDir, "config.json"), JSON.stringify(config));
}

async function runCli(
  args: string[],
  configDir: string,
  testApiUrl: string | undefined,
): Promise<RunResult> {
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NEMAR_CONFIG_DIR: configDir,
      TEST_API_URL: testApiUrl ?? "",
      NEMAR_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
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

describe("failure hint (#1256)", () => {
  test("prints the hint on a real failing command", async () => {
    const configDir = makeConfigDir();
    writeConfig(configDir, { apiKey: "fake-key", apiUrl: UNREACHABLE, username: "test" });
    const result = await runCli(["dataset", "manifest", "-d", "nm000104"], configDir, UNREACHABLE);
    rmSync(configDir, { recursive: true, force: true });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(HINT_URL);
  });

  test("--json suppresses the hint", async () => {
    const configDir = makeConfigDir();
    writeConfig(configDir, { apiKey: "fake-key", apiUrl: UNREACHABLE, username: "test" });
    const result = await runCli(
      ["dataset", "manifest", "-d", "nm000104", "--json"],
      configDir,
      UNREACHABLE,
    );
    rmSync(configDir, { recursive: true, force: true });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain(HINT_URL);
  });

  test("a Commander usage error suppresses the hint", async () => {
    const configDir = makeConfigDir();
    const result = await runCli(
      ["dataset", "manifest", "--this-flag-does-not-exist"],
      configDir,
      undefined,
    );
    rmSync(configDir, { recursive: true, force: true });

    // Commander's own usage-error exit; it already explained itself.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("error:");
    expect(result.stderr).not.toContain(HINT_URL);
  });

  test("--debug prints the log path instead of the generic hint", async () => {
    const configDir = makeConfigDir();
    writeConfig(configDir, { apiKey: "fake-key", apiUrl: UNREACHABLE, username: "test" });
    const result = await runCli(
      ["--debug", "dataset", "manifest", "-d", "nm000104"],
      configDir,
      UNREACHABLE,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain(HINT_URL);
    expect(result.stderr).toContain("Debug log:");

    const logPath = result.stderr
      .split("\n")
      .find((line) => line.startsWith("Debug log:"))
      ?.replace("Debug log:", "")
      .trim();
    expect(logPath).toBeTruthy();
    const content = readFileSync(logPath as string, "utf8");
    expect(content).toContain("Exit code: 1");
    rmSync(configDir, { recursive: true, force: true });
  });
});

describe("--debug log content is redacted (real request, real failure)", () => {
  test("request body, response body, and the command line are redacted", async () => {
    const configDir = makeConfigDir();
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({
            valid: true,
            user: {
              username: "alice",
              email: "alice@example.com",
              github_username: "alice-gh",
              role: "member",
              sandbox_completed: false,
            },
            aws_secret_access_key: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
            note: "Bearer abcDEF123456.token-part",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });
    const apiUrl = `http://localhost:${server.port}`;
    const fakeApiKey = "sk-fake-cli-test-secret-0123456789";

    const result = await runCli(["--debug", "login", "-k", fakeApiKey], configDir, apiUrl);
    server.stop(true);

    // A successful login exits 0, so the failure hint (and the log-path
    // line that replaces it) never fires -- the log is still written
    // unconditionally whenever --debug is on, so read it directly.
    expect(result.exitCode).toBe(0);
    const logsDir = join(configDir, "logs");
    const logFiles = readdirSync(logsDir);
    expect(logFiles.length).toBe(1);
    const content = readFileSync(join(logsDir, logFiles[0]), "utf8");

    // Command line: the -k value must never appear in the clear.
    expect(content).not.toContain(fakeApiKey);
    expect(content).toContain("Command: nemar --debug login -k [REDACTED]");

    // Request body: {"api_key": "<fakeApiKey>"} -> key fully redacted.
    expect(content).toContain('"api_key":"[REDACTED]"');

    // Response body: email masked, AWS secret masked, Bearer token masked.
    expect(content).not.toContain("alice@example.com");
    expect(content).toContain("a***@example.com");
    expect(content).not.toContain("wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY");
    expect(content).not.toContain("Bearer abcDEF123456.token-part");
    expect(content).toContain("Bearer [REDACTED]");

    // Non-sensitive fields survive.
    expect(content).toContain("alice-gh");

    rmSync(configDir, { recursive: true, force: true });
  });
});

describe("nemar doctor --report", () => {
  test("prints the environment section with no HTTP trace", async () => {
    const configDir = makeConfigDir();
    const result = await runCli(["doctor", "--report"], configDir, undefined);
    rmSync(configDir, { recursive: true, force: true });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CLI version:");
    expect(result.stdout).toContain("External tools:");
    expect(result.stdout).not.toContain("HTTP requests:");
  });
});

describe("log rotation (#1256)", () => {
  test("keeps only the 10 most recent debug logs", async () => {
    const configDir = makeConfigDir();
    const logsDir = join(configDir, "logs");
    mkdirSync(logsDir, { recursive: true });

    // Seed 10 pre-existing logs, oldest to newest by name (ISO-prefixed
    // names sort chronologically -- see debug-log.ts's pruneLogsDir).
    for (let i = 0; i < 10; i++) {
      const ms = String(i).padStart(3, "0");
      writeFileSync(join(logsDir, `nemar-2020-01-01T00-00-00-${ms}Z-fake.log`), `seed log ${i}\n`);
    }
    expect(readdirSync(logsDir).length).toBe(10);

    // doctor needs no auth/network and always exits 0 -- a clean, fast way
    // to drive one more real write through the actual entry point.
    const result = await runCli(["--debug", "doctor"], configDir, undefined);
    expect(result.exitCode).toBe(0);

    const remaining = readdirSync(logsDir);
    expect(remaining.length).toBe(10);
    // The very oldest seeded file must be the one pruned.
    expect(remaining).not.toContain("nemar-2020-01-01T00-00-00-000Z-fake.log");
    expect(remaining).toContain("nemar-2020-01-01T00-00-00-009Z-fake.log");
    expect(remaining.some((name) => name.endsWith("-doctor.log"))).toBe(true);

    rmSync(configDir, { recursive: true, force: true });
  });
});
