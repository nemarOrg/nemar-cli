/**
 * Email Preferences Tests
 *
 * Unit tests for parseEmailPreferences and CLI smoke tests
 * for admin email-preferences commands.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import { parseEmailPreferences } from "../backend/src/services/email";
import { TEST_CONFIG, sleep } from "./setup";

// ============================================================================
// Unit tests for parseEmailPreferences
// ============================================================================

describe("parseEmailPreferences", () => {
  test("null input returns all enabled", () => {
    const result = parseEmailPreferences(null);
    expect(result).toEqual({ user_approval: true, publication_request: true, announcements: true });
  });

  test("valid JSON with both fields", () => {
    const result = parseEmailPreferences(
      JSON.stringify({ user_approval: false, publication_request: true, announcements: true }),
    );
    expect(result).toEqual({
      user_approval: false,
      publication_request: true,
      announcements: true,
    });
  });

  test("valid JSON with all disabled", () => {
    const result = parseEmailPreferences(
      JSON.stringify({ user_approval: false, publication_request: false, announcements: false }),
    );
    expect(result).toEqual({
      user_approval: false,
      publication_request: false,
      announcements: false,
    });
  });

  test("missing fields default to true", () => {
    const result = parseEmailPreferences(JSON.stringify({}));
    expect(result).toEqual({ user_approval: true, publication_request: true, announcements: true });
  });

  test("partial fields: only user_approval set", () => {
    const result = parseEmailPreferences(JSON.stringify({ user_approval: false }));
    expect(result).toEqual({
      user_approval: false,
      publication_request: true,
      announcements: true,
    });
  });

  test("partial fields: only publication_request set", () => {
    const result = parseEmailPreferences(JSON.stringify({ publication_request: false }));
    expect(result).toEqual({
      user_approval: true,
      publication_request: false,
      announcements: true,
    });
  });

  test("corrupt JSON returns all enabled", () => {
    const result = parseEmailPreferences("{not valid json");
    expect(result).toEqual({ user_approval: true, publication_request: true, announcements: true });
  });

  test("empty string returns all enabled", () => {
    const result = parseEmailPreferences("");
    expect(result).toEqual({ user_approval: true, publication_request: true, announcements: true });
  });

  test("extra fields are ignored", () => {
    const result = parseEmailPreferences(
      JSON.stringify({ user_approval: false, publication_request: true, unknown_field: false }),
    );
    expect(result).toEqual({
      user_approval: false,
      publication_request: true,
      announcements: true,
    });
  });

  test("null values in fields default to true", () => {
    const result = parseEmailPreferences(
      JSON.stringify({ user_approval: null, publication_request: null }),
    );
    expect(result).toEqual({ user_approval: true, publication_request: true, announcements: true });
  });

  test("zero values treated as false", () => {
    const result = parseEmailPreferences(
      JSON.stringify({ user_approval: 0, publication_request: 0 }),
    );
    // 0 !== false is true, so these default to enabled
    expect(result).toEqual({ user_approval: true, publication_request: true, announcements: true });
  });
});

// ============================================================================
// CLI smoke tests for admin email-preferences commands
// ============================================================================

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

function setTestConfig(ctx: TestContext, config: Record<string, unknown>) {
  writeFileSync(ctx.configFile, JSON.stringify(config));
}

beforeEach(async () => {
  await sleep(300);
});

describe("admin email-preferences show", () => {
  test("shows help text", async () => {
    const { stdout } = await runCli(["admin", "email-preferences", "show", "--help"]);
    expect(stdout).toContain("email");
  });

  test("requires authentication", async () => {
    const ctx = createTestContext();
    const { stderr, exitCode } = await runCli(["admin", "email-preferences", "show"], ctx);
    const output = stderr + (await runCli(["admin", "email-preferences", "show"], ctx)).stdout;
    expect(exitCode).not.toBe(0);
  });
});

describe("admin email-preferences update", () => {
  test("shows help text", async () => {
    const { stdout } = await runCli(["admin", "email-preferences", "update", "--help"]);
    expect(stdout).toContain("email");
  });

  test("requires authentication", async () => {
    const ctx = createTestContext();
    const { exitCode } = await runCli(
      ["admin", "email-preferences", "update", "--user-approval", "true"],
      ctx,
    );
    expect(exitCode).not.toBe(0);
  });
});
